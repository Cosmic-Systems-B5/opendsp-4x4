// WebSocket connection manager for remote DSP control.
// Manages WebSocket connections to multiple servers separately from device logic.
// Supports the bridge.js protocol with JSON-based messaging.
//
// This file is a `.svelte.ts` module so that `$state` works at the module
// level. The exported singleton is reactive.

import { WebSocketTransport } from "../transport/websocket.ts";

const STORAGE_KEY_URLS = "opendsp-ws-urls";
const STORAGE_KEY_WANTED = "opendsp-ws-wanted";

export interface ServerInfo {
  serverId: string;
  port: number;
  host: string;
  bindHost?: string;
  mockMode: boolean;
  mockDeviceCount: number;
  deviceGuids: Array<{ key: string; guid: string; publishedId: string }>;
  timestamp: string;
}

export interface DeviceInfo {
  id: string;
  kind: "hid" | "mock";
  path: string;
  deviceGuid: string;
  publishedId: string;
  product: string;
  connectedAt: string;
  subscriberCount: number;
  attached?: boolean;
}

export interface ServerConnection {
  id: string;           // === url
  url: string;
  productName: string;
  connectedAt: string | null;
  connected: boolean;
  connecting: boolean;
  serverInfo?: ServerInfo;
  lastError?: string;
  /** Devices advertised by this server. Filled from `/devices` and SSE. */
  devices: DeviceInfo[];
}

function loadUrls(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_URLS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((u) => typeof u === "string");
  } catch { /* ignore */ }
  return [];
}

function loadWanted(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_WANTED);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "boolean") out[k] = v;
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
}

function saveWanted(map: Record<string, boolean>): void {
  try { localStorage.setItem(STORAGE_KEY_WANTED, JSON.stringify(map)); } catch { /* ignore */ }
}

function saveUrls(urls: string[]): void {
  try { localStorage.setItem(STORAGE_KEY_URLS, JSON.stringify(urls)); } catch { /* ignore */ }
}

function httpBase(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://");
}

class ServerManager {
  urls = $state<string[]>(loadUrls());
  servers = $state<Record<string, ServerConnection>>({});
  #wanted: Record<string, boolean> = loadWanted();

  #transports = new Map<string, WebSocketTransport>();
  #serverInfo = new Map<string, ServerInfo>();
  #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #reconnectAttempts = new Map<string, number>();
  #closing = new Set<string>();
  #sse = new Map<string, EventSource>();

  constructor() {
    const seeded: Record<string, ServerConnection> = {};
    for (const url of this.urls) seeded[url] = this.#makeRecord(url);
    this.servers = seeded;
    this.#persist();
  }

  // --- URL list -----------------------------------------------------------

  addUrl(url: string): boolean {
    const trimmed = url.trim();
    if (!trimmed) return false;
    if (!/^wss?:\/\//i.test(trimmed)) return false;
    if (this.urls.includes(trimmed)) return false;
    this.urls = [...this.urls, trimmed];
    this.servers = { ...this.servers, [trimmed]: this.#makeRecord(trimmed) };
    this.#persist();
    return true;
  }

  removeUrl(urlOrIndex: string | number): void {
    const url = typeof urlOrIndex === "number" ? this.urls[urlOrIndex] : urlOrIndex;
    if (!url) return;
    this.disconnect(url);
    this.urls = this.urls.filter((u) => u !== url);
    const { [url]: _r, ...rest } = this.servers;
    this.servers = rest;
    delete this.#wanted[url];
    saveWanted(this.#wanted);
    this.#persist();
  }

  // --- connection control -------------------------------------------------

  isConnected(url: string): boolean { return this.servers[url]?.connected ?? false; }
  isConnecting(url: string): boolean { return this.servers[url]?.connecting ?? false; }
  getTransport(url: string): WebSocketTransport | undefined { return this.#transports.get(url); }
  getServerInfo(url: string): ServerInfo | undefined { return this.#serverInfo.get(url); }

  async connect(url: string, productName = "DSP 4x4 (remote)"): Promise<ServerConnection | null> {
    if (!this.urls.includes(url)) this.addUrl(url);
    const existing = this.servers[url];
    if (existing?.connected || existing?.connecting) return existing ?? null;

    this.#wanted[url] = true;                 // NEW
    saveWanted(this.#wanted);                 // NEW

    this.#patch(url, { connecting: true, lastError: undefined });
    this.#closing.delete(url);

    const transport = new WebSocketTransport(url);
    try {
      await transport.open();
    } catch (e) {
      this.#patch(url, {
        connecting: false,
        connected: false,
        lastError: (e as Error)?.message ?? "connect failed",
      });
      this.#scheduleReconnect(url);
      return null;
    }
    this.#transports.set(url, transport);

    const [serverInfo, devices] = await Promise.all([
      this.#fetchServerInfo(url).catch(() => undefined),
      this.#fetchDevices(url).catch(() => []),
    ]);
    if (serverInfo) this.#serverInfo.set(url, serverInfo);

    this.#patch(url, {
      connected: true,
      connecting: false,
      connectedAt: new Date().toISOString(),
      productName,
      serverInfo: serverInfo ?? this.servers[url]?.serverInfo,
      devices,
      lastError: undefined,
    });
    this.#reconnectAttempts.delete(url);
    this.#openSse(url);

    transport.onClose(() => {
      const current = this.#transports.get(url) === transport;
      if (!current) return;
      this.#transports.delete(url);
      this.#closeSse(url);
      if (this.#closing.has(url)) { this.#closing.delete(url); return; }
      this.#patch(url, { connected: false, connecting: false });
      this.#scheduleReconnect(url);
    });

    return this.servers[url] ?? null;
  }

  disconnect(url: string): void {
    this.#wanted[url] = false;
    saveWanted(this.#wanted);
    const t = this.#transports.get(url);
    this.#closing.add(url);
    this.#cancelReconnect(url);
    this.#reconnectAttempts.delete(url);
    this.#closeSse(url);
    if (t) {
      t.close().catch(() => {});
      this.#transports.delete(url);
    }
    this.#patch(url, { connected: false, connecting: false, devices: [] });
  }

  disconnectAll(): void {
    for (const url of [...this.urls]) this.disconnect(url);
  }

  async restoreConnections(): Promise<void> {
    for (const url of this.urls) {
      if (!this.#wanted[url]) continue;   // NEW: honour explicit disconnect
      void this.connect(url);
    }
  }

  // --- devices ------------------------------------------------------------

  async fetchDevices(url: string): Promise<DeviceInfo[]> {
    return this.#fetchDevices(url);
  }

  async #fetchDevices(url: string): Promise<DeviceInfo[]> {
    try {
      const res = await fetch(`${httpBase(url)}/devices`);
      if (!res.ok) return [];
      const data = (await res.json()) as { devices?: DeviceInfo[] };
      return data.devices ?? [];
    } catch (e) {
      console.warn(`Could not fetch devices from ${url}:`, e);
      return [];
    }
  }

  #openSse(url: string): void {
    this.#closeSse(url);
    try {
      const sse = new EventSource(`${httpBase(url)}/devices/changes`);
      sse.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data?.type !== "devices_update" || !Array.isArray(data.devices)) return;
          this.#patch(url, { devices: data.devices as DeviceInfo[] });
        } catch { /* ignore */ }
      };
      sse.onerror = () => { /* EventSource auto-reconnects */ };
      this.#sse.set(url, sse);
    } catch { /* ignore */ }
  }

  #closeSse(url: string): void {
    const sse = this.#sse.get(url);
    if (sse) {
      try { sse.close(); } catch { /* ignore */ }
      this.#sse.delete(url);
    }
  }

  // --- internals ----------------------------------------------------------

  #makeRecord(url: string): ServerConnection {
    return {
      id: url,
      url,
      productName: "DSP 4x4 (remote)",
      connectedAt: null,
      connected: false,
      connecting: false,
      devices: [],
    };
  }

  #patch(url: string, patch: Partial<ServerConnection>): void {
    const prev = this.servers[url] ?? this.#makeRecord(url);
    this.servers = { ...this.servers, [url]: { ...prev, ...patch } };
  }

  #persist(): void {
    saveUrls(this.urls);
  }

  async #fetchServerInfo(url: string): Promise<ServerInfo | undefined> {
    try {
      const res = await fetch(`${httpBase(url)}/server-info`);
      if (!res.ok) return undefined;
      return (await res.json()) as ServerInfo;
    } catch (e) {
      console.warn(`Could not fetch server info from ${url}:`, e);
      return undefined;
    }
  }

  #scheduleReconnect(url: string): void {
    if (this.#closing.has(url) || this.#reconnectTimers.has(url)) return;
    const attempt = (this.#reconnectAttempts.get(url) ?? 0) + 1;
    this.#reconnectAttempts.set(url, attempt);
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt - 1, 4));
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(url);
      if (this.#closing.has(url) || !this.urls.includes(url)) return;
      void this.connect(url);
    }, delay);
    this.#reconnectTimers.set(url, timer);
  }

  #cancelReconnect(url: string): void {
    const t = this.#reconnectTimers.get(url);
    if (t) clearTimeout(t);
    this.#reconnectTimers.delete(url);
  }
}

export const serverManager = new ServerManager();