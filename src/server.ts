// ============================================================================
// = pocket-copilot daemon 入口                                                 =
// 职责：                                                                          =
//   1. 连接 agent host（AHP），镜像焦点会话状态（AhpConnection + AhpMirror）     =
//   2. 暴露简化手机协议（WS /ws），鉴权 + 视图快照节流推送（PhoneHub）           =
//   3. 静态托管前端（web/dist，调试期）+ /api/pair 配对 + /api/health            =
// 原始 AHP token 只在本进程内使用，不出电脑。                                     =
// ============================================================================

import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { WebSocketServer } from 'ws';

import {
  HOST,
  PORT,
  WEB_ROOT,
  STATUS_PAGE,
  AGENT_HOST_PORT,
  readAgentHostToken,
} from './config.js';
import { AhpConnection } from './ahp/connection.js';
import { AhpMirror } from './ahp/mirror.js';
import { PhoneHub } from './phone/hub.js';
import { registerDevice, qrPayload } from './phone/pairing.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// AHP 链路：mirror ⇄ hub，connection 驱动
// （hub 与 mirror 互相引用，用 let + 闭包延迟绑定，运行时才调用）
// ---------------------------------------------------------------------------

let hub: PhoneHub;
const mirror = new AhpMirror({
  onSessions: (s) => hub.onSessions(s),
  onChat: (sessionId, chat) => hub.onChat(sessionId, chat),
  onFocusChanging: (sessionId) => hub.onFocusChanging(sessionId),
});
hub = new PhoneHub(mirror);

const connection = new AhpConnection({
  onReady: (client) => {
    void mirror.start(client);
  },
  onLost: () => {
    mirror.stop();
  },
});

// ---------------------------------------------------------------------------
// HTTP + WS
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        agentHostPort: AGENT_HOST_PORT,
        ahpConnected: connection.clientOrNull !== null,
      }),
    );
    return;
  }

  if (url === '/api/status') {
    const view = hub.getLatestView();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        port: PORT,
        ahp: {
          connected: connection.clientOrNull !== null,
          agentHostPort: AGENT_HOST_PORT,
          focusSessionId: mirror.focusSessionId,
        },
        phones: hub.getPhoneStatus(),
        sessions: hub.getSessions(),
        focus: view
          ? {
              id: mirror.focusSessionId,
              streaming: view.streaming,
              messageCount: view.messages.length,
              pendingCount: view.pending.length,
            }
          : null,
      }),
    );
    return;
  }

  if (url === '/status') {
    void (async () => {
      try {
        const data = await fsp.readFile(STATUS_PAGE);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      } catch {
        res.writeHead(500);
        res.end('status page missing');
      }
    })();
    return;
  }

  if (url === '/api/pair') {
    handlePair(req, res);
    return;
  }

  if (url === '/api/config') {
    // 兼容旧 PWA：仍返回 agent host 端口 + token
    const token = readAgentHostToken();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agentHostPort: AGENT_HOST_PORT, token }));
    return;
  }

  void serveStatic(req, res, url);
});

// WS upgrade：仅 /ws 走手机协议，其余拒绝
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  log('ws', `upgrade ${url} ua=${req.headers['user-agent'] ?? 'none'}`);
  if (url === '/ws' || url.startsWith('/ws?')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.handleConnection(ws);
    });
  } else {
    socket.destroy();
  }
});

function handlePair(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let name = 'phone';
    try {
      name = JSON.parse(body).name ?? 'phone';
    } catch {
      // 忽略
    }
    void (async () => {
      const deviceToken = await registerDevice(name);
      // host/port 由客户端指定（跨设备时传 Tailscale IP / 公网映射端口）；缺省回环 + 本机端口
      let host = '127.0.0.1';
      let port = PORT;
      try {
        const p = JSON.parse(body);
        if (typeof p.host === 'string' && p.host.length > 0) host = p.host;
        if (Number.isInteger(p.port) && p.port > 0) port = p.port;
      } catch {
        // 忽略
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          deviceToken,
          qr: qrPayload(host, port, deviceToken),
        }),
      );
    })();
  });
}

// ---------------------------------------------------------------------------
// 静态托管（调试期保留；M4 后前端为 Android App，可移除）
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
): Promise<void> {
  let pathname = decodeURIComponent(url.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(WEB_ROOT, pathname);
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  log('pocket', `daemon 已启动：http://${HOST}:${PORT}`);
  log('pocket', `手机 WS：ws://${HOST}:${PORT}/ws`);
  log('pocket', `agent host 端口：${AGENT_HOST_PORT}`);
  hub.start();
  connection.start();
});
