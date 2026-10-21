// Reactive device state + controller. UI mutates this (instant), and each change
// is debounced + sent through the (serialized) transport. Engineering-unit params
// are converted to wire values via the Calibration seam.
import { WebSocketTransport } from "../transport/websocket.ts";
import { Dsp } from "../dsp.ts";
import { defaultCalibration, type Calibration } from "../eq/calibration.ts";
import { getLevelsFrame, gainRawToDb } from "../protocol/control.ts";
import { thresholdRawToDb, samplesToMs, rawToQ, peqIndexToHz } from "../protocol/blocks.ts";
import { levelsFromReply, reconstructPresetImage, parsePresetImage } from "../protocol/readback.ts";
import { makeChannels, defaultChannel, OUT_BASE, DEFAULT_BAND_FREQS, type Channel } from "./device-model.ts";
import { deviceManager } from "./device.manager.svelte.ts";
import presetManager from "./preset-manager.ts";

const DEFAULTS_KEY = "opendsp-defaults";

export type DeviceRole = 'master' | 'slave';

export class DeviceSvelte {
  connected = $state(false);
  productName = $state("");
  version = $state("");
  error = $state("");
  presetName = $state("");
  activePreset = $state(-1);
  hasDefaults = $state(typeof localStorage !== "undefined" && localStorage.getItem(DEFAULTS_KEY) !== null);
  channels = $state<Channel[]>(makeChannels());
  routing = $state<number[]>([0x01, 0x02, 0x04, 0x08]);
  selected = $state(-1);
  eqLink = $state<Record<number, number>>({});
  role: DeviceRole = 'master';
  serverGuid?: string;
  deviceGuid?: string;
  currentPresetId = $state<string | null>(null);

  private dsp: Dsp | null = null;
  private cal: Calibration = defaultCalibration;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private meterTimer?: ReturnType<typeof setInterval>;

  // Bridge glue
  private transport: WebSocketTransport | null = null;
  private boundDeviceId: string | null = null;
  private boundPublishedId: string | null = null;

  lastReadback: ReturnType<typeof parsePresetImage> | null = null;

  get selectedChannel(): Channel | undefined { return this.channels[this.selected]; }
  ch(index: number): Channel {
    while (this.channels.length <= index) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    return this.channels[index]!;
  }
  collapse(): void { this.selected = -1; }

  // --- WebSocket bridge glue ---------------------------------------------

  async bind(
      t: WebSocketTransport,
      opts: {
        deviceId: string;
        publishedId: string;
        deviceGuid: string;
        productName: string;
        kind: 'hid' | 'mock';
      },
  ): Promise<void> {
    this.transport = t;
    this.boundDeviceId = opts.deviceId;
    this.boundPublishedId = opts.publishedId;
    this.deviceGuid = opts.deviceGuid;
    this.productName = opts.productName;
    this.connected = true;
    this.error = "";

    t.send(JSON.stringify({ type: 'action', action: 'subscribe', deviceId: opts.deviceId }));

    t.addEventListener('message', (ev: MessageEvent) => {
      try {
        const data = typeof ev.data === 'string' ? ev.data : '';
        const msg = JSON.parse(data);
        this.#handleBridgeMessage(msg);
      } catch { /* ignore non-JSON frames */ }
    });

    t.addEventListener('close', () => {
      this.connected = false;
      this.transport = null;
      this.boundDeviceId = null;
      this.boundPublishedId = null;
    });
  }

  async unbind(): Promise<void> {
    if (!this.transport) return;
    if (this.boundDeviceId) {
      try {
        this.transport.send(JSON.stringify({
          type: 'action',
          action: 'unsubscribe',
          deviceId: this.boundDeviceId,
        }));
      } catch { /* socket may already be closing */ }
    }
    // Deliberately NOT closing the transport: it is shared by every device
    // bound to this server. Server lifetime is owned by serverManager.
    this.transport = null;
    this.boundDeviceId = null;
    this.boundPublishedId = null;
    this.connected = false;
  }

  private sendBridgeRequest(bytes: Uint8Array): void {
    if (!this.transport || !this.boundDeviceId) return;
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    this.transport.send(JSON.stringify({
      type: 'request',
      deviceId: this.boundDeviceId,
      data: btoa(binary),
    }));
  }

  #handleBridgeMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const isOurs = msg.deviceId === this.boundDeviceId || msg.publishedId === this.boundPublishedId;

    if (msg.type === 'report' && isOurs) {
      // Bridge → 64-byte HID report, base64. Feed through Dsp if a parser
      // is exposed; until then we keep the raw bytes for debug.
      try {
        const bin = atob(msg.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        (this as any).lastReport = bytes;
      } catch { /* ignore */ }
      return;
    }
    if (msg.type === 'settings_update' && isOurs) return;
    if (msg.type === 'subscribed' && isOurs) { this.connected = true; return; }
    if (msg.type === 'unsubscribed' && isOurs) { this.connected = false; return; }
    if (msg.type === 'device_gone' && isOurs) {
      this.connected = false;
      this.error = "device disconnected";
      return;
    }
    if (msg.type === 'error') {
      console.warn('[bridge]', msg.code, msg.message);
    }
  }

  // --- Read the 9 channel-state pages on connect -------------------------

  private async hydrate(): Promise<void> {
    if (!this.dsp) return;
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const data = await this.dsp.channelState(i);
      pages[data[0] ?? i] = data.slice(1, 51);
    }
    const pr = parsePresetImage(reconstructPresetImage(pages));
    this.lastReadback = pr;
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
      this.routing[i] = c.routingMask;
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

  private commit(key: string, fn: () => void, delay = 40): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.dsp) void Promise.resolve().then(fn).catch(() => {}).finally(() => {
        this.broadcastToSlaves();
        this.saveDeviceState();
      });
    }, delay));
  }

  private broadcastToSlaves(): void {
    if (this.role === 'slave') return;
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      deviceManager.broadcastChannelUpdate(i, {
        gainDb: ch.gainDb,
        mute: ch.mute,
        polarity: ch.polarity,
      });
      if (ch.isOutput) {
        const outIndex = i - OUT_BASE;
        if (outIndex >= 0 && outIndex < this.routing.length) {
          const r = this.routing[outIndex];
          if (r) deviceManager.broadcastRoutingUpdate(i, r);
        }
        if (ch.eq?.bands) {
          ch.eq.bands.forEach((band, bandIdx) => {
            deviceManager.broadcastEqBandUpdate(i, bandIdx, {
              freqHz: band.freqHz, gainDb: band.gainDb, bwOct: band.bwOct, type: band.type,
            });
          });
        }
        if (ch.eq?.hpf) deviceManager.broadcastEqCrossoverUpdate(i, 'hpf', { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope });
        if (ch.eq?.lpf) deviceManager.broadcastEqCrossoverUpdate(i, 'lpf', { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope });
        deviceManager.broadcastChannelUpdate(i, { delayMs: ch.delayMs });
        if (ch.comp) deviceManager.broadcastChannelUpdate(i, { comp: { ...ch.comp } });
      } else if (ch.gate) {
        deviceManager.broadcastChannelUpdate(i, { gate: { ...ch.gate } });
      }
    }
    for (const key of Object.keys(this.eqLink)) {
      const a = parseInt(key);
      const b = this.eqLink[a];
      if (b !== undefined) deviceManager.broadcastEqLinkUpdate(a, b);
    }
  }

  // --- channel basics ----------------------------------------------------

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

  commitPeqBand(i: number, band: number): void {
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

  resetBand(i: number, band: number): void {
    const b = this.ch(i).eq!.bands[band]!;
    b.freqHz = DEFAULT_BAND_FREQS[band] ?? 1000; b.gainDb = 0; b.bwOct = 1; b.type = 0; b.bypass = false;
    this.channels = [...this.channels];
    this.commitPeqBand(i, band);
  }
  copyEqTo(src: number, dst: number): void {
    const srcCh = this.ch(src);
    if (!srcCh.eq || !this.ch(dst).eq) return;
    this.ch(dst).eq = {
      bands: srcCh.eq.bands.map(b => ({ ...b })),
      hpf: { freqHz: srcCh.eq.hpf.freqHz, slope: srcCh.eq.hpf.slope },
      lpf: { freqHz: srcCh.eq.lpf.freqHz, slope: srcCh.eq.lpf.slope },
    };
    this.pushEq(dst);
  }
  private pushEq(i: number): void {
    const eq = this.ch(i).eq; if (!eq) return;
    for (let b = 0; b < eq.bands.length; b++) this.sendPeqBand(i, b);
    this.sendHpf(i); this.sendLpf(i);
  }
  linkEq(a: number, b: number): void {
    this.eqLink = { ...this.eqLink, [a]: b, [b]: a };
    this.copyEqTo(a, b);
    deviceManager.broadcastEqLinkUpdate(a, b);
  }
  unlinkEq(a: number): void {
    const b = this.eqLink[a]; const next = { ...this.eqLink };
    delete next[a]; if (b !== undefined) delete next[b];
    this.eqLink = next;
    deviceManager.broadcastEqLinkUpdate(a, -1);
  }

  // --- dynamics / delay / routing ----------------------------------------

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

  // --- global ------------------------------------------------------------

  async recallPreset(slot: number): Promise<void> {
    if (this.dsp) {
      this.activePreset = slot;
      await this.dsp.recallPreset(slot);
      try { await this.hydrate(); } catch { /* ignore */ }
    }
  }
  storePreset(slot: number): void { if (this.dsp) void this.dsp.storePreset(slot); }
  testTone(source: number, freqIndex = 0): void { if (this.dsp) void this.dsp.testTone(source, freqIndex); }
  setPassword(pw: string): void { if (this.dsp) void this.dsp.setPassword(pw); }

  saveDefaults(): void {
    try {
      localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ channels: this.channels, routing: this.routing }));
      this.hasDefaults = true;
    } catch { /* ignore */ }
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

  saveDeviceState(): void {
    try {
      const deviceState = {
        channels: this.channels,
        routing: this.routing,
        presetName: this.presetName,
        activePreset: this.activePreset,
        eqLink: this.eqLink,
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
    while (this.channels.length < 8) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    this.routing = state.routing;
    if (state.presetName !== undefined) this.presetName = state.presetName;
    if (state.activePreset !== undefined) this.activePreset = state.activePreset;
    if (state.eqLink !== undefined) this.eqLink = state.eqLink;
    if (this.dsp && this.connected) {
      try { await this.hydrate(); } catch { /* ignore */ }
    }
  }

  clearDeviceState(): void {
    try { localStorage.removeItem("opendsp-device-state"); }
    catch (e) { console.error("Error clearing device state:", e); }
  }

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

  async savePresetToJson(name?: string): Promise<void> {
    const presetData = presetManager.exportCurrentPreset();
    try {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(presetData);
      const a = document.createElement('a');
      a.setAttribute("href", dataStr);
      a.setAttribute("download", name ? `${name.replace(/[^a-z0-9]/gi, '_')}.json` : `dsp-preset-${new Date().toISOString().slice(0, 10)}.json`);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.error('Error saving preset:', e);
      throw new Error(`Failed to save preset: ${(e as Error).message}`);
    }
  }

  async loadPresetFromJson(jsonString: string, applyToDevice = false): Promise<void> {
    try {
      const parsed = JSON.parse(jsonString);
      presetManager.importPreset(parsed);
      if (applyToDevice && this.dsp) await this.applyLoadedPreset(parsed);
    } catch (e) {
      console.error('Error loading preset:', e);
      throw new Error(`Invalid preset data: ${(e as Error).message}`);
    }
  }

  async applyLoadedPreset(preset: any): Promise<void> {
    if (!this.dsp) return;
    this.stopMeters();
    try {
      if (Array.isArray(preset.device.routing)) {
        this.routing = preset.device.routing;
        for (let i = 0; i < preset.device.routing.length; i++) {
          await this.dsp.routing(OUT_BASE + i, preset.device.routing[i]).catch(() => {});
        }
      }
      if (preset.device.eqLink && typeof preset.device.eqLink === 'object') {
        this.eqLink = { ...preset.device.eqLink };
      }
      if (Array.isArray(preset.device.channels)) {
        for (let i = 0; i < preset.device.channels.length; i++) {
          const savedCh = preset.device.channels[i];
          if (!savedCh) continue;
          const ch = this.ch(i);
          if (typeof savedCh.gainDb === 'number') { ch.gainDb = savedCh.gainDb; await this.dsp.setLevelDb(i, savedCh.gainDb).catch(() => {}); }
          if (typeof savedCh.mute === 'boolean') { ch.mute = savedCh.mute; await this.dsp.mute(i, savedCh.mute).catch(() => {}); }
          if (typeof savedCh.polarity === 'boolean') { ch.polarity = savedCh.polarity; await this.dsp.setPolarity(i, savedCh.polarity).catch(() => {}); }
          if (ch.isOutput) {
            if (savedCh.delayMs !== undefined) { ch.delayMs = savedCh.delayMs; await this.dsp.delayMs(i, savedCh.delayMs).catch(() => {}); }
            if (savedCh.comp) { ch.comp = { ...savedCh.comp }; await this.dsp.compressor(i, savedCh.comp).catch(() => {}); }
            if (savedCh.eq) {
              ch.eq = {
                bands: savedCh.eq.bands.map((b: any) => ({ ...b })),
                hpf: { freqHz: savedCh.eq.hpf.freqHz, slope: savedCh.eq.hpf.slope },
                lpf: { freqHz: savedCh.eq.lpf.freqHz, slope: savedCh.eq.lpf.slope },
              };
              if (savedCh.eq.hpf) await this.dsp.crossoverHpf(i, this.cal.xoverHzToRaw(savedCh.eq.hpf.freqHz), savedCh.eq.hpf.slope).catch(() => {});
              if (savedCh.eq.lpf) await this.dsp.crossoverLpf(i, this.cal.xoverHzToRaw(savedCh.eq.lpf.freqHz), savedCh.eq.lpf.slope).catch(() => {});
              if (Array.isArray(savedCh.eq.bands)) {
                for (let band = 0; band < savedCh.eq.bands.length; band++) {
                  const savedBand = savedCh.eq.bands[band];
                  if (!savedBand) continue;
                  ch.eq!.bands[band] = { ...savedBand };
                  await this.dsp.peqBand(i, band, {
                    freqHz: savedBand.freqHz, q: this.cal.bwOctToQ(savedBand.bwOct, savedBand.freqHz),
                    gainRaw: this.cal.peqGainDbToRaw(savedBand.gainDb, savedBand.type),
                    type: savedBand.type, bypass: savedBand.bypass,
                  }).catch(() => {});
                }
              }
            }
          } else if (savedCh.gate) {
            ch.gate = { ...savedCh.gate };
            await this.dsp.gate(i, savedCh.gate).catch(() => {});
          }
        }
      }
      if (typeof preset.device.activePreset === 'number') {
        this.activePreset = preset.device.activePreset;
      }
    } finally {
      this.startMeters();
    }
  }

  async loadSavedPresetFromStorage(index: number): Promise<void> {
    const preset = presetManager.loadPreset(index);
    if (!preset) return;
    this.currentPresetId = preset.id;
    this.channels = preset.device.channels;
    while (this.channels.length < 8) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    this.routing = preset.device.routing;
    this.eqLink = { ...preset.device.eqLink };
    this.activePreset = preset.device.activePreset;
    this.saveDeviceState();
    if (this.dsp) {
      try { await this.applyLoadedPreset(preset); }
      catch (err) { console.error("Error applying preset to device:", err); }
    }
  }

  saveCurrentPresetToStorage(name: string): void {
    const channelCount = this.channels.length;
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) {
        this.channels = [...this.channels, defaultChannel(i)];
      }
    }
    const channels: Channel[] = [];
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      channels.push({
        index: ch.index, name: ch.name, isOutput: ch.isOutput,
        gainDb: ch.gainDb, mute: ch.mute, polarity: ch.polarity, meter: ch.meter,
        eq: ch.eq ? {
          bands: ch.eq.bands.map((b: any) => ({
            freqHz: b.freqHz, gainDb: b.gainDb, bwOct: b.bwOct, type: b.type, bypass: b.bypass,
          })),
          hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
          lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope },
        } : undefined,
        delayMs: ch.delayMs,
        comp: ch.comp ? { ...ch.comp } : undefined,
        gate: ch.gate ? { ...ch.gate } : undefined,
        eqMode: ch.eqMode,
      });
    }
    const routing = [...this.routing];
    const savedPreset = presetManager.saveDeviceStateToPreset(name, channels, routing, this.eqLink, this.activePreset);
    if (savedPreset) this.currentPresetId = savedPreset.id;
    this.saveDeviceState();
  }

  updateExistingPresetToStorage(name: string, presetId: string): void {
    const channelCount = this.channels.length;
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) {
        this.channels = [...this.channels, defaultChannel(i)];
      }
    }
    const channels: Channel[] = [];
    for (let i = 0; i < this.channels.length; i++) {
      const ch = this.ch(i);
      channels.push({
        index: ch.index, name: ch.name, isOutput: ch.isOutput,
        gainDb: ch.gainDb, mute: ch.mute, polarity: ch.polarity, meter: ch.meter,
        eq: ch.eq ? {
          bands: ch.eq.bands.map((b: any) => ({
            freqHz: b.freqHz, gainDb: b.gainDb, bwOct: b.bwOct, type: b.type, bypass: b.bypass,
          })),
          hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
          lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope },
        } : undefined,
        delayMs: ch.delayMs,
        comp: ch.comp ? { ...ch.comp } : undefined,
        gate: ch.gate ? { ...ch.gate } : undefined,
        eqMode: ch.eqMode,
      });
    }
    const routing = [...this.routing];
    const idx = presetManager.findPresetIndexById(presetId);
    if (idx >= 0) {
      presetManager.updatePresetById(presetId, {
        name,
        device: {
          channels, routing,
          eqLink: { ...this.eqLink },
          activePreset: this.activePreset,
          presetName: this.presetName,
        },
      });
      const savedPreset = presetManager.loadPreset(idx);
      if (savedPreset) this.currentPresetId = savedPreset.id;
      this.saveDeviceState();
    }
  }

  // --- meters (unchanged but kept private, since pushAll refers to them) --

  private startMeters(): void {
    this.stopMeters();
    let busy = false;
    const METER_SMOOTHING = 0.3;
    this.meterTimer = setInterval(() => {
      if (!this.dsp || busy) return;
      busy = true;
      void this.dsp.send(getLevelsFrame()).then((r) => {
        const lv = levelsFromReply(r);
        if (lv) for (let i = 0; i < 8; i++) {
          const current = this.ch(i).meter;
          const next = lv[i]!;
          this.ch(i).meter = current === 0 && next < 0.05
              ? next
              : current + METER_SMOOTHING * (next - current);
        }
      }).catch(() => {}).finally(() => { busy = false; });
    }, 100);
  }

  private stopMeters(): void {
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = undefined; }
  }
}

export const device = new DeviceSvelte();