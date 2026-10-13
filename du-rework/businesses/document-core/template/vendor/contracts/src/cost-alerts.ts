import { z } from 'zod';
import { BudgetQuotaScopeSchema } from './usage-budget';

const UUID = z.string().uuid();
const SafeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/)
  .refine((value) => !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value), { message: 'identifiers cannot be URLs' });
const Timestamp = z.string().datetime({ offset: true });
const SafeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const CostAlertKindSchema = z.enum(['threshold', 'limit', 'trust_gap']);
export type CostAlertKind = z.infer<typeof CostAlertKindSchema>;

export const CostAlertChannelSchema = z.object({
  channelId: SafeId,
  channelRevision: z.number().int().min(1),
  kind: z.literal('in-app'),
  displayName: z.string().min(1).max(120),
  enabled: z.boolean(),
  destinationLabel: z.literal('Owner-scoped Admin inbox'),
}).strict();
export type CostAlertChannel = z.infer<typeof CostAlertChannelSchema>;

const CostAlertChannelRefSchema = z.object({
  channelId: SafeId,
  channelRevision: z.number().int().min(1),
}).strict();

export const CostAlertChannelListSchema = z.object({
  tenantId: UUID,
  channels: z.array(CostAlertChannelSchema).max(20),
}).strict();
export type CostAlertChannelList = z.infer<typeof CostAlertChannelListSchema>;

/** An alert recipient is an explicit identity kind. External principals are
 * opaque directory keys; issuer and subject claims are never wire fields. */
export const CostAlertRecipientReferenceSchema = z.union([
  z.object({ kind: z.literal('local'), userId: UUID }).strict(),
  z.object({ kind: z.literal('oidc'), principalId: UUID }).strict(),
]);
export type CostAlertRecipientReference = z.infer<typeof CostAlertRecipientReferenceSchema>;

export const CostAlertRecipientSchema = z.object({
  kind: z.literal('oidc'),
  principalId: UUID,
  displayName: z.string().min(1).max(80),
  role: z.literal('ADMIN'),
  state: z.enum(['ENABLED', 'DISABLED', 'REVOKED']),
  authorizationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  lastVerifiedAt: Timestamp,
  eligible: z.boolean(),
}).strict().superRefine((recipient, context) => {
  if (recipient.eligible !== (recipient.role === 'ADMIN' && recipient.state === 'ENABLED')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['eligible'], message: 'only enabled external Admin principals are eligible' });
  }
});
export type CostAlertRecipient = z.infer<typeof CostAlertRecipientSchema>;

export const CostAlertRecipientCatalogQuerySchema = z.object({
  tenantId: UUID,
  q: z.string().trim().max(80).default(''),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type CostAlertRecipientCatalogQuery = z.infer<typeof CostAlertRecipientCatalogQuerySchema>;

export const CostAlertRecipientCatalogSchema = z.object({
  tenantId: UUID,
  items: z.array(CostAlertRecipientSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).nullable(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextCursor'], message: 'hasMore and nextCursor must agree' });
  }
});
export type CostAlertRecipientCatalog = z.infer<typeof CostAlertRecipientCatalogSchema>;

export const CostAlertRecipientLifecycleWriteSchema = z.object({
  expectedAuthorizationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  action: z.enum(['disable', 'enable', 'revoke']),
  reason: z.string().trim().min(8).max(240).regex(/^[^\u0000-\u001f\u007f]+$/),
}).strict();
export type CostAlertRecipientLifecycleWrite = z.infer<typeof CostAlertRecipientLifecycleWriteSchema>;

export const CostAlertRecipientLifecycleResultSchema = z.object({
  principalId: UUID,
  state: z.enum(['ENABLED', 'DISABLED', 'REVOKED']),
  authorizationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  changedAt: Timestamp,
}).strict();
export type CostAlertRecipientLifecycleResult = z.infer<typeof CostAlertRecipientLifecycleResultSchema>;

export const CostPolicyScopeCatalogKindSchema = z.enum(['api-keys', 'profiles', 'businesses']);
export const CostPolicyScopeCatalogQuerySchema = z.object({
  tenantId: UUID,
  kind: CostPolicyScopeCatalogKindSchema,
  q: z.string().trim().max(80).default(''),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  apiKeyId: UUID.optional(),
  profileId: UUID.optional(),
}).strict().superRefine((query, context) => {
  if (query.kind === 'api-keys' && (query.apiKeyId !== undefined || query.profileId !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeyId'], message: 'API-key catalog does not accept parent scope filters' });
  }
  if (query.kind === 'profiles' && query.profileId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['profileId'], message: 'profile catalog does not accept a profile filter' });
  }
  if (query.kind === 'businesses' && query.profileId !== undefined && query.apiKeyId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKeyId'], message: 'profile-filtered business catalog requires its API key scope' });
  }
});
export type CostPolicyScopeCatalogQuery = z.infer<typeof CostPolicyScopeCatalogQuerySchema>;

export const CostPolicyScopeApiKeySchema = z.object({ id: UUID, label: z.string().min(1).max(120) }).strict();
export type CostPolicyScopeApiKey = z.infer<typeof CostPolicyScopeApiKeySchema>;
export const CostPolicyScopeProfileSchema = z.object({
  id: UUID,
  apiKeyId: UUID,
  apiKeyLabel: z.string().min(1).max(120),
  businessId: SafeId,
  businessVersion: SafeId,
  action: SafeId,
  profileName: z.string().min(1).max(128),
}).strict();
export type CostPolicyScopeProfile = z.infer<typeof CostPolicyScopeProfileSchema>;
export const CostPolicyScopeBusinessSchema = z.object({ id: SafeId, label: z.string().min(1).max(160) }).strict();
export type CostPolicyScopeBusiness = z.infer<typeof CostPolicyScopeBusinessSchema>;

const ScopeCatalogPageBase = {
  tenantId: UUID,
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).nullable(),
};
const ScopeCatalogPageRefinement = (page: { hasMore: boolean; nextCursor: string | null }, context: z.RefinementCtx) => {
  if (page.hasMore !== (page.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextCursor'], message: 'hasMore and nextCursor must agree' });
  }
};
export const CostPolicyScopeCatalogSchema = z.union([
  z.object({ ...ScopeCatalogPageBase, kind: z.literal('api-keys'), items: z.array(CostPolicyScopeApiKeySchema).max(100) }).strict().superRefine(ScopeCatalogPageRefinement),
  z.object({ ...ScopeCatalogPageBase, kind: z.literal('profiles'), items: z.array(CostPolicyScopeProfileSchema).max(100) }).strict().superRefine(ScopeCatalogPageRefinement),
  z.object({ ...ScopeCatalogPageBase, kind: z.literal('businesses'), items: z.array(CostPolicyScopeBusinessSchema).max(100) }).strict().superRefine(ScopeCatalogPageRefinement),
]);
export type CostPolicyScopeCatalog = z.infer<typeof CostPolicyScopeCatalogSchema>;

export const CostBudgetAlertBindingSchema = z.object({
  tenantId: UUID,
  budgetId: UUID,
  budgetRevision: z.number().int().min(1),
  bindingRevision: z.number().int().min(1),
  owner: z.union([
    z.object({
      userId: UUID,
      displayName: z.string().min(1).max(128),
      role: z.enum(['ADMIN', 'USER', 'VIEWER']),
      enabled: z.boolean(),
      locked: z.boolean(),
    }).strict(),
    z.object({
      kind: z.literal('oidc'),
      principalId: UUID,
      displayName: z.string().min(1).max(80),
      role: z.literal('ADMIN'),
      enabled: z.boolean(),
      locked: z.literal(false),
      authorizationVersion: z.number().int().min(1),
    }).strict(),
  ]),
  channels: z.array(CostAlertChannelRefSchema).min(1).max(20),
  updatedAt: Timestamp,
  updatedBy: z.string().min(1).max(128),
}).strict();
export type CostBudgetAlertBinding = z.infer<typeof CostBudgetAlertBindingSchema>;

const CostBudgetAlertBindingWriteBaseSchema = z.object({
  tenantId: UUID,
  budgetId: UUID,
  budgetRevision: z.number().int().min(1),
  expectedBindingRevision: z.number().int().min(0),
  ownerUserId: UUID.optional(),
  owner: CostAlertRecipientReferenceSchema.optional(),
  channels: z.array(CostAlertChannelRefSchema).min(1).max(20),
}).strict();
export const CostBudgetAlertBindingWriteSchema = CostBudgetAlertBindingWriteBaseSchema.superRefine((value, context) => {
  if ((value.ownerUserId === undefined) === (value.owner === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['owner'], message: 'provide exactly one recipient; legacy ownerUserId is a local-recipient adapter' });
  }
  if (value.owner?.kind === 'local' && value.ownerUserId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['ownerUserId'], message: 'recipient cannot be supplied in both legacy and discriminated form' });
  }
  const ids = value.channels.map((channel) => channel.channelId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['channels'], message: 'channel ids must be unique' });
  }
});
export type CostBudgetAlertBindingWrite = z.infer<typeof CostBudgetAlertBindingWriteSchema>;

export const CostAlertSourceSchema = z.enum(['preflight', 'settlement']);
export const CostAlertTrustSchema = z.object({
  confidence: z.enum(['upper-bound', 'best-effort']),
  reasonCode: z.enum([
    'BOUND_UNSUPPORTED',
    'PRICE_UNAVAILABLE',
    'USAGE_BASIS_UNBOUNDED',
    'RESERVATION_BASIS_UNBOUNDED',
  ]).nullable(),
}).strict().superRefine((trust, context) => {
  if (trust.confidence === 'upper-bound' && trust.reasonCode !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'upper-bound trust cannot carry a trust-gap reason' });
  }
  if (trust.confidence === 'best-effort' && trust.reasonCode === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reasonCode'], message: 'best-effort trust requires a concrete reason' });
  }
});
export const CostAlertEvaluationSchema = z.object({
  action: z.enum(['ALLOW', 'WARN', 'BLOCK']),
  hardCapEnabled: z.boolean(),
  warnThresholdExceeded: z.boolean(),
  usagePercent: SafeCount,
  limitExceeded: z.boolean(),
  remainingTokens: SafeCount,
  remainingCostMicrousd: SafeCount,
}).strict();

/** Trusted facts passed by Usage from its active reservation-group transaction. */
export const CostBudgetAlertEnqueueFactsSchema = z.object({
  tenantId: UUID,
  budgetId: UUID,
  budgetRevision: z.number().int().min(1),
  quotaScopeKey: z.string().min(1).max(512),
  windowStart: Timestamp,
  windowEnd: Timestamp,
  source: CostAlertSourceSchema,
  sourceEventKey: z.string().min(1).max(512),
  reservationGroupId: UUID,
  operationId: UUID,
  taskId: UUID,
  invocationId: SafeId,
  attempt: z.number().int().min(1),
  usageEventId: z.string().min(1).max(128).optional(),
  evaluation: CostAlertEvaluationSchema,
  trust: CostAlertTrustSchema,
}).strict().superRefine((facts, context) => {
  if (Date.parse(facts.windowEnd) <= Date.parse(facts.windowStart)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['windowEnd'], message: 'windowEnd must follow windowStart' });
  }
  if (facts.source === 'settlement' && facts.usageEventId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['usageEventId'], message: 'settlement alerts require a persisted usage event' });
  }
  if (facts.evaluation.hardCapEnabled && facts.trust.confidence !== 'upper-bound') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['trust', 'confidence'], message: 'hard-cap alerts require an upper-bound evaluation' });
  }
});
export type CostBudgetAlertEnqueueFacts = z.infer<typeof CostBudgetAlertEnqueueFactsSchema>;

export const CostAlertDeliveryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  state: z.enum(['CLAIMED', 'DELIVERED', 'RETRY', 'EXHAUSTED', 'UNKNOWN']),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
}).strict();
export type CostAlertDeliveryAttempt = z.infer<typeof CostAlertDeliveryAttemptSchema>;

export const CostAlertDeliverySchema = z.object({
  channelId: SafeId,
  channelRevision: z.number().int().min(1),
  channelName: z.string().min(1).max(120),
  state: z.enum(['PENDING', 'CLAIMED', 'DELIVERED', 'RETRY', 'EXHAUSTED', 'HELD']),
  attempts: z.number().int().min(0).max(8),
  maxAttempts: z.literal(8),
  nextAttemptAt: Timestamp.nullable(),
  deliveredAt: Timestamp.nullable(),
  history: z.array(CostAlertDeliveryAttemptSchema).max(8),
}).strict();
export type CostAlertDelivery = z.infer<typeof CostAlertDeliverySchema>;

export const CostAlertRecordSchema = z.object({
  alertId: UUID,
  tenantId: UUID,
  budgetId: UUID,
  budgetRevision: z.number().int().min(1),
  kind: CostAlertKindSchema,
  source: CostAlertSourceSchema,
  sourceEventKey: z.string().min(1).max(512),
  quotaScope: BudgetQuotaScopeSchema,
  quotaScopeKey: z.string().min(1).max(512),
  windowStart: Timestamp,
  windowEnd: Timestamp,
  reservationGroupId: UUID,
  operationId: UUID,
  taskId: UUID,
  invocationId: SafeId,
  attempt: z.number().int().min(1),
  usageEventId: z.string().min(1).max(128).nullable(),
  evaluation: CostAlertEvaluationSchema,
  trust: CostAlertTrustSchema,
  routingState: z.enum(['ROUTED', 'UNROUTED']),
  bindingRevision: z.number().int().min(1).nullable(),
  owner: z.union([
    z.object({ userId: UUID, displayName: z.string().min(1).max(128), role: z.literal('ADMIN') }).strict(),
    z.object({
      kind: z.literal('oidc'),
      principalId: UUID,
      displayName: z.string().min(1).max(80),
      role: z.literal('ADMIN'),
      enabled: z.boolean(),
      locked: z.literal(false),
      authorizationVersion: z.number().int().min(1),
    }).strict(),
  ]).nullable(),
  channels: z.array(z.object({
    channelId: SafeId,
    channelRevision: z.number().int().min(1),
    displayName: z.string().min(1).max(120),
  }).strict()).max(20),
  deliveries: z.array(CostAlertDeliverySchema).max(20),
  createdAt: Timestamp,
}).strict();
export type CostAlertRecord = z.infer<typeof CostAlertRecordSchema>;

export const CostAlertListQuerySchema = z.object({
  tenantId: UUID,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  budgetId: UUID.optional(),
  kind: CostAlertKindSchema.optional(),
}).strict();
export type CostAlertListQuery = z.infer<typeof CostAlertListQuerySchema>;

export const CostAlertListSchema = z.object({
  tenantId: UUID,
  items: z.array(CostAlertRecordSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextCursor'], message: 'hasMore and nextCursor must agree' });
  }
});
export type CostAlertList = z.infer<typeof CostAlertListSchema>;

export const CostAlertInboxItemSchema = z.object({
  alertId: UUID,
  tenantId: UUID,
  budgetId: UUID,
  budgetRevision: z.number().int().min(1),
  kind: CostAlertKindSchema,
  source: CostAlertSourceSchema,
  sourceEventKey: z.string().min(1).max(512),
  windowStart: Timestamp,
  windowEnd: Timestamp,
  evaluation: CostAlertEvaluationSchema,
  trust: CostAlertTrustSchema,
  createdAt: Timestamp,
  deliveredAt: Timestamp,
  readAt: Timestamp.nullable(),
}).strict();
export type CostAlertInboxItem = z.infer<typeof CostAlertInboxItemSchema>;

export const CostAlertInboxQuerySchema = z.object({
  tenantId: UUID,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  unreadOnly: z.boolean().default(false),
}).strict();
export type CostAlertInboxQuery = z.infer<typeof CostAlertInboxQuerySchema>;

export const CostAlertInboxPageSchema = z.object({
  tenantId: UUID,
  items: z.array(CostAlertInboxItemSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).nullable(),
}).strict().superRefine((page, context) => {
  if (page.hasMore !== (page.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['nextCursor'], message: 'hasMore and nextCursor must agree' });
  }
});
export type CostAlertInboxPage = z.infer<typeof CostAlertInboxPageSchema>;

export const CostAlertInboxReadAckSchema = z.object({
  tenantId: UUID,
  alertId: UUID,
  readAt: Timestamp,
}).strict();
export type CostAlertInboxReadAck = z.infer<typeof CostAlertInboxReadAckSchema>;

