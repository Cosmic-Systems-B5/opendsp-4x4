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
    url?: string;
    path?: string;
    productName: string;
    serialNumber?: string;
  };
  serverGuid?: string;      // Unique GUID of the WebSocket server
  deviceGuid?: string;      // Unique GUID of this DSP device (from server)
  connected: boolean;       // Whether this device is currently connected
}

// WebSocket server connection info (separate from devices)
export interface ServerConnection {
  id: string;
  url: string;
  transportType: 'websocket';
  productName: string;
  connectedAt: string;
  serverGuid?: string;  // Unique GUID of this server (from /server-info endpoint)
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
  servers: ServerConnection[] = [];
  nextId = 0;

  get master(): typeof defaultDevice | undefined {
    // Find the first connected device with master role
    return this.devices.find(d => d.role === 'master' && d.connected)?.store;
  }

  get slaveCount(): number {
    return this.devices.filter(d => d.role === 'slave' && d.connected).length;
  }

  /**
   * Connect to a WebSocket server (creates transport, not a device connection)
   */
  connectServer(url: string, productName: string, serverGuid?: string): ServerConnection | null {
    // Check if already connected
    for (const existing of this.servers) {
      if (existing.url === url) {
        console.warn(`Server ${url} is already connected`);
        return null;
      }
    }

    const server: ServerConnection = {
      id: `server-${this.nextId++}`,
      url,
      transportType: 'websocket',
      productName,
      serverGuid,
      connectedAt: new Date().toISOString()
    };

    this.servers.push(server);
    return server;
  }

  /**
   * Disconnect from a WebSocket server
   */
  disconnectServer(url: string): void {
    const idx = this.servers.findIndex(s => s.url === url);
    if (idx >= 0) {
      this.servers.splice(idx, 1);
    }
    // Also mark any devices on this server as disconnected
    for (const device of this.devices) {
      if (device.connectionInfo.url === url && device.connected) {
        device.connected = false;
        console.log(`Device ${device.id} marked as disconnected from server ${url}`);
      }
    }
  }

  /**
   * Get all connected servers
   */
  getServers(): ServerConnection[] {
    return [...this.servers];
  }

  connect(deviceStore: typeof defaultDevice, connectionInfo: ConnectedDevice['connectionInfo'], transportType: 'usb' | 'websocket', serverGuid?: string, deviceGuid?: string): void {
    // Determine the unique identifier for this device
    const identifier = transportType === 'usb' ? connectionInfo.path : connectionInfo.url;

    // Check if a device with the same path/url is already connected (prevents duplicate connections)
    for (const existing of this.devices) {
      const existingIdentifier = existing.transportType === 'usb'
        ? existing.connectionInfo.path
        : existing.connectionInfo.url;

      // Use serverGuid + url/path combination to uniquely identify devices
      // This allows multiple identical DSP units on the same server
      const isSameDevice = existing.transportType === transportType &&
        ((transportType === 'usb' && existing.connectionInfo.path === connectionInfo.path) ||
         (transportType === 'websocket' && existing.connectionInfo.url === connectionInfo.url));

      // If same URL/path but different serverGuid, this is a different connection
      if (isSameDevice && (!serverGuid || existing.serverGuid === serverGuid)) {
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
      connectionInfo,
      serverGuid,
      deviceGuid,
      connected: true
    };

    this.devices.push(connectedDevice);
  }

  disconnect(id: string): void {
    const deviceToDisconnect = this.devices.find(d => d.id === id);
    if (!deviceToDisconnect) return;

    // Mark as disconnected instead of removing from list
    deviceToDisconnect.connected = false;

    // If we disconnected the master and there are still connected devices,
    // make the first connected one the new master
    if (deviceToDisconnect.role === 'master') {
      const connectedDevices = this.devices.filter(d => d.connected);
      if (connectedDevices.length > 0 && connectedDevices[0]!.role !== 'master') {
        connectedDevices[0]!.role = 'master';
      }
    }

    console.log(`Device ${id} disconnected, marked as ${deviceToDisconnect.role}`);

    // Save connection state to localStorage
    this.saveConnectionState();
  }

  /**
   * Reconnect a previously disconnected device
   */
  reconnect(id: string): void {
    const device = this.devices.find(d => d.id === id);
    if (device) {
      device.connected = true;
      console.log(`Device ${id} reconnected`);

      // Save connection state to localStorage
      this.saveConnectionState();
    }
  }

  disconnectAll(): void {
    for (const device of this.devices) {
      device.connected = false;
    }
    console.log('All devices marked as disconnected');
  }

  broadcastChannelUpdate(channelIndex: number, updates: Partial<Channel>): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
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
      if (device.role === 'slave' && device.connected) {
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
      if (device.role === 'slave' && device.connected) {
        device.store.eqLink = { ...device.store.eqLink, [a]: b, [b]: a };
      }
    }
  }

  broadcastEqBandUpdate(channelIndex: number, bandIndex: number, updates: EqBandUpdates): void {
    const masterDevice = this.master;
    if (!masterDevice || this.slaveCount === 0) return;

    for (const device of this.devices) {
      if (device.role === 'slave' && device.connected) {
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
      if (device.role === 'slave' && device.connected) {
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
      if (device.role === 'slave' && device.connected) {
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

  // --- Connection State Persistence ---
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
          connected: d.connected
        })),
        servers: this.servers.map(s => ({
          id: s.id,
          url: s.url,
          productName: s.productName,
          serverGuid: s.serverGuid,
          connectedAt: s.connectedAt
        }))
      };
      localStorage.setItem("opendsp-device-manager-state", JSON.stringify(state));
    } catch (e) {
      console.error('Error saving device manager state:', e);
    }
  }

  restoreConnectionState(): void {
    try {
      const raw = localStorage.getItem("opendsp-device-manager-state");
      if (raw) {
        const state = JSON.parse(raw);

        // Restore devices
        this.devices = state.devices.map((d: any) => ({
          id: d.id,
          store: device, // Will be replaced when we reconnect
          role: d.role as DeviceRole,
          transportType: d.transportType,
          connectionInfo: d.connectionInfo,
          serverGuid: d.serverGuid,
          deviceGuid: d.deviceGuid,
          connected: d.connected
        }));

        // Restore servers
        this.servers = state.servers.map((s: any) => ({
          id: s.id,
          url: s.url,
          transportType: s.transportType as 'websocket',
          productName: s.productName,
          serverGuid: s.serverGuid,
          connectedAt: s.connectedAt
        }));

        console.log('Restored device manager state:', {
          devices: this.devices.length,
          servers: this.servers.length
        });
      }
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
}

export const deviceManager = new DeviceManagerState();
