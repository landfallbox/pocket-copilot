import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { HOST, PORT, WEB_ROOT, WORKSPACE_STORAGE_ROOT } from './config.js';

const NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
);
import { SessionTailer } from './tailer.js';
import { HeimdallTailer } from './heimdall-tailer.js';
import { Registry } from './registry.js';
import { SessionTitleStore } from './session-titles.js';
import { ModelNameStore } from './model-name.js';
import { buildProjectNameMap, workspaceHashOf } from './project-name.js';
import type { BridgeEvent } from './types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 单一状态源：jsonl 只喂会话目录（哪些项目/会话），heimdall 喂请求 + 内容
const registry = new Registry((e: BridgeEvent) => broadcast(withRecorder(e)));

const heimdallTailer = new HeimdallTailer((rec) => registry.onHeimdall(rec));

// 会话标题源（state.vscdb，独立可降级）：标题变化时重推 session_list
const titleStore = new SessionTitleStore();
titleStore.onChange = () => {
  if (clients.size > 0) broadcast({ type: 'session_list', sessions: registry.summaries() });
};
registry.setTitleProvider((sid) => titleStore.get(sid));

// 模型权威名源（chatLanguageModels.json，独立可降级）：注册表变化时重推 session_list
const modelNameStore = new ModelNameStore();
modelNameStore.onChange = () => {
  if (clients.size > 0) broadcast({ type: 'session_list', sessions: registry.summaries() });
};
registry.setModelProvider((id) => modelNameStore.get(id));

// 项目名映射（workspace.json），启动时异步构建；onRecord 经 let 绑定在运行时读取
let projectNameMap = new Map<string, string>();
const mappedProjects = new Set<string>();

const tailer = new SessionTailer(WORKSPACE_STORAGE_ROOT, {
  onRecord: (sessionId, file, rec) => {
    registry.onJsonl(sessionId, rec);
    if (!mappedProjects.has(sessionId)) {
      mappedProjects.add(sessionId);
      const hash = workspaceHashOf(file);
      const name = hash ? projectNameMap.get(hash) : undefined;
      if (name) registry.setProject(sessionId, name);
    }
  },
  onRewrite: (sessionId) => registry.resetSession(sessionId),
});

/** 给 hello/session_list 附上记录源健康状态（区分"模型没输出"与"链路断了"） */
function withRecorder(e: BridgeEvent): BridgeEvent {
  if (e.type === 'hello' || e.type === 'session_list') {
    return { ...e, recorder: heimdallTailer.health(registry.lastActivity()) };
  }
  return e;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];
    if (url.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let file: string;
    if (url.startsWith('/vendor/')) {
      // 本地 vendor（如 marked），避免外网 CDN 依赖
      const rel = url.slice('/vendor/'.length);
      file = path.resolve(NODE_MODULES, rel);
      if (!file.startsWith(NODE_MODULES + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
    } else {
      const rel = url === '/' ? 'index.html' : url.slice(1);
      file = path.resolve(WEB_ROOT, rel);
      if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
    }
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// 固定 /ws 路径：开发期 Vite 代理 ws://…/ws → bridge，前端同源连接
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();

function broadcast(e: BridgeEvent): void {
  const payload = JSON.stringify(e);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(
    JSON.stringify(
      withRecorder({ type: 'hello', sessions: registry.summaries() }),
    ),
  );
  ws.on('message', (buf) => {
    let msg: { type?: string; sessionId?: string };
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'replay' && msg.sessionId) {
      const state = registry.fullState(msg.sessionId);
      if (state) {
        ws.send(JSON.stringify({ type: 'replay', ...state }));
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// recorder 健康值只随 hello/session_list 推送，前端可能长时间收不到更新
// （stale 状态陈旧）。周期性广播轻量 session_list 刷新健康状态。
const healthTimer = setInterval(() => {
  if (clients.size > 0) {
    broadcast({ type: 'session_list', sessions: registry.summaries() });
  }
}, 30000);
healthTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`copilot-bridge listening on http://${HOST}:${PORT}`);
  console.log(`workspace storage: ${WORKSPACE_STORAGE_ROOT}`);
  void (async () => {
    // 项目名映射先建（onRecord 可能紧随其后触发）
    projectNameMap = await buildProjectNameMap();
    console.log(`project name map: ${projectNameMap.size} workspaces`);
    titleStore.start();
    modelNameStore.start();
    await tailer.start();
    console.log('tailer started');
    registry.start();
    await heimdallTailer.start();
    console.log('heimdall tailer started');
  })().catch((err) => {
    console.error('start failed:', err);
    process.exit(1);
  });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    registry.stop();
    titleStore.stop();
    modelNameStore.stop();
    clearInterval(healthTimer);
    void Promise.allSettled([tailer.stop(), heimdallTailer.stop()]);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
