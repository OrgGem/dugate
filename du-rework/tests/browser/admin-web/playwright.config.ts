import { defineConfig, devices } from '@playwright/test';

/**
 * AWEB-01b browser-evidence config (scoped to this directory only).
 *
 * Runs against a harness-started `createAdminShellServer` (see harness.ts);
 * the base URL/token arrive via AWEB01B_URL / AWEB01B_TOKEN env vars. Deliberately
 * separate from the repo `playwright.config.ts` so the live-admin-e2e suite and
 * its two projects are not picked up by `npx playwright test --config admin-web/…`.
 */
export default defineConfig({
  testDir: '.',
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
    viewport: { width: 1280, height: 800 },
  },
});
