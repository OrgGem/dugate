import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

/**
 * BIZ-09 — Business Detail Cockpit browser evidence.
 *
 * What each case pins, and why:
 *  1. all four cards render values that came from four DIFFERENT reads, with the
 *     server's own state and health columns (a client-side health rule would
 *     make this pass with no real data);
 *  2. every card states when it was sampled — a number without a sample time
 *     reads as a current fact;
 *  3. one failing read leaves the other three rendering (independent error
 *     boundaries) — this is the case that fails loudly if a single page-level
 *     error state is ever introduced;
 *  4. an empty read says so in words; it must never read as a table of zeroes.
 */

const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';

// The harness is started by the packet runner (run-browser-harness.ps1), which
// writes harness.json and exports these env vars. A module import is not
// possible: harness.ts is a standalone script, not an export.
const EVIDENCE_DIR = EVIDENCE;

function setScenario(query: string): Promise<unknown> {
  return fetch(`${STUB}/__stub/mode?${query}`).then((r) => r.json());
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/admin');
}

/** Open the cockpit the way an operator does: Businesses -> Versions on a row. */
async function openCockpit(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto(`${BASE}admin/businesses`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Versions' }).first().click();
  await expect(page.getByRole('heading', { name: /^Detail for / })).toBeVisible();
}

test('1. four cards render four reads, with the server state and health columns', async ({ page }) => {
  // Every scenario named: the harness state persists BETWEEN tests, so an
  // unnamed knob would inherit whatever the previous test left behind.
  await setScenario('biz=rows&workers=rows&profiles=rows&profileWorkflows=rows');
  await openCockpit(page);
  // Scope to the cockpit: the Businesses screen renders its OWN versions table
  // directly above it, and both carry the aria-label Business versions.
  const cockpit = page.getByRole('region', { name: /^Detail for / });

  await expect(cockpit.getByRole('table', { name: 'Business versions' })).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Worker instances' })).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Profiles of this business' })).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Workflow schema bindings' })).toBeVisible();

  // Worker rows carry BOTH the server state and the server health verdict.
  await expect(cockpit.getByRole('cell', { name: 'worker-a' })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'worker-b' })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'HEALTHY', exact: true })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'DEGRADED', exact: true })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'ONLINE', exact: true })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'DRAINING', exact: true })).toBeVisible();

  // A profile whose revision is 0 is rendered `unsaved`, never as revision 0.
  await expect(cockpit.getByRole('cell', { name: 'unsaved', exact: true })).toBeVisible();

  // Binding state and schema status are separate columns.
  await expect(cockpit.getByRole('cell', { name: 'enabled', exact: true })).toBeVisible();
  await expect(cockpit.getByRole('cell', { name: 'not bound', exact: true })).toBeVisible();

  await shot(page, 'biz09-01-cockpit-four-cards.png');
});

test('2. every card states its sample time', async ({ page }) => {
  await setScenario('biz=rows');
  await openCockpit(page);

  // The worker card shows the PAGE sample; the others show the newest row
  // timestamp their payload carries, because their payloads carry none.
  await expect(page.getByText('sampled 2026-10-11T02:00:06.000Z').first()).toBeVisible();
  await expect(page.getByText('sampled 2026-10-10T12:00:00.000Z').first()).toBeVisible();
  await expect(page.getByText('sampled 2026-10-02T09:00:00.000Z').first()).toBeVisible();

  await shot(page, 'biz09-02-sample-times.png');
});

test('3. one failing read leaves the other three rendering (independent boundaries)', async ({ page }) => {
  await setScenario('biz=rows&workers=error&profiles=rows&profileWorkflows=rows');
  await openCockpit(page);
  const cockpit = page.getByRole('region', { name: /^Detail for / });

  // The failed card renders the fail-closed state (ErrorState = role=alert
  // carrying the status) and NO table. It never degrades to an empty table.
  await expect(cockpit.getByRole('alert')).toBeVisible();
  await expect(cockpit.getByText('500')).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Worker instances' })).toHaveCount(0);
  // ...and the other three are untouched.
  await expect(cockpit.getByRole('table', { name: 'Business versions' })).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Profiles of this business' })).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Workflow schema bindings' })).toBeVisible();

  await shot(page, 'biz09-03-independent-error-boundary.png');
});

test('4. an empty read says so in words, never as a table of zeroes', async ({ page }) => {
  // workers and workflows are named because test 3 left workers=error.
  await setScenario('biz=rows&workers=rows&profiles=empty&profileWorkflows=rows');
  await openCockpit(page);
  const cockpit = page.getByRole('region', { name: /^Detail for / });

  await expect(cockpit.getByText('No profile rows for this business.')).toBeVisible();
  await expect(cockpit.getByRole('table', { name: 'Profiles of this business' })).toHaveCount(0);
  // The neighbouring cards still render their own answers.
  await expect(cockpit.getByRole('table', { name: 'Worker instances' })).toBeVisible();

  await shot(page, 'biz09-04-empty-is-not-zero.png');
});
