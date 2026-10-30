import { defineConfig } from 'vitest/config';

// 单元测试只覆盖纯数据转换逻辑（不依赖浏览器环境），跑 Node 环境即可。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
