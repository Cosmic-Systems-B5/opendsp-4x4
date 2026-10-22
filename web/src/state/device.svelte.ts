// Reactive device state + controller. UI mutates this (instant), and each
// change is debounced + sent through the transport. Engineering-unit params
// are converted to wire values via the Calibration seam.
//
// Two roles:
//   - 'ui'    : the canonical model the UI renders. `dsp` is null. All edits
//               mutate this store and are broadcast to bound shadows via
//               deviceManager.broadcast*. Persisted once under a single key.
//   - 'bound' : a hardware mirror created by the picker when a DSP connects.
//               Holds a real `Dsp`. Hydrates from hardware, then mirrors into
//               the UI model (first connect) or receives a push from the UI
//               model (subsequent connects).
import { WebSocketTransport } from "../transport/websocket.ts";
import { Dsp } from "../dsp.ts";
import { defaultCalibration, type Calibration } from "../eq/calibration.ts";
import { getLevelsFrame, gainRawToDb } from "../protocol/control.ts";
import { thresholdRawToDb, samplesToMs, rawToQ, peqIndexToHz } from "../protocol/blocks.ts";
import { levelsFromReply, reconstructPresetImage, parsePresetImage } from "../protocol/readback.ts";
import { makeChannels, defaultChannel, OUT_BASE, DEFAULT_BAND_FREQS, type Channel } from "./device-model.ts";
import { deviceManager } from "./device-manager.svelte.ts";
import presetManager from "./preset-manager.ts";

const DEFAULTS_KEY = "opendsp-defaults";

const DEV_DEBUG = true;
function dlog(...args: unknown[]) {
  if (DEV_DEBUG) console.log('%c[dev]', 'color:#a08cc4', ...args);
}

export type DeviceRole = 'ui' | 'bound';

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

  serverid?: string;
  guid?: string;

  currentPresetId = $state<string | null>(null);

  /** 'ui' = canonical model (default). 'bound' = a hardware shadow. */
  role: DeviceRole = 'ui';

  /** Only 'bound' stores have a real Dsp. */
  dsp: Dsp | null = null;

  private _ready: Promise<void> = Promise.resolve();
  get ready(): Promise<void> { return this._ready; }

  private cal: Calibration = defaultCalibration;
  get calibration(): Calibration { return this.cal; }
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private meterTimer?: ReturnType<typeof setInterval>;

  // WebSocket bridge binding (only populated for 'bound' stores).
  private transport: WebSocketTransport | null = null;
  private boundGuid: string | null = null;
  private boundServerid: string | null = null;
  private unsubMessage?: () => void;
  private unsubClose?: () => void;

  lastReadback: ReturnType<typeof parsePresetImage> | null = null;

  get selectedChannel(): Channel | undefined { return this.channels[this.selected]; }
  ch(index: number): Channel {
    while (this.channels.length <= index) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    return this.channels[index]!;
  }
  collapse(): void { this.selected = -1; }

  // --- bridge bind / unbind ---------------------------------------------

  async bind(
      t: WebSocketTransport,
      opts: {
        guid: string;
        serverid: string;
        productName: string;
        kind: 'hid' | 'mock';
      },
  ): Promise<void> {
    this.role = 'bound';
    dlog('bind START', opts.guid, opts.serverid);
    this.transport = t;
    this.boundGuid = opts.guid;
    this.boundServerid = opts.serverid;
    this.guid = opts.guid;
    this.serverid = opts.serverid;
    this.productName = opts.productName;
    this.connected = true;
    this.error = "";

    t.send(JSON.stringify({ type: 'action', action: 'subscribe', guid: opts.guid }));

    this.unsubMessage = t.onMessage((msg) => this.#handleBridgeMessage(msg as any));
    this.unsubClose = t.onCloseListener(() => {
      this.connected = false;
      this.transport = null;
      this.dsp = null;
      this.boundGuid = null;
      this.boundServerid = null;
    });

    this.dsp = new Dsp(t, opts.guid);
    dlog('bind: Dsp created', 'guid=' + opts.guid);

    queueMicrotask(() => {
      console.log('[device] bind: starting hydration for', opts.guid);
      this._ready = this.hydrate()
          .then(() => {
            console.log('[device] bind: hydration complete');
            try { this.saveDeviceState(); } catch (e) { console.error('saveDeviceState failed:', e); }
          })
          .catch((e) => {
            console.error('initial hydrate failed:', e);
            throw e;
          });
    });
  }

  async unbind(): Promise<void> {
    if (!this.transport) return;

    if (this.boundGuid) {
      try {
        this.transport.send(JSON.stringify({
          type: 'action', action: 'unsubscribe', guid: this.boundGuid,
        }));
      } catch { /* socket may already be closing */ }
    }

    this.unsubMessage?.(); this.unsubMessage = undefined;
    this.unsubClose?.();   this.unsubClose   = undefined;

    this.dsp = null;
    this.transport = null;
    this.boundGuid = null;
    this.boundServerid = null;
    this.connected = false;
  }

  #handleBridgeMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const isOurs = msg.guid === this.boundGuid && msg.serverid === this.boundServerid;
    dlog('msg', msg.type, 'guid=' + (msg.guid ?? '-'),
        'serverid=' + (msg.serverid ?? '-'),
        'isOurs=' + isOurs);
    if (!isOurs) return;

    switch (msg.type) {
      case 'subscribed':      dlog('  subscribed ack'); this.connected = true; return;
      case 'unsubscribed':    dlog('  unsubscribed ack'); this.connected = false; return;
      case 'device_gone':     dlog('  device_gone'); this.connected = false; this.error = 'device disconnected'; return;
      case 'settings_update': dlog('  settings_update (ignored — hydrate is the source of truth)'); return;
      case 'report':          dlog('  report (unsolicited or race-lost reply)'); return;
      case 'error':           console.warn('[bridge]', msg.code, msg.message); return;
    }
  }

  // --- adopt from another store (used for first-connect mirror) ---------

  adoptFrom(other: typeof device): void {
    this.channels = other.channels.map(ch => ({
      ...ch,
      eq: ch.eq ? {
        bands: ch.eq.bands.map(b => ({ ...b })),
        hpf: { ...ch.eq.hpf },
        lpf: { ...ch.eq.lpf },
      } : undefined,
      comp: ch.comp ? { ...ch.comp } : undefined,
      gate: ch.gate ? { ...ch.gate } : undefined,
    }));
    this.routing = [...other.routing];
    this.eqLink = { ...other.eqLink };
    this.lastReadback = other.lastReadback;
    this.hasDefaults = other.hasDefaults;
  }

  // --- hydrate ----------------------------------------------------------

  private async hydrate(): Promise<void> {
    if (!this.dsp) { dlog('hydrate SKIP: no dsp'); return; }
    dlog('hydrate START');
    const pages: Uint8Array[] = [];
    for (let i = 0; i < 9; i++) {
      const data = await this.dsp.channelState(i);
      pages[data[0] ?? i] = data.slice(1, 51);
    }

    const pr = parsePresetImage(reconstructPresetImage(pages));
    this.lastReadback = pr;
    // presetName and activePreset are UI-only; do not copy from hardware.

    const newChannels = [...this.channels];
    pr.inputs.forEach((c, i) => {
      if (!newChannels[i]) return;
      if (c.name) newChannels[i].name = c.name;
      newChannels[i].gainDb = gainRawToDb(c.gainRaw);
      newChannels[i].polarity = c.polarity;
      newChannels[i].gate = {
        attackMs: c.gate.atkRaw,
        releaseMs: c.gate.relRaw,
        holdMs: c.gate.holdRaw,
        thresholdDb: thresholdRawToDb(c.gate.thrRaw),
      };
    });

    const newRouting = [...this.routing];
    pr.outputs.forEach((c, i) => {
      const idx = OUT_BASE + i;
      if (!newChannels[idx]) return;
      if (c.name) newChannels[idx].name = c.name;
      newChannels[idx].gainDb = gainRawToDb(c.gainRaw);
      newChannels[idx].polarity = c.polarity;
      newChannels[idx].delayMs = samplesToMs(c.delaySamples);
      newRouting[i] = c.routingMask;
      newChannels[idx].comp = {
        ratioIndex: c.comp.ratioIndex, kneeDb: c.comp.kneeRaw,
        attackMs: c.comp.atkRaw, releaseMs: c.comp.relRaw,
        thresholdDb: thresholdRawToDb(c.comp.thrRaw),
      };
      if (newChannels[idx].eq) {
        newChannels[idx].eq.hpf = { freqHz: this.cal.xoverRawToHz(c.hpfRaw), slope: c.hpfSlope };
        newChannels[idx].eq.lpf = { freqHz: this.cal.xoverRawToHz(c.lpfRaw), slope: c.lpfSlope };
        newChannels[idx].eq.bands = c.bands.map((bd) => {
          const freqHz = peqIndexToHz(bd.freqIdx);
          return {
            freqHz,
            type: bd.type,
            bypass: false,
            gainDb: this.cal.peqGainRawToDb(bd.gainRaw, bd.type),
            bwOct: this.cal.qToBwOct(rawToQ(bd.qRaw), freqHz),
          };
        });
      }
    });

    this.channels = newChannels;
    this.routing = newRouting;
  }

  // --- debounced commit -------------------------------------------------

  private commit(key: string, fn: () => void, delay = 40): void {
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);

      if (this.role === 'ui') {
        // Canonical model: no local hardware. The set* method already called
        // deviceManager.broadcast* which pushes to every bound shadow.
        this.saveDeviceState();
        this.syncCurrentPreset();
        return;
      }

      // Bound shadow: write to its own hardware.
      if (this.dsp) void Promise.resolve().then(fn).catch(() => {}).finally(() => {
        this.saveDeviceState();
        this.syncCurrentPreset();
      });
    }, delay));
  }

  // --- channel basics ---------------------------------------------------

  setGainDb(i: number, db: number): void {
    if ((globalThis as any).__devDebug) {
      console.log('%c[dev]', 'color:#a08cc4', 'setGainDb', i, db, 'role=' + this.role);
    }
    const ch = this.ch(i);
    ch.gainDb = db;
    this.channels = [...this.channels];
    this.commit(`gain${i}`, () => this.dsp!.setLevelDb(i, db));
    deviceManager.broadcastChannelUpdate(i, { gainDb: db });
  }
  setMute(i: number, on: boolean): void {
    const ch = this.ch(i); ch.mute = on;
    this.channels = [...this.channels];
    this.commit(`mute${i}`, () => this.dsp!.mute(i, on), 0);
    deviceManager.broadcastChannelUpdate(i, { mute: on });
  }
  setPolarity(i: number, inv: boolean): void {
    const ch = this.ch(i); ch.polarity = inv;
    this.channels = [...this.channels];
    this.commit(`pol${i}`, () => this.dsp!.setPolarity(i, inv), 0);
    deviceManager.broadcastChannelUpdate(i, { polarity: inv });
  }

  toggleEqMode(i: number): void {
    const ch = this.ch(i);
    if (ch.eq) { ch.eqMode = ch.eqMode === "geq" ? "peq" : "geq"; this.channels = [...this.channels]; }
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
      freqHz: b.freqHz,
      q: this.cal.bwOctToQ(b.bwOct, b.freqHz),
      gainRaw: this.cal.peqGainDbToRaw(b.gainDb, b.type),
      type: b.type,
      bypass: b.bypass,
    }));
    deviceManager.broadcastEqBandUpdate(i, band, {
      freqHz: b.freqHz, gainDb: b.gainDb, bwOct: b.bwOct, type: b.type,
    });
  }

  commitHpf(i: number): void {
    this.sendHpf(i);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      this.ch(p).eq!.hpf = { ...this.ch(i).eq!.hpf! };
      this.channels = [...this.channels];
      this.sendHpf(p);
    }
    deviceManager.broadcastEqCrossoverUpdate(i, 'hpf', {
      freqHz: this.ch(i).eq!.hpf.freqHz, slope: this.ch(i).eq!.hpf.slope,
    });
  }
  commitLpf(i: number): void {
    this.sendLpf(i);
    const p = this.eqLink[i];
    if (p !== undefined && this.ch(p).eq) {
      this.ch(p).eq!.lpf = { ...this.ch(i).eq!.lpf! };
      this.channels = [...this.channels];
      this.sendLpf(p);
    }
    deviceManager.broadcastEqCrossoverUpdate(i, 'lpf', {
      freqHz: this.ch(i).eq!.lpf.freqHz, slope: this.ch(i).eq!.lpf.slope,
    });
  }
  private sendHpf(i: number): void {
    const x = this.ch(i).eq!.hpf;
    this.commit(`hpf${i}`, () => this.dsp!.crossoverHpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope));
  }
  private sendLpf(i: number): void {
    const x = this.ch(i).eq!.lpf;
    this.commit(`lpf${i}`, () => this.dsp!.crossoverLpf(i, this.cal.xoverHzToRaw(x.freqHz), x.slope));
  }

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

  // --- dynamics / delay / routing ---------------------------------------

  setDelayMs(i: number, ms: number): void {
    const ch = this.ch(i); ch.delayMs = ms;
    this.channels = [...this.channels];
    this.commit(`delay${i}`, () => this.dsp!.delayMs(i, ms));
    deviceManager.broadcastChannelUpdate(i, { delayMs: ms });
  }
  commitComp(i: number): void {
    const c = this.ch(i).comp!;
    this.channels = [...this.channels];
    this.commit(`comp${i}`, () => this.dsp!.compressor(i, c));
    deviceManager.broadcastChannelUpdate(i, { comp: { ...this.ch(i).comp! } });
  }
  commitGate(i: number): void {
    const g = this.ch(i).gate!;
    this.channels = [...this.channels];
    this.commit(`gate${i}`, () => this.dsp!.gate(i, g));
    deviceManager.broadcastChannelUpdate(i, { gate: { ...this.ch(i).gate! } });
  }
  setRouting(outIndex: number, mask: number): void {
    this.routing[outIndex - 0x04] = mask;
    this.routing = [...this.routing];
    this.commit(`route${outIndex}`, () => this.dsp!.routing(outIndex, mask), 0);
    deviceManager.broadcastRoutingUpdate(outIndex, mask);
  }

  // --- global -----------------------------------------------------------

  async recallPreset(slot: number): Promise<void> {
    if (this.dsp) {
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

  /** Single persistent slot: the UI model is the only thing persisted. */
  private stateKey(): string {
    return "opendsp-device-state";
  }

  saveDeviceState(): void {
    try {
      const deviceState = {
        channels: this.channels,
        routing: this.routing,
        eqLink: this.eqLink,
        currentPresetId: this.currentPresetId,
      };
      localStorage.setItem(this.stateKey(), JSON.stringify(deviceState));
    } catch (e) { console.error("Error saving device state:", e); }
  }

  async restoreDeviceState(): Promise<void> {
    let raw: string | null = null;
    try { raw = localStorage.getItem(this.stateKey()); } catch { /* ignore */ }
    if (!raw) return;
    const state = JSON.parse(raw) as {
      channels: Channel[]; routing: number[];
      eqLink?: Record<number, number>;
      currentPresetId?: string | null;
    };
    this.channels = state.channels;
    while (this.channels.length < 8) {
      this.channels = [...this.channels, defaultChannel(this.channels.length)];
    }
    this.routing = state.routing;
    if (state.eqLink !== undefined) this.eqLink = state.eqLink;
    if (state.currentPresetId !== undefined) this.currentPresetId = state.currentPresetId;
    // Restore presetName from the currently-linked preset (UI-only field;
    // it isn't persisted, but the preset manager can supply it).
    if (this.currentPresetId) {
      const idx = presetManager.findPresetIndexById(this.currentPresetId);
      if (idx >= 0) {
        const p = presetManager.loadPreset(idx);
        if (p) this.presetName = p.name;
      }
    }
  }

  clearDeviceState(): void {
    try { localStorage.removeItem(this.stateKey()); }
    catch (e) { console.error("Error clearing device state:", e); }
  }

  async pushAll(): Promise<void> {
    if (!this.dsp) {
      console.warn('[device] pushAll skipped — no dsp');
      return;
    }
    console.log('[device] pushAll START', this.channels.length, 'channels');
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
                freqHz: b.freqHz,
                q: this.cal.bwOctToQ(b.bwOct, b.freqHz),
                gainRaw: this.cal.peqGainDbToRaw(b.gainDb, b.type),
                type: b.type,
                bypass: b.bypass,
              });
            }
          }
        }
      }
      console.log('[device] pushAll DONE');
    } finally {
      this.startMeters();
    }
  }

  // --- presets (JSON) ---------------------------------------------------

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
      if (applyToDevice) await this.applyLoadedPreset(parsed);
    } catch (e) {
      console.error('Error loading preset:', e);
      throw new Error(`Invalid preset data: ${(e as Error).message}`);
    }
  }

  async applyLoadedPreset(preset: any): Promise<void> {
    if (!preset?.device) return;

    // --- Phase 1: MODEL ---------------------------------------------------
    // Build the new channels array from the preset. Do not mutate in place —
    // replace the array so Svelte reactivity sees it as new, and so a failure
    // in phase 3 leaves the model in a clean, fully-loaded state.
    const nextChannels = this.channels.slice();
    if (Array.isArray(preset.device.channels)) {
      for (let i = 0; i < preset.device.channels.length; i++) {
        const savedCh = preset.device.channels[i];
        if (!savedCh) continue;
        while (nextChannels.length <= i) nextChannels.push(defaultChannel(nextChannels.length));
        const base = nextChannels[i]!;
        nextChannels[i] = {
          index: base.index,
          name: savedCh.name ?? base.name,
          isOutput: base.isOutput,
          gainDb: typeof savedCh.gainDb === 'number' ? savedCh.gainDb : base.gainDb,
          mute: typeof savedCh.mute === 'boolean' ? savedCh.mute : base.mute,
          polarity: typeof savedCh.polarity === 'boolean' ? savedCh.polarity : base.polarity,
          meter: base.meter,
          eq: savedCh.eq ? {
            bands: savedCh.eq.bands.map((b: any) => ({
              freqHz: b.freqHz, gainDb: b.gainDb, bwOct: b.bwOct, type: b.type, bypass: b.bypass,
            })),
            hpf: { freqHz: savedCh.eq.hpf.freqHz, slope: savedCh.eq.hpf.slope },
            lpf: { freqHz: savedCh.eq.lpf.freqHz, slope: savedCh.eq.lpf.slope },
          } : base.eq,
          delayMs: savedCh.delayMs ?? base.delayMs,
          comp: savedCh.comp ? { ...savedCh.comp } : base.comp,
          gate: savedCh.gate ? { ...savedCh.gate } : base.gate,
          eqMode: savedCh.eqMode ?? base.eqMode,
        };
      }
    }
    while (nextChannels.length < 8) nextChannels.push(defaultChannel(nextChannels.length));

    this.channels = nextChannels;
    if (Array.isArray(preset.device.routing)) this.routing = [...preset.device.routing];
    if (preset.device.eqLink && typeof preset.device.eqLink === 'object') {
      this.eqLink = { ...preset.device.eqLink };
    }

    // UI-only fields: keep them in sync with the loaded preset.
    if (typeof preset.name === 'string') this.presetName = preset.name;
    if (typeof preset.id === 'string') this.currentPresetId = preset.id;

    // --- Phase 2: PERSISTENCE --------------------------------------------
    // Write the model we just built. If phase 3 fails, the persisted state is
    // still correct.
    this.saveDeviceState();
    this.syncCurrentPreset();

    // --- Phase 3: HARDWARE -----------------------------------------------
    // Push the loaded model to every bound shadow. Errors are per-device and
    // do not roll back the model or the persisted state.
    await deviceManager.pushFullConfigToAllFrom(this);
  }

  async loadSavedPresetFromStorage(index: number): Promise<void> {
    const preset = presetManager.loadPreset(index);
    if (!preset) return;
    // applyLoadedPreset writes model → persistence → hardware in that order.
    await this.applyLoadedPreset(preset);
  }

  saveCurrentPresetToStorage(name: string): void {
    const channelCount = this.channels.length;
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) this.channels = [...this.channels, defaultChannel(i)];
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
    const savedPreset = presetManager.saveDeviceStateToPreset(name, channels, [...this.routing], this.eqLink);
    if (savedPreset) {
      this.currentPresetId = savedPreset.id;
      this.presetName = name;
    }
    this.saveDeviceState();
  }

  updateExistingPresetToStorage(name: string, presetId: string): void {
    const channelCount = this.channels.length;
    if (channelCount < 8) {
      for (let i = channelCount; i < 8; i++) this.channels = [...this.channels, defaultChannel(i)];
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
    const idx = presetManager.findPresetIndexById(presetId);
    if (idx >= 0) {
      presetManager.updatePresetById(presetId, {
        name,
        device: {
          channels,
          routing: [...this.routing],
          eqLink: { ...this.eqLink },
        },
      });
      const savedPreset = presetManager.loadPreset(idx);
      if (savedPreset) {
        this.currentPresetId = savedPreset.id;
        this.presetName = name;
      }
      this.saveDeviceState();
    }
  }

  private syncCurrentPreset(): void {
    if (!this.currentPresetId) return;
    const idx = presetManager.findPresetIndexById(this.currentPresetId);
    if (idx < 0) {
      this.currentPresetId = null;
      return;
    }
    const preset = presetManager.loadPreset(idx);
    if (!preset) return;
    try {
      // Both args: the preset's display name and its id.
      this.updateExistingPresetToStorage(preset.name, this.currentPresetId);
    } catch (e) {
      console.warn('[preset] syncCurrentPreset failed:', e);
    }
  }

  deleteCurrentPreset(): boolean {
    if (!this.currentPresetId) return false;
    const idx = presetManager.findPresetIndexById(this.currentPresetId);
    if (idx < 0) return false;
    presetManager.deletePreset(idx);
    this.currentPresetId = null;
    this.presetName = "";
    return true;
  }

  deletePresetById(id: string): boolean {
    const idx = presetManager.findPresetIndexById(id);
    if (idx < 0) return false;
    presetManager.deletePreset(idx);
    if (this.currentPresetId === id) {
      this.currentPresetId = null;
      this.presetName = "";
    }
    return true;
  }

  listPresets() {
    return presetManager.getPresets();
  }

  subscribeToPresets(cb: () => void): () => void {
    return presetManager.subscribe(cb);
  }

  // --- meters -----------------------------------------------------------

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

/**
 * The canonical UI model. UI components import this and read/write it directly.
 * It never holds a `dsp` — hardware lives in the 'bound' shadows that the
 * picker creates.
 */
export const device = new DeviceSvelte();