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
import { readVsCodeProjects, projectKey, uriToFsPath } from './projects.js';
import type {
  PhoneProject,
  PhoneSession,
  PhoneSessionConfig,
  SessionConfigOption,
} from '../phone/protocol.js';
import { log } from '../log.js';

export interface MirrorCallbacks {
  /** 会话列表变化 */
  onSessions(sessions: PhoneSession[]): void;
  /** 焦点会话 ChatState 变化（快照或增量；null = 无 chat 状态） */
  onChat(sessionId: string, chat: ChatState | null): void;
  /** 焦点会话切换中（订阅新会话期间） */
  onFocusChanging(sessionId: string): void;
  /** 焦点会话变化（含 null = 无未完成会话；供端上同步标题栏/清空旧视图） */
  onFocus(sessionId: string | null): void;
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

    // 默认焦点：第一个"未标记完成"的会话（与电脑端列表首项一致）
    const first =
      res.items.find((s) => (s.status & SessionStatus.IsArchived) === 0) ??
      res.items[0];
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
    this.cb.onFocus(sessionId);
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
        log('mirror', `会话 ${sessionId} 无 chat 通道`);
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
      log('mirror', `加载会话失败：${msg}`);
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
        // upsert：真实摘要覆盖合成摘要（新建会话首条消息后到达），否则置顶
        this.sessions = [
          summary,
          ...this.sessions.filter((x) => x.resource !== summary.resource),
        ];
        this.emitSessions();
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
          // 跟随剩余会话中第一个"未标记完成"的会话
          const next =
            this.sessions.find((s) => (s.status & SessionStatus.IsArchived) === 0) ??
            this.sessions[0];
          if (next) {
            void this.select(next.resource);
          } else {
            this.cb.onFocus(null);
          }
        }
      } else if (ev.type === 'sessionSummaryChanged') {
        const id = ev.params.session;
        const changes = ev.params.changes;
        this.sessions = this.sessions.map((x) =>
          x.resource === id ? { ...x, ...changes } : x,
        );
        this.emitSessions();
        // 若焦点会话刚被标记完成（AHP 回流），切走焦点
        this.relocateFocusIfArchived();
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
        log('mirror', `chatReducer 失败，重置 chat 状态: ${e instanceof Error ? e.message : String(e)}`);
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
      // 与电脑端一致：全部会话都下发并带 archived 标记；端上默认过滤掉已完成的，
      // 并提供"显示已完成"开关用于查看/恢复。项目下会话全部完成时，端上按
      // project 分组后该项目自然消失。
      this.sessions.map((s) => ({
        id: s.resource,
        title: s.title,
        status: statusToString(s.status),
        activity: s.activity ?? null,
        modifiedAt: s.modifiedAt,
        project: s.project?.displayName ?? null,
        projectUri: s.project?.uri ?? null,
        archived: (s.status & SessionStatus.IsArchived) !== 0,
      })),
    );
  }

  /**
   * 焦点会话若已被标记完成（archived），将焦点切换到下一个未完成会话；
   * 全部完成时焦点置 null。切换会触发 onFocusChanging（释放旧订阅）+ select。
   * 与电脑端 agent 窗口行为一致：标记完成当前会话后立即隐藏并切走焦点。
   */
  private relocateFocusIfArchived(): void {
    const current = this.focusSessionId;
    if (!current) return;
    const cur = this.sessions.find((s) => s.resource === current);
    if (!cur || (cur.status & SessionStatus.IsArchived) === 0) return;
    const next = this.sessions.find((s) => (s.status & SessionStatus.IsArchived) === 0);
    if (next) {
      void this.select(next.resource);
    } else {
      // 全部完成：释放订阅、清空焦点
      void this.releaseChat();
      this.focusSessionId = null;
      this.focusChatState = null;
      this.cb.onChat(current, null);
      this.cb.onFocus(null);
    }
  }

  // ---- 新增：标记完成 / 新建会话 / 项目列表 ---------------------------------

  /** 当前焦点会话所属项目 URI（"新建会话"默认项目用）；无焦点或无项目时 null */
  focusProjectUri(): string | null {
    if (!this.focusSessionId) return null;
    const s = this.sessions.find((x) => x.resource === this.focusSessionId);
    return s?.project?.uri ?? null;
  }

  /**
   * 解析某项目的会话配置（新建会话确认弹窗用）。
   * 返回可选项（isolation/mode/... 的当前值 + 可选值），供手机展示并让用户确认。
   */
  async resolveConfig(projectUri: string): Promise<PhoneSessionConfig | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const cfg = await client.request('resolveSessionConfig', {
        channel: 'ahp-root://',
        workingDirectory: projectUri,
      });
      const values = (cfg?.values ?? {}) as Record<string, unknown>;
      const props = cfg?.schema?.properties ?? {};
      const options: SessionConfigOption[] = Object.entries(props).map(([key, p]) => ({
        key,
        label: p?.title ?? key,
        value:
          typeof values[key] === 'string'
            ? (values[key] as string)
            : values[key] == null
              ? null
              : String(values[key]),
        options: Array.isArray(p?.enum)
          ? (p.enum as unknown[]).map((v) => String(v))
          : [],
      }));
      return { projectUri, options };
    } catch (err) {
      log('mirror', `resolveConfig 失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** 标记 / 取消标记会话完成（archived）。
   *  dispatch 后 AHP 对"有消息的真实会话"会回发 sessionSummaryChanged 回流列表；
   *  但"刚创建的空会话"（无消息）AHP 不跟踪、不回流，故这里同时做本地乐观更新
   *  并立即重发列表，保证手机端标记完成/恢复即时生效；真实会话的后续回流是幂等覆盖。
   */
  setArchived(sessionId: string, archived: boolean): boolean {
    const client = this.client;
    if (!client) return false;
    client.dispatch(sessionId, {
      type: ActionType.SessionIsArchivedChanged,
      isArchived: archived,
    });
    const idx = this.sessions.findIndex((x) => x.resource === sessionId);
    if (idx >= 0) {
      const s = this.sessions[idx];
      const next = archived
        ? (s.status | SessionStatus.IsArchived)
        : (s.status & ~SessionStatus.IsArchived);
      if (next !== s.status) {
        this.sessions = this.sessions.map((x, i) =>
          i === idx ? { ...x, status: next } : x,
        );
        this.emitSessions();
      }
    }
    // 若焦点会话刚被标记完成，切走焦点（恢复/标记非焦点会话时无副作用）
    this.relocateFocusIfArchived();
    return true;
  }

  /**
   * 在指定项目下新建会话并切换焦点。
   * 新建的会话在首条消息前不会出现在 listSessions，故这里立即合成一条
   * PhoneSession 推送给手机（consumeRoot 的 sessionAdded 会按 resource 去重）。
   * 返回新会话 URI；失败返回 null。
   */
  async createSessionIn(
    projectUri: string,
    config?: Record<string, unknown>,
  ): Promise<string | null> {
    const client = this.client;
    if (!client) return null;
    try {
      const channel = `ahp-session:/${crypto.randomUUID()}`;
      // 手机未带 config 时（如"新建会话"走默认），回退到服务端默认值；
      // 手机确认弹窗后会把用户选定的 config 传进来。
      let finalConfig = config;
      if (!finalConfig) {
        try {
          const cfg = await client.request('resolveSessionConfig', {
            channel: 'ahp-root://',
            workingDirectory: projectUri,
          });
          if (cfg && typeof cfg === 'object' && cfg.values) finalConfig = cfg.values;
        } catch (e) {
          log('mirror', `resolveSessionConfig 失败，用默认创建：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await client.request('createSession', {
        channel,
        workingDirectories: [projectUri],
        ...(finalConfig ? { config: finalConfig } : {}),
      });
      await this.select(channel);

      // 新建会话在首条消息前不会出现在 listSessions，故先合成一条摘要入列，
      // 让手机立即看到；首条消息触发 sessionAdded 时会以真实摘要 upsert 覆盖。
      const now = new Date().toISOString();
      const name = projectUriToName(projectUri);
      const synthetic: SessionSummary = {
        resource: channel,
        createdAt: now,
        modifiedAt: now,
        provider: 'copilot',
        title: '(新会话)',
        status: SessionStatus.Idle,
        project: { uri: projectUri, displayName: name },
        workingDirectories: [projectUri],
      };
      this.sessions = [
        synthetic,
        ...this.sessions.filter((x) => x.resource !== channel),
      ];
      this.emitSessions();
      return channel;
    } catch (err) {
      log('mirror', `createSession 失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 可新建会话的项目列表：AHP 会话目录中的项目 + VS Code 最近项目，
   * 按 projectKey（worktree 归并到主仓）去重。
   */
  async listProjects(): Promise<PhoneProject[]> {
    const seen = new Map<string, PhoneProject>();
    // 1) AHP 会话目录：project.uri 是基础仓库（worktree 会话也指向主仓）
    for (const s of this.sessions) {
      const uri = s.project?.uri;
      if (!uri) continue;
      const key = projectKey(uriToFsPath(uri) ?? '');
      if (!seen.has(key)) {
        seen.set(key, { uri, name: s.project?.displayName ?? projectUriToName(uri) });
      }
    }
    // 2) VS Code 侧最近项目（agent 选择器 + 打开窗口）
    const vs = await readVsCodeProjects();
    for (const p of vs) {
      const key = projectKey(uriToFsPath(p.uri) ?? '');
      if (!seen.has(key)) seen.set(key, { uri: p.uri, name: p.name });
    }
    return [...seen.values()];
  }
}

/** file:// URI → 目录名（展示用） */
function projectUriToName(uri: string): string {
  const p = uriToFsPath(uri);
  if (!p) return uri;
  const base = p.replace(/[\\/]+$/, '');
  return base.split(/[\\/]/).pop() ?? base;
}

/** SessionStatus 位集 → 主状态可读字符串（取最高优先位的语义） */
function statusToString(status: number): string {
  if (status & SessionStatus.Error) return 'error';
  if (status & SessionStatus.InputNeeded) return 'inputNeeded';
  if (status & SessionStatus.InProgress) return 'inProgress';
  if (status & SessionStatus.IsArchived) return 'archived';
  return 'idle';
}
