import { z } from 'zod';
import { BudgetActionSchema, BudgetConfigSchema, BudgetPolicySchema, BudgetStatusSchema } from './usage-budget';
import { ModelPricingTableSchema, ModelPricingTierSchema } from './pricing';
import { InvocationCostBudgetPinSchema } from './connector';

const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/);
const UuidSchema = z.string().uuid();
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const SafeCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Code-owned capability identifiers only. Every entry is an exact endpoint,
 * model snapshot and enforced output ceiling, not an operator assertion. */
export const COST_BOUND_CAPABILITIES = [
  {
    capabilityId: 'openai-gpt-4o-2024-08-06-chat-v1',
    provider: 'openai',
    model: 'gpt-4o-2024-08-06',
    origin: 'https://api.openai.com',
    path: '/v1/chat/completions',
    inputContextTokens: 128_000,
    maxOutputTokens: 16_384,
    outputLimitField: 'max_tokens',
    unitTypes: ['input_tokens_per_million', 'output_tokens_per_million'],
    evidenceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o',
    evidenceSnapshotDate: '2026-10-11',
  },
  {
    capabilityId: 'openai-gpt-4o-mini-2024-07-18-chat-v1',
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    origin: 'https://api.openai.com',
    path: '/v1/chat/completions',
    inputContextTokens: 128_000,
    maxOutputTokens: 16_384,
    outputLimitField: 'max_tokens',
    unitTypes: ['input_tokens_per_million', 'output_tokens_per_million'],
    evidenceUrl: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
    evidenceSnapshotDate: '2026-10-11',
  },
] as const;

export const CostBoundCapabilitySchema = z.object({
  capabilityId: SafeIdSchema,
  provider: SafeIdSchema,
  model: SafeIdSchema,
  origin: z.string().url(),
  path: z.string().min(1).max(256),
  inputContextTokens: SafeCountSchema.min(1),
  maxOutputTokens: SafeCountSchema.min(1),
  outputLimitField: z.enum(['max_tokens', 'max_completion_tokens', 'max_output_tokens']),
  unitTypes: z.tuple([z.literal('input_tokens_per_million'), z.literal('output_tokens_per_million')]),
  evidenceUrl: z.string().url(),
  evidenceSnapshotDate: z.string().date(),
}).strict();
export type CostBoundCapability = z.infer<typeof CostBoundCapabilitySchema>;

export const CostBoundProofSchema = z.object({
  version: z.literal('cost-bound-v1'),
  /** Null is an explicit unsupported/unbounded request. The Connector must
   * never invent token ceilings merely to pass a blocking policy. */
  capabilityId: SafeIdSchema.nullable(),
  connectorId: SafeIdSchema,
  connectorRevision: z.number().int().min(1),
  provider: SafeIdSchema,
  model: SafeIdSchema,
  /** Hash of final canonical outbound bytes; payload and credentials never cross this API. */
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  inputUpperBoundTokens: SafeCountSchema.min(1).nullable(),
  outputLimit: SafeCountSchema.min(1).nullable(),
  outputLimitField: z.enum(['max_tokens', 'max_completion_tokens', 'max_output_tokens']).nullable(),
  artifactCount: z.number().int().min(0).max(4),
  hasSession: z.boolean(),
  hasTools: z.boolean(),
  hasUnknownUnits: z.boolean(),
  retryCount: z.number().int().min(0).max(16),
}).strict().superRefine((proof, context) => {
  const limits = [proof.inputUpperBoundTokens, proof.outputLimit, proof.outputLimitField];
  if (proof.capabilityId === null && limits.some((value) => value !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilityId'], message: 'unbounded requests omit every claimed token limit' });
  }
  if (proof.capabilityId !== null && limits.some((value) => value === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['inputUpperBoundTokens'], message: 'bound capabilities require both token limits and the enforced output field' });
  }
});
export type CostBoundProof = z.infer<typeof CostBoundProofSchema>;

/** Connector-only post-render request. `grant` is verified by the route and
 * never echoed; the proof is checked against code-owned capabilities before
 * any reservation can be committed. */
export const CostPreflightRequestSchema = z.object({
  grant: z.string().min(1).max(16_384),
  proof: CostBoundProofSchema,
}).strict();
export type CostPreflightRequest = z.infer<typeof CostPreflightRequestSchema>;

export const CostBudgetEvaluationSchema = z.object({
  budgetId: UuidSchema,
  revision: z.number().int().min(1),
  action: BudgetActionSchema,
  hardCapEnabled: z.boolean(),
  /** The threshold flag is independent of action (for example, alert-only
   * policies can WARN before they hit either cap). */
  warnThresholdExceeded: z.boolean(),
  usagePercent: SafeCountSchema,
  limitExceeded: z.boolean(),
  remainingTokens: SafeCountSchema,
  remainingCostMicrousd: SafeCountSchema,
  trustReasonCode: z.enum([
    'BOUND_UNSUPPORTED', 'PRICE_UNAVAILABLE', 'USAGE_BASIS_UNBOUNDED', 'RESERVATION_BASIS_UNBOUNDED',
  ]).nullable(),
}).strict();

export const CostPreflightResponseSchema = z.object({
  decision: z.enum(['ADMITTED', 'BLOCKED']),
  selection: z.object({
    state: z.literal('FROZEN'),
    reservationGroupId: UuidSchema,
    selectedAt: TimestampSchema,
    priceRevision: z.number().int().min(1).nullable(),
    /** Exact immutable tier used for this invocation; no later price lookup is
     * permitted when producing its usage event. */
    pricingTier: ModelPricingTierSchema.nullable(),
    budgetPins: z.array(InvocationCostBudgetPinSchema).max(32),
  }).strict(),
  confidence: z.enum(['upper-bound', 'best-effort']),
  hardCapEnabled: z.boolean(),
  evaluations: z.array(CostBudgetEvaluationSchema).max(32),
}).strict().superRefine((response, context) => {
  if (response.decision === 'BLOCKED' && response.hardCapEnabled === false) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['hardCapEnabled'], message: 'a best-effort admission cannot report a hard block' });
  }
});
export type CostPreflightResponse = z.infer<typeof CostPreflightResponseSchema>;

export const CostReservationGroupTransitionSchema = z.object({
  grant: z.string().min(1).max(16_384),
  reservationGroupId: UuidSchema,
  operationId: UuidSchema,
  taskId: UuidSchema,
  invocationId: UuidSchema,
  attempt: z.number().int().min(1),
  target: z.enum(['RUNNING', 'UNKNOWN', 'RELEASED']),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  confirmedNotSent: z.literal(true).optional(),
}).strict().superRefine((transition, context) => {
  if (transition.target === 'RELEASED' && transition.confirmedNotSent !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmedNotSent'], message: 'release requires affirmative proof the provider was not called' });
  }
  if (transition.target === 'UNKNOWN' && transition.reasonCode === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'UNKNOWN transition requires a bounded reason code' });
  }
});
export type CostReservationGroupTransition = z.infer<typeof CostReservationGroupTransitionSchema>;

export const CostReservationGroupAckSchema = z.object({
  reservationGroupId: UuidSchema,
  state: z.enum(['RESERVED', 'RUNNING', 'UNKNOWN', 'RELEASED', 'BLOCKED', 'PENDING', 'SETTLED']),
  updatedAt: TimestampSchema,
}).strict();
export type CostReservationGroupAck = z.infer<typeof CostReservationGroupAckSchema>;

/* Persisted budget and price revision DTOs. State changes are CAS commands at
 * the service boundary; published snapshots are immutable. */
export const CostPolicyRevisionStateSchema = z.enum(['DRAFT', 'REVIEW', 'PUBLISHED', 'SUPERSEDED', 'RETIRED']);

export const PersistedBudgetRevisionSchema = z.object({
  budgetId: UuidSchema,
  revision: z.number().int().min(1),
  state: CostPolicyRevisionStateSchema,
  config: BudgetConfigSchema,
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  actor: SafeIdSchema,
  createdAt: TimestampSchema,
  publishedAt: TimestampSchema.nullable(),
}).strict().superRefine((revision, context) => {
  if (revision.state === 'PUBLISHED' && revision.publishedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['publishedAt'], message: 'published revisions require a timestamp' });
  }
});
export type PersistedBudgetRevision = z.infer<typeof PersistedBudgetRevisionSchema>;

export const CostControlBudgetHeadSchema = z.object({
  budgetId: UuidSchema,
  headRevision: z.number().int().min(0),
  activeRevision: z.number().int().min(1).nullable(),
  latest: PersistedBudgetRevisionSchema.nullable(),
}).strict().superRefine((head, context) => {
  if ((head.latest === null) !== (head.headRevision === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['latest'], message: 'empty heads have no revision and non-empty heads have a latest revision' });
  }
  if (head.latest && (head.latest.budgetId !== head.budgetId || head.latest.revision !== head.headRevision)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['latest'], message: 'latest revision must match the head identity and revision' });
  }
  if (head.activeRevision !== null && head.activeRevision > head.headRevision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['activeRevision'], message: 'active revision cannot exceed the head' });
  }
});
export type CostControlBudgetHead = z.infer<typeof CostControlBudgetHeadSchema>;

export const CostControlBudgetListSchema = z.object({
  tenantId: z.string().uuid(),
  budgets: z.array(CostControlBudgetHeadSchema).max(200),
}).strict().superRefine((list, context) => {
  const ids = list.budgets.map((budget) => budget.budgetId);
  if (new Set(ids).size !== ids.length || list.budgets.some((budget) => budget.latest && budget.latest.config.tenantId !== list.tenantId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['budgets'], message: 'budgets must be unique and tenant scoped' });
  }
});
export type CostControlBudgetList = z.infer<typeof CostControlBudgetListSchema>;

export const CostControlBudgetDetailSchema = z.object({
  tenantId: z.string().uuid(),
  budgetId: UuidSchema,
  headRevision: z.number().int().min(1),
  activeRevision: z.number().int().min(1).nullable(),
  revisions: z.array(PersistedBudgetRevisionSchema).min(1).max(100),
}).strict().superRefine((detail, context) => {
  if (detail.revisions.some((revision) => revision.budgetId !== detail.budgetId || revision.config.tenantId !== detail.tenantId || revision.revision > detail.headRevision)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions'], message: 'revision history must match its budget and tenant' });
  }
  if (!detail.revisions.some((revision) => revision.revision === detail.headRevision)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions'], message: 'revision history must include the current head' });
  }
});
export type CostControlBudgetDetail = z.infer<typeof CostControlBudgetDetailSchema>;

export const BudgetDraftWriteSchema = z.object({
  budgetId: UuidSchema.optional(),
  expectedHeadRevision: z.number().int().min(0),
  config: BudgetConfigSchema,
}).strict();
export type BudgetDraftWrite = z.infer<typeof BudgetDraftWriteSchema>;

export const CostPolicyTransitionRequestSchema = z.object({
  expectedState: CostPolicyRevisionStateSchema,
  expectedHeadRevision: z.number().int().min(0),
  reviewerReason: z.string().min(8).max(512).optional(),
}).strict();
export type CostPolicyTransitionRequest = z.infer<typeof CostPolicyTransitionRequestSchema>;

export const CostPolicyRollbackRequestSchema = z.object({
  sourceRevision: z.number().int().min(1),
  expectedHeadRevision: z.number().int().min(0),
  reviewerReason: z.string().min(8).max(512),
}).strict();
export type CostPolicyRollbackRequest = z.infer<typeof CostPolicyRollbackRequestSchema>;

export const PersistedPriceRevisionSchema = z.object({
  revision: z.number().int().min(1),
  state: CostPolicyRevisionStateSchema,
  tiers: ModelPricingTableSchema,
  contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  actor: SafeIdSchema,
  createdAt: TimestampSchema,
  publishedAt: TimestampSchema.nullable(),
}).strict().superRefine((revision, context) => {
  if (revision.state === 'PUBLISHED' && revision.publishedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['publishedAt'], message: 'published revisions require a timestamp' });
  }
});
export type PersistedPriceRevision = z.infer<typeof PersistedPriceRevisionSchema>;

export const CostControlPriceListSchema = z.object({
  headRevision: z.number().int().min(0),
  activeRevision: z.number().int().min(1).nullable(),
  revisions: z.array(PersistedPriceRevisionSchema).max(100),
}).strict().superRefine((list, context) => {
  if ((list.activeRevision !== null && list.activeRevision > list.headRevision)
    || (list.headRevision === 0 && list.revisions.length !== 0)
    || (list.headRevision > 0 && !list.revisions.some((revision) => revision.revision === list.headRevision))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions'], message: 'price list does not match its revision head' });
  }
});
export type CostControlPriceList = z.infer<typeof CostControlPriceListSchema>;

export const PriceDraftWriteSchema = z.object({
  expectedHeadRevision: z.number().int().min(0),
  tiers: ModelPricingTableSchema,
}).strict();
export type PriceDraftWrite = z.infer<typeof PriceDraftWriteSchema>;

export const EffectiveBudgetPinSchema = z.object({
  budgetId: UuidSchema,
  revision: z.number().int().min(1),
  config: BudgetConfigSchema,
  quotaScopeKey: z.string().min(1).max(512),
  periodStart: TimestampSchema,
  periodEnd: TimestampSchema,
}).strict().superRefine((pin, context) => {
  if (Date.parse(pin.periodEnd) <= Date.parse(pin.periodStart)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'budget window must be non-empty' });
  }
});
export type EffectiveBudgetPin = z.infer<typeof EffectiveBudgetPinSchema>;

/** Retain named imports as explicit service-side guards against accepting a
 * broader policy or status enum from a future generated client. */
export const COST_POLICY_ENUMS = { policy: BudgetPolicySchema, status: BudgetStatusSchema } as const;
