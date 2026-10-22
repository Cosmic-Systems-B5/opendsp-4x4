// App-lifetime bootstrap for the WebSocket bridge.
//
// Runs exactly once per page load:
//   1. Restores the persisted server list and reconnects every server whose
//      `wanted` flag is still true (serverManager.restoreConnections()).
//   2. For every server that transitions from disconnected → connected,
//      restores the persisted per-(url, guid) device bindings.
//
// This is deliberately module-level, not component-level. It must run
// regardless of which page is mounted, and reconnection on server drop must
// keep running whether the picker is visible or not.

import { serverManager } from "./server-manager.svelte.ts";
import { deviceManager } from "./device-manager.svelte.ts";
import { DeviceSvelte } from "./device.svelte.ts";

// URLs whose persisted device bindings have already been restored this boot.
const restoredThisSession = new Set<string>();
let started = false;

export function startBridge(): void {
    if (started) return;
    started = true;

    // 1. Reconnect servers that were connected at the end of the previous session.
    void serverManager.restoreConnections();

    // 2. Watch for newly-connected servers and restore their device bindings.
    //    A `$effect` in a `.svelte.ts` module re-runs when its reactive
    //    dependencies (serverManager.servers, which is $state) change.
    $effect(() => {
        for (const url of serverManager.urls) {
            const conn = serverManager.servers[url];

            if (!conn?.connected) {
                // Server dropped — clear the guard so the next reconnect re-restores.
                restoredThisSession.delete(url);
                continue;
            }
            if (restoredThisSession.has(url)) continue;
            restoredThisSession.add(url);
            void restoreBindingsFor(url);
        }
    });

    // 3. Also watch for *connections* (device drop) so a transient device
    //    disconnect can retry on the next server reconnect without a page
    //    refresh. Clearing the guard on device_gone is done implicitly: when
    //    the server reconnects, the URL re-enters the effect body above.
}

/**
 * Restore persisted device bindings for one connected server.
 *
 * The persisted record is keyed by (url, guid). A binding whose guid no
 * longer appears in the server's device list is dropped — the bridge is
 * authoritative.
 */
async function restoreBindingsFor(url: string): Promise<void> {
    const conn = serverManager.servers[url];
    if (!conn?.connected) return;

    const persisted = deviceManager.bindingsFor(url);
    if (persisted.length === 0) return;

    const liveGuids = new Set(conn.devices.map(d => d.guid));
    for (const pb of persisted) {
        if (!liveGuids.has(pb.guid)) {
            deviceManager.forgetBinding(url, pb.guid);
            continue;
        }
        if (deviceManager.connectedDevices.some(d =>
            d.connectionInfo.url === url && d.guid === pb.guid
        )) {
            continue;
        }
        try {
            await connectDevice(url, pb.guid);
        } catch (e) {
            console.warn(`[bridge] restore failed for ${url} ${pb.guid}:`, e);
            deviceManager.forgetBinding(url, pb.guid);
        }
    }
}

/**
 * Connect one DSP unit and bind it. Idempotent: returns the existing record
 * if the same (url, guid) is already bound.
 *
 * Note: each call creates a fresh shadow DeviceSvelte. The UI model (`device`)
 * is the canonical model; the shadow only talks to hardware and mirrors into
 * the model (first connect) or receives a push from the model (subsequent).
 */
export async function connectDevice(url: string, guid: string): Promise<void> {
    const conn = serverManager.servers[url];
    if (!conn?.connected) return;

    const info = conn.devices.find(d => d.guid === guid);
    if (!info) return;

    const t = serverManager.getTransport(url);
    if (!t) { console.error('[bridge] no transport for', url); return; }

    const existing = deviceManager.connectedDevices.find(d =>
        d.connectionInfo.url === url && d.guid === guid
    );
    if (existing) return;

    const shadow = new DeviceSvelte();
    await shadow.bind(t, {
        guid: info.guid,
        serverid: info.serverid,
        productName: info.product,
        kind: info.kind,
    });

    deviceManager.bindTransport(t, shadow, {
        url,
        guid: info.guid,
        serverid: info.serverid,
        productName: info.product,
        kind: info.kind,
    });
}

/**
 * Disconnect one DSP unit. Safe to call from any page. Idempotent.
 */
export async function disconnectDevice(url: string, guid: string): Promise<void> {
    const rec = deviceManager.connectedDevices.find(d =>
        d.connectionInfo.url === url && d.guid === guid
    );
    if (!rec) return;
    try { await rec.store.unbind(); } catch { /* ignore */ }
    deviceManager.disconnect(rec.id);
}

/**
 * Disconnect a server and every device bound to it. Safe to call from any page.
 */
export function disconnectServer(url: string): void {
    for (const d of deviceManager.connectedDevices) {
        if (d.connectionInfo.url === url) {
            deviceManager.disconnect(d.id);
        }
    }
    serverManager.disconnect(url);
}