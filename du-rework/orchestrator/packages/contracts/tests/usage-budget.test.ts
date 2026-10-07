import { ZodError } from 'zod';
import {
  BudgetConfigSchema,
  BudgetEvaluationSchema,
  BudgetPeriodSchema,
  BudgetPolicySchema,
  evaluateBudgetStatus,
  type BudgetConfig,
} from '../src/usage-budget';
import { UsageSummarySchema, aggregateUsageEvents, type UsageSummary } from '../src/usage-reconciliation';
import { UsageLedgerEventSchema, type UsageLedgerEvent } from '../src/usage-metrics';
import { evaluateBudgetStatus as ViaIndex } from '../src/index';

/**
 * COST-04 budget/threshold policy-core tests (W-COST04-BUDGET-ALERT-1) -
 * offline, zero DB/Redis. Positive: documented ALLOW/WARN/BLOCK semantics
 * produce exact integers with BigInt math. Negative (win = fail closed):
 * unknown keys rejected by .strict(); zero or fractional or oversized caps
 * rejected; hostile usage/reservation payloads refused before arithmetic;
 * totals beyond Number.MAX_SAFE_INTEGER refuse to truncate. Pinned semantics
 * (flip = exactly one test each, receipt deltas D14/D15/D17) are marked PIN.
 */

const OP_X1 = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const OP_X2 = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TASK_X = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

const makeSummary = (over: Record<string, unknown> = {}): UsageSummary =>
  UsageSummarySchema.parse({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostMicrousd: 0,
    eventCount: 0,
    ...over,
  });

const SUM = (tokens: number, cost: number, events = 2): UsageSummary =>
  makeSummary({
    inputTokens: Math.floor(tokens / 2),
    outputTokens: tokens - Math.floor(tokens / 2),
    totalTokens: tokens,
    totalCostMicrousd: cost,
    eventCount: events,
  });

const BASE_BUDGET = {
  tenantId: 'tenant-a',
  period: 'monthly',
  tokenThreshold: 1000,
  usdThresholdMicroUsd: 25000,
  alertThresholdPercent: 80,
  policy: 'alert-only',
  notificationChannels: ['channel-01'],
  status: 'active',
};

const makeBudget = (over: Record<string, unknown> = {}): BudgetConfig =>
  BudgetConfigSchema.parse({ ...BASE_BUDGET, ...over });

/** Ledger events for the aggregator-to-budget integration (test 29). */
const BASE_LEDGER = {
  eventId: 'evt-b1',
  idempotencyKey: 'evt-b1',
  kind: 'initial',
  tenantId: 'tenant-a',
  apiKeyId: 'key-01',
  operationId: OP_X1,
  taskId: TASK_X,
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
  units: { inputTokens: 2000, outputTokens: 1000 },
  costMicrousd: 15000,
  currency: 'USD',
  costStatus: 'measured',
  durationMs: 120,
  occurredAt: '2026-03-01T10:00:00Z',
  receivedAt: '2026-03-01T10:00:05Z',
};
const makeLedger = (over: Record<string, unknown> = {}): UsageLedgerEvent =>
  UsageLedgerEventSchema.parse({ ...BASE_LEDGER, ...over });

describe('Budget config schemas', () => {
  test('1. period/policy/status enums are closed and case-sensitive', () => {
    expect(BudgetPeriodSchema.parse('daily')).toBe('daily');
    expect(BudgetPeriodSchema.parse('monthly')).toBe('monthly');
    expect(BudgetPolicySchema.parse('alert-only')).toBe('alert-only');
    expect(BudgetPolicySchema.parse('block-new-invocations')).toBe('block-new-invocations');
    for (const bad of ['DAILY', 'Weekly', 'WEEKLY', 'SOFT_BLOCK', '', null, 80]) {
      expect(() => BudgetPeriodSchema.parse(bad)).toThrow(ZodError);
    }
    for (const bad of ['alert_only', 'ALERT_ONLY', 'BLOCK_NEW_INVOCATIONS', 'Block', 'ALERT', '', null]) {
      expect(() => BudgetPolicySchema.parse(bad)).toThrow(ZodError);
    }
    expect(BudgetConfigSchema.parse({ ...BASE_BUDGET, status: 'suspended' }).status).toBe('suspended');
    expect(() => makeBudget({ status: 'paused' })).toThrow(ZodError);
  });

  test('2. happy config: defaults filled, canonical round-trip, fresh default arrays', () => {
    const minimal = BudgetConfigSchema.parse({
      tenantId: 'tenant-a',
      period: 'daily',
      tokenThreshold: 10,
      usdThresholdMicroUsd: 10,
      alertThresholdPercent: 80,
      policy: 'alert-only',
      status: 'active',
    });
    expect(minimal.notificationChannels).toEqual([]);
    const again = BudgetConfigSchema.parse({
      tenantId: 'tenant-a',
      period: 'daily',
      tokenThreshold: 10,
      usdThresholdMicroUsd: 10,
      alertThresholdPercent: 80,
      policy: 'alert-only',
      status: 'active',
    });
    // thunk default: two parsed rows must not share one mutable array
    expect(minimal.notificationChannels).not.toBe(again.notificationChannels);
    const full = makeBudget({ alertThresholdPercent: 65, notificationChannels: ['ch-1', 'ch-2'] });
    expect(BudgetConfigSchema.parse(full)).toStrictEqual(full);
  });

  test('3. .strict() refuses every sentinel key', () => {
    for (const sentinel of ['costUsd', 'groupBy', 'webhookUrl', 'expectedRevision', 'budgetNotes', 'apiKeySecret', 'owner']) {
      expect(() => BudgetConfigSchema.parse({ ...BASE_BUDGET, [sentinel]: 'x' })).toThrow(ZodError);
    }
  });

  test('4. tenant and optional scope IDs are sanitized opaque IDs', () => {
    expect(() => makeBudget({ tenantId: 'ops team' })).toThrow(ZodError);
    expect(() => makeBudget({ tenantId: 42 })).toThrow(ZodError);
    expect(() => makeBudget({ apiKeyId: 'key with spaces' })).toThrow(ZodError);
    expect(() => makeBudget({ profileId: '' })).toThrow(ZodError);
    expect(() => makeBudget({ businessId: 'https://hooks.example/x?a=b' })).toThrow(ZodError);
    expect(makeBudget({ apiKeyId: 'key-1', profileId: 'profile-1', businessId: 'document-core' })).toMatchObject({
      apiKeyId: 'key-1',
      profileId: 'profile-1',
      businessId: 'document-core',
    });
    expect(makeBudget({ apiKeyId: 'a'.repeat(128) }).apiKeyId).toHaveLength(128);
    expect(() => makeBudget({ apiKeyId: 'a'.repeat(129) })).toThrow(ZodError);
  });

  test('5. alertThresholdPercent band 1..100, integers only', () => {
    for (const bad of [0, 101, 1.5, -80, '80', null]) {
      expect(() => makeBudget({ alertThresholdPercent: bad })).toThrow(ZodError);
    }
    expect(makeBudget({ alertThresholdPercent: 1 }).alertThresholdPercent).toBe(1);
    expect(makeBudget({ alertThresholdPercent: 100 }).alertThresholdPercent).toBe(100);
  });

  test('6. limits: mandatory int >= 1 <= MAX_SAFE_INTEGER (0 refused, PIN delta D16)', () => {
    for (const bad of [1000.5, -1, '1000', 0, 1e20, Infinity, null]) {
      expect(() => makeBudget({ tokenThreshold: bad })).toThrow(ZodError);
      expect(() => makeBudget({ usdThresholdMicroUsd: bad })).toThrow(ZodError);
    }
    expect(() => {
      // a config missing tokenThreshold entirely must not pass either
      const { tokenThreshold, ...rest } = BASE_BUDGET;
      void tokenThreshold;
      return BudgetConfigSchema.parse(rest);
    }).toThrow(ZodError);
    expect(makeBudget({ tokenThreshold: 1 }).tokenThreshold).toBe(1);
    expect(makeBudget({ tokenThreshold: MAX_SAFE }).tokenThreshold).toBe(MAX_SAFE);
  });

  test('7. notificationChannels: bounded list of opaque ids, URLs structurally refused', () => {
    expect(() => makeBudget({ notificationChannels: 'channel-01' })).toThrow(ZodError);
    expect(() => makeBudget({ notificationChannels: ['ch a'] })).toThrow(ZodError);
    expect(() => makeBudget({ notificationChannels: ['https://hooks.example/x?a=b'] })).toThrow(ZodError);
    expect(() => makeBudget({ notificationChannels: ['https://hooks.example/x'] })).toThrow(ZodError);
    expect(() => makeBudget({ notificationChannels: Array.from({ length: 21 }, (_, i) => 'ch-' + i) })).toThrow(ZodError);
    const ok = makeBudget({ notificationChannels: Array.from({ length: 20 }, (_, i) => 'ch-' + i) });
    expect(ok.notificationChannels).toHaveLength(20);
    expect(makeBudget({ notificationChannels: [] }).notificationChannels).toEqual([]);
  });
});

describe('evaluateBudgetStatus', () => {
  test('8. zero usage returns exactly the six packet fields, all clear', () => {
    const r = evaluateBudgetStatus(makeBudget(), SUM(0, 0, 0));
    expect(r).toStrictEqual({
      usagePercent: 0,
      warnThresholdExceeded: false,
      limitExceeded: false,
      action: 'ALLOW',
      remainingTokens: 1000,
      remainingCostMicrousd: 25000,
    });
    expect(Object.keys(r).sort()).toEqual([
      'action',
      'limitExceeded',
      'remainingCostMicrousd',
      'remainingTokens',
      'usagePercent',
      'warnThresholdExceeded',
    ]);
  });

  test('9. well under threshold: ALLOW', () => {
    const r = evaluateBudgetStatus(makeBudget(), SUM(500, 12500));
    expect(r.usagePercent).toBe(50);
    expect(r.action).toBe('ALLOW');
    expect(r.warnThresholdExceeded).toBe(false);
    expect(r.limitExceeded).toBe(false);
    expect(r.remainingTokens).toBe(500);
    expect(r.remainingCostMicrousd).toBe(12500);
  });

  test('10. PIN delta D14/D15: touching the threshold exactly (floor >= k) WARNs', () => {
    // 800/1000 tokens = 80% exactly, 20000/25000 cost = 80% exactly
    const r = evaluateBudgetStatus(makeBudget(), SUM(800, 20000, 3));
    expect(r.usagePercent).toBe(80);
    expect(r.warnThresholdExceeded).toBe(true);
    expect(r.action).toBe('WARN');
    expect(r.limitExceeded).toBe(false);
    expect(r.remainingTokens).toBe(200);
    expect(r.remainingCostMicrousd).toBe(5000);
  });

  test('11. just below threshold stays ALLOW even a hair under', () => {
    const r = evaluateBudgetStatus(makeBudget(), SUM(799, 19999));
    expect(r.usagePercent).toBe(79);
    expect(r.warnThresholdExceeded).toBe(false);
    expect(r.action).toBe('ALLOW');
    expect(r.remainingTokens).toBe(201);
    expect(r.remainingCostMicrousd).toBe(5001);
  });

  test('12. over threshold, under cap: WARN (ALERT_ONLY and BLOCK agree here)', () => {
    const warn = evaluateBudgetStatus(makeBudget(), SUM(900, 5000));
    expect(warn.usagePercent).toBe(90);
    expect(warn.action).toBe('WARN');
    expect(warn.limitExceeded).toBe(false);
    const blockSame = evaluateBudgetStatus(makeBudget({ policy: 'block-new-invocations' }), SUM(900, 5000));
    expect(blockSame).toStrictEqual(warn);
  });

  test('13. PIN delta D14: reaching the cap counts as limitExceeded; ALERT_ONLY caps action at WARN', () => {
    const r = evaluateBudgetStatus(makeBudget(), SUM(1000, 25000));
    expect(r.limitExceeded).toBe(true);
    expect(r.usagePercent).toBe(100);
    expect(r.warnThresholdExceeded).toBe(true);
    expect(r.action).toBe('WARN'); // ALERT_ONLY never blocks
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(0);
  });

  test('14. over cap with ALERT_ONLY: WARN with honest percent above 100, remaining clamped', () => {
    const r = evaluateBudgetStatus(makeBudget(), SUM(1080, 31250));
    expect(r.usagePercent).toBe(125);
    expect(r.limitExceeded).toBe(true);
    expect(r.action).toBe('WARN');
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(0);
  });

  test('15. exactly at cap with BLOCK_NEW_INVOCATIONS: BLOCK (one more invocation is refused)', () => {
    const r = evaluateBudgetStatus(makeBudget({ policy: 'block-new-invocations' }), SUM(1000, 20000));
    expect(r.limitExceeded).toBe(true);
    expect(r.action).toBe('BLOCK');
    expect(r.usagePercent).toBe(100);
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(5000); // cost dimension still has room
  });

  test('16. over cap with BLOCK: BLOCK', () => {
    const r = evaluateBudgetStatus(makeBudget({ policy: 'block-new-invocations' }), SUM(1100, 20000));
    expect(r.usagePercent).toBe(110);
    expect(r.action).toBe('BLOCK');
    expect(r.limitExceeded).toBe(true);
  });

  test('17. inFlightReservation pushes usage across the warn threshold', () => {
    const usage = SUM(700, 17500);
    const alone = evaluateBudgetStatus(makeBudget(), usage);
    expect(alone.action).toBe('ALLOW');
    const withRes = evaluateBudgetStatus(makeBudget(), usage, SUM(150, 3750, 1));
    expect(withRes.usagePercent).toBe(85);
    expect(withRes.warnThresholdExceeded).toBe(true);
    expect(withRes.action).toBe('WARN');
    expect(withRes.limitExceeded).toBe(false);
    expect(withRes.remainingTokens).toBe(150);
    expect(withRes.remainingCostMicrousd).toBe(3750);
  });

  test('18. PIN delta D14: reservation counts 100% toward blocking (running/UNKNOWN held)', () => {
    const r = evaluateBudgetStatus(
      makeBudget({ policy: 'block-new-invocations' }),
      SUM(900, 22500),
      SUM(100, 2500, 1),
    );
    expect(r.usagePercent).toBe(100);
    expect(r.limitExceeded).toBe(true);
    expect(r.action).toBe('BLOCK');
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(0);
  });

  test('19. omitted reservation and zero-reservation are identical; null is refused', () => {
    const usage = SUM(640, 16000);
    const omitted = evaluateBudgetStatus(makeBudget(), usage);
    const zero = evaluateBudgetStatus(makeBudget(), usage, SUM(0, 0, 0));
    expect(zero).toStrictEqual(omitted);
    expect(omitted.usagePercent).toBe(64); // 640/1000 = 16000/25000 = 64% < 80%
    expect(omitted.action).toBe('ALLOW');
    expect(() =>
      evaluateBudgetStatus(makeBudget(), usage, null as unknown as UsageSummary),
    ).toThrow(ZodError);
    expect(() =>
      evaluateBudgetStatus(makeBudget(), usage, 42 as unknown as UsageSummary),
    ).toThrow(ZodError);
  });

  test('20. dimensions are evaluated independently: cost breach blocks even with tokens at 50%', () => {
    const alert = evaluateBudgetStatus(makeBudget(), SUM(500, 26000));
    expect(alert.usagePercent).toBe(104);
    expect(alert.limitExceeded).toBe(true);
    expect(alert.action).toBe('WARN');
    expect(alert.remainingTokens).toBe(500);
    expect(alert.remainingCostMicrousd).toBe(0);
    const blocked = evaluateBudgetStatus(makeBudget({ policy: 'block-new-invocations' }), SUM(500, 26000));
    expect(blocked.action).toBe('BLOCK');
  });

  test('21. PIN delta D15: usagePercent is the MAX over dimensions, independent of threshold', () => {
    const usage = SUM(300, 24999); // tokens 30%, cost 99%
    const lowThreshold = evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 30 }), usage);
    const highThreshold = evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 99 }), usage);
    expect(lowThreshold.usagePercent).toBe(99);
    expect(highThreshold.usagePercent).toBe(99);
    expect(lowThreshold.warnThresholdExceeded).toBe(true);
    expect(highThreshold.warnThresholdExceeded).toBe(true);
    expect(lowThreshold.action).toBe('WARN');
    expect(highThreshold.action).toBe('WARN');
    const overThreshold = evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 100 }), usage);
    expect(overThreshold.usagePercent).toBe(99);
    expect(overThreshold.warnThresholdExceeded).toBe(false);
    expect(overThreshold.action).toBe('ALLOW');
  });

  test('22. percent is exact BigInt floor division: boundaries and truncation, no float drift', () => {
    // 100/1000 = 10% exactly answers threshold 10 (integer math, not 9.999...)
    expect(evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 10 }), SUM(100, 1)).usagePercent).toBe(10);
    expect(evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 10 }), SUM(99, 1)).usagePercent).toBe(9);
    // truncation toward zero: 333/1000 -> 33, threshold 34 NOT reached
    const t = evaluateBudgetStatus(makeBudget({ alertThresholdPercent: 34 }), SUM(333, 25));
    expect(t.usagePercent).toBe(33);
    expect(t.warnThresholdExceeded).toBe(false);
    // odd token split keeps total exact: in=50 out=49
    const odd = evaluateBudgetStatus(makeBudget(), makeSummary({ inputTokens: 50, outputTokens: 49, totalTokens: 99, totalCostMicrousd: 2474, eventCount: 1 }));
    expect(odd.usagePercent).toBe(9);
  });

  test('23. hostile budget payloads fail closed before any arithmetic', () => {
    const usage = SUM(100, 100);
    expect(() => evaluateBudgetStatus({ ...BASE_BUDGET, tokenThreshold: '1000' } as unknown as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus({ ...BASE_BUDGET, tenantId: 42 } as unknown as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus({ ...BASE_BUDGET, usdThresholdMicroUsd: 25000.5 } as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus({ period: 'monthly', tokenThreshold: 10, usdThresholdMicroUsd: 10, policy: 'alert-only', status: 'active' } as unknown as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus({ ...BASE_BUDGET, policy: 'ALERT' } as unknown as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus(null as unknown as BudgetConfig, usage)).toThrow(ZodError);
    expect(() => evaluateBudgetStatus('budget' as unknown as BudgetConfig, usage)).toThrow(ZodError);
  });

  test('24. hostile usage/reservation payloads are re-parsed, never trusted', () => {
    const budget = makeBudget();
    expect(() =>
      evaluateBudgetStatus(budget, { inputTokens: 50, outputTokens: 50, totalTokens: 100, totalCostMicrousd: 100 } as unknown as UsageSummary),
    ).toThrow(ZodError); // missing eventCount
    expect(() =>
      evaluateBudgetStatus(budget, { inputTokens: 1.5, outputTokens: 0, totalTokens: 1.5, totalCostMicrousd: 100, eventCount: 1 } as unknown as UsageSummary),
    ).toThrow(ZodError); // fractional tokens
    expect(() =>
      evaluateBudgetStatus(budget, { inputTokens: '500', outputTokens: '500', totalTokens: '1000', totalCostMicrousd: '20000', eventCount: 3 } as unknown as UsageSummary),
    ).toThrow(ZodError); // string money
    expect(() =>
      evaluateBudgetStatus(budget, makeSummary({ inputTokens: 700, outputTokens: 700, totalTokens: 700, totalCostMicrousd: 0, eventCount: 1 })),
    ).toThrow(ZodError); // totalTokens invariant
    expect(() =>
      evaluateBudgetStatus(budget, SUM(100, 100), { ...SUM(50, 50, 1), prompt: 'leak' } as unknown as UsageSummary),
    ).toThrow(ZodError); // strict refuses extra key on reservation
  });

  test('25. remaining budget is exact BigInt arithmetic below the cap and 0 at/above it', () => {
    const noRes = evaluateBudgetStatus(makeBudget(), SUM(250, 5000));
    expect(noRes.remainingTokens).toBe(750);
    expect(noRes.remainingCostMicrousd).toBe(20000);
    const withRes = evaluateBudgetStatus(makeBudget(), SUM(250, 5000), SUM(200, 5000, 2));
    expect(withRes.remainingTokens).toBe(550);
    expect(withRes.remainingCostMicrousd).toBe(15000);
    expect(withRes.usagePercent).toBe(45);
    const over = evaluateBudgetStatus(makeBudget(), SUM(250, 5000), SUM(1000, 30000, 4));
    expect(over.remainingTokens).toBe(0);
    expect(over.remainingCostMicrousd).toBe(0);
    expect(over.usagePercent).toBe(140); // cost 35000/25000 is the max dimension
  });

  test('26. MAX_SAFE_INTEGER limits evaluate exactly at the boundary', () => {
    const budget = makeBudget({ tokenThreshold: MAX_SAFE, usdThresholdMicroUsd: MAX_SAFE, policy: 'block-new-invocations' });
    const r = evaluateBudgetStatus(budget, SUM(MAX_SAFE, MAX_SAFE, 1));
    expect(r.usagePercent).toBe(100);
    expect(r.limitExceeded).toBe(true);
    expect(r.action).toBe('BLOCK');
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(0);
    expect(Number.isSafeInteger(r.usagePercent)).toBe(true);
  });

  test('27. overflow safeguards: sums and percents beyond MAX_SAFE raise RangeError, never silent doubles', () => {
    const budget = makeBudget({ tokenThreshold: MAX_SAFE, usdThresholdMicroUsd: MAX_SAFE });
    // 5e15 + 5e15 = 1e16 > MAX_SAFE (9.007e15): refuse
    expect(() => evaluateBudgetStatus(budget, SUM(5e15, 1), SUM(5e15, 1, 1))).toThrow(RangeError);
    expect(() => evaluateBudgetStatus(budget, SUM(5e15, 1), SUM(5e15, 1, 1))).toThrow(/USAGE_BUDGET_OVERFLOW/);
    // cost dimension overflow names the field
    expect(() => evaluateBudgetStatus(budget, SUM(1, 5e15), SUM(1, 5e15, 1))).toThrow(/totalCostMicrousd/);
    // percent guard: limit 1 vs total 9e15 would need 9e17 percent
    const tiny = makeBudget({ tokenThreshold: 1, usdThresholdMicroUsd: 1 });
    expect(() => evaluateBudgetStatus(tiny, SUM(9e15, 1, 1))).toThrow(/usagePercent/);
    expect(() => evaluateBudgetStatus(tiny, SUM(9e15, 1, 1))).toThrow(RangeError);
  });

  test('28. purity and determinism: inputs untouched, repeat calls identical, output self-validates', () => {
    const budget = makeBudget({ policy: 'block-new-invocations', alertThresholdPercent: 60 });
    const usage = SUM(650, 16000);
    const res = SUM(10, 100, 1);
    const b0 = JSON.stringify(budget);
    const u0 = JSON.stringify(usage);
    const r0 = JSON.stringify(res);
    const first = evaluateBudgetStatus(budget, usage, res);
    const second = evaluateBudgetStatus(budget, usage, res);
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(budget)).toBe(b0);
    expect(JSON.stringify(usage)).toBe(u0);
    expect(JSON.stringify(res)).toBe(r0);
    expect(BudgetEvaluationSchema.parse(first)).toStrictEqual(first);
    expect(first.usagePercent).toBe(66); // 660/1000 tokens, 16100/25000 cost=64
    expect(first.action).toBe('WARN'); // 66 >= 60, no cap reached
  });

  test('29. integration: aggregateUsageEvents output feeds evaluateBudgetStatus unmodified', () => {
    const events = [
      makeLedger(),
      makeLedger({ eventId: 'evt-b2', operationId: OP_X2, invocationId: 'inv-02', units: { inputTokens: 1000, outputTokens: 500 }, costMicrousd: 7500, occurredAt: '2026-03-01T11:00:00Z', receivedAt: '2026-03-01T11:00:04Z' }),
    ];
    const actual = aggregateUsageEvents(events, { tenantId: 'tenant-a' });
    expect(actual).toStrictEqual({ inputTokens: 3000, outputTokens: 1500, totalTokens: 4500, totalCostMicrousd: 22500, eventCount: 2 });
    const r = evaluateBudgetStatus(makeBudget({ tokenThreshold: 4000, usdThresholdMicroUsd: 30000, policy: 'block-new-invocations' }), actual);
    expect(r.usagePercent).toBe(112); // tokens 4500/4000; cost 75% is the lower dimension
    expect(r.limitExceeded).toBe(true);
    expect(r.action).toBe('BLOCK');
    expect(r.remainingTokens).toBe(0);
    expect(r.remainingCostMicrousd).toBe(7500);
  });

  test('30. index re-export is the same function object and produces identical verdicts', () => {
    expect(ViaIndex).toBe(evaluateBudgetStatus);
    const budget = makeBudget({ policy: 'block-new-invocations' });
    expect(ViaIndex(budget, SUM(1000, 25000))).toStrictEqual(evaluateBudgetStatus(budget, SUM(1000, 25000)));
  });
});
