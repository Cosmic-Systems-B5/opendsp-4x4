<script lang="ts">
  import { device } from "../state/device.svelte.ts";
  import { WebSocketTransport } from "../transport/websocket.ts";

  const wsSupported = typeof WebSocket !== "undefined" && WebSocketTransport.supported();

  let connectionType = $state<"local" | "remote">("local");
  let remoteUrl = $state<string>("ws://localhost:8765");
  let remoteDevices = $state<Array<{path: string; vendorId: string; productId: string; product: string}>>([]);
  let selectedDevicePath = $state<string>("");
  let loadingDevices = $state(false);

  // Load saved URL
  const savedUrl = typeof localStorage !== "undefined" ? localStorage.getItem("opendsp-remote-url") : null;
  if (savedUrl) {
    connectionType = "remote";
    remoteUrl = savedUrl;
  }

  async function loadRemoteDevices() {
    loadingDevices = true;
    try {
      const url = new URL(remoteUrl.trim());
      const apiBase = `${url.protocol}//${url.host}`;
      const resp = await fetch(`${apiBase}/devices`);
      if (resp.ok) {
        const data = await resp.json();
        remoteDevices = data.devices || [];
        if (data.connectedPath && !selectedDevicePath) {
          selectedDevicePath = data.connectedPath;
        }
      }
    } catch (e) {
      console.error('Failed to load devices:', e);
    } finally {
      loadingDevices = false;
    }
  }

  async function handleConnect() {
    if (connectionType === "remote" && remoteUrl.trim()) {
      localStorage.setItem("opendsp-remote-url", remoteUrl.trim());
      const connectUrl = selectedDevicePath || remoteUrl.trim();
      void device.connect(connectUrl);
    } else {
      localStorage.removeItem("opendsp-remote-url");
      void device.connect();
    }
  }

  function handleDisconnect() {
    device.connected = false;
  }

  function handleChangeConnectionType(type: "local" | "remote") {
    connectionType = type;
    device.error = "";
    selectedDevicePath = "";
  }
</script>

<div class="connection-panel">
  <div class="panel-header">
    <span class="title">Connection</span>
    <span class="spacer"></span>
  </div>
  <div class="content">
    <div class="conn-controls">
      <button class="conn-btn" class:active={connectionType === "local"} onclick={() => handleChangeConnectionType("local")}>
        Local USB
      </button>
      {#if wsSupported}
        <button class="conn-btn" class:active={connectionType === "remote"} onclick={() => handleChangeConnectionType("remote")}>
          Remote
        </button>
      {/if}
    </div>
    {#if connectionType === "remote"}
      <div class="remote-controls">
        <input type="text" bind:value={remoteUrl} placeholder="ws://server:port" class="url-input"
               onblur={() => localStorage.setItem("opendsp-remote-url", remoteUrl.trim())} />
        <button class="device-btn" onclick={loadRemoteDevices} disabled={loadingDevices}>
          {#if loadingDevices}Loading...{:else}Select Device{/if}
        </button>
        {#if remoteDevices.length > 0}
          <select class="device-select" bind:value={selectedDevicePath}>
            <option value="">-- Select Device --</option>
            {#each remoteDevices as dev (dev.path)}
              <option value={dev.path}>{dev.product} ({dev.vendorId}:{dev.productId})</option>
            {/each}
          </select>
        {/if}
      </div>
    {/if}

    <div class="status-row">
      <span class="dot" class:ok={device.connected}></span>
      <span class="status" class:ok={device.connected}>{device.connected ? device.version || device.productName : device.error || "Not connected"}</span>
      {#if device.connected}
        <button class="primary" onclick={handleDisconnect}>Disconnect</button>
      {:else}
        <button class="primary" onclick={handleConnect}>{connectionType === "remote" ? "Connect (Remote)" : "Connect DSP"}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .connection-panel { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .panel-header { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .5rem 1rem; background: var(--bg-elev); border-bottom: 1px solid var(--line); }
  .title { font-weight: 600; color: var(--text); }
  .spacer { flex: 1; }
  .content { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }

  .conn-controls { display: flex; gap: .25rem; background: var(--bg-panel); padding: .15rem; border-radius: var(--radius); }
  .conn-btn { padding: .35rem .7rem; border: none; border-radius: 6px; background: transparent; color: var(--text-dim);
              font-size: .8rem; cursor: pointer; transition: all .15s; white-space: nowrap; }
  .conn-btn:hover { color: var(--text); background: rgba(255,255,255,.05); }
  .conn-btn.active { background: var(--accent); color: #0a0d12; font-weight: 600; box-shadow: var(--glow); }

  .remote-controls { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .url-input { flex: 1; min-width: 180px; max-width: 300px; padding: .35rem .6rem; border-radius: 6px;
               background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); font-size: .85rem; }
  .device-btn { padding: .35rem .7rem; border-radius: 6px; background: var(--bg-elev); color: var(--text);
                font-size: .8rem; cursor: pointer; transition: all .15s; white-space: nowrap; border: 1px solid var(--line); }
  .device-btn:hover:not(:disabled) { border-color: var(--accent); }
  .device-btn:disabled { opacity: .6; cursor: not-allowed; }
  .device-select { padding: .35rem .7rem; border-radius: 6px; background: var(--bg-elev); color: var(--text);
                   border: 1px solid var(--line); font-size: .8rem; min-width: 200px; }

  .status-row { display: flex; align-items: center; gap: .5rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 8px var(--bad); }
  .dot.ok { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .status { font-size: .82rem; color: var(--text-dim); max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status.ok { color: var(--good); }
</style>
