import { createHash, randomUUID } from 'node:crypto';
import {
  ConnectorBackupEffectFenceCommandSchema,
  ConnectorBackupEffectFenceObservationRequestSchema,
  ConnectorBackupEffectFenceObservationSchema,
  isTenantUuid,
  type ConnectorBackupEffectFenceCommand,
  type ConnectorBackupEffectFenceObservation,
  type ConnectorBackupEffectFenceObservationRequest,
  type ConnectorReplicaIdentity,
} from '@du/contracts';
import { ConnectorError } from '../errors';
import type { SqlClient } from './sql';

export interface BackupEffectGateRow {
  fence_id: string | null;
  fence_revision: number | string;
  state: 'OPEN' | 'HELD' | 'UNKNOWN';
}

export async function lockConnectorBackupEffectGate(
  tx: SqlClient,
  mode: 'SHARE' | 'UPDATE' = 'SHARE',
): Promise<BackupEffectGateRow> {
  const result = await tx.query<BackupEffectGateRow>(
    `SELECT fence_id,fence_revision,state FROM connector_backup_effect_gate
      WHERE singleton_id=1 FOR ${mode}`,
  );
  const row = result.rows[0];
  if (!row) throw unavailable('Connector backup effect gate is not initialized.');
  return row;
}

export function assertConnectorBackupEffectGateOpen(row: BackupEffectGateRow): void {
  if (row.state !== 'OPEN') {
    throw new ConnectorError('CONNECTOR_DISABLED', 'Connector external effects are held for a maintenance backup.');
  }
}

export interface ConnectorEffectOwner {
  replicaId: string;
  runtimeIdentity: string;
  bootId: string;
}

export interface ConnectorUsagePermitRow {
  eventId: string;
  invocationId: string;
  payload: unknown;
  attempts: number;
  failedAttempts: number;
  createdAt: string;
  nextAttemptAt: string;
  deliveryToken: string;
}

/** Durable fence for typed-recipe/config mutations that cross a process
 * boundary (notably exact-version KV2 credential writes). The caller locks
 * the singleton gate before every revision/intent row lock, stages PREPARED
 * in that same transaction, and activates immediately before external I/O. */
export interface ConnectorBackupConfigWritePort {
  prepare(client: SqlClient, input: {
    effectId: string;
    tenantId: string;
    connectorId: string;
    idempotencyKey: string;
  }): Promise<void>;
  activate(effectId: string): Promise<boolean>;
  complete(client: SqlClient, effectId: string): Promise<void>;
  markUnknown(effectId: string, reasonCode: string): Promise<void>;
}

export async function insertConnectorEffectPermit(
  tx: SqlClient,
  input: ConnectorEffectOwner & {
    effectId: string;
    domain: 'provider' | 'poll' | 'usage' | 'config';
    operationId?: string;
    invocationId?: string;
    eventId?: string;
    ownerToken?: string;
    fenceRevision: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO connector_backup_effect_permits
      (effect_id,domain,operation_id,invocation_id,event_id,owner_replica_id,owner_runtime_identity,
       owner_boot_id,owner_token,fence_revision,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED')`,
    [input.effectId, input.domain, input.operationId ?? null, input.invocationId ?? null, input.eventId ?? null,
      input.replicaId, input.runtimeIdentity, input.bootId, input.ownerToken ?? input.effectId, input.fenceRevision],
  );
}

interface RegisteredReplicaRow {
  replica_id: string;
  runtime_identity: string;
  slot: string;
  revision: string;
  image_digest: string;
  control_state: 'OPEN' | 'DRAINING';
}

export class PostgresConnectorBackupEffectControl implements ConnectorBackupConfigWritePort {
  public constructor(
    private readonly db: SqlClient,
    private readonly identity: ConnectorReplicaIdentity,
    private readonly bootId: string = randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async hold(raw: ConnectorBackupEffectFenceCommand): Promise<ConnectorBackupEffectFenceObservation> {
    const command = ConnectorBackupEffectFenceCommandSchema.parse(raw);
    this.assertExpectedIdentity(command);
    if (command.action !== 'HOLD') throw invalid('hold endpoint requires HOLD action');
    const executionTokenSha256 = hash(command.executionToken);
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx, 'UPDATE');
      const currentRevision = integer(gate.fence_revision);
      const sameFence = gate.state === 'HELD'
        && gate.fence_id === command.fenceId
        && currentRevision === command.fenceRevision;
      if (!sameFence) {
        if (gate.state !== 'OPEN'
          || currentRevision !== command.expectedFenceRevision
          || command.fenceRevision !== currentRevision + 1) {
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence revision changed; refresh before retrying.');
        }
        const updated = await tx.query(
          `UPDATE connector_backup_effect_gate
              SET fence_id=$1,fence_revision=$2,state='HELD',backup_id=$3,maintenance_job_id=$4,
                  maintenance_item_id=$5,maintenance_execution_fence=$6,owner_runtime_identity=$7,
                  owner_boot_id=$8,execution_token_sha256=$9,requested_at=$10,updated_at=$10
            WHERE singleton_id=1 AND state='OPEN' AND fence_revision=$11`,
          [command.fenceId, command.fenceRevision, command.backupId, command.maintenanceJobId,
            command.maintenanceItemId,command.maintenanceExecutionFence,command.ownerRuntimeIdentity,
            command.ownerBootId,executionTokenSha256,this.isoNow(),command.expectedFenceRevision],
        );
        if (updated.rowCount !== 1) throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence changed concurrently.');
        // A PREPARED permit has not crossed the send boundary. The gate and
        // activation both lock this row, so after this CAS no old process can
        // activate it. Preserve pending polls and make unsent first attempts
        // terminal; do not touch already ACTIVE/UNKNOWN effects.
        await this.cancelPreparedEffects(tx);
      } else {
        await this.assertFenceOwner(tx, command, executionTokenSha256);
      }
      await this.acknowledge(tx, command.fenceId, command.fenceRevision);
      return this.observeInTransaction(tx, { ...command, expectedFenceRevision: command.fenceRevision });
    });
  }

  public async release(raw: ConnectorBackupEffectFenceCommand): Promise<{ released: true; fenceRevision: number }> {
    const command = ConnectorBackupEffectFenceCommandSchema.parse(raw);
    this.assertExpectedIdentity(command);
    if (command.action !== 'RELEASE') throw invalid('release endpoint requires RELEASE action');
    const executionTokenSha256 = hash(command.executionToken);
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx, 'UPDATE');
      const currentRevision = integer(gate.fence_revision);
      if (gate.state === 'OPEN') {
        const prior = await tx.query<{
          last_fence_id:string|null;last_execution_token_sha256:string|null;last_owner_runtime_identity:string|null;
          last_owner_boot_id:string|null;last_maintenance_job_id:string|null;last_maintenance_item_id:string|null;
          last_maintenance_execution_fence:string|number|null;
        }>(
          `SELECT last_fence_id,last_execution_token_sha256,last_owner_runtime_identity,last_owner_boot_id,
                  last_maintenance_job_id,last_maintenance_item_id,last_maintenance_execution_fence
             FROM connector_backup_effect_gate WHERE singleton_id=1`,
        );
        if (currentRevision === command.fenceRevision
          && prior.rows[0]?.last_fence_id === command.fenceId
          && prior.rows[0]?.last_execution_token_sha256 === executionTokenSha256
          && prior.rows[0]?.last_owner_runtime_identity === command.ownerRuntimeIdentity
          && prior.rows[0]?.last_owner_boot_id === command.ownerBootId
          && prior.rows[0]?.last_maintenance_job_id === command.maintenanceJobId
          && prior.rows[0]?.last_maintenance_item_id === command.maintenanceItemId
          && Number(prior.rows[0]?.last_maintenance_execution_fence) === command.maintenanceExecutionFence) {
          return { released: true as const, fenceRevision: currentRevision };
        }
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence is no longer owned by this execution.');
      }
      if (gate.state !== 'HELD'
        || gate.fence_id !== command.fenceId
        || currentRevision !== command.fenceRevision
        || command.expectedFenceRevision !== currentRevision) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence revision changed; refresh before release.');
      }
      await this.assertFenceOwner(tx, command, executionTokenSha256);
      const open = await tx.query<{ count: string | number }>(
        `SELECT count(*)::text AS count FROM connector_backup_effect_permits
          WHERE state IN ('PREPARED','ACTIVE','SETTLING')`,
      );
      if (integer(open.rows[0]?.count) !== 0) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence has active external effects.');
      }
      const updated = await tx.query(
        `UPDATE connector_backup_effect_gate
            SET state='OPEN',fence_id=NULL,backup_id=NULL,maintenance_job_id=NULL,
                last_fence_id=fence_id,last_execution_token_sha256=execution_token_sha256,
                last_owner_runtime_identity=owner_runtime_identity,last_maintenance_job_id=maintenance_job_id,
                last_owner_boot_id=owner_boot_id,last_maintenance_item_id=maintenance_item_id,
                last_maintenance_execution_fence=maintenance_execution_fence,
                maintenance_item_id=NULL,maintenance_execution_fence=NULL,owner_runtime_identity=NULL,
                owner_boot_id=NULL,execution_token_sha256=NULL,requested_at=NULL,updated_at=$2
          WHERE singleton_id=1 AND state='HELD' AND fence_id=$1 AND fence_revision=$3`,
        [command.fenceId, this.isoNow(), command.fenceRevision],
      );
      if (updated.rowCount !== 1) throw new ConnectorError('INVOCATION_UNKNOWN', 'Connector backup fence changed during release.');
      return { released: true as const, fenceRevision: currentRevision };
    });
  }

  public async observe(raw: ConnectorBackupEffectFenceObservationRequest): Promise<ConnectorBackupEffectFenceObservation> {
    const request = ConnectorBackupEffectFenceObservationRequestSchema.parse(raw);
    this.assertExpectedIdentity(request);
    return this.db.transaction(async (tx) => this.observeInTransaction(tx, request));
  }

  /** Claim durable outbox rows and their effect permits under the same gate
   * lock. Expired CLAIMED/SENDING/UNKNOWN rows are deliberately not reclaimed. */
  public async claimUsageBatch(limit: number, now = this.isoNow()): Promise<ConnectorUsagePermitRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('usage batch size is invalid');
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      if (gate.state !== 'OPEN') return [];
      const selected = await tx.query<{
        event_id: string; invocation_id: string; payload: unknown; attempts: number;
        failed_attempts: number; created_at: Date | string; next_attempt_at: Date | string;
      }>(
        `SELECT event_id,invocation_id,payload,attempts,failed_attempts,created_at,next_attempt_at
           FROM connector_usage_outbox
          WHERE delivered_at IS NULL AND delivery_state='READY' AND delivery_claim_token IS NULL AND next_attempt_at <= $1
          ORDER BY next_attempt_at,created_at,event_id FOR UPDATE SKIP LOCKED LIMIT $2`, [now, limit],
      );
      const result: ConnectorUsagePermitRow[] = [];
      for (const row of selected.rows) {
        const token = randomUUID();
        const effectId = randomUUID();
        const leaseExpiresAt = new Date(Date.parse(now) + 60_000);
        if (!Number.isFinite(leaseExpiresAt.getTime())) throw unavailable('usage claim clock is invalid');
        const claimed = await tx.query(
          `UPDATE connector_usage_outbox SET attempts=attempts+1,delivery_owner_replica_id=$2,
              delivery_owner_runtime_identity=$3,delivery_owner_boot_id=$4,delivery_claim_token=$5,
              delivery_lease_expires_at=$6,delivery_effect_id=$7,delivery_state='CLAIMED',delivery_updated_at=$8
            WHERE event_id=$1 AND delivery_state='READY' AND delivery_claim_token IS NULL AND delivered_at IS NULL`,
          [row.event_id, this.identity.replicaId, this.identity.runtimeIdentity, this.bootId,
            token, leaseExpiresAt.toISOString(), effectId, now],
        );
        if (claimed.rowCount !== 1) continue;
        await insertConnectorEffectPermit(tx, {
          effectId, domain: 'usage', eventId: row.event_id, invocationId: row.invocation_id,
          replicaId: this.identity.replicaId, runtimeIdentity: this.identity.runtimeIdentity,
          bootId: this.bootId, ownerToken: token, fenceRevision: integer(gate.fence_revision),
        });
        result.push({
          eventId: row.event_id,
          invocationId: row.invocation_id,
          payload: row.payload,
          attempts: Number(row.attempts) + 1,
          failedAttempts: Number(row.failed_attempts),
          createdAt: dateText(row.created_at),
          nextAttemptAt: dateText(row.next_attempt_at),
          deliveryToken: token,
        });
      }
      return result;
    });
  }

  /** Stage a configuration permit in the draft-intent transaction. This
   * method intentionally does not acquire the gate itself: the repository
   * must have acquired it as the first row lock before touching the chain. */
  public async prepare(client: SqlClient, input: {
    effectId: string; tenantId: string; connectorId: string; idempotencyKey: string;
  }): Promise<void> {
    if (!isUuid(input.effectId) || !isTenantUuid(input.tenantId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.connectorId)
      || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw invalid('configuration effect identity is invalid');
    }
    const gate = await lockConnectorBackupEffectGate(client);
    assertConnectorBackupEffectGateOpen(gate);
    await insertConnectorEffectPermit(client, {
      effectId: input.effectId,
      domain: 'config',
      operationId: `${input.tenantId}:${input.connectorId}:${input.idempotencyKey}`,
      replicaId: this.identity.replicaId,
      runtimeIdentity: this.identity.runtimeIdentity,
      bootId: this.bootId,
      ownerToken: input.effectId,
      fenceRevision: integer(gate.fence_revision),
    });
  }

  /** Final CAS before a Vault KV2 request or the final revision transaction.
   * PREPARED is rebindable because it proves no network call began. UNKNOWN is
   * deliberately never taken over based on lease expiry or a new process. */
  public async activate(effectId: string): Promise<boolean> {
    if (!isUuid(effectId)) throw invalid('configuration effect identifier is invalid');
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      if (gate.state !== 'OPEN') return false;
      const selected = await tx.query<{
        state:string;owner_replica_id:string;owner_runtime_identity:string;owner_boot_id:string;owner_token:string;
        fence_revision:string|number;reason_code:string|null;
      }>(
        `SELECT state,owner_replica_id,owner_runtime_identity,owner_boot_id,owner_token,fence_revision,reason_code
           FROM connector_backup_effect_permits WHERE effect_id=$1 AND domain='config' FOR UPDATE`, [effectId],
      );
      const row = selected.rows[0];
      if (!row) return false;
      if (row.state === 'ACTIVE') {
        return row.owner_replica_id === this.identity.replicaId && row.owner_runtime_identity === this.identity.runtimeIdentity
          && row.owner_boot_id === this.bootId;
      }
      const rebindable = row.state === 'PREPARED'
        || (row.state === 'CANCELLED' && row.reason_code === 'BACKUP_FENCE_ACTIVE')
        // The exact planned Vault writer first reads the pinned target version
        // and only issues a CAS for that same version/hash. Re-activating this
        // permit keeps that reconciliation counted while it runs; UNKNOWN is
        // never converted directly to completed or ignored.
        || (row.state === 'UNKNOWN' && row.reason_code === 'VAULT_WRITE_AMBIGUOUS');
      if (!rebindable) return false;
      const token = row.owner_boot_id === this.bootId && row.owner_replica_id === this.identity.replicaId
        ? row.owner_token : randomUUID();
      const updated = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='ACTIVE',owner_replica_id=$2,owner_runtime_identity=$3,
            owner_boot_id=$4,owner_token=$5,fence_revision=$6,activated_at=$7,settled_at=NULL,reason_code=NULL,updated_at=$7
          WHERE effect_id=$1 AND domain='config'
            AND (state='PREPARED' OR (state='CANCELLED' AND reason_code='BACKUP_FENCE_ACTIVE')
              OR (state='UNKNOWN' AND reason_code='VAULT_WRITE_AMBIGUOUS'))`,
        [effectId,this.identity.replicaId,this.identity.runtimeIdentity,this.bootId,token,integer(gate.fence_revision),this.isoNow()],
      );
      return updated.rowCount === 1;
    });
  }

  /** Settle the exact config permit atomically with its immutable revision
   * write. Existing ACTIVE work may settle while the gate is HELD; the backup
   * collector waits for this transaction before snapshotting. */
  public async complete(client: SqlClient, effectId: string): Promise<void> {
    if (!isUuid(effectId)) throw invalid('configuration effect identifier is invalid');
    await lockConnectorBackupEffectGate(client);
    const result = await client.query(
      `UPDATE connector_backup_effect_permits SET state='COMPLETED',settled_at=$2,updated_at=$2
        WHERE effect_id=$1 AND domain='config' AND state='ACTIVE'
          AND owner_replica_id=$3 AND owner_runtime_identity=$4 AND owner_boot_id=$5`,
      [effectId,this.isoNow(),this.identity.replicaId,this.identity.runtimeIdentity,this.bootId],
    );
    if (result.rowCount !== 1) throw new ConnectorError('INVOCATION_UNKNOWN', 'Configuration effect permit is not owned by this process.');
  }

  /** Network errors after activation are ambiguous until exact Vault-version
   * reconciliation proves whether the write committed. Keep the permit held. */
  public async markUnknown(effectId: string, reasonCode: string): Promise<void> {
    if (!isUuid(effectId) || !/^[A-Z0-9_]{1,80}$/.test(reasonCode)) throw invalid('configuration effect uncertainty is invalid');
    await this.db.transaction(async (tx) => {
      await lockConnectorBackupEffectGate(tx);
      const changed = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='UNKNOWN',reason_code=$2,updated_at=$3
          WHERE effect_id=$1 AND domain='config' AND owner_replica_id=$4 AND owner_runtime_identity=$5
            AND owner_boot_id=$6 AND state IN ('ACTIVE','SETTLING')`,
        [effectId,reasonCode,this.isoNow(),this.identity.replicaId,this.identity.runtimeIdentity,this.bootId],
      );
      if (changed.rowCount !== 1) throw new ConnectorError('INVOCATION_UNKNOWN', 'Configuration effect permit cannot be fenced as unknown.');
    });
  }

  /** Atomically cross the last local gate before provider or poll traffic. */
  public async activateInvocation(invocationId: string, pollLeaseToken?: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      const isPoll = pollLeaseToken !== undefined;
      const effect = await tx.query<{ effect_id: string; state: string }>(
        `SELECT effect_id,state FROM connector_backup_effect_permits
          WHERE domain=$1 AND invocation_id=$2 AND owner_replica_id=$3 AND owner_boot_id=$4
            AND owner_token=COALESCE($5::uuid,effect_id) FOR UPDATE`,
        [isPoll ? 'poll' : 'provider', invocationId, this.identity.replicaId, this.bootId, pollLeaseToken ?? null],
      );
      const row = effect.rows[0];
      if (!row || row.state !== 'PREPARED') return false;
      if (gate.state !== 'OPEN') {
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='CANCELLED',settled_at=$2,updated_at=$2,reason_code='BACKUP_FENCE_ACTIVE'
            WHERE effect_id=$1 AND state='PREPARED'`, [row.effect_id, this.isoNow()],
        );
        if (isPoll) {
          await tx.query(
            `UPDATE connector_invocations SET state='PENDING',poll_lease_token=NULL,poll_lease_expires_at=NULL,
                poll_effect_id=NULL,updated_at=$3
              WHERE invocation_id=$1 AND state='POLLING' AND poll_lease_token=$2`,
            [invocationId, pollLeaseToken, this.isoNow()],
          );
        } else {
          await tx.query(
            `UPDATE connector_invocations SET state='FAILED',error_code='PROVIDER_UNAVAILABLE',provider_effect_id=NULL,updated_at=$2
              WHERE invocation_id=$1 AND state='IN_FLIGHT' AND provider_effect_id=$3`,
            [invocationId, this.isoNow(), row.effect_id],
          );
        }
        return false;
      }
      const activated = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='ACTIVE',activated_at=$2,updated_at=$2
          WHERE effect_id=$1 AND state='PREPARED' AND fence_revision=$3`,
        [row.effect_id, this.isoNow(), integer(gate.fence_revision)],
      );
      return activated.rowCount === 1;
    });
  }

  public async settleInvocation(invocationId: string, pollLeaseToken?: string): Promise<void> {
    const isPoll = pollLeaseToken !== undefined;
    await this.db.query(
      `UPDATE connector_backup_effect_permits SET state=CASE WHEN state='PREPARED' THEN 'CANCELLED' ELSE 'COMPLETED' END,
          settled_at=$4,updated_at=$4
        WHERE domain=$1 AND invocation_id=$2 AND owner_replica_id=$3 AND owner_boot_id=$5
          AND ($6::uuid IS NULL AND effect_id=(SELECT provider_effect_id FROM connector_invocations WHERE invocation_id=$2)
            OR $6::uuid IS NOT NULL AND owner_token=$6::uuid)
          AND state IN ('PREPARED','ACTIVE','SETTLING')`,
      [isPoll ? 'poll' : 'provider', invocationId, this.identity.replicaId, this.isoNow(), this.bootId, pollLeaseToken ?? null],
    );
  }

  public async markInvocationUnknown(invocationId: string, pollLeaseToken?: string, reasonCode = 'INVOCATION_UNKNOWN'): Promise<void> {
    await this.db.query(
      `UPDATE connector_backup_effect_permits SET state='UNKNOWN',reason_code=$5,updated_at=$6
        WHERE domain=$1 AND invocation_id=$2 AND owner_replica_id=$3 AND owner_boot_id=$4
          AND ($7::uuid IS NULL AND effect_id=(SELECT provider_effect_id FROM connector_invocations WHERE invocation_id=$2)
            OR $7::uuid IS NOT NULL AND owner_token=$7::uuid)
          AND state IN ('PREPARED','ACTIVE','SETTLING')`,
      [pollLeaseToken ? 'poll' : 'provider', invocationId, this.identity.replicaId, this.bootId, reasonCode, this.isoNow(), pollLeaseToken ?? null],
    );
  }

  public async activateUsage(eventId: string, claimToken: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      const row = await tx.query<{ delivery_effect_id: string; delivery_state: string }>(
        `SELECT delivery_effect_id,delivery_state FROM connector_usage_outbox
          WHERE event_id=$1 AND delivery_claim_token=$2 FOR UPDATE`, [eventId, claimToken],
      );
      if (!row.rows[0] || row.rows[0].delivery_state !== 'CLAIMED' || !row.rows[0].delivery_effect_id) return false;
      if (gate.state !== 'OPEN') {
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='CANCELLED',settled_at=$2,updated_at=$2,reason_code='BACKUP_FENCE_ACTIVE'
            WHERE effect_id=$1 AND state='PREPARED'`, [row.rows[0].delivery_effect_id, this.isoNow()],
        );
        await tx.query(
          `UPDATE connector_usage_outbox SET delivery_state='READY',delivery_owner_replica_id=NULL,
              delivery_owner_runtime_identity=NULL,delivery_owner_boot_id=NULL,delivery_claim_token=NULL,
              delivery_lease_expires_at=NULL,delivery_effect_id=NULL,delivery_updated_at=$3
            WHERE event_id=$1 AND delivery_claim_token=$2 AND delivery_state='CLAIMED'`,
          [eventId, claimToken, this.isoNow()],
        );
        return false;
      }
      const activated = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='ACTIVE',activated_at=$2,updated_at=$2
          WHERE effect_id=$1 AND state='PREPARED' AND fence_revision=$3`,
        [row.rows[0].delivery_effect_id, this.isoNow(), integer(gate.fence_revision)],
      );
      if (activated.rowCount !== 1) return false;
      await tx.query(
        `UPDATE connector_usage_outbox SET delivery_state='SENDING',delivery_updated_at=$3
          WHERE event_id=$1 AND delivery_claim_token=$2 AND delivery_state='CLAIMED'`,
        [eventId, claimToken, this.isoNow()],
      );
      return true;
    });
  }

  public async settleUsage(eventId: string, claimToken: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Keep backup-fence → outbox → effect lock order. A backup hold waits for
      // a send already in progress, while this exact-token settlement can still
      // finish after the hold has become visible.
      await lockConnectorBackupEffectGate(tx);
      const row = await tx.query<{ delivery_effect_id: string | null; delivery_state: string }>(
        `SELECT delivery_effect_id,delivery_state FROM connector_usage_outbox WHERE event_id=$1 AND delivery_claim_token=$2 FOR UPDATE`,
        [eventId, claimToken],
      );
      if (!row.rows[0] || row.rows[0].delivery_state !== 'SENDING' || !row.rows[0].delivery_effect_id) return false;
      const now = this.isoNow();
      const delivered = await tx.query(
        `UPDATE connector_usage_outbox SET delivered_at=$3,delivery_state='DELIVERED',delivery_updated_at=$3,
            delivery_claim_token=NULL,delivery_lease_expires_at=NULL
          WHERE event_id=$1 AND delivery_claim_token=$2 AND delivery_state='SENDING' AND delivered_at IS NULL`,
        [eventId, claimToken, now],
      );
      if (delivered.rowCount !== 1) return false;
      const settled = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='COMPLETED',settled_at=$2,updated_at=$2
          WHERE effect_id=$1 AND owner_token=$3 AND state IN ('ACTIVE','SETTLING')`,
        [row.rows[0].delivery_effect_id, now, claimToken],
      );
      if (settled.rowCount !== 1) throw unavailable('Usage effect permit could not be durably settled.');
      return true;
    });
  }

  public async deferUsage(eventId: string, claimToken: string, nextAttemptAt: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await lockConnectorBackupEffectGate(tx);
      const row = await tx.query<{ delivery_effect_id: string | null; delivery_state: string }>(
        `SELECT delivery_effect_id,delivery_state FROM connector_usage_outbox WHERE event_id=$1 AND delivery_claim_token=$2 FOR UPDATE`,
        [eventId, claimToken],
      );
      // Only a claim that is still pre-send can be safely retried. A SENDING
      // or UNKNOWN row may already have reached the sink, even if fetch failed.
      if (!row.rows[0] || row.rows[0].delivery_state !== 'CLAIMED') return false;
      const now = this.isoNow();
      const updated = await tx.query(
        `UPDATE connector_usage_outbox SET next_attempt_at=$3::timestamptz,failed_attempts=failed_attempts+1,
            last_failure_code='USAGE_SINK_DELIVERY_FAILED',delivery_state='READY',delivery_owner_replica_id=NULL,
            delivery_owner_runtime_identity=NULL,delivery_owner_boot_id=NULL,delivery_claim_token=NULL,
            delivery_lease_expires_at=NULL,delivery_effect_id=NULL,delivery_updated_at=$4
          WHERE event_id=$1 AND delivery_claim_token=$2 AND delivered_at IS NULL`, [eventId, claimToken, nextAttemptAt, now],
      );
      if (updated.rowCount === 1 && row.rows[0].delivery_effect_id) {
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='CANCELLED',settled_at=$2,updated_at=$2
            WHERE effect_id=$1 AND state='PREPARED'`, [row.rows[0].delivery_effect_id, now],
        );
      }
      return updated.rowCount === 1;
    });
  }

  public async markUsageUnknown(eventId: string, claimToken: string, reasonCode = 'USAGE_SEND_OUTCOME_UNKNOWN'): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockConnectorBackupEffectGate(tx);
      const row = await tx.query<{ delivery_effect_id: string | null }>(
        `SELECT delivery_effect_id FROM connector_usage_outbox WHERE event_id=$1 AND delivery_claim_token=$2 FOR UPDATE`,
        [eventId, claimToken],
      );
      if (!row.rows[0]) return;
      const now = this.isoNow();
      await tx.query(
        `UPDATE connector_usage_outbox SET delivery_state='UNKNOWN',delivery_updated_at=$3
          WHERE event_id=$1 AND delivery_claim_token=$2 AND delivered_at IS NULL`, [eventId, claimToken, now],
      );
      if (row.rows[0].delivery_effect_id) {
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='UNKNOWN',reason_code=$2,updated_at=$3
            WHERE effect_id=$1 AND state IN ('PREPARED','ACTIVE','SETTLING')`, [row.rows[0].delivery_effect_id, reasonCode, now],
        );
      }
    });
  }

  private async observeInTransaction(
    tx: SqlClient,
    request: ConnectorBackupEffectFenceObservationRequest,
  ): Promise<ConnectorBackupEffectFenceObservation> {
    const gate = await lockConnectorBackupEffectGate(tx);
    const identity = await tx.query<RegisteredReplicaRow>(
      `SELECT replica_id,runtime_identity,slot,revision,image_digest,control_state
        FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE`, [this.identity.replicaId],
    );
    const row = identity.rows[0];
    if (!row || row.runtime_identity !== this.identity.runtimeIdentity || row.replica_id !== this.identity.replicaId
      || row.slot !== this.identity.slot || row.revision !== this.identity.revision || row.image_digest !== this.identity.imageDigest) {
      throw unavailable('Connector replica identity is not registered in the effect observer.');
    }
    const revision = integer(gate.fence_revision);
    if (gate.state === 'HELD' && (gate.fence_id !== request.fenceId || revision !== request.expectedFenceRevision)) {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Requested backup fence is not the active Connector fence.');
    }
    const observedAt = this.isoNow();
    let acknowledgedAt: string | null = null;
    if (gate.state === 'HELD') {
      acknowledgedAt = await this.acknowledge(tx, request.fenceId, request.expectedFenceRevision);
    }
    const result = await tx.query<{
      provider_active: string | number; poll_active: string | number; usage_active: string | number;
      prepared: string | number; active: string | number; settling: string | number; unknown: string | number;
      unclosed: string | number; unresolved_invocations: string | number; unknown_usage: string | number;
    }>(
      `SELECT
         count(*) FILTER (WHERE domain='provider' AND state IN ('ACTIVE','SETTLING') AND owner_replica_id=$1 AND owner_boot_id=$2)::text AS provider_active,
         count(*) FILTER (WHERE domain='poll' AND state IN ('ACTIVE','SETTLING') AND owner_replica_id=$1 AND owner_boot_id=$2)::text AS poll_active,
         count(*) FILTER (WHERE domain='usage' AND state IN ('ACTIVE','SETTLING') AND owner_replica_id=$1 AND owner_boot_id=$2)::text AS usage_active,
         count(*) FILTER (WHERE state='PREPARED')::text AS prepared,
         count(*) FILTER (WHERE state='ACTIVE')::text AS active,
         count(*) FILTER (WHERE state='SETTLING')::text AS settling,
         count(*) FILTER (WHERE state='UNKNOWN')::text AS unknown,
         count(*) FILTER (WHERE state IN ('PREPARED','ACTIVE','SETTLING','UNKNOWN'))::text AS unclosed
       FROM connector_backup_effect_permits`, [this.identity.replicaId, this.bootId],
    );
    const held = await tx.query<{ count: string | number }>(
      `SELECT count(*)::text AS count FROM connector_invocations WHERE state=ANY($1::text[])`,
      [['IN_FLIGHT','PENDING','POLLING','UNKNOWN']],
    );
    const unknownUsage = await tx.query<{ count: string | number }>(
      `SELECT count(*)::text AS count FROM connector_usage_outbox WHERE delivered_at IS NULL AND delivery_state='UNKNOWN'`,
    );
    const counts = result.rows[0];
    if (!counts) throw unavailable('Connector backup effect counts are unavailable.');
    return ConnectorBackupEffectFenceObservationSchema.parse({
      ...this.identity,
      fence: {
        fenceId: gate.fence_id,
        fenceRevision: revision,
        state: gate.state,
        acknowledgedAt,
        bootId: this.bootId,
      },
      work: {
        processActiveInvocations: integer(counts.provider_active),
        processActivePolls: integer(counts.poll_active),
        processActiveUsageSends: integer(counts.usage_active),
        effectPermits: {
          prepared: integer(counts.prepared),
          active: integer(counts.active),
          settling: integer(counts.settling),
          unknown: integer(counts.unknown),
        },
        unclosedEffectPermits: integer(counts.unclosed),
        unresolvedInvocationHolds: integer(held.rows[0]?.count),
        unknownUsageDeliveries: integer(unknownUsage.rows[0]?.count),
      },
      observedAt,
      workObservedAt: observedAt,
    });
  }

  private async acknowledge(tx: SqlClient, fenceId: string, fenceRevision: number): Promise<string> {
    const result = await tx.query<{ acknowledged_at: Date | string }>(
      `INSERT INTO connector_backup_effect_acknowledgements
        (fence_id,fence_revision,replica_id,runtime_identity,boot_id,acknowledged_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(fence_id,replica_id,boot_id) DO UPDATE
         SET fence_revision=EXCLUDED.fence_revision,runtime_identity=EXCLUDED.runtime_identity,acknowledged_at=EXCLUDED.acknowledged_at
       RETURNING acknowledged_at`,
      [fenceId, fenceRevision, this.identity.replicaId, this.identity.runtimeIdentity, this.bootId, this.isoNow()],
    );
    const saved = result.rows[0]?.acknowledged_at;
    if (!saved) throw unavailable('Connector backup fence acknowledgement could not be persisted.');
    return dateText(saved);
  }

  private async cancelPreparedEffects(tx: SqlClient): Promise<void> {
    const now = this.isoNow();
    await tx.query(
      `WITH cancelled AS (
         UPDATE connector_backup_effect_permits SET state='CANCELLED',settled_at=$1,updated_at=$1,reason_code='BACKUP_FENCE_ACTIVE'
          WHERE state='PREPARED' AND domain IN ('provider','poll','usage','config') RETURNING effect_id,domain,invocation_id,event_id
       )
       UPDATE connector_invocations i SET state=CASE WHEN c.domain='provider' THEN 'FAILED' ELSE 'PENDING' END,
         error_code=CASE WHEN c.domain='provider' THEN 'PROVIDER_UNAVAILABLE' ELSE i.error_code END,
         provider_effect_id=CASE WHEN c.domain='provider' THEN NULL ELSE i.provider_effect_id END,
         poll_effect_id=CASE WHEN c.domain='poll' THEN NULL ELSE i.poll_effect_id END,
         poll_lease_token=CASE WHEN c.domain='poll' THEN NULL ELSE i.poll_lease_token END,
         poll_lease_expires_at=CASE WHEN c.domain='poll' THEN NULL ELSE i.poll_lease_expires_at END,
         updated_at=$1
       FROM cancelled c WHERE c.invocation_id=i.invocation_id AND c.domain IN ('provider','poll')
         AND ((c.domain='provider' AND i.state='IN_FLIGHT' AND i.provider_effect_id=c.effect_id)
          OR (c.domain='poll' AND i.state='POLLING' AND i.poll_effect_id=c.effect_id))`, [now],
    );
    await tx.query(
      `UPDATE connector_usage_outbox SET delivery_state='READY',delivery_owner_replica_id=NULL,
          delivery_owner_runtime_identity=NULL,delivery_owner_boot_id=NULL,delivery_claim_token=NULL,
          delivery_lease_expires_at=NULL,delivery_effect_id=NULL,delivery_updated_at=$1
        WHERE delivery_effect_id IN (SELECT effect_id FROM connector_backup_effect_permits
          WHERE domain='usage' AND state='CANCELLED' AND reason_code='BACKUP_FENCE_ACTIVE') AND delivered_at IS NULL`, [now],
    );
  }

  private async assertFenceOwner(
    tx: SqlClient,
    command: ConnectorBackupEffectFenceCommand,
    tokenHash: string,
  ): Promise<void> {
    const row = await tx.query<{
      backup_id: string | null; maintenance_job_id: string | null; maintenance_item_id:string|null;
      maintenance_execution_fence:string|number|null; owner_runtime_identity: string | null;owner_boot_id:string|null;
      execution_token_sha256: string | null;
    }>(
      `SELECT backup_id,maintenance_job_id,maintenance_item_id,maintenance_execution_fence,
              owner_runtime_identity,owner_boot_id,execution_token_sha256
        FROM connector_backup_effect_gate WHERE singleton_id=1`,
    );
    const owner = row.rows[0];
    if (!owner || owner.backup_id !== command.backupId || owner.maintenance_job_id !== command.maintenanceJobId
      || owner.maintenance_item_id !== command.maintenanceItemId
      || Number(owner.maintenance_execution_fence) !== command.maintenanceExecutionFence
      || owner.owner_runtime_identity !== command.ownerRuntimeIdentity || owner.owner_boot_id !== command.ownerBootId
      || owner.execution_token_sha256 !== tokenHash) {
      throw new ConnectorError('BINDING_DENIED', 'Connector backup fence owner does not match this execution.');
    }
  }

  private assertExpectedIdentity(expected: ConnectorBackupEffectFenceCommand | ConnectorBackupEffectFenceObservationRequest): void {
    if (expected.slot !== this.identity.slot || expected.runtimeIdentity !== this.identity.runtimeIdentity
      || expected.replicaId !== this.identity.replicaId || expected.revision !== this.identity.revision
      || expected.imageDigest !== this.identity.imageDigest) {
      throw new ConnectorError('BINDING_DENIED', 'Backup fence identity does not match this boot-pinned Connector process.');
    }
  }

  private isoNow(): string {
    const date = this.now();
    if (!Number.isFinite(date.getTime())) throw unavailable('Connector backup fence clock is invalid.');
    return date.toISOString();
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function dateText(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function integer(value: string | number | undefined): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw unavailable('Connector backup effect count or revision is invalid.');
  return number;
}
function invalid(message: string): ConnectorError { return new ConnectorError('INVALID_INPUT', message); }
function unavailable(message: string): ConnectorError { return new ConnectorError('PROVIDER_UNAVAILABLE', message); }
