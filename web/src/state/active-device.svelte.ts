// Reactive selector for "the DeviceSvelte that the UI should render".
//
// - When a remote server has been bound and one of its DSP units is master,
//   this returns that store (a live DeviceSvelte whose dsp is wired to the
//   bridge transport).
// - Otherwise it returns the module-level `device` singleton, so single-device
//   USB workflows keep working unchanged.
//
// Components should import `active` and read it via `$derived` or directly:
//   <input bind:value={active.channels[i].gainDb} oninput={...}>
//   function onInput(e) { active.setGainDb(i, +e.target.value); }

import { device } from "./device.svelte.ts";
import { deviceManager } from "./device-manager.svelte.ts";

/**
 * The store the UI should render and mutate. Reactive — a `$derived` in a
 * component will re-run when the master changes.
 */
export function activeDevice(): typeof device {
    const master = deviceManager.master;
    return master ?? device;
}

/**
 * Non-reactive getter for imperative call sites (event handlers). Reads the
 * current master at call time. Use this inside `function onX() { … }`
 * bodies; use `activeDevice()` inside `$derived`/template expressions.
 */
export function activeNow(): typeof device {
    return deviceManager.master ?? device;
}