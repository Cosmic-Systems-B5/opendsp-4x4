// Multi-DSP Device Manager with master/slave support.
// First connected DSP becomes the master - all settings are read from it.
// Subsequent DSPs become slaves and receive master's setup and any changes.

import { device as defaultDevice } from "./device.svelte.ts";
import type { Channel } from "./model.ts";

export type DeviceRole = 'master' | 'slave';

export interface ConnectedDevice {
  id: string;
  store: typeof defaultDevice;
  role: DeviceRole;
  transportType: 'usb' | 'websocket';
  connectionInfo: {
    path?: string;
    url?: string;
    productName: string;
    serialNumber?: string;
  };
}

// Type for eq band updates - simplified to avoid TypeScript narrowing issues
export interface EqBandUpdates {
  freqHz?: number;
  gainDb?: number;
  bwOct?: number;
  type?: number;
  bypass?: boolean;
}

// Type for eq band updates - simplified to avoid TypeScript narrowing issues

class DeviceManagerState {
  devices: ConnectedDevice[] = [];
  nextId = 0;

  get master(): typeof defaultDevice | undefined {
    return this.devices.find(d => d.role === 'master')?.store;
  }

  get slaveCount(): number {
    return this.devices.filter(d => d.role === 'slave').length;
  }

  connect(deviceStore: typeof defaultDevice, transportType: 'usb' | 'websocket', connectionInfo: ConnectedDevice['connectionInfo']): void {
    // Check if a device with the same path/url is already connected (prevents duplicate connections)
    for (const existing of this.devices) {
      const isNewPath = transportType === 'usb' && existing.connectionInfo.path === connectionInfo.path;
      const isNewUrl = transportType === 'websocket' && existing.connectionInfo.url === connectionInfo.url;

      if (isNewPath || isNewUrl) {
        console.warn(`Device ${connectionInfo.productName} is already connected (${existing.id})`);
        return; // Don't add duplicate
      }
    }

    const role = this.devices.length === 0 ? 'master' : 'slave';

    const connectedDevice: ConnectedDevice = {
      id: `${transportType}-${this.nextId++}`,
      store: deviceStore,
      role,
      transportType,
      connectionInfo
    };

    this.devices.push(connectedDevice);
  }

  disconnect(id: string): void {
    const idx = this.devices.findIndex(d => d.id === id);
    if (idx >= 0) {
      this.devices.splice(idx, 1);
      if (this.devices.length > 0 && this.devices[0]!.role !== 'master') {
        this.devices[0]!.role = 'master';
      }
    }
  }

  disconnectAll(): void {
    this.devices = [];
  }

  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const ch = device.store.channels[channelIndex];
        if (ch) {
          Object.assign(ch, updates);
          // Reassign to trigger reactivity
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  broadcastRoutingUpdate(outIndex: number, mask: number): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const routingIndex = outIndex - 0x04;
        if (routingIndex >= 0 && routingIndex < device.store.routing.length) {
          device.store.routing[routingIndex] = mask;
          // Reassign to trigger reactivity
          device.store.routing = [...device.store.routing];
        }
      }
    }
  }

  broadcastEqLinkUpdate(a: number, b: number): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        device.store.eqLink = { ...device.store.eqLink, [a]: b, [b]: a };
      }
    }
  }

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: EqBandUpdates): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const ch = device.store.channels[channelIndex];
        // @ts-ignore - TypeScript narrowing issue with nested optional properties
        const eq = ch?.eq;
        if (eq && Array.isArray(eq.bands) && bandIndex < eq.bands.length) {
          // @ts-ignore - Object.assign overload mismatch
          Object.assign(eq.bands[bandIndex], updates);
          // Reassign to trigger reactivity
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  broadcastEqCrossoverUpdate(channelIndex: number, type: 'hpf' | 'lpf', updates: any): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const ch = device.store.channels[channelIndex];
        // @ts-ignore - TypeScript narrowing issue with nested optional properties
        const eq = ch?.eq;
        if (eq && (type in eq)) {
          Object.assign(eq[type], updates);
          // Reassign to trigger reactivity
          device.store.channels = [...device.store.channels];
        }
      }
    }
  }

  syncAllToSlaves(): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        // Convert $state to plain objects for cloning
        device.store.channels = masterDevice.channels.map(ch => ({
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
            lpf: { freqHz: ch.eq.lpf.freqHz, slope: ch.eq.lpf.slope }
          } : undefined,
          delayMs: ch.delayMs,
          comp: ch.comp ? { ...ch.comp } : undefined,
          gate: ch.gate ? { ...ch.gate } : undefined,
          eqMode: ch.eqMode
        }));
        device.store.routing = [...masterDevice.routing];
        device.store.eqLink = { ...masterDevice.eqLink };
      }
    }
  }
}

export const deviceManager = new DeviceManagerState();
