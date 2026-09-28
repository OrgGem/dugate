/**
 * W48-O5(1) Admin route verification matrix.
 *
 * For each of the 6 Admin GET routes Claude Code landed in ADM-BASE-01
 * (`server.ts` 818 / 848 / 875 / 912 / 959 / 1010):
 *   - Drive the section fetchers through the REAL HTTP branch by
 *     pointing `jsonBaseUrl` at the in-process fixture server
 *     (`startVerifyHarness` in `../src/admin-mock`).
 *   - Log in as admin and navigate to the corresponding shell route.
 *   - Assert the rendered `<section class="<x>-section">` does NOT
 *     carry any `--not-found` / `--unauthorized` / `--error` modifier
 *     class (the renderer paints those onto the base class whenever
 *     a fetcher returns a failure `kind`).
 *   - Run axe-core; assert zero critical/serious violations.
 *
 * Gate (W48-O5(2) lifted 2026-09-24T18:58 by A6): the 6 Admin GET routes
 * are live on the platform (per `coordination/reports/claude.md`
 * "ADM-BASE-01 VERIFIED live 12:49 by A6" and W47-O2's live-pane
 * proof at 18:58 over real PG :5433 + Redis :6380 — pane ate row
 * `live-pane-biz-f3489126` with `data-version="1.0.0"`). Three
 * of the six are HONEST PLACEHOLDERS per W45-C1 (profile/connector/
 * audit return static envelopes — no revision/ledger/audit tables
 * exist), so the matrix covers well-formed envelopes across all 6
 * routes with the same "ok pane painted" assertion.
 *
 * Spec backend: `startVerifyHarness()` boots the SYNTHETIC fixture
 * server (`admin-mock.ts`) on `127.0.0.1:0` and points the REAL
 * platform fetchers at it via `jsonBaseUrl` — so the renderer
 * receives envelopes produced by REAL parser code (`parseFetchPayload`
 * in `*-section-data.js`) over REAL HTTP (the fixture listener),
 * with field-for-field shapes copied from `services/orchestrator/
 * dist/server.js`. NOT a live DB proof; still SYNTHETIC data, just
 * the W48-O5(2) skip gate is now correctly OFF because A6 confirmed
 * the platform would answer the same shapes.
 *
 * Every test attaches `synthetic:true` so any downstream reader
 * cannot mistake a green run for a live DB verification.
 *
 * NO DB. NO Redis. NO real platform HTTP.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  startVerifyHarness,
  ROUTE_PROBES,
} from '../src/admin-mock';
import type { VerifyHarnessHandle } from '../src/admin-mock';

const RUN_LIVE = true; // W48-O5(2) gate LIFTED 2026-09-24T18:58 by A6 (claude.md). Kept as a named constant for symmetry.

interface RouteMatrix {
  /** Internal id; matches the fixture `ROUTES[].id`. */
  id: string;
  /** Pathname the fixture asserted was hit. */
  probe: string;
  /** Path the user navigates to in the shell. */
  shellPath: string;
  /** Selector that must exist after navigation. */
  expectedSelector: string;
}

const MATRIX: readonly RouteMatrix[] = [
  {
    id: 'admin-businesses-list',
    probe: '/api/v1/admin/businesses',
    shellPath: '/admin/businesses',
    expectedSelector: 'section.business-section',
  },
  {
    id: 'admin-business-versions',
    probe: '/api/v1/admin/businesses/tenant-acme/versions',
    shellPath: '/admin/businesses?businessId=tenant-acme',
    expectedSelector: 'section.business-section',
  },
  {
    id: 'admin-profile',
    probe: '/api/v1/admin/profiles/tenant-acme/2026.09.01/extraction-default',
    shellPath:
      '/admin/profiles?businessId=tenant-acme&businessVersion=2026.09.01&profile=extraction-default',
    expectedSelector: 'section.profile-section',
  },
  {
    id: 'admin-connector-revision',
    probe: '/api/v1/admin/connectors/connector-rest-1/revisions/7',
    shellPath: '/admin/connectors?connectorId=connector-rest-1&revision=7',
    expectedSelector: 'section.connector-section',
  },
  {
    id: 'admin-api-keys',
    probe: '/api/v1/admin/api-keys',
    shellPath: '/admin/api-keys',
    expectedSelector: 'section.api-key-section',
  },
  {
    id: 'admin-audit',
    probe: '/api/v1/admin/audit',
    shellPath: '/admin/overview?tenantId=tenant-acme',
    // Audit is consumed by the overview section; there is no dedicated
    // `/admin/audit` route. The fixture confirms the platform GET
    // would have answered; the renderer must paint the section
    // without a failure modifier.
    expectedSelector: 'section.overview-section',
  },
];

let harnessUrl = '';
let harnessHandle: VerifyHarnessHandle | undefined;

test.beforeAll(async () => {
  const harness = await startVerifyHarness();
  harnessUrl = harness.url;
  harnessHandle = harness;
  // eslint-disable-next-line no-console
  console.log(
    `[W48-O5(1)] verify harness booted at ${harnessUrl} (mock at ${harness.mock.url})`,
  );
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

/** Failure modifier classes the renderer paints onto `<section class="X-section …">`. */
const FAILURE_MODIFIERS = ['--not-found', '--unauthorized', '--error', '--empty'] as const;
type FailureModifier = (typeof FAILURE_MODIFIERS)[number];

function isFailureModifier(className: string): FailureModifier | null {
  for (const m of FAILURE_MODIFIERS) {
    if (className.includes(m)) return m;
  }
  return null;
}

for (const route of MATRIX) {
  test.describe(`admin route=${route.id}`, () => {
    test('section renders data (no failure modifier) + axe clean @ admin-routes', async ({
      page,
    }, testInfo) => {
      testInfo.annotations.push({
        type: 'route-probe',
        description: route.probe,
      });
      testInfo.annotations.push({
        type: 'synthetic',
        description: 'true',
      });

      await loginAsAdmin(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${harnessUrl}${route.shellPath}`);
      await page.waitForSelector(route.expectedSelector, { timeout: 10_000 });

      // Read the rendered section's class list; fail loudly on any failure modifier.
      const classInfo = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { exists: false, className: '' };
        return { exists: true, className: el.className };
      }, route.expectedSelector);

      expect(classInfo.exists, `section ${route.expectedSelector} did not render`).toBe(true);

      const failure = isFailureModifier(classInfo.className);
      expect(
        failure,
        `route=${route.id} probe=${route.probe} painted failure modifier '${failure ?? ''}' ` +
          `(className='${classInfo.className}'). The fetcher returned a failure kind; ` +
          `the renderer's ok pane did not paint.`,
      ).toBeNull();

      // axe: critical/serious only.
      const axe = await new AxeBuilder({ page })
        .disableRules(['color-contrast'])
        .analyze();
      const criticalOrSerious = axe.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      );
      testInfo.attach('axe-summary', {
        body: JSON.stringify(
          {
            route: route.id,
            probe: route.probe,
            synthetic: true,
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
      expect(
        criticalOrSerious,
        `critical/serious axe violations on ${route.id}: ${JSON.stringify(
          criticalOrSerious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        )}`,
      ).toEqual([]);

      // Cross-check: the fixture server's request log records the
      // probe path — proves the shell actually hit it (vs a
      // catalog-side short-circuit). Run only when the harness was
      // booted (RUN_LIVE path).
      if (harnessHandle) {
        const requests = harnessHandle.mock.requests();
        const hit = requests.some((r) => r.includes(route.probe));
        expect(
          hit,
          `fixture server never received ${route.probe} (got: ${JSON.stringify(requests)})`,
        ).toBe(true);
      }
    });
  });
}

// Probe-table sanity: ROUTE_PROBES must contain every route in MATRIX.
// Keeps the spec honest if someone adds a probe to admin-mock without
// wiring a test for it (or vice-versa).
test('ROUTE_PROBES covers every matrix entry', () => {
  const probes = new Set(ROUTE_PROBES.map((p) => p.path));
  for (const r of MATRIX) {
    expect(probes.has(r.probe), `ROUTE_PROBES missing ${r.probe}`).toBe(true);
  }
});