import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createAuditService } from '../../../orchestrator/services/orchestrator/src/modules/audit/audit';
import { createDb, type Db } from '../../../orchestrator/services/orchestrator/src/db/db';
import { loadMigrationFiles, migrate } from '../../../orchestrator/services/orchestrator/src/db/migrations';
import { createMaintenanceService, type BackupAdapter, type BackupTarget, type MaintenanceExecutionFence, type ReplicaObservation, type ReplicaRolloutAdapter } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/maintenance-service';
import { createMaintenanceBackupFence } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-fence';
import { createBackupSnapshotWriteGate, PostgresBackupArtifactEffects, PostgresBackupSnapshotFence } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence';
import type { ConnectorBackupEffectControl, ConnectorBackupEffectTarget } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/connector-backup-effect-control';
import type { ReplicaRuntimeObservation, ReplicaRuntimeSafetyPort } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/replica-runtime-safety';
import type { BackupReplicaRuntimePin } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/trusted-manifest-rollout-adapter';
import type { MaintenanceScope } from '../../../orchestrator/packages/contracts/src/maintenance';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeSql(value: string | null): string { return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function safeErrorCode(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown };
  return typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message.slice(0, 80) : 'UNKNOWN';
}

interface TxTrace { firstSql: string | null; gateDomain: string | null; backendPid: number | null; errorCode: string | null; }

function tracedDb(base: Db, name: string, transactions: Array<TxTrace>, gateEvents: Array<Record<string, unknown>>, clientTraces: WeakMap<object, TxTrace>): Db {
  return {
    pool: base.pool,
    query: (text, params) => base.query(text, params),
    close: () => base.close(),
    async tx<T>(fn: (client: any) => Promise<T>): Promise<T> {
      return base.tx(async (client) => {
        const trace: TxTrace = { firstSql: null, gateDomain: null, backendPid: null, errorCode: null };
        const instrumented = new Proxy(client, {
          get(target, key) {
            if (key === 'query') return async (...args: any[]) => {
              const sql = typeof args[0] === 'string' ? args[0] : String(args[0]?.text ?? '');
              if (trace.firstSql === null) trace.firstSql = sql;
              try { return await (target.query as any).apply(target, args); }
              catch (error) { trace.errorCode = safeErrorCode(error); throw error; }
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        clientTraces.set(instrumented, trace);
        try { return await fn(instrumented); }
        finally { transactions.push(trace); }
      });
    },
  };
}

function instrumentedGate(name: string, clientTraces: WeakMap<object, TxTrace>, gateEvents: Array<Record<string, unknown>>) {
  const actual = createBackupSnapshotWriteGate();
  return {
    async assertWriteAllowed(client: any, input: { tenantId: string | null; domain: any; requestKey: string }) {
      const trace = clientTraces.get(client);
      if (trace) trace.gateDomain = input.domain;
      try {
        await actual.assertWriteAllowed(client, input);
        if (trace) {
          const pid = await client.query('SELECT pg_backend_pid() AS pid');
          trace.backendPid = Number(pid.rows[0]?.pid);
        }
        gateEvents.push({ runner: name, domain: input.domain, outcome: 'allowed', backendPid: trace?.backendPid ?? null });
      } catch (error) {
        if (trace) trace.errorCode = safeErrorCode(error);
        gateEvents.push({ runner: name, domain: input.domain, outcome: 'blocked', errorCode: safeErrorCode(error) });
        throw error;
      }
    },
  };
}

const imageDigest = `synthetic@sha256:${'a'.repeat(64)}`;
const actor = { actor: 'orv14-vfy-host-synthetic', actorRole: 'platform' };
const platform: MaintenanceScope = { kind: 'platform' };
const backupTarget: BackupTarget = {
  name: 'orv14-vfy-host-target', descriptionCode: 'SYNTHETIC_FIXTURE', kind: 'postgres',
  allowlisted: true, immutable: true, manifestSha256: 'b'.repeat(64), targetPinDigest: 'c'.repeat(64),
  credentialVersionRefs: [], encryptionKeyVersionRefs: [], supportedScopes: ['platform', 'tenant', 'business'],
};

describe('ORV14 synthetic Host claim interleaving against real PostgreSQL', () => {
  jest.setTimeout(90000);

  it('checks maintenance and rollout claims against HELD and counts only the exact backup owner', async () => {
    const connectionString = process.env.ORV14_VFY_HOST_TEST_DATABASE_URL;
    if (!connectionString) throw new Error('ORV14_VFY_HOST_TEST_DATABASE_URL_REQUIRED');
    const databaseA = createDb(connectionString);
    const databaseB = createDb(connectionString);
    const txTraces: TxTrace[] = [];
    const gateEvents: Array<Record<string, unknown>> = [];
    const byClient = new WeakMap<object, TxTrace>();
    const dbA = tracedDb(databaseA, 'host-controller-a', txTraces, gateEvents, byClient);
    const dbB = tracedDb(databaseB, 'host-runner-b', txTraces, gateEvents, byClient);
    const blockerStarted = deferred<void>();
    const blockerRelease = deferred<void>();
    const connectorHeld = deferred<void>();
    const permitConnectorHold = deferred<void>();
    const primaryQuiescent = deferred<any>();
    const permitPrimaryRelease = deferred<void>();
    const maintenanceExternalCalls: string[] = [];
    const rolloutExternalCalls: string[] = [];
    const observationCounts = { runtime: 0, connectorObserve: 0, connectorHold: 0, connectorRelease: 0 };
    const evidence: Record<string, unknown> = { clock: 'system-wall-clock', maintenanceOnly: process.env.ORV14_VFY_HOST_MAINTENANCE_ONLY === '1' };
    // Use the real wall clock on every observation. This exercises the same
    // post-collection freshness bound as a live adapter; do not freeze or
    // advance a shared synthetic clock in this full interleaving case.
    const wallNow = () => new Date();
    const wallTimestamp = () => wallNow().toISOString();
    let connectorFence: { state: 'OPEN' | 'HELD'; fenceId: string | null; fenceRevision: number; acknowledgedAt: string | null } = {
      state: 'OPEN', fenceId: null, fenceRevision: 0, acknowledgedAt: null,
    };
    let blockerJobId = '';
    let primaryBootId = randomUUID();
    let primaryFenceError: string | null = null;
    let activeIngress: 'blue' | 'green' = 'blue';
    let heldOnce = false;
    let blockerRun: Promise<unknown> | null = null;
    let primaryRun: Promise<unknown> | null = null;

    try {
      const migrationsDir = path.resolve(process.cwd(), 'orchestrator/services/orchestrator/migrations');
      const sourceMigrations = loadMigrationFiles(migrationsDir);
      const migrationResult = await migrate(databaseA);
      expect(migrationResult.applied.length).toBe(sourceMigrations.length);
      const ledger = await databaseA.query<{ sequence: number; filename: string }>('SELECT sequence,filename FROM schema_migrations ORDER BY sequence');
      expect(ledger.rows.map((row) => row.filename)).toEqual(sourceMigrations.map((row) => row.filename));
      expect(ledger.rows.at(-1)?.sequence).toBeGreaterThanOrEqual(65);
      evidence.orchestratorMigrationLedgerRows = ledger.rows.length;
      evidence.lastMigrationSequence = ledger.rows.at(-1)?.sequence;

      const pins: BackupReplicaRuntimePin[] = (['orchestrator', 'connector', 'worker'] as const).flatMap((service) =>
        (['blue', 'green'] as const).map((slot) => {
          const runtimeIdentity = `${service}-${slot}`;
          return {
            service, slot, serviceId: `synthetic-${service}`, runtimeIdentity, replicaId: runtimeIdentity,
            revision: `fixture-${service}-r1`, imageDigest,
            ...(service === 'connector' ? { controlBaseUrl: 'http://127.0.0.1:29161' } : {}),
          };
        }));
      const runtimeSafety: ReplicaRuntimeSafetyPort = {
        async observe(input): Promise<ReplicaRuntimeObservation> {
          observationCounts.runtime += 1;
          const observedAt = wallTimestamp();
          const observed: ReplicaRuntimeObservation = {
            service: input.service, slot: input.slot, runtimeIdentity: input.runtimeIdentity,
            replicaId: input.replicaId, revision: input.revision, imageDigest: input.imageDigest,
            readiness: 'READY', observedAt, workObservedAt: observedAt, controlRevision: 1,
            controlState: 'OPEN', controlAcknowledgedAt: observedAt,
            ...(input.service === 'worker' ? { backupEffectFence: { revision: 1, acknowledgedAt: observedAt } } : {}),
            work: {
              workerLeases: { applicable: true, count: 0 }, sdkActiveTasks: { applicable: true, count: 0 },
              connectorInvocations: { applicable: true, count: 0 }, orchestratorRequests: { applicable: true, count: 0 },
              dispatches: { applicable: true, count: 0 }, maintenanceExecutions: { applicable: true, count: 0 },
            },
          };
          if (input.service === 'orchestrator') {
            const counts = await databaseA.query<{ count: string }>(
              `SELECT ((SELECT count(*) FROM maintenance_job_items WHERE owner_runtime_identity=$1 AND status IN ('RUNNING','UNKNOWN'))
                    +(SELECT count(*) FROM replica_rollout_jobs WHERE owner_runtime_identity=$1 AND state IN ('RUNNING','UNKNOWN')))::text AS count`,
              [input.runtimeIdentity],
            );
            observed.work.maintenanceExecutions.count = Number(counts.rows[0]?.count ?? 0);
          }
          return observed;
        },
        async requestDrain() { return { controlRevision: 2, requestedAt: new Date().toISOString() }; },
        async requestResume() { return { controlRevision: 3, requestedAt: new Date().toISOString() }; },
        async probeFixedIngress(input) {
          const slot = activeIngress;
          const pin = pins.find((entry) => entry.service === input.service && entry.slot === slot)!;
          return {
            statusCode: 200, servedService: input.service, servedSlot: slot,
            servedRuntimeIdentity: pin.runtimeIdentity, servedReplicaId: pin.replicaId,
            servedRevision: pin.revision, servedImageDigest: pin.imageDigest, observedAt: new Date().toISOString(),
          };
        },
      };

      const connectorTargets = pins.filter((entry) => entry.service === 'connector') as ConnectorBackupEffectTarget[];
      const connectorControl: ConnectorBackupEffectControl = {
        async observe(target) {
          observationCounts.connectorObserve += 1;
          return connectorObservation(target, connectorFence, wallTimestamp);
        },
        async hold(target, command) {
          observationCounts.connectorHold += 1;
          if (connectorFence.state === 'OPEN') connectorFence = {
            state: 'HELD', fenceId: command.fenceId, fenceRevision: command.fenceRevision,
            acknowledgedAt: wallTimestamp(),
          };
          if (connectorFence.state !== 'HELD' || connectorFence.fenceId !== command.fenceId
            || connectorFence.fenceRevision !== command.fenceRevision) throw new Error('SYNTHETIC_CONNECTOR_CAS_MISMATCH');
          if (!heldOnce) {
            heldOnce = true;
            connectorHeld.resolve();
            await permitConnectorHold.promise;
          }
          return connectorObservation(target, connectorFence, wallTimestamp);
        },
        async release(target, command) {
          observationCounts.connectorRelease += 1;
          if (connectorFence.state !== 'HELD' || connectorFence.fenceId !== command.fenceId
            || connectorFence.fenceRevision !== command.fenceRevision) throw new Error('SYNTHETIC_CONNECTOR_RELEASE_MISMATCH');
          connectorFence = { state: 'OPEN', fenceId: null, fenceRevision: command.fenceRevision, acknowledgedAt: null };
          void target;
        },
      };

      const artifactEffects = new PostgresBackupArtifactEffects(databaseA, {
        runtimeIdentity: 'host-controller-a', bootId: primaryBootId,
      }, wallNow);
      const snapshotFence = new PostgresBackupSnapshotFence(databaseA);
      const backupFence = createMaintenanceBackupFence({
        db: databaseA, snapshotFence, artifactEffects, runtimeSafety, replicaPins: pins,
        connectorControl, maxWaitMs: 10000, sampleIntervalMs: 20, freshnessMs: 5000,
        now: wallNow,
        sleep: delay,
      });

      const rolloutAdapter: ReplicaRolloutAdapter = {
        trusted: true, runtimeSafety,
        async executorIdentityForSlot(input) { return `candidate-${input.service}-${input.slot}`; },
        async observe(input) {
          const active = pins.find((entry) => entry.service === input.service && entry.slot === activeIngress)!;
          const replica: ReplicaObservation = {
            replicaId: active.runtimeIdentity, slot: active.slot, desiredRevision: active.revision,
            observedRevision: active.revision, state: 'READY', activeWork: 0,
            acknowledgedAt: new Date().toISOString(), code: null,
          };
          return { replicas: [replica], ingressTarget: activeIngress, fixedIngress: true };
        },
        async prepareSlot(input) {
          rolloutExternalCalls.push(`prepare:${input.slot}:${input.revision}`);
          return {
            replicaId: `candidate-${input.service}-${input.slot}`, slot: input.slot,
            desiredRevision: input.revision, observedRevision: input.revision, state: 'READY',
            activeWork: 0, acknowledgedAt: new Date().toISOString(), code: null,
          };
        },
        async switchIngress(input) {
          rolloutExternalCalls.push(`switch:${input.expectedTarget}->${input.target}`);
          if (input.expectedTarget !== activeIngress) throw new Error('SYNTHETIC_INGRESS_CAS_MISMATCH');
          activeIngress = input.target as 'blue' | 'green';
          return { switched: true, observedTarget: activeIngress };
        },
        async drainReplica(input) {
          rolloutExternalCalls.push(`drain:${input.replicaId}`);
          return {
            replicaId: input.replicaId, slot: 'blue', desiredRevision: 'fixture-orchestrator-r0',
            observedRevision: 'fixture-orchestrator-r0', state: 'STOPPED', activeWork: 0,
            acknowledgedAt: new Date().toISOString(), code: null,
          };
        },
        async restoreIngress(input) {
          rolloutExternalCalls.push(`restore:${input.expectedTarget}->${input.target}`);
          activeIngress = input.target as 'blue' | 'green';
          return { switched: true, observedTarget: activeIngress };
        },
      };

      const bundleAdapterFor = (hostIdentity: string): BackupAdapter => ({
        trusted: true,
        async listTargets() { return [backupTarget]; },
        async createBundle(input) {
          maintenanceExternalCalls.push(`${hostIdentity}:${input.execution.jobId}`);
          if (input.execution.jobId === blockerJobId) {
            blockerStarted.resolve();
            await blockerRelease.promise;
            return bundleResult('fixture-blocker');
          }
          if (hostIdentity === 'host-controller-a') {
            let acquired;
            try {
              acquired = await backupFence.acquire({
                backupId: input.backupId, execution: input.execution, reason: 'durable-platform-backup',
              });
            } catch (error) {
              primaryFenceError = safeErrorCode(error);
              throw error;
            }
            primaryQuiescent.resolve(acquired);
            await permitPrimaryRelease.promise;
            await backupFence.release({
              backupId: input.backupId, fenceId: acquired.fenceId, fenceRevision: acquired.fenceRevision,
              execution: input.execution, restorePriorState: true,
            });
            return bundleResult('fixture-primary');
          }
          return bundleResult('fixture-queued');
        },
        async restoreBundle() { throw new Error('RESTORE_NOT_USED'); },
      });

      const makeService = (database: Db, runnerIdentity: string) => {
        const traced = runnerIdentity === 'host-controller-a' ? dbA : dbB;
        const serviceBoot = runnerIdentity === 'host-controller-a' ? primaryBootId : randomUUID();
        return createMaintenanceService({
          db: traced, audit: createAuditService(traced), artifacts: { async expireForMaintenance() { return { status: 'SKIPPED', code: null }; } },
          async getEffectiveRetentionPolicy() { return { revision: 1, cacheTtlHours: 0, outputRetentionDays: 0, cleanupIntervalSeconds: 0 }; },
          backupAdapter: bundleAdapterFor(runnerIdentity), rolloutAdapter,
          runnerRuntimeIdentity: runnerIdentity, trustedHostControllerIdentity: runnerIdentity,
          ownerBootId: serviceBoot,
          backupSnapshotWriteGate: instrumentedGate(runnerIdentity, byClient, gateEvents),
        });
      };
      const hostA = makeService(dbA, 'host-controller-a');
      const hostB = makeService(dbB, 'host-runner-b');
      const makeBackup = async (service: ReturnType<typeof makeService>, key: string) => {
        const preview = await service.createMaintenancePreview(actor, {
          kind: 'backup', scope: platform, filters: { backupTarget: backupTarget.name }, reason: `synthetic ${key}`,
        });
        return service.startMaintenanceJob(actor, {
          previewId: preview.previewId, expectedVersion: preview.expectedVersion,
          idempotencyKey: `orv14-vfy-host-${key}-${randomUUID()}`, reason: `synthetic ${key}`,
        });
      };

      const blocker = await makeBackup(hostB, 'blocker');
      blockerJobId = blocker.jobId;
      blockerRun = hostB.runQueuedMaintenanceJobs('host-runner-b', 1);
      await blockerStarted.promise;
      expect(maintenanceExternalCalls).toHaveLength(1);

      const primary = await makeBackup(hostA, 'primary');
      const later = await makeBackup(hostB, 'later');
      const maintenanceOnly = process.env.ORV14_VFY_HOST_MAINTENANCE_ONLY === '1';
      const rolloutPreview = maintenanceOnly ? null : await hostB.createRolloutPreview(actor, {
        service: 'orchestrator', desiredRevision: 'fixture-orchestrator-r2', scope: platform,
        strategy: 'two_slot', reason: 'synthetic host handoff',
      });
      const rollout = rolloutPreview ? await hostB.executeRollout(actor, {
        previewId: rolloutPreview.previewId, expectedVersion: rolloutPreview.expectedVersion,
        idempotencyKey: `orv14-vfy-host-rollout-${randomUUID()}`, reason: 'synthetic host handoff',
      }) : null;

      primaryRun = hostA.runQueuedMaintenanceJobs('host-controller-a', 1);
      await connectorHeld.promise;
      const heldRow = await databaseA.query<{ state: string; fence_revision: number }>(
        'SELECT state,fence_revision FROM maintenance_backup_effect_gate WHERE singleton_id=1',
      );
      expect({ state: heldRow.rows[0]?.state, fenceRevision: Number(heldRow.rows[0]?.fence_revision) })
        .toEqual({ state: 'HELD', fenceRevision: 1 });
      evidence.gateHeld = { state: heldRow.rows[0]?.state, revision: Number(heldRow.rows[0]?.fence_revision) };

      const callCountBeforeBlockedClaims = maintenanceExternalCalls.length;
      const rolloutCallCountBeforeBlockedClaims = rolloutExternalCalls.length;
      const heldMaintenanceAttempt = await hostB.runQueuedMaintenanceJobs('host-runner-b', 1);
      const heldRolloutAttempt = maintenanceOnly ? [] : await hostB.runQueuedRollouts('host-runner-b', 1);
      expect(heldMaintenanceAttempt).toEqual([]);
      expect(heldRolloutAttempt).toEqual([]);
      expect(maintenanceExternalCalls).toHaveLength(callCountBeforeBlockedClaims);
      expect(rolloutExternalCalls).toHaveLength(rolloutCallCountBeforeBlockedClaims);
      const queuedStatus = await databaseA.query<{ status: string }>(
        'SELECT status FROM maintenance_job_items WHERE job_id=$1', [later.jobId],
      );
      expect(queuedStatus.rows[0]?.status).toBe('PENDING');
      if (rollout) {
        const rolloutStatus = await databaseA.query<{ state: string; phase: string }>(
          'SELECT state,phase FROM replica_rollout_jobs WHERE job_id=$1', [rollout.jobId],
        );
        expect(rolloutStatus.rows[0]).toMatchObject({ state: 'QUEUED', phase: 'PREPARE' });
      }

      const runningCounts = await databaseA.query<{ total: string }>(
        `SELECT ((SELECT count(*) FROM maintenance_job_items WHERE status IN ('RUNNING','UNKNOWN'))
                  +(SELECT count(*) FROM replica_rollout_jobs WHERE state IN ('RUNNING','UNKNOWN')))::text AS total`,
      );
      const execution = await readClaim(databaseA, primary.jobId, backupTarget.name);
      const exact = await databaseA.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM maintenance_job_items WHERE job_id=$1 AND item_id=$2 AND item_type='backup'
           AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4 AND execution_fence=$5
           AND backup_execution_token_sha256=$6 AND claim_until>now()`,
        [execution.jobId, execution.itemId, execution.ownerRuntimeIdentity, execution.ownerBootId,
          execution.executionFence, execution.executionTokenSha256],
      );
      expect(Number(runningCounts.rows[0]?.total)).toBe(2);
      expect(Number(exact.rows[0]?.count)).toBe(1);
      expect(Number(runningCounts.rows[0]?.total) - Number(exact.rows[0]?.count)).toBe(1);
      evidence.heldWorkCounts = { totalRunningOrUnknown: Number(runningCounts.rows[0]?.total), exactBackupOwner: Number(exact.rows[0]?.count), residualBlocker: 1 };

      permitConnectorHold.resolve();
      const runtimeBefore = observationCounts.runtime;
      try { await waitFor(() => observationCounts.runtime > runtimeBefore + 6, 3000); }
      catch {
        throw new Error(`SYNTHETIC_FENCE_SAMPLE_NOT_STARTED runtime=${observationCounts.runtime} connectorObserve=${observationCounts.connectorObserve} connectorHold=${observationCounts.connectorHold} fenceError=${primaryFenceError ?? 'none'}`);
      }
      const resolvedTooEarly = await Promise.race([primaryQuiescent.promise.then(() => true), delay(150).then(() => false)]);
      expect(resolvedTooEarly).toBe(false);
      const exactWhileBlocked = await databaseA.query<{ total: string; own: string }>(
        `SELECT ((SELECT count(*) FROM maintenance_job_items WHERE status IN ('RUNNING','UNKNOWN'))
                  +(SELECT count(*) FROM replica_rollout_jobs WHERE state IN ('RUNNING','UNKNOWN')))::text AS total,
                (SELECT count(*) FROM maintenance_job_items WHERE job_id=$1 AND item_id=$2 AND status='RUNNING'
                   AND owner_runtime_identity=$3 AND owner_boot_id=$4 AND execution_fence=$5
                   AND backup_execution_token_sha256=$6 AND claim_until>now())::text AS own`,
        [execution.jobId, execution.itemId, execution.ownerRuntimeIdentity, execution.ownerBootId,
          execution.executionFence, execution.executionTokenSha256],
      );
      expect(exactWhileBlocked.rows[0]).toEqual({ total: '2', own: '1' });
      evidence.interleavedCountsBeforeBlockerRelease = exactWhileBlocked.rows[0];

      blockerRelease.resolve();
      await blockerRun;
      const proof = await primaryQuiescent.promise;
      expect(proof.proof.orchestratorDispatch.inFlight).toBe(0);
      const onlyOwner = await databaseA.query<{ total: string; own: string }>(
        `SELECT ((SELECT count(*) FROM maintenance_job_items WHERE status IN ('RUNNING','UNKNOWN'))
                  +(SELECT count(*) FROM replica_rollout_jobs WHERE state IN ('RUNNING','UNKNOWN')))::text AS total,
                (SELECT count(*) FROM maintenance_job_items WHERE job_id=$1 AND item_id=$2 AND status='RUNNING'
                   AND owner_runtime_identity=$3 AND owner_boot_id=$4 AND execution_fence=$5
                   AND backup_execution_token_sha256=$6 AND claim_until>now())::text AS own`,
        [execution.jobId, execution.itemId, execution.ownerRuntimeIdentity, execution.ownerBootId,
          execution.executionFence, execution.executionTokenSha256],
      );
      expect(onlyOwner.rows[0]).toEqual({ total: '1', own: '1' });
      evidence.quiescentCountsAfterBlockerRelease = onlyOwner.rows[0];
      evidence.backupProofObservedAt = proof.proof.observedAt;
      expect(maintenanceExternalCalls).toHaveLength(callCountBeforeBlockedClaims);
      expect(rolloutExternalCalls).toHaveLength(rolloutCallCountBeforeBlockedClaims);

      permitPrimaryRelease.resolve();
      await primaryRun;
      const openRow = await databaseA.query<{ state: string }>('SELECT state FROM maintenance_backup_effect_gate WHERE singleton_id=1');
      expect(openRow.rows[0]?.state).toBe('OPEN');
      expect(connectorFence.state).toBe('OPEN');

      const laterResult = await hostB.runQueuedMaintenanceJobs('host-runner-b', 1);
      expect(laterResult[0]?.state).toBe('SUCCEEDED');
      expect(maintenanceExternalCalls).toHaveLength(callCountBeforeBlockedClaims + 1);

      if (rollout) {
        const prepared = await hostB.runQueuedRollouts('host-runner-b', 1);
        if (prepared[0]?.state !== 'QUEUED') {
          throw new Error(`ROLLOUT_HANDOFF_RESULT:${JSON.stringify({
            returned: prepared.map(({ state, activeIngressTarget, lastErrorCode }) => ({ state, activeIngressTarget, lastErrorCode })),
            calls: rolloutExternalCalls,
            durable: (await databaseA.query<{ state: string; phase: string; owner_runtime_identity: string | null; claim_until: Date | null; old_ingress_target: string | null; candidate_runtime_identity: string | null; service: string; desired_revision: string }>(
              'SELECT state,phase,owner_runtime_identity,claim_until,old_ingress_target,candidate_runtime_identity,service,desired_revision FROM replica_rollout_jobs WHERE job_id=$1', [rollout.jobId],
            )).rows[0] ?? null,
            latestTransactions: txTraces.slice(-8),
            gates: gateEvents,
            items: (await databaseA.query('SELECT replica_id,slot,state,code FROM replica_rollout_job_items WHERE job_id=$1 ORDER BY ordinal', [rollout.jobId])).rows,
          })}`);
        }
        expect(prepared[0]?.state).toBe('QUEUED');
        const afterPrepare = await databaseA.query<{ state: string; phase: string; active_ingress_target: string; owner_runtime_identity: string | null; claim_until: Date | null }>(
          'SELECT state,phase,active_ingress_target,owner_runtime_identity,claim_until FROM replica_rollout_jobs WHERE job_id=$1', [rollout.jobId],
        );
        expect(afterPrepare.rows[0]).toMatchObject({
          state: 'QUEUED', phase: 'CUTOVER', active_ingress_target: 'blue',
          owner_runtime_identity: null, claim_until: null,
        });
        evidence.rolloutPrepareHandoff = {
          state: afterPrepare.rows[0]?.state, phase: afterPrepare.rows[0]?.phase,
          activeIngress: afterPrepare.rows[0]?.active_ingress_target, ownerReleased: afterPrepare.rows[0]?.owner_runtime_identity === null,
        };
        const callsBeforeForeign = rolloutExternalCalls.length;
        const restartedHostController = makeService(dbB, 'host-runner-b');
        expect(await restartedHostController.runQueuedRollouts('foreign-controller', 1)).toEqual([]);
        expect(rolloutExternalCalls).toHaveLength(callsBeforeForeign);
        const handedOff = await restartedHostController.runQueuedRollouts('host-runner-b', 1);
        expect(handedOff[0]).toMatchObject({ state: 'SUCCEEDED', activeIngressTarget: 'green' });
        evidence.rolloutAfterControllerRestart = {
          state: handedOff[0]?.state, activeIngress: handedOff[0]?.activeIngressTarget,
          calls: rolloutExternalCalls.slice(callsBeforeForeign),
        };
        expect(rolloutExternalCalls).toEqual([
          `prepare:green:fixture-orchestrator-r2`, 'switch:blue->green', 'drain:orchestrator-blue',
        ]);

        await databaseA.query(`
          CREATE FUNCTION orv14_vfy_reject_rollout_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.replica_id LIKE 'slot-%' THEN
              RAISE EXCEPTION 'synthetic pre-effect candidate rejection' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER orv14_vfy_reject_rollout_candidate
            BEFORE INSERT ON replica_rollout_job_items FOR EACH ROW
            EXECUTE FUNCTION orv14_vfy_reject_rollout_candidate();
        `);
        const failurePreview = await restartedHostController.createRolloutPreview(actor, {
          service: 'orchestrator', desiredRevision: 'fixture-orchestrator-pre-effect-failure', scope: platform,
          strategy: 'two_slot', reason: 'synthetic pre-effect failure',
        });
        const failureJob = await restartedHostController.executeRollout(actor, {
          previewId: failurePreview.previewId, expectedVersion: failurePreview.expectedVersion,
          idempotencyKey: `orv14-vfy-host-rollout-failure-${randomUUID()}`, reason: 'synthetic pre-effect failure',
        });
        const callsBeforeFailedPrepare = rolloutExternalCalls.length;
        const failedPrepare = await restartedHostController.runQueuedRollouts('host-runner-b', 1);
        expect(failedPrepare[0]).toMatchObject({ state: 'FAILED', lastErrorCode: '23514' });
        expect(rolloutExternalCalls).toHaveLength(callsBeforeFailedPrepare);
        const failureStatus = await databaseA.query<{ state: string; phase: string; owner_runtime_identity: string | null; claim_until: Date | null; last_error_code: string | null }>(
          'SELECT state,phase,owner_runtime_identity,claim_until,last_error_code FROM replica_rollout_jobs WHERE job_id=$1', [failureJob.jobId],
        );
        expect(failureStatus.rows[0]).toMatchObject({
          state: 'FAILED', phase: 'PREPARE', owner_runtime_identity: null, claim_until: null, last_error_code: '23514',
        });
        evidence.preEffectPrepareFailure = {
          state: failureStatus.rows[0]?.state, phase: failureStatus.rows[0]?.phase,
          ownerReleased: failureStatus.rows[0]?.owner_runtime_identity === null,
          leaseReleased: failureStatus.rows[0]?.claim_until === null,
          sqlState: failureStatus.rows[0]?.last_error_code,
          adapterCallCount: rolloutExternalCalls.length - callsBeforeFailedPrepare,
        };
      }

      const claimTransactions = txTraces.filter((trace) => trace.gateDomain !== null);
      expect(claimTransactions.length).toBeGreaterThanOrEqual(maintenanceOnly ? 5 : 8);
      const expectedFirst = normalizeSql('SELECT state,fence_id,fence_revision FROM maintenance_backup_effect_gate WHERE singleton_id=1 FOR SHARE');
      expect(claimTransactions.every((trace) => normalizeSql(trace.firstSql) === expectedFirst)).toBe(true);
      const allowedBackendPids = new Set(gateEvents.filter((event) => event.outcome === 'allowed').map((event) => event.backendPid));
      expect(allowedBackendPids.size).toBeGreaterThanOrEqual(2);
      expect(gateEvents.some((event) => event.outcome === 'blocked' && event.domain === 'maintenance-execution')).toBe(true);
      if (!maintenanceOnly) expect(gateEvents.some((event) => event.outcome === 'blocked' && event.domain === 'rollout-execution')).toBe(true);
      expect(observationCounts.connectorHold).toBe(2);
      expect(observationCounts.connectorRelease).toBe(1);
      evidence.claimGateTransactions = claimTransactions.length;
      evidence.allowedPostgresBackendPidCount = allowedBackendPids.size;
      evidence.gateBlocks = gateEvents.filter((event) => event.outcome === 'blocked').map(({ domain, errorCode }) => ({ domain, errorCode }));
      evidence.maintenanceExternalCallCount = maintenanceExternalCalls.length;
      evidence.connectorControlCalls = { holds: observationCounts.connectorHold, releases: observationCounts.connectorRelease };

      // The synthetic adapters prove the durable Host service protocol and PG
      // exclusion only. Their callbacks are not production Connector or ingress
      // observations, and no backup object was created outside this fixture.
      expect(maintenanceExternalCalls.every((entry) => entry.startsWith('host-'))).toBe(true);
      process.stdout.write(`ORV14_HOST_CLAIM_EVIDENCE ${JSON.stringify(evidence)}\n`);
    } finally {
      blockerRelease.resolve();
      permitConnectorHold.resolve();
      permitPrimaryRelease.resolve();
      await Promise.allSettled([blockerRun, primaryRun].filter(Boolean) as Promise<unknown>[]);
      await Promise.allSettled([databaseA.close(), databaseB.close()]);
    }
  });
});

function connectorObservation(target: ConnectorBackupEffectTarget, current: { state: 'OPEN' | 'HELD'; fenceId: string | null; fenceRevision: number; acknowledgedAt: string | null }, now: () => string) {
  const observedAt = now();
  return {
    slot: target.slot, runtimeIdentity: target.runtimeIdentity, replicaId: target.replicaId,
    revision: target.revision, imageDigest: target.imageDigest,
    fence: { fenceId: current.fenceId, fenceRevision: current.fenceRevision, state: current.state,
      acknowledgedAt: current.acknowledgedAt, bootId: randomUUID() },
    work: { processActiveInvocations: 0, processActivePolls: 0, processActiveUsageSends: 0,
      effectPermits: { prepared: 0, active: 0, settling: 0, unknown: 0 }, unclosedEffectPermits: 0,
      unresolvedInvocationHolds: 0, unknownUsageDeliveries: 0 },
    observedAt, workObservedAt: observedAt,
  };
}

function bundleResult(suffix: string) {
  return { bundleRef: `synthetic://${suffix}`, sha256: 'd'.repeat(64), byteSize: 7, immutable: true as const,
    verified: true as const, credentialVersionRefs: [], encryptionKeyVersionRefs: [], manifest: { synthetic: true } };
}

async function readClaim(db: Db, jobId: string, itemId: string): Promise<MaintenanceExecutionFence & { executionTokenSha256: string }> {
  const result = await db.query<{
    job_id: string; item_id: string; owner_runtime_identity: string; owner_boot_id: string;
    execution_fence: number; backup_execution_token_sha256: string; claim_until: Date;
  }>(`SELECT job_id,item_id,owner_runtime_identity,owner_boot_id,execution_fence,
            backup_execution_token_sha256,claim_until
       FROM maintenance_job_items WHERE job_id=$1 AND item_id=$2`, [jobId, itemId]);
  const row = result.rows[0];
  if (!row || row.owner_runtime_identity !== 'host-controller-a' || !row.backup_execution_token_sha256) {
    throw new Error('SYNTHETIC_PRIMARY_CLAIM_NOT_FOUND');
  }
  // The execution token is deliberately not read from PostgreSQL. The claim
  // hash is enough to join the exact durable owner row without exposing the
  // in-memory bearer token in fixture evidence.
  return {
    jobId: row.job_id, itemId: row.item_id, ownerRuntimeIdentity: row.owner_runtime_identity,
    ownerBootId: row.owner_boot_id, executionFence: Number(row.execution_fence),
    executionToken: 'unused-token-never-logged-0000000000000000',
    executionTokenSha256: row.backup_execution_token_sha256,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('SYNTHETIC_OBSERVATION_TIMEOUT');
}
