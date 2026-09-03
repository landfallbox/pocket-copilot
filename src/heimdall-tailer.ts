import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { LineTailer } from './line-tailer.js';
import { HEIMDALL_DATA_DIR, HEIMDALL_REQUESTS_DIR } from './config.js';
import type { HeimdallRecord, RecorderHealth } from './types.js';

/** 记录格式版本（必须与 heimdall REQUEST_LOG_VERSION 一致，不匹配拒绝解析） */
const SUPPORTED_VERSION = 1;

/** 有近期活动但无新记录的判定阈值 */
const STALE_MS = 5 * 60 * 1000;
/** 多久内的 VS Code 活动算"近期"（更久之前无记录视为空闲，不算异常） */
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;

/**
 * heimdall 请求/响应记录 tailer。
 * 监听 <HEIMDALL_DATA_DIR>/requests/*.jsonl，按行解析为 HeimdallRecord。
 * 目录不存在（requestLogging 未启用或 heimdall 未运行）时静默空转，
 * 健康状态会反映"无记录"，由上层决定是否提示。
 */
export class HeimdallTailer {
  private tailer?: LineTailer<HeimdallRecord>;
  private lastRecordAt = 0;
  private lastFile?: string;

  constructor(
    private readonly onRecord: (rec: HeimdallRecord) => void,
  ) {}

  async start(): Promise<void> {
    this.tailer = new LineTailer<HeimdallRecord>(HEIMDALL_DATA_DIR, {
      pattern: path.join('requests', '*.jsonl'),
      // 每次调用重新扫描：LineTailer 启动时 + 周期性补扫都靠它发现新文件，
      // 不能返回启动时的一次性快照（否则启动后才创建的文件永远发现不了）。
      scanFiles: async () => {
        let out: string[] = [];
        try {
          const entries = await fsp.readdir(HEIMDALL_REQUESTS_DIR, {
            withFileTypes: true,
          });
          out = entries
            .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
            .map((e) => path.join(HEIMDALL_REQUESTS_DIR, e.name));
        } catch {
          // 目录不存在：requestLogging 未启用或 heimdall 未运行，空转
        }
        return out;
      },
      // heimdall chunk 是流式增量源，需低延迟：轮询 150ms（jsonl tailer 保持 1s）
      pollMs: 150,
      parseLine: (line) => {
        let rec: HeimdallRecord;
        try {
          rec = JSON.parse(line) as HeimdallRecord;
        } catch {
          return null;
        }
        if (rec.version !== SUPPORTED_VERSION) {
          console.warn(
            `heimdall record version mismatch: ${rec.version} (supported: ${SUPPORTED_VERSION})`,
          );
          return null;
        }
        // 旧架构记录丢弃：request_start 缺 systemTail 字段 = 新方案上线前写的，
        // 不属于新数据，不建 turn（其 chunk/end 查不到 turn 静默忽略）。
        // 新记录 systemTail 恒在（systemTailOf 最差返回 ""），故缺字段只可能是旧记录。
        if (rec.type === 'request_start' && !('systemTail' in rec)) {
          return null;
        }
        return rec;
      },
      onLine: (file, rec) => {
        const t = Date.parse(rec.time);
        if (Number.isFinite(t) && t > this.lastRecordAt) {
          this.lastRecordAt = t;
          this.lastFile = path.basename(file);
        }
        this.onRecord(rec);
      },
    });
    await this.tailer.start();
  }

  async stop(): Promise<void> {
    await this.tailer?.stop();
  }

  /**
   * 记录源健康：
   * - 有记录且新鲜 → 正常
   * - 完全无记录 → 不判异常（可能 requestLogging 未启用），由前端按"无内容"处理
   * - 有记录但 5 分钟无新记录，且 VS Code 10 分钟内有活动 → 链路可能断了
   */
  health(lastVsCodeActivityAt: number): RecorderHealth {
    const now = Date.now();
    const hasRecentActivity = now - lastVsCodeActivityAt < RECENT_ACTIVITY_MS;
    const stale =
      this.lastRecordAt > 0 &&
      hasRecentActivity &&
      now - this.lastRecordAt > STALE_MS;
    return {
      lastRecordAt: this.lastRecordAt,
      lastFile: this.lastFile,
      stale,
    };
  }
}
