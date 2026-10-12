import fs from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const BASE = process.env.AWEB01B_URL ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const EVIDENCE = process.env.ORV14_FINANCE_EVIDENCE ?? '';
const fixtures = require('../../workflow-api/orv14-vfy/profile-docs-fixtures.cjs') as {
  TENANT: string;
  OTHER_TENANT: string;
  PROFILE_ID: string;
  API_KEY_ID: string;
  BUSINESS_ID: string;
  BUSINESS_VERSION: string;
  PROFILE_NAME: string;
  REVISION: number;
  inputSchema: Record<string, unknown>;
  adminSession: Record<string, unknown>;
  userSession: Record<string, unknown>;
  viewerSession: Record<string, unknown>;
  tenantPage: unknown;
  profileListPage: unknown;
  profileDetail: unknown;
  profileKeyPage: unknown;
  assignedProfilePage: unknown;
  assignedKeyPage: unknown;
};

type SessionKind = 'admin' | 'user' | 'viewer';
type SeenRequest = { method: string; path: string; query: Record<string, string> };

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function fulfill(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: json(value) });
}

async function installProfileDocsApi(page: Page, sessionKind: SessionKind = 'admin'): Promise<SeenRequest[]> {
  const calls: SeenRequest[] = [];
  const session = sessionKind === 'user' ? fixtures.userSession
    : sessionKind === 'viewer' ? fixtures.viewerSession : fixtures.adminSession;
  await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), fixtures.TENANT);
  page.on('pageerror', (error) => console.info(`ORV14_PROFILE_DOCS_PAGE_ERROR ${error.message}`));
  await page.route('**/admin/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    calls.push({ method, path, query });

    if (path === '/admin/api/session' && method === 'GET') return fulfill(route, session);
    if (path === '/admin/api/tenants' && method === 'GET') return fulfill(route, fixtures.tenantPage);
    if (path === '/admin/api/health' && method === 'GET') return fulfill(route, {
      status: 'ok', db: true, redis: true, activeLeases: 0,
      queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: '2026-10-12T00:00:00.000Z' },
      outboxBacklog: 0, sampledAt: '2026-10-12T00:00:00.000Z',
    });
    if (path === '/admin/api/businesses' && method === 'GET') return fulfill(route, {
      items: [{ businessId: fixtures.BUSINESS_ID, activeVersion: fixtures.BUSINESS_VERSION, version: fixtures.BUSINESS_VERSION, status: 'ACTIVE' }],
      total: 1, limit: 100,
    });
    if (path === `/admin/api/businesses/${fixtures.BUSINESS_ID}/versions` && method === 'GET') return fulfill(route, {
      businessId: fixtures.BUSINESS_ID,
      activeVersion: fixtures.BUSINESS_VERSION,
      rows: [{ version: fixtures.BUSINESS_VERSION, status: 'ACTIVE', isActive: true }],
    });
    if (path === '/admin/api/profiles/assigned' && method === 'GET') return fulfill(route, fixtures.assignedProfilePage);
    if (path === `/admin/api/profiles/assigned/${fixtures.PROFILE_ID}/api-keys` && method === 'GET') return fulfill(route, fixtures.assignedKeyPage);
    if (path === '/admin/api/profiles' && method === 'GET') return fulfill(route, fixtures.profileListPage);
    if (path === `/admin/api/profiles/${fixtures.BUSINESS_ID}/${fixtures.BUSINESS_VERSION}/${fixtures.PROFILE_NAME}` && method === 'GET') return fulfill(route, fixtures.profileDetail);
    if (path === `/admin/api/profiles/${fixtures.BUSINESS_ID}/${fixtures.BUSINESS_VERSION}/${fixtures.PROFILE_NAME}/api-keys` && method === 'GET') return fulfill(route, fixtures.profileKeyPage);
    if (path === `/admin/api/profiles/${fixtures.BUSINESS_ID}/${fixtures.BUSINESS_VERSION}/${fixtures.PROFILE_NAME}/workflows` && method === 'GET') return fulfill(route, {
      businessId: fixtures.BUSINESS_ID, businessVersion: fixtures.BUSINESS_VERSION, items: [], total: 0,
    });
    if (path === '/admin/api/api-keys' && method === 'GET') return fulfill(route, { items: [], total: 0, limit: 100, nextCursor: null });
    return fulfill(route, {});
  });
  return calls;
}

async function login(page: Page, route: string): Promise<void> {
  if (!BASE || !TOKEN) throw new Error('AWEB01B_URL and AWEB01B_TOKEN must point to the normal private Admin shell');
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.locator('input[name="token"]').fill(TOKEN);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/admin');
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
}

function handoff(tenantId: string, expectedRevision = fixtures.REVISION) {
  return {
    handoffId: '55555555-5555-4555-8555-555555555555',
    tenantId,
    businessId: fixtures.BUSINESS_ID,
    businessVersion: fixtures.BUSINESS_VERSION,
    profileName: fixtures.PROFILE_NAME,
    expectedRevision,
  };
}

async function injectHandoff(page: Page, value: ReturnType<typeof handoff>): Promise<void> {
  await page.evaluate((payload) => {
    const state = { usr: { profileWorkbenchHandoff: payload }, key: 'orv14-profile-docs-handoff', idx: history.length };
    history.pushState(state, '', location.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  }, value);
}

async function saveScreenshot(page: Page, file: string): Promise<void> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE, file), fullPage: true });
}

test.describe('ORV14 current Profile → Docs Workbench handoff', () => {
  test.beforeAll(() => {
    if (!BASE || !TOKEN || !EVIDENCE) throw new Error('The normal private shell, Admin token, and evidence directory are required');
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test('exact tenant/Profile revision handoff confirms unsaved edits and rehydrates the saved tuple', async ({ page }) => {
    const calls = await installProfileDocsApi(page);
    await login(page, 'admin/profiles');
    await expect(page.locator('#global-tenant-select')).toHaveValue(fixtures.TENANT);
    const profileRow = page.getByRole('row').filter({ hasText: fixtures.PROFILE_NAME });
    await expect(profileRow).toBeVisible();
    await profileRow.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByText(`Revision ${fixtures.REVISION}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Test in Workbench' })).toBeEnabled();

    const extensions = page.getByLabel('Allowed file extensions (CSV)').first();
    await extensions.fill('.csv');
    await page.getByRole('button', { name: 'Test in Workbench' }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Unsaved Profile changes stay in this page only');
    await expect(confirm).toContainText('The Workbench will load the current saved revision');
    await expect(page).toHaveURL(/\/admin\/profiles$/);
    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(extensions).toHaveValue('.csv');

    await page.getByRole('button', { name: 'Test in Workbench' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard local edits and continue' }).click();
    await expect(page).toHaveURL(/\/admin\/docs$/);
    await expect(page.locator('#workbench-profile')).toHaveValue(JSON.stringify([fixtures.TENANT, fixtures.BUSINESS_ID, fixtures.BUSINESS_VERSION, fixtures.PROFILE_NAME]));
    await expect(page.locator('#workbench-action')).toHaveValue('extract');
    await expect(page.getByText(new RegExp(`Tenant scope: ${fixtures.TENANT}`))).toBeVisible();
    expect(calls.some((call) => call.method === 'GET' && call.path === `/admin/api/profiles/${fixtures.BUSINESS_ID}/${fixtures.BUSINESS_VERSION}/${fixtures.PROFILE_NAME}`)).toBe(true);
    expect(calls.some((call) => call.method === 'GET' && call.path === '/admin/api/profiles' && call.query.tenantId === fixtures.TENANT)).toBe(true);
    expect(calls.filter((call) => call.method === 'POST' && call.path.includes('admin-workbench'))).toHaveLength(0);
    await saveScreenshot(page, 'orv14-profile-handoff-current-revision.png');
  });

  test('foreign tenant tuple is rejected before the Profile read', async ({ page }) => {
    const calls = await installProfileDocsApi(page);
    await login(page, 'admin/docs');
    await injectHandoff(page, handoff(fixtures.OTHER_TENANT));
    await expect(page.getByText('The Profile handoff belongs to a different tenant. Select that tenant and open the Profile again.')).toBeVisible();
    await expect(page.locator('#workbench-action')).toHaveCount(0);
    expect(calls.filter((call) => call.path.startsWith('/admin/api/profiles/') && call.path.includes(fixtures.PROFILE_NAME))).toHaveLength(0);
    await saveScreenshot(page, 'orv14-profile-handoff-foreign-tenant-denied.png');
  });

  test('stale revision tuple is rejected against the current saved Profile read', async ({ page }) => {
    const calls = await installProfileDocsApi(page);
    await login(page, 'admin/docs');
    await injectHandoff(page, handoff(fixtures.TENANT, fixtures.REVISION + 1));
    await expect(page.getByText(`The saved Profile revision changed from ${fixtures.REVISION + 1}. Refresh Profiles and open the current revision before testing.`)).toBeVisible();
    await expect(page.locator('#workbench-action')).toHaveCount(0);
    expect(calls.filter((call) => call.method === 'GET' && call.path === `/admin/api/profiles/${fixtures.BUSINESS_ID}/${fixtures.BUSINESS_VERSION}/${fixtures.PROFILE_NAME}`)).toHaveLength(1);
    await saveScreenshot(page, 'orv14-profile-handoff-stale-revision-denied.png');
  });

  test('direct Docs URL and reload do not reuse an old Profile selection', async ({ page }) => {
    const calls = await installProfileDocsApi(page);
    await login(page, 'admin/docs');
    await expect(page.getByRole('heading', { name: 'API Docs and Test Workbench' })).toBeVisible();
    await expect(page.locator('#workbench-profile')).toHaveValue('');
    await expect(page.locator('#workbench-action')).toHaveCount(0);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('#workbench-profile')).toHaveValue('');
    await expect(page.locator('#workbench-action')).toHaveCount(0);
    expect(calls.some((call) => call.path === '/admin/api/profiles' && call.query.tenantId === fixtures.TENANT)).toBe(true);
    await saveScreenshot(page, 'orv14-docs-direct-reload-empty-selection.png');
  });

  test('local USER sees only the assigned Profile and API key', async ({ page }) => {
    const calls = await installProfileDocsApi(page, 'user');
    await login(page, 'admin/docs');
    await expect(page.getByText(new RegExp(`Tenant scope: ${fixtures.TENANT} · local USER assignment scope`))).toBeVisible();
    const profile = page.locator('#workbench-profile');
    await expect(profile.locator('option')).toContainText([`${fixtures.PROFILE_NAME} · rev ${fixtures.REVISION}`]);
    await profile.selectOption(fixtures.PROFILE_ID);
    await expect(page.locator('#workbench-action')).toHaveValue('extract');
    await expect(page.locator('#workbench-key')).toHaveValue(fixtures.API_KEY_ID);
    await expect(page.getByLabel('Document type')).toHaveValue('invoice');
    expect(calls.some((call) => call.path === '/admin/api/profiles/assigned' && call.query.limit === '100')).toBe(true);
    expect(calls.some((call) => call.path === `/admin/api/profiles/assigned/${fixtures.PROFILE_ID}/api-keys` && call.query.limit === '100')).toBe(true);
    expect(calls.some((call) => call.path === '/admin/api/api-keys')).toBe(false);
    expect(calls.some((call) => call.path === '/admin/api/profiles')).toBe(false);
    await saveScreenshot(page, 'orv14-docs-local-user-assigned-profile.png');
  });

  test('Viewer cannot open the Workbench or select a Profile', async ({ page }) => {
    await installProfileDocsApi(page, 'viewer');
    await login(page, 'admin/docs');
    await expect(page.getByText('Viewer access is read-only')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Test Endpoint' })).toHaveCount(0);
    await expect(page.locator('#workbench-profile')).toHaveCount(0);
  });
});
