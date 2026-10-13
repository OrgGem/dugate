import { z } from 'zod';
import { IdentityRoleSchema, IdentityUserSchema } from './identity';
import { ConnectorWorkflowOverridesSchema, InvocationArtifactPinWithGenerationSchema, InvocationCostContextSchema, InvocationInputSchema } from './connector';
import { ConnectorRevisionStateSchema } from './vault';

/** ORV14 Identity, key lifecycle and full Connector recipe contracts. */
const UuidSchema = z.string().uuid();
const CursorSchema = z.string().min(1).max(512).nullable();

export const IdentityAssignmentSetSchema = z.object({
  userId: UuidSchema,
  version: z.number().int().min(1),
  profileIds: z.array(UuidSchema).max(500),
  apiKeyIds: z.array(UuidSchema).max(500),
}).strict();
export type IdentityAssignmentSet = z.infer<typeof IdentityAssignmentSetSchema>;

export const IdentityAssignmentReplaceSchema = z.object({
  expectedVersion: z.number().int().min(1),
  profileIds: z.array(UuidSchema).max(500),
  apiKeyIds: z.array(UuidSchema).max(500),
}).strict();
export type IdentityAssignmentReplace = z.infer<typeof IdentityAssignmentReplaceSchema>;

export const IdentityPasswordResetSchema = z.object({
  password: z.string().min(12).max(1024),
  expectedVersion: z.number().int().min(1),
}).strict();
export type IdentityPasswordReset = z.infer<typeof IdentityPasswordResetSchema>;

export const IdentityAssignableUserSchema = z.object({
  id: UuidSchema,
  username: z.string().min(1),
  role: z.enum(['ADMIN', 'USER']),
  tenantId: UuidSchema,
  enabled: z.literal(true),
}).strict();
export type IdentityAssignableUser = z.infer<typeof IdentityAssignableUserSchema>;

export const IdentityAssignableUserPageSchema = z.object({
  items: z.array(IdentityAssignableUserSchema),
  nextCursor: CursorSchema,
  prevCursor: CursorSchema,
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(250),
}).strict();
export type IdentityAssignableUserPage = z.infer<typeof IdentityAssignableUserPageSchema>;

export const IdentityUserPageSchema = z.object({
  items: z.array(IdentityUserSchema),
  nextCursor: CursorSchema,
  prevCursor: CursorSchema,
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(250),
}).strict();
export type IdentityUserPage = z.infer<typeof IdentityUserPageSchema>;

export const ApiKeyLifecycleRowSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  prefix: z.string().min(1).max(32),
  note: z.string().max(200).nullable(),
  status: z.enum(['ACTIVE', 'REVOKED']),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  profileIds: z.array(UuidSchema).max(500),
  protected: z.boolean(),
}).strict();
export type ApiKeyLifecycleRow = z.infer<typeof ApiKeyLifecycleRowSchema>;

export const ApiKeyLifecyclePageSchema = z.object({
  items: z.array(ApiKeyLifecycleRowSchema),
  nextCursor: CursorSchema,
  prevCursor: CursorSchema,
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(250),
}).strict();
export type ApiKeyLifecyclePage = z.infer<typeof ApiKeyLifecyclePageSchema>;

export const ApiKeyIssueSchema = z.object({
  note: z.string().trim().max(200).nullable().default(null),
  profileIds: z.array(UuidSchema).max(500).default([]),
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type ApiKeyIssue = z.infer<typeof ApiKeyIssueSchema>;

export const ApiKeyRotateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type ApiKeyRotate = z.infer<typeof ApiKeyRotateSchema>;

export const ApiKeyNoteSchema = z.object({
  note: z.string().trim().max(200).nullable(),
  expectedVersion: z.number().int().min(1),
}).strict();
export type ApiKeyNote = z.infer<typeof ApiKeyNoteSchema>;

export const ApiKeyMutationResultSchema = z.object({
  key: ApiKeyLifecycleRowSchema,
  /** Returned by issue/rotate once only; never stored or returned by list/read. */
  secret: z.string().min(32).optional(),
  secretAvailable: z.boolean(),
}).strict();
export type ApiKeyMutationResult = z.infer<typeof ApiKeyMutationResultSchema>;

export const ConnectorRecipeHeaderSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  value: z.string().max(512),
}).strict();

export const ConnectorRecipeAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('api-key-header'), headerName: z.string().min(1).max(128), secretSlot: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('bearer'), secretSlot: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('basic'), usernameSlot: z.string().min(1).max(128), passwordSlot: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('oauth2-client-credentials'), tokenUrl: z.string().url().max(2048), clientId: z.string().min(1).max(256), clientSecretSlot: z.string().min(1).max(128), scopes: z.array(z.string().max(128)).max(32) }).strict(),
]);

const ConnectorRecipeFieldSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  source: z.enum(['prompt', 'input', 'model', 'static', 'session']),
  value: z.union([z.string().max(4096), z.number().finite(), z.boolean()]).optional(),
  sessionPath: z.string().max(512).regex(/^[A-Za-z0-9_$.[\]-]+$/).optional(),
}).strict();

const SafeResponsePathSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_$.[\]-]+$/);

export const ConnectorRecipeSchema = z.object({
  adapter: z.enum(['json-http', 'multipart-http', 'gemini', 'openai-compatible']),
  method: z.enum(['POST', 'PUT']),
  endpointUrl: z.string().url().max(2048),
  auth: ConnectorRecipeAuthSchema,
  headers: z.array(ConnectorRecipeHeaderSchema).max(64),
  request: z.object({
    promptField: z.string().min(1).max(128),
    modelField: z.string().min(1).max(128).optional(),
    inputField: z.string().max(128).optional(),
    fileField: z.string().min(1).max(128).optional(),
    fileNameField: z.string().max(128).optional(),
    fields: z.array(ConnectorRecipeFieldSchema).max(128),
  }).strict(),
  response: z.object({
    contentPath: SafeResponsePathSchema,
    modelPath: SafeResponsePathSchema.optional(),
    inputTokensPath: SafeResponsePathSchema.optional(),
    outputTokensPath: SafeResponsePathSchema.optional(),
    errorPath: SafeResponsePathSchema.optional(),
  }).strict(),
  session: z.object({
    capture: z.array(z.object({ name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/), path: SafeResponsePathSchema }).strict()).max(32),
    inject: z.array(z.object({ name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/), path: SafeResponsePathSchema }).strict()).max(32),
  }).strict(),
  timeoutMs: z.number().int().min(100).max(60_000),
  responseBytes: z.number().int().min(1_024).max(2_000_000),
}).strict().superRefine((recipe, ctx) => {
  const secretHeaders = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);
  recipe.headers.forEach((header, index) => {
    if (secretHeaders.has(header.name.toLowerCase())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers', index, 'name'], message: 'secret-bearing headers must use a credential slot' });
    }
  });
  if (recipe.adapter === 'multipart-http' && !recipe.request.fileField) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fileField'], message: 'multipart recipes require a file field' });
  }
  const headerNames = recipe.headers.map((header) => header.name.toLowerCase());
  if (new Set(headerNames).size !== headerNames.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers'], message: 'recipe header names must be unique' });
  }
  const fieldNames = recipe.request.fields.map((field) => field.name);
  if (new Set(fieldNames).size !== fieldNames.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields'], message: 'recipe request field names must be unique' });
  }
  for (const [index, field] of recipe.request.fields.entries()) {
    if (field.source === 'static' && field.value === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields', index, 'value'], message: 'static recipe fields require a value' });
    }
    if (field.source !== 'static' && field.value !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields', index, 'value'], message: 'only static recipe fields may carry a value' });
    }
    if (field.source === 'session' && !field.sessionPath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields', index, 'sessionPath'], message: 'session recipe fields require a session path' });
    }
    if (field.source !== 'session' && field.sessionPath !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields', index, 'sessionPath'], message: 'only session recipe fields may carry a session path' });
    }
    if (typeof field.value === 'string' && /(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]/i.test(field.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['request', 'fields', index, 'value'], message: 'credential-like values must use a write-only credential slot' });
    }
  }
  const endpoint = new URL(recipe.endpointUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endpointUrl'], message: 'endpoint URL must be an http(s) URL without userinfo or fragment' });
  }
});
export type ConnectorRecipe = z.infer<typeof ConnectorRecipeSchema>;

export const ConnectorRecipePinsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  ConnectorWorkflowOverridesSchema,
).default({});

export const ConnectorCredentialChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('replace'), secret: z.string().min(1).max(16_384) }).strict(),
  z.object({ action: z.literal('clear'), confirm: z.literal(true) }).strict(),
  // Opaque tenant-owned Secret Catalog ID. The server imports it into a new
  // Connector Vault version; callers never provide or receive Vault paths.
  z.object({ action: z.literal('vault-ref'), reference: z.string().uuid() }).strict(),
]);

export const ConnectorDraftUpsertSchema = z.object({
  tenantId: UuidSchema,
  expectedHeadRevision: z.number().int().min(0),
  recipe: ConnectorRecipeSchema,
  credentialChange: ConnectorCredentialChangeSchema,
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type ConnectorDraftUpsert = z.infer<typeof ConnectorDraftUpsertSchema>;

export const ConnectorCredentialStageSchema = z.object({
  expectedHeadRevision: z.number().int().min(1),
  change: ConnectorCredentialChangeSchema,
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type ConnectorCredentialStage = z.infer<typeof ConnectorCredentialStageSchema>;

export const ProviderTestRequestSchema = z.object({
  tenantId: UuidSchema,
  apiKeyId: UuidSchema,
  profileId: UuidSchema,
  expectedProfileRevision: z.number().int().min(1),
  businessId: z.string().min(1).max(128),
  businessVersion: z.string().min(1).max(64),
  action: z.string().min(1).max(128),
  endpointSlug: z.string().min(1).max(128),
  connectorId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  /** Required only for a platform-admin test of an unbound PENDING candidate. */
  bindingSlot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
  model: z.string().min(1).max(256).optional(),
  prompt: z.string().min(1).max(32_000),
  parameters: z.record(z.string().min(1).max(128), z.unknown()).default({}).superRefine((parameters, ctx) => {
    const serialized = (() => { try { return JSON.stringify(parameters); } catch { return null; } })();
    if (serialized === null || serialized.length > 32_768) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'test parameters must be JSON serializable and at most 32 KiB' });
    }
    const sensitive = /(?:^|[^a-z0-9])(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|source[_-]?url|endpoint[_-]?url)(?:$|[^a-z0-9])/i;
    const check = (value: unknown, depth: number): boolean => {
      if (depth > 8) return false;
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return typeof value !== 'string' || value.length <= 8_192;
      if (typeof value === 'number') return Number.isFinite(value);
      if (Array.isArray(value)) return value.length <= 128 && value.every((entry) => check(entry, depth + 1));
      if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        return entries.length <= 128 && entries.every(([key, entry]) => key.length <= 128 && key !== '__proto__' && key !== 'constructor' && !sensitive.test(key) && check(entry, depth + 1));
      }
      return false;
    };
    if (!check(parameters, 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'test parameters contain an unsupported or oversized value' });
  }),
  artifactIds: z.array(UuidSchema).max(4).default([]),
  timeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  idempotencyKey: z.string().min(8).max(200),
}).strict();
export type ProviderTestRequest = z.infer<typeof ProviderTestRequestSchema>;

/** Short-lived signed Connector-only grant. The test runner requires every field to match the request and stored revision. */
export const ProviderTestGrantClaimsSchema = z.object({
  audience: z.literal('connector'),
  purpose: z.literal('admin-provider-test'),
  tenantId: UuidSchema,
  apiKeyId: UuidSchema,
  profileId: UuidSchema,
  businessId: z.string().min(1).max(128),
  businessVersion: z.string().min(1).max(64),
  endpointSlug: z.string().min(1).max(128),
  connectorId: z.string().min(1).max(128),
  connectorRevision: z.number().int().min(1),
  revisionState: z.enum(['PENDING', 'ACTIVE']),
  operationId: UuidSchema,
  taskId: UuidSchema,
  invocationId: UuidSchema,
  inputHash: z.string().min(1).max(256),
  bindingSlot: z.string().min(1).max(256),
  reservationGroupId: UuidSchema,
  costContext: InvocationCostContextSchema,
  allowedModel: z.string().min(1).max(256).optional(),
  artifactIds: z.array(UuidSchema).max(4),
  artifactPins: z.array(InvocationArtifactPinWithGenerationSchema).max(4),
  exp: z.number().int().positive(),
  iat: z.number().int().nonnegative(),
}).strict().superRefine((claims, ctx) => {
  if (claims.costContext.budgetReservationGroupId !== claims.reservationGroupId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costContext', 'budgetReservationGroupId'], message: 'reservation group must match the signed cost context' });
  }
  if (claims.costContext.selectionState !== 'DEFERRED'
      || claims.costContext.budgetPins.length !== 0
      || claims.costContext.priceRevision !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costContext'], message: 'provider-test grants defer mutable budget and price selection to Connector preflight' });
  }
  if (claims.costContext.apiKeyId !== claims.apiKeyId || claims.costContext.profileId !== claims.profileId
      || claims.costContext.businessId !== claims.businessId || claims.costContext.businessVersion !== claims.businessVersion) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costContext'], message: 'cost scope must match the provider-test grant scope' });
  }
  if (claims.artifactIds.length !== claims.artifactPins.length || claims.artifactIds.some((id, index) => id !== claims.artifactPins[index]?.artifactId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactPins'], message: 'artifact pins must exactly match signed artifact IDs' });
  }
  if (new Set(claims.artifactIds).size !== claims.artifactIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: 'artifact IDs must be unique' });
  }
});
export type ProviderTestGrantClaims = z.infer<typeof ProviderTestGrantClaimsSchema>;

export const ProviderTestInvocationRequestSchema = z.object({
  grant: z.string().min(1).max(16_384),
  input: InvocationInputSchema,
  deadlineAt: z.string().datetime(),
}).strict();
export type ProviderTestInvocationRequest = z.infer<typeof ProviderTestInvocationRequestSchema>;

export const ProviderTestResultSchema = z.object({
  invocationId: UuidSchema,
  state: z.enum(['SUCCEEDED', 'FAILED', 'UNKNOWN']),
  statusCode: z.number().int().min(100).max(599).nullable(),
  content: z.string().max(16_384).nullable(),
  contentTruncated: z.boolean(),
  /** Connector's credential-aware sanitizer marked this durable result safe. */
  contentSanitized: z.literal(true).optional(),
  latencyMs: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  usageEventId: z.string().min(1).max(256).nullable(),
  errorCode: z.string().regex(/^[A-Z0-9_-]{1,48}$/).nullable(),
}).strict().superRefine((result, context) => {
  if (result.content !== null && result.contentSanitized !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentSanitized'], message: 'provider-test content requires Connector sanitization evidence' });
  }
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

export const ConnectorUnknownEvidenceSchema = z.object({
  tenantId: UuidSchema,
  invocationId: UuidSchema,
  connectorId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  expectedStateVersion: z.number().int().min(1),
  evidenceKind: z.enum(['provider-request-id', 'provider-status', 'usage-receipt', 'artifact-hash']),
  evidenceRef: z.string().min(1).max(512),
  amountMicros: z.string().regex(/^(0|[1-9][0-9]{0,17})$/).nullable(),
  outcome: z.enum(['effect-confirmed', 'no-effect-confirmed']),
  reason: z.string().min(8).max(500),
}).strict();
export type ConnectorUnknownEvidence = z.infer<typeof ConnectorUnknownEvidenceSchema>;

export const ConnectorParityRevisionSchema = z.object({
  tenantId: UuidSchema,
  connectorId: z.string().min(1),
  revision: z.number().int().min(1),
  state: ConnectorRevisionStateSchema,
  recipe: ConnectorRecipeSchema,
  credentialRef: z.string().min(1).nullable(),
  credentialVersion: z.number().int().min(1).nullable(),
  expectedHeadRevision: z.number().int().min(0),
}).strict();
export type ConnectorParityRevision = z.infer<typeof ConnectorParityRevisionSchema>;

export const ConnectorParityDraftResultSchema = z.object({
  revision: ConnectorParityRevisionSchema,
  expectedHeadRevision: z.number().int().min(0),
  replayed: z.boolean(),
}).strict();
export type ConnectorParityDraftResult = z.infer<typeof ConnectorParityDraftResultSchema>;

export const ConnectorParityActivationResultSchema = z.object({
  activated: z.boolean(),
  currentRevision: z.number().int().min(1).nullable(),
}).strict();
export type ConnectorParityActivationResult = z.infer<typeof ConnectorParityActivationResultSchema>;

export const ParityIdentityUserResponseSchema = z.object({ user: IdentityUserSchema }).strict();
export type ParityIdentityUserResponse = z.infer<typeof ParityIdentityUserResponseSchema>;
