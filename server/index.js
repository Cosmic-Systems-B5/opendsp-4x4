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

/**
 * Generate a unique GUID for a DSP device
 * Uses serial number if available, otherwise generates a random one
 */
function generateDeviceGuid(serialNumber, path) {
  const prefix = 'DSP-';
  // Use serial number if available (real devices)
  if (serialNumber && serialNumber.trim() !== '') {
    return prefix + serialNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  // For mock mode or devices without serial numbers, generate a deterministic GUID from path
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    const char = path.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  // Convert to a readable format: DSP-XXXX where XXXX is hex representation
  const hexHash = Math.abs(hash).toString(16).padStart(4, '0').toUpperCase();
  return prefix + hexHash;
}

// Device GUID registry - maps path/serial to persistent GUIDs
const deviceGuids = new Map();

/**
 * Get or create a GUID for a DSP device
 */
function getDeviceGuid(deviceInfo) {
  const { serialNumber, path } = deviceInfo;
  const key = serialNumber || path;

  if (!deviceGuids.has(key)) {
    // Generate and store a new GUID
    const guid = generateDeviceGuid(serialNumber, path);
    deviceGuids.set(key, guid);
    console.log(`Assigned GUID ${guid} to device: ${key}`);
  }

  return deviceGuids.get(key);
}

/**
 * Get all registered device GUIDs
 */
function getAllDeviceGuids() {
  return Array.from(deviceGuids.entries()).map(([key, guid]) => ({ key, guid }));
}

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

    // Start settings updates
    ensureSettingsUpdates();

    // Listen for input reports from the device
    hidDevice.on('data', (buffer) => {
      const bytes = Array.from(buffer);
      broadcastReport(bytes);
      notifySettingsChanged(); // Update settings display on data
    });

  } catch (err) {
    console.error(`HID connect failed: ${err.message}`);
    disconnectHid();
  }
}

/**
 * Start settings updates when HID is connected or mock mode is active
 */
function ensureSettingsUpdates() {
  if ((hidDevice || MOCK_MODE) && !settingsInterval) {
    startSettingsUpdates();
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

  // Stop settings updates when disconnected
  stopSettingsUpdates();
}

/**
 * Send initial mock device state to a client
 */
function sendMockInitialStatus(ws) {
  // Send GET_STATUS response
  const statusFrame = buildReplyFrame([0x01, 0x00, 0x01, 0x02]); // status = 0x02 (ready)
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'report', data: btoa(String.fromCharCode(...statusFrame)) }));
  }

  // Send GET_VERSION response
  const versionStr = "4x4MINIPRO V010";
  const versionPayload = [0x01, 0x00, 1 + versionStr.length, 0x52];
  for (const c of versionStr) {
    versionPayload.push(c.charCodeAt(0));
  }
  const versionFrame = buildReplyFrame(versionPayload);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'report', data: btoa(String.fromCharCode(...versionFrame)) }));
  }

  console.log('[MOCK] Sent initial device state to client');
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
 * Get device info - either from actual HID device or mock configuration
 */
function getDeviceInfo() {
  if (hidDevice) {
    return {
      path: hidDevice.path,
      serialNumber: hidDevice.serialNumber || '',
      product: hidDevice.product || 'DSP 4x4 Mini Pro'
    };
  }
  if (MOCK_MODE) {
    // In mock mode, create a consistent device info
    const mockSerial = 'MOCK001';
    return {
      path: 'mock-device',
      serialNumber: mockSerial,
      product: 'DSP 4x4 Mini Pro (Mock)'
    };
  }
  return null;
}

/**
 * Register a client as a DSP connection
 */
function registerClient(ws, path) {
  // Use connectedDevices size to ensure unique IDs
  const id = `client-${connectedDevices.size}`;

  // Get device info for GUID generation and metadata
  const deviceInfo = getDeviceInfo();

  // Determine role: first connected device is master if no other master exists
  const hasMaster = Array.from(connectedDevices.values()).some(d => d.role === 'master');
  let isMaster = !hasMaster;

  // Adjust master determination based on actual device state
  if (deviceInfo) {
    isMaster = !hasMaster && (!hidDevice || hidDevice.path === path);
  }

  // Get or generate GUID for this DSP device
  const serialNumber = deviceInfo ? deviceInfo.serialNumber : '';
  const deviceGuid = getDeviceGuid({ serialNumber, path: deviceInfo ? deviceInfo.path : path });

  connectedDevices.set(id, {
    id,
    ws,
    path: deviceInfo ? deviceInfo.path : path,
    role: isMaster ? 'master' : 'slave',
    deviceGuid,
    serialNumber: serialNumber || '',
    productName: deviceInfo ? deviceInfo.product : 'DSP 4x4 (remote)',
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
    deviceGuid: d.deviceGuid,
    serialNumber: d.serialNumber,
    productName: d.productName,
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
      const mockDevice = {
        path: 'mock-device',
        vendorId: VENDOR_ID.toString(16),
        productId: PRODUCT_ID.toString(16),
        product: 'DSP 4x4 Mini Pro (Mock)',
        serialNumber: 'MOCK001',
        deviceGuid: getDeviceGuid({ serialNumber: 'MOCK001', path: 'mock-device' }),
        role: 'master'
      };
      res.end(JSON.stringify({
        devices: [mockDevice],
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
        deviceGuid: getDeviceGuid({ serialNumber: d.serialNumber || '', path: d.path }),
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
        deviceGuid: d.deviceGuid,
        serialNumber: d.serialNumber,
        productName: d.productName,
        role: d.role,
        connectedAt: d.connectedAt
      }))
    }));
  } else if (req.url === '/device-guids' && req.method === 'GET') {
    // Return all registered device GUIDs for mapping between paths and GUIDs
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      deviceGuids: getAllDeviceGuids(),
      serverId: SERVER_ID
    }));
  } else if (req.url === '/mock' && req.method === 'POST') {
    // Toggle mock mode
    const body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
      try {
        const { enable } = JSON.parse(body.join(''));
        process.env.MOCK_MODE = String(!!enable);

        // Start or stop settings updates based on mock mode state
        if (MOCK_MODE || hidDevice) {
          ensureSettingsUpdates();
        } else {
          stopSettingsUpdates();
        }

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
      deviceGuids: getAllDeviceGuids(),
      timestamp: new Date().toISOString()
    }));
  } else if (req.url === '/settings' && req.method === 'GET') {
    // Settings page with real-time DSP settings display
    const localAddress = getLocalAddress();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en"><head><title>openDSP-4x4 Settings - ${SERVER_ID}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 1rem; background: #1a1a2e; color: #eee; }
header { display: flex; align-items: center; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--line); }
.server-id { background: #3b82f6; padding: 0.25rem 0.5rem; border-radius: 4px; font-family: monospace; color: white; }
.status-ok { color: #4ade80; }
.status-warn { color: #fbbf24; }
.status-err { color: #f87171; }

.routing-matrix { display: grid; grid-template-columns: 50px repeat(4, 1fr); gap: 4px; margin-top: 1rem; }
.matrix-cell { background: #2d2d44; padding: 8px; text-align: center; border-radius: 4px; font-size: .75rem; }
.matrix-header { background: #3b82f6; color: white; font-weight: bold; }
.matrix-row-label { background: #4b5563; color: white; text-align: right; padding-right: 10px; }

.channel-group { margin-bottom: 1.5rem; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.channel-header { background: #2d2d44; padding: .75rem 1rem; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
.channel-body { padding: 1rem; }
.param-row { display: flex; gap: 1rem; margin-bottom: .5rem; flex-wrap: wrap; }
.param-label { color: #9ca3af; font-size: .85rem; min-width: 80px; }
.param-value { color: var(--good); font-family: monospace; }

footer { padding: 1rem; border-top: 1px solid var(--line); margin-top: 2rem; text-align: center; font-size: .8rem; color: #6b7280; }
</style>
</head>
<body>
<header>
  <h1>openDSP-4x4 DSP Settings</h1>
  <span class="server-id">${SERVER_ID}</span>
  <span>Status: ${hidDevice ? '<span class="status-ok">Connected to DSP</span>' : (MOCK_MODE ? '<span class="status-warn">Mock Mode</span>' : '<span class="status-err">Not Connected</span>')}</span>
</header>

<div id="settings-content">
  <h2>Routing Matrix</h2>
  <div class="routing-matrix" id="routing-display"></div>

  <h2 style="margin-top: 2rem;">Channel Settings</h2>
  <div id="channels-container"></div>
</div>

<footer>
  Real-time DSP settings display | <a href="/">Back to Bridge</a>
</footer>

<script>
// Fetch initial settings
async function loadSettings() {
  try {
    const res = await fetch('/server-info');
    if (res.ok) {
      console.log('Server info loaded');
    }
  } catch (e) { console.error('Failed to load:', e); }
}

loadSettings();

// SSE for real-time updates
const eventSource = new EventSource('/settings/updates');
eventSource.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data);
    console.log('Settings update:', data.timestamp);

    // Update routing matrix
    if (data.routing) {
      const display = document.getElementById('routing-display');
      if (display) {
        display.innerHTML = '';

        // Header row
        ['In1', 'In2', 'In3', 'In4'].forEach(label => {
          const div = document.createElement('div');
          div.className = 'matrix-cell matrix-header';
          div.textContent = label;
          display.appendChild(div);
        });

        // Row for each output
        data.routing.forEach((mask, outIdx) => {
          const rowLabel = document.createElement('div');
          rowLabel.className = 'matrix-cell matrix-row-label';
          rowLabel.textContent = 'Out' + (outIdx + 1);
          display.appendChild(rowLabel);

          [0x01, 0x02, 0x04, 0x08].forEach(inputMask => {
            const cell = document.createElement('div');
            cell.className = 'matrix-cell';
            if ((mask & inputMask) !== 0) {
              cell.style.background = '#10b981';
              cell.textContent = 'X';
            }
            display.appendChild(cell);
          });
        });
      }
    }

    // Update channels (simplified)
    if (data.channels) {
      const container = document.getElementById('channels-container');
      if (container && data.channels.length > 0) {
        container.innerHTML = '';

        data.channels.forEach((ch, idx) => {
          const group = document.createElement('div');
          group.className = 'channel-group';
          group.innerHTML = \`
            <div class="channel-header">
              <span>Channel \${idx + 1}</span>
              <span>\${ch.gainDb !== null ? ch.gainDb.toFixed(1) + ' dB' : '-'} gain</span>
            </div>
            <div class="channel-body">
              <div class="param-row">
                <span class="param-label">Mute:</span>
                <span class="param-value">\${ch.mute ? 'ON' : 'OFF'}</span>
              </div>
              <div class="param-row">
                <span class="param-label">Delay:</span>
                <span class="param-value">\${ch.delayMs !== null ? ch.delayMs.toFixed(1) + ' ms' : '-'}</span>
              </div>
            </div>
          \`;
          container.appendChild(group);
        });
      }
    }
  } catch (err) { console.error('Settings parse error:', err); }
};
eventSource.onerror = (e) => {
  console.log('Settings SSE connection closed');
};
</script>
</body></html>`);
  } else if (req.url === '/settings/updates' && req.method === 'GET') {
    // SSE endpoint for real-time settings updates
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const callback = (msg) => {
      try {
        res.write(msg + '\n\n');
      } catch (e) {
        console.error('Error sending settings update:', e.message);
      }
    };

    settingsSubscribers.add(callback);

    // Send initial state immediately
    notifySettingsChanged();

    req.on('close', () => {
      settingsSubscribers.delete(callback);
    });
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

// Real-time DSP settings updates via SSE
const settingsSubscribers = new Set();

function subscribeToSettings(callback) {
  settingsSubscribers.add(callback);
  return () => settingsSubscribers.delete(callback);
}

function notifySettingsChanged() {
  if (settingsSubscribers.size === 0 || (!hidDevice && !MOCK_MODE)) return;

  // Build current DSP state
  const channels = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    name: `Channel ${i}`,
    gainDb: 0,
    mute: false,
    polarity: false,
    delayMs: null,
    eq: {
      hpf: { freqHz: 20, slope: -12 },
      lpf: { freqHz: 20000, slope: -12 },
      bands: Array.from({ length: 7 }, (_, b) => ({
        type: 'peak', freqHz: 1000 * (b + 1), gainDb: 0, bwOct: 1
      }))
    }
  }));

  const routing = [0x01, 0x02, 0x04, 0x08]; // Default diagonal routing

  const msg = JSON.stringify({
    type: 'settings_update',
    timestamp: new Date().toISOString(),
    channels,
    routing
  });

  for (const callback of settingsSubscribers) {
    try {
      callback(msg);
    } catch (e) {
      console.error('Error in settings subscriber:', e.message);
    }
  }
}

// Schedule periodic settings updates
let settingsInterval = null;
function startSettingsUpdates() {
  if (settingsInterval) clearInterval(settingsInterval);
  if (MOCK_MODE || hidDevice) {
    notifySettingsChanged();
    settingsInterval = setInterval(() => {
      notifySettingsChanged();
    }, 1000); // Update every second
  }
}

// Stop settings updates when disconnected
function stopSettingsUpdates() {
  if (settingsInterval) clearInterval(settingsInterval);
}
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

  // Send initial status report in mock mode
  if (MOCK_MODE) {
    setTimeout(() => {
      sendMockInitialStatus(ws);
    }, 100);
  }

  // If this is the first client, try to connect to HID if not already (not in mock mode)
  if (!MOCK_MODE && clients.size === 1 && !hidDevice) {
    setTimeout(connectHid, 500);
  }

  // Start settings updates if we have a device or are in mock mode
  ensureSettingsUpdates();

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

    // Note: HID is NOT automatically disconnected when client disconnects.
    // It remains connected for other clients or manual disconnection.
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

/**
 * Kill any existing process using the given port
 */
async function killProcessOnPort(port) {
  try {
    const { spawn } = await import('child_process');
    return new Promise((resolve, reject) => {
      // Try lsof first (macOS/Linux)
      const lsofChild = spawn('lsof', ['-ti:', String(port)]);

      let pidData = '';
      lsofChild.stdout.on('data', (data) => { pidData += data.toString(); });

      lsofChild.on('close', (code) => {
        if (code === 0 && pidData.trim()) {
          // Kill the process
          const pids = pidData.trim().split('\n').filter(p => p.trim());
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid, 10), 'SIGTERM');
              console.log(`Killed existing process ${pid} on port ${port}`);
            } catch (e) {}
          }
          resolve(true);
        } else {
          resolve(false);
        }
      });

      lsofChild.on('error', () => {
        // lsof not available, try fuser
        const fuserChild = spawn('fuser', ['-k', '-TERM', String(port) + '/tcp']);
        let fuserOutput = '';
        fuserChild.stdout.on('data', (data) => { fuserOutput += data.toString(); });
        fuserChild.stderr.on('data', (data) => { fuserOutput += data.toString(); });

        fuserChild.on('close', () => {
          resolve(fuserOutput.includes(String(port)));
        });

        fuserChild.on('error', () => {
          resolve(false);
        });
      });
    });
  } catch (e) {
    console.error(`Error killing process on port ${port}:`, e.message);
    return false;
  }
}

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

// Handle address already in use - kill existing process and retry once
httpServer.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);

    // Try to kill any existing process on this port
    const killed = await killProcessOnPort(PORT);

    if (killed) {
      console.log(`Retrying after killing existing process...`);
      // Give a moment for the port to be released
      setTimeout(() => {
        httpServer.listen(PORT, () => {
          console.log(`WebSocket bridge listening on ws://localhost:${PORT} (retry)`);
          console.log(`HTTP status at http://localhost:${PORT}/`);
          console.log(`Mock mode: ${process.env.MOCK_MODE === 'true' ? 'enabled' : 'disabled'}`);
          console.log(`Server ID: ${SERVER_ID}`);

          startBonjour();
          console.log('Waiting for clients...');
        });
      }, 500);
    } else {
      console.error(`\nCould not kill existing process on port ${PORT}.`);
      console.error('Please manually kill any processes using this port and try again.');
      process.exit(1);
    }
  } else {
    throw err;
  }
});
