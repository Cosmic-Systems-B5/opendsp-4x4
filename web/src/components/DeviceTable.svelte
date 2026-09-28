<script lang="ts">
  import { deviceManager } from "../state/device-manager.ts";
</script>

<div class="device-table-container">
  <table class="device-table">
    <thead>
      <tr>
        <th style="width: 60px;">Status</th>
        <th>Role</th>
        <th>Product Name</th>
        <th>Type</th>
        <th>ID</th>
        <th style="width: 80px;">Action</th>
      </tr>
    </thead>
    <tbody>
      {#if deviceManager.devices.length === 0}
        <tr class="empty-row">
          <td colspan="6">No DSPs connected. Use System > Connection to add devices.</td>
        </tr>
      {:else}
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
            <td class="id">{dev.id.slice(0, 12)}...</td>
            <td class="action">
              {#if dev.role !== 'master'}
                <button class="btn-link" onclick={() => deviceManager.disconnect(dev.id)}>Disconnect</button>
              {:else}
                <span class="muted">Master</span>
              {/if}
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>

  <div class="summary">
    <span>Total: {deviceManager.devices.length}</span>
    <span>Master: {#if deviceManager.master}<strong>{deviceManager.master.productName}</strong>{:else}-{/if}</span>
    <span>Slaves: {deviceManager.slaveCount}</span>
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

  .master { background: rgba(0, 255, 0, 0.08); }
  .slave { background: rgba(0, 0, 255, 0.06); }

  .status-cell { text-align: center; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block;
         background: var(--good); box-shadow: 0 0 6px var(--good); }

  .role-badge { display: inline-flex; align-items: center; justify-content: center;
                width: 24px; height: 24px; border-radius: 4px; font-size: .75rem; font-weight: 600; }
  .role-master { background: #d0f0d0; color: #1a5c1a; }
  .role-slave { background: #d0d8f0; color: #1a235c; }

  .role-label { margin-left: 6px; font-size: .7rem; color: var(--text-dim); }

  .product { font-weight: 500; color: var(--text); }
  .type { text-transform: uppercase; font-family: monospace; color: var(--text-dim); font-size: .78rem; }
  .id { font-family: monospace; color: var(--text-dim); font-size: .75rem; }

  .btn-link { background: none; border: none; color: #f66; cursor: pointer; font-size: .8rem; padding: 0; }
  .btn-link:hover { text-decoration: underline; }

  .summary { display: flex; gap: 1.5rem; padding: 0.75rem; border-top: 1px solid var(--line);
             font-size: .8rem; color: var(--text-dim); }
  .summary strong { color: var(--text); }
</style>
