// WebSocket transport for remote DSP control over a HID/WebSocket bridge.
// The server proxies USB HID reports: request frames are sent to the server,
// and reply frames are received from the server.
//
// Protocol format (bridge.js v2):
//   JSON messages with type field:
//     - 'report': device response data, base64-encoded in 'data' field
//     - 'request': host command, base64-encoded in 'data' field
//     - 'subscribed': confirmation of device subscription
//     - 'settings_update': device settings change notification
//     - 'devices': list of available devices (serverId + devices array)
//
// Device identifiers:
//   - deviceGuid: "DSP" + 5-char alphanumeric (stable per physical device)
//   - publishedId: "SERVER_ID-DSP_GUID" (e.g., "Q7X2K-DSP7C4H9")

import type { DspTransport } from "./transport.ts";

export interface DeviceReport {
  type: 'report';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
  data: string; // base64-encoded binary
}

export interface RequestMessage {
  type: 'request';
  deviceId?: string;
  data: string; // base64-encoded frame
}

export interface SubscribedMessage {
  type: 'subscribed';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
  product: string;
  kind: 'hid' | 'mock';
}

export interface SettingsUpdateMessage {
  type: 'settings_update';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
  timestamp: string;
  channels: Array<{
    index: number;
    name: string;
    gainDb: number;
    mute: boolean;
    polarity: boolean;
    delayMs: number | null;
    eq: {
      hpf: { freqHz: number; slope: number };
      lpf: { freqHz: number; slope: number };
      bands: Array<{ type: number; freqHz: number; gainDb: number; bwOct: number }>;
    };
  }>;
  routing: number[];
}

export interface DevicesMessage {
  type: 'devices';
  serverId: string;
  devices: Array<{
    id: string;
    kind: 'hid' | 'mock';
    path: string;
    deviceGuid: string;
    publishedId: string;
    product: string;
    connectedAt: string;
    subscribed: boolean;
  }>;
}

export class WebSocketTransport implements DspTransport {
  private listeners = new Set<(r: Uint8Array) => void>();
  private pending: ((r: Uint8Array | null) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  // Device info from subscription
  public deviceGuid?: string;
  public publishedId?: string;
  public productName = "DSP 4x4 (remote)";
  public kind: 'hid' | 'mock' = 'hid';

  static supported(): boolean {
    return typeof WebSocket !== "undefined";
  }

  constructor(public readonly url: string) {}

  get isOpen(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private ws: WebSocket | null = null;
  private messageHandler?: (e: MessageEvent) => void;

  async open(): Promise<void> {
    if (this.closed) throw new Error("transport already closed");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      // Define message handler first so we can reference it
      this.messageHandler = (e: MessageEvent) => {
        try {
          if (typeof e.data === "string") {
            const msg = JSON.parse(e.data);

            // Handle different message types from bridge.js
            switch (msg.type) {
              case 'report':
                this.handleReportMessage(msg);
                break;
              case 'subscribed':
                this.handleSubscribedMessage(msg);
                break;
              case 'settings_update':
                this.handleSettingsUpdate(msg);
                break;
              case 'devices':
                console.log('Device list update:', msg.devices);
                break;
            }
          } else if (e.data instanceof ArrayBuffer) {
            // Handle raw binary data (legacy fallback)
            this.handleReport(new Uint8Array(e.data));
          }
        } catch (err) {
          console.warn(`WebSocket: Failed to parse message`, err);
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

  /**
   * Parse a report message and extract the binary data
   */
  private handleReportMessage(msg: DeviceReport): void {
    try {
      if (typeof msg.data === 'string') {
        // Base64-encoded binary data - decode properly using atob
        const decoded = atob(msg.data);
        const bytes = new Uint8Array(decoded.length).map((_, i) => decoded.charCodeAt(i));
        this.handleReport(bytes);
      }
    } catch (err) {
      console.warn(`WebSocket: Failed to decode report data`, err);
    }
  }

  /**
   * Handle subscription confirmation message
   */
  private handleSubscribedMessage(msg: SubscribedMessage): void {
    this.deviceGuid = msg.deviceGuid;
    this.publishedId = msg.publishedId;
    this.productName = msg.product;
    this.kind = msg.kind;
    console.log(`Subscribed to device: ${msg.publishedId} (${msg.kind})`);
  }

  /**
   * Handle settings update message
   */
  private handleSettingsUpdate(msg: SettingsUpdateMessage): void {
    // This is informational - the transport doesn't act on it directly
    // but we could notify listeners if needed
    console.debug('Settings update received', msg);
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

        // Send frame as base64-encoded JSON message
        const data = btoa(String.fromCharCode(...frame));
        try {
          const msg: RequestMessage = { type: 'request', data };
          this.ws!.send(JSON.stringify(msg));
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
