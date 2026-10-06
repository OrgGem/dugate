import fs from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * P745-UI-KEYS-JOURNEY - real browser journey for the profiles write flow.
 *
 * Open Profiles -> load a stored profile -> edit the policy -> Save (upsert) ->
 * Publish -> Rollback, asserting both the UI states and the exact dispatcher
 * wire bodies (the harness now records every profile.* write at /__stub/writes).
 *
 * Runner-confirmed infrastructure: tests/browser/admin-web/playwright.config.ts
 * + harness.ts. No runner, no dependency, no lockfile change. Needs the same
 * AWEB01B_URL / AWEB01B_EVIDENCE / AWEB03B_STUB / AWEB01B_TOKEN as every
 * sibling spec here. TEST ONLY: no production source is touched.
 *
 * GAP: this runs against the harness seam (stubbed Vault/S3/Postgres), not a
 * live stack. The live DB seed is not part of this packet.
 */

const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

/** The apiKeyId the harness fixture now surfaces on the profile detail read. */
const API_KEY_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

test.describe('P745-UI-KEYS journey (real browser)', () => {
  test.beforeAll(() => {
    if (!BASE || !EVIDENCE || !STUB || !TOKEN) {
      throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB03B_STUB / AWEB01B_TOKEN must be set');
    }
    fs.mkdirSync(join(EVIDENCE, 'p745-ui-keys-journey'), { recursive: true });
  });

  test.beforeEach(async () => {
    const response = await fetch(`${STUB}/__stub/mode?reset=1`);
    expect(response.ok).toBe(true);
  });

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(EVIDENCE, 'p745-ui-keys-journey', name), fullPage: true });
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

  test('1. edit policy -> save -> publish -> rollback, with wire bodies', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await setScenario('profile=fixture&profileWrite=ok');
    await loadProfile(page);
    await expect(page.getByText('revision 7')).toBeVisible();

    // Edit the policy value, then save (upsert).
    await page.getByLabel('value ai_model').fill('gpt-4o-mini');
    await page.getByRole('button', { name: 'Save extract' }).click();
    await expect(page.getByText('Saved — reloading the persisted revision.')).toBeVisible();
    await expect(page.getByText('revision 8', { exact: true })).toBeVisible();
    await shot(page, '745-01-saved-revision-8.png');

    // Publish.
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published (revision 9).')).toBeVisible();
    await expect(page.getByText('revision 9', { exact: true })).toBeVisible();
    await shot(page, '745-02-published-revision-9.png');

    // Rollback to the previous revision.
    await page.getByRole('button', { name: 'Rollback to v8' }).click();
    await expect(page.getByText('Rolled back (active revision 8).')).toBeVisible();
    await expect(page.getByText('revision 8', { exact: true })).toBeVisible();
    await shot(page, '745-03-rolled-back-revision-8.png');

    // The exact wire bodies the screen sent.
    const writes = (await (await fetch(`${STUB}/__stub/writes`)).json()).writes as Array<{
      action: string;
      params: Record<string, unknown>;
    }>;
    expect(writes.map((write) => write.action)).toEqual(['profile.upsert', 'profile.publish', 'profile.rollback']);

    const upsert = writes[0]!.params;
    expect(upsert['expectedRevision']).toBe(7);
    expect(upsert['apiKey']).toEqual({ apiKeyId: API_KEY_ID });
    expect(JSON.stringify(upsert['policy'])).toContain('gpt-4o-mini');

    const publish = writes[1]!.params;
    expect(publish['expectedRevision']).toBe(8);
    expect(publish['apiKey']).toEqual({ apiKeyId: API_KEY_ID });

    const rollback = writes[2]!.params;
    expect(rollback['targetRevision']).toBe(8);
    expect(rollback['expectedRevision']).toBe(9);
    expect(rollback['apiKey']).toEqual({ apiKeyId: API_KEY_ID });

    expect(errors).toEqual([]);
  });
});
