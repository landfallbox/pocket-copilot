import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 服务配置（AHP 方案）。
 *
 * pocket-copilot 是薄服务，不接触任何会话数据：
 * - 静态托管 PWA（web/dist）
 * - GET /api/config：提供 agent host 的 ws 端口 + token（PWA 据此直连 VS Code）
 * - GET /api/health：探测 agent host 状态（供 PWA 给出友好提示）
 */

/** 绑定地址：0.0.0.0 以便 Tailscale 访问（见 REQUIREMENTS §9） */
export const HOST = process.env.POCKET_HOST ?? '0.0.0.0';
export const PORT = Number(process.env.POCKET_PORT ?? 8765);

/** agent host 的 AHP WebSocket 端口（必须与注册表 VSCODE_AGENT_HOST_PORT 一致） */
export const AGENT_HOST_PORT = Number(process.env.AGENT_HOST_PORT ?? 8081);

/** 已配对设备 token 文件（手机配对用） */
export const DEVICES_FILE = path.join(os.homedir(), '.pocket-copilot', 'devices.json');

/**
 * 读取 agent host 连接 token。
 * 唯一事实来源是注册表 HKCU\Environment 的 VSCODE_AGENT_HOST_CONNECTION_TOKEN（VS Code 读取处）；
 * 管理器启动本进程时将其注入 AHP_TOKEN 环境变量。
 */
export function readAgentHostToken(): string | null {
  const t = (process.env.AHP_TOKEN ?? '').trim();
  return t.length > 0 ? t : null;
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
