import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时前端跑 5173，接口与 WebSocket 一起反向代理到后端 8000。
// 生产构建产物由后端服务在 `/` 路径直接托管（单端口对外，无跨域）。
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // ws: true —— 网页终端的 WebSocket 也走这条代理，不需要额外配置跨域
      '/api': {
        target: backend,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // xterm.js 体积不小，单独切一个 chunk，主包只留页面代码
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
  },
});
