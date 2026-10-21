<script lang="ts">
  import { device, deviceManager } from "./state/device.ts";
  import PatchBoard from "./components/PatchBoard.svelte";
  import TuningView from "./components/TuningView.svelte";
  import SystemView from "./components/SystemView.svelte";
  import FlashMessage from "./components/FlashMessage.svelte";

  // Load saved view mode from localStorage, default to "tuning"
  const savedViewMode = typeof localStorage !== "undefined" ? localStorage.getItem("opendsp-view-mode") : null;
  let viewMode = $state<"tuning" | "routing" | "system">(savedViewMode ?? "tuning");

  // Save view mode to localStorage when it changes
  $effect(() => {
    try {
      localStorage.setItem("opendsp-view-mode", viewMode);
    } catch (e) {
      // Ignore storage errors
    }
  });

  // Initialize and restore connection state on page load
  $effect(() => {
    const init = async () => {
      try {
        // Restore device manager state (devices, servers)
        deviceManager.restoreConnectionState();

        // Restore device connection state (serverGuid, deviceGuid)
        device.restoreConnectionState();

        console.log('Connection state restored');

        // Auto-connect to saved server URLs if available
        const urls = device.webSocketUrls;
        if (urls.length > 0) {
          for (const url of urls) {
            try {
              console.log(`Attempting auto-connect to ${url}...`);
              await device.connect(url);
              break; // Stop after first successful connection
            } catch (e) {
              console.warn(`Auto-connect failed to ${url}:`, e);
            }
          }
        }
      } catch (e) {
        console.error('Error restoring connection state:', e);
      }
    };

    init();
  });

  // Flash message state - supports both auto-dismissing messages and confirmations
  let flashMessage = $state<{ text: string; type: 'success' | 'error' | 'info'; confirm?: boolean } | null>(null);

  // Confirmation callback storage
  let confirmationCallback: ((confirmed: boolean) => void) | null = null;

  function showFlash(text: string, type: 'success' | 'error' | 'info' = 'info', confirm = false): Promise<boolean> {
    return new Promise((resolve) => {
      flashMessage = { text, type, confirm };

      if (confirm) {
        // Store the callback for when user confirms or cancels
        confirmationCallback = resolve;

        // Also listen for the custom event from FlashMessage component
        const handleConfirm = (e: Event) => {
          const detail = (e as CustomEvent).detail;
          if (detail?.confirmed !== undefined) {
            if (confirmationCallback) {
              confirmationCallback(detail.confirmed);
              confirmationCallback = null;
            }
            // Only clear flash message after callback is called
            window.setTimeout(() => {
              if (flashMessage?.text === text) {
                flashMessage = null;
              }
            }, 100);
          }
        };

        window.addEventListener('flash-confirm', handleConfirm);
      } else {
        // Auto-clear after 4 seconds for regular messages
        window.setTimeout(() => {
          if (flashMessage?.text === text && flashMessage.type === type) {
            flashMessage = null;
          }
        }, 4000);
      }
    });
  }

  // Export for use in other components
  (globalThis as any).showFlash = showFlash;

  // Listen for flash events from child components (in case they dispatch custom events)
  $effect(() => {
    const handleFlash = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.text) {
        showFlash(detail.text, detail.type || 'info', detail.confirm || false);
      }
    };
    window.addEventListener('flash', handleFlash);
    return () => window.removeEventListener('flash', handleFlash);
  });
</script>

<FlashMessage message={flashMessage?.text || ''} type={flashMessage?.type || 'info'} confirm={!!flashMessage?.confirm} />

<header class="top">
  <strong>cosmicDSP-4x4</strong>
  <div class="view-toggle">
    <button class="view-btn" class:active={viewMode === "tuning"} onclick={() => (viewMode = "tuning")}>Tuning</button>
    <button class="view-btn" class:active={viewMode === "routing"} onclick={() => (viewMode = "routing")}>Routing</button>
    <button class="view-btn" class:active={viewMode === "system"} onclick={() => (viewMode = "system")}>System</button>
  </div>
  <span class="spacer"></span>
  <span class="dot" class:ok={device.connected}></span>
  <span class="status" class:ok={device.connected}>{device.connected ? device.version || device.productName : device.error || "Not connected"}</span>
</header>

{#if !device.connected}
<div class="warn-box">
    Not connected. Select System to configure connection.
</div>
{/if}

{#if viewMode === "routing"}
  <PatchBoard />
{:else if viewMode === "tuning"}
  <TuningView />
{:else}
  <SystemView />
{/if}

<footer class="agpl muted">
  a cosmic mutation of openDSP-4x4 · <a href="https://www.gnu.org/licenses/agpl-3.0.html">AGPL-3.0</a> ·
  <a href="https://github.com/GlassOnTin/opendsp-4x4">source</a> ·
  <a href="https://ko-fi.com/glassontin">Ko-fi ☕</a> · not affiliated with Thomann
</footer>

<style>
  .top { display: flex; align-items: center; gap: .55rem; padding: calc(.6rem + var(--safe-top, 0px)) 1rem .6rem; border-bottom: 1px solid var(--line); background: var(--bg-panel); }
  .view-toggle { display: flex; gap: .25rem; background: var(--bg-elev); padding: .15rem; border-radius: var(--radius); }
  .view-btn { padding: .35rem .7rem; border: none; border-radius: 6px; background: transparent; color: var(--text-dim);
              font-size: .8rem; cursor: pointer; transition: all .15s; }
  .view-btn:hover { color: var(--text); background: rgba(255,255,255,.05); }
  .view-btn.active { background: var(--accent); color: #0a0d12; font-weight: 600; box-shadow: var(--glow); }
  .spacer { flex: 1; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 8px var(--bad); }
  .dot.ok { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .status { font-size: .82rem; color: var(--text-dim); max-width: 22ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status.ok { color: var(--good); }
  .warn-box { margin: .6rem 1rem; background: #4a2b00; color: #ffd9a0; padding: .55rem .8rem; border-radius: var(--radius); }
  .agpl { padding: 1rem; border-top: 1px solid var(--line); font-size: .72rem; text-align: center; margin-top: auto; }
  .agpl a { color: var(--accent); }
</style>
