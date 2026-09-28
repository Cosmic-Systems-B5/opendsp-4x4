<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import Meter from "./Meter.svelte";
  let { index }: { index: number; } = $props();
  const ch = $derived(device.ch(index));
</script>

<div class="header" style="--c:var(--ch-{index})">
  <span class="gain_label">Gain</span>
  <div class="fader">
    <input type="range" min="-60" max="12" step="0.5" value={ch.gainDb} oninput={(e) => device.setGainDb(index, +(e.currentTarget).value)} />
    <span class="db mono">{ch.gainDb >= 0 ? "+" : ""}{ch.gainDb.toFixed(1)} dB</span>
  </div>
  <button class="tgl" class:on={ch.mute} onclick={() => device.setMute(index, !ch.mute)}>Mute</button>
  <button class="tgl" class:on={ch.polarity} onclick={() => device.setPolarity(index, !ch.polarity)}>Ø</button>
  <button class="mode-toggle tgl" class:peq={ch.eqMode === "peq"} class:geq={ch.eqMode === "geq"} onclick={() => device.toggleEqMode(index)}>{ch.eqMode?.toUpperCase()}</button>
  <div class="meter"><Meter level={ch.meter} horizontal /></div>
</div>

<style>
  .header { display: flex; align-items: center; gap: .5rem; padding: .55rem .7rem; background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--radius); }
  .gain_label { font-size: .72rem; color: var(--text-dim); flex-shrink: 0; }
  .fader { flex: 1 1 auto; min-width: 60px; max-width: 240px; display: flex; align-items: center; gap: .5rem; }
  .fader input { flex: 1; min-width: 0; accent-color: var(--c); }
  .db { width: 9ch; flex-shrink: 0; text-align: left; font-size: .8rem; }
  .tgl { flex-shrink: 0; }
  .tgl.on { background: var(--warn); color: #1a1205; border-color: var(--warn); }
  .mode-toggle { flex-shrink: 0; padding: .7rem .5rem; border-radius: 9px; font-size: .6rem; font-family: ui-monospace, monospace; }
  .mode-toggle.peq { border-color: #4ade80; } /* green for PEQ */
  .mode-toggle.geq { border-color: var(--accent); } /* blue/cyan for GEQ */
  .meter { flex: 1; text-align: right; }
</style>
