import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { RawRecord } from './types.js';

export interface TailCallbacks {
  /** mtimeMs：文件最后修改时间（用于 lastActivity 真实时间戳） */
  onRecord: (sessionId: string, filePath: string, rec: RawRecord, mtimeMs: number) => void;
  /** 文件被重写（开头内容变化）时回调，调用方应重置该会话状态 */
  onRewrite?: (sessionId: string) => void;
}

/**
 * 跨 workspace 监听 %APPDATA%\Code\User\workspaceStorage\*\chatSessions\*.jsonl，
 * 按字节偏移增量读取，把完整行解析为 RawRecord 后回调。
 *
 * 关键点：
 * - VS Code 用 ~8KB 缓冲批量 flush，最后一行可能不完整（无换行符），
 *   不完整部分留在 pending 里等下次合并
 * - 文件被截断/重建/压缩重写时重置偏移整读（行边界校验检测重写）
 * - 新会话文件出现时自动纳入（mtime 新，从头重放）
 */
export class SessionTailer {
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private offsets = new Map<string, number>();
  private pending = new Map<string, Buffer>();
  private tracking = new Set<string>();
  private draining = new Set<string>();
  private drainQueued = new Set<string>();
  /** 上次补扫新文件的时间（轮询周期性 scan，chokidar add 在 Windows 上不可靠） */
  private lastScan = 0;
  private cb: TailCallbacks;
  private root: string;

  constructor(root: string, cb: TailCallbacks) {
    this.root = root;
    this.cb = cb;
  }

  async start(): Promise<void> {
    const files = await this.scan();
    for (const f of files) {
      await this.track(f);
    }
    this.watcher = chokidar.watch(
      path.join(this.root, '*', 'chatSessions', '*.jsonl'),
      { ignoreInitial: true },
    );
    this.watcher.on('add', (f) => {
      void this.track(f);
    });
    this.watcher.on('change', (f) => {
      void this.drain(f);
    });
    // 轮询兜底：Windows 上 chokidar change 对 VS Code 缓冲批量 flush 不可靠，
    // 周期性对已跟踪文件 drain（size 未变即 no-op）。
    this.pollTimer = setInterval(() => {
      for (const f of this.tracking) void this.drain(f);
      // 周期性补扫新会话文件：chokidar add 在 Windows 上对新建 .jsonl 不可靠，
      // 而轮询只 drain 已跟踪文件，新文件会永远不被跟踪（表现为新会话未分组、
      // 模型名缺失）。5 秒补扫一次，新文件最多 5 秒内被纳入。
      if (Date.now() - this.lastScan > 5000) {
        this.lastScan = Date.now();
        void this.scanNewFiles();
      }
    }, 1000);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.watcher?.close();
  }

  /** 初始扫描所有 workspace 的 chatSessions 目录 */
  private async scan(): Promise<string[]> {
    const out: string[] = [];
    let workspaces: Dirent[] = [];
    try {
      workspaces = await fsp.readdir(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const dir = path.join(this.root, ws.name, 'chatSessions');
      let files: Dirent[] = [];
      try {
        files = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          out.push(path.join(dir, f.name));
        }
      }
    }
    return out;
  }

  /** 发现 scan 到但尚未跟踪的新会话文件并纳入（track 内部已防重） */
  private async scanNewFiles(): Promise<void> {
    const files = await this.scan();
    for (const f of files) {
      if (!this.tracking.has(f)) void this.track(f);
    }
  }

  private async track(file: string): Promise<void> {
    if (this.tracking.has(file)) return;
    this.tracking.add(file);
    // 从 0 整读：会话文件是侧边栏注册来源，必须纳入全部历史会话；
    // 之后 offset 推进、仅 tail 新增内容。
    this.offsets.set(file, 0);
    await this.drain(file);
  }

  /**
   * 从当前偏移读到 EOF，处理完整行，保留不完整尾行。
   * per-file 互斥：chokidar change 与初始重放可能并发触发，
   * 并发 drain 会把同一批字节读两次（前端表现为消息重复）。
   * 互斥期间到来的请求标记 queued，本轮结束后补一次。
   */
  private async drain(file: string): Promise<void> {
    if (this.draining.has(file)) {
      this.drainQueued.add(file);
      return;
    }
    this.draining.add(file);
    try {
      await this.drainOnce(file);
    } finally {
      this.draining.delete(file);
      if (this.drainQueued.delete(file)) {
        void this.drain(file);
      }
    }
  }

  /** 文件被重写：回调上层重置会话状态（sessionId 取文件名） */
  private notifyRewrite(file: string): void {
    if (!this.cb.onRewrite) return;
    const sessionId = path.basename(file, '.jsonl');
    this.cb.onRewrite(sessionId);
  }

  /**
   * 等待文件写入稳定（连续 stableMs 大小不变）。
   * 检测到重写后调用，避免整读时撞上 VS Code 正在写的半截文件。
   * 超时后放弃等待（用当前 size 继续），不无限阻塞 drain。
   */
  private async waitStable(
    file: string,
    timeoutMs = 5000,
    intervalMs = 300,
    stableMs = 600,
  ): Promise<void> {
    const start = Date.now();
    let lastSize = -1;
    let calm = 0;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        return;
      }
      if (st.size === lastSize) {
        calm += intervalMs;
        if (calm >= stableMs) return;
      } else {
        calm = 0;
        lastSize = st.size;
      }
    }
  }

  private async drainOnce(file: string): Promise<void> {
    let size: number;
    let mtimeMs = 0;
    try {
      const st = await fsp.stat(file);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return;
    }
    let offset = this.offsets.get(file) ?? 0;
    if (size < offset) {
      // 文件被截断/重建：重置偏移整读
      offset = 0;
      this.offsets.set(file, 0);
      this.pending.set(file, Buffer.alloc(0));
      this.notifyRewrite(file);
    }
    if (size === offset) return;

    const handle = await fsp.open(file, 'r');
    try {
      // 行边界校验检测重写：jsonl 追加模式下，offset 必然在行边界（offset=0 或
      // 前一字节是换行 \n），无论 pending 是否为空。VS Code 压缩重写后头部前 1KB
      // 跨重写稳定（version/creationDate/sessionId/第 0 条请求不变，变化在 23MB 后
      // 的 requests 数组尾部），头部指纹检测不到；但旧 offset 会指向新文件某行中间，
      // 前一字节不再是 \n → 判定重写。重写后先等文件写入稳定再从头整读，避免读到
      // VS Code 正在写的半截文件。
      if (offset > 0) {
        const prevByte = Buffer.alloc(1);
        await handle.read(prevByte, 0, 1, offset - 1);
        if (prevByte[0] !== 0x0a) {
          offset = 0;
          this.offsets.set(file, 0);
          this.pending.set(file, Buffer.alloc(0));
          this.notifyRewrite(file);
          await this.waitStable(file);
          const st2 = await fsp.stat(file);
          size = st2.size;
          if (size === 0) return;
        }
      }

      const len = size - offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await handle.read(buf, 0, len, offset);
      const data = buf.subarray(0, bytesRead);

      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        // 还没有完整行，全部进 pending；offset 照常推进，避免下次重读重复拼接
        const prev = this.pending.get(file) ?? Buffer.alloc(0);
        this.pending.set(file, Buffer.concat([prev, data]));
        this.offsets.set(file, offset + data.length);
        return;
      }
      const complete = data.subarray(0, lastNl + 1);
      const rest = data.subarray(lastNl + 1);
      const prev = this.pending.get(file) ?? Buffer.alloc(0);
      const full = Buffer.concat([prev, complete]);
      this.pending.set(file, Buffer.from(rest));
      // 用实际读到的字节数推进 offset，避免 stat 与 read 之间新写入的数据被跳过
      this.offsets.set(file, offset + complete.length);

      const sessionId = path.basename(file, '.jsonl');
      for (const line of full.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let rec: RawRecord;
        try {
          rec = JSON.parse(t) as RawRecord;
        } catch {
          continue;
        }
        this.cb.onRecord(sessionId, file, rec, mtimeMs);
      }
    } finally {
      await handle.close();
    }
  }
}
