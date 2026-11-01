import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

// 单元测试覆盖两类：
// - 纯数据转换逻辑（不依赖浏览器环境），跑 Node 环境即可；
// - 组件交互（终端面板的关闭/移除），用 jsdom 环境（文件头部注解切换）。
export default defineConfig({
  // vitest.config.ts 不继承 vite.config.ts，@/ 别名必须在这里再写一遍。
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
