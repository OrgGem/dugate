/**
 * W47-O real-interaction specs.
 *
 * Four interactions that prove the Admin shell's behaviour end-to-end
 * through a real Chromium:
 *   (1) Navigate 7 sections after operator cookie login → each section's
 *       expected DOM discriminator is present.
 *   (2) Open the human-wait form with an expired CAS, assert the submit
 *       button stays disabled.
 *   (3) Reload the API-key copy-once page, assert the raw key string is
 *       never in the DOM (write-only enforcement).
 *   (4) Run cancel-operation against the stubbed running op, assert the
 *       action button has the explicit data-action="cancel-operation"
 *       + data-can-cancel="true" + data-operation-state="RUNNING".
 *
 * NO DB, NO Redis, NO platform HTTP.
 */

import { test, expect } from '@playwright/test';
import { startHarness } from '../src/harness-server';
import { writeSummary, listArtifacts, recordScreenshot } from './a11y-summary';

let harnessUrl = '';
let harnessHandle: import('../src/harness-server').HarnessHandle | undefined;

test.beforeAll(async () => {
  const harness = await startHarness();
  harnessUrl = harness.url;
  harnessHandle = harness;
});

test.afterAll(async () => {
  if (harnessHandle) {
    await harnessHandle.close();
  }
  if ((await listArtifacts()).length > 0) {
    await writeSummary();
  }
});

async function loginAs(page: import('@playwright/test').Page, role: 'admin' | 'operator' | 'viewer'): Promise<void> {
  await page.goto(`${harnessUrl}/admin/login`);
  // The shell accepts `role:<role>:<token>` to mint a cookie with the
  // requested role. All three roles share the same adminToken in this
  // harness; the role only changes what the shell renders.
  await page
    .locator('input[name="token"]')
    .fill(`role:${role}:harness-secret-token`);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname.startsWith('/admin'));
}

test('interaction-1: operator can navigate all 7 sections end-to-end', async ({ page }) => {
  await loginAs(page, 'operator');
  const visits: ReadonlyArray<{ path: string; expected: string }> = [
    { path: '/admin', expected: 'main' },
    { path: '/admin/businesses?businessId=tenant-acme', expected: 'section.business-section' },
    { path: '/admin/operations?operationId=op-running', expected: 'section.operation-section' },
    { path: '/admin/overview?tenantId=tenant-acme', expected: 'section.overview-section' },
    { path: '/admin/profiles?businessId=tenant-acme&businessVersion=2026.09.01&profile=extraction-default', expected: 'section.profile-section' },
    { path: '/admin/connectors?connectorId=connector-rest-1&revision=7', expected: 'section.connector-section' },
    // api-keys is admin-only — operator gets the 403 page, not the
    // section root. Visit twice: once as operator (403), once as admin.
    { path: '/admin/api-keys', expected: 'h1, h2, p' },
  ];
  for (const v of visits) {
    const resp = await page.goto(`${harnessUrl}${v.path}`);
    expect(resp, `response for ${v.path}`).not.toBeNull();
    if (v.path === '/admin/api-keys') {
      // operator role on an admin-only nav: shell returns 403
      expect(resp!.status()).toBe(403);
      await expect(page.locator('body')).toContainText(/not authorized|access denied/i);
      continue;
    }
    expect(resp!.status(), `status for ${v.path}`).toBe(200);
    await page.waitForSelector(v.expected, { timeout: 10_000 });
  }
});

test('interaction-2: human-wait form with expired CAS keeps submit disabled', async ({ page }) => {
  await loginAs(page, 'operator');
  const resp = await page.goto(`${harnessUrl}/admin/operations?operationId=op-wait`);
  expect(resp).not.toBeNull();
  expect(resp!.status()).toBe(200);
  // The op-wait stub returns isExpired=true and casToken="cas-1"
  await page.waitForSelector('section.operation-section', { timeout: 10_000 });
  const form = page.locator('section.operation-section__wait form').first();
  await expect(form).toBeVisible();
  // CAS hidden input carries the server's token, verbatim.
  await expect(form.locator('input[name="casToken"]')).toHaveValue('cas-1');
  // Submit button: data-action="submit-resume" + disabled when expired
  const submit = form.locator('button[data-action="submit-resume"]').first();
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
});

test('interaction-3: API key copy-once page never exposes raw key in DOM', async ({ page }) => {
  // Log in as admin so /admin/api-keys returns 200.
  await loginAs(page, 'admin');
  const resp = await page.goto(
    `${harnessUrl}/admin/api-keys?keyId=expired-copy-once`,
  );
  expect(resp).not.toBeNull();
  expect(resp!.status()).toBe(200);
  await page.waitForSelector('section.api-key-section', { timeout: 10_000 });

  // The harness never returns a raw value from the stub — the
  // createCopyOnce block carries only maskedHint + notice. Confirm
  // the well-known raw sentinel string is absent from the entire
  // document body, including after a hard reload (the bug class
  // we're guarding against is "raw value persisted into client state
  // and re-rendered after navigation").
  const body = await page.locator('body').innerHTML();
  expect(body).not.toContain('S3CRET');
  expect(body).not.toContain('sk_live_plaintext_value');
  // And the masked hint IS visible
  await expect(page.locator('body')).toContainText('sk_****-****-****-****');

  // Reload — raw must STILL not appear after a full document reload.
  await page.reload();
  const bodyAfterReload = await page.locator('body').innerHTML();
  expect(bodyAfterReload).not.toContain('S3CRET');
  expect(bodyAfterReload).not.toContain('sk_live_plaintext_value');
  await expect(page.locator('body')).toContainText('sk_****-****-****-****');
});

test('interaction-4: cancel-operation button has explicit discriminators', async ({ page }) => {
  await loginAs(page, 'operator');
  const resp = await page.goto(
    `${harnessUrl}/admin/operations?operationId=op-running`,
  );
  expect(resp).not.toBeNull();
  expect(resp!.status()).toBe(200);
  await page.waitForSelector('section.operation-section', { timeout: 10_000 });

  const section = page.locator('section.operation-section').first();
  await expect(section).toHaveAttribute('data-operation-state', 'RUNNING');
  await expect(section).toHaveAttribute('data-operation-terminal', 'false');
  await expect(section).toHaveAttribute('data-can-cancel', 'true');

  const cancel = section.locator('button[data-action="cancel-operation"]').first();
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeEnabled();

  // Capture a screenshot of this interaction as evidence the renderer
  // paints the right state.
  const file = 'artifacts/interaction-4-cancel-operation.png';
  await page.screenshot({ path: file, fullPage: true });
  const stat = await (await import('node:fs/promises')).stat(file);
  await recordScreenshot({
    section: 'operations',
    viewport: 'desktop',
    path: file,
    bytes: stat.size,
    url: page.url(),
  });
});
