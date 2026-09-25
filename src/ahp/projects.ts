// ============================================================================
// = 可新建会话的项目列表（VS Code 侧数据源）                                   =
// 对齐 VS Code agent 窗口"新建会话"的项目选择器：只列出"以前在 VS Code        =
// 打开过/用 agent 选过"的项目，而非全盘目录浏览。数据源：                      =
//   1) agents profile state.vscdb 的 sessions.recentlyPickedWorkspaces         =
//      （agent 窗口选择器写入的最近项目，最多 10 条）                          =
//   2) globalStorage/storage.json 的 windowsState.openedWindows[].folder       =
//      （当前/最近打开的 VS Code 窗口）                                        =
// daemon 跑在 Electron 内置 Node 20（无 node:sqlite），用 sql.js(WASM) 只读   =
// DB；DB 被 VS Code 占用时 fs.readFileSync 仍可读取（已实测）。               =
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { log } from '../log.js';

/** 一个可新建会话的项目 */
export interface ProjectRef {
  /** file:// URI（createSession 的 workingDirectories 用） */
  uri: string;
  /** 项目名（目录名，展示用） */
  name: string;
}

const require = createRequire(import.meta.url);

/** 懒加载的 sql.js 运行时（WASM 只初始化一次） */
let sqlJsPromise: Promise<SqlJsStatic> | null = null;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const main = require.resolve('sql.js');
      const wasm = path.join(path.dirname(main), 'sql-wasm.wasm');
      return initSqlJs({ locateFile: () => wasm });
    })();
  }
  return sqlJsPromise;
}

// ---- 路径工具 ----------------------------------------------------------------

/** file:// URI → 文件系统绝对路径（Windows 盘符大小写保留） */
export function uriToFsPath(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'file:') return null;
    let p = decodeURIComponent(u.pathname);
    // /d:/foo → d:/foo
    p = p.replace(/^\/([A-Za-z]:)/, '$1');
    return p.replace(/\//g, path.sep);
  } catch {
    return null;
  }
}

/** 文件系统绝对路径 → file:// URI */
export function fsPathToUri(p: string): string {
  return pathToFileURL(p).toString();
}

/**
 * 去重键：小写 + worktree 映射回主仓（.worktrees 段之前）。
 * 与 VS Code agent 窗口行为一致：worktree 路径归并到其基础仓库。
 */
export function projectKey(fsPath: string): string {
  let s = fsPath.replace(/\//g, '\\').toLowerCase();
  const idx = s.indexOf('.worktrees');
  if (idx > 0) s = s.slice(0, idx);
  return s.replace(/\\+$/, '');
}

/** 过滤 VS Code 内部/非用户项目（copilot-* 前缀、.worktrees 段、临时目录） */
function isUserProject(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  const segments = lower.split(/[\\/]/);
  if (segments.some((seg) => seg.startsWith('copilot-'))) return false;
  if (segments.includes('.worktrees')) return false;
  return true;
}

// ---- VS Code 数据源定位（Windows） ------------------------------------------

function dataRoot(): string {
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
}

const AGENTS_DB = () =>
  path.join(dataRoot(), 'profiles', 'builtin', 'agents', 'globalStorage', 'state.vscdb');
const STORAGE_JSON = () => path.join(dataRoot(), 'globalStorage', 'storage.json');

// ---- 读取 --------------------------------------------------------------------

/** 从 agents profile DB 读 sessions.recentlyPickedWorkspaces */
async function readRecentlyPicked(): Promise<ProjectRef[]> {
  const dbPath = AGENTS_DB();
  if (!fs.existsSync(dbPath)) return [];
  const bytes = fs.readFileSync(dbPath);
  const SQLJS = await getSqlJs();
  const db: Database = new SQLJS.Database(bytes);
  try {
    const rows = db.exec(
      "SELECT value FROM ItemTable WHERE key = 'sessions.recentlyPickedWorkspaces'",
    );
    if (!rows.length || !rows[0].values.length) return [];
    const arr = JSON.parse(rows[0].values[0][0] as string);
    if (!Array.isArray(arr)) return [];
    const out: ProjectRef[] = [];
    for (const item of arr) {
      const uriObj = item?.uri;
      if (!uriObj) continue;
      let fsPath: string | null =
        typeof uriObj.fsPath === 'string' ? uriObj.fsPath : uriToFsPath(uriObj.external ?? '');
      if (!fsPath && typeof uriObj.path === 'string') {
        fsPath = uriToFsPath('file://' + uriObj.path) ?? null;
      }
      if (fsPath) out.push({ uri: uriObj.external ?? fsPathToUri(fsPath), name: path.basename(fsPath) });
    }
    return out;
  } finally {
    db.close();
  }
}

/** 从 storage.json 读 windowsState.openedWindows[].folder */
function readOpenedWindows(): ProjectRef[] {
  const sjPath = STORAGE_JSON();
  if (!fs.existsSync(sjPath)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(sjPath, 'utf8'));
    const wins = j?.windowsState?.openedWindows;
    if (!Array.isArray(wins)) return [];
    const out: ProjectRef[] = [];
    for (const w of wins) {
      if (typeof w?.folder === 'string' && w.folder.startsWith('file://')) {
        const fsPath = uriToFsPath(w.folder);
        if (fsPath) out.push({ uri: w.folder, name: path.basename(fsPath) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 读取 VS Code 侧"最近项目"（agent 选择器 + 打开窗口），去重 + 过滤。
 * 任一数据源失败都降级（返回已读到的部分），不抛错。
 */
export async function readVsCodeProjects(): Promise<ProjectRef[]> {
  const [picked, opened] = await Promise.allSettled([readRecentlyPicked(), Promise.resolve(readOpenedWindows())]);
  const raw: ProjectRef[] = [];
  if (picked.status === 'fulfilled') raw.push(...picked.value);
  else log('projects', `读 recentlyPickedWorkspaces 失败：${String(picked.reason)}`);
  if (opened.status === 'fulfilled') raw.push(...opened.value);

  const seen = new Set<string>();
  const out: ProjectRef[] = [];
  for (const p of raw) {
    const fsPath = uriToFsPath(p.uri);
    if (!fsPath || !isUserProject(fsPath)) continue;
    const key = projectKey(fsPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
