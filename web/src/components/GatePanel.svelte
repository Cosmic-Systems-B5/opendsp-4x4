<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import Param from "./Param.svelte";
  let { index }: { index: number } = $props();

  // Svelte 5 runes mode fix for bind:value with derived values
  // We use a local state that syncs with the device state
  function getGate() {
    return structuredClone(device.ch(index).gate) as NonNullable<typeof device.channels[0].gate>;
  }

  let gate = $state(getGate());

  // Keep local state in sync with device state changes
  $effect(() => {
    const newGate = getGate();
    if (newGate) {
      gate = newGate;
    }
  });

  function commit() {
    device.ch(index).gate = { ...gate };
    device.commitGate(index);
  }
</script>

<div class="panel">
  <Param label="Threshold" bind:value={gate.thresholdDb} min={-90} max={0} step={0.5} unit="dB" onchange={commit} />
  <Param label="Attack" bind:value={gate.attackMs} min={1} max={999} step={1} unit="ms" onchange={commit} />
  <Param label="Hold" bind:value={gate.holdMs} min={10} max={999} step={1} unit="ms" onchange={commit} />
  <Param label="Release" bind:value={gate.releaseMs} min={1} max={3000} step={10} unit="ms" onchange={commit} />
</div>

<style>
  .panel { display: flex; gap: .8rem; flex-wrap: wrap; padding: .8rem 0; }
</style>
