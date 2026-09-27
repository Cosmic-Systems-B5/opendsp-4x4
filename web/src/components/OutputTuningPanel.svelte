<script lang="ts">
  // Single output tuning panel with all controls visible
  import { device } from "../state/device.svelte.ts";
  import ChannelHeader from "./ChannelHeader.svelte";
  import DelayPanel from "./DelayPanel.svelte";
  import EqPanel from "./EqPanel.svelte";
  import type { ChannelEq } from "../eq/types.ts";

  let { index, eq = $bindable() }: { index: number; eq: ChannelEq } = $props();
</script>

<section class="output-panel" style="--c:var(--ch-{index})">
  <ChannelHeader index={index} />
  <EqPanel index={index} bind:eq />
  <DelayPanel index={index} />
</section>

<style>
  .output-panel {
    border: 1px solid var(--c);
    border-radius: var(--radius);
    background: var(--bg-panel);
    overflow: hidden;
  }
</style>
