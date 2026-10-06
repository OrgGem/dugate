import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * AWEB-04 — Profile vertical slice browser evidence.
 *
 * The harness stub serves the FROZEN Profile wire (placeholder + fixture modes)
 * and the dispatcher outcomes (missing/ok/conflict/locked400/partial). The real
 * backend (T-API-01..03) is not shipped yet, so the "missing writer" cases are
 * first-class evidence: the UI must show the honest 404, never a fake save.
 */
const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const VIEWER = process.env.AWEB03B_VIEWER ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

test.describe('AWEB-04 Profiles browser evidence (harness seam)', () => {
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
    await page.evaluate(() => window.scrollTo(0, 0));
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

  async function loadProfile(page: Page): Promise<void> {
    await loginAsAdmin(page);
    await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
    await page.fill('#profile-business', 'doc-core');
    await page.getByRole('button', { name: 'Load profile' }).click();
    await expect(page.getByText(/revision \d+/)).toBeVisible();
  }

  test('1. placeholder projection → honest "policy backend not shipped", actions disabled', async ({ page }) => {
    await loadProfile(page);
    await expect(page.getByText('revision 0')).toBeVisible();
    await expect(page.getByText('policy backend not shipped (T-API-01..03)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save all endpoints' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Test Endpoint' })).toBeDisabled();
    await expect(page.getByText('Preview requires backend')).toBeVisible();
    await shot(page, '04-01-placeholder-honest.png');
  });

  test('2. fixture + writer missing → 404 shown, draft kept, locked slot display-only', async ({ page }) => {
    await setScenario('profile=fixture');
    await loadProfile(page);
    await expect(page.getByText('revision 7')).toBeVisible();

    const locked = page.locator('input[data-locked="true"]');
    await expect(locked).toHaveCount(1);
    await expect(locked).toBeDisabled();
    await expect(locked).toHaveAttribute('readonly', '');

    await page.getByLabel('value ai_model').fill('gpt-4o-mini');
    await page.getByRole('button', { name: 'Save extract' }).click();
    await expect(page.getByText(/^404 · ACTION_NOT_FOUND/)).toBeVisible();
    await expect(page.getByLabel('value ai_model')).toHaveValue('gpt-4o-mini');
    await shot(page, '04-02-writer-missing-draft-kept.png');
  });

  test('3. fixture + writer ok → save persists, reload shows the new revision', async ({ page }) => {
    await setScenario('profile=fixture&profileWrite=ok');
    await loadProfile(page);
    await page.getByLabel('value ai_model').fill('gpt-4o-mini');
    await page.getByRole('button', { name: 'Save extract' }).click();
    await expect(page.getByText('Saved — reloading the persisted revision.')).toBeVisible();
    await expect(page.getByText('revision 8', { exact: true })).toBeVisible();
    await shot(page, '04-03-saved-revision-persisted.png');
  });

  test('4. stale revision (409) → conflict banner, draft survives', async ({ page }) => {
    await setScenario('profile=fixture&profileWrite=conflict');
    await loadProfile(page);
    await page.getByLabel('value ai_model').fill('gpt-4o-mini');
    await page.getByRole('button', { name: 'Save extract' }).click();
    await expect(page.getByText(/^409 · REVISION_CONFLICT/)).toBeVisible();
    await expect(page.getByText(/The stored revision moved/)).toBeVisible();
    await expect(page.getByLabel('value ai_model')).toHaveValue('gpt-4o-mini');
    await shot(page, '04-04-conflict-draft-kept.png');
  });

  test('5. locked-field 400 → explicit hint, draft survives', async ({ page }) => {
    await setScenario('profile=fixture&profileWrite=locked400');
    await loadProfile(page);
    await page.getByRole('button', { name: 'Save extract' }).click();
    await expect(page.getByText(/^400 · PROFILE_LOCKED_FIELD/)).toBeVisible();
    await expect(page.getByText(/locked slots must be omitted/)).toBeVisible();
    await shot(page, '04-05-locked-field-400.png');
  });

  test('6. bulk save → allSettled per-row results, no common rollback', async ({ page }) => {
    await setScenario('profile=fixture&profileWrite=partial');
    await loadProfile(page);
    // The frozen wire seeds ONE policy row; add a second row to prove the
    // per-row allSettled reporting (stub rejects any name except `extract`).
    await page.getByRole('button', { name: 'Add endpoint row' }).click();
    await page.getByLabel('row profile name').last().fill('compare');
    await page.getByRole('button', { name: 'Save all endpoints' }).click();
    await expect(page.getByText('Bulk save results (per row)')).toBeVisible();
    await expect(page.getByText(/extract: OK/)).toBeVisible();
    await expect(page.getByText(/compare: FAILED/)).toBeVisible();
    await shot(page, '04-06-bulk-partial.png');
  });

  test('7. viewer session → denied with the T-AUTH-03 gate reason', async ({ page }) => {
    await setScenario('profile=fixture');
    await page.context().addCookies([{ name: 'du_session', value: VIEWER, url: BASE }]);
    await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
    await page.fill('#profile-business', 'doc-core');
    await page.getByRole('button', { name: 'Load profile' }).click();
    await expect(page.getByText('Access denied')).toBeVisible();
    await expect(page.getByText(/VFY-LOCAL/)).toBeVisible();
    await shot(page, '04-07-viewer-denied.png');
  });

  test('8. Test Endpoint runs through the gated route → honest 404 while unshipped', async ({ page }) => {
    await setScenario('profile=fixture&testEndpoint=missing');
    await loadProfile(page);
    await page.getByRole('button', { name: 'Test Endpoint' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Run test' }).click();
    await expect(page.getByText('404 · NOT_FOUND')).toBeVisible();
    await shot(page, '04-08-test-endpoint-unshipped.png');
  });

  test('9. 320px: profiles reflows without horizontal overflow', async ({ page }) => {
    await setScenario('profile=fixture');
    await loadProfile(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.fill('#profile-business', 'doc-core');
    await page.getByRole('button', { name: 'Load profile' }).click();
    await expect(page.getByText(/revision \d+/)).toBeVisible();
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth + 1);
    await shot(page, '04-09-profiles-320px.png');
  });
});
