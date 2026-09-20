import { z } from 'zod';
import { OperationStateSchema } from './operations';

/**
 * Public API DTOs (docs 06): pagination, submission response, webhook payload.
 */

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export const PageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageOf<T>(items: T[], nextCursor: string | null): { items: T[]; nextCursor: string | null } {
  return { items, nextCursor };
}

export const ListOperationsQuerySchema = PageQuerySchema.extend({
  state: OperationStateSchema.optional(),
});
export type ListOperationsQuery = z.infer<typeof ListOperationsQuerySchema>;

/* ------------------------------------------------------------------ */
/* Submission response                                                 */
/* ------------------------------------------------------------------ */

export const SubmitAckSchema = z.object({
  operationId: z.string().uuid(),
  state: OperationStateSchema,
  stateVersion: z.number().int().min(0),
  /** true when an idempotent replay returned an existing operation (200 vs 202). */
  replayed: z.boolean().default(false),
  correlationId: z.string(),
  links: z.object({
    self: z.string(),
    result: z.string(),
  }),
});
export type SubmitAck = z.infer<typeof SubmitAckSchema>;

/* ------------------------------------------------------------------ */
/* Webhook (docs 06): at-least-once, signed, dedup by deliveryId       */
/* ------------------------------------------------------------------ */

export const WebhookEventTypes = [
  'operation.succeeded',
  'operation.failed',
  'operation.cancelled',
  'operation.timed-out',
] as const;
export type WebhookEventType = (typeof WebhookEventTypes)[number];

export const WebhookPayloadSchema = z
  .object({
    deliveryId: z.string().min(1),
    eventType: z.enum(WebhookEventTypes),
    operationId: z.string().uuid(),
    state: OperationStateSchema,
    stateVersion: z.number().int().min(0),
    occurredAt: z.string(),
  })
  .strict();
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/** Webhook signature scheme: HMAC-SHA256 over `{timestamp}.{body}`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-du-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-du-timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'x-du-delivery-id';

export function webhookSigningPayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/* ------------------------------------------------------------------ */
/* Artifact metadata (public GET /artifacts/{id})                      */
/* ------------------------------------------------------------------ */

export const ArtifactState = ['STAGING', 'READY', 'EXPIRED', 'DELETED'] as const;
export type ArtifactState = (typeof ArtifactState)[number];
export const ArtifactStateSchema = z.enum(ArtifactState);

export const ArtifactMetadataSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string(),
  operationId: z.string().uuid().nullable().optional(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  state: ArtifactStateSchema,
  fileName: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().nullable().optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

/* ------------------------------------------------------------------ */
/* Business catalog (public GET /businesses)                           */
/* ------------------------------------------------------------------ */

export const PublicBusinessActionSchema = z.object({
  businessId: z.string(),
  version: z.string(),
  action: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  capabilities: z.object({ cancel: z.boolean(), resume: z.boolean() }),
  artifactPolicy: z.object({
    minFiles: z.number().int(),
    maxFiles: z.number().int(),
    acceptedMimeTypes: z.array(z.string()).optional(),
  }),
});
export type PublicBusinessAction = z.infer<typeof PublicBusinessActionSchema>;