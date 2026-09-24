// pocket-copilot 本地管理器（Electron 主进程）
// 职责：AHP 环境变量读写（HKCU\Environment）、daemon/隧道 进程管理、
//       开机自启（schtasks）、状态轮询（/api/status）、托盘常驻。

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

const DAEMON_PORT = 8765;
const TUNNEL_PORT = 28765;
const PUBLIC_HOST = '122.193.22.120';
const PUBLIC_URL = `http://${PUBLIC_HOST}:${TUNNEL_PORT}`;
const APPDATA = path.join(os.homedir(), 'AppData', 'Local', 'PocketCopilotManager');
const DAEMON_LOG = path.join(APPDATA, 'daemon.log');
const TUNNEL_LOG = path.join(APPDATA, 'tunnel.log');
// 系统自带 OpenSSH 客户端（Win10 1809+ 内置）；隧道 = 直接 spawn ssh.exe -R
const SSH_BIN = 'C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe';
const TASK_NAME = 'PocketCopilotDaemon';
// daemon 编译产物；运行时用软件自带的 Node（即管理器自身的 Electron 可执行文件，
// 以 ELECTRON_RUN_AS_NODE 模式充当 node），不再依赖系统 node / npm / tsx。
const DAEMON_ENTRY = path.join(__dirname, '..', 'dist', 'server.js');

const state = {
  daemon: { managed: false, proc: null, running: false, status: null },
  tunnel: { active: false, managed: false, proc: null, running: false },
  publicUp: false,
  lastPublicCheck: null,
};

let win = null;
let tray = null;
let pollTimer = null;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 递归结束进程树（用于隧道：powershell → ssh 多层） */
async function killTree(pid) {
  // 注意：不能用 $queue[1..($queue.Count-1)] 出队 —— 队列剩 1 个元素时 1..0 是降序范围，
  // 会取出 @($null, 原元素) 造成死循环。用索引计数器代替。
  return psExec(
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `if ($p) { $ids = @(); $queue = @(${pid}); $i = 0; ` +
      `while ($i -lt $queue.Count) { $cur = $queue[$i]; $i++; ` +
      `$ids += $cur; $ids += (Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur" -ErrorAction SilentlyContinue).ProcessId }; ` +
      `$ids | Where-Object { $_ } | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; 'killed' } else { 'gone' }`,
  );
}

function psExec(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: String(err.message || err), stdout: stdout || '', stderr: stderr || '' });
        else resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

const MGR_LOG = path.join(APPDATA, 'manager.log');
function logMgr(msg) {
  try {
    fs.mkdirSync(APPDATA, { recursive: true });
    fs.appendFileSync(MGR_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

// CRC32（PNG 块校验用）
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 生成纯色圆点 PNG（托盘用，避免额外图标资源） */
function dotPng(r, g, b, size = 16) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - (size - 1) / 2;
      const dy = y - (size - 1) / 2;
      const inside = dx * dx + dy * dy <= ((size - 2) / 2) ** 2;
      const off = row + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, mkChunk('IHDR', ihdr), mkChunk('IDAT', zlib.deflateSync(raw)), mkChunk('IEND', Buffer.alloc(0))]);
}

const ICON_GREEN = dotPng(84, 176, 84);
const ICON_YELLOW = dotPng(230, 180, 60);
const ICON_RED = dotPng(220, 80, 70);

/** 读取 HKCU\Environment 中的三个 AHP 变量（JSON 输出，未设置为 null） */
async function readEnvVars() {
  const r = await psExec(
    `$p = Get-ItemProperty -Path 'HKCU:\\Environment' -Name VSCODE_AGENT_HOST_PORT, VSCODE_AGENT_HOST_HOST, VSCODE_AGENT_HOST_CONNECTION_TOKEN -ErrorAction SilentlyContinue; ` +
      `@{ port = $p.VSCODE_AGENT_HOST_PORT; host = $p.VSCODE_AGENT_HOST_HOST; token = $p.VSCODE_AGENT_HOST_CONNECTION_TOKEN } | ConvertTo-Json -Compress`,
  );
  if (!r.ok) return { ok: false, port: '', host: '', token: '' };
  try {
    const j = JSON.parse((r.stdout || '').trim());
    return { ok: true, port: j.port || '', host: j.host || '', token: j.token || '' };
  } catch {
    return { ok: false, port: '', host: '', token: '' };
  }
}

/** 写入 HKCU\Environment（等效 setx） */
async function writeEnvVars(vars) {
  logMgr(`env:save 收到 vars=${JSON.stringify(vars)}`);
  const q = (s) => String(s || '').replace(/'/g, "''");
  const script = [
    `Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'VSCODE_AGENT_HOST_PORT' -Value '${q(vars.port)}'`,
    `Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'VSCODE_AGENT_HOST_HOST' -Value '${q(vars.host)}'`,
    `Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'VSCODE_AGENT_HOST_CONNECTION_TOKEN' -Value '${q(vars.token)}'`,
  ].join('; ');
  const r = await psExec(script);
  logMgr(`env:save psExec ok=${r.ok} error=${r.error || ''} stderr=${JSON.stringify((r.stderr || '').slice(0, 300))}`);
  // 写后读回校验，避免"点了保存但没写进去"无从判断
  if (r.ok) {
    const rb = await readEnvVars();
    logMgr(`env:save 读回 port=${rb.port} host=${rb.host} token=${rb.token ? '已写入' : '空'}`);
    if (!rb.ok || rb.port !== vars.port || rb.host !== vars.host || rb.token !== vars.token) {
      return { ok: false, error: `写后校验不一致（期望 port=${vars.port} host=${vars.host}，实际 port=${rb.port} host=${rb.host} token=${rb.token ? '已写入' : '空'}）` };
    }
  }
  return r;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'GET', timeout: timeoutMs },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ ok: true, json: JSON.parse(data) }); }
          catch { resolve({ ok: false, error: 'invalid json' }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// daemon / 隧道 进程管理
// ---------------------------------------------------------------------------

function tunnelLog(msg) {
  try {
    fs.mkdirSync(APPDATA, { recursive: true });
    fs.appendFileSync(TUNNEL_LOG, `[tunnel] ${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDaemon() {
  if (state.daemon.running) return { ok: true, already: true };
  if (!fs.existsSync(DAEMON_ENTRY)) {
    return { ok: false, error: `未找到 daemon 编译产物 ${DAEMON_ENTRY}，请先在项目根目录运行 npm run build:daemon` };
  }
  fs.mkdirSync(APPDATA, { recursive: true });
  const logStream = fs.openSync(DAEMON_LOG, 'a');
  // token 以注册表为唯一事实来源：启动时读出并注入 daemon 的 AHP_TOKEN 环境变量
  const envVars = await readEnvVars();
  // 用软件自带的 Node 运行时（process.execPath）直接跑编译产物：独立子进程，
  // 崩溃不影响管理器 UI，也不再依赖 powershell → npm → tsx 进程链。
  const proc = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AHP_TOKEN: envVars.token || '' },
    windowsHide: true,
    // detached 让 daemon 脱离管理器所在控制台：从终端启动管理器时关掉终端不会连带杀掉 daemon。
    detached: true,
    stdio: ['ignore', logStream, logStream],
  });
  proc.unref();
  state.daemon.proc = proc;
  state.daemon.managed = true;
  return { ok: true };
}

async function stopDaemon() {
  const d = state.daemon;
  if (d.managed && d.proc) {
    await killTree(d.proc.pid);
    d.proc = null;
    d.managed = false;
    d.running = false;
    return { ok: true, by: 'managed' };
  }
  // 非本应用启动：杀端口宿主 + 其子进程；父进程是 npm/cmd/powershell 时一并杀（避免误伤用户终端）
  const r = await psExec(
    `$c = Get-NetTCPConnection -LocalPort ${DAEMON_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
      `if (-not $c) { 'not-listening'; exit } ` +
      `$id = $c.OwningProcess; $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; ` +
      `$kids = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$id" -ErrorAction SilentlyContinue).ProcessId; ` +
      `Stop-Process -Id $kids -Force -ErrorAction SilentlyContinue; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; ` +
      `if ($ci) { $pn = (Get-Process -Id $ci.ParentProcessId -ErrorAction SilentlyContinue).ProcessName; ` +
      `if ($pn -in 'npm','npm.cmd','cmd','powershell') { Stop-Process -Id $ci.ParentProcessId -Force -ErrorAction SilentlyContinue } }; 'killed'`,
  );
  return { ok: true, by: 'port', detail: r.stdout.trim() };
}

async function tunnelLoop() {
  while (state.tunnel.active) {
    // 重连前先探活：若公网已可达（例如端口被本应用更早的成功会话占用），
    // 则不重复建连，避免 ssh 反复报 "remote port forwarding failed" 空转
    const pub = await fetchJson(`${PUBLIC_URL}/api/status`, 4000);
    if (pub.ok) {
      tunnelLog('公网隧道已可达，30s 后复检');
      await sleep(30000);
      continue;
    }
    tunnelLog(`建立隧道 ${PUBLIC_HOST}:${TUNNEL_PORT} -> 127.0.0.1:${DAEMON_PORT}`);
    fs.mkdirSync(APPDATA, { recursive: true });
    const logStream = fs.openSync(TUNNEL_LOG, 'a');
    const proc = spawn(
      SSH_BIN,
      [
        '-N',
        `-R 0.0.0.0:${TUNNEL_PORT}:127.0.0.1:${DAEMON_PORT}`,
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'BatchMode=yes',
        PUBLIC_HOST,
      ],
      { windowsHide: true, stdio: ['ignore', logStream, logStream] },
    );
    state.tunnel.proc = proc;
    const code = await new Promise((resolve) => {
      proc.on('exit', (c) => resolve(c));
      proc.on('error', (e) => { tunnelLog(`ssh 启动失败：${e.message}`); resolve(-1); });
    });
    try { fs.closeSync(logStream); } catch { /* 已关闭 */ }
    state.tunnel.proc = null;
    if (!state.tunnel.active) break;
    tunnelLog(`隧道断开（exit=${code}），5s 后重连`);
    await sleep(5000);
  }
  state.tunnel.running = false;
}

async function startTunnel() {
  const t = state.tunnel;
  if (t.active) return { ok: true, already: true };
  if (!fs.existsSync(SSH_BIN)) {
    return { ok: false, error: `未找到系统 OpenSSH 客户端（${SSH_BIN}），请在 Windows 可选功能中启用"OpenSSH 客户端"` };
  }
  t.active = true;
  t.managed = true;
  void tunnelLoop();
  return { ok: true };
}

async function stopTunnel() {
  const t = state.tunnel;
  if (t.active) {
    t.active = false; // 退出重连循环
    if (t.proc) {
      try { t.proc.kill(); } catch { /* 已退出 */ }
      t.proc = null;
    }
    t.managed = false;
    t.running = false;
    return { ok: true, by: 'managed' };
  }
  // 非本应用启动的 ssh -R 进程（命令行含 28765 的 ssh.exe）
  const r = await psExec(
    `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${TUNNEL_PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($_.ProcessId)" }`,
  );
  return { ok: true, by: 'ssh', detail: r.stdout.trim() };
}

// ---------------------------------------------------------------------------
// 开机自启（计划任务，Logon 触发）
// ---------------------------------------------------------------------------

async function getAutoStart() {
  const r = await psExec(`schtasks /Query /TN "${TASK_NAME}" /FO LIST 2>$null | Out-String`);
  return r.ok && (r.stdout || '').includes(TASK_NAME);
}

async function setAutoStart(enabled) {
  fs.mkdirSync(APPDATA, { recursive: true });
  if (enabled) {
    const root = path.join(__dirname, '..');
    const script = path.join(APPDATA, 'start-daemon.ps1');
    // 与 startDaemon 相同：软件自带 Node 运行时（当前 Electron 可执行文件）直启编译产物
    const electronBin = process.execPath;
    fs.writeFileSync(
      script,
      `# 由 pocket-copilot 管理器生成：登录时启动 daemon（已运行则跳过）\r\n` +
        `$c = Get-NetTCPConnection -LocalPort ${DAEMON_PORT} -State Listen -ErrorAction SilentlyContinue\r\n` +
        `if (-not $c) {\r\n` +
        `  if (Test-Path '${DAEMON_ENTRY}') {\r\n` +
        `    New-Item -ItemType Directory -Force -Path '${APPDATA}' | Out-Null\r\n` +
        `    $env:ELECTRON_RUN_AS_NODE = '1'\r\n` +
        `    $env:AHP_TOKEN = (Get-ItemProperty -Path 'HKCU:\\Environment' -Name VSCODE_AGENT_HOST_CONNECTION_TOKEN -ErrorAction SilentlyContinue).VSCODE_AGENT_HOST_CONNECTION_TOKEN\r\n` +
        `    & '${electronBin}' '${DAEMON_ENTRY}' *> '${DAEMON_LOG}'\r\n` +
        `  }\r\n` +
        `}\r\n`,
      'utf8',
    );
    const tr = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
    const r = await psExec(`schtasks /Create /F /TN "${TASK_NAME}" /TR "${tr}" /SC ONLOGON`);
    return { ok: r.ok, detail: (r.stdout || r.stderr || '').trim() };
  }
  const r = await psExec(`schtasks /Delete /F /TN "${TASK_NAME}" 2>$null | Out-String`);
  return { ok: true, detail: (r.stdout || r.stderr || '').trim() };
}

// ---------------------------------------------------------------------------
// VS Code 重启（AHP 环境变量生效）
// ---------------------------------------------------------------------------

async function vscodeRunning() {
  const r = await psExec(`Get-Process Code -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`);
  return r.ok && (r.stdout || '').trim().length > 0;
}

async function killVsCode() {
  const r = await psExec(`taskkill /F /IM Code.exe 2>&1 | Out-String`);
  return { ok: true, detail: (r.stdout || '').trim() };
}

async function relaunchVsCode() {
  const candidates = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
    'D:\\App\\Microsoft VS Code\\Code.exe',
  ];
  const target = candidates.find((p) => fs.existsSync(p));
  if (!target) return { ok: false, error: '未找到 Code.exe' };
  spawn(target, [path.join(__dirname, '..')], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true, exe: target };
}

// ---------------------------------------------------------------------------
// 状态轮询
// ---------------------------------------------------------------------------

async function poll() {
  const st = await fetchJson(`http://127.0.0.1:${DAEMON_PORT}/api/status`, 2500);
  state.daemon.status = st.ok ? st.json : null;
  state.daemon.running = st.ok;

  // 公网探活（每 5s 一次，走公网）。SSH -R 远程隧道只在服务器侧监听 28765，
  // 本地永远没有该端口，故"隧道可用"以公网探活为准。
  const now = Date.now();
  if (!state.lastPublicCheck || now - state.lastPublicCheck > 5000) {
    state.lastPublicCheck = now;
    const pub = await fetchJson(`${PUBLIC_URL}/api/status`, 4000);
    state.publicUp = pub.ok;
    state.tunnel.running = state.tunnel.active && pub.ok;
  }

  if (win && !win.isDestroyed()) win.webContents.send('status', buildStatus());
  updateTray();
}

function buildStatus() {
  const s = state.daemon.status;
  return {
    at: new Date().toISOString(),
    daemon: {
      running: state.daemon.running,
      managed: state.daemon.managed,
      pid: s?.pid ?? null,
      uptimeSec: s?.uptimeSec ?? null,
      startedAt: s?.startedAt ?? null,
      ahpConnected: s?.ahp?.connected ?? false,
      agentHostPort: s?.ahp?.agentHostPort ?? 8081,
      focusSessionId: s?.ahp?.focusSessionId ?? null,
      phones: s?.phones ?? [],
      sessions: (s?.sessions ?? []).map((x) => ({ id: x.id, title: x.title, status: x.status })),
      focus: s?.focus ?? null,
    },
    tunnel: { running: state.tunnel.running, managed: state.tunnel.managed, publicUp: state.publicUp, publicUrl: PUBLIC_URL },
  };
}

function updateTray() {
  if (!tray) return;
  const d = state.daemon.running;
  const t = state.tunnel.running;
  const icon = d && t ? ICON_GREEN : d || t ? ICON_YELLOW : ICON_RED;
  const ahp = state.daemon.status?.ahp?.connected ? '（AHP 已连）' : '';
  tray.setImage(nativeImage.createFromBuffer(icon));
  tray.setToolTip(`pocket-copilot 管理器 — daemon: ${d ? '运行中' : '停止'}${ahp} / 隧道: ${t ? '运行中' : '停止'}`);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('env:get', () => readEnvVars());
  ipcMain.handle('env:save', async (_e, vars) => {
    try {
      const r = await writeEnvVars(vars || {});
      logMgr(`ipc env:save 返回 ok=${r.ok} error=${r.error || ''}`);
      return r;
    } catch (e) {
      logMgr(`ipc env:save 异常 ${e.message}`);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vscode:running', () => vscodeRunning());
  ipcMain.handle('vscode:restart', async () => {
    const killed = await killVsCode();
    await new Promise((r) => setTimeout(r, 2500));
    const relaunched = await relaunchVsCode();
    return { ...killed, relaunched };
  });
  ipcMain.handle('daemon:start', startDaemon);
  ipcMain.handle('daemon:stop', stopDaemon);
  ipcMain.handle('tunnel:start', startTunnel);
  ipcMain.handle('tunnel:stop', stopTunnel);
  ipcMain.handle('autostart:get', getAutoStart);
  ipcMain.handle('autostart:set', (_e, enabled) => setAutoStart(!!enabled));
  ipcMain.handle('status:now', () => buildStatus());
  ipcMain.handle('open:log', (_e, which) => {
    const file = which === 'tunnel' ? TUNNEL_LOG : DAEMON_LOG;
    fs.mkdirSync(APPDATA, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    spawn('notepad', [file], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: 'pocket-copilot 管理器',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(ICON_YELLOW));
  tray.setToolTip('pocket-copilot 管理器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: () => { if (win) { win.isVisible() ? win.hide() : win.show(); } } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    logMgr(`app 启动 pid=${process.pid}`);
    registerIpc();
    createWindow();
    createTray();
    pollTimer = setInterval(poll, 3000);
    poll();
  });
  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
  app.on('before-quit', async () => {
    if (state.daemon.managed && state.daemon.proc) await killTree(state.daemon.proc.pid);
    await stopTunnel();
  });
}
