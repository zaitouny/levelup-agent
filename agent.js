/* LevelUp Agent (WS) - Stable Edge Kiosk Blocker
   - Reads config.json next to exe
   - Connects to ws://<server>/api/v1/realtime?token=<authToken>
   - Commands: lock / unlock / shutdown / restart
   - Lock: launches Microsoft Edge in Kiosk fullscreen to a local blocker HTML
   - Watchdog: relaunches kiosk if closed while locked
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

// -------------------- State --------------------
let isLocked = false;

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let wsPingTimer = null;

let blockerHtmlPath = null;
let blockerUrl = null;

let edgeProc = null;         // spawn handle (may be null if detached)
let edgePid = null;          // pid we started
let edgeUserDataDir = null;  // unique profile dir for kiosk
let watchdogTimer = null;

const HEARTBEAT_MS = 10_000;
const WS_PING_MS = 15_000;
const RECONNECT_MS = 3_000;
const WATCHDOG_MS = 2_000;

// -------------------- Helpers --------------------
function isWindows() {
  return process.platform === 'win32';
}

function safeExec(cmd) {
  exec(cmd, { windowsHide: true }, () => {});
}

function getConfigPath() {
  // For packaged EXE: config.json next to exe
  // For dev: you can also place config.json in cwd
  const exeDir = path.dirname(process.execPath);
  const packaged = path.join(exeDir, 'config.json');
  if (fs.existsSync(packaged)) return packaged;

  const cwd = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(cwd)) return cwd;

  // Fallback next to script
  return path.join(__dirname, 'config.json');
}

function loadConfig() {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    console.error('❌ Missing config.json. Put it next to the EXE.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.error('❌ Invalid config.json (not valid JSON).');
    process.exit(1);
  }

  if (!config || typeof config.serverUrl !== 'string' || !config.serverUrl.trim()) {
    console.error('❌ Invalid config: serverUrl is required');
    process.exit(1);
  }
  if (!config || typeof config.authToken !== 'string' || !config.authToken.trim()) {
    console.error('❌ Invalid config: authToken is required');
    process.exit(1);
  }

  return {
    serverUrl: config.serverUrl.trim(),
    authToken: config.authToken.trim(),
  };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '0.0.0.0';
}

function getSystemPayload() {
  return {
    deviceName: os.hostname(),
    localIP: getLocalIP(),
    osVersion: `${os.type()} ${os.release()}`,
    uptime: os.uptime(),
  };
}

function toWsUrl(serverUrl, authToken) {
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    console.error('❌ Invalid config: serverUrl format is invalid');
    process.exit(1);
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    console.error('❌ Invalid config: serverUrl must use http or https');
    process.exit(1);
  }

  parsed.pathname = '/api/v1/realtime';
  parsed.search = `token=${encodeURIComponent(authToken)}`;
  return parsed.toString();
}

function wsSend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendRegistration() {
  wsSend({ type: 'agent.register', data: getSystemPayload() });
}

function sendHeartbeat() {
  wsSend({ type: 'agent.heartbeat', data: getSystemPayload() });
}

// -------------------- Blocker (Edge Kiosk) --------------------
function ensureBlockerHtml() {
  if (blockerUrl && blockerHtmlPath && fs.existsSync(blockerHtmlPath)) return blockerUrl;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>LevelUp Blocker</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:#000;color:#fff;overflow:hidden;user-select:none;cursor:none;font-family:Segoe UI,Arial,sans-serif}
  body{display:flex;align-items:center;justify-content:center;text-align:center}
  .wrap{display:flex;flex-direction:column;gap:16px}
  .t1{font-size:64px;font-weight:700;line-height:1.1}
  .t2{font-size:30px;opacity:.95}
</style>
</head>
<body>
  <div class="wrap">
    <div class="t1">Session Paused</div>
    <div class="t2">Please wait for admin</div>
  </div>
  <script>
    window.oncontextmenu=()=>false;
    window.onkeydown=(e)=>{e.preventDefault();return false};
    window.onkeyup=(e)=>{e.preventDefault();return false};
    window.onkeypress=(e)=>{e.preventDefault();return false};
  </script>
</body>
</html>`;

  blockerHtmlPath = path.join(os.tmpdir(), `levelup-blocker-${process.pid}.html`);
  fs.writeFileSync(blockerHtmlPath, html, 'utf8');
  blockerUrl = pathToFileURL(blockerHtmlPath).toString();
  return blockerUrl;
}

function cleanupBlockerHtml() {
  if (blockerHtmlPath) {
    try {
      if (fs.existsSync(blockerHtmlPath)) fs.unlinkSync(blockerHtmlPath);
    } catch {}
  }
  blockerHtmlPath = null;
  blockerUrl = null;
}

function resolveEdgeExecutable() {
  // Prefer full paths, then fallback to "msedge"
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'msedge',
    'msedge.exe',
  ];

  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      return c;
    }
  }
  return 'msedge';
}

function makeEdgeProfileDir() {
  // unique profile dir so no restore session / no shared edge windows
  const dir = path.join(os.tmpdir(), `levelup-edge-profile-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function killEdgeProcess() {
  // kill the exact pid first
  if (edgePid) safeExec(`taskkill /PID ${edgePid} /T /F`);
  edgePid = null;
  edgeProc = null;

  // hard kill any kiosk left (optional but helps)
  safeExec('taskkill /IM msedge.exe /F');
}

function startEdgeKiosk(url) {
  if (!isWindows()) return;

  const edge = resolveEdgeExecutable();

  // Create dedicated profile dir per run
  edgeUserDataDir = makeEdgeProfileDir();

  // Edge kiosk args (Edge-only)
  const args = [
    '--kiosk',
    '--edge-kiosk-type=fullscreen',
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    `--user-data-dir=${edgeUserDataDir}`,
    url,
  ];

  try {
    const child = spawn(edge, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    edgeProc = child;
    edgePid = child.pid;
    child.unref();

    // NOTE: detached+unref may not reliably emit exit; that's why watchdog exists
  } catch (e) {
    edgeProc = null;
    edgePid = null;
    console.error('❌ Failed to launch Edge kiosk:', e?.message || 'unknown');
  }
}

function isEdgeRunning() {
  if (!isWindows()) return false;
  // If we have a PID, check it
  if (edgePid) {
    // tasklist returns 0 even if not found sometimes; parse output
    // We do a synchronous-ish check using exec with callback via a Promise pattern avoided here
    // We'll use a quick heuristic by spawning tasklist and parsing.
    // For simplicity: return true if PID exists in tasklist output.
    return true; // actual check handled by watchdog using tasklist, see below
  }
  return false;
}

function scheduleWatchdog() {
  if (!isWindows()) return;
  if (watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    if (!isLocked) return;

    // Check if Edge is running; if pid known, confirm it's alive
    if (edgePid) {
      exec(`tasklist /FI "PID eq ${edgePid}"`, { windowsHide: true }, (err, stdout) => {
        const alive = !err && stdout && stdout.toLowerCase().includes(`${edgePid}`.toLowerCase());
        if (!alive) {
          edgePid = null;
          edgeProc = null;
          // relaunch
          const url = ensureBlockerHtml();
          startEdgeKiosk(url);
        }
      });
      return;
    }

    // If no pid (unknown), just ensure kiosk is up by relaunching once
    const url = ensureBlockerHtml();
    startEdgeKiosk(url);
  }, WATCHDOG_MS);
}

function stopWatchdog() {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function lockNow() {
  if (isLocked) return;
  isLocked = true;

  const url = ensureBlockerHtml();

  // Kill old Edge sessions to reduce escape chance
  safeExec('taskkill /IM msedge.exe /F');

  startEdgeKiosk(url);
  scheduleWatchdog();

  console.log('🔒 LOCKED');
}

function unlockNow() {
  if (!isLocked) return;
  isLocked = false;

  stopWatchdog();
  killEdgeProcess();
  cleanupBlockerHtml();

  // Clean profile dir (best-effort)
  if (edgeUserDataDir) {
    try {
      fs.rmSync(edgeUserDataDir, { recursive: true, force: true });
    } catch {}
  }
  edgeUserDataDir = null;

  console.log('🔓 UNLOCKED');
}

// -------------------- Commands --------------------
function handleCommand(command) {
  switch (command) {
    case 'lock':
      lockNow();
      break;
    case 'unlock':
      unlockNow();
      break;
    case 'shutdown':
      if (isWindows()) exec('shutdown /s /t 0');
      break;
    case 'restart':
      if (isWindows()) exec('shutdown /r /t 0');
      break;
    default:
      break;
  }
}

// -------------------- WebSocket --------------------
function scheduleReconnect(connectFn) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectFn();
  }, RECONNECT_MS);
}

function connectWebSocket(wsUrl) {
  console.log('Connecting to:', wsUrl);

  // Close old ws if any
  try { if (ws) ws.terminate(); } catch {}
  ws = null;

  ws = new WebSocket(wsUrl, {
    handshakeTimeout: 10_000,
    perMessageDeflate: false,
  });

  ws.on('open', () => {
    console.log('✅ Connected');
    sendRegistration();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'command' && typeof msg.data === 'string') {
        console.log('⚡ Command received:', msg.data);
        handleCommand(msg.data);
      }
    } catch {}
  });

  ws.on('error', (error) => {
    console.error('❌ WS Error:', error?.message || 'unknown');
  });

  ws.on('close', () => {
    console.log('🔌 Disconnected');
    scheduleReconnect(() => connectWebSocket(wsUrl));
  });
}

function startHeartbeatLoops() {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      sendHeartbeat();
    }, HEARTBEAT_MS);
  }

  // WebSocket ping frames to keep NAT/firewalls from killing idle sockets
  if (!wsPingTimer) {
    wsPingTimer = setInterval(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
      } catch {}
    }, WS_PING_MS);
  }
}

// -------------------- Start --------------------
function start() {
  if (!isWindows()) {
    console.error('This agent is intended for Windows machines.');
  }

  const config = loadConfig();
  const wsUrl = toWsUrl(config.serverUrl, config.authToken);

  connectWebSocket(wsUrl);
  startHeartbeatLoops();
}

start();