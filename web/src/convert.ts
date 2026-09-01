import type { RequestState } from './store';

// ============================================================================
// = 消息模型（脱离 assistant-ui，前端自定义）                                 =
// ============================================================================

/** 助手消息内的一个片段：文本 / 思考 / 工具调用 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; label: string };

export type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; parts: Part[]; done: boolean };

/** 把一个请求（items 时间线）转成 user + assistant 消息 */
export function requestToMessages(r: RequestState): Message[] {
  const out: Message[] = [];
  if (r.userText) {
    out.push({ id: `${r.requestId}-user`, role: 'user', text: r.userText });
  }

  const parts: Part[] = [];
  for (const it of r.items) {
    if (it.type === 'thinking') {
      // replay 路径后端 items 用 text，流式 chunk 用 delta，两者兼容
      const body = it.text ?? it.delta;
      if (body) parts.push({ type: 'reasoning', text: body });
    } else if (it.type === 'text' && it.text) {
      parts.push({ type: 'text', text: it.text });
    } else if (it.type === 'tool_call' && it.tool) {
      parts.push({
        type: 'tool-call',
        toolCallId: it.tool.toolCallId ?? `${r.requestId}-t${parts.length}`,
        toolName: it.tool.toolId ?? 'tool',
        label: it.tool.pastTenseMessage || it.tool.message || it.tool.toolId || 'tool',
      });
    } else if (it.type === 'question' && it.question) {
      const q = it.question;
      parts.push({
        type: 'text',
        text: `**问题** ${q.title ?? ''}\n${q.message ?? ''}${q.options?.length ? '\n选项：' + q.options.join(' / ') : ''}`,
      });
    } else if (it.type === 'edit' && it.edit) {
      // 编辑文件也作为工具调用折叠进 "Finished with x steps"（对齐 Copilot 行为）
      parts.push({
        type: 'tool-call',
        toolCallId: `${r.requestId}-edit${parts.length}`,
        toolName: 'edit',
        label: `编辑文件：${it.edit.fsPath ?? '?'}`,
      });
    }
    // status 项：耗时/token 不单独渲染
  }

  if (parts.length > 0) {
    out.push({ id: `${r.requestId}-asst`, role: 'assistant', parts, done: r.done });
  }
  return out;
}

export function sessionToMessages(
  order: string[],
  requests: Map<string, RequestState>,
): Message[] {
  const out: Message[] = [];
  for (const rid of order) {
    const r = requests.get(rid);
    if (r) out.push(...requestToMessages(r));
  }
  return out;
}
