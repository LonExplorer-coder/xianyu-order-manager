import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    testTimeout: process.env.CI ? 60_000 : process.platform === 'win32' ? 15_000 : 5_000,
  },
});
