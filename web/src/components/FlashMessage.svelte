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
</script>

{#if message}
  <div class={`flash flash-${confirm ? 'info' : msgType} ${confirm ? 'confirm' : ''}`}>
    <span class="message">{message}</span>
    {#if confirm}
      <div class="confirm-buttons">
        <button class="btn-confirm" onclick={handleConfirm}>OK</button>
        <button class="btn-cancel" onclick={handleCancel}>Cancel</button>
      </div>
    {:else}
      <button class="close-btn" aria-label="Close message">×</button>
    {/if}
  </div>
{/if}

<style>
  .flash {
    position: fixed;
    top: var(--safe-top, 0);
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    padding: 0.75rem 1.5rem;
    border-radius: var(--radius);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 1rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: slideDown 0.3s ease-out;
    min-width: 300px;
  }

  .flash.success {
    background: #dcfce7;
    color: #166534;
    border: 1px solid #86efac;
  }

  .flash.error {
    background: #fee2e2;
    color: #991b1b;
    border: 1px solid #fca5a5;
  }

  .flash.info,
  .flash.confirm {
    background: #eff6ff;
    color: #1e40af;
    border: 1px solid #bfdbfe;
  }

  .message {
    flex: 1;
    font-size: 0.9rem;
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

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translate(-50%, -100%);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (max-width: 600px) {
    .flash {
      left: 1rem;
      right: 1rem;
      width: auto;
      transform: none;
      padding: 0.6rem 1rem;
    }
  }
</style>
