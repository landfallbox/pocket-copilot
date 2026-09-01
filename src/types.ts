/**
 * 类型定义（新架构，2026-08-31 重构）。
 *
 * 数据源职责：
 * - VS Code `chatSessions/*.jsonl`：只当"会话目录"——哪些项目、哪些会话、
 *   createdAt / model。不从中读取任何请求内容。
 * - heimdall `requests/*.jsonl`：唯一的请求 + 内容源——用户请求、思维链、
 *   工具调用、正文、token 数全从它来。
 *
 * 一个"用户轮次"（turn）= 一条用户请求 + 其助手响应；响应可能跨多次模型调用
 * （agent 循环：调用→工具→再调用…），由 registry 按 (sessionId, userText, 连续)
 * 分组归并。turn 不依赖 jsonl，故无需 provisional / 归属迁移。
 */

// ============================================================
// VS Code 会话头（jsonl kind=0，仅取目录所需字段）
// ============================================================

/** kind=0 会话头（只读 createdAt / model，忽略其余） */
export interface SessionHeader {
  version?: number;
  creationDate?: number;
  sessionId?: string;
  inputState?: {
    selectedModel?: { identifier?: string; metadata?: { name?: string } };
  };
}

/** kind=1 k=["inputState","selectedModel"] 模型更新记录（会话中切换模型时写入，覆盖会话头快照） */
export interface SelectedModelUpdate {
  identifier?: string;
  metadata?: { name?: string };
}

/** 一行原始 jsonl 记录 */
export interface RawRecord {
  kind: number;
  k?: string[];
  v?: unknown;
}

// ============================================================
// heimdall 请求/响应记录（格式 spec：heimdall docs/request-logging-format.md）
// ============================================================

/** heimdall 记录事件（每行一个 JSON） */
export type HeimdallRecord =
  | {
      version: number;
      type: 'request_start';
      time: string;
      requestId: string;
      vendor: string;
      model: string;
      format: 'chat-completions' | 'responses';
      stream: boolean;
      lastUserText: string;
      historyFingerprint: string;
      systemFingerprint: string;
      /** 系统提示词末尾原文（heimdall 通用 raw 字段，bridge 自行解析 VS Code 特定内容） */
      systemTail: string;
      toolNames: string[];
      messageCount: number;
    }
  | {
      version: number;
      type: 'chunk';
      time: string;
      requestId: string;
      seq: number;
      kind: 'text' | 'reasoning' | 'tool_call';
      content: string;
    }
  | {
      version: number;
      type: 'request_end';
      time: string;
      requestId: string;
      vendor: string;
      model: string;
      format: 'chat-completions' | 'responses';
      stream: boolean;
      durationMs: number;
      status: 'ok' | 'error';
      usageKnown: boolean;
      inputTokens: number | null;
      cachedInputTokens: number | null;
      outputTokens: number | null;
      reasoningTokens: number | null;
      totalTokens: number | null;
    };

/** 记录源健康状态（暴露给前端，区分"模型没输出"与"链路断了"） */
export interface RecorderHealth {
  /** 最后一条 heimdall 记录的时间戳（ms），从未有记录时为 0 */
  lastRecordAt: number;
  /** 最后一条记录的文件名（YYYY-MM.jsonl） */
  lastFile?: string;
  /** 是否异常（running 会话长时间无新记录 / 全局长时间零记录） */
  stale: boolean;
}

// ============================================================
// 前端协议（服务端 → 手机）
// ============================================================

/** 单个 item（与前端 items 数组同构） */
export interface Item {
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'question' | 'edit' | 'status';
  /** text 类型的 markdown 正文 */
  text?: string;
  ts?: number;
  id?: string;
  delta?: string;
  tool?: {
    toolId?: string;
    toolCallId?: string;
    message?: string;
    pastTenseMessage?: string;
    isComplete?: boolean;
  };
  question?: {
    title?: string;
    message?: string;
    options?: string[];
  };
  edit?: { fsPath?: string };
  elapsedMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

/** 一个用户轮次的完整状态（replay 用，与前端 RequestState 同构） */
export interface RequestState {
  requestId: string;
  ts: number;
  userText: string;
  items: Item[];
  done: boolean;
  promptTokens?: number;
  completionTokens?: number;
}

/** 会话完整状态（replay 用） */
export interface SessionFullState {
  sessionId: string;
  createdAt: number;
  model?: string;
  lastActivity: number;
  /** 会话标题（Copilot 生成，来自 state.vscdb；读不到时前端回退 sessionId 前缀） */
  title?: string;
  requests: RequestState[];
}

/** 服务端 → 手机 的规范化事件 */
export type BridgeEvent =
  | {
      type: 'hello';
      /** 当前会话（按最近活跃排序） */
      sessions: SessionSummary[];
      recorder?: RecorderHealth;
    }
  | {
      type: 'session_list';
      sessions: SessionSummary[];
      recorder?: RecorderHealth;
    }
  | {
      type: 'replay';
      sessionId: string;
      createdAt: number;
      model?: string;
      lastActivity: number;
      title?: string;
      requests: RequestState[];
    }
  | {
      type: 'session';
      sessionId: string;
      createdAt: number;
      model?: string;
      project?: string;
    }
  | {
      type: 'user_message';
      sessionId: string;
      requestId: string;
      text: string;
      ts: number;
    }
  | {
      type: 'chunk';
      sessionId: string;
      requestId: string;
      kind: 'thinking' | 'text' | 'tool_call' | 'question' | 'edit';
      /** thinking 块 id，同 id 续写；text 无 id */
      chunkId?: string;
      /** thinking/text 的增量文本 */
      delta?: string;
      /** thinking 增长快照：true 表示 delta 是该块完整快照，前端应原位替换而非追加 */
      replace?: boolean;
      /** tool_call 信息 */
      tool?: {
        toolId?: string;
        toolCallId?: string;
        message?: string;
        pastTenseMessage?: string;
        isComplete?: boolean;
      };
      /** question 信息 */
      question?: {
        title?: string;
        message?: string;
        options?: string[];
      };
      /** edit 信息 */
      edit?: { fsPath?: string };
    }
  | {
      type: 'request_done';
      sessionId: string;
      requestId: string;
      elapsedMs?: number;
      promptTokens?: number;
      completionTokens?: number;
      /** 完整时间线（思考/文本/工具按轮次交错） */
      items: Item[];
    }
  | {
      /** 写路径发送结果（send_message 的回执，仅发给发起方） */
      type: 'send_result';
      sessionId: string;
      ok: boolean;
      error?: string;
    }
  | {
      /** 解析/归属错误（如 systemTail 解析失败）：前端展示 + 后端已记日志 */
      type: 'error';
      message: string;
      requestId?: string;
    };

export interface SessionSummary {
  sessionId: string;
  lastActivity: number;
  model?: string;
  requestCount: number;
  /** 项目名（workspace.json 解析） */
  project?: string;
  /** 会话标题（Copilot 生成，来自 state.vscdb；读不到时前端回退 sessionId 前缀） */
  title?: string;
}
