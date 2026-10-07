/**
 * Pure Overview View Models (P6-07 headless foundation).
 *
 * Scope: pure functions that map server-side wire/domain shapes into
 * UI-ready view models for the Admin Overview page:
 *
 *   1. Usage rollup by provider / model, tenant-scoped.
 *   2. Audit event list projection.
 *   3. Operational health overview projection that **reuses** the
 *      existing `GET /api/v1/health` wire shape
 *      (`{status, db, redis, activeLeases}`) rather than inventing a
 *      second shape.
 *
 * Hard rule: never echo secret / credential / header material; never
 * invent a parallel health schema — the renderer should be able to
 * consume the same shape the platform already emits.
 *
 * Pure and offline: Zero DB activity, zero HTTP I/O, zero framework
 * dependencies, strict TypeScript with zero `any`.
 */

// ---------------------------------------------------------------------------
// 1. Usage rollup
// ---------------------------------------------------------------------------

/**
 * Measurement kind carried on every usage rollup row. Mirrors the
 * frozen `@du/contracts` `UsageEvent.measurement` domain.
 */
export type UsageMeasurement = 'measured' | 'estimated' | 'mixed' | 'pending';

/**
 * A single usage row projected from the wire `UsageSummaryRow` shape
 * (P2-07 tenant usage projection). Provider / model collapse to
 * `'(unattributed)'` when the underlying payload does not carry the
 * field — the server-side rollup does the same collapse so the UI
 * never invents attribution that isn't there.
 */
export interface UsageRollupRow {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  measurement: UsageMeasurement;
  /** Renderer-safe badge variant derived from `measurement`. */
  measurementBadge: 'success' | 'warning' | 'neutral';
  /** Renderer-safe human label derived from `measurement`. */
  measurementLabel: string;
}

/**
 * Tenant-scoped totals that mirror the wire `UsageSummary.totals`
 * block (operations + inputTokens + outputTokens + pages + costMicrousd).
 */
export interface UsageRollupTotals {
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
}

/**
 * Full usage rollup view. The tenant id is preserved so the renderer
 * can label the pane (`Tenant: <id>`); the [from, to] window is
 * preserved verbatim so the renderer can show "showing <from> – <to>".
 */
export interface UsageRollupView {
  tenantId: string;
  from: string;
  to: string;
  rows: UsageRollupRow[];
  totals: UsageRollupTotals;
  /** True when at least one row was rolled up. */
  hasRows: boolean;
  /** True when every row is in the `(unattributed)` bucket. */
  allUnattributed: boolean;
}

// ---------------------------------------------------------------------------
// 2. Audit event list
// ---------------------------------------------------------------------------

/**
 * Audit event kind. The platform already emits lifecycle / runtime /
 * webhook / usage events; the view model tags them so the renderer can
 * filter and badge.
 *
 * - `operation.cancel`      — operator cancelled a running op.
 * - `operation.resume`      — operator answered a human wait.
 * - `operation.deadline`    — lifecycle sweep closed a deadline-expired op.
 * - `operation.complete`    — a worker reported a terminal completion.
 * - `operation.fail`        — a worker / join / lease sweep failed an op.
 * - `webhook.delivered`     — webhook dispatcher POSTed a delivery.
 * - `webhook.failed`        — webhook delivery exhausted its retry budget.
 * - `connector.rotated`     — connector secret rotation completed.
 * - `connector.test`        — connector test action recorded an outcome.
 * - `business.activate`     — admin activated a business version.
 * - `business.deactivate`   — admin deactivated a business version.
 * - `business.enable`       — admin enabled a business version.
 * - `business.drain`        — admin drained a business version.
 * - `apikey.create`         — admin issued an API key (no raw key value).
 * - `apikey.revoke`         — admin revoked an API key.
 * - `profile_binding.bind` -- grants a profile binding to an API key.
 * - `apikey.profile_bind`   — legacy ledger spelling retained for old rows.
 */
export type AuditEventKind =
  | 'operation.cancel'
  | 'operation.resume'
  | 'operation.deadline'
  | 'operation.complete'
  | 'operation.fail'
  | 'webhook.delivered'
  | 'webhook.failed'
  | 'connector.rotated'
  | 'connector.test'
  | 'business.activate'
  | 'business.deactivate'
  | 'business.enable'
  | 'business.drain'
  | 'apikey.create'
  | 'apikey.revoke'
  | 'apikey.profile_bind'
  | 'profile_binding.bind';

/**
 * Severity tier for the renderer badge. Mapping:
 *   - `info`     — normal lifecycle events.
 *   - `success`  — terminal positive events.
 *   - `warning`  — retries, drains, deadline closures.
 *   - `error`    — failures and exhausted budgets.
 */
export type AuditSeverity = 'info' | 'success' | 'warning' | 'error';

/**
 * A single audit event wire row. `actor` is a stable identifier
 * (`'system'`, `'admin:<bearer>'`, or an API key id) — never the raw
 * bearer token or credential.
 */
export interface AuditEventRow {
  /** Server-issued event id. */
  id: string;
  kind: AuditEventKind;
  severity: AuditSeverity;
  /** ISO timestamp; the renderer should display it verbatim. */
  occurredAt: string;
  /** Tenant id the event belongs to (cross-tenant visibility blocked). */
  tenantId: string;
  /** Resource id the event refers to (operation, business, connector, etc.). */
  resourceId: string;
  /** Stable actor identifier; never a raw credential. */
  actor: string;
  /** Free-form, sanitizer-safe message; no upstream response bodies / headers. */
  message: string;
}

/**
 * Rendered audit event view (derived from a wire row). Carries the
 * renderer-safe label and severity badge alongside the row's
 * structural fields. The wire shape (`AuditEventRow`) is the input;
 * `AuditEventView` is what the renderer consumes.
 */
export interface AuditEventView {
  id: string;
  kind: AuditEventKind;
  /** Renderer-safe human label derived from `kind`. */
  kindLabel: string;
  severity: AuditSeverity;
  /** Renderer-safe badge variant derived from `severity`. */
  severityBadge: 'success' | 'warning' | 'error' | 'neutral';
  occurredAt: string;
  tenantId: string;
  resourceId: string;
  actor: string;
  message: string;
}

/**
 * Rendered audit list view. The renderer reads `events` in `newest
 * first` order; `kinds` and `severities` let you offer filter chips
 * without re-scanning.
 */
export interface AuditListView {
  tenantId: string;
  /** Newest-first ordering. */
  events: AuditEventView[];
  /** Unique `kind`s present in this view (renderer filter chips). */
  kinds: AuditEventKind[];
  /** Unique `severity`s present in this view. */
  severities: AuditSeverity[];
  /** True when at least one event is present. */
  hasEvents: boolean;
}

// ---------------------------------------------------------------------------
// 3. Operational health overview (reuses GET /api/v1/health shape)
// ---------------------------------------------------------------------------

/**
 * Wire shape that mirrors what `GET /api/v1/health` returns
 * (server.ts line 338–344). The view model reuses this shape rather
 * than inventing a parallel one, so the Admin overview pane and any
 * other health consumer see the same payload.
 *
 * - `status` — overall `'ok'` or `'degraded'`.
 * - `db`     — postgres `SELECT 1` probe.
 * - `redis`  — redis `PING` probe.
 * - `activeLeases` — running-lease count surfaced by runtime.
 */
export interface HealthWire {
  status: 'ok' | 'degraded';
  db: boolean;
  redis: boolean;
  activeLeases: number;
}

/**
 * Rendered health overview view. Pure projection; the badge variant
 * is derived from the `status` field so the renderer doesn't have to
 * re-implement the ok/degraded mapping.
 */
export interface HealthOverviewView {
  status: 'ok' | 'degraded';
  /** Renderer-safe badge variant. */
  badge: 'success' | 'error';
  /** Renderer-safe human label. */
  statusLabel: string;
  db: boolean;
  /** Renderer-safe badge variant. */
  dbBadge: 'success' | 'error';
  /** Renderer-safe human label. */
  dbLabel: string;
  redis: boolean;
  redisBadge: 'success' | 'error';
  redisLabel: string;
  activeLeases: number;
  /** True when both db and redis probes passed. */
  fullyHealthy: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEASUREMENT_META: {
  readonly [K in UsageMeasurement]: { readonly badge: 'success' | 'warning' | 'neutral'; readonly label: string };
} = {
  measured: { badge: 'success', label: 'Measured' },
  estimated: { badge: 'warning', label: 'Estimated' },
  mixed: { badge: 'warning', label: 'Mixed' },
  pending: { badge: 'neutral', label: 'Pending' },
};

export function usageMeasurementBadge(m: UsageMeasurement): 'success' | 'warning' | 'neutral' {
  return MEASUREMENT_META[m].badge;
}

export function usageMeasurementLabel(m: UsageMeasurement): string {
  return MEASUREMENT_META[m].label;
}

const AUDIT_KIND_META: {
  readonly [K in AuditEventKind]: { readonly severity: AuditSeverity; readonly label: string };
} = {
  'operation.cancel': { severity: 'warning', label: 'Operation cancelled' },
  'operation.resume': { severity: 'info', label: 'Operation resumed' },
  'operation.deadline': { severity: 'warning', label: 'Operation deadline expired' },
  'operation.complete': { severity: 'success', label: 'Operation completed' },
  'operation.fail': { severity: 'error', label: 'Operation failed' },
  'webhook.delivered': { severity: 'success', label: 'Webhook delivered' },
  'webhook.failed': { severity: 'error', label: 'Webhook delivery failed' },
  'connector.rotated': { severity: 'info', label: 'Connector secret rotated' },
  'connector.test': { severity: 'info', label: 'Connector test run' },
  'business.activate': { severity: 'info', label: 'Business version activated' },
  'business.deactivate': { severity: 'warning', label: 'Business version deactivated' },
  'business.enable': { severity: 'success', label: 'Business version enabled' },
  'business.drain': { severity: 'warning', label: 'Business version drained' },
  'apikey.create': { severity: 'info', label: 'API key created' },
  'apikey.revoke': { severity: 'warning', label: 'API key revoked' },
  'apikey.profile_bind': { severity: 'info', label: 'Profile binding granted' },
  'profile_binding.bind': { severity: 'info', label: 'Profile binding granted' },
};

export function auditKindLabel(kind: AuditEventKind): string {
  return AUDIT_KIND_META[kind].label;
}

export function auditKindSeverity(kind: AuditEventKind): AuditSeverity {
  return AUDIT_KIND_META[kind].severity;
}

export function auditSeverityBadge(s: AuditSeverity): 'success' | 'warning' | 'error' | 'neutral' {
  switch (s) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    case 'info':
      return 'neutral';
  }
}

const UNATTRIBUTED = '(unattributed)';

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/**
 * Build a single usage rollup row from a wire row. Pure projection:
 * carries the badge + label for the renderer.
 */
export function buildUsageRollupRow(wire: {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  measurement: UsageMeasurement;
}): UsageRollupRow {
  return {
    provider: wire.provider,
    model: wire.model,
    operations: wire.operations,
    inputTokens: wire.inputTokens,
    outputTokens: wire.outputTokens,
    pages: wire.pages,
    costMicrousd: wire.costMicrousd,
    measurement: wire.measurement,
    measurementBadge: usageMeasurementBadge(wire.measurement),
    measurementLabel: usageMeasurementLabel(wire.measurement),
  };
}

/**
 * Build the full usage rollup view from the wire `UsageSummary`
 * shape. Preserves tenant id and window, derives `hasRows` and
 * `allUnattributed` so the renderer can show the right empty-state
 * copy.
 */
export function buildUsageRollupView(wire: {
  tenantId: string;
  from: string;
  to: string;
  rows: ReadonlyArray<{
    provider: string;
    model: string;
    operations: number;
    inputTokens: number;
    outputTokens: number;
    pages: number;
    costMicrousd: number;
    measurement: UsageMeasurement;
  }>;
  totals: UsageRollupTotals;
}): UsageRollupView {
  const rows = wire.rows.map(buildUsageRollupRow);
  const hasRows = rows.length > 0;
  const allUnattributed =
    hasRows && rows.every((r) => r.provider === UNATTRIBUTED && r.model === UNATTRIBUTED);
  return {
    tenantId: wire.tenantId,
    from: wire.from,
    to: wire.to,
    rows,
    totals: wire.totals,
    hasRows,
    allUnattributed,
  };
}

/**
 * Build a single audit event view from a wire row. Pure projection:
 * carries the renderer-safe `kindLabel` and `severityBadge` derived
 * from the kind + severity, so the renderer does not have to
 * re-implement the kind → label map.
 */
export function buildAuditEventView(row: AuditEventRow): AuditEventView {
  const severity = auditKindSeverity(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: auditKindLabel(row.kind),
    severity,
    severityBadge: auditSeverityBadge(severity),
    occurredAt: row.occurredAt,
    tenantId: row.tenantId,
    resourceId: row.resourceId,
    actor: row.actor,
    message: row.message,
  };
}

/**
 * Build the audit list view from a tenant-scoped list of audit
 * events. Newest-first ordering is preserved; the caller is
 * responsible for supplying events in that order.
 *
 * Tenant scoping is enforced at the input level: any event whose
 * `tenantId` does not match the view's `tenantId` is dropped. The
 * renderer can rely on this for cross-tenant isolation.
 */
export function buildAuditListView(input: {
  tenantId: string;
  events: ReadonlyArray<AuditEventRow>;
}): AuditListView {
  const filtered = input.events.filter((e) => e.tenantId === input.tenantId);
  const events = filtered.map(buildAuditEventView);
  const kinds: AuditEventKind[] = [];
  const severities: AuditSeverity[] = [];
  const seenKind = new Set<AuditEventKind>();
  const seenSev = new Set<AuditSeverity>();
  for (const e of events) {
    if (!seenKind.has(e.kind)) {
      seenKind.add(e.kind);
      kinds.push(e.kind);
    }
    if (!seenSev.has(e.severity)) {
      seenSev.add(e.severity);
      severities.push(e.severity);
    }
  }
  return {
    tenantId: input.tenantId,
    events,
    kinds,
    severities,
    hasEvents: events.length > 0,
  };
}

/**
 * Build the health overview view from the wire `GET /api/v1/health`
 * shape. The wire shape is reused verbatim — `status`, `db`, `redis`,
 * `activeLeases` flow through unchanged; only the badge + label
 * companions are added.
 */
export function buildHealthOverviewView(wire: HealthWire): HealthOverviewView {
  const fullyHealthy = wire.db && wire.redis;
  return {
    status: wire.status,
    badge: wire.status === 'ok' ? 'success' : 'error',
    statusLabel: wire.status === 'ok' ? 'OK' : 'Degraded',
    db: wire.db,
    dbBadge: wire.db ? 'success' : 'error',
    dbLabel: wire.db ? 'Healthy' : 'Unreachable',
    redis: wire.redis,
    redisBadge: wire.redis ? 'success' : 'error',
    redisLabel: wire.redis ? 'Healthy' : 'Unreachable',
    activeLeases: wire.activeLeases,
    fullyHealthy,
  };
}
