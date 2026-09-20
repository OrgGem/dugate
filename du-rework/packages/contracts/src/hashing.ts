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
}

export function canonicalRequestHash(parts: CanonicalRequestParts): string {
  const artifacts = (parts.artifacts ?? [])
    .map((a) => ({ role: a.role, sha256: a.sha256 ?? a.artifactId ?? '' }))
    .sort((x, y) => (x.role < y.role ? -1 : x.role > y.role ? 1 : x.sha256 < y.sha256 ? -1 : 1));
  const payload = {
    v: 1,
    input: parts.input ?? null,
    artifacts,
    output: parts.output ?? null,
    callback: parts.callback?.url ?? null,
  };
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