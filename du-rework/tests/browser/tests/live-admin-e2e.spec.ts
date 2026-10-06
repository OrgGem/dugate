/**
 * live-admin-e2e.spec.ts — Live E2E Browser Test for Admin Web Shell
 *
 * Runs against the LIVE Orchestrator Admin Web UI (default: http://127.0.0.1:3001).
 * Tests real Authentication, Navigation, API Keys, Connectors, and Operations monitoring
 * with real screenshots and WCAG accessibility assertions.
 */

import { test, expect, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import * as path from 'path';
import * as fs from 'fs';

const LIVE_URL = process.env.LIVE_ADMIN_URL || 'http://127.0.0.1:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'du-live-admin-token-secret-32b';
const ARTIFACTS_DIR = path.resolve(__dirname, '../artifacts');

test.beforeAll(async () => {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
});

async function loginAsAdmin(page: Page) {
  await page.goto(`${LIVE_URL}/admin/login`, { waitUntil: 'networkidle' });

  const tokenInput = page.locator('input[name="token"]');
  const usernameInput = page.locator('input[name="username"]');

  if (await tokenInput.isVisible()) {
    await tokenInput.fill(ADMIN_TOKEN);
    await page.locator('button[type="submit"]').click();
  } else if (await usernameInput.isVisible()) {
    await usernameInput.fill('admin');
    await page.locator('input[name="password"]').fill('Admin@123456');
    await page.locator('button[type="submit"]').click();
  }

  // Wait for redirect to admin shell
  await page.waitForURL(/\/admin(\/.*)?$/, { timeout: 10_000 });
  await expect(page.locator('.admin-shell')).toBeVisible();
}

test.describe('Live Admin Web UI Tests', () => {

  test('LIV-08: Admin Authentication & Overview Page', async ({ page }) => {
    // 1. Go to Login page
    await page.goto(`${LIVE_URL}/admin/login`, { waitUntil: 'networkidle' });

    const title = await page.title();
    expect(title).toContain('Admin sign-in');

    // 2. Perform Login via Admin Bearer Token
    const tokenInput = page.locator('input[name="token"]');
    await expect(tokenInput).toBeVisible();
    await tokenInput.fill(ADMIN_TOKEN);
    await page.locator('button[type="submit"]').click();

    // 3. Verify Admin Shell & Overview
    await page.waitForURL(/\/admin(\/.*)?$/, { timeout: 10_000 });
    await expect(page.locator('.admin-shell')).toBeVisible();
    await expect(page.locator('.admin-shell__role')).toContainText('admin');

    // Navigate to overview pane
    await page.goto(`${LIVE_URL}/admin/overview`, { waitUntil: 'networkidle' });
    await expect(page.locator('.admin-shell__main')).toBeVisible();

    // 4. Capture screenshot
    const screenshotPath = path.join(ARTIFACTS_DIR, 'live-admin-overview.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    expect(fs.existsSync(screenshotPath)).toBe(true);

    // 5. Accessibility audit via Axe
    const axeResults = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    expect(axeResults.violations.filter(v => v.impact === 'critical')).toHaveLength(0);
  });

  test('LIV-09: API Key Management & Connector Pane', async ({ page }) => {
    // 1. Authenticate session
    await loginAsAdmin(page);

    // 2. Navigate to API Keys section
    await page.goto(`${LIVE_URL}/admin/api-keys`, { waitUntil: 'networkidle' });
    await expect(page.locator('.admin-shell__main')).toBeVisible();
    await expect(page.locator('.admin-breadcrumbs__current')).toContainText('API keys');

    // Capture screenshot
    const apiKeyScreenshot = path.join(ARTIFACTS_DIR, 'live-api-keys.png');
    await page.screenshot({ path: apiKeyScreenshot, fullPage: true });
    expect(fs.existsSync(apiKeyScreenshot)).toBe(true);

    // 3. Navigate to Connectors section
    await page.goto(`${LIVE_URL}/admin/connectors`, { waitUntil: 'networkidle' });
    await expect(page.locator('.admin-shell__main')).toBeVisible();
    await expect(page.locator('.admin-breadcrumbs__current')).toContainText('Connectors');

    // Capture screenshot
    const connScreenshot = path.join(ARTIFACTS_DIR, 'live-connectors.png');
    await page.screenshot({ path: connScreenshot, fullPage: true });
    expect(fs.existsSync(connScreenshot)).toBe(true);
  });

  test('LIV-10: Operations Triage & Detail View', async ({ page }) => {
    // 1. Authenticate session
    await loginAsAdmin(page);

    // 2. Navigate to Operations monitoring section
    await page.goto(`${LIVE_URL}/admin/operations`, { waitUntil: 'networkidle' });
    await expect(page.locator('.admin-shell__main')).toBeVisible();
    await expect(page.locator('.admin-breadcrumbs__current')).toContainText('Operations');

    // Capture screenshot
    const opsScreenshot = path.join(ARTIFACTS_DIR, 'live-operations-list.png');
    await page.screenshot({ path: opsScreenshot, fullPage: true });
    expect(fs.existsSync(opsScreenshot)).toBe(true);
  });

});
