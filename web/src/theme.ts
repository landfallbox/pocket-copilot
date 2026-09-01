/**
 * 前端主题注入：拉取 bridge /api/theme，把 VS Code 主题色写入 :root 的 --vscode-*
 * CSS 变量，供 Tailwind / 自定义样式 / 代码高亮消费。
 *
 * 降级：fetch 失败时不注入，index.css 提供内置深色兜底变量（Dark 2026 值），
 * 保证 bridge 不可达时页面仍有可读的深色外观。
 */

/** 与 bridge src/theme.ts 的 ThemeInfo 同构（只声明前端用到的字段） */
export interface ThemeInfo {
  name: string;
  uiTheme: 'dark' | 'light' | 'hcDark' | 'hcLight';
  colors: Record<string, string>;
  chat: Record<string, string | null>;
  tokenColors: Array<{
    scope: string | string[];
    settings: {
      foreground?: string;
      background?: string;
      fontStyle?: string;
    };
  }>;
  at: number;
}

/**
 * 主题 token 名 → 合法 CSS 自定义属性名（原始 token 变量，带 `tk` 命名空间）。
 * 两处转换：
 * - `.` → `-`：CSS 自定义属性名（<dashident>）不能含 `.`，否则 setProperty
 *   静默失败、派生变量引用落空（与 VS Code 生成 `--vscode-editor-background` 一致）。
 * - 前缀 `--vscode-tk-`：与 index.css 的派生语义变量（`--vscode-background` 等）
 *   区分命名空间，避免顶层 token（如 `foreground`）与派生变量同名导致自引用。
 */
const toCssVar = (token: string) => `--vscode-tk-${token.replace(/\./g, '-')}`;

/** 把主题色写入 :root 的 --vscode-* 变量（通用色 + chat 专属色） */
export function applyTheme(info: ThemeInfo): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(info.colors)) {
    root.style.setProperty(toCssVar(key), value);
  }
  for (const [key, value] of Object.entries(info.chat)) {
    if (value) root.style.setProperty(toCssVar(key), value);
  }
  root.dataset.theme = info.uiTheme;
}

/** 拉取活动主题；失败返回 null（调用方降级） */
export async function fetchTheme(): Promise<ThemeInfo | null> {
  try {
    const res = await fetch('/api/theme');
    if (!res.ok) return null;
    return (await res.json()) as ThemeInfo;
  } catch {
    return null;
  }
}
