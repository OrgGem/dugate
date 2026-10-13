import { z } from 'zod';

/**
 * Queue wire contract (docs 09). BusinessJobV1 is the exact payload shape
 * placed on BullMQ queues named `du-business-{businessId}-{exactVersion}`.
 *
 * The job carries NO file bytes, raw prompts, provider secrets, long-lived
 * signed URLs, or full checkpoints — scoped refs are fetched via runtime
 * HTTP after claim.
 */

export const BusinessJobV1Schema = z
  .object({
    contractVersion: z.literal('1'),
    deliveryId: z.string().min(1), // stable, derived from outbox row
    taskId: z.string().uuid(),
    operationId: z.string().uuid(),
    businessId: z.string().min(1),
    businessVersion: z.string().min(1),
    action: z.string().min(1),
    kind: z.string().min(1), // registered handler kind
    correlationId: z.string().min(1),
    priority: z.number().optional(),
  })
  .strict();
export type BusinessJobV1 = z.infer<typeof BusinessJobV1Schema>;

/** Queue name is platform-generated only — never accepted from clients. */
export function businessQueueName(businessId: string, version: string): string {
  return `du-business-${businessId}-${version}`;
}

export const QUEUE_NAME_REGEX = /^du-business-[a-z][a-z0-9-]*-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isValidQueueName(name: string): boolean {
  return QUEUE_NAME_REGEX.test(name);
}

/**
 * BullMQ job ID convention: deterministic from deliveryId so at-least-once
 * re-enqueue dedups at the queue layer too (job IDs stable from outbox/delivery
 * ID, per docs 09).
 *
 * BullMQ rejects custom job IDs containing ':' (it is Redis's internal key
 * separator), so the deterministic ID uses '-' and folds any ':' in the
 * deliveryId (e.g. retry deliveryIds `taskId:retry:N`) to '-'. The mapping is
 * injective for our deliveryId charset, preserving determinism.
 */
export function jobIdForDelivery(deliveryId: string): string {
  return `du-${deliveryId.replace(/:/g, '-')}`;
}

/** Transport retry policy for queue delivery only (business retry is runtime-owned). */
export const QUEUE_TRANSPORT_RETRY = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
} as const;