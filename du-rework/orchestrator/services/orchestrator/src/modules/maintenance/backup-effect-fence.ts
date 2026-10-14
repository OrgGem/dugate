import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { conflict, unavailable } from '../../http/errors';
import type { MaintenanceExecutionFence } from './maintenance-service';
import { isTenantUuid } from '@du/contracts';

export type BackupSnapshotWriteDomain =
  | 'work-admission'
  | 'orchestrator-dispatch'
  | 'usage-settlement'
  | 'financial-adjustment'
  | 'cost-policy-publication'
  | 'global-settings-publication'
  | 'secret-catalog-write'
  | 'connector-recipe-publication'
  | 'storage-generation-publication'
  | 'artifact-metadata'
  | 'maintenance-execution'
  | 'rollout-execution';

export interface BackupSnapshotWriteGate {
  /**
   * Call as the first row lock in the caller's transaction, before tenant,
   * policy, reservation-group, artifact, or idempotency locks. The FOR SHARE
   * lock remains held until the caller commits and conflicts with backup
   * activation's FOR UPDATE lock on the same singleton row.
   */
  assertWriteAllowed(
    client: Pick<PoolClient, 'query'>,
    input: { tenantId: string | null; domain: BackupSnapshotWriteDomain; requestKey: string },
  ): Promise<void>;
}

interface GateRow extends QueryResultRow {
  state: 'OPEN' | 'HELD' | 'UNKNOWN';
  fence_id: string | null;
  fence_revision: string | number;
  backup_id: string | null;
  maintenance_job_id: string | null;
  owner_item_id: string | null;
  owner_runtime_identity: string | null;
  owner_boot_id: string | null;
  owner_execution_fence: string | number | null;
  execution_token_sha256: string | null;
  last_fence_id: string | null;
  last_execution_token_sha256: string | null;
  last_owner_runtime_identity: string | null;
  last_owner_boot_id: string | null;
  last_maintenance_job_id: string | null;
  last_owner_item_id: string | null;
  last_owner_execution_fence: string | number | null;
}

export function createBackupSnapshotWriteGate(): BackupSnapshotWriteGate {
  return {
    async assertWriteAllowed(client, input) {
      if (!input || typeof input.domain !== 'string' || input.domain.length > 64
        || typeof input.requestKey !== 'string' || input.requestKey.length < 1 || input.requestKey.length > 200
        || (input.tenantId !== null && !isTenantUuid(input.tenantId))) {
        throw conflict('INVALID_ARGUMENT', 'Backup snapshot write identity is invalid.');
      }
      let selected;
      try {
        selected = await client.query<GateRow>(
          `SELECT state,fence_id,fence_revision FROM maintenance_backup_effect_gate
            WHERE singleton_id=1 FOR SHARE`,
        );
      } catch {
        throw unavailable('Backup snapshot write gate is unavailable; the write was refused.');
      }
      const gate = selected.rows[0];
      if (!gate) throw unavailable('Backup snapshot write gate is not initialized; the write was refused.');
      if (gate.state !== 'OPEN') {
        throw conflict('BACKUP_EFFECT_FENCE_ACTIVE', 'The write is fenced while a maintenance snapshot is active.');
      }
      const revision = Number(gate.fence_revision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw unavailable('Backup snapshot write gate revision is invalid; the write was refused.');
      }
    },
  };
}

export type BackupArtifactEffectCategory =
  | 'grant-issue'
  | 'ingestion-write'
  | 'encrypted-upload'
  | 'multipart-part'
  | 'multipart-complete'
  | 'multipart-abort'
  | 'metadata-mutation'
  | 'artifact-delete'
  | 'generation-activation'
  | 'storage-generation-test'
  | 'cleanup';

export interface BackupArtifactEffectOwner {
  runtimeIdentity: string;
  bootId: string;
}

export interface BackupArtifactEffectBegin {
  effectKey: string;
  category: BackupArtifactEffectCategory;
  tenantId: string | null;
  artifactId?: string | null;
  storageGenerationId: string;
  objectKeySha256?: string | null;
  capability?: {
    kind: 'presigned-put' | 'multipart' | 'internal';
    capabilityId: string;
    expiresAt: string | null;
  } | null;
}

export interface BackupArtifactEffectHandle {
  effectId: string;
  state: 'PREPARED' | 'ACTIVE' | 'SETTLING' | 'COMPLETED' | 'CANCELLED' | 'UNKNOWN';
  replayed: boolean;
}

export interface BackupArtifactEffectProof {
  objectVersionId: string | null;
  objectSha256: string | null;
  objectByteSize: number | null;
  sidecarVersionId: string | null;
  sidecarSha256: string | null;
  sidecarByteSize: number | null;
  metadataRowSha256: string | null;
}

export interface BackupArtifactSnapshotPin {
  artifactId: string;
  storageGenerationId: string;
  storageVersionId: string;
  manifestVersionId: string | null;
}

export interface BackupCapabilitySnapshot {
  observedAt: string;
  openCapabilities: number;
  includedExactVersion: number;
  excludedIncomplete: number;
  evidenceSha256: string;
}

export interface BackupArtifactEffectObservation {
  observedAt: string;
  workObservedAt: string;
  owner: BackupArtifactEffectOwner;
  processActiveEffects: number;
  preparedEffects: number;
  activeEffects: number;
  settlingEffects: number;
  unclosedEffects: number;
  unresolvedCapabilities: number;
  unknownEffects: number;
}

/** Exact durable gate consumed by public upload, multipart, ingestion, cleanup,
 * generation activation and the encrypted upload gateway. */
export interface BackupArtifactEffectPort {
  begin(input: BackupArtifactEffectBegin, client?: Pick<PoolClient, 'query'>): Promise<BackupArtifactEffectHandle>;
  activate(effectId: string, client?: Pick<PoolClient, 'query'>): Promise<boolean>;
  cancelPrepared(effectId: string, reasonCode: string): Promise<boolean>;
  settle(effectId: string, proof: BackupArtifactEffectProof): Promise<boolean>;
  markUnknown(effectId: string, reasonCode: string): Promise<void>;
  observe(): Promise<BackupArtifactEffectObservation>;
  lookup(effectKey: string): Promise<BackupArtifactEffectHandle | undefined>;
  snapshotOpenCapabilities(input: { backupId: string; artifactPins: readonly BackupArtifactSnapshotPin[] }): Promise<BackupCapabilitySnapshot>;
}

interface EffectRow extends QueryResultRow {
  effect_id: string;
  effect_key_sha256: string;
  request_sha256: string;
  category: BackupArtifactEffectCategory;
  tenant_id: string | null;
  artifact_id: string | null;
  storage_generation_id: string;
  object_key_sha256: string | null;
  capability_kind: 'presigned-put' | 'multipart' | 'internal' | null;
  capability_state: 'NOT_ISSUED' | 'OPEN' | 'CLOSED';
  capability_id_sha256: string | null;
  capability_expires_at: Date | string | null;
  owner_runtime_identity: string;
  owner_boot_id: string;
  fence_revision: string | number;
  state: BackupArtifactEffectHandle['state'];
  object_version_id: string | null;
  object_sha256: string | null;
  object_byte_size: string | number | null;
  sidecar_version_id: string | null;
  sidecar_sha256: string | null;
  sidecar_byte_size: string | number | null;
  metadata_row_sha256: string | null;
  prepared_at: Date | string;
  activated_at: Date | string | null;
  settled_at: Date | string | null;
}

/**
 * Durable artifact-writer permits shared by public, multipart, ingestion,
 * encrypted-upload, cleanup and generation services. Effect keys are hashed
 * before storage and raw capability IDs are never returned by lookup.
 */
export class PostgresBackupArtifactEffects implements BackupArtifactEffectPort {
  public constructor(
    private readonly db: Db,
    private readonly owner: BackupArtifactEffectOwner,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!isSafeId(owner.runtimeIdentity) || !isUuid(owner.bootId)) throw new Error('Backup effect owner identity is invalid.');
  }

  public async begin(input: BackupArtifactEffectBegin, client?: Pick<PoolClient, 'query'>): Promise<BackupArtifactEffectHandle> {
    validateBegin(input);
    const keyHash = sha(input.effectKey);
    const requestHash = sha(JSON.stringify(canonical({
      category: input.category,
      tenantId: input.tenantId,
      artifactId: input.artifactId ?? null,
      storageGenerationId: input.storageGenerationId,
      objectKeySha256: input.objectKeySha256 ?? null,
      capability: input.capability ? {
        kind: input.capability.kind,
        capabilityIdSha256: sha(input.capability.capabilityId),
        expiresAt: input.capability.expiresAt,
      } : null,
    })));
    const prepare = async (tx: Pick<PoolClient,'query'>): Promise<BackupArtifactEffectHandle> => {
      const gate = await lockGate(tx, 'SHARE');
      if (gate.state !== 'OPEN') throw conflict('BACKUP_EFFECT_FENCE_ACTIVE', 'Artifact mutation is fenced by a maintenance snapshot.');
      const prior = await tx.query<EffectRow>(
        `SELECT * FROM maintenance_backup_artifact_effects WHERE effect_key_sha256=$1 FOR UPDATE`, [keyHash],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.request_sha256 !== requestHash || row.owner_runtime_identity !== this.owner.runtimeIdentity) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'Artifact effect key is already bound to a different request.');
        }
        // A cancelled PREPARED effect is affirmative evidence that the object
        // request never started. It can be rebound to a fresh fence revision
        // and process boot without changing its immutable request identity.
        if (row.state === 'CANCELLED' || (row.state === 'PREPARED' && row.owner_boot_id !== this.owner.bootId)) {
          const revision = checkedRevision(gate.fence_revision);
          const resumed = await tx.query(
          `UPDATE maintenance_backup_artifact_effects
                SET state='PREPARED',owner_boot_id=$2,fence_revision=$3,reason_code=NULL,
                    prepared_at=$4,activated_at=NULL,settled_at=NULL,updated_at=$4
              WHERE effect_id=$1 AND state IN ('PREPARED','CANCELLED') AND owner_runtime_identity=$5`,
            [row.effect_id,this.owner.bootId,revision,this.isoNow(),this.owner.runtimeIdentity],
          );
          if (resumed.rowCount !== 1) throw conflict('BACKUP_EFFECT_CAS_FAILED', 'Cancelled artifact effect changed concurrently.');
          return { effectId: row.effect_id, state: 'PREPARED', replayed: true };
        }
        return { effectId: row.effect_id, state: row.state, replayed: true };
      }
      const effectId = randomUUID();
      const revision = checkedRevision(gate.fence_revision);
      await tx.query(
        `INSERT INTO maintenance_backup_artifact_effects
          (effect_id,effect_key_sha256,request_sha256,category,tenant_id,artifact_id,storage_generation_id,
           object_key_sha256,capability_kind,capability_id_sha256,capability_expires_at,owner_runtime_identity,
           owner_boot_id,fence_revision,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PREPARED')`,
        [effectId,keyHash,requestHash,input.category,input.tenantId,input.artifactId ?? null,input.storageGenerationId,
          input.objectKeySha256 ?? null,input.capability?.kind ?? null,
          input.capability ? sha(input.capability.capabilityId) : null,
          input.capability?.expiresAt ?? null,this.owner.runtimeIdentity,this.owner.bootId,revision],
      );
      return { effectId, state: 'PREPARED', replayed: false };
    };
    return client ? prepare(client) : this.db.tx(prepare);
  }

  /** Last local CAS before the external object-store request or capability return. */
  public async activate(effectId: string, client?: Pick<PoolClient, 'query'>): Promise<boolean> {
    if (!isUuid(effectId)) throw conflict('INVALID_ARGUMENT', 'Artifact effect identifier is invalid.');
    const activate = async (tx: Pick<PoolClient, 'query'>): Promise<boolean> => {
      const gate = await lockGate(tx, 'SHARE');
      const selected = await tx.query<EffectRow>(
        `SELECT * FROM maintenance_backup_artifact_effects WHERE effect_id=$1 FOR UPDATE`, [effectId],
      );
      const effect = selected.rows[0];
      if (!effect || !this.isOwned(effect)) return false;
      if (effect.state === 'ACTIVE') return true;
      if (effect.state !== 'PREPARED') return false;
      if (gate.state !== 'OPEN' || checkedRevision(gate.fence_revision) !== Number(effect.fence_revision)) {
        await tx.query(
          `UPDATE maintenance_backup_artifact_effects SET state='CANCELLED',reason_code='BACKUP_EFFECT_FENCE_ACTIVE',
              settled_at=$2,updated_at=$2 WHERE effect_id=$1 AND state='PREPARED'`, [effectId,this.isoNow()],
        );
        return false;
      }
      const updated = await tx.query(
        `UPDATE maintenance_backup_artifact_effects SET state='ACTIVE',activated_at=$2,
            capability_state=CASE WHEN capability_kind IS NULL THEN 'NOT_ISSUED' ELSE 'OPEN' END,updated_at=$2
          WHERE effect_id=$1 AND state='PREPARED' AND owner_runtime_identity=$3 AND owner_boot_id=$4 AND fence_revision=$5`,
        [effectId,this.isoNow(),this.owner.runtimeIdentity,this.owner.bootId,Number(effect.fence_revision)],
      );
      return updated.rowCount === 1;
    };
    return client ? activate(client) : this.db.tx(activate);
  }

  /** Cancels only a pre-send permit; ACTIVE/UNKNOWN rows are never cleared. */
  public async cancelPrepared(effectId: string, reasonCode: string): Promise<boolean> {
    if (!isUuid(effectId) || !/^[A-Z0-9_]{1,80}$/.test(reasonCode)) throw conflict('INVALID_ARGUMENT', 'Artifact cancellation identity is invalid.');
    return this.db.tx(async (client) => {
      await lockGate(client, 'SHARE');
      const updated = await client.query(
        `UPDATE maintenance_backup_artifact_effects SET state='CANCELLED',reason_code=$2,settled_at=$3,updated_at=$3
          WHERE effect_id=$1 AND state='PREPARED' AND owner_runtime_identity=$4`,
        [effectId,reasonCode,this.isoNow(),this.owner.runtimeIdentity],
      );
      return updated.rowCount === 1;
    });
  }

  public async settle(effectId: string, proof: BackupArtifactEffectProof): Promise<boolean> {
    if (!isUuid(effectId)) throw conflict('INVALID_ARGUMENT', 'Artifact effect identifier is invalid.');
    validateProof(proof);
    return this.db.tx(async (client) => {
      // Existing effects may settle while HELD; only new activation is denied.
      await lockGate(client, 'SHARE');
      const selected = await client.query<EffectRow>(
        `SELECT * FROM maintenance_backup_artifact_effects WHERE effect_id=$1 FOR UPDATE`, [effectId],
      );
      const effect = selected.rows[0];
      if (!effect || !this.isOwned(effect)) return false;
      if (effect.state === 'COMPLETED') return true;
      if (effect.state !== 'ACTIVE' && effect.state !== 'SETTLING') return false;
      requireProofForCategory(effect.category, proof);
      const now = this.isoNow();
      const updated = await client.query(
        `UPDATE maintenance_backup_artifact_effects SET state='COMPLETED',
            object_version_id=$2,object_sha256=$3,object_byte_size=$4,
            sidecar_version_id=$5,sidecar_sha256=$6,sidecar_byte_size=$7,
            metadata_row_sha256=$8,settled_at=$9,updated_at=$9
          WHERE effect_id=$1 AND state IN ('ACTIVE','SETTLING') AND owner_runtime_identity=$10 AND owner_boot_id=$11`,
        [effectId,proof.objectVersionId,proof.objectSha256,proof.objectByteSize,proof.sidecarVersionId,
          proof.sidecarSha256,proof.sidecarByteSize,proof.metadataRowSha256,
          now,
          this.owner.runtimeIdentity,this.owner.bootId],
      );
      return updated.rowCount === 1;
    });
  }

  public async markUnknown(effectId: string, reasonCode: string): Promise<void> {
    if (!isUuid(effectId) || !/^[A-Z0-9_]{1,80}$/.test(reasonCode)) throw conflict('INVALID_ARGUMENT', 'Artifact effect uncertainty is invalid.');
    await this.db.tx(async (client) => {
      await lockGate(client,'SHARE');
      await client.query(
        `UPDATE maintenance_backup_artifact_effects SET state='UNKNOWN',reason_code=$2,
            capability_state=CASE WHEN capability_kind IS NOT NULL AND activated_at IS NOT NULL THEN 'OPEN' ELSE capability_state END,
            updated_at=$3
          WHERE effect_id=$1 AND owner_runtime_identity=$4 AND owner_boot_id=$5
            AND state IN ('PREPARED','ACTIVE','SETTLING')`,
        [effectId,reasonCode,this.isoNow(),this.owner.runtimeIdentity,this.owner.bootId],
      );
    });
  }

  public async observe(): Promise<BackupArtifactEffectObservation> {
    const sampledAt = this.isoNow();
    const result = await this.db.query<{
      process_active: string | number; prepared: string | number; active: string | number; settling: string | number;
      unclosed: string | number; capabilities: string | number; unknown: string | number;
    }>(
      `SELECT
         count(*) FILTER (WHERE state IN ('ACTIVE','SETTLING') AND owner_runtime_identity=$1 AND owner_boot_id=$2)::text AS process_active,
         count(*) FILTER (WHERE state='PREPARED')::text AS prepared,
         count(*) FILTER (WHERE state='ACTIVE')::text AS active,
         count(*) FILTER (WHERE state='SETTLING')::text AS settling,
         count(*) FILTER (WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN'))::text AS unclosed,
         count(*) FILTER (WHERE capability_state='OPEN')::text AS capabilities,
         count(*) FILTER (WHERE state='UNKNOWN')::text AS unknown
       FROM maintenance_backup_artifact_effects`, [this.owner.runtimeIdentity,this.owner.bootId],
    );
    const row = result.rows[0];
    if (!row) throw unavailable('Artifact effect observation is unavailable.');
    return {
      observedAt: sampledAt,
      workObservedAt: sampledAt,
      owner: this.owner,
      processActiveEffects: count(row.process_active),
      preparedEffects: count(row.prepared),
      activeEffects: count(row.active),
      settlingEffects: count(row.settling),
      unclosedEffects: count(row.unclosed),
      unresolvedCapabilities: count(row.capabilities),
      unknownEffects: count(row.unknown),
    };
  }

  public async lookup(effectKey: string): Promise<BackupArtifactEffectHandle | undefined> {
    if (typeof effectKey !== 'string' || effectKey.length < 8 || effectKey.length > 512) {
      throw conflict('INVALID_ARGUMENT', 'Artifact effect key is invalid.');
    }
    const result = await this.db.query<Pick<EffectRow,'effect_id'|'state'>>(
      `SELECT effect_id,state FROM maintenance_backup_artifact_effects WHERE effect_key_sha256=$1`, [sha(effectKey)],
    );
    const row = result.rows[0];
    return row ? { effectId: row.effect_id, state: row.state, replayed: true } : undefined;
  }

  public async snapshotOpenCapabilities(input: { backupId: string; artifactPins: readonly BackupArtifactSnapshotPin[] }): Promise<BackupCapabilitySnapshot> {
    if (!isUuid(input.backupId) || !Array.isArray(input.artifactPins) || input.artifactPins.length > 2_000_000) {
      throw conflict('INVALID_ARGUMENT', 'Backup capability snapshot identity is invalid.');
    }
    const pins = new Map<string, BackupArtifactSnapshotPin>();
    for (const pin of input.artifactPins) {
      if (!isUuid(pin.artifactId) || !isUuid(pin.storageGenerationId)
        || typeof pin.storageVersionId !== 'string' || pin.storageVersionId.length < 1 || pin.storageVersionId.length > 1024
        || (pin.manifestVersionId !== null && (typeof pin.manifestVersionId !== 'string' || pin.manifestVersionId.length < 1 || pin.manifestVersionId.length > 1024))
        || pins.has(pin.artifactId)) throw conflict('INVALID_ARGUMENT', 'Backup artifact snapshot pin is invalid.');
      pins.set(pin.artifactId, pin);
    }
    const observedAt = this.isoNow();
    return this.db.tx(async (client) => {
      const gate = await lockGate(client, 'SHARE');
      if (gate.state !== 'HELD' || gate.backup_id !== input.backupId) {
        throw conflict('BACKUP_FENCE_OWNER_MISMATCH', 'Capability snapshot requires the active backup fence.');
      }
      const effects = await client.query<EffectRow>(
        `SELECT * FROM maintenance_backup_artifact_effects
          WHERE capability_state='OPEN' ORDER BY effect_id FOR UPDATE`,
      );
      const evidence: Array<Record<string, unknown>> = [];
      let includedExactVersion = 0;
      let excludedIncomplete = 0;
      for (const effect of effects.rows) {
        if (!effect.artifact_id) throw conflict('BACKUP_CAPABILITY_UNRESOLVED', 'An open upload capability has no artifact row.');
        const artifactResult = await client.query<{
          id:string;state:string;storage_generation_id:string|null;storage_version_id:string|null;manifest_version_id:string|null;
        }>(
          `SELECT id,state,storage_generation_id::text,storage_version_id,manifest_version_id
             FROM artifacts WHERE id=$1 FOR SHARE`, [effect.artifact_id],
        );
        const artifact = artifactResult.rows[0];
        if (!artifact) throw conflict('BACKUP_CAPABILITY_UNRESOLVED', 'An open upload capability has no retained artifact metadata.');
        const pin = pins.get(artifact.id);
        let disposition: 'INCLUDED_EXACT_VERSION' | 'EXCLUDED_INCOMPLETE';
        if (artifact.state === 'READY') {
          if (!pin || pin.storageGenerationId !== artifact.storage_generation_id
            || pin.storageVersionId !== artifact.storage_version_id || pin.manifestVersionId !== artifact.manifest_version_id
            || effect.storage_generation_id !== artifact.storage_generation_id) {
            throw conflict('BACKUP_CAPABILITY_UNRESOLVED', 'A ready upload capability is not covered by the exact immutable artifact snapshot.');
          }
          disposition = 'INCLUDED_EXACT_VERSION';
          includedExactVersion += 1;
        } else {
          if (pin || !['STAGING','EXPIRED','DELETED','FAILED','ABORTED'].includes(artifact.state)) {
            throw conflict('BACKUP_CAPABILITY_UNRESOLVED', 'An incomplete upload capability has an inconsistent artifact snapshot.');
          }
          disposition = 'EXCLUDED_INCOMPLETE';
          excludedIncomplete += 1;
        }
        const rowEvidence = {
          backupId: input.backupId, effectId: effect.effect_id, artifactId: artifact.id,
          disposition, artifactState: artifact.state,
          storageGenerationId: artifact.storage_generation_id,
          storageVersionId: artifact.storage_version_id,
          manifestVersionId: artifact.manifest_version_id,
        };
        const proofSha = sha(JSON.stringify(canonical(rowEvidence)));
        const prior = await client.query<{proof_sha256:string}>(
          `SELECT proof_sha256 FROM maintenance_backup_capability_snapshots WHERE backup_id=$1 AND effect_id=$2`,
          [input.backupId,effect.effect_id],
        );
        if (prior.rows[0] && prior.rows[0].proof_sha256 !== proofSha) {
          throw conflict('BACKUP_CAPABILITY_SNAPSHOT_CONFLICT', 'Capability snapshot evidence changed during backup replay.');
        }
        if (!prior.rows[0]) {
          await client.query(
            `INSERT INTO maintenance_backup_capability_snapshots
              (backup_id,effect_id,disposition,artifact_state,storage_generation_id,storage_version_id,manifest_version_id,proof_sha256,observed_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [input.backupId,effect.effect_id,disposition,artifact.state,artifact.storage_generation_id,
              artifact.storage_version_id,artifact.manifest_version_id,proofSha,observedAt],
          );
        }
        evidence.push(rowEvidence);
      }
      const evidenceSha256 = sha(JSON.stringify(canonical(evidence)));
      return { observedAt, openCapabilities: effects.rowCount ?? effects.rows.length, includedExactVersion, excludedIncomplete, evidenceSha256 };
    });
  }

  private isOwned(row: EffectRow): boolean {
    return row.owner_runtime_identity === this.owner.runtimeIdentity && row.owner_boot_id === this.owner.bootId;
  }

  private isoNow(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw unavailable('Artifact effect clock is invalid.');
    return value.toISOString();
  }
}

/** Persist the Host-owned backup overlay without changing ordinary controls. */
export class PostgresBackupSnapshotFence {
  public constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  public async hold(input: {
    fenceId: string; backupId: string; execution: MaintenanceExecutionFence; expectedFenceRevision: number;
    priorControlStates: Record<string, unknown>;
  }): Promise<{ fenceId: string; fenceRevision: number; state: 'HELD' }> {
    const execution = input.execution;
    if (!isUuid(input.fenceId) || !isUuid(input.backupId) || !isUuid(execution.jobId) || !isUuid(execution.ownerBootId)
      || !isSafeId(execution.ownerRuntimeIdentity) || !isSafeId(execution.itemId)
      || execution.executionToken.length < 32 || execution.executionToken.length > 512
      || !Number.isSafeInteger(execution.executionFence) || execution.executionFence < 1
      || !Number.isSafeInteger(input.expectedFenceRevision) || input.expectedFenceRevision < 0) {
      throw conflict('INVALID_ARGUMENT', 'Backup snapshot fence identity is invalid.');
    }
    return this.db.tx(async (client) => {
      const selected = await client.query<GateRow>(
        `SELECT state,fence_id,fence_revision,backup_id,maintenance_job_id,owner_item_id,owner_runtime_identity,
                owner_boot_id,owner_execution_fence,execution_token_sha256,last_fence_id,last_execution_token_sha256,
                last_owner_runtime_identity,last_owner_boot_id,last_maintenance_job_id,last_owner_item_id,last_owner_execution_fence
           FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR UPDATE`,
      );
      const gate = selected.rows[0];
      if (!gate) throw unavailable('Backup snapshot fence row is not initialized.');
      const revision = checkedRevision(gate.fence_revision);
      const executionHash = sha(execution.executionToken);
      // Verify the durable RUNNING item claim even on an idempotent retry of
      // the same held fence. A surviving gate row is not proof this executor
      // still owns the live job-item lease.
      await assertCurrentExecution(client,execution);
      if (gate.state === 'HELD' && gate.fence_id === input.fenceId && revision === input.expectedFenceRevision + 1) {
        assertFenceOwner(gate,input.backupId,execution,executionHash);
        return { fenceId: input.fenceId, fenceRevision: revision, state: 'HELD' as const };
      }
      if (gate.state !== 'OPEN' || revision !== input.expectedFenceRevision) {
        throw conflict('BACKUP_FENCE_CAS_FAILED', 'Backup snapshot fence revision changed; refresh before retrying.');
      }
      const nextRevision = revision + 1;
      const updated = await client.query(
        `UPDATE maintenance_backup_effect_gate SET state='HELD',fence_id=$1,fence_revision=$2,backup_id=$3,
            maintenance_job_id=$4,owner_item_id=$5,owner_runtime_identity=$6,owner_boot_id=$7,
            owner_execution_fence=$8,execution_token_sha256=$9,prior_control_states=$10::jsonb,
            requested_at=$11,updated_at=$11
          WHERE singleton_id=1 AND state='OPEN' AND fence_revision=$12`,
        [input.fenceId,nextRevision,input.backupId,execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,
          execution.ownerBootId,execution.executionFence,executionHash,JSON.stringify(input.priorControlStates),this.isoNow(),revision],
      );
      if (updated.rowCount !== 1) throw conflict('BACKUP_FENCE_CAS_FAILED', 'Backup snapshot fence changed concurrently.');
      // PREPARED artifact permits are proven pre-send. Once HELD, their
      // activate CAS will fail, so close them durably here. ACTIVE work must
      // quiesce; UNKNOWN history remains intact and is carried in the bundle.
      await client.query(
        `UPDATE maintenance_backup_artifact_effects
            SET state='CANCELLED',reason_code='BACKUP_EFFECT_FENCE_ACTIVE',settled_at=$1::timestamptz,updated_at=$1::timestamptz
          WHERE state='PREPARED'`,
        [this.isoNow()],
      );
      return { fenceId: input.fenceId, fenceRevision: nextRevision, state: 'HELD' as const };
    });
  }

  public async release(input: {
    fenceId: string; fenceRevision: number; backupId: string; execution: MaintenanceExecutionFence; restorePriorState: true;
  }): Promise<void> {
    const execution = input.execution;
    if (!isUuid(input.fenceId) || !isUuid(input.backupId) || !isUuid(execution.jobId)
      || !isUuid(execution.ownerBootId) || !isSafeId(execution.ownerRuntimeIdentity) || !isSafeId(execution.itemId)
      || execution.executionToken.length < 32 || execution.executionToken.length > 512
      || !Number.isSafeInteger(execution.executionFence) || execution.executionFence < 1
      || !Number.isSafeInteger(input.fenceRevision) || input.fenceRevision < 1 || input.restorePriorState !== true) {
      throw conflict('INVALID_ARGUMENT', 'Backup snapshot fence release identity is invalid.');
    }
    await this.db.tx(async (client) => {
      const selected = await client.query<GateRow>(
        `SELECT state,fence_id,fence_revision,backup_id,maintenance_job_id,owner_item_id,owner_runtime_identity,
                owner_boot_id,owner_execution_fence,execution_token_sha256,last_fence_id,last_execution_token_sha256,
                last_owner_runtime_identity,last_owner_boot_id,last_maintenance_job_id,last_owner_item_id,last_owner_execution_fence
           FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR UPDATE`,
      );
      const gate = selected.rows[0];
      if (!gate) throw unavailable('Backup snapshot fence row is not initialized.');
      const executionHash = sha(execution.executionToken);
      if (gate.state === 'OPEN' && gate.last_fence_id === input.fenceId
        && gate.last_execution_token_sha256 === executionHash
        && gate.last_owner_runtime_identity === execution.ownerRuntimeIdentity
        && gate.last_owner_boot_id === execution.ownerBootId
        && gate.last_maintenance_job_id === execution.jobId
        && gate.last_owner_item_id === execution.itemId
        && Number(gate.last_owner_execution_fence) === execution.executionFence
        && checkedRevision(gate.fence_revision) === input.fenceRevision) return;
      if (gate.state !== 'HELD' || gate.fence_id !== input.fenceId || gate.backup_id !== input.backupId
        || checkedRevision(gate.fence_revision) !== input.fenceRevision) {
        throw conflict('BACKUP_FENCE_CAS_FAILED', 'Backup snapshot fence is no longer owned by this execution.');
      }
      assertFenceOwner(gate,input.backupId,execution,executionHash);
      await assertCurrentExecution(client,execution);
      const unresolved = await client.query<{ count: string | number }>(
        `SELECT count(*)::text AS count FROM maintenance_backup_artifact_effects
          WHERE state IN ('PREPARED','ACTIVE','SETTLING')`,
      );
      if (count(unresolved.rows[0]?.count) !== 0) {
        throw conflict('BACKUP_EFFECTS_ACTIVE', 'Backup snapshot cannot release while artifact effects remain active.');
      }
      const unrecordedCapabilities = await client.query<{ count: string | number }>(
        `SELECT count(*)::text AS count FROM maintenance_backup_artifact_effects e
          WHERE e.capability_state='OPEN'
            AND NOT EXISTS (SELECT 1 FROM maintenance_backup_capability_snapshots s
              WHERE s.backup_id=$1 AND s.effect_id=e.effect_id)`, [input.backupId],
      );
      if (count(unrecordedCapabilities.rows[0]?.count) !== 0) {
        throw conflict('BACKUP_CAPABILITIES_UNRESOLVED', 'Backup snapshot cannot release until every open upload capability has exact snapshot evidence.');
      }
      const updated = await client.query(
        `UPDATE maintenance_backup_effect_gate SET state='OPEN',last_fence_id=fence_id,
            last_execution_token_sha256=execution_token_sha256,last_owner_runtime_identity=owner_runtime_identity,
            last_owner_boot_id=owner_boot_id,last_maintenance_job_id=maintenance_job_id,last_owner_item_id=owner_item_id,
            last_owner_execution_fence=owner_execution_fence,
            fence_id=NULL,backup_id=NULL,maintenance_job_id=NULL,owner_item_id=NULL,
            owner_runtime_identity=NULL,owner_boot_id=NULL,owner_execution_fence=NULL,
            execution_token_sha256=NULL,prior_control_states=NULL,
            requested_at=NULL,updated_at=$2 WHERE singleton_id=1 AND state='HELD' AND fence_id=$1 AND fence_revision=$3`,
        [input.fenceId,this.isoNow(),input.fenceRevision],
      );
      if (updated.rowCount !== 1) throw conflict('BACKUP_FENCE_CAS_FAILED', 'Backup snapshot fence changed during release.');
    });
  }

  private isoNow(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw unavailable('Backup snapshot fence clock is invalid.');
    return value.toISOString();
  }
}

async function lockGate(client: Pick<PoolClient,'query'>, mode: 'SHARE' | 'UPDATE'): Promise<GateRow> {
  let selected;
  try {
    selected = await client.query<GateRow>(
      `SELECT state,fence_id,fence_revision,backup_id,maintenance_job_id,owner_item_id,owner_runtime_identity,
              owner_boot_id,owner_execution_fence,execution_token_sha256,last_fence_id,last_execution_token_sha256,
              last_owner_runtime_identity,last_owner_boot_id,last_maintenance_job_id,last_owner_item_id,last_owner_execution_fence
         FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR ${mode}`,
    );
  } catch {
    throw unavailable('Backup snapshot effect gate is unavailable; the operation was refused.');
  }
  const row = selected.rows[0];
  if (!row) throw unavailable('Backup snapshot effect gate is not initialized; the operation was refused.');
  return row;
}

async function assertCurrentExecution(client: Pick<PoolClient,'query'>, execution: MaintenanceExecutionFence): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM maintenance_job_items
      WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3
        AND owner_boot_id=$4 AND execution_fence=$5 AND backup_execution_token_sha256=$6
        AND claim_until>now() FOR SHARE`,
    [execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,execution.ownerBootId,
      execution.executionFence,sha(execution.executionToken)],
  );
  if (result.rowCount !== 1) throw conflict('MAINTENANCE_EXECUTION_FENCE_LOST', 'Backup operation no longer owns its current durable maintenance claim.');
}

function validateBegin(input: BackupArtifactEffectBegin): void {
  if (!input || typeof input.effectKey !== 'string' || input.effectKey.length < 8 || input.effectKey.length > 512
    || !['grant-issue','ingestion-write','encrypted-upload','multipart-part','multipart-complete','multipart-abort',
      'metadata-mutation','artifact-delete','generation-activation','storage-generation-test','cleanup'].includes(input.category)
    || (input.tenantId !== null && !isTenantUuid(input.tenantId)) || (input.artifactId != null && !isUuid(input.artifactId))
    || !isUuid(input.storageGenerationId)
    || (input.objectKeySha256 != null && !/^[a-f0-9]{64}$/.test(input.objectKeySha256))) {
    throw conflict('INVALID_ARGUMENT', 'Artifact effect request is invalid.');
  }
  if (input.capability) {
    if (!input.capability.capabilityId || input.capability.capabilityId.length > 512
      || (input.capability.expiresAt !== null && !Number.isFinite(Date.parse(input.capability.expiresAt)))) {
      throw conflict('INVALID_ARGUMENT', 'Artifact capability registration is invalid.');
    }
  }
  if (input.category === 'grant-issue' && !input.capability) {
    throw conflict('INVALID_ARGUMENT', 'Grant issuance requires a registered capability.');
  }
}

function validateProof(proof: BackupArtifactEffectProof): void {
  const hashOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
  const versionOrNull = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 1024);
  const sizeOrNull = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if (!proof || !versionOrNull(proof.objectVersionId) || !hashOrNull(proof.objectSha256) || !sizeOrNull(proof.objectByteSize)
    || !versionOrNull(proof.sidecarVersionId) || !hashOrNull(proof.sidecarSha256) || !sizeOrNull(proof.sidecarByteSize)
    || !hashOrNull(proof.metadataRowSha256)) throw conflict('INVALID_ARGUMENT', 'Artifact settlement proof is invalid.');
}

function requireProofForCategory(category: BackupArtifactEffectCategory, proof: BackupArtifactEffectProof): void {
  if (category === 'grant-issue') {
    if (!proof.metadataRowSha256) throw conflict('BACKUP_EFFECT_PROOF_MISSING', 'Exact grant row readback proof is required.');
    return;
  }
  if (category === 'metadata-mutation' || category === 'generation-activation' || category === 'cleanup') {
    if (!proof.metadataRowSha256) throw conflict('BACKUP_EFFECT_PROOF_MISSING', 'Exact metadata readback proof is required.');
    return;
  }
  if (!proof.objectVersionId || !proof.objectSha256 || proof.objectByteSize === null
    || !proof.sidecarVersionId || !proof.sidecarSha256 || proof.sidecarByteSize === null || !proof.metadataRowSha256) {
    throw conflict('BACKUP_EFFECT_PROOF_MISSING', 'Object, encrypted sidecar, and metadata readback proof are required.');
  }
}

function assertFenceOwner(gate: GateRow, backupId: string, execution: MaintenanceExecutionFence, tokenHash: string): void {
  if (gate.backup_id !== backupId || gate.maintenance_job_id !== execution.jobId || gate.owner_item_id !== execution.itemId
    || gate.owner_runtime_identity !== execution.ownerRuntimeIdentity || gate.owner_boot_id !== execution.ownerBootId
    || Number(gate.owner_execution_fence) !== execution.executionFence
    || gate.execution_token_sha256 !== tokenHash) {
    throw conflict('BACKUP_FENCE_OWNER_MISMATCH', 'Backup snapshot fence owner does not match this execution.');
  }
}

function checkedRevision(value: string | number): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw unavailable('Backup snapshot fence revision is invalid.');
  return revision;
}
function count(value: string | number | undefined): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable('Backup effect count is invalid.');
  return result;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isSafeId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
