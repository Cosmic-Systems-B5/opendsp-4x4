// Test script to run two servers in mock mode with the web UI
// Usage: node run-test-mock-servers.js

import { spawn, exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [8765, 8766];
const WEB_PORT = 5173;

// Store child processes
const servers = [];
let webProcess = null;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kill any existing process using the given port
 */
function killProcessOnPort(port) {
  return new Promise((resolve) => {
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
            log(`Killed existing process ${pid} on port ${port}`);
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
}

/**
 * Start a mock server instance on the given port
 */
async function startMockServer(port) {
  return new Promise(async (resolve, reject) => {
    // Check if port is in use and kill existing process
    try {
      const { stdout } = await new Promise((res, rej) => {
        exec(`lsof -ti:${port} 2>/dev/null || echo ""`, (err, stdout) => {
          res({ stdout, err });
        });
      });
      const pid = stdout.trim();

      if (pid) {
        log(`Port ${port} is in use by PID ${pid}, killing existing process...`);
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
          // Wait a moment for the port to be released
          await sleep(500);
        } catch (e) {
          log(`Failed to kill process ${pid}: ${e.message}`);
        }
      }
    } catch (e) {
      // lsof not available, continue anyway
      log(`Could not check port ${port} (${e.message})`);
    }

    const env = { ...process.env, PORT: String(port), MOCK_MODE: 'true' };
    const args = [join(__dirname, '..', 'index.js')];

    log(`Starting mock server on port ${port}...`);

    const child = spawn('node', args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: false
    });

    servers.push(child);

    child.stdout.on('data', (data) => {
      console.log(`[Server ${port}] ${data}`);
    });

    // Wait for server to start
    child.stdout.on('data', function check(data) {
      const msg = data.toString();
      if (msg.includes('WebSocket bridge listening')) {
        log(`Mock server started on port ${port}`);
        resolve(child);
      }
    });

    child.on('error', (err) => {
      // Handle EADDRINUSE by killing process and retrying
      if (err.message && err.message.includes('EADDRINUSE')) {
        log(`Port ${port} still in use, attempting to kill...`);
        killProcessOnPort(port).then(() => {
          sleep(500).then(() => {
            // Retry starting the server
            startMockServer(port).then(resolve).catch(reject);
          });
        });
      } else {
        reject(err);
      }
    });

    // Handle early exit
    setTimeout(() => {
      if (!servers.some(s => s === child)) {
        resolve(child);
      }
    }, 2000);
  });
}

/**
 * Start the web app dev server
 */
function startWebApp() {
  return new Promise((resolve, reject) => {
    const webDir = join(__dirname, '..', '..', 'web');
    log(`Starting web app dev server on port ${WEB_PORT}...`);

    // Use npm from parent directory to run web dev server
    const child = spawn('npm', ['run', 'dev'], {
      cwd: webDir,
      env: { ...process.env, PORT: String(WEB_PORT) },
      stdio: ['pipe', 'pipe', 'inherit'],
      detached: false
    });

    webProcess = child;

    child.stdout.on('data', (data) => {
      console.log(`[Web App] ${data}`);
    });

    // Wait for Vite to be ready
    child.stdout.on('data', function check(data) {
      const msg = data.toString();
      if (msg.includes('Local:') || msg.includes('ready in')) {
        log('Web app dev server is ready');
        resolve(child);
      }
    });

    child.on('error', reject);
  });
}

/**
 * Stop all running processes
 */
function cleanup() {
  log('\nStopping servers...');

  // Kill web process first
  if (webProcess) {
    try { webProcess.kill('SIGTERM'); } catch (e) {}
  }

  // Kill server processes
  for (const server of servers) {
    try { server.kill('SIGTERM'); } catch (e) {}
  }

  log('All servers stopped.');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main() {
  console.log('\n=== openDSP-4x4 Mock Server Test Suite ===\n');

  // Set up signal handlers for graceful shutdown
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    // Start two mock servers
    const server1 = await startMockServer(PORTS[0]);
    const server2 = await startMockServer(PORTS[1]);

    log(`\n=== Mock Servers Running ===`);
    log(`Server 1: ws://localhost:${PORTS[0]} (mock mode)`);
    log(`Server 2: ws://localhost:${PORTS[1]} (mock mode)`);

    // Give servers time to fully initialize
    await sleep(1000);

    // Start web app
    const web = await startWebApp();

    log(`\n=== Web App Running ===`);
    log(`Open http://localhost:${WEB_PORT} in your browser`);

    log(`\n=== Test Instructions ===`);
    log(`1. Connect to Server 1: ws://localhost:${PORTS[0]}`);
    log(`2. Connect to Server 2: ws://localhost:${PORTS[1]}`);
    log(`3. Both servers are in mock mode - no USB device required`);
    log(`4. Check /logs/connections endpoint for connection logs`);

    log('\nPress Ctrl+C to stop all servers\n');

    // Keep the process running
    await new Promise(() => {});

  } catch (error) {
    console.error('Error starting servers:', error);
    cleanup();
    process.exit(1);
  }
}

main();
