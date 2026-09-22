import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import {
  HOST,
  PORT,
  WEB_ROOT,
  AGENT_HOST_PORT,
  readAgentHostToken,
} from './config.js';

const pExecFile = promisify(execFile);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 探测 agent host 的 TCP 端口（agent host 绑定 0.0.0.0，回环探测即可） */
function probeAgentHost(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: AGENT_HOST_PORT });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

/** 检查 Code.exe 进程是否存在（区分"没启动"与"没带环境变量启动"） */
async function isCodeRunning(): Promise<boolean> {
  try {
    const { stdout } = await pExecFile('tasklist', [
      '/FI',
      'IMAGENAME eq Code.exe',
      '/NH',
    ]);
    return /Code\.exe/i.test(stdout);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/api/config') {
      const token = await readAgentHostToken();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ agentHostPort: AGENT_HOST_PORT, token }));
      return;
    }

    if (url === '/api/health') {
      const up = await probeAgentHost();
      const status = up
        ? 'ok'
        : (await isCodeRunning() ? 'not_started_with_env' : 'vscode_not_running');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status, agentHostPort: AGENT_HOST_PORT }));
      return;
    }

    if (url.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // 静态文件（SPA：未命中的非文件路径回退 index.html）
    const rel = url === '/' ? 'index.html' : url.slice(1);
    const file = path.resolve(WEB_ROOT, rel);
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    let data: Buffer;
    try {
      data = await fsp.readFile(file);
    } catch {
      if (path.extname(file) === '') {
        const fallback = path.join(WEB_ROOT, 'index.html');
        data = await fsp.readFile(fallback);
      } else {
        res.writeHead(404);
        res.end('not found');
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(500);
    res.end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`copilot-bridge listening on http://${HOST}:${PORT}`);
  console.log(
    `agent host: ws://<本机地址>:${AGENT_HOST_PORT}（token 文件 %USERPROFILE%\\.copilot-bridge\\token.txt）`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
