import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 开发时前端跑 5173。**开发代理只是兜底**：请求恒为绝对地址直连后端 8000
// （后端已放开 CORS，跨源直连可用），只有当连接配置里的基址指向 Vite 自己
// （`http://127.0.0.1:5173`）时代理才生效——此时代理的目标由 `BACKEND_URL`
// 决定（默认 `http://127.0.0.1:8000`）。换后端的正确做法是在界面里改
// 「连接配置」的后端地址，不是改这个环境变量。
// 生产构建产物由独立静态源提供（后端只提供 /api，不托管前端）。
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  // 相对路径基址：产物里的资源引用是 `./assets/...` 而不是 `/assets/...`。
  //
  // 两种部署形态都能解析：
  // - web 形态：产物由独立静态源提供（后端只提供 /api），相对引用从 `/` 出发即 `/assets/...`；
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
    // 文件图标是运行时按需加载的本地 SVG：不内联成 data URI。
    // 内联会把 100+ 个图标全塞进主 chunk（+~400KB），而界面上一次只显示十几个。
    assetsInlineLimit: 0,
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
