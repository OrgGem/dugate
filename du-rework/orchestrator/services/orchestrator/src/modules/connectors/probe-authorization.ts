import { ApiKeyModeSchema, type ApiKeyMode } from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { parseConnectorBindings } from '../profiles/profiles';

export interface ConnectorProbePrincipal {
  readonly id: string;
  readonly tenantId: string;
  /**
   * PC-R05: the explicit authority mode returned by `resolveApiKey` (PC-04).
   * Required on purpose — the probe must never guess a mode: guessing
   * "managed" would grant legacy keys the grant path, guessing "standalone"
   * is what denied every managed key before this fix.
   */
  readonly keyMode: ApiKeyMode;
}

interface ProbeRow {
  api_key_id: string;
  tenant_id: string;
  enabled: boolean;
  connector_bindings: unknown;
}

/**
 * 0039 standalone semantics, unchanged: authorization runs off MEMBERSHIP
 * (`profile_api_keys`), not off the revision's author field — a rotated-in key
 * that never wrote a revision is still authorized, and a revoked membership
 * stops resolving here without touching the immutable bindings.
 */
const STANDALONE_PROBE_SQL = `SELECT m.api_key_id, p.tenant_id, p.enabled, p.connector_bindings
   FROM profile_active_revisions a
   JOIN profile_bindings p
     ON p.profile_id = a.profile_id AND p.revision = a.revision
   JOIN profile_api_keys m
     ON m.profile_id = p.profile_id AND m.api_key_id = $1 AND m.state = 'ACTIVE'
   JOIN api_keys k ON k.id = m.api_key_id AND k.tenant_id = p.tenant_id
  WHERE p.tenant_id = $2
    AND p.enabled = true AND k.status = 'ACTIVE'`;

/**
 * PC-R05 managed semantics: the key's authority is its CURRENT root grant
 * (`profile_group_api_keys`, state ACTIVE) plus the ACTIVE group revision's
 * member pin (`profile_group_members.group_revision = profile_groups.active_revision`)
 * resolved to the immutable child binding. Managed keys intentionally hold no
 * `profile_api_keys` rows — conversion tombstones them — so the standalone
 * join above can never authorize them.
 *
 * `profile_groups.access_version` is the grant-mutation CAS counter; a probe
 * carries no expected version to compare against, so "current" here means the
 * grant is ACTIVE and the group still uses `GROUP_GRANT` authority.
 */
const MANAGED_PROBE_SQL = `SELECT g.api_key_id, p.tenant_id, p.enabled, p.connector_bindings
   FROM profile_group_api_keys g
   JOIN profile_groups grp
     ON grp.group_id = g.group_id AND grp.tenant_id = g.tenant_id
   JOIN profile_group_members gm
     ON gm.group_id = grp.group_id AND gm.group_revision = grp.active_revision
   JOIN profile_bindings p
     ON p.profile_id = gm.profile_id AND p.revision = gm.binding_revision
   JOIN api_keys k ON k.id = g.api_key_id AND k.tenant_id = g.tenant_id
  WHERE g.api_key_id = $1 AND g.tenant_id = $2 AND g.state = 'ACTIVE'
    AND grp.auth_authority = 'GROUP_GRANT'
    AND p.tenant_id = $2
    AND p.enabled = true AND k.status = 'ACTIVE'`;

/** Readiness is restricted to enabled, currently published bindings for this key. */
export async function authorizeConnectorProbe(
  db: Pick<Db, 'query'>,
  principal: ConnectorProbePrincipal,
  connectorId: string,
): Promise<void> {
  const mode = ApiKeyModeSchema.safeParse(principal.keyMode);
  if (!mode.success) {
    // Unknown/NULL mode is an authorization error, never a fallback (PC-04).
    throw new HttpError(403, 'PERMISSION_DENIED', 'connector probe is not permitted');
  }
  const result = await db.query<ProbeRow>(
    // PC-R05: managed keys resolve through the root grant; legacy modes keep
    // their exact pre-R05 scope (`UNMANAGED_LEGACY` had no memberships, so the
    // standalone join denies it exactly as before — no tenant-wide widening).
    mode.data === 'GROUP_MANAGED' ? MANAGED_PROBE_SQL : STANDALONE_PROBE_SQL,
    [principal.id, principal.tenantId],
  );
  for (const row of result.rows) {
    // Keep the ownership boundary explicit even if a repository projection changes.
    if (row.api_key_id !== principal.id || row.tenant_id !== principal.tenantId || row.enabled !== true) continue;
    let bindings: ReturnType<typeof parseConnectorBindings>;
    try {
      bindings = parseConnectorBindings(row.connector_bindings);
    } catch {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector probe authorization is unavailable');
    }
    if (Object.values(bindings).some((binding) => binding.connectorId === connectorId)) return;
  }
  // No legacy fallback to the global deployment registry for a public probe.
  throw new HttpError(403, 'PERMISSION_DENIED', 'connector probe is not permitted');
}
