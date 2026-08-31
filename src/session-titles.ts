/**
 * SessionTitleStore：从 VS Code workbench 状态库（state.vscdb）读取会话标题。
 *
 * 背景：Copilot 生成的会话标题不在 chatSessions/*.jsonl 里，而存在每个
 * workspace 的 `state.vscdb`（SQLite）的 `ItemTable` 表、key 为
 * `chat.ChatSessionStore.index` 的一行里。该行 value 是一个 JSON 对象：
 *   { "<sessionId>": { sessionId, title, lastMessageDate, ... }, ... }
 *
 * 设计原则：
 * - 独立数据源，与 jsonl / heimdall 解耦。
 * - 可失败降级：任何读取错误（文件缺失 / 被锁 / 格式变化）都静默跳过，
 *   返回空映射，绝不阻塞或抛错到主链路。
 * - 周期性刷新（标题在首轮对话后由 Copilot 生成，且用户可改名）。
 */
import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_STORAGE_ROOT } from './config.js';

/** ItemTable 里存会话索引的 key（VS Code 私有格式，可能随版本变化） */
const SESSION_INDEX_KEY = 'chat.ChatSessionStore.index';
/** 刷新间隔：标题生成/改名后最迟该时长内可见 */
const REFRESH_INTERVAL_MS = 15 * 1000;

/**
 * 读取单个 workspace 的 state.vscdb，返回该 workspace 内 sessionId → title。
 * 任何错误返回空 Map（降级，不抛）。
 */
function readTitlesFromVscdb(vscdbPath: string): Map<string, string> {
  const out = new Map<string, string>();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(vscdbPath, { readOnly: true });
  } catch {
    return out;
  }
  try {
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get(SESSION_INDEX_KEY) as { value: string } | undefined;
    if (!row?.value) return out;
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    // 结构：{ version, entries: { "<sessionId>": { title, ... } } }；
    // 兼容无 entries 包装的扁平形式（旧版本）。
    const entries =
      parsed.entries && typeof parsed.entries === 'object'
        ? (parsed.entries as Record<string, { title?: unknown }>)
        : (parsed as Record<string, { title?: unknown }>);
    for (const [sid, entry] of Object.entries(entries)) {
      if (entry && typeof entry.title === 'string' && entry.title) {
        out.set(sid, entry.title);
      }
    }
  } catch {
    // 格式变化 / 被锁 / JSON 损坏：静默降级
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  return out;
}

export class SessionTitleStore {
  private titles = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  /** 标题映射发生变化（新增/更新）时回调，供 server 触发 session_list 重推 */
  onChange?: () => void;

  /** 全量重建标题映射（扫所有 workspace 的 state.vscdb） */
  async refresh(): Promise<void> {
    const next = new Map<string, string>();
    let dirs: string[] = [];
    try {
      const entries = await fsp.readdir(WORKSPACE_STORAGE_ROOT, {
        withFileTypes: true,
      });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const hash of dirs) {
      const vscdb = path.join(WORKSPACE_STORAGE_ROOT, hash, 'state.vscdb');
      for (const [sid, title] of readTitlesFromVscdb(vscdb)) {
        next.set(sid, title);
      }
    }

    // 仅当有变化时通知（避免无谓重推）
    if (sameMap(this.titles, next)) return;
    this.titles = next;
    this.onChange?.();
  }

  /** 取会话标题；无则 undefined（前端回退 sessionId 前缀） */
  get(sessionId: string): string | undefined {
    return this.titles.get(sessionId);
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** 两个 Map 是否等价（键值全同） */
function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
