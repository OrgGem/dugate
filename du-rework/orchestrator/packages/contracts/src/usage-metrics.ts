import { z } from 'zod';

/**
 * COST-01 token & usage ledger contract (docs/admin-ops-monitoring-cost.md).
 *
 * ADDITIVE ONLY. The existing wire schemas — UsageEventSchema (runtime.ts),
 * InvocationUsageSchema (connector.ts), UsageSchema (operations.ts) — are
 * unchanged and remain authoritative for their transport paths. This module
 * adds the per-operation metrics view, a full-attribution ledger event, a
 * provider-wire adapter, and display-only USD formatting.
 *
 * Ledger rules honored here (Quy tắc số liệu và bảo mật):
 * - All money is a non-negative integer of micro-USD (costMicrousd). No float
 *   USD ever enters or leaves a ledger type; USD appears only as a 6-decimal
 *   display string derived by formatMicrousdAsUsd().
 * - 0 tokens is a measured zero. Missing usage is expressed by costStatus
 *   'pending' / 'unpriced' — and those statuses are schema-locked to
 *   costMicrousd = 0, so missing data can never masquerade as settled cost.
 * - Usage records carry token counts and sanitized IDs only. Prompt/content/
 *   secret text is structurally impossible: every schema is .strict() (unknown
 *   keys fail closed), ID-ish fields are allowlist-patterned (no free text),
 *   and the provider-wire adapter copies ONLY the allowlisted numeric fields.
 */

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

export const MICROUSD_PER_USD = 1_000_000;

/** Sanitized identifier shape for attribution fields: opaque IDs, provider
 * names, model slugs — never secrets or free text. */
export const USAGE_ATTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,127}$/;

const SafeIdSchema = z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN);
const TokenCountSchema = z.number().int().min(0);
const NonNegativeIntSchema = z.number().int().min(0);
/** RFC 3339 with optional numeric offset; UTC 'Z' always accepted. */
const TimestampSchema = z.string().datetime({ offset: true });

/** COST-03 display taxonomy: measured ≠ estimated ≠ pending ≠ unpriced. */
export const UsageCostStatus = ['measured', 'estimated', 'pending', 'unpriced'] as const;
export const UsageCostStatusSchema = z.enum(UsageCostStatus);
export type UsageCostStatus = z.infer<typeof UsageCostStatusSchema>;

/* ------------------------------------------------------------------ */
/* Per-operation usage metrics (view model)                            */
/* ------------------------------------------------------------------ */

const OperationUsageMetricsBaseSchema = z
  .object({
    operationId: z.string().uuid(),
    /** Provider-agnostic canonical pair; prompt_tokens/completion_tokens are
     * wire aliases resolved by metricsFromProviderUsage(), not stored names. */
    inputTokens: TokenCountSchema.default(0),
    outputTokens: TokenCountSchema.default(0),
    /** Subset of inputTokens served from provider cache (0 when unreported). */
    cachedInputTokens: TokenCountSchema.default(0),
    totalTokens: TokenCountSchema,
    /** Non-token billing units stay distinct from token counts (docs COST-01). */
    pages: NonNegativeIntSchema.optional(),
    costMicrousd: NonNegativeIntSchema.default(0),
    costStatus: UsageCostStatusSchema,
    durationMs: NonNegativeIntSchema,
  })
  .strict();

export const OperationUsageMetricsSchema = OperationUsageMetricsBaseSchema.superRefine(
  (metrics, ctx) => {
    if (metrics.totalTokens !== metrics.inputTokens + metrics.outputTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'TOKENS_TOTAL_MISMATCH' },
        message: 'totalTokens must equal inputTokens + outputTokens',
        path: ['totalTokens'],
      });
    }
    if (metrics.cachedInputTokens > metrics.inputTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'CACHED_EXCEEDS_INPUT' },
        message: 'cachedInputTokens is a subset of inputTokens',
        path: ['cachedInputTokens'],
      });
    }
    if ((metrics.costStatus === 'pending' || metrics.costStatus === 'unpriced') && metrics.costMicrousd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'UNSETTLED_COST_MUST_BE_ZERO' },
        message: 'pending/unpriced usage must not carry implied cost',
        path: ['costMicrousd'],
      });
    }
  },
);
export type OperationUsageMetrics = z.infer<typeof OperationUsageMetricsSchema>;

/* ------------------------------------------------------------------ */
/* Display-only USD view model                                         */
/* ------------------------------------------------------------------ */

/** Format micro-USD as a fixed 6-decimal USD string using integer arithmetic
 * only. Display path per docs rule "UI mới định dạng USD" — never sum these. */
export function formatMicrousdAsUsd(microUsd: number): string {
  if (!Number.isInteger(microUsd) || microUsd < 0) {
    throw new RangeError('micro-USD must be a non-negative integer');
  }
  const whole = Math.floor(microUsd / MICROUSD_PER_USD);
  const frac = String(microUsd % MICROUSD_PER_USD).padStart(6, '0');
  return `${whole}.${frac}`;
}

const OperationUsageMetricsViewBaseSchema = OperationUsageMetricsBaseSchema.extend({
  /** Derived presentation string (e.g. '0.004200'); authoritative value stays
   * in costMicrousd. */
  costEstimateUsd: z.string(),
  /** Only 'measured' is settled money; estimated/pending/unpriced are not. */
  costSettled: z.boolean(),
}).strict();

export const OperationUsageMetricsViewSchema = OperationUsageMetricsViewBaseSchema.superRefine(
  (view, ctx) => {
    if (view.costEstimateUsd !== formatMicrousdAsUsd(view.costMicrousd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'USD_DISPLAY_MISMATCH' },
        message: 'costEstimateUsd must equal formatMicrousdAsUsd(costMicrousd)',
        path: ['costEstimateUsd'],
      });
    }
    if (view.costSettled !== (view.costStatus === 'measured')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'SETTLED_FLAG_MISMATCH' },
        message: 'costSettled is true only for measured cost',
        path: ['costSettled'],
      });
    }
  },
);
export type OperationUsageMetricsView = z.infer<typeof OperationUsageMetricsViewSchema>;

export function toOperationUsageMetricsView(
  metrics: OperationUsageMetrics,
): OperationUsageMetricsView {
  return OperationUsageMetricsViewSchema.parse({
    ...metrics,
    costEstimateUsd: formatMicrousdAsUsd(metrics.costMicrousd),
    costSettled: metrics.costStatus === 'measured',
  });
}

/* ------------------------------------------------------------------ */
/* Provider-wire adapter (boundary for OpenAI-style usage objects)     */
/* ------------------------------------------------------------------ */

/** OpenAI-compatible usage chunk. passthrough tolerates provider extras — the
 * adapter copies ONLY the allowlisted numeric fields below, so echoed prompt
 * text, fingerprints, or any adversarial extra key cannot cross into the
 * ledger. Non-integer/unknown values fail closed. */
export const ProviderUsageWireSchema = z
  .object({
    prompt_tokens: TokenCountSchema.optional(),
    completion_tokens: TokenCountSchema.optional(),
    total_tokens: TokenCountSchema.optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: TokenCountSchema.optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ProviderUsageWire = z.infer<typeof ProviderUsageWireSchema>;

export function metricsFromProviderUsage(input: {
  operationId: string;
  /** Untrusted provider usage object; only the allowlisted numbers are read. */
  providerUsage: unknown;
  durationMs: number;
  costMicrousd?: number;
  costStatus: UsageCostStatus;
}): OperationUsageMetrics {
  const wire = ProviderUsageWireSchema.parse(input.providerUsage);
  const prompt = wire.prompt_tokens ?? 0;
  const completion = wire.completion_tokens ?? 0;
  const cached = wire.prompt_tokens_details?.cached_tokens ?? 0;
  const total = wire.total_tokens ?? prompt + completion;
  return OperationUsageMetricsSchema.parse({
    operationId: input.operationId,
    inputTokens: prompt,
    outputTokens: completion,
    cachedInputTokens: cached,
    totalTokens: total,
    costMicrousd: input.costMicrousd ?? 0,
    costStatus: input.costStatus,
    durationMs: input.durationMs,
  });
}

/* ------------------------------------------------------------------ */
/* Full-attribution ledger event (docs COST-01)                        */
/* ------------------------------------------------------------------ */

export const UsageLedgerUnitsSchema = z
  .object({
    inputTokens: TokenCountSchema.default(0),
    outputTokens: TokenCountSchema.default(0),
    cachedInputTokens: TokenCountSchema.optional(),
    pages: NonNegativeIntSchema.optional(),
  })
  .strict();
export type UsageLedgerUnits = z.infer<typeof UsageLedgerUnitsSchema>;

/** The billing-unit family represented by a ledger event's unit breakdown.
 * `mixed` is used when the provider reports both token and page quantities. */
export const UsageUnitType = ['tokens', 'pages', 'mixed'] as const;
export const UsageUnitTypeSchema = z.enum(UsageUnitType);
export type UsageUnitType = z.infer<typeof UsageUnitTypeSchema>;

/** Ledger write model. eventId is the dedup key (duplicate delivery counts
 * once); idempotencyKey identifies retries of the event-ingest request.
 * Corrections/refunds are NEW events linked via correctsEventId — the original
 * row is never rewritten (docs COST-01). */
export const UsageLedgerEventSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    /** Stable request key reused when delivery of this event is retried. */
    idempotencyKey: SafeIdSchema,
    kind: z.enum(['initial', 'correction', 'refund']).default('initial'),
    correctsEventId: z.string().min(1).max(128).optional(),
    tenantId: SafeIdSchema,
    /** API key identifier only — key material has no representation here. */
    apiKeyId: SafeIdSchema,
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    invocationId: SafeIdSchema,
    attempt: z.number().int().min(1),
    stepKey: SafeIdSchema,
    businessId: SafeIdSchema,
    businessVersion: SafeIdSchema,
    action: SafeIdSchema,
    profileRevision: NonNegativeIntSchema,
    connectorId: SafeIdSchema,
    connectorRevision: NonNegativeIntSchema,
    /** Provider/model actually used, snapshotted at invocation time (docs
     * COST-01: never re-derived from current config after a change). */
    provider: SafeIdSchema,
    model: SafeIdSchema,
    unitType: UsageUnitTypeSchema,
    units: UsageLedgerUnitsSchema,
    costMicrousd: NonNegativeIntSchema.default(0),
    currency: z.literal('USD').default('USD'),
    costStatus: UsageCostStatusSchema,
    durationMs: NonNegativeIntSchema,
    occurredAt: TimestampSchema,
    receivedAt: TimestampSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.kind === 'initial' && event.correctsEventId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'INITIAL_HAS_PARENT' },
        message: 'initial events must not reference a corrected event',
        path: ['correctsEventId'],
      });
    }
    if (event.kind !== 'initial' && event.correctsEventId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'CORRECTION_MISSING_PARENT' },
        message: 'correction/refund events must link the original eventId',
        path: ['correctsEventId'],
      });
    }
    if (event.correctsEventId !== undefined && event.correctsEventId === event.eventId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'SELF_CORRECTION' },
        message: 'an event cannot correct itself',
        path: ['correctsEventId'],
      });
    }
    if ((event.costStatus === 'pending' || event.costStatus === 'unpriced') && event.costMicrousd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'UNSETTLED_COST_MUST_BE_ZERO' },
        message: 'pending/unpriced usage must not carry implied cost',
        path: ['costMicrousd'],
      });
    }
    const hasTokenUnits =
      event.units.inputTokens > 0 ||
      event.units.outputTokens > 0 ||
      (event.units.cachedInputTokens ?? 0) > 0;
    const hasPageUnits = (event.units.pages ?? 0) > 0;
    if (hasTokenUnits || hasPageUnits) {
      const expectedUnitType: UsageUnitType =
        hasTokenUnits && hasPageUnits ? 'mixed' : hasPageUnits ? 'pages' : 'tokens';
      if (event.unitType !== expectedUnitType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          params: { rule: 'UNIT_TYPE_MISMATCH' },
          message: 'unitType must match the unit dimensions with reported quantities',
          path: ['unitType'],
        });
      }
    }
  });
export type UsageLedgerEvent = z.infer<typeof UsageLedgerEventSchema>;

/* ------------------------------------------------------------------ */
/* Logger-safe projection                                              */
/* ------------------------------------------------------------------ */

/**
 * Flatten metrics into scalar fields for structured logs.
 *
 * Hidden constraint: @du/observability's redaction applies SENSITIVE_KEY_PATTERN
 * to key NAMES by substring, and the bare 'token' alternative (meant for auth
 * tokens) would blank any key like 'inputTokens'/'totalTokens'. Keys here are
 * deliberately named so usage counters survive logger redaction. Values are
 * scalars only — this carries no prompt, URL, or name data (docs: secrets and
 * prompt text are never logged).
 */
export function usageMetricsLogFields(
  metrics: OperationUsageMetrics,
): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    operationId: metrics.operationId,
    unitsIn: metrics.inputTokens,
    unitsOut: metrics.outputTokens,
    unitsCached: metrics.cachedInputTokens,
    unitsTotal: metrics.totalTokens,
    microUsd: metrics.costMicrousd,
    costStatus: metrics.costStatus,
    durationMs: metrics.durationMs,
  };
  if (metrics.pages !== undefined) fields.pages = metrics.pages;
  return fields;
}
