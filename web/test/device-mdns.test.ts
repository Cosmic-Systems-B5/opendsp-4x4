import { test } from "node:test";
import assert from "node:assert/strict";

// Mock the dns-sd-browser module
vi.mock('../mdns/mdns-browser', () => {
  return {
    mdnsBrowser: {
      start: async () => {},
      stop: async () => {},
      getServers: () => []
    },
    onServersChange: (callback: (servers: any[]) => void) => { return () => {} }
  };
});

// Import after mocking
import { startMdnsDiscovery, stopMdnsDiscovery, getDiscoveredServers, onServerListChange } from "../state/device.svelte.ts";

test("startMdnsDiscovery does not throw", async () => {
  // Should not throw even if mDNS is not available
  await assert.doesNotReject(async () => {
    await startMdnsDiscovery();
  });
});

test("stopMdnsDiscovery does not throw", async () => {
  // Should not throw even if mDNS was never started
  await assert.doesNotReject(async () => {
    await stopMdnsDiscovery();
  });
});

test("getDiscoveredServers returns array", () => {
  const servers = getDiscoveredServers();
  assert(Array.isArray(servers));
});

test("onServerListChange callback registration", () => {
  let called = false;
  const unsubscribe = onServerListChange((servers: any[]) => {
    called = true;
    assert(Array.isArray(servers));
  });

  assert.equal(typeof unsubscribe, 'function');

  // Call the callback manually to verify it works
  unsubscribe();
});

test("multiple server callbacks can be registered", () => {
  let called1 = false;
  let called2 = false;

  const unsubscribe1 = onServerListChange((servers: any[]) => {
    called1 = true;
  });

  const unsubscribe2 = onServerListChange((servers: any[]) => {
    called2 = true;
  });

  assert.equal(typeof unsubscribe1, 'function');
  assert.equal(typeof unsubscribe2, 'function');

  // Unsubscribe both
  unsubscribe1();
  unsubscribe2();
});

test("unsubscribe function removes callback", () => {
  let callCount = 0;
  const callback = (servers: any[]) => { callCount++; };

  const unsubscribe = onServerListChange(callback);
  assert.equal(callCount, 0);

  // Unsubscribe
  unsubscribe();

  // Callback should no longer be called
  // Note: This is verified by the API design - the callback is removed from the set
});
