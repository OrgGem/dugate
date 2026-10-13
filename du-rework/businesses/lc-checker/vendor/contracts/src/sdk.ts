import { z } from 'zod';

/**
 * SDK-facing wire DTOs (docs 09). TaskDisposition is what a business handler
 * returns; the worker-sdk maps each disposition onto runtime API calls.
 * The TaskContext *interface* (methods/facades) lives in @du/worker-sdk —
 * contracts owns only the serializable shapes.
 */

export const ArtifactRefDispositionSchema = z.object({
  artifactId: z.string().uuid(),
  role: z.string().default('output'),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  hashSha256: z.string().optional(),
});
export type ArtifactRefDisposition = z.infer<typeof ArtifactRefDispositionSchema>;

export const TaskDispositionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    resultRef: z.string().min(1),
    artifacts: z.array(ArtifactRefDispositionSchema).optional(),
  }),
  z.object({ kind: z.literal('waiting-children') }),
  z.object({ kind: z.literal('waiting-input'), waitId: z.string().min(1) }),
  z.object({ kind: z.literal('retry-scheduled') }),
]);
export type TaskDisposition = z.infer<typeof TaskDispositionSchema>;

/** Handler kinds every business must declare in its manifest runtime block. */
export const WellKnownHandlerKinds = ['root'] as const;

/**
 * Retry classification reported by SDK → runtime (docs 04: runtime owns the
 * retry budget; the SDK only classifies).
 */
export const RetryClassificationSchema = z.object({
  retryable: z.boolean(),
  errorCode: z.string().min(1),
  retryAfterMs: z.number().int().min(0).optional(),
  detail: z.string().max(2048).optional(),
});
export type RetryClassification = z.infer<typeof RetryClassificationSchema>;

/** Join policies — v1 supports only all-success (docs 07). */
export const JoinPolicies = ['all-success'] as const;
export type JoinPolicy = (typeof JoinPolicies)[number];
export const JoinPolicySchema = z.enum(JoinPolicies);
