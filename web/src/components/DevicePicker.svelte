<script lang="ts">
  import { onMount } from "svelte";
  import { serverManager } from "../state/server-manager.svelte.ts";
  import { deviceManager } from "../state/device-manager.svelte.ts";
  import { DeviceSvelte } from "../state/device.svelte.ts";

  let urls = $derived(serverManager.urls);
  let servers = $derived(serverManager.servers);
  let devices = $derived(deviceManager.devices);

  function isConnecting(url: string): boolean { return servers[url]?.connecting ?? false; }
  function isConnected(url: string): boolean  { return servers[url]?.connected ?? false; }
  function serverInfo(url: string)            { return servers[url]?.serverInfo; }
  function serverDevices(url: string)         { return servers[url]?.devices ?? []; }

  function boundDevice(url: string, guid: string) {
    return devices.find(d =>
            d.connectionInfo.url === url
            && d.guid === guid
            && d.connected,
    );
  }

  async function connectServer(url: string) { await serverManager.connect(url); }
  function disconnectServer(url: string) {
    for (const d of devices) {
      if (d.connectionInfo.url === url && d.connected) {
        deviceManager.disconnect(d.id);
      }
    }
    serverManager.disconnect(url);
  }

  async function connectDevice(url: string, guid: string) {
    const s = servers[url];
    if (!s?.connected) return;
    const info = s.devices.find(d => d.guid === guid);
    if (!info) return;

    const t = serverManager.getTransport(url);
    if (!t) { console.error('no transport for', url); return; }

    const store = new DeviceSvelte();

    await store.bind(t, {
      guid: info.guid,
      serverid: info.serverid,
      productName: info.product,
      kind: info.kind,
    });

    deviceManager.bindTransport(t, store, {
      url,
      guid: info.guid,
      serverid: info.serverid,
      productName: info.product,
      kind: info.kind,
    });
  }

  async function disconnectDevice(url: string, guid: string) {
    const rec = boundDevice(url, guid);
    if (!rec) return;
    try { await rec.store.unbind(); } catch { /* ignore */ }
    deviceManager.disconnect(rec.id);
  }

  let newServerUrl = $state("");
  let showUrlInput = $state(false);
  let addError = $state<string | null>(null);

  function addServerUrl() {
    addError = null;
    const ok = serverManager.addUrl(newServerUrl);
    if (!ok) { addError = "Enter a valid ws:// or wss:// URL (and it must not already be listed)."; return; }
    newServerUrl = "";
    showUrlInput = false;
  }

  // URLs we've already auto-restored since this server became connected.
  const restoredThisSession = new Set<string>();

  $effect(() => {
    for (const url of urls) {
      const s = servers[url];
      if (!s?.connected) {
        restoredThisSession.delete(url);
        continue;
      }
      if (restoredThisSession.has(url)) continue;
      restoredThisSession.add(url);
      void restoreBindingsFor(url);
    }
  });

  async function restoreBindingsFor(url: string) {
    const s = servers[url];
    if (!s) return;
    const persisted = deviceManager.bindingsFor(url);
    if (persisted.length === 0) return;

    // Reject any binding whose stored serverid doesn't match the current
    // server's serverId — the bridge was replaced and the GUIDs are stale.
    const liveGuids = new Set(s.devices.map(d => d.guid));
    for (const pb of persisted) {
      if (!liveGuids.has(pb.guid)) {
        deviceManager.forgetBinding(url, pb.guid);
        continue;
      }
      if (boundDevice(url, pb.guid)) continue;
      try {
        await connectDevice(url, pb.guid);
      } catch (e) {
        console.warn(`Auto-restore failed for ${url} ${pb.guid}:`, e);
        deviceManager.forgetBinding(url, pb.guid);
      }
    }
  }

  onMount(() => { void serverManager.restoreConnections(); });
</script>

<div class="picker">

  <section class="panel">
    <h3>Servers ({urls.length})</h3>

    {#if urls.length === 0}
      <p class="hint">No servers configured. Add one below.</p>
    {:else}
      <ul class="list">
        {#each urls as url (url)}
          <li class="row">
            <span class="url" title={url}>{url}</span>
            {#if serverInfo(url)}
              <span class="badge" title="server-id">{serverInfo(url)?.serverId}</span>
            {/if}
            {#if servers[url]?.lastError}
              <span class="err" title={servers[url].lastError}>error</span>
            {/if}
            {#if isConnected(url)}
              <button class="btn danger" onclick={() => disconnectServer(url)}>Disconnect</button>
            {:else}
              <button class="btn primary" onclick={() => connectServer(url)} disabled={isConnecting(url)}>
                {isConnecting(url) ? 'Connecting…' : 'Connect'}
              </button>
            {/if}
            <button class="btn icon" onclick={() => serverManager.removeUrl(url)} title="Remove">×</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if showUrlInput}
      <div class="add-row">
        <input type="text" bind:value={newServerUrl} placeholder="ws://server:port"
               onkeydown={(e) => { if (e.key === 'Enter') addServerUrl(); }} />
        <button class="btn primary" onclick={addServerUrl}>Add</button>
        <button class="btn" onclick={() => { showUrlInput = false; newServerUrl = ''; addError = null; }}>Cancel</button>
      </div>
      {#if addError}<p class="err small">{addError}</p>{/if}
    {:else}
      <button class="btn" onclick={() => (showUrlInput = true)}>+ Add Server</button>
    {/if}
  </section>

  <section class="panel">
    <h3>DSP Units</h3>

    {#if urls.filter(isConnected).length === 0}
      <p class="hint">Connect to a server above to see its DSP units.</p>
    {:else}
      {#each urls as url (url)}
        {#if isConnected(url)}
          <div class="server-group">
            <div class="server-head">
              <span class="url">{url}</span>
              <span class="badge">{serverDevices(url).length} unit(s)</span>
            </div>

            {#if serverDevices(url).length === 0}
              <p class="hint">No DSP units on this server.</p>
            {:else}
              <ul class="list">
                {#each serverDevices(url) as info (info.guid)}
                  {@const bound = boundDevice(url, info.guid)}
                  <li class="row">
                    <span class="kind pill {info.kind}">{info.kind}</span>
                    <span class="name" title={info.product}>{info.product}</span>
                    <span class="badge mono">{info.guid}</span>

                    {#if bound}
                      <button class="btn danger"
                              onclick={() => disconnectDevice(url, info.guid)}>Disconnect</button>
                    {:else}
                      <button class="btn primary"
                              onclick={() => connectDevice(url, info.guid)}>Connect</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/each}
    {/if}
  </section>

</div>

<style>
  .picker {
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }
  @media (max-width: 780px) {
    .picker { grid-template-columns: 1fr; }
  }

  .panel {
    background: var(--bg-panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 1rem;
  }
  .panel h3 { margin: 0 0 .75rem; font-size: .95rem; color: var(--text); }
  .hint { color: var(--text-dim); font-style: italic; font-size: .82rem; margin: .25rem 0 .75rem; }
  .err { color: #f88; font-size: .78rem; }
  .err.small { font-size: .72rem; margin: .25rem 0 0; }

  .list { list-style: none; padding: 0; margin: 0 0 .75rem; border-top: 1px solid var(--line); }
  .row {
    display: flex; align-items: center; gap: .5rem;
    padding: .45rem .5rem;
    border-bottom: 1px solid var(--line);
    background: rgba(255,255,255,.02);
    font-size: .82rem;
  }
  .row:last-child { border-bottom: none; }

  .url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: monospace; color: var(--text-dim); min-width: 120px; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text); }

  .badge {
    font-family: monospace; font-size: .7rem; letter-spacing: .04em;
    background: rgba(0,0,0,.25); border: 1px solid var(--line);
    color: var(--text-dim); padding: 1px 6px; border-radius: 3px;
  }
  .badge.mono { text-transform: none; }

  .pill {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: .64rem; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; font-family: monospace;
    border: 1px solid var(--line); color: var(--text-dim); background: var(--bg-panel);
  }
  .pill.hid  { color: #8fa5c4; border-color: #3a4a5e; background: rgba(60,80,110,.15); }
  .pill.mock { color: #a08cc4; border-color: #4a3f5e; background: rgba(90,70,120,.15); }
  .pill.master { color: #d0f0d0; border-color: #2f5d2f; background: rgba(50,120,50,.2); }
  .pill.slave  { color: #d0d8f0; border-color: #2f3a5d; background: rgba(50,70,120,.2); }

  .btn {
    padding: .3rem .7rem;
    font-size: .78rem;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: var(--bg-panel);
    color: var(--text);
    cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--accent); color: #0a0d12; border-color: var(--accent); font-weight: 600; }
  .btn.danger  { background: #dc2626; color: white; border-color: #dc2626; }
  .btn.icon    { width: 26px; height: 26px; padding: 0; display: inline-flex;
    align-items: center; justify-content: center; font-size: 1.05rem;
    background: #ef4444; color: #fff; border-color: #ef4444; }

  .add-row { display: flex; gap: .5rem; flex-wrap: wrap; margin: .25rem 0 .5rem; }
  .add-row input {
    flex: 1; min-width: 180px;
    padding: .4rem .6rem; border-radius: 6px;
    background: var(--bg-panel); color: var(--text);
    border: 1px solid var(--line); font-size: .85rem;
  }
  .add-row input:focus { outline: none; border-color: var(--accent); }

  .server-group { margin-bottom: 1rem; }
  .server-head {
    display: flex; align-items: center; gap: .5rem;
    padding: .3rem 0;
    border-bottom: 1px dashed var(--line);
    margin-bottom: .25rem;
  }
</style>