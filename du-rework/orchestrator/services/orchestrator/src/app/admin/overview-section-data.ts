/**
 * P6-07 Overview section data seam.
 *
 * Pure HTTP fetcher for the Admin Overview pane (usage rollup + audit
 * events + operational health). Discriminated `OverviewFetchResult`
 * drives the renderer.
 *
 * Design (mirrors `operation-section-data.ts`):
 * - When `jsonBaseUrl` is empty, the fetcher uses an in-process
 *   `OverviewCatalog` (test / offline path). The catalog carries
 *   three typed shapes: `usageSummary`, `auditEvents`, `health`.
 *   Empty `usageSummary.rows` AND empty `auditEvents` returns
 *   `{ kind: 'empty' }` so the renderer shows the empty pane.
 *   `auditEvents` are tenant-scoped to `tenantId` (cross-tenant
 *   rows are dropped at fetch time).
 * - When `jsonBaseUrl` is set, the fetcher GETs three platform
 *   endpoints in parallel and parses them:
 *     - `GET {base}/api/v1/usage?tenantId=…&from=…&to=…`
 *     - `GET {base}/api/v1/admin/audit?tenantId=…&limit=…`
 *     - `GET {base}/api/v1/health`
 *   Each gets a 4-second `AbortController` timeout. 401/403 →
 *   `unauthorized` (the admin token was rejected). 404 on any of
 *   the three endpoints → `unauthorized` (the platform currently
 *   does not expose these GETs; the renderer paints the
 *   unauthorized pane). Other transport failures → `error`.
 *
 * Hard rules:
 * - The fetcher reuses the existing `GET /api/v1/health` wire shape
 *   verbatim (`{status, db, redis, activeLeases}`); no parallel
 *   schema is invented.
 * - The fetcher never echoes a raw credential / header. The audit
 *   events are reduced through `buildAuditListView` from
 *   `overview-view-models.ts` so the renderer never sees the raw
 *   wire.
 * - The fetcher is **never** authoritative for the live health
 *   verdict — it reflects what the server returned; the renderer
 *   surfaces the badge.
 *
 * No DB, no Redis. `fetchImpl` is injectable. Strict TypeScript,
 * zero `any`.
 */

import { ADMIN_LIST_LIMIT_MAX } from '@du/contracts';
import { sanitizeUpstreamErrorBody } from './upstream-error-body';
import {
  buildAuditListView,
  buildHealthOverviewView,
  buildUsageRollupView,
} from './overview-view-models';
import { errorClassOf, safeTransportErrorText } from '../../http/errors';
import type {
  AuditEventRow,
  AuditEventKind,
  AuditSeverity,
  HealthWire,
  UsageMeasurement,
  UsageRollupTotals,
} from './overview-view-models';

// ---------------------------------------------------------------------------
// Wire shapes (raw rows as the platform's GET would return them)
// ---------------------------------------------------------------------------

/**
 * Wire envelope for `GET /api/v1/usage?tenantId=…&from=…&to=…`.
 * `rows[]` carries one row per (provider, model) bucket; `totals`
 * mirrors the row sums.
 */
export interface UsageSummaryWireEnvelope {
  tenantId?: string;
  from?: string;
  to?: string;
  rows?: Array<{
    provider?: string;
    model?: string;
    operations?: number;
    inputTokens?: number;
    outputTokens?: number;
    pages?: number;
    costMicrousd?: number;
    measurement?: UsageMeasurement;
  }>;
  totals?: Partial<UsageRollupTotals>;
}

/**
 * Wire envelope for `GET /api/v1/admin/audit`.
 *
 * W-ADMUX02-EXT-1: the route answers the shared admin page envelope, so the
 * events ride in `items` alongside the four paging fields; the retired
 * `{ tenantId, events }` shape is still typed for read tolerance.
 */
export interface AuditListWireEnvelope {
  tenantId?: string;
  items?: Array<{
    id?: string;
    kind?: string;
    severity?: string;
    occurredAt?: string;
    tenantId?: string;
    resourceId?: string;
    actor?: string;
    message?: string;
  }>;
  nextCursor?: string | null;
  prevCursor?: string | null;
  total?: number;
  limit?: number;
  /** Legacy key (pre W-ADMUX02-EXT-1); still accepted on read. */
  events?: Array<{
    id?: string;
    kind?: string;
    severity?: string;
    occurredAt?: string;
    tenantId?: string;
    resourceId?: string;
    actor?: string;
    message?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Catalog (test / offline path)
// ---------------------------------------------------------------------------

/**
 * Headless fixture input — used by tests when no platform JSON API is
 * wired. Mirrors the wire shape but stays fully offline. The fetcher
 * prefers the in-process catalog when no `jsonBaseUrl` is set.
 */
export interface OverviewCatalog {
  /** Pre-built usage rollup wire envelope. `null` to omit usage. */
  usageSummary: UsageSummaryWireEnvelope | null;
  /** Pre-built audit list wire envelope. `null` to omit audit. */
  auditEvents: AuditListWireEnvelope | null;
  /** Health probe wire payload. `null` to omit health. */
  health: (HealthWire & { queueIntegrity?: unknown }) | null;
}

export type OverviewTimePreset = 'today' | '24h' | '7d' | 'custom';

export interface OverviewTriageMetric {
  status: 'available' | 'unavailable' | 'stale';
  /** A real source count; null means the source did not provide a count. */
  value: number | null;
  /** Source timestamp when one is available, ISO-8601 UTC. */
  sourceUpdatedAt?: string;
  detail?: string;
}

export interface OverviewTriageSnapshot {
  failed: OverviewTriageMetric;
  timedOut: OverviewTriageMetric;
  pending: OverviewTriageMetric;
  queueLag: OverviewTriageMetric;
  connectorDegradations: OverviewTriageMetric;
  /** Time this Admin shell fetched the source snapshots, ISO-8601 UTC. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Fetcher input
// ---------------------------------------------------------------------------

/** Inputs the fetcher needs from the shell. */
export interface OverviewFetcherInput {
  /**
   * Tenant whose usage / audit to load. Empty → usage + audit are NOT
   * requested at all (F-2: the upstream answers 422 for an admin principal
   * without a tenant, which would fail the whole pane), and the pane asks
   * for a tenant instead.
   */
  tenantId: string;
  /** ISO window start. Empty → defaults to the current UTC day. */
  from?: string;
  /** ISO window end. Empty → defaults to the current UTC day. */
  to?: string;
  /** UTC window selector shown in the overview toolbar. */
  timePreset?: OverviewTimePreset;
  /** Audit list cap. Default 50. */
  auditLimit?: number;
  /** Base URL of the orchestrator JSON API. */
  jsonBaseUrl: string;
  /** Admin bearer token (sent verbatim as `Authorization: Bearer …`). */
  adminToken: string;
  /** Optional in-process catalog (test-only). */
  manifestCatalog?: OverviewCatalog;
  /** Injected fetch. Default = global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Fetcher result (discriminated union — drives the renderer's screen state)
// ---------------------------------------------------------------------------

/**
 * Rendered view models for the three overview sub-panes. The renderer
 * never sees raw wire / provider data — only these typed projections.
 */
export interface OverviewBundle {
  /** Usage rollup view; `null` when the platform did not return data. */
  usage: ReturnType<typeof buildUsageRollupView> | null;
  /** Audit list view; `null` when the platform did not return data. */
  audit: ReturnType<typeof buildAuditListView> | null;
  /** Health overview view; `null` when the platform did not return data. */
  health: ReturnType<typeof buildHealthOverviewView> | null;
  /** Snapshot metrics used by the first, triage-focused viewport. */
  triage?: OverviewTriageSnapshot;
  /** Server-side now (ISO). The renderer can use it for "as of" labels. */
  serverNow: string;
}

export interface OverviewOkResult {
  kind: 'ok';
  /** Tenant id the overview was scoped to. */
  tenantId: string;
  /** The [from, to] window the fetcher actually used. */
  from: string;
  to: string;
  bundle: OverviewBundle;
  /**
   * F-2: true when no tenant was selected, so usage/audit were NOT read and
   * the pane must ask for a tenant instead of showing empty tables.
   */
  tenantRequired?: boolean;
  /** F-2: roster for the tenant picker (empty when it could not be read). */
  tenantOptions?: readonly OverviewTenantOption[];
}

/** One tenant-picker option: the id is a value, the name is the label. */
export interface OverviewTenantOption {
  id: string;
  name: string;
  state: string;
}

export type OverviewFetchResult =
  | OverviewOkResult
  | { kind: 'empty'; message: string; tenantId?: string; from?: string; to?: string; triage?: OverviewTriageSnapshot; tenantOptions?: readonly OverviewTenantOption[] }
  | { kind: 'unauthorized'; message: string; tenantId?: string; from?: string; to?: string; triage?: OverviewTriageSnapshot; tenantOptions?: readonly OverviewTenantOption[] }
  | { kind: 'error'; message: string; tenantId?: string; from?: string; to?: string; triage?: OverviewTriageSnapshot; tenantOptions?: readonly OverviewTenantOption[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Numeric cast with a fallback for missing wire fields. */
function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** String cast with a fallback for missing wire fields. */
function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function isUsageMeasurement(v: unknown): v is UsageMeasurement {
  return v === 'measured' || v === 'estimated' || v === 'mixed' || v === 'pending';
}

const AUDIT_KIND_SET: ReadonlySet<string> = new Set<AuditEventKind>([
  'operation.cancel',
  'operation.resume',
  'operation.deadline',
  'operation.complete',
  'operation.fail',
  'webhook.delivered',
  'webhook.failed',
  'connector.rotated',
  'connector.test',
  'business.activate',
  'business.deactivate',
  'business.enable',
  'business.drain',
  'apikey.create',
  'apikey.revoke',
  // Retain truthful rendering for rows written before the canonical event rename.
  'apikey.profile_bind',
  // Real ledger kind written by the profile-binding admin mutation
  // (server.ts:1072-1079). Adopted here per PR-AUDIT-E so this kind
  // renders with its true label instead of the 'operation.complete'
  // fallback.
  'profile_binding.bind',
]);

function asAuditKind(v: unknown): AuditEventKind {
  if (typeof v === 'string' && AUDIT_KIND_SET.has(v)) return v as AuditEventKind;
  return 'operation.complete';
}

const SEVERITY_SET: ReadonlySet<string> = new Set<AuditSeverity>([
  'info',
  'success',
  'warning',
  'error',
]);

function asSeverity(v: unknown): AuditSeverity {
  if (typeof v === 'string' && SEVERITY_SET.has(v)) return v as AuditSeverity;
  return 'info';
}

function pickCatalog(input: OverviewFetcherInput): OverviewCatalog | undefined {
  return input.manifestCatalog;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Resolve the [from, to] window. Empty inputs default to the current
 * UTC day (00:00:00.000Z .. now). Pure projection — the caller may
 * pass `now` for deterministic tests.
 */
export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  nowMs: number = Date.now(),
): { from: string; to: string } {
  const now = new Date(nowMs);
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const toIso = to && to.length > 0 ? to : now.toISOString();
  const fromIso = from && from.length > 0 ? from : dayStart.toISOString();
  return { from: fromIso, to: toIso };
}

/** Resolve the named overview presets in UTC so the label and query agree. */
export function resolveOverviewPresetWindow(
  preset: OverviewTimePreset | undefined,
  from: string | undefined,
  to: string | undefined,
  nowMs: number = Date.now(),
): { from: string; to: string } {
  if (preset === 'custom') return resolveWindow(from, to, nowMs);
  if (preset === '24h') {
    return {
      from: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(nowMs).toISOString(),
    };
  }
  if (preset === '7d') {
    return {
      from: new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date(nowMs).toISOString(),
    };
  }
  return resolveWindow(undefined, undefined, nowMs);
}

function unavailableMetric(detail: string): OverviewTriageMetric {
  return { status: 'unavailable', value: null, detail };
}

function operationCountMetric(raw: unknown): OverviewTriageMetric {
  if (!isRecord(raw) || typeof raw['total'] !== 'number') {
    return unavailableMetric('The operations list did not provide a total count.');
  }
  const value = raw['total'];
  if (!Number.isSafeInteger(value) || value < 0) {
    return unavailableMetric('The operations list returned an invalid total count.');
  }
  return { status: 'available', value };
}

function queueLagMetric(rawHealth: unknown, nowMs: number): OverviewTriageMetric {
  if (!isRecord(rawHealth) || !isRecord(rawHealth['queueIntegrity'])) {
    return unavailableMetric('Queue integrity has not published a snapshot.');
  }
  const queue = rawHealth['queueIntegrity'];
  const state = queue['state'];
  const stalled = queue['stalled'];
  const lastSweepAt = queue['lastSweepAt'];
  if (
    (state !== 'OK' && state !== 'RECONSTRUCTING' && state !== 'SUSPECT') ||
    typeof stalled !== 'number' ||
    !Number.isSafeInteger(stalled) ||
    stalled < 0 ||
    typeof lastSweepAt !== 'string' ||
    !Number.isFinite(Date.parse(lastSweepAt))
  ) {
    return unavailableMetric('Queue integrity returned an incomplete snapshot.');
  }
  const ageMs = nowMs - Date.parse(lastSweepAt);
  const stale = ageMs > 120_000 || ageMs < -60_000;
  return {
    status: stale ? 'stale' : 'available',
    value: stalled,
    sourceUpdatedAt: new Date(lastSweepAt).toISOString(),
    detail: `Integrity ${state}`,
  };
}

function unavailableOverviewTriage(updatedAt: string): OverviewTriageSnapshot {
  return {
    failed: unavailableMetric('Operation count is unavailable.'),
    timedOut: unavailableMetric('Operation count is unavailable.'),
    pending: unavailableMetric('Operation count is unavailable.'),
    queueLag: unavailableMetric('Queue integrity is unavailable.'),
    connectorDegradations: unavailableMetric('Connector health is not exposed by this platform API.'),
    updatedAt,
  };
}

function buildOverviewTriage(
  failedRaw: unknown,
  timedOutRaw: unknown,
  pendingRaw: unknown,
  healthRaw: unknown,
  updatedAt: string,
  nowMs: number,
): OverviewTriageSnapshot {
  return {
    failed: operationCountMetric(failedRaw),
    timedOut: operationCountMetric(timedOutRaw),
    pending: operationCountMetric(pendingRaw),
    queueLag: queueLagMetric(healthRaw, nowMs),
    // The Admin API currently has no connector-health list or health snapshot.
    // Empty audit results are not evidence that every connector is healthy.
    connectorDegradations: unavailableMetric(
      'Connector health is not exposed by this platform API.',
    ),
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Catalog → ok result
// ---------------------------------------------------------------------------

function normaliseUsageSummary(
  raw: UsageSummaryWireEnvelope,
  tenantId: string,
  fromIso: string,
  toIso: string,
): NonNullable<OverviewBundle['usage']> {
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : [];
  const rows = rowsRaw
    .filter(isRecord)
    .map((r) => {
      const measurementRaw = r['measurement'];
      return {
        provider: asString(r['provider'], '(unattributed)'),
        model: asString(r['model'], '(unattributed)'),
        operations: asNumber(r['operations'], 0),
        inputTokens: asNumber(r['inputTokens'], 0),
        outputTokens: asNumber(r['outputTokens'], 0),
        pages: asNumber(r['pages'], 0),
        costMicrousd: asNumber(r['costMicrousd'], 0),
        measurement: isUsageMeasurement(measurementRaw) ? measurementRaw : 'pending',
      };
    });
  const totalsRaw = isRecord(raw.totals) ? raw.totals : {};
  const totals: UsageRollupTotals = {
    operations: asNumber(totalsRaw['operations'], 0),
    inputTokens: asNumber(totalsRaw['inputTokens'], 0),
    outputTokens: asNumber(totalsRaw['outputTokens'], 0),
    pages: asNumber(totalsRaw['pages'], 0),
    costMicrousd: asNumber(totalsRaw['costMicrousd'], 0),
  };
  return buildUsageRollupView({
    tenantId: asString(raw.tenantId, tenantId),
    from: asString(raw.from, fromIso),
    to: asString(raw.to, toIso),
    rows,
    totals,
  });
}

function normaliseAuditEvents(
  raw: AuditListWireEnvelope,
  tenantId: string,
): NonNullable<OverviewBundle['audit']> {
  // W-ADMUX02-EXT-1: /api/v1/admin/audit now returns the standard page
  // envelope, whose key is `items`. `events` is still read so an older build
  // behind the shell renders instead of looking like a zero-event ledger.
  const eventRows = raw['items'] ?? raw['events'];
  const eventsRaw = Array.isArray(eventRows) ? eventRows : [];
  const rows: AuditEventRow[] = eventsRaw
    .filter(isRecord)
    .map((r) => ({
      id: asString(r['id'], ''),
      kind: asAuditKind(r['kind']),
      severity: asSeverity(r['severity']),
      occurredAt: asString(r['occurredAt'], ''),
      tenantId: asString(r['tenantId'], tenantId),
      resourceId: asString(r['resourceId'], ''),
      actor: asString(r['actor'], 'system'),
      message: asString(r['message'], '').slice(0, 256),
    }))
    .filter((r) => r.id.length > 0);
  return buildAuditListView({ tenantId, events: rows });
}

function buildOkFromCatalog(
  catalog: OverviewCatalog,
  tenantId: string,
  fromIso: string,
  toIso: string,
  serverNow: string,
): OverviewFetchResult {
  const triage = buildOverviewTriage(
    undefined,
    undefined,
    undefined,
    catalog.health,
    serverNow,
    Date.parse(serverNow),
  );
  const usage =
    catalog.usageSummary !== null
      ? normaliseUsageSummary(catalog.usageSummary, tenantId, fromIso, toIso)
      : null;
  const audit =
    catalog.auditEvents !== null
      ? normaliseAuditEvents(catalog.auditEvents, tenantId)
      : null;
  const health = catalog.health !== null ? buildHealthOverviewView(catalog.health) : null;

  const usageHasRows = !!usage && usage.hasRows;
  const auditHasRows = !!audit && audit.hasEvents;
  if (!usageHasRows && !auditHasRows && !health) {
    return {
      kind: 'empty',
      message:
        'No usage, audit, or health data is available yet. Submit an operation to seed the overview.',
      tenantId,
      from: fromIso,
      to: toIso,
      triage,
    };
  }

  return {
    kind: 'ok',
    tenantId,
    from: fromIso,
    to: toIso,
    bundle: { usage, audit, health, serverNow, triage },
    tenantRequired: tenantId.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Wire → ok result
// ---------------------------------------------------------------------------

function parseUsageSummary(
  raw: unknown,
  tenantId: string,
  fromIso: string,
  toIso: string,
): NonNullable<OverviewBundle['usage']> | { error: string } {
  if (!isRecord(raw)) return { error: 'Usage endpoint returned a non-object payload.' };
  return normaliseUsageSummary(raw as UsageSummaryWireEnvelope, tenantId, fromIso, toIso);
}

function parseAuditEvents(
  raw: unknown,
  tenantId: string,
): NonNullable<OverviewBundle['audit']> | { error: string } {
  if (!isRecord(raw)) return { error: 'Audit endpoint returned a non-object payload.' };
  return normaliseAuditEvents(raw as AuditListWireEnvelope, tenantId);
}

function parseHealth(raw: unknown): NonNullable<OverviewBundle['health']> | { error: string } {
  if (!isRecord(raw)) return { error: 'Health endpoint returned a non-object payload.' };
  const status = raw['status'];
  if (status !== 'ok' && status !== 'degraded') {
    return { error: 'Health endpoint returned an unknown status.' };
  }
  const out: HealthWire = {
    status,
    db: raw['db'] === true,
    redis: raw['redis'] === true,
    activeLeases: asNumber(raw['activeLeases'], 0),
  };
  return buildHealthOverviewView(out);
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch the overview (usage + audit + health + tenant roster) for the shell.
 * Returns a discriminated result the renderer can map onto a screen state.
 * **Never throws** — transport errors collapse into `{ kind: 'error', ... }`.
 *
 * F-2: the roster read rides the same request as the bundle so the picker
 * and the panes always describe the same snapshot. It is fail-closed
 * (`fetchTenantOptions` never throws and never surfaces upstream text), so a
 * roster failure can only ever empty the picker, never fail the pane.
 */
export async function fetchOverview(
  input: OverviewFetcherInput,
): Promise<OverviewFetchResult> {
  const [result, tenantOptions] = await Promise.all([
    fetchOverviewCore(input),
    fetchTenantOptions({
      jsonBaseUrl: input.jsonBaseUrl,
      adminToken: input.adminToken,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    }),
  ]);
  switch (result.kind) {
    case 'ok':
      return { ...result, tenantOptions };
    case 'empty':
      return { ...result, tenantOptions };
    case 'unauthorized':
      return { ...result, tenantOptions };
    case 'error':
      return { ...result, tenantOptions };
  }
}

async function fetchOverviewCore(
  input: OverviewFetcherInput,
): Promise<OverviewFetchResult> {
  const tenantId = input.tenantId;
  const tenantRequired = tenantId.length === 0;
  const auditLimit = input.auditLimit ?? 50;
  const nowMs = Date.now();
  const { from: fromIso, to: toIso } = input.timePreset
    ? resolveOverviewPresetWindow(input.timePreset, input.from, input.to, nowMs)
    : resolveWindow(input.from, input.to, nowMs);
  const serverNow = new Date(nowMs).toISOString();
  const unavailableTriage = unavailableOverviewTriage(serverNow);

  // Offline path.
  if (!input.jsonBaseUrl) {
    const catalog = pickCatalog(input);
    if (!catalog) {
      return {
        kind: 'empty',
        message:
          'No usage, audit, or health data is available yet. Submit an operation to seed the overview.',
        tenantId,
        from: fromIso,
        to: toIso,
        triage: unavailableTriage,
      };
    }
    return buildOkFromCatalog(catalog, tenantId, fromIso, toIso, serverNow);
  }

  if (!input.adminToken) {
    return {
      kind: 'unauthorized',
      message: 'Admin bearer token is not configured.',
      tenantId,
      from: fromIso,
      to: toIso,
      triage: unavailableTriage,
    };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;

  // Build URLs.
  let usageUrl: URL;
  let auditUrl: URL;
  let healthUrl: URL;
  let operationCountUrls: URL[];
  try {
    const usageQuery = new URLSearchParams();
    if (tenantId.length > 0) usageQuery.set('tenantId', tenantId);
    usageQuery.set('from', fromIso);
    usageQuery.set('to', toIso);
    usageUrl = new URL(`/api/v1/usage?${usageQuery.toString()}`, input.jsonBaseUrl);

    const auditQuery = new URLSearchParams();
    if (tenantId.length > 0) auditQuery.set('tenantId', tenantId);
    auditQuery.set('limit', auditLimit.toString());
    auditUrl = new URL(`/api/v1/admin/audit?${auditQuery.toString()}`, input.jsonBaseUrl);

    healthUrl = new URL('/api/v1/health', input.jsonBaseUrl);
    operationCountUrls = ['FAILED', 'TIMED_OUT', 'RUNNING'].map((state) => {
      const operationQuery = new URLSearchParams({ state, limit: '1' });
      if (tenantId.length > 0) operationQuery.set('tenant', tenantId);
      return new URL(`/api/v1/operations?${operationQuery.toString()}`, input.jsonBaseUrl);
    });
  } catch {
    return {
      kind: 'error',
      message: 'Invalid platform JSON API base URL.',
      tenantId,
      from: fromIso,
      to: toIso,
      triage: unavailableTriage,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    authorization: `Bearer ${input.adminToken}`,
    accept: 'application/json',
    'x-correlation-id': `p6-07-${nowMs.toString(36)}`,
  };

  try {
    const requestJson = (url: URL, allowDegradedHealth = false): Promise<unknown> =>
      fetchImpl(url.toString(), { method: 'GET', headers, signal: controller.signal })
        .then((res) => asJson(res, allowDegradedHealth))
        .catch((err) => ({
          __err: err instanceof Error && err.name === 'AbortError' ? 'aborted' : errorClassOf(err),
        }));

    // F-2: with no tenant selected, usage and audit are NOT requested — the
    // upstream answers 422 for an admin principal without a tenant, and that
    // single 422 used to fail the whole pane. Health and the operation counts
    // stay platform-wide, exactly as before.
    const [usageRaw, auditRaw, healthRaw, failedRaw, timedOutRaw, pendingRaw] = await Promise.all([
      tenantRequired ? Promise.resolve(null) : requestJson(usageUrl),
      tenantRequired ? Promise.resolve(null) : requestJson(auditUrl),
      requestJson(healthUrl, true),
      requestJson(operationCountUrls[0]!),
      requestJson(operationCountUrls[1]!),
      requestJson(operationCountUrls[2]!),
    ]);
    const triage = buildOverviewTriage(
      failedRaw,
      timedOutRaw,
      pendingRaw,
      healthRaw,
      serverNow,
      nowMs,
    );

    // Map transport errors → unified shape.
    const usageErr = isErrPayload(usageRaw) ? usageRaw : null;
    const auditErr = isErrPayload(auditRaw) ? auditRaw : null;
    const healthErr = isErrPayload(healthRaw) ? healthRaw : null;

    if (usageErr || auditErr || healthErr) {
      const aborted =
        controller.signal.aborted ||
        (usageErr?.__err?.includes('aborted') ?? false) ||
        (auditErr?.__err?.includes('aborted') ?? false) ||
        (healthErr?.__err?.includes('aborted') ?? false);
      if (aborted) {
        return {
          kind: 'error',
          message: `Timed out after ${timeoutMs}ms waiting for the platform.`,
          tenantId,
          from: fromIso,
          to: toIso,
          triage,
        };
      }
      return {
        kind: 'error',
        message: safeTransportErrorText('Network error contacting the platform'),
        tenantId,
        from: fromIso,
        to: toIso,
        triage,
      };
    }

    // Authn — treat 401/403 from any endpoint as `unauthorized`.
    const unauthorized =
      isUnauthorizedPayload(usageRaw) ||
      isUnauthorizedPayload(auditRaw) ||
      isUnauthorizedPayload(healthRaw) ||
      isUnauthorizedPayload(failedRaw) ||
      isUnauthorizedPayload(timedOutRaw) ||
      isUnauthorizedPayload(pendingRaw);
    if (unauthorized) {
      return {
        kind: 'unauthorized',
        message: 'Platform rejected the admin token (HTTP 401/403).',
        tenantId,
        from: fromIso,
        to: toIso,
        triage,
      };
    }

    // Parse each payload.
    const usage = tenantRequired ? null : parseUsageSummary(usageRaw, tenantId, fromIso, toIso);
    const audit = tenantRequired ? null : parseAuditEvents(auditRaw, tenantId);
    const health = parseHealth(healthRaw);
    if (usage !== null && 'error' in usage) {
      return { kind: 'error', message: usage.error, tenantId, from: fromIso, to: toIso, triage };
    }
    if (audit !== null && 'error' in audit) {
      return { kind: 'error', message: audit.error, tenantId, from: fromIso, to: toIso, triage };
    }
    if ('error' in health) {
      return { kind: 'error', message: health.error, tenantId, from: fromIso, to: toIso, triage };
    }

    return {
      kind: 'ok',
      tenantId,
      from: fromIso,
      to: toIso,
      bundle: { usage, audit, health, serverNow, triage },
      tenantRequired,
    };
  } catch (err) {
    const aborted =
      controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    return {
      kind: 'error',
      message: aborted
        ? `Timed out after ${timeoutMs}ms waiting for the platform.`
        : safeTransportErrorText('Network error contacting the platform'),
      tenantId,
      from: fromIso,
      to: toIso,
      triage: unavailableTriage,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tenant roster (F-2 — the overview picker's options)
// ---------------------------------------------------------------------------

/** One roster page is capped by the shared admin list limit (200). */
const TENANT_ROSTER_PAGE_LIMIT = ADMIN_LIST_LIMIT_MAX;
/** Bounded walk: the picker is a convenience, never an unbounded crawl. */
const TENANT_ROSTER_MAX_PAGES = 10;

/**
 * Read the tenant roster for the overview picker (F-2).
 *
 * Fail-closed by construction: a missing token / base URL, a transport error,
 * a non-2xx status or an unreadable body yields the options read so far —
 * empty on the first page — and never a thrown error, an upstream message, a
 * response body or a stack. The scope is the credential's: the route derives
 * it through the same `authorizeAuditTenantRead` path the roster list uses,
 * so a tenant operator only ever receives its own row and this reader cannot
 * widen it. Rows without a usable id AND name are dropped rather than
 * rendered as a bare id.
 */
export async function fetchTenantOptions(input: {
  jsonBaseUrl: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OverviewTenantOption[]> {
  if (input.jsonBaseUrl.length === 0 || input.adminToken.length === 0) return [];
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? 4000;
  const options: OverviewTenantOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < TENANT_ROSTER_MAX_PAGES; page += 1) {
    let url: URL;
    try {
      url = new URL('/api/v1/admin/tenants', input.jsonBaseUrl);
      url.searchParams.set('limit', String(TENANT_ROSTER_PAGE_LIMIT));
      if (cursor !== null) url.searchParams.set('cursor', cursor);
    } catch {
      return options;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${input.adminToken}`, accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return options;
      const body: unknown = await res.json().catch(() => null);
      if (!isRecord(body) || !Array.isArray(body['items'])) return options;
      for (const item of body['items']) {
        const option = toTenantOption(item);
        if (option) options.push(option);
      }
      const next = typeof body['nextCursor'] === 'string' && body['nextCursor'].length > 0
        ? body['nextCursor']
        : null;
      if (next === null || seenCursors.has(next)) return options;
      seenCursors.add(next);
      cursor = next;
    } catch {
      return options;
    } finally {
      clearTimeout(timer);
    }
  }
  return options;
}

/** Strict-enough row mapping: no id or no name → the row is not offered. */
function toTenantOption(raw: unknown): OverviewTenantOption | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (id.length === 0 || name.length === 0) return null;
  const state = typeof raw['state'] === 'string' ? raw['state'] : '';
  return { id, name, state };
}

// ---------------------------------------------------------------------------
// JSON / error helpers (private)
// ---------------------------------------------------------------------------

interface ErrPayload {
  __err: string;
}

function isErrPayload(v: unknown): v is ErrPayload {
  return isRecord(v) && typeof v['__err'] === 'string';
}

interface UnauthorizedPayload {
  __status: 401 | 403;
}

function isUnauthorizedPayload(v: unknown): v is UnauthorizedPayload {
  return (
    isRecord(v) && (v['__status'] === 401 || v['__status'] === 403)
  );
}

async function asJson(
  res: unknown,
  allowDegradedHealth = false,
): Promise<unknown | UnauthorizedPayload | ErrPayload> {
  if (!isRecord(res)) {
    return { __err: 'Transport returned a non-Response value.' };
  }
  const status = (res as { status?: unknown })['status'];
  if (status === 401 || status === 403) {
    return { __status: status as 401 | 403 };
  }
  const allowStatus503 = allowDegradedHealth && status === 503;
  if (
    typeof (res as { ok?: unknown }).ok === 'boolean' &&
    !(res as { ok: boolean }).ok &&
    !allowStatus503
  ) {
    const text = await (res as { text: () => Promise<string> }).text().catch(() => '');
    return { __err: sanitizeUpstreamErrorBody(text) || `HTTP ${String(status)}` };
  }
  const text = await (res as { text: () => Promise<string> }).text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __err: 'Non-JSON payload.' };
  }
}

// ---------------------------------------------------------------------------
// Helpers re-exported for tests
// ---------------------------------------------------------------------------

export const __test = {
  normaliseUsageSummary,
  normaliseAuditEvents,
  parseUsageSummary,
  parseAuditEvents,
  parseHealth,
  buildOkFromCatalog,
  resolveWindow,
  isUsageMeasurement,
  asAuditKind,
  asSeverity,
};

/** Type guard for the renderer / tests. */
export function isOverviewOkResult(f: OverviewFetchResult): f is OverviewOkResult {
  return f.kind === 'ok';
}
