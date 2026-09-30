<script lang="ts">
  // Tuning view: shows Out 1-3 with gain, EQ, LPF, HPF, and Delay sections always visible
  import { device } from "../state/device.svelte.ts";
  import { OUT_BASE } from "../state/model.ts";
  import OutputTuning from "./OutputTuning.svelte";

  // Show outputs 1, 2, 3 (indices 4, 5, 6)
  const OUT_indices = [OUT_BASE + 0, OUT_BASE + 1, OUT_BASE + 2];
</script>

<div class="tuning-view">
  {#each OUT_indices as outIndex (outIndex)}
    <OutputTuning
      index={outIndex}
      eq={device.ch(outIndex).eq!}
      allEqs={OUT_indices.map(i => ({ ch: device.ch(i), color: `var(--ch-${i})` }))}
    />
  {/each}
</div>

<style>
  .tuning-view { display: flex; flex-direction: column; gap: 1.5rem; padding: 1rem; }
</style>
