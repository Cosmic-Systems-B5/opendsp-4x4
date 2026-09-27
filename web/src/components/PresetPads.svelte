<script lang="ts">
  // Gig-facing preset launcher: a row of coloured pads. Tap = recall
  // (the fast scene-change action). Store is a deliberate two-step (arm, then tap)
  // so a slot can't be overwritten by accident mid-show.
  import { device } from "../state/device.svelte.ts";
  const COUNT = 7; // the device exposes 7 preset slots (matches the official app)
  let storeMode = $state(false);

  function fire(slot: number): void {
    if (storeMode) { device.storePreset(slot); storeMode = false; }
    else device.recallPreset(slot);
  }
</script>

<section class="presets">
  <div class="body">
    <span class="title">Presets</span>
    {#if device.presetName}<span class="cur">{device.presetName}</span>{/if}
    <span class="spacer"></span>
    <button class="store" class:on={storeMode} disabled={!device.connected} onclick={() => (storeMode = !storeMode)}>
      {storeMode ? "Tap a pad to STORE… (tap here to cancel)" : "Store…"}
    </button>
  </div>
  <div class="pads">
    {#each Array.from({ length: COUNT }) as _, i (i)}
      <button
        class="pad"
        class:active={device.activePreset === i}
        class:arm={storeMode}
        style="--h: {(i * 47) % 360}"
        disabled={!device.connected}
        onclick={() => fire(i)}
      >{i + 1}</button>
    {/each}
  </div>
</section>

<style>
  .presets { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .body { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .5rem 1rem; background: var(--bg-elev); border-bottom: 1px solid var(--line); }
  .title { font-weight: 600; color: var(--text); }
  .cur { font-size: .8rem; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 18ch; }
  .spacer { flex: 1; }
  .store { padding: .35rem .7rem; border-radius: 6px; background: var(--bg-elev); color: var(--text);
           font-size: .82rem; cursor: pointer; transition: all .15s; white-space: nowrap; border: 1px solid var(--line); }
  .store:hover:not(:disabled) { border-color: var(--accent); }
  .store.on { background: var(--bad); color: #fff; border-color: var(--bad); }
  .pads { display: flex; flex-wrap: wrap; gap: .4rem; justify-content: center; padding: .5rem 1rem; }
  .pad { min-width: 46px; height: 46px; flex: 0 0 auto; border-radius: 8px; font-weight: 600; color: #fff;
    border: 1px solid hsl(var(--h) 50% 48%); background: hsl(var(--h) 45% 24%); }
  .pad.active { background: hsl(var(--h) 70% 46%); box-shadow: 0 0 0 2px hsl(var(--h) 85% 64%), 0 0 12px hsl(var(--h) 80% 50% / .55); }
  .pad.arm { border-color: var(--bad); }
  .pad:disabled { opacity: .4; }
</style>
