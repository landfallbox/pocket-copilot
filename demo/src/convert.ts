import type { ThreadMessageLike } from '@assistant-ui/react';
import type { RequestState } from './store';

/** 把一个请求（items 时间线）转成 assistant-ui 的 user + assistant 消息 */
export function requestToMessages(r: RequestState): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];
  if (r.userText) {
    out.push({ id: `${r.requestId}-user`, role: 'user', content: r.userText });
  }

  const parts: any[] = [];
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
        args: { message: it.tool.message ?? '' },
        argsText: it.tool.message ?? '',
      });
    } else if (it.type === 'question' && it.question) {
      const q = it.question;
      parts.push({
        type: 'text',
        text: `**问题** ${q.title ?? ''}\n${q.message ?? ''}${q.options?.length ? '\n选项：' + q.options.join(' / ') : ''}`,
      });
    } else if (it.type === 'edit' && it.edit) {
      // 编辑文件也作为工具调用折叠进 "Finished with x steps"（对齐 Copilot 行为）
      const label = `编辑文件：${it.edit.fsPath ?? '?'}`;
      parts.push({
        type: 'tool-call',
        toolCallId: `${r.requestId}-edit${parts.length}`,
        toolName: 'edit',
        args: { message: label },
        argsText: label,
      });
    }
    // status 项：耗时/token 由 assistant 消息状态体现，不单独渲染
  }

  if (parts.length > 0) {
    out.push({
      id: `${r.requestId}-asst`,
      role: 'assistant',
      content: parts,
      status: r.done ? { type: 'complete' } : { type: 'running' },
    });
  }
  return out;
}

export function sessionToMessages(order: string[], requests: Map<string, RequestState>): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];
  for (const rid of order) {
    const r = requests.get(rid);
    if (r) out.push(...requestToMessages(r));
  }
  return out;
}
