<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import presetManager from "../state/preset-manager.ts";

  // Preset name input for saving
  let presetNameInput = $state("");
  let showNameInput = $state(false);

  // Use advanced name generator when opening save dialog
  function openSaveDialog() {
    showNameInput = true;
    if (!presetNameInput) {
      presetNameInput = presetManager.advancedNameGenerator();
    }
  }

  // Reactive list of presets that updates when presets change
  let presets = $state(presetManager.getPresets());

  // Subscribe to preset changes to keep the list updated
  $effect(() => {
    const unsubscribe = presetManager.subscribe(() => {
      presets = presetManager.getPresets();
    });

    return () => unsubscribe();
  });

  // Get index of currently loaded preset (matches device.currentPresetId)
  function getCurrentPresetIndex(): number {
    if (!device.currentPresetId) return -1;
    return presets.findIndex(p => p.id === device.currentPresetId);
  }

  async function clearPresets() {
    const confirmed = await showFlash('Delete all saved presets? This cannot be undone.', 'info', true);
    if (confirmed) {
      presetManager.clearAllPresets();
      showFlash('All presets cleared', 'success');
    }
  }

  // Save current device state to a named preset in localStorage
  async function savePresetToStorage() {
    const name = presetNameInput.trim() || "Untitled preset";
    try {
      device.saveCurrentPresetToStorage(name);
      presetNameInput = "";
      showNameInput = false;
      showFlash(`Preset "${name}" saved to localStorage`, 'success');
    } catch (e) {
      showFlash(`Failed to save preset: ${(e as Error).message}`, 'error');
    }
  }

  // Load a saved preset from localStorage and apply to device
  async function loadSavedPreset(index: number) {
    try {
      await device.loadSavedPresetFromStorage(index);
      const preset = presets[index];
      showFlash(`Preset "${preset?.name || 'Untitled'}" loaded successfully`, 'success');
    } catch (err) {
      showFlash(`Failed to load preset: ${(err as Error).message}`, 'error');
    }
  }

  // Download a specific preset as JSON file
  function downloadSavedPreset(index: number) {
    try {
      const preset = presets[index];
      if (preset) {
        presetManager.downloadPreset(index);
        showFlash(`Downloaded preset "${preset.name}"`, 'success');
      }
    } catch (err) {
      showFlash(`Failed to download preset: ${(err as Error).message}`, 'error');
    }
  }

  // Delete a specific preset
  function deleteSavedPreset(index: number) {
    const preset = presets[index];
    if (preset) {
      presetManager.deletePreset(index);
      showFlash(`Deleted preset "${preset.name}"`, 'success');
    }
  }

  // Upload JSON file to localStorage (without auto-applying)
  async function uploadPreset(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          device.loadPresetFromJson(event.target?.result as string, false);
          showFlash('Preset uploaded to localStorage successfully', 'success');
        } catch (err) {
          showFlash(`Failed to load preset: ${(err as Error).message}`, 'error');
        }
      };
      reader.readAsText(target.files[0]);
    }
  }

  // Download all presets
  function downloadAllPresets() {
    try {
      presetManager.downloadAllPresets();
      showFlash('Downloaded all presets', 'success');
    } catch (err) {
      showFlash(`Failed to download presets: ${(err as Error).message}`, 'error');
    }
  }

  // Flash message helper - dispatch custom event
  function showFlash(text: string, type: 'success' | 'error' | 'info', confirm = false): Promise<boolean> {
    return new Promise((resolve) => {
      const event = new CustomEvent('flash', {
        detail: { text, type, confirm, onConfirm: resolve }
      });
      window.dispatchEvent(event);
    });
  }

  // Update the current preset with the latest device state
  function updateCurrentPreset(index: number) {
    const preset = presets[index];
    if (preset) {
      showFlash(`Updating preset "${preset.name}" with current device state...`, 'info');
      try {
        device.updateExistingPresetToStorage(preset.name, preset.id);
        showFlash(`Preset "${preset.name}" updated successfully`, 'success');
      } catch (err) {
        showFlash(`Failed to update preset: ${(err as Error).message}`, 'error');
      }
    }
  }
</script>

<div class="preset-panel">
  <div class="panel-content">
    <h3>Presets (JSON)</h3>
    <!-- Save to localStorage controls -->
    <div class="preset-controls">
      {#if !showNameInput}
        <button onclick={openSaveDialog}>+ Save Preset</button>
      {:else}
        <div class="name-input-row">
          <input type="text" bind:value={presetNameInput} placeholder="Preset name..." />
          <button onclick={savePresetToStorage} class="primary-btn">Save</button>
          <button onclick={() => showNameInput = false}>Cancel</button>
        </div>
      {/if}
    </div>

    <h4>Saved Presets ({presets.length})</h4>
    <ul class="saved-list">
      {#each presets as p, i}
        <li class="saved-item" class:current={i === getCurrentPresetIndex()}>
          <span>{p.name || 'Untitled'}</span>
          <time datetime={p.timestamp}>{new Date(p.timestamp).toLocaleString()}</time>
          <div class="button-group">
            {#if i === getCurrentPresetIndex()}
              <button onclick={() => updateCurrentPreset(i)} title="Update preset with current device state">Update</button>
            {:else}
              <button onclick={() => loadSavedPreset(i)} title="Load preset to device">Load</button>
            {/if}
            <button onclick={() => downloadSavedPreset(i)} title="Download as JSON">Download</button>
            <button onclick={() => deleteSavedPreset(i)} class="delete-btn" title="Delete preset">×</button>
          </div>
        </li>
      {/each}
    </ul>
  <div class="preset-controls">
    <label class="primary-btn file-upload-label">
      + Upload Preset(s)
      <input type="file" accept=".json" style="display:none" onchange={(e) => uploadPreset(e)} />
    </label>

    {#if presets.length > 0}
      <button onclick={downloadAllPresets}>Download All</button>
      <button onclick={clearPresets} class="danger-btn">Clear Saved</button>
    {/if}
  </div>

  </div>
</div>

<style>
  .saved-item.current {
    background: rgba(0, 128, 0, 0.05);
    border-left: 3px solid var(--good);
  }
  .saved-item.current span {
    font-weight: 600;
    color: var(--text);
  }

  .preset-panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-content { padding: 1rem; }

  .preset-panel h3 { margin-top: 0; color: var(--text); font-size: 1rem; }

  .preset-controls { display: flex; gap: .5rem; margin-bottom: 0.75rem; flex-wrap: wrap; align-items: center; }
  .name-input-row { display: flex; gap: .5rem; flex-wrap: wrap; width: 100%; }

  button { padding: .4rem .8rem; border-radius: 6px; font-size: .85rem; cursor: pointer;
           transition: all .15s; }
  button:hover:not(:disabled) { transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }

  input[type="text"] { padding: .4rem .6rem; border-radius: 6px; border: 1px solid var(--line);
                      background: var(--bg-panel); color: var(--text); font-size: .85rem; }
  input[type="text"]:focus { outline: none; border-color: var(--accent); }

  .primary-btn { background: var(--accent); color: #0a0d12; border: none; font-weight: 600; }
  .danger-btn { background: #dc2626; color: white; border: none; }

  /* File upload button styling */
  .file-upload-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    transition: all 0.15s;
  }
  .file-upload-label:hover { transform: translateY(-1px); }

  .delete-btn { background: #ef4444; color: white; border: none; width: 28px; height: 28px;
                padding: 0; display: flex; align-items: center; justify-content: center; }

  .delete-btn:hover { background: #dc2626; }

  .button-group { display: flex; gap: .25rem; }
  .button-group button { padding: .25rem .5rem; font-size: .75rem; min-width: 50px; }

  h4 { margin: .75rem 0 .5rem; color: var(--text); font-size: .9rem; }

  /* Saved presets list */
  .saved-list { list-style: none; padding: 0; margin: .5rem 0; max-height: 200px; overflow-y: auto; border-top: 1px solid var(--line); }
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
