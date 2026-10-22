// Reactive selector for "the DeviceSvelte that the UI should render".
//
// Returns the local device store. In the peer-to-peer architecture,
// all devices are equal peers, and each has its own local data model.
// Components can use this to get a consistent reference to the device
// they should be editing.
//
// - For USB-connected devices: returns the module-level `device` singleton.
// - For remote WebSocket connections: also returns `device` (the active
//   connection is tracked via deviceManager, but there's no master/slave).
//
// Components should import `active` and read it via `$derived` or directly:
//   <input bind:value={active.channels[i].gainDb} oninput={...}>
//   function onInput(e) { active.setGainDb(i, +e.target.value); }

import { device } from "./device.svelte.ts";

/**
 * The store the UI should render and mutate. Reactive — a `$derived` in a
 * component will re-run when device state changes.
 */
export function activeDevice(): typeof device {
    return device;
}

/**
 * Non-reactive getter for imperative call sites (event handlers). Returns
 * the current device reference at call time. Use this inside `function onX() { … }`
 * bodies; use `activeDevice()` inside `$derived`/template expressions.
 */
export function activeNow(): typeof device {
    return device;
}
