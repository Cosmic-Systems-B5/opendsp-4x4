// WebSocket connection manager for remote DSP control.
// Manages WebSocket connections to multiple servers separately from device logic.
// Supports the new bridge.js protocol with JSON-based messaging.

import { WebSocketTransport } from "../transport/websocket.ts";

export interface ServerInfo {
  serverId: string;
  port: number;
  host: string;
  mockMode: boolean;
  mockDeviceCount: number;
  deviceGuids: Array<{ key: string; guid: string; publishedId: string }>;
  timestamp: string;
}

export interface DeviceInfo {
  id: string;
  kind: 'hid' | 'mock';
  path: string;
  deviceGuid: string;
  publishedId: string;
  product: string;
  connectedAt: string;
  subscriberCount: number;
}

export interface ServerConnection {
  id: string;
  url: string;
  productName: string;
  connectedAt: string;
  serverInfo?: ServerInfo;
}

class WebSocketManagerState {
  private connections: Map<string, { transport: WebSocketTransport; server: ServerConnection }> = new Map();
  private nextId = 0;

// // WebSocket URLs for multiple servers - stored in localStorage
//   function loadWebSocketUrls(): string[] {
//     try {
//       const saved = localStorage.getItem("opendsp-ws-urls");
//       if (saved) return JSON.parse(saved);
//     } catch (e) {}
//     return [];
//   }
//
//   function saveWebSocketUrls(urls: string[]): void {
//     try {
//       localStorage.setItem("opendsp-ws-urls", JSON.stringify(urls));
//     } catch (e) {}
//   }
//
// // Store for WebSocket URLs
//   let webSocketUrls = $state<string[]>(loadWebSocketUrls());


  // get webSocketUrls(): string[] {
  //   return webSocketUrls;
  // }

  /**
   * Get all active server connections (reactive list)
   */
  getConnections(): ServerConnection[] {
    return Array.from(this.connections.values()).map(c => c.server);
  }

  /**
   * Check if a server is connected
   */
  isConnected(url: string): boolean {
    return this.connections.has(url);
  }

  /**
   * Get connection state for all URLs (for reactive UI)
   */
  getConnectionStates(): Record<string, boolean> {
    const states: Record<string, boolean> = {};
    for (const url of this.connections.keys()) {
      states[url] = true;
    }
    return states;
  }

  /**
   * Fetch server info from a WebSocket server's HTTP endpoint
   */
  async fetchServerInfo(url: string): Promise<ServerInfo | null> {
    try {
      const httpUrl = url.replace(/^ws/, 'http');
      const res = await fetch(`${httpUrl}/server-info`);
      if (res.ok) {
        console.log("fetchServerInfo", res.json())
        return await res.json();
      }
    } catch (e) {
      console.warn(`Could not fetch server info from ${url}:`, e);
    }
    return null;
  }

  /**
   * Fetch list of devices from a WebSocket server
   */
  async fetchDevices(url: string): Promise<DeviceInfo[]> {
    try {
      const httpUrl = url.replace(/^ws/, 'http');
      const res = await fetch(`${httpUrl}/devices`);
      if (res.ok) {
        console.log("fetchDevices", res.json())
        const data = await res.json();
        return data.devices || [];
      }
    } catch (e) {
      console.warn(`Could not fetch devices from ${url}:`, e);
    }
    return [];
  }

  /**
   * Connect to a WebSocket server
   */
  async connect(url: string, productName: string): Promise<ServerConnection | null> {
    // Check if already connected
    if (this.connections.has(url)) {
      console.warn(`WebSocket connection to ${url} already exists`);
      return null;
    }

    try {
      const transport = new WebSocketTransport(url);
      await transport.open();

      // Fetch server info after connecting
      const serverInfo = await this.fetchServerInfo(url);

      const server: ServerConnection = {
        id: `ws-${this.nextId++}`,
        url,
        productName,
        connectedAt: new Date().toISOString(),
        serverInfo: serverInfo || undefined
      };

      this.connections.set(url, { transport, server });
      console.log(`WebSocket connection established to ${url}`);
      return server;
    } catch (e) {
      console.error(`Failed to connect to WebSocket server ${url}:`, e);
      throw e;
    }
  }

  /**
   * Disconnect from a WebSocket server
   */
  disconnect(url: string): void {
    const conn = this.connections.get(url);
    if (conn) {
      conn.transport.close().catch(() => {});
      this.connections.delete(url);
      console.log(`WebSocket connection closed to ${url}`);
    }
  }

  /**
   * Disconnect all WebSocket connections
   */
  disconnectAll(): void {
    for (const [url] of this.connections.entries()) {
      this.disconnect(url);
    }
  }

  /**
   * Get the transport for a specific URL
   */
  getTransport(url: string): WebSocketTransport | undefined {
    const conn = this.connections.get(url);
    return conn?.transport;
  }

  /**
   * Get server info for a specific URL
   */
  getServerInfo(url: string): ServerInfo | undefined {
    const conn = this.connections.get(url);
    return conn?.server.serverInfo;
  }
}

export const serverManager = new WebSocketManagerState();
