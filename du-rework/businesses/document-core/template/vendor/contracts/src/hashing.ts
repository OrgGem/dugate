// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/contracts/src/hashing.ts (lines=95) sha256=A0FFAFE5219F760F1ECED9DF6C5FC2256A18B073775549275BC390B5C92ED6E7
// why: contentHash, hashInvocationInput for vendored worker-sdk

import { createHash } from 'node:crypto';
import { canonicalize } from './manifest-validator';

/**
 * Canonical request hashing (docs 06 idempotency, P1 required tests).
 *
 * The idempotency request hash covers normalized input + artifact content
 * identity + output + callback — NOT the client reference or correlation ID.
 * Same key + same hash → replay cached operation; same key + different hash → 409.
 */

export interface CanonicalRequestParts {
  /** Normalized action input (aliases folded to canonical route). */
  input: unknown;
  /** Artifact content identity: sha256 of each artifact, sorted by role+hash. */
  artifacts?: readonly { artifactId?: string; role: string; sha256?: string }[];
  output?: unknown;
  callback?: { url: string } | null;
  sourceUrl?: string;
}

export function canonicalRequestHash(parts: CanonicalRequestParts): string {
  const artifacts = (parts.artifacts ?? [])
    .map((a) => ({ role: a.role, sha256: a.sha256 ?? a.artifactId ?? '' }))
    .sort((x, y) => (x.role < y.role ? -1 : x.role > y.role ? 1 : x.sha256 < y.sha256 ? -1 : 1));
  const payload: Record<string, unknown> = {
    v: 1,
    input: parts.input ?? null,
    artifacts,
    output: parts.output ?? null,
    callback: parts.callback?.url ?? null,
  };
  // Keep legacy idempotency hashes stable when no URL source is supplied.
  if (parts.sourceUrl !== undefined) payload.sourceUrl = parts.sourceUrl;
  return `sha256:${createHash('sha256').update(canonicalize(payload)).digest('hex')}`;
}

/** Route action normalization: legacy alias routes fold to the generic route. */
export function normalizeRouteAction(
  businessId: string,
  action: string,
  alias?: string
): string {
  const canonicalAction = alias ?? action;
  return `${businessId}/${canonicalAction}`;
}

/** Generic content hash used for inputHash on steps/invocations. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

/**
 * Canonical Connector invocation input hash (W11-C1 / R08-02).
 *
 * Stable identity for a logical provider call is derived from the exact wire
 * fields the Connector receives and validates: the binding slot, connector
 * input, connector options, tenant/operation/task/step binding, session ref
 * and HTTP deadline. The SDK computes this over the payload it will send; the
 * Orchestrator signs the same value into the grant claims; the Connector
 * re-derives it from the verified request and rejects any mismatch. This
 * single source of truth removes the prior SDK/Connector field-set drift that
 * required a test-time hash bridge.
 */
export interface InvocationInputHashParts {
  contractVersion: '1';
  tenantId: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: unknown;
  options?: unknown;
  sessionRef?: string | null;
  deadlineAt: string;
}

export function hashInvocationInput(value: InvocationInputHashParts): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalize({
        contractVersion: value.contractVersion,
        tenantId: value.tenantId,
        operationId: value.operationId,
        taskId: value.taskId,
        stepKey: value.stepKey,
        bindingSlot: value.bindingSlot,
        input: value.input,
        options: value.options ?? {},
        sessionRef: value.sessionRef ?? null,
        deadlineAt: value.deadlineAt,
      })
    )
    .digest('hex')}`;
}
