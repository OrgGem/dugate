import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-07 — Identity / Security / Settings browser evidence.
 * crypto-config is the only real backend here; identity/settings prove the
 * honest "not managed / requires deployment action" states, never fake writes.
 */
const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const VIEWER = process.env.AWEB03B_VIEWER ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

test.describe('AWEB-07 Identity/Security/Settings browser evidence (harness seam)', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !STUB || !VIEWER || !TOKEN) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN / AWEB03B_{STUB,VIEWER} must be set');
    }
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test.beforeEach(async () => {
    const response = await fetch(`${STUB}/__stub/mode?reset=1`);
    expect(response.ok).toBe(true);
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  }

  function setScenario(query: string): Promise<unknown> {
    return fetch(`${STUB}/__stub/mode?${query}`).then((r) => r.json());
  }

  async function loginAsAdmin(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.fill('input[name="token"]', TOKEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/admin');
  }

  async function gotoAsAdmin(page: Page, path: string): Promise<void> {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/web/${path}`, { waitUntil: 'networkidle' });
  }

  test('1. security ready (admin): view + real apply change', async ({ page }) => {
    await gotoAsAdmin(page, 'security');
    await expect(page.getByText('fingerprintPreview')).toBeVisible();
    await page.getByRole('button', { name: 'Apply change' }).click();
    await expect(page.getByText(/Applied\. Changed fields: deliveryEncryption/)).toBeVisible();
    await shot(page, '07-01-security-ready.png');
  });

  test('2. security unconfigured → honest requires-deployment-action card', async ({ page }) => {
    await setScenario('crypto=unconfigured');
    await gotoAsAdmin(page, 'security');
    await expect(page.getByText('Crypto configuration unavailable')).toBeVisible();
    await expect(page.getByText('requires deployment action').first()).toBeVisible();
    await shot(page, '07-02-security-unconfigured.png');
  });

  test('3. security denied for a viewer session', async ({ page }) => {
    await page.context().addCookies([{ name: 'du_session', value: VIEWER, url: BASE }]);
    await page.goto(`${BASE}/admin/web/security`, { waitUntil: 'networkidle' });
    await expect(page.getByText('Access denied')).toBeVisible();
    await shot(page, '07-03-security-denied.png');
  });

  test('4. identity: real session + auth-mode not managed + users list unavailable', async ({ page }) => {
    await gotoAsAdmin(page, 'identity');
    await expect(page.getByText('Current session')).toBeVisible();
    await expect(page.getByText('legacy:admin').first()).toBeVisible();
    await expect(page.getByText('chưa managed')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users & sessions' })).toBeVisible();
    await expect(page.getByText(/owner LOCAL\/OIDC/)).toBeVisible();
    await shot(page, '07-04-identity.png');
  });

  test('5. settings: deployment guidance, no fake Save anywhere', async ({ page }) => {
    await gotoAsAdmin(page, 'settings');
    await expect(page.getByText('No deployment adapter on this build')).toBeVisible();
    await expect(page.getByText(/requires deployment action/).first()).toBeVisible();
    await expect(page.getByText('DU_ADMIN_AUTH_MODE, LOCAL-00')).toBeVisible();
    await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
    await shot(page, '07-05-settings.png');
  });

  test('6. 320px: security reflows without horizontal overflow', async ({ page }) => {
    await gotoAsAdmin(page, 'security');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('fingerprintPreview')).toBeVisible();
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, '07-06-security-320px.png');
  });
});
