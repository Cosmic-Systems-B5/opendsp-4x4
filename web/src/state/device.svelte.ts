// Reactive device state + controller. UI mutates this (instant), and each change
// is debounced + sent through the (serialized) transport. Engineering-unit params
// are converted to wire values via the Calibration seam.
import { WebSocketTransport } from "../transport/websocket.ts";
import { Dsp } from "../dsp.ts";
import { defaultCalibration, type Calibration } from "../eq/calibration.ts";
import { getLevelsFrame, gainRawToDb } from "../protocol/control.ts";
import { thresholdRawToDb, samplesToMs, rawToQ, peqIndexToHz } from "../protocol/blocks.ts";
import { levelsFromReply, reconstructPresetImage, parsePresetImage } from "../protocol/readback.ts";
import { makeChannels, defaultChannel, OUT_BASE, DEFAULT_BAND_FREQS, type Channel } from "./model.ts";
import { deviceManager } from "./device-manager.ts";
import { websocketManager } from "./websocket-manager.ts";
import presetManager from "./preset-manager.ts";

const DEFAULTS_KEY = "opendsp-defaults";

export type DeviceRole = 'master' | 'slave';

// WebSocket URLs for multiple servers - stored in localStorage
function loadWebSocketUrls(): string[] {
  try {
    const saved = localStorage.getItem("opendsp-ws-urls");
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return [];
}

function saveWebSocketUrls(urls: string[]): void {
  try {
    localStorage.setItem("opendsp-ws-urls", JSON.stringify(urls));
  } catch (e) {}
}

// Store for WebSocket URLs
let webSocketUrls = $state<string[]>(loadWebSocketUrls());

export class DeviceStore {
  connected = $state(false);
  productName = $state("");
  version = $state("");
  error = $state("");
  presetName = $state("");
  activePreset = $state(-1); // last-recalled preset slot (highlights its pad); -1 = unknown on connect
  hasDefaults = $state(typeof localStorage !== "undefined" && localStorage.getItem(DEFAULTS_KEY) !== null);
  channels = $state<Channel[]>(makeChannels());
  routing = $state<number[]>([0x01, 0x02, 0x04, 0x08]); // Out1..4 input masks (default diagonal)
  selected = $state(-1); // selected channel index; -1 = nothing open (collapsed overview on load)
  eqLink = $state<Record<number, number>>({}); // output index -> linked partner (symmetric); EQ edits mirror
  role: DeviceRole = 'master'; // set by DeviceManager when multi-device is active
  serverGuid?: string; // Unique GUID of the server this device is connected to
  deviceGuid?: string; // Unique GUID of this DSP device

  currentPresetId = $state<string | null>(null); // GUID of the currently loaded preset from localStorage

  get webSocketUrls(): string[] {
    return webSocketUrls;
  }

  private dsp: Dsp | null = null;
  private cal: Calibration = defaultCalibration;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private meterTimer?: ReturnType<typeof setInterval>;

  lastReadback: ReturnType<typeof parsePresetImage> | null = null; // raw readback (debug/calibration)

  get selectedChannel(): Channel | undefined { return this.channels[this.selected]; }
  ch(index: number): Channel {
    // Ensure we always have enough channels
    while (this.channels.length <= index) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    return this.channels[index]!;
  }
  /** Collapse the open node → all-collapsed patch-board overview. */
  collapse(): void { this.selected = -1; }

  /** Connect via WebSocket to remote DSP servers only.
   *  Attempts to connect to configured URLs in order until one succeeds. */
  async connect(url?: string): Promise<void> {
    if (!WebSocketTransport.supported()) {
      this.error = "WebSocket unavailable";
      return;
    }

    // Use provided URL or try all configured URLs
    const urlsToTry = url ? [url] : webSocketUrls;

    for (const serverUrl of urlsToTry) {
      try {
        // Fetch server info and devices from the server before connecting
        let serverGuid: string | undefined;
        let availableDevices: Array<{id: string, deviceGuid: string, publishedId: string}> = [];
        try {
          const httpUrl = serverUrl.replace(/^ws/, 'http');
          const res = await fetch(`${httpUrl}/server-info`);
          if (res.ok) {
            const data = await res.json();
            serverGuid = data.serverId;
          }
          // Also fetch devices list to get available device GUIDs
          const devicesRes = await fetch(`${httpUrl}/devices`);
          if (devicesRes.ok) {
            const devicesData = await devicesRes.json();
            availableDevices = devicesData.devices || [];
          }
        } catch (e) {
          console.warn(`Could not fetch server info from ${serverUrl}:`, e);
        }

        // Check if there are any devices available
        if (availableDevices.length === 0) {
          this.error = "No DSP devices connected to server. Please connect a device or enable mock mode.";
          console.log(`Server ${serverUrl} has no devices available`);
          continue; // Try next URL
        }

        const t = new WebSocketTransport(serverUrl.trim());
        this.serverGuid = serverGuid;
        await this._bind(t, availableDevices);
        console.log(`Connected to server: ${serverUrl} (GUID: ${serverGuid || 'N/A'})`);
        return;
      } catch (e) {
        console.log(`Failed to connect to ${serverUrl}: ${(e as Error).message}`);
        // Continue to next URL
      }
    }
    this.error = "No available servers. Ensure WebSocket servers are running.";
  }

  /** Auto-connect to configured WebSocket URLs on page load. */
  async autoConnect(): Promise<void> {
    if (!WebSocketTransport.supported()) {
      this.error = "WebSocket unavailable";
      return;
    }

    // Try to connect to all configured URLs until one succeeds
    for (const url of webSocketUrls) {
      try {
        // Pre-fetch device info for this URL
        let availableDevices: Array<{id: string, deviceGuid: string, publishedId: string}> = [];
        try {
          const httpUrl = url.replace(/^ws/, 'http');
          const res = await fetch(`${httpUrl}/devices`);
          if (res.ok) {
            const data = await res.json();
            availableDevices = data.devices || [];
          }
        } catch (e) {
          console.warn(`Could not fetch devices from ${url}:`, e);
        }

        // Check if there are any devices available
        if (availableDevices.length === 0) {
          console.log(`Server ${url} has no devices available`);
          continue; // Try next URL
        }

        await this._bind(new WebSocketTransport(url.trim()), availableDevices);
        console.log(`Auto-connected to: ${url}`);
        return;
      } catch (e) {
        console.log(`Auto-connect failed to ${url}: ${(e as Error).message}`);
      }
    }
    this.error = "No available servers";
  }

  private async _bind(t: WebSocketTransport, availableDevices?: Array<{id: string, deviceGuid: string, publishedId: string}>): Promise<void> {
    await t.open();

    // Subscribe to all devices after WebSocket connection is established
    this.subscribeToAllDevices(t);

    this.dsp = new Dsp(t);
    this.version = await this.dsp.getVersion(); // self-wakes (0x10 then 0x13)
    this.productName = t.productName || "DSP 4x4 (remote)";
    this.connected = true;
    this.error = "";

    // Use deviceGuid from transport if available (set via 'subscribed' message)
    if (t.deviceGuid) {
      this.deviceGuid = t.deviceGuid;
    } else {
      // Fallback: try to find a matching device in the devices list
      const httpUrl = t.url.replace(/^ws:/, 'http:');
      try {
        const res = await fetch(`${httpUrl}/devices`);
        if (res.ok) {
          const data = await res.json();
          // Find the first subscribed or available device
          const device = (data.devices || []).find((d: any) => d.subscribed === true);
          if (device?.deviceGuid) {
            this.deviceGuid = device.deviceGuid;
            console.log(`Found device GUID via devices list: ${device.deviceGuid}`);
          }
        }
      } catch (e) {
        console.warn('Could not fetch device info:', e);
      }
    }

    try { await this.hydrate(); } catch { /* readback is best-effort; UI keeps defaults */ }
    this.startMeters();

    // Register with DeviceManager
    deviceManager.connect(this, {
      url: t.url,
      productName: this.productName
    }, 'websocket', this.serverGuid, this.deviceGuid);

    // Save connection state to localStorage
    this.saveConnectionState();
    deviceManager.saveConnectionState();
  }

  /**
   * Send subscription action to bridge.js server
   */
  private subscribeToAllDevices(t: WebSocketTransport): void {
    if (t.isOpen && t.ws) {
      const msg = JSON.stringify({ type: 'action', action: 'subscribe_all' });
      try {
        t.ws.send(msg);
        console.log('Sent subscribe_all action to bridge.js server');
      } catch (e) {
        console.warn('Failed to send subscription message:', e);
      }
    } else {
      // If not open yet, wait for open event
      const checkAndSubscribe = () => {
        if (t.isOpen && t.ws) {
          const msg = JSON.stringify({ type: 'action', action: 'subscribe_all' });
          try {
            t.ws.send(msg);
            console.log('Sent subscribe_all action to bridge.js server');
          } catch (e) {
            console.warn('Failed to send subscription message:', e);
          }
        }
      };
      setTimeout(checkAndSubscribe, 100);
    }
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
        // Save device state to localStorage after changes
        this.saveDeviceState();
        // Note: preset updates are now only triggered manually via the "Update" button
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
          deviceManager.broadcastChannelUpdate(i, { comp: { ...ch.comp } });
        }
      } else {
        // Sync gate for inputs
        if (ch.gate) {
          deviceManager.broadcastChannelUpdate(i, { gate: { ...ch.gate } });
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
  setGainDb(i: number, db: number): void {
    const ch = this.ch(i);
    ch.gainDb = db;
    this.channels = [...this.channels];
    this.commit(`gain${i}`, () => this.dsp!.setLevelDb(i, db));
  }
  setMute(i: number, on: boolean): void {
    const ch = this.ch(i);
    ch.mute = on;
    this.channels = [...this.channels];
    this.commit(`mute${i}`, () => this.dsp!.mute(i, on), 0);
  }
  setPolarity(i: number, inv: boolean): void {
    const ch = this.ch(i);
    ch.polarity = inv;
    this.channels = [...this.channels];
    this.commit(`pol${i}`, () => this.dsp!.setPolarity(i, inv), 0);
  }
  toggleEqMode(i: number): void {
    const ch = this.ch(i);
    if (ch.eq) {
      ch.eqMode = ch.eqMode === "geq" ? "peq" : "geq";
      this.channels = [...this.channels];
    }
  }

  // --- EQ (commit reads the already-mutated band; UI mutates eq directly for instant draw) ---
  commitPeqBand(i: number, band: number): void {
    console.log(i, band)
    this.sendPeqBand(i, band);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      Object.assign(this.ch(p).eq!.bands[band]!, { ...this.ch(i).eq!.bands[band]! });
      this.channels = [...this.channels];
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
  commitHpf(i: number): void {
    this.sendHpf(i);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      this.ch(p).eq!.hpf = { ...this.ch(i).eq!.hpf! };
      this.channels = [...this.channels];
      this.sendHpf(p);
    }
  }
  commitLpf(i: number): void {
    this.sendLpf(i);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      this.ch(p).eq!.lpf = { ...this.ch(i).eq!.lpf! };
      this.channels = [...this.channels];
      this.sendLpf(p);
    }
  }
  private sendHpf(i: number): void { const x = this.ch(i).eq!.hpf; this.commit(`hpf${i}`, () => this.dsp!.crossoverHpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope)); }
  private sendLpf(i: number): void { const x = this.ch(i).eq!.lpf; this.commit(`lpf${i}`, () => this.dsp!.crossoverLpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope)); }

  /** Reset one PEQ band to its default (centre freq, 0 dB, 1 oct, peak). */
  resetBand(i: number, band: number): void {
    const b = this.ch(i).eq!.bands[band]!;
    b.freqHz = DEFAULT_BAND_FREQS[band] ?? 1000; b.gainDb = 0; b.bwOct = 1; b.type = 0; b.bypass = false;
    this.channels = [...this.channels];
    this.commitPeqBand(i, band);
  }
  /** Copy a whole channel's EQ (7 bands + crossover) to another output and push it. */
  copyEqTo(src: number, dst: number): void {
    const srcCh = this.ch(src);
    if (!srcCh.eq || !this.ch(dst).eq) return;

    // Convert $state to plain objects for cloning
    this.ch(dst).eq = {
      bands: srcCh.eq.bands.map(b => ({ ...b })),
      hpf: { freqHz: srcCh.eq.hpf.freqHz, slope: srcCh.eq.hpf.slope },
      lpf: { freqHz: srcCh.eq.lpf.freqHz, slope: srcCh.eq.lpf.slope }
    };
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
  setDelayMs(i: number, ms: number): void {
    const ch = this.ch(i);
    ch.delayMs = ms;
    this.channels = [...this.channels];
    this.commit(`delay${i}`, () => this.dsp!.delayMs(i, ms));
  }
  commitComp(i: number): void {
    const c = this.ch(i).comp!;
    this.channels = [...this.channels];
    this.commit(`comp${i}`, () => this.dsp!.compressor(i, c));
  }
  commitGate(i: number): void {
    const g = this.ch(i).gate!;
    this.channels = [...this.channels];
    this.commit(`gate${i}`, () => this.dsp!.gate(i, g));
  }
  setRouting(outIndex: number, mask: number): void {
    this.routing[outIndex - 0x04] = mask;
    this.routing = [...this.routing];
    this.commit(`route${outIndex}`, () => this.dsp!.routing(outIndex, mask), 0);
  }

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

  // --- Device state persistence to localStorage ---
  saveDeviceState(): void {
    try {
      const deviceState = {
        channels: this.channels,
        routing: this.routing,
        presetName: this.presetName,
        activePreset: this.activePreset,
        eqLink: this.eqLink
      };
      localStorage.setItem("opendsp-device-state", JSON.stringify(deviceState));
    } catch (e) {
      console.error("Error saving device state:", e);
    }
  }

  async restoreDeviceState(): Promise<void> {
    let raw: string | null = null;
    try { raw = localStorage.getItem("opendsp-device-state"); } catch { /* ignore */ }
    if (!raw) return;

    const state = JSON.parse(raw) as {
      channels: Channel[];
      routing: number[];
      presetName?: string;
      activePreset?: number;
      eqLink?: Record<number, number>;
    };

    this.channels = state.channels;

    // Ensure we have at least 8 default channels after restore
    while (this.channels.length < 8) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }

    this.routing = state.routing;
    if (state.presetName !== undefined) this.presetName = state.presetName;
    if (state.activePreset !== undefined) this.activePreset = state.activePreset;
    if (state.eqLink !== undefined) this.eqLink = state.eqLink;

    // Request current state from device after restoring from localStorage
    if (this.dsp && this.connected) {
      try { await this.hydrate(); } catch { /* ignore errors */ }
    }
  }

  clearDeviceState(): void {
    try {
      localStorage.removeItem("opendsp-device-state");
    } catch (e) {
      console.error("Error clearing device state:", e);
    }
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
  async savePresetToJson(name?: string): Promise<void> {
    const presetData = presetManager.exportCurrentPreset();
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(presetData);
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", name ? `${name.replace(/[^a-z0-9]/gi, '_')}.json` : `dsp-preset-${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    } catch (e) {
      console.error('Error saving preset:', e);
      throw new Error(`Failed to save preset: ${(e as Error).message}`);
    }
  }

  async loadPresetFromJson(jsonString: string, applyToDevice = false): Promise<void> {
    try {
      const parsed = JSON.parse(jsonString);
      presetManager.importPreset(parsed);

      // Optionally apply the loaded preset to the device
      if (applyToDevice && this.dsp) {
        await this.applyLoadedPreset(parsed);
      }
    } catch (e) {
      console.error('Error loading preset:', e);
      throw new Error(`Invalid preset data: ${(e as Error).message}`);
    }
  }

  /**
   * Apply a loaded preset to the connected device. If not connected, only updates local state.
   */
  async applyLoadedPreset(preset: any): Promise<void> {
    if (!this.dsp) return;

    // Stop meters during preset application
    this.stopMeters();
    try {
      // Restore routing - send to device only if connected
      if (Array.isArray(preset.device.routing)) {
        this.routing = preset.device.routing;
        for (let i = 0; i < preset.device.routing.length; i++) {
          await this.dsp.routing(OUT_BASE + i, preset.device.routing[i]).catch(() => {});
        }
      }

      // Restore EQ links
      if (preset.device.eqLink && typeof preset.device.eqLink === 'object') {
        this.eqLink = { ...preset.device.eqLink };
      }

      // Restore channels - send to device only if connected
      if (Array.isArray(preset.device.channels)) {
        for (let i = 0; i < preset.device.channels.length; i++) {
          const savedCh = preset.device.channels[i];
          if (!savedCh) continue;

          const ch = this.ch(i);

          // Basic properties - update local state, send to device only if connected
          if (typeof savedCh.gainDb === 'number') {
            ch.gainDb = savedCh.gainDb;
            await this.dsp.setLevelDb(i, savedCh.gainDb).catch(() => {});
          }

          if (typeof savedCh.mute === 'boolean') {
            ch.mute = savedCh.mute;
            await this.dsp.mute(i, savedCh.mute).catch(() => {});
          }

          if (typeof savedCh.polarity === 'boolean') {
            ch.polarity = savedCh.polarity;
            await this.dsp.setPolarity(i, savedCh.polarity).catch(() => {});
          }

          // Output-specific: delay, compressor, EQ - send to device only if connected
          if (ch.isOutput) {
            if (savedCh.delayMs !== undefined) {
              ch.delayMs = savedCh.delayMs;
              await this.dsp.delayMs(i, savedCh.delayMs).catch(() => {});
            }

            // Compressor
            if (savedCh.comp) {
              ch.comp = { ...savedCh.comp };
              await this.dsp.compressor(i, savedCh.comp).catch(() => {});
            }

            // EQ
            if (savedCh.eq) {
              ch.eq = {
                bands: savedCh.eq.bands.map((b: any) => ({ ...b })),
                hpf: { freqHz: savedCh.eq.hpf.freqHz, slope: savedCh.eq.hpf.slope },
                lpf: { freqHz: savedCh.eq.lpf.freqHz, slope: savedCh.eq.lpf.slope }
              };

              // Crossovers
              if (savedCh.eq.hpf) {
                await this.dsp.crossoverHpf(i, this.cal.xoverHzToRaw(savedCh.eq.hpf.freqHz), savedCh.eq.hpf.slope).catch(() => {});
              }
              if (savedCh.eq.lpf) {
                await this.dsp.crossoverLpf(i, this.cal.xoverHzToRaw(savedCh.eq.lpf.freqHz), savedCh.eq.lpf.slope).catch(() => {});
              }

              // EQ bands
              if (Array.isArray(savedCh.eq.bands)) {
                for (let band = 0; band < savedCh.eq.bands.length; band++) {
                  const savedBand = savedCh.eq.bands[band];
                  if (!savedBand) continue;

                  ch.eq!.bands[band] = { ...savedBand };
                  await this.dsp.peqBand(i, band, {
                    freqHz: savedBand.freqHz,
                    q: this.cal.bwOctToQ(savedBand.bwOct, savedBand.freqHz),
                    gainRaw: this.cal.peqGainDbToRaw(savedBand.gainDb, savedBand.type),
                    type: savedBand.type,
                    bypass: savedBand.bypass
                  }).catch(() => {});
                }
              }
            }
          } else {
            // Input-specific: gate - send to device only if connected
            if (savedCh.gate) {
              ch.gate = { ...savedCh.gate };
              await this.dsp.gate(i, savedCh.gate).catch(() => {});
            }
          }
        }
      }

      // Restore active preset slot
      if (typeof preset.device.activePreset === 'number') {
        this.activePreset = preset.device.activePreset;
      }

    } finally {
      this.startMeters();
    }
  }

  /**
   * Load a saved preset from localStorage by index and apply it to the device
   */
  async loadSavedPresetFromStorage(index: number): Promise<void> {
    const preset = presetManager.loadPreset(index);
    if (!preset) return;

    // First, update currentPresetId and save to localStorage immediately
    // This ensures localStorage is updated even without a hardware connection
    this.currentPresetId = preset.id;

    // Apply preset data to current device state (local state update)
    this.channels = preset.device.channels;

    // Ensure we have at least 8 default channels after loading preset
    while (this.channels.length < 8) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }

    this.routing = preset.device.routing;
    this.eqLink = { ...preset.device.eqLink };
    this.activePreset = preset.device.activePreset;

    // Save device state to localStorage immediately
    this.saveDeviceState();

    // Send to device if connected - catch errors to prevent timeout failures
    if (this.dsp) {
      try {
        await this.applyLoadedPreset(preset);
      } catch (err) {
        console.error("Error applying preset to device:", err);
        // Don't throw - the preset was still loaded into local state and saved to localStorage
      }
    }
  }

  /**
   * Save current device state as a named preset in localStorage
   */
  saveCurrentPresetToStorage(name: string): void {
    // Get channels array - ensure we always have at least 8 default channels
    const channelCount = this.channels.length;

    // Ensure we have all 8 default channels before saving
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) {
        this.channels = [...this.channels, defaultChannel(i)];
      }
    }

    const channels: Channel[] = [];
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      channels.push({
        index: ch.index,
        name: ch.name,
        isOutput: ch.isOutput,
        gainDb: ch.gainDb,
        mute: ch.mute,
        polarity: ch.polarity,
        meter: ch.meter,
        eq: ch.eq ? {
          bands: ch.eq.bands.map((b: any) => ({
            freqHz: b.freqHz,
            gainDb: b.gainDb,
            bwOct: b.bwOct,
            type: b.type,
            bypass: b.bypass
          })),
          hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
          lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope }
        } : undefined,
        delayMs: ch.delayMs,
        comp: ch.comp ? { ...ch.comp } : undefined,
        gate: ch.gate ? { ...ch.gate } : undefined,
        eqMode: ch.eqMode
      });
    }

    const routing = [...this.routing];

    // Create a new preset - always generates a new GUID
    const savedPreset = presetManager.saveDeviceStateToPreset(name, channels, routing, this.eqLink, this.activePreset);

    // Store the ID of the current preset for tracking
    if (savedPreset) {
      this.currentPresetId = savedPreset.id;
    }

    // Also save device state to localStorage for quick restoration
    this.saveDeviceState();
  }

  /**
   * Save current device state as a named preset in localStorage, updating an existing preset by ID
   */
  updateExistingPresetToStorage(name: string, presetId: string): void {
    // Get channels array - ensure we always have at least 8 default channels
    const channelCount = this.channels.length;

    // Ensure we have all 8 default channels before saving
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) {
        this.channels = [...this.channels, defaultChannel(i)];
      }
    }

    const channels: Channel[] = [];
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      channels.push({
        index: ch.index,
        name: ch.name,
        isOutput: ch.isOutput,
        gainDb: ch.gainDb,
        mute: ch.mute,
        polarity: ch.polarity,
        meter: ch.meter,
        eq: ch.eq ? {
          bands: ch.eq.bands.map((b: any) => ({
            freqHz: b.freqHz,
            gainDb: b.gainDb,
            bwOct: b.bwOct,
            type: b.type,
            bypass: b.bypass
          })),
          hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
          lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope }
        } : undefined,
        delayMs: ch.delayMs,
        comp: ch.comp ? { ...ch.comp } : undefined,
        gate: ch.gate ? { ...ch.gate } : undefined,
        eqMode: ch.eqMode
      });
    }

    const routing = [...this.routing];

    // Update existing preset by ID - preserves the original GUID
    const idx = presetManager.findPresetIndexById(presetId);
    if (idx >= 0) {
      presetManager.updatePresetById(presetId, {
        name,
        device: {
          channels,
          routing,
          eqLink: { ...this.eqLink },
          activePreset: this.activePreset,
          presetName: this.presetName
        }
      });
      const savedPreset = presetManager.loadPreset(idx);

      // Store the ID of the current preset for tracking
      if (savedPreset) {
        this.currentPresetId = savedPreset.id;
      }

      // Also save device state to localStorage for quick restoration
      this.saveDeviceState();
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

  // --- Connection State Persistence ---
  saveConnectionState(): void {
    try {
      const state = {
        serverGuid: this.serverGuid,
        deviceGuid: this.deviceGuid,
        connectedAt: new Date().toISOString()
      };
      localStorage.setItem("opendsp-connection-state", JSON.stringify(state));
    } catch (e) {
      console.error('Error saving connection state:', e);
    }
  }

  restoreConnectionState(): void {
    try {
      const raw = localStorage.getItem("opendsp-connection-state");
      if (raw) {
        const state = JSON.parse(raw);
        this.serverGuid = state.serverGuid;
        this.deviceGuid = state.deviceGuid;
        console.log('Restored connection state:', state);
      }
    } catch (e) {
      console.error('Error restoring connection state:', e);
    }
  }

  clearConnectionState(): void {
    try {
      localStorage.removeItem("opendsp-connection-state");
    } catch (e) {
      console.error('Error clearing connection state:', e);
    }
  }
}

// Export the singleton instance
export const device = new DeviceStore();

// Export for backward compatibility - single device mode still works
export { deviceManager } from "./device-manager.ts";
