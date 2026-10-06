import type { BudgetConfigInput, UsageSummary } from '@du/contracts';
import { HttpError } from '../src/http/errors';
import { validateBudgetEvaluation } from '../src/modules/usage/budget-evaluation-validator';

const TENANT = 'tenant-a';
const CONFIG: BudgetConfigInput = {
  tenantId: TENANT,
  period: 'daily',
  tokenThreshold: 100,
  usdThresholdMicroUsd: 10_000,
  alertThresholdPercent: 80,
  notificationChannels: ['ops-oncall'],
  policy: 'block-new-invocations',
  status: 'active',
};
const USAGE = {
  inputTokens: 80,
  outputTokens: 0,
  totalTokens: 80,
  totalCostMicrousd: 6_000,
  eventCount: 1,
};

function capturedError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('validateBudgetEvaluation', () => {
  it('validates active tenant configuration and returns a schema-checked warning', () => {
    const result = validateBudgetEvaluation({ tenantId: TENANT, budget: CONFIG, usage: USAGE });
    expect(result).toMatchObject({
      usagePercent: 80,
      warnThresholdExceeded: true,
      limitExceeded: false,
      action: 'WARN',
      remainingTokens: 20,
      remainingCostMicrousd: 4_000,
    });
  });

  it('includes an in-flight reservation before deciding whether a call is blocked', () => {
    const result = validateBudgetEvaluation({
      tenantId: TENANT,
      budget: CONFIG,
      usage: USAGE,
      inFlightReservation: {
        inputTokens: 20,
        outputTokens: 0,
        totalTokens: 20,
        totalCostMicrousd: 0,
        eventCount: 1,
      },
    });
    expect(result.limitExceeded).toBe(true);
    expect(result.remainingTokens).toBe(0);
    expect(result.action).toBe('BLOCK');
  });

  it('fails closed on tenant mismatch and unsupported narrower scopes', () => {
    const tenantError = capturedError(() =>
      validateBudgetEvaluation({ tenantId: 'tenant-b', budget: CONFIG, usage: USAGE }),
    );
    expect(tenantError).toBeInstanceOf(HttpError);
    expect(tenantError).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    const scopeError = capturedError(() =>
      validateBudgetEvaluation({
        tenantId: TENANT,
        budget: { ...CONFIG, apiKeyId: 'key-1' },
        usage: USAGE,
      }),
    );
    expect(scopeError).toBeInstanceOf(HttpError);
    expect(scopeError).toMatchObject({ status: 422, code: 'BUDGET_SCOPE_UNSUPPORTED' });
  });

  it('maps invalid contracts to a safe 422 and does not activate suspended budgets', () => {
    try {
      validateBudgetEvaluation({
        tenantId: TENANT,
        budget: { ...CONFIG, policy: 'BLOCK' } as unknown as BudgetConfigInput,
        usage: USAGE,
      });
      throw new Error('expected invalid config to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
      expect((error as HttpError).message).toBe('request validation failed');
    }

    const badUsage = capturedError(() =>
      validateBudgetEvaluation({
        tenantId: TENANT,
        budget: CONFIG,
        usage: { ...USAGE, totalTokens: 1 } as UsageSummary,
      }),
    );
    expect(badUsage).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    const badReservation = capturedError(() =>
      validateBudgetEvaluation({
        tenantId: TENANT,
        budget: CONFIG,
        usage: USAGE,
        inFlightReservation: { ...USAGE, totalCostMicrousd: 1.5 } as UsageSummary,
      }),
    );
    expect(badReservation).toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });

    const suspended = validateBudgetEvaluation({
      tenantId: TENANT,
      budget: { ...CONFIG, status: 'suspended' },
      usage: { ...USAGE, inputTokens: 100, totalTokens: 100 },
    });
    expect(suspended.limitExceeded).toBe(true);
    expect(suspended.action).toBe('ALLOW');
  });
});
