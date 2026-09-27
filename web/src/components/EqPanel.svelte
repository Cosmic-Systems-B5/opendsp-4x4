<script lang="ts">
  // EQ panel that can show either PEQ controls or GEQ graph, with HPF/LPF always visible
  import { device } from "../state/device.svelte.ts";
  import BandList from "./BandList.svelte";
  import CrossoverBands from "./CrossoverBands.svelte";
  import EqGraph from "./EqGraph.svelte";
  import type { ChannelEq } from "../eq/types.ts";
  import DelayPanel from "./DelayPanel.svelte";

  let { index, eq = $bindable(), mode: externalMode }: { index: number; eq: ChannelEq; mode?: "peq" | "geq" } = $props();

  // Use externalMode prop directly as the source of truth for display mode
  let mode = $derived<"peq" | "geq">(externalMode ?? "peq");

  function onCommit(kind: "band" | "hpf" | "lpf", band?: number) {
    if (kind === "band" && band != null) device.commitPeqBand(index, band);
    else if (kind === "hpf") device.commitHpf(index);
    else device.commitLpf(index);
  }
</script>

<div class="eq-panel">
  <!-- PEQ mode: BandList + CrossoverBands side by side -->
  <div class="mode-content peq-mode" style:display={mode === "peq" ? "flex" : "none"}>
    <BandList index={index} />
    <div class="eq-panel">
      <CrossoverBands index={index} />
      <DelayPanel index={index} />
    </div>
  </div>

  <!-- GEQ mode: Full-width graph + HPF/LPF below -->
  <div class="mode-content geq-mode" style:display={mode === "geq" ? "flex" : "none"}>
    <EqGraph bind:eq onCommit={onCommit} showReadout={false} eqMode={mode} />
  </div>
</div>

<style>
  .eq-panel { position: relative; }

  .mode-content {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    padding: 0 1rem 1rem;
    width: 100%;
  }


  /* BandList takes available space, CrossoverBands has two items */
  .peq-mode > * { min-width: 0; }
  .peq-mode > :first-child { flex: 1; }

  /* GEQ mode - graph takes full width, HPF/LPF below */
  .geq-mode { flex-direction: column; gap: 1rem; align-items: stretch; }
  .geq-mode > :first-child { flex: 1; min-width: 0; }
</style>
