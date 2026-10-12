import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  ConnectorBackupEffectFenceCommandSchema,
  ConnectorBackupEffectFenceObservationRequestSchema,
  type ConnectorBackupEffectFenceCommand,
  type ConnectorBackupEffectFenceObservation,
} from '@du/contracts';
import type { Db } from '../../db/db';
import type { MaintenanceExecutionFence } from './maintenance-service';
import type { ConnectorBackupEffectControl, ConnectorBackupEffectTarget } from './connector-backup-effect-control';

interface FenceStageRow extends QueryResultRow {
  fence_id: string; backup_id: string; slot: 'blue' | 'green'; service_id: string; replica_id: string;
  runtime_identity: string; runtime_revision: string; image_digest: string;
  expected_fence_revision: string | number; fence_revision: string | number;
  maintenance_job_id: string; maintenance_item_id: string; maintenance_execution_fence: string | number;
  owner_runtime_identity: string; owner_boot_id: string; execution_token_sha256: string;
  state: 'PREPARED' | 'HELD' | 'RELEASED' | 'UNKNOWN'; remote_boot_id: string | null;
  acknowledged_at: Date | string | null; observed_at: Date | string | null; work_observed_at: Date | string | null;
  work_counts: unknown;
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
function tokenHash(execution: MaintenanceExecutionFence): string { return sha(execution.executionToken); }
function count(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function fail(): Error { return new Error('BACKUP_CONNECTOR_FENCE_UNAVAILABLE'); }

function sameTarget(row: FenceStageRow, target: ConnectorBackupEffectTarget): boolean {
  return row.slot === target.slot && row.service_id === target.serviceId && row.replica_id === target.replicaId
    && row.runtime_identity === target.runtimeIdentity && row.runtime_revision === target.revision
    && row.image_digest === target.imageDigest;
}

function command(input: {
  target: ConnectorBackupEffectTarget; fenceId: string; fenceRevision: number; expectedFenceRevision: number;
  backupId: string; execution: MaintenanceExecutionFence; action: 'HOLD' | 'RELEASE';
}): ConnectorBackupEffectFenceCommand {
  return ConnectorBackupEffectFenceCommandSchema.parse({
    slot: input.target.slot, runtimeIdentity: input.target.runtimeIdentity, replicaId: input.target.replicaId,
    revision: input.target.revision, imageDigest: input.target.imageDigest,
    fenceId: input.fenceId, fenceRevision: input.fenceRevision, expectedFenceRevision: input.expectedFenceRevision,
    backupId: input.backupId, maintenanceJobId: input.execution.jobId, maintenanceItemId: input.execution.itemId,
    maintenanceExecutionFence: input.execution.executionFence, ownerRuntimeIdentity: input.execution.ownerRuntimeIdentity,
    ownerBootId: input.execution.ownerBootId, executionToken: input.execution.executionToken, action: input.action,
  });
}

/** Exact per-replica Connector fence journal. A command is persisted before
 * HTTP so an ambiguous response is retried with the same owner, token hash and
 * remote revision. Only immutable deployment-manifest targets are accepted. */
export function createConnectorBackupEffectCoordinator(input: {
  db: Db;
  control: ConnectorBackupEffectControl;
  targets: readonly ConnectorBackupEffectTarget[];
  now?: () => Date;
}): {
  holdAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<ConnectorBackupEffectFenceObservation[]>;
  observeAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<ConnectorBackupEffectFenceObservation[]>;
  releaseAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<void>;
} {
  const now = input.now ?? (() => new Date());
  const targets = [...input.targets];
  if (targets.length < 2 || targets.length > 2 || new Set(targets.map((target) => target.slot)).size !== 2
    || new Set(targets.map((target) => target.replicaId)).size !== targets.length) {
    throw new Error('BACKUP_CONNECTOR_TARGETS_INVALID');
  }
  function nowIso(): string {
    const value = now();
    if (!Number.isFinite(value.getTime())) throw fail();
    return value.toISOString();
  }
  async function assertCurrentExecution(execution: MaintenanceExecutionFence): Promise<void> {
    const result = await input.db.query(
      `SELECT 1 FROM maintenance_job_items
        WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4
          AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now()`,
      [execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,execution.ownerBootId,
        execution.executionFence,tokenHash(execution)],
    );
    if (result.rowCount !== 1) throw fail();
  }
  async function stage(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }, target: ConnectorBackupEffectTarget): Promise<FenceStageRow> {
    await assertCurrentExecution(args.execution);
    const found = await input.db.query<FenceStageRow>(
      `SELECT * FROM maintenance_backup_connector_fences WHERE fence_id=$1 AND replica_id=$2`,
      [args.fenceId,target.replicaId],
    );
    if (found.rows[0]) {
      const row = found.rows[0];
      if (!sameTarget(row,target) || row.backup_id !== args.backupId || row.maintenance_job_id !== args.execution.jobId
        || row.maintenance_item_id !== args.execution.itemId || row.owner_runtime_identity !== args.execution.ownerRuntimeIdentity
        || row.owner_boot_id !== args.execution.ownerBootId || Number(row.maintenance_execution_fence) !== args.execution.executionFence
        || row.execution_token_sha256 !== tokenHash(args.execution)) throw fail();
      return row;
    }
    await assertCurrentExecution(args.execution);
    const initial = await input.control.observe(target,ConnectorBackupEffectFenceObservationRequestSchema.parse({
      slot:target.slot,runtimeIdentity:target.runtimeIdentity,replicaId:target.replicaId,
      revision:target.revision,imageDigest:target.imageDigest,fenceId:args.fenceId,expectedFenceRevision:1,
    }));
    if (initial.fence.state !== 'OPEN' || initial.fence.fenceId !== null
      || !count(initial.fence.fenceRevision)) throw fail();
    const expected = initial.fence.fenceRevision;
    const fenceRevision = expected + 1;
    if (!Number.isSafeInteger(fenceRevision)) throw fail();
    return input.db.tx(async (client) => {
      const gate = await client.query<{ state:string;fence_id:string|null;backup_id:string|null;fence_revision:string|number;
        maintenance_job_id:string|null;owner_item_id:string|null;owner_runtime_identity:string|null;owner_boot_id:string|null;
        owner_execution_fence:string|number|null;execution_token_sha256:string|null }>(
        `SELECT state,fence_id,backup_id,fence_revision,maintenance_job_id,owner_item_id,owner_runtime_identity,owner_boot_id,
                owner_execution_fence,execution_token_sha256
           FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR SHARE`,
      );
      const current = gate.rows[0];
      if (!current || current.state !== 'HELD' || current.fence_id !== args.fenceId || current.backup_id !== args.backupId
        || current.maintenance_job_id !== args.execution.jobId || current.owner_item_id !== args.execution.itemId
        || current.owner_runtime_identity !== args.execution.ownerRuntimeIdentity || current.owner_boot_id !== args.execution.ownerBootId
        || Number(current.owner_execution_fence) !== args.execution.executionFence
        || current.execution_token_sha256 !== tokenHash(args.execution)) throw fail();
      const job = await client.query(
        `SELECT 1 FROM maintenance_job_items
          WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4
            AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now() FOR SHARE`,
        [args.execution.jobId,args.execution.itemId,args.execution.ownerRuntimeIdentity,args.execution.ownerBootId,
          args.execution.executionFence,tokenHash(args.execution)],
      );
      if (job.rowCount !== 1) throw fail();
      const inserted = await client.query<FenceStageRow>(
        `INSERT INTO maintenance_backup_connector_fences
          (fence_id,backup_id,slot,service_id,replica_id,runtime_identity,runtime_revision,image_digest,
           expected_fence_revision,fence_revision,maintenance_job_id,maintenance_item_id,maintenance_execution_fence,
           owner_runtime_identity,owner_boot_id,execution_token_sha256,state,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'PREPARED',$17)
         RETURNING *`,
        [args.fenceId,args.backupId,target.slot,target.serviceId,target.replicaId,target.runtimeIdentity,target.revision,
          target.imageDigest,expected,fenceRevision,args.execution.jobId,args.execution.itemId,args.execution.executionFence,
          args.execution.ownerRuntimeIdentity,args.execution.ownerBootId,tokenHash(args.execution),nowIso()],
      );
      if (!inserted.rows[0]) throw fail();
      return inserted.rows[0];
    });
  }

  async function persistObservation(row: FenceStageRow, observation: ConnectorBackupEffectFenceObservation, state?: FenceStageRow['state']): Promise<void> {
    if (observation.fence.bootId.length < 1 || !count(observation.work.processActiveInvocations)
      || !count(observation.work.processActivePolls) || !count(observation.work.processActiveUsageSends)
      || !count(observation.work.unclosedEffectPermits) || !count(observation.work.unresolvedInvocationHolds)
      || !count(observation.work.unknownUsageDeliveries)) throw fail();
    await input.db.tx(async (client) => {
      const claim = await client.query(
        `SELECT 1 FROM maintenance_job_items
          WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4
            AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now() FOR SHARE`,
        [row.maintenance_job_id,row.maintenance_item_id,row.owner_runtime_identity,row.owner_boot_id,
          row.maintenance_execution_fence,row.execution_token_sha256],
      );
      if (claim.rowCount !== 1) throw fail();
      const gate = await client.query<{ state:string;fence_id:string|null;backup_id:string|null;fence_revision:string|number;
        maintenance_job_id:string|null;owner_item_id:string|null;owner_runtime_identity:string|null;owner_boot_id:string|null;
        owner_execution_fence:string|number|null;execution_token_sha256:string|null }>(
        `SELECT state,fence_id,backup_id,fence_revision,maintenance_job_id,owner_item_id,owner_runtime_identity,owner_boot_id,
                owner_execution_fence,execution_token_sha256
           FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR SHARE`,
      );
      const current = gate.rows[0];
      if (!current || current.state !== 'HELD' || current.fence_id !== row.fence_id || current.backup_id !== row.backup_id
        || Number(current.fence_revision) !== Number(row.fence_revision)
        || current.maintenance_job_id !== row.maintenance_job_id || current.owner_item_id !== row.maintenance_item_id
        || current.owner_runtime_identity !== row.owner_runtime_identity || current.owner_boot_id !== row.owner_boot_id
        || Number(current.owner_execution_fence) !== Number(row.maintenance_execution_fence)
        || current.execution_token_sha256 !== row.execution_token_sha256) throw fail();
      const updated = await client.query(
        `UPDATE maintenance_backup_connector_fences
            SET state=COALESCE($3,state),remote_boot_id=$4,acknowledged_at=$5,observed_at=$6,work_observed_at=$7,
                work_counts=$8::jsonb,updated_at=$9
          WHERE fence_id=$1 AND replica_id=$2 AND owner_runtime_identity=$10 AND owner_boot_id=$11
            AND maintenance_execution_fence=$12 AND execution_token_sha256=$13`,
        [row.fence_id,row.replica_id,state ?? null,observation.fence.bootId,observation.fence.acknowledgedAt,
          observation.observedAt,observation.workObservedAt,JSON.stringify(observation.work),nowIso(),row.owner_runtime_identity,
          row.owner_boot_id,Number(row.maintenance_execution_fence),row.execution_token_sha256],
      );
      if (updated.rowCount !== 1) throw fail();
    });
  }

  async function readStage(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }, target: ConnectorBackupEffectTarget): Promise<FenceStageRow> {
    await assertCurrentExecution(args.execution);
    const result = await input.db.query<FenceStageRow>(
      `SELECT * FROM maintenance_backup_connector_fences WHERE fence_id=$1 AND replica_id=$2`,[args.fenceId,target.replicaId],
    );
    const row = result.rows[0];
    if (!row || !sameTarget(row,target) || row.backup_id !== args.backupId || row.maintenance_job_id !== args.execution.jobId
      || row.maintenance_item_id !== args.execution.itemId || row.owner_runtime_identity !== args.execution.ownerRuntimeIdentity
      || row.owner_boot_id !== args.execution.ownerBootId || Number(row.maintenance_execution_fence) !== args.execution.executionFence
      || row.execution_token_sha256 !== tokenHash(args.execution)) throw fail();
    return row;
  }

  async function observeOne(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }, target: ConnectorBackupEffectTarget): Promise<ConnectorBackupEffectFenceObservation> {
    const row = await readStage(args,target);
    if (row.state === 'UNKNOWN') throw fail();
    if (row.state === 'RELEASED') throw fail();
    await assertCurrentExecution(args.execution);
    const observation = await input.control.observe(target,ConnectorBackupEffectFenceObservationRequestSchema.parse({
      slot:target.slot,runtimeIdentity:target.runtimeIdentity,replicaId:target.replicaId,revision:target.revision,
      imageDigest:target.imageDigest,fenceId:args.fenceId,expectedFenceRevision:Number(row.fence_revision),
    }));
    if (observation.fence.state !== 'HELD' || observation.fence.fenceId !== args.fenceId
      || observation.fence.fenceRevision !== Number(row.fence_revision) || observation.fence.acknowledgedAt === null) throw fail();
    await persistObservation(row,observation,'HELD');
    return observation;
  }

  async function holdAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<ConnectorBackupEffectFenceObservation[]> {
    // The Connector fence is a singleton shared by both replicas. Stage every
    // exact target against the same OPEN revision before the first HOLD; a
    // sequential stage→hold loop would see replica one's HELD state while
    // attempting to stage replica two and could strand an incomplete journal.
    const staged = await Promise.all(targets.map(async (target) => ({ target, row: await stage(args,target) })));
    const observations: ConnectorBackupEffectFenceObservation[] = [];
    for (const { target, row } of staged) {
      await assertCurrentExecution(args.execution);
      if (row.state === 'UNKNOWN' || row.state === 'RELEASED') throw fail();
      if (row.state === 'PREPARED') {
        const observation = await input.control.hold(target,command({
          target,fenceId:args.fenceId,backupId:args.backupId,execution:args.execution,
          fenceRevision:Number(row.fence_revision),expectedFenceRevision:Number(row.expected_fence_revision),action:'HOLD',
        }));
        if (observation.fence.state !== 'HELD' || observation.fence.fenceId !== args.fenceId
          || observation.fence.fenceRevision !== Number(row.fence_revision) || observation.fence.acknowledgedAt === null) throw fail();
        await persistObservation(row,observation,'HELD');
        observations.push(observation);
      } else observations.push(await observeOne(args,target));
    }
    return observations;
  }

  async function observeAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<ConnectorBackupEffectFenceObservation[]> {
    const observations: ConnectorBackupEffectFenceObservation[] = [];
    for (const target of targets) observations.push(await observeOne(args,target));
    return observations;
  }

  async function releaseAll(args: { fenceId: string; backupId: string; execution: MaintenanceExecutionFence }): Promise<void> {
    const rows = await Promise.all(targets.map((target) => readStage(args,target)));
    if (rows.some((row) => row.state === 'UNKNOWN' || row.state === 'PREPARED')) throw fail();
    const observations: Array<{ target: ConnectorBackupEffectTarget; row: FenceStageRow; value: ConnectorBackupEffectFenceObservation }> = [];
    for (const target of targets) {
      const row = await readStage(args,target);
      await assertCurrentExecution(args.execution);
      const value = await input.control.observe(target,ConnectorBackupEffectFenceObservationRequestSchema.parse({
        slot:target.slot,runtimeIdentity:target.runtimeIdentity,replicaId:target.replicaId,revision:target.revision,
        imageDigest:target.imageDigest,fenceId:args.fenceId,expectedFenceRevision:Number(row.fence_revision),
      }));
      const held = value.fence.state === 'HELD' && value.fence.fenceId === args.fenceId
        && value.fence.fenceRevision === Number(row.fence_revision) && value.fence.acknowledgedAt !== null;
      const alreadyReleased = value.fence.state === 'OPEN' && value.fence.fenceId === null
        && value.fence.fenceRevision === Number(row.fence_revision);
      if (!held && !alreadyReleased) throw fail();
      if (value.work.processActiveInvocations !== 0 || value.work.processActivePolls !== 0
        || value.work.processActiveUsageSends !== 0) throw fail();
      await persistObservation(row,value,alreadyReleased ? 'RELEASED' : 'HELD');
      observations.push({ target,row,value });
    }
    const stillHeld = observations.find((entry) => entry.value.fence.state === 'HELD');
    if (stillHeld) {
      // The Connector's singleton is shared by both replicas. Send exactly
      // one RELEASE after both process acknowledgements and work snapshots;
      // releasing a second replica would reopen the same gate twice.
      await assertCurrentExecution(args.execution);
      await input.control.release(stillHeld.target,command({
        target:stillHeld.target,fenceId:args.fenceId,backupId:args.backupId,execution:args.execution,
        fenceRevision:Number(stillHeld.row.fence_revision),expectedFenceRevision:Number(stillHeld.row.fence_revision),action:'RELEASE',
      }));
    }
    const releasedAt = nowIso();
    for (const row of rows) {
      const result = await input.db.query(
        `UPDATE maintenance_backup_connector_fences SET state='RELEASED',updated_at=$3
          WHERE fence_id=$1 AND replica_id=$2 AND state IN ('HELD','RELEASED') AND owner_runtime_identity=$4
            AND owner_boot_id=$5 AND maintenance_execution_fence=$6 AND execution_token_sha256=$7`,
        [row.fence_id,row.replica_id,releasedAt,row.owner_runtime_identity,row.owner_boot_id,
          Number(row.maintenance_execution_fence),row.execution_token_sha256],
      );
      if (result.rowCount !== 1) throw fail();
    }
  }
  return { holdAll, observeAll, releaseAll };
}

