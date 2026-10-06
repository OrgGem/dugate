import {
  buildAuditListView,
  buildAuditEventView,
  buildHealthOverviewView,
  buildUsageRollupRow,
  buildUsageRollupView,
  type AuditEventRow,
  type HealthWire,
} from '../src/app/admin/overview-view-models';

const X = '<script>alert(1)</script>';

function sh(tag: string, fn: () => string): void {
  try {
    console.log('PROBE ' + tag + ' -> ' + fn());
  } catch (e) {
    console.log('PROBE ' + tag + ' -> THREW ' + (e as Error).constructor.name + ': ' + (e as Error).message);
  }
}

const TOT = { operations: 1, inputTokens: 2, outputTokens: 3, pages: 4, costMicrousd: 5 };
const row = (o: Record<string, unknown> = {}) => ({
  provider: 'openai', model: 'gpt-4o-mini', operations: 1, inputTokens: 2,
  outputTokens: 3, pages: 4, costMicrousd: 5, measurement: 'measured', ...o,
});
const rollup = (rows: unknown, o: Record<string, unknown> = {}) =>
  buildUsageRollupView({
    tenantId: 'tenant-1', from: 'a', to: 'b', rows, totals: TOT, ...o,
  } as never);
const ev = (o: Partial<AuditEventRow> = {}): AuditEventRow => ({
  id: 'e1', kind: 'operation.complete', severity: 'success',
  occurredAt: '2026-09-23T00:00:00.000Z', tenantId: 't1',
  resourceId: 'r1', actor: 'system', message: 'm', ...o,
} as AuditEventRow);

test('PROBE stats', () => {
  sh('rows.dupBuckets', () => {
    const v = rollup([row(), row(), row({ provider: 'anthropic' })]);
    return 'n=' + v.rows.length + ' hasRows=' + v.hasRows;
  });
  sh('rows.emptyStringProvider', () => {
    const v = rollup([row({ provider: '', model: '' })]);
    return 'json=' + JSON.stringify(v.rows[0]);
  });
  sh('rows.nullProvider', () => {
    const v = rollup([row({ provider: null })]);
    return 'provider=' + JSON.stringify(v.rows[0]!.provider);
  });
  sh('rows.unattributedCase', () => {
    const v = rollup([row({ provider: '(unattributed)', model: '(unattributed)' })]);
    return 'allUnattributed=' + v.allUnattributed;
  });
  sh('rows.unattributedPartial', () => {
    const v = rollup([row({ provider: '(unattributed)' })]);
    return 'allUnattributed=' + v.allUnattributed;
  });
  sh('rows.unattributedMixed', () => {
    const v = rollup([row({ provider: '(unattributed)', model: '(unattributed)' }), row()]);
    return 'allUnattributed=' + v.allUnattributed;
  });
  sh('rows.measurementMixed', () => {
    const v = rollup([row({ measurement: 'measured' }), row({ measurement: 'pending' })]);
    return JSON.stringify(v.rows.map((r) => r.measurementBadge));
  });
  sh('rows.notArray', () => { try { return 'ok=' + rollup({ a: 1 }).hasRows; } catch (e) { return 'THREW ' + (e as Error).constructor.name; } });
  sh('rows.bigCount', () => 'n=' + rollup(Array.from({ length: 200 }, () => row())).rows.length);
  sh('rows.hostileProvider', () => 'p=' + JSON.stringify(rollup([row({ provider: X })]).rows[0]!.provider));
  sh('totals.negative', () => 't=' + JSON.stringify(rollup([], { totals: { operations: -5, inputTokens: -1 } }).totals));
  sh('totals.extraKeys', () => 't=' + JSON.stringify(rollup([], { totals: { ...TOT, extra: 1 } }).totals));
  sh('totals.mismatch', () => 'rows=' + rollup([row({ operations: 100 })], { totals: { operations: 1 } }).rows[0]!.operations + ' totals=' + rollup([row({ operations: 100 })], { totals: { operations: 1 } }).totals.operations);
  sh('row.negCount', () => {
    const r = buildUsageRollupRow(row({ operations: -1, pages: -2 }) as never);
    return 'ops=' + r.operations + ' pages=' + r.pages;
  });
  sh('row.negTotalsOk', () => 'hasRows=' + rollup([row({ operations: -5 })]).hasRows);
  sh('row.hugeCount', () => 'ops=' + buildUsageRollupRow(row({ operations: 1e21 }) as never).operations);
});

test('PROBE window+tenant', () => {
  sh('win.undefBoth', () => {
    const v = rollup([], { from: undefined, to: undefined });
    return 'inJson=' + JSON.stringify(v).includes('from') + ' rows=' + v.rows.length;
  });
  sh('win.emptyStrings', () => {
    const v = rollup([], { from: '', to: '' });
    return 'from=' + JSON.stringify(v.from) + ' to=' + JSON.stringify(v.to);
  });
  sh('win.inverted', () => 'from=' + rollup([], { from: '2026-09-30T00:00:00Z', to: '2026-01-01T00:00:00Z' }).from);
  sh('tenant.rollupNoCheck', () => {
    const v = rollup([row()], { tenantId: 'tenant-that-has-no-rows' });
    return 'tenant=' + v.tenantId + ' hasRows=' + v.hasRows;
  });
  sh('tenant.rollupUndef', () => 'tenant=' + JSON.stringify(rollup([], { tenantId: undefined }).tenantId));
  sh('tenant.auditUndefMatch', () => {
    const v = buildAuditListView({ tenantId: undefined as never, events: [ev({ id: 'a', tenantId: undefined as never }), ev({ id: 'b', tenantId: 't1' })] });
    return 'kept=' + v.events.map((e) => e.id).join(',') + ' has=' + v.hasEvents;
  });
  sh('tenant.auditNullMatch', () => {
    const v = buildAuditListView({ tenantId: null as never, events: [ev({ id: 'a', tenantId: null as never }), ev({ id: 'b', tenantId: 't1' })] });
    return 'kept=' + v.events.map((e) => e.id).join(',');
  });
  sh('tenant.auditCase', () => {
    const v = buildAuditListView({ tenantId: 'T1', events: [ev({ tenantId: 't1' })] });
    return 'kept=' + v.events.length;
  });
  sh('tenant.auditObjectMatch', () => {
    const v = buildAuditListView({ tenantId: {} as never, events: [ev({ id: 'a', tenantId: {} as never })] });
    return 'kept=' + v.events.length;
  });
  sh('tenant.auditWhitespace', () => {
    const v = buildAuditListView({ tenantId: ' t1 ', events: [ev({ tenantId: 't1' }), ev({ id: 'b', tenantId: ' t1 ' })] });
    return 'kept=' + v.events.map((e) => e.id).join(',');
  });
  sh('tenant.eventIgnored', () => {
    const v = buildAuditListView({ tenantId: 't1', events: [ev({ id: 'a', tenantId: 't1', tenantId2: 'other' } as never)] });
    return 'kept=' + v.events.length;
  });
  sh('tenant.eventRowTenant', () => 'view=' + buildAuditEventView(ev({ tenantId: 'zzz' })).tenantId);
});

test('PROBE health-neg', () => {
  sh('h.negLeases', () => 'v=' + buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: -9 }).activeLeases);
  sh('h.negLeasesBadge', () => 'badge=' + buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: -9 }).badge);
  sh('h.negBothFalse', () => {
    const v = buildHealthOverviewView({ status: 'degraded', db: false, redis: false, activeLeases: -1 });
    return 'fully=' + v.fullyHealthy + ' badge=' + v.badge;
  });
  sh('h.statusNeg', () => 'badge=' + buildHealthOverviewView({ status: 'degraded', db: true, redis: true, activeLeases: 0 }).badge);
  sh('h.control', () => {
    const v = buildHealthOverviewView({ status: 'ok', db: true, redis: true, activeLeases: 0 } as HealthWire);
    return 'fully=' + v.fullyHealthy + ' badge=' + v.badge;
  });
  sh('h.degradedOkProbes', () => {
    const v = buildHealthOverviewView({ status: 'degraded', db: true, redis: true, activeLeases: 0 });
    return 'statusBadge=' + v.badge + ' dbBadge=' + v.dbBadge + ' fully=' + v.fullyHealthy;
  });
});
