import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发：5173 出页面 + 代理 /api、WS 到 bridge :8765（同源，手机/浏览器无跨域）。
// 生产：vite build → web/dist，由 bridge 同端口 8765 托管（见 REQUIREMENTS §11）。
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
