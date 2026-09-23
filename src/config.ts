import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * 服务配置（AHP 方案）。
 *
 * bridge 是薄服务，不接触任何会话数据：
 * - 静态托管 PWA（web/dist）
 * - GET /api/config：提供 agent host 的 ws 端口 + token（PWA 据此直连 VS Code）
 * - GET /api/health：探测 agent host 状态（供 PWA 给出友好提示）
 */

/** 绑定地址：0.0.0.0 以便 Tailscale 访问（见 REQUIREMENTS §9） */
export const HOST = process.env.BRIDGE_HOST ?? '0.0.0.0';
export const PORT = Number(process.env.BRIDGE_PORT ?? 8765);

/** agent host 的 AHP WebSocket 端口（必须与 launch-vscode-ahp.cmd 一致） */
export const AGENT_HOST_PORT = Number(process.env.AGENT_HOST_PORT ?? 8081);

/**
 * token 唯一事实来源：launch-vscode-ahp.cmd 首次运行时生成并持久化到该文件，
 * 之后每次冷启动复用。bridge 只读，保证启动器与 PWA 看到的 token 一致。
 */
export const TOKEN_FILE = path.join(os.homedir(), '.copilot-bridge', 'token.txt');

/** 已配对设备 token 文件（手机配对用） */
export const DEVICES_FILE = path.join(os.homedir(), '.copilot-bridge', 'devices.json');

/** 读取 agent host 连接 token（文件不存在/为空返回 null） */
export async function readAgentHostToken(): Promise<string | null> {
  try {
    const raw = await fsp.readFile(TOKEN_FILE, 'utf8');
    const t = raw.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** 静态前端目录（web 前端构建产物，相对项目根） */
export const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
  'dist',
);

/** 状态页（自包含单文件，无需构建） */
export const STATUS_PAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
  'status.html',
);
