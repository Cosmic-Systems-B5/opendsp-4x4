<script lang="ts">
  import DevicePicker from "./DevicePicker.svelte";
  import PresetPanel from "./PresetPanel.svelte";
</script>

<div class="system-view">
  <DevicePicker />
<!--  <PresetPanel />-->
</div>

<style>
  .system-view { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; padding: 1rem; }
</style>
