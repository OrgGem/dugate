/**
 * W47-O11 verification probe — counts DOM descendants inside
 * section.api-key-section for desktop and mobile, to prove the
 * pane is NOT empty after the shell + progressbar fixes.
 *
 * Standalone spec, runs in isolation; emits a single JSON line
 * to stdout via console.log, captured by the wrapper.
 *
 * NO DB, NO Redis, NO platform HTTP.
 */

import { test, expect } from '@playwright/test';
import { startHarness } from '../src/harness-server';
import type { HarnessHandle } from '../src/harness-server';

let harnessUrl = '';
let harnessHandle: HarnessHandle | undefined;

test.beforeAll(async () => {
  const harness = await startHarness();
  harnessUrl = harness.url;
  harnessHandle = harness;
});

test.afterAll(async () => {
  if (harnessHandle) await harnessHandle.close();
});

async function loginAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${harnessUrl}/admin/login`);
  await page.locator('input[name="token"]').fill('role:admin:harness-secret-token');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname.startsWith('/admin'));
}

interface PaneCounts {
  paneTextLen: number;
  paneOuterHTMLLen: number;
  totalDescendants: number;
  byTag: Record<string, number>;
}

async function probe(page: import('@playwright/test').Page): Promise<PaneCounts> {
  await page.goto(`${harnessUrl}/admin/api-keys`);
  await page.waitForSelector('section.api-key-section', { timeout: 10_000 });
  return page.evaluate(() => {
    const pane = document.querySelector('section.api-key-section');
    if (!pane) return { paneTextLen: 0, paneOuterHTMLLen: 0, totalDescendants: 0, byTag: { _error: 1 } };
    const all = pane.querySelectorAll('*');
    const byTag: Record<string, number> = {};
    // `querySelectorAll` returns `NodeListOf<Element>`; under the
    // `ES2022 + DOM` lib combo the iterator protocol is not picked
    // up, and `innerText` only exists on `HTMLElement`. Materialise
    // to a plain array and narrow to HTMLElement so the strict-TS
    // checks pass without dropping the count semantics.
    for (const el of Array.from(all) as HTMLElement[]) {
      byTag[el.tagName] = (byTag[el.tagName] ?? 0) + 1;
    }
    return {
      paneTextLen: (pane as HTMLElement).innerText.trim().length,
      paneOuterHTMLLen: pane.outerHTML.length,
      totalDescendants: all.length,
      byTag,
    };
  });
}

test('api-keys pane count desktop vs mobile', async ({ browser }) => {
  const desktopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dPage = await desktopCtx.newPage();
  await loginAsAdmin(dPage);
  const desktop = await probe(dPage);
  await desktopCtx.close();

  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobileCtx.newPage();
  await loginAsAdmin(mPage);
  const mobile = await probe(mPage);
  await mobileCtx.close();

  // eslint-disable-next-line no-console
  console.log(`[W47-O PROBE] api-keys pane counts: ${JSON.stringify({ desktop, mobile })}`);

  // Sanity gates: pane MUST have content (not empty)
  expect(desktop.totalDescendants, 'desktop api-keys pane is empty (false-green risk)').toBeGreaterThan(20);
  expect(mobile.totalDescendants, 'mobile api-keys pane is empty (false-green risk)').toBeGreaterThan(20);
});