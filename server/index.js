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

    const devices = NodeHid.devices({
      vendorId: VENDOR_ID,
      productId: PRODUCT_ID
    });

    if (devices.length === 0) {
      throw new Error(`DSP device not found. Vendor: 0x${VENDOR_ID.toString(16)}, Product: 0x${PRODUCT_ID.toString(16)}`);
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
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
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
  const id = `client-${clients.size}`;
  const isMaster = clients.size === 0 && hidDevice?.path === path;
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
      // Reassign master role if needed
      if (clients.size > 0 && !Array.from(connectedDevices.values()).find(d => d.role === 'master')) {
        const firstClient = Array.from(clients)[0];
        for (const [dinfo] of connectedDevices.entries()) {
          if (dinfo.ws === firstClient) {
            dinfo.role = 'master';
            break;
          }
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

// HTTP server for serving static files (optional)
const httpServer = createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: hidDevice !== null,
      device: hidDevice ? 'DSP 4x4 Mini Pro' : null
    }));
  } else if (req.url === '/devices' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const localDevices = NodeHid ? NodeHid.devices({ vendorId: VENDOR_ID, productId: PRODUCT_ID }) : [];

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
    res.end(`<!DOCTYPE html>
<html><head><title>openDSP-4x4 Bridge</title></head>
<body><h1>openDSP-4x4 WebSocket Bridge</h1>
<p>Status: ${hidDevice ? '<span style="color:green">Connected to DSP</span>' : '<span style="color:red">Not Connected</span>'}</p>
<p>Active connections: ${clients.size} (${Array.from(connectedDevices.values()).filter(d => d.role === 'master').length} master)</p>
<ul>
<li>Connect web UI to <code>wss://${req.headers.host || 'localhost:8765'}</code></li>
<li>HID device vendor: 0x${VENDOR_ID.toString(16).padStart(4, '0')}</li>
<li>HID device product: 0x${PRODUCT_ID.toString(16).padStart(4, '0')}</li>
</ul>
<pre style="background:#222;color:#eee;padding:1rem;border-radius:5px">${hidDevice ? `HID Path: ${hidDevice.path}` : 'No HID device connected'}</pre></body></html>`);
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
  console.log('Waiting for clients...');
});
