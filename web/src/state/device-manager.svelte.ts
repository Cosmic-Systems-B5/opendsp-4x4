// Multi-DSP Device Manager with master/slave support.
// First connected DSP becomes the master; slaves mirror the master.
//
// A `.svelte.ts` module so `$state` works at the module level. Importers must
// use `device-manager.svelte.ts` (with extension) in Svelte 5 + Vite unless
// the Svelte plugin config accepts `.svelte.ts` extensions.

import { device as defaultDevice } from "./device.svelte.ts";
import type { Channel } from "./device-model.ts";
import type { WebSocketTransport } from "../transport/websocket.ts";

export type DeviceRole = 'master' | 'slave';

export interface ConnectedDevice {
  id: string;
  store: typeof defaultDevice;
  role: DeviceRole;
  transportType: 'usb' | 'websocket';
  transport?: WebSocketTransport;
  connectionInfo: {
    url?: string;
    path?: string;
    productName: string;
    serialNumber?: string;
  };
  serverGuid?: string;
  deviceGuid?: string;
  publishedId?: string;
  deviceId?: string;
  connected: boolean;
}

export interface ServerConnection {
  id: string;
  url: string;
  transportType: 'websocket';
  productName: string;
  connectedAt: string;
  serverGuid?: string;
}

export interface EqBandUpdates {
  freqHz?: number;
  gainDb?: number;
  bwOct?: number;
  type?: number;
  bypass?: boolean;
}

// --- Persisted device bindings ---------------------------------------------
// Records which (url, deviceId) pairs the user has bound, so a page refresh
// can restore them once the server reconnects.

const STORAGE_KEY_BOUND = "opendsp-bound-devices";

export interface PersistedBinding {
  deviceId: string;
  productName: string;
  deviceGuid: string;
  publishedId: string;
  kind: 'hid' | 'mock';
}
export type PersistedBindings = Record<string, Record<string, PersistedBinding>>;

class DeviceManagerState {
  devices = $state<ConnectedDevice[]>([]);
  servers: ServerConnection[] = [];
  nextId = 0;

  get master(): typeof defaultDevice | undefined {
    return this.devices.find(d => d.role === 'master' && d.connected)?.store;
  }
  get slaveCount(): number {
    return this.devices.filter(d => d.role === 'slave' && d.connected).length;
  }
  get connectedDevices(): ConnectedDevice[] {
    return this.devices.filter(d => d.connected);
  }

  // --- bind / disconnect -------------------------------------------------

  bindTransport(
      t: WebSocketTransport,
      deviceStore: typeof defaultDevice,
      opts: {
        url: string;
        deviceId: string;
        publishedId: string;
        deviceGuid: string;
        serverGuid?: string;
        productName: string;
        kind: 'hid' | 'mock';
      },
  ): ConnectedDevice | null {
    const existing = this.devices.find(
        d => d.transportType === 'websocket'
            && d.connectionInfo.url === opts.url
            && d.deviceId === opts.deviceId
            && d.connected,
    );
    if (existing) return existing;

    const role: DeviceRole = this.devices.some(d => d.role === 'master' && d.connected)
        ? 'slave'
        : 'master';

    const rec: ConnectedDevice = {
      id: `websocket-${this.nextId++}`,
      store: deviceStore,
      role,
      transportType: 'websocket',
      transport: t,
      connectionInfo: { url: opts.url, productName: opts.productName },
      serverGuid: opts.serverGuid,
      deviceGuid: opts.deviceGuid,
      publishedId: opts.publishedId,
      deviceId: opts.deviceId,
      connected: true,
    };
    this.devices = [...this.devices, rec];

    deviceStore.serverGuid = opts.serverGuid;
    deviceStore.deviceGuid = opts.deviceGuid;
    deviceStore.role = role;
    deviceStore.productName = opts.productName;

    this.#recordBinding(rec);
    this.saveConnectionState();

    // NEW: if this device joined as a slave, mirror the master into it and
    // push the mirrored state to its hardware. Do it here (not at the call site)
    // so callers can't forget and so the role is guaranteed to be assigned.

    if (rec.role === 'slave') {
      const master = this.master;
      if (master && master !== deviceStore) {
        void this.applyMasterConfig(deviceStore).catch((e) =>
            console.warn(`[deviceManager] applyMasterConfig failed for ${rec.id}:`, e)
        );
      }
    }

    return rec;
  }

  connectServer(url: string, productName: string, serverGuid?: string): ServerConnection | null {
    for (const existing of this.servers) if (existing.url === url) return null;
    const server: ServerConnection = {
      id: `server-${this.nextId++}`,
      url, transportType: 'websocket', productName, serverGuid,
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
    // this.#promoteIfNeeded();
  }

  getServers(): ServerConnection[] { return [...this.servers]; }

  /** Legacy USB path — no deviceId-aware binding needed. */
  connect(
      deviceStore: typeof defaultDevice,
      connectionInfo: ConnectedDevice['connectionInfo'],
      transportType: 'usb' | 'websocket',
      serverGuid?: string,
      deviceGuid?: string,
  ): void {
    const duplicate = this.devices.some(d =>
        d.transportType === transportType
        && d.connectionInfo.path === connectionInfo.path
        && d.connectionInfo.url === connectionInfo.url
        && d.connected);
    if (duplicate) return;

    const role: DeviceRole = this.devices.some(d => d.role === 'master' && d.connected)
        ? 'slave'
        : 'master';

    this.devices = [...this.devices, {
      id: `${transportType}-${this.nextId++}`,
      store: deviceStore,
      role,
      transportType,
      connectionInfo,
      serverGuid,
      deviceGuid,
      connected: true,
    }];
    this.saveConnectionState();
  }

  disconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = false;
    this.#dropBinding(rec);
    this.devices = [...this.devices];
    // this.#promoteIfNeeded();
    this.saveConnectionState();
  }

  reconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = true;
    this.devices = [...this.devices];
    // this.#promoteIfNeeded();
    this.saveConnectionState();
  }

  disconnectAll(): void {
    for (const d of this.devices) d.connected = false;
    this.devices = [...this.devices];
  }

  // --- master → slave mirroring ------------------------------------------

  /**
   * Copy the master's current state into `target` and push it to `target`'s
   * bound device. Called when a slave joins, and on role promotion.
   */
  async applyMasterConfig(target: typeof defaultDevice): Promise<void> {
    const master = this.master;
    if (!master || master === target) return;

    await master.ready;

    console.log('[dm] applyMasterConfig', {
      target_has_dsp: !!(target as any).dsp,
      master_channels: master.channels.length,
      target_channels: target.channels.length,
      target_role: target.role,
    });

    target.channels = master.channels.map(ch => ({
      index: ch.index,
      name: ch.name,
      isOutput: ch.isOutput,
      gainDb: ch.gainDb,
      mute: ch.mute,
      polarity: ch.polarity,
      meter: ch.meter,
      eq: ch.eq ? {
        bands: ch.eq.bands.map(b => ({ ...b })),
        hpf: { freqHz: ch.eq.hpf.freqHz, slope: ch.eq.hpf.slope },
        lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope },
      } : undefined,
      delayMs: ch.delayMs,
      comp: ch.comp ? { ...ch.comp } : undefined,
      gate: ch.gate ? { ...ch.gate } : undefined,
      eqMode: ch.eqMode,
    }));
    target.routing = [...master.routing];
    target.eqLink = { ...master.eqLink };
    target.presetName = master.presetName;
    target.activePreset = master.activePreset;

    await target.pushAll();
  }

  // /** Promote the first connected slave to master if no master is active. */
  // #promoteIfNeeded(): void {
  //   const hasMaster = this.devices.some(d => d.role === 'master' && d.connected);
  //   if (hasMaster) return;
  //   const first = this.devices.find(d => d.connected);
  //   if (!first) return;
  //   for (const d of this.devices) {
  //     d.role = d.id === first.id ? 'master' : 'slave';
  //     d.store.role = d.role;
  //   }
  //   this.devices = [...this.devices];    // ← NEW: trigger reactivity for activeDevice()
  //   // Strict: bring the promoted master's device in line with what the UI
  //   // already shows, and reapply its config to the remaining slaves.
  //   void first.store.pushAll().catch(() => {});
  //   for (const d of this.devices) {
  //     if (d.id !== first.id && d.connected) {
  //       void this.applyMasterConfig(d.store).catch(() => {});
  //     }
  //   }
  // }

  // --- live broadcast (state mirror + per-field hardware push) -----------

// ---------------------------------------------------------------------------
// Live broadcast: mirror master → slave stores, AND push the same values to
// each slave's bound device via `store.dsp` directly.
//
// IMPORTANT: these must NOT call the store's public setters (setGainDb,
// setMute, etc.) — those call commit(), which calls broadcastToSlaves(),
// which would re-enter this method. Calling `store.dsp.<cmd>()` directly
// sends the write without any local rebroadcast.
// ---------------------------------------------------------------------------

  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role !== 'slave' || !device.connected) continue;
      const ch = device.store.channels[channelIndex];
      if (!ch) continue;

      // 1) Mirror to the slave's reactive store (UI).
      Object.assign(ch, updates);
      device.store.channels = [...device.store.channels];

      // 2) Push to the slave's hardware via dsp directly (bypasses commit()).
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
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role !== 'slave' || !device.connected) continue;
      const i = outIndex - 0x04;
      if (i < 0 || i >= device.store.routing.length) continue;

      // 1) Mirror to slave store.
      device.store.routing[i] = mask;
      device.store.routing = [...device.store.routing];

      // 2) Push to slave hardware.
      const dsp = device.store.dsp;
      if (!dsp) continue;
      void dsp.routing(outIndex, mask).catch(() => {});
    }
  }

  broadcastEqLinkUpdate(a: number, b: number): void {
    // EQ links are a UI-only concept (they pair two outputs for mirrored
    // editing). There is no wire command for "link EQ", so this is
    // store-only — no dsp push.
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role !== 'slave' || !device.connected) continue;
      device.store.eqLink = { ...device.store.eqLink, [a]: b, [b]: a };
    }
  }

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: EqBandUpdates): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role !== 'slave' || !device.connected) continue;
      const ch = device.store.channels[channelIndex];
      const eq = ch?.eq;
      if (!eq || !Array.isArray(eq.bands) || bandIndex >= eq.bands.length) continue;

      // 1) Mirror to slave store.
      Object.assign(eq.bands[bandIndex]!, updates);
      device.store.channels = [...device.store.channels];

      // 2) Push to slave hardware. Uses the store's Calibration to convert
      //    engineering units back to wire values.
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
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role !== 'slave' || !device.connected) continue;
      const eq = device.store.channels[channelIndex]?.eq;
      if (!eq || !(type in eq)) continue;

      // 1) Mirror to slave store.
      Object.assign((eq as any)[type], updates);
      device.store.channels = [...device.store.channels];

      // 2) Push to slave hardware.
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

  /**
   * Push one field's change to the store's bound device, dispatching to the
   * correct Dsp method. Called from broadcast* to keep slave hardware in sync
   * without re-pushing the entire state.
   */
  async #pushChannelField(store: typeof defaultDevice, i: number, updates: Partial<Channel>): Promise<void> {
    const dsp = (store as any).dsp;
    if (!dsp) return;
    try {
      if (typeof updates.gainDb === 'number') await dsp.setLevelDb(i, updates.gainDb);
      if (typeof updates.mute === 'boolean') await dsp.mute(i, updates.mute);
      if (typeof updates.polarity === 'boolean') await dsp.setPolarity(i, updates.polarity);
      if (typeof updates.delayMs === 'number') await dsp.delayMs(i, updates.delayMs);
      if (updates.comp) await dsp.compressor(i, updates.comp);
      if (updates.gate) await dsp.gate(i, updates.gate);
    } catch { /* per-field best-effort */ }
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

  forgetBinding(url: string, deviceId: string): void {
    const map = this.loadBindings();
    if (map[url]?.[deviceId]) {
      delete map[url][deviceId];
      if (Object.keys(map[url]!).length === 0) delete map[url];
      this.#saveBindings(map);
    }
  }

  #saveBindings(map: PersistedBindings): void {
    try { localStorage.setItem(STORAGE_KEY_BOUND, JSON.stringify(map)); } catch { /* ignore */ }
  }

  #recordBinding(rec: ConnectedDevice): void {
    if (rec.transportType !== "websocket") return;
    const url = rec.connectionInfo.url;
    const deviceId = rec.deviceId;
    if (!url || !deviceId) return;
    const map = this.loadBindings();
    map[url] = map[url] ?? {};
    map[url]![deviceId] = {
      deviceId,
      productName: rec.connectionInfo.productName,
      deviceGuid: rec.deviceGuid ?? "",
      publishedId: rec.publishedId ?? "",
      kind: "hid",
    };
    this.#saveBindings(map);
  }

  #dropBinding(rec: ConnectedDevice): void {
    if (rec.transportType !== "websocket") return;
    const url = rec.connectionInfo.url;
    const deviceId = rec.deviceId;
    if (!url || !deviceId) return;
    const map = this.loadBindings();
    if (map[url]?.[deviceId]) {
      delete map[url][deviceId];
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
          id: d.id, role: d.role, transportType: d.transportType,
          connectionInfo: d.connectionInfo, serverGuid: d.serverGuid,
          deviceGuid: d.deviceGuid, connected: d.connected,
        })),
        servers: this.servers.map(s => ({
          id: s.id, url: s.url, productName: s.productName,
          serverGuid: s.serverGuid, connectedAt: s.connectedAt,
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
        id: d.id, store: defaultDevice, role: d.role as DeviceRole,
        transportType: d.transportType, connectionInfo: d.connectionInfo,
        serverGuid: d.serverGuid, deviceGuid: d.deviceGuid, connected: false,
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