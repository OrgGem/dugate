import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Independent ORV14 browser contract for the served Usage & Cost adjustment
 * journey. This spec intercepts only Admin API calls so it can exercise typed
 * UI state transitions; the separate real-PG verifier owns financial truth.
 * Run only after the final server-served Admin bundle is leased and its hash is
 * recorded. No product source or shared build output is written here.
 */

const BASE = process.env.AWEB01B_URL ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const EVIDENCE_DIR = resolve(process.env.ORV14_FINANCE_EVIDENCE ?? 'coordination/evidence/orv14-finance-ui');
const TENANT = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '22222222-2222-4222-8222-222222222222';
const ROOT_EVENT = 'orv14-finance-root-001';
const EVENT_TIME = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const RECORDED_AT = new Date().toISOString();
const INITIAL = 100_000_000;
const EVIDENCE_ID = '33333333-3333-4333-8333-333333333333';
const GENERATION_ID = '44444444-4444-4444-8444-444444444444';
const PRINCIPAL_ID = '55555555-5555-4555-8555-555555555555';
const OPAQUE_SESSION_SENTINEL = 'orv14-browser-session-sentinel-must-not-render';
const RAW_SUBJECT_SENTINEL = 'orv14-browser-oidc-subject-sentinel-must-not-render';
const SHA = `sha256:${'a'.repeat(64)}`;
const OBJECT_SHA = `sha256:${'b'.repeat(64)}`;
const SIDECAR_SHA = `sha256:${'c'.repeat(64)}`;

type SessionKind = 'platform-admin' | 'tenant-user';
type PostResponse =
  | { status: 409; code: 'BACKUP_EFFECT_FENCE_ACTIVE' }
  | { status: 409; code: 'COST_ADJUSTMENT_CAS_CONFLICT' }
  | { status: 503; code: 'UPSTREAM_UNAVAILABLE' }
  | { status: 201; code: 'OK' };
interface CapturedAdjustment {
  command: Record<string, unknown>;
  idempotencyKey: string | undefined;
  csrf: string | undefined;
}
interface FinanceFixture {
  writes: CapturedAdjustment[];
  queuedPosts: PostResponse[];
  historyRequests: URL[];
  eventQueries: URL[];
  state: { revision: number; gross: number; refunded: number; items: Record<string, unknown>[] };
  servedAssets: Array<{ url: string; sha256: string }>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function originalAttribution() {
  return {
    tenantId: TENANT,
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    profileRevision: 4,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    operationId: '66666666-6666-4666-8666-666666666666',
    taskId: '77777777-7777-4777-8777-777777777777',
    invocationId: 'orv14-invocation-opaque-001',
    attempt: 1,
    connectorId: 'synthetic-provider',
    connectorRevision: 3,
    provider: 'openai',
    model: 'gpt-4o',
    occurredAt: EVENT_TIME,
    quotaWindowPins: [],
    priceRevision: 9,
    priceSnapshotDigest: SHA,
    provenanceDigest: OBJECT_SHA,
    costStatus: 'measured',
    inputTokens: 1200,
    outputTokens: 320,
    cachedInputTokens: 0,
    pages: 1,
    durationMs: 850,
  };
}

function historyEntry(input: {
  revision: number;
  previousId: string | null;
  kind: 'correction' | 'refund';
  gross: number;
  refunded: number;
  target: number | null;
  refund: number | null;
  reason: string;
}) {
  return {
    adjustmentEventId: input.revision === 1 ? '88888888-8888-4888-8888-888888888881' : '88888888-8888-4888-8888-888888888882',
    rootEventId: ROOT_EVENT,
    adjustmentRevision: input.revision,
    previousAdjustmentEventId: input.previousId,
    kind: input.kind,
    targetChargeMicrousd: input.target,
    refundMicrousd: input.refund,
    initialChargeMicrousd: INITIAL,
    grossChargeMicrousd: input.gross,
    refundedMicrousd: input.refunded,
    netChargeMicrousd: input.gross - input.refunded,
    effectiveAt: EVENT_TIME,
    quotaWindowPins: [],
    recordedAt: RECORDED_AT,
    evidenceArtifactId: EVIDENCE_ID,
    evidenceStorageGenerationId: GENERATION_ID,
    evidenceSizeBytes: 640,
    evidenceSha256: SHA,
    evidenceObjectSizeBytes: 692,
    evidenceObjectSha256: OBJECT_SHA,
    evidenceObjectProofComplete: true,
    evidenceObjectVersionId: `object-version-${input.revision}`,
    evidenceSidecarSizeBytes: 512,
    evidenceSidecarVersionId: `sidecar-version-${input.revision}`,
    evidenceSidecarSha256: SIDECAR_SHA,
    authority: 'platform-admin-approved',
    actorPrincipalId: PRINCIPAL_ID,
    actorKind: 'oidc-admin',
    reason: input.reason,
  };
}

function historyPage(fixture: FinanceFixture) {
  return {
    tenantId: TENANT,
    rootEventId: ROOT_EVENT,
    adjustmentRevision: fixture.state.revision,
    headAdjustmentEventId: fixture.state.items[0]?.['adjustmentEventId'] ?? null,
    eligible: true,
    blockers: [],
    initialChargeMicrousd: INITIAL,
    grossChargeMicrousd: fixture.state.gross,
    refundedMicrousd: fixture.state.refunded,
    netChargeMicrousd: fixture.state.gross - fixture.state.refunded,
    originalAttribution: originalAttribution(),
    items: fixture.state.items,
    limit: 50,
    nextCursor: null,
  };
}

function usageEvent(fixture: FinanceFixture) {
  return {
    eventId: ROOT_EVENT,
    operationId: '66666666-6666-4666-8666-666666666666',
    taskId: '77777777-7777-4777-8777-777777777777',
    invocationId: 'orv14-invocation-opaque-001',
    provider: 'openai',
    model: 'gpt-4o',
    units: { inputTokens: 1200, outputTokens: 320, pages: 1 },
    costMicrousd: INITIAL,
    costStatus: 'measured',
    providerReportedCost: { costMicrousd: 102_000_000, currency: 'USD', source: 'provider-response', status: 'unverified' },
    financialAccounting: {
      rootEventId: ROOT_EVENT,
      initialChargeMicrousd: INITIAL,
      grossChargeMicrousd: fixture.state.gross,
      refundedMicrousd: fixture.state.refunded,
      netChargeMicrousd: fixture.state.gross - fixture.state.refunded,
      adjustmentRevision: fixture.state.revision,
      headAdjustmentEventId: fixture.state.items[0]?.['adjustmentEventId'] ?? null,
      semantics: 'initial-charge-plus-direct-root-adjustments-v1',
    },
    measurement: 'measured',
    occurredAt: EVENT_TIME,
    receivedAt: EVENT_TIME,
  };
}

function applyCommand(fixture: FinanceFixture, command: Record<string, unknown>): Record<string, unknown> {
  fixture.state.revision += 1;
  const kind = command['kind'];
  if (kind === 'correction') fixture.state.gross = Number(command['targetChargeMicrousd']);
  else fixture.state.refunded += Number(command['refundMicrousd']);
  const item = historyEntry({
    revision: fixture.state.revision,
    previousId: fixture.state.items[0]?.['adjustmentEventId'] as string | null ?? null,
    kind: kind as 'correction' | 'refund',
    gross: fixture.state.gross,
    refunded: fixture.state.refunded,
    target: kind === 'correction' ? Number(command['targetChargeMicrousd']) : null,
    refund: kind === 'refund' ? Number(command['refundMicrousd']) : null,
    reason: String(command['reason']),
  });
  fixture.state.items.unshift(item);
  return {
    outcome: 'ADJUSTED',
    adjustmentEventId: item['adjustmentEventId'],
    rootEventId: ROOT_EVENT,
    adjustmentRevision: fixture.state.revision,
    initialChargeMicrousd: INITIAL,
    grossChargeMicrousd: fixture.state.gross,
    refundedMicrousd: fixture.state.refunded,
    netChargeMicrousd: fixture.state.gross - fixture.state.refunded,
    effectiveAt: EVENT_TIME,
    recordedAt: RECORDED_AT,
    replayed: false,
  };
}

async function fulfillJson(route: Route, status: number, value: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: json(value) });
}

async function installFinanceApi(page: Page, options: { session?: SessionKind } = {}): Promise<FinanceFixture> {
  const fixture: FinanceFixture = {
    writes: [],
    queuedPosts: [],
    historyRequests: [],
    eventQueries: [],
    state: { revision: 0, gross: INITIAL, refunded: 0, items: [] },
    servedAssets: [],
  };

  page.on('response', async (response) => {
    const url = response.url();
    if (!/\/admin\/assets\/.*\.(?:js|css)(?:\?|$)/.test(url)) return;
    try {
      const body = await response.body();
      fixture.servedAssets.push({ url, sha256: createHash('sha256').update(body).digest('hex') });
    } catch { /* a failed navigation will be surfaced by the test itself */ }
  });
  page.on('requestfailed', (request) => {
    console.info(`ORV14_FINANCE_REQUEST_FAILED ${json({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? 'unknown' })}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.info(`ORV14_FINANCE_BROWSER_CONSOLE_ERROR ${message.text()}`);
  });

  await page.route('**/admin/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/admin/api/session' && request.method() === 'GET') {
      const session = options.session ?? 'platform-admin';
      return fulfillJson(route, 200, session === 'platform-admin' ? {
        schemaVersion: '1', plane: 'oidc', role: 'admin',
        principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
        displayName: 'oidc:configured-provider', localUser: false, csrfToken: 'synthetic-csrf-token',
      } : {
        schemaVersion: '1', plane: 'oidc', role: 'operator',
        principal: { kind: 'tenant_operator', tenantId: TENANT }, scope: { kind: 'tenant', tenantId: TENANT },
        displayName: 'local-user', localUser: true, csrfToken: 'synthetic-csrf-token',
      });
    }
    if (path === '/admin/api/tenants' && request.method() === 'GET') {
      return fulfillJson(route, 200, { items: [{ id: TENANT, name: 'ORV14 Synthetic Tenant', state: 'ACTIVE' }], nextCursor: null, prevCursor: null, total: 1, limit: 100 });
    }
    if (path === '/admin/api/usage' && request.method() === 'GET') {
      return fulfillJson(route, 200, {
        tenantId: TENANT,
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        rows: [{ provider: 'openai', model: 'gpt-4o', operations: 1, inputTokens: 1200, outputTokens: 320, pages: 1, costMicrousd: INITIAL, measurement: 'measured', costStatus: 'measured' }],
        totals: { operations: 1, inputTokens: 1200, outputTokens: 320, pages: 1, costMicrousd: INITIAL, costStatus: 'measured' },
      });
    }
    if (path === '/admin/api/usage/events' && request.method() === 'GET') {
      fixture.eventQueries.push(url);
      return fulfillJson(route, 200, {
        tenantId: TENANT,
        events: [usageEvent(fixture)],
        limit: 50,
        hasMore: false,
        skippedInvalidEvents: 0,
        timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
      });
    }
    if (path === '/admin/api/cost-control/adjustments/evidence' && request.method() === 'GET') {
      if (url.searchParams.get('tenantId') !== TENANT) return fulfillJson(route, 200, { tenantId: FOREIGN_TENANT, items: [], limit: 50, nextCursor: null });
      return fulfillJson(route, 200, {
        tenantId: TENANT,
        items: [{ artifactId: EVIDENCE_ID, fileName: 'synthetic-invoice-evidence.pdf', mimeType: 'application/pdf', sizeBytes: 640, sha256: SHA, createdAt: '2026-10-11T00:00:00.000Z' }],
        limit: 50,
        nextCursor: null,
      });
    }
    if (path === '/admin/api/cost-control/adjustments' && request.method() === 'GET') {
      fixture.historyRequests.push(url);
      if (url.searchParams.get('tenantId') !== TENANT || url.searchParams.get('rootEventId') !== ROOT_EVENT) {
        return fulfillJson(route, 200, { ...historyPage(fixture), tenantId: FOREIGN_TENANT });
      }
      return fulfillJson(route, 200, historyPage(fixture));
    }
    if (path === '/admin/api/cost-control/adjustments' && request.method() === 'POST') {
      const command = request.postDataJSON() as Record<string, unknown>;
      fixture.writes.push({ command, idempotencyKey: request.headers()['idempotency-key'], csrf: request.headers()['x-csrf-token'] });
      const next = fixture.queuedPosts.shift() ?? { status: 201, code: 'OK' as const };
      if (next.code === 'BACKUP_EFFECT_FENCE_ACTIVE') {
        return fulfillJson(route, 409, { type: 'urn:du:error:backup_effect_fence_active', title: 'Financial writes are held by an active backup', status: 409, code: next.code });
      }
      if (next.code === 'COST_ADJUSTMENT_CAS_CONFLICT') {
        fixture.state.revision += 1;
        fixture.state.gross = 90_000_000;
        const external = historyEntry({ revision: fixture.state.revision, previousId: null, kind: 'correction', gross: fixture.state.gross, refunded: 0, target: fixture.state.gross, refund: null, reason: 'Concurrent authorized correction' });
        fixture.state.items.unshift(external);
        return fulfillJson(route, 409, { type: 'urn:du:error:cost_adjustment_cas_conflict', title: 'Adjustment head changed', status: 409, code: next.code });
      }
      if (next.code === 'UPSTREAM_UNAVAILABLE') {
        return fulfillJson(route, 503, { type: 'urn:du:error:upstream_unavailable', title: 'Adjustment acknowledgement unavailable', status: 503, code: next.code });
      }
      return fulfillJson(route, 201, applyCommand(fixture, command));
    }
    if (path === '/admin/api/cost-control/budgets' && request.method() === 'GET') return fulfillJson(route, 200, { tenantId: TENANT, budgets: [] });
    if (path === '/admin/api/cost-control/prices' && request.method() === 'GET') return fulfillJson(route, 200, { headRevision: 0, activeRevision: null, revisions: [] });
    if (path === '/admin/api/cost-alerts/channels' && request.method() === 'GET') return fulfillJson(route, 200, { tenantId: TENANT, channels: [] });
    if (path === '/admin/api/cost-alerts/recipients' && request.method() === 'GET') return fulfillJson(route, 200, { tenantId: TENANT, items: [], limit: 50, hasMore: false, nextCursor: null });
    if (path === '/admin/api/cost-alerts' && request.method() === 'GET') return fulfillJson(route, 200, { tenantId: TENANT, items: [], limit: 25, hasMore: false, nextCursor: null });
    if (path === '/admin/api/cost-alerts/inbox' && request.method() === 'GET') return fulfillJson(route, 200, { tenantId: TENANT, items: [], limit: 25, hasMore: false, nextCursor: null });
    if (path === '/admin/api/identity/assignable-users' && request.method() === 'GET') return fulfillJson(route, 200, { items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100 });
    if (path === '/admin/api/cost-alerts/scope-catalog' && request.method() === 'GET') {
      const kind = url.searchParams.get('kind') ?? 'api-keys';
      return fulfillJson(route, 200, { tenantId: TENANT, kind, items: [], limit: Number(url.searchParams.get('limit') ?? 50), hasMore: false, nextCursor: null });
    }
    if (path === '/admin/api/health' && request.method() === 'GET') return fulfillJson(route, 200, {
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: 0,
      queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: new Date().toISOString() },
      outboxBacklog: 0,
      sampledAt: new Date().toISOString(),
    });
    // Usage may mount unrelated read-only dashboard panels. They receive an
    // empty safe body; any interaction under test is handled above.
    return fulfillJson(route, 200, {});
  });
  return fixture;
}

async function loginAndOpenUsage(page: Page): Promise<void> {
  if (!BASE || !TOKEN) throw new Error('AWEB01B_URL and AWEB01B_TOKEN must point to the final served Admin build');
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.fill('input[name="token"]', TOKEN);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/admin');
  await page.goto(`${BASE}admin/usage`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Usage & Cost' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cost adjustment history' })).toBeVisible();
}

async function openAdjustmentDetails(page: Page, canWrite = true): Promise<void> {
  await page.getByRole('button', { name: 'Cost adjustment history' }).click();
  await expect(page.getByRole('region', { name: 'Financial adjustment details' })).toBeVisible();
  if (canWrite) await expect(page.getByText('Prepare an administrative adjustment')).toBeVisible();
}

async function prepareAndReview(page: Page, amount: number, kind: 'correction' | 'refund' = 'correction'): Promise<void> {
  await page.getByRole('combobox', { name: /^Adjustment/ }).selectOption(kind);
  const label = kind === 'correction' ? 'Replacement gross charge' : 'Refund credit delta';
  const amountInput = page.getByLabel(new RegExp(label));
  await amountInput.fill(String(amount));
  await page.getByRole('textbox', { name: 'Reason', exact: true }).fill(kind === 'correction' ? 'Correct invoice total after review' : 'Issue verified customer credit');
  await page.getByLabel('Evidence artifact').selectOption(EVIDENCE_ID);
  await page.getByRole('button', { name: 'Review adjustment' }).click();
  await expect(page.getByRole('heading', { name: 'Review before confirmation' })).toBeVisible();
}

async function submitReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm adjustment' }).click();
}

function recordAssets(fixture: FinanceFixture): void {
  const assets = [...new Map(fixture.servedAssets.map((asset) => [asset.url, asset])).values()];
  console.info(`ORV14_FINANCE_SERVED_ASSETS ${json(assets)}`);
}

test.describe('ORV14 served Admin financial adjustment journey', () => {
  test.beforeAll(() => {
    if (!BASE || !TOKEN) throw new Error('AWEB01B_URL and AWEB01B_TOKEN are required');
    mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  test('correction 100→80 then refund 30→net 50; preserves original units and separates provider report', async ({ page }) => {
    const fixture = await installFinanceApi(page);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page);

    await expect(page.getByText('Initial computed charge')).toBeVisible();
    await expect(page.getByText('100.000000 USD').first()).toBeVisible();
    await expect(page.getByText(/Provider-reported amount \(unverified\): 102\.000000 USD/)).toBeVisible();
    await expect(page.getByText(/Diagnostic difference: 2\.000000 USD/)).toBeVisible();
    await expect(page.getByText(/Input 1,200 · cached 0 · output 320 · pages 1/)).toBeVisible();

    await prepareAndReview(page, 80_000_000, 'correction');
    await submitReview(page);
    await expect(page.getByText(/Server-calculated gross 80\.000000 USD/)).toBeVisible();
    await expect(page.getByText(/Original usage units, trust classification, provenance and accounting time remain unchanged/)).toBeVisible();

    await prepareAndReview(page, 30_000_000, 'refund');
    await submitReview(page);
    const adjustmentDetails = page.getByRole('region', { name: 'Financial adjustment details' });
    await expect(adjustmentDetails.getByText(/Refund credit 30\.000000 USD · gross 80\.000000 USD · refunded 30\.000000 USD · net 50\.000000 USD/)).toBeVisible();
    const currentNetLabel = adjustmentDetails.getByText('Current net', { exact: true });
    await expect(currentNetLabel).toBeVisible();
    await expect(currentNetLabel.locator('xpath=following-sibling::p[1]')).toHaveText('50.000000 USD');
    await expect(page.getByText(/Provider-reported amount \(unverified\): 102\.000000 USD/)).toBeVisible();
    await expect(page.getByText(/Input 1,200 · cached 0 · output 320 · pages 1/)).toBeVisible();

    const adjustmentDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export current history page CSV/ }).click();
    const adjustmentCsvDownload = await adjustmentDownload;
    const adjustmentCsvPath = await adjustmentCsvDownload.path();
    expect(adjustmentCsvPath).not.toBeNull();
    const adjustmentCsv = readFileSync(adjustmentCsvPath!, 'utf8');
    expect(adjustmentCsv).toContain('"initial_charge_microusd","gross_charge_microusd","refunded_microusd","net_charge_microusd"');
    expect(adjustmentCsv).toContain(`"${INITIAL}","${80_000_000}","${30_000_000}","${50_000_000}"`);
    expect(adjustmentCsv).toContain('oidc-admin');

    const usageDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export this page CSV/ }).click();
    const usageCsvDownload = await usageDownload;
    const usageCsvPath = await usageCsvDownload.path();
    expect(usageCsvPath).not.toBeNull();
    const usageCsv = readFileSync(usageCsvPath!, 'utf8');
    expect(usageCsv).toContain('"provider_reported_cost_microusd_unverified"');
    expect(usageCsv).toContain('"financial_initial_charge_microusd"');
    expect(usageCsv).toContain(`${INITIAL}`);
    expect(usageCsv).toContain('102000000');
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[0]?.command).toMatchObject({ kind: 'correction', targetChargeMicrousd: 80_000_000, expectedAdjustmentRevision: 0, tenantId: TENANT, rootEventId: ROOT_EVENT, evidenceArtifactId: EVIDENCE_ID });
    expect(fixture.writes[1]?.command).toMatchObject({ kind: 'refund', refundMicrousd: 30_000_000, expectedAdjustmentRevision: 1, tenantId: TENANT, rootEventId: ROOT_EVENT, evidenceArtifactId: EVIDENCE_ID });
    expect(fixture.writes.every((write) => write.idempotencyKey && write.csrf === 'synthetic-csrf-token')).toBe(true);
    expect(fixture.historyRequests.every((request) => request.searchParams.get('tenantId') === TENANT && request.searchParams.get('rootEventId') === ROOT_EVENT)).toBe(true);
    expect(fixture.eventQueries.every((request) => request.searchParams.get('tenantId') === TENANT)).toBe(true);
    const text = await page.locator('body').innerText();
    expect(text).not.toContain(OPAQUE_SESSION_SENTINEL);
    expect(text).not.toContain(RAW_SUBJECT_SENTINEL);
    expect(pageErrors).toEqual([]);
    recordAssets(fixture);
    await page.screenshot({ path: join(EVIDENCE_DIR, 'orv14-finance-final-history.png'), fullPage: true });
  });

  test('typed backup hold preserves reviewed draft and a known non-write retry uses a fresh key', async ({ page }) => {
    const fixture = await installFinanceApi(page);
    fixture.queuedPosts.push({ status: 409, code: 'BACKUP_EFFECT_FENCE_ACTIVE' }, { status: 201, code: 'OK' });
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page);
    await prepareAndReview(page, 80_000_000);
    const reviewText = await page.locator('[aria-label="Adjustment review"]').innerText();
    const command = fixture.writes.length;
    await submitReview(page);
    await expect(page.getByText(/held while the backup or recovery safety gate is active/)).toBeVisible();
    await expect(page.locator('[aria-label="Adjustment review"]')).toContainText('80.000000 USD');
    await expect(page.getByLabel('Replacement gross charge')).toHaveValue('80000000');
    await expect(page.getByLabel('Evidence artifact')).toHaveValue(EVIDENCE_ID);
    await expect(page.getByText(/adjustment head changed before confirmation/i)).toHaveCount(0);
    expect(fixture.writes).toHaveLength(command + 1);
    await submitReview(page);
    await expect(page.getByRole('region', { name: 'Financial adjustment details' }).getByText(/Replacement gross charge 80\.000000 USD · gross 80\.000000 USD · refunded 0\.000000 USD · net 80\.000000 USD/)).toBeVisible();
    expect(fixture.writes).toHaveLength(command + 2);
    expect(fixture.writes[0]?.command).toEqual(fixture.writes[1]?.command);
    expect(fixture.writes[0]?.idempotencyKey).not.toBe(fixture.writes[1]?.idempotencyKey);
    expect(fixture.writes[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fixture.writes[1]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(reviewText).toContain('80.000000 USD');
    recordAssets(fixture);
  });

  test('typed adjustment-head CAS conflict reloads history without clearing entered values', async ({ page }) => {
    const fixture = await installFinanceApi(page);
    fixture.queuedPosts.push({ status: 409, code: 'COST_ADJUSTMENT_CAS_CONFLICT' });
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page);
    await prepareAndReview(page, 80_000_000);
    await submitReview(page);
    await expect(page.getByText(/adjustment head changed before confirmation/i)).toBeVisible();
    await expect(page.locator('[aria-label="Adjustment review"]')).toHaveCount(0);
    await expect(page.getByLabel('Replacement gross charge')).toHaveValue('80000000');
    await expect(page.getByRole('textbox', { name: 'Reason', exact: true })).toHaveValue('Correct invoice total after review');
    await expect(page.getByLabel('Evidence artifact')).toHaveValue(EVIDENCE_ID);
    await expect(page.getByText('Adjustment head r1')).toBeVisible();
    await page.getByRole('button', { name: 'Review adjustment' }).click();
    await expect(page.locator('[aria-label="Adjustment review"]')).toContainText('Revision 1');
    expect(fixture.writes).toHaveLength(1);
    recordAssets(fixture);
  });

  test('503 unknown acknowledgement keeps the exact command and idempotency key for recheck', async ({ page }) => {
    const fixture = await installFinanceApi(page);
    fixture.queuedPosts.push({ status: 503, code: 'UPSTREAM_UNAVAILABLE' }, { status: 201, code: 'OK' });
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page);
    await prepareAndReview(page, 80_000_000);
    await submitReview(page);
    await expect(page.getByText(/server acknowledgement is unknown/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recheck same adjustment request' })).toBeVisible();
    const first = fixture.writes[0];
    await page.getByRole('button', { name: 'Recheck same adjustment request' }).click();
    await expect(page.getByRole('region', { name: 'Financial adjustment details' }).getByText(/Replacement gross charge 80\.000000 USD · gross 80\.000000 USD · refunded 0\.000000 USD · net 80\.000000 USD/)).toBeVisible();
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.writes[1]?.command).toEqual(first?.command);
    expect(fixture.writes[1]?.idempotencyKey).toBe(first?.idempotencyKey);
    recordAssets(fixture);
  });

  test('tenant USER session reads scoped history and has no adjustment controls', async ({ page }) => {
    const fixture = await installFinanceApi(page, { session: 'tenant-user' });
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page, false);
    await expect(page.getByText('Financial adjustment history is read only. A current platform Admin must review and record changes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review adjustment' })).toHaveCount(0);
    await expect(page.getByLabel('Replacement gross charge')).toHaveCount(0);
    expect(fixture.historyRequests.length).toBeGreaterThan(0);
    expect(fixture.historyRequests.every((request) => request.searchParams.get('tenantId') === TENANT)).toBe(true);
    expect(fixture.eventQueries.every((request) => request.searchParams.get('tenantId') === TENANT)).toBe(true);
    recordAssets(fixture);
  });

  test('final journey is keyboard accessible and has no critical/serious axe violations at required viewports/themes', async ({ page }) => {
    const fixture = await installFinanceApi(page);
    await loginAndOpenUsage(page);
    await openAdjustmentDetails(page);
    await expect(page.getByRole('region', { name: 'Financial adjustment details' })).toBeVisible();

    await page.getByRole('combobox', { name: /^Adjustment/ }).focus();
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement as (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }) | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      const labels = active.labels ? Array.from(active.labels).map((label) => label.innerText).join(' ') : '';
      return { label: active.getAttribute('aria-label') ?? (labels || active.textContent?.trim() || ''), outline: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });
    expect(focus).not.toBeNull();
    expect(focus!.label).toContain('Replacement gross charge');
    expect(focus!.outline !== 'none' || focus!.boxShadow !== 'none' || Number.parseFloat(focus!.outlineWidth) > 0).toBe(true);

    const reports: Array<{
      width: number;
      theme: string;
      overflow: boolean;
      scrollWidth: number;
      clientWidth: number;
      criticalOrSerious: string[];
    }> = [];
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((mode) => {
          document.documentElement.setAttribute('data-theme', mode);
        }, theme);
        await expect(page.getByRole('region', { name: 'Financial adjustment details' })).toBeVisible();
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        const axe = await new AxeBuilder({ page }).analyze();
        const material = axe.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
        reports.push({
          width,
          theme,
          overflow: dimensions.scroll > dimensions.client + 1,
          scrollWidth: dimensions.scroll,
          clientWidth: dimensions.client,
          criticalOrSerious: material.flatMap((violation) => violation.nodes.map((node) => `${violation.impact}:${violation.id}:${node.target.join(',')}`)),
        });
        await page.screenshot({ path: join(EVIDENCE_DIR, `orv14-finance-${width}-${theme}.png`), fullPage: true });
      }
    }
    console.info(`ORV14_FINANCE_UI_MATRIX ${json(reports)}`);
    recordAssets(fixture);
    expect(reports.filter((report) => report.overflow || report.criticalOrSerious.length > 0), 'All required width/theme pairs must have no horizontal overflow and zero critical/serious axe violations').toEqual([]);
  });
});
