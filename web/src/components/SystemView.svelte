<script lang="ts">
  import PresetPads from "./PresetPads.svelte";
  import SystemPanel from "./SystemPanel.svelte";
  import TonePanel from "./TonePanel.svelte";
  import LockPanel from "./LockPanel.svelte";
  import DefaultsPanel from "./DefaultsPanel.svelte";
</script>

<div class="system-view">
  <SystemPanel />
  <PresetPads />
  <TonePanel />
  <LockPanel />
  <DefaultsPanel />
</div>

<style>
  .system-view { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; padding: 1rem; }
</style>
