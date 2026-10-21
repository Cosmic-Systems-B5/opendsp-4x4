<script lang="ts">
  // Single output tuning panel with all controls visible
  import { device } from "../state/device.ts";
  import ChannelHeader from "./ChannelHeader.svelte";
  import EqPanel from "./EqPanel.svelte";

  let {
    index, allEqs }: { index: number; allEqs?: { ch: any; color: string }[] } = $props();
  const ch = $derived(device.ch(index));

  // Get extra EQs (all except current channel)
  const extraEqs = $derived(
    allEqs?.filter(e => e.ch.index !== index).map(e => ({ eq: e.ch.eq!, color: e.color })) ?? []
  );
</script>

<section class="output-panel" style="--c:var(--ch-{index})">
  <ChannelHeader index={index} />
  <EqPanel index={index} mode={ch.eqMode ?? "peq"} extraEqs={extraEqs} />
</section>

<style>
  .output-panel {
    border: 1px solid var(--c);
    border-radius: var(--radius);
    background: var(--bg-panel);
    overflow: hidden;
  }
</style>
