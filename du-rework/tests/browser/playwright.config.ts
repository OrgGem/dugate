import { defineConfig, devices } from '@playwright/test';

/**
 * W47-O browser harness config.
 *
 * Chromium-only, headless, no DB / Redis / network. Two viewports:
 *   - desktop: 1440x900 (covers the canvas at common laptop widths)
 *   - mobile: 390x844 (iPhone 14-class viewport, used by axe + screenshots)
 *
 * Test artifacts (screenshots, axe reports) land under
 * `tests/browser/artifacts/`. The summary is written to
 * `tests/browser/artifacts/artifacts-summary.json` and is the single
 * file the orchestrator-side report links to.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/playwright-report.json' }],
  ],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
});
