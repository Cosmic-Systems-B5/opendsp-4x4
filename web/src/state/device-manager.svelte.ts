// Multi-DSP Device Manager - peer-to-peer architecture
// All DSP units are peers; the UI local data model is the single source of truth.
//
// A `.svelte.ts` module so `$state` works at the module level. Importers must
// use `device-manager.svelte.ts` (with extension) in Svelte 5 + Vite unless
// the Svelte plugin config accepts `.svelte.ts` extensions.

import { device as defaultDevice } from "../state/device.svelte.ts";

import type { Channel } from "./device-model.ts";
import type { WebSocketTransport } from "../transport/websocket.ts";

export interface ConnectedDevice {
  id: string;
  store: typeof defaultDevice;
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

  // Get all connected devices
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
        d => d.connectionInfo.url === opts.url
            && d.deviceId === opts.deviceId
            && d.connected,
    );
    if (existing) return existing;

    const rec: ConnectedDevice = {
      id: `websocket-${this.nextId++}`,
      store: deviceStore,
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
    deviceStore.productName = opts.productName;

    if (this.devices.length >= 2) {
      // Send current local data model config to any newly connected device
      void this.sendFullConfigToDevice(deviceStore).catch((e) =>
          console.warn(`[deviceManager] sendFullConfigToDevice failed for ${rec.id}:`, e)
      );
    }

    this.#recordBinding(rec);

    return rec;
  }

  connectServer(url: string, productName: string, serverGuid?: string): ServerConnection | null {
    for (const existing of this.servers) if (existing.url === url) return null;
    const server: ServerConnection = {
      id: `server-${this.nextId++}`,
      url, productName, serverGuid,
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

  // getServers(): ServerConnection[] { return [...this.servers]; }
  //
  // /** Legacy USB path — no deviceId-aware binding needed. */
  // connect(
  //     deviceStore: typeof defaultDevice,
  //     connectionInfo: ConnectedDevice['connectionInfo'],
  //     transportType: 'usb' | 'websocket',
  //     serverGuid?: string,
  //     deviceGuid?: string,
  // ): void {
  //   const duplicate = this.devices.some(d =>
  //       d.connectionInfo.path === connectionInfo.path
  //       && d.connectionInfo.url === connectionInfo.url
  //       && d.connected);
  //   if (duplicate) return;
  //
  //   this.devices = [...this.devices, {
  //     id: `${transportType}-${this.nextId++}`,
  //     store: deviceStore,
  //     connectionInfo,
  //     serverGuid,
  //     deviceGuid,
  //     connected: true,
  //   }];
  //
  //   // USB devices always hydrate from hardware first; they don't receive
  //   // config from other devices (no master/slave in peer-to-peer).
  //   // The UI will read the state after hydration completes.
  //
  //   this.saveConnectionState();
  // }

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

  /**
   * Send the complete current local data model configuration to a DSP device.
   * This is called when a device connects and should receive the current state.
   */
  async sendFullConfigToDevice(deviceStore: typeof defaultDevice): Promise<void> {
    if (!deviceStore.dsp) {
      console.log('[dm] sendFullConfigToDevice skipped — no dsp');
      return;
    }

    await deviceStore.ready;

    console.log('[dm] sendFullConfigToDevice', {
      deviceId: deviceStore.deviceGuid,
      channels: deviceStore.channels.length,
    });

    // Push all channel settings to the device
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
          await deviceStore.dsp.routing(0x04 + i, deviceStore.routing[i]);
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
        } else {
          if (ch.gate) await deviceStore.dsp.gate(i, ch.gate);
        }
      } catch (e) {
        console.warn(`[dm] Failed to push channel ${i} config:`, e);
      }
    }

    // Push routing (output 1-4)
    for (let i = 0; i < deviceStore.routing.length; i++) {
      try {
        await deviceStore.dsp.routing(0x04 + i, deviceStore.routing[i]);
      } catch (e) {
        console.warn(`[dm] Failed to push routing ${i}:`, e);
      }
    }

    // Push preset name and active preset
    if (deviceStore.presetName) {
      // Note: SET_NAME command sets the current preset name on device
    }

    console.log('[dm] sendFullConfigToDevice done');
  }

  // --- live broadcast (state mirror + per-field hardware push) -----------

  /**
   * Broadcast a channel update to all connected DSP devices.
   * The change originated from the UI local model, so we push to all devices
   * including the one that may have triggered the change (for redundancy).
   */
  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    if (this.connectedDevices.length === 0) return;
    for (const device of this.devices) {
      if (!device.connected) continue;
      const ch = device.store.channels[channelIndex];
      if (!ch) continue;

      // Mirror to the device's store
      Object.assign(ch, updates);
      device.store.channels = [...device.store.channels];

      // Push to the hardware via dsp directly (bypasses commit()).
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

      // Mirror to store.
      device.store.routing[i] = mask;
      device.store.routing = [...device.store.routing];

      // Push to hardware.
      const dsp = device.store.dsp;
      if (!dsp) continue;
      void dsp.routing(outIndex, mask).catch(() => {});
    }
  }

  broadcastEqLinkUpdate(a: number, b: number): void {
    // EQ links are a UI-only concept (they pair two outputs for mirrored
    // editing). There is no wire command for "link EQ", so this is
    // store-only — no dsp push.
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

      // Mirror to store.
      Object.assign(eq.bands[bandIndex]!, updates);
      device.store.channels = [...device.store.channels];

      // Push to hardware. Uses the store's Calibration to convert
      // engineering units back to wire values.
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

      // Mirror to store.
      Object.assign((eq as any)[type], updates);
      device.store.channels = [...device.store.channels];

      // Push to hardware.
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
          id: d.id,
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
        id: d.id, store: defaultDevice, transportType: d.transportType,
        connectionInfo: d.connectionInfo,
        serverGuid: d.serverGuid, deviceGuid: d.deviceGuid, connected: false,
      }));
      this.servers = state.servers ?? [];
    } catch (e) { console.error('Error restoring device manager state:', e); }
  }

  clearConnectionState(): void {
    try { localStorage.removeItem("opendsp-device-manager-state"); }
    catch (e) { console.error('Error clearing device manager state:', e); }
  }

  #hasBoundDevice(): boolean {
    try {
      const raw = localStorage.getItem("opendsp-bound-devices");
      if (raw) {
        var boundDevices = JSON.parse(raw);
        return !!raw && raw.length > 5;
      } else {
        return false;
      }
    } catch { /* ignore */ }
    return false;
  }
}

export const deviceManager = new DeviceManagerState();
