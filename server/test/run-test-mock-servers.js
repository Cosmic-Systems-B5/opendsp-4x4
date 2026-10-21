// run-test-mock-servers.js
// Usage: node run-test-mock-servers.js

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [8765, 8766];
const WEB_PORT = 5173;

const servers = [];
let webProcess = null;

const ts = () => new Date().toLocaleTimeString();
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Start one mock server; resolve only once it prints its ready line.
// Rejects on exit-before-ready or on spawn error.
// ---------------------------------------------------------------------------

function startMockServer(port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), MOCK_MODE: 'true' };
    const args = [join(__dirname, '..', 'bridge.js')];

    log(`Starting mock server on port ${port}...`);
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);

    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const onData = (buf) => {
      const s = buf.toString();
      // Echo every line prefixed with the port
      for (const line of s.split('\n')) {
        if (line) console.log(`[Server ${port}] ${line}`);
      }
      // Stable readiness marker (see bridge.js patch below)
      if (s.includes(`READY ${port}`) || s.includes('WebSocket bridge on ws://')) {
        log(`Mock server ready on port ${port}`);
        settle(resolve, child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (buf) => {
      process.stderr.write(`[Server ${port}!] ${buf}`);
    });

    child.on('error', (err) => settle(reject, err));
    child.on('exit', (code) => {
      if (!settled) settle(reject, new Error(`Server ${port} exited early (code ${code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// Optional Vite dev server — skipped if ../web doesn't exist
// ---------------------------------------------------------------------------

function startWebApp() {
  const webDir = join(__dirname, '../../', 'web');
  if (!existsSync(webDir)) {
    log(`No web/ directory at ${webDir} — skipping Vite dev server`);
    log(`(bridge.js serves the dashboard itself at each server's /)`);
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    log(`Starting web app dev server in ${webDir} on port ${WEB_PORT}...`);
    const child = spawn('npm', ['run', 'dev', '--', '--host', '--port', String(WEB_PORT)], {
      cwd: webDir,
      env: { ...process.env, PORT: String(WEB_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    webProcess = child;

    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const onData = (buf) => {
      const s = buf.toString();
      for (const line of s.split('\n')) if (line) console.log(`[Web App] ${line}`);
      if (s.includes('Local:') || s.includes('ready in')) {
        log('Web app dev server is ready');
        settle(resolve, child);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (buf) => process.stderr.write(`[Web App!] ${buf}`));
    child.on('error', (err) => settle(reject, err));
    child.on('exit', (code) => {
      if (!settled) settle(reject, new Error(`Web app exited early (code ${code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function cleanup() {
  log('\nStopping servers...');
  if (webProcess) { try { webProcess.kill('SIGTERM'); } catch {} }
  for (const s of servers) { try { s.kill('SIGTERM'); } catch {} }
  log('All servers stopped.');
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n=== openDSP-4x4 Mock Server Test Suite ===\n');

  // Sequential spawn is fine now — each promise resolves on its own readiness.
  await startMockServer(PORTS[0]);
  await startMockServer(PORTS[1]);

  // Optional web UI
  await startWebApp();

  log('\n=== Running ===');
  for (const p of PORTS) {
    log(`Server ${p}:  dashboard http://localhost:${p}/   ws ws://localhost:${p}/`);
  }
  if (webProcess) log(`Web app:    http://localhost:${WEB_PORT}`);
  log('Press Ctrl+C to stop.\n');

  await new Promise(() => {}); // keep alive
}

main().catch((err) => {
  console.error('Fatal:', err);
  cleanup();
});