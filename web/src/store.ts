import { create } from 'zustand';
import { fetchTheme, applyTheme, type ThemeInfo } from './theme';

/** 首次打开（无持久化）时，默认显示最近 7 天有会话活动的项目 */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const LS_KEY = 'copilot-bridge:visible-projects';

/**
 * 读取持久化的可见项目列表。
 * 返回 null 表示“从未持久化过”（首次打开，需按最近 7 天活跃初始化）；
 * 返回数组（可能为空）表示用户已维护过，原样恢复上次的状态。
 */
function loadVisibleProjects(): string[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null) return null;
    const o = JSON.parse(raw) as { visible?: unknown };
    return Array.isArray(o.visible) ? (o.visible as string[]) : [];
  } catch {
    return null;
  }
}
function saveVisibleProjects(visible: string[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ visible }));
  } catch {
    // 隐私模式等写入失败时静默降级（仅本次会话生效）
  }
}

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
export type SessionState = {
  sessionId: string;
  model?: string;
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
  /** 活动主题（/api/theme），驱动 CSS 变量 + 代码高亮色表 */
  theme: ThemeInfo | null;
  /** 侧边栏可见项目（持久化；首次默认最近 7 天活跃，之后保持上次状态） */
  visibleProjects: string[];
  /** 是否已初始化可见项目（false 时等待首次 session_list 按最近活跃初始化） */
  projectsInitialized: boolean;
};

const initialVisible = loadVisibleProjects();

export const useDemoStore = create<DemoStore>(() => ({
  connected: false,
  sessions: new Map(),
  activeSessionId: null,
  version: 0,
  error: null,
  sending: false,
  theme: null,
  visibleProjects: initialVisible ?? [],
  projectsInitialized: initialVisible !== null,
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
      if (sum.project) sess.project = sum.project;
      if (sum.title) sess.title = sum.title;
    }
    // 同步可见项目（首次初始化 / 新项目自动加入）
    const s = useDemoStore.getState();
    const allProjects = [...new Set([...s.sessions.values()].map((x) => x.project).filter(Boolean))] as string[];
    syncVisibleProjects(allProjects);
    // 自动选中第一个可见会话
    const s2 = useDemoStore.getState();
    if (!s2.activeSessionId && s2.sessions.size > 0) {
      const visible = new Set(s2.visibleProjects);
      const candidates = [...s2.sessions.values()].filter(
        (x) => x.project && visible.has(x.project),
      );
      const pool = candidates.length > 0 ? candidates : [...s2.sessions.values()];
      const first = pool.sort((a, b) => b.lastActivity - a.lastActivity)[0];
      useDemoStore.setState({ activeSessionId: first.sessionId });
      ws?.send(JSON.stringify({ type: 'replay', sessionId: first.sessionId }));
    }
    bump();
    return;
  }

  if (e.type === 'replay') {
    const sess = ensureSession(e.sessionId);
    if (e.model) sess.model = e.model;
    if (e.title) sess.title = e.title;
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
    if (e.title) sess.title = e.title;
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
  // 拉取活动主题并注入 CSS 变量（失败降级：保留 index.css 内置深色兜底）
  fetchTheme().then((info) => {
    if (info) {
      applyTheme(info);
      useDemoStore.setState({ theme: info });
    }
  });
}

/** 切换会话：设置激活 id 并请求服务端 replay（重复点击同一会话不重发） */
export function selectSession(sessionId: string) {
  const s = useDemoStore.getState();
  if (s.activeSessionId === sessionId) return;
  useDemoStore.setState({ activeSessionId: sessionId });
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'replay', sessionId }));
  }
}

/** 刷新当前会话：重新请求服务端 replay（拉取最新 turns） */
export function refreshActive() {
  const s = useDemoStore.getState();
  const id = s.activeSessionId;
  if (id && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'replay', sessionId: id }));
  }
}

/**
 * 计算最近 7 天内有会话活动的项目集合（仅首次初始化用）。
 */
export function recentlyActiveProjects(sessions: SessionState[]): string[] {
  const cutoff = Date.now() - RECENT_MS;
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.project && s.lastActivity >= cutoff) set.add(s.project);
  }
  return [...set];
}

/**
 * 项目是否可见：在 visibleProjects 列表中即显示。
 */
export function isProjectVisible(project: string): boolean {
  return useDemoStore.getState().visibleProjects.includes(project);
}

/**
 * 切换项目可见性（管理项目面板 / 项目头眼睛按钮）。
 */
export function toggleProject(project: string): void {
  const { visibleProjects } = useDemoStore.getState();
  const visible = visibleProjects.includes(project)
    ? visibleProjects.filter((x) => x !== project)
    : [...visibleProjects, project];
  saveVisibleProjects(visible);
  useDemoStore.setState((s) => ({
    visibleProjects: visible,
    version: s.version + 1,
  }));
}

/**
 * 同步可见项目：
 * - 首次（无持久化）：按最近 7 天活跃初始化。
 * - 已初始化：自动加入“近期活跃”的新项目（用户新开的会话）。
 *   只加 recent 项目是关键：启动重放期所有历史项目会陆续出现，
 *   若无条件加入会把全部历史项目都塞进来；限定 recent 后，
 *   历史非活跃项目不会误入，真正新开的会话（必然 recent）才会自动出现。
 */
function syncVisibleProjects(allProjects: string[]): void {
  const s = useDemoStore.getState();
  const recentSet = new Set(recentlyActiveProjects([...s.sessions.values()]));
  if (!s.projectsInitialized) {
    // 首次：按最近 7 天活跃初始化
    const recent = [...recentSet];
    saveVisibleProjects(recent);
    useDemoStore.setState({ visibleProjects: recent, projectsInitialized: true });
    return;
  }
  // 已初始化：自动加入近期活跃的新项目
  const current = new Set(s.visibleProjects);
  let changed = false;
  for (const p of allProjects) {
    if (!current.has(p) && recentSet.has(p)) {
      current.add(p);
      changed = true;
    }
  }
  if (changed) {
    const next = [...current];
    saveVisibleProjects(next);
    useDemoStore.setState({ visibleProjects: next });
  }
}

/** 写路径：向当前激活会话发送消息（bridge 经 UIA 注入 VS Code） */
export function sendMessage(text: string) {
  const s = useDemoStore.getState();
  const id = s.activeSessionId;
  if (!id || s.sending || ws?.readyState !== WebSocket.OPEN) return;
  useDemoStore.setState({ sending: true, error: null });
  ws.send(JSON.stringify({ type: 'send_message', sessionId: id, text }));
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
