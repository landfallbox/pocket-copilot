// ============================================================================
// = 手机 Hub：管理手机 WS 连接、hello 鉴权、事件扇出、视图快照节流推送          =
// 推送模型：快照式。AHP 状态变化 → 重算 ChatView → 100ms 节流 + 单调 version   =
// 号，手机忽略旧 version。零 diff 逻辑。                                        =
// ============================================================================

import type { WebSocket } from 'ws';
import type { ChatState } from '@microsoft/agent-host-protocol';
import type { AhpMirror } from '../ahp/mirror.js';
import { chatToView } from '../ahp/view.js';
import { verifyDeviceToken } from './pairing.js';
import type {
  ChatView,
  DaemonEvent,
  PhoneCommand,
  PhoneSession,
} from './protocol.js';
import { log } from '../log.js';

const PUSH_THROTTLE_MS = 100;
const HEARTBEAT_MS = 30_000;

interface PhoneState {
  ws: WebSocket;
  deviceToken: string;
  name: string;
  isAlive: boolean;
  connectedAt: number;
  /** 最近一次收到 pong 的时间（诊断心跳超时用） */
  lastPongAt: number;
}

export class PhoneHub {
  /** 已鉴权手机（key = deviceToken） */
  private phones = new Map<string, PhoneState>();
  /** 待鉴权连接（hello 前） */
  private pending = new Set<PhoneState>();
  /** 全局单调递增的视图版本号 */
  private viewVersion = 0;
  /** 当前焦点会话的最新视图（节流合并） */
  private latestView: ChatView | null = null;
  private latestSessions: PhoneSession[] = [];
  private pushTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly mirror: AhpMirror) {}

  start(): void {
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    for (const p of [...this.phones.values(), ...this.pending]) {
      p.ws.close(1000, 'daemon shutdown');
    }
    this.phones.clear();
    this.pending.clear();
  }

  // ---- 状态查询（供 /api/status）-------------------------------------------

  /** 已鉴权手机列表 */
  getPhoneStatus(): { name: string; connectedAt: string; alive: boolean }[] {
    return [...this.phones.values()].map((p) => ({
      name: p.name,
      connectedAt: new Date(p.connectedAt).toISOString(),
      alive: p.isAlive,
    }));
  }

  /** 当前会话列表 */
  getSessions(): PhoneSession[] {
    return this.latestSessions;
  }

  /** 焦点会话最新视图（可能为 null） */
  getLatestView(): ChatView | null {
    return this.latestView;
  }

  /** 新 WS 连接（server.ts 的 /ws upgrade 路由到这里） */
  handleConnection(ws: WebSocket): void {
    const state: PhoneState = {
      ws,
      deviceToken: '',
      name: '',
      isAlive: true,
      connectedAt: Date.now(),
      lastPongAt: Date.now(),
    };
    this.pending.add(state);
    ws.on('message', (data) => {
      let cmd: PhoneCommand;
      try {
        cmd = JSON.parse(data.toString()) as PhoneCommand;
      } catch {
        return;
      }
      if (this.pending.has(state)) {
        // hello 前只接受 hello
        if (cmd.t === 'hello') this.handleHello(state, cmd);
        return;
      }
      this.handleCommand(state, cmd);
    });
    ws.on('pong', () => {
      state.isAlive = true;
      state.lastPongAt = Date.now();
    });
    // 仅当注册表仍指向本连接时才删除，防止旧连接的迟到 close 误删新连接
    const removeIfCurrent = () => {
      this.pending.delete(state);
      if (this.phones.get(state.deviceToken) === state) {
        this.phones.delete(state.deviceToken);
      }
    };
    ws.on('close', (code, reason) => {
      if (state.deviceToken) {
        const upSec = Math.round((Date.now() - state.connectedAt) / 1000);
        log(
          'hub',
          `手机连接关闭：${state.name} code=${code} reason=${reason || '（空）'} 已连接 ${upSec}s`,
        );
      }
      removeIfCurrent();
    });
    ws.on('error', removeIfCurrent);
  }

  // -------------------------------------------------------------------------

  private handleHello(
    state: PhoneState,
    cmd: Extract<PhoneCommand, { t: 'hello' }>,
  ): void {
    void (async () => {
      const ok = await verifyDeviceToken(cmd.device);
      if (state.ws.readyState !== state.ws.OPEN) return; // 鉴权期间已断开
      if (!ok) {
        this.send(state, { t: 'error', msg: 'deviceToken 无效' });
        state.ws.close(4401, 'unauthorized');
        return;
      }
      this.pending.delete(state);
      state.deviceToken = cmd.device;
      state.name = 'phone';
      this.phones.set(state.deviceToken, state);
      log('hub', `手机已连接：${state.name}`);
      this.sendWelcome(state);
    })();
  }

  private handleCommand(state: PhoneState, cmd: PhoneCommand): void {
    if (cmd.t === 'select') {
      void this.mirror.select(cmd.id);
      return;
    }
    if (cmd.t === 'send') {
      const ok = this.mirror.dispatchPendingMessage(cmd.text);
      if (!ok) {
        this.send(state, {
          t: 'error',
          msg: '发送失败：AHP 未连接或无焦点会话',
        });
      }
      return;
    }
    if (cmd.t === 'newSession') {
      // 在焦点项目下新建：先解析配置回给手机弹确认框
      const projectUri = this.mirror.focusProjectUri();
      if (!projectUri) {
        this.send(state, { t: 'error', msg: '新建会话失败：当前无焦点项目' });
        return;
      }
      void this.resolveConfigTo(state, projectUri);
      return;
    }
    if (cmd.t === 'newSessionIn') {
      void this.createSession(state, cmd.projectUri, cmd.config);
      return;
    }
    if (cmd.t === 'resolveConfig') {
      void this.resolveConfigTo(state, cmd.projectUri);
      return;
    }
    if (cmd.t === 'setArchived') {
      const ok = this.mirror.setArchived(cmd.id, cmd.archived);
      if (!ok) {
        this.send(state, { t: 'error', msg: '标记失败：AHP 未连接' });
      }
      return;
    }
    if (cmd.t === 'listProjects') {
      void this.mirror.listProjects().then((items) => {
        this.send(state, { t: 'projects', items });
      });
    }
  }

  /** 解析项目会话配置并回包 configResolved（手机据此弹确认框） */
  private async resolveConfigTo(state: PhoneState, projectUri: string): Promise<void> {
    const config = await this.mirror.resolveConfig(projectUri);
    if (config) {
      this.send(state, { t: 'configResolved', config });
    } else {
      this.send(state, { t: 'error', msg: '解析会话配置失败' });
    }
  }

  /** 新建会话并回包 sessionCreated（失败回包 error） */
  private async createSession(
    state: PhoneState,
    projectUri: string,
    config?: Record<string, unknown>,
  ): Promise<void> {
    const id = await this.mirror.createSessionIn(projectUri, config);
    if (id) {
      this.send(state, { t: 'sessionCreated', id });
    } else {
      this.send(state, { t: 'error', msg: '新建会话失败' });
    }
  }

  private sendWelcome(state: PhoneState): void {
    this.send(state, {
      t: 'welcome',
      sessions: this.latestSessions,
      focus: this.mirror.focusSessionId,
    });
    // 焦点会话当前视图（若有）
    if (this.latestView && this.mirror.focusSessionId) {
      this.send(state, {
        t: 'chat',
        id: this.mirror.focusSessionId,
        v: this.viewVersion,
        view: this.latestView,
      });
    }
  }

  // ---- AHP 镜像回调 ---------------------------------------------------------

  /** 会话列表变化 → 立即推送（低频） */
  onSessions(sessions: PhoneSession[]): void {
    this.latestSessions = sessions;
    this.broadcast({ t: 'sessions', items: sessions });
  }

  /** 焦点会话切换中 */
  onFocusChanging(_sessionId: string): void {
    // 切换期间视图会先清空再填充，无需额外提示
  }

  /** 焦点会话变化（含 null）→ 立即推送，端上据此同步标题栏/清空旧视图 */
  onFocus(sessionId: string | null): void {
    this.broadcast({ t: 'focus', id: sessionId });
  }

  /** 焦点会话 ChatState 变化 → 重算视图 + 节流推送 */
  onChat(sessionId: string, chat: ChatState | null): void {
    this.latestView = chat ? chatToView(chat) : null;
    this.viewVersion += 1;
    if (!chat) return;
    this.schedulePush(sessionId);
  }

  private schedulePush(sessionId: string): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const view = this.latestView;
      if (!view) return;
      this.broadcast({ t: 'chat', id: sessionId, v: this.viewVersion, view });
    }, PUSH_THROTTLE_MS);
    this.pushTimer.unref?.();
  }

  // ---- 推送 / 心跳 ----------------------------------------------------------

  private send(state: PhoneState, ev: DaemonEvent): void {
    if (state.ws.readyState === state.ws.OPEN) {
      state.ws.send(JSON.stringify(ev));
    }
  }

  private broadcast(ev: DaemonEvent): void {
    const data = JSON.stringify(ev);
    for (const p of this.phones.values()) {
      if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
    }
  }

  private heartbeat(): void {
    for (const p of this.phones.values()) {
      if (!p.isAlive) {
        const upSec = Math.round((Date.now() - p.connectedAt) / 1000);
        const sincePongSec = Math.round((Date.now() - p.lastPongAt) / 1000);
        log(
          'hub',
          `手机心跳超时，断开：${p.name}（已连接 ${upSec}s，距上次 pong ${sincePongSec}s）`,
        );
        p.ws.terminate();
        this.phones.delete(p.deviceToken);
        continue;
      }
      p.isAlive = false;
      p.ws.ping();
    }
  }
}
