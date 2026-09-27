<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import Param from "./Param.svelte";
  let { index }: { index: number } = $props();
  const ch = $derived(device.ch(index));
  const commit = () => device.setDelayMs(index, ch.delayMs ?? 0);
</script>

<div class="band" style="margin-top: .6rem;">
  <button class="num" style="--c:var(--ch-6)" title="Delay" disabled={(ch.delayMs ?? 0) === 0}>DLY</button>
  <Param label="" bind:value={ch.delayMs} min={0} max={100} step={0.01} unit="ms" format={(v) => v.toFixed(2)} onchange={commit} dragSensitivity={3000} />
  <div class="readout muted mono">
    {((ch.delayMs ?? 0) * 48).toFixed(0)} samples
  </div>
</div>

<style>
  .band { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: .4rem;
          padding: .5rem .3rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-panel); }
  .num { width: 40px; height: 30px; padding: 0; border-radius: 6px; border: 2px solid var(--c);
         background: color-mix(in oklab, var(--c) 22%, transparent); color: var(--text); font-weight: 700; font-size: .75rem; cursor: default;
         display: flex; align-items: center; justify-content: center; }
  .readout { font-size: .8rem; margin-top: .4rem; }
</style>
