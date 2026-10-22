<script lang="ts">
  type MessageType = 'success' | 'error' | 'info';

  let { message = '', type: msgType = 'info', confirm }: {
    message?: string,
    type?: MessageType,
    confirm?: boolean
  } = $props();

  // Auto-hide after 4 seconds when a message is shown (unless it's a confirmation)
  $effect(() => {
    if (message && !confirm) {
      const timeoutId = window.setTimeout(() => {
        message = '';
      }, 4000);

      return () => clearTimeout(timeoutId);
    }
  });

  function handleConfirm() {
    // Dispatch custom event with result
    const event = new CustomEvent('flash-confirm', { detail: { confirmed: true } });
    window.dispatchEvent(event);
    message = '';
  }

  function handleCancel() {
    // Dispatch custom event with result
    const event = new CustomEvent('flash-confirm', { detail: { confirmed: false } });
    window.dispatchEvent(event);
    message = '';
  }

  function handleClose() {
    message = '';
  }
</script>

<div class="header-status-bar">
  {#if message}
    <div class={`header-status-content header-status-${confirm ? 'info' : msgType} ${confirm ? 'confirm' : ''}`}>
      <span class="message">{message}</span>
      {#if confirm}
        <div class="confirm-buttons">
          <button class="btn-confirm" onclick={handleConfirm}>OK</button>
          <button class="btn-cancel" onclick={handleCancel}>Cancel</button>
        </div>
      {:else}
        <button class="close-btn" aria-label="Close message" onclick={handleClose}>×</button>
      {/if}
    </div>
  {:else}
    <span class="placeholder">Ready</span>
  {/if}
</div>

<style>
  .header-status-bar {
    width: calc(100% - 2rem);
    max-width: 900px;
    margin: 0 auto;
    min-height: 3rem;
    display: flex;
    align-items: center;
    padding: 0.75rem 1.5rem;
    border-radius: var(--radius);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transition: all 0.3s ease-out;
  }

  .header-status-bar.success {
    background: #dcfce7;
    color: #166534;
    border: 1px solid #86efac;
  }

  .header-status-bar.error {
    background: #fee2e2;
    color: #991b1b;
    border: 1px solid #fca5a5;
  }

  .header-status-bar.info,
  .header-status-bar.confirm {
    background: #eff6ff;
    color: #1e40af;
    border: 1px solid #bfdbfe;
  }

  .header-status-content {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .message {
    flex: 1;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .close-btn {
    background: none;
    border: none;
    color: inherit;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.7;
    transition: opacity 0.15s;
  }

  .close-btn:hover {
    opacity: 1;
  }

  .confirm-buttons {
    display: flex;
    gap: 0.5rem;
  }

  .btn-confirm,
  .btn-cancel {
    padding: 0.35rem 0.8rem;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-confirm {
    background: #2563eb;
    color: white;
    border: none;
    font-weight: 500;
  }

  .btn-confirm:hover {
    background: #1d4ed8;
  }

  .btn-cancel {
    background: #e5e7eb;
    color: #374151;
    border: none;
  }

  .btn-cancel:hover {
    background: #d1d5db;
  }

  .placeholder {
    font-size: 0.9rem;
    color: var(--text-dim);
    opacity: 0.7;
  }

  @media (max-width: 600px) {
    .header-status-bar {
      width: calc(100% - 2rem);
      margin: 0.5rem 1rem;
      padding: 0.6rem 1rem;
    }
  }
</style>
