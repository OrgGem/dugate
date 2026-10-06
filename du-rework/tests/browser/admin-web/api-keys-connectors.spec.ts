import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-05 — API keys + Connectors browser evidence.
 *
 * Drivers: `harness.ts` (real shell server + scripted upstream + session
 * store). Screenshots land in AWEB01B_EVIDENCE (packet runner sets it to
 * coordination/evidence/aweb05/).
 */
const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const VIEWER = process.env.AWEB03B_VIEWER ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const RAW_ISSUED_KEY = 'du_test_copy_once_raw_key_9f2c';

/** STUB-EXT: a draft whose imported cURL carries a secret and a local file path. */
const SQ = String.fromCharCode(39);
const DRAFT_SECRET = 'sk-live-stub-ext-9c31';
const DRAFT_CURL =
  'curl -X POST https://api.vendor.example/v1/extract' +
  ' -H ' + SQ + 'authorization:Bearer ' + DRAFT_SECRET + SQ +
  ' -H content-type:application/json' +
  ' -F prompt=hello' +
  ' -F file=@C:/Users/op/private-dir/source.pdf';

test.describe('AWEB-05 API keys + Connectors browser evidence (harness seam)', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !STUB || !VIEWER || !TOKEN) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN / AWEB03B_{STUB,VIEWER} must be set');
    }
    fs.mkdirSync(EVIDENCE, { recursive: true });
  });

  test.beforeEach(async () => {
    // The stub server outlives a single test: reset its mutable state so each
    // case starts from the seed (one ACTIVE key, no issued rows).
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

  test('1. api-keys ready: tenant rows + read-only bindings + F7 disabled actions', async ({ page }) => {
    await setScenario('keys=rows');
    await gotoAsAdmin(page, 'api-keys');
    await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'du_live_ab12', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'ACTIVE', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Profile bindings' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'doc-core', exact: true })).toBeVisible();
    await expect(page.getByText('rotate/disable: requires backend').first()).toBeVisible();
    const rotateButtons = page.getByRole('button', { name: 'Rotate' });
    await expect(rotateButtons.first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Disable' }).first()).toBeDisabled();
    await shot(page, '05-01-keys-ready.png');
  });

  test('2. issue → copy-once shown exactly once, never stored, gone after reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`${msg.text()} @ ${msg.location().url}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    await setScenario('keys=rows');
    await gotoAsAdmin(page, 'api-keys');
    await page.fill('#issue-tenant', '11111111-1111-4111-8111-111111111111');
    await page.getByRole('button', { name: 'Issue key' }).click();

    const banner = page.getByText('Copy this key now — it will not be shown again');
    await expect(banner).toBeVisible();
    expect(errors).toEqual([]);
    await expect(page.getByText(RAW_ISSUED_KEY)).toHaveCount(1);
    await shot(page, '05-02-copy-once.png');

    const storage = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(storage).toEqual({ local: [], session: [] });

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText(RAW_ISSUED_KEY)).toHaveCount(0);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText(RAW_ISSUED_KEY)).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'du_live_new', exact: true })).toBeVisible();
    await shot(page, '05-03-copy-once-hidden-after-reload.png');
  });

  test('3. revoke flow with confirm → row becomes REVOKED', async ({ page }) => {
    await setScenario('keys=rows');
    await gotoAsAdmin(page, 'api-keys');
    const row = page.getByRole('row', { name: /du_live_ab12/ });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, '05-04-revoke-confirm.png');
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('cell', { name: 'REVOKED', exact: true })).toBeVisible();
    await shot(page, '05-05-revoked.png');
  });

  test('4. empty and error+retry states', async ({ page }) => {
    await setScenario('keys=empty');
    await gotoAsAdmin(page, 'api-keys');
    await expect(page.getByText('No API keys')).toBeVisible();
    await shot(page, '05-06-keys-empty.png');

    await setScenario('keys=error');
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('UPSTREAM_ERROR')).toBeVisible();
    await shot(page, '05-07-keys-error.png');
    await setScenario('keys=rows');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('cell', { name: 'du_live_ab12', exact: true })).toBeVisible();
    await shot(page, '05-08-keys-recovered.png');
  });

  test('5. viewer session → denied on api-keys', async ({ page }) => {
    await setScenario('keys=rows');
    await page.context().addCookies([{ name: 'du_session', value: VIEWER, url: BASE }]);
    await page.goto(`${BASE}/admin/web/api-keys`, { waitUntil: 'networkidle' });
    await expect(page.getByText('Access denied')).toBeVisible();
    await shot(page, '05-09-keys-denied.png');
  });

  /** STUB-EXT: the exact dispatcher params of every write the browser sent. */
  async function capturedWrites(): Promise<Array<{ action: string; params: Record<string, unknown> }>> {
    const data = (await fetch(`${STUB}/__stub/writes`).then((r) => r.json())) as {
      writes: Array<{ action: string; params: Record<string, unknown> }>;
    };
    return data.writes;
  }

  test('6. connectors: management not composed → advertised false, honest unavailable', async ({ page }) => {
    await setScenario('connectorMgmt=absent&connector=missing');
    await gotoAsAdmin(page, 'connectors');
    await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
    // CONNECTOR-WIRE-B: the advertisement is composition-derived. `absent` means
    // the platform itself answered management:false — the header badge stays
    // read-only, no list is offered and no write control is faked.
    await expect(page.getByText('Composition capabilities')).toBeVisible();
    await expect(page.getByText('read-only', { exact: true })).toBeVisible();
    await page.fill('#connector-id', 'openai');
    await page.getByRole('button', { name: 'Load revision' }).click();
    await expect(page.getByText('Connector unavailable')).toBeVisible();
    await expect(page.getByText('requires backend').first()).toBeVisible();
    await expect(page.getByText(/connectorBaseUrls/)).toBeVisible();
    await shot(page, '05-10-connector-unavailable.png');
  });

  test('7. connectors: no management → degraded projection, every write gated with the reason', async ({ page }) => {
    await setScenario('connectorMgmt=absent&connector=ok');
    await gotoAsAdmin(page, 'connectors');
    await page.fill('#connector-id', 'openai');
    await page.getByRole('button', { name: 'Load revision' }).click();
    await expect(page.getByText('configured:o***:443')).toBeVisible();
    await expect(page.getByText('degraded projection', { exact: true })).toBeVisible();
    await expect(page.getByText('revision 1')).toBeVisible();
    // The probe rides the management surface (connector.test), so an uncomposed
    // deployment disables it with the real reason like every other write.
    const probe = page.getByRole('button', { name: 'Test connection' });
    await expect(probe).toBeDisabled();
    await expect(probe).toHaveAttribute('title', /management:false/);
    await expect(page.getByRole('button', { name: 'Activate' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Disable' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retire revision' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Rotate secret' })).toBeDisabled();
    await shot(page, '05-11-connector-degraded-gated.png');
  });

  test('8. connectors: the advertisement read fails → fail-closed on the transport reason', async ({ page }) => {
    await setScenario('connectorMgmt=error&connector=ok');
    await gotoAsAdmin(page, 'connectors');
    await expect(page.getByText('Capability advertisement unavailable')).toBeVisible();
    // The upstream 500 is collapsed by the BFF into a fixed 502 UPSTREAM_ERROR:
    // the UI must not guess capabilities from a transport failure.
    await expect(page.getByText(/502 · UPSTREAM_ERROR/)).toBeVisible();
    await expect(page.getByText('read-only', { exact: true })).toBeVisible();
    await page.fill('#connector-id', 'openai');
    await page.getByRole('button', { name: 'Load revision' }).click();
    await expect(page.getByText('degraded projection', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activate' })).toBeDisabled();
    await shot(page, '05-13-connector-advertisement-down.png');
  });

  test('9. connectors: management journey — ledger, CAS activate, disable confirm, 409 + 422', async ({ page }) => {
    await setScenario('connectorMgmt=composed&connector=ok');
    await gotoAsAdmin(page, 'connectors');
    await expect(page.getByText('management', { exact: true })).toBeVisible();

    // (a) the real ledger, with the ACTIVE head resolved per connector.
    await expect(page.getByRole('table', { name: 'Connectors' })).toBeVisible();
    await expect(page.getByRole('row', { name: /vendor-extract 1 ACTIVE/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /vendor-extract 2 PENDING/ })).toBeVisible();
    await shot(page, '05-14-connector-ledger-list.png');

    // (b) load the PENDING revision → management shape: keys and names only.
    await page.fill('#connector-id', 'vendor-extract');
    await page.fill('#connector-revision', '2');
    await page.getByRole('button', { name: 'Load revision' }).click();
    await expect(page.getByText('platform ledger')).toBeVisible();
    await expect(page.getByText('vault://du/vendor-extract')).toBeVisible();
    await expect(page.getByText(/masked: authorization/)).toBeVisible();
    // The seeded header VALUE is the literal redaction marker, so a rendered
    // element whose whole text is that marker would mean the value leaked.
    await expect(page.getByText('[REDACTED]', { exact: true })).toHaveCount(0);

    // (c) activate with the CAS guard read from the list (expected head = 1).
    const activate = page.getByRole('button', { name: 'Activate' });
    await expect(activate).toBeEnabled();
    await activate.click();
    await expect(page.getByText('Action accepted')).toBeVisible();
    await expect(page.getByText('Activate requested for vendor-extract@2.')).toBeVisible();
    await expect(page.getByRole('row', { name: /vendor-extract 2 ACTIVE/ })).toBeVisible();
    await shot(page, '05-15-connector-activated.png');

    let writes = await capturedWrites();
    expect(writes.filter((w) => w.action === 'connector.activate').map((w) => w.params)).toEqual([
      { connectorId: 'vendor-extract', revision: 2, expectedCurrentRevision: 1 },
    ]);

    // (d) disable goes through the confirm dialog — no one-click destroy.
    await page.getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Disable' }).click();
    await expect(page.getByText('Disable requested for vendor-extract.')).toBeVisible();
    writes = await capturedWrites();
    expect(writes.filter((w) => w.action === 'connector.disable').map((w) => w.params)).toEqual([
      { connectorId: 'vendor-extract' },
    ]);

    // (e) a lost CAS is a 409 problem+json, never a silent success.
    await setScenario('connectorWrite=conflict');
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByText('The admin API rejected the request')).toBeVisible();
    await expect(page.getByText(/409 · STATE_CONFLICT/)).toBeVisible();
    await shot(page, '05-16-connector-cas-conflict.png');

    // (f) a schema rejection surfaces as 422 INVALID_SCHEMA.
    await setScenario('connectorWrite=invalid');
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByText(/422 · INVALID_SCHEMA/)).toBeVisible();
    await shot(page, '05-17-connector-422.png');
  });

  test('10. connectors: cURL draft → connector.upsert 201 without the secret or the local path', async ({ page }) => {
    await setScenario('connectorMgmt=composed');
    await gotoAsAdmin(page, 'connectors');
    await page.getByRole('button', { name: 'Import cURL' }).click();
    await page.locator('textarea[aria-label="cURL command"]').fill(DRAFT_CURL);
    await page.getByRole('button', { name: 'Accept draft' }).click();

    // Save is gated on real coordinates, not on hope.
    await expect(page.getByText('Imported cURL draft')).toBeVisible();
    const save = page.getByRole('button', { name: 'Save connection' });
    await expect(save).toBeDisabled();
    await expect(page.getByText(/Save stays disabled until/)).toBeVisible();
    await page.fill('#import-draft-connector-id', 'vendor-summarize');
    await page.fill('#import-draft-adapter', 'http-json');
    await page.fill('#import-draft-credential-ref', 'vault://du/vendor-summarize');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page.getByText('Connector vendor-summarize saved (mode create, credential slot vault://du/vendor-summarize).'),
    ).toBeVisible();
    await shot(page, '05-18-connector-upsert-201.png');

    const writes = await capturedWrites();
    const upsert = writes.filter((w) => w.action === 'connector.upsert');
    expect(upsert).toHaveLength(1);
    const params = upsert[0]?.params ?? {};
    expect(params.mode).toBe('create');
    expect(params.connectorId).toBe('vendor-summarize');
    const payload = JSON.stringify(params);
    // Redaction is structural: the secret and the operator's local path are not
    // in the payload at all, while the non-secret shape rides intact.
    expect(payload).not.toContain(DRAFT_SECRET);
    expect(payload).not.toContain('private-dir');
    expect(payload).toContain('https://api.vendor.example/v1/extract');
    expect(payload).toContain('content-type');
  });

  test('11. 320px: api-keys reflows without horizontal overflow', async ({ page }) => {
    await setScenario('keys=rows');
    await gotoAsAdmin(page, 'api-keys');
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('cell', { name: 'du_live_ab12', exact: true })).toBeVisible();
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, '05-12-keys-320px.png');
  });
});
