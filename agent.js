const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const io = require('socket.io-client');
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
  const configPath = resolveConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const socket = io(config.serverUrl, {
    auth: { token: config.authToken },
    transports: ['websocket']
  });

  socket.on('connect', async () => {
    try {
      const payload = await getSystemPayload();
      socket.emit('agent:register', payload);
      console.log('Connected to server:', config.serverUrl);
      console.log('Registered:', payload);
    } catch (error) {
      console.error('Failed to register agent:', error.message);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
  });

  socket.on('connect_error', (error) => {
    console.error('Connection error:', error.message);
  });

  setInterval(async () => {
    if (!socket.connected) return;
    try {
      const payload = await getSystemPayload();
      socket.emit('agent:heartbeat', payload);
      console.log('Heartbeat sent');
    } catch (error) {
      console.error('Heartbeat failed:', error.message);
    }
  }, 10000);

  socket.on('command', (command) => {
    switch (command) {
      case 'lock':
        console.log('DEVICE LOCKED');
        break;
      case 'unlock':
        console.log('DEVICE UNLOCKED');
        break;
      case 'shutdown':
        exec('shutdown /s /t 0');
        break;
      case 'restart':
        exec('shutdown /r /t 0');
        break;
      default:
        console.log('Unknown command:', command);
    }
  });
}

start().catch((error) => {
  console.error('Agent startup failed:', error.message);
  process.exit(1);
});
