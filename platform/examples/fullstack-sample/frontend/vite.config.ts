import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时前端跑 5173，接口反向代理到后端 8000（生产构建产物由后端直接托管）。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL ?? 'http://app:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
