// mDNS browser for discovering openDSP servers on the local network
import { DnsSdBrowser } from 'dns-sd-browser';

const BONJOUR_SERVICE_NAME = '_opendsp-ws._tcp.local';

export interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  type: string;
  protocol: string;
  lastSeen: number;
}

// Callbacks for when the server list changes
let serverListCallbacks: Set<(servers: DiscoveredServer[]) => void> = new Set();

/**
 * Register a callback for when the server list changes
 */
export function onServersChange(callback: (servers: DiscoveredServer[]) => void): () => void {
  serverListCallbacks.add(callback);
  return () => serverListCallbacks.delete(callback);
}

class MdnsBrowserClass {
  private browser: DnsSdBrowser | null = null;
  private servers: Map<string, DiscoveredServer> = new Map();
  private listeners: Set<(servers: DiscoveredServer[]) => void> = new Set();

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.browser = DnsSdBrowser.create();

        this.browser.on('serviceUp', (service: any) => {
          if (service.type === BONJOUR_SERVICE_NAME && service.protocol === 'tcp') {
            const server: DiscoveredServer = {
              name: service.name,
              host: service.host || 'localhost',
              port: service.port,
              type: 'opendsp-ws',
              protocol: 'tcp',
              lastSeen: Date.now()
            };
            this.servers.set(service.id, server);
            this.notifyListeners();
            console.log(`Found openDSP server: ${service.name} at ws://${server.host}:${server.port}`);
          }
        });

        this.browser.on('serviceDown', (service: any) => {
          if (service.type === BONJOUR_SERVICE_NAME && service.protocol === 'tcp') {
            this.servers.delete(service.id);
            this.notifyListeners();
            console.log(`openDSP server removed: ${service.name}`);
          }
        });

        this.browser.start();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.browser) {
        this.browser.stop();
        this.browser = null;
      }
      this.servers.clear();
      resolve();
    });
  }

  getServers(): DiscoveredServer[] {
    // Clean up stale entries (older than 30 seconds)
    const now = Date.now();
    for (const [key, server] of this.servers.entries()) {
      if (now - server.lastSeen > 30000) {
        this.servers.delete(key);
      }
    }
    return Array.from(this.servers.values());
  }

  onServersChange(callback: (servers: DiscoveredServer[]) => void): () => void {
    this.listeners.add(callback);
    // Return unsubscribe function
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notifyListeners() {
    const servers = this.getServers();
    for (const listener of this.listeners) {
      try {
        listener(servers);
      } catch (e) {
        console.error('Error in mDNS server change listener:', e);
      }
    }
    // Also call global callbacks
    for (const callback of serverListCallbacks) {
      try {
        callback(servers);
      } catch (e) {
        console.error('Error in global server list callback:', e);
      }
    }
  }
}

export const mdnsBrowser = new MdnsBrowserClass();
