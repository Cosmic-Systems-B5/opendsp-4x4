<script lang="ts">
  import { device } from "../state/device.svelte.ts";
</script>

<div class="panel">
  <div class="body">
    <span class="title">Defaults <span class="muted">(this browser)</span></span>
    <span class="spacer"></span>
  </div>
  <div class="content">
    <div class="defaults-row">
      <button onclick={() => device.saveDefaults()} disabled={!device.connected}>Save current</button>
      <button class="primary" onclick={() => device.restoreDefaults()} disabled={!device.connected || !device.hasDefaults}>Restore</button>
    </div>
    <span class="muted">{device.hasDefaults ? "snapshot saved — Restore re-sends it to the DSP" : "no snapshot yet — Save the current setup first"}</span>
  </div>
</div>

<style>
  .panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .body { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .5rem 1rem; background: var(--bg-elev); border-bottom: 1px solid var(--line); }
  .title { font-weight: 600; color: var(--text); }
  .spacer { flex: 1; }
  .content { padding: 1rem; display: flex; flex-direction: column; gap: .45rem; min-width: 200px; }
  .defaults-row { display: flex; gap: .4rem; }
</style>
