<script lang="ts">
  import { deviceManager } from "../state/device-manager.svelte.ts";
  let devices = $derived(deviceManager.devices);
</script>

<div class="device-table-container">
  <table class="device-table">
    <thead>
      <tr>
        <th style="width: 60px;">Status</th>
        <th>Product Name</th>
        <th>Type</th>
        <th>ID</th>
        <th style="width: 80px;">Action</th>
      </tr>
    </thead>
    <tbody>
      {#if devices.length === 0}
        <tr class="empty-row">
          <td colspan="5">No DSPs connected. Use System > Connection to add devices.</td>
        </tr>
      {:else}
        {#each devices as dev (dev.id)}
          <tr>
            <td class="status-cell">
              <span class="dot ok"></span>
            </td>
            <td class="product">{dev.connectionInfo.productName}</td>
            <td class="type">{dev.transportType.toUpperCase()}</td>
            <td class="id">{dev.id.slice(0, 12)}...</td>
            <td class="action">
              <button class="btn-link" onclick={() => deviceManager.disconnect(dev.id)}>Disconnect</button>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>

  <div class="summary">
    <span>Total: {devices.length}</span>
  </div>
</div>

<style>
  .device-table-container { width: 100%; max-width: 900px; margin: 0 auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-panel); overflow: hidden; }
  .device-table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-bottom: 0.5rem; }
  .device-table th { text-align: left; padding: .4rem .6rem; background: var(--bg-elev); color: var(--text-dim);
                     font-weight: 500; border-bottom: 1px solid var(--line); }
  .device-table td { padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
  .device-table tr:last-child td { border-bottom: none; }

  .empty-row td { color: var(--text-dim); font-style: italic; text-align: center; padding: 1.5rem !important; }

  .status-cell { text-align: center; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block;
         background: var(--good); box-shadow: 0 0 6px var(--good); }

  .product { font-weight: 500; color: var(--text); }
  .type { text-transform: uppercase; font-family: monospace; color: var(--text-dim); font-size: .78rem; }
  .id { font-family: monospace; color: var(--text-dim); font-size: .75rem; }

  .btn-link { background: none; border: none; color: #f66; cursor: pointer; font-size: .8rem; padding: 0; }
  .btn-link:hover { text-decoration: underline; }

  .summary { display: flex; gap: 1.5rem; padding: 0.75rem; border-top: 1px solid var(--line);
             font-size: .8rem; color: var(--text-dim); }
  .summary strong { color: var(--text); }
</style>
