import { defineConfig, devices } from '@playwright/test';

/** Isolated Admin Web UX verification; this excludes unrelated legacy browser specs. */
export default defineConfig({
  testDir: '.',
  testMatch: 'frontend-ux.verify.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1440, height: 1000 },
  },
});
