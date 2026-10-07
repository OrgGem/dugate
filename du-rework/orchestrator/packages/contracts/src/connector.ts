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
export type InvocationArtifactPin = z.infer<typeof InvocationArtifactPinSchema>;

export const InvocationInputSchema = z
  .object({
    prompt: z.string().optional(),
    text: z.string().optional(),
    task: z.string().min(1).max(128).optional(),
    language: z.string().min(1).max(64).optional(),
    artifacts: z.array(InvocationArtifactContentSchema).max(CONNECTOR_ARTIFACT_MAX_COUNT).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
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
    sessionRef: z.string().nullable().optional(),
    deadlineAt: z.string(), // RFC3339; HTTP deadline never extends operation deadline
  })
  .strict();
export type InvocationRequest = z.infer<typeof InvocationRequestSchema>;

export const InvocationUsageSchema = z.object({
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  pages: z.number().int().min(0).optional(),
  costMicrousd: z.number().int().min(0).default(0),
  measurement: z.enum(['measured', 'estimated']),
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
    artifactPins: z.array(InvocationArtifactPinSchema).max(CONNECTOR_ARTIFACT_MAX_COUNT).optional(),
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
