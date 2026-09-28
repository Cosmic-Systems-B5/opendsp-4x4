<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";
  import DevicePicker from "./DevicePicker.svelte";

  let showPicker = $state(false);
</script>

<div class="connection-panel">
  <div class="panel-header">
    <span class="title">Connection</span>
    <button class="picker-btn" onclick={() => (showPicker = !showPicker)}>
      {#if deviceManager.devices.length > 0}Manage Connections{:else}Connect Device{/if}
    </button>
  </div>

  <div class="content">
    {#if showPicker}
      <DevicePicker onclose={() => (showPicker = false)} />
    {:else}
      <p class="status-summary">
        {#if deviceManager.devices.length === 0}
          No devices connected. Click "Connect Device" to add one.
        {:else if deviceManager.master}
          Master: <strong>{deviceManager.master.productName}</strong> ({deviceManager.slaveCount} slave{#if deviceManager.slaveCount > 1}s{/if})
        {/if}
      </p>
    {/if}
  </div>
</div>

<style>
  .connection-panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-header { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .5rem 1rem; background: var(--bg-elev); border-bottom: 1px solid var(--line); }
  .title { font-weight: 600; color: var(--text); }
  .picker-btn { padding: .35rem .7rem; border-radius: 6px; background: var(--accent); color: #0a0d12;
                font-size: .8rem; cursor: pointer; transition: all .15s; border: none; font-weight: 600; }
  .picker-btn:hover { box-shadow: var(--glow); }
  .content { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }

  .status-summary { color: var(--text-dim); font-size: .85rem; }
  .status-summary strong { color: var(--text); }
</style>
