import type { Db } from '../../db/db';

type JsonObject = Record<string, unknown>;
type ReadinessStatus = 'INVENTORY_REQUIRED' | 'INVENTORY_STALE' | 'RECONCILIATION_REQUIRED' | 'IDENTITY_RESET_REQUIRED' | 'SYNTHETIC_REHEARSAL_REQUIRED' | 'CUSTOMER_EVIDENCE_PENDING' | 'CUTOVER_READY';

export interface MigrationReadinessEvidence {
  evidenceKind: 'inventory' | 'reconciliation' | 'backup' | 'restore' | 'runtime_probe' | 'cutover_probe';
  evidenceSha256: string;
  recordedAt: string;
  status: string | null;
  scope: 'synthetic' | 'customer-authorized' | null;
}

export interface MigrationReadinessRun {
  sourceVersion: string;
  sourceSha256: string;
  planSha256: string;
  importedAt: string;
  sourceCounts: Record<string, number>;
  destinationCounts: Record<string, number>;
  latestInventory: null | {
    recordedAt: string;
    inventorySha256: string;
    targetCounts: Record<string, number>;
    issueCounts: Record<string, number>;
    totalIssues: number;
    verifiedBlobCount: number;
    failedBlobCount: number;
    capabilities: JsonObject;
    capabilityReady: boolean;
    continuityEvidence: JsonObject;
    customerEvidence: JsonObject;
    unresolvedRequiredResetUsers: number;
    stale: boolean;
    staleObservedAt: string | null;
    evidence: MigrationReadinessEvidence[];
    externalGates: string[];
  };
  status: ReadinessStatus;
  capabilityReady: boolean;
  rehearsalReady: boolean;
  cutoverReady: boolean;
}
export interface MigrationReadinessResponse { tenantId: string; runs: MigrationReadinessRun[] }

function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, count]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0));
}
function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function statusText(value: unknown): string | null { return typeof value === 'string' && /^[A-Z_]{1,96}$/.test(value) ? value : null; }
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Tenant fence is mandatory even for a platform caller. Only sanitized
 * evidence is projected; archive, prompt, credential and artifact bytes never
 * cross this boundary. Readiness is derived from current inventory, persisted
 * owner receipts and customer evidence, not a constant. */
export async function readMigrationReadiness(db: Db, tenantId: string): Promise<MigrationReadinessResponse> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('invalid tenant scope');
  const rows = await db.query(`SELECT r.source_version,r.source_sha256,r.plan_sha256,r.created_at,r.source_counts,r.destination_counts,
    i.inventory_sha256,i.report,i.recorded_at,live.latest_mutation_at,
    reset.unresolved_required_reset_users
    FROM legacy_migration_runs r
    LEFT JOIN LATERAL (
      SELECT inventory_sha256,report,recorded_at FROM legacy_migration_inventory_reports
      WHERE tenant_id=r.tenant_id AND source_version=r.source_version ORDER BY recorded_at DESC LIMIT 1
    ) i ON true
    LEFT JOIN LATERAL (
      SELECT GREATEST(
        COALESCE((SELECT max(updated_at) FROM legacy_app_settings WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM operations WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM api_keys WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(moved_at) FROM profile_active_revisions p JOIN profile_bindings b USING(profile_id) WHERE b.tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(updated_at) FROM admin_local_users WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM admin_local_user_profile_grants WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM admin_local_user_api_key_grants WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM global_settings_tenant_revisions WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM global_settings_retention_revisions),'epoch'::timestamptz),
        COALESCE((SELECT max(GREATEST(created_at,COALESCE(activated_at,'epoch'::timestamptz))) FROM storage_generations),'epoch'::timestamptz),
        COALESCE((SELECT max(received_at) FROM usage_events WHERE operation_id IN (SELECT id FROM operations WHERE tenant_id=r.tenant_id)),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM cost_budget_revisions WHERE tenant_id=r.tenant_id),'epoch'::timestamptz),
        COALESCE((SELECT max(created_at) FROM cost_reservation_groups WHERE tenant_id=r.tenant_id),'epoch'::timestamptz)
      ) AS latest_mutation_at
    ) live ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS unresolved_required_reset_users FROM admin_local_users
      WHERE tenant_id=r.tenant_id AND legacy_password_reset_required=true
    ) reset ON true
    WHERE r.tenant_id=$1 ORDER BY r.created_at DESC,r.source_version LIMIT 100`, [tenantId]);
  return {
    tenantId,
    runs: await Promise.all(rows.rows.map(async row => {
      const report = object(row.report);
      const rawIssues = Array.isArray(report.issues) ? report.issues : [];
      const issueCounts: Record<string, number> = {};
      for (const issue of rawIssues) {
        const code = object(issue).code;
        if (typeof code === 'string' && /^[A-Z_]{1,96}$/.test(code)) issueCounts[code] = (issueCounts[code] ?? 0) + 1;
      }
      const blobs = Array.isArray(report.blobChecks) ? report.blobChecks.map(object) : [];
      const failedBlobCount = blobs.filter(blob => blob.backend === 'postgres'
        ? !blob.actualSha256 || blob.actualSha256 !== blob.expectedSha256 || blob.sizeMatches !== true
        : !blob.storageGenerationId || blob.storageVersionPinned !== true || blob.manifestVersionPinned !== true).length;
      const recordedAt = timestamp(row.recorded_at);
      const latestMutationAt = timestamp(row.latest_mutation_at);
      const stale = Boolean(recordedAt && latestMutationAt && Date.parse(latestMutationAt) > Date.parse(recordedAt));
      const unresolvedRequiredResetUsers = Number(row.unresolved_required_reset_users ?? 0);
      const capabilities = object(report.capabilities);
      const configurationMapping = object(capabilities.configurationMapping);
      const capabilityReady = report.version === 'ldba-continuity-inventory-v2'
        && report.capabilityReady === true && configurationMapping.available === true
        && rawIssues.length === 0 && failedBlobCount === 0 && !stale;
      const evidenceQuery = await db.query(`SELECT DISTINCT ON (evidence_kind,COALESCE(receipt->>'scope','')) evidence_kind,evidence_sha256,recorded_at,
          receipt->>'status' AS status,receipt->>'scope' AS scope
        FROM legacy_continuity_evidence WHERE tenant_id=$1 AND source_version=$2
        ORDER BY evidence_kind,COALESCE(receipt->>'scope',''),recorded_at DESC LIMIT 32`, [tenantId, String(row.source_version)]);
      const evidence = evidenceQuery.rows.map(item => ({
        evidenceKind: item.evidence_kind as MigrationReadinessEvidence['evidenceKind'],
        evidenceSha256: String(item.evidence_sha256),
        recordedAt: timestamp(item.recorded_at) ?? new Date(0).toISOString(),
        status: statusText(item.status),
        scope: item.scope === 'synthetic' || item.scope === 'customer-authorized' ? item.scope : null,
      }));
      const restoreVerified = evidence.some(item => item.evidenceKind === 'restore' && item.scope === 'synthetic' && item.status === 'VERIFIED');
      const runtimeVerified = evidence.some(item => item.evidenceKind === 'runtime_probe' && item.scope === 'synthetic' && item.status === 'VERIFIED');
      const isolatedCutoverVerified = evidence.some(item => item.evidenceKind === 'cutover_probe' && item.scope === 'synthetic' && item.status === 'VERIFIED');
      const continuityEvidence = {
        isolatedRestore: restoreVerified ? 'VERIFIED' : 'PENDING',
        sourceOffRuntimeProbe: runtimeVerified ? 'VERIFIED' : 'PENDING',
        isolatedCutoverProbe: isolatedCutoverVerified ? 'VERIFIED' : 'PENDING',
        rehearsalReady: capabilityReady && unresolvedRequiredResetUsers === 0 && restoreVerified && runtimeVerified && isolatedCutoverVerified,
      };
      const rawCustomerEvidence = object(report.customerEvidence);
      const customerEvidence = {
        sourceFreeze: rawCustomerEvidence.sourceFreeze === 'VERIFIED' ? 'VERIFIED' : 'PENDING_CUSTOMER_INPUT',
        sourceTimezone: rawCustomerEvidence.sourceTimezone === 'VERIFIED' ? 'VERIFIED' : 'PENDING_CUSTOMER_INPUT',
        cutoverAuthorization: rawCustomerEvidence.cutoverAuthorization === 'APPROVED' ? 'APPROVED' : 'PENDING_CUSTOMER_INPUT',
        evidenceSha256: typeof rawCustomerEvidence.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(rawCustomerEvidence.evidenceSha256)
          ? rawCustomerEvidence.evidenceSha256 : null,
        productionCutover: 'NOT_PERFORMED' as const,
      };
      const rehearsalReady = continuityEvidence.rehearsalReady;
      const sourceFreezeVerified = customerEvidence.sourceFreeze === 'VERIFIED' && customerEvidence.sourceTimezone === 'VERIFIED';
      const cutoverApproved = customerEvidence.cutoverAuthorization === 'APPROVED';
      const customerEvidenceBound = typeof customerEvidence.evidenceSha256 === 'string'
        && /^[a-f0-9]{64}$/.test(customerEvidence.evidenceSha256)
        && evidence.some(item => item.evidenceKind === 'cutover_probe' && item.scope === 'customer-authorized'
          && item.evidenceSha256 === customerEvidence.evidenceSha256 && item.status === 'APPROVED');
      const cutoverReady = rehearsalReady && sourceFreezeVerified && cutoverApproved && customerEvidenceBound
        && customerEvidence.productionCutover === 'NOT_PERFORMED';
      let status: ReadinessStatus;
      if (!recordedAt) status = 'INVENTORY_REQUIRED';
      else if (stale) status = 'INVENTORY_STALE';
      else if (!capabilityReady) status = 'RECONCILIATION_REQUIRED';
      else if (unresolvedRequiredResetUsers > 0) status = 'IDENTITY_RESET_REQUIRED';
      else if (!rehearsalReady) status = 'SYNTHETIC_REHEARSAL_REQUIRED';
      else if (!sourceFreezeVerified || !cutoverApproved) status = 'CUSTOMER_EVIDENCE_PENDING';
      else status = 'CUTOVER_READY';
      return {
        sourceVersion: String(row.source_version), sourceSha256: String(row.source_sha256), planSha256: String(row.plan_sha256), importedAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
        sourceCounts: counts(row.source_counts), destinationCounts: counts(row.destination_counts),
        latestInventory: recordedAt ? {
          recordedAt, inventorySha256: String(row.inventory_sha256), targetCounts: counts(report.targetCounts), issueCounts, totalIssues: rawIssues.length,
          verifiedBlobCount: Math.max(0, blobs.length - failedBlobCount), failedBlobCount, capabilities, capabilityReady,
          continuityEvidence, customerEvidence, unresolvedRequiredResetUsers, stale, staleObservedAt: stale ? latestMutationAt : null, evidence,
          externalGates: [
            ...(stale ? ['Target changed after inventory; rerun preflight and inventory'] : []),
            ...(unresolvedRequiredResetUsers ? [`${unresolvedRequiredResetUsers} required legacy password reset(s) remain`] : []),
            ...(!restoreVerified ? ['Encrypted dual-plane backup restore into new isolated databases and storage is unverified'] : []),
            ...(!runtimeVerified ? ['Source-off login, Profile, defaults, result and download proof is unverified'] : []),
            ...(!isolatedCutoverVerified ? ['Synthetic isolated cutover and rollback probe is unverified'] : []),
            ...(!sourceFreezeVerified ? ['Customer source freeze and timezone evidence is pending'] : []),
            ...(!cutoverApproved ? ['Customer cutover authorization is pending'] : []),
            ...(!customerEvidenceBound ? ['Customer source and cutover evidence is not bound to an immutable receipt'] : []),
          ],
        } : null,
        status, capabilityReady, rehearsalReady, cutoverReady,
      };
    })),
  };
}
