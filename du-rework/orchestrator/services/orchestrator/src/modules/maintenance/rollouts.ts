import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import {
  ReplicaRolloutPreviewRequestSchema,
  PreviewReplicaRollbackSchema,
  ExecuteReplicaRollbackSchema,
  type ReplicaRolloutPreviewRequest,
  type ReplicaRolloutPreview,
  type ReplicaRolloutJob,
  type PreviewReplicaRollback,
  type ReplicaRollbackPreview,
  type ExecuteReplicaRollback,
  type MaintenanceScope,
} from '@du/contracts';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import type {
  ReplicaRolloutAdapter,
  ReplicaRolloutObservationAdapter,
  ReplicaObservation,
} from './maintenance-service';
import { canonicalPayloadHash } from '../idempotency/idempotency';
import { conflict, notFound, unavailable } from '../../http/errors';
import type { BackupSnapshotWriteGate } from './backup-effect-fence';

type Row = QueryResultRow & Record<string, any>;
type Actor = { actor: string; actorRole?: string; actorIssuer?: string; actorSub?: string };

export interface ReplicaRolloutServiceOptions {
  db: Db;
  audit: AuditService;
  observationAdapter?: ReplicaRolloutObservationAdapter;
  executionAdapter?: ReplicaRolloutAdapter;
  /** The executing Orchestrator process identity comes from its immutable
   * service-runtime boot configuration, never from the Admin request. */
  executorRuntimeIdentity?: string | null;
  /** Only the dedicated host context may populate this value after checking
   * the root-pinned backup manifest identity. It lets that external durable
   * controller finish CUTOVER after the source slot yielded its claim. */
  trustedHostControllerIdentity?: string | null;
  /** Shared singleton gate; rollout claims take FOR SHARE before row locks. */
  backupSnapshotWriteGate: BackupSnapshotWriteGate;
  now?: () => Date;
}

const previewLifetime = 5 * 60_000;
const callDeadline = 2 * 60_000;
// replica_rollout_job_items.ordinal is PostgreSQL INTEGER (signed int32).
// Normal replicas use zero-based ordinals, so this remains last while staying
// inside the persisted type's exact range.
const candidateReplicaOrdinal = 2_147_483_647;
const SAFE_EXECUTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

export function rolloutCutoverExecutorAllowed(input: {
  service: string;
  phase: string;
  executorIdentity: string;
  candidateRuntimeIdentity: string | null;
  trustedHostControllerIdentity?: string | null;
}): boolean {
  if (input.phase !== 'CUTOVER' || input.service !== 'orchestrator') return true;
  return input.executorIdentity === input.candidateRuntimeIdentity
    || (!!input.trustedHostControllerIdentity && input.executorIdentity === input.trustedHostControllerIdentity);
}

function readJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value == null ? fallback : value as T;
}
function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function normalizeSnapshot(snapshot: Awaited<ReturnType<NonNullable<ReplicaRolloutAdapter>['observe']>>) {
  return {
    ingressTarget: snapshot.ingressTarget,
    fixedIngress: snapshot.fixedIngress,
    replicas: [...snapshot.replicas].map((replica) => ({
      replicaId: replica.replicaId, slot: replica.slot, desiredRevision: replica.desiredRevision,
      observedRevision: replica.observedRevision, state: replica.state, activeWork: replica.activeWork,
    })).sort((a, b) => a.replicaId.localeCompare(b.replicaId)),
  };
}
function sameDigest(a: string, b: string): boolean { return /^[a-f0-9]{64}$/.test(a) && a === b; }
function safeCode(value: unknown): string {
  if (typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)) return value;
  return 'ROLLOUT_FAILED';
}
function targetSlot(ingress: string | null): 'blue' | 'green' {
  if (ingress === 'blue') return 'green';
  if (ingress === 'green') return 'blue';
  throw conflict('ROLLOUT_INGRESS_INVALID', 'fixed ingress target must identify the active blue or green slot');
}

export function createReplicaRolloutService(options: ReplicaRolloutServiceOptions) {
  const now = options.now ?? (() => new Date());
  const observer = options.observationAdapter;
  const executor = options.executionAdapter;
  if (options.trustedHostControllerIdentity
    && (!SAFE_EXECUTOR_ID.test(options.trustedHostControllerIdentity)
      || options.executorRuntimeIdentity !== options.trustedHostControllerIdentity)) {
    throw new Error('ROLLOUT_HOST_CONTROLLER_IDENTITY_INVALID');
  }

  async function recordAudit(actor: Actor, action: string, resource: string, severity: 'info' | 'success' | 'warning' | 'error' = 'info', executor?: any) {
    await options.audit.record({ tenantId: null, actor: actor.actor, actorRole: actor.actorRole, actorIssuer: actor.actorIssuer, actorSub: actor.actorSub, action, resource, severity }, executor);
  }

  async function observe(input: Pick<ReplicaRolloutPreviewRequest, 'service' | 'scope'>) {
    if (!observer || observer.trusted !== true) throw unavailable('a trusted fixed-ingress deployment observer is not configured');
    return observer.observe(input);
  }

  async function createRolloutPreview(actor: Actor, raw: ReplicaRolloutPreviewRequest): Promise<ReplicaRolloutPreview> {
    const request = ReplicaRolloutPreviewRequestSchema.parse(raw);
    if (!observer || observer.trusted !== true) throw unavailable('a trusted fixed-ingress deployment observer is not configured');
    const capabilities = await observer.capabilities();
    if (!capabilities.services.includes(request.service)) {
      throw conflict('ROLLOUT_TARGET_UNAVAILABLE', 'requested service is not pinned by the trusted deployment manifest');
    }
    const snapshot = await observe(request);
    if (snapshot.replicas.length < 1) throw conflict('ROLLOUT_NO_REPLICAS', 'deployment adapter reports no current replicas');
    if (request.strategy === 'two_slot' && (request.service === 'worker'
      || !capabilities.fixedIngressServices.includes(request.service)
      || !snapshot.fixedIngress || !['blue','green'].includes(snapshot.ingressTarget ?? ''))) {
      throw conflict('FIXED_INGRESS_REQUIRED', 'two-slot rollout requires a configured fixed blue/green ingress target');
    }
    if (request.strategy === 'per_replica' && (request.service !== 'worker' || !capabilities.workerReplacement)) {
      throw conflict('ROLLOUT_STRATEGY_UNSUPPORTED', 'per-replica replacement is supported only for workers with an exact replacement adapter');
    }
    const ready = snapshot.replicas.filter((replica) => replica.state === 'READY' && replica.observedRevision !== null).length;
    const spare = request.strategy === 'two_slot' ? targetSlot(snapshot.ingressTarget) : null;
    const candidateRuntimeIdentity = request.service === 'orchestrator' && spare
      ? await observer.executorIdentityForSlot({ service: request.service, revision: request.desiredRevision, slot: spare })
      : null;
    if (request.service === 'orchestrator' && !candidateRuntimeIdentity) {
      throw unavailable('candidate-slot runtime identity is not pinned by the trusted manifest');
    }
    const minimumReadyReplicas = Math.max(1, ready);
    const previewId = randomUUID();
    const createdAt = now().toISOString();
    const expiresAt = new Date(now().getTime() + previewLifetime).toISOString();
    const stable = normalizeSnapshot(snapshot);
    const expectedVersion = canonicalPayloadHash({ request, snapshot: stable, candidateRuntimeIdentity });
    const warnings: string[] = [];
    if (ready !== snapshot.replicas.length) warnings.push('CURRENT_REPLICA_SET_DEGRADED');
    if (request.strategy === 'two_slot' && snapshot.replicas.some((replica) => replica.slot === spare)) warnings.push('SPARE_SLOT_CURRENTLY_OCCUPIED');
    const body: ReplicaRolloutPreview = {
      previewId, service: request.service, desiredRevision: request.desiredRevision, scope: request.scope,
      strategy: request.strategy, createdAt, expiresAt, expectedVersion, currentReplicas: snapshot.replicas.length,
      minimumReadyReplicas, requiresIngressSwitch: request.strategy === 'two_slot', warnings,
    };
    await options.db.tx(async (client) => {
      await client.query(
        `INSERT INTO replica_rollout_previews(preview_id,service,desired_revision,scope,strategy,expected_version,expires_at,created_by,candidate_runtime_identity,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [previewId,request.service,request.desiredRevision,JSON.stringify(request.scope),request.strategy,expectedVersion,expiresAt,actor.actor,candidateRuntimeIdentity,createdAt],
      );
      await recordAudit(actor, 'maintenance.rollout.preview', `rollout-preview:${previewId}`, 'info', client);
    });
    return body;
  }

  async function executeRollout(actor: Actor, input: { previewId: string; expectedVersion: string; idempotencyKey: string; reason: string }): Promise<ReplicaRolloutJob> {
    const requestHash = canonicalPayloadHash({ previewId: input.previewId, expectedVersion: input.expectedVersion });
    const replay = await options.db.query<Row>('SELECT * FROM replica_rollout_jobs WHERE idempotency_key=$1', [input.idempotencyKey]);
    if (replay.rowCount) {
      if (replay.rows[0]!.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'rollout idempotency key was reused');
      return getRolloutJob(replay.rows[0]!.job_id);
    }
    const previewResult = await options.db.query<Row>('SELECT * FROM replica_rollout_previews WHERE preview_id=$1', [input.previewId]);
    const preview = previewResult.rows[0];
    if (!preview) throw notFound('rollout preview not found');
    if (preview.state !== 'PREVIEWED' || new Date(preview.expires_at).getTime() <= now().getTime()) throw conflict('PREVIEW_EXPIRED', 'rollout preview expired or was consumed');
    if (!sameDigest(preview.expected_version, input.expectedVersion)) throw conflict('STATE_CONFLICT', 'rollout preview changed; refresh before confirming');
    const scope = readJson<MaintenanceScope>(preview.scope, { kind: 'platform' });
    if (!observer || observer.trusted !== true) throw unavailable('a trusted fixed-ingress deployment observer is not configured');
    const capabilities = await observer.capabilities();
    if (!capabilities.services.includes(preview.service)) throw conflict('ROLLOUT_TARGET_UNAVAILABLE', 'requested service is no longer pinned by the trusted deployment manifest');
    if (preview.strategy === 'two_slot' && !capabilities.fixedIngressServices.includes(preview.service)) {
      throw conflict('FIXED_INGRESS_REQUIRED', 'two-slot rollout is not supported by the trusted deployment manifest');
    }
    if (preview.strategy === 'per_replica' && (preview.service !== 'worker' || !capabilities.workerReplacement)) {
      throw conflict('ROLLOUT_STRATEGY_UNSUPPORTED', 'per-replica replacement is not supported by the trusted deployment manifest');
    }
    const current = await observe({ service: preview.service, scope });
    const request = { service: preview.service, desiredRevision: preview.desired_revision, scope,
      strategy: preview.strategy, reason: input.reason } as ReplicaRolloutPreviewRequest;
    const strategy = preview.strategy as ReplicaRolloutPreviewRequest['strategy'];
    const candidateSlot = strategy === 'two_slot' ? targetSlot(current.ingressTarget) : null;
    const candidateRuntimeIdentity = preview.service === 'orchestrator' && candidateSlot
      ? await observer?.executorIdentityForSlot({ service: preview.service, revision: preview.desired_revision, slot: candidateSlot })
      : null;
    if (!sameDigest(canonicalPayloadHash({ request, snapshot: normalizeSnapshot(current), candidateRuntimeIdentity }), input.expectedVersion)) throw conflict('STATE_CONFLICT', 'replica, ingress, or candidate observations changed; refresh rollout preview');
    if (preview.service === 'orchestrator' && candidateRuntimeIdentity !== preview.candidate_runtime_identity) throw conflict('STATE_CONFLICT', 'candidate executor identity changed; refresh rollout preview');

    const jobId = randomUUID();
    await options.db.tx(async (client) => {
      const locked = await client.query<Row>('SELECT * FROM replica_rollout_previews WHERE preview_id=$1 FOR UPDATE', [input.previewId]);
      if (!locked.rowCount || locked.rows[0]!.state !== 'PREVIEWED' || locked.rows[0]!.expected_version !== input.expectedVersion) throw conflict('STATE_CONFLICT', 'rollout preview is no longer current');
      await client.query(
        `INSERT INTO replica_rollout_jobs(job_id,preview_id,idempotency_key,request_hash,service,desired_revision,state,phase,candidate_runtime_identity,old_ingress_target,active_ingress_target,rollback_state,reason,actor,version,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'QUEUED','PREPARE',$7,$8,$8,'NOT_REQUIRED',$9,$10,1,now(),now())`,
        [jobId,input.previewId,input.idempotencyKey,requestHash,preview.service,preview.desired_revision,candidateRuntimeIdentity,current.ingressTarget,input.reason,actor.actor],
      );
      for (let index = 0; index < current.replicas.length; index += 1) {
        const replica = current.replicas[index]!;
        await client.query(
          `INSERT INTO replica_rollout_job_items(job_id,replica_id,slot,desired_revision,observed_revision,state,active_work,acknowledged_at,code,ordinal)
           VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7,NULL,$8)`,
          [jobId,replica.replicaId,replica.slot,preview.desired_revision,replica.observedRevision,replica.activeWork,replica.acknowledgedAt,index],
        );
      }
      await client.query(`UPDATE replica_rollout_previews SET state='CONSUMED' WHERE preview_id=$1`, [input.previewId]);
      await recordAudit(actor, 'maintenance.rollout.start', `rollout-job:${jobId}`, 'info', client);
    });
    return getRolloutJob(jobId);
  }

  async function claimRolloutJob(jobId: string, executorIdentity: string): Promise<Row | null> {
    if (!executorIdentity) return null;
    return options.db.tx(async (client) => {
      await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
        tenantId: null, domain: 'rollout-execution', requestKey: `rollout-claim:${jobId}`,
      });
      const locked = await client.query<Row>(
        `SELECT j.*,p.strategy,p.scope FROM replica_rollout_jobs j
          JOIN replica_rollout_previews p ON p.preview_id=j.preview_id WHERE j.job_id=$1 FOR UPDATE OF j`,
        [jobId],
      );
      const job = locked.rows[0];
      if (!job || ['SUCCEEDED','FAILED','PARTIAL','UNKNOWN','CANCELLED'].includes(job.state)) return null;
      if (job.claim_until && new Date(job.claim_until).getTime() > now().getTime()) return null;
      if (job.owner_runtime_identity && job.claim_until && new Date(job.claim_until).getTime() <= now().getTime()) {
        await client.query(`UPDATE replica_rollout_job_items SET state='UNKNOWN',code='ROLLOUT_OWNER_LOST',updated_at=now() WHERE job_id=$1 AND state IN ('STARTING','DRAINING')`,[jobId]);
        await client.query(`UPDATE replica_rollout_jobs SET state='UNKNOWN',rollback_state=CASE WHEN active_ingress_target IS DISTINCT FROM old_ingress_target THEN 'UNKNOWN' ELSE rollback_state END,last_error_code='ROLLOUT_OWNER_LOST',version=version+1,updated_at=now(),claim_until=NULL WHERE job_id=$1`,[jobId]);
        return null;
      }
      if (!rolloutCutoverExecutorAllowed({
        service: job.service,
        phase: job.phase,
        executorIdentity,
        candidateRuntimeIdentity: job.candidate_runtime_identity ?? null,
        trustedHostControllerIdentity: options.trustedHostControllerIdentity,
      })) return null;
      const claimed = await client.query<Row>(
        `UPDATE replica_rollout_jobs SET state='RUNNING',owner_runtime_identity=$2,execution_fence=execution_fence+1,
          claim_until=now()+interval '5 minutes',started_at=COALESCE(started_at,now()),updated_at=now(),version=version+1
          WHERE job_id=$1 RETURNING *`,[jobId,executorIdentity],
      );
      return { ...job, ...claimed.rows[0] };
    });
  }

  async function runQueuedRollouts(executorIdentity = options.executorRuntimeIdentity ?? null, limit = 2): Promise<ReplicaRolloutJob[]> {
    if (!executor || executor.trusted !== true || !executorIdentity) return [];
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
    const pending = await options.db.query<Row>(
      `SELECT job_id,actor FROM replica_rollout_jobs
        WHERE state IN ('QUEUED','RUNNING') AND (claim_until IS NULL OR claim_until<=now())
          AND (phase='PREPARE' OR service<>'orchestrator' OR candidate_runtime_identity=$1
            OR ($2::text IS NOT NULL AND $1=$2))
        ORDER BY created_at LIMIT $3`,[executorIdentity,options.trustedHostControllerIdentity ?? null,bounded],
    );
    const results: ReplicaRolloutJob[] = [];
    for (const row of pending.rows) {
      try { results.push(await runRolloutJob(row.job_id,{actor:row.actor,actorRole:'platform'},executorIdentity)); }
      catch { /* The durable owner lease remains visible for safe recovery. */ }
    }
    return results;
  }

  async function runRolloutJob(jobId: string, actor: Actor, executorIdentity = options.executorRuntimeIdentity ?? ''): Promise<ReplicaRolloutJob> {
    if (!executor || executor.trusted !== true) throw unavailable('trusted deployment execution adapter is unavailable');
    const adapter = executor;
    const job = await claimRolloutJob(jobId,executorIdentity);
    if (!job) return getRolloutJob(jobId);
    const fence = Number(job.execution_fence);
    const assertOwner = async () => {
      const owner = await options.db.query(
        `SELECT 1 FROM replica_rollout_jobs WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$3 AND claim_until>now() AND state='RUNNING'`,
        [jobId,executorIdentity,fence],
      );
      if (!owner.rowCount) throw conflict('ROLLOUT_OWNER_LOST','rollout executor fence was lost');
    };
    const scope = readJson<MaintenanceScope>(job.scope, { kind: 'platform' });
    const service = job.service as ReplicaRolloutPreviewRequest['service'];
    const strategy = job.strategy as ReplicaRolloutPreviewRequest['strategy'];
    if (strategy === 'per_replica') {
      if (service !== 'worker' || !adapter.replaceReplica) throw conflict('ROLLOUT_STRATEGY_UNSUPPORTED','worker replacement adapter is unavailable');
      const replicas = (await options.db.query<Row>('SELECT * FROM replica_rollout_job_items WHERE job_id=$1 ORDER BY ordinal',[jobId])).rows;
      try {
        for (const replica of replicas) {
          const current = await adapter.observe({ service, scope });
          const otherReady = current.replicas.some((entry) => entry.replicaId !== replica.replica_id && entry.state === 'READY' && entry.activeWork !== null);
          if (!otherReady) throw conflict('MINIMUM_READY_REPLICAS_LOST','worker replacement would remove the last ready worker');
          await assertOwner();
          await options.db.query(`UPDATE replica_rollout_job_items SET state='DRAINING',owner_runtime_identity=$3,execution_fence=$4,claim_until=now()+interval '5 minutes' WHERE job_id=$1 AND replica_id=$2`,[jobId,replica.replica_id,executorIdentity,fence]);
          const replaced = await adapter.replaceReplica({ service, scope, replicaId: replica.replica_id, revision: job.desired_revision });
          if (replaced.state !== 'READY' || replaced.observedRevision !== job.desired_revision || replaced.activeWork !== 0 || !replaced.acknowledgedAt) throw conflict('ROLLOUT_READINESS_FAILED','replacement worker did not report fresh ready state and zero work');
          const saved = await options.db.query(`UPDATE replica_rollout_job_items SET slot=$3,state='READY',observed_revision=$4,active_work=$5,acknowledged_at=$6,code=NULL,owner_runtime_identity=NULL,claim_until=NULL WHERE job_id=$1 AND replica_id=$2 AND execution_fence=$7`,[jobId,replica.replica_id,replaced.slot,replaced.observedRevision,replaced.activeWork,replaced.acknowledgedAt,fence]);
          if (!saved.rowCount) throw conflict('ROLLOUT_OWNER_LOST','worker replacement journal fence was lost');
        }
        await options.db.query(`UPDATE replica_rollout_jobs SET state='SUCCEEDED',phase='DONE',owner_runtime_identity=NULL,claim_until=NULL,last_error_code=NULL,version=version+1,updated_at=now(),completed_at=now() WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$3`,[jobId,executorIdentity,fence]);
        await recordAudit(actor,'maintenance.rollout.succeeded',`rollout-job:${jobId}`,'success');
      } catch (error) {
        const code = safeCode((error as { code?: unknown })?.code);
        const unknown = ['ROLLOUT_OPERATION_OUTCOME_UNKNOWN','ROLLOUT_OWNER_LOST','ROLLOUT_STOP_OUTCOME_UNKNOWN'].includes(code);
        await options.db.query(`UPDATE replica_rollout_job_items SET state=CASE WHEN $3='UNKNOWN' THEN 'UNKNOWN' ELSE state END,code=$4,owner_runtime_identity=CASE WHEN $3='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,claim_until=NULL WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$5`,[jobId,executorIdentity,unknown?'UNKNOWN':'FAILED',unknown?'ROLLOUT_STEP_OUTCOME_UNKNOWN':code,fence]);
        await options.db.query(`UPDATE replica_rollout_jobs SET state=$3,phase=CASE WHEN $3='UNKNOWN' THEN phase ELSE 'DONE' END,last_error_code=$4,owner_runtime_identity=CASE WHEN $3='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,claim_until=NULL,completed_at=CASE WHEN $3='UNKNOWN' THEN NULL ELSE now() END,version=version+1,updated_at=now() WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$5`,[jobId,executorIdentity,unknown?'UNKNOWN':'PARTIAL',code,fence]);
        await recordAudit(actor,`maintenance.rollout.${unknown?'unknown':'partial'}`,`rollout-job:${jobId}`,unknown?'warning':'error');
      }
      return getRolloutJob(jobId);
    }
    const target = targetSlot(job.old_ingress_target);
    let originals: Row[];
    if (job.phase === 'PREPARE') {
      try {
        const itemId = `slot-${target}`;
        await options.db.query(
          `INSERT INTO replica_rollout_job_items(job_id,replica_id,slot,desired_revision,state,ordinal,owner_runtime_identity,execution_fence,claim_until)
           VALUES($1,$2,$3,$4,'STARTING',$5,$6,$7,now()+interval '5 minutes')
           ON CONFLICT(job_id,replica_id) DO UPDATE SET state='STARTING',code=NULL,owner_runtime_identity=$6,execution_fence=$7,claim_until=now()+interval '5 minutes',updated_at=now()`,
          [jobId,itemId,target,job.desired_revision,candidateReplicaOrdinal,executorIdentity,fence],
        );
        await assertOwner();
        const candidate = await adapter.prepareSlot({ service, scope, revision: job.desired_revision, slot: target! });
        if (candidate.state !== 'READY' || candidate.observedRevision !== job.desired_revision || !candidate.acknowledgedAt || candidate.slot !== target) throw conflict('ROLLOUT_READINESS_FAILED','spare slot did not report the requested ready revision');
        await options.db.tx(async (client) => {
          const owner = await client.query(`SELECT 1 FROM replica_rollout_jobs WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$3 AND claim_until>now() FOR UPDATE`,[jobId,executorIdentity,fence]);
          if (!owner.rowCount) throw conflict('ROLLOUT_OWNER_LOST','rollout executor fence was lost before handoff');
          await client.query(`UPDATE replica_rollout_job_items SET replica_id=$3,slot=$4,observed_revision=$5,state='READY',active_work=$6,acknowledged_at=$7,code=NULL,owner_runtime_identity=NULL,claim_until=NULL WHERE job_id=$1 AND replica_id=$2`,[jobId,itemId,candidate.replicaId,candidate.slot,candidate.observedRevision,candidate.activeWork,candidate.acknowledgedAt]);
          const handoff = service === 'orchestrator';
          await client.query(`UPDATE replica_rollout_jobs SET phase='CUTOVER',state=$4,owner_runtime_identity=$5,claim_until=$6,version=version+1,updated_at=now() WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$3`,[jobId,executorIdentity,fence,handoff?'QUEUED':'RUNNING',handoff?null:executorIdentity,handoff?null:new Date(now().getTime()+5*60_000)]);
        });
        if (service === 'orchestrator') return getRolloutJob(jobId);
      } catch (error) {
        const code = (error as { code?: string }).code;
        const unknown = code === 'ROLLOUT_OPERATION_OUTCOME_UNKNOWN' || code === 'ROLLOUT_OWNER_LOST';
        const itemState = unknown ? 'UNKNOWN' : 'FAILED';
        const itemCode = unknown ? 'ROLLOUT_PREPARE_OUTCOME_UNKNOWN' : safeCode(code);
        await options.db.query(
          `UPDATE replica_rollout_job_items
              SET state=$3,code=$4,owner_runtime_identity=CASE WHEN $3='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,
                  claim_until=NULL,updated_at=now()
            WHERE job_id=$1 AND replica_id=$2 AND state='STARTING'
              AND owner_runtime_identity=$5 AND execution_fence=$6`,
          [jobId,`slot-${target}`,itemState,itemCode,executorIdentity,fence],
        );
        await options.db.query(
          `UPDATE replica_rollout_jobs
              SET state=$3,last_error_code=$4,
                  owner_runtime_identity=CASE WHEN $3='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,
                  claim_until=NULL,completed_at=CASE WHEN $3='UNKNOWN' THEN NULL ELSE now() END,
                  version=version+1,updated_at=now()
            WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$5`,
          [jobId,executorIdentity,itemState,safeCode(code),fence],
        );
        return getRolloutJob(jobId);
      }
    }
    originals = (await options.db.query<Row>('SELECT * FROM replica_rollout_job_items WHERE job_id=$1 ORDER BY ordinal',[jobId])).rows;
    let switched = false;
    let failCode: string | null = null;
    let failUnknown = false;
    try {
      if (strategy === 'two_slot') {
        const candidate = originals.find((entry) => entry.slot === target && entry.state === 'READY');
        if (!candidate || candidate.observed_revision !== job.desired_revision || Number(candidate.active_work ?? 0) !== 0) throw conflict('ROLLOUT_READINESS_FAILED','candidate slot is not journaled as ready with zero active work');
        await assertOwner();
        const expectedIngress = job.old_ingress_target as string | null;
        const switchedResult = await adapter.switchIngress({ service, scope, expectedTarget: expectedIngress, target: target! });
        if (switchedResult.observedTarget !== target) { failUnknown = true; throw conflict('ROLLOUT_INGRESS_OUTCOME_UNKNOWN','ingress switch acknowledgment did not match requested slot'); }
        switched = true;
        const activeUpdate = await options.db.query(`UPDATE replica_rollout_jobs SET active_ingress_target=$2,version=version+1,updated_at=now() WHERE job_id=$1 AND owner_runtime_identity=$3 AND execution_fence=$4`,[jobId,target,executorIdentity,fence]);
        if (!activeUpdate.rowCount) throw conflict('ROLLOUT_OWNER_LOST','rollout executor fence was lost after ingress switch');
        for (const replica of originals.filter((row) => row.slot === job.old_ingress_target)) {
          await assertOwner();
          await options.db.query(`UPDATE replica_rollout_job_items SET state='DRAINING',owner_runtime_identity=$3,execution_fence=$4,claim_until=now()+interval '5 minutes' WHERE job_id=$1 AND replica_id=$2`,[jobId,replica.replica_id,executorIdentity,fence]);
          const result = await adapter.drainReplica({ service, scope, replicaId: replica.replica_id, deadlineMs: callDeadline });
          await options.db.query(`UPDATE replica_rollout_job_items SET state=$3,active_work=$4,acknowledged_at=$5,observed_revision=$6,code=$7,owner_runtime_identity=NULL,claim_until=NULL WHERE job_id=$1 AND replica_id=$2 AND execution_fence=$8`,
            [jobId,replica.replica_id,result.state,result.activeWork,result.acknowledgedAt,result.observedRevision,result.state === 'STOPPED' && result.activeWork === 0 ? null : 'REPLICA_DRAIN_INCOMPLETE',fence]);
          if (result.state === 'DRAINING' && result.code === 'ROLLOUT_DRAIN_TIMEOUT') {
            await options.db.tx(async (client) => {
              await client.query(`UPDATE replica_rollout_jobs SET state='PARTIAL',last_error_code='ROLLOUT_DRAIN_TIMEOUT',owner_runtime_identity=NULL,claim_until=NULL,version=version+1,updated_at=now(),completed_at=now() WHERE job_id=$1 AND owner_runtime_identity=$2 AND execution_fence=$3`,[jobId,executorIdentity,fence]);
              await recordAudit(actor,'maintenance.rollout.partial_drain',`rollout-job:${jobId}`,'warning',client);
            });
            return getRolloutJob(jobId);
          }
          if (result.state !== 'STOPPED' || result.activeWork !== 0) throw conflict('ROLLOUT_DRAIN_FAILED','old replica did not acknowledge drain completion');
        }
      } else {
        // Explicit per-replica replacement is a supported adapter strategy;
        // all replicas stay journaled and each replacement must be ready
        // before the next old replica is drained.
        if (!adapter.replaceReplica) throw conflict('PER_REPLICA_ADAPTER_UNSUPPORTED','adapter does not implement exact per-replica replacement');
        for (const replica of originals) {
          const live = await adapter.observe({ service, scope });
          const ready = live.replicas.filter((entry) => entry.state === 'READY').length;
          if (ready < 1) throw conflict('MINIMUM_READY_REPLICAS_LOST','rollout would take the service below one ready replica');
          await options.db.query(`UPDATE replica_rollout_job_items SET state='DRAINING' WHERE job_id=$1 AND replica_id=$2`,[jobId,replica.replica_id]);
          const result = await adapter.replaceReplica({ service, scope, replicaId: replica.replica_id, revision: job.desired_revision });
          if (result.state !== 'READY' || result.observedRevision !== job.desired_revision || !result.acknowledgedAt) throw conflict('ROLLOUT_READINESS_FAILED','replacement replica did not report the requested ready revision');
          await options.db.query(`UPDATE replica_rollout_job_items SET slot=$3,state='READY',observed_revision=$4,active_work=$5,acknowledged_at=$6,code=NULL WHERE job_id=$1 AND replica_id=$2`,[jobId,replica.replica_id,result.slot,result.observedRevision,result.activeWork,result.acknowledgedAt]);
        }
      }
    } catch (error) {
      failCode = (error as { code?: string }).code && /^[A-Z0-9_]{1,80}$/.test((error as { code: string }).code) ? (error as { code: string }).code : 'ROLLOUT_FAILED';
      const ambiguous = failUnknown || ['ROLLOUT_INGRESS_OUTCOME_UNKNOWN','ROLLOUT_OPERATION_OUTCOME_UNKNOWN','ROLLOUT_INGRESS_BUSY_OR_UNCERTAIN','ROLLOUT_OWNER_LOST'].includes(failCode);
      if (switched && !ambiguous && target) {
        const oldRevision = originals.find((entry) => entry.slot === job.old_ingress_target)?.observed_revision as string | null | undefined;
        if (!oldRevision) {
          await options.db.query(`UPDATE replica_rollout_jobs SET state='UNKNOWN',rollback_state='UNKNOWN',last_error_code='ROLLBACK_REVISION_UNAVAILABLE',claim_until=NULL,version=version+1,updated_at=now() WHERE job_id=$1 AND execution_fence=$2`,[jobId,fence]);
          await recordAudit(actor,'maintenance.rollout.rollback_unknown',`rollout-job:${jobId}`,'error');
          return getRolloutJob(jobId);
        }
        await options.db.query(`UPDATE replica_rollout_jobs SET rollback_state='PENDING',version=version+1,updated_at=now() WHERE job_id=$1`,[jobId]);
        try {
          const rolledBack = await adapter.restoreIngress({ service, scope, expectedTarget: target, target: job.old_ingress_target, targetRevision: oldRevision });
          if (rolledBack.observedTarget !== job.old_ingress_target) throw new Error('rollback mismatch');
          await options.db.query(`UPDATE replica_rollout_jobs SET phase='DONE',active_ingress_target=$2,rollback_state='APPLIED',state='FAILED',last_error_code=$3,owner_runtime_identity=NULL,claim_until=NULL,version=version+1,updated_at=now(),completed_at=now() WHERE job_id=$1 AND owner_runtime_identity=$4 AND execution_fence=$5`,[jobId,job.old_ingress_target,failCode,executorIdentity,fence]);
          await options.db.query(`UPDATE replica_rollout_job_items SET code=COALESCE(code,'AUTOMATIC_ROLLBACK_APPLIED') WHERE job_id=$1 AND replica_id LIKE 'slot-%'`,[jobId]);
          await recordAudit(actor,'maintenance.rollout.automatic_rollback',`rollout-job:${jobId}`,'warning');
          return getRolloutJob(jobId);
        } catch {
          await options.db.query(`UPDATE replica_rollout_jobs SET rollback_state='UNKNOWN',state='UNKNOWN',last_error_code='ROLLBACK_OUTCOME_UNKNOWN',claim_until=NULL,version=version+1,updated_at=now() WHERE job_id=$1 AND execution_fence=$2`,[jobId,fence]);
          await recordAudit(actor,'maintenance.rollout.rollback_unknown',`rollout-job:${jobId}`,'error');
          return getRolloutJob(jobId);
        }
      }
      await options.db.query(`UPDATE replica_rollout_job_items SET state=CASE WHEN state IN ('STARTING','DRAINING') THEN 'UNKNOWN' ELSE state END,code=COALESCE(code,$2) WHERE job_id=$1`,[jobId,ambiguous ? 'ROLLOUT_STEP_OUTCOME_UNKNOWN' : failCode]);
      await options.db.query(`UPDATE replica_rollout_jobs SET phase=CASE WHEN $2='UNKNOWN' THEN phase ELSE 'DONE' END,state=$2,last_error_code=$3,owner_runtime_identity=CASE WHEN $2='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,claim_until=NULL,rollback_state=CASE WHEN $2='UNKNOWN' THEN 'UNKNOWN' ELSE rollback_state END,version=version+1,updated_at=now(),completed_at=CASE WHEN $2='UNKNOWN' THEN NULL ELSE now() END WHERE job_id=$1 AND owner_runtime_identity=$4 AND execution_fence=$5`,[jobId,ambiguous ? 'UNKNOWN' : 'FAILED',failCode,executorIdentity,fence]);
      await recordAudit(actor,`maintenance.rollout.${ambiguous?'unknown':'failed'}`,`rollout-job:${jobId}`,ambiguous?'warning':'error');
      return getRolloutJob(jobId);
    }
    await options.db.tx(async (client) => {
      await client.query(`UPDATE replica_rollout_jobs SET state='SUCCEEDED',phase='DONE',active_ingress_target=COALESCE($2,active_ingress_target),rollback_state='NOT_REQUIRED',owner_runtime_identity=NULL,claim_until=NULL,last_error_code=NULL,version=version+1,updated_at=now(),completed_at=now() WHERE job_id=$1 AND owner_runtime_identity=$3 AND execution_fence=$4`,[jobId,target,executorIdentity,fence]);
      await recordAudit(actor,'maintenance.rollout.succeeded',`rollout-job:${jobId}`,'success',client);
    });
    return getRolloutJob(jobId);
  }

  async function getRolloutJob(jobId: string): Promise<ReplicaRolloutJob> {
    const result = await options.db.query<Row>('SELECT * FROM replica_rollout_jobs WHERE job_id=$1',[jobId]);
    if (!result.rowCount) throw notFound('rollout job not found');
    let job = result.rows[0]!;
    const claimExpired = job.claim_until && new Date(job.claim_until).getTime() < now().getTime();
    if (claimExpired && (job.state === 'RUNNING' || job.rollback_state === 'PENDING')) {
      await options.db.query(`UPDATE replica_rollout_job_items SET state='UNKNOWN',code='ROLLOUT_OWNER_LOST',updated_at=now() WHERE job_id=$1 AND state IN ('STARTING','DRAINING')`,[jobId]);
      await options.db.query(`UPDATE replica_rollout_jobs SET state='UNKNOWN',rollback_state=CASE WHEN rollback_state='PENDING' OR active_ingress_target IS DISTINCT FROM old_ingress_target THEN 'UNKNOWN' ELSE rollback_state END,last_error_code='ROLLOUT_OWNER_LOST',version=version+1,updated_at=now(),claim_until=NULL WHERE job_id=$1 AND (state='RUNNING' OR rollback_state='PENDING')`,[jobId]);
      job = (await options.db.query<Row>('SELECT * FROM replica_rollout_jobs WHERE job_id=$1',[jobId])).rows[0]!;
    }
    const items = await options.db.query<Row>('SELECT * FROM replica_rollout_job_items WHERE job_id=$1 ORDER BY ordinal',[jobId]);
    return {
      jobId: job.job_id, version: Number(job.version), service: job.service, desiredRevision: job.desired_revision,
      state: job.state, createdAt: iso(job.created_at)!, updatedAt: iso(job.updated_at)!, oldIngressTarget: job.old_ingress_target,
      activeIngressTarget: job.active_ingress_target, rollbackState: job.rollback_state,
      replicas: items.rows.map((row) => ({ replicaId: row.replica_id, slot: row.slot, desiredRevision: row.desired_revision,
        observedRevision: row.observed_revision, state: row.state, activeWork: row.active_work, acknowledgedAt: iso(row.acknowledged_at), code: row.code })),
      lastErrorCode: job.last_error_code,
    };
  }

  async function createRollbackPreview(actor: Actor, jobId: string, input: PreviewReplicaRollback): Promise<ReplicaRollbackPreview> {
    const request = PreviewReplicaRollbackSchema.parse(input);
    const job = await options.db.query<Row>('SELECT * FROM replica_rollout_jobs WHERE job_id=$1',[jobId]);
    if (!job.rowCount) throw notFound('rollout job not found');
    if (job.rows[0]!.rollback_state === 'APPLIED') throw conflict('ROLLBACK_ALREADY_APPLIED','rollout has already been rolled back');
    const scopeRow = await options.db.query<Row>('SELECT scope,service FROM replica_rollout_previews WHERE preview_id=$1',[job.rows[0]!.preview_id]);
    const scope = readJson<MaintenanceScope>(scopeRow.rows[0]?.scope,{kind:'platform'});
    const observed = await observe({ service: job.rows[0]!.service, scope });
    const current = observed.ingressTarget;
    const capabilities = observer?.trusted === true ? await observer.capabilities() : null;
    const eligible = !!capabilities?.fixedIngressServices.includes(job.rows[0]!.service)
      && observed.fixedIngress && current === job.rows[0]!.active_ingress_target
      && job.rows[0]!.old_ingress_target !== current && !!job.rows[0]!.old_ingress_target;
    const previewId = randomUUID();
    const createdAt = now().toISOString();
    const expiresAt = new Date(now().getTime()+previewLifetime).toISOString();
    const expectedVersion = canonicalPayloadHash({ jobId, version: Number(job.rows[0]!.version), active: current, old: job.rows[0]!.old_ingress_target, request });
    const warnings = eligible ? [] : ['ROLLBACK_INGRESS_CAS_UNAVAILABLE'];
    const body: ReplicaRollbackPreview = { previewId, jobId, createdAt, expiresAt, expectedVersion, oldIngressTarget: job.rows[0]!.old_ingress_target, activeIngressTarget: current, targetIngress: job.rows[0]!.old_ingress_target, eligible, warnings };
    await options.db.tx(async (client) => {
      await client.query(`INSERT INTO replica_rollout_rollback_previews(preview_id,job_id,expected_version,request,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[previewId,jobId,expectedVersion,JSON.stringify({ ...request, eligible, jobId }),actor.actor,createdAt,expiresAt]);
      await recordAudit(actor,'maintenance.rollout.rollback.preview',`rollout-job:${jobId}`,'info',client);
    });
    return body;
  }

  async function executeRollback(actor: Actor, jobId: string, input: ExecuteReplicaRollback): Promise<ReplicaRolloutJob> {
    const request = ExecuteReplicaRollbackSchema.parse(input);
    const replay = await options.db.query<Row>('SELECT * FROM replica_rollout_rollback_previews WHERE idempotency_key=$1',[request.idempotencyKey]);
    if (replay.rowCount) {
      const record = replay.rows[0]!;
      if (record.job_id !== jobId || record.expected_version !== request.expectedVersion || record.preview_id !== request.previewId) throw conflict('IDEMPOTENCY_CONFLICT','rollback idempotency key was reused');
      return getRolloutJob(jobId);
    }
    const previewResult = await options.db.query<Row>('SELECT * FROM replica_rollout_rollback_previews WHERE preview_id=$1 AND job_id=$2',[request.previewId,jobId]);
    const preview = previewResult.rows[0];
    if (!preview) throw notFound('rollout rollback preview not found');
    if (new Date(preview.expires_at).getTime() <= now().getTime() || preview.state !== 'PREVIEWED' || preview.expected_version !== request.expectedVersion) throw conflict('STATE_CONFLICT','rollback preview is expired or stale');
    const job = await options.db.query<Row>('SELECT * FROM replica_rollout_jobs WHERE job_id=$1',[jobId]);
    if (!job.rowCount || Number(job.rows[0]!.version) < 1) throw notFound('rollout job not found');
    const stored = readJson<PreviewReplicaRollback & { eligible?: boolean; jobId?: string }>(preview.request,{reason:request.reason});
    const parsed: PreviewReplicaRollback = { reason: stored.reason };
    if (parsed.reason !== request.reason || stored.jobId !== jobId) throw conflict('STATE_CONFLICT','rollback reason or job does not match the preview');
    const rolloutPreview = await options.db.query<Row>('SELECT service,scope FROM replica_rollout_previews WHERE preview_id=$1',[job.rows[0]!.preview_id]);
    const scope = readJson<MaintenanceScope>(rolloutPreview.rows[0]!.scope,{kind:'platform'});
    if (!executor || executor.trusted !== true) throw unavailable('trusted ingress execution adapter is unavailable');
    const adapter = executor;
    const oldTarget = job.rows[0]!.old_ingress_target as string | null;
    if (!oldTarget) throw conflict('ROLLBACK_REVISION_UNAVAILABLE','old ingress target is not recorded');
    const oldReplica = await options.db.query<Row>(
      `SELECT observed_revision FROM replica_rollout_job_items WHERE job_id=$1 AND slot=$2 AND observed_revision IS NOT NULL ORDER BY ordinal LIMIT 1`,
      [jobId, oldTarget],
    );
    const oldRevision = oldReplica.rows[0]?.observed_revision as string | undefined;
    if (!oldRevision) throw conflict('ROLLBACK_REVISION_UNAVAILABLE','old slot revision is not recorded');
    const observed = await observe({ service: job.rows[0]!.service, scope });
    const expected = canonicalPayloadHash({ jobId, version: Number(job.rows[0]!.version), active: observed.ingressTarget, old: job.rows[0]!.old_ingress_target, request: parsed });
    if (!sameDigest(expected, request.expectedVersion) || observed.ingressTarget !== job.rows[0]!.active_ingress_target) throw conflict('STATE_CONFLICT','ingress or rollout state changed; refresh rollback preview');
    if (stored.eligible !== true) throw conflict('ROLLBACK_BLOCKED','rollback was not eligible at preview');
    const claim = await options.db.tx(async (client) => {
      const updated = await client.query<Row>(`UPDATE replica_rollout_jobs SET rollback_state='PENDING',version=version+1,claim_until=now()+interval '15 minutes',updated_at=now() WHERE job_id=$1 AND version=$2 AND active_ingress_target=$3 AND rollback_state<>'APPLIED' RETURNING *`,[jobId,job.rows[0]!.version,observed.ingressTarget]);
      if (!updated.rowCount) throw conflict('STATE_CONFLICT','rollout changed while rollback was confirmed');
      const consumed = await client.query(`UPDATE replica_rollout_rollback_previews SET state='CONSUMED',idempotency_key=$2,request=request || $3::jsonb WHERE preview_id=$1 AND state='PREVIEWED' RETURNING preview_id`,[request.previewId,request.idempotencyKey,JSON.stringify({ jobId,expectedVersion:request.expectedVersion })]);
      if (!consumed.rowCount) throw conflict('STATE_CONFLICT','rollback preview was already consumed');
      await recordAudit(actor,'maintenance.rollout.rollback.start',`rollout-job:${jobId}`,'warning',client);
      return updated.rows[0]!;
    });
    try {
      const result = await adapter.restoreIngress({ service: claim.service, scope, expectedTarget: observed.ingressTarget!, target: claim.old_ingress_target, targetRevision: oldRevision });
      if (result.observedTarget !== claim.old_ingress_target) throw new Error('rollback target mismatch');
      await options.db.query(`UPDATE replica_rollout_jobs SET active_ingress_target=$2,rollback_state='APPLIED',state=CASE WHEN state='SUCCEEDED' THEN 'PARTIAL' ELSE state END,claim_until=NULL,version=version+1,updated_at=now() WHERE job_id=$1`,[jobId,claim.old_ingress_target]);
      await options.db.query(`UPDATE replica_rollout_job_items SET code=COALESCE(code,'OPERATOR_ROLLBACK_APPLIED') WHERE job_id=$1 AND slot=$2`,[jobId,observed.ingressTarget]);
      await recordAudit(actor,'maintenance.rollout.rollback.applied',`rollout-job:${jobId}`,'success');
    } catch {
      await options.db.query(`UPDATE replica_rollout_jobs SET state='UNKNOWN',rollback_state='UNKNOWN',last_error_code='ROLLBACK_OUTCOME_UNKNOWN',claim_until=NULL,version=version+1,updated_at=now() WHERE job_id=$1`,[jobId]);
      await options.db.query(`UPDATE replica_rollout_job_items SET state='UNKNOWN',code='ROLLBACK_OUTCOME_UNKNOWN' WHERE job_id=$1 AND slot=$2`,[jobId,observed.ingressTarget]);
      await recordAudit(actor,'maintenance.rollout.rollback.unknown',`rollout-job:${jobId}`,'error');
    }
    return getRolloutJob(jobId);
  }

  return { createRolloutPreview, executeRollout, getRolloutJob, runQueuedRollouts, createRollbackPreview, executeRollback };
}
