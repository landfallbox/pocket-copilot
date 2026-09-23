// ============================================================================
// = 简化手机协议（daemon ↔ Android / PWA 瘦客户端）                            =
// JSON over WebSocket，单连接双向。AHP 复杂度由 daemon 消化，对手机呈现为       =
// 会话列表 + 焦点会话的视图快照（节流推送，带单调版本号）。                     =
// 原始 AHP token 不出电脑；手机只持 deviceToken（QR 配对下发）。               =
// ============================================================================

/** 助手消息内的一个片段：文本 / 思考 / 工具调用 */
export type Part =
  | { k: 'text'; text: string }
  | { k: 'reasoning'; text: string }
  | { k: 'tool'; name: string; label: string; status: string };

/** 展示消息（由 AHP ChatState 转换而来） */
export type PhoneMessage =
  | { id: string; role: 'user'; text: string; queued?: boolean }
  | { id: string; role: 'assistant'; parts: Part[]; done: boolean };

/** 焦点会话的视图快照（daemon 节流推送，手机零 diff 逻辑） */
export interface ChatView {
  /** 是否有进行中的 turn（流式输出中） */
  streaming: boolean;
  /** 消息列表（历史 turns + 进行中的 activeTurn + 排队消息） */
  messages: PhoneMessage[];
  /** 排队中等待宿主消费的消息（发送后立即回显，当前 turn 结束后自动发出） */
  pending: { id: string; text: string }[];
}

/** 会话摘要（供手机会话列表渲染） */
export interface PhoneSession {
  /** 会话 URI（ahp-session:/<uuid>） */
  id: string;
  title: string;
  /** running / idle / ...（AHP SessionStatus） */
  status: string;
  /** 当前活动描述（AHP activity，可能为空） */
  activity: string | null;
  modifiedAt: string;
  /** 项目名（AHP project.name，可能为空） */
  project: string | null;
}

// ---------------------------------------------------------------------------
// = 手机 → daemon（命令）                                                    =
// ---------------------------------------------------------------------------

/** 连接后首条：鉴权（deviceToken 由 QR 配对下发） */
export interface HelloMsg {
  t: 'hello';
  device: string;
}

/** 切换焦点会话（daemon 据此切换 AHP 订阅） */
export interface SelectMsg {
  t: 'select';
  id: string;
}

/** 发送文字消息（排队语义，与 Agents 窗口一致） */
export interface SendMsg {
  t: 'send';
  text: string;
}

export type PhoneCommand = HelloMsg | SelectMsg | SendMsg;

// ---------------------------------------------------------------------------
// = daemon → 手机（事件）                                                    =
// ---------------------------------------------------------------------------

/** 鉴权成功后：当前会话列表 + 焦点会话 */
export interface WelcomeMsg {
  t: 'welcome';
  sessions: PhoneSession[];
  focus: string | null;
}

/** 会话列表更新 */
export interface SessionsMsg {
  t: 'sessions';
  items: PhoneSession[];
}

/** 焦点会话视图快照（节流 100ms + 单调版本号，手机忽略过期版本） */
export interface ChatMsg {
  t: 'chat';
  /** 会话 URI */
  id: string;
  /** 单调递增版本号 */
  v: number;
  view: ChatView;
}

/** agent host 连接状态 */
export interface HostMsg {
  t: 'host';
  ok: boolean;
}

/** 错误提示 */
export interface ErrorMsg {
  t: 'error';
  msg: string;
}

export type DaemonEvent = WelcomeMsg | SessionsMsg | ChatMsg | HostMsg | ErrorMsg;
