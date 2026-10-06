import { hashInvocationInput as canonicalInvocationHash } from '@du/contracts';
import type { LocalInvocationRequest } from './types';

/**
 * Canonical Connector invocation input hash (W11-C1 / R08-02).
 *
 * Delegates to the single source of truth in @du/contracts so the SDK (which
 * hashes the outgoing wire payload), the Orchestrator (which signs the hash
 * into grant claims) and the Connector (which re-derives it from the verified
 * request here) cannot drift apart again. The `sha256:` multihash-style prefix
 * is part of the canonical digest on all three sides.
 */
export function canonicalInput(request: LocalInvocationRequest): string {
  const digest = canonicalInvocationHash({
    contractVersion: request.contractVersion,
    tenantId: request.tenantId,
    operationId: request.operationId,
    taskId: request.taskId,
    stepKey: request.stepKey,
    bindingSlot: request.bindingSlot,
    input: request.input,
    options: request.options,
    sessionRef: request.sessionRef,
    deadlineAt: request.deadlineAt,
  });
  return digest;
}

export function hashInvocationInput(request: LocalInvocationRequest): string {
  return canonicalInput(request);
}
