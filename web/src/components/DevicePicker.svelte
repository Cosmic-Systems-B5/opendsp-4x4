<script lang="ts">
  import { device, deviceManager } from "../state/device.svelte.ts";
  import { WebHidTransport } from "../transport/webhid.ts";

  let selectedTab = $state<"usb" | "remote">("usb");
  let localDevices = $state<HIDDevice[]>([]);
  let remoteDevices = $state<Array<{path: string; vendorId: string; productId: string; product: string}>>([]);
  let remoteUrl = $state<string>("ws://localhost:8765");
  let loadingRemote = $state(false);
  let connecting = $state(false);

  // Load saved URL
  const savedUrl = typeof localStorage !== "undefined" ? localStorage.getItem("opendsp-remote-url") : null;
  if (savedUrl) remoteUrl = savedUrl;

  async function loadLocalDevices() {
    if (!WebHidTransport.supported()) return;
    localDevices = await navigator.hid.getDevices();
  }

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
            if (data.devices) {
              remoteDevices = data.devices;
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

  async function connectDevice(deviceOrUrl: HIDDevice | string, isRemote: boolean) {
    connecting = true;
    try {
      if (isRemote && typeof deviceOrUrl === 'string') {
        // Connect to remote DSP via WebSocket
        await device.connect(deviceOrUrl);
        const info = {
          url: deviceOrUrl,
          productName: "DSP 4x4 (remote)"
        };
        deviceManager.connect(device, 'websocket', info);
      } else if (!isRemote && deviceOrUrl instanceof HIDDevice) {
        // Connect to local USB DSP using the specific device provided
        const transport = await WebHidTransport.fromDevice(deviceOrUrl as HIDDevice);
        if (transport) {
          await device.bind(transport);
        }
        const info = {
          path: deviceOrUrl.path,
          productName: deviceOrUrl.productName || "DSP 4x4"
        };
        deviceManager.connect(device, 'usb', info);
      }
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

  // Auto-load devices on mount
  $effect(() => {
    loadLocalDevices();
  });
</script>

<div class="device-picker">
  <div class="tabs">
    <button class="tab-btn" class:active={selectedTab === "usb"} onclick={() => { selectedTab = "usb"; loadLocalDevices(); }}>
      Local USB Devices
    </button>
    <button class="tab-btn" class:active={selectedTab === "remote"} onclick={() => { selectedTab = "remote"; loadRemoteDevices(); }}>
      Remote DSPs
    </button>
  </div>

  <div class="content">
    {#if selectedTab === "usb"}
      <div class="device-list">
        {#if localDevices.length === 0}
          <p class="empty">No USB devices found. Connect a DSP and click the Local USB tab.</p>
        {:else}
          <table class="device-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Vendor:Product</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {#each localDevices as dev (dev.productId)}
                <tr>
                  <td>{dev.productName || "Unknown"}</td>
                  <td class="mono">0x{dev.vendorId.toString(16).padStart(4, '0')} : 0x{dev.productId.toString(16).padStart(4, '0')}</td>
                  <td><button onclick={() => connectDevice(dev, false)} disabled={connecting}>Connect</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {:else}
      <div class="remote-controls">
        <input type="text" bind:value={remoteUrl} placeholder="ws://server:port" class="url-input" onblur={() => localStorage.setItem("opendsp-remote-url", remoteUrl.trim())} />
        <button onclick={loadRemoteDevices} disabled={loadingRemote}>{#if loadingRemote}Loading...{:else}Load{/if}</button>
      </div>

      <div class="device-list">
        {#if remoteDevices.length === 0}
          <p class="empty">{#if loadingRemote}Loading...{:else}No remote DSPs found. Check server connection.{/if}</p>
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
                  <td><button onclick={() => connectDevice(dev.path, true)} disabled={connecting}>Connect</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
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
    <p class="hint">Select a device to connect. First connected becomes master.</p>
  {/if}
</div>

<style>
  .device-picker { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .tabs { display: flex; border-bottom: 1px solid var(--line); background: var(--bg-elev); }
  .tab-btn { padding: .6rem 1.2rem; border: none; border-radius: 0; background: transparent; color: var(--text-dim);
             font-size: .85rem; cursor: pointer; transition: all .15s; flex: 1; }
  .tab-btn:hover { color: var(--text); background: rgba(255,255,255,.03); }
  .tab-btn.active { background: var(--bg-panel); color: var(--accent); font-weight: 600; border-bottom: 2px solid var(--accent); }

  .content { padding: 1rem; }
  .empty { color: var(--text-dim); font-style: italic; text-align: center; padding: 1.5rem; }
  .device-table { width: 100%; max-width: 600px; margin: 0 auto; border-collapse: collapse; font-size: .85rem; margin-top: 0.5rem; }
  .device-table th { text-align: left; padding: .4rem .6rem; background: var(--bg-elev); color: var(--text-dim); font-weight: 500; }
  .device-table td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); }
  .device-table tr:last-child td { border-bottom: none; }
  .mono { font-family: monospace; color: var(--text-dim); font-size: .8rem; }

  .remote-controls { display: flex; gap: .5rem; margin-bottom: 1rem; }
  .url-input { flex: 1; min-width: 200px; padding: .4rem .6rem; border-radius: 6px;
               background: var(--bg-elev); color: var(--text); border: 1px solid var(--line);
               font-size: .85rem; }
  .url-input:focus { outline: none; border-color: var(--accent); }

  .status-bar { display: flex; align-items: center; gap: .75rem; padding: .75rem 1rem;
                background: #0a3d0a; color: #bdf5bd; font-size: .85rem; border-top: 1px solid var(--line); }
  .status-bar .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--good); box-shadow: 0 0 6px var(--good); }
  .muted { opacity: .7; font-size: .8rem; }

  .hint { color: var(--text-dim); text-align: center; padding: 1.25rem; font-style: italic; }
</style>
