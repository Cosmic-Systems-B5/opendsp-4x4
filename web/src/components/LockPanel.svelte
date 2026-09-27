<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  let pw = $state("");
  let done = $state(false);
  function set() { device.setPassword(pw); done = true; setTimeout(() => (done = false), 1500); }
</script>

<div class="panel">
  <div class="body">
    <span class="title">Lock Password</span>
    <span class="spacer"></span>
  </div>
  <div class="content">
    <div class="lock-row">
      <input class="mono" maxlength="4" placeholder="1234" bind:value={pw} />
      <button disabled={!device.connected || pw.length !== 4} onclick={set}>Set</button>
      {#if done}<span class="ok">✓ set</span>{/if}
    </div>
  </div>
</div>

<style>
  .panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .body { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .5rem 1rem; background: var(--bg-elev); border-bottom: 1px solid var(--line); }
  .title { font-weight: 600; color: var(--text); }
  .spacer { flex: 1; }
  .content { padding: 1rem; }
  .lock-row { display: flex; align-items: center; gap: .4rem; font-size: .85rem; }
  input { width: 5ch; background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: .3rem; text-align: center; letter-spacing: .2em; }
  .ok { color: var(--good); }
</style>
