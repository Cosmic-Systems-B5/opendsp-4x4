<script lang="ts">
  import ConnectionPanel from "./ConnectionPanel.svelte";
  import DeviceTable from "./DeviceTable.svelte";
  import PresetPanel from "./PresetPads.svelte";
  import TonePanel from "./TonePanel.svelte";
  import LockPanel from "./LockPanel.svelte";
  import DefaultsPanel from "./DefaultsPanel.svelte";
</script>

<div class="system-view">
  <ConnectionPanel />
  <DeviceTable />
  <PresetPanel />
  <TonePanel />
  <LockPanel />
  <DefaultsPanel />
</div>

<style>
  .system-view { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; padding: 1rem; }
</style>
