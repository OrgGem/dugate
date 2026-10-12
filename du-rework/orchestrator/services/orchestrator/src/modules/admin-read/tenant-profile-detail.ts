/** Tenant-scoped profile detail lookup used by tenant-operator admin reads. */
import type { Db } from '../../db/db';
import type { ProfileDetailDbRow, ProfileDetailLookup } from './profile-detail';

/**
 * The legacy platform lookup intentionally resolves a global tuple. Tenant
 * reads use this separate path so both the active revision and orphan checks
 * are fenced in SQL before any profile identity or policy is returned.
 */
export async function loadTenantProfileDetail(
  db: Db,
  businessId: string,
  businessVersion: string,
  profileName: string,
  tenantId: string,
): Promise<ProfileDetailLookup> {
  const params = [businessId, businessVersion, profileName, tenantId];
  const hit = await db.query<ProfileDetailDbRow>(
    `SELECT n.profile_id, a.revision, n.api_key_id,
            p.enabled, p.parameters, p.job_priority, p.allowed_file_extensions,
            p.connections_override, p.file_url_auth_cipher, p.request_redaction, p.callback_policy,
            p.allowed_origins, p.connector_bindings
       FROM profile_names n
       JOIN profile_active_revisions a ON a.profile_id = n.profile_id
       JOIN profile_bindings p
         ON p.profile_id = a.profile_id AND p.revision = a.revision
      WHERE n.business_id=$1 AND n.business_version=$2 AND n.profile_name=$3
        AND n.tenant_id=$4
      ORDER BY a.moved_at DESC, n.profile_id
      LIMIT 1`,
    params,
  );
  if (hit.rowCount) return { kind: 'found', row: hit.rows[0]! };

  const orphan = await db.query(
    `SELECT 1 FROM profile_names
      WHERE business_id=$1 AND business_version=$2 AND profile_name=$3
        AND tenant_id=$4
      LIMIT 1`,
    params,
  );
  return orphan.rowCount ? { kind: 'pointer-missing' } : { kind: 'not-found' };
}
