import { z } from 'zod';
import {
  USAGE_ATTRIBUTION_ID_PATTERN,
  UsageLedgerEventSchema,
  type UsageLedgerEvent,
  type UsageCostStatus,
} from './usage-metrics';

/**
 * COST-03 usage reconciliation aggregator (docs/admin-ops-monitoring-cost.md,
 * task COST-03, docs rules 'Quy tac so lieu va bao mat' items on micro-USD
 * integers and duplicate-event accounting).
 *
 * ADDITIVE ONLY. This module consumes UsageLedgerEvent (usage-metrics.ts) as
 * is; nothing existing is modified.
 *
 * Money law honored here: every summed value is a non-negative integer
 * (micro-USD for cost, plain counts elsewhere) accumulated in BigInt; JS
 * doubles never sit in an addition path. Totals are capped at
 * Number.MAX_SAFE_INTEGER and overflow raises RangeError instead of silently
 * truncating to an inexact double.
 *
 * Ledger rules honored here:
 * - Duplicate delivery of the same eventId counts exactly once (docs COST-01
 *   'Event trung chi tinh mot lan'). Two events sharing an eventId with
 *   DIVERGENT content are ledger corruption, not a duplicate: the aggregator
 *   fails closed with UsageReconciliationConflictError.
 * - The effective filter window is half-open [from, to) and both bounds and
 *   event timestamps are compared as instants (Date.parse), so 'Z' and
 *   '+07:00' spellings interleave correctly (same rule as pricing windows).
 * - Which ledger timestamp answers the window is a PUBLISHED rule (docs
 *   COST-03: time rule occurredAt vs receivedAt must be announced):
 *   timeField defaults to 'occurredAt' and callers may switch to
 *   'receivedAt'; there is no silent mixed mode.
 *
 * Group dimensions are an allowlisted hierarchy. Each bucket computes its
 * own distinct operation/invocation/attempt counts; additive values (events,
 * tokens and micro-USD) reconcile across buckets. Distinct counts are not
 * added across buckets because one operation can legitimately use more than
 * one API key, profile, or provider/model. Correction/refund NETTING
 * semantics (supersede vs additive) are not decided by the ledger contract
 * and are deliberately NOT applied here: all unique events are summed
 * additively, pending coordinator adjudication.
 */

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

const SafeIdSchema = z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN);
/** RFC 3339 with optional numeric offset; UTC 'Z' always accepted. */
const TimestampSchema = z.string().datetime({ offset: true });
/** Counters live as JS ints at the boundary but MUST stay within the
 * safe-integer range so every downstream display/persistence step is exact. */
const SafeNonNegativeIntSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/* ------------------------------------------------------------------ */
/* UsageAggregateFilter                                                */
/* ------------------------------------------------------------------ */

/** Which immutable ledger timestamp the [from, to) window filters on. */
export const UsageAggregateTimeFieldSchema = z.enum(['occurredAt', 'receivedAt']);
export type UsageAggregateTimeField = z.infer<typeof UsageAggregateTimeFieldSchema>;

const UsageAggregateFilterBaseSchema = z
  .object({
    tenantId: SafeIdSchema.optional(),
    businessId: SafeIdSchema.optional(),
    operationId: z.string().uuid().optional(),
    /** Inclusive lower bound (instant comparison). */
    from: TimestampSchema.optional(),
    /** Exclusive upper bound: half-open [from, to), same convention as
     * pricing effective windows and ledger retention windows. */
    to: TimestampSchema.optional(),
    /** Published time rule (docs COST-03). Defaults to the immutable
     * occurredAt (invocation time); 'receivedAt' exposes ingest-lag views. */
    timeField: UsageAggregateTimeFieldSchema.default('occurredAt'),
  })
  .strict();

export const UsageAggregateFilterSchema = UsageAggregateFilterBaseSchema.superRefine(
  (filter, ctx) => {
    if (filter.from !== undefined && filter.to !== undefined) {
      const start = Date.parse(filter.from);
      const end = Date.parse(filter.to);
      if (!(end > start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          params: { rule: 'WINDOW_ORDER' },
          message: 'to must be strictly after from (half-open [from,to) needs a non-empty span)',
          path: ['to'],
        });
      }
    }
  },
);
export type UsageAggregateFilter = z.infer<typeof UsageAggregateFilterSchema>;
/** Pre-parse caller shape: timeField carries a default, so it is optional. */
export type UsageAggregateFilterInput = z.input<typeof UsageAggregateFilterSchema>;

/* ------------------------------------------------------------------ */
/* Paginated usage event drill-down / export                           */
/* ------------------------------------------------------------------ */

/**
 * A bounded event query used when a user drills into an aggregate group or
 * exports its underlying ledger rows. The authorized tenant is always taken
 * from the caller's principal; tenantId is only an optional consistency check
 * for cross-tenant admin routes. Unknown query fields fail closed so content,
 * credentials, or arbitrary SQL filters cannot enter this boundary.
 */
export const UsageEventDrilldownQuerySchema = z.object({
  tenantId: SafeIdSchema.optional(),
  apiKeyId: SafeIdSchema.optional(),
  businessId: SafeIdSchema.optional(),
  action: SafeIdSchema.optional(),
  profileRevision: SafeNonNegativeIntSchema.optional(),
  provider: SafeIdSchema.optional(),
  model: SafeIdSchema.optional(),
  operationId: z.string().uuid().optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  timeField: UsageAggregateTimeFieldSchema.default('occurredAt'),
  /** Page size is deliberately bounded for UI and export consumers. */
  limit: z.number().int().min(1).max(100).default(50),
  /** Opaque URL-safe keyset cursor; its contents are validated server-side. */
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().superRefine((query, ctx) => {
  if (query.from !== undefined && query.to !== undefined && Date.parse(query.to) <= Date.parse(query.from)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'WINDOW_ORDER' },
      message: 'to must be strictly after from (half-open [from,to) needs a non-empty span)',
      path: ['to'],
    });
  }
  if ((query.businessId === undefined) !== (query.action === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'INCOMPLETE_BUSINESS_ACTION_FILTER' },
      message: 'businessId and action must be supplied together for a business/action group',
      path: [query.businessId === undefined ? 'businessId' : 'action'],
    });
  }
  if ((query.provider === undefined) !== (query.model === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'INCOMPLETE_PROVIDER_MODEL_FILTER' },
      message: 'provider and model must be supplied together',
      path: [query.provider === undefined ? 'provider' : 'model'],
    });
  }
});
export type UsageEventDrilldownQuery = z.infer<typeof UsageEventDrilldownQuerySchema>;
export type UsageEventDrilldownQueryInput = z.input<typeof UsageEventDrilldownQuerySchema>;

/** Cursor payload shape exported for validation and adapter conformance tests. */
export const UsageEventDrilldownCursorSchema = z.object({
  version: z.literal(1),
  tenantId: SafeIdSchema,
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  after: TimestampSchema,
  eventId: z.string().min(1).max(128),
}).strict();
export type UsageEventDrilldownCursor = z.infer<typeof UsageEventDrilldownCursorSchema>;

/**
 * Export records use the strict ledger allowlist above: prompts, documents,
 * credentials, URLs, and upstream error bodies have no representation.
 */
export const UsageEventExportRecordSchema = UsageLedgerEventSchema;
export type UsageEventExportRecord = z.infer<typeof UsageEventExportRecordSchema>;

/** One bounded page, usable by both drill-down UI and streamed export clients. */
export const UsageEventExportPageSchema = z.object({
  tenantId: SafeIdSchema,
  events: z.array(UsageEventExportRecordSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  skippedInvalidEvents: SafeNonNegativeIntSchema,
  timeSemantics: z.object({
    field: UsageAggregateTimeFieldSchema,
    order: z.literal('asc'),
    timezone: z.literal('UTC'),
  }).strict(),
}).strict().superRefine((page, ctx) => {
  if (page.hasMore !== (page.nextCursor !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'USAGE_PAGE_CURSOR_MISMATCH' },
      message: 'nextCursor must be present exactly when hasMore is true',
      path: ['nextCursor'],
    });
  }
  if (page.events.length > page.limit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'USAGE_PAGE_LIMIT_EXCEEDED' },
      message: 'events cannot exceed the requested page limit',
      path: ['events'],
    });
  }
});
export type UsageEventExportPage = z.infer<typeof UsageEventExportPageSchema>;

/* ------------------------------------------------------------------ */
/* Grouping and aggregation result                                     */
/* ------------------------------------------------------------------ */

/** Supported group-by levels, in the documented drill-down order. */
export const UsageAggregateDimension = [
  'tenant',
  'apiKey',
  'businessAction',
  'profile',
  'providerModel',
] as const;
export const UsageAggregateDimensionSchema = z.enum(UsageAggregateDimension);
export type UsageAggregateDimension = z.infer<typeof UsageAggregateDimensionSchema>;

const DEFAULT_GROUP_BY = [...UsageAggregateDimension] as UsageAggregateDimension[];

export const UsageAggregateGroupBySchema = z
  .array(UsageAggregateDimensionSchema)
  .min(1)
  .max(UsageAggregateDimension.length)
  .refine((dimensions) => new Set(dimensions).size === dimensions.length, {
    message: 'groupBy dimensions must be unique',
  })
  .refine((dimensions) => dimensions.every((value, index) => {
    if (index === 0) return true;
    return UsageAggregateDimension.indexOf(dimensions[index - 1]!) < UsageAggregateDimension.indexOf(value);
  }), { message: 'groupBy dimensions must follow the documented hierarchy' });
export type UsageAggregateGroupBy = z.infer<typeof UsageAggregateGroupBySchema>;

/** The selected attribution keys for one group. Pair dimensions remain pairs
 * so consumers cannot accidentally split business/action or provider/model. */
export const UsageAggregateDimensionsSchema = z
  .object({
    tenantId: SafeIdSchema.optional(),
    apiKeyId: SafeIdSchema.optional(),
    businessId: SafeIdSchema.optional(),
    action: SafeIdSchema.optional(),
    profileRevision: SafeNonNegativeIntSchema.optional(),
    provider: SafeIdSchema.optional(),
    model: SafeIdSchema.optional(),
  })
  .strict();
export type UsageAggregateDimensions = z.infer<typeof UsageAggregateDimensionsSchema>;

const UsageAggregateStatusMetricsBaseSchema = z
  .object({
    eventCount: SafeNonNegativeIntSchema,
    uniqueOperations: SafeNonNegativeIntSchema,
    invocations: SafeNonNegativeIntSchema,
    attempts: SafeNonNegativeIntSchema,
    inputTokens: SafeNonNegativeIntSchema,
    outputTokens: SafeNonNegativeIntSchema,
    totalTokens: SafeNonNegativeIntSchema,
    costMicrousd: SafeNonNegativeIntSchema,
  })
  .strict();

export const UsageAggregateStatusMetricsSchema = UsageAggregateStatusMetricsBaseSchema.superRefine((metrics, ctx) => {
    if (
      !Number.isSafeInteger(metrics.inputTokens) ||
      !Number.isSafeInteger(metrics.outputTokens) ||
      !Number.isSafeInteger(metrics.totalTokens)
    ) return;
    if (BigInt(metrics.inputTokens) + BigInt(metrics.outputTokens) !== BigInt(metrics.totalTokens)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'TOKENS_TOTAL_MISMATCH' },
        message: 'totalTokens must equal inputTokens + outputTokens',
        path: ['totalTokens'],
      });
    }
  });
export type UsageAggregateStatusMetrics = z.infer<typeof UsageAggregateStatusMetricsSchema>;

const UsageCostBreakdownSchema = z.object({
  measured: UsageAggregateStatusMetricsSchema,
  estimated: UsageAggregateStatusMetricsSchema,
  pending: UsageAggregateStatusMetricsSchema,
  unpriced: UsageAggregateStatusMetricsSchema,
}).strict();
export type UsageCostBreakdown = z.infer<typeof UsageCostBreakdownSchema>;

export const UsageAggregateMetricsSchema = UsageAggregateStatusMetricsBaseSchema.extend({
  breakdown: UsageCostBreakdownSchema,
}).strict().superRefine((metrics, ctx) => {
  if (metrics.breakdown === undefined || metrics.breakdown === null || typeof metrics.breakdown !== 'object') return;
  const statuses = Object.values(metrics.breakdown);
  const numericFields = [
    'eventCount', 'uniqueOperations', 'invocations', 'attempts',
    'inputTokens', 'outputTokens', 'totalTokens', 'costMicrousd',
  ] as const;
  if (numericFields.some((field) => !Number.isSafeInteger(metrics[field])) ||
    statuses.some((status) => status === null || typeof status !== 'object' ||
      numericFields.some((field) => !Number.isSafeInteger(status[field])))) return;
  const equalFields = [
    'eventCount', 'inputTokens', 'outputTokens', 'totalTokens', 'costMicrousd',
  ] as const;
  for (const field of equalFields) {
    const sum = statuses.reduce((total, status) => total + BigInt(status[field]), 0n);
    if (sum !== BigInt(metrics[field])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'BREAKDOWN_TOTAL_MISMATCH', field },
        message: `status breakdown ${field} must equal the aggregate ${field}`,
        path: ['breakdown'],
      });
    }
  }
  for (const [status, values] of Object.entries(metrics.breakdown)) {
    if ((status === 'pending' || status === 'unpriced') && values.costMicrousd !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'UNSETTLED_COST_MUST_BE_ZERO' },
        message: `${status} usage must not carry implied cost`,
        path: ['breakdown', status, 'costMicrousd'],
      });
    }
  }
});
export type UsageAggregateMetrics = z.infer<typeof UsageAggregateMetricsSchema>;

export const UsageAggregateGroupSchema = z.object({
  dimensions: UsageAggregateDimensionsSchema,
  metrics: UsageAggregateMetricsSchema,
}).strict().superRefine((group, ctx) => {
  // Pair dimensions are all-or-nothing; the selected groupBy levels are
  // checked by UsageAggregationSchema below.
  for (const [left, right] of [['businessId', 'action'], ['provider', 'model']] as const) {
    if ((group.dimensions[left] === undefined) !== (group.dimensions[right] === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'INCOMPLETE_GROUP_DIMENSION' },
        message: `${left} and ${right} must be present together`,
        path: ['dimensions', left],
      });
    }
  }
});
export type UsageAggregateGroup = z.infer<typeof UsageAggregateGroupSchema>;

export const UsageAggregationSchema = z.object({
  filter: UsageAggregateFilterSchema,
  groupBy: UsageAggregateGroupBySchema,
  /** Timestamp comparison is by instant; rendering and bucket boundaries use UTC. */
  timeSemantics: z.object({
    field: UsageAggregateTimeFieldSchema,
    interval: z.literal('[from,to)'),
    timezone: z.literal('UTC'),
  }).strict(),
  totals: UsageAggregateMetricsSchema,
  groups: z.array(UsageAggregateGroupSchema),
}).strict().superRefine((aggregation, ctx) => {
  if (!Array.isArray(aggregation.groupBy) || !Array.isArray(aggregation.groups)) return;
  if (aggregation.filter !== undefined && aggregation.filter !== null &&
    aggregation.timeSemantics !== undefined && aggregation.timeSemantics !== null &&
    aggregation.filter.timeField !== aggregation.timeSemantics.field) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'TIME_FIELD_MISMATCH' },
      message: 'timeSemantics.field must match filter.timeField',
      path: ['timeSemantics', 'field'],
    });
  }
  const expectedFields = new Set<string>();
  for (const dimension of aggregation.groupBy) {
    if (dimension === 'tenant') expectedFields.add('tenantId');
    if (dimension === 'apiKey') expectedFields.add('apiKeyId');
    if (dimension === 'businessAction') {
      expectedFields.add('businessId');
      expectedFields.add('action');
    }
    if (dimension === 'profile') expectedFields.add('profileRevision');
    if (dimension === 'providerModel') {
      expectedFields.add('provider');
      expectedFields.add('model');
    }
  }
  const keys = new Set<string>();
  for (const [index, group] of aggregation.groups.entries()) {
    if (group === undefined || group === null || group.dimensions === undefined ||
      group.dimensions === null || typeof group.dimensions !== 'object') continue;
    const actualFields = Object.keys(group.dimensions);
    if (actualFields.some((field) => !expectedFields.has(field)) ||
      [...expectedFields].some((field) => !actualFields.includes(field))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'GROUP_DIMENSIONS_MISMATCH' },
        message: 'group dimensions must match the requested groupBy levels',
        path: ['groups', index, 'dimensions'],
      });
    }
    const key = JSON.stringify(group.dimensions);
    if (keys.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'DUPLICATE_USAGE_GROUP' },
        message: 'group dimensions must be unique',
        path: ['groups', index, 'dimensions'],
      });
    }
    keys.add(key);
  }
  // Additive values must reconcile exactly. Distinct counts are bucket-local
  // and intentionally are not summed here (an operation may span buckets).
  const additiveFields = ['eventCount', 'inputTokens', 'outputTokens', 'totalTokens', 'costMicrousd'] as const;
  if (aggregation.totals === undefined || aggregation.totals === null ||
    additiveFields.some((field) => !Number.isSafeInteger(aggregation.totals[field])) ||
    aggregation.groups.some((group) => group === undefined || group === null || group.metrics === undefined || group.metrics === null ||
      additiveFields.some((field) => !Number.isSafeInteger(group.metrics[field])))) return;
  for (const field of additiveFields) {
    const sum = aggregation.groups.reduce((total, group) => total + BigInt(group.metrics[field]), 0n);
    if (sum !== BigInt(aggregation.totals[field])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'GROUP_TOTAL_MISMATCH', field },
        message: `group ${field} values must reconcile to the overall total`,
        path: ['groups'],
      });
    }
  }
});
export type UsageAggregation = z.infer<typeof UsageAggregationSchema>;

export const UsageAggregationOptionsSchema = z.object({
  filter: UsageAggregateFilterSchema.default({}),
  groupBy: UsageAggregateGroupBySchema.default(DEFAULT_GROUP_BY),
}).strict();
export type UsageAggregationOptions = z.infer<typeof UsageAggregationOptionsSchema>;
export type UsageAggregationOptionsInput = z.input<typeof UsageAggregationOptionsSchema>;

/* ------------------------------------------------------------------ */
/* UsageSummary                                                        */
/* ------------------------------------------------------------------ */

export const UsageSummarySchema = z
  .object({
    inputTokens: SafeNonNegativeIntSchema,
    outputTokens: SafeNonNegativeIntSchema,
    /** Distinct from cost: tokens are counts, money is micro-USD integers. */
    totalTokens: SafeNonNegativeIntSchema,
    totalCostMicrousd: SafeNonNegativeIntSchema,
    /** Unique ledger events actually summed (post-dedup, post-filter). */
    eventCount: SafeNonNegativeIntSchema,
  })
  .strict()
  .superRefine((summary, ctx) => {
    // zod v3 runs refinements even on DIRTY values whose base checks failed:
    // BigInt(1.5) would throw RangeError out of parse() instead of ZodError.
    // Keep parse()'s failure mode uniformly schema-shaped (receipt delta D22).
    if (
      !Number.isInteger(summary.inputTokens) ||
      !Number.isInteger(summary.outputTokens) ||
      !Number.isInteger(summary.totalTokens)
    ) {
      return;
    }
    const implied = BigInt(summary.inputTokens) + BigInt(summary.outputTokens);
    if (implied !== BigInt(summary.totalTokens)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'TOKENS_TOTAL_MISMATCH' },
        message: 'totalTokens must equal inputTokens + outputTokens',
        path: ['totalTokens'],
      });
    }
  });
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

/* ------------------------------------------------------------------ */
/* Dedup integrity error                                               */
/* ------------------------------------------------------------------ */

/** Same eventId seen twice with different canonical content. Duplicate
 * DELIVERY is idempotent (counts once); duplicate ID with divergent payload
 * means the ledger itself is corrupt and no summary over it can be trusted. */
export class UsageReconciliationConflictError extends Error {
  constructor(public readonly eventId: string) {
    super('USAGE_EVENT_CONFLICT: eventId ' + JSON.stringify(eventId) + ' appears more than once with differing content');
    this.name = 'UsageReconciliationConflictError';
  }
}

/* ------------------------------------------------------------------ */
/* aggregateUsageEvents                                                */
/* ------------------------------------------------------------------ */

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

function assertSafeTotal(value: bigint, field: string): number {
  if (value > MAX_SAFE_BIG) {
    throw new RangeError(
      'USAGE_AGGREGATE_OVERFLOW: ' +
        field +
        ' exceeds Number.MAX_SAFE_INTEGER; refusing to truncate to an inexact double',
    );
  }
  return Number(value);
}

function windowInstant(
  value: string,
  eventId: string,
  field: UsageAggregateTimeField,
): number {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new RangeError(
      'USAGE_AGGREGATE_UNPARSEABLE_TIME: event ' +
        eventId +
        ' field ' +
        field +
        ' is not a parseable instant',
    );
  }
  return instant;
}

/**
 * Pure reconciliation core: dedup by eventId -> filter -> BigInt sum.
 *
 * Both inputs are RE-PARSED through their schemas before any arithmetic, so
 * untrusted payloads (hosted views, hand-edited fixtures, wire JSON) cannot
 * smuggle extra dimensions or non-integer money into a total. Dedup runs over
 * the whole input first (the eventId is the ledger's unit of account), then
 * the filter selects which unique events contribute to the summary.
 *
 * All unique matched events contribute additively; correction/refund netting
 * is intentionally not applied (see module scope note).
 */
export function aggregateUsageEvents(
  events: readonly UsageLedgerEvent[],
  filter?: UsageAggregateFilterInput,
): UsageSummary {
  if (!Array.isArray(events)) {
    throw new TypeError('aggregateUsageEvents: events must be an array of UsageLedgerEvent');
  }
  const parsedFilter = UsageAggregateFilterSchema.parse(filter ?? {});
  const from = parsedFilter.from === undefined ? undefined : Date.parse(parsedFilter.from);
  const to = parsedFilter.to === undefined ? undefined : Date.parse(parsedFilter.to);

  const seen = new Map<string, string>();
  let inputTokens = 0n;
  let outputTokens = 0n;
  let costMicrousd = 0n;
  let eventCount = 0;

  for (const rawEvent of events) {
    const event = UsageLedgerEventSchema.parse(rawEvent);
    const canonical = JSON.stringify(event);
    const prior = seen.get(event.eventId);
    if (prior !== undefined) {
      if (prior !== canonical) {
        throw new UsageReconciliationConflictError(event.eventId);
      }
      continue;
    }
    seen.set(event.eventId, canonical);

    if (parsedFilter.tenantId !== undefined && event.tenantId !== parsedFilter.tenantId) continue;
    if (parsedFilter.businessId !== undefined && event.businessId !== parsedFilter.businessId) continue;
    if (parsedFilter.operationId !== undefined && event.operationId !== parsedFilter.operationId) continue;
    const when = windowInstant(event[parsedFilter.timeField], event.eventId, parsedFilter.timeField);
    if (from !== undefined && when < from) continue;
    if (to !== undefined && when >= to) continue;

    inputTokens += BigInt(event.units.inputTokens);
    outputTokens += BigInt(event.units.outputTokens);
    costMicrousd += BigInt(event.costMicrousd);
    eventCount += 1;
  }

  const totalTokens = inputTokens + outputTokens;
  return UsageSummarySchema.parse({
    inputTokens: assertSafeTotal(inputTokens, 'inputTokens'),
    outputTokens: assertSafeTotal(outputTokens, 'outputTokens'),
    totalTokens: assertSafeTotal(totalTokens, 'totalTokens'),
    totalCostMicrousd: assertSafeTotal(costMicrousd, 'totalCostMicrousd'),
    eventCount: assertSafeTotal(BigInt(eventCount), 'eventCount'),
  });
}

type MutableUsageMetrics = {
  eventCount: bigint;
  operations: Set<string>;
  invocations: Set<string>;
  attempts: Set<string>;
  inputTokens: bigint;
  outputTokens: bigint;
  costMicrousd: bigint;
};

const EMPTY_STATUS_LIST = ['measured', 'estimated', 'pending', 'unpriced'] as const;

function newMetricsAccumulator(): MutableUsageMetrics {
  return {
    eventCount: 0n,
    operations: new Set(),
    invocations: new Set(),
    attempts: new Set(),
    inputTokens: 0n,
    outputTokens: 0n,
    costMicrousd: 0n,
  };
}

function recordUsageEvent(target: MutableUsageMetrics, event: UsageLedgerEvent): void {
  target.eventCount += 1n;
  // Invocation ids and attempts are scoped to an operation and tenant in the
  // ledger. This avoids accidental collisions in test/imported legacy data.
  const operationKey = JSON.stringify([event.tenantId, event.operationId]);
  const invocationKey = JSON.stringify([operationKey, event.invocationId]);
  target.operations.add(operationKey);
  target.invocations.add(invocationKey);
  target.attempts.add(JSON.stringify([invocationKey, event.attempt]));
  target.inputTokens += BigInt(event.units.inputTokens);
  target.outputTokens += BigInt(event.units.outputTokens);
  target.costMicrousd += BigInt(event.costMicrousd);
}

function materializeStatusMetrics(target: MutableUsageMetrics, label: string): UsageAggregateStatusMetrics {
  const totalTokens = target.inputTokens + target.outputTokens;
  return UsageAggregateStatusMetricsSchema.parse({
    eventCount: assertSafeTotal(target.eventCount, `${label}.eventCount`),
    uniqueOperations: assertSafeTotal(BigInt(target.operations.size), `${label}.uniqueOperations`),
    invocations: assertSafeTotal(BigInt(target.invocations.size), `${label}.invocations`),
    attempts: assertSafeTotal(BigInt(target.attempts.size), `${label}.attempts`),
    inputTokens: assertSafeTotal(target.inputTokens, `${label}.inputTokens`),
    outputTokens: assertSafeTotal(target.outputTokens, `${label}.outputTokens`),
    totalTokens: assertSafeTotal(totalTokens, `${label}.totalTokens`),
    costMicrousd: assertSafeTotal(target.costMicrousd, `${label}.costMicrousd`),
  });
}

function materializeMetrics(
  total: MutableUsageMetrics,
  statuses: Record<UsageCostStatus, MutableUsageMetrics>,
  label: string,
): UsageAggregateMetrics {
  const metrics = materializeStatusMetrics(total, label);
  const breakdown = Object.fromEntries(
    EMPTY_STATUS_LIST.map((status) => [
      status,
      materializeStatusMetrics(statuses[status], `${label}.breakdown.${status}`),
    ]),
  ) as UsageCostBreakdown;
  return UsageAggregateMetricsSchema.parse({ ...metrics, breakdown });
}

function dimensionsForEvent(
  event: UsageLedgerEvent,
  groupBy: UsageAggregateGroupBy,
): UsageAggregateDimensions {
  const dimensions: UsageAggregateDimensions = {};
  for (const dimension of groupBy) {
    switch (dimension) {
      case 'tenant':
        dimensions.tenantId = event.tenantId;
        break;
      case 'apiKey':
        dimensions.apiKeyId = event.apiKeyId;
        break;
      case 'businessAction':
        dimensions.businessId = event.businessId;
        dimensions.action = event.action;
        break;
      case 'profile':
        dimensions.profileRevision = event.profileRevision;
        break;
      case 'providerModel':
        dimensions.provider = event.provider;
        dimensions.model = event.model;
        break;
    }
  }
  return UsageAggregateDimensionsSchema.parse(dimensions);
}

/**
 * Reconcile a deduplicated ledger slice into a total and deterministic
 * group-by rows. The default levels follow the COST-03 hierarchy. Event,
 * token, and cost totals add across groups; operation/invocation/attempt
 * counts are distinct within each total or bucket and therefore may not add
 * across buckets when an operation spans multiple attribution values.
 */
export function aggregateUsageGroups(
  events: readonly UsageLedgerEvent[],
  options?: UsageAggregationOptionsInput,
): UsageAggregation {
  if (!Array.isArray(events)) {
    throw new TypeError('aggregateUsageGroups: events must be an array of UsageLedgerEvent');
  }
  const parsedOptions = UsageAggregationOptionsSchema.parse(options ?? {});
  const parsedFilter = parsedOptions.filter;
  const from = parsedFilter.from === undefined ? undefined : Date.parse(parsedFilter.from);
  const to = parsedFilter.to === undefined ? undefined : Date.parse(parsedFilter.to);

  const seen = new Map<string, string>();
  const selected: UsageLedgerEvent[] = [];
  for (const rawEvent of events) {
    const event = UsageLedgerEventSchema.parse(rawEvent);
    const canonical = JSON.stringify(event);
    const prior = seen.get(event.eventId);
    if (prior !== undefined) {
      if (prior !== canonical) throw new UsageReconciliationConflictError(event.eventId);
      continue;
    }
    seen.set(event.eventId, canonical);

    if (parsedFilter.tenantId !== undefined && event.tenantId !== parsedFilter.tenantId) continue;
    if (parsedFilter.businessId !== undefined && event.businessId !== parsedFilter.businessId) continue;
    if (parsedFilter.operationId !== undefined && event.operationId !== parsedFilter.operationId) continue;
    const when = windowInstant(event[parsedFilter.timeField], event.eventId, parsedFilter.timeField);
    if (from !== undefined && when < from) continue;
    if (to !== undefined && when >= to) continue;
    selected.push(event);
  }

  const total = newMetricsAccumulator();
  const totalStatuses = Object.fromEntries(
    EMPTY_STATUS_LIST.map((status) => [status, newMetricsAccumulator()]),
  ) as Record<UsageCostStatus, MutableUsageMetrics>;
  const groups = new Map<string, {
    dimensions: UsageAggregateDimensions;
    total: MutableUsageMetrics;
    statuses: Record<UsageCostStatus, MutableUsageMetrics>;
  }>();

  for (const event of selected) {
    recordUsageEvent(total, event);
    recordUsageEvent(totalStatuses[event.costStatus], event);

    const dimensions = dimensionsForEvent(event, parsedOptions.groupBy);
    const key = JSON.stringify(dimensions);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        dimensions,
        total: newMetricsAccumulator(),
        statuses: Object.fromEntries(
          EMPTY_STATUS_LIST.map((status) => [status, newMetricsAccumulator()]),
        ) as Record<UsageCostStatus, MutableUsageMetrics>,
      };
      groups.set(key, group);
    }
    recordUsageEvent(group.total, event);
    recordUsageEvent(group.statuses[event.costStatus], event);
  }

  const groupRows: UsageAggregateGroup[] = [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, group]) => ({
      dimensions: group.dimensions,
      metrics: materializeMetrics(group.total, group.statuses, `group.${key}`),
    }));

  return UsageAggregationSchema.parse({
    filter: parsedFilter,
    groupBy: parsedOptions.groupBy,
    timeSemantics: {
      field: parsedFilter.timeField,
      interval: '[from,to)',
      timezone: 'UTC',
    },
    totals: materializeMetrics(total, totalStatuses, 'totals'),
    groups: groupRows,
  });
}
