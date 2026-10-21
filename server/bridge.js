// WebSocket to USB HID bridge for openDSP-4x4 — multi-device
// No master/slave logic; leadership is decided by the UI.
// Supports N HID devices and N mock devices.
//
// Identifier model:
//   SERVER_ID  = 5-char alphanumeric server id (e.g. "Q7X2K")
//   device.guid= "DSP" + 5-char alphanumeric (e.g. "DSP7C4H9")
//   device.publishedId = SERVER_ID + "-" + device.guid  (e.g. "Q7X2K-DSP7C4H9")
//
// SERVER_ID and per-device GUIDs are PERSISTED to disk, so they survive
// restarts. This makes `publishedId` stable across process lifetimes —
// a UI can remember a device by its publishedId and expect it to refer
// to the same physical device (HID path) or mock slot on reconnect.
//
// Serial numbers are intentionally NOT exposed. GUIDs are stable per
// physical device (HID path) or per mock slot (mock-device-N).

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
const MOCK_DEVICE_COUNT = Math.max(1, Number(process.env.MOCK_DEVICES) || 4);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

// Bind to loopback by default. Set BRIDGE_HOST=0.0.0.0 to expose on LAN
// (do this only if you understand that any origin can then drive HID).
const BIND_HOST = process.env.BRIDGE_HOST || '127.0.0.1';

// Cap on incoming WS frame size. A single HID report is 64 bytes; base64
// inflates that to ~88 chars; JSON envelope is small. 64 KiB is generous.
const MAX_WS_PAYLOAD = 64 * 1024;

// Max HID report length we will forward to a device. The device protocol
// uses fixed 64-byte reports.
const MAX_HID_REPORT_BYTES = 64;

// Where to persist SERVER_ID + device GUID registry.
const STATE_DIR = process.env.BRIDGE_STATE_DIR
    || join(homedir(), '.opendsp-bridge');
const STATE_FILE = join(STATE_DIR, 'registry.json');

let mockMode = process.env.MOCK_MODE === 'true';

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

// Persistent state: { serverId, deviceGuids: { [key]: "DSPxxxxx" } }
const persistedState = {
    serverId: null,
    deviceGuids: {},
};

async function loadState() {
    try {
        const raw = await readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.serverId === 'string' && /^[A-Z0-9]{5}$/.test(parsed.serverId)) {
            persistedState.serverId = parsed.serverId;
        }
        if (parsed.deviceGuids && typeof parsed.deviceGuids === 'object') {
            for (const [k, v] of Object.entries(parsed.deviceGuids)) {
                if (typeof v === 'string' && /^DSP[A-Z0-9]{5}$/.test(v)) {
                    persistedState.deviceGuids[k] = v;
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
            await rename(tmp, STATE_FILE); // atomic on POSIX
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

function ensureDeviceGuid(key) {
    if (!persistedState.deviceGuids[key]) {
        persistedState.deviceGuids[key] = 'DSP' + randomId(5);
        scheduleStateSave();
    }
    return persistedState.deviceGuids[key];
}

function publishedId(guid) {
    return `${SERVER_ID}-${guid}`;
}

function getAllDeviceGuids() {
    return Object.entries(persistedState.deviceGuids).map(([key, guid]) => ({
        key,
        guid,
        publishedId: publishedId(guid),
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
// Protocol (DLE / STX / ETX framing)
// ---------------------------------------------------------------------------

const DLE = 0x10, STX = 0x02, ETX = 0x03;

function frameChecksum(bytes) {
    let x = 0;
    for (let i = 0; i < bytes.length; i++) x ^= bytes[i];
    // LSB inverted per device protocol.
    return (x ^ 1) & 0xff;
}

// Build a 64-byte report. Throws if the payload doesn't fit so a bad
// call-site is caught immediately rather than silently truncated.
function buildReplyFrame(payload) {
    const payloadWithHeader = [0x01, 0x00, 1 + payload.length, ...payload];
    const checksum = frameChecksum(payloadWithHeader);

    // DLE STX <payloadWithHeader> DLE ETX <checksum>
    const totalLen = 2 + payloadWithHeader.length + 2 + 1;
    if (totalLen > MAX_HID_REPORT_BYTES) {
        throw new Error(
            `Reply payload too large: ${payload.length} bytes (framed ${totalLen} > ${MAX_HID_REPORT_BYTES})`,
        );
    }
    if (payloadWithHeader.length > 0xff) {
        throw new Error('Reply payload length exceeds length-byte limit');
    }

    const report = new Uint8Array(MAX_HID_REPORT_BYTES).fill(0);
    let pos = 0;
    report[pos++] = DLE;
    report[pos++] = STX;
    for (const b of payloadWithHeader) report[pos++] = b & 0xff;
    report[pos++] = DLE;
    report[pos++] = ETX;
    report[pos] = checksum;
    return report;
}

const b64encode = (bytes) => Buffer.from(bytes).toString('base64');
const b64decode = (str) => Array.from(Buffer.from(str, 'base64'));

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const connectionLogs = [];
const messageLogs = [];

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
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

// Returns a summary object; does NOT mutate `entry`.
function summarizeEntry(entry) {
    if (entry.payloadHex) return { kind: 'hex', text: entry.payloadHex };
    if (entry.payloadJson) return { kind: 'json', text: entry.payloadJson };
    if (entry.payloadBase64) {
        try {
            const bytes = b64decode(entry.payloadBase64);
            const str = tryDecodeString(bytes);
            if (str && /^[\s[{]/.test(str)) {
                try {
                    const json = JSON.stringify(JSON.parse(str));
                    return { kind: 'json', text: json };
                } catch { /* not JSON */ }
            }
            return { kind: 'hex', text: bytesToHex(bytes) };
        } catch { /* ignore */ }
    }
    if (entry.payloadText) return { kind: 'text', text: entry.payloadText };
    return { kind: 'none', text: '' };
}

// Build a derived log record (input is not mutated). Decodes base64 payload
// into hex / text / json as appropriate.
function makeMessageLog(entry) {
    const out = { ...entry };
    if (entry.payload && typeof entry.payload === 'string' && !out.payloadHex && !out.payloadBase64) {
        try {
            const bytes = b64decode(entry.payload);
            out.payloadBase64 = entry.payload;
            out.payloadHex = bytesToHex(bytes);
            const str = tryDecodeString(bytes);
            if (str && /^[\s[{]/.test(str)) {
                try {
                    out.payloadJson = JSON.stringify(JSON.parse(str));
                } catch { /* fall through to hex */ }
            } else if (str) {
                out.payloadText = str;
            }
        } catch {
            out.payloadText = entry.payload;
        }
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

// ---------------------------------------------------------------------------
// DeviceSvelte registry
// ---------------------------------------------------------------------------

const devices = new Map(); // id -> DeviceRecord
const openingPaths = new Set(); // guards openHidDevice against re-entry

const DEFAULT_SETTINGS = () => ({
    channels: Array.from({ length: 8 }, (_, i) => ({
        index: i,
        name: `Channel ${i}`,
        gainDb: 0,
        mute: false,
        polarity: false,
        delayMs: null,
        eq: {
            hpf: { freqHz: 20, slope: -12 },
            lpf: { freqHz: 20000, slope: -12 },
            bands: Array.from({ length: 7 }, (_, b) => ({
                type: 'peak', freqHz: 1000 * (b + 1), gainDb: 0, bwOct: 1,
            })),
        },
    })),
    routing: [0x01, 0x02, 0x04, 0x08],
});

function makeDeviceRecord({ id, kind, path, product, hidHandle = null, slotKey = null }) {
    const key = slotKey || path || id;
    const guid = ensureDeviceGuid(key);
    return {
        id,
        kind,
        path,
        product: product || 'DSP 4x4',
        deviceGuid: guid,
        publishedId: publishedId(guid),
        hid: hidHandle,
        subscribers: new Set(),
        settings: DEFAULT_SETTINGS(),
        connectedAt: new Date().toISOString(),
        mockResponseDelayMs: 15,
        closing: false,
    };
}

// ---------------------------------------------------------------------------
// Mock plumbing
// ---------------------------------------------------------------------------

function mockReplyForCommand(bytes) {
    let payloadStart = -1, payloadEnd = -1;
    for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === DLE && bytes[i + 1] === STX) payloadStart = i + 2;
        if (payloadStart >= 0 && bytes[i] === DLE && bytes[i + 1] === ETX) {
            payloadEnd = i;
            break;
        }
    }
    if (payloadStart < 0 || payloadEnd <= payloadStart) return null;

    const code = bytes.slice(payloadStart, payloadEnd)[3];
    switch (code) {
        case 0x10: return [0x01, 0x00, 0x01, 0x02];
        case 0x12: return [0x01, 0x00, 0x01, 0x01];
        case 0x13: {
            const v = '4x4MINIPRO V010';
            const out = [0x01, 0x00, 1 + v.length, 0x52];
            for (const c of v) out.push(c.charCodeAt(0));
            return out;
        }
        case 0x20:
        case 0x21: return [0x01, 0x00, 0x01, 0x01];
        case 0x27: {
            // 54-byte settings blob: [0x01, 0x00, len, 0x27, <50 bytes>]
            // len = total blob length = 54.
            const out = new Array(54).fill(0);
            out[0] = 0x01;
            out[1] = 0x00;
            out[2] = 54;    // length field (matches 0x34 in original, verified)
            out[3] = 0x27;  // command code — FIX: was 0x24 in original
            return out;
        }
        case 0x30: case 0x31: case 0x32: case 0x33:
        case 0x34: case 0x35: case 0x36: case 0x38:
        case 0x3a: case 0x3e: return [0x01, 0x00, 0x01, 0x01];
        case 0x40: {
            const out = new Array(13).fill(0);
            out[0] = 0x01; out[2] = 0x0c; out[3] = 0x40;
            return out;
        }
        default: return null;
    }
}

function handleMockWrite(device, bytes) {
    const reply = mockReplyForCommand(bytes);
    if (!reply) return;
    const frame = buildReplyFrame(reply);
    addMessageLog({
        timestamp: new Date().toISOString(),
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        type: 'mock_response',
        direction: 'outbound',
        payloadHex: bytesToHex(Array.from(frame)),
    });
    setTimeout(() => emitReportFromDevice(device, Array.from(frame)), device.mockResponseDelayMs);
}

// ---------------------------------------------------------------------------
// DeviceSvelte lifecycle
// ---------------------------------------------------------------------------

function openHidDevice(hidPath) {
    if (devices.has(hidPath)) return devices.get(hidPath);
    if (openingPaths.has(hidPath)) return null;
    openingPaths.add(hidPath);

    let handle;
    try {
        handle = new NodeHid.HID(hidPath);
    } catch (e) {
        openingPaths.delete(hidPath);
        console.warn(`Failed to open HID ${hidPath}:`, e.message);
        return null;
    }

    const rec = makeDeviceRecord({
        id: hidPath,
        kind: 'hid',
        path: hidPath,
        product: handle.product || 'DSP 4x4 Mini Pro',
        hidHandle: handle,
        slotKey: hidPath,
    });

    // Register BEFORE attaching listeners so re-entrant calls find it.
    devices.set(hidPath, rec);
    openingPaths.delete(hidPath);

    handle.on('data', (buf) => {
        const bytes = Array.from(buf);
        emitReportFromDevice(rec, bytes);
    });

    handle.on('error', (err) => {
        console.error(`HID ${hidPath} error:`, err.message);
        closeDevice(hidPath);
    });

    console.log(`Opened HID ${hidPath} → ${rec.publishedId}`);
    notifyDevicesChanged();
    return rec;
}

function closeDevice(deviceId) {
    const rec = devices.get(deviceId);
    if (!rec || rec.closing) return;
    rec.closing = true;

    // Remove from map first so re-entrant closeDevice()/openHidDevice()
    // during handle.close() behave sanely.
    devices.delete(deviceId);

    if (rec.hid) {
        try { rec.hid.close(); } catch {}
    }

    const goneMsg = JSON.stringify({
        type: 'device_gone',
        deviceId: rec.id,
        deviceGuid: rec.deviceGuid,
        publishedId: rec.publishedId,
    });
    for (const ws of rec.subscribers) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(goneMsg); } catch {}
    }
    rec.subscribers.clear();

    console.log(`Closed ${deviceId}`);
    notifyDevicesChanged();
}

function scanAndSyncHidDevices() {
    const seen = new Set();
    for (const d of listHidDevices()) {
        seen.add(d.path);
        openHidDevice(d.path);
    }
    for (const [id, rec] of devices) {
        if (rec.kind === 'hid' && !seen.has(id)) closeDevice(id);
    }
}

// ---------------------------------------------------------------------------
// Mock device management
// ---------------------------------------------------------------------------

function nextMockSlot() {
    let n = 1;
    while (devices.has(`mock-device-${n}`)) n++;
    return n;
}

function addMockDevice() {
    const n = nextMockSlot();
    const id = `mock-device-${n}`;
    const rec = makeDeviceRecord({
        id,
        kind: 'mock',
        path: id,
        product: `DSP 4x4 Mini Pro (Mock ${n})`,
        slotKey: id,
    });
    devices.set(id, rec);
    console.log(`Added ${id} → ${rec.publishedId}`);
    notifyDevicesChanged();
    return rec;
}

function removeMockDevice(id) {
    const rec = devices.get(id);
    if (!rec || rec.kind !== 'mock') return false;
    closeDevice(id);
    return true;
}

function spawnMockDevices() {
    // Ensure at least MOCK_DEVICE_COUNT mock devices exist, without
    // duplicating slots on repeated enable:true toggles.
    let existing = 0;
    for (const rec of devices.values()) if (rec.kind === 'mock') existing++;
    for (let i = existing; i < MOCK_DEVICE_COUNT; i++) addMockDevice();
}

function removeMockDevices() {
    for (const [id, rec] of [...devices]) {
        if (rec.kind === 'mock') closeDevice(id);
    }
}

// ---------------------------------------------------------------------------
// Per-device I/O
// ---------------------------------------------------------------------------

function emitReportFromDevice(device, reportBytes) {
    // Always log for diagnostics, but only push over the wire if someone
    // is listening. Throttle log volume: only first report per device per
    // second is logged when there are no subscribers.
    if (device.subscribers.size === 0) {
        const now = Date.now();
        if (!device._lastIdleLogAt || now - device._lastIdleLogAt >= 1000) {
            device._lastIdleLogAt = now;
            addMessageLog({
                timestamp: new Date().toISOString(),
                deviceId: device.id,
                deviceGuid: device.deviceGuid,
                publishedId: device.publishedId,
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
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        type: 'report',
        direction: 'outbound',
        payload: data,
    });

    const msg = JSON.stringify({
        type: 'report',
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
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
        console.warn(`Rejecting ${bytes.length}-byte write to ${device.id} (max ${MAX_HID_REPORT_BYTES})`);
        return false;
    }

    addMessageLog({
        timestamp: new Date().toISOString(),
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        type: 'request',
        direction: 'inbound',
        payloadHex: bytesToHex(bytes),
        payloadBase64: b64encode(bytes),
    });

    if (device.kind === 'mock') { handleMockWrite(device, bytes); return true; }
    if (!device.hid) return false;
    try {
        device.hid.write(new Uint8Array(bytes));
        return true;
    } catch (e) {
        console.error(`HID ${device.id} write error:`, e.message);
        closeDevice(device.id);
        return false;
    }
}

function notifySettingsForDevice(device) {
    if (device.subscribers.size === 0) return;
    const msg = JSON.stringify({
        type: 'settings_update',
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        timestamp: new Date().toISOString(),
        channels: device.settings.channels,
        routing: device.settings.routing,
    });
    for (const ws of device.subscribers) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(msg); } catch {}
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// There is intentionally no periodic settings ticker: settings are sent
// once on subscribe, and would be pushed again on any real change (once
// the protocol parser populates device.settings from HID reports).

// ---------------------------------------------------------------------------
// Devices-change SSE
// ---------------------------------------------------------------------------

const devicesChangeSubscribers = new Set();

function devicesSnapshot() {
    return [...devices.values()].map(d => ({
        id: d.id,
        kind: d.kind,
        path: d.path,
        deviceGuid: d.deviceGuid,
        publishedId: d.publishedId,
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
    // Reject path traversal defensively even though current callers pass
    // hard-coded literals.
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
        res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
        });
        res.end('Not found');
    }
}

function json(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(obj));
}

async function getLocalAddress() {
    // Returns the address we're actually bound to (so a loopback bind
    // reports 127.0.0.1, not a LAN IP the server isn't listening on).
    if (BIND_HOST !== '0.0.0.0') return BIND_HOST;
    try {
        const os = await import('node:os');
        for (const iface of Object.values(os.networkInterfaces())) {
            if (!iface) continue;
            for (const addr of iface) {
                if (addr.family === 'IPv4' && !addr.internal) return addr.address;
            }
        }
    } catch (e) {
        console.warn('getLocalAddress failed:', e.message);
    }
    return '127.0.0.1';
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
    // --- CORS ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

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
            deviceGuids: getAllDeviceGuids(),
            timestamp: new Date().toISOString(),
        });
    }

    if (path === '/devices') {
        const attached = new Set(listHidDevices().map(d => d.path));
        return json(res, 200, {
            serverId: SERVER_ID,
            devices: devicesSnapshot().map(d => ({
                ...d,
                attached: d.kind === 'mock' || attached.has(d.id),
            })),
            hidAttached: [...attached],
        });
    }

    if (path === '/device-guids') {
        return json(res, 200, { serverId: SERVER_ID, deviceGuids: getAllDeviceGuids() });
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
                        message: `Added ${rec.id}`,
                        added: rec.id,
                        deviceGuid: rec.deviceGuid,
                        publishedId: rec.publishedId,
                        deviceCount: devices.size,
                    });
                }

                if (typeof body.remove === 'string') {
                    const ok = removeMockDevice(body.remove);
                    if (!ok) return json(res, 404, { message: `Not a mock device: ${body.remove}` });
                    return json(res, 200, {
                        message: `Removed ${body.remove}`,
                        removed: body.remove,
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
                    if (mockMode) spawnMockDevices();   // ensures at least N, no duplicates
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

function getSubs(ws) {
    let s = clientSubscriptions.get(ws);
    if (!s) { s = new Set(); clientSubscriptions.set(ws, s); }
    return s;
}

function subscribe(ws, deviceId) {
    const device = devices.get(deviceId);
    if (!device) return false;

    if (device.subscribers.has(ws)) {
        // Already subscribed — re-send current state, but don't double-notify.
        sendToClient(ws, {
            type: 'subscribed',
            deviceId: device.id,
            deviceGuid: device.deviceGuid,
            publishedId: device.publishedId,
            product: device.product,
            kind: device.kind,
            subscriberCount: device.subscribers.size,
            alreadySubscribed: true,
        });
        return true;
    }

    device.subscribers.add(ws);
    getSubs(ws).add(deviceId);

    sendToClient(ws, {
        type: 'subscribed',
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        product: device.product,
        kind: device.kind,
        subscriberCount: device ? device.subscribers.size : null,

    });
    sendToClient(ws, {
        type: 'settings_update',
        deviceId: device.id,
        deviceGuid: device.deviceGuid,
        publishedId: device.publishedId,
        timestamp: new Date().toISOString(),
        channels: device.settings.channels,
        routing: device.settings.routing,
    });

    if (device.kind === 'mock') {
        sendToClient(ws, { type: 'report', deviceId: device.id, deviceGuid: device.deviceGuid,
            publishedId: device.publishedId,
            data: b64encode(buildReplyFrame([0x01, 0x00, 0x01, 0x02])) });
        const v = '4x4MINIPRO V010';
        const vp = [0x01, 0x00, 1 + v.length, 0x52];
        for (const c of v) vp.push(c.charCodeAt(0));
        sendToClient(ws, { type: 'report', deviceId: device.id, deviceGuid: device.deviceGuid,
            publishedId: device.publishedId,
            data: b64encode(buildReplyFrame(vp)) });
    }

    notifyDevicesChanged();
    return true;
}

function unsubscribe(ws, deviceId) {
    const device = devices.get(deviceId);
    if (device) device.subscribers.delete(ws);
    getSubs(ws).delete(deviceId);
    sendToClient(ws, {
        type: 'unsubscribed',
        deviceId,
        deviceGuid: device ? device.deviceGuid : null,
        publishedId: device ? device.publishedId : null,
        subscriberCount: device ? device.subscribers.size : null,

    });
    notifyDevicesChanged();
    return true;
}

function sendToClient(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
    let clientId = nextClientId++;
    console.log(`Client #${clientId} connected`);

    const autoDevice = new URL(req.url, 'http://localhost').searchParams.get('device');
    if (autoDevice) {
        if (!subscribe(ws, autoDevice)) {
            sendToClient(ws, {
                type: 'error',
                code: 'unknown_device',
                message: `Unknown deviceId: ${autoDevice}`,
                deviceId: autoDevice,
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

            if (msg.type === 'action') {
                switch (msg.action) {
                    case 'list_devices':
                        return sendToClient(ws, {
                            type: 'devices',
                            serverId: SERVER_ID,
                            devices: devicesSnapshot().map(d => ({
                                ...d,
                                subscribed: getSubs(ws).has(d.id),
                            })),
                        });
                    case 'subscribe':   if (msg.deviceId) subscribe(ws, msg.deviceId);   return;
                    case 'unsubscribe': if (msg.deviceId) unsubscribe(ws, msg.deviceId); return;
                    case 'subscribe_all':
                        for (const id of devices.keys()) subscribe(ws, id);
                        return;
                    case 'unsubscribe_all':
                        for (const id of [...getSubs(ws)]) unsubscribe(ws, id);
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
                if (msg.deviceId) {
                    const dev = devices.get(msg.deviceId);
                    if (dev) targets = [dev];
                } else {
                    for (const id of getSubs(ws)) {
                        const dev = devices.get(id);
                        if (dev) targets.push(dev);
                    }
                }
                if (targets.length === 0) {
                    console.warn('No subscribed device for message — dropping');
                    return;
                }
                for (const dev of targets) sendBytesToDevice(dev, bytes);
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

let nextClientId = 0;


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
        child.on('error', () => resolve(false)); // e.g. lsof missing (Windows)
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
    // Best-effort synchronous state save on shutdown.
    try {
        const { writeFileSync, mkdirSync } = require('node:fs');
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(persistedState, null, 2));
    } catch { /* ignore */ }

    for (const id of [...devices.keys()]) closeDevice(id);

    // Politely close clients so wss.close() can complete without waiting
    // on half-open sockets.
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