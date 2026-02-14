const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const WebSocket = require('ws');
const si = require('systeminformation');

function resolveConfigPath() {
  const packagedPath = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(packagedPath)) return packagedPath;
  return path.join(__dirname, 'config.json');
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

async function getSystemPayload() {
  const osInfo = await si.osInfo();
  return {
    deviceName: os.hostname(),
    localIP: getLocalIP(),
    osVersion: `${osInfo.distro} ${osInfo.release}`,
    uptime: os.uptime()
  };
}

async function start() {
  try {
    const configPath = resolveConfigPath();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config.serverUrl || !config.authToken) {
      throw new Error('Invalid config.json (serverUrl or authToken missing)');
    }

    const wsUrl =
      config.serverUrl.replace(/^http/, 'ws') +
      `/api/v1/realtime?token=${config.authToken}`;

    console.log('Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);

    ws.on('open', async () => {
      console.log('✅ Connected to server');

      const payload = await getSystemPayload();

      ws.send(
        JSON.stringify({
          type: 'agent.register',
          data: payload
        })
      );

      console.log('📡 Registered:', payload);
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());

        // Ping from server
        if (data.type === 'realtime.ping') {
          ws.send(
            JSON.stringify({
              type: 'agent.pong',
              ts: Date.now()
            })
          );
          return;
        }

        // Commands
        if (data.type === 'command') {
          console.log('⚡ Command received:', data.data);

          switch (data.data) {
            case 'lock':
              console.log('🔒 DEVICE LOCKED');
              break;

            case 'unlock':
              console.log('🔓 DEVICE UNLOCKED');
              break;

            case 'shutdown':
              exec('shutdown /s /t 0');
              break;

            case 'restart':
              exec('shutdown /r /t 0');
              break;

            default:
              console.log('Unknown command:', data.data);
          }
        }
      } catch (err) {
        console.error('Message parse error:', err.message);
      }
    });

    ws.on('close', (code, reason) => {
      console.log('❌ Disconnected:', code, reason?.toString());
      setTimeout(start, 5000); // Auto-reconnect
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err.message);
    });

    // Heartbeat every 10 seconds
    setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const payload = await getSystemPayload();

      ws.send(
        JSON.stringify({
          type: 'agent.heartbeat',
          data: payload
        })
      );

      console.log('💓 Heartbeat sent');
    }, 10000);
  } catch (err) {
    console.error('❌ Agent startup failed:', err.message);
    process.exit(1);
  }
}

start();