import type { PoolClient } from 'pg';
import type { VersionAdmissionReason } from '@du/contracts';

export interface BusinessAdmissionSnapshot {
  enabled: boolean;
  activationRevision: number;
  activeVersion: string | null;
  targetStatus: string | null;
  submissionsPaused: boolean;
  preDrainVersion: string | null;
}

export type BusinessAdmissionLock = 'SHARE' | 'UPDATE';

/**
 * Read version admission while locking the business root. All writers that
 * change the active pointer take this row FOR UPDATE first. New submissions,
 * claims and heartbeats take it FOR SHARE before touching version/worker/task
 * rows, giving activation one common linearization point across replicas.
 */
export async function readBusinessAdmission(
  client: Pick<PoolClient, 'query'>,
  businessId: string,
  targetVersion?: string,
  lock: BusinessAdmissionLock = 'SHARE',
): Promise<BusinessAdmissionSnapshot | null> {
  const lockClause = lock === 'UPDATE' ? 'FOR UPDATE' : 'FOR SHARE';
  // Lock the mutex row in its own statement. Under READ COMMITTED, joined rows
  // from the same SELECT can be based on a snapshot taken before a lock wait;
  // the following version query gets a fresh snapshot after the lock is held.
  const root = await client.query<{
    enabled: boolean;
    activation_revision: number | string;
    submissions_paused: boolean;
    pre_drain_version: string | null;
  }>(
    `SELECT enabled,activation_revision,submissions_paused,pre_drain_version
       FROM business_catalog WHERE business_id=$1 ${lockClause}`,
    [businessId],
  );
  const rootRow = root.rows[0];
  if (!rootRow) return null;
  const versions = await client.query<{ version: string; status: string; is_active: boolean }>(
    `SELECT version,status,is_active FROM business_versions
      WHERE business_id=$1 AND (is_active=true OR version=$2)`,
    [businessId, targetVersion ?? null],
  );
  const active = versions.rows.find((row) => row.is_active);
  const target = targetVersion === undefined
    ? active
    : versions.rows.find((row) => row.version === targetVersion);
  const activationRevision = Number(rootRow.activation_revision);
  if (!Number.isSafeInteger(activationRevision) || activationRevision < 1) {
    throw new Error('business activation revision is invalid');
  }
  return {
    enabled: rootRow.enabled,
    activationRevision,
    activeVersion: active?.version ?? null,
    targetStatus: target?.status ?? null,
    submissionsPaused: rootRow.submissions_paused,
    preDrainVersion: rootRow.pre_drain_version,
  };
}

export function admissionReasonForVersion(
  snapshot: BusinessAdmissionSnapshot,
  businessVersion: string,
): VersionAdmissionReason {
  if (!snapshot.enabled) return 'BUSINESS_DISABLED';
  if (snapshot.activeVersion === null) return 'NO_ACTIVE_VERSION';
  if (snapshot.targetStatus !== 'ENABLED') return 'VERSION_NOT_ENABLED';
  if (snapshot.activeVersion !== businessVersion) return 'VERSION_NOT_ACTIVE';
  return 'ELIGIBLE';
}
