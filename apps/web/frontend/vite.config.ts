import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时前端跑 5173，接口与 WebSocket 一起反向代理到后端 8000。
// 生产构建产物由后端服务在 `/` 路径直接托管（单端口对外，无跨域）。
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  // 相对路径基址：产物里的资源引用是 `./assets/...` 而不是 `/assets/...`。
  //
  // 两种部署形态都能解析：
  // - web 形态：后端用 StaticFiles 把产物挂在 `/`，相对引用从 `/` 出发即 `/assets/...`；
  // - 桌面形态：产物由 Tauri 自定义协议提供（Windows 上是 `http://tauri.localhost/`），
  //   同样从根路径解析。
  //
  // 开发模式下 Vite 仍按 `/` 提供服务（`base: './'` 只影响构建产物）。
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@/xxx` 一律指向 src/xxx，与 tsconfig 的 paths 保持一致。
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
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
