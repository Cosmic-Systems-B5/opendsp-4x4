<script lang="ts">
  import { activeDevice } from "../state/active-device.svelte.ts";
  const device = $derived(activeDevice());
  import Param from "./Param.svelte";
  import { Ratio } from "../protocol/commands.ts";
  let { index }: { index: number } = $props();

  // Svelte 5 runes mode fix for bind:value with derived values
  function getComp() {
    return $state.snapshot(device.ch(index).comp);
  }

  let comp = $state(getComp());

  // Keep local state in sync with device state changes
  $effect(() => {
    const newComp = getComp();
    if (newComp) {
      comp = newComp;
    }
  });

  function commit() {
    device.ch(index).comp = { ...comp };
    device.commitComp(index);
  }
</script>

<div class="panel">
  <Param label="Threshold" bind:value={comp.thresholdDb} min={-90} max={20} step={0.5} unit="dB" onchange={commit} />
  <div class="param">
    <span class="lbl">Ratio</span>
    <select class="sel" value={comp.ratioIndex} onchange={(e) => { comp.ratioIndex = +(e.currentTarget as HTMLSelectElement).value; commit(); }}>
      {#each Ratio as r, i (i)}<option value={i}>{r}</option>{/each}
    </select>
  </div>
  <Param label="Knee" bind:value={comp.kneeDb} min={0} max={12} step={1} unit="dB" onchange={commit} />
  <Param label="Attack" bind:value={comp.attackMs} min={1} max={999} step={1} unit="ms" onchange={commit} />
  <Param label="Release" bind:value={comp.releaseMs} min={10} max={3000} step={10} unit="ms" onchange={commit} />
</div>

<style>
  .panel { display: flex; gap: .8rem; flex-wrap: wrap; padding: .8rem 0; user-select: none; }
  .param { display: flex; flex-direction: column; gap: .25rem; width: 100px; user-select: none; }
  .lbl { font-size: .7rem; color: var(--text-dim); text-align: center; user-select: none; }
  .sel { height: 64px; background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); border-radius: 8px; font: inherit; text-align: center; user-select: none; }
</style>
