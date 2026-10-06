import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-08 live — Admin Web on the du-live deployment (GATED).
 *
 * Offline this file skips cleanly: it runs only when `DU_LIVE_INFRA=1` AND
 * `AWEB_LIVE_URL` is set (same gate family as the repo's live jest suites).
 * Nothing here touches the deployment by itself — the packet's runbook flips
 * `DU_ADMIN_WEB`/`DU_ADMIN_WEB_ROUTES` on the host and restarts the rework
 * service; this spec only exercises what that flag exposes.
 *
 * Env:
 *   DU_LIVE_INFRA=1            gate
 *   AWEB_LIVE_URL              e.g. http://127.0.0.1:3001
 *   AWEB_LIVE_TOKEN            admin shell token login (legacy plane)
 *   AWEB_LIVE_COOKIE           optional `du_session=<id>` (OIDC/operator run)
 *   AWEB_LIVE_TENANT           optional tenant uuid → audit side-effect strict
 *   AWEB_LIVE_EVIDENCE         screenshot dir (default coordination/evidence/aweb08-live)
 */
const LIVE = process.env.DU_LIVE_INFRA === '1' && (process.env.AWEB_LIVE_URL ?? '').length > 0;
const BASE = process.env.AWEB_LIVE_URL ?? '';
const TOKEN = process.env.AWEB_LIVE_TOKEN ?? '';
const COOKIE = process.env.AWEB_LIVE_COOKIE ?? '';
const TENANT = process.env.AWEB_LIVE_TENANT ?? '';
const EVIDENCE = process.env.AWEB_LIVE_EVIDENCE ?? resolve(__dirname, '../../../coordination/evidence/aweb08-live');

test.describe('AWEB-08 live — Admin Web on du-live (gated)', () => {
  test.skip(!LIVE, 'live-gated: set DU_LIVE_INFRA=1 + AWEB_LIVE_URL (see runbook in aweb08-liveprep receipt)');

  test.beforeAll(() => {
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
  }

  async function login(page: Page): Promise<void> {
    if (COOKIE.length > 0) {
      const [name, ...rest] = COOKIE.split('=');
      await page.context().addCookies([{ name: name ?? 'du_session', value: rest.join('='), url: BASE }]);
      return;
    }
    expect(TOKEN.length, 'AWEB_LIVE_TOKEN or AWEB_LIVE_COOKIE required').toBeGreaterThan(0);
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.fill('input[name="token"]', TOKEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/admin');
  }

  test('1. direct URL gated by the real session; login renders the app', async ({ page }) => {
    const unauth = await page.request.get(`${BASE}/admin/web`, { maxRedirects: 0, failOnStatusCode: false });
    expect([302, 200]).toContain(unauth.status());
    if (unauth.status() === 302) expect(unauth.headers()['location']).toBe('/admin/login');

    await login(page);
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Admin Web bootstrap is running' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Admin Web Navigation' })).toBeVisible();
    await shot(page, 'live-01-login-app.png');
  });

  test('2. overview reads the REAL session + audit ledger (honest state)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Current session')).toBeVisible();
    await expect(page.getByText('Audit ledger')).toBeVisible();
    // Either real rows or the honest empty state — both are valid live answers.
    const table = page.getByRole('table', { name: 'Audit events' });
    const empty = page.getByText('No audit events');
    await expect(table.or(empty)).toBeVisible();
    if ((await table.count()) > 0) {
      await expect(page.getByRole('columnheader', { name: 'Severity' })).toBeVisible();
    }
    await shot(page, 'live-02-overview.png');
  });

  test('3. security: real view OR honest 503-unavailable (both branches accepted)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/security`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
    const view = page.getByText('fingerprintPreview');
    const unavailable = page.getByText('Crypto configuration unavailable');
    await expect(view.or(unavailable)).toBeVisible();
    await shot(page, 'live-03-security.png');
  });

  test('4. real mutation: issue (copy-once once) → revoke, then audit side effect', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/api-keys`, { waitUntil: 'networkidle' });

    const rows = page.getByRole('row');
    const before = await rows.count();
    await page.fill('#issue-tenant', TENANT || '00000000-0000-4000-8000-000000000000');
    await page.getByRole('button', { name: 'Issue key' }).click();
    await expect(page.getByText('Copy this key now — it will not be shown again')).toBeVisible();
    const rawKeyText = await page.locator('output code').first().innerText();
    expect(rawKeyText.length).toBeGreaterThan(8);
    await expect(page.locator('output code').filter({ hasText: rawKeyText })).toHaveCount(1);
    await shot(page, 'live-04-issue-copy-once.png');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText(rawKeyText)).toHaveCount(0);
    await expect.poll(async () => rows.count()).toBeGreaterThan(before);

    // Revoke the freshly issued row (first ACTIVE row) and prove the state change.
    const newRow = rows.nth(1);
    await newRow.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('cell', { name: 'REVOKED', exact: true }).first()).toBeVisible();
    await shot(page, 'live-05-revoked.png');

    // Audit side effect: ask the BFF for the ledger page the session can see.
    const auditResponse = await page.request.get(`${BASE}/admin/api/audit?limit=50`);
    expect(auditResponse.status()).toBe(200);
    const audit = (await auditResponse.json()) as { items?: { kind?: string }[] };
    const kinds = (audit.items ?? []).map((item) => item.kind ?? '');
    const sawIssue = kinds.some((kind) => kind.includes('apikey.issue'));
    if (TENANT.length > 0) {
      expect(sawIssue, 'apikey.issue must appear in the tenant ledger').toBe(true);
    }
    await shot(page, 'live-06-audit-query.png');
  });

  test('5. 320px reflow + reload keeps the session', async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${BASE}/admin/web/overview`, { waitUntil: 'networkidle' });
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, 'live-07-320px.png');

    await page.reload({ waitUntil: 'networkidle' });
    expect(new URL(page.url()).pathname).toBe('/admin/web/overview');
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await shot(page, 'live-08-reload-session.png');
  });

  test('6. connectors: real list/capabilities + activate/disable (honest both ways)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/connectors`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Connectors' });
    const empty = page.getByText('No connectors');
    await expect(table.or(empty)).toBeVisible();
    if ((await table.count()) > 0) {
      // Capabilities are part of the connector row projection when present.
      await expect(page.getByText(/capabilit/i).first()).toBeVisible();
      const toggle = page.getByRole('button', { name: /Activate|Disable/i }).first();
      // The toggle is either real (enabled) or honestly gated — never assumed.
      if (await toggle.isEnabled()) {
        await toggle.click();
        await page.waitForLoadState('networkidle');
      }
    }
    await shot(page, 'live-09-connectors.png');
  });

  test('7. profiles: upsert against a REAL apiKeyId (or honest backend-absent)', async ({ page }) => {
    await login(page);
    // A real api key id from the same BFF the UI uses; degrade honestly on 404.
    let realApiKeyId = '';
    const keys = await page.request.get(`${BASE}/admin/api/api-keys?limit=50`);
    if (keys.status() === 200) {
      const body = (await keys.json()) as { items?: { id?: string }[] };
      realApiKeyId = (body.items ?? []).map((k) => k.id ?? '').find((id) => id.length > 0) ?? '';
    }
    await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
    await page.fill('#profile-business', 'doc-core');
    await page.getByRole('button', { name: 'Load profile' }).click();
    // Either the real editor or the honest not-shipped card; both are valid answers.
    const editor = page.getByRole('button', { name: 'Save all endpoints' });
    const notShipped = page.getByText('policy backend not shipped (T-API-01..03)');
    await expect(editor.or(notShipped)).toBeVisible();
    if (realApiKeyId.length > 0 && (await editor.count()) > 0 && (await editor.isEnabled())) {
      const apiKeyField = page.locator('#profile-api-key-id');
      if (await apiKeyField.count() > 0) await apiKeyField.fill(realApiKeyId);
      await editor.click();
      await page.waitForLoadState('networkidle');
    }
    await shot(page, 'live-10-profiles-upsert.png');
  });

  test('8. operations: detail → result/artifact projection (honest empty allowed)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/operations`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('table', { name: 'Operations' })).toBeVisible();
    const rows = page.getByRole('row');
    if ((await rows.count()) > 1) {
      await rows.nth(1).click();
      const artifacts = page.getByRole('table', { name: 'Operation artifacts' });
      const none = page.getByText(/No artifacts|result not available/i);
      await expect(artifacts.or(none)).toBeVisible();
    }
    await shot(page, 'live-11-operation-detail.png');
  });

  test('9. vault/security: real crypto config OR honest unavailable, provider stated', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/admin/web/security`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
    const view = page.getByText('fingerprintPreview');
    const unavailable = page.getByText('Crypto configuration unavailable');
    await expect(view.or(unavailable)).toBeVisible();
    // Vault presence: the security/crypto surface must name its provider.
    await expect(page.getByText(/vault|local|provider/i).first()).toBeVisible();
    await shot(page, 'live-12-vault-config.png');
  });
});
