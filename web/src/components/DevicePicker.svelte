<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";

  let remoteUrls = $state<Array<string>>([]);
  let connecting = $state(false);

  // Use the reactive webSocketUrls from device state
  $effect(() => {
    remoteUrls = device.webSocketUrls;
  });

  async function connectDevice(url: string) {
    connecting = true;
    try {
      await device.connect(url);
    } catch (e) {
      console.error('Connection failed:', e);
      device.error = (e as Error).message;
    } finally {
      connecting = false;
    }
  }

  function disconnectServer(url: string) {
    // Find all devices attached to this server and disconnect them
    const dev = deviceManager.devices.find(d => d.connectionInfo.url === url);
    if (dev) {
      deviceManager.disconnect(dev.id);
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

</script>

<div class="device-picker">
  <div class="panel-content">
  <!-- Connection Section -->
  <div class="connection-section">
    <h3>DSP Connections</h3>
    <p class="hint">Configure WebSocket servers and manage attached DSP devices.</p>

    <!-- Server URL configuration -->
    <div class="url-config">
      <h4>WebSocket Servers ({remoteUrls.length})</h4>
      <ul class="server-list">
        {#each remoteUrls as url, i}
          <li class="server-item">
            <span class="server-url">{url}</span>
            {#if deviceManager.devices.some(d => d.connectionInfo.url === url)}
              <button class="primary-btn disconnect-btn" onclick={() => disconnectServer(url)}>Disconnect</button>
            {:else}
              <button class="primary-btn connect-btn" onclick={() => connectDevice(url)}>
                Connect
              </button>
            {/if}
            <button class="remove-btn" onclick={() => {
              device.removeServerUrl(i);
              // Also disconnect any devices on this server
              disconnectServer(url);
            }} title="Remove server">×</button>
          </li>
        {/each}
      </ul>

      <div class="add-url-row" style:display={showUrlInput ? 'flex' : 'none'}>
        <input type="text" bind:value={newServerUrl} placeholder="ws://server:port" />
        <button onclick={addServerUrl} class="primary-btn">Add Server</button>
      </div>

      <div class="controls">
        <button class="secondary-btn" onclick={() => {
          showUrlInput = !showUrlInput;
          if (!showUrlInput) newServerUrl = "";
        }}>
          {#if showUrlInput}Cancel{:else}+ Add Server{/if}
        </button>
      </div>
    </div>

    <!-- Devices attached to servers -->
    <h4>Attached DSP Devices ({deviceManager.devices.length})</h4>
    <div class="device-list">
      {#if deviceManager.devices.length > 0}
        <table class="device-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Role</th>
              <th>Product Name</th>
              <th>Server URL</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each deviceManager.devices as dev (dev.id)}
              <tr class:master={dev.role === 'master'} class:slave={dev.role === 'slave'}>
                <td class="status-cell">
                  <span class="dot ok"></span>
                </td>
                <td>
                  <span class="role-badge" class:role-master={dev.role === 'master'} class:role-slave={dev.role === 'slave'}>
                    {#if dev.role === 'master'}M{:else}S{/if}
                  </span>
                  {#if dev.role === 'master'}<span class="role-label">Master</span>{/if}
                </td>
                <td class="product">{dev.connectionInfo.productName}</td>
                <td class="server-ip">{dev.connectionInfo.url}</td>
                <td class="action">
                  {#if dev.role !== 'master'}
                    <button class="btn-link" onclick={() => deviceManager.disconnect(dev.id)}>Disconnect</button>
                  {:else}
                    <span class="muted">Master</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-devices">No DSP devices attached. Connect to a server to see available devices.</p>
      {/if}
    </div>

    <!-- Summary bar -->
    <div class="summary">
      <span>Servers: {remoteUrls.length}</span>
      <span>Devices: {deviceManager.devices.length}</span>
      <span>Master: {#if deviceManager.master}<strong>{deviceManager.master.productName}</strong>{:else}-{/if}</span>
      <span>Slaves: {deviceManager.slaveCount}</span>
    </div>
  </div>

  <!-- Connection status bar at bottom -->
  {#if device.connected}
    <div class="status-bar">
      <span class="dot ok"></span>
      <span>Connected to server</span>
    </div>
  {/if}
  </div>
</div>

<style>
  .device-picker { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-content { padding: 1rem; }
  .connection-section h3 { margin-top: 0; color: var(--text); font-size: 1rem; }
  .connection-section h4 { margin: 1rem 0 0.5rem; color: var(--text); font-size: .9rem; border-bottom: 1px solid var(--line); padding-bottom: 0.25rem; }
  .hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }

  /* URL configuration styling */
  .url-config { background: var(--bg-elev); padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }

  /* Server list matching preset list style */
  .server-list { list-style: none; padding: 0; margin: 0.5rem 0 0.75rem 0; max-height: 200px; overflow-y: auto;
                 border-top: 1px solid var(--line); }
  .server-item { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
                 background: rgba(255,255,255,.02); font-size: .8rem; }
  .server-item:last-child { border-bottom: none; }
  .server-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                font-family: monospace; color: var(--text-dim); }
  .remove-btn { background: #ef4444; color: white; border: none; width: 28px; height: 28px;
                padding: 0; display: flex; align-items: center; justify-content: center;
                border-radius: 4px; cursor: pointer; font-size: 1.1rem; line-height: 1; }
  .remove-btn:hover { background: #dc2626; }

  .add-url-row { display: flex; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; }
  .add-url-row input { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
                       background: var(--bg-panel); color: var(--text); border: 1px solid var(--line);
                       font-size: .85rem; }
  .add-url-row input:focus { outline: none; border-color: var(--accent); }

  .controls { display: flex; gap: .5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }

  button { padding: .4rem .8rem; border-radius: 6px; font-size: .85rem; cursor: pointer;
           transition: all .15s; }
  button:hover:not(:disabled) { transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }

  .primary-btn { background: var(--accent); color: #0a0d12; border: none; font-weight: 600; }
  .secondary-btn { background: var(--bg-panel); color: var(--text); border: 1px solid var(--line); }
  .disconnect-btn { background: #dc2626; color: white; }

  /* Device list table */
  .device-list { overflow-x: auto; margin-top: .5rem; }

  .device-table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-bottom: 0.5rem; }
  .device-table th { text-align: left; padding: .4rem .6rem; background: var(--bg-elev); color: var(--text-dim);
                     font-weight: 500; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .device-table td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .device-table tr:last-child td { border-bottom: none; }

  .master { background: rgba(0, 255, 0, 0.08); }
  .slave { background: rgba(0, 0, 255, 0.06); }

  .status-cell { text-align: center; white-space: nowrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block;
         background: var(--good); box-shadow: 0 0 6px var(--good); }

  .role-badge { display: inline-flex; align-items: center; justify-content: center;
                width: 24px; height: 24px; border-radius: 4px; font-size: .75rem; font-weight: 600; white-space: nowrap; }
  .role-master { background: #d0f0d0; color: #1a5c1a; }
  .role-slave { background: #d0d8f0; color: #1a235c; }

  .role-label { margin-left: 6px; font-size: .7rem; color: var(--text-dim); }
  .product { font-weight: 500; color: var(--text); }
  .server-ip { font-family: monospace; color: var(--text-dim); font-size: .75rem; word-break: break-all; }

  .btn-link { background: none; border: none; color: #f66; cursor: pointer; font-size: .8rem; padding: 0; }
  .btn-link:hover { text-decoration: underline; }

  .no-devices { color: var(--text-dim); font-style: italic; text-align: center; padding: 2rem 1rem; }
  .summary { display: flex; gap: 1.5rem; padding: 0.75rem; border-top: 1px solid var(--line);
             font-size: .8rem; color: var(--text-dim); background: var(--bg-elev); }
  .summary strong { color: var(--text); }

  .status-bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem;
                background: #0a3d0a; color: #bdf5bd; font-size: .85rem; border-top: 1px solid var(--line); }
  .status-bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); box-shadow: 0 0 6px var(--good); }

  @media (max-width: 600px) {
    .device-picker { border-radius: 0; border-left: none; border-right: none; }
    .controls { flex-direction: column; }
    button { width: 100%; }
    .server-ip { max-width: 200px; }
  }
</style>
