<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";
  import presetManager from "../state/preset-manager.ts";

  let remoteUrl = $state<string>("ws://localhost:8765");
  let remoteDevices = $state<Array<{path: string; vendorId: string; productId: string; product: string}>>([]);
  let loadingRemote = $state(false);
  let connecting = $state(false);

  // Load saved URL
  const savedUrl = typeof localStorage !== "undefined" ? localStorage.getItem("opendsp-remote-url") : null;
  if (savedUrl) remoteUrl = savedUrl;

  async function loadRemoteDevices() {
    loadingRemote = true;
    try {
      const ws = new WebSocket(remoteUrl.trim());

      ws.onopen = () => {
        // Request devices list
        ws.send(JSON.stringify({ type: 'request', data: btoa(JSON.stringify({ action: 'list_devices' })) }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'report') {
            const data = JSON.parse(atob(msg.data));
            if (data.devices !== undefined) {
              remoteDevices = data.devices || [];
            }
            // Show error message for no devices
            if (data.error === 'no_device' && !data.devices?.length) {
              console.log('Remote DSP: No devices connected to server');
            }
          }
        } catch (e) {
          console.error('Failed to parse remote devices response:', e);
        }
      };

      ws.onclose = () => {
        loadingRemote = false;
      };

      ws.onerror = () => {
        loadingRemote = false;
        console.error('WebSocket error loading remote devices');
      };
    } catch (e) {
      loadingRemote = false;
      console.error('Failed to load remote devices:', e);
    }
  }

  async function connectDevice(url: string) {
    // Don't allow re-connecting if already connected to the same URL
    if (device.connected && deviceManager.devices.find(d => d.role === 'master')?.connectionInfo.url === url) return;

    connecting = true;
    try {
      await device.connect(url);
      const info = {
        url: url,
        productName: "DSP 4x4 (remote)"
      };
      deviceManager.connect(device, 'websocket', info);
    } catch (e) {
      console.error('Connection failed:', e);
      device.error = (e as Error).message;
    } finally {
      connecting = false;
    }
  }

  function handleDisconnect() {
    device.connected = false;
    deviceManager.disconnectAll();
  }

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


  // Server URL management
  let newServerUrl = $state("");
  let showUrlInput = $state(false);

  function addServerUrl() {
    if (newServerUrl.trim()) {
      device.addServerUrl(newServerUrl.trim());
      newServerUrl = "";
      showUrlInput = false;
    }
  }

  const serverUrls = deviceManager.devices.length > 0
    ? deviceManager.devices.map(d => d.connectionInfo.url || '').filter(Boolean)
    : ["ws://localhost:8765", "ws://localhost:8766"];
</script>

<div class="device-picker">
  <div class="connection-section">
    <h3>Remote DSP Connections</h3>
    <p class="hint">Enter WebSocket server URL to connect. Multiple servers can be configured.</p>

    <div class="url-inputs">
      {#each serverUrls as url, i}
        <div class="url-row">
          <input type="text" value={url} readonly class="url-display" />
          <button onclick={() => {
            // Remove URL and try to reconnect
            device.removeServerUrl(i);
            if (device.connected && deviceManager.devices[0]?.connectionInfo.url === url) {
              handleDisconnect();
            }
          }} class="remove-btn">Remove</button>
        </div>
      {/each}
    </div>

    <div class="add-url-row" style:display={showUrlInput ? 'flex' : 'none'}>
      <input type="text" bind:value={newServerUrl} placeholder="ws://server:port" class="url-input" />
      <button onclick={addServerUrl} class="primary-btn">Add</button>
    </div>

    <div class="controls">
      <button class="secondary-btn" onclick={() => showUrlInput = !showUrlInput}>
        {#if showUrlInput}Cancel{:else}+ Add Server{/if}
      </button>
      <button onclick={loadRemoteDevices} disabled={loadingRemote}>{#if loadingRemote}Loading...{:else}Refresh{/if}</button>
    </div>

    <div class="device-list">
      {#if remoteDevices.length === 0}
        <p class="empty">{#if loadingRemote}Connecting to server...{:else}No remote DSPs found. Enter a valid server URL and refresh.{/if}</p>
      {:else}
        <table class="device-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Path</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each remoteDevices as dev (dev.path)}
              <tr>
                <td>{dev.product}</td>
                <td class="mono">{dev.path}</td>
                <td>
                  {#if device.connected && deviceManager.devices.find(d => d.connectionInfo.url === dev.path)}
                    <button disabled class="connected-btn">Connected</button>
                  {:else}
                    <button onclick={() => connectDevice(dev.path)} disabled={connecting}>Connect</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>

  <div class="presets-section">
    <h3>Presets (JSON)</h3>
    <p class="hint">Save and load device configurations as JSON files.</p>

    <div class="preset-controls">
      <button onclick={savePreset} disabled={!device.connected}>
        {#if device.connected}💾 Save Preset{:else}Connect to Save{/if}
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

  {#if device.connected}
    <div class="status-bar">
      <span class="dot ok"></span>
      <span>Connected: <strong>{device.productName}</strong></span>
      {#if deviceManager.slaveCount > 0}
        <span class="muted">{deviceManager.slaveCount} slave{#if deviceManager.slaveCount > 1}s{/if}</span>
      {/if}
    </div>
  {:else}
    <p class="hint">Select a server to connect. Only WebSocket connections are supported.</p>
  {/if}
</div>

<style>
  .device-picker { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }

  .connection-section, .presets-section { padding: 1rem; border-bottom: 1px solid var(--line); }
  .connection-section:last-child, .presets-section:last-child { border-bottom: none; }

  .connection-section h3, .presets-section h3 { margin-top: 0; color: var(--text); font-size: 1rem; }
  .hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }

  .url-inputs, .add-url-row { display: flex; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; }
  .url-display { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
                background: var(--bg-elev); color: var(--text); border: 1px solid var(--line);
                font-size: .85rem; }
  .url-input { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
               background: var(--bg-elev); color: var(--text); border: 1px solid var(--line);
               font-size: .85rem; }
  .url-input:focus { outline: none; border-color: var(--accent); }

  .controls, .preset-controls { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }

  button { padding: .4rem .8rem; border-radius: 6px; font-size: .85rem; cursor: pointer;
           transition: all .15s; }
  button:hover:not(:disabled) { transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }

  .primary-btn { background: var(--accent); color: #0a0d12; border: none; font-weight: 600; }
  .secondary-btn { background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); }
  .danger-btn { background: #dc2626; color: white; border: none; }
  .remove-btn, .delete-btn { background: #ef4444; color: white; border: none; width: 28px; height: 28px;
                             padding: 0; display: flex; align-items: center; justify-content: center; }

  .device-list { max-height: 300px; overflow-y: auto; margin-top: .5rem; }
  .empty { color: var(--text-dim); font-style: italic; text-align: center; padding: 1.5rem; }

  .device-table { width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse; font-size: .85rem; }
  .device-table th { text-align: left; padding: .4rem .6rem; background: var(--bg-elev); color: var(--text-dim); font-weight: 500; }
  .device-table td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  .device-table tr:last-child td { border-bottom: none; }
  .mono { font-family: monospace; color: var(--text-dim); font-size: .8rem; }

  .status-bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem;
                background: #0a3d0a; color: #bdf5bd; font-size: .85rem; border-top: 1px solid var(--line); }
  .status-bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); box-shadow: 0 0 6px var(--good); }
  .muted { opacity: .7; font-size: .8rem; }

  .saved-list { list-style: none; padding: 0; margin: .5rem 0; max-height: 150px; overflow-y: auto; border-top: 1px solid var(--line); }
  .saved-item { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
                background: rgba(255,255,255,.02); font-size: .8rem; }
  .saved-item span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .saved-item time { color: var(--text-dim); font-size: .75rem; }

  @media (max-width: 600px) {
    .device-picker { border-radius: 0; border-left: none; border-right: none; }
    .controls, .preset-controls { flex-direction: column; }
    button { width: 100%; }
  }
</style>
