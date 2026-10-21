// WebSocket connection manager for remote DSP control.
// Manages WebSocket connections to multiple servers separately from device logic.

import { WebSocketTransport } from "../transport/websocket.ts";

export interface ServerConnection {
  id: string;
  url: string;
  productName: string;
  connectedAt: string;
}

class WebSocketManagerState {
  private connections: Map<string, { transport: WebSocketTransport; server: ServerConnection }> = new Map();
  private nextId = 0;

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

      const server: ServerConnection = {
        id: `ws-${this.nextId++}`,
        url,
        productName,
        connectedAt: new Date().toISOString()
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
   * Get all active server connections
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
}

export const websocketManager = new WebSocketManagerState();
