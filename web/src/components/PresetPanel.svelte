<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import presetManager from "../state/preset-manager.ts";

  function clearPresets() {
    if (confirm('Delete all saved presets? This cannot be undone.')) {
      presetManager.clearAllPresets();
      alert('All presets cleared.');
    }
  }

  // Preset functions
  async function savePreset() {
    try {
      await device.savePresetToJson();
    } catch (e) {
      alert(`Failed to save preset: ${(e as Error).message}`);
    }
  }

  async function loadPresetInput(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          device.loadPresetFromJson(event.target?.result as string);
          alert('Preset loaded successfully!');
        } catch (err) {
          alert(`Failed to load preset: ${(err as Error).message}`);
        }
      };
      reader.readAsText(target.files[0]);
    }
  }
</script>

<div class="preset-panel">
  <div class="panel-content">
    <h3>Presets (JSON)</h3>
    <p class="hint">Save and load device configurations as JSON files.</p>

    <div class="preset-controls">
      <button onclick={savePreset}>
        Save Preset
      </button>
      <label class="primary-btn">
        📂 Load Preset
        <input type="file" accept=".json" style="display:none" onclick={(e) => loadPresetInput(e)} />
      </label>
      {#if presetManager.getPresets().length > 0}
        <button onclick={clearPresets} class="danger-btn">Clear Saved</button>
      {/if}
    </div>

    {#if presetManager.getPresets().length > 0}
      <h4>Saved Presets ({presetManager.getPresets().length})</h4>
      <ul class="saved-list">
        {#each presetManager.getPresets() as p, i}
          <li class="saved-item">
            <span>{p.name || 'Untitled'}</span>
            <time datetime={p.timestamp}>{new Date(p.timestamp).toLocaleString()}</time>
            <button onclick={() => presetManager.deletePreset(i)} class="delete-btn">×</button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">No presets saved yet. Connect to a server and save your configuration.</p>
    {/if}
  </div>
</div>

<style>
  .preset-panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-content { padding: 1rem; }

  .preset-panel h3 { margin-top: 0; color: var(--text); font-size: 1rem; }
  .hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }

  .preset-controls { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }

  button { padding: .4rem .8rem; border-radius: 6px; font-size: .85rem; cursor: pointer;
           transition: all .15s; }
  button:hover:not(:disabled) { transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }

  .primary-btn { background: var(--accent); color: #0a0d12; border: none; font-weight: 600; }
  .danger-btn { background: #dc2626; color: white; border: none; }
  .delete-btn { background: #ef4444; color: white; border: none; width: 28px; height: 28px;
                padding: 0; display: flex; align-items: center; justify-content: center; }

  .empty { color: var(--text-dim); font-style: italic; text-align: center; padding: 1.5rem; }
  h4 { margin: .75rem 0 .5rem; color: var(--text); font-size: .9rem; }

  /* Saved presets list */
  .saved-list { list-style: none; padding: 0; margin: .5rem 0; max-height: 150px; overflow-y: auto; border-top: 1px solid var(--line); }
  .saved-item { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
                background: rgba(255,255,255,.02); font-size: .8rem; }
  .saved-item span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .saved-item time { color: var(--text-dim); font-size: .75rem; }

  @media (max-width: 600px) {
    .preset-panel { border-radius: 0; border-left: none; border-right: none; }
    .preset-controls { flex-direction: column; }
    button { width: 100%; }
  }
</style>
