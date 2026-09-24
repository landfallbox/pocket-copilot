// ============================================================================
// = AHP 连接生命周期（store.ts 连接状态机移植到 Node）                          =
// 连接 agent host（ws://127.0.0.1:8081?tkn=token）→ initialize → 断线自动重连。 =
// token 每次重连时重新读取（文件不存在则等待重试）。                            =
// ============================================================================

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import { AGENT_HOST_PORT, readAgentHostToken } from '../config.js';
import { log } from '../log.js';
import { WebSocket as WsWebSocket } from 'ws';

const RECONNECT_MS = 3000;
const CLIENT_ID = 'pocket-copilot-daemon';

// Electron 内置的 Node 运行时（ELECTRON_RUN_AS_NODE）没有全局 WebSocket，
// 而 AHP 的 WebSocketTransport 依赖 globalThis.WebSocket。
// 用 ws 库的 WebSocket（浏览器兼容 API 子集）做 polyfill，仅覆盖缺失场景。
if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as { WebSocket: unknown }).WebSocket = WsWebSocket;
}

export interface ConnectionCallbacks {
  /** 连接建立且 initialize 完成（可开始订阅） */
  onReady(client: AhpClient): void;
  /** 连接断开（非主动 shutdown） */
  onLost(): void;
}

export class AhpConnection {
  private client: AhpClient | null = null;
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(private readonly cb: ConnectionCallbacks) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    this.wake?.();
  }

  /** 当前已建立的客户端（未连接时为 null） */
  get clientOrNull(): AhpClient | null {
    return this.client;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const ok = await this.connectOnce();
      if (!ok) {
        await sleep(RECONNECT_MS);
        continue;
      }
      // 连接存活期间挂起，直到断开（stateChanges 监视器唤醒）
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }

  private async connectOnce(): Promise<boolean> {
    try {
      const token = readAgentHostToken();
      if (!token) {
        log('ahp', '缺少 AHP_TOKEN 环境变量，等待重试（请通过管理器启动 daemon，并确保已保存 AHP 环境变量）');
        return false;
      }
      const url = `ws://127.0.0.1:${AGENT_HOST_PORT}?tkn=${token}`;
      const transport = await WebSocketTransport.connect(url);
      const c = new AhpClient(transport);
      c.connect();
      await c.initialize({
        clientId: CLIENT_ID,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        initialSubscriptions: ['ahp-root://'],
      });
      this.client = c;
      log('ahp', `已连接 agent host :${AGENT_HOST_PORT}`);

      // 监视断开 → 通知上层 + 唤醒重连循环
      void (async () => {
        try {
          for await (const st of c.stateChanges()) {
            if (st.status === 'closed' && st.reason.type !== 'shutdown') {
              log('ahp', 'agent host 连接断开');
              this.client = null;
              this.cb.onLost();
              this.wake?.();
            }
          }
        } catch {
          // 关闭迭代器时的二次错误，忽略
        }
      })();

      this.cb.onReady(c);
      return true;
    } catch (err) {
      this.client = null;
      const msg = err instanceof Error ? err.message : String(err);
      log('ahp', `连接 agent host 失败：${msg}（${RECONNECT_MS / 1000}s 后重试）`);
      return false;
    }
  }

  private teardown(): void {
    const c = this.client;
    this.client = null;
    if (c) {
      c.shutdown().catch(() => {});
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
