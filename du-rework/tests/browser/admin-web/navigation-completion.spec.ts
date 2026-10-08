import { expect, test } from '@playwright/test';

const BASE = process.env.ADMIN_UI_PREVIEW_URL ?? 'http://127.0.0.1:5173';

test.beforeEach(async ({ page }) => {
  await page.route('**/admin/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/session')
      ? { schemaVersion: '1', plane: 'legacy', role: 'admin', principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' }, displayName: 'UI Test Admin', csrfToken: 'fixture' }
      : path.endsWith('/businesses')
        ? { items: [{ businessId: 'doc-core', activeVersion: 'v1', version: 'v1', status: 'ACTIVE' }], total: 1, limit: 20 }
        : path.endsWith('/versions')
          ? { businessId: 'doc-core', rows: [{ version: 'v1', status: 'ACTIVE', isActive: true }] }
          : {};
    await route.fulfill({ json: data });
  });
});

test('desktop navigation, account dialog, and logout endpoint', async ({ page }) => {
  await page.goto(`${BASE}/admin/web/profiles`);
  const nav = page.getByRole('navigation', { name: 'Orchestrator Portal Navigation' });
  await expect(nav.getByRole('link', { name: 'Profiles', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await nav.getByRole('link').count()).toBe(16);
  await expect(page.locator('header nav')).toHaveCount(0);
  await expect(page.locator('header time')).toBeVisible();
  await page.getByRole('button', { name: 'UI Test Admin · Profile' }).click();
  await expect(page.getByRole('dialog')).toContainText('platform');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('header form')).toHaveAttribute('method', 'post');
  await expect(page.locator('header form')).toHaveAttribute('action', '/admin/logout');
  await page.screenshot({ path: 'artifacts/navigation-completion-desktop.png', fullPage: true });
});

test('business/version suggestions and unavailable-registry fallback', async ({ page }) => {
  await page.goto(`${BASE}/admin/web/profiles`);
  await expect(page.locator('datalist option[value="doc-core"]')).toHaveCount(1);
  await page.locator('#profile-business').fill('doc-core');
  await expect(page.locator('datalist option[value="v1"]')).toHaveCount(1);
  await page.locator('#profile-version').fill('v1');
  await page.route('**/admin/api/businesses/other/versions', (route) => route.fulfill({ status: 403, json: { status: 403, title: 'Denied' } }));
  await page.locator('#profile-business').fill('other');
  await expect(page.locator('#profile-version')).toHaveValue('latest');
  await expect(page.locator('datalist option[value="v1"]')).toHaveCount(0);
  await expect(page.getByText('Version suggestions unavailable; enter a version or use latest.')).toBeVisible();
  await page.locator('#profile-version').fill('custom-version');
  await expect(page.locator('#profile-version')).toHaveValue('custom-version');
});

test('320px navigation and UTC calendar validation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${BASE}/admin/web/usage`);
  await expect(page.getByRole('navigation')).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation')).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Profiles', exact: true }).click();
  await expect(page.getByRole('navigation')).toBeHidden();
  await page.goto(`${BASE}/admin/web/usage`);
  await expect(page.locator('#usage-from')).toHaveAttribute('type', 'datetime-local');
  await page.locator('#usage-from').fill('2026-10-06T10:00');
  await page.locator('#usage-to').fill('2026-10-05T10:00');
  await expect(page.getByRole('button', { name: 'Load usage' })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('start time before');
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({ path: 'artifacts/navigation-completion-mobile.png', fullPage: true });
});

test('connector suggestions come from the advertised management list', async ({ page }) => {
  await page.route('**/admin/api/connectors/capabilities', (route) => route.fulfill({ json: { management: true, credentialWorkflow: false, test: false, knownConnectorIds: [] } }));
  await page.route('**/admin/api/connectors', (route) => route.fulfill({ json: { items: [
    { connectorId: 'vendor-a', revision: 2, adapter: 'http-json', state: 'ACTIVE', config: {} },
    { connectorId: 'vendor-b', revision: 7, adapter: 'http-json', state: 'ACTIVE', config: {} },
  ] } }));
  await page.goto(`${BASE}/admin/web/connectors`);
  await expect(page.locator('#connector-id-suggestions option')).toHaveCount(2);
  await page.locator('#connector-id').fill('vendor-a');
  await expect(page.locator('#connector-revision-suggestions option[value="2"]')).toHaveCount(1);
  await expect(page.locator('#connector-revision-suggestions option[value="7"]')).toHaveCount(0);
});
