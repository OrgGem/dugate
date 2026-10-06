import { ZodError } from 'zod';
import {
  BudgetReservationRequestSchema,
  BudgetReservationReconcileSchema,
  BudgetReservationReconcileRequestSchema,
  budgetQuotaScopeKey,
  budgetReservationCountsAsHeld,
  isBudgetReservationTrusted,
  quotaScopeForBudget,
  resolveBudgetQuotaWindow,
} from '../src/usage-budget';

const BUDGET = {
  tenantId: 'tenant-a',
  apiKeyId: 'key-a',
  profileId: 'profile-a',
  businessId: 'document-core',
  period: 'daily' as const,
  tokenThreshold: 10_000,
  usdThresholdMicroUsd: 1_000_000,
  alertThresholdPercent: 80,
  policy: 'block-new-invocations' as const,
  status: 'active' as const,
};
const OPERATION = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const TASK = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';

describe('COST-04 reservation contract', () => {
  test('budget scope has one stable key shared by reserve and reconcile', () => {
    const scope = quotaScopeForBudget(BUDGET);
    expect(scope).toStrictEqual({
      tenantId: 'tenant-a', apiKeyId: 'key-a', profileId: 'profile-a', businessId: 'document-core',
    });
    expect(budgetQuotaScopeKey(scope)).toBe(budgetQuotaScopeKey({
      businessId: 'document-core', profileId: 'profile-a', apiKeyId: 'key-a', tenantId: 'tenant-a',
    }));
    expect(budgetQuotaScopeKey(scope)).not.toBe(budgetQuotaScopeKey({ tenantId: 'tenant-a', apiKeyId: 'key-a' }));
  });

  test('pre-call reservation rejects a scope that differs from its budget', () => {
    const good = {
      budget: BUDGET,
      quotaScope: quotaScopeForBudget(BUDGET),
      operationId: OPERATION,
      taskId: TASK,
      invocationId: 'invocation-a',
      attempt: 1,
      idempotencyKey: 'reserve-a',
      reserve: { tokens: 100, costMicroUsd: 500 },
      confidence: 'upper-bound',
    } as const;
    expect(BudgetReservationRequestSchema.parse(good).reserve).toStrictEqual({ tokens: 100, costMicroUsd: 500 });
    expect(() => BudgetReservationRequestSchema.parse({
      ...good,
      quotaScope: { tenantId: 'tenant-a' },
    })).toThrow(ZodError);
    expect(() => BudgetReservationRequestSchema.parse({
      ...good,
      reserve: { tokens: 0, costMicroUsd: 0 },
    })).toThrow(ZodError);
  });

  test('reconciliation binds actual usage to the original quota scope and invocation', () => {
    expect(BudgetReservationReconcileSchema.parse({
      reservationId: OPERATION,
      quotaScope: quotaScopeForBudget(BUDGET),
      operationId: OPERATION,
      taskId: TASK,
      invocationId: 'invocation-a',
      attempt: 1,
      eventId: 'usage-event-a',
      actual: { tokens: 95, costMicroUsd: 412 },
    })).toMatchObject({ actual: { tokens: 95, costMicroUsd: 412 } });
    expect(() => BudgetReservationReconcileSchema.parse({
      reservationId: OPERATION,
      quotaScope: { tenantId: 'tenant-a' },
      operationId: OPERATION,
      taskId: TASK,
      invocationId: 'invocation-a',
      attempt: 1,
      eventId: 'usage-event-a',
      actual: { tokens: 95, costMicroUsd: 412 },
      rawError: 'must not be accepted',
    })).toThrow(ZodError);
  });

  test('post-call wire contract refuses unknown diagnostics and preserves valid measured usage', () => {
    const request = {
      reservationId: OPERATION,
      quotaScope: quotaScopeForBudget(BUDGET),
      attempt: 1,
      usageEvent: {
        eventId: 'event:actual/1',
        invocationId: 'invocation-a',
        operationId: OPERATION,
        taskId: TASK,
        units: { inputTokens: 90, outputTokens: 10 },
        costMicrousd: 800,
        currency: 'USD' as const,
        measurement: 'measured' as const,
        occurredAt: '2026-09-28T12:00:00.000Z',
      },
    };
    expect(BudgetReservationReconcileRequestSchema.parse(request).usageEvent.eventId).toBe('event:actual/1');
    expect(() => BudgetReservationReconcileRequestSchema.parse({
      ...request,
      usageEvent: { ...request.usageEvent, rawProviderError: 'credential-bearing detail' },
    })).toThrow(ZodError);
    expect(() => BudgetReservationReconcileRequestSchema.parse({ ...request, debugDump: 'not part of the contract' })).toThrow(ZodError);
  });

  test('daily and monthly windows are exact UTC half-open intervals', () => {
    expect(resolveBudgetQuotaWindow('daily', new Date('2026-09-28T23:59:00Z'))).toStrictEqual({
      period: 'daily', from: '2026-09-28T00:00:00.000Z', to: '2026-09-29T00:00:00.000Z',
    });
    expect(resolveBudgetQuotaWindow('monthly', new Date('2026-12-31T23:59:00Z'))).toStrictEqual({
      period: 'monthly', from: '2026-12-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z',
    });
    expect(() => resolveBudgetQuotaWindow('daily', new Date(Number.NaN))).toThrow(/BUDGET_WINDOW_INVALID_DATE/);
  });

  test('reserved, running, and UNKNOWN count as held until reconcile or proven release', () => {
    expect(budgetReservationCountsAsHeld('RESERVED')).toBe(true);
    expect(budgetReservationCountsAsHeld('RUNNING')).toBe(true);
    expect(budgetReservationCountsAsHeld('UNKNOWN')).toBe(true);
    expect(budgetReservationCountsAsHeld('RECONCILED')).toBe(false);
    expect(budgetReservationCountsAsHeld('RELEASED')).toBe(false);
  });

  test('hard cap requires every reliability assertion, including bounded estimates', () => {
    const trusted = {
      durableAtomicStore: true,
      sharedQuotaScope: true,
      validatedUsageLedger: true,
      boundedReservation: true,
    };
    expect(isBudgetReservationTrusted(trusted)).toBe(true);
    expect(isBudgetReservationTrusted({ ...trusted, boundedReservation: false })).toBe(false);
    expect(isBudgetReservationTrusted({ ...trusted, validatedUsageLedger: false })).toBe(false);
  });
});
