import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock the @homebridge/ciao module
const mockAdvertise = {
  start: async () => {},
  stop: async () => {}
};

const mockBrowser = {
  on: () => {},
  start: () => {},
  stop: () => {}
};

vi.mock('@homebridge/ciao', () => {
  return {
    Advertisement: {
      createTcpService: (name, hostname, options) => {
        return mockAdvertise;
      }
    },
    MdnsBrowser: {
      create: () => mockBrowser
    }
  };
});

// Mock node-dns-sd
vi.mock('node-dns-sd', () => {
  return {};
});

import { startBonjourAdvertising, stopBonjourAdvertising, updateDiscoveredServer, getDiscoveredServers } from '../index.js';

test("startBonjourAdvertising does not throw", async () => {
  // Should not throw even if mDNS is not available
  await assert.doesNotReject(async () => {
    startBonjourAdvertising();
  });
});

test("stopBonjourAdvertising does not throw", async () => {
  // Should not throw even if advertising was never started
  await assert.doesNotReject(async () => {
    stopBonjourAdvertising();
  });
});

test("updateDiscoveredServer adds new server", () => {
  const initialCount = getDiscoveredServers().length;

  updateDiscoveredServer({
    name: 'Test Server',
    host: '192.168.1.100',
    port: 8765,
    type: 'opendsp-ws',
    protocol: 'tcp',
    lastSeen: Date.now()
  });

  const servers = getDiscoveredServers();
  assert.equal(servers.length, initialCount + 1);

  const server = servers.find(s => s.host === '192.168.1.100');
  assert.ok(server);
  assert.equal(server.port, 8765);
});

test("updateDiscoveredServer updates existing server", () => {
  const hostname = '192.168.1.100';
  const port = 8765;

  // Add initial server
  updateDiscoveredServer({
    name: 'Test Server v1',
    host: hostname,
    port: port,
    type: 'opendsp-ws',
    protocol: 'tcp',
    lastSeen: Date.now()
  });

  let servers = getDiscoveredServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'Test Server v1');

  // Update the same server
  setTimeout(() => {
    updateDiscoveredServer({
      name: 'Test Server v2',
      host: hostname,
      port: port,
      type: 'opendsp-ws',
      protocol: 'tcp',
      lastSeen: Date.now()
    });

    servers = getDiscoveredServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'Test Server v2');
  }, 10);
});

test("getDiscoveredServers returns array", () => {
  const servers = getDiscoveredServers();
  assert(Array.isArray(servers));
});

test("getDiscoveredServers cleans stale entries", async () => {
  // Add an old server (more than 30 seconds ago)
  updateDiscoveredServer({
    name: 'Old Server',
    host: '192.168.1.200',
    port: 8766,
    type: 'opendsp-ws',
    protocol: 'tcp',
    lastSeen: Date.now() - 35000 // 35 seconds ago
  });

  const servers = getDiscoveredServers();

  // Old server should be filtered out
  assert.ok(!servers.find(s => s.host === '192.168.1.200'));
});

test("updateDiscoveredServer handles duplicate entries", () => {
  const initialCount = getDiscoveredServers().length;

  updateDiscoveredServer({
    name: 'Duplicate Server',
    host: '10.0.0.1',
    port: 9000,
    type: 'opendsp-ws',
    protocol: 'tcp',
    lastSeen: Date.now()
  });

  const firstCount = getDiscoveredServers().length;

  // Add same server again
  updateDiscoveredServer({
    name: 'Duplicate Server Updated',
    host: '10.0.0.1',
    port: 9000,
    type: 'opendsp-ws',
    protocol: 'tcp',
    lastSeen: Date.now()
  });

  const secondCount = getDiscoveredServers().length;

  // Should still be only one entry
  assert.equal(secondCount, firstCount);
});
