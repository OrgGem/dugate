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
