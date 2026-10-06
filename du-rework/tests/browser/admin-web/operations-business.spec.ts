import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-06 — Operations / Usage / Business browser evidence.
 * Harness stub serves the operations/usage/business wire; state-aware
 * controls (stop/retry) and the platform-scoped business fence are
 * first-class assertions.
 */
const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const OPERATOR = process.env.AWEB03B_OPERATOR ?? '';
const TENANT = process.env.AWEB03B_TENANT ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

test.describe('AWEB-06 Operations/Business browser evidence (harness seam)', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !STUB || !OPERATOR || !TENANT || !TOKEN) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN / AWEB03B_{STUB,OPERATOR,TENANT} must be set');
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

  async function getRequests(): Promise<{ method: string; path: string }[]> {
    const data = (await fetch(`${STUB}/__stub/requests`).then((r) => r.json())) as {
      requests: { method: string; path: string }[];
    };
    return data.requests;
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

  test('1. operations ready (admin) → rows, state-aware controls, detail + artifacts', async ({ page }) => {
    await gotoAsAdmin(page, 'operations');
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'RUNNING', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Retry', exact: true }).first()).toBeDisabled();
    await shot(page, '06-01-operations-ready.png');

    await page.getByRole('button', { name: /cccccccc/ }).click();
    await expect(page.getByRole('table', { name: 'Operation artifacts' })).toBeVisible();
    await expect(page.getByText('input', { exact: true })).toBeVisible();
    await shot(page, '06-02-operation-detail-artifacts.png');
  });

  test('2. operations empty → EmptyState; error → retry recovers', async ({ page }) => {
    await setScenario('ops=empty');
    await gotoAsAdmin(page, 'operations');
    await expect(page.getByText('No operations', { exact: true })).toBeVisible();
    await shot(page, '06-03-operations-empty.png');

    await setScenario('ops=error');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('UPSTREAM_ERROR')).toBeVisible();
    await shot(page, '06-04-operations-error.png');
    await setScenario('ops=rows');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
  });

  test('3. operator session: tenant-fenced operations; business registry denied', async ({ page }) => {
    await page.context().addCookies([{ name: 'du_session', value: OPERATOR, url: BASE }]);
    await page.goto(`${BASE}/admin/web/operations`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    const opsRequests = (await getRequests()).filter((r) => r.path.startsWith('/api/v1/operations'));
    expect(opsRequests.length).toBeGreaterThan(0);
    expect(opsRequests[opsRequests.length - 1]?.path).toContain(`tenant=${TENANT}`);
    await shot(page, '06-05-operations-operator-tenant.png');

    await page.goto(`${BASE}/admin/web/businesses`, { waitUntil: 'networkidle' });
    await expect(page.getByText('Access denied')).toBeVisible();
    await expect(page.getByText(/platform-scoped/)).toBeVisible();
    await shot(page, '06-06-businesses-operator-denied.png');
  });

  test('4. businesses ready (admin) → versions + real Enable action', async ({ page }) => {
    await gotoAsAdmin(page, 'businesses');
    await expect(page.getByRole('table', { name: 'Businesses' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'doc-core', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Versions' }).click();
    await expect(page.getByRole('table', { name: 'Business versions' })).toBeVisible();
    await shot(page, '06-07-businesses-versions.png');

    await page.getByRole('button', { name: 'Enable' }).first().click();
    await expect(page.getByText(/Version 3 enabled\./)).toBeVisible();
    await shot(page, '06-08-business-enable-action.png');
  });

  test('5. businesses error → retry recovers', async ({ page }) => {
    await setScenario('biz=error');
    await gotoAsAdmin(page, 'businesses');
    await expect(page.getByText('UPSTREAM_ERROR')).toBeVisible();
    await setScenario('biz=rows');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('cell', { name: 'doc-core', exact: true })).toBeVisible();
    await shot(page, '06-09-businesses-recovered.png');
  });

  test('6. usage ready → verbatim summary', async ({ page }) => {
    await gotoAsAdmin(page, 'usage');
    await expect(page.getByText(/"tokens": 3456/)).toBeVisible();
    await shot(page, '06-10-usage-ready.png');
  });

  test('7. 320px: operations reflows without horizontal overflow', async ({ page }) => {
    await gotoAsAdmin(page, 'operations');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, '06-11-operations-320px.png');
  });
});
