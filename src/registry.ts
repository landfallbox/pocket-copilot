/**
 * Registry：单一状态源（新架构核心，2026-08-31 重构）。
 *
 * 合并了旧 Normalizer（会话/请求状态 + 事件发射）与 Aligner（内容累积 + 归属）
 * 的职责。两个数据源各管一摊，互不对齐：
 *
 * - `onJsonl`（VS Code chatSessions）：读会话头（kind=0）登记"有哪些会话、
 *   createdAt / model"，并消费 kind=1 的 selectedModel 更新（会话中切换模型时
 *   覆盖会话头快照，拿到当前真实模型）。jsonl 请求定义（kind=2）与 result 不再消费。
 * - `onHeimdall`（heimdall requests）：唯一的请求 + 内容源。request_start 建/续
 *   turn，chunk 累积内容，request_end 收尾。
 *
 * 一个 turn（用户轮次）= 一条用户请求 + 其助手响应。响应可能跨多次模型调用
 * （agent 循环：调用→工具→再调用…），按 (sessionId, userText, 时间连续) 归并到
 * 同一 turn。turn 直接由 heimdall 驱动，不依赖 jsonl，故无 provisional / 迁移。
 */
import type {
  BridgeEvent,
  HeimdallRecord,
  Item,
  RawRecord,
  RequestState,
  SelectedModelUpdate,
  SessionFullState,
  SessionHeader,
  SessionSummary,
} from './types.js';
import { parseSessionInfo } from './session-info.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HEIMDALL_REQUESTS_DIR } from './config.js';

// ============================================================
// 常量
// ============================================================

/** 同 userText 的两次模型调用间隔超过该值视为新轮次（用户重发相同问题） */
const TURN_GAP_MS = 30 * 1000;
/** done 的 turn 保留时长（超时清理，防内存无限增长） */
const TURN_SWEEP_MS = 10 * 60 * 1000;

// ============================================================
// 状态结构
// ============================================================

/** 一个用户轮次（跨多次模型调用累积内容） */
interface TurnState {
  /** 该 turn 首个 heimdall requestId（稳定键，作前端 requestId） */
  turnId: string;
  sessionId: string;
  userText: string;
  ts: number;
  items: Item[];
  done: boolean;
  promptTokens?: number;
  completionTokens?: number;
  elapsedMs?: number;
  /** 跨多次调用的内容累积（按到达顺序，保持思考/文本交织） */
  segments: Array<{ kind: 'text' | 'reasoning'; content: string }>;
  /** 本次模型调用是否出现 tool_call（end 时据此判定 turn 是否收尾） */
  sawToolCall: boolean;
  /** 最近一次该 turn 的活动时间（轮次连续性判定 + 清理） */
  lastActivity: number;
}

interface SessionState {
  sessionId: string;
  createdAt: number;
  /** 模型名回退值（jsonl metadata.name 或 heimdall model） */
  model?: string;
  /** 模型 identifier（vendor/provider/modelId，用于查注册表权威名） */
  modelIdentifier?: string;
  /** Agent 模式（jsonl inputState.mode.kind，如 "agent"） */
  mode?: string;
  /** 思考程度（reasoningEffort：low/medium/xhigh） */
  thinkingLevel?: string;
  project?: string;
  lastActivity: number;
  announced: boolean;
  turns: Map<string, TurnState>;
  order: string[];
  /** 当前活跃 turn 指针（同轮次后续模型调用复用） */
  lastActiveTurnId?: string;
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 从 heimdall `lastUserText`（VS Code 发给模型的完整 prompt）提取 `<userRequest>`
 * 标签内的纯用户输入。真实输入总在 prompt 末尾；`<context>` 里可能回显含
 * `<userRequest>` 字面量的历史命令（且回显的标签可能无闭合）。
 *
 * 策略：定位最后一个 `<userRequest>` 开标签，取其到最近 `</userRequest>`（或字符串末尾）的内容。
 * 不用正则全局配对——回显中的未闭合 `<userRequest>` 会与真实标签的 `</userRequest>` 错误配对。
 */
function extractUserRequest(lastUserText: string): string {
  const lastOpen = lastUserText.lastIndexOf('<userRequest>');
  if (lastOpen === -1) return lastUserText;
  const afterOpen = lastOpen + '<userRequest>'.length;
  const lastClose = lastUserText.lastIndexOf('</userRequest>');
  const end = lastClose > afterOpen ? lastClose : lastUserText.length;
  return lastUserText.substring(afterOpen, end).trim();
}

/** 判断文本是否含实质内容（模型偶尔误发纯标点推理碎片，需过滤） */
function hasSubstance(text: string): boolean {
  return /[0-9A-Za-z\u4e00-\u9fff]/.test(text);
}

/** 解析 tool_call chunk 的 content（JSON 字符串，如 {"name":"readFile"}） */
function parseToolCall(content: string): { name?: string } {
  try {
    const obj = JSON.parse(content) as { name?: unknown };
    return { name: typeof obj.name === 'string' ? obj.name : undefined };
  } catch {
    return { name: content || undefined };
  }
}

// ============================================================
// Registry
// ============================================================

export class Registry {
  private sessions = new Map<string, SessionState>();
  /** heimdall requestId → 归属 (sessionId, turnId)，chunk/end 路由用 */
  private calls = new Map<string, { sessionId: string; turnId: string }>();
  private emit: (e: BridgeEvent) => void;
  private sweepTimer?: NodeJS.Timeout;
  /** 会话标题查询（来自 state.vscdb，server 注入；未注入时返回 undefined） */
  private titleOf?: (sessionId: string) => string | undefined;
  /** 模型权威名查询（来自 chatLanguageModels.json，server 注入） */
  private modelOf?: (identifier: string) => string | undefined;

  constructor(emit: (e: BridgeEvent) => void) {
    this.emit = emit;
  }

  /** 注入会话标题查询（server 持有 SessionTitleStore 后调用） */
  setTitleProvider(fn: (sessionId: string) => string | undefined): void {
    this.titleOf = fn;
  }

  /** 注入模型权威名查询（server 持有 ModelNameStore 后调用） */
  setModelProvider(fn: (identifier: string) => string | undefined): void {
    this.modelOf = fn;
  }

  /** 解析会话显示模型名：注册表权威名优先，回退缓存名 */
  private resolveModel(s: SessionState): string | undefined {
    return (s.modelIdentifier ? this.modelOf?.(s.modelIdentifier) : undefined) ?? s.model;
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 1000);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ============================================================
  // jsonl 侧：只读会话目录
  // ============================================================

  /** 处理一条 jsonl 记录：会话头（kind=0）+ inputState 增量（kind=1），其余忽略 */
  onJsonl(sessionId: string, rec: RawRecord, mtimeMs: number): void {
    const s = this.state(sessionId);
    let changed = false;
    if (rec.kind === 0) {
      const h = rec.v as SessionHeader | undefined;
      if (h?.creationDate) s.createdAt = h.creationDate;
      const m = h?.inputState?.selectedModel;
      if (m) changed = this.applyModel(s, m) || changed;
      // 会话头快照：Agent 模式 + 思考程度（selectedModel.modelConfiguration）
      const mode = h?.inputState?.mode;
      if (mode?.kind && s.mode !== mode.kind) {
        s.mode = mode.kind;
        changed = true;
      }
      const effort = m?.modelConfiguration?.reasoningEffort;
      if (effort && s.thinkingLevel !== effort) {
        s.thinkingLevel = effort;
        changed = true;
      }
    } else if (rec.kind === 1) {
      // 会话中切换：selectedModel / mode / modelConfiguration 覆盖会话头快照
      const k = rec.k ?? [];
      if (k[0] === 'inputState' && k[1] === 'selectedModel') {
        changed = this.applyModel(s, rec.v as SelectedModelUpdate) || changed;
      } else if (k[0] === 'inputState' && k[1] === 'mode') {
        const mode = rec.v as { kind?: string } | undefined;
        if (mode?.kind && s.mode !== mode.kind) {
          s.mode = mode.kind;
          changed = true;
        }
      } else if (k[0] === 'inputState' && k[1] === 'modelConfiguration') {
        const cfg = rec.v as { reasoningEffort?: string } | undefined;
        if (cfg?.reasoningEffort && s.thinkingLevel !== cfg.reasoningEffort) {
          s.thinkingLevel = cfg.reasoningEffort;
          changed = true;
        }
      }
    } else {
      return;
    }
    // 用文件 mtime（VS Code 最后碰该会话的时间）而非 Date.now()，
    // 避免重放历史时所有会话都被标为"刚刚活跃"。
    s.lastActivity = mtimeMs;
    this.announce(s);
    // 已 announce 的会话切换模型/模式/思考程度：重推 session_list（否则前端不更新）
    if (changed && s.announced) {
      this.emit({ type: 'session_list', sessions: this.summaries() });
    }
  }

  /** 应用模型信息（缓存名 + identifier，供注册表权威名解析）；返回是否变化 */
  private applyModel(s: SessionState, m: { identifier?: string; metadata?: { name?: string } }): boolean {
    if (!m) return false;
    const name = m.metadata?.name ?? m.identifier;
    if (s.model === name && s.modelIdentifier === m.identifier) return false;
    s.model = name;
    s.modelIdentifier = m.identifier;
    return true;
  }

  /** 注入项目名（server 由会话文件路径解析 workspace.json 后调用） */
  setProject(sessionId: string, project: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.project === project) return;
    s.project = project;
    this.emit({ type: 'session_list', sessions: this.summaries() });
  }

  /** 取会话项目名（写路径按窗口标题定位 VS Code 实例用）；无则 undefined */
  getProject(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.project;
  }

  /** 文件被重写/截断时重置会话（turn 内容全来自 heimdall，jsonl 重写不影响） */
  resetSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.turns = new Map();
    s.order = [];
    s.lastActiveTurnId = undefined;
    s.announced = false;
  }

  // ============================================================
  // heimdall 侧：请求 + 内容
  // ============================================================

  onHeimdall(rec: HeimdallRecord): void {
    if (rec.type === 'request_start') this.onStart(rec);
    else if (rec.type === 'chunk') this.onChunk(rec);
    else this.onEnd(rec);
  }

  private onStart(rec: Extract<HeimdallRecord, { type: 'request_start' }>): void {
    const startTs = Date.parse(rec.time);

    // ground truth 归属：从 systemTail 解析会话 id（解析失败报错 + 丢弃）
    const sessionId = parseSessionInfo(rec.systemTail).sessionId;
    if (!sessionId) {
      const msg = `systemTail 解析失败：无法提取会话 id（requestId=${rec.requestId}）`;
      console.error('registry: ' + msg);
      this.emit({ type: 'error', message: msg, requestId: rec.requestId });
      return;
    }

    // 判别"新用户请求" vs "agent 循环后续调用"：
    // 不能用 <userRequest> 标签内容判别——agent 后续调用的 lastUserText 可能含
    // <userRequest> 标签（tool result 回显对话历史 / VS Code 重新包装），提取出的
    // 文本是垃圾（commit message 片段等），据此新建 turn 会产生幽灵 turn。
    //
    // 可靠判别：VS Code 不允许 agent 运行中发新消息（输入框禁用），所以有活跃 turn
    // （未 done + 时间连续）时，进来的调用一定是 agent 后续调用 → 归并。
    // 无活跃 turn → 新用户请求 → 新建 turn（此时 lastUserText 必含真实用户输入）。
    // 真正的非聊天流量（补全 / inline edit）无 sessionId，已被上面的检查丢弃。
    const s = this.state(sessionId);
    if (!s.model) s.model = rec.model;

    const activeTurn = this.matchTurn(s, startTs);
    if (activeTurn) {
      // agent 循环后续调用：归并到当前活跃 turn
      this.calls.set(rec.requestId, { sessionId, turnId: activeTurn.turnId });
    } else {
      // 新用户请求：创建新 turn。
      // 孤儿收尾：此时会话内若仍有敞开 turn（以 tool_call 收尾、等归而未归），
      // 它已不会再被归并——强制判 done，避免永久 Working。最坏情况（慢工具 >30s）
      // 内容归属与现状一致（进新 turn），只是完成时刻晚于真实完成时刻。
      this.forceCompleteOpenTurns(s, startTs);
      const userText = extractUserRequest(rec.lastUserText);
      const turn = this.createTurn(s, rec.requestId, userText, startTs);
      this.calls.set(rec.requestId, { sessionId, turnId: turn.turnId });
    }
  }

  /**
   * 孤儿收尾：把会话内所有未 done 的 turn 强制判 done 并 emit request_done。
   * 在 request_start 到达且 matchTurn 未命中时调用——下一个事件已证明上一个
   * agent run 结束（输入框重新可用）或本就无法归并，敞开 turn 不应无限等待。
   */
  private forceCompleteOpenTurns(s: SessionState, nowTs: number): void {
    for (const id of s.order) {
      const t = s.turns.get(id);
      if (!t || t.done) continue;
      t.done = true;
      t.elapsedMs = nowTs - t.ts;
      this.emit({
        type: 'request_done',
        sessionId: t.sessionId,
        requestId: t.turnId,
        elapsedMs: t.elapsedMs,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        items: t.items,
      });
    }
  }

  /**
   * 找当前活跃 turn：未 done + 时间连续（TURN_GAP_MS 内）。
   * 不比较 userText——agent 后续调用的 lastUserText 是 tool result，与原始 userText 不同。
   * VS Code 不允许 agent 运行中发新消息，所以活跃 turn 内的调用一定是后续调用。
   */
  private matchTurn(s: SessionState, startTs: number): TurnState | undefined {
    const id = s.lastActiveTurnId;
    if (!id) return undefined;
    const t = s.turns.get(id);
    if (!t || t.done) return undefined;
    if (startTs - t.lastActivity > TURN_GAP_MS) return undefined;
    return t;
  }

  private createTurn(s: SessionState, turnId: string, userText: string, ts: number): TurnState {
    const t: TurnState = {
      turnId,
      sessionId: s.sessionId,
      userText,
      ts,
      items: [{ type: 'user', text: userText, ts }],
      done: false,
      segments: [],
      sawToolCall: false,
      lastActivity: ts,
    };
    s.turns.set(turnId, t);
    s.order.push(turnId);
    s.lastActiveTurnId = turnId;
    s.lastActivity = ts;
    this.announce(s);
    this.emit({ type: 'user_message', sessionId: s.sessionId, requestId: turnId, text: userText, ts });
    return t;
  }

  private onChunk(rec: Extract<HeimdallRecord, { type: 'chunk' }>): void {
    const c = this.calls.get(rec.requestId);
    if (!c) return;
    const t = this.sessions.get(c.sessionId)?.turns.get(c.turnId);
    if (!t || t.done) return;
    t.lastActivity = Date.parse(rec.time);

    if (rec.kind === 'text') {
      this.appendSegment(t, 'text', rec.content);
    } else if (rec.kind === 'reasoning') {
      this.appendSegment(t, 'reasoning', rec.content);
    } else if (rec.kind === 'tool_call') {
      // 块边界：先按顺序 flush 累计的思考/文本段
      this.flushSegments(t);
      t.sawToolCall = true;
      const { name } = parseToolCall(rec.content);
      this.emit({
        type: 'chunk',
        sessionId: t.sessionId,
        requestId: t.turnId,
        kind: 'tool_call',
        tool: { message: name, pastTenseMessage: name, isComplete: true },
      });
      t.items.push({ type: 'tool_call', tool: { message: name, pastTenseMessage: name, isComplete: true } });
    }
  }

  /** 追加有序段：同类型连续 chunk 合并到末段，跨类型开新段（保持交织顺序） */
  private appendSegment(t: TurnState, kind: 'text' | 'reasoning', content: string): void {
    const last = t.segments[t.segments.length - 1];
    if (last && last.kind === kind) last.content += content;
    else t.segments.push({ kind, content });
    // text 逐 chunk 实时 emit（前端合并连续 text）；reasoning 不实时 emit（flush 时统一处理）
    if (kind === 'text') {
      this.emit({ type: 'chunk', sessionId: t.sessionId, requestId: t.turnId, kind: 'text', delta: content });
    }
  }

  private onEnd(rec: Extract<HeimdallRecord, { type: 'request_end' }>): void {
    const c = this.calls.get(rec.requestId);
    this.calls.delete(rec.requestId);
    if (!c) return;
    const s = this.sessions.get(c.sessionId);
    const t = s?.turns.get(c.turnId);
    if (!t) return;
    t.lastActivity = Date.now();

    this.flushSegments(t);
    if (rec.inputTokens != null) t.promptTokens = (t.promptTokens ?? 0) + rec.inputTokens;
    if (rec.outputTokens != null) t.completionTokens = (t.completionTokens ?? 0) + rec.outputTokens;

    // 完成判定：本次模型调用无 tool_call = agent 循环结束（模型给了最终回答）。
    // 轮次中间的一次调用（有 tool_call）不触发，turn 保留供后续调用复用。
    if (!t.sawToolCall) {
      t.done = true;
      t.elapsedMs = rec.durationMs;
      this.emit({
        type: 'request_done',
        sessionId: t.sessionId,
        requestId: t.turnId,
        elapsedMs: t.elapsedMs,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        items: t.items,
      });
    }
    // 重置本次调用标记，供同 turn 下一次模型调用
    t.sawToolCall = false;
    if (s) s.lastActivity = Date.parse(rec.time);
  }

  /** 按到达顺序 flush 累计的思考/文本段（保持交织顺序），发事件 + 入 items。silent=true 时不 emit（rebuild 路径用） */
  private flushSegments(t: TurnState, silent = false): void {
    const segs = t.segments;
    t.segments = [];
    // 预处理：模型偶尔在 text 中间穿插纯标点 reasoning 碎片（实测 ".\n"），
    // 按类型分段时它会把 text 切断，导致行内代码反引号跨段配对失败
    // （渲染成孤立 ` + 错位行内代码）。这里丢弃无实质碎片，并把被它
    // 切断的相邻 text 段合并回一段。
    const merged: Array<{ kind: 'text' | 'reasoning'; content: string }> = [];
    for (const seg of segs) {
      if (seg.kind === 'reasoning' && !hasSubstance(seg.content.trim())) continue;
      const last = merged[merged.length - 1];
      if (seg.kind === 'text' && last && last.kind === 'text') {
        last.content += seg.content;
      } else {
        merged.push(seg);
      }
    }
    for (const seg of merged) {
      const trimmed = seg.content.trim();
      if (!trimmed) continue;
      if (seg.kind === 'reasoning') {
        if (!silent && !t.done) {
          this.emit({
            type: 'chunk',
            sessionId: t.sessionId,
            requestId: t.turnId,
            kind: 'thinking',
            delta: trimmed,
          });
        }
        t.items.push({ type: 'thinking', text: trimmed, ts: Date.now() });
      } else {
        // 正文保留原始 content（不 trim）：段间空格是 markdown 结构的一部分
        // text 已在 appendSegment 里逐 chunk 实时 emit，这里只入 items（不重复 emit）
        t.items.push({ type: 'text', text: seg.content, ts: Date.now() });
      }
    }
  }

  // ============================================================
  // 查询 + 事件
  // ============================================================

  /** 所有会话的摘要（按最近活跃排序） */
  summaries(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => ({
        sessionId: s.sessionId,
        lastActivity: s.lastActivity,
        model: this.resolveModel(s),
        modelIdentifier: s.modelIdentifier,
        mode: s.mode,
        thinkingLevel: s.thinkingLevel,
        requestCount: s.order.length,
        project: s.project,
        title: this.titleOf?.(s.sessionId),
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /**
   * 会话完整状态（replay 用）。
   * 内存有 turns（活跃会话）→ 直接用；内存无 turns（已被 sweep）→ 从 heimdall 文件重建。
   */
  async fullState(sessionId: string): Promise<SessionFullState | undefined> {
    const s = this.sessions.get(sessionId);
    if (!s) return undefined;

    let requests: RequestState[] = [];
    if (s.order.length > 0) {
      requests = s.order
        .map((id) => s.turns.get(id))
        .filter((t): t is TurnState => Boolean(t))
        .map((t) => ({
          requestId: t.turnId,
          ts: t.ts,
          userText: t.userText,
          items: t.items,
          done: t.done,
          promptTokens: t.promptTokens,
          completionTokens: t.completionTokens,
        }));
    }
    if (requests.length === 0) {
      requests = await this.rebuildFromFiles(sessionId);
    }

    return {
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      model: this.resolveModel(s),
      mode: s.mode,
      thinkingLevel: s.thinkingLevel,
      lastActivity: s.lastActivity,
      title: this.titleOf?.(s.sessionId),
      requests,
    };
  }

  /**
   * 从 heimdall 文件重建指定会话的 turns（replay 按需重建，内存无数据时的回退路径）。
   * 复用与 onHeimdall 相同的聚合逻辑（matchTurn / appendSegment / flushSegments），
   * 但不 emit 事件、用记录时间戳替代 Date.now()。
   */
  private async rebuildFromFiles(sessionId: string): Promise<RequestState[]> {
    let files: string[] = [];
    try {
      const entries = await fsp.readdir(HEIMDALL_REQUESTS_DIR, { withFileTypes: true });
      files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(HEIMDALL_REQUESTS_DIR, e.name));
    } catch {
      return [];
    }

    const turns = new Map<string, TurnState>();
    const order: string[] = [];
    const calls = new Map<string, string>();
    let lastActiveTurnId: string | undefined;

    for (const file of files) {
      let content: string;
      try { content = await fsp.readFile(file, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let rec: HeimdallRecord;
        try { rec = JSON.parse(line) as HeimdallRecord; } catch { continue; }
        if (rec.version !== 1) continue;

        if (rec.type === 'request_start') {
          if (!('systemTail' in rec)) continue;
          const info = parseSessionInfo(rec.systemTail);
          if (info.sessionId !== sessionId) continue;
          const startTs = Date.parse(rec.time);

          // 与 onStart 相同逻辑：有活跃 turn（未 done + 时间连续）→ 归并（agent 后续调用）
          // 无活跃 turn → 新建（新用户请求）
          let turn: TurnState | undefined;
          if (lastActiveTurnId) {
            const last = turns.get(lastActiveTurnId);
            if (last && !last.done && startTs - last.lastActivity < TURN_GAP_MS) {
              turn = last;
            }
          }
          if (!turn) {
            // 孤儿收尾（与实时路径 onStart 一致）：此前敞开 turn 不会再被归并，判 done
            for (const t of turns.values()) if (!t.done) t.done = true;
            const userText = extractUserRequest(rec.lastUserText);
            turn = {
              turnId: rec.requestId,
              sessionId,
              userText,
              ts: startTs,
              items: [{ type: 'user', text: userText, ts: startTs }],
              done: false,
              segments: [],
              sawToolCall: false,
              lastActivity: startTs,
            };
            turns.set(turn.turnId, turn);
            order.push(turn.turnId);
          }
          lastActiveTurnId = turn.turnId;
          calls.set(rec.requestId, turn.turnId);
        } else if (rec.type === 'chunk') {
          const turnId = calls.get(rec.requestId);
          if (!turnId) continue;
          const t = turns.get(turnId);
          if (!t || t.done) continue;
          t.lastActivity = Date.parse(rec.time);
          if (rec.kind === 'text' || rec.kind === 'reasoning') {
            const last = t.segments[t.segments.length - 1];
            if (last && last.kind === rec.kind) last.content += rec.content;
            else t.segments.push({ kind: rec.kind, content: rec.content });
          } else if (rec.kind === 'tool_call') {
            this.flushSegments(t, true);
            t.sawToolCall = true;
            const { name } = parseToolCall(rec.content);
            t.items.push({ type: 'tool_call', tool: { message: name, pastTenseMessage: name, isComplete: true } });
          }
        } else if (rec.type === 'request_end') {
          const turnId = calls.get(rec.requestId);
          calls.delete(rec.requestId);
          if (!turnId) continue;
          const t = turns.get(turnId);
          if (!t) continue;
          t.lastActivity = Date.parse(rec.time);
          this.flushSegments(t, true);
          if (rec.inputTokens != null) t.promptTokens = (t.promptTokens ?? 0) + rec.inputTokens;
          if (rec.outputTokens != null) t.completionTokens = (t.completionTokens ?? 0) + rec.outputTokens;
          if (!t.sawToolCall) {
            t.done = true;
            t.elapsedMs = rec.durationMs;
          }
          t.sawToolCall = false;
        }
      }
    }

    return order.map((id) => {
      const t = turns.get(id)!;
      return {
        requestId: t.turnId,
        ts: t.ts,
        userText: t.userText,
        items: t.items,
        done: t.done,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
      };
    });
  }

  /** 所有会话中最近的活动时间戳（记录源健康判定用） */
  lastActivity(): number {
    let max = 0;
    for (const s of this.sessions.values()) {
      if (s.lastActivity > max) max = s.lastActivity;
    }
    return max;
  }

  /** 清理 done 且超时的 turn */
  private sweep(): void {
    for (const s of this.sessions.values()) {
      for (const id of [...s.order]) {
        const t = s.turns.get(id);
        if (!t) continue;
        if (t.done && Date.now() - t.lastActivity > TURN_SWEEP_MS) {
          s.turns.delete(id);
          const i = s.order.indexOf(id);
          if (i >= 0) s.order.splice(i, 1);
          if (s.lastActiveTurnId === id) s.lastActiveTurnId = undefined;
        }
      }
    }
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        createdAt: Date.now(),
        lastActivity: 0, // 由 onJsonl(mtime) / onEnd(rec.time) 设真实值
        announced: false,
        turns: new Map(),
        order: [],
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private announce(s: SessionState): void {
    if (s.announced) return;
    s.announced = true;
    this.emit({
      type: 'session',
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      model: this.resolveModel(s),
      mode: s.mode,
      thinkingLevel: s.thinkingLevel,
      project: s.project,
    });
    this.emit({ type: 'session_list', sessions: this.summaries() });
  }
}
