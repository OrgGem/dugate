import { defineConfig, devices } from '/workspace/dugate/du-rework/tests/browser/node_modules/@playwright/test/index.mjs';

export default defineConfig({
  testDir: '/workspace/dugate/du-rework/tests/browser/admin-web',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: `${process.env.ORV14_ADMIN_PRIVATE_EVIDENCE ?? '/workspace/scratch/orv14-primary-ui-20261012T0243Z/finance-evidence'}/playwright-output`,
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    launchOptions: {
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 800 },
  },
});
