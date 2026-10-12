import { z } from 'zod';

const UuidSchema = z.string().uuid();
const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/);
const SafeAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveAmountSchema = SafeAmountSchema.min(1);
const TimestampSchema = z.string().datetime({ offset: true });
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const QuotaWindowPinSchema = z.object({
  budgetId: UuidSchema,
  budgetRevision: z.number().int().min(1),
  scopeKey: z.string().min(1).max(512),
  period: z.enum(['daily', 'monthly']),
  windowStart: TimestampSchema,
  windowEnd: TimestampSchema,
}).strict().superRefine((pin, context) => {
  if (Date.parse(pin.windowStart) >= Date.parse(pin.windowEnd)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['windowEnd'], message: 'accounting window must have positive duration' });
  }
});
const QuotaWindowPinsSchema = z.array(QuotaWindowPinSchema).max(32);

/** A financial adjustment references the original charge directly.  The
 * server resolves the artifact's exact stored object/sidecar pins and digest;
 * callers cannot submit a claimed digest or provider verification flag. */
const CostAdjustmentBaseSchema = z.object({
  tenantId: UuidSchema,
  rootEventId: SafeIdSchema,
  expectedAdjustmentRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(3).max(500),
  evidenceArtifactId: UuidSchema,
}).strict();

export const CostAdjustmentCommandSchema = z.discriminatedUnion('kind', [
  CostAdjustmentBaseSchema.extend({
    kind: z.literal('correction'),
    /** Replacement gross billable total, never an additive delta. */
    targetChargeMicrousd: SafeAmountSchema,
  }).strict(),
  CostAdjustmentBaseSchema.extend({
    kind: z.literal('refund'),
    /** Positive credit delta. */
    refundMicrousd: PositiveAmountSchema,
  }).strict(),
]);
export type CostAdjustmentCommand = z.infer<typeof CostAdjustmentCommandSchema>;

export const CostAdjustmentQuerySchema = z.object({
  tenantId: UuidSchema,
  rootEventId: SafeIdSchema,
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1024).optional(),
}).strict();
export type CostAdjustmentQuery = z.infer<typeof CostAdjustmentQuerySchema>;

export const CostAdjustmentEvidenceQuerySchema = z.object({
  tenantId: UuidSchema,
  q: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1024).optional(),
}).strict();
export type CostAdjustmentEvidenceQuery = z.infer<typeof CostAdjustmentEvidenceQuerySchema>;

export const CostAdjustmentEvidenceItemSchema = z.object({
  artifactId: UuidSchema,
  fileName: z.string().max(512).nullable(),
  mimeType: z.string().min(1).max(256),
  sizeBytes: SafeAmountSchema,
  sha256: DigestSchema,
  createdAt: TimestampSchema,
}).strict();
export type CostAdjustmentEvidenceItem = z.infer<typeof CostAdjustmentEvidenceItemSchema>;

export const CostAdjustmentEvidencePageSchema = z.object({
  tenantId: UuidSchema,
  items: z.array(CostAdjustmentEvidenceItemSchema).max(100),
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(1024).nullable(),
}).strict();
export type CostAdjustmentEvidencePage = z.infer<typeof CostAdjustmentEvidencePageSchema>;

export const CostAdjustmentEligibilityBlockerSchema = z.enum([
  'ROOT_NOT_FOUND',
  'TENANT_MISMATCH',
  'UNPRICED_OR_UNTRUSTED',
  'SETTLEMENT_INCOMPLETE',
  'RESERVATION_UNKNOWN',
  'ATTRIBUTION_INCOMPLETE',
  'PRICE_PROVENANCE_INCOMPLETE',
  'EVIDENCE_UNAVAILABLE',
  'EVIDENCE_NOT_READY',
  'EVIDENCE_PIN_INCOMPLETE',
]);

export const CostAdjustmentOriginalAttributionSchema = z.object({
  tenantId: UuidSchema,
  apiKeyId: UuidSchema.nullable(),
  profileId: UuidSchema.nullable(),
  profileRevision: z.number().int().min(1).nullable(),
  businessId: SafeIdSchema,
  businessVersion: SafeIdSchema,
  action: SafeIdSchema,
  operationId: UuidSchema,
  taskId: UuidSchema,
  invocationId: SafeIdSchema,
  attempt: z.number().int().min(1),
  connectorId: SafeIdSchema,
  connectorRevision: z.number().int().min(1),
  provider: SafeIdSchema,
  model: SafeIdSchema,
  occurredAt: TimestampSchema,
  quotaWindowPins: QuotaWindowPinsSchema,
  priceRevision: z.number().int().min(1),
  priceSnapshotDigest: DigestSchema,
  provenanceDigest: DigestSchema,
  costStatus: z.enum(['measured', 'estimated']),
  inputTokens: SafeAmountSchema,
  outputTokens: SafeAmountSchema,
  cachedInputTokens: SafeAmountSchema,
  pages: SafeAmountSchema,
  durationMs: SafeAmountSchema,
}).strict().superRefine((value, context) => {
  if (value.cachedInputTokens > value.inputTokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['cachedInputTokens'], message: 'cached tokens cannot exceed input tokens' });
  }
});
export type CostAdjustmentOriginalAttribution = z.infer<typeof CostAdjustmentOriginalAttributionSchema>;

export const CostAdjustmentHistoryEntrySchema = z.object({
  adjustmentEventId: UuidSchema,
  rootEventId: SafeIdSchema,
  adjustmentRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousAdjustmentEventId: UuidSchema.nullable(),
  kind: z.enum(['correction', 'refund']),
  targetChargeMicrousd: SafeAmountSchema.nullable(),
  refundMicrousd: PositiveAmountSchema.nullable(),
  initialChargeMicrousd: SafeAmountSchema,
  grossChargeMicrousd: SafeAmountSchema,
  refundedMicrousd: SafeAmountSchema,
  netChargeMicrousd: SafeAmountSchema,
  effectiveAt: TimestampSchema,
  quotaWindowPins: QuotaWindowPinsSchema,
  recordedAt: TimestampSchema,
  evidenceArtifactId: UuidSchema,
  evidenceStorageGenerationId: UuidSchema,
  /** Logical plaintext file metadata verified by ArtifactService. */
  evidenceSizeBytes: SafeAmountSchema,
  evidenceSha256: DigestSchema,
  /** Exact encrypted storage object version bytes, distinct from the logical file. */
  evidenceObjectSizeBytes: PositiveAmountSchema.nullable(),
  evidenceObjectSha256: DigestSchema.nullable(),
  evidenceObjectProofComplete: z.boolean(),
  evidenceObjectVersionId: SafeIdSchema,
  evidenceSidecarSizeBytes: SafeAmountSchema,
  evidenceSidecarVersionId: SafeIdSchema,
  evidenceSidecarSha256: DigestSchema,
  authority: z.literal('platform-admin-approved'),
  /** Stable server-owned UUID; never an OIDC issuer, subject, or browser value. */
  actorPrincipalId: UuidSchema,
  actorKind: z.enum(['local-user', 'oidc-admin']),
  reason: z.string().min(3).max(500),
}).strict().superRefine((entry, context) => {
  if (entry.evidenceObjectProofComplete !== (entry.evidenceObjectSizeBytes !== null && entry.evidenceObjectSha256 !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceObjectProofComplete'], message: 'object proof completeness must match the persisted exact-version digest and size' });
  }
  if ((entry.kind === 'correction') !== (entry.targetChargeMicrousd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetChargeMicrousd'], message: 'corrections have a target total; refunds do not' });
  }
  if ((entry.kind === 'refund') !== (entry.refundMicrousd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['refundMicrousd'], message: 'refunds have a positive delta; corrections do not' });
  }
  if (entry.netChargeMicrousd !== entry.grossChargeMicrousd - entry.refundedMicrousd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['netChargeMicrousd'], message: 'net must equal gross minus refunds' });
  }
});
export type CostAdjustmentHistoryEntry = z.infer<typeof CostAdjustmentHistoryEntrySchema>;

export const CostAdjustmentHistoryPageSchema = z.object({
  tenantId: UuidSchema,
  rootEventId: SafeIdSchema,
  adjustmentRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  headAdjustmentEventId: UuidSchema.nullable(),
  eligible: z.boolean(),
  blockers: z.array(CostAdjustmentEligibilityBlockerSchema).max(16),
  initialChargeMicrousd: SafeAmountSchema.nullable(),
  grossChargeMicrousd: SafeAmountSchema.nullable(),
  refundedMicrousd: SafeAmountSchema.nullable(),
  netChargeMicrousd: SafeAmountSchema.nullable(),
  originalAttribution: CostAdjustmentOriginalAttributionSchema.nullable(),
  items: z.array(CostAdjustmentHistoryEntrySchema).max(100),
  limit: z.number().int().min(1).max(100),
  nextCursor: z.string().min(1).max(1024).nullable(),
}).strict().superRefine((page, context) => {
  if (page.eligible && (page.blockers.length > 0 || page.originalAttribution === null
      || page.initialChargeMicrousd === null || page.grossChargeMicrousd === null
      || page.refundedMicrousd === null || page.netChargeMicrousd === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['eligible'], message: 'eligible roots require complete attribution and amounts' });
  }
  if ((page.adjustmentRevision === 0) !== (page.headAdjustmentEventId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['headAdjustmentEventId'], message: 'empty heads have no event; nonempty heads have a head event' });
  }
  if (page.items.some((entry) => entry.rootEventId !== page.rootEventId || entry.adjustmentRevision > page.adjustmentRevision)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'history rows must belong to the root and not exceed its head' });
  }
});
export type CostAdjustmentHistoryPage = z.infer<typeof CostAdjustmentHistoryPageSchema>;

export const CostAdjustmentCommandResultSchema = z.object({
  outcome: z.enum(['ADJUSTED', 'NOOP']),
  adjustmentEventId: UuidSchema.nullable(),
  rootEventId: SafeIdSchema,
  adjustmentRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  initialChargeMicrousd: SafeAmountSchema,
  grossChargeMicrousd: SafeAmountSchema,
  refundedMicrousd: SafeAmountSchema,
  netChargeMicrousd: SafeAmountSchema,
  effectiveAt: TimestampSchema,
  recordedAt: TimestampSchema,
  replayed: z.boolean(),
}).strict().superRefine((result, context) => {
  if (result.netChargeMicrousd !== result.grossChargeMicrousd - result.refundedMicrousd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['netChargeMicrousd'], message: 'net must equal gross minus refunds' });
  }
  if ((result.outcome === 'NOOP') !== (result.adjustmentEventId === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['adjustmentEventId'], message: 'only no-op results omit an adjustment event' });
  }
});
export type CostAdjustmentCommandResult = z.infer<typeof CostAdjustmentCommandResultSchema>;
