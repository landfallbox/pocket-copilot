/**
 * 从 heimdall `systemTail`（system 提示词末尾原文）解析 VS Code 会话归属信息。
 *
 * VS Code 在 system 末尾注入模板变量：
 *   VSCODE_TARGET_SESSION_LOG: c:\...\workspaceStorage\<hash>\GitHub.copilot-chat\debug-logs\<sessionId>
 *
 * - `<hash>`（32 位 hex）= workspace hash，对应 workspaceStorage 目录名，
 *   可经 project-name.ts 的 projectNameMap 查项目名
 * - `<sessionId>`（UUID）= 会话 id，**等于 chatSessions 的 jsonl 文件名**
 *   （实测确认），可直接定位 bridge 正在 tail 的会话
 *
 * 职责边界：解析 VS Code 特定格式是 bridge 的职责，heimdall 只记 raw 原文。
 * 模板变量名 / 路径格式若随 VS Code 版本变化，只需改本文件。
 */

export interface SessionInfo {
  workspaceHash?: string;
  sessionId?: string;
}

/** 从 system 末尾原文提取 workspace hash 与 session id（无该变量时返回空） */
export function parseSessionInfo(systemTail: string | undefined): SessionInfo {
  if (!systemTail) return {};
  // 兼容 Windows 反斜杠与 POSIX 正斜杠路径分隔
  const m = systemTail.match(
    /VSCODE_TARGET_SESSION_LOG:\s*\S*?workspaceStorage[\\/][a-f0-9]{32}[\\/][\w.-]+[\\/]+debug-logs[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (!m) return {};
  const p = m[0];
  const ws = p.match(/workspaceStorage[\\/][a-f0-9]{32}/i);
  const sid = p.match(/debug-logs[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return {
    workspaceHash: ws ? ws[0].split(/[\\/]/)[1] : undefined,
    sessionId: sid ? sid[0].split(/[\\/]/)[1] : undefined,
  };
}
