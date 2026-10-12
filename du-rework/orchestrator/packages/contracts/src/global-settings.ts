import { z } from 'zod';

const RevisionSchema = z.number().int().nonnegative().max(1_000_000_000);
const ActorLabelSchema = z.string().min(1).max(128);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ConnectorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/** AI defaults refer to an immutable Connector revision; credential values and
 * arbitrary endpoint URLs remain owned by Connector/Vault. */
export const TenantAiDefaultsSchema = z.object({
  provider: z.enum(['gemini', 'openai-compatible']),
  model: z.string().trim().min(1).max(128),
  connectorId: ConnectorIdSchema.nullable(),
  connectorRevision: RevisionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.connectorId === null) !== (value.connectorRevision === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectorRevision'], message: 'connector id and revision must be present together' });
  }
});
export type TenantAiDefaults = z.infer<typeof TenantAiDefaultsSchema>;

export const TenantPromptDefaultsSchema = z.object({
  image: z.string().min(1).max(32_768),
  pdf: z.string().min(1).max(32_768),
  docx: z.string().min(1).max(32_768),
  compare: z.string().min(1).max(32_768),
  generate: z.string().min(1).max(32_768),
}).strict();
export type TenantPromptDefaults = z.infer<typeof TenantPromptDefaultsSchema>;

/**
 * Immutable admission snapshot. Prompt bodies are carried only inside the
 * operation-bound encrypted envelope; this DTO is the opened worker claim
 * shape. The digest covers both revisions and all resolved values.
 */
export const TenantDefaultsSnapshotSchema = z.object({
  aiRevision: RevisionSchema.nullable(),
  promptRevision: RevisionSchema.nullable(),
  settingsDigest: DigestSchema,
  ai: z.object({
    provider: z.enum(['gemini', 'openai-compatible']).nullable(),
    model: z.string().min(1).max(128).nullable(),
    connectorId: ConnectorIdSchema.nullable(),
    connectorRevision: RevisionSchema.nullable(),
  }).strict(),
  prompts: z.object({
    image: z.string().max(32_768).nullable(),
    pdf: z.string().max(32_768).nullable(),
    docx: z.string().max(32_768).nullable(),
    compare: z.string().max(32_768).nullable(),
    generate: z.string().max(32_768).nullable(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const ai = value.ai;
  if ((ai.connectorId === null) !== (ai.connectorRevision === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ai', 'connectorRevision'], message: 'connector id and revision must be present together' });
  }
  if (ai.provider === null && (ai.model !== null || ai.connectorId !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ai'], message: 'provider must be selected before model or connector defaults' });
  }
});
export type TenantDefaultsSnapshot = z.infer<typeof TenantDefaultsSnapshotSchema>;

export const GlobalSettingsRevisionStateSchema = z.enum(['DRAFT', 'TESTED', 'PUBLISHED', 'SUPERSEDED']);
export type GlobalSettingsRevisionState = z.infer<typeof GlobalSettingsRevisionStateSchema>;

export const TenantAiRevisionSchema = z.object({
  tenantId: z.string().uuid(),
  revision: RevisionSchema,
  state: GlobalSettingsRevisionStateSchema,
  settings: TenantAiDefaultsSchema,
  digest: DigestSchema,
  createdAt: z.string().datetime({ offset: true }),
  actor: ActorLabelSchema,
  testedAt: z.string().datetime({ offset: true }).nullable(),
  sourceRevision: RevisionSchema.nullable(),
}).strict();
export type TenantAiRevision = z.infer<typeof TenantAiRevisionSchema>;

export const TenantPromptRevisionSchema = z.object({
  tenantId: z.string().uuid(),
  revision: RevisionSchema,
  state: GlobalSettingsRevisionStateSchema,
  settings: TenantPromptDefaultsSchema,
  digest: DigestSchema,
  createdAt: z.string().datetime({ offset: true }),
  actor: ActorLabelSchema,
  sourceRevision: RevisionSchema.nullable(),
}).strict();
export type TenantPromptRevision = z.infer<typeof TenantPromptRevisionSchema>;

export const GlobalSettingsStreamReadSchema = <T extends z.ZodTypeAny>(revision: T) => z.object({
  activeRevision: RevisionSchema.nullable(),
  draft: revision.nullable(),
  history: z.array(revision).max(100),
}).strict();

export const TenantGlobalSettingsReadSchema = z.object({
  tenantId: z.string().uuid(),
  ai: GlobalSettingsStreamReadSchema(TenantAiRevisionSchema),
  prompts: GlobalSettingsStreamReadSchema(TenantPromptRevisionSchema),
  effective: TenantDefaultsSnapshotSchema,
  capability: z.object({ editable: z.boolean(), testable: z.boolean(), reasonCode: z.string().max(96).nullable() }).strict(),
}).strict();
export type TenantGlobalSettingsRead = z.infer<typeof TenantGlobalSettingsReadSchema>;

export const TenantAiDraftRequestSchema = z.object({
  expectedActiveRevision: RevisionSchema.nullable(),
  sourceRevision: RevisionSchema.nullable().optional(),
  settings: TenantAiDefaultsSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type TenantAiDraftRequest = z.infer<typeof TenantAiDraftRequestSchema>;

export const TenantPromptDraftRequestSchema = z.object({
  expectedActiveRevision: RevisionSchema.nullable(),
  sourceRevision: RevisionSchema.nullable().optional(),
  settings: TenantPromptDefaultsSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type TenantPromptDraftRequest = z.infer<typeof TenantPromptDraftRequestSchema>;

export const GlobalSettingsPublishRequestSchema = z.object({
  draftRevision: RevisionSchema,
  expectedActiveRevision: RevisionSchema.nullable(),
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type GlobalSettingsPublishRequest = z.infer<typeof GlobalSettingsPublishRequestSchema>;

export const GlobalSettingsRollbackRequestSchema = z.object({
  targetRevision: RevisionSchema,
  expectedActiveRevision: RevisionSchema.nullable(),
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type GlobalSettingsRollbackRequest = z.infer<typeof GlobalSettingsRollbackRequestSchema>;

export const TenantAiTestRequestSchema = z.object({
  revision: RevisionSchema,
  /** Existing active references used to admit the real provider invocation. */
  apiKeyId: z.string().uuid(),
  profileId: z.string().uuid(),
  expectedProfileRevision: z.number().int().min(1),
  businessId: z.string().min(1).max(128),
  businessVersion: z.string().min(1).max(64),
  action: z.string().min(1).max(128),
  endpointSlug: z.string().min(1).max(128),
  /** Declared action slot selected for a platform-only PENDING Connector candidate test. */
  bindingSlot: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1).max(32_000),
  parameters: z.record(z.string().min(1).max(128), z.unknown()).default({}).superRefine((parameters, ctx) => {
    const serialized = (() => { try { return JSON.stringify(parameters); } catch { return null; } })();
    if (serialized === null || serialized.length > 32_768) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'test parameters must be JSON serializable and at most 32 KiB' });
  }),
  artifactIds: z.array(z.string().uuid()).max(4).default([]),
  timeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  idempotencyKey: z.string().min(8).max(256),
}).strict();
export type TenantAiTestRequest = z.infer<typeof TenantAiTestRequestSchema>;

export const TenantAiTestResultSchema = z.object({
  tenantId: z.string().uuid(),
  revision: RevisionSchema,
  ok: z.boolean(),
  testedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().max(96).nullable(),
}).strict();
export type TenantAiTestResult = z.infer<typeof TenantAiTestResultSchema>;

export const PlatformRetentionSettingsSchema = z.object({
  cacheTtlHours: z.number().int().min(0).max(87_600),
  outputRetentionDays: z.number().int().min(0).max(3_650),
  cleanupIntervalSeconds: z.number().int().min(0).max(31_536_000),
}).strict();
export type PlatformRetentionSettings = z.infer<typeof PlatformRetentionSettingsSchema>;

export const PlatformRetentionRevisionSchema = z.object({
  revision: RevisionSchema,
  state: GlobalSettingsRevisionStateSchema,
  settings: PlatformRetentionSettingsSchema,
  digest: DigestSchema,
  createdAt: z.string().datetime({ offset: true }),
  actor: ActorLabelSchema,
  sourceRevision: RevisionSchema.nullable(),
}).strict();
export type PlatformRetentionRevision = z.infer<typeof PlatformRetentionRevisionSchema>;

export const PlatformRetentionReadSchema = z.object({
  activeRevision: RevisionSchema,
  effective: PlatformRetentionSettingsSchema,
  draft: PlatformRetentionRevisionSchema.nullable(),
  history: z.array(PlatformRetentionRevisionSchema).max(100),
  capability: z.object({ editable: z.boolean(), reasonCode: z.string().max(96).nullable() }).strict(),
}).strict();
export type PlatformRetentionRead = z.infer<typeof PlatformRetentionReadSchema>;

export const PlatformRetentionDraftRequestSchema = z.object({
  expectedActiveRevision: RevisionSchema,
  sourceRevision: RevisionSchema.nullable().optional(),
  settings: PlatformRetentionSettingsSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type PlatformRetentionDraftRequest = z.infer<typeof PlatformRetentionDraftRequestSchema>;

export const GlobalSettingsMutationResultSchema = z.object({
  tenantId: z.string().uuid().nullable(),
  stream: z.enum(['tenant-ai', 'tenant-prompts', 'platform-retention']),
  revision: RevisionSchema,
  activeRevision: RevisionSchema,
  replayed: z.boolean(),
}).strict();
export type GlobalSettingsMutationResult = z.infer<typeof GlobalSettingsMutationResultSchema>;

