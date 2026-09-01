import tailwindcssAnimate from 'tailwindcss-animate';

/**
 * 颜色全部映射到 --vscode-* CSS 变量（运行时由 /api/theme 注入，
 * index.css 提供内置深色兜底）。Fluent 组件与自定义元素共用同一套变量。
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'var(--vscode-border)',
        input: 'var(--vscode-input)',
        ring: 'var(--vscode-ring)',
        background: 'var(--vscode-background)',
        foreground: 'var(--vscode-foreground)',
        muted: {
          DEFAULT: 'var(--vscode-muted)',
          foreground: 'var(--vscode-muted-fg)',
        },
        card: {
          DEFAULT: 'var(--vscode-card)',
          foreground: 'var(--vscode-foreground)',
        },
        primary: {
          DEFAULT: 'var(--vscode-primary)',
          foreground: 'var(--vscode-primary-fg)',
        },
        secondary: {
          DEFAULT: 'var(--vscode-secondary)',
          foreground: 'var(--vscode-foreground)',
        },
        // 聊天面板专属（Copilot 观感核心）
        bubble: 'var(--vscode-chat-bubble)',
        bubbleHover: 'var(--vscode-chat-bubble-hover)',
        requestBg: 'var(--vscode-chat-request-bg)',
        codeBlock: 'var(--vscode-chat-code-bg)',
        link: 'var(--vscode-chat-link)',
        success: 'var(--vscode-chat-success)',
      },
      borderRadius: {
        // Copilot 圆角刻度（Fluent cornerRadius：medium 4 / large 8 / xLarge 12）
        bubble: 'var(--vscode-radius-xl)',
        md: 'var(--vscode-radius-lg)',
      },
      fontFamily: {
        sans: 'var(--vscode-font-family)',
        mono: 'var(--vscode-font-mono)',
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
