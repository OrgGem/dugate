import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-03b — Overview graft browser evidence.
 *
 * Drivers: the harness (`harness.ts`) boots the real shell server + a scripted
 * audit upstream + an in-memory session store (operator tenant / viewer).
 * Evidence screenshots land in the directory given by AWEB01B_EVIDENCE
 * (set by the packet runner to coordination/evidence/aweb03b/).
 *
 * Cases: mount-level 401, ready (tenant-fenced rows), empty, error+retry,
 * denied (viewer), SPA-level 401 (intercepted), 320px reflow.
 */
const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const OPERATOR = process.env.AWEB03B_OPERATOR ?? '';
const VIEWER = process.env.AWEB03B_VIEWER ?? '';
const TENANT = process.env.AWEB03B_TENANT ?? '';

test.describe('AWEB-03b Overview browser evidence (harness seam)', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !STUB || !OPERATOR || !VIEWER || !TENANT) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB03B_{STUB,OPERATOR,VIEWER,TENANT} must be set');
    }
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  }

  function trackConsole(page: Page): string[] {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = msg.location().url ?? '';
      if (url.includes('favicon.ico')) return;
      errors.push(`${msg.text()} @ ${url}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    return errors;
  }

  function setScenario(mode: 'rows' | 'empty' | 'error'): Promise<unknown> {
    return fetch(`${STUB}/__stub/mode?scenario=${mode}`).then((r) => r.json());
  }

  async function auditRequests(): Promise<{ path: string; tenantId: string | null; authHeaderPresent: boolean }[]> {
    const data = (await fetch(`${STUB}/__stub/requests`).then((r) => r.json())) as {
      requests: { path: string; tenantId: string | null; authHeaderPresent: boolean }[];
    };
    return data.requests.filter((r) => r.path.startsWith('/api/v1/admin/audit'));
  }

  async function sessionCookie(page: Page, sessionId: string): Promise<void> {
    await page.context().addCookies([{ name: 'du_session', value: sessionId, url: BASE }]);
  }

  test('0. unauth direct /admin/web/overview → login (mount gate)', async ({ page }) => {
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'domcontentloaded' });
    expect(new URL(page.url()).pathname).toBe('/admin/login');
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await shot(page, 'overview-00-unauth-login.png');
  });

  test('1. operator tenant → ready: tenant-fenced rows + honest tiles', async ({ page }) => {
    const errors = trackConsole(page);
    await setScenario('rows');
    await sessionCookie(page, OPERATOR);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText(TENANT)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit events' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin.profile.publish', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'admin.connector.rotate_credential', exact: true })).toBeVisible();
    await expect(page.getByText('requires backend')).toHaveCount(2);
    await expect(page.getByText('Usage rollup')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await shot(page, 'overview-01-ready.png');

    const requests = await auditRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[requests.length - 1]?.tenantId).toBe(TENANT);
    expect(requests[requests.length - 1]?.authHeaderPresent).toBe(true);
    expect(errors).toEqual([]);
  });

  test('2. empty scope → EmptyState with refresh affordance', async ({ page }) => {
    await setScenario('empty');
    await sessionCookie(page, OPERATOR);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByText('No audit events')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    await shot(page, 'overview-02-empty.png');
  });

  test('3. upstream failure → 502 error, retry succeeds after recovery', async ({ page }) => {
    await setScenario('error');
    await sessionCookie(page, OPERATOR);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByText('UPSTREAM_ERROR')).toBeVisible();
    await expect(page.getByText('502')).toBeVisible();
    await shot(page, 'overview-03-error.png');

    await setScenario('rows');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('cell', { name: 'admin.profile.publish', exact: true })).toBeVisible();
    await shot(page, 'overview-04-error-retried.png');
  });

  test('4. viewer session → denied, upstream untouched', async ({ page }) => {
    const before = (await auditRequests()).length;
    await setScenario('rows');
    await sessionCookie(page, VIEWER);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByText('Access denied')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Audit events' })).toHaveCount(0);
    await shot(page, 'overview-05-denied.png');
    const after = (await auditRequests()).length;
    expect(after).toBe(before);
  });

  test('5. SPA-level 401 → sign-in link (session expired mid-flight)', async ({ page }) => {
    await page.route('**/admin/api/session*', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json; charset=utf-8',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({
          status: 401,
          code: 'UNAUTHENTICATED',
          title: 'sign in to use the Admin API',
        }),
      }),
    );
    await sessionCookie(page, OPERATOR);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await expect(page.getByText('UNAUTHENTICATED')).toBeVisible();
    await shot(page, 'overview-06-session-401.png');
  });

  test('6. 320px viewport: no horizontal overflow on Overview', async ({ page }) => {
    await setScenario('rows');
    await sessionCookie(page, OPERATOR);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('table', { name: 'Audit events' })).toBeVisible();
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, 'overview-07-320px.png');
  });
});
