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
    coverage: {
      // sim-core is held at 100% — cheap by construction, pure functions only
      // (plan §2.3, architecture §11). Other packages ratchet in later.
      provider: 'v8',
      include: ['packages/sim-core/src/**'],
      exclude: ['packages/sim-core/src/**/*.test.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
      reporter: ['text-summary'],
    },
  },
});
