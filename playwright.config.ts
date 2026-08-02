import { defineConfig } from '@playwright/test';

// E2E runs against the LOCAL feed-server only (revised ADR-03): a red test
// must mean "code broke", never "cloud weather". Retries are deliberately 0 —
// flakiness here is a determinism bug, not a flaky test (T-0.1.10).
export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  // One shared simulated world — a parallel sibling's /sim/gap would tear
  // this test's wire too. E2E is serial by design.
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
  },
  webServer: [
    {
      command: 'pnpm --filter @fx/feed-server exec tsx src/index.ts',
      url: 'http://127.0.0.1:8123/healthz',
      // The page lives on :5199 here — the browser's Origin must be allowed
      // or the upgrade is refused with 403 (architecture §7.1).
      env: { PORT: '8123', FX_ALLOWED_ORIGINS: 'http://127.0.0.1:5199,http://localhost:5199' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @fx/web exec vite --host 127.0.0.1 --port 5199 --strictPort',
      url: 'http://127.0.0.1:5199',
      env: { FX_BACKEND_PORT: '8123' },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
