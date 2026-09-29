/**
 * Unit tests for P6-07 pure Overview View Models (W39-O3 headless slice).
 *
 * Validates:
 *
 *   1. Usage rollup:
 *      - `usageMeasurementBadge` / `usageMeasurementLabel` for all 4 kinds.
 *      - `buildUsageRollupRow` carries badge + label.
 *      - `buildUsageRollupView` preserves tenant id + window, derives
 *        `hasRows` and `allUnattributed`.
 *      - Tenant id is preserved verbatim.
 *
 *   2. Audit event list:
 *      - `auditKindLabel` / `auditKindSeverity` for all 15 kinds.
 *      - `auditSeverityBadge` for all 4 severities.
 *      - `buildAuditEventView` carries `kindLabel` + `severityBadge`.
 *      - `buildAuditListView` enforces tenant scoping (cross-tenant
 *        events dropped) and emits unique `kinds` + `severities` lists.
 *
 *   3. Health overview (reuses GET /api/v1/health wire shape):
 *      - `buildHealthOverviewView` accepts the wire shape verbatim,
 *        carries badge + label for status / db / redis, and surfaces
 *        `fullyHealthy`. HTTP 503 → degraded.
 *
 * Hard contracts asserted:
 *   - Wire shape `HealthWire` matches `GET /api/v1/health`.
 *   - No raw secret / credential / bearer token ever projected.
 *   - The view model does not invent a parallel health schema; tests
 *     assert the wire shape fields flow through unchanged.
 *
 * Pure offline tests: Zero database activity, zero HTTP calls, strict
 * TypeScript without `any`.
 */

import {
  auditKindLabel,
  auditKindSeverity,
  auditSeverityBadge,
  buildAuditEventView,
  buildAuditListView,
  buildHealthOverviewView,
  buildUsageRollupRow,
  buildUsageRollupView,
  usageMeasurementBadge,
  usageMeasurementLabel,
  type AuditEventKind,
  type AuditEventRow,
  type HealthWire,
  type UsageMeasurement,
} from '../src/app/admin/overview-view-models';

// ---------------------------------------------------------------------------
// 1. Usage rollup
// ---------------------------------------------------------------------------

describe('W39-O3 P6-07: usageMeasurementBadge / usageMeasurementLabel', () => {
  const cases: Array<{ kind: UsageMeasurement; badge: 'success' | 'warning' | 'neutral'; label: string }> = [
    { kind: 'measured', badge: 'success', label: 'Measured' },
    { kind: 'estimated', badge: 'warning', label: 'Estimated' },
    { kind: 'mixed', badge: 'warning', label: 'Mixed' },
    { kind: 'pending', badge: 'neutral', label: 'Pending' },
  ];

  test.each(cases)('$kind -> $badge / $label', ({ kind, badge, label }) => {
    expect(usageMeasurementBadge(kind)).toBe(badge);
    expect(usageMeasurementLabel(kind)).toBe(label);
  });
});

describe('W39-O3 P6-07: buildUsageRollupRow', () => {
  test('projection carries wire fields verbatim and derives badge + label', () => {
    const row = buildUsageRollupRow({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operations: 7,
      inputTokens: 1234,
      outputTokens: 567,
      pages: 9,
      costMicrousd: 8450,
      measurement: 'measured',
    });
    expect(row).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operations: 7,
      inputTokens: 1234,
      outputTokens: 567,
      pages: 9,
      costMicrousd: 8450,
      measurement: 'measured',
      measurementBadge: 'success',
      measurementLabel: 'Measured',
    });
  });

  test('attribution gap collapses to (unattributed) bucket, neutral badge', () => {
    const row = buildUsageRollupRow({
      provider: '(unattributed)',
      model: '(unattributed)',
      operations: 3,
      inputTokens: 0,
      outputTokens: 0,
      pages: 0,
      costMicrousd: 0,
      measurement: 'pending',
    });
    expect(row.measurementBadge).toBe('neutral');
    expect(row.measurementLabel).toBe('Pending');
    expect(row.provider).toBe('(unattributed)');
    expect(row.model).toBe('(unattributed)');
  });
});

describe('W39-O3 P6-07: buildUsageRollupView (tenant-scoped rollup)', () => {
  test('preserves tenant id + window and derives hasRows + allUnattributed', () => {
    const view = buildUsageRollupView({
      tenantId: 'tenant-A',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-23T00:00:00.000Z',
      rows: [
        {
          provider: '(unattributed)',
          model: '(unattributed)',
          operations: 5,
          inputTokens: 100,
          outputTokens: 50,
          pages: 0,
          costMicrousd: 0,
          measurement: 'pending',
        },
      ],
      totals: {
        operations: 5,
        inputTokens: 100,
        outputTokens: 50,
        pages: 0,
        costMicrousd: 0,
      },
    });
    expect(view.tenantId).toBe('tenant-A');
    expect(view.from).toBe('2026-09-01T00:00:00.000Z');
    expect(view.to).toBe('2026-09-23T00:00:00.000Z');
    expect(view.hasRows).toBe(true);
    expect(view.allUnattributed).toBe(true);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.measurementBadge).toBe('neutral');
  });

  test('mixed attribution yields allUnattributed=false', () => {
    const view = buildUsageRollupView({
      tenantId: 'tenant-B',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-23T00:00:00.000Z',
      rows: [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          operations: 3,
          inputTokens: 100,
          outputTokens: 0,
          pages: 0,
          costMicrousd: 0,
          measurement: 'measured',
        },
        {
          provider: '(unattributed)',
          model: '(unattributed)',
          operations: 1,
          inputTokens: 0,
          outputTokens: 0,
          pages: 0,
          costMicrousd: 0,
          measurement: 'pending',
        },
      ],
      totals: {
        operations: 4,
        inputTokens: 100,
        outputTokens: 0,
        pages: 0,
        costMicrousd: 0,
      },
    });
    expect(view.allUnattributed).toBe(false);
    expect(view.hasRows).toBe(true);
    expect(view.rows).toHaveLength(2);
  });

  test('empty rows yields hasRows=false and allUnattributed=false', () => {
    const view = buildUsageRollupView({
      tenantId: 'tenant-C',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-23T00:00:00.000Z',
      rows: [],
      totals: {
        operations: 0,
        inputTokens: 0,
        outputTokens: 0,
        pages: 0,
        costMicrousd: 0,
      },
    });
    expect(view.hasRows).toBe(false);
    expect(view.allUnattributed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Audit event list
// ---------------------------------------------------------------------------

const ALL_KINDS: AuditEventKind[] = [
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
  'apikey.profile_bind',
  'profile_binding.bind',
];

describe('W39-O3 P6-07: auditKindLabel / auditKindSeverity (all 17 kinds)', () => {
  test.each(ALL_KINDS)('%s has a non-empty label and a severity', (kind) => {
    const label = auditKindLabel(kind);
    const severity = auditKindSeverity(kind);
    expect(label.length).toBeGreaterThan(0);
    expect(['info', 'success', 'warning', 'error']).toContain(severity);
  });

  test('success-mapped kinds: complete / delivered / enable', () => {
    expect(auditKindSeverity('operation.complete')).toBe('success');
    expect(auditKindSeverity('webhook.delivered')).toBe('success');
    expect(auditKindSeverity('business.enable')).toBe('success');
  });

  test('error-mapped kinds: operation.fail / webhook.failed', () => {
    expect(auditKindSeverity('operation.fail')).toBe('error');
    expect(auditKindSeverity('webhook.failed')).toBe('error');
  });

  test('warning-mapped kinds: cancel / deadline / deactivate / drain / revoke', () => {
    expect(auditKindSeverity('operation.cancel')).toBe('warning');
    expect(auditKindSeverity('operation.deadline')).toBe('warning');
    expect(auditKindSeverity('business.deactivate')).toBe('warning');
    expect(auditKindSeverity('business.drain')).toBe('warning');
    expect(auditKindSeverity('apikey.revoke')).toBe('warning');
  });

  test('info-mapped kinds: resume / rotated / test / activate / create', () => {
    expect(auditKindSeverity('operation.resume')).toBe('info');
    expect(auditKindSeverity('connector.rotated')).toBe('info');
    expect(auditKindSeverity('connector.test')).toBe('info');
    expect(auditKindSeverity('business.activate')).toBe('info');
    expect(auditKindSeverity('apikey.create')).toBe('info');
  });

  test('profile binding has a distinct event identity and label', () => {
    expect(auditKindLabel('profile_binding.bind')).toBe('Profile binding granted');
    expect(auditKindSeverity('profile_binding.bind')).toBe('info');
    expect(auditKindLabel('profile_binding.bind')).not.toBe(auditKindLabel('apikey.create'));
    expect(auditKindLabel('apikey.profile_bind')).toBe('Profile binding granted');
  });
});

describe('W39-O3 P6-07: auditSeverityBadge (all 4 severities)', () => {
  const cases: Array<{ sev: 'info' | 'success' | 'warning' | 'error'; badge: 'success' | 'warning' | 'error' | 'neutral' }> = [
    { sev: 'info', badge: 'neutral' },
    { sev: 'success', badge: 'success' },
    { sev: 'warning', badge: 'warning' },
    { sev: 'error', badge: 'error' },
  ];
  test.each(cases)('$sev -> $badge', ({ sev, badge }) => {
    expect(auditSeverityBadge(sev)).toBe(badge);
  });
});

const baseAuditRow = (overrides: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: 'evt-1',
  kind: 'operation.cancel',
  severity: 'warning',
  occurredAt: '2026-09-23T01:00:00.000Z',
  tenantId: 'tenant-A',
  resourceId: 'op-7',
  actor: 'admin:bearer-abc',
  message: 'Cancelled by operator',
  ...overrides,
});

describe('W39-O3 P6-07: buildAuditEventView', () => {
  test('projection carries kindLabel + severityBadge derived from kind', () => {
    const view = buildAuditEventView(baseAuditRow());
    expect(view).toEqual({
      id: 'evt-1',
      kind: 'operation.cancel',
      kindLabel: 'Operation cancelled',
      severity: 'warning',
      severityBadge: 'warning',
      occurredAt: '2026-09-23T01:00:00.000Z',
      tenantId: 'tenant-A',
      resourceId: 'op-7',
      actor: 'admin:bearer-abc',
      message: 'Cancelled by operator',
    });
  });

  test('success kind -> success badge', () => {
    const view = buildAuditEventView(
      baseAuditRow({ kind: 'operation.complete', severity: 'success' }),
    );
    expect(view.kindLabel).toBe('Operation completed');
    expect(view.severityBadge).toBe('success');
  });

  test('error kind -> error badge', () => {
    const view = buildAuditEventView(
      baseAuditRow({ kind: 'webhook.failed', severity: 'error' }),
    );
    expect(view.kindLabel).toBe('Webhook delivery failed');
    expect(view.severityBadge).toBe('error');
  });
});

describe('W39-O3 P6-07: buildAuditListView (tenant-scoped + filtering)', () => {
  test('cross-tenant events are dropped (RES-07 tenant isolation)', () => {
    const view = buildAuditListView({
      tenantId: 'tenant-A',
      events: [
        baseAuditRow({ id: 'evt-1', tenantId: 'tenant-A' }),
        baseAuditRow({ id: 'evt-2', tenantId: 'tenant-B' }), // cross-tenant
        baseAuditRow({ id: 'evt-3', tenantId: 'tenant-A' }),
      ],
    });
    expect(view.tenantId).toBe('tenant-A');
    expect(view.events.map((e) => e.id)).toEqual(['evt-1', 'evt-3']);
    expect(view.hasEvents).toBe(true);
  });

  test('unique kinds and severities are emitted for renderer filter chips', () => {
    const view = buildAuditListView({
      tenantId: 'tenant-A',
      events: [
        baseAuditRow({ id: 'evt-1', kind: 'operation.cancel', severity: 'warning' }),
        baseAuditRow({ id: 'evt-2', kind: 'operation.cancel', severity: 'warning' }), // duplicate
        baseAuditRow({ id: 'evt-3', kind: 'operation.complete', severity: 'success' }),
        baseAuditRow({ id: 'evt-4', kind: 'webhook.failed', severity: 'error' }),
      ],
    });
    expect(view.kinds).toEqual([
      'operation.cancel',
      'operation.complete',
      'webhook.failed',
    ]);
    expect(view.severities).toEqual(['warning', 'success', 'error']);
  });

  test('empty input yields empty lists and hasEvents=false', () => {
    const view = buildAuditListView({ tenantId: 'tenant-A', events: [] });
    expect(view.events).toEqual([]);
    expect(view.kinds).toEqual([]);
    expect(view.severities).toEqual([]);
    expect(view.hasEvents).toBe(false);
  });

  test('no matching tenant yields empty view, not a phantom entry', () => {
    const view = buildAuditListView({
      tenantId: 'tenant-A',
      events: [baseAuditRow({ tenantId: 'tenant-B' })],
    });
    expect(view.hasEvents).toBe(false);
    expect(view.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Health overview (reuses GET /api/v1/health wire shape)
// ---------------------------------------------------------------------------

describe('W39-O3 P6-07: buildHealthOverviewView (reuses GET /api/v1/health wire)', () => {
  test('healthy wire -> ok status, both probes success, fullyHealthy=true', () => {
    const wire: HealthWire = { status: 'ok', db: true, redis: true, activeLeases: 12 };
    const view = buildHealthOverviewView(wire);
    expect(view.status).toBe('ok');
    expect(view.statusLabel).toBe('OK');
    expect(view.badge).toBe('success');
    expect(view.db).toBe(true);
    expect(view.dbBadge).toBe('success');
    expect(view.dbLabel).toBe('Healthy');
    expect(view.redis).toBe(true);
    expect(view.redisBadge).toBe('success');
    expect(view.redisLabel).toBe('Healthy');
    expect(view.activeLeases).toBe(12);
    expect(view.fullyHealthy).toBe(true);
  });

  test('db down -> degraded, error badges, fullyHealthy=false', () => {
    const wire: HealthWire = { status: 'degraded', db: false, redis: true, activeLeases: 0 };
    const view = buildHealthOverviewView(wire);
    expect(view.status).toBe('degraded');
    expect(view.statusLabel).toBe('Degraded');
    expect(view.badge).toBe('error');
    expect(view.db).toBe(false);
    expect(view.dbBadge).toBe('error');
    expect(view.dbLabel).toBe('Unreachable');
    expect(view.redisBadge).toBe('success');
    expect(view.fullyHealthy).toBe(false);
  });

  test('redis down -> degraded, error badge on redis', () => {
    const wire: HealthWire = { status: 'degraded', db: true, redis: false, activeLeases: 4 };
    const view = buildHealthOverviewView(wire);
    expect(view.fullyHealthy).toBe(false);
    expect(view.redisBadge).toBe('error');
    expect(view.redisLabel).toBe('Unreachable');
    expect(view.dbBadge).toBe('success');
  });

  test('both probes down -> fullyHealthy=false and status=degraded', () => {
    const wire: HealthWire = { status: 'degraded', db: false, redis: false, activeLeases: 0 };
    const view = buildHealthOverviewView(wire);
    expect(view.fullyHealthy).toBe(false);
    expect(view.status).toBe('degraded');
    expect(view.badge).toBe('error');
  });

  test('activeLeases=0 is allowed for a healthy system (idle)', () => {
    const wire: HealthWire = { status: 'ok', db: true, redis: true, activeLeases: 0 };
    const view = buildHealthOverviewView(wire);
    expect(view.activeLeases).toBe(0);
    expect(view.fullyHealthy).toBe(true);
  });

  test('HealthWire shape matches GET /api/v1/health (regression guard)', () => {
    // The wire shape must not drift from server.ts /health handler.
    // server.ts lines 338–344:
    //   { status: 'ok'|'degraded', db: boolean, redis: boolean, activeLeases: number }
    const wire: HealthWire = { status: 'ok', db: true, redis: true, activeLeases: 1 };
    const keys = Object.keys(wire).sort();
    expect(keys).toEqual(['activeLeases', 'db', 'redis', 'status']);
  });

  test('health overview carries no raw credential / secret material', () => {
    const wire: HealthWire = { status: 'ok', db: true, redis: true, activeLeases: 2 };
    const view = buildHealthOverviewView(wire);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');
    const obj = view as unknown as Record<string, unknown>;
    expect(obj['token']).toBeUndefined();
    expect(obj['header']).toBeUndefined();
    expect(obj['credential']).toBeUndefined();
  });
});

// ===========================================================================
// W-ADM-UX-11-OVERVIEW-VIEW-MODEL-NEGATIVE (Turn 344 / Cycle 55)
//
// Negative + boundary tests for the pure overview view models. Every
// expectation was MEASURED with a throwaway probe against the real function
// first. Several pin behaviour that is arguably wrong; those are marked
// DEFECT and reported, not fixed (production code is out of scope).
//
// Pure unit file: no DB, no HTTP, no listener, so no port band applies.
// ===========================================================================

const WADMUX11_XSS = '<script>alert(1)</script>';
const WADMUX11_ZERO_TOTALS = {
  operations: 0,
  inputTokens: 0,
  outputTokens: 0,
  pages: 0,
  costMicrousd: 0,
};

const usageRow = (o: {
  provider?: string;
  model?: string;
  operations?: number;
  inputTokens?: number;
  outputTokens?: number;
  pages?: number;
  costMicrousd?: number;
  measurement?: string;
} = {}) => ({
  provider: 'openai',
  model: 'gpt-4o-mini',
  operations: 1,
  inputTokens: 2,
  outputTokens: 3,
  pages: 4,
  costMicrousd: 5,
  measurement: 'measured',
  ...o,
});

// ---------------------------------------------------------------------------
// 1. Malformed status summaries
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: one module, three different degradation modes for a bad enum', () => {
  // Measured: the meta-table lookups THROW, the switch returns undefined, and
  // a binary ternary reports the unknown value as degraded. All in one file.
  const bad: string[] = ['BOGUS', '', 'Measured', 'measured '];

  test.each(bad)('usageMeasurementBadge(%p) throws a TypeError', (m) => {
    expect(() => usageMeasurementBadge(m as never)).toThrow(TypeError);
  });

  test.each(bad)('usageMeasurementLabel(%p) throws a TypeError', (m) => {
    expect(() => usageMeasurementLabel(m as never)).toThrow(TypeError);
  });

  test.each(bad)('auditKindLabel(%p) throws a TypeError', (kind) => {
    expect(() => auditKindLabel(kind as never)).toThrow(TypeError);
  });

  test.each(bad)('auditKindSeverity(%p) throws a TypeError', (kind) => {
    expect(() => auditKindSeverity(kind as never)).toThrow(TypeError);
  });

  // The odd one out: auditSeverityBadge is a switch with no default branch, so
  // an unknown severity returns undefined instead of throwing. The declared
  // return type excludes undefined, so TypeScript cannot catch this.
  test.each(bad)('auditSeverityBadge(%p) silently returns undefined', (s) => {
    expect(auditSeverityBadge(s as never)).toBeUndefined();
  });

  test('the four declared severities still resolve (control)', () => {
    expect(auditSeverityBadge('success')).toBe('success');
    expect(auditSeverityBadge('warning')).toBe('warning');
    expect(auditSeverityBadge('error')).toBe('error');
    expect(auditSeverityBadge('info')).toBe('neutral');
  });

  // SEAL: every kind the contracts declare must have a label and a severity.
  // This is the check that would have caught a kind added to the union
  // without a matching meta entry.
  test('every declared audit kind resolves to a label and a severity', () => {
    for (const kind of ALL_KINDS) {
      expect(typeof auditKindLabel(kind)).toBe('string');
      expect(auditKindLabel(kind).length).toBeGreaterThan(0);
      expect(['info', 'success', 'warning', 'error']).toContain(auditKindSeverity(kind));
    }
  });

  test('a bad measurement takes down the whole rollup row, not just the badge', () => {
    expect(() => buildUsageRollupRow(usageRow({ measurement: 'BOGUS' }) as never)).toThrow(TypeError);
  });

  test('a bad kind takes down the whole audit event view', () => {
    expect(() => buildAuditEventView(baseAuditRow({ kind: 'BOGUS' as never }))).toThrow(TypeError);
  });

  // DEFECT: buildAuditEventView never reads row.severity. It recomputes the
  // severity from the kind, so a wire row that claims a HIGHER severity is
  // silently downgraded and the wire value disappears from the view.
  test('the wire severity is discarded and recomputed from the kind', () => {
    const view = buildAuditEventView(baseAuditRow({ kind: 'operation.cancel', severity: 'error' }));
    expect(view.severity).toBe('warning');
    expect(view.severityBadge).toBe('warning');
  });

  test('a wire row claiming info for a failing kind is likewise overwritten', () => {
    const view = buildAuditEventView(baseAuditRow({ kind: 'operation.fail', severity: 'info' }));
    expect(view.severity).toBe('error');
  });

  // The one place this module degrades in the SAFE direction: an unknown
  // health status is reported as degraded, not as ok.
  test('an unknown health status is reported as degraded, not ok', () => {
    const view = buildHealthOverviewView({
      status: 'BOGUS' as never,
      db: true,
      redis: true,
      activeLeases: 1,
    });
    expect(view.status).toBe('BOGUS');
    expect(view.badge).toBe('error');
    expect(view.statusLabel).toBe('Degraded');
  });
});

// ---------------------------------------------------------------------------
// 2. NaN / negative counters
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: every usage counter is an unclamped passthrough', () => {
  test('NaN, negative and infinite counters survive verbatim', () => {
    const row = buildUsageRollupRow(
      usageRow({ operations: NaN, inputTokens: -1, outputTokens: Infinity, pages: -0, costMicrousd: NaN }) as never,
    );
    expect(row.operations).toBeNaN();
    expect(row.inputTokens).toBe(-1);
    expect(row.outputTokens).toBe(Infinity);
    expect(row.pages).toBe(-0);
    expect(row.costMicrousd).toBeNaN();
  });

  test('a negative cost is projected as a negative cost', () => {
    const row = buildUsageRollupRow(usageRow({ costMicrousd: -999_999 }) as never);
    expect(row.costMicrousd).toBe(-999_999);
  });

  test('a huge token count is not clamped to a safe-integer bound', () => {
    const huge = Number.MAX_SAFE_INTEGER + 10;
    const row = buildUsageRollupRow(usageRow({ inputTokens: huge }) as never);
    expect(row.inputTokens).toBe(huge);
  });

  // DEFECT: totals is carried by reference, not copied. Mutating the wire
  // object after the projection changes the rendered totals.
  test('the totals object is shared with the wire input, not copied', () => {
    const totals = { operations: 1, inputTokens: 2, outputTokens: 3, pages: 4, costMicrousd: 5 };
    const view = buildUsageRollupView({
      tenantId: 't',
      from: 'a',
      to: 'b',
      rows: [usageRow() as never],
      totals,
    });
    expect(view.totals).toBe(totals);
    totals.operations = 999;
    expect(view.totals.operations).toBe(999);
  });

  test('corrupt totals are never reconciled against the rows', () => {
    // The rows sum to 1 operation; the totals claim 0. Nothing checks.
    const view = buildUsageRollupView({
      tenantId: 't',
      from: 'a',
      to: 'b',
      rows: [usageRow({ operations: 7 }) as never],
      totals: WADMUX11_ZERO_TOTALS,
    });
    expect(view.rows[0]!.operations).toBe(7);
    expect(view.totals.operations).toBe(0);
  });

  test('a null rows array throws', () => {
    expect(() =>
      buildUsageRollupView({ tenantId: 't', from: 'a', to: 'b', rows: null as never, totals: WADMUX11_ZERO_TOTALS }),
    ).toThrow(TypeError);
  });

  test('allUnattributed requires BOTH provider and model to be unattributed', () => {
    // A half-attributed row reads as attributed, so the empty-state copy
    // would not show even though the row carries no real attribution.
    const half = buildUsageRollupView({
      tenantId: 't',
      from: '',
      to: '',
      rows: [usageRow({ provider: '(unattributed)' }) as never],
      totals: WADMUX11_ZERO_TOTALS,
    });
    const whole = buildUsageRollupView({
      tenantId: 't',
      from: '',
      to: '',
      rows: [usageRow({ provider: '(unattributed)', model: '(unattributed)' }) as never],
      totals: WADMUX11_ZERO_TOTALS,
    });
    expect(half.allUnattributed).toBe(false);
    expect(whole.allUnattributed).toBe(true);
  });

  test('an empty row list is neither hasRows nor allUnattributed', () => {
    const view = buildUsageRollupView({
      tenantId: 't',
      from: 'a',
      to: 'b',
      rows: [],
      totals: WADMUX11_ZERO_TOTALS,
    });
    expect(view.hasRows).toBe(false);
    expect(view.allUnattributed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Corrupt throughput metrics
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: there is no throughput metric to corrupt', () => {
  // The packet asks for corrupt throughput metrics. This module exports ten
  // functions and none of them computes a rate or throughput; usage is
  // projected as raw counters. Those counters are covered in the block above,
  // so this block pins what the module does and does not do.
  test('usage is projected as raw counters, never as a derived rate', () => {
    const row = buildUsageRollupRow(usageRow({ operations: 5, pages: 10 }) as never);
    expect(row.operations).toBe(5);
    expect(row.pages).toBe(10);
    expect(Object.keys(row).sort()).toEqual([
      'costMicrousd',
      'inputTokens',
      'measurement',
      'measurementBadge',
      'measurementLabel',
      'model',
      'operations',
      'outputTokens',
      'pages',
      'provider',
    ]);
  });

  test('a zero-denominator style input cannot produce Infinity here, because no division happens', () => {
    // With no rate computation there is no divide-by-zero surface - the
    // counters simply pass through, which is why the clamp question above is
    // the only metric question this module raises.
    const row = buildUsageRollupRow(usageRow({ operations: 0, inputTokens: 0 }) as never);
    expect(row.operations).toBe(0);
    expect(row.inputTokens).toBe(0);
  });

  test('NaN in the only health counter is projected verbatim', () => {
    const view = buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: NaN });
    expect(view.activeLeases).toBeNaN();
  });

  test('a negative lease count is projected verbatim', () => {
    const view = buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: -5 });
    expect(view.activeLeases).toBe(-5);
  });
});

// ---------------------------------------------------------------------------
// 4. Boundary time-window intervals
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: the [from, to] window is never parsed or ordered', () => {
  // There is no date handling anywhere in this module. The window is carried
  // through so the renderer can echo it, which means every interval defect
  // arrives at the UI intact.
  const viewWith = (from: string, to: string) =>
    buildUsageRollupView({ tenantId: 't', from, to, rows: [], totals: WADMUX11_ZERO_TOTALS });

  // DEFECT: an inverted window is not detected. to < from is meaningless, and
  // the renderer will be asked to label it as-is.
  test('an inverted window (to before from) passes through unchanged', () => {
    const view = viewWith('2026-09-30T00:00:00Z', '2026-01-01T00:00:00Z');
    expect(view.from).toBe('2026-09-30T00:00:00Z');
    expect(view.to).toBe('2026-01-01T00:00:00Z');
  });

  test('unparseable window bounds pass through unchanged', () => {
    const view = viewWith('garbage', 'not-a-date');
    expect(view.from).toBe('garbage');
    expect(view.to).toBe('not-a-date');
  });

  test('an empty window passes through as empty strings', () => {
    const view = viewWith('', '');
    expect(view.from).toBe('');
    expect(view.to).toBe('');
  });

  test('a zero-length window (same instant both ends) is accepted', () => {
    const view = viewWith('2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z');
    expect(view.from).toBe(view.to);
  });

  test('mixed formats (epoch millis vs ISO) are both accepted without complaint', () => {
    const view = viewWith('1758604800000', '2026-09-23T00:00:00Z');
    expect(view.from).toBe('1758604800000');
    expect(view.to).toBe('2026-09-23T00:00:00Z');
  });

  test('a rolled-over calendar date is indistinguishable from a valid one', () => {
    const view = viewWith('2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z');
    expect(view.from).toBe('2026-02-30T00:00:00Z');
  });

  test('the audit list carries no window at all, so it cannot be bounded', () => {
    // baseAuditRow defaults to tenant-A; the view is scoped to t1, so the
    // row needs an explicit tenant or the filter would drop it.
    const view = buildAuditListView({
      tenantId: 't1',
      events: [baseAuditRow({ tenantId: 't1', occurredAt: 'garbage' })],
    });
    expect(view.events[0]!.occurredAt).toBe('garbage');
  });
});

// ---------------------------------------------------------------------------
// 5. Tenant breakdown edge cases
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: tenant scoping is a bare === and collapses when both sides are missing', () => {
  // DEFECT and the sharpest of this packet: the filter is e.tenantId ===
  // input.tenantId. When BOTH are undefined the comparison is true, so a view
  // with no tenantId keeps every event that also has no tenantId. Tenant
  // scoping silently becomes a no-op instead of failing closed.
  test('a view with an undefined tenantId keeps every event lacking one', () => {
    const view = buildAuditListView({
      tenantId: undefined as never,
      events: [
        baseAuditRow({ id: 'a', tenantId: undefined as never }),
        baseAuditRow({ id: 'b', tenantId: 't1' }),
        baseAuditRow({ id: 'c', tenantId: undefined as never }),
      ],
    });
    expect(view.events.map((e) => e.id)).toEqual(['a', 'c']);
  });

  test('two different tenants both missing an id would land in the same view', () => {
    // The isolation argument in the docstring is "any event whose tenantId
    // does not match is dropped" - true for present values, false for absent.
    const view = buildAuditListView({
      tenantId: undefined as never,
      events: [
        baseAuditRow({ id: 'from-tenant-x', tenantId: undefined as never }),
        baseAuditRow({ id: 'from-tenant-y', tenantId: undefined as never }),
      ],
    });
    expect(view.events).toHaveLength(2);
    expect(view.hasEvents).toBe(true);
  });

  test('scoping is case-sensitive, so a case-flipped id drops every event', () => {
    const view = buildAuditListView({
      tenantId: 'T1',
      events: [baseAuditRow({ tenantId: 't1' })],
    });
    expect(view.events).toHaveLength(0);
    expect(view.hasEvents).toBe(false);
  });

  test('the empty string is a valid tenant id and matches other empty strings', () => {
    const view = buildAuditListView({
      tenantId: '',
      events: [baseAuditRow({ id: 'a', tenantId: '' }), baseAuditRow({ id: 'b', tenantId: 't1' })],
    });
    expect(view.events.map((e) => e.id)).toEqual(['a']);
  });

  test('a null event throws instead of being dropped', () => {
    expect(() => buildAuditListView({ tenantId: 't1', events: [null as never] })).toThrow(TypeError);
  });

  test('a null events array throws', () => {
    expect(() => buildAuditListView({ tenantId: 't1', events: null as never })).toThrow(TypeError);
  });

  test('kinds and severities are deduplicated in first-appearance order', () => {
    const view = buildAuditListView({
      tenantId: 't1',
      events: [
        baseAuditRow({ id: 'a', kind: 'operation.fail', tenantId: 't1' }),
        baseAuditRow({ id: 'b', kind: 'operation.fail', tenantId: 't1' }),
        baseAuditRow({ id: 'c', kind: 'apikey.revoke', tenantId: 't1' }),
      ],
    });
    expect(view.kinds).toEqual(['operation.fail', 'apikey.revoke']);
    expect(view.severities).toEqual(['error', 'warning']);
  });

  test('kinds and severities reflect the view scope, not the dropped events', () => {
    const view = buildAuditListView({
      tenantId: 't1',
      events: [
        baseAuditRow({ id: 'a', kind: 'operation.fail', tenantId: 't1' }),
        baseAuditRow({ id: 'b', kind: 'webhook.delivered', tenantId: 'tenant-B' }),
      ],
    });
    expect(view.kinds).toEqual(['operation.fail']);
    expect(view.severities).toEqual(['error']);
  });

  test('hostile message and actor text are passed through unescaped', () => {
    const view = buildAuditListView({
      tenantId: 't1',
      events: [baseAuditRow({ tenantId: 't1', message: WADMUX11_XSS, actor: '<img src=x onerror=alert(1)>' })],
    });
    expect(view.events[0]!.message).toBe(WADMUX11_XSS);
    expect(view.events[0]!.actor).toBe('<img src=x onerror=alert(1)>');
  });
});

// ---------------------------------------------------------------------------
// 6. Health probe flags: truthiness, not equality
// ---------------------------------------------------------------------------

describe('W-ADM-UX-11: the health probes are truthiness tests, and fullyHealthy is not always boolean', () => {
  // Same class as the connector hasValue defect in cycle 52: a truthy string
  // reports the probe as healthy.
  test('the string "false" reports BOTH probes as healthy', () => {
    const view = buildHealthOverviewView({
      status: 'ok',
      db: 'false' as never,
      redis: 'false' as never,
      activeLeases: 0,
    });
    expect(view.dbBadge).toBe('success');
    expect(view.redisBadge).toBe('success');
    expect(view.dbLabel).toBe('Healthy');
  });

  test('fullyHealthy is a && chain, so it can return a non-boolean', () => {
    // Declared boolean, but 'false' && 'false' short-circuits to the string.
    const view = buildHealthOverviewView({
      status: 'ok',
      db: 'false' as never,
      redis: 'false' as never,
      activeLeases: 0,
    });
    expect(typeof view.fullyHealthy).not.toBe('boolean');
    expect(view.fullyHealthy).toBe('false');
  });

  test('a numeric zero db probe yields the number 0, not the boolean false', () => {
    const view = buildHealthOverviewView({
      status: 'degraded',
      db: 0 as never,
      redis: 1 as never,
      activeLeases: 0,
    });
    expect(view.dbBadge).toBe('error');
    expect(view.redisBadge).toBe('success');
    expect(view.fullyHealthy).toBe(0);
  });

  test('with real booleans the contract holds (control)', () => {
    const ok = buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: 2 });
    expect(ok.fullyHealthy).toBe(true);
    expect(ok.badge).toBe('success');
    const bad = buildHealthOverviewView({ status: 'degraded', db: false, redis: true, activeLeases: 2 });
    expect(bad.fullyHealthy).toBe(false);
    expect(bad.dbBadge).toBe('error');
    expect(bad.redisBadge).toBe('success');
  });
});

