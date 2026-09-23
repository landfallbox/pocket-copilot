// ============================================================================
// = ChatState → 手机视图快照（web/src/convert.ts 移植）                        =
// 输入 AHP ChatState（官方 chatReducer 维护），输出简化协议的 ChatView。        =
// ============================================================================

import type {
  ActiveTurn,
  ChatState,
  ResponsePart,
  StringOrMarkdown,
  ToolCallState,
  Turn,
} from '@microsoft/agent-host-protocol';
import type { ChatView, Part, PhoneMessage } from '../phone/protocol.js';

/** StringOrMarkdown（string | {markdown}）统一取文本 */
function toText(som: StringOrMarkdown | undefined): string {
  if (!som) return '';
  return typeof som === 'string' ? som : som.markdown;
}

/** 工具调用的展示文案（按生命周期状态取对应字段） */
function toolLabel(tc: ToolCallState): string {
  switch (tc.status) {
    case 'completed':
      return toText(tc.pastTenseMessage) || tc.displayName || tc.toolName;
    case 'cancelled':
      return `${tc.displayName || tc.toolName}（已取消）`;
    case 'pending-confirmation':
      return (
        toText(tc.confirmationTitle) ||
        toText(tc.invocationMessage) ||
        tc.displayName ||
        tc.toolName
      );
    case 'auth-required':
      return `${toText(tc.invocationMessage) || tc.displayName || tc.toolName}（需要认证）`;
    default:
      // streaming / running / pending-result-confirmation
      return toText(tc.invocationMessage) || tc.displayName || tc.toolName;
  }
}

function responsePartsToParts(parts: ResponsePart[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    if (p.kind === 'markdown') {
      if (p.content) out.push({ k: 'text', text: p.content });
    } else if (p.kind === 'reasoning') {
      if (p.content) out.push({ k: 'reasoning', text: p.content });
    } else if (p.kind === 'toolCall') {
      out.push({
        k: 'tool',
        name: p.toolCall.toolName,
        label: toolLabel(p.toolCall),
        status: p.toolCall.status,
      });
    } else if (p.kind === 'inputRequest') {
      const req = p.request;
      const lines: string[] = [];
      if (req.message) lines.push(req.message);
      for (const q of req.questions ?? []) {
        lines.push(`**问题** ${q.title ?? ''}\n${q.message}`);
      }
      if (lines.length) out.push({ k: 'text', text: lines.join('\n') });
    } else if (p.kind === 'error') {
      out.push({
        k: 'text',
        text: `**错误** ${p.error.message || p.error.errorType || '未知错误'}`,
      });
    } else if (p.kind === 'systemNotification') {
      const t = toText(p.content);
      if (t) out.push({ k: 'text', text: t });
    }
    // contentRef：大内容引用，暂不渲染
  }
  return out;
}

function turnToMessages(turn: Turn): PhoneMessage[] {
  const out: PhoneMessage[] = [];
  if (turn.message.origin.kind === 'user') {
    out.push({ id: `${turn.id}-user`, role: 'user', text: turn.message.text });
  }
  const parts = responsePartsToParts(turn.responseParts);
  if (parts.length > 0) {
    out.push({ id: `${turn.id}-asst`, role: 'assistant', parts, done: true });
  }
  return out;
}

function activeTurnToMessages(t: ActiveTurn): PhoneMessage[] {
  const out: PhoneMessage[] = [];
  if (t.message.origin.kind === 'user') {
    out.push({ id: `${t.id}-user`, role: 'user', text: t.message.text });
  }
  const parts = responsePartsToParts(t.responseParts);
  if (parts.length > 0) {
    out.push({ id: `${t.id}-asst`, role: 'assistant', parts, done: false });
  }
  return out;
}

/** 把 AHP ChatState（历史 turns + 进行中的 activeTurn + 排队消息）转成视图快照 */
export function chatToView(chat: ChatState): ChatView {
  const messages: PhoneMessage[] = [];
  for (const turn of chat.turns) messages.push(...turnToMessages(turn));
  if (chat.activeTurn) messages.push(...activeTurnToMessages(chat.activeTurn));

  const pending: { id: string; text: string }[] = [];
  // steering / queued 消息：发送后立即回显，等宿主消费（当前 turn 结束后自动发出）
  if (chat.steeringMessage) {
    const m = chat.steeringMessage.message;
    if (m.origin.kind === 'user') {
      pending.push({ id: chat.steeringMessage.id, text: m.text });
      messages.push({ id: `steer-${chat.steeringMessage.id}`, role: 'user', text: m.text, queued: true });
    }
  }
  for (const q of chat.queuedMessages ?? []) {
    if (q.message.origin.kind === 'user') {
      pending.push({ id: q.id, text: q.message.text });
      messages.push({ id: `queued-${q.id}`, role: 'user', text: q.message.text, queued: true });
    }
  }

  return { streaming: chat.activeTurn !== undefined, messages, pending };
}
