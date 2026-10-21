// Multi-DSP Device Manager with master/slave support.
// First connected DSP becomes the master; slaves mirror the master.

import { device as defaultDevice } from "./device.svelte.ts";
import type { Channel } from "./device-model.ts";
import type { WebSocketTransport } from "../transport/websocket.ts";

const STORAGE_KEY_BOUND = "opendsp-bound-devices";

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

export interface PersistedBinding {
  deviceId: string;
  productName: string;
  deviceGuid: string;
  publishedId: string;
  kind: 'hid' | 'mock';
}

export type PersistedBindings = Record<string, Record<string, PersistedBinding>>;

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

  /**
   * Attach a device store to a WebSocket transport for a specific deviceId
   * on a specific server. Idempotent: returns the existing record if the same
   * (url, deviceId) is already bound.
   */
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
    return rec;
  }

  disconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = false;
    this.devices = [...this.devices];
    this.#dropBinding(rec);
    this.#promoteIfNeeded();
    this.saveConnectionState();
  }

  reconnect(id: string): void {
    const rec = this.devices.find(d => d.id === id);
    if (!rec) return;
    rec.connected = true;
    this.devices = [...this.devices];
    this.#promoteIfNeeded();
    this.saveConnectionState();
  }

  disconnectAll(): void {
    for (const d of this.devices) d.connected = false;
    this.devices = [...this.devices];
  }

  /** Promote the first connected slave to master if no master is active. */
  #promoteIfNeeded(): void {
    const hasMaster = this.devices.some(d => d.role === 'master' && d.connected);
    if (hasMaster) return;
    const first = this.devices.find(d => d.connected);
    if (!first) return;
    for (const d of this.devices) {
      d.role = d.id === first.id ? 'master' : 'slave';
      d.store.role = d.role;
    }
  }

  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        const ch = device.store.channels[channelIndex];
        if (ch) {
          Object.assign(ch, updates);
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  broadcastRoutingUpdate(outIndex: number, mask: number): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        const i = outIndex - 0x04;
        if (i >= 0 && i < device.store.routing.length) {
          device.store.routing[i] = mask;
          device.store.routing = [...device.store.routing];
        }
      }
    }
  }

  broadcastEqLinkUpdate(a: number, b: number): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        device.store.eqLink = { ...device.store.eqLink, [a]: b, [b]: a };
      }
    }
  }

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: EqBandUpdates): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        const ch = device.store.channels[channelIndex];
        const eq = ch?.eq;
        if (eq && Array.isArray(eq.bands) && bandIndex < eq.bands.length) {
          Object.assign(eq.bands[bandIndex]!, updates);
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  broadcastEqCrossoverUpdate(channelIndex: number, type: 'hpf' | 'lpf', updates: any): void {
    if (!this.master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        const eq = device.store.channels[channelIndex]?.eq;
        if (eq && (type in eq)) {
          Object.assign((eq as any)[type], updates);
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  syncAllToSlaves(): void {
    const master = this.master;
    if (!master || this.slaveCount === 0) return;
    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
        device.store.channels = master.channels.map(ch => ({
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
        device.store.routing = [...master.routing];
        device.store.eqLink = { ...master.eqLink };
      }
    }
  }

  saveConnectionState(): void {
    try {
      const state = {
        devices: this.devices.map(d => ({
          id: d.id,
          role: d.role,
          transportType: d.transportType,
          connectionInfo: d.connectionInfo,
          serverGuid: d.serverGuid,
          deviceGuid: d.deviceGuid,
          connected: d.connected,
        })),
        servers: this.servers.map(s => ({
          id: s.id,
          url: s.url,
          productName: s.productName,
          serverGuid: s.serverGuid,
          connectedAt: s.connectedAt,
        })),
      };
      localStorage.setItem("opendsp-device-manager-state", JSON.stringify(state));
    } catch (e) {
      console.error('Error saving device manager state:', e);
    }
  }

  restoreConnectionState(): void {
    try {
      const raw = localStorage.getItem("opendsp-device-manager-state");
      if (!raw) return;
      const state = JSON.parse(raw);
      this.devices = (state.devices ?? []).map((d: any) => ({
        id: d.id,
        store: defaultDevice,
        role: d.role as DeviceRole,
        transportType: d.transportType,
        connectionInfo: d.connectionInfo,
        serverGuid: d.serverGuid,
        deviceGuid: d.deviceGuid,
        connected: false,
      }));
      this.servers = state.servers ?? [];
    } catch (e) {
      console.error('Error restoring device manager state:', e);
    }
  }

  clearConnectionState(): void {
    try {
      localStorage.removeItem("opendsp-device-manager-state");
    } catch (e) {
      console.error('Error clearing device manager state:', e);
    }
  }

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

  forgetBinding(url: string, deviceId: string): void {
    const map = this.loadBindings();
    if (map[url]?.[deviceId]) {
      delete map[url][deviceId];
      if (Object.keys(map[url]!).length === 0) delete map[url];
      this.#saveBindings(map);
    }
  }
}

export const deviceManager = new DeviceManagerState();