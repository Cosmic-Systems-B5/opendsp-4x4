// Reactive device state + controller. UI mutates this (instant), and each change
// is debounced + sent through the (serialized) transport. Engineering-unit params
// are converted to wire values via the Calibration seam.
import { WebHidTransport } from "../transport/webhid.ts";
import { WebSocketTransport } from "../transport/websocket.ts";
import { Dsp } from "../dsp.ts";
import { defaultCalibration, type Calibration } from "../eq/calibration.ts";
import { getLevelsFrame, gainRawToDb } from "../protocol/control.ts";
import { thresholdRawToDb, samplesToMs, rawToQ, peqIndexToHz } from "../protocol/blocks.ts";
import { levelsFromReply, reconstructPresetImage, parsePresetImage } from "../protocol/readback.ts";
import { makeChannels, OUT_BASE, DEFAULT_BAND_FREQS, type Channel } from "./model.ts";
import type { ChannelEq } from "../eq/types.ts";
import { deviceManager } from "./device-manager.ts";
import presetManager from "./preset-manager.ts";
import { mdnsBrowser } from "../mdns/mdns-browser.ts";

const DEFAULTS_KEY = "opendsp-defaults";

export type DeviceRole = 'master' | 'slave';

// mDNS discovery state
let mdnsStarted = false;

/**
 * Start mDNS browser for discovering openDSP servers on the network
 */
export async function startMdnsDiscovery(): Promise<void> {
  if (!mdnsStarted) {
    try {
      await mdnsBrowser.start();
      mdnsStarted = true;
      console.log('mDNS discovery started');
    } catch (e) {
      console.warn('Failed to start mDNS discovery:', e);
    }
  }
}

/**
 * Stop mDNS browser
 */
export async function stopMdnsDiscovery(): Promise<void> {
  if (mdnsStarted) {
    try {
      await mdnsBrowser.stop();
      mdnsStarted = false;
      console.log('mDNS discovery stopped');
    } catch (e) {
      console.warn('Failed to stop mDNS discovery:', e);
    }
  }
}

/**
 * Get list of discovered servers via mDNS
 */
export function getDiscoveredServers() {
  return mdnsBrowser.getServers();
}

// WebSocket URLs for multiple servers - stored in localStorage
function loadWebSocketUrls(): string[] {
  try {
    const saved = localStorage.getItem("opendsp-ws-urls");
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return ["ws://localhost:8765", "ws://localhost:8766", "ws://localhost:8767"];
}

function saveWebSocketUrls(urls: string[]): void {
  try {
    localStorage.setItem("opendsp-ws-urls", JSON.stringify(urls));
  } catch (e) {}
}

// Store for WebSocket URLs
let webSocketUrls = loadWebSocketUrls();

export class DeviceStore {
  connected = false;
  productName = "";
  version = "";
  error = "";
  presetName = "";
  activePreset = -1; // last-recalled preset slot (highlights its pad); -1 = unknown on connect
  hasDefaults = typeof localStorage !== "undefined" && localStorage.getItem(DEFAULTS_KEY) !== null;
  channels: Channel[] = makeChannels();
  routing: number[] = [0x01, 0x02, 0x04, 0x08]; // Out1..4 input masks (default diagonal)
  selected = -1; // selected channel index; -1 = nothing open (collapsed overview on load)
  eqLink: Record<number, number> = {}; // output index -> linked partner (symmetric); EQ edits mirror
  role: DeviceRole = 'master'; // set by DeviceManager when multi-device is active

  private dsp: Dsp | null = null;
  private cal: Calibration = defaultCalibration;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private meterTimer?: ReturnType<typeof setInterval>;

  lastReadback: ReturnType<typeof parsePresetImage> | null = null; // raw readback (debug/calibration)

  get selectedChannel(): Channel | undefined { return this.channels[this.selected]; }
  ch(index: number): Channel { return this.channels[index]!; }
  /** Collapse the open node → all-collapsed patch-board overview. */
  collapse(): void { this.selected = -1; }

  /** Connect via WebSocket to remote DSP servers only.
   *  Attempts to connect to configured URLs in order until one succeeds. */
  async connect(url?: string): Promise<void> {
    try {
      if (!WebSocketTransport.supported())
        throw new Error("WebSocket unavailable");

      // Use provided URL or try all configured URLs
      const urlsToTry = url ? [url] : webSocketUrls;

      for (const serverUrl of urlsToTry) {
        try {
          const t = new WebSocketTransport(serverUrl.trim());
          await this._bind(t);
          console.log(`Connected to server: ${serverUrl}`);
          return;
        } catch (e) {
          console.log(`Failed to connect to ${serverUrl}: ${(e as Error).message}`);
          // Continue to next URL
        }
      }
      this.error = "No available servers. Ensure WebSocket servers are running.";
    } catch (e) { this.error = (e as Error).message; }
  }

  /** Auto-connect to configured WebSocket URLs on page load. */
  async autoConnect(): Promise<void> {
    try {
      if (!WebSocketTransport.supported())
        throw new Error("WebSocket unavailable");

      // Try to connect to all configured URLs until one succeeds
      for (const url of webSocketUrls) {
        try {
          await this._bind(new WebSocketTransport(url.trim()));
          console.log(`Auto-connected to: ${url}`);
          return;
        } catch (e) {
          console.log(`Auto-connect failed to ${url}: ${(e as Error).message}`);
        }
      }
      this.error = "No available servers";
    } catch (e) { this.error = (e as Error).message; }
  }

  private async _bind(t: WebSocketTransport): Promise<void> {
    await t.open();
    this.dsp = new Dsp(t);
    this.version = await this.dsp.getVersion(); // self-wakes (0x10 then 0x13)
    this.productName = t.productName || "DSP 4x4 (remote)";
    this.connected = true;
    this.error = "";
    try { await this.hydrate(); } catch { /* readback is best-effort; UI keeps defaults */ }
    this.startMeters();

    // Register with DeviceManager
    const transportType: 'websocket' = 'websocket';
    deviceManager.connect(this, transportType, {
      url: t.url,
      productName: this.productName
    });
  }

  /** Public version of _bind for direct transport attachment (e.g., multi-device scenarios) */
  async bind(t: WebSocketTransport): Promise<void> {
    await this._bind(t);
  }

  /** Read the 9 channel-state pages on connect → mirror preset name, channel names, gains. */
  private async hydrate(): Promise<void> {
    if (!this.dsp) return;
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const data = await this.dsp.channelState(i); // [idx, ...50B]
      pages[data[0] ?? i] = data.slice(1, 51);
    }
    const pr = parsePresetImage(reconstructPresetImage(pages));
    this.lastReadback = pr; // raw readback kept for calibration/debug (no extra device I/O)
    this.presetName = pr.presetName;
    pr.inputs.forEach((c, i) => {
      const ch = this.ch(i);
      if (c.name) ch.name = c.name;
      ch.gainDb = gainRawToDb(c.gainRaw);
      ch.polarity = c.polarity;
      ch.gate = { attackMs: c.gate.atkRaw, releaseMs: c.gate.relRaw, holdMs: c.gate.holdRaw, thresholdDb: thresholdRawToDb(c.gate.thrRaw) };
    });
    pr.outputs.forEach((c, i) => {
      const ch = this.ch(OUT_BASE + i);
      if (c.name) ch.name = c.name;
      ch.gainDb = gainRawToDb(c.gainRaw);
      ch.polarity = c.polarity;
      ch.delayMs = samplesToMs(c.delaySamples);
      this.routing[i] = c.routingMask; // mirror the device's real input→output routing
      ch.comp = {
        ratioIndex: c.comp.ratioIndex, kneeDb: c.comp.kneeRaw,
        attackMs: c.comp.atkRaw, releaseMs: c.comp.relRaw, thresholdDb: thresholdRawToDb(c.comp.thrRaw),
      };
      if (ch.eq) {
        ch.eq.hpf = { freqHz: this.cal.xoverRawToHz(c.hpfRaw), slope: c.hpfSlope };
        ch.eq.lpf = { freqHz: this.cal.xoverRawToHz(c.lpfRaw), slope: c.lpfSlope };
        ch.eq.bands = c.bands.map((bd) => {
          const freqHz = peqIndexToHz(bd.freqIdx);
          return {
            freqHz, type: bd.type, bypass: false,
            gainDb: this.cal.peqGainRawToDb(bd.gainRaw, bd.type),
            bwOct: this.cal.qToBwOct(rawToQ(bd.qRaw), freqHz),
          };
        });
      }
    });
  }

  /** DEBUG: dump the live channel-state records as hex (full records, to diff Out1 vs Out2). */
  async _dumpRecords(): Promise<Record<string, string>> {
    if (!this.dsp) return {};
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) { const d = await this.dsp.channelState(i); pages[d[0] ?? i] = d.slice(1, 51); }
    const img = reconstructPresetImage(pages);
    const hex = (o: number, n: number) => Array.from(img.slice(o, o + n), (b) => b.toString(16).padStart(2, "0")).join(" ");
    const out: Record<string, string> = {};
    [112, 186, 260, 334].forEach((b, i) => { const h = hex(b, 74); out[`OUT${i + 1}`] = h; console.log(`OUT${i + 1} @${b}: ${h}`); });
    [16, 40, 64, 88].forEach((b, i) => { const h = hex(b, 24); out[`IN${"ABCD"[i]}`] = h; console.log(`IN${"ABCD"[i]} @${b}: ${h}`); });
    return out;
  }

  /** Poll the device's 8 I/O levels (~10 Hz) into channel meters. */
  private startMeters(): void {
    this.stopMeters();
    let busy = false; // skip a tick if the previous poll hasn't replied — avoids piling up the transport
    // Meter smoothing: alpha for exponential moving average (0.3 = 30% new value, 70% old)
    const METER_SMOOTHING = 0.3;
    this.meterTimer = setInterval(() => {
      if (!this.dsp || busy) return;
      busy = true;
      void this.dsp.send(getLevelsFrame()).then((r) => {
        const lv = levelsFromReply(r);
        if (lv) for (let i = 0; i < 8; i++) {
          // Smooth meter values to prevent jumpy display
          const currentMeter = this.ch(i).meter;
          const newMeter = lv[i]!;
          // Only apply smoothing if we have a valid previous value
          this.ch(i).meter = currentMeter === 0 && newMeter < 0.05 ? newMeter :
            currentMeter + METER_SMOOTHING * (newMeter - currentMeter);
        }
      }).catch(() => {}).finally(() => { busy = false; });
    }, 100);
  }
  private stopMeters(): void { if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = undefined; } }

  /** Debounce by key; coalesces rapid changes (e.g. a fader/EQ drag) into one send. */
  private commit(key: string, fn: () => void, delay = 40): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.dsp) void Promise.resolve().then(fn).catch(() => {}).finally(() => {
        // Broadcast changes to slaves after successful commit
        this.broadcastToSlaves();
      });
    }, delay));
  }

  /** Broadcast channel updates to all slave devices */
  private broadcastToSlaves(): void {
    if (this.role === 'slave') return; // Slaves don't broadcast

    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      deviceManager.broadcastChannelUpdate(i, {
        gainDb: ch.gainDb,
        mute: ch.mute,
        polarity: ch.polarity
      });

      if (ch.isOutput) {
        // Sync routing for outputs
        const outIndex = i - OUT_BASE;
        if (outIndex >= 0 && outIndex < this.routing.length) {
          const thisRouting = this.routing[outIndex];
          if (thisRouting) {
            deviceManager.broadcastRoutingUpdate(i, thisRouting);
          } else {
            console.warn(`Routing ${i} not found.`);
          }
        }

        // Sync EQ bands
        if (ch.eq?.bands) {
          ch.eq.bands.forEach((band, bandIdx) => {
            deviceManager.broadcastEqBandUpdate(i, bandIdx, {
              freqHz: band.freqHz,
              gainDb: band.gainDb,
              bwOct: band.bwOct,
              type: band.type
            });
          });
        }

        // Sync crossover
        if (ch.eq?.hpf) {
          deviceManager.broadcastEqCrossoverUpdate(i, 'hpf', { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope });
        }
        if (ch.eq?.lpf) {
          deviceManager.broadcastEqCrossoverUpdate(i, 'lpf', { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope });
        }

        // Sync delay
        deviceManager.broadcastChannelUpdate(i, { delayMs: ch.delayMs });

        // Sync compressor
        if (ch.comp) {
          deviceManager.broadcastChannelUpdate(i, { comp: structuredClone(ch.comp) });
        }
      } else {
        // Sync gate for inputs
        if (ch.gate) {
          deviceManager.broadcastChannelUpdate(i, { gate: structuredClone(ch.gate) });
        }
      }
    }

    // Sync EQ links
    const linkKeys = Object.keys(this.eqLink);
    if (linkKeys.length > 0) {
      linkKeys.forEach(key => {
        const a = parseInt(key);
        const b = this.eqLink[a];
        if (b !== undefined) deviceManager.broadcastEqLinkUpdate(a, b);
      });
    }
  }

  // --- channel basics ---
  setGainDb(i: number, db: number): void { this.ch(i).gainDb = db; this.commit(`gain${i}`, () => this.dsp!.setLevelDb(i, db)); }
  setMute(i: number, on: boolean): void { this.ch(i).mute = on; this.commit(`mute${i}`, () => this.dsp!.mute(i, on), 0); }
  setPolarity(i: number, inv: boolean): void { this.ch(i).polarity = inv; this.commit(`pol${i}`, () => this.dsp!.setPolarity(i, inv), 0); }
  toggleEqMode(i: number): void { const ch = this.ch(i); if (ch.eq) ch.eqMode = ch.eqMode === "geq" ? "peq" : "geq"; }

  // --- EQ (commit reads the already-mutated band; UI mutates eq directly for instant draw) ---
  commitPeqBand(i: number, band: number): void {
    this.sendPeqBand(i, band);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      Object.assign(this.ch(p).eq!.bands[band]!, { ...this.ch(i).eq!.bands[band]! });
      this.sendPeqBand(p, band);
    }
  }
  private sendPeqBand(i: number, band: number): void {
    const b = this.ch(i).eq!.bands[band]!;
    this.commit(`peq${i}.${band}`, () => this.dsp!.peqBand(i, band, {
      freqHz: b.freqHz, q: this.cal.bwOctToQ(b.bwOct, b.freqHz),
      gainRaw: this.cal.peqGainDbToRaw(b.gainDb, b.type), type: b.type, bypass: b.bypass,
    }));
  }
  commitHpf(i: number): void { this.sendHpf(i); const p = this.eqLink[i]; if (p !== undefined && this.ch(p).eq) { this.ch(p).eq!.hpf = { ...this.ch(i).eq!.hpf! }; this.sendHpf(p); } }
  commitLpf(i: number): void { this.sendLpf(i); const p = this.eqLink[i]; if (p !== undefined && this.ch(p).eq) { this.ch(p).eq!.lpf = { ...this.ch(i).eq!.lpf! }; this.sendLpf(p); } }
  private sendHpf(i: number): void { const x = this.ch(i).eq!.hpf; this.commit(`hpf${i}`, () => this.dsp!.crossoverHpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope)); }
  private sendLpf(i: number): void { const x = this.ch(i).eq!.lpf; this.commit(`lpf${i}`, () => this.dsp!.crossoverLpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope)); }

  /** Reset one PEQ band to its default (centre freq, 0 dB, 1 oct, peak). */
  resetBand(i: number, band: number): void {
    const b = this.ch(i).eq!.bands[band]!;
    b.freqHz = DEFAULT_BAND_FREQS[band] ?? 1000; b.gainDb = 0; b.bwOct = 1; b.type = 0; b.bypass = false;
    this.commitPeqBand(i, band);
  }
  /** Copy a whole channel's EQ (7 bands + crossover) to another output and push it. */
  copyEqTo(src: number, dst: number): void {
    const s = this.ch(src).eq; if (!s || !this.ch(dst).eq) return;
    this.ch(dst).eq = structuredClone(s) as ChannelEq;
    this.pushEq(dst);
  }
  private pushEq(i: number): void {
    const eq = this.ch(i).eq; if (!eq) return;
    for (let b = 0; b < eq.bands.length; b++) this.sendPeqBand(i, b);
    this.sendHpf(i); this.sendLpf(i);
  }
  /** Link two outputs' EQ so edits to either mirror to the other (and sync b←a now). */
  linkEq(a: number, b: number): void {
    this.eqLink = { ...this.eqLink, [a]: b, [b]: a };
    this.copyEqTo(a, b);
    deviceManager.broadcastEqLinkUpdate(a, b);
  }
  unlinkEq(a: number): void {
    const b = this.eqLink[a]; const next = { ...this.eqLink };
    delete next[a]; if (b !== undefined) delete next[b];
    this.eqLink = next;
    // Broadcast removal of EQ link
    deviceManager.broadcastEqLinkUpdate(a, -1);
  }

  // --- dynamics / delay / routing ---
  setDelayMs(i: number, ms: number): void { this.ch(i).delayMs = ms; this.commit(`delay${i}`, () => this.dsp!.delayMs(i, ms)); }
  commitComp(i: number): void { const c = this.ch(i).comp!; this.commit(`comp${i}`, () => this.dsp!.compressor(i, c)); }
  commitGate(i: number): void { const g = this.ch(i).gate!; this.commit(`gate${i}`, () => this.dsp!.gate(i, g)); }
  setRouting(outIndex: number, mask: number): void { this.routing[outIndex - 0x04] = mask; this.commit(`route${outIndex}`, () => this.dsp!.routing(outIndex, mask), 0); }

  // --- global ---
  async recallPreset(slot: number): Promise<void> {
    if (this.dsp) {
      this.activePreset = slot;
      await this.dsp.recallPreset(slot);
      // Re-read all channel states after recall
      try { await this.hydrate(); } catch { /* ignore errors */ }
    }
  }
  storePreset(slot: number): void { if (this.dsp) void this.dsp.storePreset(slot); }
  testTone(source: number, freqIndex = 0): void { if (this.dsp) void this.dsp.testTone(source, freqIndex); }
  setPassword(pw: string): void { if (this.dsp) void this.dsp.setPassword(pw); }

  // --- defaults snapshot (browser localStorage; not a device preset slot) ---
  saveDefaults(): void {
    try {
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ channels: this.channels, routing: this.routing }));
      this.hasDefaults = true;
    } catch { /* storage unavailable */ }
  }
  async restoreDefaults(): Promise<void> {
    let raw: string | null = null;
    try { raw = localStorage.getItem(DEFAULTS_KEY); } catch { /* ignore */ }
    if (!raw) return;
    const snap = JSON.parse(raw) as { channels: Channel[]; routing: number[] };
    this.channels = snap.channels;
    this.routing = snap.routing;
    await this.pushAll();
  }
  /** Re-send every channel's full state to the device (Restore Defaults). Meters paused to avoid contention. */
  async pushAll(): Promise<void> {
    if (!this.dsp) return;
    this.stopMeters();
    try {
      for (let i = 0; i < this.channels.length; i++) {
        const ch = this.channels[i]!;
        await this.dsp.setLevelDb(i, ch.gainDb);
        await this.dsp.setPolarity(i, ch.polarity);
        await this.dsp.mute(i, ch.mute);
        if (ch.gate) await this.dsp.gate(i, ch.gate);
        if (ch.isOutput) {
          if (ch.delayMs != null) await this.dsp.delayMs(i, ch.delayMs);
          if (ch.comp) await this.dsp.compressor(i, ch.comp);
          await this.dsp.routing(i, this.routing[i - OUT_BASE] ?? 0);
          if (ch.eq) {
            await this.dsp.crossoverHpf(i, this.cal.xoverHzToRaw(ch.eq.hpf.freqHz), ch.eq.hpf.slope);
            await this.dsp.crossoverLpf(i, this.cal.xoverHzToRaw(ch.eq.lpf.freqHz), ch.eq.lpf.slope);
            for (let band = 0; band < ch.eq.bands.length; band++) {
              const b = ch.eq.bands[band]!;
              await this.dsp.peqBand(i, band, {
                freqHz: b.freqHz, q: this.cal.bwOctToQ(b.bwOct, b.freqHz),
                gainRaw: this.cal.peqGainDbToRaw(b.gainDb, b.type), type: b.type, bypass: b.bypass,
              });
            }
          }
        }
      }
    } finally { this.startMeters(); }
  }

  // --- JSON Preset Save/Load ---
  async savePresetToJson(): Promise<void> {
    const presetData = presetManager.exportCurrentPreset();
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(presetData);
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", `dsp-preset-${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    } catch (e) {
      console.error('Error saving preset:', e);
      throw new Error(`Failed to save preset: ${(e as Error).message}`);
    }
  }

  async loadPresetFromJson(jsonString: string): Promise<void> {
    try {
      const parsed = JSON.parse(jsonString);
      presetManager.importPreset(parsed);
    } catch (e) {
      console.error('Error loading preset:', e);
      throw new Error(`Invalid preset data: ${(e as Error).message}`);
    }
  }

  // --- Server URL Management ---
  addServerUrl(url: string): void {
    if (!webSocketUrls.includes(url)) {
      webSocketUrls = [...webSocketUrls, url];
      saveWebSocketUrls(webSocketUrls);
    }
  }

  removeServerUrl(index: number): void {
    webSocketUrls = webSocketUrls.filter((_, i) => i !== index);
    saveWebSocketUrls(webSocketUrls);
  }

  updateServerUrl(index: number, newUrl: string): void {
    webSocketUrls[index] = newUrl;
    saveWebSocketUrls(webSocketUrls);
  }
}

// Export the singleton instance
export const device = new DeviceStore();

// --- mDNS Server Discovery Callbacks ---
let serverListCallbacks: Set<(servers: any[]) => void> = new Set();

/**
 * Register a callback for when the server list changes
 */
export function onServerListChange(callback: (servers: any[]) => void): () => void {
  serverListCallbacks.add(callback);
  return () => serverListCallbacks.delete(callback);
}

/**
 * Notify listeners of server list changes
 */
function notifyServerListChange(servers: any[]) {
  for (const callback of serverListCallbacks) {
    try {
      callback(servers);
    } catch (e) {
      console.error('Error in server list change callback:', e);
    }
  }
}

// Export for backward compatibility - single device mode still works
export { deviceManager } from "./device-manager.ts";
