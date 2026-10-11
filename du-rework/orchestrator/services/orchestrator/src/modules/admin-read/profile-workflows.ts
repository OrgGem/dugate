import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

export interface ProfileWorkflowIdentity {
  tenantId: string;
  businessId: string;
  businessVersion: string;
  profileName: string;
}

export interface ProfileWorkflowItem {
  slug: string;
  revision: number;
  status: 'active' | 'retired';
  enabled: boolean;
  createdAt: string;
}

export interface ProfileWorkflowList {
  businessId: string;
  businessVersion: string;
  items: ProfileWorkflowItem[];
  total: number;
}

interface ProfileOwner extends QueryResultRow {
  profile_id: string;
  tenant_id: string;
}

interface WorkflowRow extends QueryResultRow {
  slug: string;
  revision: number;
  status: 'active' | 'retired';
  enabled: boolean;
  created_at: Date | string;
}

type ProfileWorkflowQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<QueryResult<T>>;

async function findProfileOwner(
  query: ProfileWorkflowQuery,
  identity: ProfileWorkflowIdentity,
  lock = false,
): Promise<ProfileOwner> {
  const selected = await query<ProfileOwner>(
    `SELECT n.profile_id, n.tenant_id
       FROM profile_names n
       JOIN profile_active_revisions a ON a.profile_id=n.profile_id
       JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
      WHERE n.tenant_id=$1 AND n.business_id=$2 AND n.business_version=$3 AND n.profile_name=$4
      ORDER BY a.moved_at DESC, n.profile_id
      LIMIT 1${lock ? ' FOR UPDATE OF n, p' : ''}`,
    [identity.tenantId, identity.businessId, identity.businessVersion, identity.profileName],
  );
  const owner = selected.rows[0];
  if (!owner) throw new HttpError(404, 'NOT_FOUND', 'stored profile was not found for this tenant and business');
  return owner;
}

/**
 * Profile selector data is filtered in SQL by the profile's tenant, business,
 * and version. Unowned legacy workflows stay in the tenant catalog only.
 */
export async function listProfileWorkflows(
  db: Db,
  identity: ProfileWorkflowIdentity,
): Promise<ProfileWorkflowList> {
  const owner = await findProfileOwner(db.query.bind(db), identity);
  const selected = await db.query<WorkflowRow>(
    `SELECT w.slug, w.revision, w.status, w.created_at,
            COALESCE(b.enabled, false) AS enabled
       FROM legacy_workflow_schemas w
       LEFT JOIN profile_workflow_bindings b
         ON b.profile_id=$4 AND b.workflow_slug=w.slug AND b.workflow_revision=w.revision
      WHERE w.tenant_id=$1 AND w.business_id=$2 AND w.business_version=$3
        AND (w.status='active' OR EXISTS (
          SELECT 1 FROM profile_workflow_bindings saved
           WHERE saved.profile_id=$4 AND saved.workflow_slug=w.slug AND saved.workflow_revision=w.revision
        ))
      ORDER BY w.slug ASC, w.revision DESC`,
    [owner.tenant_id, identity.businessId, identity.businessVersion, owner.profile_id],
  );
  const items = selected.rows.map((row) => ({
    slug: row.slug,
    revision: Number(row.revision),
    status: row.status,
    enabled: row.enabled,
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
  }));
  return {
    businessId: identity.businessId,
    businessVersion: identity.businessVersion,
    items,
    total: items.length,
  };
}

/** Persist one workflow toggle inside the caller's transaction/audit boundary. */
export async function setProfileWorkflowBinding(
  client: PoolClient,
  identity: ProfileWorkflowIdentity,
  selection: { workflowSlug: string; workflowRevision: number; enabled: boolean },
): Promise<{ tenantId: string; profileId: string }> {
  const owner = await findProfileOwner(client.query.bind(client), identity, true);
  const workflow = await client.query<{ status: 'active' | 'retired' }>(
    `SELECT status FROM legacy_workflow_schemas
      WHERE tenant_id=$1 AND business_id=$2 AND business_version=$3
        AND slug=$4 AND revision=$5
      FOR SHARE`,
    [owner.tenant_id, identity.businessId, identity.businessVersion, selection.workflowSlug, selection.workflowRevision],
  );
  const status = workflow.rows[0]?.status;
  if (!status) throw new HttpError(404, 'NOT_FOUND', 'workflow does not belong to this profile business');
  if (selection.enabled && status !== 'active') {
    throw new HttpError(409, 'WORKFLOW_NOT_ACTIVE', 'retired workflow revisions cannot be enabled');
  }
  await client.query(
    `INSERT INTO profile_workflow_bindings
       (profile_id, workflow_slug, workflow_revision, enabled)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (profile_id, workflow_slug) DO UPDATE
       SET workflow_revision=EXCLUDED.workflow_revision, enabled=EXCLUDED.enabled`,
    [owner.profile_id, selection.workflowSlug, selection.workflowRevision, selection.enabled],
  );
  return { tenantId: owner.tenant_id, profileId: owner.profile_id };
}
