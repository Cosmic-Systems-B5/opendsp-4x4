# openDSP-4x4 WebSocket Bridge

This Node.js server provides a WebSocket-to-HID bridge, allowing remote web UI to control a DSP device connected via USB.

## Requirements

- Node.js 18+
- node-hid package (`npm install node-hid`)

## Installation

```bash
cd server
npm install
```

For HID support on Linux, you may need to add udev rules:

```bash
# Create /etc/udev/rules.d/99-opendsp.rules
SUBSYSTEM=="usb", ATTR{idVendor}=="0168", ATTR{idProduct}=="0821", MODE="0666"
```

## Usage

Start the server:

```bash
npm start
```

The server will:
1. Listen for WebSocket connections on port 8765 (default)
2. Attempt to connect to a DSP device via USB HID
3. Proxy requests from web clients to the device and relay responses

## Connecting the Web UI

In the openDSP-4x4 web interface:

1. Click "Remote" in the connection controls
2. Enter `ws://<server-ip>:8765` (or use the default `ws://localhost:8765`)
3. Click "Connect DSP"

The server status is available at `http://<server-ip>:8765/`

## Protocol

Messages are sent as JSON strings over WebSocket:

**Client → Server:**
```json
{"type": "request", "data": "<base64-encoded-hid-report>"}
```

**Server → Client:**
```json
{"type": "report", "data": "<base64-encoded-hid-reply>"}
```

The HID report format follows the t.racks DSP 4x4 Mini Pro protocol:
- DLE STX | payload | DLE ETX | checksum
- Request payload: [0x00, addr, N, code, ...data]
