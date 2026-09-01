import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 服务配置。
 * Spike 1 阶段固定 127.0.0.1，Tailscale 接入时把 HOST 改为 tailscale IP 即可
 * （或后续加一个 --host 参数）。
 */
export const HOST = process.env.BRIDGE_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.BRIDGE_PORT ?? 8765);

/** %APPDATA%\Code\User\workspaceStorage */
export const WORKSPACE_STORAGE_ROOT = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Code',
  'User',
  'workspaceStorage',
);

/** VS Code BYOK/customendpoint 模型注册表（全局静态文件，模型权威名来源） */
export const CHAT_LANGUAGE_MODELS_FILE = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Code',
  'User',
  'chatLanguageModels.json',
);

/**
 * heimdall 数据目录（请求/响应记录所在）。
 * 生产 heimdall 是安装版 Electron，数据目录在 %APPDATA%\Heimdall；
 * 可用 HEIMDALL_DATA_DIR 覆盖（如指向第二实例/worktree 验证实例）。
 */
export const HEIMDALL_DATA_DIR =
  process.env.HEIMDALL_DATA_DIR ??
  path.join(os.homedir(), 'AppData', 'Roaming', 'Heimdall');

/** heimdall 请求记录目录（requests/YYYY-MM.jsonl，格式见 heimdall docs/request-logging-format.md） */
export const HEIMDALL_REQUESTS_DIR = path.join(HEIMDALL_DATA_DIR, 'requests');

/** 记录源健康判定：超过该时长无新记录且存在运行中请求 → 标记异常 */
export const RECORDER_STALE_MS = 5 * 60 * 1000;

/** 静态前端目录（web 前端构建产物，相对项目根） */
export const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'web',
  'dist',
);
