// WebSocket to USB HID bridge for openDSP-4x4
// This server connects to a local DSP device via WebHID and proxies requests
// from remote WebSocket clients.

import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

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

// WebSocket clients connected to this server
let clients = new Set();

/**
 * Broadcast a report to all connected clients
 */
function broadcastReport(reportBytes) {
  if (clients.size === 0 || !hidDevice) return;

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
 * Send a request to the HID device
 */
function sendToHid(bytes) {
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
  const isMaster = !hasMaster && hidDevice?.path === path;
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
        for (const [dinfo] of connectedDevices.entries()) {
          dinfo.role = 'master';
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
    res.end(JSON.stringify({
      connected: hidDevice !== null,
      device: hidDevice ? 'DSP 4x4 Mini Pro' : null
    }));
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

    if (localDevices.length === 0) {
      res.end(JSON.stringify({
        devices: [],
        message: 'No DSP devices found. Connect a device via USB.',
        error: 'no_device'
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
  } else if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const mockMode = process.env.MOCK_MODE === 'true';
    res.end(`<!DOCTYPE html>
<html><head><title>openDSP-4x4 Bridge</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:2rem auto;padding:1rem;background:#1a1a2e;color:#eee">
<h1>openDSP-4x4 WebSocket Bridge</h1>

<div style="background:#2d2d44;padding:1.5rem;border-radius:8px;margin-bottom:1rem">
<p>Status: ${hidDevice ? '<span style="color:#4ade80">Connected to DSP</span>' : '<span style="color:#f87171">Not Connected</span>'}</p>
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
  const data = await res.json();
  alert(data.message);
  location.reload();
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
  const urlPath = new URL(ws._socket.remoteAddress ? `http://localhost${ws.upgradeReq.url}` : 'http://localhost').pathname;
  registerClient(ws, urlPath);

  // If this is the first client, try to connect to HID if not already
  if (clients.size === 1 && !hidDevice) {
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
            const localDevices = NodeHid ? NodeHid.devices({ vendorId: VENDOR_ID, productId: PRODUCT_ID }) : [];

            // Map HID path to master/slave role
            const getRoleForPath = (path) => {
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

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
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
  console.log('Waiting for clients...');
});
