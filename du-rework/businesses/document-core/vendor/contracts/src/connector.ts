import { z } from 'zod';

/**
 * Connector invocation wire contract v1 (docs 08). POST /internal/v1/invocations.
 * Aligned with the error taxonomy and state set the connector lane implements.
 */

export const CONNECTOR_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const CONNECTOR_ARTIFACT_MAX_COUNT = 4;
export const CONNECTOR_INVOCATION_MAX_BODY_BYTES = 15 * 1024 * 1024;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Verified source content carried to OCR/vision providers. The storage
 * version and digest bind these bytes to the grant that authorized the read. */
const InvocationArtifactBaseSchema = z.object({
  artifactId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/).max(127),
  sizeBytes: z.number().int().min(1).max(CONNECTOR_ARTIFACT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageVersionId: z.string().min(1).max(1024),
  contentBase64: z.string().max(Math.ceil(CONNECTOR_ARTIFACT_MAX_BYTES / 3) * 4).regex(BASE64_PATTERN),
}).strict();

export const InvocationArtifactContentSchema = InvocationArtifactBaseSchema.superRefine((artifact, context) => {
  const padding = artifact.contentBase64.endsWith('==') ? 2 : artifact.contentBase64.endsWith('=') ? 1 : 0;
  const decodedSizeBytes = (artifact.contentBase64.length / 4) * 3 - padding;
  if (
    artifact.contentBase64.length !== Math.ceil(artifact.sizeBytes / 3) * 4 ||
    decodedSizeBytes !== artifact.sizeBytes
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentBase64'], message: 'Base64 length does not match sizeBytes.' });
  }
});
export type InvocationArtifactContent = z.infer<typeof InvocationArtifactContentSchema>;

/** Storage identity signed into the short-lived invocation grant. */
export const InvocationArtifactPinSchema = InvocationArtifactBaseSchema.omit({ contentBase64: true });
export const InvocationArtifactPinWithGenerationSchema = InvocationArtifactPinSchema.extend({
  /** Optional opaque storage generation UUID. It contains no storage key and
   * is additive so pre-generation grants remain wire compatible. */
  storageGenerationId: z.string().uuid().nullable().optional(),
});
export type InvocationArtifactPin = z.infer<typeof InvocationArtifactPinWithGenerationSchema>;

const WorkflowOverrideNameSchema = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const WorkflowStaticValueSchema = z.string().max(512).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value)
    && !/^(?:bearer\s+|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})/i.test(value),
  'workflow static values must be bounded non-secret text without control characters',
);
const WorkflowHeaderValueSchema = z.string().max(256).regex(/^[\x20-\x7e]*$/);
const WorkflowHeaderNameSchema = z.string().min(1).max(64).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).superRefine((name, context) => {
  const lowered = name.toLowerCase();
  const reserved = new Set([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length',
    'transfer-encoding', 'connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer',
    'expect', 'forwarded', 'via', 'origin', 'referer', 'content-type', 'idempotency-key',
    'api-key', 'x-api-key', 'x-goog-api-key', 'x-auth-token', 'x-tenant-id',
  ]);
  if (reserved.has(lowered) || lowered.startsWith('x-forwarded-') || lowered.startsWith('proxy-')
    || lowered.startsWith('x-auth-') || lowered.startsWith('x-provider-')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'workflow header is reserved or can affect identity/routing' });
  }
});

/** A workflow recipe leaf compiled at admission. Values are static text only;
 * dynamic prompt/input values remain in InvocationInput and provider routes,
 * credentials, and arbitrary URL configuration never enter this shape. */
export const ConnectorWorkflowOverridesSchema = z.object({
  connectorId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  connectorRevision: z.number().int().min(1),
  recipeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  staticFormFields: z.array(z.object({ name: WorkflowOverrideNameSchema, value: WorkflowStaticValueSchema }).strict()).max(32),
  extraHeaders: z.array(z.object({ name: WorkflowHeaderNameSchema, value: WorkflowHeaderValueSchema }).strict()).max(16),
}).strict().superRefine((recipe, context) => {
  const fields = recipe.staticFormFields.map((field) => field.name.toLowerCase());
  if (new Set(fields).size !== fields.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['staticFormFields'], message: 'static workflow field names must be unique' });
  }
  const headers = recipe.extraHeaders.map((header) => header.name.toLowerCase());
  if (new Set(headers).size !== headers.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['extraHeaders'], message: 'workflow header names must be unique case-insensitively' });
  }
});
export type ConnectorWorkflowOverrides = z.infer<typeof ConnectorWorkflowOverridesSchema>;

/** Tenant-scoped retirement of one immutable typed recipe revision. The
 * caller must perform profile/operation reference checks before issuing this
 * command; Connector supplies CAS, tenant ownership, and exact replay. */
export const ConnectorParityRetirementRequestSchema = z.object({
  tenantId: z.string().uuid(),
  expectedCurrentRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(200),
  reason: z.enum(['OPERATOR_RETIRE', 'LEGACY_DISABLED_IMPORT', 'PROFILE_UNBOUND']),
}).strict();
export type ConnectorParityRetirementRequest = z.infer<typeof ConnectorParityRetirementRequestSchema>;

export const ConnectorParityRetirementResultSchema = z.object({
  retired: z.boolean(),
  currentRevision: z.number().int().min(1).nullable(),
}).strict();
export type ConnectorParityRetirementResult = z.infer<typeof ConnectorParityRetirementResultSchema>;

/** Provisional cost scope signed at grant issuance. The Connector's first
 * authenticated preflight freezes current policy/price revisions before the
 * provider call; secret material, endpoint URLs and provider payloads have no
 * representation here. */
export const InvocationCostBudgetPinSchema = z.object({
  budgetId: z.string().uuid(),
  revision: z.number().int().min(1),
}).strict();
export type InvocationCostBudgetPin = z.infer<typeof InvocationCostBudgetPinSchema>;

export const InvocationCostContextSchema = z.object({
  /** Signed grants carry deferred scope; preflight replies carry FROZEN. */
  selectionState: z.literal('DEFERRED'),
  apiKeyId: z.string().uuid().nullable(),
  profileId: z.string().uuid().nullable(),
  profileRevision: z.number().int().min(1).nullable(),
  businessId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  businessVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  action: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/),
  attempt: z.number().int().min(1),
  priceRevision: z.null(),
  budgetReservationGroupId: z.string().uuid(),
  budgetPins: z.array(InvocationCostBudgetPinSchema).max(32),
}).strict().superRefine((context, ctx) => {
  if (context.budgetPins.length !== 0 || context.priceRevision !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['budgetPins'], message: 'signed grants carry provisional scope only; policy pins are selected by preflight' });
  }
});
export type InvocationCostContext = z.infer<typeof InvocationCostContextSchema>;

/* Canonical action parameters are data, not provider request passthrough. They
 * are admitted against the immutable action manifest upstream, then bounded
 * again here before mapping. Credential, routing, and transport fields are
 * deliberately excluded by key name at every nesting level. */
const InvocationParameterScalarSchema = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(16_384),
]);
const INVOCATION_PARAMETER_SENSITIVE_KEY = /(?:secret|password|passwd|token|credential|authorization|api[_-]?key|cookie|session|endpoint|url|uri|host|proxy|header|request[_-]?config)/i;
function invocationParameterValueSchema(depth: number): z.ZodTypeAny {
  if (depth <= 0) return InvocationParameterScalarSchema;
  const nested = invocationParameterValueSchema(depth - 1);
  const record = z.record(z.string().min(1).max(128), nested).superRefine((value, context) => {
    if (Object.keys(value).length > 128) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action parameter object has too many keys' });
    for (const key of Object.keys(value)) {
      if (INVOCATION_PARAMETER_SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'action parameter key is sensitive or unsafe' });
      }
    }
  });
  return z.union([InvocationParameterScalarSchema, z.array(nested).max(128), record]);
}
const InvocationParameterValueSchema = invocationParameterValueSchema(5);
const InvocationParametersSchema = z.record(z.string().min(1).max(128), InvocationParameterValueSchema)
  .superRefine((parameters, context) => {
    if (Object.keys(parameters).length > 128) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action parameters have too many keys' });
    for (const key of Object.keys(parameters)) {
      if (INVOCATION_PARAMETER_SENSITIVE_KEY.test(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'action parameter key is sensitive or unsafe' });
      }
    }
    const visit = (value: unknown, depth: number): number => {
      if (depth > 5) return Number.MAX_SAFE_INTEGER;
      if (Array.isArray(value)) return 1 + value.reduce((total, item) => total + visit(item, depth + 1), 0);
      if (value !== null && typeof value === 'object') {
        return 1 + Object.values(value).reduce((total, item) => total + visit(item, depth + 1), 0);
      }
      return 1;
    };
    const nodeCount = visit(parameters, 0);
    if (nodeCount > 2048) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action parameters exceed the item limit' });
    let bytes = Number.MAX_SAFE_INTEGER;
    try { bytes = new TextEncoder().encode(JSON.stringify(parameters)).byteLength; } catch { /* rejected below */ }
    if (bytes > 65_536) context.addIssue({ code: z.ZodIssueCode.custom, message: 'action parameters exceed the encoded size limit' });
  });

export const InvocationInputSchema = z
  .object({
    prompt: z.string().optional(),
    text: z.string().optional(),
    task: z.string().min(1).max(128).optional(),
    language: z.string().min(1).max(64).optional(),
    artifacts: z.array(InvocationArtifactContentSchema).max(CONNECTOR_ARTIFACT_MAX_COUNT).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    parameters: InvocationParametersSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const totalBytes = (input.artifacts ?? []).reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (totalBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'Artifact payload exceeds the total size limit.' });
    }
    const ids = (input.artifacts ?? []).map((artifact) => artifact.artifactId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifacts'], message: 'Artifact IDs must be unique.' });
    }
  });
export type InvocationInput = z.infer<typeof InvocationInputSchema>;

/**
 * P745-CONNECTOR-PASSTHROUGH (T5): explicit, closed option set. The typed
 * keys plus the two connector passthrough keys the business layer actually
 * sends (`responseFormat`/`jsonSchema`) are the entire surface forwarded to
 * a provider and hashed into the canonical invocation input. Anything else
 * is rejected at both wire ends (SDK outbound + connector inbound) instead
 * of silently extending the provider payload and the invocation identity.
 */
export const InvocationOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    model: z.string().optional(),
    maxTokens: z.number().int().min(1).optional(),
    responseFormat: z.enum(['json', 'text']).optional(),
    jsonSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type InvocationOptions = z.infer<typeof InvocationOptionsSchema>;

export const InvocationRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    invocationId: z.string().min(1), // runtime-issued; stable across transport retries
    grant: z.string().min(1), // signed short-lived token
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    stepKey: z.string().min(1),
    bindingSlot: z.string().min(1),
    input: InvocationInputSchema,
    options: InvocationOptionsSchema.optional(),
    /** Compiled recipe leaf is separate from worker-controlled options. */
    workflowOverrides: ConnectorWorkflowOverridesSchema.optional(),
    sessionRef: z.string().nullable().optional(),
    deadlineAt: z.string(), // RFC3339; HTTP deadline never extends operation deadline
  })
  .strict();
export type InvocationRequest = z.infer<typeof InvocationRequestSchema>;

export const InvocationUsageSchema = z.object({
  inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  cachedInputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  pages: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  costMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  measurement: z.enum(['measured', 'estimated']),
}).superRefine((usage, context) => {
  if (usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['cachedInputTokens'], message: 'cachedInputTokens cannot exceed inputTokens' });
  }
});
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>;

export const InvocationResultSchema = z.object({
  content: z.string().optional(),
  data: z.unknown().optional(),
  artifacts: z.array(z.object({ artifactId: z.string().uuid(), role: z.string() })).optional(),
  sessionRef: z.string().nullable().optional(),
});
export type InvocationResult = z.infer<typeof InvocationResultSchema>;

export const InvocationResponseSchema = z.object({
  invocationId: z.string().min(1),
  state: z.enum(['NEW', 'IN_FLIGHT', 'PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED']),
  result: InvocationResultSchema.nullable().optional(),
  usage: InvocationUsageSchema.nullable().optional(),
  providerRequestId: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterMs: z.number().int().min(0).optional(),
    })
    .nullable()
    .optional(),
  /** Provider async: poll hint (202 semantics). */
  nextPollAt: z.string().nullable().optional(),
  /**
   * CR06-04: continuation session for THIS invocation. A provider may return
   * a sessionRef in an async 202 accept body (not only in the final result);
   * the connector persists it on the pending record, echoes it on every
   * PENDING response, and keeps it as the invocation's session when the final
   * result omits one. Additive optional — absent keeps the pre-CR06-04 wire
   * shape byte-identical.
   */
  sessionRef: z.string().nullable().optional(),
});
export type InvocationResponse = z.infer<typeof InvocationResponseSchema>;

/** Source-bound recovery view for an administrative provider test. This is a
 * read of the Connector's durable invocation ledger and usage outbox; callers
 * cannot supply an outcome, amount, provider request ID, or result. A positive
 * replay is permitted only when both the mapped result and its exact outbox
 * event were persisted for the pinned tenant/operation/task/invocation. */
export const ConnectorProviderTestEvidenceQuerySchema = z.object({
  tenantId: z.string().uuid(),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  invocationId: z.string().uuid(),
  connectorId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
}).strict();
export type ConnectorProviderTestEvidenceQuery = z.infer<typeof ConnectorProviderTestEvidenceQuerySchema>;

export const ConnectorProviderTestEvidenceSchema = z.object({
  tenantId: z.string().uuid(),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  invocationId: z.string().uuid(),
  connectorId: z.string().min(1).max(128),
  revision: z.number().int().min(1),
  state: z.enum(['IN_FLIGHT', 'PENDING', 'POLLING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED']),
  stateVersion: z.number().int().min(1),
  updatedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().regex(/^[A-Z0-9_-]{1,48}$/).nullable(),
  result: z.object({
    content: z.string().max(16_384).nullable(),
    /** Present only when Connector's credential-aware result sanitizer ran. */
    contentSanitized: z.literal(true).optional(),
    contentTruncated: z.boolean(),
    statusCode: z.number().int().min(100).max(599).nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    providerRequestId: z.string().max(512).nullable(),
    resultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict().nullable(),
  usageEvent: z.object({
    eventId: z.string().min(1).max(256),
    payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    costMicrousd: z.number().int().min(0).nullable(),
    measurement: z.enum(['measured', 'estimated']).nullable(),
    costStatus: z.enum(['measured', 'estimated', 'unpriced', 'pending']).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    deliveredAt: z.string().datetime({ offset: true }).nullable(),
  }).strict().nullable(),
  evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  recoveryReady: z.boolean(),
}).strict().superRefine((evidence, context) => {
  if (evidence.recoveryReady && (evidence.state !== 'SUCCEEDED' || evidence.result === null || evidence.usageEvent === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['recoveryReady'], message: 'positive recovery requires a persisted successful result and linked usage event' });
  }
  if (evidence.usageEvent !== null && evidence.result === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['usageEvent'], message: 'usage evidence cannot outlive its persisted invocation result' });
  }
  if (evidence.result !== null && evidence.result.content !== null && evidence.result.contentSanitized !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['result', 'contentSanitized'], message: 'provider-test content requires Connector sanitization evidence' });
  }
});
export type ConnectorProviderTestEvidence = z.infer<typeof ConnectorProviderTestEvidenceSchema>;

/**
 * Invocation grant claims (docs 08): the grant binds tenant, operation/task/step,
 * invocationId, inputHash, connector revision, allowed options/model, artifact
 * IDs, expiry and audience. Worker input cannot override connector URL/headers/auth.
 */
export const InvocationGrantClaimsSchema = z
  .object({
    audience: z.literal('connector'),
    tenantId: z.string(),
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    stepKey: z.string(),
    invocationId: z.string().min(1),
    inputHash: z.string().min(1),
    connectorId: z.string(),
    connectorRevision: z.number().int(),
    bindingSlot: z.string(),
    allowedModel: z.string().nullable().optional(),
    allowedOptions: z.record(z.string(), z.unknown()).optional(),
    artifactIds: z.array(z.string().uuid()).optional(),
    artifactPins: z.array(InvocationArtifactPinWithGenerationSchema).max(CONNECTOR_ARTIFACT_MAX_COUNT).optional(),
    /** Optional for legacy grants; new Orchestrator grants sign the full
     * immutable budget/price/attribution context used by the rich ledger. */
    costContext: InvocationCostContextSchema.optional(),
    /** Signed binding for a compiled node recipe. The invocation carries the
     * leaf separately and must recompute this tenant/revision/invocation hash. */
    workflowOverridesDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    exp: z.number().int(), // unix seconds
    iat: z.number().int(),
  })
  .strict()
  .superRefine((claims, context) => {
    if (claims.artifactIds && new Set(claims.artifactIds).size !== claims.artifactIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: 'Artifact IDs must be unique.' });
    }
    if ((claims.artifactIds?.length ?? 0) > 0 && !claims.artifactPins) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactPins'], message: 'Artifact IDs require signed storage pins.' });
      return;
    }
    if (!claims.artifactPins) return;
    const pinIds = claims.artifactPins.map((pin) => pin.artifactId);
    if (new Set(pinIds).size !== pinIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactPins'], message: 'Artifact pins must be unique.' });
    }
    if (claims.artifactIds && (claims.artifactIds.length !== pinIds.length || claims.artifactIds.some((id, index) => id !== pinIds[index]))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: 'Artifact IDs do not match the signed pins.' });
    }
  });
export type InvocationGrantClaims = z.infer<typeof InvocationGrantClaimsSchema>;

/** Connector capability catalog entry (GET /capabilities). */
export const ConnectorCapabilitySchema = z.object({
  adapterId: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  maxInputBytes: z.number().int().min(0).optional(),
  supportsAsyncPoll: z.boolean().default(false),
  supportsIdempotencyKey: z.boolean().default(false),
});
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;
