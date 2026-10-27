// WebSocket to USB HID bridge for openDSP-4x4 — multi-device
// No master/slave logic; leadership is decided by the UI.
//
// Identifiers:
//   SERVER_ID = 5-char alphanumeric server id (e.g. "Q7X2K")
//   guid      = "DSP" + 5-char alphanumeric (e.g. "DSP7C4H9")
//   serverid  = SERVER_ID  (just the server identity; same for every device)
//
// Every message carries both `guid` and `serverid`:
//   - key devices by `guid` (unique within a server)
//   - use `serverid` to know which bridge the device belongs to
//
// SERVER_ID and per-slot GUIDs are PERSISTED to disk so they survive restarts.
//
// Mock devices obey the real protocol. Every reply is generated from
// device.settings using the same unit conversions as the client.

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto as crypto } from 'node:crypto';
import { homedir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VENDOR_ID = 0x0168;
const PRODUCT_ID = 0x0821;
const MAX_LOGS = 200;
const PORT = Number(process.env.PORT) || 8765;
const MOCK_DEVICE_COUNT = Math.max(1, Number(process.env.MOCK_DEVICES) || 1);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const BIND_HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const MAX_WS_PAYLOAD = 64 * 1024;
const MAX_HID_REPORT_BYTES = 64;

const DEBUG_FRAMES = process.env.DEBUG_FRAMES !== 'false';

const STATE_DIR = process.env.BRIDGE_STATE_DIR
    || join(homedir(), '.opendsp-bridge', `port-${PORT}`);
const STATE_FILE = join(STATE_DIR, 'registry.json');

let mockMode = process.env.MOCK_MODE === 'true';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const DLE = 0x10, STX = 0x02, ETX = 0x03;
const REQUEST_ADDR = 0x01;

const Command = {
    GET_STATUS: 0x10, INIT_DONE: 0x12, GET_VERSION: 0x13, GET_FLAG: 0x14,
    GET_FLAGS_BLOCK: 0x22, READ_CHANNEL: 0x27, READ_PRESET_NAME: 0x29,
    GET_CONFIG: 0x2c, REPLY_CHANNEL: 0x24, RECALL_PRESET: 0x20,
    STORE_PRESET: 0x21, SET_NAME: 0x26, SET_PASSWORD: 0x2f, TEST_TONE: 0x39,
    COMPRESSOR: 0x30, CROSSOVER_LPF: 0x31, CROSSOVER_HPF: 0x32,
    PEQ_BAND: 0x33, LEVEL: 0x34, MUTE: 0x35, POLARITY: 0x36,
    DELAY: 0x38, GATE: 0x3e, ROUTING: 0x3a, READBACK_LEVELS: 0x40,
    GET_VERSION_FW: 0x52,
};

const KNOWN_COMMANDS = {
    0x10: "GET_STATUS", 0x12: "INIT_DONE", 0x13: "GET_VERSION", 0x14: "GET_FLAG",
    0x20: "RECALL_PRESET", 0x21: "STORE_PRESET", 0x22: "GET_FLAGS_BLOCK",
    0x24: "REPLY_CHANNEL", 0x26: "SET_NAME", 0x27: "READ_CHANNEL",
    0x29: "READ_PRESET_NAME", 0x2c: "GET_CONFIG", 0x2f: "SET_PASSWORD",
    0x39: "TEST_TONE", 0x30: "COMPRESSOR", 0x31: "CROSSOVER_LPF",
    0x32: "CROSSOVER_HPF", 0x33: "PEQ_BAND", 0x34: "LEVEL", 0x35: "MUTE",
    0x36: "POLARITY", 0x38: "DELAY", 0x3a: "ROUTING", 0x3e: "GATE",
    0x40: "READBACK_LEVELS", 0x52: "GET_VERSION_FW",
};

function cmdName(code) {
    return KNOWN_COMMANDS[code] ?? `UNKNOWN_0x${(code ?? 0).toString(16)}`;
}

const Slope = {
    BYPASS: 0x00, BW6: 0x01, BL6: 0x02, BW12: 0x03, BL12: 0x04, LK12: 0x05,
    BW18: 0x06, BL18: 0x07, BW24: 0x08, BL24: 0x09, LK24: 0x0a,
};

const PeqType = {
    PEAK: 0x00, LOW_SHELF: 0x01, HIGH_SHELF: 0x02, LOW_PASS: 0x03,
    HIGH_PASS: 0x04, ALLPASS1: 0x05, ALLPASS2: 0x06,
};

const CH_IN_A = 0x00, CH_IN_B = 0x01, CH_IN_C = 0x02, CH_IN_D = 0x03;
const CH_OUT_1 = 0x04, CH_OUT_2 = 0x05, CH_OUT_3 = 0x06, CH_OUT_4 = 0x07;

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function frameChecksum(payload) {
    let x = 0;
    for (let i = 0; i < payload.length; i++) x ^= payload[i];
    return (x ^ 1) & 0xff;
}

function buildReplyFrame(payload) {
    const out = new Uint8Array(MAX_HID_REPORT_BYTES).fill(0);
    const wrapped = [DLE, STX, ...payload.map(b => b & 0xff), DLE, ETX, frameChecksum(payload)];
    if (wrapped.length > MAX_HID_REPORT_BYTES) {
        throw new Error(`reply too large: ${wrapped.length} > ${MAX_HID_REPORT_BYTES}`);
    }
    out.set(wrapped, 0);
    return out;
}

function parseRequest(bytes) {
    if (bytes[0] !== DLE || bytes[1] !== STX) return null;
    const N = bytes[4] ?? 0;
    const plen = N + 3;
    const payload = bytes.slice(2, 2 + plen);
    const code = payload[3] ?? 0;
    const data = payload.slice(4, 3 + N);
    return { payload, code, data };
}

// ---------------------------------------------------------------------------
// Unit conversions
// ---------------------------------------------------------------------------

const GAIN_ZERO_DB = 281;
const GAIN_UNITS_PER_DB = 10;
const GAIN_MAX_RAW = 400;
const gainDbToRaw = (db) => Math.max(0, Math.min(GAIN_MAX_RAW, Math.round(GAIN_ZERO_DB + db * GAIN_UNITS_PER_DB)));
const gainRawToDb = (raw) => (raw - GAIN_ZERO_DB) / GAIN_UNITS_PER_DB;
const thresholdDbToRaw = (db) => Math.round((db + 90) * 2);
const thresholdRawToDb = (raw) => raw / 2 - 90;
const msToSamples = (ms) => Math.max(0, Math.min(32640, Math.round(ms * 48)));
const samplesToMs = (s) => s / 48;
const hzToPeqIndex = (hz) => Math.max(0, Math.min(300, Math.round(30 * Math.log2(hz / 19.7))));
const peqIndexToHz = (i) => 19.7 * Math.pow(2, i / 30);
const qToRaw = (q) => Math.max(0, Math.min(255, Math.round(q * 10)));
const rawToQ = (raw) => raw / 10;

// ---------------------------------------------------------------------------
// Identifier generation + persistence
// ---------------------------------------------------------------------------

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomId(len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

const persistedState = { serverId: null, guids: {} };

async function loadState() {
    try {
        const raw = await readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.serverId === 'string' && /^[A-Z0-9]{5}$/.test(parsed.serverId)) {
            persistedState.serverId = parsed.serverId;
        }
        if (parsed.guids && typeof parsed.guids === 'object') {
            for (const [k, v] of Object.entries(parsed.guids)) {
                if (typeof v === 'string' && /^DSP[A-Z0-9]{5}$/.test(v)) {
                    persistedState.guids[k] = v;
                }
            }
        }
        console.log(`Loaded state from ${STATE_FILE}`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Could not read state file: ${e.message}`);
    }
}

let saveStateTimer = null;
function scheduleStateSave() {
    if (saveStateTimer) return;
    saveStateTimer = setTimeout(async () => {
        saveStateTimer = null;
        try {
            await mkdir(STATE_DIR, { recursive: true });
            const tmp = STATE_FILE + '.tmp';
            await writeFile(tmp, JSON.stringify(persistedState, null, 2));
            await rename(tmp, STATE_FILE);
        } catch (e) {
            console.warn(`Could not persist state: ${e.message}`);
        }
    }, 50);
}

await loadState();
if (!persistedState.serverId) {
    persistedState.serverId = randomId(5);
    scheduleStateSave();
}
const SERVER_ID = persistedState.serverId;

/**
 * Return the persisted GUID for a given hidPath, generating and persisting
 * one if needed. `hidPath` is the OS HID path for physical devices, or
 * "mock-hid-path-N" for mocks. If null, a fresh random path is created
 * (only used for one-off debug callers; real call sites always pass one).
 */
function ensureDeviceGuid(hidPath = null) {
    if (!hidPath) hidPath = 'anon-' + randomId(8);
    if (!persistedState.guids[hidPath]) {
        persistedState.guids[hidPath] = 'DSP' + randomId(5);
        scheduleStateSave();
    }
    return persistedState.guids[hidPath];
}

function getAllDeviceGuids() {
    return Object.entries(persistedState.guids).map(([key, guid]) => ({
        key, guid, serverid: SERVER_ID,
    }));
}

// ---------------------------------------------------------------------------
// HID
// ---------------------------------------------------------------------------

let NodeHid = null;
try {
    const mod = await import('node-hid');
    NodeHid = mod.default || mod;
} catch {
    console.warn('node-hid not available. Install with: npm install node-hid');
}

function listHidDevices() {
    if (!NodeHid) return [];
    try { return NodeHid.devices(VENDOR_ID, PRODUCT_ID); }
    catch (e) { console.warn('node-hid.devices() failed:', e.message); return []; }
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const connectionLogs = [];
const messageLogs = [];

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
function hexDump(bytes, n = 64) {
    const arr = Array.from(bytes);
    const head = arr.slice(0, n).map(b => b.toString(16).padStart(2, '0')).join(' ');
    return arr.length > n ? `${head} …(${arr.length} bytes)` : head;
}

function logFrame(direction, device, bytes, extra) {
    if (!DEBUG_FRAMES) return;
    const tag = `[${direction}] ${device.serverid}/${device.guid}`;
    const parsed = parseRequest(Array.from(bytes));
    const meta = parsed
        ? `code=0x${parsed.code.toString(16).padStart(2, '0')} (${cmdName(parsed.code)}) N=${parsed.payload[2] ?? '?'} data=${parsed.data.length}B`
        : 'unparsable';
    const suffix = extra ? ` ${extra}` : '';
    console.log(`${tag} ${meta}${suffix}\n  ${hexDump(bytes, 64)}`);
}

function tryDecodeString(bytes) {
    const printable = bytes.filter(b => b >= 32 && b < 127);
    if (printable.length > bytes.length * 0.5) {
        return String.fromCharCode(...bytes).replace(/[^\x20-\x7E]/g, '');
    }
    return null;
}
function addConnectionLog(entry) {
    connectionLogs.unshift(entry);
    if (connectionLogs.length > MAX_LOGS) connectionLogs.pop();
}
function summarizeEntry(entry) {
    if (entry.payloadHex) return { kind: 'hex', text: entry.payloadHex };
    if (entry.payloadJson) return { kind: 'json', text: entry.payloadJson };
    if (entry.payloadBase64) {
        try {
            const bytes = b64decode(entry.payloadBase64);
            const str = tryDecodeString(bytes);
            if (str && /^[\s[{]/.test(str)) {
                try { return { kind: 'json', text: JSON.stringify(JSON.parse(str)) }; } catch { /* ignore */ }
            }
            return { kind: 'hex', text: bytesToHex(bytes) };
        } catch { /* ignore */ }
    }
    if (entry.payloadText) return { kind: 'text', text: entry.payloadText };
    return { kind: 'none', text: '' };
}
function makeMessageLog(entry) {
    const out = { ...entry };
    if (entry.payload && typeof entry.payload === 'string' && !out.payloadHex && !out.payloadBase64) {
        try {
            const bytes = b64decode(entry.payload);
            out.payloadBase64 = entry.payload;
            out.payloadHex = bytesToHex(bytes);
            const str = tryDecodeString(bytes);
            if (str && /^[\s[{]/.test(str)) {
                try { out.payloadJson = JSON.stringify(JSON.parse(str)); } catch { /* ignore */ }
            } else if (str) { out.payloadText = str; }
        } catch { out.payloadText = entry.payload; }
    }
    out.summary = summarizeEntry(out);
    return out;
}
function addMessageLog(entry) {
    const rec = makeMessageLog(entry);
    messageLogs.unshift(rec);
    if (messageLogs.length > MAX_LOGS) messageLogs.pop();
    return rec;
}

const b64encode = (bytes) => Buffer.from(bytes).toString('base64');
const b64decode = (str) => Array.from(Buffer.from(str, 'base64'));

// ---------------------------------------------------------------------------
// Per-mock settings
// ---------------------------------------------------------------------------

const DEFAULT_BAND_FREQS = [60, 150, 400, 1000, 2500, 6000, 12000];
const IN_NAMES = ['In A', 'In B', 'In C', 'In D'];
const OUT_NAMES = ['Out 1', 'Out 2', 'Out 3', 'Out 4'];
const RANDOM_IN_NAMES = ['Kick', 'Snare', 'Bass', 'Gtr', 'Vox', 'Keys', 'Aux', 'FX'];
const RANDOM_OUT_NAMES = ['Main L', 'Main R', 'Sub', 'Fill', 'Mon 1', 'Mon 2', 'Rec', 'Spare'];

function defaultChannelFor(i) {
    const isOutput = i >= 4;
    return {
        index: i,
        name: isOutput ? OUT_NAMES[i - 4] : IN_NAMES[i],
        gainDb: 0, mute: false, polarity: false,
        delayMs: isOutput ? 0 : null,
        eq: isOutput ? {
            hpf: { freqHz: 20, slopeCode: Slope.BYPASS },
            lpf: { freqHz: 20000, slopeCode: Slope.BYPASS },
            bands: DEFAULT_BAND_FREQS.map(f => ({
                type: PeqType.PEAK, freqHz: f, gainDb: 0, q: 1, bypass: true,
            })),
        } : undefined,
        comp: isOutput ? { ratioIndex: 0, kneeDb: 0, attackMs: 50, releaseMs: 500, thresholdDb: 20 } : undefined,
        gate: !isOutput ? { thresholdDb: -90, attackMs: 50, holdMs: 100, releaseMs: 500 } : undefined,
    };
}
function defaultSettings() {
    return {
        presetName: 'Init',
        channels: Array.from({ length: 8 }, (_, i) => defaultChannelFor(i)),
        routing: [0x01, 0x02, 0x04, 0x08],
    };
}
function randDb(lo = -24, hi = 6) { return Math.round((lo + Math.random() * (hi - lo)) * 10) / 10; }
function randomBand(idx) {
    const anchors = [40, 90, 200, 500, 1200, 3500, 9000];
    const base = anchors[idx] ?? 1000;
    return {
        type: PeqType.PEAK,
        freqHz: Math.round(base * (0.85 + Math.random() * 0.3)),
        gainDb: Math.round((-12 + Math.random() * 18) * 10) / 10,
        q: Math.round((0.4 + Math.random() * 6) * 100) / 100,
        bypass: Math.random() < 0.25,
    };
}
function randomRoutingMask() {
    const modes = [
        () => 1 << Math.floor(Math.random() * 4),
        () => (1 << Math.floor(Math.random() * 4)) | (1 << Math.floor(Math.random() * 4)),
        () => 0x0f,
    ];
    const mask = modes[Math.floor(Math.random() * modes.length)]() & 0x0f;
    return mask === 0 ? 0x01 : mask;
}
const SLOPE_CODES = [Slope.BW12, Slope.BW24, Slope.BL12, Slope.BL24];
function generateRandomSettings() {
    const channels = Array.from({ length: 8 }, (_, i) => {
        const isOutput = i >= 4;
        const names = isOutput ? RANDOM_OUT_NAMES : RANDOM_IN_NAMES;
        const name = names[i % names.length] ?? `Ch ${i}`;
        return {
            index: i, name,
            gainDb: randDb(-24, 6),
            mute: Math.random() < 0.1,
            polarity: Math.random() < 0.05,
            delayMs: isOutput ? Math.round(Math.random() * 300) / 10 : null,
            eq: isOutput ? {
                hpf: { freqHz: [20, 40, 60, 80, 100, 120][Math.floor(Math.random() * 6)], slopeCode: SLOPE_CODES[Math.floor(Math.random() * SLOPE_CODES.length)] },
                lpf: { freqHz: [8000, 12000, 16000, 20000][Math.floor(Math.random() * 4)], slopeCode: SLOPE_CODES[Math.floor(Math.random() * SLOPE_CODES.length)] },
                bands: Array.from({ length: 7 }, (_, b) => randomBand(b)),
            } : undefined,
            comp: isOutput ? {
                ratioIndex: Math.floor(Math.random() * 16),
                kneeDb: Math.round(Math.random() * 24),
                attackMs: [5, 10, 20, 50][Math.floor(Math.random() * 4)],
                releaseMs: [100, 200, 500, 1000][Math.floor(Math.random() * 4)],
                thresholdDb: Math.round(-30 + Math.random() * 30),
            } : undefined,
            gate: !isOutput ? {
                thresholdDb: Math.round(-90 + Math.random() * 40),
                attackMs: [10, 20, 50][Math.floor(Math.random() * 3)],
                holdMs: [50, 100, 200][Math.floor(Math.random() * 3)],
                releaseMs: [200, 500, 1000][Math.floor(Math.random() * 3)],
            } : undefined,
        };
    });
    return {
        presetName: `Random ${Math.floor(Math.random() * 100)}`,
        channels,
        routing: Array.from({ length: 4 }, () => randomRoutingMask()),
    };
}

// ---------------------------------------------------------------------------
// Preset image
// ---------------------------------------------------------------------------

function writeAscii(img, off, len, str) {
    const clean = String(str ?? '').slice(0, len);
    for (let i = 0; i < len; i++) img[off + i] = i < clean.length ? clean.charCodeAt(i) & 0x7f : 0;
}
function writeU16(img, off, v) {
    const u = Math.max(0, Math.min(0xffff, v | 0));
    img[off] = u & 0xff;
    img[off + 1] = (u >> 8) & 0xff;
}
function buildPresetImage(device) {
    const img = new Uint8Array(450);
    writeAscii(img, 2, 14, device.settings.presetName);

    const inputOffsets = [16, 40, 64, 88];
    for (let i = 0; i < 4; i++) {
        const ch = device.settings.channels[i];
        const b = inputOffsets[i];
        if (!ch) continue;
        writeAscii(img, b + 0, 10, ch.name);
        const g = ch.gate ?? { attackMs: 0, releaseMs: 0, holdMs: 0, thresholdDb: -90 };
        writeU16(img, b + 10, g.attackMs ?? 0);
        writeU16(img, b + 12, g.releaseMs ?? 0);
        writeU16(img, b + 14, g.holdMs ?? 0);
        writeU16(img, b + 16, thresholdDbToRaw(g.thresholdDb ?? -90));
        writeU16(img, b + 18, gainDbToRaw(ch.gainDb ?? 0));
        img[b + 20] = ch.polarity ? 1 : 0;
    }

    const outputOffsets = [112, 186, 260, 334];
    for (let i = 0; i < 4; i++) {
        const ch = device.settings.channels[4 + i];
        const b = outputOffsets[i];
        if (!ch) continue;
        writeAscii(img, b + 0, 8, ch.name);
        img[b + 8] = device.settings.routing[i] ?? 0;
        writeU16(img, b + 10, hzToPeqIndex(ch.eq?.hpf?.freqHz ?? 20));
        writeU16(img, b + 12, hzToPeqIndex(ch.eq?.lpf?.freqHz ?? 20000));
        img[b + 14] = ch.eq?.hpf?.slopeCode ?? Slope.BYPASS;
        img[b + 15] = ch.eq?.lpf?.slopeCode ?? Slope.BYPASS;

        for (let band = 0; band < 7; band++) {
            const rec = b + 16 + band * 6;
            const data = ch.eq?.bands?.[band] ?? { type: PeqType.PEAK, freqHz: 1000, gainDb: 0, q: 1, bypass: true };
            const gainRaw = Math.max(0, Math.min(240, Math.round(120 + (data.gainDb ?? 0) * 10)));
            writeU16(img, rec + 0, gainRaw);
            writeU16(img, rec + 2, hzToPeqIndex(data.freqHz));
            img[rec + 4] = qToRaw(data.q ?? 1);
            img[rec + 5] = data.type ?? PeqType.PEAK;
        }

        const c = ch.comp ?? { ratioIndex: 0, kneeDb: 0, attackMs: 50, releaseMs: 500, thresholdDb: 20 };
        img[b + 58] = c.ratioIndex ?? 0;
        img[b + 59] = Math.max(0, Math.min(255, c.kneeDb ?? 0));
        writeU16(img, b + 60, c.attackMs ?? 0);
        writeU16(img, b + 62, c.releaseMs ?? 0);
        writeU16(img, b + 64, thresholdDbToRaw(c.thresholdDb ?? 20));

        writeU16(img, b + 66, gainDbToRaw(ch.gainDb ?? 0));
        img[b + 68] = ch.polarity ? 1 : 0;
        writeU16(img, b + 70, msToSamples(ch.delayMs ?? 0));
    }
    return img;
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------
//
// `devices` is keyed by `guid`. `hidPathToGuid` tracks the HID path → guid
// mapping so `scanAndSyncHidDevices` can find disappeared HID devices without
// making `devices` a two-key map.

const devices = new Map();          // guid -> record
const hidPathToGuid = new Map();    // hidPath -> guid
const openingPaths = new Set();

/**
 * Create a device record.
 *
 * `hidPath` is the stable identity: OS HID path for physical units, or
 * "mock-hid-path-N" for mocks. ensureDeviceGuid maps it to a persisted guid.
 */
function makeDeviceRecord({ hidPath, kind, path, product, hidHandle = null }) {
    const guid = ensureDeviceGuid(hidPath);
    return {
        guid,
        serverid: SERVER_ID,     // ← server identity, same for every device
        kind,
        path: path ?? hidPath,
        product: product || 'DSP 4x4',
        hid: hidHandle,
        subscribers: new Set(),
        settings: kind === 'mock' ? generateRandomSettings() : defaultSettings(),
        connectedAt: new Date().toISOString(),
        mockResponseDelayMs: 15,
        closing: false,
    };
}

// ---------------------------------------------------------------------------
// applyWrite
// ---------------------------------------------------------------------------

function applyWrite(device, code, data) {
    const s = device.settings;
    if (!s) return false;
    const ch = data[0];
    const c = s.channels[ch];

    switch (code) {
        case Command.LEVEL: {
            if (!c) return false;
            const raw = data[1] | (data[2] << 8);
            const db = gainRawToDb(raw);
            if (Math.abs((c.gainDb ?? 0) - db) < 0.01) return false;
            c.gainDb = db;
            return true;
        }
        case Command.MUTE: {
            if (!c) return false;
            const on = data[1] === 1;
            if (c.mute === on) return false;
            c.mute = on;
            return true;
        }
        case Command.POLARITY: {
            if (!c) return false;
            const inv = data[1] === 1;
            if (c.polarity === inv) return false;
            c.polarity = inv;
            return true;
        }
        case Command.DELAY: {
            if (!c) return false;
            const ms = samplesToMs(data[1] | (data[2] << 8));
            if (c.delayMs === ms) return false;
            c.delayMs = ms;
            return true;
        }
        case Command.ROUTING: {
            const outIdx = ch - CH_OUT_1;
            if (outIdx < 0 || outIdx >= s.routing.length) return false;
            const mask = data[1] & 0x0f;
            if (s.routing[outIdx] === mask) return false;
            s.routing[outIdx] = mask;
            return true;
        }
        case Command.PEQ_BAND: {
            if (!c?.eq) return false;
            const rec = c.eq.bands[data[1] ?? 0];
            if (!rec) return false;
            const gainDb = Math.round((((data[2] | (data[3] << 8)) - 120) / 10) * 10) / 10;
            const freqHz = peqIndexToHz(data[4] | (data[5] << 8));
            const q = rawToQ(data[6]);
            const type = data[7];
            const bypass = !!data[8];
            if (rec.gainDb === gainDb && rec.freqHz === freqHz && rec.q === q && rec.type === type && rec.bypass === bypass) {
                return false;
            }
            rec.gainDb = gainDb; rec.freqHz = freqHz; rec.q = q; rec.type = type; rec.bypass = bypass;
            return true;
        }
        case Command.CROSSOVER_HPF: {
            if (!c?.eq) return false;
            const freqHz = peqIndexToHz(data[1] | (data[2] << 8));
            const slopeCode = data[3] ?? Slope.BYPASS;
            if (c.eq.hpf.freqHz === freqHz && c.eq.hpf.slopeCode === slopeCode) return false;
            c.eq.hpf.freqHz = freqHz;
            c.eq.hpf.slopeCode = slopeCode;
            return true;
        }
        case Command.CROSSOVER_LPF: {
            if (!c?.eq) return false;
            const freqHz = peqIndexToHz(data[1] | (data[2] << 8));
            const slopeCode = data[3] ?? Slope.BYPASS;
            if (c.eq.lpf.freqHz === freqHz && c.eq.lpf.slopeCode === slopeCode) return false;
            c.eq.lpf.freqHz = freqHz;
            c.eq.lpf.slopeCode = slopeCode;
            return true;
        }
        case Command.COMPRESSOR: {
            if (!c?.comp) return false;
            c.comp.ratioIndex = data[1] ?? c.comp.ratioIndex;
            c.comp.kneeDb = data[2] ?? c.comp.kneeDb;
            c.comp.attackMs = data[3] | (data[4] << 8);
            c.comp.releaseMs = data[5] | (data[6] << 8);
            c.comp.thresholdDb = thresholdRawToDb(data[7] | (data[8] << 8));
            return true;
        }
        case Command.GATE: {
            if (!c?.gate) return false;
            c.gate.attackMs = data[1] | (data[2] << 8);
            c.gate.releaseMs = data[3] | (data[4] << 8);
            c.gate.holdMs = data[5] | (data[6] << 8);
            c.gate.thresholdDb = thresholdRawToDb(data[7] | (data[8] << 8));
            return true;
        }
        case Command.SET_NAME: {
            const str = String.fromCharCode(...data.slice(0, 14)).replace(/\0[\s\S]*$/, '').trim();
            if (str && str !== s.presetName) { s.presetName = str; return true; }
            return false;
        }

        // Read-only / no-op — never signal a state change.
        case Command.GET_STATUS:
        case Command.GET_VERSION:
        case Command.GET_FLAG:
        case Command.GET_FLAGS_BLOCK:
        case Command.GET_CONFIG:
        case Command.READ_CHANNEL:
        case Command.READ_PRESET_NAME:
        case Command.READBACK_LEVELS:
        case Command.RECALL_PRESET:
        case Command.STORE_PRESET:
        case Command.SET_PASSWORD:
        case Command.TEST_TONE:
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// mockReply
// ---------------------------------------------------------------------------

function mockReply(device, code, data) {
    switch (code) {
        case Command.GET_STATUS: return [0x01, 0x00, 0x02, 0x10, 0x1f];
        case Command.INIT_DONE:  return [0x01, 0x00, 0x01, 0x01];
        case Command.GET_VERSION: {
            const v = '4x4MINIPRO V010';
            const out = [0x01, 0x00, 0x01 + v.length, 0x52];
            for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i) & 0xff);
            return out;
        }
        case Command.GET_FLAG: return [0x01, 0x00, 0x02, 0x14, 0x00];
        case Command.GET_FLAGS_BLOCK: {
            const out = [0x01, 0x00, 30 + 1, 0x22];
            for (let i = 0; i < 30; i++) out.push(0);
            return out;
        }
        case Command.GET_CONFIG: {
            const out = [0x01, 0x00, 8, 0x2c];
            for (let i = 0; i < 7; i++) out.push(0);
            return out;
        }
        case Command.READ_PRESET_NAME: {
            const name = device.settings.presetName ?? '';
            const out = [0x01, 0x00, 1 + 14, 0x29];
            for (let i = 0; i < 14; i++) out.push(i < name.length ? name.charCodeAt(i) & 0x7f : 0);
            return out;
        }
        case Command.READ_CHANNEL: {
            const index = data[0] ?? 0;
            const img = buildPresetImage(device);
            const page = img.slice(index * 50, index * 50 + 50);
            const out = [0x01, 0x00, 52, Command.REPLY_CHANNEL, index];
            for (let i = 0; i < 50; i++) out.push(page[i] ?? 0);
            return out;
        }
        case Command.READBACK_LEVELS: {
            const out = [0x01, 0x00, 25, 0x40];
            for (let i = 0; i < 8; i++) {
                const ch = device.settings.channels[i];
                const on = ch && ch.mute !== true && ch.gainDb > -60;
                out.push(on ? Math.floor(30 + Math.random() * 42) : 0, 0, 0);
            }
            return out;
        }
        case Command.TEST_TONE:
        case Command.RECALL_PRESET:
        case Command.STORE_PRESET:
        case Command.SET_PASSWORD:
        case Command.SET_NAME:
        case Command.LEVEL:
        case Command.MUTE:
        case Command.POLARITY:
        case Command.DELAY:
        case Command.ROUTING:
        case Command.PEQ_BAND:
        case Command.CROSSOVER_HPF:
        case Command.CROSSOVER_LPF:
        case Command.COMPRESSOR:
        case Command.GATE:
            return [0x01, 0x00, 0x01, 0x01];
        default: return null;
    }
}

function handleMockWrite(device, bytes) {
    let parsed;
    try { parsed = parseRequest(bytes); }
    catch (e) { console.error(`parseRequest threw on ${device.guid}:`, e.message); return false; }
    if (!parsed) return false;

    logFrame('TX', device, bytes, `-> mock ${cmdName(parsed.code)} data=[${parsed.data.map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);

    const changed = applyWrite(device, parsed.code, parsed.data);

    let reply;
    try { reply = mockReply(device, parsed.code, parsed.data); }
    catch (e) { console.error(`mockReply threw on ${device.guid} for code 0x${parsed.code.toString(16)}:`, e.message); return changed; }
    if (!reply) return changed;

    let frame;
    try { frame = buildReplyFrame(reply); }
    catch (e) { console.error(`buildReplyFrame threw on ${device.guid}:`, e.message); return changed; }

    logFrame('RX', device, frame, `<- mock reply to 0x${parsed.code.toString(16).padStart(2, '0')} (${cmdName(parsed.code)})`);

    addMessageLog({
        timestamp: new Date().toISOString(),
        guid: device.guid,
        serverid: device.serverid,
        type: 'mock_response',
        direction: 'outbound',
        payloadHex: bytesToHex(Array.from(frame)),
    });
    setTimeout(() => emitReportFromDevice(device, Array.from(frame)), device.mockResponseDelayMs);
    return changed;
}

// ---------------------------------------------------------------------------
// Device lifecycle
// ---------------------------------------------------------------------------

function openHidDevice(hidPath) {
    const existingGuid = hidPathToGuid.get(hidPath);
    if (existingGuid && devices.has(existingGuid)) return devices.get(existingGuid);
    if (openingPaths.has(hidPath)) return null;
    openingPaths.add(hidPath);

    let handle;
    try { handle = new NodeHid.HID(hidPath); }
    catch (e) {
        openingPaths.delete(hidPath);
        console.warn(`Failed to open HID ${hidPath}:`, e.message);
        return null;
    }

    const rec = makeDeviceRecord({
        hidPath,
        kind: 'hid',
        product: handle.product || 'DSP 4x4 Mini Pro',
        hidHandle: handle,
    });

    devices.set(rec.guid, rec);
    hidPathToGuid.set(hidPath, rec.guid);
    openingPaths.delete(hidPath);

    handle.on('data', (buf) => {
        const bytes = Array.from(buf);
        logFrame('HID-RX', rec, bytes, 'from physical device');
        emitReportFromDevice(rec, bytes);
    });
    handle.on('error', (err) => {
        console.error(`HID ${hidPath} error:`, err.message);
        closeDevice(rec.guid);
    });

    console.log(`Opened HID ${hidPath} → ${rec.guid} (${rec.serverid})`);
    notifyDevicesChanged();
    return rec;
}

function closeDevice(guid) {
    const rec = devices.get(guid);
    if (!rec || rec.closing) return;
    rec.closing = true;
    devices.delete(guid);
    if (rec.path && hidPathToGuid.get(rec.path) === guid) hidPathToGuid.delete(rec.path);

    if (rec.hid) { try { rec.hid.close(); } catch {} }

    const goneMsg = JSON.stringify({
        type: 'device_gone',
        guid: rec.guid,
        serverid: rec.serverid,
    });
    for (const ws of rec.subscribers) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(goneMsg); } catch {}
    }
    rec.subscribers.clear();

    console.log(`Closed ${guid}`);
    notifyDevicesChanged();
}

function scanAndSyncHidDevices() {
    const seen = new Set();
    for (const d of listHidDevices()) {
        seen.add(d.path);
        openHidDevice(d.path);
    }
    for (const [hidPath, guid] of [...hidPathToGuid]) {
        if (!seen.has(hidPath)) closeDevice(guid);
    }
}

// ---------------------------------------------------------------------------
// Mock device management
// ---------------------------------------------------------------------------

/**
 * Find the lowest unused mock HID path. The path is the mock's stable
 * identity, analogous to the OS HID path for physical units. The
 * `persistedState.guids` check ensures a path is allocated at most once, so a
 * mock's guid (and therefore its identity) survives restarts and remove+add
 * cycles. If you want slot reuse instead, drop the `used` set.
 */
function nextMockHidPath() {
    const used = new Set(
        Object.keys(persistedState.guids).filter(k => k.startsWith('mock-hid-path-'))
    );
    for (let n = 1; ; n++) {
        const hidPath = `mock-hid-path-${n}`;
        if (!used.has(hidPath) && ![...devices.values()].some(d => d.path === hidPath)) {
            return hidPath;
        }
    }
}

function addMockDevice() {
    const hidPath = nextMockHidPath();
    const rec = makeDeviceRecord({
        hidPath,
        kind: 'mock',
        product: `DSP 4x4 Mini Pro (${hidPath})`,
    });
    devices.set(rec.guid, rec);
    console.log(`Added ${rec.guid} (${rec.serverid}) @ ${hidPath}`);
    notifyDevicesChanged();
    return rec;
}

function removeMockDevice(ref) {
    const guid = resolveGuid(ref);
    if (!guid) return false;
    const rec = devices.get(guid);
    if (!rec || rec.kind !== 'mock') return false;
    closeDevice(guid);
    return true;
}

function spawnMockDevices() {
    let existing = 0;
    for (const rec of devices.values()) if (rec.kind === 'mock') existing++;
    for (let i = existing; i < MOCK_DEVICE_COUNT; i++) addMockDevice();
}

function removeMockDevices() {
    for (const [guid, rec] of [...devices]) {
        if (rec.kind === 'mock') closeDevice(guid);
    }
}

// ---------------------------------------------------------------------------
// Per-device I/O
// ---------------------------------------------------------------------------

function emitReportFromDevice(device, reportBytes) {
    if (device.subscribers.size === 0) {
        const now = Date.now();
        if (!device._lastIdleLogAt || now - device._lastIdleLogAt >= 1000) {
            device._lastIdleLogAt = now;
            addMessageLog({
                timestamp: new Date().toISOString(),
                guid: device.guid,
                serverid: device.serverid,
                type: 'report',
                direction: 'outbound',
                payload: b64encode(reportBytes),
                note: 'no subscribers',
            });
        }
        return;
    }

    const data = b64encode(reportBytes);
    addMessageLog({
        timestamp: new Date().toISOString(),
        guid: device.guid,
        serverid: device.serverid,
        type: 'report',
        direction: 'outbound',
        payload: data,
    });

    const msg = JSON.stringify({
        type: 'report',
        guid: device.guid,
        serverid: device.serverid,
        data,
    });

    for (const ws of device.subscribers) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch (e) {
            console.error('Send to client failed:', e.message);
        }
    }
}

function sendBytesToDevice(device, bytes) {
    if (!Array.isArray(bytes) || bytes.length === 0) return false;
    if (bytes.length > MAX_HID_REPORT_BYTES) {
        console.warn(`Rejecting ${bytes.length}-byte write to ${device.guid} (max ${MAX_HID_REPORT_BYTES})`);
        return false;
    }

    addMessageLog({
        timestamp: new Date().toISOString(),
        guid: device.guid,
        serverid: device.serverid,
        type: 'request',
        direction: 'inbound',
        payloadHex: bytesToHex(bytes),
        payloadBase64: b64encode(bytes),
    });

    let ok = false;
    let stateChanged = false;

    if (device.kind === 'mock') {
        stateChanged = handleMockWrite(device, bytes);
        ok = true;
    } else if (device.hid) {
        // Parse the request to detect state changes before sending to hardware
        let parsed;
        try { parsed = parseRequest(bytes); }
        catch (e) { console.error(`parseRequest threw on ${device.guid}:`, e.message); }

        try { device.hid.write(new Uint8Array(bytes)); ok = true; }
        catch (e) { closeDevice(device.guid); return false; }

        // Apply the write to settings so subscribers are notified of changes
        if (parsed) {
            stateChanged = applyWrite(device, parsed.code, parsed.data);
        }
    } else {
        return false;
    }

    if (ok && stateChanged) notifySettingsForDevice(device);
    return ok;
}

function notifySettingsForDevice(device) {
    if (device.subscribers.size === 0) return;
    const msg = JSON.stringify({
        type: 'settings_update',
        guid: device.guid,
        serverid: device.serverid,
        timestamp: new Date().toISOString(),
        channels: device.settings.channels,
        routing: device.settings.routing,
    });
    for (const ws of device.subscribers) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {}
    }
}

// ---------------------------------------------------------------------------
// Devices-change SSE
// ---------------------------------------------------------------------------

const devicesChangeSubscribers = new Set();

function devicesSnapshot() {
    return [...devices.values()].map(d => ({
        guid: d.guid,
        serverid: d.serverid,
        kind: d.kind,
        path: d.path,
        product: d.product,
        connectedAt: d.connectedAt,
        subscriberCount: d.subscribers.size,
    }));
}

function notifyDevicesChanged() {
    const snap = devicesSnapshot();
    for (const cb of devicesChangeSubscribers) {
        try { cb(snap); } catch (e) { console.error('Devices SSE error:', e.message); }
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
    '.map':  'application/json; charset=utf-8',
};

async function serveStatic(res, name) {
    const resolved = join(PUBLIC_DIR, name);
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Forbidden');
        return;
    }
    try {
        const data = await readFile(resolved);
        const ext = extname(name);
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('Not found');
    }
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
}

async function getLocalAddress() {
    if (BIND_HOST !== '0.0.0.0') return BIND_HOST;
    try {
        const os = await import('node:os');
        for (const iface of Object.values(os.networkInterfaces())) {
            if (!iface) continue;
            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) return addr.address;
            }
        }
    } catch (e) { console.warn('getLocalAddress failed:', e.message); }
    return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    addConnectionLog({
        timestamp: new Date().toISOString(),
        type: 'http_request',
        method: req.method,
        path: req.url,
        ip: req.socket.remoteAddress || 'unknown',
        headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
        query: req.url.includes('?') ? req.url.split('?')[1] : null,
    });

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/' && req.method === 'GET') return serveStatic(res, 'index.html');

    if (path === '/status') {
        return json(res, 200, {
            connected: devices.size > 0,
            deviceCount: devices.size,
            hidCount: [...devices.values()].filter(d => d.kind === 'hid').length,
            mockCount: [...devices.values()].filter(d => d.kind === 'mock').length,
            mockMode,
        });
    }

    if (path === '/server-info') {
        return json(res, 200, {
            serverId: SERVER_ID,
            port: PORT,
            host: await getLocalAddress(),
            bindHost: BIND_HOST,
            mockMode,
            mockDeviceCount: MOCK_DEVICE_COUNT,
            guids: getAllDeviceGuids(),
            timestamp: new Date().toISOString(),
        });
    }

    if (path === '/devices') {
        const attached = new Set(listHidDevices().map(d => d.path));
        return json(res, 200, {
            serverId: SERVER_ID,
            devices: devicesSnapshot().map(d => ({
                ...d,
                attached: d.kind === 'mock' || attached.has(d.path),
            })),
            hidAttached: [...attached],
        });
    }

    if (path === '/device-guids') {
        return json(res, 200, { serverId: SERVER_ID, guids: getAllDeviceGuids() });
    }

    if (path === '/servers') return json(res, 200, { servers: [] });
    if (path === '/logs/connections') return json(res, 200, connectionLogs);
    if (path === '/logs/messages')   return json(res, 200, messageLogs);

    if (path === '/mock' && req.method === 'POST') {
        const chunks = [];
        let aborted = false;
        req.on('data', c => chunks.push(c));
        req.on('aborted', () => { aborted = true; });
        req.on('error', (e) => {
            console.warn('Mock request error:', e.message);
            if (!res.headersSent) json(res, 400, { message: 'Request error', error: e.message });
        });
        req.on('end', () => {
            if (aborted) return;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

                if (body.add === true) {
                    if (!mockMode) mockMode = true;
                    process.env.MOCK_MODE = String(mockMode);
                    const rec = addMockDevice();
                    return json(res, 200, {
                        message: `Added ${rec.guid}`,
                        guid: rec.guid,
                        serverid: rec.serverid,
                        deviceCount: devices.size,
                    });
                }

                if (typeof body.remove === 'string') {
                    const targetGuid = resolveGuid(body.remove);
                    if (!targetGuid) return json(res, 404, { message: `Unknown device: ${body.remove}` });
                    const target = devices.get(targetGuid);
                    if (!target || target.kind !== 'mock') {
                        return json(res, 404, { message: `Not a mock device: ${body.remove}` });
                    }
                    closeDevice(targetGuid);
                    return json(res, 200, {
                        message: `Removed ${target.guid}`,
                        guid: target.guid,
                        serverid: target.serverid,
                        deviceCount: devices.size,
                    });
                }

                if (body.remove === true) {
                    const before = devices.size;
                    removeMockDevices();
                    return json(res, 200, {
                        message: `Removed ${before - devices.size} mock device(s)`,
                        removedCount: before - devices.size,
                        deviceCount: devices.size,
                    });
                }

                if (typeof body.enable === 'boolean') {
                    mockMode = body.enable;
                    process.env.MOCK_MODE = String(mockMode);
                    if (mockMode) spawnMockDevices();
                    else removeMockDevices();
                    return json(res, 200, {
                        message: `Mock mode ${mockMode ? 'enabled' : 'disabled'}`,
                        enabled: mockMode,
                        deviceCount: devices.size,
                    });
                }

                return json(res, 400, { message: 'Expected one of: { add }, { remove }, { enable }' });
            } catch (e) {
                return json(res, 400, { message: 'Invalid body', error: e.message });
            }
        });
        return;
    }

    if (path === '/devices/changes' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        const cb = (snap) => {
            try {
                res.write(`data: ${JSON.stringify({
                    type: 'devices_update',
                    serverId: SERVER_ID,
                    devices: snap,
                })}\n\n`);
            } catch (e) { console.error('Devices SSE write error:', e.message); }
        };
        devicesChangeSubscribers.add(cb);
        cb(devicesSnapshot());
        req.on('close', () => devicesChangeSubscribers.delete(cb));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('openDSP-4x4 bridge');
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_WS_PAYLOAD });

const clientSubscriptions = new WeakMap();
let nextClientId = 0;

function getSubs(ws) {
    let s = clientSubscriptions.get(ws);
    if (!s) { s = new Set(); clientSubscriptions.set(ws, s); }
    return s;
}

/**
 * Accept a guid (or, for backwards compatibility, a "SERVER-guid" style ref)
 * and return the guid, or null if unknown.
 */
function resolveGuid(ref) {
    if (!ref || typeof ref !== 'string') return null;
    if (devices.has(ref)) return ref;
    const dash = ref.indexOf('-');
    if (dash > 0) {
        const maybeGuid = ref.slice(dash + 1);
        if (devices.has(maybeGuid)) return maybeGuid;
    }
    return null;
}

function subscribe(ws, ref) {
    const guid = resolveGuid(ref);
    if (!guid) return false;
    const device = devices.get(guid);

    if (device.subscribers.has(ws)) {
        sendToClient(ws, {
            type: 'subscribed',
            guid: device.guid,
            serverid: device.serverid,
            product: device.product,
            kind: device.kind,
            subscriberCount: device.subscribers.size,
            alreadySubscribed: true,
        });
        return true;
    }

    device.subscribers.add(ws);
    getSubs(ws).add(guid);

    sendToClient(ws, {
        type: 'subscribed',
        guid: device.guid,
        serverid: device.serverid,
        product: device.product,
        kind: device.kind,
        subscriberCount: device.subscribers.size,
    });
    sendToClient(ws, {
        type: 'settings_update',
        guid: device.guid,
        serverid: device.serverid,
        timestamp: new Date().toISOString(),
        channels: device.settings.channels,
        routing: device.settings.routing,
    });

    notifyDevicesChanged();
    return true;
}

function unsubscribe(ws, ref) {
    const guid = resolveGuid(ref);
    const device = guid ? devices.get(guid) : null;
    if (device) device.subscribers.delete(ws);
    if (guid) getSubs(ws).delete(guid);
    sendToClient(ws, {
        type: 'unsubscribed',
        guid: device ? device.guid : null,
        serverid: device ? device.serverid : null,
        subscriberCount: device ? device.subscribers.size : null,
    });
    notifyDevicesChanged();
    return true;
}

function sendToClient(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
    const clientId = nextClientId++;
    console.log(`Client #${clientId} connected`);

    const autoDevice = new URL(req.url, 'http://localhost').searchParams.get('device');
    if (autoDevice) {
        if (!subscribe(ws, autoDevice)) {
            sendToClient(ws, {
                type: 'error',
                code: 'unknown_device',
                message: `Unknown guid: ${autoDevice}`,
                ref: autoDevice,
            });
        }
    }

    ws.on('message', (data) => {
        try {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            if (text.length > MAX_WS_PAYLOAD) {
                return sendToClient(ws, { type: 'error', code: 'payload_too_large' });
            }
            const msg = JSON.parse(text);
            if (!msg) return;

            // Accept guid, serverid, or deviceId — all resolve to a guid.
            const ref = msg.guid ?? msg.deviceId ?? null;

            if (msg.type === 'action') {
                switch (msg.action) {
                    case 'list_devices':
                        return sendToClient(ws, {
                            type: 'devices',
                            serverId: SERVER_ID,
                            devices: devicesSnapshot().map(d => ({
                                ...d,
                                subscribed: getSubs(ws).has(d.guid),
                            })),
                        });
                    case 'subscribe':   if (ref) subscribe(ws, ref);   return;
                    case 'unsubscribe': if (ref) unsubscribe(ws, ref); return;
                    case 'subscribe_all':
                        for (const guid of devices.keys()) subscribe(ws, guid);
                        return;
                    case 'unsubscribe_all':
                        for (const guid of [...getSubs(ws)]) unsubscribe(ws, guid);
                        return;
                }
                return;
            }

            if (msg.type === 'request' && msg.data) {
                const bytes = b64decode(msg.data);
                if (bytes.length > MAX_HID_REPORT_BYTES) {
                    return sendToClient(ws, {
                        type: 'error',
                        code: 'report_too_large',
                        message: `Report is ${bytes.length} bytes; max is ${MAX_HID_REPORT_BYTES}`,
                    });
                }
                let targets = [];
                if (ref) {
                    const guid = resolveGuid(ref);
                    if (guid) targets = [devices.get(guid)];
                } else {
                    for (const guid of getSubs(ws)) {
                        const dev = devices.get(guid);
                        if (dev) targets.push(dev);
                    }
                }
                if (targets.length === 0) {
                    console.warn('No subscribed device for message — dropping');
                    return;
                }
                for (const dev of targets) if (dev) sendBytesToDevice(dev, bytes);
            }
        } catch (e) {
            console.error('Error handling message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`Client #${clientId} disconnected`);
        for (const rec of devices.values()) rec.subscribers.delete(ws);
        notifyDevicesChanged();
    });

    ws.on('error', (err) => console.error('WebSocket error:', err.message));
});

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

async function killProcessOnPort(port) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
        const child = spawn('lsof', ['-ti:' + port]);
        let out = '';
        child.stdout.on('data', d => (out += d.toString()));
        child.on('close', (code) => {
            if (code === 0 && out.trim()) {
                for (const pid of out.trim().split('\n')) {
                    try { process.kill(Number(pid), 'SIGTERM'); } catch {}
                }
                resolve(true);
            } else resolve(false);
        });
        child.on('error', () => resolve(false));
    });
}

let hidScanInterval = null;
let shuttingDown = false;

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down...');

    if (hidScanInterval) { clearInterval(hidScanInterval); hidScanInterval = null; }
    if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
    try {
        const { writeFileSync, mkdirSync } = require('node:fs');
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(persistedState, null, 2));
    } catch { /* ignore */ }

    for (const guid of [...devices.keys()]) closeDevice(guid);

    for (const ws of wss.clients) {
        try { ws.close(1001, 'server shutting down'); } catch {}
    }

    const finish = () => process.exit(0);
    const timer = setTimeout(finish, 2000);
    timer.unref?.();

    wss.close(() => {
        httpServer.close(() => {
            clearTimeout(timer);
            process.exit(0);
        });
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function startListening() {
    httpServer.listen(PORT, BIND_HOST, async () => {
        const host = await getLocalAddress();
        console.log(`WebSocket bridge on ws://${host}:${PORT}  (bind ${BIND_HOST})`);
        console.log(`HTTP  dashboard  http://${host}:${PORT}/`);
        console.log(`Mock mode: ${mockMode ? 'enabled' : 'disabled'} (${MOCK_DEVICE_COUNT} mock devices)`);
        console.log(`Server ID: ${SERVER_ID}`);
        console.log(`State file: ${STATE_FILE}`);
        console.log(`Verbose frame logs: ${DEBUG_FRAMES ? 'ON' : 'OFF'} (DEBUG_FRAMES=${process.env.DEBUG_FRAMES ?? 'default'})`);

        if (mockMode) spawnMockDevices();
        else scanAndSyncHidDevices();

        hidScanInterval = setInterval(() => { if (!mockMode) scanAndSyncHidDevices(); }, 2000);
    });
}

httpServer.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} in use — attempting to free it...`);
        const ok = await killProcessOnPort(PORT);
        if (ok) setTimeout(startListening, 500);
        else { console.error('Could not free port. Kill the process and retry.'); process.exit(1); }
    } else throw err;
});

startListening();