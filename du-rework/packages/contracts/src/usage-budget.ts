import { z } from 'zod';
import { USAGE_ATTRIBUTION_ID_PATTERN } from './usage-metrics';
import { UsageSummarySchema, type UsageSummary } from './usage-reconciliation';

/**
 * COST-04 budget configuration + threshold evaluation (docs/admin-ops-monitoring-cost.md,
 * task COST-04 'Budget and alerts', acceptance flow 4).
 *
 * ADDITIVE ONLY. This module consumes UsageSummary (usage-reconciliation.ts)
 * as-is; nothing existing is modified. Persistence of budget rows, alert
 * dispatch, the reservation ledger itself, draft/review/publish CAS and
 * tenant/role authorization are service-layer concerns; what lives here is
 * the pure, deterministic policy core those layers call.
 *
 * Money law honored here: every limit and every summed quantity is a
 * non-negative integer (micro-USD for money). All comparisons, sums and
 * percentages run in BigInt, never in JS doubles; usagePercent is a
 * truncated integer percent computed by exact integer division
 * (total * 100 / limit), so no float artifact can shift ALLOW to WARN or
 * WARN to BLOCK at a boundary.
 *
 * Ledger rules honored here:
 * - The evaluated total is committed usage PLUS in-flight reservation.
 *   Docs COST-04: when blocking is on, the reservation taken before the
 *   provider call and the reconciliation after actual usage arrives share
 *   one quota scope; running/UNKNOWN invocations count in the reservation.
 *   Actual usage arriving late must release its reservation exactly once -
 *   that matching is persistence-side; this pure function only ever sees
 *   the (usage, reservation) pair the service resolved for it.
 * - Reaching a cap counts as breached (total >= limit). The reservation is
 *   held BEFORE the provider call, so a strict greater-than would still
 *   admit one more invocation on a budget that is already fully reserved.
 *   Pinned in tests; reversal is a decision, not a surprise (receipt
 *   delta D14).
 * - warnThresholdExceeded is an independent detection flag: the policy
 *   gates the ACTION, never the truth of the flag (receipt delta D17).
 * - This function never reads the clock. Which calendar day/month the
 *   totals cover is enforced by the caller through
 *   aggregateUsageEvents + UsageAggregateFilter [from,to), keeping the
 *   policy core pure and timezone-testable (receipt delta D19).
 */

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

/** Same allowlist pattern as ledger attribution IDs, with URI schemes refused
 * so tenant/scope/channel values stay opaque identifiers rather than URLs. */
const SafeIdSchema = z
  .string()
  .regex(USAGE_ATTRIBUTION_ID_PATTERN)
  .refine((value) => !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value), {
    message: 'budget identifiers must not contain a URI',
  });
/** Limits and results live as JS ints at the boundary and MUST stay within
 * the safe-integer range so every BigInt comparison and Number() cast is
 * exact end to end. */
const SafeNonNegativeIntSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/* ------------------------------------------------------------------ */
/* BudgetPeriod / BudgetPolicy / BudgetConfig                          */
/* ------------------------------------------------------------------ */

export const BudgetPeriodSchema = z.enum(['daily', 'monthly']);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

export const BudgetPolicySchema = z.enum(['alert-only', 'block-new-invocations']);
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const BudgetStatusSchema = z.enum(['active', 'suspended']);
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const BudgetConfigSchema = z
  .object({
    tenantId: SafeIdSchema,
    /** Optional narrower quota dimensions; resolution/filtering is service-side. */
    apiKeyId: SafeIdSchema.optional(),
    profileId: SafeIdSchema.optional(),
    businessId: SafeIdSchema.optional(),
    period: BudgetPeriodSchema,
    /** Positive safe integers; zero thresholds are refused to avoid accidental
     * block-all configurations and divide-by-zero percentage calculations. */
    tokenThreshold: SafeNonNegativeIntSchema.refine((value) => value >= 1, {
      params: { rule: 'LIMIT_BELOW_ONE' },
      message: 'tokenThreshold must be at least 1',
      path: ['tokenThreshold'],
    }),
    usdThresholdMicroUsd: SafeNonNegativeIntSchema.refine((value) => value >= 1, {
      params: { rule: 'LIMIT_BELOW_ONE' },
      message: 'usdThresholdMicroUsd must be at least 1',
      path: ['usdThresholdMicroUsd'],
    }),
    /** Percent band is explicit so every published config has a reviewable threshold. */
    alertThresholdPercent: z.number().int().min(1).max(100),
    policy: BudgetPolicySchema,
    /** Opaque non-secret channel ids; resolution to real destinations is
     * service-side. Thunk default keeps every parsed row on a fresh array. */
    notificationChannels: z.array(SafeIdSchema).max(20).default(() => []),
    status: BudgetStatusSchema,
  })
  .strict();
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
/** Pre-parse caller shape: notificationChannels carries a default. */
export type BudgetConfigInput = z.input<typeof BudgetConfigSchema>;

/* ------------------------------------------------------------------ */
/* Quota scope, window and reservation lifecycle (COST-04)             */
/* ------------------------------------------------------------------ */

/** A canonical quota scope shared by both admission and reconciliation.
 * Omitted dimensions are wildcards; both paths derive this exact shape from
 * the published budget, never independently from mutable runtime config. */
export const BudgetQuotaScopeSchema = z
  .object({
    tenantId: SafeIdSchema,
    apiKeyId: SafeIdSchema.optional(),
    profileId: SafeIdSchema.optional(),
    businessId: SafeIdSchema.optional(),
  })
  .strict();
export type BudgetQuotaScope = z.infer<typeof BudgetQuotaScopeSchema>;

/** Project a budget into the scope key used for every reservation and actual
 * usage query. Property order is fixed so the serialized key is stable. */
export function quotaScopeForBudget(budget: BudgetConfigInput): BudgetQuotaScope {
  const config = BudgetConfigSchema.parse(budget);
  return BudgetQuotaScopeSchema.parse({
    tenantId: config.tenantId,
    ...(config.apiKeyId !== undefined ? { apiKeyId: config.apiKeyId } : {}),
    ...(config.profileId !== undefined ? { profileId: config.profileId } : {}),
    ...(config.businessId !== undefined ? { businessId: config.businessId } : {}),
  });
}

/** Collision-free deterministic representation for a normalized scope. */
export function budgetQuotaScopeKey(scopeInput: BudgetQuotaScope): string {
  const scope = BudgetQuotaScopeSchema.parse(scopeInput);
  return JSON.stringify([
    scope.tenantId,
    scope.apiKeyId ?? null,
    scope.profileId ?? null,
    scope.businessId ?? null,
  ]);
}

const BudgetTimestampSchema = z.string().datetime({ offset: true });
export const BudgetQuotaWindowSchema = z
  .object({
    period: BudgetPeriodSchema,
    from: BudgetTimestampSchema,
    to: BudgetTimestampSchema,
  })
  .strict()
  .superRefine((window, ctx) => {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (!(to > from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_WINDOW_ORDER' },
        message: 'budget window must be a non-empty half-open interval',
        path: ['to'],
      });
    }
    const start = new Date(from);
    const aligned = window.period === 'daily'
      ? start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0 && start.getUTCMilliseconds() === 0
      : start.getUTCDate() === 1 && start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0 && start.getUTCMilliseconds() === 0;
    if (Number.isFinite(from) && !aligned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_WINDOW_ALIGNMENT' },
        message: 'budget windows must start at the UTC day or month boundary',
        path: ['from'],
      });
    }
    if (Number.isFinite(from)) {
      const expectedTo = window.period === 'daily'
        ? from + 24 * 60 * 60 * 1000
        : Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
      if (to !== expectedTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          params: { rule: 'BUDGET_WINDOW_SPAN' },
          message: 'budget window must span exactly one UTC day or month',
          path: ['to'],
        });
      }
    }
  });
export type BudgetQuotaWindow = z.infer<typeof BudgetQuotaWindowSchema>;

/** Resolve daily/monthly windows in UTC so every replica and late usage event
 * lands in the same half-open quota interval. */
export function resolveBudgetQuotaWindow(period: BudgetPeriod, at: Date = new Date()): BudgetQuotaWindow {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new RangeError('BUDGET_WINDOW_INVALID_DATE: expected a valid Date');
  }
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const from = period === 'daily'
    ? new Date(Date.UTC(year, month, at.getUTCDate()))
    : new Date(Date.UTC(year, month, 1));
  const to = period === 'daily'
    ? new Date(from.getTime() + 24 * 60 * 60 * 1000)
    : new Date(Date.UTC(year, month + 1, 1));
  return BudgetQuotaWindowSchema.parse({ period, from: from.toISOString(), to: to.toISOString() });
}

export const BudgetReservationStatusSchema = z.enum([
  'RESERVED',
  'RUNNING',
  'UNKNOWN',
  'RECONCILED',
  'RELEASED',
  'BLOCKED',
]);
export type BudgetReservationStatus = z.infer<typeof BudgetReservationStatusSchema>;

/** A reservation is held while the provider may still be running or its
 * outcome is unknown. It is removed from held totals only after reconciliation
 * or a proof that no provider call was sent. */
export function budgetReservationCountsAsHeld(status: BudgetReservationStatus): boolean {
  return status === 'RESERVED' || status === 'RUNNING' || status === 'UNKNOWN';
}

export const BudgetReservationConfidenceSchema = z.enum(['upper-bound', 'best-effort']);
export type BudgetReservationConfidence = z.infer<typeof BudgetReservationConfidenceSchema>;

const BudgetReservationAmountSchema = z
  .object({
    tokens: SafeNonNegativeIntSchema,
    costMicroUsd: SafeNonNegativeIntSchema,
  })
  .strict()
  .refine((amount) => amount.tokens > 0 || amount.costMicroUsd > 0, {
    message: 'a reservation must hold at least one non-zero quota dimension',
  });

/** Pre-call command. The caller must not invoke a provider until the durable
 * service returns ADMITTED; upper-bound confidence is required for a hard
 * cap because an unbounded estimate cannot safely protect a quota. */
export const BudgetReservationRequestSchema = z
  .object({
    budget: BudgetConfigSchema,
    quotaScope: BudgetQuotaScopeSchema,
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    invocationId: SafeIdSchema,
    attempt: z.number().int().min(1),
    idempotencyKey: SafeIdSchema,
    reserve: BudgetReservationAmountSchema,
    confidence: BudgetReservationConfidenceSchema,
  })
  .strict()
  .superRefine((request, ctx) => {
    const expected = quotaScopeForBudget(request.budget);
    if (budgetQuotaScopeKey(request.quotaScope) !== budgetQuotaScopeKey(expected)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_RESERVATION_SCOPE_MISMATCH' },
        message: 'reservation quota scope must exactly match the budget scope',
        path: ['quotaScope'],
      });
    }
  });
export type BudgetReservationRequest = z.infer<typeof BudgetReservationRequestSchema>;

/** Proof inputs required before the policy may make a hard-cap decision. */
export const BudgetReservationTrustSchema = z
  .object({
    durableAtomicStore: z.boolean(),
    sharedQuotaScope: z.boolean(),
    validatedUsageLedger: z.boolean(),
    boundedReservation: z.boolean(),
  })
  .strict();
export type BudgetReservationTrust = z.infer<typeof BudgetReservationTrustSchema>;

export function isBudgetReservationTrusted(input: BudgetReservationTrust): boolean {
  const trust = BudgetReservationTrustSchema.parse(input);
  return trust.durableAtomicStore && trust.sharedQuotaScope && trust.validatedUsageLedger && trust.boundedReservation;
}

/** Reconciliation command binds actual usage back to the same invocation and
 * scope that created the hold. The event itself is separately validated by
 * UsageEventSchema at the Orchestrator persistence boundary. */
export const BudgetReservationReconcileSchema = z
  .object({
    reservationId: z.string().uuid(),
    quotaScope: BudgetQuotaScopeSchema,
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    invocationId: SafeIdSchema,
    attempt: z.number().int().min(1),
    eventId: SafeIdSchema,
    actual: z
      .object({
        tokens: SafeNonNegativeIntSchema,
        costMicroUsd: SafeNonNegativeIntSchema,
      })
      .strict(),
  })
  .strict();
export type BudgetReservationReconcile = z.infer<typeof BudgetReservationReconcileSchema>;

export const BudgetReservationTransitionSchema = z
  .object({
    reservationId: z.string().uuid(),
    quotaScope: BudgetQuotaScopeSchema,
    target: z.enum(['RUNNING', 'UNKNOWN', 'RELEASED']),
    confirmedNotSent: z.literal(true).optional(),
  })
  .strict()
  .superRefine((transition, ctx) => {
    if (transition.target === 'RELEASED' && transition.confirmedNotSent !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_RELEASE_REQUIRES_NO_CALL_PROOF' },
        message: 'a reservation can be released only with confirmation that no provider call was sent',
        path: ['confirmedNotSent'],
      });
    }
    if (transition.target !== 'RELEASED' && transition.confirmedNotSent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_RELEASE_PROOF_NOT_APPLICABLE' },
        message: 'provider-call release confirmation applies only to release transitions',
        path: ['confirmedNotSent'],
      });
    }
  });
export type BudgetReservationTransition = z.infer<typeof BudgetReservationTransitionSchema>;

export const BudgetReservationSchema = z
  .object({
    reservationId: z.string().uuid(),
    idempotencyKey: SafeIdSchema,
    quotaScope: BudgetQuotaScopeSchema,
    window: BudgetQuotaWindowSchema,
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    invocationId: SafeIdSchema,
    attempt: z.number().int().min(1),
    reserve: BudgetReservationAmountSchema,
    confidence: BudgetReservationConfidenceSchema,
    status: BudgetReservationStatusSchema,
    usageEventId: SafeIdSchema.optional(),
    createdAt: BudgetTimestampSchema,
    updatedAt: BudgetTimestampSchema,
  })
  .strict()
  .superRefine((reservation, ctx) => {
    if (reservation.status === 'RECONCILED' && reservation.usageEventId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_RESERVATION_MISSING_RECONCILIATION' },
        message: 'a reconciled reservation must point to its actual usage event',
        path: ['usageEventId'],
      });
    }
    if (reservation.status !== 'RECONCILED' && reservation.usageEventId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_RESERVATION_EARLY_RECONCILIATION' },
        message: 'only a reconciled reservation may point to an actual usage event',
        path: ['usageEventId'],
      });
    }
  });
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

/* ------------------------------------------------------------------ */
/* Evaluation result                                                   */
/* ------------------------------------------------------------------ */

export const BudgetActionSchema = z.enum(['ALLOW', 'WARN', 'BLOCK']);
export type BudgetAction = z.infer<typeof BudgetActionSchema>;

const BudgetEvaluationBaseSchema = z
  .object({
    /** max(floor(tokenTotal*100/tokenThreshold), floor(costTotal*100/usdThresholdMicroUsd))
     * as an exact truncated integer percent (delta D15). >= 100 is exactly
     * when limitExceeded is true; unbounded above beyond 100 is reported
     * honestly, overflow of the safe-int range raises RangeError. */
    usagePercent: SafeNonNegativeIntSchema,
    warnThresholdExceeded: z.boolean(),
    limitExceeded: z.boolean(),
    action: BudgetActionSchema,
    /** Cap minus (usage + reservation), clamped to 0 once that dimension is
     * breached; below the cap the value is exact BigInt arithmetic. */
    remainingTokens: SafeNonNegativeIntSchema,
    remainingCostMicrousd: SafeNonNegativeIntSchema,
  })
  .strict();

export const BudgetEvaluationSchema = BudgetEvaluationBaseSchema.superRefine((evaluation, ctx) => {
  if (evaluation.limitExceeded !== (evaluation.usagePercent >= 100)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'EVAL_CAP_FLAG_MISMATCH' },
      message: 'limitExceeded is true exactly when usagePercent reaches 100',
      path: ['limitExceeded'],
    });
  }
  if (!evaluation.limitExceeded && (evaluation.remainingTokens === 0 || evaluation.remainingCostMicrousd === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'EVAL_REMAINING_MISMATCH' },
      message: 'below the cap both dimensions must still report remaining budget',
      path: ['remainingTokens'],
    });
  }
});
export type BudgetEvaluation = z.infer<typeof BudgetEvaluationSchema>;

export const BudgetReservationAdmissionSchema = z
  .object({
    decision: z.enum(['ADMITTED', 'BLOCKED']),
    hardCapEnabled: z.boolean(),
    evaluation: BudgetEvaluationSchema,
    reservation: BudgetReservationSchema,
  })
  .strict()
  .superRefine((admission, ctx) => {
    if ((admission.decision === 'BLOCKED') !== (admission.reservation.status === 'BLOCKED')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BUDGET_ADMISSION_STATUS_MISMATCH' },
        message: 'blocked admission must persist a BLOCKED reservation result',
        path: ['reservation', 'status'],
      });
    }
  });
export type BudgetReservationAdmission = z.infer<typeof BudgetReservationAdmissionSchema>;

/* ------------------------------------------------------------------ */
/* evaluateBudgetStatus                                                */
/* ------------------------------------------------------------------ */

function breachPercent(total: bigint, limit: bigint): bigint {
  // Schemas guarantee limit >= 1, so this division can never hit 0n.
  return (total * 100n) / limit;
}

function assertDimensionSafe(total: bigint, dimension: string): void {
  if (total > MAX_SAFE_BIG) {
    throw new RangeError(
      'USAGE_BUDGET_OVERFLOW: ' +
        dimension +
        ' total (usage + reservation) exceeds Number.MAX_SAFE_INTEGER; refusing to evaluate against an inexact double',
    );
  }
}

/**
 * Pure admission-control view over an active budget: config + committed usage
 * (+ optional in-flight reservation) -> ALLOW/WARN/BLOCK with an exact
 * integer percent and exact remaining budget per dimension.
 *
 * All three inputs are RE-PARSED through their schemas before any
 * arithmetic (same fail-closed pattern as aggregateUsageEvents), so
 * untrusted payloads cannot smuggle fractional money, extra dimensions,
 * missing counters, or limit shapes that would silently corrupt the
 * BigInt comparisons below.
 */
export function evaluateBudgetStatus(
  budget: BudgetConfigInput,
  currentUsage: UsageSummary,
  inFlightReservation?: UsageSummary,
): BudgetEvaluation {
  const config = BudgetConfigSchema.parse(budget);
  const usage = UsageSummarySchema.parse(currentUsage);
  const reserved =
    inFlightReservation === undefined
      ? { totalTokens: 0, totalCostMicrousd: 0 }
      : UsageSummarySchema.parse(inFlightReservation);

  const tokenTotal = BigInt(usage.totalTokens) + BigInt(reserved.totalTokens);
  const costTotal = BigInt(usage.totalCostMicrousd) + BigInt(reserved.totalCostMicrousd);
  assertDimensionSafe(tokenTotal, 'totalTokens');
  assertDimensionSafe(costTotal, 'totalCostMicrousd');

  const tokenLimit = BigInt(config.tokenThreshold);
  const costLimit = BigInt(config.usdThresholdMicroUsd);
  // Reaching the cap counts as breached (module header, delta D14).
  const tokenBreached = tokenTotal >= tokenLimit;
  const costBreached = costTotal >= costLimit;
  const limitExceeded = tokenBreached || costBreached;

  const tokenPercent = breachPercent(tokenTotal, tokenLimit);
  const costPercent = breachPercent(costTotal, costLimit);
  const percentBig = tokenPercent >= costPercent ? tokenPercent : costPercent;
  if (percentBig > MAX_SAFE_BIG) {
    throw new RangeError(
      'USAGE_BUDGET_OVERFLOW: usagePercent exceeds Number.MAX_SAFE_INTEGER (limits far below totals); refusing to truncate to an inexact double',
    );
  }
  const usagePercent = Number(percentBig);
  // floor(x) >= k for integer k is equivalent to x >= k, so the max of the
  // two truncated percents answers the threshold exactly as "any dimension
  // crossed it" would (delta D15).
  const warnThresholdExceeded = percentBig >= BigInt(config.alertThresholdPercent);

  let action: BudgetAction = 'ALLOW';
  if (config.status === 'active') {
    if (limitExceeded) {
      action = config.policy === 'block-new-invocations' ? 'BLOCK' : 'WARN';
    } else if (warnThresholdExceeded) {
      action = 'WARN';
    }
  }

  return BudgetEvaluationSchema.parse({
    usagePercent,
    warnThresholdExceeded,
    limitExceeded,
    action,
    remainingTokens: tokenBreached ? 0 : Number(tokenLimit - tokenTotal),
    remainingCostMicrousd: costBreached ? 0 : Number(costLimit - costTotal),
  });
}
