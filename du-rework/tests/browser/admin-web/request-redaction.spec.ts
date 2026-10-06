import { expect, test } from '@playwright/test';
const BASE = process.env.ADMIN_UI_PREVIEW_URL ?? 'http://127.0.0.1:25173';
const policy = { enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '', fileUrlAuthConfigured: false, connectionsOverride: [], requestRedaction: [] };
const profile = { businessId: 'doc-core', businessVersion: 'v1', profileName: 'privacy', apiKeyId: '11111111-1111-4111-8111-111111111111', revision: 1, currentValues: {}, policy, manifest: { actions: [{ name: 'extract' }] }, capabilities: [{ connectorId: 'local', capability: 'upsert' }] };

test.beforeEach(async ({ page }) => {
  await page.route('**/admin/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/session') ? { schemaVersion: '1', plane: 'legacy', role: 'admin', principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' }, displayName: 'Privacy Admin', csrfToken: 'fixture' }
      : path.endsWith('/businesses') ? { items: [{ businessId: 'doc-core', activeVersion: 'v1', status: 'ACTIVE' }] }
      : path.endsWith('/versions') ? { rows: [{ version: 'v1', status: 'ACTIVE', isActive: true }] }
      : path.includes('/profiles/') ? profile : {};
    await route.fulfill({ json: data });
  });
});

test('profile editor saves regex, replacement and selected flags', async ({ page }) => {
  let saved: Record<string, unknown> | undefined;
  await page.route('**/admin/api/profiles/**/upsert', async route => {
    saved = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { revision: 2 } });
  });
  await page.goto(`${BASE}/admin/web/profiles`);
  await page.locator('#profile-business').fill('doc-core');
  await page.locator('#profile-version').fill('v1');
  await page.locator('#profile-name').fill('privacy');
  await page.getByRole('button', { name: 'Load profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'row profile name', exact: true }).fill('privacy');
  await page.getByRole('button', { name: 'Add redaction rule', exact: true }).click();
  await page.getByLabel('Redaction pattern 1', { exact: true }).fill('(090)1234567');
  await page.getByLabel('Redaction replacement 1', { exact: true }).fill('$1*******');
  await page.getByLabel('Ignore case', { exact: true }).check();
  await page.getByRole('button', { name: 'Save privacy', exact: true }).click();
  await expect.poll(() => saved).toBeTruthy();
  expect(saved?.policy).toMatchObject({ requestRedaction: [{ pattern: '(090)1234567', replacement: '$1*******', flags: 'i' }] });
  await page.screenshot({ path: 'artifacts/request-redaction-profile.png', fullPage: true });
});

for (const status of ['REDACTED', 'HIDDEN'] as const) {
  test(`operation displays only server-provided ${status} input on mobile`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const operation = { id: 'privacy-op', state: 'RUNNING', businessId: 'doc-core', action: 'extract' };
    await page.route(/\/admin\/api\/operations(?:\?.*)?$/,  route => route.fulfill({ json: { items: [operation] } }));
    await page.route('**/admin/api/operations/privacy-op', route => route.fulfill({ json: { operation, requestInput: { status, ruleCount: 1, data: status === 'HIDDEN' ? '[REDACTED]' : { phone: '090*******' } } } }));
    await page.goto(`${BASE}/admin/web/operations`);
    await page.getByRole('button', { name: /privacy-/ }).click();
    await expect(page.getByLabel('Request input', { exact: true })).toContainText(status === 'HIDDEN' ? '[REDACTED]' : '090*******');
    await expect(page.locator('body')).not.toContainText('0901234567');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/request-redaction-${status.toLowerCase()}-mobile.png`, fullPage: true });
  });
}
