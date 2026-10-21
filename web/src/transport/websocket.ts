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
// DeviceSvelte identifiers:
//   - deviceGuid: "DSP" + 5-char alphanumeric (stable per physical device)
//   - publishedId: "SERVER_ID-DSP_GUID" (e.g., "Q7X2K-DSP7C4H9")

import type { DspTransport } from "./transport.ts";

export interface DeviceReport {
  type: 'report';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
  data: string;
}

export interface RequestMessage {
  type: 'request';
  deviceId?: string;
  data: string;
}

export interface SubscribedMessage {
  type: 'subscribed';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
  product: string;
  kind: 'hid' | 'mock';
  subscriberCount?: number;
  alreadySubscribed?: boolean;
}

export interface UnsubscribedMessage {
  type: 'unsubscribed';
  deviceId: string;
  deviceGuid: string | null;
  publishedId: string | null;
  subscriberCount: number | null;
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

export interface DeviceGoneMessage {
  type: 'device_gone';
  deviceId: string;
  deviceGuid: string;
  publishedId: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message?: string;
  deviceId?: string;
}

export type BridgeMessage =
    | DeviceReport
    | SubscribedMessage
    | UnsubscribedMessage
    | SettingsUpdateMessage
    | DevicesMessage
    | DeviceGoneMessage
    | ErrorMessage;

/**
 * WebSocketTransport
 *
 * - One socket per server.
 * - Reports for a *specific* device are filtered to that device's bound
 *   listeners via `onReport` / `request`. Reports from other devices on the
 *   same socket are still delivered to generic `message` listeners, so a
 *   DeviceSvelte that filters by deviceId itself also works.
 * - `send(text)` for fire-and-forget JSON (subscribe / unsubscribe / requests).
 */
export class WebSocketTransport implements DspTransport {
  /** Raw-byte listeners, already filtered to the bound device. */
  private listeners = new Set<(r: Uint8Array) => void>();
  /** Typed-message listeners, unfiltered (consumer filters on deviceId). */
  private msgListeners = new Set<(m: BridgeMessage) => void>();
  private pending: ((r: Uint8Array | null) => void) | null = null;
  private pendingFor: string | null = null; // deviceId we're waiting on
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  // DeviceSvelte info from subscription
  public deviceGuid?: string;
  public publishedId?: string;
  public productName = "DSP 4x4 (remote)";
  public kind: 'hid' | 'mock' = 'hid';

  /**
   * When non-null, only reports / settings_update / subscribed / device_gone
   * for this deviceId reach the raw listener set. When null (before any
   * `subscribe()`), the socket acts as a "server-level" transport that does
   * not filter — used by server-manager to listen for `devices` broadcasts.
   */
  public boundDeviceId: string | null = null;

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

      this.messageHandler = (e: MessageEvent) => {
        try {
          if (typeof e.data === "string") {
            const msg = JSON.parse(e.data) as BridgeMessage;
            this.dispatch(msg);
          } else if (e.data instanceof ArrayBuffer) {
            this.handleReport(new Uint8Array(e.data), undefined);
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

      const onOpen = () => { cleanup(); resolve(); };
      const onError = (_e: Event) => { cleanup(); reject(new Error("WebSocket connection failed")); };
      const onClose = (_e: CloseEvent) => {
        cleanup();
        this.closed = true;
        if (this.pending) {
          const resolve = this.pending;
          this.pending = null;
          this.pendingFor = null;
          resolve(null);
        }
        for (const cb of this.listeners) {
          try { cb(new Uint8Array(0)); } catch { /* ignore */ }
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
      try { ws.close(); } catch { /* ignore */ }
      this.ws = null;
      this.messageHandler = undefined;
    }
  }

  // --- message dispatch ---------------------------------------------------

  private dispatch(msg: BridgeMessage): void {
    // Always fan out to typed listeners (consumers filter on deviceId).
    for (const cb of this.msgListeners) {
      try { cb(msg); } catch { /* ignore */ }
    }

    switch (msg.type) {
      case 'report': {
        // Filter to *this transport's* bound device (if any).
        if (this.boundDeviceId && msg.deviceId !== this.boundDeviceId) return;
        this.handleReportMessage(msg);
        return;
      }
      case 'subscribed':
        if (!this.boundDeviceId || msg.deviceId === this.boundDeviceId) {
          this.handleSubscribedMessage(msg);
        }
        return;
      case 'settings_update':
        // Informational for the transport; consumers do the parsing.
        return;
      case 'devices':
        // Server-level; typed listeners handle it.
        return;
      case 'unsubscribed':
      case 'device_gone':
        // Informational for the transport; consumers handle it.
        return;
      case 'error':
        console.warn(`[bridge] ${msg.code}${msg.message ? `: ${msg.message}` : ''}`);
        return;
    }
  }

  private handleReportMessage(msg: DeviceReport): void {
    try {
      const decoded = atob(msg.data);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      this.handleReport(bytes, msg.deviceId);
    } catch (err) {
      console.warn(`WebSocket: Failed to decode report data`, err);
    }
  }

  private handleSubscribedMessage(msg: SubscribedMessage): void {
    // If this transport is already bound to a device, don't let a *different*
    // device's subscribe ack overwrite our identity.
    if (this.boundDeviceId && msg.deviceId !== this.boundDeviceId) return;
    this.deviceGuid = msg.deviceGuid;
    this.publishedId = msg.publishedId;
    this.productName = msg.product;
    this.kind = msg.kind;
    if (!this.boundDeviceId) this.boundDeviceId = msg.deviceId;
    console.log(`Subscribed to device: ${msg.publishedId} (${msg.kind})`);
  }

  private handleReport(report: Uint8Array, deviceId: string | undefined): void {
    // Only resolve a pending request if it belongs to the device we asked for.
    if (this.pending) {
      if (this.pendingFor === null || deviceId === this.pendingFor) {
        const resolve = this.pending;
        this.pending = null;
        this.pendingFor = null;
        resolve(report);
      }
    }
    for (const cb of this.listeners) {
      try { cb(report); } catch { /* ignore */ }
    }
  }

  // --- public API --------------------------------------------------------

  /**
   * Send a raw JSON text frame. Used for fire-and-forget actions
   * (subscribe, unsubscribe, and per-device requests).
   */
  send(text: string): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocketTransport: socket not open");
    }
    this.ws.send(text);
  }

  /** Convenience: send a typed message object as JSON. */
  sendMessage(msg: object): void {
    this.send(JSON.stringify(msg));
  }

  onClose(cb: () => void): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    this.ws.addEventListener("close", cb);
  }

  addEventListener(type: 'open' | 'close' | 'message', cb: (ev: any) => void): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    this.ws.addEventListener(type, cb as EventListener);
  }

  removeEventListener(type: 'open' | 'close' | 'message', cb: (ev: any) => void): void {
    if (!this.ws) return;
    this.ws.removeEventListener(type, cb as EventListener);
  }

  onCloseListener(cb: () => void): () => void {
    if (!this.ws) return () => {};
    this.ws.addEventListener('close', cb);
    return () => { try { this.ws?.removeEventListener('close', cb); } catch { /* ignore */ } };
  }

  /**
   * Register a listener for typed bridge messages (unfiltered). Consumers
   * filter on `msg.deviceId` themselves. Returns an unsubscribe function.
   */
  onMessage(cb: (msg: BridgeMessage) => void): () => void {
    this.msgListeners.add(cb);
    return () => { this.msgListeners.delete(cb); };
  }

  /**
   * Register a listener for *this device's* reports only. Returns an
   * unsubscribe function.
   */
  onReport(cb: (r: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Send a request frame and wait for the next report *from the same device*.
   * Serialized through `chain` so overlapping callers can't interleave
   * replies.
   */
  async request(frame: Uint8Array, timeoutMs = 1200, deviceId?: string): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");
    const run = this.chain.then(() => this.sendOne(frame, timeoutMs, deviceId ?? this.boundDeviceId ?? undefined));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendOne(frame: Uint8Array, timeoutMs: number, deviceId: string | undefined): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");

    const perMs = 400;
    for (let i = 0; i * perMs < timeoutMs; i++) {
      const reply = new Promise<Uint8Array | null>((resolve) => {
        this.pending = resolve;
        this.pendingFor = deviceId ?? null;
        setTimeout(() => {
          if (this.pending === resolve) {
            this.pending = null;
            this.pendingFor = null;
            resolve(null);
          }
        }, perMs);

        let binary = '';
        for (let b = 0; b < frame.length; b++) binary += String.fromCharCode(frame[b]!);
        const data = btoa(binary);
        try {
          const msg: RequestMessage = { type: 'request', data };
          if (deviceId) msg.deviceId = deviceId;
          this.send(JSON.stringify(msg));
        } catch {
          if (this.pending === resolve) {
            this.pending = null;
            this.pendingFor = null;
            resolve(null);
          }
        }
      });

      const r = await reply;
      if (r && !this.closed) return r;
    }
    throw new Error("reply timeout");
  }
}