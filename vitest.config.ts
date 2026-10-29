import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 浏览器扩展自己的测试；agent/conversation-wiki 使用 Node 内置测试运行器。
    include: ['src/**/*.test.ts'],
  },
});
