import { create } from 'zustand';
import {
  AhpClient,
  type Subscription,
} from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  SUPPORTED_PROTOCOL_VERSIONS,
  chatReducer,
  type ChatAction,
  type ChatState,
  type SessionState,
  type SessionSummary,
} from '@microsoft/agent-host-protocol';

// ============================================================================
// = AHP 状态镜像                                                              =
// PWA 是 VS Code Agents 窗口的"第二块屏"：
// - 读路径：订阅根通道（会话列表）+ 活动会话的 chat 通道；
//   ChatState 由官方 chatReducer 纯函数维护（快照 + live action 增量）
// - 写路径（M2）：dispatch chat/pendingMessageSet 排队消息，
//   宿主在合适时机消费（空闲立即开 turn，忙碌时排到当前 turn 之后）
// 数据面直连 agent host（ws://<host>:8081?tkn=<token>），pocket-copilot 只提供
// 静态文件与 /api/config（端口 + token）。
// ============================================================================

type Phase = 'boot' | 'no-token' | 'connecting' | 'connected' | 'error';

type AhpStore = {
  phase: Phase;
  /** 连接错误/提示（非空时顶部 banner 展示） */
  error: string | null;
  /** 会话列表（listSessions + sessionAdded/Removed/SummaryChanged 维护） */
  sessions: SessionSummary[];
  /** 活动会话 URI（ahp-session:/<uuid>） */
  activeSessionId: string | null;
  /** 正在加载会话（订阅 session + chat 通道中） */
  selecting: boolean;
  /** 活动 chat 的状态（快照 + chatReducer 增量） */
  chatState: ChatState | null;
  /** 正在加载更早历史（fetchTurns 进行中） */
  loadingOlder: boolean;
  /** 递增版本号，驱动 React 重渲染 */
  version: number;
};

export const useAhpStore = create<AhpStore>(() => ({
  phase: 'boot',
  error: null,
  sessions: [],
  activeSessionId: null,
  selecting: false,
  chatState: null,
  loadingOlder: false,
  version: 0,
}));

const bump = () => useAhpStore.setState((s) => ({ version: s.version + 1 }));

// ---------------------------------------------------------------------------
// 连接管理
// ---------------------------------------------------------------------------

let client: AhpClient | null = null;
let rootSub: Subscription | null = null;
let sessionSub: Subscription | null = null;
let chatSub: Subscription | null = null;
let activeChatUri: string | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function startConnection(): void {
  if (started) return;
  started = true;
  void connect();
}

async function connect(): Promise<void> {
  const set = useAhpStore.setState;
  try {
    set({ phase: 'boot', error: null });

    // 1. 从 pocket-copilot 取 agent host 端口 + token
    const cfg = (await fetch('/api/config').then((r) => r.json())) as {
      agentHostPort: number;
      token: string | null;
    };
    if (!cfg.token) {
      set({
        phase: 'no-token',
        error: '未找到连接 token，请先用 launch-vscode-ahp.cmd 启动 VS Code',
      });
      return;
    }

    // 2. 直连 agent host（与页面同源 hostname，手机走 Tailscale IP 时同样成立）
    set({ phase: 'connecting' });
    const url = `ws://${location.hostname}:${cfg.agentHostPort}?tkn=${cfg.token}`;
    const transport = await WebSocketTransport.connect(url);
    const c = new AhpClient(transport);
    client = c;
    c.connect();
    await c.initialize({
      clientId: 'pocket-copilot-pwa',
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      initialSubscriptions: ['ahp-root://'],
    });
    set({ phase: 'connected' });

    // 3. 根通道：会话列表变化
    rootSub = c.attachSubscription('ahp-root://');
    void consumeRoot(rootSub);

    // 4. 初始会话列表（服务端按最近修改排序），自动选中最近一个
    const res = await c.request('listSessions', { channel: 'ahp-root://' });
    set({ sessions: res.items });
    const first = res.items[0];
    if (first) await selectSession(first.resource);

    // 5. 连接断开 → 提示并定时重连
    void (async () => {
      for await (const st of c.stateChanges()) {
        if (st.status === 'closed' && st.reason.type !== 'shutdown') {
          await teardown();
          set({
            phase: 'error',
            error: '与 VS Code 的连接已断开，正在重试…',
          });
          scheduleReconnect();
        }
      }
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({ phase: 'error', error: `无法连接 VS Code agent host：${msg}` });
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, 3000);
}

async function teardown(): Promise<void> {
  rootSub = null;
  sessionSub = null;
  chatSub = null;
  activeChatUri = null;
  const c = client;
  client = null;
  if (c) {
    try {
      await c.shutdown();
    } catch {
      // 忽略关闭中的二次错误
    }
  }
}

// ---------------------------------------------------------------------------
// 根通道：会话列表
// ---------------------------------------------------------------------------

async function consumeRoot(sub: Subscription): Promise<void> {
  for await (const ev of sub) {
    const s = useAhpStore.getState();
    if (ev.type === 'sessionAdded') {
      const summary = ev.params.summary;
      if (!s.sessions.some((x) => x.resource === summary.resource)) {
        useAhpStore.setState({ sessions: [summary, ...s.sessions] });
        // 尚无活动会话时跟随最新会话
        if (!s.activeSessionId) void selectSession(summary.resource);
      }
    } else if (ev.type === 'sessionRemoved') {
      const id = ev.params.session;
      const wasActive = s.activeSessionId === id;
      useAhpStore.setState({
        sessions: s.sessions.filter((x) => x.resource !== id),
        ...(wasActive ? { activeSessionId: null, chatState: null } : {}),
      });
      if (wasActive) {
        activeChatUri = null;
        chatSub = null;
      }
    } else if (ev.type === 'sessionSummaryChanged') {
      const id = ev.params.session;
      const changes = ev.params.changes;
      useAhpStore.setState({
        sessions: s.sessions.map((x) =>
          x.resource === id ? { ...x, ...changes } : x,
        ),
      });
    }
    bump();
  }
}

// ---------------------------------------------------------------------------
// 会话 / chat 通道
// ---------------------------------------------------------------------------

/** 选中会话：订阅 session 通道拿 defaultChat，再订阅 chat 通道拿 ChatState */
export async function selectSession(sessionId: string): Promise<void> {
  const s = useAhpStore.getState();
  if (!client || s.activeSessionId === sessionId) return;
  useAhpStore.setState({ selecting: true, chatState: null });
  try {
    // 释放上一个 chat 订阅
    if (activeChatUri) {
      try {
        await client.unsubscribe(activeChatUri);
      } catch {
        // 忽略
      }
      chatSub = null;
      activeChatUri = null;
    }

    const sessionRes = await client.subscribe(sessionId);
    sessionSub = sessionRes.subscription;
    const snap = sessionRes.result.snapshot;
    const sessionState = snap?.state as SessionState | undefined;
    const chatUri =
      sessionState?.defaultChat ?? sessionState?.chats[0]?.resource ?? null;
    if (!chatUri) {
      useAhpStore.setState({
        activeSessionId: sessionId,
        chatState: null,
        selecting: false,
      });
      return;
    }

    const chatRes = await client.subscribe(chatUri);
    chatSub = chatRes.subscription;
    activeChatUri = chatUri;
    const chatSnap = chatRes.result.snapshot?.state as ChatState | undefined;
    useAhpStore.setState({
      activeSessionId: sessionId,
      chatState: chatSnap ?? null,
      selecting: false,
    });
    if (chatSnap) void consumeChat(chatSub, chatUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useAhpStore.setState({ selecting: false, error: `加载会话失败：${msg}` });
  }
}

/** chat 通道 live action → 官方 chatReducer 纯函数增量更新 */
async function consumeChat(sub: Subscription, chatUri: string): Promise<void> {
  for await (const ev of sub) {
    if (ev.type !== 'action' || ev.params.channel !== chatUri) continue;
    const cs = useAhpStore.getState().chatState;
    if (!cs) continue;
    const next = chatReducer(cs, ev.params.action as ChatAction);
    if (next !== cs) useAhpStore.setState({ chatState: next });
  }
}

// ---------------------------------------------------------------------------
// 写路径
// ---------------------------------------------------------------------------

/**
 * 发送消息 = dispatch 一条排队消息。
 * 宿主行为：chat 空闲时立即消费开新 turn；当前 turn 进行中则排队，
 * turn 结束后自动作为新 turn 发出（与 Agents 窗口"排队发送"一致）。
 * 回显经 chat/pendingMessageSet action 走订阅回流，由 chatReducer 更新状态。
 */
export function sendMessage(text: string): void {
  if (!client || !activeChatUri || !text.trim()) return;
  client.dispatch(activeChatUri, {
    type: ActionType.ChatPendingMessageSet,
    kind: PendingMessageKind.Queued,
    id: crypto.randomUUID(),
    message: { text, origin: { kind: MessageKind.User } },
  });
}

/** 加载更早历史：fetchTurns 请求，数据经 chat/turnsLoaded 回流由 chatReducer 处理 */
export async function loadOlder(): Promise<void> {
  const s = useAhpStore.getState();
  if (!client || !activeChatUri || !s.chatState?.turnsNextCursor || s.loadingOlder)
    return;
  useAhpStore.setState({ loadingOlder: true });
  try {
    await client.request('fetchTurns', {
      channel: activeChatUri,
      cursor: s.chatState.turnsNextCursor,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    useAhpStore.setState({ error: `加载历史失败：${msg}` });
  } finally {
    useAhpStore.setState({ loadingOlder: false });
  }
}
