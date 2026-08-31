import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_STORAGE_ROOT } from './config.js';

/**
 * workspaceStorage\<hash>\workspace.json → 项目名（风险 5 已验证）。
 * - 单根：`folder` 是 file URI（file:///d:/code/x 或 file:///C:/Users/...）
 * - 多根：`workspace` 是 .code-workspace 文件路径
 * 项目名取路径末段（folder 末段 / .code-workspace 文件名去扩展名）。
 * 37 目录 34 有 workspace.json（缺的是 ext-dev 等特殊目录）。
 */

interface WorkspaceJson {
  folder?: string;
  workspace?: string;
}

/** file URI → 本地路径（处理 %20 等转义与盘符大小写） */
function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return uri;
  }
}

function lastSegment(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).pop() ?? '';
}

/** 从 workspace.json 内容解析项目名 */
export function projectNameFromJson(content: string): string | undefined {
  let ws: WorkspaceJson;
  try {
    ws = JSON.parse(content) as WorkspaceJson;
  } catch {
    return undefined;
  }
  if (ws.folder) {
    return lastSegment(uriToPath(ws.folder));
  }
  if (ws.workspace) {
    const base = lastSegment(uriToPath(ws.workspace));
    return base.replace(/\.code-workspace$/i, '') || base;
  }
  return undefined;
}

/**
 * 扫描所有 workspace，建立 hash → 项目名 映射。
 * 失败/缺失的目录跳过（返回 undefined），不阻塞。
 */
export async function buildProjectNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let dirs: string[] = [];
  try {
    const entries = await fsp.readdir(WORKSPACE_STORAGE_ROOT, {
      withFileTypes: true,
    });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return map;
  }
  for (const hash of dirs) {
    const file = path.join(WORKSPACE_STORAGE_ROOT, hash, 'workspace.json');
    let content: string;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const name = projectNameFromJson(content);
    if (name) map.set(hash, name);
  }
  return map;
}

/** 从 chatSessions 文件路径提取 workspace hash */
export function workspaceHashOf(sessionFile: string): string | undefined {
  // .../workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
  const parts = sessionFile.split(path.sep);
  const idx = parts.indexOf('chatSessions');
  if (idx >= 1) return parts[idx - 1];
  return undefined;
}
