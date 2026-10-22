// WebSocket transport for remote DSP control over a HID/WebSocket bridge.
// The server proxies USB HID reports: request frames are sent to the server,
// and reply frames are received from the server.
//
// Protocol format (bridge.js v3):
//   JSON messages with `type`:
//     - 'report': device response data, base64-encoded in `data`
//     - 'request': host command, base64-encoded in `data`
//     - 'subscribed': confirmation of device subscription
//     - 'unsubscribed': confirmation of unsubscription
//     - 'settings_update': device settings change notification
//     - 'devices': list of available devices (serverId + devices array)
//     - 'device_gone': device disconnected
//     - 'error': error response
//
// Identifier model (matches bridge.js):
//   SERVER_ID = 5-char alphanumeric server id (e.g. "Q7X2K")
//   guid      = "DSP" + 5-char alphanumeric (e.g. "DSP7C4H9")
//   serverid  = SERVER_ID  (server identity; same for every device on a bridge)
//
// Every message carries BOTH `guid` and `serverid`. The pair (serverid, guid)
// is the globally unique device identity. Within one bridge `guid` alone is
// unique, so a shared WebSocketTransport may serve many devices; each Dsp
// sends its own `guid` on every request and the transport routes each reply
// back to the matching pending request.

import type { DspTransport } from "./transport.ts";

export interface DeviceReport {
  type: 'report';
  guid: string;
  serverid: string;
  data: string; // base64-encoded binary
}

export interface RequestMessage {
  type: 'request';
  guid?: string;
  data: string; // base64-encoded frame
}

export interface SubscribedMessage {
  type: 'subscribed';
  guid: string;
  serverid: string;
  product: string;
  kind: 'hid' | 'mock';
  subscriberCount?: number;
  alreadySubscribed?: boolean;
}

export interface UnsubscribedMessage {
  type: 'unsubscribed';
  guid: string | null;
  serverid: string | null;
  subscriberCount: number | null;
}

export interface SettingsUpdateMessage {
  type: 'settings_update';
  guid: string;
  serverid: string;
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
    guid: string;
    serverid: string;
    kind: 'hid' | 'mock';
    path: string;
    product: string;
    connectedAt: string;
    subscriberCount: number;
    subscribed: boolean;
  }>;
}

export interface DeviceGoneMessage {
  type: 'device_gone';
  guid: string;
  serverid: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message?: string;
  guid?: string;
}

export type BridgeMessage =
    | DeviceReport
    | SubscribedMessage
    | UnsubscribedMessage
    | SettingsUpdateMessage
    | DevicesMessage
    | DeviceGoneMessage
    | ErrorMessage;

const WS_DEBUG = true;
function wlog(...args: unknown[]) {
  if (WS_DEBUG) console.log('%c[ws]', 'color:#8fa5c4', ...args);
}

/**
 * WebSocketTransport
 *
 * - One socket per server.
 * - Reports for a specific device are routed via `pendingFor` = the guid of the
 *   in-flight request. Reports for other devices on the same socket still reach
 *   generic `message` listeners, so a DeviceSvelte that filters by guid sees
 *   exactly its own traffic.
 * - `send(text)` for fire-and-forget JSON (subscribe / unsubscribe / requests).
 */
export class WebSocketTransport implements DspTransport {
  /** Raw-byte listeners (unfiltered; consumer filters). */
  private listeners = new Set<(r: Uint8Array) => void>();
  /** Typed-message listeners (unfiltered; consumer filters). */
  private msgListeners = new Set<(m: BridgeMessage) => void>();
  private pending: ((r: Uint8Array | null) => void) | null = null;
  private pendingFor: string | null = null; // guid we're waiting on
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** Informational — the most recent subscribed ack on this socket. */
  public guid?: string;
  public serverid?: string;
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

      this.messageHandler = (e: MessageEvent) => {
        // Debug: show every raw frame that reaches the transport.
        if (typeof e.data === 'string') {
          try {
            const m = JSON.parse(e.data);
            wlog('RX raw', m.type,
                'guid=' + (m.guid ?? '-'),
                'serverid=' + (m.serverid ?? '-'),
                'dataLen=' + (m.data ? m.data.length : '-'));
          } catch {
            wlog('RX raw (non-JSON)', e.data.slice(0, 80));
          }
        } else if (e.data instanceof ArrayBuffer) {
          wlog('RX raw (binary)', 'bytes=' + e.data.byteLength);
        }

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
    wlog('dispatch', msg.type,
        'guid=' + ((msg as any).guid ?? '-'),
        'serverid=' + ((msg as any).serverid ?? '-'));

    // Fan out to typed listeners (unfiltered — consumers filter by guid+serverid).
    for (const cb of this.msgListeners) {
      try { cb(msg); } catch { /* ignore */ }
    }

    switch (msg.type) {
      case 'report': {
        this.handleReportMessage(msg);
        return;
      }
      case 'subscribed':
        this.handleSubscribedMessage(msg);
        return;
      case 'settings_update':
        return;
      case 'devices':
        return;
      case 'unsubscribed':
      case 'device_gone':
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
      wlog('handleReportMessage', 'guid=' + msg.guid, 'bytes=' + bytes.length,
          'head=' + Array.from(bytes.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
      this.handleReport(bytes, msg.guid);
    } catch (err) {
      console.warn(`WebSocket: Failed to decode report data`, err);
    }
  }

  private handleSubscribedMessage(msg: SubscribedMessage): void {
    this.guid = msg.guid;
    this.serverid = msg.serverid;
    this.productName = msg.product;
    this.kind = msg.kind;
    console.log(`Subscribed to device: ${msg.guid} (${msg.kind}) on ${msg.serverid}`);
  }

  private handleReport(report: Uint8Array, guid: string | undefined): void {
    const hadPending = this.pending !== null;
    const matches = this.pendingFor === null || guid === this.pendingFor;

    wlog('handleReport', 'guid=' + (guid ?? '-'),
        'hadPending=' + hadPending,
        'pendingFor=' + (this.pendingFor ?? '-'),
        'matches=' + matches);

    if (this.pending && matches) {
      const resolve = this.pending;
      this.pending = null;
      this.pendingFor = null;
      resolve(report);
    } else if (this.pending) {
      wlog('  report does not match pendingFor — dropped for resolver');
    } else {
      wlog('  no pending request (report is unsolicited)');
    }

    for (const cb of this.listeners) {
      try { cb(report); } catch { /* ignore */ }
    }
  }

  // --- public API --------------------------------------------------------

  /** Send a raw JSON text frame. */
  send(text: string): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocketTransport: socket not open");
    }
    this.ws.send(text);
  }

  sendMessage(msg: object): void {
    this.send(JSON.stringify(msg));
  }

  onClose(cb: () => void): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    this.ws.addEventListener("close", cb);
  }

  onCloseListener(cb: () => void): () => void {
    if (!this.ws) return () => {};
    this.ws.addEventListener("close", cb);
    return () => { try { this.ws?.removeEventListener("close", cb); } catch { /* ignore */ } };
  }

  addEventListener(type: 'open' | 'close' | 'message', cb: (ev: any) => void): void {
    if (!this.ws) throw new Error("WebSocketTransport: not opened");
    this.ws.addEventListener(type, cb as EventListener);
  }

  removeEventListener(type: 'open' | 'close' | 'message', cb: (ev: any) => void): void {
    if (!this.ws) return;
    this.ws.removeEventListener(type, cb as EventListener);
  }

  onMessage(cb: (msg: BridgeMessage) => void): () => void {
    this.msgListeners.add(cb);
    return () => { this.msgListeners.delete(cb); };
  }

  onReport(cb: (r: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * Send a request frame and wait for the next report from the same device.
   * Serialized through `chain` so overlapping callers can't interleave replies.
   * The `guid` is forwarded to the bridge so the reply can be routed back.
   */
  async request(frame: Uint8Array, timeoutMs = 1200, guid?: string): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");
    const run = this.chain.then(() => this.sendOne(frame, timeoutMs, guid));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendOne(frame: Uint8Array, timeoutMs: number, guid: string | undefined): Promise<Uint8Array> {
    if (!this.ws || this.closed) throw new Error("transport not open");

    const perMs = 400;
    for (let i = 0; i * perMs < timeoutMs; i++) {
      const reply = new Promise<Uint8Array | null>((resolve) => {
        this.pending = resolve;
        this.pendingFor = guid ?? null;
        wlog('  attempt', i, 'pendingFor=' + (this.pendingFor ?? '-'));
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
          if (guid) msg.guid = guid;
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