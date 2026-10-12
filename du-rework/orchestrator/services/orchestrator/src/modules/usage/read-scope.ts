import { createHash } from 'node:crypto';

/**
 * Trusted local-user population resolved by Identity from the current
 * roleVersion. These IDs are never accepted from a browser query.
 */
export interface LocalUserUsageReadScope {
  tenantId: string;
  userId: string;
  roleVersion: number;
  profileIds: readonly string[];
  apiKeyIds: readonly string[];
}

/** Bind paginated cursors to the exact authorized population. A cursor minted
 * before a role/grant change cannot continue under the new population. */
export function usageReadScopeFingerprint(scope?: LocalUserUsageReadScope): string | null {
  if (!scope) return null;
  const normalized = {
    tenantId: scope.tenantId,
    userId: scope.userId,
    roleVersion: scope.roleVersion,
    apiKeyIds: [...new Set(scope.apiKeyIds)].sort(),
    profileIds: [...new Set(scope.profileIds)].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Add the same key AND profile population predicate to every Usage reader.
 * The caller's SQL still includes its independent tenant predicate. */
export function appendLocalUserUsageFence(
  where: string[],
  bind: (value: unknown) => string,
  scope?: LocalUserUsageReadScope,
): void {
  if (!scope) return;
  // Empty assigned-key populations must return no rows. Empty profile
  // populations still permit operations that were not profile-bound.
  if (scope.apiKeyIds.length === 0) {
    where.push('FALSE');
    return;
  }
  const apiKeys = bind([...new Set(scope.apiKeyIds)]);
  const profiles = bind([...new Set(scope.profileIds)]);
  const tenantId = bind(scope.tenantId);
  const userId = bind(scope.userId);
  const roleVersion = bind(scope.roleVersion);
  where.push(`o.api_key_id = ANY(${apiKeys}::uuid[])`);
  where.push(`EXISTS (
    SELECT 1 FROM admin_local_users usage_scope_user
     WHERE usage_scope_user.tenant_id = ${tenantId}::uuid
       AND usage_scope_user.id = ${userId}::uuid
       AND usage_scope_user.role = 'operator'
       AND usage_scope_user.is_enabled = true
       AND usage_scope_user.is_locked = false
       AND usage_scope_user.version = ${roleVersion}
  )`);
  where.push(`EXISTS (
    SELECT 1 FROM admin_local_user_api_key_grants usage_scope_key
    JOIN api_keys usage_scope_api_key
      ON usage_scope_api_key.tenant_id = usage_scope_key.tenant_id
     AND usage_scope_api_key.id = usage_scope_key.api_key_id
     WHERE usage_scope_key.tenant_id = o.tenant_id
       AND usage_scope_key.user_id = ${userId}::uuid
       AND usage_scope_key.api_key_id = o.api_key_id
       AND usage_scope_api_key.status = 'ACTIVE'
       AND lower(trim(coalesce(usage_scope_api_key.name,''))) <> 'global'
  )`);
  where.push(`(o.profile_id IS NULL OR (
    o.profile_id = ANY(${profiles}::uuid[])
    AND EXISTS (
      SELECT 1 FROM admin_local_user_profile_grants usage_scope_profile
       WHERE usage_scope_profile.tenant_id = o.tenant_id
         AND usage_scope_profile.user_id = ${userId}::uuid
         AND usage_scope_profile.profile_id = o.profile_id
    )
  ))`);
}
