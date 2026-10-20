<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";

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
  <!-- Connection Section - Contains both connection status and device list in one table -->
  <div class="connection-section">
    <h3>DSP Connections</h3>
    <p class="hint">Manage your DSP devices and configure WebSocket servers.</p>

    <!-- Server URL configuration -->
    <div class="url-config">
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
    </div>

    <!-- Device list table - merged into connection section -->
    <div class="device-list">
        <table class="device-table">
          <thead>
            <tr>
              <th style="width: 60px;">Status</th>
              <th>Role</th>
              <th>Product Name</th>
              <th>Type</th>
              <th>Server IP</th>
              <th>Device ID</th>
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
                <td class="type">{dev.transportType.toUpperCase()}</td>
                <td class="server-ip">{dev.connectionInfo.url ?? dev.connectionInfo.path ?? 'N/A'}</td>
                <td class="device-id">{dev.id.slice(0, 12)}...</td>
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

      <!-- Remote devices (for connection) - shown when no local devices connected -->
      {#if deviceManager.devices.length === 0 && remoteDevices.length > 0}
        <div class="remote-devices-section">
          <p class="section-title">Available Remote DSPs:</p>
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
        </div>
      {/if}
    </div>

    <!-- Summary bar -->
    <div class="summary">
      <span>Total: {deviceManager.devices.length}</span>
      <span>Master: {#if deviceManager.master}<strong>{deviceManager.master.productName}</strong>{:else}-{/if}</span>
      <span>Slaves: {deviceManager.slaveCount}</span>
    </div>
  </div>

  <!-- Connection status bar at bottom -->
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

  .connection-section h3 { margin-top: 0; color: var(--text); font-size: 1rem; }
  .hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }

  /* URL configuration styling */
  .url-config { background: var(--bg-elev); padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
  .url-inputs, .add-url-row { display: flex; gap: .5rem; margin-bottom: .75rem; flex-wrap: wrap; }
  .url-display { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
                background: var(--bg-panel); color: var(--text); border: 1px solid var(--line);
                font-size: .85rem; }
  .url-input { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
               background: var(--bg-panel); color: var(--text); border: 1px solid var(--line);
               font-size: .85rem; }
  .url-input:focus { outline: none; border-color: var(--accent); }

  .controls { display: flex; gap: .5rem; margin-bottom: 1rem; flex-wrap: wrap; }

  button { padding: .4rem .8rem; border-radius: 6px; font-size: .85rem; cursor: pointer;
           transition: all .15s; }
  button:hover:not(:disabled) { transform: translateY(-1px); }
  button:active:not(:disabled) { transform: translateY(0); }

  .primary-btn { background: var(--accent); color: #0a0d12; border: none; font-weight: 600; }
  .secondary-btn { background: var(--bg-panel); color: var(--text); border: 1px solid var(--line); }
  .remove-btn { background: #ef4444; color: white; border: none; width: 28px; height: 28px;
                padding: 0; display: flex; align-items: center; justify-content: center; }

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
  .type { text-transform: uppercase; font-family: monospace; color: var(--text-dim); font-size: .78rem; white-space: nowrap; }
  .server-ip { font-family: monospace; color: var(--text-dim); font-size: .75rem; word-break: break-all; }
  .device-id { font-family: monospace; color: var(--text-dim); font-size: .75rem; white-space: nowrap; }

  .btn-link { background: none; border: none; color: #f66; cursor: pointer; font-size: .8rem; padding: 0; }
  .btn-link:hover { text-decoration: underline; }

  .summary { display: flex; gap: 1.5rem; padding: 0.75rem; border-top: 1px solid var(--line);
             font-size: .8rem; color: var(--text-dim); background: var(--bg-elev); }
  .summary strong { color: var(--text); }

  /* Remote devices section */
  .remote-devices-section { margin-top: 1rem; }
  .section-title { color: var(--text-dim); font-size: .85rem; margin-bottom: .5rem; font-weight: 500; }
  .mono { font-family: monospace; color: var(--text-dim); font-size: .8rem; }

  .status-bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem;
                background: #0a3d0a; color: #bdf5bd; font-size: .85rem; border-top: 1px solid var(--line); }
  .status-bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); box-shadow: 0 0 6px var(--good); }
  .muted { opacity: .7; font-size: .8rem; }

  @media (max-width: 600px) {
    .device-picker { border-radius: 0; border-left: none; border-right: none; }
    .controls { flex-direction: column; }
    button { width: 100%; }
    .server-ip { max-width: 150px; }
  }
</style>
