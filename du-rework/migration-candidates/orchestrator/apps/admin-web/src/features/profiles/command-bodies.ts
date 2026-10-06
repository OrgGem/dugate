import type {
  ApiKeyIdRef,
  PolicyUpsertBody,
  ProfileDetail,
  ProfilePublishBody,
  ProfileRollbackBody,
} from '@/lib/api';

/**
 * P745-UI-KEYS (Δ-UI-1, T-API-01 closure follow-up) — the command bodies that
 * carry the write identity the detail read revealed.
 *
 * The three `profile.*` commands are strict and ALL require `apiKey`
 * (Δ7-A ProfileCommandKeyShape): the URL's (business, version, name) cannot
 * select a row on its own. This module is the ONE place that maps the
 * detail read onto those bodies, so the screen stays a thin caller and the
 * mapping is unit-testable without rendering React.
 *
 * Honest absence: a detail without `apiKeyId` (the `/new` sentinel, or a
 * profile not stored yet) produces a body WITHOUT `apiKey` — the dispatcher
 * then answers 422 INVALID_SCHEMA (fail-closed), never a silent wrong row.
 */

export function apiKeyRefFromDetail(
  detail: Pick<ProfileDetail, 'apiKeyId'> | null | undefined
): ApiKeyIdRef | undefined {
  const id = detail?.apiKeyId;
  return typeof id === 'string' && id.length > 0 ? { apiKeyId: id } : undefined;
}

/** `profile.upsert` body: CAS baseline + policy + write identity. */
export function buildUpsertBody(
  detail: ProfileDetail,
  policy: Record<string, unknown>
): PolicyUpsertBody {
  const apiKey = apiKeyRefFromDetail(detail);
  return {
    expectedRevision: detail.revision,
    policy,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

/** `profile.publish` body: the CAS move + write identity. */
export function buildPublishBody(detail: ProfileDetail): ProfilePublishBody {
  const apiKey = apiKeyRefFromDetail(detail);
  return {
    expectedRevision: detail.revision,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}

/**
 * `profile.rollback` body: pointer move + write identity.
 *
 * `expectedRevision` carries the detail's revision UNCONDITIONALLY (parity
 * with the pre-Δ-UI-1 call site, which always sent it) — a stale view still
 * answers 409 instead of silently moving the pointer.
 */
export function buildRollbackBody(
  detail: ProfileDetail,
  targetRevision: number
): ProfileRollbackBody {
  const apiKey = apiKeyRefFromDetail(detail);
  return {
    targetRevision,
    expectedRevision: detail.revision,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
}
