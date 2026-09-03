import { create } from 'zustand';

/** 与主服务 BridgeEvent 同构（只声明 demo 用到的字段） */
type Tool = {
  toolId?: string;
  toolCallId?: string;
  message?: string;
  pastTenseMessage?: string;
  isComplete?: boolean;
};
export type Item =
  | { type: 'user'; text: string; ts?: number }
  // text：replay 路径后端 fullState items 用此字段；delta：流式 chunk 增量
  | { type: 'thinking'; id?: string; delta?: string; text?: string }
  | { type: 'text'; text?: string }
  | { type: 'tool_call'; tool?: Tool }
  | { type: 'question'; question?: { title?: string; message?: string; options?: string[] } }
  | { type: 'edit'; edit?: { fsPath?: string } }
  | {
      type: 'status';
      elapsedMs?: number;
      promptTokens?: number;
      completionTokens?: number;
    };
export type RequestState = {
  requestId: string;
  ts: number;
  userText: string;
  items: Item[];
  done: boolean;
};
/** 模型选项（与后端 ModelChoice 同构） */
export type ModelChoice = {
  identifier: string;
  name: string;
  supportsReasoningEffort?: string[];
};

export type SessionState = {
  sessionId: string;
  model?: string;
  /** 模型 identifier（写路径匹配 UIA 选项用） */
  modelIdentifier?: string;
  /** Agent 模式（agent/ask/plan） */
  mode?: string;
  /** 思考程度（low/medium/xhigh） */
  thinkingLevel?: string;
  lastActivity: number;
  /** 项目名（用于侧边栏分组） */
  project?: string;
  /** 会话标题（Copilot 生成；无则前端回退 sessionId 前缀） */
  title?: string;
  requests: Map<string, RequestState>;
  order: string[];
};

type DemoStore = {
  connected: boolean;
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  /** 递增版本号，驱动 React 重渲染（Map 内容变更不触发引用变化） */
  version: number;
  /** 后端上报的错误（如 systemTail 解析失败），非空时顶部显示 banner */
  error: string | null;
  /** 写路径：发送中（send_message 已发出、send_result 未回执） */
  sending: boolean;
  /** 模型列表（chatLanguageModels.json，前端模型下拉 + thinking 档位） */
  modelList: ModelChoice[];
  /** 移动端当前选择（发消息时发给后端改 PC 端）：跟随激活会话，用户可改 */
  selMode?: string;
  selModelId?: string;
  selThinking?: string;
  /** 用户是否手动改过当前会话的选择（true 时不跟随后端会话值） */
  selDirty: boolean;
};

export const useDemoStore = create<DemoStore>(() => ({
  connected: false,
  sessions: new Map(),
  activeSessionId: null,
  version: 0,
  error: null,
  sending: false,
  modelList: [],
  selMode: undefined,
  selModelId: undefined,
  selThinking: undefined,
  selDirty: false,
}));

const bump = () => useDemoStore.setState((s) => ({ version: s.version + 1 }));

function ensureSession(sessionId: string): SessionState {
  const s = useDemoStore.getState();
  let sess = s.sessions.get(sessionId);
  if (!sess) {
    sess = { sessionId, lastActivity: Date.now(), requests: new Map(), order: [] };
    s.sessions.set(sessionId, sess);
  }
  return sess;
}

function ensureRequest(sess: SessionState, requestId: string): RequestState {
  let r = sess.requests.get(requestId);
  if (!r) {
    r = { requestId, ts: Date.now(), userText: '', items: [], done: false };
    sess.requests.set(requestId, r);
    sess.order.push(requestId);
  }
  return r;
}

function handleEvent(e: Record<string, any>) {
  if (e.type === 'error') {
    useDemoStore.setState({ error: e.message ?? '未知错误' });
    return;
  }

  if (e.type === 'model_list') {
    useDemoStore.setState({ modelList: e.models ?? [] });
    return;
  }

  if (e.type === 'send_result') {
    // 写路径回执：成功时消息会经 jsonl/heimdall 读路径自然回流，无需本地插入
    if (!e.ok) {
      useDemoStore.setState({
        sending: false,
        error: e.error ?? '发送失败',
      });
    } else {
      useDemoStore.setState({ sending: false });
    }
    return;
  }

  if (e.type === 'hello' || e.type === 'session_list') {
    for (const sum of e.sessions ?? []) {
      const sess = ensureSession(sum.sessionId);
      sess.lastActivity = sum.lastActivity ?? Date.now();
      if (sum.model) sess.model = sum.model;
      if (sum.modelIdentifier) sess.modelIdentifier = sum.modelIdentifier;
      if (sum.mode) sess.mode = sum.mode;
      if (sum.thinkingLevel) sess.thinkingLevel = sum.thinkingLevel;
      if (sum.project) sess.project = sum.project;
      if (sum.title) sess.title = sum.title;
    }
    // 自动选中最近活跃的会话
    const s2 = useDemoStore.getState();
    if (!s2.activeSessionId && s2.sessions.size > 0) {
      const first = [...s2.sessions.values()].sort(
        (a, b) => b.lastActivity - a.lastActivity,
      )[0];
      useDemoStore.setState({ activeSessionId: first.sessionId });
      syncSelection(first.sessionId);
      ws?.send(JSON.stringify({ type: 'replay', sessionId: first.sessionId }));
    }
    // 激活会话三值更新：未手动改过则跟随 PC 端
    syncSelIfClean();
    bump();
    return;
  }

  if (e.type === 'replay') {
    const sess = ensureSession(e.sessionId);
    if (e.model) sess.model = e.model;
    if (e.modelIdentifier) sess.modelIdentifier = e.modelIdentifier;
    if (e.mode) sess.mode = e.mode;
    if (e.thinkingLevel) sess.thinkingLevel = e.thinkingLevel;
    if (e.title) sess.title = e.title;
    sess.lastActivity = e.lastActivity ?? Date.now();
    sess.requests = new Map();
    sess.order = [];
    for (const req of e.requests ?? []) {
      sess.requests.set(req.requestId, req);
      sess.order.push(req.requestId);
    }
    syncSelIfClean();
    bump();
    return;
  }

  if (e.type === 'session') {
    const sess = ensureSession(e.sessionId);
    if (e.model) sess.model = e.model;
    if (e.mode) sess.mode = e.mode;
    if (e.thinkingLevel) sess.thinkingLevel = e.thinkingLevel;
    if (e.title) sess.title = e.title;
    syncSelIfClean();
    bump();
    return;
  }

  const sess = ensureSession(e.sessionId);
  sess.lastActivity = Date.now();
  const r = ensureRequest(sess, e.requestId);

  if (e.type === 'user_message') {
    r.ts = e.ts ?? Date.now();
    r.userText = e.text;
    r.items.push({ type: 'user', text: e.text, ts: e.ts });
  } else if (e.type === 'chunk') {
    if (e.kind === 'thinking') {
      // 增长快照：replace 时原位替换同 id 的 thinking 项，否则追加
      if (e.replace && e.chunkId) {
        const ex = r.items.find(
          (it) => it.type === 'thinking' && it.id === e.chunkId,
        );
        if (ex && ex.type === 'thinking') {
          ex.delta = e.delta ?? '';
        } else {
          r.items.push({ type: 'thinking', id: e.chunkId, delta: e.delta ?? '' });
        }
      } else {
        r.items.push({ type: 'thinking', id: e.chunkId, delta: e.delta ?? '' });
      }
    } else if (e.kind === 'text') {
      // 连续 text chunk 合并到末项：行内代码反引号可能跨 chunk 拆分，
      // 拆成多个 item 各自独立渲染会配对失败（孤立 ` / 错位行内代码）。
      const last = r.items[r.items.length - 1];
      if (last && last.type === 'text') {
        last.text = (last.text ?? '') + (e.delta ?? '');
      } else {
        r.items.push({ type: 'text', text: e.delta ?? '' });
      }
    } else if (e.kind === 'tool_call') {
      r.items.push({ type: 'tool_call', tool: e.tool });
    } else if (e.kind === 'question') {
      r.items.push({ type: 'question', question: e.question });
    } else if (e.kind === 'edit') {
      r.items.push({ type: 'edit', edit: e.edit });
    }
  } else if (e.type === 'request_done') {
    r.items = e.items ?? r.items;
    r.done = true;
  }
  bump();
}

let ws: WebSocket | null = null;
let started = false;

export function startConnection() {
  if (started) return;
  started = true;
  connect();
}

/** 把指定会话的三值同步到移动端选择（切换会话时调用，重置 dirty） */
function syncSelection(sessionId: string) {
  const s = useDemoStore.getState();
  const sess = s.sessions.get(sessionId);
  if (!sess) return;
  useDemoStore.setState({
    selMode: sess.mode,
    selModelId: sess.modelIdentifier,
    selThinking: sess.thinkingLevel,
    selDirty: false,
  });
}

/** 激活会话三值更新且用户未手动改过 → 跟随 PC 端 */
function syncSelIfClean() {
  const s = useDemoStore.getState();
  if (s.selDirty || !s.activeSessionId) return;
  const sess = s.sessions.get(s.activeSessionId);
  if (!sess) return;
  useDemoStore.setState({
    selMode: sess.mode,
    selModelId: sess.modelIdentifier,
    selThinking: sess.thinkingLevel,
  });
}

/** 移动端手动选择 Agent 模式（发消息时生效） */
export function pickMode(mode: string) {
  useDemoStore.setState({ selMode: mode, selDirty: true });
}

/** 移动端手动选择模型（发消息时生效）；切换后若当前思考程度不在新模型支持范围则回退 */
export function pickModel(identifier: string) {
  const s = useDemoStore.getState();
  const model = s.modelList.find((m) => m.identifier === identifier);
  const efforts = model?.supportsReasoningEffort ?? [];
  let thinking = s.selThinking;
  if (efforts.length > 0 && thinking && !efforts.includes(thinking)) {
    thinking = efforts.includes('medium') ? 'medium' : efforts[0];
  }
  useDemoStore.setState({ selModelId: identifier, selThinking: thinking, selDirty: true });
}

/** 移动端手动选择思考程度（发消息时生效） */
export function pickThinking(level: string) {
  useDemoStore.setState({ selThinking: level, selDirty: true });
}

/** 切换会话：设置激活 id 并请求服务端 replay（重复点击同一会话不重发） */
export function selectSession(sessionId: string) {
  const s = useDemoStore.getState();
  if (s.activeSessionId === sessionId) return;
  useDemoStore.setState({ activeSessionId: sessionId });
  syncSelection(sessionId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'replay', sessionId }));
  }
}

/** 写路径：向当前激活会话发送消息（bridge 经 UIA 注入 VS Code + 改选中值） */
export function sendMessage(text: string) {
  const s = useDemoStore.getState();
  const id = s.activeSessionId;
  if (!id || s.sending || ws?.readyState !== WebSocket.OPEN) return;
  useDemoStore.setState({ sending: true, error: null });
  ws.send(
    JSON.stringify({
      type: 'send_message',
      sessionId: id,
      text,
      mode: s.selMode,
      modelIdentifier: s.selModelId,
      thinkingLevel: s.selThinking,
    }),
  );
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // bridge 的 WebSocketServer 监听 /ws 路径（见 server.ts），直连需带该路径
  ws = new WebSocket(`${proto}://127.0.0.1:8765/ws`);
  ws.onopen = () => {
    useDemoStore.setState({ connected: true });
    const id = useDemoStore.getState().activeSessionId;
    if (id) ws?.send(JSON.stringify({ type: 'replay', sessionId: id }));
  };
  ws.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(m.data));
    } catch (err) {
      console.error('bad message', err);
    }
  };
  ws.onclose = () => {
    useDemoStore.setState({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
}
