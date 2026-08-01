import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
  },
});
