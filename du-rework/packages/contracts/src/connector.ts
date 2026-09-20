import { z } from 'zod';

/**
 * Connector invocation wire contract v1 (docs 08). POST /internal/v1/invocations.
 * Aligned with the error taxonomy and state set the connector lane implements.
 */

export const InvocationInputSchema = z
  .object({
    prompt: z.string().optional(),
    text: z.string().optional(),
    artifacts: z.array(z.object({ artifactId: z.string().uuid() })).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type InvocationInput = z.infer<typeof InvocationInputSchema>;

export const InvocationOptionsSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    model: z.string().optional(),
    maxTokens: z.number().int().min(1).optional(),
  })
  .passthrough();
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
    exp: z.number().int(), // unix seconds
    iat: z.number().int(),
  })
  .strict();
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