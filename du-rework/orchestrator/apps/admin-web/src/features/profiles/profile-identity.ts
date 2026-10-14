import type { ProfileDetail, ProfileListRow } from '@/lib/api';

export type ProfileCatalogIdentity = Pick<
  ProfileListRow,
  'profileId' | 'tenantId' | 'businessId' | 'businessVersion' | 'profileName' | 'boundActions' | 'action' | 'endpointSlug'
>;

export type ProfileActionResolution =
  | { kind: 'resolved'; action: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

export type ProfileIdentityResolution =
  | { kind: 'resolved'; profileId: string; action: string; endpointSlug: string | null | undefined }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

export interface SavedProfileTarget {
  businessId: string;
  businessVersion: string;
  profileName: string;
  action: string;
  endpointSlug: string | null;
  profileId?: string;
}

export function actionFromEndpointSlug(endpointSlug: string): string | null {
  const action = endpointSlug.trim().split(':', 1)[0]?.trim();
  return action ? action : null;
}

export function firstManifestAction(detail: ProfileDetail): string | null {
  for (const item of detail.manifest.actions) {
    const action = item.name?.trim() || item.action?.trim();
    if (action) return action;
  }
  return null;
}

export function newProfileAction(detail: ProfileDetail, endpointSlug: string): string | null {
  return endpointSlug.trim().length > 0
    ? actionFromEndpointSlug(endpointSlug)
    : firstManifestAction(detail);
}

/** Replace sentinels such as `latest` with the concrete identity returned by the detail read. */
export function normalizeProfileTarget<T extends { businessId: string; businessVersion: string; profileName: string }>(
  target: T,
  detail: Pick<ProfileDetail, 'businessId' | 'businessVersion' | 'profileName'>,
): T {
  return {
    ...target,
    businessId: detail.businessId,
    businessVersion: detail.businessVersion,
    profileName: detail.profileName.trim() || target.profileName,
  };
}

/** Resolve a stored profile's action only when its tenant catalog is conclusive. */
export function resolveProfileActionFromCatalog(
  rows: readonly ProfileCatalogIdentity[],
  expected: Pick<ProfileCatalogIdentity, 'tenantId' | 'businessId' | 'businessVersion' | 'profileName'>,
): ProfileActionResolution {
  const matches = rows.filter((row) => row.tenantId === expected.tenantId
    && row.businessId === expected.businessId
    && row.businessVersion === expected.businessVersion
    && row.profileName === expected.profileName);
  if (matches.length === 0) return { kind: 'missing' };
  const actions = new Set(matches.map((row) => {
    const action = row.action?.trim();
    return action || (row.boundActions.length === 1 ? row.boundActions[0] : undefined);
  }));
  if (actions.has(undefined)) return { kind: 'ambiguous' };
  if (actions.size !== 1) return { kind: 'ambiguous' };
  const action = [...actions][0];
  return typeof action === 'string' && action.length > 0
    ? { kind: 'resolved', action }
    : { kind: 'ambiguous' };
}

/** Resolve one exact saved resource before a detail read can become editable. */
export function resolveProfileIdentityFromCatalog(
  rows: readonly ProfileCatalogIdentity[],
  expected: Pick<ProfileCatalogIdentity, 'tenantId' | 'businessId' | 'businessVersion' | 'profileName'> & { profileId?: string },
): ProfileIdentityResolution {
  const matches = rows.filter((row) => row.tenantId === expected.tenantId
    && row.businessId === expected.businessId
    && row.businessVersion === expected.businessVersion
    && row.profileName === expected.profileName
    && (expected.profileId === undefined || row.profileId === expected.profileId));
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length !== 1) return { kind: 'ambiguous' };
  const row = matches[0]!;
  const action = row.action?.trim() || (row.boundActions.length === 1 ? row.boundActions[0]?.trim() : undefined);
  if (!row.profileId || !action) return { kind: 'ambiguous' };
  // `null` is an explicit generic binding; `undefined` means an older catalog
  // response did not include binding metadata at all.
  return { kind: 'resolved', profileId: row.profileId, action, endpointSlug: row.endpointSlug };
}

/** Carry the exact successful row identity into read-after-write refresh. */
export function profileTargetAfterSave(
  loaded: Pick<SavedProfileTarget, 'businessId' | 'businessVersion' | 'profileName' | 'action'> & { profileId?: string | null },
  row: Pick<SavedProfileTarget, 'profileName' | 'action' | 'endpointSlug'>,
  returnedProfileId: unknown,
): SavedProfileTarget {
  const profileName = row.profileName.trim() || loaded.profileName;
  const action = row.action.trim();
  const mutationProfileId = typeof returnedProfileId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(returnedProfileId)
    ? returnedProfileId
    : undefined;
  const profileId = mutationProfileId
    ?? (profileName === loaded.profileName && action === loaded.action ? loaded.profileId : undefined);
  return {
    businessId: loaded.businessId,
    businessVersion: loaded.businessVersion,
    profileName,
    action,
    endpointSlug: row.endpointSlug?.trim() || null,
    ...(profileId ? { profileId } : {}),
  };
}

/** Choose the earliest successful row that has a safe refresh identity. */
export function firstSuccessfulProfileTarget(
  outcomes: readonly { ok: boolean; savedTarget?: SavedProfileTarget }[],
): SavedProfileTarget | null {
  return outcomes.find((outcome) => outcome.ok && outcome.savedTarget !== undefined)?.savedTarget ?? null;
}
