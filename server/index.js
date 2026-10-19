// WebSocket to USB HID bridge for openDSP-4x4
// This server connects to a local DSP device via WebHID and proxies requests
// from remote WebSocket clients.

import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { MdnsBrowser, Advertisement } from '@homebridge/ciao';
import dnsSd from 'node-dns-sd';

const MOCK_MODE = process.env.MOCK_MODE === 'true';

// Try to load node-hid for HID access
let NodeHid;
try {
  // Use dynamic import since node-hid might not be installed
  const hidModule = await import('node-hid');
  NodeHid = hidModule.default || hidModule;
} catch (e) {
  console.warn('node-hid not available. Install with: npm install node-hid');
}

const VENDOR_ID = 0x0168;
const PRODUCT_ID = 0x0821;

// Global HID device reference
let hidDevice = null;
let reconnectTimer = null;
let isConnecting = false;

// Mock mode state
let mockHidBuffer = [];
let mockPendingRequest = null;
const MOCK_MODE = process.env.MOCK_MODE === 'true';

/**
 * Find and open the DSP device
 */
async function connectHid() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    if (!NodeHid) throw new Error('node-hid not available');

    // node-hid.devices() expects vendorId and productId as separate arguments, not an object
    const devices = NodeHid.devices(VENDOR_ID, PRODUCT_ID);

    if (devices.length === 0) {
      return; // No device found - server will just wait for one
    }

    const dev = devices[0];
    console.log(`Found DSP device: ${dev.path}`);

    hidDevice = new NodeHid.HID(dev.path);
    console.log('Connected to HID device');

    // Listen for input reports from the device
    hidDevice.on('data', (buffer) => {
      const bytes = Array.from(buffer);
      broadcastReport(bytes);
    });

  } catch (err) {
    console.error(`HID connect failed: ${err.message}`);
    disconnectHid();
  } finally {
    isConnecting = false;
  }
}

/**
 * Close the HID connection
 */
function disconnectHid() {
  if (hidDevice) {
    try {
      hidDevice.close();
    } catch (e) {}
    hidDevice = null;
  }
  clearTimeout(reconnectTimer);
}

/**
 * DLE/STX/ETX constants for the protocol
 */
const DLE = 0x10;
const STX = 0x02;
const ETX = 0x03;

/**
 * Build a DLE-framed reply report (64 bytes)
 */
function buildReplyFrame(payload) {
  const frameChecksum = (bytes) => {
    let x = 0;
    for (let i = 0; i < bytes.length; i++) x ^= bytes[i];
    return (x ^ 1) & 0xff;
  };

  const report = new Uint8Array(64).fill(0);
  const payloadWithHeader = [0x01, 0x00, 1 + payload.length, ...payload];
  const checksum = frameChecksum(payloadWithHeader);

  let pos = 0;
  report[pos++] = DLE;
  report[pos++] = STX;
  for (const b of payloadWithHeader) {
    report[pos++] = b & 0xff;
  }
  report[pos++] = DLE;
  report[pos++] = ETX;
  report[pos] = checksum;

  return report;
}

/**
 * Mock HID data handler - simulates DSP responses
 */
function handleMockHidWrite(bytes) {
  if (MOCK_MODE) {
    // Parse the request and generate mock response
    try {
      // Extract payload from DLE frame
      let payloadStart = -1, payloadEnd = -1;
      for (let i = 0; i < bytes.length - 4; i++) {
        if (bytes[i] === DLE && bytes[i + 1] === STX) {
          payloadStart = i + 2;
        }
        if (payloadStart >= 0 && bytes[i] === DLE && bytes[i + 1] === ETX) {
          payloadEnd = i;
          break;
        }
      }

      if (payloadStart >= 0 && payloadEnd > payloadStart) {
        const payload = bytes.slice(payloadStart, payloadEnd);
        const addr = payload[0];
        const n = payload[1];
        const code = payload[3];

        console.log(`[MOCK] Request: code=0x${code.toString(16).padStart(2, '0')}`);

        // Generate mock response based on command
        let replyPayload;
        switch (code) {
          case 0x10: // GET_STATUS - return model/status byte
            replyPayload = [0x01, 0x00, 0x01, 0x02]; // status = 0x02 (ready)
            break;
          case 0x12: // INIT_DONE
            replyPayload = [0x01, 0x00, 0x01, 0x01];
            break;
          case 0x13: // GET_VERSION - return "4x4MINIPRO V010"
            const versionStr = "4x4MINIPRO V010";
            replyPayload = [0x01, 0x00, 1 + versionStr.length, 0x52];
            for (const c of versionStr) {
              replyPayload.push(c.charCodeAt(0));
            }
            break;
          case 0x20: // RECALL_PRESET
            replyPayload = [0x01, 0x00, 0x01, 0x01];
            break;
          case 0x21: // STORE_PRESET
            replyPayload = [0x01, 0x00, 0x01, 0x01];
            break;
          case 0x27: // READ_CHANNEL
            // Return a minimal 50-byte channel state
            replyPayload = new Array(54);
            replyPayload[0] = 0x01; // addr
            replyPayload[1] = 0x00; // status
            replyPayload[2] = 0x34; // N = 52 (50 data bytes)
            replyPayload[3] = 0x24; // REPLY_CHANNEL code
            for (let i = 4; i < 54; i++) {
              replyPayload[i] = 0;
            }
            break;
          case 0x30: // COMPRESSOR
          case 0x31: // CROSSOVER_LPF
          case 0x32: // CROSSOVER_HPF
          case 0x33: // PEQ_BAND
          case 0x34: // LEVEL
          case 0x35: // MUTE
          case 0x36: // POLARITY
          case 0x38: // DELAY
          case 0x3a: // ROUTING
          case 0x3e: // GATE
            replyPayload = [0x01, 0x00, 0x01, 0x01];
            break;
          case 0x40: // READBACK_LEVELS - return 8 meter values
            replyPayload = new Array(13);
            replyPayload[0] = 0x01; // addr
            replyPayload[1] = 0x00; // status
            replyPayload[2] = 0x0c; // N = 12 (8 levels + header)
            replyPayload[3] = 0x40; // READBACK_LEVELS code
            for (let i = 4; i < 12; i++) {
              replyPayload[i] = 0;
            }
            break;
          default:
            console.log(`[MOCK] Unknown command: 0x${code.toString(16)}`);
            return null;
        }

        const replyFrame = buildReplyFrame(replyPayload);
        broadcastReport(Array.from(replyFrame));
      }
    } catch (e) {
      console.error('[MOCK] Error handling request:', e.message);
    }
    return true;
  }
  return false;
}

/**
 * Close the HID connection
 */
function disconnectHid() {
  if (hidDevice) {
    try {
      hidDevice.close();
    } catch (e) {}
    hidDevice = null;
  }
  clearTimeout(reconnectTimer);
}

// WebSocket clients connected to this server
let clients = new Set();

/**
 * Broadcast a report to all connected clients
 */
function broadcastReport(reportBytes) {
  if (clients.size === 0 || (!hidDevice && !MOCK_MODE)) return;

  const data = btoa(String.fromCharCode(...reportBytes));
  const msg = JSON.stringify({ type: 'report', data });
  for (const client of clients) {
    // Check both readyState and if client still exists in Set
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    } catch (e) {
      console.error('Error sending to client:', e.message);
    }
  }
}

/**
 * Send a request to the HID device (or mock handler)
 */
function sendToHid(bytes) {
  // In mock mode, use the mock handler instead of real HID
  if (MOCK_MODE) {
    return handleMockHidWrite(bytes);
  }

  if (!hidDevice) return false;
  try {
    hidDevice.write(new Uint8Array(bytes));
    return true;
  } catch (e) {
    console.error('HID write error:', e.message);
    disconnectHid();
    return false;
  }
}

// Track connected devices with roles for multi-DSP support
const connectedDevices = new Map();

/**
 * Register a client as a DSP connection
 */
function registerClient(ws, path) {
  // Use connectedDevices size to ensure unique IDs
  const id = `client-${connectedDevices.size}`;
  // Determine role: first connected device is master if no other master exists
  const hasMaster = Array.from(connectedDevices.values()).some(d => d.role === 'master');
  const isMaster = !hasMaster && (!hidDevice || hidDevice.path === path);
  connectedDevices.set(id, {
    id,
    ws,
    path,
    role: isMaster ? 'master' : 'slave',
    connectedAt: new Date().toISOString()
  });
}

/**
 * Unregister a client
 */
function unregisterClient(ws) {
  for (const [id, info] of connectedDevices.entries()) {
    if (info.ws === ws) {
      connectedDevices.delete(id);
      // Reassign master role if needed - find first remaining client that's not the removed one
      if (connectedDevices.size > 0 && !Array.from(connectedDevices.values()).find(d => d.role === 'master')) {
        // Find first available client and make them master
        for (const [_, info] of connectedDevices.entries()) {
          info.role = 'master';
          break;
        }
      }
      break;
    }
  }
}

/**
 * Send a message to a specific client
 */
function sendToClient(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Web-based logging storage
const connectionLogs = [];
const messageLogs = [];
const MAX_LOGS = 100;

// Add to logs, with limit
function addConnectionLog(entry) {
  connectionLogs.unshift(entry);
  if (connectionLogs.length > MAX_LOGS) {
    connectionLogs.pop();
  }
}

function addMessageLog(entry) {
  messageLogs.unshift(entry);
  if (messageLogs.length > MAX_LOGS) {
    messageLogs.pop();
  }
}

// HTTP server for serving static files (optional)
const httpServer = createServer((req, res) => {
  // Log all requests
  const now = new Date().toISOString();
  addConnectionLog({
    timestamp: now,
    type: 'http_request',
    method: req.method,
    path: req.url,
    ip: req.socket.remoteAddress || 'unknown'
  });

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const deviceInfo = MOCK_MODE ? 'DSP 4x4 Mini Pro (Mock)' : (hidDevice ? 'DSP 4x4 Mini Pro' : null);
    res.end(JSON.stringify({
      connected: hidDevice !== null || MOCK_MODE,
      device: deviceInfo
    }));
  } else if (req.url === '/servers' && req.method === 'GET') {
    // Return list of discovered servers via Bonjour
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers: getDiscoveredServers() }));
  } else if (req.url === '/logs/connections' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(connectionLogs));
  } else if (req.url === '/logs/messages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messageLogs));
  } else if (req.url === '/devices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // node-hid.devices() expects vendorId and productId as separate arguments
    const localDevices = NodeHid ? NodeHid.devices(VENDOR_ID, PRODUCT_ID) : [];

    if (localDevices.length === 0 && !MOCK_MODE) {
      res.end(JSON.stringify({
        devices: [],
        message: 'No DSP devices found. Connect a device via USB.',
        error: 'no_device'
      }));
      return;
    }

    // In mock mode, return a fake device
    if (MOCK_MODE && localDevices.length === 0) {
      res.end(JSON.stringify({
        devices: [{
          path: 'mock-device',
          vendorId: VENDOR_ID.toString(16),
          productId: PRODUCT_ID.toString(16),
          product: 'DSP 4x4 Mini Pro (Mock)',
          serialNumber: 'MOCK001',
          role: 'master'
        }],
        connectedPath: null
      }));
      return;
    }

    // Map HID path to master/slave role
    const getRoleForPath = (path) => {
      if (!hidDevice || hidDevice.path !== path) return 'available';
      for (const info of connectedDevices.values()) {
        if (info.path === path && info.role === 'master') return 'master';
      }
      return 'slave';
    };

    res.end(JSON.stringify({
      devices: localDevices.map(d => ({
        path: d.path,
        vendorId: d.vendorId.toString(16),
        productId: d.productId.toString(16),
        product: d.product || 'Unknown',
        serialNumber: d.serialNumber || '',
        role: getRoleForPath(d.path)
      })),
      connectedPath: hidDevice ? hidDevice.path : null
    }));
  } else if (req.url === '/connections' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connections: Array.from(connectedDevices.values()).map(d => ({
        id: d.id,
        path: d.path,
        role: d.role,
        connectedAt: d.connectedAt
      }))
    }));
  } else if (req.url === '/mock' && req.method === 'POST') {
    // Toggle mock mode
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const { enable } = JSON.parse(body.join(''));
        process.env.MOCK_MODE = String(!!enable);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Mock mode ${enable ? 'enabled' : 'disabled'}`, enabled: enable }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Invalid request body', error: e.message }));
      }
    });
  } else if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const mockMode = process.env.MOCK_MODE === 'true';
    res.end(`<!DOCTYPE html>
<html><head><title>openDSP-4x4 Bridge</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:2rem auto;padding:1rem;background:#1a1a2e;color:#eee">
<h1>openDSP-4x4 WebSocket Bridge</h1>

<div style="background:#2d2d44;padding:1.5rem;border-radius:8px;margin-bottom:1rem">
<p>Status: ${hidDevice ? '<span style="color:#4ade80">Connected to DSP</span>' : (MOCK_MODE ? '<span style="color:#3b82f6">Mock Mode - Simulated Device</span>' : '<span style="color:#f87171">Not Connected</span>')}</p>
<p>Active connections: ${clients.size} (${Array.from(connectedDevices.values()).filter(d => d.role === 'master').length} master)</p>
<p>Mock mode: <strong>${mockMode ? 'ON' : 'OFF'}</strong></p>
</div>

<h2>Connection Info</h2>
<ul style="background:#2d2d44;padding:1rem;border-radius:8px">
<li>Connect web UI to <code>ws://localhost:${process.env.PORT || 8765}</code></li>
<li>HID device vendor: 0x${VENDOR_ID.toString(16).padStart(4, '0')}</li>
<li>HID device product: 0x${PRODUCT_ID.toString(16).padStart(4, '0')}</li>
</ul>

<h2>Mock Mode Control</h2>
<div style="background:#2d2d44;padding:1rem;border-radius:8px">
<button id="toggleMock" style="padding:.5rem 1rem;background:${mockMode ? '#f87171' : '#4ade80'};color:#0a0d12;border:none;border-radius:6px;font-weight:bold;cursor:pointer">Toggle Mock Mode</button>
<p id="mockStatus" style="margin-top:.5rem;color:#9ca3af">${mockMode ? 'Mock mode is active - simulating DSP devices' : 'Mock mode is inactive - using real HID device'}</p>
</div>

<h2>Connection Logs (last 100)</h2>
<div style="background:#2d2d44;padding:1rem;border-radius:8px;max-height:300px;overflow:auto">
<button id="clearLogs" style="padding:.25rem .5rem;background:#4b5563;color:white;border:none;border-radius:4px;margin-bottom:.5rem;cursor:pointer">Clear Logs</button>
<div id="logs"></div>
</div>

<script>
const mockMode = ${mockMode};
document.getElementById('toggleMock').onclick = async () => {
  const res = await fetch('/mock', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enable:!mockMode}) });
  if (res.ok) location.reload();
};
document.getElementById('clearLogs').onclick = async () => {
  connectionLogs = [];
  document.getElementById('logs').innerHTML = '<p class="empty">Logs cleared</p>';
};

// Fetch and display logs
async function loadLogs() {
  try {
    const res = await fetch('/logs/connections');
    const logs = await res.json();
    const logDiv = document.getElementById('logs');
    if (logs.length === 0) {
      logDiv.innerHTML = '<p class="empty">No connection logs yet</p>';
    } else {
      logDiv.innerHTML = logs.slice(0, 100).map(l =>
        \`<div style="padding:.25rem 0;border-bottom:1px solid#374151;font-size:.8rem">
          <span style="color:#9ca3af">\${l.timestamp}</span> -
          <span style="color:\${l.type==='http_request'?'#60a5fa':'#fbbf24'}">\${l.method||l.type}</span> -
          <code>\${l.path}</code>
        </div>\`
      ).join('');
    }
  } catch (e) { console.error('Failed to load logs:', e); }
}
loadLogs();
setInterval(loadLogs, 5000);
</script>

<style>
.empty { color: #9ca3af; font-style: italic; text-align: center; padding: 1rem; }
code { background:#1f2937;padding:.1rem .4rem;border-radius:4px;font-family:monospace; }
</style>
</body></html>`);
  } else {
    res.writeHead(404);
    res.end('WebSocket Bridge - openDSP-4x4');
  }
});

// WebSocket server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  // Register the client for device tracking with path from WebSocket URL if available
  let urlPath = '/';
  try {
    if (ws.upgradeReq && ws.upgradeReq.url) {
      urlPath = new URL(`http://localhost${ws.upgradeReq.url}`).pathname;
    }
  } catch (e) { /* ignore */ }
  registerClient(ws, urlPath);

  // If this is the first client, try to connect to HID if not already (not in mock mode)
  if (!MOCK_MODE && clients.size === 1 && !hidDevice) {
    setTimeout(connectHid, 500);
  }

  ws.on('message', (data) => {
    try {
      let msg;
      if (typeof data === 'string') {
        msg = JSON.parse(data);
      } else if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) {
        // Binary frame - decode as base64
        const text = data.toString('utf8');
        msg = JSON.parse(text);
      }

      if (!msg) return;

      addMessageLog({
        timestamp: new Date().toISOString(),
        type: 'ws_message',
        direction: 'inbound',
        payload: typeof data === 'string' ? data : data.toString()
      });

      // Handle list_devices action via WebSocket
      if (msg.type === 'request' && msg.data) {
        // Check if this is a special action message (base64-encoded JSON with action)
        try {
          const bytesStr = atob(msg.data);
          const decoded = JSON.parse(bytesStr);

          if (decoded.action === 'list_devices') {
            let localDevices = [];
            if (NodeHid) {
              // node-hid.devices() expects vendorId and productId as separate arguments
              try {
                localDevices = NodeHid.devices(VENDOR_ID, PRODUCT_ID);
              } catch (e) {
                console.log('node-hid devices call failed:', e.message);
              }
            }

            // In mock mode, add a mock device if no real devices found
            if (MOCK_MODE && localDevices.length === 0) {
              localDevices = [{
                path: 'mock-device',
                vendorId: VENDOR_ID,
                productId: PRODUCT_ID,
                product: 'DSP 4x4 Mini Pro (Mock)',
                serialNumber: 'MOCK001'
              }];
            }

            // Map HID path to master/slave role (mock mode aware)
            const getRoleForPath = (path) => {
              if (MOCK_MODE && path === 'mock-device') return 'master';
              if (!hidDevice || hidDevice.path !== path) return 'available';
              for (const info of connectedDevices.values()) {
                if (info.path === path && info.role === 'master') return 'master';
              }
              return 'slave';
            };

            const responseMsg = {
              type: 'report',
              data: btoa(JSON.stringify({
                devices: localDevices.map(d => ({
                  path: d.path,
                  vendorId: d.vendorId.toString(16),
                  productId: d.productId.toString(16),
                  product: d.product || 'Unknown',
                  serialNumber: d.serialNumber || '',
                  role: getRoleForPath(d.path)
                }))
              }))
            };
            sendToClient(ws, responseMsg);
            return;
          } else if (decoded.action === 'list_servers') {
            // Return list of discovered servers
            const responseMsg = {
              type: 'report',
              data: btoa(JSON.stringify({
                servers: getDiscoveredServers()
              }))
            };
            sendToClient(ws, responseMsg);
            return;
          }
        } catch (e) {
          // Not an action message, continue to HID proxy
        }

        // Decode base64 and send to HID device
        const bytesStr = atob(msg.data);
        const bytes = Array.from(bytesStr).map(c => c.charCodeAt(0));
        if (!sendToHid(bytes)) {
          console.warn('HID not available, message dropped');
        }
      }
    } catch (e) {
      console.error('Error handling message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
    unregisterClient(ws);

    // If no more clients, disconnect HID
    if (clients.size === 0) {
      console.log('No clients connected, disconnecting HID...');
      setTimeout(disconnectHid, 1000); // Delay to allow reconnection of same client
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Bonjour advertising
let mdnsAdvertiser = null;
let mdnsBrowser = null;
const BONJOUR_SERVICE_NAME = '_opendsp-ws._tcp.local';

/**
 * Start advertising this server via Bonjour/mDNS
 */
function startBonjourAdvertising() {
  const PORT = process.env.PORT || 8765;

  // Create the mDNS advertiser for our service
  mdnsAdvertiser = Advertisement.createTcpService(BONJOUR_SERVICE_NAME, `openDSP-4x4-${process.env.HOSTNAME || process.env.USER || 'server'}`, {
    port: PORT,
    txt: {
      mockMode: MOCK_MODE.toString(),
      version: '1.0.0',
      vendorId: VENDOR_ID.toString(16),
      productId: PRODUCT_ID.toString(16)
    }
  });

  mdnsAdvertiser.start().then(() => {
    console.log(`Server advertising via Bonjour on ${BONJOUR_SERVICE_NAME}`);
  }).catch((err) => {
    console.warn('Failed to start mDNS advertisement:', err.message);
  });

  // Create the mDNS browser for discovering other openDSP servers
  mdnsBrowser = MdnsBrowser.create();

  mdnsBrowser.on('serviceUp', (service) => {
    if (service.type === BONJOUR_SERVICE_NAME && service.protocol === 'tcp') {
      const server = {
        name: service.name,
        host: service.host || 'localhost',
        port: service.port,
        type: 'opendsp-ws',
        protocol: 'tcp',
        lastSeen: Date.now()
      };
      updateDiscoveredServer(server);
      console.log(`Found openDSP server: ${service.name} at ws://${server.host}:${server.port}`);
    }
  });

  mdnsBrowser.on('serviceDown', (service) => {
    if (service.type === BONJOUR_SERVICE_NAME && service.protocol === 'tcp') {
      console.log(`openDSP server removed: ${service.name}`);
    }
  });

  // Start browsing for services
  mdnsBrowser.start();
}

/**
 * Stop Bonjour advertising
 */
function stopBonjourAdvertising() {
  if (mdnsAdvertiser) {
    mdnsAdvertiser.stop().then(() => {
      console.log('Stopped mDNS advertisement');
    });
    mdnsAdvertiser = null;
  }
  if (mdnsBrowser) {
    mdnsBrowser.stop();
    mdnsBrowser = null;
  }
}

// Track discovered servers for the web UI
const discoveredServers = [];

/**
 * Update the list of discovered servers and notify WebSocket clients
 */
function updateDiscoveredServer(server) {
  const existingIndex = discoveredServers.findIndex(s => s.host === server.host && s.port === server.port);
  if (existingIndex >= 0) {
    discoveredServers[existingIndex] = { ...server, lastSeen: Date.now() };
  } else {
    discoveredServers.push({ ...server, lastSeen: Date.now() });
  }

  // Broadcast server list to all connected WebSocket clients
  const serversMsg = JSON.stringify({
    type: 'discovered_servers',
    data: btoa(JSON.stringify({ servers: getDiscoveredServers() }))
  });

  for (const client of clients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serversMsg);
      }
    } catch (e) {
      console.error('Error broadcasting discovered servers:', e.message);
    }
  }
}

// Get list of discovered servers
function getDiscoveredServers() {
  // Clean up stale entries (older than 30 seconds)
  const now = Date.now();
  return discoveredServers.filter(s => now - s.lastSeen < 30000);
}

/**
 * Graceful shutdown
 */
function shutdown() {
  console.log('Shutting down...');
  stopBonjourAdvertising();
  disconnectHid();
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
const PORT = process.env.PORT || 8765;

httpServer.listen(PORT, () => {
  console.log(`WebSocket bridge listening on ws://localhost:${PORT}`);
  console.log(`HTTP status at http://localhost:${PORT}/`);
  console.log(`Mock mode: ${process.env.MOCK_MODE === 'true' ? 'enabled' : 'disabled'}`);

  // Start Bonjour advertising
  startBonjourAdvertising();

  console.log('Waiting for clients...');
});
