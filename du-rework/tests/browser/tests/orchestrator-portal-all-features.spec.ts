/**
 * Orchestrator Portal — comprehensive UI E2E suite (desktop + mobile).
 *
 * Plan: docs/portal-ui-e2e-test-plan.md (PLAT-MIG-08B / Swagger slice dispatch).
 *
 * Runs against the real Orchestrator admin shell (`createAdminShellServer` via
 * tests/browser/admin-web/harness.ts) with the real Vite build of
 * apps/admin-web mounted at /admin/web and a scripted upstream stub. No DB, no
 * Redis, no live platform HTTP.
 *
 * Required env (supplied by tests/browser/scripts/run-portal-all-features.cjs
 * or any packet runner that boots the harness):
 *   PORTAL_E2E_URL                shell origin (e.g. http://127.0.0.1:41234)
 *   PORTAL_E2E_ADMIN_SESSION      du_session value for the platform-admin session
 *                                 (falls back to PORTAL_E2E_OPERATOR_SESSION)
 *   PORTAL_E2E_STUB               stub control origin (fixture modes)
 *   PORTAL_E2E_TENANT             operator tenant id (asserted in the UI)
 *
 * Every route asserts: main components rendered, console errors = 0,
 * horizontal overflow = 0, screenshot written, axe critical/serious = 0.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PORTAL_E2E_URL ?? '';
const STUB = process.env.PORTAL_E2E_STUB ?? '';
const SESSION =
  process.env.PORTAL_E2E_ADMIN_SESSION ?? process.env.PORTAL_E2E_OPERATOR_SESSION ?? '';
const TENANT = process.env.PORTAL_E2E_TENANT ?? '11111111-1111-4111-8111-111111111111';
const ARTIFACTS = path.resolve(__dirname, process.env.PORTAL_E2E_ARTIFACTS ?? '../artifacts');

interface RouteRecord {
  route: string;
  project: string;
  consoleErrors: string[];
  overflowPx: number;
  axeCritical: number;
  axeSerious: number;
  axeViolations: string[];
  screenshot: string;
  ok: boolean;
}

const RECORDS: RouteRecord[] = [];

test.beforeAll(() => {
  if (!BASE || !SESSION) {
    throw new Error(
      'PORTAL_E2E_URL and PORTAL_E2E_ADMIN_SESSION (or PORTAL_E2E_OPERATOR_SESSION) must be set; run tests/browser/scripts/run-portal-all-features.cjs',
    );
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });
});

test.afterAll(() => {
  const file = path.join(ARTIFACTS, 'portal-all-features-summary.json');
  let previous: RouteRecord[] = [];
  try {
    previous = (JSON.parse(fs.readFileSync(file, 'utf8')).routes ?? []) as RouteRecord[];
  } catch {
    /* first project of the run */
  }
  const merged = [
    ...previous.filter((p) => !RECORDS.some((r) => r.route === p.route && r.project === p.project)),
    ...RECORDS,
  ];
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        base: BASE,
        generatedAt: new Date().toISOString(),
        routes: merged,
        totals: {
          records: merged.length,
          failed: merged.filter((r) => !r.ok).length,
          consoleErrors: merged.reduce((sum, r) => sum + r.consoleErrors.length, 0),
          maxOverflowPx: merged.reduce((max, r) => Math.max(max, r.overflowPx), 0),
          axeCritical: merged.reduce((sum, r) => sum + r.axeCritical, 0),
          axeSerious: merged.reduce((sum, r) => sum + r.axeSerious, 0),
        },
      },
      null,
      2,
    ),
  );
});

/** Reset the harness stub to the fixture modes every route expects. */
async function resetStub(): Promise<void> {
  if (!STUB) return;
  await fetch(`${STUB}/__stub/mode?reset=1`);
  await fetch(
    `${STUB}/__stub/mode?profile=fixture&connectorMgmt=composed&connector=ok&connectorWrite=ok&testEndpoint=ok&crypto=ok`,
  );
}

function identitySnapshot(): unknown {
  return {
    users: [
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        username: 'operator-a',
        role: 'ADMIN',
        enabled: true,
        locked: false,
        createdAt: '2026-10-01T08:00:00.000Z',
        updatedAt: '2026-10-04T08:00:00.000Z',
        version: 3,
      },
      {
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        username: 'viewer-b',
        role: 'VIEWER',
        enabled: true,
        locked: false,
        createdAt: '2026-10-01T08:00:00.000Z',
        updatedAt: '2026-10-04T08:00:00.000Z',
        version: 1,
      },
    ],
    capabilities: { userWriter: false },
    auth: {
      mode: 'local',
      localEnabled: true,
      oidc: {
        issuer: 'https://idp.e2e.test',
        clientId: 'orchestrator-portal-e2e',
        callbackUrl: '/admin/oidc/callback',
        scopes: ['openid', 'profile', 'email'],
      },
    },
  };
}

/** Session cookie + the one BFF read without an upstream fixture (identity). */
async function prime(page: Page): Promise<void> {
  await page.context().addCookies([{ name: 'du_session', value: SESSION, url: BASE }]);
  await page.route('**/admin/api/identity**', async (route) => {
    const request = route.request();
    let pathname = '';
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = '';
    }
    if (request.method() === 'GET' && pathname === '/admin/api/identity') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(identitySnapshot()),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: JSON.stringify({ status: 404, code: 'NOT_FOUND', title: 'no identity route' }),
    });
  });
}

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location().url ?? '';
    if (url.includes('favicon.ico')) return;
    if (message.text().includes('favicon')) return;
    errors.push(`${message.text()} @ ${url}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function openRoute(page: Page, routePath: string): Promise<void> {
  await page.goto(`${BASE}/admin/web/${routePath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
}

async function finishRoute(
  page: Page,
  testInfo: TestInfo,
  id: string,
  errors: string[],
  overflow: number,
): Promise<RouteRecord> {
  let axeCritical = 0;
  let axeSerious = 0;
  let axeViolations: string[] = [];
  if (testInfo.project.name === 'desktop') {
    const axe = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze();
    axeCritical = axe.violations.filter((v) => v.impact === 'critical').length;
    axeSerious = axe.violations.filter((v) => v.impact === 'serious').length;
    axeViolations = axe.violations
      .filter((v) => v.impact === 'critical' || v.impact === 'serious')
      .map((v) => `${v.impact}:${v.id}:${v.nodes.length}`);
  }
  const screenshot = path.join(ARTIFACTS, `portal-${id}-${testInfo.project.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const record: RouteRecord = {
    route: id,
    project: testInfo.project.name,
    consoleErrors: errors,
    overflowPx: overflow,
    axeCritical,
    axeSerious,
    axeViolations,
    screenshot,
    ok: errors.length === 0 && overflow <= 1 && axeCritical === 0 && axeSerious === 0 && fs.existsSync(screenshot),
  };
  RECORDS.push(record);
  return record;
}

interface RouteCase {
  id: string;
  routePath: string;
  check: (page: Page) => Promise<void>;
}

async function runRouteCase(page: Page, testInfo: TestInfo, routeCase: RouteCase): Promise<void> {
  await resetStub();
  await prime(page);
  const errors = trackConsole(page);
  await openRoute(page, routeCase.routePath);
  await routeCase.check(page);
  const overflow = await overflowPx(page);
  const record = await finishRoute(page, testInfo, routeCase.id, errors, overflow);
  expect(errors, `[${routeCase.id}] console errors must be 0`).toEqual([]);
  expect(overflow, `[${routeCase.id}] horizontal overflow must be 0`).toBeLessThanOrEqual(1);
  expect(record.axeCritical, `[${routeCase.id}] axe critical must be 0`).toBe(0);
  expect(record.axeSerious, `[${routeCase.id}] axe serious must be 0`).toBe(0);
  expect(record.axeViolations, `[${routeCase.id}] axe critical/serious detail`).toEqual([]);
}

const REVOKE_DIALOG = () => 'Revoke API key';

const ROUTE_CASES: readonly RouteCase[] = [
  {
    id: 'overview',
    routePath: 'overview',
    check: async (page) => {
      await expect(page.locator('h1#overview-title')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Audit events' })).toBeVisible();
      await expect(page.getByText('admin.profile.publish', { exact: true })).toBeVisible();
      await expect(page.getByText('Usage rollup')).toBeVisible();
    },
  },
  {
    id: 'api-keys',
    routePath: 'api-keys',
    check: async (page) => {
      await expect(page.locator('h1#api-keys-title')).toBeVisible();
      await expect(page.getByRole('table', { name: 'API keys' })).toBeVisible();
      await expect(page.getByText('du_live_ab12')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Issue key' })).toBeVisible();
      // Revoke confirm dialog opens and cancels — no mutation is sent.
      await page.getByRole('button', { name: 'Revoke' }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(REVOKE_DIALOG())).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    },
  },
  {
    id: 'connectors',
    routePath: 'connectors',
    check: async (page) => {
      await expect(page.locator('h1#connectors-title')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Connectors' })).toBeVisible();
      await expect(page.getByText('vendor-extract').first()).toBeVisible();
      await page.getByRole('button', { name: 'Load' }).first().click();
      await expect(page.getByText('platform ledger')).toBeVisible();
      await expect(page.getByText('revision 1', { exact: true })).toBeVisible();
    },
  },
  {
    id: 'profiles',
    routePath: 'profiles',
    check: async (page) => {
      await expect(page.locator('h1#profiles-title')).toBeVisible();
      await expect(page.getByText('Profile selector')).toBeVisible();
      await page.getByLabel('businessId').fill('doc-core');
      await page.getByLabel('businessVersion').fill('3');
      await page.locator('#profile-name').fill('extract');
      await page.getByRole('button', { name: 'Load profile' }).click();
      await expect(page.getByText('doc-core@3 · extract')).toBeVisible();
      await expect(page.getByText('revision 7')).toBeVisible();
    },
  },
  {
    id: 'operations',
    routePath: 'operations',
    check: async (page) => {
      await expect(page.locator('h1#operations-title')).toBeVisible();
      const table = page.getByRole('table', { name: 'Operations' });
      await expect(table).toBeVisible();
      await table.getByRole('button').first().click();
      await expect(page.getByRole('heading', { name: 'Detail' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Operation artifacts' })).toBeVisible();
    },
  },
  {
    id: 'businesses',
    routePath: 'businesses',
    check: async (page) => {
      await expect(page.locator('h1#businesses-title')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Businesses' })).toBeVisible();
      await page.getByRole('button', { name: 'Versions' }).first().click();
      await expect(page.getByText('Versions — doc-core')).toBeVisible();
      await expect(page.getByRole('table', { name: 'Business versions' })).toBeVisible();
    },
  },
  {
    id: 'usage',
    routePath: 'usage',
    check: async (page) => {
      await expect(page.locator('h1#usage-title')).toBeVisible();
      await expect(page.getByText('Window')).toBeVisible();
      await expect(page.getByText('"requests": 12', { exact: false })).toBeVisible();
    },
  },
  {
    id: 'security',
    routePath: 'security',
    check: async (page) => {
      await expect(page.locator('h1#security-title')).toBeVisible();
      await expect(page.getByText('Tenant scope')).toBeVisible();
      await page.locator('#crypto-tenant').fill(TENANT);
      await page.getByRole('button', { name: 'Load configuration' }).click();
      await expect(page.getByText('Effective view')).toBeVisible();
      await expect(page.getByText('du-live-kek')).toBeVisible();
    },
  },
  {
    id: 'identity',
    routePath: 'identity',
    check: async (page) => {
      await expect(page.locator('h1#identity-title')).toBeVisible();
      await expect(page.getByText('Current session')).toBeVisible();
      await expect(page.getByText('Auth mode')).toBeVisible();
      await expect(page.getByText('OIDC metadata')).toBeVisible();
      await expect(page.getByText('Users & sessions')).toBeVisible();
      await expect(page.getByText('operator-a')).toBeVisible();
      await expect(page.getByText('idp.e2e.test')).toBeVisible();
    },
  },
  {
    id: 'settings',
    routePath: 'settings',
    check: async (page) => {
      await expect(page.locator('h1#settings-title')).toBeVisible();
      await expect(page.getByText('No settings wire on this build')).toBeVisible();
      await expect(page.getByText('Orchestrator Portal mount (DU_ADMIN_WEB)')).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Managed by' })).toBeVisible();
    },
  },
  {
    id: 'workflows',
    routePath: 'workflows',
    check: async (page) => {
      await expect(page.getByText('Workflows route is disabled')).toBeVisible();
      await expect(page.getByText('There are no workflows available in this preview mode.')).toBeVisible();
    },
  },
  {
    id: 'docs',
    routePath: 'docs',
    check: async (page) => {
      await expect(page.getByRole('heading', { name: 'API Docs + Test Workbench' })).toBeVisible();
      await expect(page.getByText('Endpoints')).toBeVisible();
      await expect(page.getByText('/actions')).toBeVisible();
    },
  },
  {
    id: 'api-docs',
    routePath: 'api-docs',
    check: async (page) => {
      await expect(page.locator('#api-docs-title')).toBeVisible();
      const rows = page.locator('ul[aria-label="OpenAPI operations"] li');
      await expect(rows).toHaveCount(57);
      await page.getByLabel('Search operations').fill('claim');
      await expect(rows).toHaveCount(1);
      await page.getByLabel('Search operations').fill('');
      await page.getByRole('button', { name: /^Public API \(12\)$/ }).click();
      await expect(rows).toHaveCount(12);
      await page.getByRole('button', { name: /^All \(57\)$/ }).click();
      await page.getByRole('button', { name: /POST \/api\/v1\/admin\/actions/ }).click();
      const detail = page.getByRole('region', { name: 'Operation detail' });
      await expect(detail.getByText('http://localhost:3002', { exact: false })).toBeVisible();
      await expect(page.getByText('Schemas (14)')).toBeVisible();
      await expect(page.getByText('Try-it-out is intentionally disabled', { exact: false })).toBeVisible();
    },
  },
  {
    id: 'not-found',
    routePath: 'this-route-does-not-exist',
    check: async (page) => {
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page.getByText('No Orchestrator Portal route matches this URL yet.')).toBeVisible();
    },
  },
];

for (const routeCase of ROUTE_CASES) {
  test(`${routeCase.id}: renders main components, console=0, overflow=0`, async ({ page }, testInfo) => {
    await runRouteCase(page, testInfo, routeCase);
  });
}

test('shell: branding, navigation and session header', async ({ page }, testInfo) => {
  await resetStub();
  await prime(page);
  const errors = trackConsole(page);
  await openRoute(page, 'overview');

  await expect(page).toHaveTitle('Orchestrator Portal');
  await expect(page.getByText('Orchestrator Portal', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Logout/ })).toBeVisible();

  const width = page.viewportSize()?.width ?? 1440;
  if (width < 768) {
    await expect(page.getByRole('navigation', { name: 'Orchestrator Portal Navigation' })).toBeHidden();
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  const nav = page.getByRole('navigation', { name: 'Orchestrator Portal Navigation' });
  await expect(nav).toBeVisible();
  for (const label of [
    'Overview',
    'Operations',
    'Usage',
    'Businesses',
    'Profiles',
    'Connectors',
    'Workflows',
    'API keys',
    'Security',
    'Identity',
    'Settings',
    'API Reference',
    'Documentation',
    'Bootstrap',
  ]) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  const overflow = await overflowPx(page);
  const record = await finishRoute(page, testInfo, 'shell', errors, overflow);
  expect(errors, '[shell] console errors must be 0').toEqual([]);
  expect(overflow, '[shell] horizontal overflow must be 0').toBeLessThanOrEqual(1);
  expect(record.axeCritical, '[shell] axe critical must be 0').toBe(0);
  expect(record.axeSerious, '[shell] axe serious must be 0').toBe(0);
});

test('responsive 768px: shell and data-heavy routes have no horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one 768px sweep is enough; runs in the desktop project');
  await page.setViewportSize({ width: 768, height: 900 });
  await resetStub();
  await prime(page);
  const errors = trackConsole(page);
  for (const routePath of ['overview', 'operations', 'businesses', 'api-keys', 'connectors', 'settings', 'api-docs']) {
    await openRoute(page, routePath);
    const overflow = await overflowPx(page);
    expect(overflow, `[768px ${routePath}] horizontal overflow must be 0`).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: path.join(ARTIFACTS, 'portal-responsive-768.png'), fullPage: true });
  expect(errors, '[768px sweep] console errors must be 0').toEqual([]);
});
