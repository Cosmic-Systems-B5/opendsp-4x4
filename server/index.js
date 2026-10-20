// WebSocket to USB HID bridge for openDSP-4x4
// This server connects to a local DSP device via WebHID and proxies requests
// from remote WebSocket clients.

import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import * as dns_sd from 'dns-sd-browser';

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

// Generate a unique 5-digit alphanumeric GUID for this server
function generateServerId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

const SERVER_ID = generateServerId();
console.log(`Server ID: ${SERVER_ID}`);

// Global HID device reference
let hidDevice = null;
let reconnectTimer = null;
let isConnecting = false;

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
  }
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
        // addr and n are extracted for potential future use
        void payload[0];
        void payload[1];
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
        const [_, info] = connectedDevices.entries().next().value;
        if (info) info.role = 'master';
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

// Web-based logging storage with full request/response details
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

// Broadcast connection changes to all WebSocket clients
const connectionChangeSubscribers = new Set();

function subscribeToConnectionChanges(callback) {
  connectionChangeSubscribers.add(callback);
  return () => connectionChangeSubscribers.delete(callback);
}

function notifyConnectionChanges() {
  const connectionsInfo = Array.from(connectedDevices.values()).map(d => ({
    id: d.id,
    path: d.path,
    role: d.role,
    connectedAt: d.connectedAt
  }));

  for (const callback of connectionChangeSubscribers) {
    try {
      callback(connectionsInfo);
    } catch (e) {
      console.error('Error in connection change subscriber:', e.message);
    }
  }
}

// HTTP server for serving static files (optional)
const httpServer = createServer((req, res) => {
  // Log all requests with full details
  const now = new Date().toISOString();
  addConnectionLog({
    timestamp: now,
    type: 'http_request',
    method: req.method,
    path: req.url,
    ip: req.socket.remoteAddress || 'unknown',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')),
    query: req.url.includes('?') ? req.url.split('?')[1] : null
  });

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const deviceInfo = MOCK_MODE ? 'DSP 4x4 Mini Pro (Mock)' : (hidDevice ? 'DSP 4x4 Mini Pro' : null);
    res.end(JSON.stringify({
      connected: hidDevice !== null || MOCK_MODE,
      device: deviceInfo
    }));
  } else if (req.url === '/servers' && req.method === 'GET') {
    // Return list of discovered servers via Bonjour/mDNS
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers: getDiscoveredServers() }));
  } else if (req.url === '/connection-changes' && req.method === 'GET') {
    // SSE endpoint for real-time connection updates
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const callback = (connectionsInfo) => {
      res.write(`data: ${JSON.stringify({ type: 'connection_update', connections: connectionsInfo })}\n\n`);
    };

    connectionChangeSubscribers.add(callback);

    // Send initial state
    callback(Array.from(connectedDevices.values()).map(d => ({
      id: d.id,
      path: d.path,
      role: d.role,
      connectedAt: d.connectedAt
    })));

    req.on('close', () => {
      connectionChangeSubscribers.delete(callback);
    });
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
  } else if (req.url === '/server-info' && req.method === 'GET') {
    // Return server identification and connection details
    const localAddress = getLocalAddress();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      serverId: SERVER_ID,
      port: process.env.PORT || 8765,
      host: localAddress,
      mockMode: MOCK_MODE,
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const mockMode = process.env.MOCK_MODE === 'true';
    const localAddress = getLocalAddress();
    res.end(`<!DOCTYPE html>
<html lang="en"><head><title>openDSP-4x4 Bridge - ${SERVER_ID}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 1rem; background: #1a1a2e; color: #eee; }
h1 { margin-bottom: 0.5rem; }
.hint { color: var(--text-dim); font-style: italic; font-size: .85rem; margin-bottom: .75rem; }
.server-id { background: #3b82f6; padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace; color: white; }
.status-ok { color: #4ade80; }
.status-warn { color: #fbbf24; }
.status-err { color: #f87171; }
.log-entry { padding: 0.5rem; margin-bottom: 0.25rem; background: #2d2d44; border-radius: 6px; font-size: 0.85rem; }
.log-entry:hover { background: #3a3a52; }
code { background: #1f2937; padding: 0.1rem 0.3rem; border-radius: 4px; font-family: monospace; }
</style>
</head>
<body>
<h1>openDSP-4x4 WebSocket Bridge</h1>

<div style="background:#2d2d44;padding:1.5rem;border-radius:8px;margin-bottom:1rem">
<p><strong>Server ID:</strong> <span class="server-id">${SERVER_ID}</span></p>
<p>Status: ${hidDevice ? '<span class="status-ok">Connected to DSP</span>' : (MOCK_MODE ? '<span class="status-warn">Mock Mode - Simulated Device</span>' : '<span class="status-err">Not Connected</span>')}</p>
<p>Active connections: ${clients.size} (${Array.from(connectedDevices.values()).filter(d => d.role === 'master').length} master)</p>
<p>Mock mode: <strong>${mockMode ? 'ON' : 'OFF'}</strong></p>
<p class="hint">Connect web UI to: <code>ws://${localAddress}:${process.env.PORT || 8765}</code></p>
</div>

<h2>Connection Info</h2>
<ul style="background:#2d2d44;padding:1rem;border-radius:8px">
<li>HID device vendor: 0x${VENDOR_ID.toString(16).padStart(4, '0')}</li>
<li>HID device product: 0x${PRODUCT_ID.toString(16).padStart(4, '0')}</li>
<li>Server GUID: <code>${SERVER_ID}</code></li>
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
  connectionLogs.length = 0;
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
        \`<div class="log-entry">
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

// Real-time connection updates via SSE
const eventSource = new EventSource('/connection-changes');
eventSource.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    console.log('Connection update:', data.connections);
    // Update connection count display
    document.querySelector('p:nth-of-type(3)').innerHTML = \`Active connections: \${data.connections.length} (\${data.connections.filter(c=>c.role==='master').length} master)\`;
  } catch (err) { console.error('SSE parse error:', err); }
};
eventSource.onerror = (e) => {
  console.log('SSE connection closed');
};
</script>
</body></html>`);
  } else {
    res.writeHead(404);
    res.end('WebSocket Bridge - openDSP-4x4');
  }
});

// Helper to get local IP address (synchronous)
let _localAddressCache = null;
async function initLocalAddress() {
  if (_localAddressCache) return _localAddressCache;
  try {
    const os = await import('node:os');
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          _localAddressCache = addr.address;
          return addr.address;
        }
      }
    }
  } catch (e) {}
  return 'localhost';
}

// Sync wrapper for use in HTTP handlers
function getLocalAddress() {
  // Return cached value if available, otherwise return localhost as fallback
  // The cache will be populated on first async call during startup
  return _localAddressCache || 'localhost';
}

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

  // Notify subscribers of connection change
  notifyConnectionChanges();

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

    // Notify subscribers of connection change
    notifyConnectionChanges();

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

// Track discovered servers for the web UI (servers are discovered via HTTP endpoint)
const discoveredServers = [];

/**
 * Get list of discovered servers
 */
function getDiscoveredServers() {
  // Clean up stale entries (older than 30 seconds)
  const now = Date.now();
  return discoveredServers.filter(s => now - s.lastSeen < 30000);
}

/**
 * Start mDNS/DNS-SD service broadcasting
 * Note: dns-sd-browser is a client-side library; for Node.js mDNS use bonjour-service package.
 */
let mdnsService = null;
let browser = null;

function startBonjour() {
  // dns-sd-browser is a client-side library that doesn't support Node.js server-side APIs
  // For Node.js, you would use the 'bonjour' or 'dns-sd' packages instead
  console.log('mDNS broadcasting requires bonjour-service package (not installed)');
  console.log(`Server ${SERVER_ID} running on port ${process.env.PORT || 8765}`);
}

/**
 * Stop mDNS/DNS-SD service
 */
function stopBonjour() {
  if (mdnsService) {
    try { mdnsService.stop(); } catch (e) {}
    mdnsService = null;
  }
  if (browser) {
    try { browser.stop(); } catch (e) {}
    browser = null;
  }
}

/**
 * Graceful shutdown
 */
function shutdown() {
  console.log('Shutting down...');
  stopBonjour();
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
  console.log(`Server ID: ${SERVER_ID}`);

  // Start mDNS broadcasting
  startBonjour();

  console.log('Waiting for clients...');
});
