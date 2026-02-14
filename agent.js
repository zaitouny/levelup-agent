const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

let isLocked = false;
let blockerProcess = null;
let disconnectTimer = null;
let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let blockerHtmlPath = null;

function getConfigPath() {
  return path.join(path.dirname(process.execPath), 'config.json');
}

function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    console.error('Missing config.json next to executable');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error('Invalid config.json');
    process.exit(1);
  }

  if (!config || typeof config.serverUrl !== 'string' || !config.serverUrl.trim()) {
    console.error('Invalid config: serverUrl is required');
    process.exit(1);
  }

  if (!config || typeof config.authToken !== 'string' || !config.authToken.trim()) {
    console.error('Invalid config: authToken is required');
    process.exit(1);
  }

  return {
    serverUrl: config.serverUrl.trim(),
    authToken: config.authToken.trim()
  };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '0.0.0.0';
}

function getSystemPayload() {
  return {
    deviceName: os.hostname(),
    localIP: getLocalIP(),
    osVersion: `${os.type()} ${os.release()}`,
    uptime: os.uptime()
  };
}

function toWsUrl(serverUrl, authToken) {
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch (error) {
    console.error('Invalid config: serverUrl format is invalid');
    process.exit(1);
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    console.error('Invalid config: serverUrl must use http or https');
    process.exit(1);
  }

  parsed.pathname = '/api/v1/realtime';
  parsed.search = `token=${encodeURIComponent(authToken)}`;
  return parsed.toString();
}

function sendMessage(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendRegistration() {
  sendMessage({
    type: 'agent.register',
    data: getSystemPayload()
  });
}

function sendHeartbeat() {
  sendMessage({
    type: 'agent.heartbeat',
    data: getSystemPayload()
  });
}

function createBlockerHtml() {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LevelUp Blocker</title><style>html,body{margin:0;padding:0;width:100%;height:100%;background:#000;color:#fff;overflow:hidden;user-select:none;cursor:none;font-family:Segoe UI,Arial,sans-serif}body{display:flex;align-items:center;justify-content:center;text-align:center}.wrap{display:flex;flex-direction:column;gap:16px}.t1{font-size:64px;font-weight:700;line-height:1.1}.t2{font-size:30px;opacity:.95}</style></head><body><div class="wrap"><div class="t1">Session Paused</div><div class="t2">Please wait for admin</div></div><script>window.oncontextmenu=()=>false;window.onkeydown=(e)=>{e.preventDefault();return false};window.onkeyup=(e)=>{e.preventDefault();return false};window.onkeypress=(e)=>{e.preventDefault();return false};</script></body></html>';
  blockerHtmlPath = path.join(os.tmpdir(), `levelup-blocker-${process.pid}.html`);
  fs.writeFileSync(blockerHtmlPath, html, 'utf8');
  return blockerHtmlPath;
}

function removeBlockerHtml() {
  if (!blockerHtmlPath) return;
  try {
    if (fs.existsSync(blockerHtmlPath)) fs.unlinkSync(blockerHtmlPath);
  } catch (_) {}
  blockerHtmlPath = null;
}

function resolveEdgeExecutable() {
  const candidates = [
    'msedge',
    'msedge.exe',
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];

  for (const candidate of candidates) {
    if (candidate === 'msedge' || candidate === 'msedge.exe') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'msedge';
}

function startBlocker() {
  if (isLocked) return;

  try {
    const htmlPath = createBlockerHtml();
    const edge = resolveEdgeExecutable();
    const url = pathToFileURL(htmlPath).toString();
    const args = ['--kiosk', '--edge-kiosk-type=fullscreen', '--no-first-run', '--disable-restore-session-state', url];

    blockerProcess = spawn(edge, args, {
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });

    blockerProcess.on('exit', () => {
      blockerProcess = null;
      if (isLocked) {
        isLocked = false;
        removeBlockerHtml();
        console.log('🔓 Blocker released');
      }
    });

    blockerProcess.on('error', () => {
      blockerProcess = null;
      if (isLocked) {
        isLocked = false;
        removeBlockerHtml();
        console.log('🔓 Blocker released');
      }
    });

    isLocked = true;
    console.log('🔒 Blocker activated');
  } catch (error) {
    isLocked = false;
    blockerProcess = null;
    removeBlockerHtml();
    console.error('Blocker start failed:', error.message);
  }
}

function stopBlocker() {
  if (!isLocked) return;

  if (blockerProcess && blockerProcess.pid) {
    try {
      exec(`taskkill /PID ${blockerProcess.pid} /T /F`, () => {});
    } catch (_) {}
  }

  blockerProcess = null;
  isLocked = false;
  removeBlockerHtml();
  exec('taskkill /IM msedge.exe /F', () => {});
  console.log('🔓 Blocker released');
}

function handleCommand(command) {
  switch (command) {
    case 'lock':
      startBlocker();
      break;
    case 'unlock':
      stopBlocker();
      break;
    case 'shutdown':
      exec('shutdown /s /t 0');
      break;
    case 'restart':
      exec('shutdown /r /t 0');
      break;
    default:
      break;
  }
}

function scheduleReconnect(connectFn) {
  if (reconnectTimer) return;
  console.log('Reconnecting');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectFn();
  }, 3000);
}

function connectWebSocket(wsUrl) {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log('Connected');
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    sendRegistration();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'command' && typeof msg.data === 'string') {
        handleCommand(msg.data);
      }
    } catch (_) {}
  });

  ws.on('error', (error) => {
    console.error('Error', error.message);
  });

  ws.on('close', () => {
    console.log('Disconnected');
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      if (isLocked) stopBlocker();
      disconnectTimer = null;
    }, 60000);
    scheduleReconnect(() => connectWebSocket(wsUrl));
  });
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    sendHeartbeat();
  }, 10000);
}

function start() {
  const config = loadConfig();
  const wsUrl = toWsUrl(config.serverUrl, config.authToken);
  connectWebSocket(wsUrl);
  startHeartbeat();
}

start();
