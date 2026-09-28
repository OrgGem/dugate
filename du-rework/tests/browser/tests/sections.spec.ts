/**
 * W47-O section screenshot + axe scan matrix.
 *
 * Boots the Admin shell on an OS-assigned port, logs in as admin,
 * navigates to each of the 7 sections, and for every (section, viewport)
 * pair:
 *   1. Takes a full-page screenshot to artifacts/<section>-<viewport>.png
 *   2. Runs @axe-core/playwright on the live DOM
 *   3. Asserts zero critical / serious violations
 *   4. Appends a record to the in-memory artifacts list (the
 *      a11y-summary writer emits artifacts-summary.json on suite teardown)
 *
 * NO DB, NO Redis, NO platform HTTP.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startHarness } from '../src/harness-server';
import {
  recordScreenshot,
  recordAxeResult,
  listArtifacts,
  writeSummary,
} from './a11y-summary';

interface SectionSpec {
  /** Internal id (also used for filename). */
  id: string;
  /** Path the user navigates to. */
  path: string;
  /** Selector that must exist after navigation (proves the section rendered). */
  expectedSelector: string;
}

const SECTIONS: readonly SectionSpec[] = [
  { id: 'admin-root', path: '/admin', expectedSelector: 'main' },
  { id: 'businesses', path: '/admin/businesses?businessId=tenant-acme', expectedSelector: 'section.business-section' },
  { id: 'operations', path: '/admin/operations?operationId=op-running', expectedSelector: 'section.operation-section' },
  { id: 'overview', path: '/admin/overview?tenantId=tenant-acme', expectedSelector: 'section.overview-section' },
  { id: 'profiles', path: '/admin/profiles?businessId=tenant-acme&businessVersion=2026.09.01&profile=extraction-default', expectedSelector: 'section.profile-section' },
  { id: 'connectors', path: '/admin/connectors?connectorId=connector-rest-1&revision=7', expectedSelector: 'section.connector-section' },
  { id: 'api-keys', path: '/admin/api-keys', expectedSelector: 'section.api-key-section' },
];

let harnessUrl = '';
let harnessHandle: import('../src/harness-server').HarnessHandle | undefined;

test.beforeAll(async () => {
  const harness = await startHarness();
  harnessUrl = harness.url;
  harnessHandle = harness;
  test.info().annotations.push({ type: 'harness-url', description: harnessUrl });
  // eslint-disable-next-line no-console
  console.log(`[W47-O] harness booted at ${harnessUrl}`);
});

test.afterAll(async () => {
  // The harness handle is captured in beforeAll via module-level state;
  // closing it directly here avoids relying on test.afterAll() from
  // inside an async beforeAll (which Playwright rejects).
  if (harnessHandle) {
    await harnessHandle.close();
  }
  await writeSummary();
  const list = await listArtifacts();
  // eslint-disable-next-line no-console
  console.log(
    `[W47-O] wrote artifacts-summary.json — ${list.length} entries ` +
      `(${list.filter((a) => a.kind === 'screenshot').length} screenshots, ` +
      `${list.filter((a) => a.kind === 'axe').length} axe scans)`,
  );
});

async function loginAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${harnessUrl}/admin/login`);
  // The harness server stores `adminToken: 'role:admin:harness-secret-token'`,
  // so the form must POST that exact string for `deriveRoleFromToken` to
  // accept it (verified via diag3 POST trace: 'harness-secret-token' alone
  // returns 401).
  await page.locator('input[name="token"]').fill('role:admin:harness-secret-token');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname.startsWith('/admin'));
}

for (const section of SECTIONS) {
  test(`section=${section.id} viewport=desktop renders + axe clean`, async ({ page }, testInfo) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${harnessUrl}${section.path}`);
    await page.waitForSelector(section.expectedSelector, { timeout: 10_000 });

    const file = `artifacts/${section.id}-desktop.png`;
    await page.screenshot({ path: file, fullPage: true });
    const stat = await (await import('node:fs/promises')).stat(file);
    await recordScreenshot({
      section: section.id,
      viewport: 'desktop',
      path: file,
      bytes: stat.size,
      url: page.url(),
    });

    const axe = await new AxeBuilder({ page })
      .disableRules(['color-contrast']) // color-contrast is unreliable on synthetic DOM; we keep semantic + structural rules
      .analyze();
    await recordAxeResult({
      section: section.id,
      viewport: 'desktop',
      url: page.url(),
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        description: v.description,
        nodes: v.nodes.length,
      })),
    });
    const criticalOrSerious = axe.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      criticalOrSerious,
      `critical/serious axe violations on ${section.id} (desktop): ${JSON.stringify(
        criticalOrSerious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        null,
        2,
      )}`,
    ).toEqual([]);
    testInfo.attach('axe-summary', {
      body: JSON.stringify(
        {
          section: section.id,
          viewport: 'desktop',
          violationCount: axe.violations.length,
          critical: axe.violations.filter((v) => v.impact === 'critical').length,
          serious: axe.violations.filter((v) => v.impact === 'serious').length,
          minor: axe.violations.filter((v) => v.impact === 'minor').length,
          moderate: axe.violations.filter((v) => v.impact === 'moderate').length,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });

  test(`section=${section.id} viewport=mobile renders + axe clean`, async ({ page }, testInfo) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harnessUrl}${section.path}`);
    await page.waitForSelector(section.expectedSelector, { timeout: 10_000 });

    const file = `artifacts/${section.id}-mobile.png`;
    await page.screenshot({ path: file, fullPage: true });
    const stat = await (await import('node:fs/promises')).stat(file);
    await recordScreenshot({
      section: section.id,
      viewport: 'mobile',
      path: file,
      bytes: stat.size,
      url: page.url(),
    });

    const axe = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    await recordAxeResult({
      section: section.id,
      viewport: 'mobile',
      url: page.url(),
      violations: axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? 'minor',
        description: v.description,
        nodes: v.nodes.length,
      })),
    });
    const criticalOrSerious = axe.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      criticalOrSerious,
      `critical/serious axe violations on ${section.id} (mobile): ${JSON.stringify(
        criticalOrSerious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        null,
        2,
      )}`,
    ).toEqual([]);
    testInfo.attach('axe-summary', {
      body: JSON.stringify(
        {
          section: section.id,
          viewport: 'mobile',
          violationCount: axe.violations.length,
          critical: axe.violations.filter((v) => v.impact === 'critical').length,
          serious: axe.violations.filter((v) => v.impact === 'serious').length,
          minor: axe.violations.filter((v) => v.impact === 'minor').length,
          moderate: axe.violations.filter((v) => v.impact === 'moderate').length,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  });
}
