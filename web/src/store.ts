import { create } from 'zustand';

/** 与 bridge BridgeEvent 同构（只声明前端用到的字段） */
export type Tool = {
  toolId?: string;
  toolCallId?: string;
  message?: string;
  pastTenseMessage?: string;
  isComplete?: boolean;
};
export type Item =
  | { type: 'user'; text: string; ts?: number }
  | { type: 'thinking'; text?: string; id?: string }
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
export type SessionState = {
  sessionId: string;
  model?: string;
  project?: string;
  lastActivity: number;
  requests: Map<string, RequestState>;
  order: string[];
};
export type RecorderHealth = {
  lastRecordAt: number;
  lastFile?: string;
  stale: boolean;
};

type Store = {
  connected: boolean;
  recorder?: RecorderHealth;
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  /** 递增版本号，驱动 React 重渲染（Map 内容变更不触发引用变化） */
  version: number;
};

export const useStore = create<Store>(() => ({
  connected: false,
  sessions: new Map(),
  activeSessionId: null,
  version: 0,
}));

const bump = () => useStore.setState((s) => ({ version: s.version + 1 }));

function ensureSession(sessionId: string): SessionState {
  const s = useStore.getState();
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
  if (e.type === 'hello' || e.type === 'session_list') {
    const s = useStore.getState();
    if (e.recorder) s.recorder = e.recorder;
    for (const sum of e.sessions ?? []) {
      const sess = ensureSession(sum.sessionId);
      sess.lastActivity = sum.lastActivity ?? Date.now();
      if (sum.model) sess.model = sum.model;
      if (sum.project) sess.project = sum.project;
    }
    if (!s.activeSessionId && s.sessions.size > 0) {
      const first = [...s.sessions.values()].sort(
        (a, b) => b.lastActivity - a.lastActivity,
      )[0];
      useStore.setState({ activeSessionId: first.sessionId });
      ws?.send(JSON.stringify({ type: 'replay', sessionId: first.sessionId }));
    }
    bump();
    return;
  }

  if (e.type === 'replay') {
    const sess = ensureSession(e.sessionId);
    if (e.model) sess.model = e.model;
    sess.lastActivity = e.lastActivity ?? Date.now();
    sess.requests = new Map();
    sess.order = [];
    for (const req of e.requests ?? []) {
      sess.requests.set(req.requestId, req);
      sess.order.push(req.requestId);
    }
    bump();
    return;
  }

  if (e.type === 'session') {
    const sess = ensureSession(e.sessionId);
    if (e.model) sess.model = e.model;
    if (e.project) sess.project = e.project;
    bump();
    return;
  }

  if (e.type === 'request_migrated') {
    // 方案 A：provisional 请求归属到真实请求 → 前端把请求对象搬移。
    // 注意：该事件无顶层 sessionId/requestId，必须提前返回，
    // 否则落入通用分支 ensureSession(undefined) 产生脏会话。
    const from = ensureSession(e.fromSessionId);
    const to = ensureSession(e.toSessionId);
    const req = from.requests.get(e.fromRequestId);
    if (req) {
      from.requests.delete(e.fromRequestId);
      const fi = from.order.indexOf(e.fromRequestId);
      if (fi >= 0) from.order.splice(fi, 1);
      const existing = to.requests.get(e.toRequestId);
      if (existing) {
        // 真实请求已存在（jsonl user_message 先到）：把 provisional 已流式的内容并入
        for (const it of req.items) {
          if (it.type !== 'user') existing.items.push(it);
        }
        existing.done = req.done;
      } else {
        to.requests.set(e.toRequestId, req);
        to.order.push(e.toRequestId);
      }
    }
    bump();
    return;
  }

  if (e.type === 'provisional_removed') {
    // 方案 A：provisional 超时未归属（非聊天流量）→ 前端移除
    const sess = ensureSession(e.sessionId);
    sess.requests.delete(e.requestId);
    const i = sess.order.indexOf(e.requestId);
    if (i >= 0) sess.order.splice(i, 1);
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
      // 对齐器按整段 flush（非增长快照），直接追加
      r.items.push({ type: 'thinking', text: e.delta ?? '', id: e.chunkId });
    } else if (e.kind === 'text') {
      r.items.push({ type: 'text', text: e.delta ?? '' });
    } else if (e.kind === 'tool_call') {
      r.items.push({ type: 'tool_call', tool: e.tool });
    } else if (e.kind === 'question') {
      r.items.push({ type: 'question', question: e.question });
    } else if (e.kind === 'edit') {
      r.items.push({ type: 'edit', edit: e.edit });
    }
  } else if (e.type === 'request_done') {
    // server 发的权威 items（含完整正文），覆盖实时累积
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

/** 切换会话：设置激活 id 并请求服务端 replay（重复点击同一会话不重发） */
export function selectSession(sessionId: string) {
  const s = useStore.getState();
  if (s.activeSessionId === sessionId) return;
  useStore.setState({ activeSessionId: sessionId });
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'replay', sessionId }));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    useStore.setState({ connected: true });
    const id = useStore.getState().activeSessionId;
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
    useStore.setState({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws?.close();
}
