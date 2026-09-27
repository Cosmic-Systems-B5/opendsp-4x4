// WebSocket transport for remote DSP control over a HID/WebSocket bridge.
// The server proxies USB HID reports: request frames are sent to the server,
// and reply frames are received from the server.

import type { DspTransport } from "./transport.ts";

export class WebSocketTransport implements DspTransport {
  private listeners = new Set<(r: Uint8Array) => void>();
  private pending: ((r: Uint8Array | null) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  static supported(): boolean {
    return typeof WebSocket !== "undefined";
  }

  constructor(private readonly url: string) {}

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get productName(): string { return "DSP 4x4 (remote)"; }

  private ws: WebSocket | null = null;
  private messageHandler?: (e: MessageEvent) => void;

  async open(): Promise<void> {
    if (this.closed) throw new Error("transport already closed");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      // Define message handler first so we can reference it
      this.messageHandler = (e: MessageEvent) => {
        if (typeof e.data === "string") {
          // Base64-encoded binary data
          const bytes = new Uint8Array(atob(e.data).split("").map((c) => c.charCodeAt(0)));
          this.handleReport(bytes);
        } else if (e.data instanceof ArrayBuffer) {
          this.handleReport(new Uint8Array(e.data));
        }
      };

      ws.addEventListener("message", this.messageHandler);

      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (e: Event) => {
        cleanup();
        reject(new Error("WebSocket connection failed"));
      };

      const onClose = (e: CloseEvent) => {
        cleanup();
        this.closed = true;
        // Reject any pending requests
        if (this.pending) {
          const resolve = this.pending;
          this.pending = null;
          resolve(null);
        }
        // Notify listeners of closure
        for (const cb of this.listeners) {
          try { cb(new Uint8Array(0)); } catch {}
        }
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
      ws.addEventListener("close", onClose);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    if (ws && this.messageHandler) {
      ws.removeEventListener("message", this.messageHandler);
      ws.close();
      this.ws = null;
      this.messageHandler = undefined;
    }
  }

  private handleReport(report: Uint8Array): void {
    if (this.pending && !this.closed) {
      const resolve = this.pending;
      this.pending = null;
      resolve(report);
    }
    for (const cb of this.listeners) {
      try { cb(report); } catch {}
    }
  }

  onReport(cb: (r: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async request(frame: Uint8Array, timeoutMs = 1200): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");

    const run = this.chain.then(() => this.sendOne(frame, timeoutMs));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendOne(frame: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");

    // Retry pattern similar to WebHID
    const perMs = 400;
    for (let i = 0; i * perMs < timeoutMs; i++) {
      const reply = new Promise<Uint8Array | null>((resolve) => {
        this.pending = resolve;
        setTimeout(() => { if (this.pending === resolve) { this.pending = null; resolve(null); } }, perMs);

        // Send frame as base64-encoded string
        const data = btoa(String.fromCharCode(...frame));
        try {
          this.ws!.send(data);
        } catch (e) {
          if (this.pending === resolve) { this.pending = null; resolve(null); }
        }
      });

      const r = await reply;
      if (r && !this.closed) return r;
    }
    throw new Error("reply timeout");
  }
}
