import { randomUUID } from 'node:crypto';
import {
  ModelPricingTierSchema,
  UsageLedgerEventSchema,
} from '@du/contracts';
import type { BudgetConfigInput, ModelPricingTier, UsageLedgerEvent } from '@du/contracts';
import type { Db, } from '../src/db/db';
import {
  createUsageService,
  projectLedgerEvent,
  reconcileUsageRows,
} from '../src/modules/usage/usage';

/**
 * COST-05 integration tests (W-COST05-SERVICE-RECON-1) - OFFLINE ONLY:
 * a fake Db answers the two SELECT shapes; no PG/Redis/S3 is contacted.
 * Pins: (a) zero numeric drift on the W39-C summary path over wire-shaped
 * payloads (the same fixture numbers as the live suite expects); (b) the
 * contract money law (BigInt ceilings, fail-closed 503 on unusable stored
 * amounts); (c) the ledger boundary projector never fabricates fields;
 * (d) aggregateUsageEvents/evaluateBudgetStatus/COST-02 pricing engine
 * semantics end-to-end through UsageService. Deltas D24/D25/D26 in receipt.
 */

const TENANT = '11111111-2222-4333-8444-555555555555';
const OP_A = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const OP_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TASK_A = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';
const FROM = new Date('2000-01-01T00:00:00.000Z');
const TO = new Date('2100-01-01T00:00:00.000Z');

interface FakeDb {
  db: Db;
  calls: Array<{ text: string; params: unknown[] }>;
}

function fakeDb(rows: unknown[]): FakeDb {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const stub = {
    pool: {},
    query: async (text: string, params: unknown[] = []): Promise<unknown> => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
    tx: async (): Promise<never> => {
      throw new Error('tx must not be used by summary/reconciliation reads');
    },
    close: async (): Promise<void> => undefined,
  };
  return { db: stub as unknown as Db, calls };
}

const wirePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: 'w39c-w-' + randomUUID(),
  invocationId: 'inv-' + randomUUID(),
  operationId: OP_A,
  taskId: TASK_A,
  units: { inputTokens: 10, outputTokens: 5 },
  costMicrousd: 7,
  currency: 'USD',
  measurement: 'measured',
  occurredAt: '2026-03-01T10:00:00.000Z',
  ...over,
});

const summaryRow = (payload: Record<string, unknown>, operationId: string) => ({
  payload,
  operation_id: operationId,
});

const BASE_LEDGER = {
  eventId: 'evt-l1',
  idempotencyKey: 'evt-l1-idem',
  kind: 'initial',
  tenantId: 'tenant-a',
  apiKeyId: 'key-01',
  operationId: OP_A,
  taskId: TASK_A,
  invocationId: 'inv-01',
  attempt: 1,
  stepKey: 'convert',
  businessId: 'biz-reports',
  businessVersion: 'v3',
  action: 'transform',
  profileRevision: 2,
  connectorId: 'conn-openai',
  connectorRevision: 4,
  provider: 'openai',
  model: 'gpt-4o',
  unitType: 'tokens',
  units: { inputTokens: 1000, outputTokens: 500 },
  costMicrousd: 7500,
  currency: 'USD',
  costStatus: 'measured',
  durationMs: 120,
  occurredAt: '2026-03-01T10:00:00Z',
  receivedAt: '2026-03-01T10:00:05Z',
};
const makeLedger = (over: Record<string, unknown> = {}): UsageLedgerEvent => {
  const units = (over['units'] ?? BASE_LEDGER.units) as Record<string, unknown>;
  const hasTokens = Number(units['inputTokens'] ?? 0) > 0 || Number(units['outputTokens'] ?? 0) > 0 ||
    Number(units['cachedInputTokens'] ?? 0) > 0;
  const hasPages = Number(units['pages'] ?? 0) > 0;
  const unitType = hasTokens && hasPages ? 'mixed' : hasPages ? 'pages' : 'tokens';
  return UsageLedgerEventSchema.parse({
    ...BASE_LEDGER,
    ...over,
    idempotencyKey: over['idempotencyKey'] ?? `${String(over['eventId'] ?? BASE_LEDGER.eventId)}-idem`,
    unitType: over['unitType'] ?? unitType,
  });
};

const TIER_GPT4O = ModelPricingTierSchema.parse({
  provider: 'openai',
  modelId: 'gpt-4o',
  priceVersion: 1,
  effectiveFrom: '2026-01-01T00:00:00Z',
  inputMicrousdPerMillion: 2_500_000,
  outputMicrousdPerMillion: 10_000_000,
});
const GPT4O_RATE_IN = 2_500_000;
const GPT4O_RATE_OUT = 10_000_000;
void GPT4O_RATE_IN; void GPT4O_RATE_OUT;

describe('getUsageSummary - contracts money law, zero drift on legacy path', () => {
  test('1. W39-C fixture numbers reproduce EXACTLY (live-suite parity)', async () => {
    const rows = [
      summaryRow(wirePayload({ provider: 'acme', model: 'x-1', units: { inputTokens: 10, outputTokens: 5 }, costMicrousd: 7 }), OP_A),
      summaryRow(wirePayload({ eventId: 'w39c-w-2', provider: 'acme', model: 'x-1', units: { inputTokens: 20, outputTokens: 1 }, costMicrousd: 3, measurement: 'estimated' }), OP_A),
      summaryRow(wirePayload({ eventId: 'w39c-w-3', provider: 'other', model: 'y-2', units: { inputTokens: 4, outputTokens: 4, pages: 3 }, costMicrousd: 2 }), OP_B),
    ];
    const { db } = fakeDb(rows);
    const svc = createUsageService(db);
    const res = await svc.getUsageSummary(TENANT, FROM, TO);
    expect(res).toStrictEqual({
      tenantId: TENANT,
      from: FROM.toISOString(),
      to: TO.toISOString(),
      rows: [
        { provider: 'acme', model: 'x-1', operations: 1, inputTokens: 30, outputTokens: 6, pages: 0, costMicrousd: 10, measurement: 'mixed' },
        { provider: 'other', model: 'y-2', operations: 1, inputTokens: 4, outputTokens: 4, pages: 3, costMicrousd: 2, measurement: 'measured' },
      ],
      totals: { operations: 2, inputTokens: 34, outputTokens: 10, pages: 3, costMicrousd: 12 },
    });
  });

  test('2. non-string provider/model collapses to unattributed (legacy rule kept)', async () => {
    const rows = [
      summaryRow(wirePayload({ provider: 42, model: 'x-1' }), OP_A),
      summaryRow(wirePayload({ eventId: 'w39c-w-9' }), OP_A),
    ];
    const svc = createUsageService(fakeDb(rows).db);
    const res = await svc.getUsageSummary(TENANT, FROM, TO);
    expect(res.rows.map((r) => [r.provider, r.model])).toEqual([
      ['(unattributed)', '(unattributed)'],
      ['(unattributed)', 'x-1'],
    ]);
  });

  test('3. absent/non-number amounts are skipped exactly like the legacy loop', async () => {
    const rows = [
      summaryRow(wirePayload({ units: { inputTokens: '10', outputTokens: undefined }, costMicrousd: true }), OP_A),
    ];
    const svc = createUsageService(fakeDb(rows).db);
    const res = await svc.getUsageSummary(TENANT, FROM, TO);
    expect(res.rows[0]).toStrictEqual({
      provider: '(unattributed)', model: '(unattributed)', operations: 1,
      inputTokens: 0, outputTokens: 0, pages: 0, costMicrousd: 0, measurement: 'measured',
    });
  });

  test('4. PIN delta D25: stored float amount fails closed 503 (legacy added poison)', async () => {
    const rows = [summaryRow(wirePayload({ units: { inputTokens: 1.5, outputTokens: 2 } }), OP_A)];
    const svc = createUsageService(fakeDb(rows).db);
    await expect(svc.getUsageSummary(TENANT, FROM, TO)).rejects.toMatchObject({
      status: 503, code: 'TEMPORARY_UNAVAILABLE',
    });
  });

  test('5. stored negative amount fails closed 503', async () => {
    const rows = [summaryRow(wirePayload({ costMicrousd: -5 }), OP_A)];
    const svc = createUsageService(fakeDb(rows).db);
    await expect(svc.getUsageSummary(TENANT, FROM, TO)).rejects.toMatchObject({ status: 503 });
  });

  test('6. BigInt ceiling: 4.5e15+4.5e15 exact; beyond MAX_SAFE -> 503 naming the field', async () => {
    const okRows = [
      summaryRow(wirePayload({ units: { inputTokens: 4_500_000_000_000_000, outputTokens: 0 }, costMicrousd: 0 }), OP_A),
      summaryRow(wirePayload({ eventId: 'w39c-ok2', units: { inputTokens: 4_500_000_000_000_000, outputTokens: 0 }, costMicrousd: 0 }), OP_A),
    ];
    const ok = await createUsageService(fakeDb(okRows).db).getUsageSummary(TENANT, FROM, TO);
    expect(ok.totals.inputTokens).toBe(9_000_000_000_000_000);
    const badRows = [
      summaryRow(wirePayload({ units: { inputTokens: 0, outputTokens: 0 }, costMicrousd: 5e15 }), OP_A),
      summaryRow(wirePayload({ eventId: 'w39c-bad2', units: { inputTokens: 0, outputTokens: 0 }, costMicrousd: 5e15 }), OP_A),
    ];
    await expect(
      createUsageService(fakeDb(badRows).db).getUsageSummary(TENANT, FROM, TO),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('costMicrousd') });
  });

  test('7. no options -> response keys unchanged (no budget block ever)', async () => {
    const rows = [summaryRow(wirePayload({ provider: 'acme', model: 'x-1' }), OP_A)];
    const res = await createUsageService(fakeDb(rows).db).getUsageSummary(TENANT, FROM, TO);
    expect(Object.keys(res).sort()).toEqual(['from', 'rows', 'tenantId', 'to', 'totals']);
  });
});

describe('getUsageSummary - COST-04 budget option (evaluateBudgetStatus)', () => {
  const fixture = [
    summaryRow(wirePayload({ provider: 'acme', model: 'x-1', units: { inputTokens: 10, outputTokens: 5 }, costMicrousd: 7 }), OP_A),
    summaryRow(wirePayload({ eventId: 'w39c-b2', provider: 'acme', model: 'x-1', units: { inputTokens: 20, outputTokens: 1 }, costMicrousd: 3, measurement: 'estimated' }), OP_A),
    summaryRow(wirePayload({ eventId: 'w39c-b3', provider: 'other', model: 'y-2', units: { inputTokens: 4, outputTokens: 4, pages: 3 }, costMicrousd: 2 }), OP_B),
  ];
  const budgetBase: BudgetConfigInput = {
    tenantId: TENANT,
    period: 'monthly',
    tokenThreshold: 1,
    usdThresholdMicroUsd: 1_000_000_000,
    alertThresholdPercent: 80,
    notificationChannels: [],
    policy: 'alert-only',
    status: 'active',
  };

  test('8. threshold boundary through the real path: 44/55 tokens = exactly 80% -> WARN', async () => {
    const svc = createUsageService(fakeDb(fixture).db);
    const res = await svc.getUsageSummary(TENANT, FROM, TO, {
      budget: { ...budgetBase, tokenThreshold: 55 },
    });
    expect(res.budget).toMatchObject({ usagePercent: 80, warnThresholdExceeded: true, limitExceeded: false, action: 'WARN' });
    expect(res.budget!.remainingTokens).toBe(11);
    expect(res.budget!.remainingCostMicrousd).toBe(1_000_000_000 - 12);
  });

  test('9. inFlightReservation pushes an ALLOW into BLOCK at the cap', async () => {
    const svc = createUsageService(fakeDb(fixture).db);
    const withoutRes = await svc.getUsageSummary(TENANT, FROM, TO, {
      budget: { ...budgetBase, tokenThreshold: 60, policy: 'block-new-invocations' },
    });
    expect(withoutRes.budget!.action).toBe('ALLOW');
    const reservation = { inputTokens: 8, outputTokens: 8, totalTokens: 16, totalCostMicrousd: 0, eventCount: 1 };
    const withRes = await svc.getUsageSummary(TENANT, FROM, TO, {
      budget: { ...budgetBase, tokenThreshold: 60, policy: 'block-new-invocations' },
      inFlightReservation: reservation,
    });
    expect(withRes.budget!.action).toBe('BLOCK');
    expect(withRes.budget!.remainingTokens).toBe(0);
  });
});

describe('projectLedgerEvent - the never-fabricate boundary', () => {
  test('10. wire UsageEvent payload rejects with the exact missing ledger fields', () => {
    const projection = projectLedgerEvent(wirePayload({ provider: 'acme', model: 'x-1', eventId: 'evt-w1' }));
    expect(projection.ok).toBe(false);
    if (projection.ok) return;
    expect(projection.eventId).toBe('evt-w1');
    expect(projection.missingFields).toEqual([
      'action', 'apiKeyId', 'attempt', 'businessId', 'businessVersion',
      'connectorId', 'connectorRevision', 'costStatus', 'durationMs', 'idempotencyKey',
      'profileRevision', 'receivedAt', 'stepKey', 'tenantId', 'unitType',
    ]);
    expect(projection.missingFields).not.toContain('measurement');
    expect(projection.missingFields).not.toContain('provider');
    expect(projection.missingFields).not.toContain('units');
  });

  test('11. ledger-shaped payload passes through untouched', () => {
    const event = makeLedger();
    const projection = projectLedgerEvent(event);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.event.tenantId).toBe('tenant-a');
    expect(projection.event.units.inputTokens).toBe(1000);
  });
});

describe('reconcileUsageRows - aggregateUsageEvents inside UsageService', () => {
  test('12. wire-only tenant reconciles to an honest zero summary', () => {
    const payloads = [wirePayload(), wirePayload({ eventId: 'w39c-w-2' })];
    const view = reconcileUsageRows(payloads);
    expect(view.summary).toStrictEqual({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostMicrousd: 0, eventCount: 0,
    });
    expect(view.projectedEvents).toBe(0);
    expect(view.rejectedRows).toHaveLength(2);
  });

  test('13. duplicate delivery of one eventId counts ONCE in the summary (money law)', () => {
    const e1 = makeLedger({ units: { inputTokens: 1000, outputTokens: 500 }, costMicrousd: 7500 });
    const e1copy = makeLedger({ units: { inputTokens: 1000, outputTokens: 500 }, costMicrousd: 7500 });
    const e2 = makeLedger({
      eventId: 'evt-l2', units: { inputTokens: 2000, outputTokens: 1000 },
      costMicrousd: 15000, occurredAt: '2026-03-01T11:00:00Z', receivedAt: '2026-03-01T11:00:04Z',
    });
    const view = reconcileUsageRows([e1, e2, JSON.parse(JSON.stringify(e1))] as Record<string, unknown>[]);
    expect(e1.eventId).toBe(e2 ? 'evt-l1' : 'evt-l1');
    expect(view.projectedEvents).toBe(3);
    expect(view.summary).toStrictEqual({
      inputTokens: 3000, outputTokens: 1500, totalTokens: 4500, totalCostMicrousd: 22500, eventCount: 2,
    });
  });

  test('14. contract filter window [from,to) applies on occurredAt through the service', async () => {
    const e1 = makeLedger();
    const e2 = makeLedger({
      eventId: 'evt-l2', units: { inputTokens: 2000, outputTokens: 1000 },
      costMicrousd: 15000, occurredAt: '2026-03-01T11:00:00Z', receivedAt: '2026-03-01T11:00:04Z',
    });
    const { db, calls } = fakeDb([e1, e2].map((e) => ({ payload: e })));
    const svc = createUsageService(db);
    const view = await svc.getReconciliationSummary(TENANT, { from: '2026-03-01T10:30:00Z' });
    expect(view.summary.totalCostMicrousd).toBe(15000);
    expect(view.summary.eventCount).toBe(1);
    expect(calls[0]!.text).toContain('o.tenant_id = $1');
    expect(calls[0]!.params).toEqual([TENANT]);
  });

  test('15. divergent same-eventId rows -> HttpError 500 USAGE_LEDGER_CONFLICT, no silent pick', async () => {
    const a = makeLedger({ costMicrousd: 7500 });
    const b = makeLedger({ costMicrousd: 999 });
    const { db } = fakeDb([{ payload: a }, { payload: b }]);
    const svc = createUsageService(db);
    await expect(svc.getReconciliationSummary(TENANT)).rejects.toMatchObject({
      status: 500, code: 'USAGE_LEDGER_CONFLICT',
    });
  });

});

describe('reconcileUsageRows - COST-02 pricing engine pass', () => {
  test('16. ledger events price exactly like calculateOperationCost', () => {
    const e1 = makeLedger();
    const e2 = makeLedger({
      eventId: 'evt-l2', units: { inputTokens: 2000, outputTokens: 1000 },
      costMicrousd: 15000, occurredAt: '2026-03-01T11:00:00Z', receivedAt: '2026-03-01T11:00:04Z',
    });
    const view = reconcileUsageRows([e1, e2] as unknown as Record<string, unknown>[], undefined, [TIER_GPT4O]);
    expect(view.pricing).toStrictEqual({ pricedEvents: 2, unpricedEvents: 0, costMicrousd: 22500 });
  });

  test('17. model without tier and pages without page-rate count as unpriced, never 0-silent', () => {
    const unpricedModel = makeLedger({ eventId: 'evt-l9', model: 'z-9' });
    const withPages = makeLedger({ eventId: 'evt-lp', units: { inputTokens: 10, outputTokens: 10, pages: 3 }, costStatus: 'unpriced', costMicrousd: 0 });
    const view = reconcileUsageRows(
      [makeLedger(), unpricedModel, withPages] as unknown as Record<string, unknown>[],
      undefined,
      [TIER_GPT4O],
    );
    expect(view.pricing).toStrictEqual({ pricedEvents: 1, unpricedEvents: 2, costMicrousd: 7500 });
  });

  test('18. duplicate delivery is priced ONCE (pre-dedup would double-bill)', () => {
    const e1 = makeLedger();
    const dup = JSON.parse(JSON.stringify(e1)) as Record<string, unknown>;
    const view = reconcileUsageRows([e1, dup] as Record<string, unknown>[], undefined, [TIER_GPT4O]);
    expect(view.pricing).toStrictEqual({ pricedEvents: 1, unpricedEvents: 0, costMicrousd: 7500 });
    expect(view.summary.eventCount).toBe(1);
  });

  test('19. provider-scoped query vs providerless tier = unpriced (contracts delta D7a verbatim)', () => {
    const globalTier = ModelPricingTierSchema.parse({
      modelId: 'gpt-4o', priceVersion: 1, effectiveFrom: '2026-01-01T00:00:00Z',
      inputMicrousdPerMillion: 2_500_000, outputMicrousdPerMillion: 10_000_000,
    });
    const view = reconcileUsageRows([makeLedger()] as unknown as Record<string, unknown>[], undefined, [globalTier]);
    expect(view.pricing).toStrictEqual({ pricedEvents: 0, unpricedEvents: 1, costMicrousd: 0 });
  });
});
