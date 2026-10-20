import { mount } from "svelte";
import App from "./App.svelte";
import { device } from "./state/device.svelte.ts";
import "./theme.css";

const app = mount(App, { target: document.getElementById("app")! });
(globalThis as Record<string, unknown>).device = device; // debug probe handle

// Restore device state from localStorage
void device.restoreDeviceState();

export default app;
