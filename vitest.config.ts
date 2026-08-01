import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/*/src/**/*.test.{ts,tsx}',
      'apps/*/test/**/*.test.{ts,tsx}',
      'tools/**/*.test.ts',
    ],
  },
});
