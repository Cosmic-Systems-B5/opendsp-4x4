import { test } from "node:test";
import assert from "node:assert/strict";

// Mock the device.svelte.ts to avoid circular dependencies
vi.mock('../state/device.svelte.ts', () => {
  return {
    defaultDevice: {
      channels: [],
      routing: [],
      eqLink: {}
    }
  };
});

import { DeviceManagerState } from "../state/device-manager.ts";
import type { Channel } from "../state/model.ts";

test("DeviceManagerState creates master for first device", () => {
  const manager = new DeviceManagerState();

  // Mock device store
  const mockStore = {
    channels: [],
    routing: [1, 2, 4, 8],
    eqLink: {}
  };

  manager.connect(mockStore as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (remote)'
  });

  assert.equal(manager.devices.length, 1);
});

test("DeviceManagerState creates slave for second device", () => {
  const manager = new DeviceManagerState();

  // Mock device stores
  const mockStore1 = { channels: [], routing: [1, 2, 4, 8], eqLink: {} };
  const mockStore2 = { channels: [], routing: [1, 2, 4, 8], eqLink: {} };

  manager.connect(mockStore1 as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (remote) 1'
  });

  manager.connect(mockStore2 as any, 'websocket', {
    url: 'ws://localhost:8766',
    productName: 'DSP 4x4 (remote) 2'
  });

  assert.equal(manager.devices.length, 2);
  assert.equal(manager.slaveCount, 1);

  // Second device should be a slave
  const slave = manager.devices.find(d => d.role === 'slave');
  assert.ok(slave);
});

test("DeviceManagerState broadcastChannelUpdate updates slaves", () => {
  const manager = new DeviceManagerState();

  const masterStore = {
    channels: [
      { gainDb: -10, mute: false, polarity: false },
      { gainDb: 0, mute: true, polarity: false }
    ] as Channel[],
    routing: [1, 2, 4, 8],
    eqLink: {}
  };

  const slaveStore = {
    channels: [
      { gainDb: -99, mute: false, polarity: false },
      { gainDb: -99, mute: false, polarity: false }
    ] as Channel[],
    routing: [1, 2, 4, 8],
    eqLink: {}
  };

  manager.connect(masterStore as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (master)'
  });

  manager.connect(slaveStore as any, 'websocket', {
    url: 'ws://localhost:8766',
    productName: 'DSP 4x4 (slave)'
  });

  // Broadcast update to channel 0
  manager.broadcastChannelUpdate(0, { gainDb: -5, mute: false });

  assert.equal(masterStore.channels[0].gainDb, -10); // Master unchanged
  assert.equal(slaveStore.channels[0].gainDb, -5); // Slave updated
});

test("DeviceManagerState broadcastRoutingUpdate updates slaves", () => {
  const manager = new DeviceManagerState();

  const masterStore = {
    channels: [] as Channel[],
    routing: [1, 2, 4, 8],
    eqLink: {}
  };

  const slaveStore = {
    channels: [] as Channel[],
    routing: [0, 0, 0, 0], // Different initial routing
    eqLink: {}
  };

  manager.connect(masterStore as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (master)'
  });

  manager.connect(slaveStore as any, 'websocket', {
    url: 'ws://localhost:8766',
    productName: 'DSP 4x4 (slave)'
  });

  // Broadcast routing update
  manager.broadcastRoutingUpdate(0x04, 0x0f);

  assert.equal(masterStore.routing[0], 1); // Master unchanged
  assert.equal(slaveStore.routing[0], 0x0f); // Slave updated
});

test("DeviceManagerState prevents duplicate connections", () => {
  const manager = new DeviceManagerState();

  const mockStore = { channels: [], routing: [1, 2, 4, 8], eqLink: {} };

  manager.connect(mockStore as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (remote)'
  });

  const initialLength = manager.devices.length;

  // Try to connect same URL again
  manager.connect(mockStore as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (remote) duplicate'
  });

  assert.equal(manager.devices.length, initialLength);
});

test("DeviceManagerState disconnectAll clears all devices", () => {
  const manager = new DeviceManagerState();

  const mockStore1 = { channels: [], routing: [1, 2, 4, 8], eqLink: {} };
  const mockStore2 = { channels: [], routing: [1, 2, 4, 8], eqLink: {} };

  manager.connect(mockStore1 as any, 'websocket', {
    url: 'ws://localhost:8765',
    productName: 'DSP 4x4 (remote) 1'
  });

  manager.connect(mockStore2 as any, 'websocket', {
    url: 'ws://localhost:8766',
    productName: 'DSP 4x4 (remote) 2'
  });

  assert.equal(manager.devices.length, 2);

  manager.disconnectAll();

  assert.equal(manager.devices.length, 0);
});
