<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";
  import { websocketManager } from "../state/websocket-manager.ts";

  let remoteUrls = $state<Array<string>>([]);
  let connectingTo = $state<string | null>(null);
  let connectionStates = $state<Record<string, boolean>>({});

  // Use the reactive webSocketUrls from device state
  $effect(() => {
    remoteUrls = device.webSocketUrls;
    // Update connection states whenever connections change
    connectionStates = websocketManager.getConnectionStates();
  });

  /**
   * Check if a server has an active WebSocket connection
   */
  function isServerConnected(url: string): boolean {
    return connectionStates[url] ?? false;
  }

  async function connectServer(url: string) {
    connectingTo = url;
    try {
      // First, get the server info to retrieve the server GUID
      let serverGuid: string | undefined;
      try {
        const res = await fetch(`${url.replace(/^ws/, 'http')}/server-info`);
        if (res.ok) {
          const data = await res.json();
          serverGuid = data.serverId;
          console.log(`Server GUID for ${url}: ${serverGuid}`);
        }
      } catch (e) {
        console.warn('Could not fetch server info:', e);
        // Generate a client-side GUID as fallback
        serverGuid = 'srv-' + Math.random().toString(36).substring(2, 7).toUpperCase();
      }

      // Connect via websocketManager which handles the transport
      const productName = "DSP 4x4 (remote)";
      await websocketManager.connect(url, productName);

      // Get the transport from websocketManager and bind to device
      const t = websocketManager.getTransport(url);
      if (!t) throw new Error("Failed to get WebSocket transport");

      await device.bind(t);

      // Register the server connection in DeviceManager for tracking
      const server = deviceManager.connectServer(url, productName, serverGuid);
      if (server) {
        console.log(`Connected to server: ${url}`);
      }
    } catch (e) {
      console.error('Connection failed:', e);
      device.error = (e as Error).message;
    } finally {
      connectingTo = null;
    }
  }

  function disconnectServer(url: string) {
    websocketManager.disconnect(url);
    deviceManager.disconnectServer(url);
  }

  function disconnectDSP(id: string) {
    deviceManager.disconnect(id);
  }

  function reconnectDSP(id: string) {
    // Reconnect a previously disconnected device
    const deviceToReconnect = deviceManager.devices.find(d => d.id === id);
    if (deviceToReconnect && deviceToReconnect.connectionInfo.url) {
      console.log(`Reconnecting to ${deviceToReconnect.connectionInfo.url}`);
      void connectServer(deviceToReconnect.connectionInfo.url);
    }
  }

  function removeSavedDevice(id: string) {
    // Remove a saved/disconnected device from the list
    const idx = deviceManager.devices.findIndex(d => d.id === id);
    if (idx >= 0) {
      deviceManager.devices.splice(idx, 1);
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
    <h3>Websocket Connections ({remoteUrls.length})</h3>
    <!-- Server URL configuration -->
<!--    <div class="url-config">-->
      <ul class="server-list">
        {#each remoteUrls as url, i}
          <li class="server-item">
            <span class="server-url">{url}</span>

            <!-- Server connection button -->
            {#if isServerConnected(url)}
              <button class="primary-btn disconnect-btn" onclick={() => disconnectServer(url)}>
                Disconnect
              </button>
            {:else}
              <button class="primary-btn connect-btn" onclick={() => connectServer(url)} disabled={connectingTo !== null}>
                {#if connectingTo === url}Connecting...{:else}Connect{/if}
              </button>
            {/if}

            <!-- Remove button -->
            <button class="remove-btn" onclick={() => {
              device.removeServerUrl(i);
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
  </div>
  </div>

<div class="device-picker">
    <div class="panel-content">
    <!-- Connected DSP Devices table (original style) -->
    <h4>Connected DSP Units ({deviceManager.devices.filter(d => d.connected).length} connected, {deviceManager.devices.length - deviceManager.devices.filter(d => d.connected).length} saved)</h4>
    <div class="device-list">
      {#if deviceManager.devices.length > 0}
        <table class="device-table">
          <thead>
          <tr>
            <th>Status</th>
            <th>Role</th>
            <th>Product Name</th>
            <th>Server GUID</th>
            <th>Device GUID</th>
            <th>Action</th>
          </tr>
          </thead>
          <tbody>
          {#each deviceManager.devices as dev (dev.id)}
            <tr class:master={dev.role === 'master'} class:slave={dev.role === 'slave'} class:disconnected={!dev.connected}>
              <td class="status-cell">
                {#if dev.connected}
                  <span class="dot ok"></span>
                {:else}
                  <span class="dot disconnected" title="Device saved for reconnection"></span>
                {/if}
              </td>
              <td>
                    <span class="role-badge" class:role-master={dev.role === 'master'} class:role-slave={dev.role === 'slave'}>
                      {#if dev.role === 'master'}M{:else}S{/if}
                    </span>
                {#if dev.role === 'master'}<span class="role-label">Master</span>{/if}
              </td>
              <td class="product">{dev.connectionInfo.productName}</td>
              <td class="guid-cell" title="Server GUID">{dev.serverGuid ?? 'N/A'}</td>
              <td class="guid-cell" title="Device GUID">{dev.deviceGuid ?? 'N/A'}</td>
              <td class="action">
                {#if dev.connected}
                  {#if dev.role === 'master'}
                    <button class="btn-link disconnect-master" onclick={() => disconnectDSP(dev.id)}>
                      Disconnect (Promotes Slave)
                    </button>
                  {:else}
                    <button class="btn-link" onclick={() => disconnectDSP(dev.id)}>Disconnect</button>
                  {/if}
                {:else}
                  <button class="btn-link reconnect-btn" onclick={() => reconnectDSP(dev.id)}>Reconnect</button>
                  <button class="btn-link remove-btn-small" onclick={() => removeSavedDevice(dev.id)}>Remove</button>
                {/if}
              </td>
            </tr>
          {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-devices">No DSP units connected. Connect to a server and connect to a DSP unit.</p>
      {/if}
    </div>
    </div>
</div>

    <!-- Summary bar -->
<!--    <div class="summary">-->
<!--      <span>Servers: {remoteUrls.length}</span>-->
<!--      <span>Connected DSPs: {deviceManager.devices.length}</span>-->
<!--      <span>Master: {#if deviceManager.master}<strong>{deviceManager.master.productName}</strong>{:else}-{/if}</span>-->
<!--    </div>-->

<!--  &lt;!&ndash; Connection status bar at bottom &ndash;&gt;-->
<!--  {#if device.connected}-->
<!--    <div class="status-bar">-->
<!--      <span class="dot ok"></span>-->
<!--      <span>Connected to server</span>-->
<!--    </div>-->
<!--  {:else}-->
<!--    <p class="hint">Add a WebSocket server URL and connect to manage DSP units.</p>-->
<!--  {/if}-->


<style>
  .device-picker { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-content { padding: 1rem; }
  .connection-section h3 { margin-top: 0; color: var(--text); font-size: 1rem; }
  .connection-section h4 { margin: 1rem 0 0.5rem; color: var(--text); font-size: .9rem; border-bottom: 1px solid var(--line); padding-bottom: 0.25rem; }
  .hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }

  /* URL configuration styling */
  .url-config { background: var(--bg-elev); padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }

  /* Server/DSP list matching preset list style */
  .server-list { list-style: none; padding: 0; margin: 0.5rem 0 0.75rem 0; max-height: 250px; overflow-y: auto;
                 border-top: 1px solid var(--line); }
  .server-item { display: flex; align-items: center; gap: .5rem; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
                 background: rgba(255,255,255,.02); font-size: .8rem; }
  .server-item:last-child { border-bottom: none; }

  .server-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                font-family: monospace; color: var(--text-dim); min-width: 200px; }
  .device-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
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
  .guid-cell { font-family: monospace; color: var(--text-dim); font-size: .7rem; letter-spacing: .05em;
               background: rgba(0,0,0,.03); padding: 2px 6px; border-radius: 3px; }

  .disconnected { opacity: 0.7; background: rgba(128,128,128,0.05) !important; }
  .dot.disconnected { background: var(--dim); box-shadow: none; }
  .reconnect-btn { background: none; border: none; color: #3b82f6; cursor: pointer; font-size: .8rem; padding: 0; }
  .reconnect-btn:hover { text-decoration: underline; color: #2563eb; }
  .remove-btn-small { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: .75rem;
                      margin-left: .5rem; padding: 0; }
  .remove-btn-small:hover { color: #ef4444; text-decoration: underline; }

  .disconnect-master { background: none; border: none; color: #f97316; cursor: pointer; font-size: .8rem;
                       padding: 0; }
  .disconnect-master:hover { text-decoration: underline; color: #ea580c; }

  .btn-link { background: none; border: none; color: #f66; cursor: pointer; font-size: .8rem; padding: 0; }
  .btn-link:hover { text-decoration: underline; }

  /* Summary bar */
  .no-devices { color: var(--text-dim); font-style: italic; text-align: center; padding: 1rem; }
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
    .server-url, .device-name { min-width: auto; }
  }
</style>
