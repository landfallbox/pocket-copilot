import fsp from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';

export interface LineTailerOptions<T> {
  /** chokidar 监听模式（相对 root） */
  pattern: string;
  /** 初始扫描要跟踪的文件列表（绝对路径） */
  scanFiles: () => Promise<string[]>;
  /** 解析一行；返回 null 表示跳过（坏行等） */
  parseLine: (line: string) => T | null;
  /** 完整行回调 */
  onLine: (file: string, value: T) => void;
  /** 文件被重写（开头内容变化）时回调 */
  onRewrite?: (file: string) => void;
  /** 轮询兜底间隔（ms）。默认 1000；需要低延迟流式时调短（如 heimdall chunk 源） */
  pollMs?: number;
}

/**
 * 通用 jsonl 增量 tailer。
 *
 * 关键点（从 SessionTailer 抽出的已验证逻辑）：
 * - 写入方可能用 ~8KB 缓冲批量 flush，最后一行可能不完整（无换行符），
 *   不完整部分留在 pending 里等下次合并
 * - 文件被截断/重建/压缩重写时重置偏移整读（行边界校验检测重写）
 * - 新文件出现时自动纳入（mtime 新，从头重放）
 * - per-file 互斥：chokidar change 与初始重放可能并发触发，
 *   并发 drain 会把同一批字节读两次（表现为事件重复）
 */
export class LineTailer<T> {
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private offsets = new Map<string, number>();
  private pending = new Map<string, Buffer>();
  private tracking = new Set<string>();
  private draining = new Set<string>();
  private drainQueued = new Set<string>();
  /** 上次补扫新文件的时间（轮询周期性 scan，Windows 上 chokidar add 不可靠） */
  private lastScan = 0;
  private opts: LineTailerOptions<T>;
  private root: string;

  constructor(root: string, opts: LineTailerOptions<T>) {
    this.root = root;
    this.opts = opts;
  }

  async start(): Promise<void> {
    const files = await this.opts.scanFiles();
    for (const f of files) {
      await this.track(f);
    }
    this.watcher = chokidar.watch(this.opts.pattern, {
      cwd: this.root,
      ignoreInitial: true,
    });
    this.watcher.on('add', (f) => {
      void this.track(f);
    });
    this.watcher.on('change', (f) => {
      void this.drain(f);
    });
    // 轮询兜底：Windows 上 chokidar change 对缓冲批量 flush 不可靠（VS Code/heimdall
    // 都用 ~8KB 缓冲，flush 时不一定触发 ReadDirectoryChangesW 事件）。周期性对已跟踪
    // 文件 drain；drain 内部 stat 比对 offset，size 未变即 no-op，开销可忽略。
    const pollMs = this.opts.pollMs ?? 1000;
    this.pollTimer = setInterval(() => {
      for (const f of this.tracking) void this.drain(f);
      // 周期性补扫新文件：chokidar add 在 Windows 上对新建 .jsonl 不可靠，
      // 而轮询只 drain 已 track 文件，启动后才创建的文件会永远不被 track
      // （表现为当天首条请求/新会话文件内容读不到）。5 秒补扫一次。
      if (Date.now() - this.lastScan > 5000) {
        this.lastScan = Date.now();
        void this.scanNewFiles();
      }
    }, pollMs);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.watcher?.close();
  }

  /** 发现 scanFiles 返回但尚未跟踪的新文件并纳入（track 内部已防重） */
  private async scanNewFiles(): Promise<void> {
    const files = await this.opts.scanFiles();
    for (const f of files) {
      if (!this.tracking.has(f)) void this.track(f);
    }
  }

  private async track(file: string): Promise<void> {
    if (this.tracking.has(file)) return;
    this.tracking.add(file);
    // 从 0 整读建立内存状态，之后 offset 推进、仅 tail 新增内容。
    this.offsets.set(file, 0);
    await this.drain(file);
  }

  /**
   * 从当前偏移读到 EOF，处理完整行，保留不完整尾行。
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

  private notifyRewrite(file: string): void {
    this.opts.onRewrite?.(file);
  }

  /**
   * 等待文件写入稳定（连续 stableMs 大小不变）。
   * 检测到重写后调用，避免整读时撞上写入方正在写的半截文件。
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
    try {
      const st = await fsp.stat(file);
      size = st.size;
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
      // 前一字节是换行 \n）。重写后旧 offset 会指向新文件某行中间，
      // 前一字节不再是 \n → 判定重写。重写后先等文件写入稳定再从头整读。
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

      for (const line of full.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const value = this.opts.parseLine(t);
        if (value !== null) this.opts.onLine(file, value);
      }
    } finally {
      await handle.close();
    }
  }
}
