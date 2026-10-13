import fs from 'node:fs';
import { join, relative } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.AWEB01B_URL ? `${process.env.AWEB01B_URL.replace(/\/+$/, '')}/` : '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const STUB = process.env.AWEB03B_STUB ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const OPERATOR = process.env.AWEB03B_OPERATOR ?? '';
const TENANT = process.env.AWEB03B_TENANT ?? '';

const VIEWPORTS = [
  { width: 1440, height: 1000 },
  { width: 768, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 800 },
] as const;

type Scheme = 'light' | 'dark';

interface LayoutEvidence {
  route: string;
  width: number;
  height: number;
  scheme: Scheme;
  headingVisible: boolean;
  documentWidth: number;
  viewportWidth: number;
  documentHeight: number;
  canvasColor: string;
  iconTextButtonCount: number;
  iconTextButtonIssues: string[];
  screenshot: string;
}

interface InteractionEvidence {
  scenario: string;
  passed: boolean;
  details: Record<string, unknown>;
}

const layoutEvidence: LayoutEvidence[] = [];
const interactionEvidence: InteractionEvidence[] = [];
const ALT_TENANT = '22222222-2222-4222-8222-222222222222';

function recordInteraction(scenario: string, details: Record<string, unknown>): void {
  interactionEvidence.push({ scenario, passed: true, details });
}

function requireHarness(): void {
  if (!BASE || !EVIDENCE || !STUB || !TOKEN || !OPERATOR || !TENANT) {
    throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN / AWEB03B_{STUB,OPERATOR,TENANT} must be set');
  }
  fs.mkdirSync(EVIDENCE, { recursive: true });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.locator('input[name="token"]').fill(TOKEN);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/admin');
}

async function resetStub(): Promise<void> {
  const response = await fetch(`${STUB}/__stub/mode?reset=1`);
  expect(response.ok).toBe(true);
}

async function installPagedOperationsFixture(page: Page): Promise<{ requests: string[]; longId: string }> {
  const requests: string[] = [];
  const longId = `ux-operation-${'identifier-'.repeat(10)}`;
  const longBusiness = `business-${'segment-without-spaces-'.repeat(22)}`;
  const longCorrelation = `correlation-${'opaque-value-'.repeat(24)}`;
  const longJson = `unbroken-json-value-${'x'.repeat(3200)}`;

  await page.route(/\/admin\/api\/operations(?:\/|\?|$)/, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === '/admin/api/operations') {
      const cursor = url.searchParams.get('cursor');
      requests.push(cursor ?? 'first-page');
      const pageNumber = cursor === 'next-operations' ? 1 : 0;
      const items = Array.from({ length: 20 }, (_, index) => {
        const row = index + 1;
        return {
          id: pageNumber === 0 && row === 1 ? longId : `ux-operation-${pageNumber}-${String(row).padStart(2, '0')}`,
          state: 'FAILED',
          tenantId: TENANT,
          businessId: pageNumber === 0 && row === 1 ? longBusiness : 'document-core',
          action: `page-${pageNumber}-row-${row}`,
          createdAt: '2026-10-11T02:00:00.000Z',
          updatedAt: '2026-10-11T02:01:00.000Z',
          errorCode: pageNumber === 0 && row === 1 ? 'PROVIDER_OUTCOME_UNKNOWN' : null,
        };
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          total: 40,
          limit: 20,
          nextCursor: pageNumber === 0 ? 'next-operations' : null,
          prevCursor: pageNumber === 1 ? 'first-operations' : null,
        }),
      });
      return;
    }
    if (url.pathname.startsWith('/admin/api/operations/') && url.pathname !== '/admin/api/operations/metrics') {
      const requestedId = decodeURIComponent(url.pathname.slice('/admin/api/operations/'.length));
      requests.push(`detail:${requestedId}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          operation: {
            id: longId,
            state: 'FAILED',
            tenantId: TENANT,
            businessId: longBusiness,
            action: 'extract',
            createdAt: '2026-10-11T02:00:00.000Z',
            updatedAt: '2026-10-11T02:01:00.000Z',
            errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
          },
          result: { payload: longJson, correlationId: longCorrelation },
          artifacts: [{ role: 'output', status: 'READY', downloadUrl: '/admin/api/artifacts/ux-output', contentType: 'application/json' }],
          serverNow: '2026-10-11T02:02:00.000Z',
          correlationId: longCorrelation,
        }),
      });
      return;
    }
    await route.continue();
  });
  return { requests, longId };
}

async function installTenantRosterFixture(page: Page): Promise<void> {
  await page.route('**/admin/api/tenants*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          { id: TENANT, name: 'UX Tenant A', state: 'ACTIVE', createdAt: '2026-10-01T00:00:00.000Z' },
          { id: ALT_TENANT, name: 'UX Tenant B', state: 'ACTIVE', createdAt: '2026-10-02T00:00:00.000Z' },
        ],
        nextCursor: null,
        prevCursor: null,
        total: 2,
        limit: 100,
      }),
    });
  });
}

function secretEntry(tenantId: string, index: number, prefix: string): Record<string, unknown> {
  return {
    catalogVersion: 1,
    secretId: `${prefix}-secret-${index}`,
    tenantId,
    name: `${prefix} secret ${String(index).padStart(2, '0')}`,
    purpose: 'generic',
    services: ['orchestrator'],
    provider: { kind: 'managed_value' },
    state: 'ACTIVE',
    revision: 1,
    valueConfigured: true,
    usageReferences: [],
  };
}

function secretPage(tenantId: string, page: 0 | 1, prefix: string): Record<string, unknown> {
  return {
    items: Array.from({ length: 50 }, (_, index) => secretEntry(tenantId, page * 50 + index + 1, prefix)),
    nextCursor: page === 0 ? `${prefix}-next` : null,
  };
}

async function installPagedSecretFixture(page: Page, requests: string[]): Promise<void> {
  await page.route('**/admin/api/secrets*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== '/admin/api/secrets') return route.continue();
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const cursor = url.searchParams.get('cursor');
    requests.push(`${tenantId}:${cursor ?? 'first'}`);
    const isTenantB = tenantId === ALT_TENANT;
    const prefix = isTenantB ? 'Tenant B' : 'Tenant A';
    const pageIndex = cursor === `${prefix}-next` ? 1 : 0;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(secretPage(tenantId, pageIndex as 0 | 1, prefix)),
    });
  });
}

async function captureLayout(page: Page, route: string, width: number, height: number, scheme: Scheme, name: string): Promise<LayoutEvidence> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${BASE}admin/${route}`, { waitUntil: 'networkidle' });
  const shotPath = join(EVIDENCE, name);
  await page.screenshot({ path: shotPath, fullPage: false, animations: 'disabled' });
  const headingVisible = await page.getByRole('heading', { name: 'Operations', exact: true }).isVisible();
  const measured = await page.evaluate(() => {
    const iconTextButtonIssues: string[] = [];
    let iconTextButtonCount = 0;
    for (const [index, button] of Array.from(document.querySelectorAll('button')).entries()) {
      const buttonRect = button.getBoundingClientRect();
      const icon = button.querySelector('svg');
      if (buttonRect.width === 0 || buttonRect.height === 0 || !icon || button.innerText.trim() === '') continue;
      const iconRect = icon.getBoundingClientRect();
      if (iconRect.width === 0 || iconRect.height === 0) continue;
      iconTextButtonCount++;
      const textRects: DOMRect[] = [];
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNode(node);
          textRects.push(...Array.from(range.getClientRects()));
        }
        node = walker.nextNode();
      }
      const iconCenter = iconRect.top + iconRect.height / 2;
      const stackedOrOverlapping = textRects.some((textRect) => {
        const textCenter = textRect.top + textRect.height / 2;
        const verticallySeparated = Math.abs(textCenter - iconCenter) > Math.max(iconRect.height, textRect.height) * 0.65;
        const horizontallySeparated = textRect.left >= iconRect.right - 1 || textRect.right <= iconRect.left + 1;
        return verticallySeparated || !horizontallySeparated;
      });
      if (stackedOrOverlapping) iconTextButtonIssues.push(`button ${index}: ${button.innerText.trim().replace(/\s+/g, ' ')}`);
    }
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      canvasColor: getComputedStyle(document.documentElement).getPropertyValue('--bg-canvas').trim(),
      iconTextButtonCount,
      iconTextButtonIssues,
    };
  });
  const evidence: LayoutEvidence = {
    route: `/admin/${route}`,
    width,
    height,
    scheme,
    headingVisible,
    ...measured,
    screenshot: relative(process.cwd(), shotPath).replace(/\\/g, '/'),
  };
  layoutEvidence.push(evidence);
  fs.writeFileSync(join(EVIDENCE, 'frontend-browser-geometry.json'), `${JSON.stringify(layoutEvidence, null, 2)}\n`);
  return evidence;
}

test.describe('Frontend UX verification against the isolated Admin shell', () => {
  test.beforeAll(() => requireHarness());

  test.afterAll(() => {
    if (EVIDENCE && layoutEvidence.length > 0) {
      fs.writeFileSync(join(EVIDENCE, 'frontend-browser-geometry.json'), `${JSON.stringify(layoutEvidence, null, 2)}\n`);
    }
    if (EVIDENCE) {
      fs.writeFileSync(join(EVIDENCE, 'frontend-browser-interactions.json'), `${JSON.stringify(interactionEvidence, null, 2)}\n`);
    }
  });

  test('route navigation keeps deep links, semantic link navigation, and operator gates', async ({ page, browser }) => {
    await resetStub();
    await loginAsAdmin(page);

    await page.goto(`${BASE}admin/security`, { waitUntil: 'networkidle' });
    const accessNav = page.getByRole('navigation', { name: 'Access and security pages' });
    await expect(accessNav.getByRole('link', { name: 'Identity', exact: true })).toBeVisible();
    await expect(accessNav.getByRole('link', { name: 'Secrets', exact: true })).toBeVisible();
    await expect(accessNav.getByRole('link', { name: 'Identity', exact: true })).toHaveAttribute('href', /identity$/);
    await accessNav.getByRole('link', { name: 'Identity', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/identity$/);
    await expect(page.getByRole('heading', { name: 'Identity', exact: true })).toBeVisible();

    await page.goto(`${BASE}admin/system-operations/workers-queues`, { waitUntil: 'networkidle' });
    const systemNav = page.getByRole('navigation', { name: 'System operations pages' });
    await expect(systemNav.getByRole('link', { name: 'Workers & Queues', exact: true })).toBeVisible();
    await expect(systemNav.getByRole('link', { name: 'Incidents', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/system-operations\/workers-queues$/);

    await page.goto(`${BASE}admin/docs`, { waitUntil: 'networkidle' });
    const resourceNav = page.getByRole('navigation', { name: 'Resource pages' });
    await expect(resourceNav.getByRole('link', { name: 'API Reference', exact: true })).toBeVisible();
    await expect(resourceNav.getByRole('link', { name: 'Documentation', exact: true })).toBeVisible();
    await resourceNav.getByRole('link', { name: 'Documentation', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/docs$/);

    const operatorContext = await browser.newContext();
    const operatorPage = await operatorContext.newPage();
    await operatorPage.context().addCookies([{ name: 'du_session', value: OPERATOR, url: BASE }]);
    await operatorPage.goto(`${BASE}admin/businesses`, { waitUntil: 'networkidle' });
    await expect(operatorPage.getByText('Access denied')).toBeVisible();
    await expect(operatorPage.getByText(/platform-scoped/i)).toBeVisible();
    await operatorContext.close();
  });

  test('operations uses cursor pages, compact bounded results, and stays responsive', async ({ page }) => {
    test.setTimeout(30_000);
    await resetStub();
    const { requests, longId } = await installPagedOperationsFixture(page);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.includes('/admin/api/operations')) {
        requests.push(`wire:${request.method()}:${url.pathname}${url.search}`);
      }
    });
    await loginAsAdmin(page);
    await page.goto(`${BASE}admin/operations`, { waitUntil: 'networkidle' });

    const table = page.getByRole('table', { name: 'Operations' });
    const region = page.getByRole('region', { name: 'Operations results' });
    const pagination = page.getByRole('navigation', { name: 'Operations list pagination' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(21);
    await expect(page.getByText(/20 shown\s*·\s*40 total/)).toBeVisible();
    await expect(pagination).toBeVisible();
    await expect(region).toHaveAttribute('tabindex', '0');
    await region.focus();
    await expect(region).toBeFocused();
    expect(await pagination.evaluate((element) => element.closest('[aria-label="Operations results"]') === null)).toBe(true);

    const firstBounds = await region.evaluate((element) => {
      const header = element.querySelector('thead')?.getBoundingClientRect();
      const row = element.querySelector('tbody tr')?.getBoundingClientRect();
      return {
        height: element.getBoundingClientRect().height,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
        headerTop: header?.top ?? null,
        rowHeight: row?.height ?? null,
        rowHeights: Array.from(element.querySelectorAll('tbody tr')).slice(0, 3).map((item) => ({
          height: item.getBoundingClientRect().height,
          text: item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        })),
      };
    });
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-operations-density-1440.png'), fullPage: false, animations: 'disabled' });
    fs.writeFileSync(join(EVIDENCE, 'frontend-browser-operations-measurement.json'), `${JSON.stringify(firstBounds, null, 2)}\n`);
    expect(firstBounds.scrollHeight).toBeGreaterThan(firstBounds.clientHeight);
    expect(firstBounds.height).toBeLessThanOrEqual(0.65 * 1000 + 2);
    expect(firstBounds.maxHeight).toBeLessThanOrEqual(0.65 * 1000 + 2);
    expect(firstBounds.rowHeight ?? 99).toBeLessThan(60);
    const headerBefore = await region.locator('thead').boundingBox();
    await region.evaluate((element) => { element.scrollTop = 180; });
    await page.waitForTimeout(60);
    const headerAfter = await region.locator('thead').boundingBox();
    expect(headerBefore).not.toBeNull();
    expect(headerAfter).not.toBeNull();
    expect(Math.abs((headerAfter?.y ?? 999) - (headerBefore?.y ?? 0))).toBeLessThanOrEqual(2);

    const lightAndDarkColors = new Map<string, string>();
    const matrixIssues: string[] = [];
    for (const width of VIEWPORTS) {
      for (const scheme of ['light', 'dark'] as const) {
        try {
          const evidence = await captureLayout(
            page,
            'operations',
            width.width,
            width.height,
            scheme,
            `frontend-browser-operations-${width.width}-${scheme}.png`,
          );
          lightAndDarkColors.set(scheme, evidence.canvasColor);
          if (!evidence.headingVisible) matrixIssues.push(`${width.width}px ${scheme}: Operations heading is missing`);
          if (evidence.documentWidth > evidence.viewportWidth + 1) matrixIssues.push(`${width.width}px ${scheme}: document overflow ${evidence.documentWidth}/${evidence.viewportWidth}`);
          if (evidence.iconTextButtonIssues.length > 0) matrixIssues.push(`${width.width}px ${scheme}: icon/text controls stacked or overlap: ${evidence.iconTextButtonIssues.join(', ')}`);
          const nextBounds = await page.getByRole('button', { name: 'Next page', exact: true }).boundingBox();
          if (!nextBounds) matrixIssues.push(`${width.width}px ${scheme}: Next page control is not visible`);
          else if (nextBounds.x < 0 || nextBounds.x + nextBounds.width > evidence.viewportWidth + 1) matrixIssues.push(`${width.width}px ${scheme}: Next page control is outside the viewport`);
        } catch (cause) {
          matrixIssues.push(`${width.width}px ${scheme}: screenshot or geometry capture failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
    expect(layoutEvidence.filter((item) => item.route === '/admin/operations')).toHaveLength(8);
    expect(matrixIssues).toEqual([]);
    expect(lightAndDarkColors.get('light')).not.toBe(lightAndDarkColors.get('dark'));

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`${BASE}admin/operations`, { waitUntil: 'networkidle' });
    await expect(table.getByText('page-0-row-1', { exact: true })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Next page', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => requests, { timeout: 5_000 }).toContain('next-operations');
    await expect(table.getByText('page-1-row-1', { exact: true })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(21);
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(table.getByText('page-0-row-1', { exact: true })).toBeVisible();

    await table.getByRole('button', { name: 'Detail', exact: true }).first().click();
    fs.writeFileSync(join(EVIDENCE, 'frontend-browser-operations-wire-requests.json'), `${JSON.stringify(requests, null, 2)}\n`);
    await expect(page.getByRole('heading', { name: 'Operation Details', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('outcome is unknown');
    expect(requests).toContain(`detail:${longId}`);
    await expect(page.getByRole('button', { name: 'Retry', exact: true }).last()).toBeDisabled();

  });

  test('long account names and Trace validation errors stay aligned without page overflow', async ({ page }) => {
    await resetStub();
    const longDisplayName = 'Operations Administrator with a deliberately long account display name for 320 pixel phones';
    await page.route('**/admin/api/session', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const upstream = await route.fetch();
      const session = await upstream.json() as Record<string, unknown>;
      await route.fulfill({
        response: upstream,
        body: JSON.stringify({ ...session, displayName: longDisplayName }),
      });
    });
    await loginAsAdmin(page);

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${BASE}admin/operations`, { waitUntil: 'networkidle' });
    const accountButton = page.locator('header button').filter({ hasText: '· Profile' }).first();
    const logout = page.getByRole('button', { name: 'Logout', exact: true });
    await expect(accountButton).toBeVisible();
    await expect(logout).toBeVisible();
    const accountBounds = await page.evaluate(() => {
      const header = document.querySelector('header');
      const account = Array.from(document.querySelectorAll('header button')).find((button) => button.textContent?.includes('· Profile'));
      const logout = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Logout');
      const accountSpan = account?.querySelector('span');
      const accountRect = account?.getBoundingClientRect();
      const logoutRect = logout?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        headerWidth: header?.getBoundingClientRect().width ?? 0,
        accountWidth: accountRect?.width ?? 0,
        accountRight: accountRect?.right ?? 0,
        logoutLeft: logoutRect?.left ?? 0,
        logoutRight: logoutRect?.right ?? 0,
        displayNameClientWidth: accountSpan?.clientWidth ?? 0,
        displayNameScrollWidth: accountSpan?.scrollWidth ?? 0,
        displayNameText: accountSpan?.textContent ?? '',
      };
    });
    expect(accountBounds.documentWidth).toBeLessThanOrEqual(accountBounds.viewportWidth + 1);
    expect(accountBounds.logoutRight).toBeLessThanOrEqual(accountBounds.viewportWidth + 1);
    expect(accountBounds.accountRight).toBeLessThanOrEqual(accountBounds.logoutLeft + 1);
    expect(accountBounds.displayNameText).toContain('deliberately long account display name');
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-account-long-name-320.png'), fullPage: false, animations: 'disabled' });
    recordInteraction('long-account-display-name-at-320px', accountBounds);

    const invalidOperationId = 'x'.repeat(201);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${BASE}admin/trace?operationId=${encodeURIComponent(invalidOperationId)}`, { waitUntil: 'networkidle' });
    const operationInput = page.getByLabel('Operation ID', { exact: true });
    const alert = page.getByRole('alert').filter({ hasText: 'identifier in this link is invalid' });
    const traceButton = page.getByRole('button', { name: 'Trace request', exact: true });
    await expect(alert).toBeVisible();
    const alignment = await page.evaluate(() => {
      const input = document.querySelector('#trace-lookup-value');
      const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Trace request');
      const error = input?.parentElement?.querySelector('[role="alert"]') ?? input?.parentElement?.parentElement?.querySelector('[role="alert"]');
      const inputRect = input?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      const errorRect = error?.getBoundingClientRect();
      return {
        inputTop: inputRect?.top ?? null,
        actionTop: buttonRect?.top ?? null,
        verticalDelta: inputRect && buttonRect ? Math.abs(inputRect.top - buttonRect.top) : null,
        errorHeight: errorRect?.height ?? 0,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    await expect(operationInput).toBeVisible();
    await expect(traceButton).toBeVisible();
    expect(alignment.errorHeight).toBeGreaterThan(0);
    expect(alignment.verticalDelta).not.toBeNull();
    expect(alignment.verticalDelta ?? 99).toBeLessThanOrEqual(3);
    expect(alignment.documentWidth).toBeLessThanOrEqual(alignment.viewportWidth + 1);
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-trace-error-alignment-1440.png'), fullPage: false, animations: 'disabled' });
    recordInteraction('trace-invalid-query-error-input-action-alignment', alignment);
  });

  test('Secret catalog cursor paging resets on tenant change and remains bounded at mobile width', async ({ page }) => {
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    await installTenantRosterFixture(page);
    const requests: string[] = [];
    await installPagedSecretFixture(page, requests);
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${BASE}admin/secrets`, { waitUntil: 'networkidle' });

    const region = page.getByRole('region', { name: 'Secret catalog page' });
    const table = region.getByRole('table');
    const paging = page.getByLabel('Secret catalog pagination');
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect(table.getByRole('cell', { name: 'Tenant A secret 01' })).toBeVisible();
    await expect(page.getByText('Page 1 · 50 secret entries loaded for this tenant.')).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-secrets-page1-320.png'), fullPage: false, animations: 'disabled' });
    const firstBounds = await region.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
    }));
    expect(firstBounds.scrollHeight).toBeGreaterThan(firstBounds.clientHeight);
    expect(firstBounds.maxHeight).toBeLessThanOrEqual(0.65 * 800 + 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321);

    await paging.getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(() => requests).toContain(`${TENANT}:Tenant A-next`);
    await expect(table.getByRole('cell', { name: 'Tenant A secret 51' })).toBeVisible();
    await expect(page.getByText('Page 2 · 50 secret entries loaded for this tenant.')).toBeVisible();
    await paging.getByRole('button', { name: 'First', exact: true }).click();
    await expect(table.getByRole('cell', { name: 'Tenant A secret 01' })).toBeVisible();
    await expect(page.getByText('Page 1 · 50 secret entries loaded for this tenant.')).toBeVisible();

    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const tenantSelect = page.getByRole('combobox', { name: 'Select active tenant' });
    await tenantSelect.selectOption(ALT_TENANT);
    const closeNavigation = page.getByRole('button', { name: 'Close navigation', exact: true });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    await expect(table.getByRole('cell', { name: 'Tenant B secret 01' })).toBeVisible();
    await expect(page.getByText('Page 1 · 50 secret entries loaded for this tenant.')).toBeVisible();
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-secrets-tenant-b-page1-320.png'), fullPage: false, animations: 'disabled' });
    expect(requests).toContain(`${TENANT}:Tenant A-next`);
    expect(requests).toContain(`${ALT_TENANT}:first`);
    expect(requests.filter((request) => request.startsWith(`${ALT_TENANT}:`)).every((request) => request === `${ALT_TENANT}:first`)).toBe(true);
    recordInteraction('secrets-next-first-tenant-reset-and-mobile-bounds', {
      viewport: 320,
      requestOrder: requests,
      firstPageRows: 50,
      pageTwoRowVisible: 'Tenant A secret 51',
      changedTenantFirstRow: 'Tenant B secret 01',
      regionBounds: firstBounds,
    });
  });

  test('a pending secret mutation cannot overwrite a newly selected tenant page', async ({ page }) => {
    test.setTimeout(20_000);
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    await installTenantRosterFixture(page);
    let mutationWasStarted = false;
    let releaseMutationResolve: () => void = () => undefined;
    const releasedMutation = new Promise<void>((resolve) => { releaseMutationResolve = resolve; });
    const requests: string[] = [];
    await installPagedSecretFixture(page, requests);
    await page.route('**/admin/api/secrets/**/disable*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      fs.appendFileSync(join(EVIDENCE, 'frontend-browser-secret-mutation-route.log'), `${route.request().method()} ${new URL(route.request().url()).pathname}\n`);
      mutationWasStarted = true;
      await releasedMutation;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...secretEntry(TENANT, 1, 'Tenant A'), state: 'DISABLED', revision: 2 }),
      });
    });
    await loginAsAdmin(page);
    await page.goto(`${BASE}admin/secrets`, { waitUntil: 'networkidle' });
    const table = page.getByRole('region', { name: 'Secret catalog page' }).getByRole('table');
    await expect(table.getByRole('cell', { name: 'Tenant A secret 01' })).toBeVisible();
    await table.getByRole('button', { name: 'Disable', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: "Disable 'Tenant A secret 01'" });
    await dialog.getByLabel('Reason').fill('browser tenant transition test');
    await dialog.getByRole('button', { name: 'Disable secret', exact: true }).click();
    await expect.poll(() => mutationWasStarted, { timeout: 5_000 }).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('combobox', { name: 'Select active tenant' }).selectOption(ALT_TENANT);
    await expect(table.getByRole('cell', { name: 'Tenant B secret 01' })).toBeVisible();
    const requestsBeforeRelease = [...requests];
    releaseMutationResolve();
    await page.waitForTimeout(100);
    await expect(table.getByRole('cell', { name: 'Tenant B secret 01' })).toBeVisible();
    expect(requests).toEqual(requestsBeforeRelease);
    expect(requests.filter((request) => request.startsWith(`${ALT_TENANT}:`)).every((request) => request === `${ALT_TENANT}:first`)).toBe(true);
    recordInteraction('secrets-pending-mutation-tenant-scope-race', {
      requestOrder: requests,
      dialogDismissedWhileMutationPending: true,
      visibleTenantBRowAfterMutationAResolved: 'Tenant B secret 01',
      tenantBRequestsHaveNoCursor: true,
    });
  });

  test('business pagination retries the failed next cursor and workflow profile selection survives profile paging', async ({ page }) => {
    test.setTimeout(30_000);
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    await installTenantRosterFixture(page);
    const businessRequests: string[] = [];
    const profileRequests: string[] = [];
    let nextCursorAttempts = 0;
    await page.route(/\/admin\/api\/businesses(?:\/|\?|$)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') return route.continue();
      if (url.pathname === '/admin/api/businesses') {
        const cursor = url.searchParams.get('cursor');
        businessRequests.push(cursor ?? 'first');
        if (cursor === 'business-next' && nextCursorAttempts++ === 0) {
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({ status: 503, code: 'TEMPORARY_FAILURE', title: 'Temporary page failure. Retry this cursor.' }),
          });
          return;
        }
        const businessId = cursor === 'business-next' ? 'business-beta' : 'doc-core';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [{ businessId, activeVersion: '1.2.0', version: '1.2.0', status: 'ENABLED', updatedAt: '2026-10-11T02:00:00.000Z', enabled: true, lifecycleRevision: 1 }],
            total: 2,
            limit: 20,
            nextCursor: cursor === null ? 'business-next' : null,
          }),
        });
        return;
      }
      if (url.pathname === '/admin/api/businesses/doc-core/versions') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ businessId: 'doc-core', activeVersion: '1.2.0', rows: [], enabled: true, lifecycleRevision: 1 }),
        });
        return;
      }
      await route.continue();
    });
    await page.route(/\/admin\/api\/profiles(?:\/|\?|$)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET') return route.continue();
      if (url.pathname === '/admin/api/profiles') {
        const cursor = url.searchParams.get('cursor');
        profileRequests.push(cursor ?? 'first');
        const pageTwo = cursor === 'profiles-next';
        const names = pageTwo ? ['gamma', 'delta'] : ['alpha', 'beta'];
        const items = names.map((profileName, index) => ({
          tenantId: TENANT,
          businessId: 'doc-core',
          businessVersion: '1.2.0',
          profileName,
          revision: 1,
          status: 'ACTIVE',
          keyCount: 1,
          boundActions: ['extract'],
          createdAt: '2026-10-11T02:00:00.000Z',
          updatedAt: `2026-10-11T02:0${index + 1}:00.000Z`,
        }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items, total: 4, limit: 50, nextCursor: pageTwo ? null : 'profiles-next', prevCursor: pageTwo ? 'profiles-first' : null }),
        });
        return;
      }
      const workflowMatch = /\/admin\/api\/profiles\/doc-core\/latest\/([^/]+)\/workflows$/.exec(url.pathname);
      if (workflowMatch) {
        const profileName = decodeURIComponent(workflowMatch[1] ?? '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            businessId: 'doc-core',
            businessVersion: 'latest',
            items: [{ slug: `wf-for-${profileName}`, revision: 2, status: 'active', enabled: true, createdAt: '2026-10-11T02:00:00.000Z' }],
            total: 1,
          }),
        });
        return;
      }
      await route.continue();
    });
    await loginAsAdmin(page);
    await page.goto(`${BASE}admin/businesses`, { waitUntil: 'networkidle' });
    const registry = page.getByRole('table', { name: 'Businesses' });
    await expect(registry.getByRole('cell', { name: 'doc-core', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Business registry pages' }).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByText('Temporary page failure. Retry this cursor.')).toBeVisible();
    expect(businessRequests).toEqual(['first', 'business-next']);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(registry.getByRole('cell', { name: 'business-beta', exact: true })).toBeVisible();
    expect(businessRequests).toEqual(['first', 'business-next', 'business-next']);

    await page.getByRole('navigation', { name: 'Business registry pages' }).getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(registry.getByRole('cell', { name: 'doc-core', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Detail for doc-core', exact: true })).toBeVisible();
    const cockpit = page.getByRole('tablist', { name: /Business detail sections for doc-core/ });
    await cockpit.getByRole('tab', { name: 'Workflow schemas', exact: true }).click();
    const workflowProfile = page.getByRole('combobox', { name: 'Profile for workflow bindings' });
    await expect(workflowProfile).toBeVisible();
    await workflowProfile.selectOption('beta');
    await expect(page.getByRole('cell', { name: 'wf-for-beta', exact: true })).toBeVisible();
    await cockpit.getByRole('tab', { name: 'Profiles', exact: true }).click();
    await page.getByRole('navigation', { name: 'Business profile server pages' }).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.getByText('Server page 2 · 4 total profiles reported', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'gamma', exact: true })).toBeVisible();
    await cockpit.getByRole('tab', { name: 'Workflow schemas', exact: true }).click();
    await expect(workflowProfile).toHaveValue('beta');
    await expect(page.getByRole('cell', { name: 'wf-for-beta', exact: true })).toBeVisible();
    expect(profileRequests).toEqual(['first', 'profiles-next']);
    recordInteraction('business-next-cursor-failure-retry-and-workflow-profile-paging-persistence', {
      businessRequestOrder: businessRequests,
      profileRequestOrder: profileRequests,
      failedNextKeptOnPageOne: true,
      retryUsedSameCursor: 'business-next',
      selectedWorkflowProfileAfterProfilesPageTwo: 'beta',
      selectedProfileWorkflowSlug: 'wf-for-beta',
    });
  });

  test('connector catalog selection is guarded during a pending mutation and resumes after completion', async ({ page }) => {
    test.setTimeout(20_000);
    await resetStub();
    const connectorRows = [
      { connectorId: 'alpha', revision: 1, adapter: 'http-json', state: 'ACTIVE', config: { endpoint: 'https://alpha.example.test' }, tenantId: TENANT },
      { connectorId: 'beta', revision: 1, adapter: 'http-json', state: 'ACTIVE', config: { endpoint: 'https://beta.example.test' }, tenantId: TENANT },
    ];
    let mutationStarted = false;
    let mutationFinished = false;
    let releaseMutationResolve: () => void = () => undefined;
    const releasedMutation = new Promise<void>((resolve) => { releaseMutationResolve = resolve; });
    const actions: string[] = [];
    const connectorRequests: string[] = [];
    await page.route(/\/admin\/api\/connectors(?:\/|$)/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      connectorRequests.push(`${request.method()} ${url.pathname}`);
      fs.appendFileSync(join(EVIDENCE, 'frontend-browser-connector-route.log'), `${request.method()} ${url.pathname}\n`);
      if (request.method() !== 'GET') return route.continue();
      if (url.pathname === '/admin/api/connectors/capabilities') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ management: true, credentialWorkflow: false, test: false, knownConnectorIds: ['alpha', 'beta'] }) });
        return;
      }
      if (url.pathname === '/admin/api/connectors') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: connectorRows }) });
        return;
      }
      const revisionMatch = /\/admin\/api\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(url.pathname);
      if (revisionMatch) {
        const connectorId = decodeURIComponent(revisionMatch[1] ?? '');
        const row = connectorRows.find((candidate) => candidate.connectorId === connectorId);
        if (!row) {
          await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'NOT_FOUND', message: 'connector not found' }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(row) });
        return;
      }
      await route.continue();
    });
    await page.route('**/admin/api/actions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON() as { action?: unknown; params?: unknown };
      const action = typeof body.action === 'string' ? body.action : 'unknown';
      actions.push(action);
      if (action === 'connector.activate') {
        mutationStarted = true;
        await releasedMutation;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { action, connectorId: 'alpha', revision: 1 } }),
      });
      if (action === 'connector.activate') mutationFinished = true;
    });
    let barrierReleased = false;
    try {
      await loginAsAdmin(page);
      await page.goto(`${BASE}admin/connectors`, { waitUntil: 'networkidle' });
      const catalog = page.getByRole('table', { name: 'Connectors' });
      const alphaName = page.getByRole('button', { name: 'Inspect alpha revision 1', exact: true });
      await expect(alphaName).toBeVisible();
      await alphaName.click();
      await expect(page.getByRole('heading', { name: 'Revision lookup', exact: true })).toBeVisible();
      await expect.poll(() => connectorRequests, { timeout: 5_000 }).toContain('GET /admin/api/connectors/alpha/revisions/1');
      await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Activate', exact: true }).click();
      await expect.poll(() => mutationStarted, { timeout: 5_000 }).toBe(true);

      await page.getByRole('tab', { name: 'Catalog', exact: true }).click();
      const alphaRow = catalog.getByRole('row').filter({ hasText: 'alpha' });
      const betaRow = catalog.getByRole('row').filter({ hasText: 'beta' });
      await expect(alphaRow).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('button', { name: 'Inspect beta revision 1', exact: true })).toBeDisabled();
      // Test-only DOM event exercises the central React busy guard; a normal Playwright click is correctly blocked by aria-disabled.
      await betaRow.evaluate((row) => row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      await expect(alphaRow).toHaveAttribute('data-state', 'selected');
      await expect(betaRow).not.toHaveAttribute('data-state', 'selected');

      releaseMutationResolve();
      barrierReleased = true;
      await expect.poll(() => mutationFinished, { timeout: 5_000 }).toBe(true);
      await expect(alphaRow).toHaveAttribute('aria-disabled', 'false');
      const betaName = page.getByRole('button', { name: 'Inspect beta revision 1', exact: true });
      await expect(betaName).toBeEnabled();
      await betaName.click();
      await expect(page.getByRole('heading', { name: 'beta', exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Catalog', exact: true }).click();
      await expect(betaRow).toHaveAttribute('data-state', 'selected');
      recordInteraction('connector-catalog-selection-locked-during-pending-mutation', {
        action: actions[0],
        selectedRowDuringBusy: 'alpha@1',
        betaNameButtonDisabledDuringBusy: true,
        testOnlyBusyRowEventDidNotChangeSelection: true,
        selectedRowAfterRelease: 'beta@1',
        connectorRequests,
      });
    } finally {
      if (!barrierReleased) releaseMutationResolve();
    }
  });

  test('Settings keeps an edited local prompt draft when returning to its tab', async ({ page }) => {
    test.setTimeout(20_000);
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    await installTenantRosterFixture(page);
    const connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const apiKeyId = 'settings-key-ux';
    await page.route(/\/admin\/api\/api-keys(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ id: apiKeyId, tenantId: TENANT, name: 'Browser Settings Key', prefix: 'du_ux', maskedHint: 'du_…ux', status: 'ACTIVE' }],
          nextCursor: null,
          prevCursor: null,
          total: 1,
          limit: 100,
        }),
      });
    });
    await page.route(/\/admin\/api\/connectors(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });
    await page.route(/\/admin\/api\/settings(?:\?|$)/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const url = new URL(route.request().url());
      const tenantId = url.searchParams.get('tenantId');
      const selectedKeyId = url.searchParams.get('apiKeyId');
      const endpointSlug = url.searchParams.get('endpointSlug');
      const scoped = selectedKeyId !== null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scope: {
            tenantId,
            apiKeyId: selectedKeyId,
            endpointSlug: scoped ? endpointSlug : null,
          },
          storage: { metadataEncryptionConfigured: true },
          capabilities: { configurationEditable: true, promptOverridesEditable: true, connectorManagementConfigured: false },
          ...(scoped ? {
            configuration: {
              activeRevision: 4,
              profile: { profileId: 'profile-ux', revision: 7, activeKeyCount: 1, connectorBindings: {} },
              historyLimit: 20,
              revisions: [],
            },
            promptOverrides: [{
              connectionId,
              apiKeyId,
              endpointSlug,
              stepId: '_default',
              promptOverride: 'existing prompt text',
              updatedAt: '2026-10-11T02:00:00.000Z',
            }],
            availableConnections: [{ slot: 'reasoning', connectionId, revision: 3 }],
          } : {}),
        }),
      });
    });

    await loginAsAdmin(page);
    await page.goto(`${BASE}admin/settings`, { waitUntil: 'networkidle' });
    const workspaces = page.getByRole('tablist', { name: 'Settings workspaces' });
    const scopedTab = workspaces.getByRole('tab', { name: 'Scoped configuration', exact: true });
    await scopedTab.click();
    await expect(scopedTab).toHaveAttribute('aria-selected', 'true');
    const keySelect = page.getByLabel('API key', { exact: false });
    await expect(keySelect.locator(`option[value="${apiKeyId}"]`)).toHaveCount(1);
    await keySelect.selectOption(apiKeyId);
    await page.getByRole('button', { name: 'Load current configuration', exact: true }).click();
    const editPrompt = page.getByRole('button', { name: /Edit .* prompt/ });
    await expect(editPrompt).toBeEnabled();
    await editPrompt.click();
    const prompt = page.locator('#settings-prompt');
    await expect(prompt).toBeVisible({ timeout: 5_000 });
    const draft = 'Edited locally in the browser; still unsaved after tab return.';
    await prompt.fill(draft);
    await workspaces.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(workspaces.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
    await workspaces.getByRole('tab', { name: 'Scoped configuration', exact: true }).click();
    await expect(prompt).toHaveValue(draft);
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-settings-draft-tab-return-1440.png'), fullPage: false, animations: 'disabled' });
    recordInteraction('settings-local-prompt-draft-survives-tab-return', {
      draftPreserved: true,
      serverMutationSent: false,
      selectedScope: `${TENANT}:${apiKeyId}:extract:invoice`,
    });
  });

  test('workflow connector-slot mappings scroll inside their accessible bounded region on mobile', async ({ page }) => {
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    const connectorSlotMap = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `connector-${String(index + 1).padStart(2, '0')}-${'integrationidentifier'.repeat(4)}`,
      `slot-${String(index + 1).padStart(2, '0')}-${'bindingreference'.repeat(4)}`,
    ]));
    await page.route('**/admin/api/workflows*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            tenantId: TENANT,
            slug: 'bounded-mapping-ux',
            revision: 1,
            digest: 'sha256-ux-mapping',
            status: 'active',
            createdAt: '2026-10-11T02:00:00.000Z',
            name: 'UX bounded mapping',
            description: 'Long connector slot names exercise the local scroll region.',
            connectorSlotMap,
          }],
          total: 1,
        }),
      });
    });
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}admin/workflows`, { waitUntil: 'networkidle' });
    const region = page.getByRole('region', { name: 'Connector slot mappings for workflow UX bounded mapping' });
    await expect(region).toBeVisible();
    await expect(region.locator('tbody tr')).toHaveCount(40);
    const bounds = await region.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(await region.getAttribute('tabindex')).toBe('0');
    expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
    expect(bounds.maxHeight).toBeLessThanOrEqual(0.65 * 844 + 2);
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth + 1);
    await region.focus();
    await expect(region).toBeFocused();
    const headerBefore = await region.locator('thead th').first().boundingBox();
    await region.evaluate((element) => { element.scrollTop = 240; });
    await page.waitForTimeout(80);
    const headerAfter = await region.locator('thead th').first().boundingBox();
    expect(headerBefore).not.toBeNull();
    expect(headerAfter).not.toBeNull();
    expect(Math.abs((headerAfter?.y ?? 999) - (headerBefore?.y ?? 0))).toBeLessThanOrEqual(2);
    await page.screenshot({ path: join(EVIDENCE, 'frontend-browser-workflow-mapping-390.png'), fullPage: false, animations: 'disabled' });
    recordInteraction('workflow-connector-mapping-bounded-accessible-overflow', bounds);
  });

  test('a delayed Next response from an old profile filter cannot replace the new filter result', async ({ page }) => {
    test.setTimeout(20_000);
    await resetStub();
    await page.addInitScript((tenantId: string) => localStorage.setItem('du_global_tenant_id', tenantId), TENANT);
    await installTenantRosterFixture(page);
    let delayedNextHasStarted = false;
    let releaseDelayedNextResolve: () => void = () => undefined;
    const releaseDelayedNext = new Promise<void>((resolve) => { releaseDelayedNextResolve = resolve; });
    const profileRequests: string[] = [];
    await page.route('**/admin/api/businesses*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { businessId: 'business-a', activeVersion: '1.0.0', version: '1.0.0', status: 'ENABLED', updatedAt: '2026-10-11T02:00:00.000Z' },
            { businessId: 'business-b', activeVersion: '2.0.0', version: '2.0.0', status: 'ENABLED', updatedAt: '2026-10-11T02:00:00.000Z' },
          ],
          total: 2,
          limit: 20,
          nextCursor: null,
        }),
      });
    });
    await page.route('**/admin/api/profiles*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== 'GET' || url.pathname !== '/admin/api/profiles') return route.continue();
      const businessId = url.searchParams.get('businessId') ?? '';
      const cursor = url.searchParams.get('cursor');
      profileRequests.push(`${businessId || 'all'}:${cursor ?? 'first'}`);
      if (businessId === 'business-a' && cursor === 'a-next') {
        delayedNextHasStarted = true;
        await releaseDelayedNext;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: [
              { tenantId: TENANT, businessId, businessVersion: '1.0.0', profileName: 'stale-a-page', revision: 1, status: 'ACTIVE', keyCount: 0, boundActions: [], createdAt: '2026-10-11T02:00:00.000Z', updatedAt: '2026-10-11T02:00:00.000Z' },
            ],
            total: 2,
            limit: 50,
            nextCursor: null,
            prevCursor: 'a-first',
          }),
        });
        return;
      }
      let items: Array<Record<string, unknown>> = [];
      let nextCursor: string | null = null;
      if (businessId === 'business-a') {
        items = [{ tenantId: TENANT, businessId, businessVersion: '1.0.0', profileName: 'business-a-first', revision: 1, status: 'ACTIVE', keyCount: 0, boundActions: [], createdAt: '2026-10-11T02:00:00.000Z', updatedAt: '2026-10-11T02:00:00.000Z' }];
        nextCursor = 'a-next';
      } else if (businessId === 'business-b') {
        items = [{ tenantId: TENANT, businessId, businessVersion: '2.0.0', profileName: 'business-b-first', revision: 1, status: 'ACTIVE', keyCount: 0, boundActions: [], createdAt: '2026-10-11T02:00:00.000Z', updatedAt: '2026-10-11T02:00:00.000Z' }];
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, total: items.length, limit: 50, nextCursor, prevCursor: null }),
      });
    });
    await loginAsAdmin(page);
    await page.goto(`${BASE}admin/profiles`, { waitUntil: 'networkidle' });
    const filter = page.getByRole('combobox', { name: 'Filter profiles by business' });
    await expect(filter.locator('option', { hasText: 'business-a' })).toHaveCount(1);
    await filter.selectOption('business-a');
    const catalog = page.getByRole('region', { name: 'Current server page of the profile catalog' });
    await expect(catalog.getByText('business-a-first', { exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Profile catalog server pages' }).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect.poll(() => delayedNextHasStarted, { timeout: 5_000 }).toBe(true);
    await filter.selectOption('business-b');
    await expect(catalog.getByText('business-b-first', { exact: true })).toBeVisible();
    releaseDelayedNextResolve();
    await page.waitForTimeout(100);
    await expect(catalog.getByText('business-b-first', { exact: true })).toBeVisible();
    await expect(catalog.getByText('stale-a-page', { exact: true })).toHaveCount(0);
    expect(profileRequests).toContain('business-a:a-next');
    expect(profileRequests).toContain('business-b:first');
    recordInteraction('profiles-delayed-old-filter-next-response-ignored', {
      profileRequestOrder: profileRequests,
      delayedRequest: 'business-a:a-next',
      currentFilter: 'business-b',
      visibleRowAfterOldResponseReleased: 'business-b-first',
    });
  });
});
