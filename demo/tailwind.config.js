import auiPlugin from '@assistant-ui/react-ui/tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@assistant-ui/react-ui/dist/**/*.mjs',
  ],
  theme: {
    extend: {
      colors: {
        border: '#3c3c3c',
        input: '#3c3c3c',
        ring: '#4ec9b0',
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        primary: { DEFAULT: '#0e639c', foreground: '#ffffff' },
        secondary: { DEFAULT: '#2d2d30', foreground: '#d4d4d4' },
        destructive: { DEFAULT: '#f14c4c', foreground: '#ffffff' },
        muted: { DEFAULT: '#2d2d30', foreground: '#8a8a8a' },
        accent: { DEFAULT: '#264f78', foreground: '#ffffff' },
        popover: { DEFAULT: '#252526', foreground: '#d4d4d4' },
        card: { DEFAULT: '#252526', foreground: '#d4d4d4' },
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    auiPlugin({
      components: ['default-theme', 'base', 'thread', 'markdown'],
      colors: {
        border: '#3c3c3c',
        input: '#3c3c3c',
        ring: '#4ec9b0',
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        primary: { DEFAULT: '#0e639c', foreground: '#ffffff' },
        secondary: { DEFAULT: '#2d2d30', foreground: '#d4d4d4' },
        destructive: { DEFAULT: '#f14c4c', foreground: '#ffffff' },
        muted: { DEFAULT: '#2d2d30', foreground: '#8a8a8a' },
        accent: { DEFAULT: '#264f78', foreground: '#ffffff' },
        popover: { DEFAULT: '#252526', foreground: '#d4d4d4' },
        card: { DEFAULT: '#252526', foreground: '#d4d4d4' },
      },
    }),
  ],
};
