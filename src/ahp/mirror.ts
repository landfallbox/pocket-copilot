// ============================================================================
// = AHP 状态镜像（store.ts 的 consumeRoot/selectSession/consumeChat 移植）      =
// - 根通道：会话列表（listSessions + sessionAdded/Removed/SummaryChanged）      =
// - 焦点会话：session 通道 → defaultChat → chat 通道，官方 chatReducer 维护     =
//   ChatState；手机切会话时切换订阅                                            =
// 只镜像"焦点会话"，不镜像全部会话。                                            =
// ============================================================================

import crypto from 'node:crypto';
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  SessionStatus,
  chatReducer,
  type ChatAction,
  type ChatState,
  type SessionState,
  type SessionSummary,
} from '@microsoft/agent-host-protocol';
import type { AhpClient, Subscription } from '@microsoft/agent-host-protocol/client';
import type { PhoneSession } from '../phone/protocol.js';

export interface MirrorCallbacks {
  /** 会话列表变化 */
  onSessions(sessions: PhoneSession[]): void;
  /** 焦点会话 ChatState 变化（快照或增量；null = 无 chat 状态） */
  onChat(sessionId: string, chat: ChatState | null): void;
  /** 焦点会话切换中（订阅新会话期间） */
  onFocusChanging(sessionId: string): void;
}

export class AhpMirror {
  private sessions: SessionSummary[] = [];
  /** 当前焦点会话 URI（ahp-session:/<uuid>） */
  focusSessionId: string | null = null;
  /** 焦点会话的 chat 通道 URI */
  focusChatUri: string | null = null;
  /** 焦点会话 ChatState（chatReducer 维护） */
  focusChatState: ChatState | null = null;

  private rootSub: Subscription | null = null;
  private chatSub: Subscription | null = null;
  private client: AhpClient | null = null;
  private stopping = false;

  constructor(private readonly cb: MirrorCallbacks) {}

  /** 连接就绪后调用：订阅根通道 + 初始会话列表 + 默认焦点 */
  async start(client: AhpClient): Promise<void> {
    this.client = client;
    this.stopping = false;

    this.rootSub = client.attachSubscription('ahp-root://');
    void this.consumeRoot(this.rootSub);

    const res = await client.request('listSessions', { channel: 'ahp-root://' });
    this.sessions = res.items;
    this.emitSessions();

    const first = res.items[0];
    if (first) await this.select(first.resource);
  }

  /** 连接断开时调用：清理订阅与状态（重连后 start 会重建） */
  stop(): void {
    this.stopping = true;
    this.rootSub = null;
    this.chatSub = null;
    this.focusChatUri = null;
    this.focusChatState = null;
    this.client = null;
  }

  /** 切换焦点会话（订阅 session 通道拿 defaultChat，再订阅 chat 通道） */
  async select(sessionId: string): Promise<void> {
    const client = this.client;
    if (!client || this.stopping || this.focusSessionId === sessionId) return;

    this.cb.onFocusChanging(sessionId);
    this.focusSessionId = sessionId;
    this.focusChatState = null;
    this.cb.onChat(sessionId, null);

    try {
      await this.releaseChat();

      const sessionRes = await client.subscribe(sessionId);
      const snap = sessionRes.result.snapshot;
      const sessionState = snap?.state as SessionState | undefined;
      const chatUri =
        sessionState?.defaultChat ?? sessionState?.chats[0]?.resource ?? null;
      if (!chatUri) {
        log(`会话 ${sessionId} 无 chat 通道`);
        return;
      }

      const chatRes = await client.subscribe(chatUri);
      this.chatSub = chatRes.subscription;
      this.focusChatUri = chatUri;
      const chatSnap = chatRes.result.snapshot?.state as ChatState | undefined;
      this.focusChatState = chatSnap ?? null;
      this.cb.onChat(sessionId, this.focusChatState);
      if (chatSnap) void this.consumeChat(this.chatSub, chatUri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`加载会话失败：${msg}`);
    }
  }

  /** 向焦点 chat 通道 dispatch 排队消息（写路径；回显经订阅回流） */
  dispatchPendingMessage(text: string): boolean {
    const { client, focusChatUri } = this;
    if (!client || !focusChatUri || !text.trim()) return false;
    client.dispatch(focusChatUri, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Queued,
      id: crypto.randomUUID(),
      message: { text, origin: { kind: MessageKind.User } },
    });
    return true;
  }

  // -------------------------------------------------------------------------

  private async consumeRoot(sub: Subscription): Promise<void> {
    for await (const ev of sub) {
      if (this.stopping) return;
      if (ev.type === 'sessionAdded') {
        const summary = ev.params.summary;
        if (!this.sessions.some((x) => x.resource === summary.resource)) {
          this.sessions = [summary, ...this.sessions];
          this.emitSessions();
        }
      } else if (ev.type === 'sessionRemoved') {
        const id = ev.params.session;
        const wasFocus = this.focusSessionId === id;
        this.sessions = this.sessions.filter((x) => x.resource !== id);
        this.emitSessions();
        if (wasFocus) {
          this.focusSessionId = null;
          this.focusChatState = null;
          this.focusChatUri = null;
          this.chatSub = null;
          this.cb.onChat(id, null);
          // 跟随剩余会话中的最新一个
          const next = this.sessions[0];
          if (next) void this.select(next.resource);
        }
      } else if (ev.type === 'sessionSummaryChanged') {
        const id = ev.params.session;
        const changes = ev.params.changes;
        this.sessions = this.sessions.map((x) =>
          x.resource === id ? { ...x, ...changes } : x,
        );
        this.emitSessions();
      }
    }
  }

  /** chat 通道 live action → 官方 chatReducer 纯函数增量更新 */
  private async consumeChat(sub: Subscription, chatUri: string): Promise<void> {
    for await (const ev of sub) {
      if (this.stopping) return;
      if (ev.type !== 'action' || ev.params.channel !== chatUri) continue;
      const cs = this.focusChatState;
      if (!cs) continue;
      let next: ChatState;
      try {
        next = chatReducer(cs, ev.params.action as ChatAction);
      } catch (e) {
        log(`chatReducer 失败，重置 chat 状态: ${e instanceof Error ? e.message : String(e)}`);
        this.focusChatState = null;
        continue;
      }
      if (next !== cs) {
        this.focusChatState = next;
        this.cb.onChat(this.focusSessionId ?? '', next);
      }
    }
  }

  private async releaseChat(): Promise<void> {
    const { client, focusChatUri } = this;
    if (client && focusChatUri) {
      try {
        await client.unsubscribe(focusChatUri);
      } catch {
        // 忽略
      }
    }
    this.chatSub = null;
    this.focusChatUri = null;
  }

  private emitSessions(): void {
    this.cb.onSessions(
      this.sessions.map((s) => ({
        id: s.resource,
        title: s.title,
        status: statusToString(s.status),
        activity: s.activity ?? null,
        modifiedAt: s.modifiedAt,
        project: s.project?.displayName ?? null,
      })),
    );
  }
}

function log(msg: string): void {
  console.log(`[mirror] ${msg}`);
}

/** SessionStatus 位集 → 主状态可读字符串（取最高优先位的语义） */
function statusToString(status: number): string {
  if (status & SessionStatus.Error) return 'error';
  if (status & SessionStatus.InputNeeded) return 'inputNeeded';
  if (status & SessionStatus.InProgress) return 'inProgress';
  if (status & SessionStatus.IsArchived) return 'archived';
  return 'idle';
}
