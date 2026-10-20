<script lang="ts">
  // EQ panel that can show either PEQ controls or GEQ graph, with HPF/LPF always visible
  import { device } from "../state/device.svelte.ts";
  import EqBandList from "./EqBandList.svelte";
  import EqGraph from "./EqGraph.svelte";
  import type { ChannelEq } from "../eq/types.ts";

  let { index, mode: externalMode, extraEqs: extraEqs }: { index: number; mode?: "peq" | "geq"; extraEqs?: { eq: ChannelEq; color: string }[] } = $props();

  // Use the EQ data directly from device for both PEQ and GEQ modes
  const eq = $derived(device.ch(index).eq);

  // Use externalMode prop directly as the source of truth for display mode
  let mode = $derived<"peq" | "geq">(externalMode ?? "peq");

</script>

<div class="eq-panel">
  <!-- PEQ mode -->
  <div class="mode-content peq-mode" style:display={mode === "peq" ? "flex" : "none"}>
    <EqBandList index={index} />

  </div>

  <!-- GEQ mode -->
  <div class="mode-content geq-mode" style:display={mode === "geq" ? "flex" : "none"}>
    <EqGraph index={index} extraEqs={extraEqs} />
  </div>
</div>

<style>
  .eq-panel { position: relative; user-select: none; }

  .mode-content {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
    padding: 0 1rem 1rem;
    width: 100%;
  }

  /* GEQ mode - graph takes full width, HPF/LPF below */
  .geq-mode { flex-direction: column; gap: 1rem; align-items: stretch; }
</style>
