const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');
const io = require('socket.io-client');
const si = require('systeminformation');

let isLocked = false;
let blockerProcess = null;
let disconnectTimer = null;

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

function buildBlockerScript() {
  return String.raw`
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeMethods {
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(ref RECT lpRect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ClipCursor(IntPtr lpRect);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$taskbar = [Win32.NativeMethods]::FindWindow("Shell_TrayWnd", $null)
if ($taskbar -ne [IntPtr]::Zero) { [Win32.NativeMethods]::ShowWindow($taskbar, 0) | Out-Null }
$win = New-Object Windows.Window
$win.WindowStyle = [Windows.WindowStyle]::None
$win.ResizeMode = [Windows.ResizeMode]::NoResize
$win.WindowState = [Windows.WindowState]::Maximized
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.Background = [Windows.Media.Brushes]::Black
$win.Cursor = [Windows.Input.Cursors]::None
$grid = New-Object Windows.Controls.Grid
$stack = New-Object Windows.Controls.StackPanel
$stack.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
$stack.VerticalAlignment = [Windows.VerticalAlignment]::Center
$t1 = New-Object Windows.Controls.TextBlock
$t1.Text = "Session Paused"
$t1.FontSize = 64
$t1.Foreground = [Windows.Media.Brushes]::White
$t1.TextAlignment = [Windows.TextAlignment]::Center
$t1.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
$t2 = New-Object Windows.Controls.TextBlock
$t2.Text = "Please wait for admin"
$t2.Margin = "0,18,0,0"
$t2.FontSize = 30
$t2.Foreground = [Windows.Media.Brushes]::White
$t2.TextAlignment = [Windows.TextAlignment]::Center
$t2.HorizontalAlignment = [Windows.HorizontalAlignment]::Center
$stack.Children.Add($t1) | Out-Null
$stack.Children.Add($t2) | Out-Null
$grid.Children.Add($stack) | Out-Null
$win.Content = $grid
$blocked = {
  param($s,$e)
  $alt = ($e.KeyboardDevice.Modifiers -band [Windows.Input.ModifierKeys]::Alt) -ne 0
  if ($e.Key -eq [Windows.Input.Key]::Escape -or $e.Key -eq [Windows.Input.Key]::LWin -or $e.Key -eq [Windows.Input.Key]::RWin -or ($alt -and ($e.SystemKey -eq [Windows.Input.Key]::F4 -or $e.SystemKey -eq [Windows.Input.Key]::Tab -or $e.Key -eq [Windows.Input.Key]::Tab))) {
    $e.Handled = $true
  }
}
$win.Add_PreviewKeyDown($blocked)
$win.Add_Closing({ param($s,$e) $e.Cancel = $true })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
  $w = [System.Windows.SystemParameters]::PrimaryScreenWidth
  $h = [System.Windows.SystemParameters]::PrimaryScreenHeight
  $rect = New-Object Win32.NativeMethods+RECT
  $rect.Left = 0
  $rect.Top = 0
  $rect.Right = [int]$w
  $rect.Bottom = [int]$h
  [Win32.NativeMethods]::ClipCursor([ref]$rect) | Out-Null
  if ([Win32.NativeMethods]::GetAsyncKeyState(0x5B) -ne 0 -or [Win32.NativeMethods]::GetAsyncKeyState(0x5C) -ne 0) {
    [Console]::Beep(37, 20)
  }
})
$timer.Start()
try {
  $win.ShowDialog() | Out-Null
} finally {
  $timer.Stop()
  [Win32.NativeMethods]::ClipCursor([IntPtr]::Zero) | Out-Null
  if ($taskbar -ne [IntPtr]::Zero) { [Win32.NativeMethods]::ShowWindow($taskbar, 5) | Out-Null }
}
`;
}

function startBlocker() {
  if (isLocked) return;
  const script = buildBlockerScript();
  blockerProcess = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: false,
    stdio: 'ignore'
  });

  blockerProcess.on('exit', () => {
    blockerProcess = null;
    if (isLocked) {
      isLocked = false;
      console.log('🔓 Blocker released');
    }
  });

  blockerProcess.on('error', () => {
    blockerProcess = null;
    if (isLocked) {
      isLocked = false;
      console.log('🔓 Blocker released');
    }
  });

  isLocked = true;
  console.log('🔒 Blocker activated');
}

function stopBlocker() {
  if (!isLocked) return;
  if (blockerProcess && blockerProcess.pid) {
    try {
      process.kill(blockerProcess.pid, 'SIGTERM');
    } catch (_) {}
    exec(`taskkill /PID ${blockerProcess.pid} /T /F`, () => {});
  }
  blockerProcess = null;
  isLocked = false;
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \"[System.Runtime.InteropServices.DllImport(\\\"user32.dll\\\")] public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName); [System.Runtime.InteropServices.DllImport(\\\"user32.dll\\\")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);\"; $h=[Win32.NativeMethods]::FindWindow(\\\"Shell_TrayWnd\\\",$null); if($h -ne [IntPtr]::Zero){[Win32.NativeMethods]::ShowWindow($h,5)|Out-Null}"', () => {});
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \"[System.Runtime.InteropServices.DllImport(\\\"user32.dll\\\")] public static extern bool ClipCursor(System.IntPtr lpRect);\"; [Win32.NativeMethods]::ClipCursor([IntPtr]::Zero)|Out-Null"', () => {});
  console.log('🔓 Blocker released');
}

function handleCommand(payload) {
  const command = typeof payload === 'string' ? payload : payload && typeof payload === 'object' ? payload.data || payload.command || '' : '';

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
      console.log('Unknown command:', command);
  }
}

async function start() {
  const configPath = resolveConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const socket = io(config.serverUrl, {
    auth: { token: config.authToken },
    transports: ['websocket']
  });

  socket.on('connect', async () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }

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
    if (disconnectTimer) clearTimeout(disconnectTimer);
    disconnectTimer = setTimeout(() => {
      if (isLocked) stopBlocker();
      disconnectTimer = null;
    }, 60000);
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

  socket.on('command', handleCommand);
}

start().catch((error) => {
  console.error('Agent startup failed:', error.message);
  process.exit(1);
});
