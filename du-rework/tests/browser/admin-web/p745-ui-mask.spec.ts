import fs from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * P745-UI-MASK-PW - real browser evidence for the Q2 reveal toggle.
 *
 * Closes the GAP in coordination/reports/p745-ui-mask-2026-10-04.md section 4:
 * jsdom / react-test-renderer / @testing-library are all unresolved in this
 * workspace, so the offline SSR run could only prove masked-by-default and that
 * the control exists - it could NOT prove a click flips it. This spec drives the
 * mounted ConnectorsScreen through the harness instead.
 *
 * Runner-confirmed infrastructure: tests/browser/admin-web/playwright.config.ts
 * + harness.ts. No runner, no dependency, no lockfile change. Needs the same
 * AWEB01B_URL / AWEB01B_TOKEN / AWEB01B_EVIDENCE as every sibling spec here.
 *
 * Scope: TEST ONLY. Production screens are UI_APPROVED and untouched by this packet.
 */

const BASE = process.env.AWEB01B_URL ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';

/** Single-line cURL, so no quoting and no shell continuation is involved. */
const SECRET = 'hiddenvalue1';
const PASTED =
  'curl -X POST https://api.vendor.example/v1/x' +
  ' -F author=Nguyen' +
  ' -F api_key=' + SECRET +
  ' -F model=gpt-4o';

test.describe('P745-UI-MASK reveal toggle (real browser)', () => {
  test.beforeAll(() => {
    if (!BASE || !TOKEN || !EVIDENCE) {
      throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB01B_EVIDENCE must be set');
    }
    fs.mkdirSync(join(EVIDENCE, 'p745-ui-mask'), { recursive: true });
  });

  const out = (name: string): string => join(EVIDENCE, 'p745-ui-mask', name);

  async function shot(page: Page, name: string): Promise<void> {
    await page.screenshot({ path: out(name), fullPage: true });
  }

  async function gotoConnectors(page: Page): Promise<void> {
    await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('input[name="token"]')).toBeVisible();
    await page.fill('input[name="token"]', TOKEN);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === '/admin');
    await page.goto(`${BASE}/admin/web/connectors`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Connectors', level: 1 })).toBeVisible();
  }

  test('1. masked by default, click reveals, click hides again', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await gotoConnectors(page);
    await page.getByRole('button', { name: 'Import cURL' }).click();
    await page.locator('textarea[aria-label="cURL command"]').fill(PASTED);

    const table = page.getByRole('table', { name: 'Imported form fields' });
    await expect(table).toBeVisible();

    // (a) masked by default: the preview table never carries the raw value.
    let html = await table.innerHTML();
    expect(html).not.toContain(SECRET);
    expect(html).toContain('****' + SECRET.slice(-4));
    // heuristic boundary: the unknown-name field stays visible for verification.
    expect(html).toContain('Nguyen');
    expect(html).toContain('gpt-4o');
    await expect(page.getByRole('button', { name: 'Show value for api_key' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide value for api_key' })).toHaveCount(0);
    await shot(page, '745-01-masked-by-default.png');

    // (b) click -> reveal.
    await page.getByRole('button', { name: 'Show value for api_key' }).click();
    await expect(page.getByRole('button', { name: 'Hide value for api_key' })).toBeVisible();
    html = await table.innerHTML();
    expect(html).toContain(SECRET);
    await expect(page.getByRole('button', { name: 'Show value for api_key' })).toHaveCount(0);
    await shot(page, '745-02-revealed.png');

    // (c) click again -> hidden again, and the mask is back.
    await page.getByRole('button', { name: 'Hide value for api_key' }).click();
    await expect(page.getByRole('button', { name: 'Show value for api_key' })).toBeVisible();
    html = await table.innerHTML();
    expect(html).not.toContain(SECRET);
    expect(html).toContain('****' + SECRET.slice(-4));
    await shot(page, '745-03-hidden-again.png');

    expect(errors).toEqual([]);
  });

  test('2. the header table offers no reveal control (hard rule)', async ({ page }) => {
    await gotoConnectors(page);
    await page.getByRole('button', { name: 'Import cURL' }).click();
    await page.locator('textarea[aria-label="cURL command"]').fill(
      'curl -X POST https://api.vendor.example/v1/x -H ' +
      String.fromCharCode(39) + 'content-type: application/json' + String.fromCharCode(39),
    );

    const headers = page.getByRole('table', { name: 'Imported headers' });
    await expect(headers).toBeVisible();
    // The header value is never rendered - only a character count.
    expect(await headers.innerHTML()).not.toContain('application/json');
    expect(await headers.innerHTML()).toContain('set (16 chars)');
    // No Reveal column at all on the header table.
    expect(await headers.locator('th').count()).toBe(2);
    await expect(headers.getByRole('button')).toHaveCount(0);
    await shot(page, '745-04-header-never-reveals.png');
  });
});
