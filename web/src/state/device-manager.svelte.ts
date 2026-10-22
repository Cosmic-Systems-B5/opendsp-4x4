// Multi-DSP Device Manager - peer-to-peer architecture.
// The canonical UI model (`device`) is the single source of truth. Each DSP
// unit is a "shadow" DeviceSvelte ('bound' role) that talks to hardware and
// mirrors into the UI model.
//
// A `.svelte.ts` module so `$state` works at the module level.

import { device as defaultDevice } from "../state/device.svelte.ts";
import { OUT_BASE, type Channel } from "./device-model.ts";
import type { WebSocketTransport } from "../transport/websocket.ts";

export interface ConnectedDevice {
  id: string;
  store: typeof defaultDevice;
  transport?: WebSocketTransport;
  connectionInfo: {
    url?: string;
    productName: string;
  };
  serverid?: string;
  guid?: string;
  connected: boolean;
}

export interface ServerConnection {
  id: string;
  url: string;
  productName: string;
  connectedAt: string;
  serverid?: string;
}

export interface EqBandUpdates {
  freqHz?: number;
  gainDb?: number;
  bwOct?: number;
  type?: number;
  bypass?: boolean;
}

// --- Persisted device bindings ---------------------------------------------

const STORAGE_KEY_BOUND = "opendsp-bound-devices";

export interface PersistedBinding {
  guid: string;
  serverid: string;
  productName: string;
  kind: 'hid' | 'mock';
}
export type PersistedBindings = Record<string, Record<string, PersistedBinding>>;

class DeviceManagerState {
  devices = $state<ConnectedDevice[]>([]);
  servers: ServerConnection[] = [];
  nextId = 0;

  get connectedDevices(): ConnectedDevice[] {
    return this.devices.filter(d => d.connected);
  }

  // --- bind / disconnect -------------------------------------------------

  bindTransport(
      t: WebSocketTransport,
      deviceStore: typeof defaultDevice,
      opts: {
        url: string;
        guid: string;
        serverid: string;
        productName: string;
        kind: 'hid' | 'mock';
      },
  ): ConnectedDevice | null {
    const existing = this.devices.find(
        d => d.connectionInfo.url === opts.url && d.guid === opts.guid && d.connected,
    );
    if (existing) return existing;

    // Count BEFORE adding this record: if it's 0, this is the first DSP.
    const isFirst = this.connectedDevices.length === 0;

    const rec: ConnectedDevice = {
      id: `websocket-${this.nextId++}`,
      store: deviceStore,
      transport: t,
      connectionInfo: { url: opts.url, productName: opts.productName },
      serverid: opts.serverid,
      guid: opts.guid,
      connected: true,
    };
    this.devices = [...this.devices, rec];

    deviceStore.serverid = opts.serverid;
    deviceStore.guid = opts.guid;
    deviceStore.productName = opts.productName;

    if (isFirst) {
      // First DSP: its hydrated state becomes the canonical UI model.
      void (async () => {
        try {
          await deviceStore.ready;
          defaultDevice.adoptFrom(deviceStore);
          defaultDevice.saveDeviceState();
          console.log('[dm] first DSP connected — UI model hydrated from', opts.guid);
        } catch (e) {
          console.warn('[dm] adopt from first DSP failed:', e);
        }
      })();
    } else {
      // Subsequent DSP: the UI model wins — push it to the new hardware.
      void (async () => {
        try {
          await deviceStore.ready;
          await this.sendFullConfigToDevice(deviceStore);
          console.log('[dm] pushed UI model to new DSP', opts.guid);
        } catch (e) {
          console.warn('[dm] push UI model to new DSP failed:', e);
        }
      })();
    }

    this.#recordBinding(rec);
    return rec;
  }

  connectServer(url: string, productName: string, serverid?: string): ServerConnection | null {
    for (const existing of this.servers) if (existing.url === url) return null;
    const server: ServerConnection = {
      id: `server-${this.nextId++}`,
      url, productName, serverid,
      connectedAt: new Date().toISOString(),
    };
    this.servers.push(server);
    return server;
  }

  disconnectServer(url: string): void {
    const idx = this.servers.findIndex(s => s.url === url);
    if (idx >= 0) this.servers.splice(idx, 1);
    for (const device of this.devices) {
      if (device.connectionInfo.url === url && device.connected) {
        device.connected = false;
        this.#dropBinding(device);
      }
    }
    this.devices = [...this.devices];
    this.#dropBindingsForServer(url);
  }

  disconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = false;
    this.#dropBinding(rec);
    this.devices = [...this.devices];
    this.saveConnectionState();
  }

  reconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = true;
    this.devices = [...this.devices];
    this.saveConnectionState();
  }

  disconnectAll(): void {
    for (const d of this.devices) d.connected = false;
    this.devices = [...this.devices];
  }

  // --- send full config to device ----------------------------------------

  async sendFullConfigToDevice(deviceStore: typeof defaultDevice): Promise<void> {
    if (!deviceStore.dsp) {
      console.log('[dm] sendFullConfigToDevice skipped — no dsp');
      return;
    }
    await deviceStore.ready;

    // Copy the canonical UI model into the shadow store first, so the values
    // we push are the UI's, not whatever the shadow hydrated from hardware.
    deviceStore.channels = defaultDevice.channels.map(ch => ({
      ...ch,
      eq: ch.eq ? {
        bands: ch.eq.bands.map(b => ({ ...b })),
        hpf: { ...ch.eq.hpf },
        lpf: { ...ch.eq.lpf },
      } : undefined,
      comp: ch.comp ? { ...ch.comp } : undefined,
      gate: ch.gate ? { ...ch.gate } : undefined,
    }));
    deviceStore.routing = [...defaultDevice.routing];
    deviceStore.eqLink = { ...defaultDevice.eqLink };

    console.log('[dm] sendFullConfigToDevice', {
      serverid: deviceStore.serverid,
      guid: deviceStore.guid,
      channels: deviceStore.channels.length,
    });

    for (let i = 0; i < deviceStore.channels.length; i++) {
      const ch = deviceStore.channels[i];
      if (!ch) continue;
      try {
        await deviceStore.dsp.setLevelDb(i, ch.gainDb);
        await deviceStore.dsp.setPolarity(i, ch.polarity);
        await deviceStore.dsp.mute(i, ch.mute);

        if (ch.isOutput) {
          if (ch.delayMs !== undefined) await deviceStore.dsp.delayMs(i, ch.delayMs);
          if (ch.comp) await deviceStore.dsp.compressor(i, ch.comp);
          await deviceStore.dsp.routing(i, deviceStore.routing[i - OUT_BASE] ?? 0);
          if (ch.eq) {
            await deviceStore.dsp.crossoverHpf(i, deviceStore.calibration.xoverHzToRaw(ch.eq.hpf.freqHz), ch.eq.hpf.slope);
            await deviceStore.dsp.crossoverLpf(i, deviceStore.calibration.xoverHzToRaw(ch.eq.lpf.freqHz), ch.eq.lpf.slope);
            for (let band = 0; band < ch.eq.bands.length; band++) {
              const b = ch.eq.bands[band];
              if (!b) continue;
              await deviceStore.dsp.peqBand(i, band, {
                freqHz: b.freqHz,
                q: deviceStore.calibration.bwOctToQ(b.bwOct, b.freqHz),
                gainRaw: deviceStore.calibration.peqGainDbToRaw(b.gainDb, b.type),
                type: b.type,
                bypass: b.bypass,
              });
            }
          }
        } else if (ch.gate) {
          await deviceStore.dsp.gate(i, ch.gate);
        }
      } catch (e) {
        console.warn(`[dm] Failed to push channel ${i} config:`, e);
      }
    }

    console.log('[dm] sendFullConfigToDevice done');
  }

  /** Push the given UI model's full state to every bound shadow's hardware. */
  async pushFullConfigToAllFrom(model: typeof defaultDevice): Promise<void> {
    for (const device of this.devices) {
      if (!device.connected || !device.store.dsp) continue;
      device.store.channels = model.channels.map(ch => ({
        ...ch,
        eq: ch.eq ? {
          bands: ch.eq.bands.map(b => ({ ...b })),
          hpf: { ...ch.eq.hpf },
          lpf: { ...ch.eq.lpf },
        } : undefined,
        comp: ch.comp ? { ...ch.comp } : undefined,
        gate: ch.gate ? { ...ch.gate } : undefined,
      }));
      device.store.routing = [...model.routing];
      device.store.eqLink = { ...model.eqLink };
      await this.sendFullConfigToDevice(device.store).catch(() => {});
    }
  }

  // --- live broadcast (state mirror + per-field hardware push) -----------

  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      const ch = device.store.channels[channelIndex];
      if (!ch) continue;

      Object.assign(ch, updates);
      device.store.channels = [...device.store.channels];

      const dsp = device.store.dsp;
      if (!dsp) continue;
      (async () => {
        try {
          if (typeof updates.gainDb === 'number') await dsp.setLevelDb(channelIndex, updates.gainDb);
          if (typeof updates.mute === 'boolean') await dsp.mute(channelIndex, updates.mute);
          if (typeof updates.polarity === 'boolean') await dsp.setPolarity(channelIndex, updates.polarity);
          if (typeof updates.delayMs === 'number') await dsp.delayMs(channelIndex, updates.delayMs);
          if (updates.comp) await dsp.compressor(channelIndex, updates.comp);
          if (updates.gate) await dsp.gate(channelIndex, updates.gate);
        } catch { /* per-field best-effort */ }
      })();
    }
  }

  broadcastRoutingUpdate(outIndex: number, mask: number): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      const i = outIndex - 0x04;
      if (i < 0 || i >= device.store.routing.length) continue;

      device.store.routing[i] = mask;
      device.store.routing = [...device.store.routing];

      const dsp = device.store.dsp;
      if (!dsp) continue;
      void dsp.routing(outIndex, mask).catch(() => {});
    }
  }

  broadcastEqLinkUpdate(a: number, b: number): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      device.store.eqLink = { ...device.store.eqLink, [a]: b, [b]: a };
    }
  }

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: EqBandUpdates): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      const ch = device.store.channels[channelIndex];
      const eq = ch?.eq;
      if (!eq || !Array.isArray(eq.bands) || bandIndex >= eq.bands.length) continue;

      Object.assign(eq.bands[bandIndex]!, updates);
      device.store.channels = [...device.store.channels];

      const dsp = device.store.dsp;
      if (!dsp) continue;
      const b = eq.bands[bandIndex]!;
      const cal = device.store.calibration;
      if (!cal) continue;
      void dsp.peqBand(channelIndex, bandIndex, {
        freqHz: b.freqHz,
        q: cal.bwOctToQ(b.bwOct, b.freqHz),
        gainRaw: cal.peqGainDbToRaw(b.gainDb, b.type),
        type: b.type,
        bypass: b.bypass,
      }).catch(() => {});
    }
  }

  broadcastEqCrossoverUpdate(channelIndex: number, type: 'hpf' | 'lpf', updates: any): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      const eq = device.store.channels[channelIndex]?.eq;
      if (!eq || !(type in eq)) continue;

      Object.assign((eq as any)[type], updates);
      device.store.channels = [...device.store.channels];

      const dsp = device.store.dsp;
      const cal = device.store.calibration;
      if (!dsp || !cal) continue;
      const x = (eq as any)[type];
      if (type === 'hpf') {
        void dsp.crossoverHpf(channelIndex, cal.xoverHzToRaw(x.freqHz), x.slope).catch(() => {});
      } else {
        void dsp.crossoverLpf(channelIndex, cal.xoverHzToRaw(x.freqHz), x.slope).catch(() => {});
      }
    }
  }

  // --- persisted bindings -------------------------------------------------

  loadBindings(): PersistedBindings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_BOUND);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as PersistedBindings;
    } catch { /* ignore */ }
    return {};
  }

  bindingsFor(url: string): PersistedBinding[] {
    return Object.values(this.loadBindings()[url] ?? {});
  }

  forgetBinding(url: string, guid: string): void {
    const map = this.loadBindings();
    if (map[url]?.[guid]) {
      delete map[url][guid];
      if (Object.keys(map[url]!).length === 0) delete map[url];
      this.#saveBindings(map);
    }
  }

  #saveBindings(map: PersistedBindings): void {
    try { localStorage.setItem(STORAGE_KEY_BOUND, JSON.stringify(map)); } catch { /* ignore */ }
  }

  #recordBinding(rec: ConnectedDevice): void {
    const url = rec.connectionInfo.url;
    const guid = rec.guid;
    const serverid = rec.serverid;
    if (!url || !guid || !serverid) return;
    const map = this.loadBindings();
    map[url] = map[url] ?? {};
    map[url]![guid] = {
      guid,
      serverid,
      productName: rec.connectionInfo.productName,
      kind: 'hid',
    };
    this.#saveBindings(map);
  }

  #dropBinding(rec: ConnectedDevice): void {
    const url = rec.connectionInfo.url;
    const guid = rec.guid;
    if (!url || !guid) return;
    const map = this.loadBindings();
    if (map[url]?.[guid]) {
      delete map[url][guid];
      if (Object.keys(map[url]!).length === 0) delete map[url];
      this.#saveBindings(map);
    }
  }

  #dropBindingsForServer(url: string): void {
    const map = this.loadBindings();
    if (map[url]) {
      delete map[url];
      this.#saveBindings(map);
    }
  }

  // --- legacy save/restore of connection state ---------------------------

  saveConnectionState(): void {
    try {
      const state = {
        devices: this.devices.map(d => ({
          id: d.id,
          connectionInfo: d.connectionInfo,
          serverid: d.serverid,
          guid: d.guid,
          connected: d.connected,
        })),
        servers: this.servers.map(s => ({
          id: s.id, url: s.url, productName: s.productName,
          serverid: s.serverid, connectedAt: s.connectedAt,
        })),
      };
      localStorage.setItem("opendsp-device-manager-state", JSON.stringify(state));
    } catch (e) { console.error('Error saving device manager state:', e); }
  }

  restoreConnectionState(): void {
    try {
      const raw = localStorage.getItem("opendsp-device-manager-state");
      if (!raw) return;
      const state = JSON.parse(raw);
      this.devices = (state.devices ?? []).map((d: any) => ({
        id: d.id, store: defaultDevice,
        connectionInfo: d.connectionInfo,
        serverid: d.serverid, guid: d.guid, connected: false,
      }));
      this.servers = state.servers ?? [];
    } catch (e) { console.error('Error restoring device manager state:', e); }
  }

  clearConnectionState(): void {
    try { localStorage.removeItem("opendsp-device-manager-state"); }
    catch (e) { console.error('Error clearing device manager state:', e); }
  }
}

export const deviceManager = new DeviceManagerState();