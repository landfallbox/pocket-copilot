/**
 * 主题 token 源：读取 VS Code 活动主题 JSON，产出前端复刻 Copilot 面板所需的色值。
 *
 * 背景：Copilot 聊天面板的视觉 = 通用色（活动主题 JSON，随 workbench.colorTheme
 * 变化）+ 17 个 chat.* 专属 token。chat.* 的默认值来自 workbench 内置
 * registerColor（其中紫气泡等引用 editor.selectionBackground 等基础 token，随
 * 主题间接变化）；但主题 JSON 也可显式定义 chat.* 覆盖默认（实测 Dark 2026
 * 主题定义了 chat.requestBubbleBackground=#ffffff13 等）。优先级：
 * 主题 JSON 显式定义 > workbench 内置默认。本模块把两者解析成前端可直接
 * 消费的 hex 色值。
 *
 * 设计原则：
 * - 独立只读数据源，可失败降级（文件缺失/格式变化返回 null，前端回退内置默认）。
 * - 主题 JSON 支持 "include" 继承链（如 2026-dark include dark_modern），递归合并。
 * - 60s 内存缓存（按 settings mtime 失效），避免每次请求重读磁盘。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { THEME_DEFAULTS_DIR } from './config.js';

// ============================================================================
// = 主题文件解析                                                              =
// ============================================================================

/** 内置主题注册表：label → 主题文件名（来自 theme-defaults/package.json，稳定） */
const THEME_FILES: Record<string, string> = {
  'Dark 2026': '2026-dark.json',
  'Light 2026': '2026-light.json',
  'Dark+': 'dark_plus.json',
  'Light+': 'light_plus.json',
  'Dark Modern': 'dark_modern.json',
  'Light Modern': 'light_modern.json',
  'Visual Studio Dark': 'dark_vs.json',
  'Visual Studio Light': 'light_vs.json',
  'Default High Contrast': 'hc_black.json',
  'Default High Contrast Light': 'hc_light.json',
};

/** 未设置 workbench.colorTheme 时的内置默认（VS Code 1.134+ 默认 Dark 2026） */
const DEFAULT_THEME = 'Dark 2026';

interface ThemeJson {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown[];
}

/** 解析主题 JSON（含 include 继承链），返回合并后的 colors + tokenColors */
async function loadTheme(file: string): Promise<{
  colors: Record<string, string>;
  tokenColors: unknown[];
  type?: string;
}> {
  const seen = new Set<string>();
  const walk = async (
    f: string,
  ): Promise<{ colors: Record<string, string>; tokenColors: unknown[]; type?: string }> => {
    if (seen.has(f)) return { colors: {}, tokenColors: [] };
    seen.add(f);
    let theme: ThemeJson;
    try {
      theme = JSON.parse(
        await fsp.readFile(path.join(THEME_DEFAULTS_DIR, 'themes', f), 'utf8'),
      ) as ThemeJson;
    } catch {
      return { colors: {}, tokenColors: [] }; // 文件缺失：降级
    }
    // include 先合并，当前层覆盖
    const base = theme.include
      ? await walk(path.basename(theme.include))
      : { colors: {}, tokenColors: [] as unknown[] };
    const colors = { ...base.colors, ...(theme.colors ?? {}) };
    const tokenColors = theme.tokenColors ?? base.tokenColors;
    return { colors, tokenColors, type: theme.type ?? base.type };
  };
  return walk(file);
}

// ============================================================================
// = chat.* token 默认值（workbench 内置 registerColor 提取）                  =
// ============================================================================

/** 解析 "#RRGGBB" / "#RRGGBBAA" → [r,g,b,a] */
function parseHex(hex: string): [number, number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!m) return null;
  const n = (s: string) => parseInt(s, 16);
  return [n(m[1].slice(0, 2)), n(m[1].slice(2, 4)), n(m[1].slice(4, 6)), m[2] ? n(m[2]) : 255];
}

/** 基础色 + 不透明度（0-1）→ #RRGGBBAA（workbench pi(base, opacity) 语义） */
function withOpacity(base: string, opacity: number): string | null {
  const c = parseHex(base);
  if (!c) return null;
  const a = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0');
  return (
    '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('') + a
  );
}

/**
 * chat.* token 默认值表（dark/light 分支，来自 workbench.desktop.main.js 的
 * registerColor 定义；引用基础 token 的已在此解析为对 colors 的引用表达式）。
 * 值为 null 表示该模式下无默认（前端回退透明/继承）。
 */
type ChatTokenSpec = {
  dark: string | null;
  light: string | null;
};
const CHAT_TOKENS: Record<string, ChatTokenSpec> = {
  'chat.requestBorder': { dark: '#FFFFFF1A', light: '#0000001A' },
  'chat.slashCommandBackground': { dark: '#26477866', light: '#ADCEFF7A' },
  'chat.slashCommandForeground': { dark: '#85B6FF', light: '#26569E' },
  'chat.avatarBackground': { dark: '#1F1F1F', light: '#F2F2F2' },
  'chat.editedFileForeground': { dark: '#E2C08D', light: '#895503' },
  'chat.requestCodeBorder': { dark: '#004972B8', light: '#0E639C40' },
  'chat.checkpointSeparator': { dark: '#585858', light: '#A9A9A9' },
  'chat.linesAddedForeground': { dark: '#54B054', light: '#107C10' },
  'chat.linesRemovedForeground': { dark: '#FC6A6A', light: '#BC2F32' },
  'chat.thinkingShimmer': { dark: '#FFFFFF', light: '#000000' },
};

/** 需引用基础 token 解析的 chat token（name → 解析函数） */
const CHAT_TOKEN_RESOLVERS: Record<
  string,
  (dark: boolean, colors: Record<string, string>) => string | null
> = {
  // 紫气泡：editor.selectionBackground 30% 透明（hover 60%）
  'chat.requestBubbleBackground': (dark, colors) =>
    withOpacity(colors['editor.selectionBackground'] ?? '', 0.3),
  'chat.requestBubbleHoverBackground': (dark, colors) =>
    withOpacity(colors['editor.selectionBackground'] ?? '', 0.6),
  // 请求底：editor.background 62% 透明
  'chat.requestBackground': (dark, colors) =>
    withOpacity(colors['editor.background'] ?? '', 0.62),
};

// ============================================================================
// = 对外 API                                                                  =
// ============================================================================

export interface ThemeInfo {
  /** 主题名（如 "Dark 2026"） */
  name: string;
  /** 界面模式：dark / light / hcDark / hcLight */
  uiTheme: 'dark' | 'light' | 'hcDark' | 'hcLight';
  /** 活动主题全部颜色（含 include 合并） */
  colors: Record<string, string>;
  /** 解析后的 chat.* token 色值（hex 或 null） */
  chat: Record<string, string | null>;
  /** 编辑器 token 色表（Monaco 代码高亮用） */
  tokenColors: unknown[];
  /** 生成时间（ms） */
  at: number;
}

let cache: { key: string; info: ThemeInfo } | null = null;
const CACHE_TTL_MS = 60 * 1000;

/** 读 settings.json 的 workbench.colorTheme（未设置返回内置默认） */
async function readActiveThemeName(settingsFile: string): Promise<string> {
  try {
    const settings = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as {
      'workbench.colorTheme'?: unknown;
    };
    if (typeof settings['workbench.colorTheme'] === 'string') {
      return settings['workbench.colorTheme'];
    }
  } catch {
    // settings 缺失/损坏：用默认主题（降级）
  }
  return DEFAULT_THEME;
}

/**
 * 组装当前活动主题信息。
 * @param settingsFile settings.json 绝对路径（server 传入，便于测试）
 * @returns 主题信息；主题文件完全不可读时返回 null（前端回退内置默认）
 */
export async function getThemeInfo(
  settingsFile: string,
): Promise<ThemeInfo | null> {
  const name = await readActiveThemeName(settingsFile);
  const file = THEME_FILES[name] ?? THEME_FILES[DEFAULT_THEME];
  const key = `${name}:${file}`;
  if (cache && cache.key === key && Date.now() - cache.info.at < CACHE_TTL_MS) {
    return cache.info;
  }

  const { colors, tokenColors, type } = await loadTheme(file);
  if (Object.keys(colors).length === 0) return null;

  // 界面模式：从主题 JSON type 推断（dark/vs-dark → dark，vs/hc-light → light 等）
  const typeStr = type ?? 'vs-dark';
  const uiTheme: ThemeInfo['uiTheme'] = typeStr.startsWith('hc')
    ? typeStr.endsWith('light')
      ? 'hcLight'
      : 'hcDark'
    : typeStr === 'vs'
      ? 'light'
      : 'dark';
  const dark = uiTheme === 'dark' || uiTheme === 'hcDark';

  // 优先级：主题 JSON 显式定义 > workbench 内置默认（含基础 token 解析）
  const chat: Record<string, string | null> = {};
  for (const [token, spec] of Object.entries(CHAT_TOKENS)) {
    chat[token] = dark ? spec.dark : spec.light;
  }
  for (const [token, resolve] of Object.entries(CHAT_TOKEN_RESOLVERS)) {
    chat[token] = resolve(dark, colors);
  }
  for (const [key, value] of Object.entries(colors)) {
    if (key.startsWith('chat.')) chat[key] = value;
  }

  const info: ThemeInfo = {
    name,
    uiTheme,
    colors,
    chat,
    tokenColors,
    at: Date.now(),
  };
  cache = { key, info };
  return info;
}
