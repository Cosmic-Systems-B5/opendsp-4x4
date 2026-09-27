<script lang="ts">
  // EQ panel that can show either PEQ controls or GEQ graph, with HPF/LPF always visible
  import { device } from "../state/device.svelte.ts";
  import BandList from "./BandList.svelte";
  import CrossoverBands from "./CrossoverBands.svelte";
  import EqGraph from "./EqGraph.svelte";
  import type { ChannelEq } from "../eq/types.ts";
  import DelayPanel from "./DelayPanel.svelte";

  let { index, eq = $bindable() }: { index: number; eq: ChannelEq } = $props();

  // PEQ mode shows band controls, GEQ mode shows visual graph
  let mode = $state<"peq" | "geq">("peq");

  function onCommit(kind: "band" | "hpf" | "lpf", band?: number) {
    if (kind === "band" && band != null) device.commitPeqBand(index, band);
    else if (kind === "hpf") device.commitHpf(index);
    else device.commitLpf(index);
  }

  function toggleMode() {
    mode = mode === "peq" ? "geq" : "peq";
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
    <EqGraph bind:eq onCommit={onCommit} showReadout={false} />
  </div>

  <!-- Toggle button between PEQ and GEQ -->
  <div class="mode-toggle">
    <button
      class="toggle-btn"
      class:active={mode === "peq"}
      onclick={toggleMode}
      title="PEQ mode - show band controls"
    >
      PEQ
    </button>
    <button
      class="toggle-btn"
      class:active={mode === "geq"}
      onclick={toggleMode}
      title="GEQ mode - show visual EQ graph"
    >
      GEQ
    </button>
  </div>
</div>

<style>
  .eq-panel { position: relative; }

  /* Both modes share same space - one visible at a time */
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

  /* Toggle controls at bottom */
  .mode-toggle {
    display: flex;
    justify-content: center;
    gap: .25rem;
    background: var(--bg-elev);
    padding: .25rem;
    border-radius: var(--radius);
    margin-top: -1rem; /* Pull toggle up into padding area */
  }
  .toggle-btn {
    padding: .35rem .7rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    font-size: .8rem;
    cursor: pointer;
    transition: all .15s;
    font-weight: 500;
  }
  .toggle-btn:hover { color: var(--text); background: rgba(255,255,255,.05); }
  .toggle-btn.active {
    background: var(--accent);
    color: #0a0d12;
    box-shadow: var(--glow);
  }
</style>
