import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';

export type BusinessVersionImpactAction = 'activate' | 'deactivate';

export interface BusinessVersionImpactInput {
  tenantId: string;
  businessId: string;
  version: string;
  action: BusinessVersionImpactAction;
}

export interface ImpactList<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

export interface BusinessVersionImpactPreview {
  tenantId: string;
  businessId: string;
  version: string;
  action: BusinessVersionImpactAction;
  status: string;
  isActive: boolean;
  activeVersion: string | null;
  lifecycleRevision: string;
  eligible: boolean;
  wouldChange: boolean;
  blockers: string[];
  sampledAt: string;
  complete: boolean;
  profileBindings: ImpactList<{
    profileId: string;
    revision: number;
    action: string;
    activeRevision: boolean;
    createdAt: string;
  }>;
  workflowBindings: ImpactList<{
    profileId: string;
    workflowSlug: string;
    workflowRevision: number;
    enabled: boolean;
    workflowStatus: string | null;
  }>;
  workerInstances: ImpactList<{
    instanceId: string;
    state: string;
    capacity: number;
    activeLeases: number;
    lastSeenAt: string;
    observedAt: string;
  }>;
}

interface VersionImpactDbRow extends QueryResultRow {
  status: string;
  is_active: boolean;
  active_version: string | null;
  lifecycle_revision: number | string;
}

interface ProfileBindingDbRow extends QueryResultRow {
  profile_id: string;
  revision: number | string;
  action: string;
  active_revision: boolean;
  created_at: Date | string;
  total_count: number | string;
}

interface WorkflowBindingDbRow extends QueryResultRow {
  profile_id: string;
  workflow_slug: string;
  workflow_revision: number | string;
  enabled: boolean;
  workflow_status: string | null;
  total_count: number | string;
}

interface WorkerInstanceDbRow extends QueryResultRow {
  instance_id: string;
  state: string;
  capacity: number | string;
  active_leases: number | string;
  last_seen_at: Date | string;
  observed_at: Date | string;
  total_count: number | string;
}

const IMPACT_LIST_LIMIT = 100;

/**
 * Read a tenant-owned version and its bounded operational dependencies from a
 * repeatable-read snapshot. Every dependency query repeats the ownership fence
 * so a global business ID is never sufficient to expose tenant data.
 */
export async function getBusinessVersionImpactPreview(
  db: Pick<Db, 'tx'>,
  input: BusinessVersionImpactInput,
  nowMs = Date.now(),
): Promise<BusinessVersionImpactPreview> {
  const sampledAt = new Date(nowMs);
  if (Number.isNaN(sampledAt.getTime())) throw new Error('business impact sample time is invalid');

  return db.tx(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const target = await client.query<VersionImpactDbRow>(
      `SELECT bv.status, bv.is_active,
              (SELECT active.version
                 FROM business_versions active
                WHERE active.business_id=bv.business_id AND active.is_active=true
                ORDER BY active.version
                LIMIT 1) AS active_version,
              bc.lifecycle_revision
         FROM business_catalog bc
         JOIN business_versions bv ON bv.business_id=bc.business_id
        WHERE bc.owner_tenant_id=$1 AND bc.business_id=$2 AND bv.version=$3`,
      [input.tenantId, input.businessId, input.version],
    );
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new HttpError(404, 'NOT_FOUND', 'business version was not found for this tenant');
    }

    const limit = IMPACT_LIST_LIMIT + 1;
    const profileResult = await client.query<ProfileBindingDbRow>(
      `SELECT p.profile_id, p.revision, p.action, p.created_at,
              COALESCE(a.revision = p.revision, false) AS active_revision,
              count(*) OVER ()::int AS total_count
         FROM business_catalog bc
         JOIN profile_bindings p
           ON p.business_id=bc.business_id AND p.tenant_id=bc.owner_tenant_id
         LEFT JOIN profile_active_revisions a ON a.profile_id=p.profile_id
        WHERE bc.owner_tenant_id=$1 AND bc.business_id=$2
          AND p.tenant_id=$1 AND p.business_version=$3
        ORDER BY COALESCE(a.revision = p.revision, false) DESC,
                 p.created_at DESC, p.profile_id ASC, p.revision DESC
        LIMIT $4`,
      [input.tenantId, input.businessId, input.version, limit],
    );

    const workflowResult = await client.query<WorkflowBindingDbRow>(
      `SELECT p.profile_id, pw.workflow_slug, pw.workflow_revision, pw.enabled,
              w.status AS workflow_status, count(*) OVER ()::int AS total_count
         FROM business_catalog bc
         JOIN profile_bindings p
           ON p.business_id=bc.business_id AND p.tenant_id=bc.owner_tenant_id
         JOIN profile_active_revisions a
           ON a.profile_id=p.profile_id AND a.revision=p.revision
         JOIN profile_workflow_bindings pw ON pw.profile_id=p.profile_id
         LEFT JOIN legacy_workflow_schemas w
           ON w.tenant_id=p.tenant_id AND w.business_id=p.business_id
          AND w.business_version=p.business_version AND w.slug=pw.workflow_slug
          AND w.revision=pw.workflow_revision
        WHERE bc.owner_tenant_id=$1 AND bc.business_id=$2
          AND p.tenant_id=$1 AND p.business_version=$3
        ORDER BY p.profile_id ASC, pw.workflow_slug ASC, pw.workflow_revision DESC
        LIMIT $4`,
      [input.tenantId, input.businessId, input.version, limit],
    );

    const workerResult = await client.query<WorkerInstanceDbRow>(
      `SELECT wi.instance_id, wi.state, wi.capacity, wi.active_leases,
              wi.last_seen_at, wi.observed_at, count(*) OVER ()::int AS total_count
         FROM business_catalog bc
         JOIN worker_instances wi ON wi.business_id=bc.business_id
        WHERE bc.owner_tenant_id=$1 AND bc.business_id=$2
          AND wi.business_version=$3
        ORDER BY wi.last_seen_at DESC, wi.instance_id ASC
        LIMIT $4`,
      [input.tenantId, input.businessId, input.version, limit],
    );

    const profileBindings = mapImpactList(profileResult.rows, (row) => ({
      profileId: row.profile_id,
      revision: readCount(row.revision, 'profile revision'),
      action: row.action,
      activeRevision: row.active_revision,
      createdAt: readTimestamp(row.created_at, 'profile binding created_at'),
    }));
    const workflowBindings = mapImpactList(workflowResult.rows, (row) => ({
      profileId: row.profile_id,
      workflowSlug: row.workflow_slug,
      workflowRevision: readCount(row.workflow_revision, 'workflow revision'),
      enabled: row.enabled,
      workflowStatus: row.workflow_status,
    }));
    const workerInstances = mapImpactList(workerResult.rows, (row) => ({
      instanceId: row.instance_id,
      state: row.state,
      capacity: readCount(row.capacity, 'worker capacity'),
      activeLeases: readCount(row.active_leases, 'worker active leases'),
      lastSeenAt: readTimestamp(row.last_seen_at, 'worker last_seen_at'),
      observedAt: readTimestamp(row.observed_at, 'worker observed_at'),
    }));

    const eligible = targetRow.status === 'ENABLED';
    const isActive = targetRow.is_active;
    const blockers = eligible ? [] : ['VERSION_NOT_ENABLED'];
    const wouldChange = eligible && (input.action === 'activate' ? !isActive : isActive);

    return {
      tenantId: input.tenantId,
      businessId: input.businessId,
      version: input.version,
      action: input.action,
      status: targetRow.status,
      isActive,
      activeVersion: targetRow.active_version,
      lifecycleRevision: readRevision(targetRow.lifecycle_revision),
      eligible,
      wouldChange,
      blockers,
      sampledAt: sampledAt.toISOString(),
      complete: !profileBindings.truncated && !workflowBindings.truncated && !workerInstances.truncated,
      profileBindings,
      workflowBindings,
      workerInstances,
    };
  });
}

function mapImpactList<TDbRow extends { total_count: number | string }, TItem>(
  rows: TDbRow[],
  map: (row: TDbRow) => TItem,
): ImpactList<TItem> {
  const total = rows.length === 0 ? 0 : readCount(rows[0]!.total_count, 'impact count');
  return {
    items: rows.slice(0, IMPACT_LIST_LIMIT).map(map),
    total,
    truncated: total > IMPACT_LIST_LIMIT,
  };
}

function readCount(value: number | string, name: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`business impact query returned invalid ${name}`);
  }
  return count;
}

function readRevision(value: number | string): string {
  const revision = String(value);
  if (!/^\d+$/.test(revision) || BigInt(revision) < 1n) {
    throw new Error('business impact query returned invalid lifecycle revision');
  }
  return revision;
}

function readTimestamp(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`business impact query returned invalid ${name}`);
  return date.toISOString();
}
