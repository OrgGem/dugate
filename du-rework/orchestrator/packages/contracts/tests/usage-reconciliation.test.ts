import { ZodError } from 'zod';
import {
  UsageAggregateFilterSchema,
  UsageAggregateGroupBySchema,
  UsageAggregationSchema,
  UsageReconciliationConflictError,
  UsageSummarySchema,
  aggregateUsageGroups,
  aggregateUsageEvents,
  type UsageAggregateFilterInput,
} from '../src/usage-reconciliation';
import { UsageLedgerEventSchema, type UsageLedgerEvent } from '../src/usage-metrics';
import { aggregateUsageEvents as ViaIndex } from '../src/index';
import { aggregateUsageGroups as GroupsViaIndex } from '../src/index';

/**
 * COST-03 reconciliation aggregator tests (W-COST03-RECONCILIATION-1) -
 * offline, zero DB/Redis. Positive: documented filter/window/dedup/sum
 * semantics produce exact integers. Negative (win = fail closed): unknown
 * keys rejected by .strict(); inverted windows rejected; empty spans across
 * timezone offsets rejected; divergent payloads sharing an eventId refuse to
 * aggregate; totals beyond Number.MAX_SAFE_INTEGER refuse to truncate.
 */

const OP_A = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const OP_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const OP_C = 'b0b1b2b3-b4b5-46b7-88b9-babbbcbdbebf';
const TASK_ID = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';

const BASE_EVENT = {
  eventId: 'evt-0001',
  idempotencyKey: 'evt-0001',
  kind: 'initial',
  tenantId: 'tenant-a',
  apiKeyId: 'key-01',
  operationId: OP_A,
  taskId: TASK_ID,
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

const makeEvent = (over: Record<string, unknown> = {}): UsageLedgerEvent =>
  UsageLedgerEventSchema.parse({ ...BASE_EVENT, ...over });

const EVT1 = makeEvent();
const EVT2 = makeEvent({
  eventId: 'evt-0002',
  operationId: OP_B,
  units: { inputTokens: 2000, outputTokens: 1000, cachedInputTokens: 500 },
  costMicrousd: 15000,
  occurredAt: '2026-03-01T11:00:00Z',
});
const EVT3 = makeEvent({
  eventId: 'evt-0003',
  tenantId: 'tenant-b',
  businessId: 'biz-archive',
  operationId: OP_C,
  units: { inputTokens: 10, outputTokens: 0 },
  costMicrousd: 0,
  costStatus: 'pending',
  occurredAt: '2026-03-01T12:00:00Z',
});

describe('UsageAggregateFilterSchema', () => {
  test('1. happy path: empty filter, full filter, timeField defaults to occurredAt', () => {
    expect(UsageAggregateFilterSchema.parse({}).timeField).toBe('occurredAt');
    const full = UsageAggregateFilterSchema.parse({
      tenantId: 'tenant-a',
      businessId: 'biz-reports',
      operationId: OP_A,
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-02T00:00:00Z',
      timeField: 'receivedAt',
    });
    expect(full.timeField).toBe('receivedAt');
    // one-sided windows are legal (open period)
    expect(UsageAggregateFilterSchema.parse({ from: '2026-03-01T00:00:00Z' }).to).toBeUndefined();
    expect(UsageAggregateFilterSchema.parse({ to: '2026-03-01T00:00:00Z' }).from).toBeUndefined();
  });

  test('2. .strict(): free-text/grouping/limit keys can never enter a filter', () => {
    for (const extra of ['prompt', 'apiKeySecret', 'groupBy', 'limit', 'signedUrl']) {
      expect(() => UsageAggregateFilterSchema.parse({ [extra]: 'x' })).toThrow(ZodError);
    }
  });

  test('3. malformed values rejected: free-text ids, non-uuid operation, non-RFC3339 bounds', () => {
    expect(() => UsageAggregateFilterSchema.parse({ tenantId: 'bad tenant' })).toThrow(ZodError);
    expect(() => UsageAggregateFilterSchema.parse({ businessId: '' })).toThrow(ZodError);
    expect(() => UsageAggregateFilterSchema.parse({ operationId: 'op-1' })).toThrow(ZodError);
    expect(() => UsageAggregateFilterSchema.parse({ from: '2026-03-01 00:00' })).toThrow(ZodError);
    expect(() => UsageAggregateFilterSchema.parse({ to: 'next tuesday' })).toThrow(ZodError);
  });

  test('4. window order: to<=from rejected, incl. equal instants written in different offsets', () => {
    expect(() =>
      UsageAggregateFilterSchema.parse({ from: '2026-03-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }),
    ).toThrow(ZodError);
    expect(() =>
      UsageAggregateFilterSchema.parse({ from: '2026-03-02T00:00:00Z', to: '2026-03-01T00:00:00Z' }),
    ).toThrow(ZodError);
    // '2026-02-28T17:00:00Z' and '2026-03-01T00:00:00+07:00' are the SAME instant
    expect(() =>
      UsageAggregateFilterSchema.parse({
        from: '2026-03-01T00:00:00+07:00',
        to: '2026-02-28T17:00:00Z',
      }),
    ).toThrow(ZodError);
  });

  test('5. timeField is a closed enum: only occurredAt / receivedAt', () => {
    expect(() => UsageAggregateFilterSchema.parse({ timeField: 'createdAt' })).toThrow(ZodError);
    expect(() => UsageAggregateFilterSchema.parse({ timeField: null })).toThrow(ZodError);
    expect(UsageAggregateFilterSchema.parse({ timeField: 'receivedAt' }).timeField).toBe('receivedAt');
  });
});

describe('UsageSummarySchema', () => {
  test('6. valid summaries parse; all-zero is a legal empty-period result', () => {
    const ok = UsageSummarySchema.parse({
      inputTokens: 3010,
      outputTokens: 1500,
      totalTokens: 4510,
      totalCostMicrousd: 22500,
      eventCount: 3,
    });
    expect(ok.totalTokens).toBe(4510);
    expect(UsageSummarySchema.parse({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostMicrousd: 0, eventCount: 0,
    })).toBeTruthy();
  });

  test('7. .strict(): no extra dimension (usd float, distinctOps) can ride along', () => {
    const base = {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostMicrousd: 0, eventCount: 0,
    };
    expect(() => UsageSummarySchema.parse({ ...base, costUsd: 0.0225 })).toThrow(ZodError);
    expect(() => UsageSummarySchema.parse({ ...base, distinctOperations: 3 })).toThrow(ZodError);
  });

  test('8. int/bounds/invariant: negative, float, unsafe-int, totalTokens mismatch rejected', () => {
    const base = {
      inputTokens: 1000, outputTokens: 500, totalTokens: 1500, totalCostMicrousd: 7500, eventCount: 1,
    };
    expect(() => UsageSummarySchema.parse({ ...base, totalCostMicrousd: -1 })).toThrow(ZodError);
    expect(() => UsageSummarySchema.parse({ ...base, totalCostMicrousd: 7500.5 })).toThrow(ZodError);
    expect(() => UsageSummarySchema.parse({ ...base, totalCostMicrousd: 1e20 })).toThrow(ZodError);
    expect(() => UsageSummarySchema.parse({ ...base, totalTokens: 1501 })).toThrow(ZodError);
  });
});

describe('usage aggregation engines', () => {
  test('9. zero events -> exact all-zero summary, eventCount 0', () => {
    expect(aggregateUsageEvents([])).toStrictEqual({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostMicrousd: 0, eventCount: 0,
    });
    expect(aggregateUsageEvents([], { tenantId: 'tenant-a' })).toStrictEqual({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCostMicrousd: 0, eventCount: 0,
    });
  });

  test('10. no filter: BigInt sums are exact integers; result round-trips UsageSummarySchema', () => {
    const s = aggregateUsageEvents([EVT1, EVT2, EVT3]);
    expect(s).toStrictEqual({
      inputTokens: 3010,
      outputTokens: 1500,
      totalTokens: 4510,
      totalCostMicrousd: 22500,
      eventCount: 3,
    });
    expect(UsageSummarySchema.parse(s)).toStrictEqual(s);
  });

  test('11. tenantId filter narrows rows; non-matching tenant yields zero summary', () => {
    const a = aggregateUsageEvents([EVT1, EVT2, EVT3], { tenantId: 'tenant-a' });
    expect(a).toStrictEqual({
      inputTokens: 3000, outputTokens: 1500, totalTokens: 4500, totalCostMicrousd: 22500, eventCount: 2,
    });
    expect(aggregateUsageEvents([EVT1, EVT2], { tenantId: 'tenant-z' }).eventCount).toBe(0);
  });

  test('12. businessId filter is independent of tenant filter field', () => {
    const b = aggregateUsageEvents([EVT1, EVT2, EVT3], { businessId: 'biz-archive' });
    expect(b).toStrictEqual({
      inputTokens: 10, outputTokens: 0, totalTokens: 10, totalCostMicrousd: 0, eventCount: 1,
    });
  });

  test('13. operationId filter selects a single operation\u0027s events (multi-invocation ops)', () => {
    const again = makeEvent({ eventId: 'evt-0009', invocationId: 'inv-09', attempt: 2 });
    const o = aggregateUsageEvents([EVT1, EVT2, EVT3, again], { operationId: OP_A });
    expect(o).toStrictEqual({
      inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, totalCostMicrousd: 15000, eventCount: 2,
    });
  });

  test('14. combined filters AND together', () => {
    const c = aggregateUsageEvents([EVT1, EVT2, EVT3], {
      tenantId: 'tenant-a',
      businessId: 'biz-reports',
      from: '2026-03-01T10:30:00Z',
      to: '2026-03-01T11:30:00Z',
    });
    expect(c).toStrictEqual({
      inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, totalCostMicrousd: 15000, eventCount: 1,
    });
    // tenant mismatch kills the same row even though business matches nothing else
    expect(aggregateUsageEvents([EVT2], { tenantId: 'tenant-b', businessId: 'biz-reports' }).eventCount).toBe(0);
  });

  test('15. half-open window [from,to): from-instant in, to-instant out, to-1ms in', () => {
    const win = { from: '2026-03-01T10:00:00Z', to: '2026-03-01T11:00:00Z' };
    expect(aggregateUsageEvents([EVT1], win).eventCount).toBe(1); // at === from
    expect(aggregateUsageEvents([EVT2], win).eventCount).toBe(0); // at === to
    expect(
      aggregateUsageEvents([EVT2], { from: '2026-03-01T10:00:00Z', to: '2026-03-01T11:00:00.001Z' }).eventCount,
    ).toBe(1);
  });

  test('16. window compares instants, not wall-clock text (Z vs +07:00)', () => {
    // 2026-03-01T00:30:00+07:00 == 2026-02-28T17:30:00Z
    const ev = makeEvent({ occurredAt: '2026-03-01T00:30:00+07:00' });
    expect(aggregateUsageEvents([ev], { from: '2026-02-28T18:00:00Z' }).eventCount).toBe(0);
    expect(
      aggregateUsageEvents([ev], {
        from: '2026-02-28T17:00:00Z',
        to: '2026-02-28T18:00:00Z',
      }).eventCount,
    ).toBe(1);
    // same-event filter written with offset against Z-stamped events still selects
    expect(
      aggregateUsageEvents([EVT1], {
        from: '2026-03-01T17:00:00+07:00',
        to: '2026-03-01T18:30:00+07:00',
      }).eventCount,
    ).toBe(1);
  });

  test('17. timeField selects the published clock: same window, different answer', () => {
    const late = makeEvent({
      eventId: 'evt-late',
      occurredAt: '2026-03-01T10:00:00Z',
      receivedAt: '2026-03-02T09:00:00Z',
    });
    const win = { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' };
    expect(aggregateUsageEvents([late], win).eventCount).toBe(1); // default occurredAt
    expect(aggregateUsageEvents([late], { ...win, timeField: 'occurredAt' }).eventCount).toBe(1);
    expect(aggregateUsageEvents([late], { ...win, timeField: 'receivedAt' }).eventCount).toBe(0);
  });

  test('18. dedup: same eventId delivered 3x (reordered keys, defaulted kind) counts once', () => {
    const explicit = UsageLedgerEventSchema.parse({ ...BASE_EVENT });
    const shuffled = UsageLedgerEventSchema.parse({
      idempotencyKey: 'evt-0001',
      occurredAt: '2026-03-01T10:00:00Z',
      unitType: 'tokens',
      units: { outputTokens: 500, inputTokens: 1000 },
      model: 'gpt-4o',
      provider: 'openai',
      connectorRevision: 4,
      connectorId: 'conn-openai',
      profileRevision: 2,
      action: 'transform',
      businessVersion: 'v3',
      businessId: 'biz-reports',
      stepKey: 'convert',
      attempt: 1,
      invocationId: 'inv-01',
      taskId: TASK_ID,
      operationId: OP_A,
      apiKeyId: 'key-01',
      tenantId: 'tenant-a',
      eventId: 'evt-0001',
      costMicrousd: 7500,
      currency: 'USD',
      costStatus: 'measured',
      durationMs: 120,
      receivedAt: '2026-03-01T10:00:05Z',
    }); // kind omitted -> defaulted, key order different
    const third = UsageLedgerEventSchema.parse({ ...BASE_EVENT, kind: 'initial' });
    const s = aggregateUsageEvents([explicit, shuffled, third]);
    expect(s).toStrictEqual({
      inputTokens: 1000, outputTokens: 500, totalTokens: 1500, totalCostMicrousd: 7500, eventCount: 1,
    });
  });

  test('19. conflict: same eventId, divergent payload -> fail closed, never pick-a-side', () => {
    const twin = makeEvent({ costMicrousd: 7501 });
    expect(() => aggregateUsageEvents([EVT1, twin])).toThrow(UsageReconciliationConflictError);
    let caught: unknown;
    try {
      aggregateUsageEvents([EVT1, twin]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageReconciliationConflictError);
    expect((caught as UsageReconciliationConflictError).eventId).toBe('evt-0001');
    expect((caught as Error).message).toMatch(/USAGE_EVENT_CONFLICT/);
  });

  test('20. dedup integrity checked before filtering: conflict outside the window still throws', () => {
    const twin = makeEvent({ costMicrousd: 7501, occurredAt: '2026-09-09T09:09:09Z' });
    expect(() =>
      aggregateUsageEvents([EVT1, twin], {
        from: '2026-03-01T00:00:00Z',
        to: '2026-03-02T00:00:00Z',
      }),
    ).toThrow(UsageReconciliationConflictError);
  });

  test('21. engine re-parses both inputs: hostile keys, non-int money, bad filter, non-array', () => {
    const hostile = { ...BASE_EVENT, prompt: 'leak' } as unknown as UsageLedgerEvent;
    expect(() => aggregateUsageEvents([hostile])).toThrow(ZodError);
    const floaty = { ...BASE_EVENT, costMicrousd: 7500.5 } as unknown as UsageLedgerEvent;
    expect(() => aggregateUsageEvents([floaty])).toThrow(ZodError);
    expect(() =>
      aggregateUsageEvents([], { groupBy: 'tenant' } as unknown as UsageAggregateFilterInput),
    ).toThrow(ZodError);
    expect(() =>
      aggregateUsageEvents([], { tenantId: 42 } as unknown as UsageAggregateFilterInput),
    ).toThrow(ZodError);
    expect(() =>
      aggregateUsageEvents(undefined as unknown as UsageLedgerEvent[]),
    ).toThrow(TypeError);
  });

  test('22. pending events contribute tokens and count but zero money; unsettled cost stays locked to 0', () => {
    const s = aggregateUsageEvents([EVT3]);
    expect(s).toStrictEqual({
      inputTokens: 10, outputTokens: 0, totalTokens: 10, totalCostMicrousd: 0, eventCount: 1,
    });
    // the ledger schema itself refuses pending-with-cost
    expect(() => makeEvent({ costStatus: 'pending', costMicrousd: 5 })).toThrow(ZodError);
  });

  test('23. current semantics PIN (pending adjudication): corrections/refunds add on top, no netting', () => {
    const refund = makeEvent({
      eventId: 'evt-refund',
      kind: 'refund',
      correctsEventId: 'evt-0001',
      units: { inputTokens: 0, outputTokens: 0 },
      costMicrousd: 200,
    });
    const s = aggregateUsageEvents([EVT1, refund]);
    expect(s.totalCostMicrousd).toBe(7700); // 7500 + 200, additive
    expect(s.eventCount).toBe(2);
  });

  test('24. decomposition identity: per-tenant and per-business group sums == overall (docs COST-03)', () => {
    const all = aggregateUsageEvents([EVT1, EVT2, EVT3]);
    const ta = aggregateUsageEvents([EVT1, EVT2, EVT3], { tenantId: 'tenant-a' });
    const tb = aggregateUsageEvents([EVT1, EVT2, EVT3], { tenantId: 'tenant-b' });
    const summed = UsageSummarySchema.parse({
      inputTokens: ta.inputTokens + tb.inputTokens,
      outputTokens: ta.outputTokens + tb.outputTokens,
      totalTokens: ta.totalTokens + tb.totalTokens,
      totalCostMicrousd: ta.totalCostMicrousd + tb.totalCostMicrousd,
      eventCount: ta.eventCount + tb.eventCount,
    });
    expect(summed).toStrictEqual(all);
    const br = aggregateUsageEvents([EVT1, EVT2, EVT3], { businessId: 'biz-reports' });
    const ba = aggregateUsageEvents([EVT1, EVT2, EVT3], { businessId: 'biz-archive' });
    expect(br.totalCostMicrousd + ba.totalCostMicrousd).toBe(all.totalCostMicrousd);
    expect(br.eventCount + ba.eventCount).toBe(all.eventCount);
  });

  test('25. overflow safeguard: totals at/below MAX_SAFE_INTEGER are exact, beyond -> RangeError', () => {
    const big = (id: string, cost: number, tin: number, tout: number) =>
      makeEvent({
        eventId: id,
        costMicrousd: cost,
        units: { inputTokens: tin, outputTokens: tout },
      });
    // 3 * 3e15 = 9e15 <= 9007199254740991: exact, no double drift
    const fits = aggregateUsageEvents([
      big('o1', 3_000_000_000_000_000, 0, 0),
      big('o2', 3_000_000_000_000_000, 0, 0),
      big('o3', 3_000_000_000_000_000, 0, 0),
    ]);
    expect(fits.totalCostMicrousd).toBe(9_000_000_000_000_000);
    // one more event crosses the cap: refuse, do not truncate
    expect(() =>
      aggregateUsageEvents([
        big('o1', 3_000_000_000_000_000, 0, 0),
        big('o2', 3_000_000_000_000_000, 0, 0),
        big('o3', 3_000_000_000_000_000, 0, 0),
        big('o4', 3_000_000_000_000_000, 0, 0),
      ]),
    ).toThrow(RangeError);
    // total-only overflow (each side individually safe) still caught
    expect(() =>
      aggregateUsageEvents([
        big('t1', 0, 6_000_000_000_000_000, 0),
        big('t2', 0, 0, 6_000_000_000_000_000),
      ]),
    ).toThrow(/USAGE_AGGREGATE_OVERFLOW/);
    // single event beyond the cap: the ledger schema has no max on cost, so
    // the aggregator is the boundary that fails closed
    expect(() => aggregateUsageEvents([big('x', 1e20, 0, 0)])).toThrow(RangeError);
  });

  test('26. pure + deterministic: inputs untouched, repeated calls identical, index re-export works', () => {
    const events = [EVT1, EVT2, EVT3];
    const snapshot = JSON.parse(JSON.stringify(events));
    const filter = { from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z' } as const;
    const first = aggregateUsageEvents(events, filter);
    expect(events).toStrictEqual(snapshot);
    expect(JSON.stringify(filter)).toBe('{"from":"2026-03-01T00:00:00Z","to":"2026-03-02T00:00:00Z"}');
    expect(aggregateUsageEvents(events, filter)).toStrictEqual(first);
    expect(ViaIndex(events)).toStrictEqual(aggregateUsageEvents(events));
  });

  test('27. COST-03 groups reconcile unique counts, status breakdowns and micro-USD', () => {
    const measuredSecondStep = makeEvent({
      eventId: 'evt-measured-step',
      stepKey: 'summarize',
      units: { inputTokens: 20, outputTokens: 10 },
      costMicrousd: 100,
    });
    const estimated = makeEvent({
      eventId: 'evt-estimated',
      invocationId: 'inv-02',
      attempt: 2,
      apiKeyId: 'key-02',
      profileRevision: 3,
      provider: 'anthropic',
      model: 'claude-sonnet',
      units: { inputTokens: 25, outputTokens: 5 },
      costMicrousd: 50,
      costStatus: 'estimated',
    });
    const pending = makeEvent({
      eventId: 'evt-pending',
      tenantId: 'tenant-b',
      operationId: OP_C,
      invocationId: 'inv-pending',
      units: { inputTokens: 0, outputTokens: 0 },
      costMicrousd: 0,
      costStatus: 'pending',
    });
    const unpriced = makeEvent({
      eventId: 'evt-unpriced',
      operationId: OP_B,
      invocationId: 'inv-unpriced',
      apiKeyId: 'key-02',
      units: { inputTokens: 10, outputTokens: 5 },
      costMicrousd: 0,
      costStatus: 'unpriced',
    });
    const events = [EVT1, measuredSecondStep, estimated, pending, unpriced, JSON.parse(JSON.stringify(EVT1)) as UsageLedgerEvent];
    const snapshot = JSON.parse(JSON.stringify(events));
    const aggregate = aggregateUsageGroups(events);

    expect(aggregate.timeSemantics).toStrictEqual({ field: 'occurredAt', interval: '[from,to)', timezone: 'UTC' });
    expect(aggregate.groupBy).toEqual(['tenant', 'apiKey', 'businessAction', 'profile', 'providerModel']);
    expect(aggregate.totals).toStrictEqual({
      eventCount: 5,
      uniqueOperations: 3,
      invocations: 4,
      attempts: 4,
      inputTokens: 1055,
      outputTokens: 520,
      totalTokens: 1575,
      costMicrousd: 7650,
      breakdown: {
        measured: {
          eventCount: 2, uniqueOperations: 1, invocations: 1, attempts: 1,
          inputTokens: 1020, outputTokens: 510, totalTokens: 1530, costMicrousd: 7600,
        },
        estimated: {
          eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1,
          inputTokens: 25, outputTokens: 5, totalTokens: 30, costMicrousd: 50,
        },
        pending: {
          eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicrousd: 0,
        },
        unpriced: {
          eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1,
          inputTokens: 10, outputTokens: 5, totalTokens: 15, costMicrousd: 0,
        },
      },
    });
    expect(aggregate.groups).toHaveLength(4);
    expect(aggregate.groups[0]!.dimensions).toStrictEqual({
      tenantId: 'tenant-a', apiKeyId: 'key-01', businessId: 'biz-reports', action: 'transform',
      profileRevision: 2, provider: 'openai', model: 'gpt-4o',
    });
    expect(aggregate.groups[0]!.metrics.uniqueOperations).toBe(1);
    expect(aggregate.groups[0]!.metrics.invocations).toBe(1);
    expect(aggregate.groups[0]!.metrics.attempts).toBe(1);
    expect(aggregate.groups[0]!.metrics.breakdown.measured.eventCount).toBe(2);
    expect(aggregate.groups.reduce((sum, group) => sum + group.metrics.eventCount, 0)).toBe(5);
    expect(events).toStrictEqual(snapshot);
    expect(GroupsViaIndex(events)).toStrictEqual(aggregate);
    expect(UsageAggregationSchema.parse(aggregate)).toStrictEqual(aggregate);
  });

  test('28. group levels are selectable and preserve pair dimensions', () => {
    const aggregate = aggregateUsageGroups([EVT1, EVT3], {
      groupBy: ['tenant', 'businessAction', 'providerModel'],
      filter: {
        tenantId: 'tenant-a',
        from: '2026-03-01T17:00:03+07:00',
        to: '2026-03-01T10:00:06Z',
        timeField: 'receivedAt',
      },
    });
    expect(aggregate.timeSemantics).toStrictEqual({ field: 'receivedAt', interval: '[from,to)', timezone: 'UTC' });
    expect(aggregate.groupBy).toEqual(['tenant', 'businessAction', 'providerModel']);
    expect(aggregate.groups).toHaveLength(1);
    expect(aggregate.groups[0]!.dimensions).toStrictEqual({
      tenantId: 'tenant-a', businessId: 'biz-reports', action: 'transform', provider: 'openai', model: 'gpt-4o',
    });
    expect(aggregate.totals.eventCount).toBe(1); // receivedAt is in-window; occurredAt is before it
    expect(() => UsageAggregationSchema.parse({
      ...aggregate,
      timeSemantics: { ...aggregate.timeSemantics, field: 'occurredAt' },
    })).toThrow(ZodError);
  });

  test('29. grouping rejects duplicate/out-of-order levels, malformed groups and overflowing totals', () => {
    expect(() => UsageAggregateGroupBySchema.parse(['apiKey', 'tenant'])).toThrow(ZodError);
    expect(() => UsageAggregateGroupBySchema.parse(['tenant', 'tenant'])).toThrow(ZodError);
    const base = aggregateUsageGroups([EVT1]);
    expect(() => UsageAggregationSchema.parse({
      ...base,
      groups: [{ ...base.groups[0]!, dimensions: { ...base.groups[0]!.dimensions, rawApiKey: 'secret' } }],
    })).toThrow(ZodError);
    expect(() => aggregateUsageGroups([makeEvent({ eventId: 'evt-too-large', costMicrousd: 1e20 })])).toThrow(RangeError);
    const conflict = makeEvent({ eventId: EVT1.eventId, costMicrousd: EVT1.costMicrousd + 1 });
    expect(() => aggregateUsageGroups([EVT1, conflict])).toThrow(UsageReconciliationConflictError);
  });
});
