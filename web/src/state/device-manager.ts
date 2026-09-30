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
      if (this.devices.length > 0 && this.devices[0].role !== 'master') {
        this.devices[0].role = 'master';
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
        if (ch) Object.assign(ch, updates);
      }
    }
  }

  broadcastRoutingUpdate(outIndex: number, mask: number): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        device.store.routing[outIndex - 0x04] = mask;
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

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: Partial<Channel['eq']['bands'][number]>): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const ch = device.store.channels[channelIndex];
        if (ch?.eq?.bands[bandIndex]) {
          Object.assign(ch.eq.bands[bandIndex], updates);
        }
      }
    }
  }

  broadcastEqCrossoverUpdate(channelIndex: number, type: 'hpf' | 'lpf', updates: Partial<Channel['eq'][typeof type]>): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        const ch = device.store.channels[channelIndex];
        if (ch?.eq?.[type]) Object.assign(ch.eq[type], updates);
      }
    }
  }

  syncAllToSlaves(): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave') {
        device.store.channels = structuredClone(masterDevice.channels);
        device.store.routing = [...masterDevice.routing];
        device.store.eqLink = { ...masterDevice.eqLink };
      }
    }
  }
}

export const deviceManager = new DeviceManagerState();
