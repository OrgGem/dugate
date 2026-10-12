import { createHash } from 'node:crypto';
import {
  InvocationCostContextSchema,
  type InvocationCostContext,
} from '@du/contracts';

/** A single admitted invocation identity. These fields are captured by the
 * trusted Orchestrator, never accepted from the browser or Connector proof. */
export interface InvocationCostContextInput {
  tenantId: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  invocationId: string;
  attempt: number;
  apiKeyId: string | null;
  profileId: string | null;
  profileRevision: number | null;
  businessId: string;
  businessVersion: string;
  action: string;
}

function uuidFromDigest(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  // Stable UUIDv5-shaped identifier. It is a dedupe identity, not a secret.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Construct the signed usage/cost attribution for one invocation. This
 * function deliberately does not read current policy or reserve quota. A
 * Connector's first authenticated post-render preflight selects and freezes
 * every active policy and the published price revision for this group. Policy
 * selection is not captured at operation admission, so a newly published cap
 * applies to the next invocation of an already accepted operation.
 */
export function createInvocationCostContext(input: InvocationCostContextInput): InvocationCostContext {
  const budgetReservationGroupId = uuidFromDigest(JSON.stringify([
    'dugate-cost-reservation-group-v1',
    input.tenantId,
    input.operationId,
    input.taskId,
    input.stepKey,
    input.bindingSlot,
    input.invocationId,
    input.attempt,
  ]));

  return InvocationCostContextSchema.parse({
    selectionState: 'DEFERRED',
    apiKeyId: input.apiKeyId,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    businessId: input.businessId,
    businessVersion: input.businessVersion,
    action: input.action,
    attempt: input.attempt,
    priceRevision: null,
    budgetReservationGroupId,
    budgetPins: [],
  });
}

