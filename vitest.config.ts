import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 默认 Node 环境（Web Crypto API 在 Node 20+ 可用）
    // KeyStore/E2EEService 测试用 vi.mock 模拟 IndexedDB/合约依赖
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/services/**/*.ts'],
      exclude: ['src/services/**/*.test.ts', 'src/services/**/abi.ts'],
    },
  },
});
