import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { QueryResultRow, PoolClient } from 'pg';
import type { Queue } from 'bullmq';
import {
  MaintenancePreviewRequestSchema, MaintenanceScopeSchema, QueueActionPreviewRequestSchema,
  ReplicaRolloutPreviewRequestSchema, StartMaintenanceJobSchema, ConfirmQueueActionSchema,
  ExecuteReplicaRolloutSchema, PreviewReplicaRollbackSchema, ExecuteReplicaRollbackSchema,
  type MaintenancePreviewRequest, type MaintenanceScope, type MaintenanceKind,
  type MaintenancePreview, type MaintenanceJob, type MaintenanceItemOutcome,
  type QueueActionPreviewRequest, type QueueActionPreview, type QueueActionJob,
  type QueueAction, type RetentionPolicySnapshot, type ServiceInventory, type QueueInventory,
  type ReplicaRolloutPreviewRequest, type ReplicaRolloutPreview, type ReplicaRolloutJob,
  type PreviewReplicaRollback, type ReplicaRollbackPreview,
  type StorageGenerationRead, type StorageGenerationStageRequest, type StorageGenerationActionRequest,
} from '@du/contracts';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import type { ArtifactService } from '../artifacts/artifacts';
import type { StorageGenerationService } from '../artifacts/storage-generations';
import { lockRuntimeControls } from '../runtime/control';
import { retryAdminDelivery, type AdminDeliveryCapabilities } from '../webhooks/admin-delivery';
import { createReplicaRolloutService } from './rollouts';
import type { BackupSnapshotWriteGate } from './backup-effect-fence';
import type { ReplicaRuntimeSafetyPort } from './replica-runtime-safety';
import { conflict, notFound, unprocessable, unavailable } from '../../http/errors';
import { canonicalPayloadHash } from '../idempotency/idempotency';

const PREVIEW_TTL_MS = 5 * 60_000;
const CONTROL_ACK_FRESH_MS = 60_000;
const MAX_RUN_ITEMS = 20;
const MAX_EVIDENCE_TEXT = 400;

export interface MaintenanceArtifactPort extends Pick<ArtifactService, 'expireForMaintenance'> {}

export interface BackupTarget {
  name: string;
  descriptionCode: string;
  kind: 'postgres' | 'artifact-storage';
  allowlisted: true;
  immutable: true;
  /** Digest of the root-pinned target manifest and immutable version inventory. */
  manifestSha256: string;
  targetPinDigest: string;
  credentialVersionRefs: readonly string[];
  encryptionKeyVersionRefs: readonly string[];
  supportedScopes: readonly ('platform' | 'tenant' | 'business')[];
}

/** Safe web-plane projection used only to preview and enqueue a target. */
export interface BackupTargetPreviewDescriptor {
  name: string;
  kind: 'postgres' | 'artifact-storage';
  allowlisted: true;
  immutable: true;
  manifestSha256: string;
  targetPinDigest: string;
  supportedScopes: readonly ('platform' | 'tenant' | 'business')[];
}

export function backupTargetPinDigest(input: {
  name: string;
  kind: BackupTarget['kind'];
  manifestSha256: string;
  credentialVersionRefs: readonly string[];
  encryptionKeyVersionRefs: readonly string[];
}): string {
  return createHash('sha256').update(JSON.stringify({
    name: input.name,
    kind: input.kind,
    manifestSha256: input.manifestSha256,
    credentialVersionRefs: [...input.credentialVersionRefs].sort(),
    encryptionKeyVersionRefs: [...input.encryptionKeyVersionRefs].sort(),
  })).digest('hex');
}

export interface BackupAdapter {
  readonly trusted: true;
  /** Only deployment-reviewed target names are returned. Paths/URLs stay private. */
  listTargets(): Promise<readonly BackupTarget[]>;
  createBundle(input: { backupId: string; target: BackupTarget; scope: MaintenanceScope; execution: MaintenanceExecutionFence }): Promise<{
    bundleRef: string; sha256: string; byteSize: number; immutable: true; verified: true;
    credentialVersionRefs: readonly string[]; encryptionKeyVersionRefs: readonly string[]; manifest: Record<string, unknown>;
  }>;
  restoreBundle(input: {
    backupId: string; bundleRef: string; expectedSha256: string; targetGenerationId: string;
    isolated: true; dispatchDisabled: true; providerCallsDisabled: true;
    execution: MaintenanceExecutionFence;
  }): Promise<{
    isolated: true; dispatchDisabled: true; providerCallsDisabled: true;
    checksummed: true; reconciled: true; counts: { artifacts: number; objects: number; keys: number };
    targetGenerationId: string; cutover: 'NOT_PERFORMED';
    runtimeProbe: Record<string, unknown>;
  }>;
}

/** Durable item ownership passed through every host-side maintenance effect. */
export interface MaintenanceExecutionFence {
  jobId: string;
  itemId: string;
  ownerRuntimeIdentity: string;
  ownerBootId: string;
  executionFence: number;
  /** Ephemeral server-side claim token. Only its SHA-256 is persisted. */
  executionToken: string;
}

export interface ReplicaObservation {
  replicaId: string;
  slot: string | null;
  desiredRevision: string;
  observedRevision: string | null;
  state: 'PENDING' | 'STARTING' | 'READY' | 'DRAINING' | 'STOPPED' | 'FAILED' | 'UNKNOWN';
  activeWork: number | null;
  acknowledgedAt: string | null;
  code: string | null;
  /** Present only when the trusted replica safety source observed this app. */
  controlRevision?: number | null;
  controlState?: 'OPEN' | 'PAUSED' | 'DRAINING' | null;
}

export type ReplicaRolloutService = 'orchestrator' | 'connector' | 'worker';
export interface ReplicaRolloutCapabilities {
  /** Services present in the exact digest-checked deployment manifest. */
  services: readonly ReplicaRolloutService[];
  /** Services with a fixed, probeable blue/green ingress. */
  fixedIngressServices: readonly ('orchestrator' | 'connector')[];
  /** A worker target supports exact per-replica replacement in the host adapter. */
  workerReplacement: boolean;
}

/** Safe read-only deployment view for previews and status. Implementations
 * expose only manifest-derived identity/capability metadata and live service
 * observations; they never carry Docker, reload, or control-mutation methods. */
export interface ReplicaRolloutObservationAdapter {
  readonly trusted: true;
  capabilities(): Promise<ReplicaRolloutCapabilities>;
  /** Candidate identity is read only from the same root-owned manifest used
   * to start and observe its slot. It fences the post-cutover executor. */
  executorIdentityForSlot(input: { service: ReplicaRolloutService; revision: string; slot: string }): Promise<string>;
  observe(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope }): Promise<{
    replicas: readonly ReplicaObservation[]; ingressTarget: string | null; fixedIngress: boolean;
  }>;
}

/** Host-only effect adapter. Keep this separate from the web preview port so
 * a web process cannot accidentally acquire Docker/reload methods. */
export interface ReplicaRolloutAdapter extends ReplicaRolloutObservationAdapter {
  readonly runtimeSafety: ReplicaRuntimeSafetyPort;
  prepareSlot(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope; revision: string; slot: string }): Promise<ReplicaObservation>;
  drainReplica(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope; replicaId: string; deadlineMs: number }): Promise<ReplicaObservation>;
  switchIngress(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope; expectedTarget: string | null; target: string }): Promise<{ switched: true; observedTarget: string }>;
  restoreIngress(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope; expectedTarget: string; target: string | null; targetRevision: string }): Promise<{ switched: true; observedTarget: string | null }>;
  /** Per-replica strategy must replace one stable logical replica at a time. */
  replaceReplica?(input: { service: 'orchestrator' | 'connector' | 'worker'; scope: MaintenanceScope; replicaId: string; revision: string }): Promise<ReplicaObservation>;
}

export interface MaintenanceServiceOptions {
  db: Db;
  audit: AuditService;
  artifacts: MaintenanceArtifactPort;
  storageGenerations?: StorageGenerationService;
  getEffectiveRetentionPolicy(): Promise<RetentionPolicySnapshot>;
  getQueue?(queueName: string): Queue | null;
  callbackCapabilities?: AdminDeliveryCapabilities;
  /** Injects runtime's exact lease/attempt/child reconciliation path. */
  recoverExpiredLease?(taskId: string, expectedLeaseEpoch: number): Promise<{ status: 'APPLIED' | 'SKIPPED'; code: string | null; evidence: Record<string, unknown> }>;
  backupAdapter?: BackupAdapter;
  /** Secret-free, no-tool reader for web previews; host execution still uses backupAdapter. */
  listBackupTargetDescriptors?: () => Promise<readonly BackupTargetPreviewDescriptor[]>;
  /** Safe manifest-backed observer used by web preview/status endpoints. */
  rolloutObservationAdapter?: ReplicaRolloutObservationAdapter;
  /** Privileged effect adapter; construct only in the dedicated host runner. */
  rolloutExecutionAdapter?: ReplicaRolloutAdapter;
  runnerRuntimeIdentity?: string | null;
  /** Set only by the dedicated host execution context after validating the
   * root-pinned backup manifest; web processes must leave this unset. */
  trustedHostControllerIdentity?: string | null;
  /** One process boot nonce shared with the backup artifact permit owner. */
  ownerBootId?: string;
  /** Shared singleton gate; every durable item claim takes FOR SHARE first. */
  backupSnapshotWriteGate: BackupSnapshotWriteGate;
  now?: () => Date;
}

type ScopeKey = { scopeKind: 'platform' | 'tenant' | 'business'; scopeId: string };
type Candidate = { itemId: string; itemType: 'artifact' | 'task' | 'delivery' | 'backup' | 'restore-target' | 'replica'; eligibility: 'ELIGIBLE' | 'SKIPPED' | 'UNKNOWN'; reasonCode: string | null; estimatedBytes: number | null; data?: Record<string, unknown> };
type PlainRow = QueryResultRow & Record<string, any>;

function scopeKey(scope: MaintenanceScope): ScopeKey {
  if (scope.kind === 'platform') return { scopeKind: 'platform', scopeId: 'all' };
  if (scope.kind === 'tenant') return { scopeKind: 'tenant', scopeId: scope.tenantId };
  return { scopeKind: 'business', scopeId: scope.businessId };
}

function scopeSql(scope: MaintenanceScope, start = 1): { where: string; params: unknown[] } {
  if (scope.kind === 'tenant') return { where: `o.tenant_id=$${start}`, params: [scope.tenantId] };
  if (scope.kind === 'business') return { where: `o.business_id=$${start}${scope.businessVersion ? ` AND o.business_version=$${start + 1}` : ''}`, params: scope.businessVersion ? [scope.businessId, scope.businessVersion] : [scope.businessId] };
  return { where: 'true', params: [] };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value == null ? fallback : value as T;
}

function iso(value: Date | string | null | undefined): string {
  if (value == null) return new Date(0).toISOString();
  const result = value instanceof Date ? value : new Date(value);
  return Number.isNaN(result.getTime()) ? new Date(0).toISOString() : result.toISOString();
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

function safeCode(value: unknown): string {
  if (typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)) return value;
  return 'MAINTENANCE_ITEM_FAILED';
}

function capText(value: string): string { return value.slice(0, MAX_EVIDENCE_TEXT); }

export function createMaintenanceService(options: MaintenanceServiceOptions) {
  const now = options.now ?? (() => new Date());
  const ownerBootId = options.ownerBootId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerBootId)) {
    throw new Error('MAINTENANCE_OWNER_BOOT_ID_INVALID');
  }
  const callbackCapabilities = options.callbackCapabilities ?? { dispatcherConfigured: false, authResolverConfigured: false };
  if (options.trustedHostControllerIdentity
    && (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(options.trustedHostControllerIdentity)
      || options.runnerRuntimeIdentity !== options.trustedHostControllerIdentity)) {
    throw new Error('MAINTENANCE_HOST_CONTROLLER_IDENTITY_INVALID');
  }
  const rolloutService = createReplicaRolloutService({ db: options.db, audit: options.audit,
    observationAdapter: options.rolloutObservationAdapter,
    executionAdapter: options.rolloutExecutionAdapter,
    executorRuntimeIdentity: options.runnerRuntimeIdentity,
    trustedHostControllerIdentity: options.trustedHostControllerIdentity,
    backupSnapshotWriteGate: options.backupSnapshotWriteGate, now });

  async function audit(client: PoolClient, actor: { actor: string; actorRole?: string; actorIssuer?: string; actorSub?: string }, action: string, resource: string, severity: 'info' | 'success' | 'warning' | 'error' = 'info') {
    await options.audit.record({ tenantId: null, actor: actor.actor, actorRole: actor.actorRole, actorIssuer: actor.actorIssuer, actorSub: actor.actorSub, action, resource, severity }, client);
  }

  async function controlSnapshot(scope: MaintenanceScope) {
    return options.db.tx((client) => lockRuntimeControls(client, scope));
  }

  async function controlObservations(scope: MaintenanceScope) {
    const key = scopeKey(scope);
    const businessIds = scope.kind === 'business'
      ? [scope.businessId]
      : scope.kind === 'tenant'
        ? (await options.db.query<{ business_id: string }>(`SELECT DISTINCT o.business_id FROM operations o WHERE o.tenant_id=$1`, [scope.tenantId])).rows.map((row) => row.business_id)
        : (await options.db.query<{ business_id: string }>('SELECT DISTINCT business_id FROM worker_instances')).rows.map((row) => row.business_id);
    const fresh = businessIds.length
      ? await options.db.query<PlainRow>(
        `SELECT instance_id,business_id,state,active_leases,last_seen_at,control_revision,control_state
           FROM worker_instances WHERE business_id=ANY($1) AND last_seen_at>now()-($2 * interval '1 millisecond')`,
        [businessIds, CONTROL_ACK_FRESH_MS],
      )
      : { rows: [], rowCount: 0 } as unknown as { rows: PlainRow[]; rowCount: number };
    const snapshot = await controlSnapshot(scope);
    const expectedAcks = fresh.rows.filter((worker) => worker.state !== 'OFFLINE').length;
    const target = snapshot.states.find((entry) => entry.scopeKind === key.scopeKind && entry.scopeId === key.scopeId);
    const observedResult = target && businessIds.length
      ? await options.db.query<{ count: number }>(
        `SELECT count(DISTINCT w.instance_id)::int AS count
           FROM worker_instances w
           JOIN worker_control_scope_acks a ON a.business_id=w.business_id AND a.instance_id=w.instance_id
          WHERE w.business_id=ANY($1) AND w.state<>'OFFLINE'
            AND w.last_seen_at>now()-($2 * interval '1 millisecond')
            AND a.scope_kind=$3 AND a.scope_id=$4 AND a.control_revision >= $5
            AND a.control_state=$6 AND a.observed_at>now()-($2 * interval '1 millisecond')`,
        [businessIds, CONTROL_ACK_FRESH_MS, key.scopeKind, key.scopeId, target.revision, target.state],
      )
      : { rows: [{ count: 0 }] } as unknown as { rows: Array<{ count: number }> };
    const observedAcks = Number(observedResult.rows[0]?.count ?? 0);
    const activeLeases = await options.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tasks t JOIN operations o ON o.id=t.operation_id
        WHERE t.state='RUNNING' AND ${scopeSql(scope).where}`,
      scopeSql(scope).params,
    );
    return { key, snapshot, workers: fresh.rows, activeLeases: Number(activeLeases.rows[0]?.count ?? 0), freshWorkers: expectedAcks, expectedAcks, observedAcks };
  }

  async function observeServiceInventory(tenantId?: string): Promise<ServiceInventory> {
    if (tenantId) {
      const tenant = await options.db.query('SELECT 1 FROM tenants WHERE id=$1', [tenantId]);
      if (!tenant.rowCount) throw notFound('tenant not found');
    }
    const params = tenantId ? [tenantId] : [];
    const where = tenantId ? 'WHERE EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id=$1 AND o.business_id=w.business_id)' : '';
    const result = await options.db.query<PlainRow>(
      `SELECT w.business_id,w.instance_id,w.business_version,w.state,w.capacity,w.last_seen_at,w.control_revision,w.control_state,
              (SELECT count(*)::int FROM tasks t JOIN operations o ON o.id=t.operation_id
                WHERE t.leased_by=w.instance_id AND o.business_id=w.business_id AND t.state='RUNNING') AS unresolved_active_work
         FROM worker_instances w ${where} ORDER BY w.business_id,w.instance_id`, params,
    );
    const sampledAt = now().toISOString();
    const byBusiness = new Map<string, PlainRow[]>();
    for (const row of result.rows) byBusiness.set(row.business_id, [...(byBusiness.get(row.business_id) ?? []), row]);
    const services: ServiceInventory['services'] = [];
    for (const [businessId, workers] of byBusiness) {
      const control = await controlSnapshot({ kind: 'business', businessId });
      services.push({
        serviceId: `worker:${businessId}`,
        kind: 'worker',
        dependencies: [
          { dependencyId: 'postgres', kind: 'postgres', state: 'HEALTHY', observedAt: sampledAt, detailCode: null },
          { dependencyId: 'redis', kind: 'redis', state: options.getQueue ? 'UNKNOWN' : 'UNAVAILABLE', observedAt: null, detailCode: options.getQueue ? null : 'QUEUE_OBSERVER_UNAVAILABLE' },
        ],
        replicas: workers.map((worker) => {
          const lastSeenAt = iso(worker.last_seen_at);
          const fresh = now().getTime() - new Date(lastSeenAt).getTime() <= CONTROL_ACK_FRESH_MS;
          const online = worker.state !== 'OFFLINE' && fresh;
          return {
            serviceId: `worker:${businessId}`, replicaId: worker.instance_id, role: 'worker' as const,
            businessId, businessVersion: worker.business_version, desiredRevision: worker.business_version,
            observedRevision: worker.business_version, state: !fresh ? 'OFFLINE' as const : worker.state === 'DRAINING' ? 'DRAINING' as const : online ? 'READY' as const : 'UNKNOWN' as const,
            lastSeenAt, activeWork: Number(worker.unresolved_active_work), controlRevision: Number(worker.control_revision), controlState: worker.control_state,
          };
        }),
      });
      // Empty businesses have no worker replica and are omitted rather than
      // inventing an online instance from process configuration.
      void control;
    }
    return { sampledAt, source: ['postgres', 'runtime-heartbeat'], freshness: result.rows.length ? 'FRESH' : 'STALE', services };
  }

  async function observeQueueInventory(tenantId?: string): Promise<QueueInventory> {
    if (tenantId && !(await options.db.query('SELECT 1 FROM tenants WHERE id=$1', [tenantId])).rowCount) throw notFound('tenant not found');
    const params: unknown[] = tenantId ? [tenantId] : [];
    const tenantFilter = tenantId ? 'WHERE EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id=$1 AND o.business_id=bv.business_id AND o.business_version=bv.version)' : '';
    const businessVersions = await options.db.query<PlainRow>(
      `SELECT bv.business_id,bv.version,COALESCE(bv.queue,'du-business-'||bv.business_id||'-'||bv.version) AS queue_name
         FROM business_versions bv ${tenantFilter} ORDER BY bv.business_id,bv.version`, params,
    );
    const queues: QueueInventory['queues'] = [];
    for (const version of businessVersions.rows) {
      const where = `o.business_id=$1 AND o.business_version=$2${tenantId ? ' AND o.tenant_id=$3' : ''}`;
      const counts = await options.db.query<PlainRow>(
        `SELECT count(*) FILTER (WHERE t.state IN ('READY','QUEUED') AND (t.due_at IS NULL OR t.due_at<=now()))::int AS waiting,
                count(*) FILTER (WHERE t.state IN ('READY','QUEUED') AND t.due_at>now())::int AS delayed,
                count(*) FILTER (WHERE t.state='RUNNING')::int AS active,
                count(*) FILTER (WHERE t.state='FAILED')::int AS failed,
                extract(epoch FROM (now()-min(t.created_at) FILTER (WHERE t.state IN ('READY','QUEUED') AND (t.due_at IS NULL OR t.due_at<=now()))))*1000 AS oldest_age
           FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE ${where}`,
        tenantId ? [version.business_id, version.version, tenantId] : [version.business_id, version.version],
      );
      const scope: MaintenanceScope = tenantId ? { kind: 'tenant', tenantId } : { kind: 'business', businessId: version.business_id, businessVersion: version.version };
      const observation = await controlObservations(scope);
      const workerRows = observation.workers;
      queues.push({
        queueName: version.queue_name, businessId: version.business_id, businessVersion: version.version,
        counts: { waiting: Number(counts.rows[0]?.waiting ?? 0), delayed: Number(counts.rows[0]?.delayed ?? 0), active: Number(counts.rows[0]?.active ?? 0), failed: Number(counts.rows[0]?.failed ?? 0) },
        oldestRunnableAgeMs: counts.rows[0]?.oldest_age == null ? null : Math.max(0, Math.trunc(Number(counts.rows[0]!.oldest_age))),
        admission: { state: observation.snapshot.state, revision: observation.snapshot.revision, activeLeases: observation.activeLeases, freshHeartbeats: observation.freshWorkers, observedAcks: observation.observedAcks, expectedAcks: observation.expectedAcks },
        workerCompatibility: {
          compatibleOnline: workerRows.filter((worker) => worker.business_version === version.version && worker.state === 'ONLINE').length,
          compatibleDraining: workerRows.filter((worker) => worker.business_version === version.version && worker.state === 'DRAINING').length,
          incompatible: workerRows.filter((worker) => worker.business_version !== version.version && worker.state !== 'OFFLINE').length,
          offline: workerRows.filter((worker) => worker.state === 'OFFLINE' || now().getTime() - new Date(worker.last_seen_at).getTime() > CONTROL_ACK_FRESH_MS).length,
        },
      });
    }
    return { sampledAt: now().toISOString(), source: ['postgres', 'runtime-heartbeat', ...(options.getQueue ? ['redis' as const] : [])], freshness: queues.length ? 'FRESH' : 'STALE', queues };
  }

  async function createQueueActionPreview(actor: { actor: string }, raw: QueueActionPreviewRequest): Promise<QueueActionPreview> {
    const request = QueueActionPreviewRequestSchema.parse(raw);
    const observed = await controlObservations(request.scope);
    const delivery = request.action === 'retry' && request.deliveryId
      ? await options.db.query<PlainRow>(
        `SELECT d.delivery_id,d.status,d.attempts,d.max_attempts,o.tenant_id,o.business_id,o.business_version
           FROM webhook_deliveries d JOIN operations o ON o.id=d.operation_id AND o.tenant_id=d.tenant_id
          WHERE d.delivery_id=$1`, [request.deliveryId],
      ) : null;
    const candidate = delivery?.rows[0];
    const inScope = candidate && (request.scope.kind === 'platform'
      || (request.scope.kind === 'tenant' && candidate.tenant_id === request.scope.tenantId)
      || (request.scope.kind === 'business' && candidate.business_id === request.scope.businessId && (!request.scope.businessVersion || candidate.business_version === request.scope.businessVersion)));
    const eligibleDeliveries = request.action === 'retry' && inScope && candidate?.status === 'FAILED' ? 1 : 0;
    const skippedDeliveries = request.action === 'retry' && inScope && candidate?.status !== 'UNKNOWN' && candidate?.status !== 'PENDING' && candidate?.status !== 'DISPATCHING' && candidate?.status !== 'FAILED' ? 1 : 0;
    const unknownDeliveries = request.action === 'retry' && inScope && candidate?.status === 'UNKNOWN' ? 1 : 0;
    const previewId = randomUUID();
    const expiresAt = new Date(now().getTime() + PREVIEW_TTL_MS).toISOString();
    const warnings: string[] = [];
    if (request.action === 'drain' && observed.expectedAcks > observed.observedAcks) warnings.push('WORKER_ACKS_PENDING');
    if (request.action === 'retry' && !eligibleDeliveries) warnings.push(unknownDeliveries ? 'DELIVERY_OUTCOME_UNKNOWN' : 'NO_ELIGIBLE_FAILED_DELIVERY');
    const body = {
      previewId, action: request.action, queueName: request.queueName, scope: request.scope,
      controlRevision: observed.snapshot.revision, expiresAt, activeLeases: observed.activeLeases,
      freshWorkers: observed.freshWorkers, expectedAcks: observed.expectedAcks, observedAcks: observed.observedAcks,
      eligibleDeliveries, skippedDeliveries, unknownDeliveries, warnings,
    } satisfies QueueActionPreview;
    await options.db.tx(async (client) => {
      const key = scopeKey(request.scope);
      await client.query(
        `INSERT INTO maintenance_previews(preview_id,kind,scope_kind,scope_id,request,expected_version,retention_revision,candidates,created_at,expires_at,created_by)
         VALUES ($1,'queue_action',$2,$3,$4,$5,NULL,$6,now(),$7,$8)`,
        [previewId, key.scopeKind, key.scopeId, JSON.stringify({ ...request, actor: actor.actor }), digest({ request, controlRevision: observed.snapshot.revision, delivery: candidate ?? null }),
          JSON.stringify([{ itemId: request.deliveryId ?? request.queueName, itemType: 'delivery', eligibility: eligibleDeliveries ? 'ELIGIBLE' : unknownDeliveries ? 'UNKNOWN' : 'SKIPPED', reasonCode: warnings[0] ?? null, data: { attempts: candidate?.attempts ?? null, controlRevision: observed.snapshot.revision } }]), expiresAt, actor.actor],
      );
      await audit(client, actor, 'maintenance.queue_action.preview', `queue:${request.queueName}`);
    });
    return body;
  }

  async function executeQueueAction(actor: { actor: string; actorRole?: string; actorIssuer?: string; actorSub?: string }, raw: unknown): Promise<QueueActionJob> {
    const request = ConfirmQueueActionSchema.parse(raw);
    const found = await options.db.query<PlainRow>('SELECT * FROM maintenance_previews WHERE preview_id=$1 AND kind=\'queue_action\'', [request.previewId]);
    const preview = found.rows[0];
    if (!preview) throw notFound('queue action preview not found');
    const payload = parseJson<QueueActionPreviewRequest & { actor: string }>(preview.request, {} as any);
    const existing = await options.db.query<PlainRow>('SELECT * FROM queue_action_jobs WHERE idempotency_key=$1', [request.idempotencyKey]);
    if (existing.rowCount) {
      if (existing.rows[0]!.request_hash !== digest({ previewId: request.previewId, expectedRevision: request.expectedRevision, action: payload.action, queueName: payload.queueName, scope: payload.scope })) throw conflict('IDEMPOTENCY_CONFLICT', 'queue action idempotency key was reused');
      return mapQueueJob(existing.rows[0]!);
    }
    if (new Date(preview.expires_at).getTime() <= now().getTime()) throw conflict('PREVIEW_EXPIRED', 'queue action preview expired');
    const snapshot = await controlSnapshot(payload.scope);
    const previewCandidate = parseJson<Candidate[]>(preview.candidates, [])[0];
    const expectedSnapshot = Number(previewCandidate?.data?.controlRevision ?? request.expectedRevision);
    if (snapshot.revision !== request.expectedRevision || request.expectedRevision !== expectedSnapshot) throw conflict('STATE_CONFLICT', 'runtime control changed; refresh preview before confirming');
    const requestHash = digest({ previewId: request.previewId, expectedRevision: request.expectedRevision, action: payload.action, queueName: payload.queueName, scope: payload.scope });
    const jobId = randomUUID();
    const row = await options.db.tx(async (client) => {
      const locked = await client.query<PlainRow>('SELECT * FROM maintenance_previews WHERE preview_id=$1 FOR UPDATE', [request.previewId]);
      if (!locked.rowCount || locked.rows[0]!.state !== 'PREVIEWED' || new Date(locked.rows[0]!.expires_at).getTime() <= now().getTime()) throw conflict('PREVIEW_CONSUMED', 'queue action preview is no longer available');
      const current = await lockRuntimeControls(client, payload.scope);
      if (payload.action !== 'retry' && current.revision !== request.expectedRevision) throw conflict('STATE_CONFLICT', 'runtime control changed; refresh preview before confirming');
      let revision = current.revision;
      if (payload.action === 'pause' || payload.action === 'drain' || payload.action === 'resume') {
        const target = scopeKey(payload.scope);
        const nextState = payload.action === 'pause' ? 'PAUSED' : payload.action === 'drain' ? 'DRAINING' : 'OPEN';
        const changed = await client.query<{ revision: number | string }>(
          `UPDATE runtime_control_scopes SET desired_state=$3,revision=nextval('runtime_control_revision_seq'),reason=$4,actor=$5,updated_at=now()
            WHERE scope_kind=$1 AND scope_id=$2 AND revision=(SELECT revision FROM runtime_control_scopes WHERE scope_kind=$1 AND scope_id=$2)
            RETURNING revision`, [target.scopeKind,target.scopeId,nextState,request.reason,actor.actor],
        );
        if (!changed.rowCount) throw conflict('STATE_CONFLICT', 'runtime control changed while applying action');
        revision = Number(changed.rows[0]!.revision);
      }
      const scopes = payload.scope;
      const freshCount = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM worker_instances WHERE state<>'OFFLINE' AND last_seen_at>now()-($1 * interval '1 millisecond')
           AND ($2='platform' OR ($2='business' AND business_id=$3) OR ($2='tenant' AND EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id=$3 AND o.business_id=worker_instances.business_id)))`,
        [CONTROL_ACK_FRESH_MS, scopeKey(scopes).scopeKind, scopeKey(scopes).scopeId],
      );
      const activeCount = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM tasks t JOIN operations o ON o.id=t.operation_id
          WHERE t.state='RUNNING'
            AND ($1='platform' OR ($1='business' AND o.business_id=$2) OR ($1='tenant' AND o.tenant_id=$2))`,
        [scopeKey(scopes).scopeKind, scopeKey(scopes).scopeId],
      );
      const targetScope = scopeKey(scopes);
      const desiredControlState = payload.action === 'pause' ? 'PAUSED' : payload.action === 'drain' ? 'DRAINING' : 'OPEN';
      const ackCount = await client.query<{ count: number }>(
        `SELECT count(DISTINCT w.instance_id)::int AS count
           FROM worker_instances w
           JOIN worker_control_scope_acks a ON a.business_id=w.business_id AND a.instance_id=w.instance_id
          WHERE w.state<>'OFFLINE' AND w.last_seen_at>now()-($1 * interval '1 millisecond')
            AND a.observed_at>now()-($1 * interval '1 millisecond')
            AND a.scope_kind=$2 AND a.scope_id=$3 AND a.control_revision >= $4 AND a.control_state=$5
            AND ($2='platform' OR ($2='business' AND w.business_id=$3) OR ($2='tenant' AND EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id=$3 AND o.business_id=w.business_id)))`,
        [CONTROL_ACK_FRESH_MS, targetScope.scopeKind, targetScope.scopeId, revision, desiredControlState],
      );
      const candidate = parseJson<Candidate[]>(locked.rows[0]!.candidates, [])[0];
      const eligible = payload.action === 'retry' && candidate?.eligibility === 'ELIGIBLE' ? 1 : 0;
      const skipped = payload.action === 'retry' && candidate?.eligibility === 'SKIPPED' ? 1 : 0;
      const unknown = payload.action === 'retry' && candidate?.eligibility === 'UNKNOWN' ? 1 : 0;
      const controlAction = payload.action === 'pause' || payload.action === 'drain' || payload.action === 'resume';
      const needsDrain = payload.action === 'drain' && Number(activeCount.rows[0]?.count ?? 0) > 0;
      const needsAck = controlAction && Number(ackCount.rows[0]?.count ?? 0) < Number(freshCount.rows[0]?.count ?? 0);
      const state = controlAction && (needsDrain || needsAck) ? 'RUNNING' : payload.action === 'retry' ? 'QUEUED' : 'SUCCEEDED';
      const inserted = await client.query<PlainRow>(
        `INSERT INTO queue_action_jobs(job_id,preview_id,idempotency_key,request_hash,action,queue_name,scope,state,control_revision,active_leases,fresh_workers,expected_acks,observed_acks,eligible_deliveries,skipped_deliveries,unknown_deliveries,reason,actor,created_at,updated_at,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,now(),now(),CASE WHEN $8 IN ('SUCCEEDED','PARTIAL') THEN now() ELSE NULL END) RETURNING *`,
        [jobId,request.previewId,request.idempotencyKey,requestHash,payload.action,payload.queueName,JSON.stringify(payload.scope),state,revision,
          Number(activeCount.rows[0]?.count ?? 0),Number(freshCount.rows[0]?.count ?? 0),Number(ackCount.rows[0]?.count ?? 0),eligible,skipped,unknown,request.reason,actor.actor],
      );
      await client.query(`UPDATE maintenance_previews SET state='CONSUMED',job_id=$2 WHERE preview_id=$1`, [request.previewId,jobId]);
      await audit(client, actor, `maintenance.queue_action.${payload.action}`, `queue:${payload.queueName}`);
      return inserted.rows[0]!;
    });
    let result = mapQueueJob(row);
    if (payload.action === 'retry' && result.state === 'QUEUED') result = await runQueueRetry(jobId, payload, actor);
    return result;
  }

  function mapQueueJob(row: PlainRow): QueueActionJob {
    return {
      jobId: row.job_id, action: row.action as QueueAction, queueName: row.queue_name,
      scope: parseJson<MaintenanceScope>(row.scope, { kind: 'platform' }), state: row.state,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), controlRevision: Number(row.control_revision),
      activeLeases: Number(row.active_leases), freshWorkers: Number(row.fresh_workers), expectedAcks: Number(row.expected_acks),
      observedAcks: Number(row.observed_acks), eligibleDeliveries: Number(row.eligible_deliveries),
      skippedDeliveries: Number(row.skipped_deliveries), unknownDeliveries: Number(row.unknown_deliveries), lastErrorCode: row.last_error_code,
    };
  }

  async function runQueueRetry(jobId: string, payload: QueueActionPreviewRequest, actor: { actor: string; actorRole?: string }): Promise<QueueActionJob> {
    try {
      const outcome = await options.db.tx(async (client) => {
        const job = await client.query<PlainRow>('SELECT * FROM queue_action_jobs WHERE job_id=$1 FOR UPDATE', [jobId]);
        if (!job.rowCount) throw notFound('queue action job not found');
        if (job.rows[0]!.state !== 'QUEUED') return job.rows[0]!;
        const preview = await client.query<PlainRow>('SELECT candidates FROM maintenance_previews WHERE preview_id=$1', [job.rows[0]!.preview_id]);
        const data = parseJson<Candidate[]>(preview.rows[0]?.candidates, [])[0];
        const attempts = Number(data?.data?.attempts);
        const delivery = payload.deliveryId;
        if (!delivery || data?.itemId !== delivery || data.eligibility !== 'ELIGIBLE' || !Number.isInteger(attempts)) throw conflict('STATE_CONFLICT', 'preview did not pin a retryable delivery attempt');
        const query = await client.query<{ operation_id: string; tenant_id: string; business_id: string | null; business_version: string | null; attempts: number; status: string }>(
          `SELECT d.operation_id,d.tenant_id,d.attempts,d.status,o.business_id,o.business_version
             FROM webhook_deliveries d JOIN operations o ON o.id=d.operation_id WHERE d.delivery_id=$1`, [delivery],
        );
        if (!query.rowCount) throw notFound('callback delivery not found');
        const row = query.rows[0]!;
        const inScope = payload.scope.kind === 'platform'
          || (payload.scope.kind === 'tenant' && row.tenant_id === payload.scope.tenantId)
          || (payload.scope.kind === 'business' && row.business_id === payload.scope.businessId
            && (!payload.scope.businessVersion || row.business_version === payload.scope.businessVersion));
        if (row.status !== 'FAILED' || row.attempts !== attempts || !inScope) throw conflict('STATE_CONFLICT', 'delivery is no longer the failed attempt shown in the preview');
        await retryAdminDelivery(client, { operationId: row.operation_id, deliveryId: delivery, tenantId: row.tenant_id, expectedAttempts: attempts }, callbackCapabilities);
        const updated = await client.query<PlainRow>(
          `UPDATE queue_action_jobs SET state='SUCCEEDED',eligible_deliveries=1,updated_at=now(),completed_at=now() WHERE job_id=$1 RETURNING *`, [jobId],
        );
        await audit(client, actor, 'maintenance.queue_action.retry', `delivery:${delivery}`, 'success');
        return updated.rows[0]!;
      });
      return mapQueueJob(outcome);
    } catch (error) {
      const code = safeCode((error as { code?: unknown })?.code) ?? 'DELIVERY_RETRY_BLOCKED';
      const failed = await options.db.tx(async (client) => {
        const result = await client.query<PlainRow>(
          `UPDATE queue_action_jobs SET state='FAILED',last_error_code=$2,updated_at=now(),completed_at=now()
            WHERE job_id=$1 AND state='QUEUED' RETURNING *`, [jobId, code],
        );
        const current = result.rowCount ? result.rows[0] : (await client.query<PlainRow>('SELECT * FROM queue_action_jobs WHERE job_id=$1', [jobId])).rows[0];
        if (!current) throw notFound('queue action job not found');
        await audit(client, actor, 'maintenance.queue_action.retry_failed', `queue-action-job:${jobId}`, 'warning');
        return current;
      });
      return mapQueueJob(failed);
    }
  }

  async function getQueueActionJob(jobId: string): Promise<QueueActionJob> {
    const result = await options.db.query<PlainRow>('SELECT * FROM queue_action_jobs WHERE job_id=$1', [jobId]);
    if (!result.rowCount) throw notFound('queue action job not found');
    const row = result.rows[0]!;
    if (['pause', 'drain', 'resume'].includes(row.action) && row.state === 'RUNNING') {
      const scope = parseJson<MaintenanceScope>(row.scope, { kind: 'platform' });
      const observation = await controlObservations(scope);
      const controlAcked = observation.observedAcks >= observation.expectedAcks;
      const complete = controlAcked && (row.action !== 'drain' || observation.activeLeases === 0);
      const updated = await options.db.query<PlainRow>(
        `UPDATE queue_action_jobs SET state=CASE WHEN $2 THEN 'SUCCEEDED' ELSE 'RUNNING' END,
          active_leases=$3,fresh_workers=$4,expected_acks=$4,observed_acks=$5,updated_at=now(),completed_at=CASE WHEN $2 THEN now() ELSE NULL END
         WHERE job_id=$1 AND state='RUNNING' RETURNING *`,
        [jobId,complete,observation.activeLeases,observation.expectedAcks,observation.observedAcks],
      );
      return mapQueueJob(updated.rows[0] ?? row);
    }
    return mapQueueJob(row);
  }

  async function enumerateMaintenanceCandidates(request: MaintenancePreviewRequest, retention: RetentionPolicySnapshot | null): Promise<Candidate[]> {
    const { scope, kind, filters } = request;
    const candidates: Candidate[] = [];
    const addArtifacts = async (query: string, params: unknown[], mode: 'orphan' | 'retention') => {
      const found = await options.db.query<PlainRow>(query, params);
      candidates.push(...found.rows.map((row) => ({ itemId: row.id, itemType: 'artifact' as const,
        eligibility: row.safe_to_delete ? 'ELIGIBLE' as const : 'SKIPPED' as const,
        reasonCode: row.safe_to_delete ? null : String(row.reason_code ?? 'ARTIFACT_REFERENCED'),
        estimatedBytes: row.size_bytes == null ? null : Math.max(0, Number(row.size_bytes)), data: { mode, state: row.state, storageGenerationId: row.storage_generation_id ?? null } })));
    };
    const max = filters.maxItems;
    const artifactIds = filters.artifactIds;
    if (kind === 'cache_cleanup' || kind === 'orphan_reconcile' || kind === 'retention_cleanup') {
      if (kind === 'retention_cleanup' && !retention) throw unavailable('effective retention policy is unavailable');
      const cutoff = filters.olderThan ?? new Date(now().getTime() - (kind === 'cache_cleanup' ? retention!.cacheTtlHours * 3600_000 : kind === 'retention_cleanup' ? retention!.outputRetentionDays * 86400_000 : 0)).toISOString();
      const purpose = kind === 'cache_cleanup' ? `a.purpose='cache' AND a.operation_id IS NULL AND a.task_id IS NULL` : kind === 'retention_cleanup' ? `a.purpose IN ('output','intermediate') AND o.state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')` : `a.state='STAGING' AND a.operation_id IS NULL AND a.task_id IS NULL AND (a.expires_at IS NULL OR a.expires_at<=now())`;
      if (scope.kind === 'business' && kind !== 'retention_cleanup') return [];
      const params: unknown[] = kind === 'retention_cleanup' ? [cutoff, ...scopeSql(scope, 2).params, max, artifactIds ?? null] : [scope.kind === 'tenant' ? scope.tenantId : null, cutoff, max, artifactIds ?? null];
      const baseTimeIndex = kind === 'retention_cleanup' ? 1 : 2;
      const limitIndex = kind === 'retention_cleanup' ? 2 + scopeSql(scope, 2).params.length : 3;
      const idsIndex = limitIndex + 1;
      const joins = 'LEFT JOIN operations o ON o.id=a.operation_id';
      const ownerScope = kind === 'retention_cleanup' ? '' : `AND ($1::uuid IS NULL OR a.tenant_id=$1)`;
      const validState = kind === 'orphan_reconcile' ? `a.state='STAGING'` : `a.state='READY'`;
      const where = `${validState} AND ${purpose} AND a.created_at <= $${baseTimeIndex}::timestamptz ${kind === 'retention_cleanup' ? `AND ${scopeSql(scope, 2).where}` : ownerScope}
        AND ($${idsIndex}::uuid[] IS NULL OR a.id=ANY($${idsIndex}::uuid[]))`;
      await addArtifacts(
        `SELECT a.id,a.state,a.size_bytes,a.storage_generation_id,
                CASE WHEN a.storage_version_id IS NULL OR a.storage_version_id='null' THEN false
                     WHEN a.multipart_upload_id IS NOT NULL THEN false
                     WHEN EXISTS (SELECT 1 FROM operations x WHERE COALESCE(x.submit_artifacts,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('artifactId',a.id::text))) THEN false
                     WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.result_ref=a.id::text) OR EXISTS (SELECT 1 FROM step_checkpoints sc WHERE sc.output_ref=a.id::text) THEN false
                     WHEN kind_hint.retention AND (o.result_ref IS NOT NULL OR COALESCE(o.cancel_requested,false)
                       OR EXISTS (SELECT 1 FROM tasks t WHERE t.operation_id=o.id AND t.state IN ('READY','QUEUED','RUNNING','RETRY_PENDING','WAITING_INPUT','WAITING_CHILDREN'))
                       OR EXISTS (SELECT 1 FROM human_waits w WHERE w.operation_id=o.id AND w.status='OPEN')) THEN false
                     ELSE true END AS safe_to_delete,
                CASE WHEN a.storage_version_id IS NULL OR a.storage_version_id='null' THEN 'IMMUTABLE_STORAGE_PIN_MISSING'
                     WHEN a.multipart_upload_id IS NOT NULL THEN 'MULTIPART_UPLOAD_ACTIVE'
                     WHEN EXISTS (SELECT 1 FROM operations x WHERE COALESCE(x.submit_artifacts,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('artifactId',a.id::text))) THEN 'ARTIFACT_REFERENCED'
                     WHEN EXISTS (SELECT 1 FROM tasks t WHERE t.result_ref=a.id::text) OR EXISTS (SELECT 1 FROM step_checkpoints sc WHERE sc.output_ref=a.id::text) THEN 'ARTIFACT_REFERENCED'
                     WHEN kind_hint.retention AND (o.result_ref IS NOT NULL OR COALESCE(o.cancel_requested,false)
                       OR EXISTS (SELECT 1 FROM tasks t WHERE t.operation_id=o.id AND t.state IN ('READY','QUEUED','RUNNING','RETRY_PENDING','WAITING_INPUT','WAITING_CHILDREN'))
                       OR EXISTS (SELECT 1 FROM human_waits w WHERE w.operation_id=o.id AND w.status='OPEN')) THEN 'ARTIFACT_REFERENCED'
                     ELSE NULL END AS reason_code
           FROM artifacts a ${joins} CROSS JOIN (SELECT ${kind === 'retention_cleanup' ? 'true' : 'false'} AS retention) kind_hint WHERE ${where} ORDER BY a.created_at LIMIT $${limitIndex}`,
        params,
        kind === 'retention_cleanup' ? 'retention' : 'orphan',
      );
    } else if (kind === 'stalled_lease_recovery') {
      const filter = scopeSql(scope, 2);
      const params: unknown[] = [max, ...filter.params, filters.taskIds ?? null];
      const found = await options.db.query<PlainRow>(
        `SELECT t.id,t.attempt,t.max_attempts,t.lease_epoch,o.tenant_id,o.business_id,
                EXISTS(SELECT 1 FROM human_waits w WHERE w.task_id=t.id AND w.status='OPEN') AS has_open_wait
           FROM tasks t JOIN operations o ON o.id=t.operation_id
          WHERE t.state='RUNNING' AND t.lease_expires_at<now()
            AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','CANCEL_REQUESTED')
            AND NOT COALESCE(o.cancel_requested,false)
            AND ${filter.where} AND ($${params.length}::uuid[] IS NULL OR t.id=ANY($${params.length}::uuid[]))
          ORDER BY t.lease_expires_at LIMIT $1`, params,
      );
      candidates.push(...found.rows.map((row) => ({ itemId: row.id, itemType: 'task' as const,
        eligibility: row.has_open_wait ? 'SKIPPED' as const : options.recoverExpiredLease ? 'ELIGIBLE' as const : 'SKIPPED' as const,
        reasonCode: row.has_open_wait ? 'HUMAN_INPUT_PENDING' : options.recoverExpiredLease ? null : 'RUNTIME_RECOVERY_UNAVAILABLE',
        estimatedBytes: null, data: { leaseEpoch: Number(row.lease_epoch), attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts) } })));
    } else if (kind === 'failed_delivery_recovery') {
      const filter = scopeSql(scope, 2);
      const found = await options.db.query<PlainRow>(
        `SELECT d.delivery_id,d.status,d.attempts,d.max_attempts,o.tenant_id,o.business_id
           FROM webhook_deliveries d JOIN operations o ON o.id=d.operation_id
          WHERE d.status IN ('FAILED','UNKNOWN') AND ${filter.where}
            AND ($${2 + filter.params.length}::text[] IS NULL OR d.delivery_id=ANY($${2 + filter.params.length}::text[]))
          ORDER BY d.created_at LIMIT $1`, [max, ...filter.params, filters.deliveryIds ?? null],
      );
      candidates.push(...found.rows.map((row) => ({ itemId: row.delivery_id, itemType: 'delivery' as const,
        eligibility: row.status === 'FAILED' && callbackCapabilities.dispatcherConfigured ? 'ELIGIBLE' as const : row.status === 'UNKNOWN' ? 'UNKNOWN' as const : 'SKIPPED' as const,
        reasonCode: row.status === 'UNKNOWN' ? 'DELIVERY_OUTCOME_UNKNOWN' : row.status !== 'FAILED' ? 'DELIVERY_NOT_FAILED' : callbackCapabilities.dispatcherConfigured ? null : 'DISPATCHER_UNAVAILABLE',
        estimatedBytes: null, data: { attempts: Number(row.attempts), tenantId: row.tenant_id } })));
    } else if (kind === 'backup') {
      const targets = options.listBackupTargetDescriptors
        ? await options.listBackupTargetDescriptors()
        : options.backupAdapter?.trusted ? await options.backupAdapter.listTargets() : [];
      const target = targets.find((entry) => entry.name === filters.backupTarget && entry.allowlisted && entry.immutable && entry.supportedScopes.includes(request.scope.kind));
      candidates.push({ itemId: filters.backupTarget!, itemType: 'backup', eligibility: target ? 'ELIGIBLE' : 'SKIPPED', reasonCode: target ? null : 'BACKUP_TARGET_NOT_ALLOWLISTED', estimatedBytes: null,
        data: target ? { targetPinDigest: target.targetPinDigest, manifestSha256: target.manifestSha256 } : {} });
    } else if (kind === 'restore') {
      const backup = await options.db.query<PlainRow>('SELECT backup_id,state,bundle_ref,bundle_sha256,target_name,manifest FROM maintenance_backup_bundles WHERE backup_id=$1', [filters.backupId]);
      const target = await options.db.query<PlainRow>(`SELECT g.generation_id,g.state,g.backend,g.endpoint,g.bucket,
          active.backend AS active_backend,active.endpoint AS active_endpoint,active.bucket AS active_bucket
        FROM storage_generations g
        LEFT JOIN storage_generation_state s ON s.active_generation_id=g.generation_id
        LEFT JOIN storage_generations active ON active.generation_id=s.active_generation_id
        WHERE g.generation_id=$1 AND s.active_generation_id IS NULL`, [filters.targetGenerationId]);
      const distinctStorage = target.rowCount === 1 && (target.rows[0]!.backend !== target.rows[0]!.active_backend
        || target.rows[0]!.endpoint !== target.rows[0]!.active_endpoint || target.rows[0]!.bucket !== target.rows[0]!.active_bucket);
      const safe = backup.rows[0]?.state === 'READY' && backup.rows[0]?.bundle_sha256 && backup.rows[0]?.bundle_ref && target.rowCount === 1 && target.rows[0]!.state === 'STAGED' && distinctStorage && !!options.backupAdapter;
      candidates.push({ itemId: filters.backupId!, itemType: 'restore-target', eligibility: safe ? 'ELIGIBLE' : 'SKIPPED', reasonCode: safe ? null : 'RESTORE_TARGET_OR_BUNDLE_NOT_ISOLATED', estimatedBytes: null, data: safe ? { targetGenerationId: filters.targetGenerationId } : {} });
    }
    return candidates.slice(0, max);
  }

  async function createMaintenancePreview(actor: { actor: string; actorRole?: string }, raw: unknown): Promise<MaintenancePreview> {
    const request = MaintenancePreviewRequestSchema.parse(raw);
    const retention = ['cache_cleanup', 'retention_cleanup'].includes(request.kind) ? await options.getEffectiveRetentionPolicy() : null;
    const candidates = await enumerateMaintenanceCandidates(request, retention);
    const counts = { candidateCount: candidates.length, eligibleCount: candidates.filter((item) => item.eligibility === 'ELIGIBLE').length, skippedCount: candidates.filter((item) => item.eligibility === 'SKIPPED').length, unknownCount: candidates.filter((item) => item.eligibility === 'UNKNOWN').length };
    const previewId = randomUUID();
    const createdAt = now().toISOString();
    const expiresAt = new Date(now().getTime() + PREVIEW_TTL_MS).toISOString();
    const expectedVersion = digest({ request, retention, candidates });
    const body: MaintenancePreview = {
      previewId, kind: request.kind, scope: request.scope, createdAt, expiresAt, expectedVersion,
      retentionRevision: retention?.revision ?? null, ...counts,
      estimatedBytes: candidates.some((item) => item.estimatedBytes === null) ? null : candidates.reduce((sum, item) => sum + (item.estimatedBytes ?? 0), 0),
      targets: candidates.map(({ itemId, itemType, eligibility, reasonCode, estimatedBytes }) => ({ itemId, itemType, eligibility, reasonCode, estimatedBytes })),
    };
    const key = scopeKey(request.scope);
    await options.db.tx(async (client) => {
      await client.query(
        `INSERT INTO maintenance_previews(preview_id,kind,scope_kind,scope_id,request,expected_version,retention_revision,retention_snapshot,candidates,created_at,expires_at,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [previewId,request.kind,key.scopeKind,key.scopeId,JSON.stringify(request),expectedVersion,retention?.revision ?? null,retention ? JSON.stringify(retention) : null,JSON.stringify(candidates),createdAt,expiresAt,actor.actor],
      );
      await audit(client, actor, `maintenance.${request.kind}.preview`, `maintenance-preview:${previewId}`);
    });
    return body;
  }

  async function startMaintenanceJob(actor: { actor: string; actorRole?: string; actorIssuer?: string; actorSub?: string }, raw: unknown): Promise<MaintenanceJob> {
    const request = StartMaintenanceJobSchema.parse(raw);
    const requestHash = digest({ previewId: request.previewId, expectedVersion: request.expectedVersion });
    const replay = await options.db.query<PlainRow>('SELECT * FROM maintenance_jobs WHERE idempotency_key=$1', [request.idempotencyKey]);
    if (replay.rowCount) {
      if (replay.rows[0]!.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'maintenance idempotency key was reused');
      return getMaintenanceJob(replay.rows[0]!.job_id);
    }
    const previewResult = await options.db.query<PlainRow>("SELECT * FROM maintenance_previews WHERE preview_id=$1 AND kind<>'queue_action'", [request.previewId]);
    const preview = previewResult.rows[0];
    if (!preview) throw notFound('maintenance preview not found');
    const candidates = parseJson<Candidate[]>(preview.candidates, []);
    if (new Date(preview.expires_at).getTime() <= now().getTime() || preview.state !== 'PREVIEWED') throw conflict('PREVIEW_EXPIRED', 'maintenance preview is expired or already consumed');
    if (String(preview.expected_version) !== request.expectedVersion) throw conflict('STATE_CONFLICT', 'maintenance preview changed; refresh before confirming');
    const storedRequest = parseJson<MaintenancePreviewRequest>(preview.request, {} as MaintenancePreviewRequest);
    const retention = parseJson<RetentionPolicySnapshot | null>(preview.retention_snapshot, null);
    if (retention && (await options.getEffectiveRetentionPolicy()).revision !== retention.revision) throw conflict('STATE_CONFLICT', 'retention policy changed; refresh cleanup preview');
    const freshCandidates = await enumerateMaintenanceCandidates(storedRequest, retention);
    if (digest({ request: storedRequest, retention, candidates: freshCandidates }) !== request.expectedVersion) throw conflict('STATE_CONFLICT', 'maintenance candidate set changed; refresh preview before confirming');
    const jobId = randomUUID();
    let job: MaintenanceJob;
    try {
      job = await options.db.tx(async (client) => {
        const sameKey = await client.query<PlainRow>('SELECT * FROM maintenance_jobs WHERE idempotency_key=$1 FOR UPDATE', [request.idempotencyKey]);
        if (sameKey.rowCount) {
          if (sameKey.rows[0]!.request_hash !== requestHash) throw conflict('IDEMPOTENCY_CONFLICT', 'maintenance idempotency key was reused');
          return loadMaintenanceJob(client, sameKey.rows[0]!.job_id);
        }
        const locked = await client.query<PlainRow>('SELECT * FROM maintenance_previews WHERE preview_id=$1 FOR UPDATE', [request.previewId]);
        if (!locked.rowCount || locked.rows[0]!.state !== 'PREVIEWED' || String(locked.rows[0]!.expected_version) !== request.expectedVersion || new Date(locked.rows[0]!.expires_at).getTime() <= now().getTime()) throw conflict('STATE_CONFLICT', 'maintenance preview is no longer current');
        await client.query(
          `INSERT INTO maintenance_jobs(job_id,preview_id,idempotency_key,request_hash,kind,scope_kind,scope_id,state,reason,actor,total_items,config,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9,$10,$11,now(),now())`,
          [jobId,request.previewId,request.idempotencyKey,requestHash,preview.kind,preview.scope_kind,preview.scope_id,request.reason,actor.actor,candidates.length,
            JSON.stringify({ request: parseJson(preview.request, {}), retention: parseJson(preview.retention_snapshot, null) })],
        );
        for (let i = 0; i < candidates.length; i += 1) {
          const candidate = candidates[i]!;
          const status = candidate.eligibility === 'ELIGIBLE' ? 'PENDING' : candidate.eligibility;
          await client.query(
            `INSERT INTO maintenance_job_items(job_id,item_id,item_type,ordinal,status,code,evidence,updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,now())`,
            [jobId,candidate.itemId,candidate.itemType,i,status === 'UNKNOWN' ? 'UNKNOWN' : status === 'SKIPPED' ? 'SKIPPED' : 'PENDING',candidate.reasonCode,JSON.stringify({ estimatedBytes: candidate.estimatedBytes, ...(candidate.data ?? {}) })],
          );
        }
        await client.query(`UPDATE maintenance_previews SET state='CONSUMED',job_id=$2 WHERE preview_id=$1`, [request.previewId,jobId]);
        await audit(client, actor, `maintenance.${preview.kind}.start`, `maintenance-job:${jobId}`);
        return loadMaintenanceJob(client, jobId);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const existing = await options.db.query<PlainRow>('SELECT * FROM maintenance_jobs WHERE idempotency_key=$1', [request.idempotencyKey]);
        if (existing.rowCount && existing.rows[0]!.request_hash === requestHash) job = await options.db.tx((client) => loadMaintenanceJob(client, existing.rows[0]!.job_id));
        else throw conflict('IDEMPOTENCY_CONFLICT', 'maintenance idempotency key was reused');
      } else throw error;
    }
    if (!job!) throw unavailable('maintenance job was not persisted');
    return getMaintenanceJob(job.jobId);
  }

  async function loadMaintenanceJob(client: Pick<PoolClient, 'query'>, jobId: string): Promise<MaintenanceJob> {
    const row = await client.query<PlainRow>('SELECT * FROM maintenance_jobs WHERE job_id=$1', [jobId]);
    if (!row.rowCount) throw notFound('maintenance job not found');
    const items = await client.query<PlainRow>('SELECT * FROM maintenance_job_items WHERE job_id=$1 ORDER BY ordinal', [jobId]);
    const job = row.rows[0]!;
    return {
      jobId: job.job_id, kind: job.kind as MaintenanceKind, state: job.state, scope: scopeFromRow(job.scope_kind, job.scope_id),
      createdAt: iso(job.created_at), updatedAt: iso(job.updated_at), totalItems: Number(job.total_items),
      completedItems: Number(job.completed_items), appliedItems: Number(job.applied_items), skippedItems: Number(job.skipped_items),
      failedItems: Number(job.failed_items), unknownItems: Number(job.unknown_items), lastErrorCode: job.last_error_code,
      items: items.rows.map((item) => ({ itemId: item.item_id, itemType: item.item_type, status: item.status, code: item.code, evidence: parseJson(item.evidence, {}), updatedAt: iso(item.updated_at) } as MaintenanceItemOutcome)),
    };
  }

  function scopeFromRow(kind: string, id: string): MaintenanceScope {
    if (kind === 'tenant') return { kind: 'tenant', tenantId: id };
    if (kind === 'business') return { kind: 'business', businessId: id };
    return { kind: 'platform' };
  }

  async function processCandidate(jobId: string, item: PlainRow, config: PlainRow, actor: { actor: string; actorRole?: string }, execution: MaintenanceExecutionFence): Promise<{ status: 'APPLIED' | 'SKIPPED' | 'FAILED' | 'UNKNOWN'; code: string | null; evidence: Record<string, unknown> }> {
    const kind = String(config.request?.kind ?? '');
    const filters = config.request?.filters ?? {};
    const storedRequest = parseJson<MaintenancePreviewRequest>(config.request, {} as MaintenancePreviewRequest);
    const data = parseJson<Record<string, unknown>>(item.evidence, {});
    if (item.item_type === 'artifact') {
      const result = await options.artifacts.expireForMaintenance(item.item_id, data.mode === 'retention' ? 'retention' : 'orphan');
      return { status: result.status === 'DELETED' ? 'APPLIED' : result.status, code: result.code, evidence: { storageGenerationId: typeof data.storageGenerationId === 'string' ? data.storageGenerationId : null } };
    }
    if (item.item_type === 'task' && kind === 'stalled_lease_recovery') {
      if (!options.recoverExpiredLease) return { status: 'SKIPPED', code: 'RUNTIME_RECOVERY_UNAVAILABLE', evidence: {} };
      return options.recoverExpiredLease(item.item_id, Number(data.leaseEpoch));
    }
    if (item.item_type === 'delivery' && kind === 'failed_delivery_recovery') {
      const delivery = await options.db.query<PlainRow>('SELECT operation_id,tenant_id,attempts FROM webhook_deliveries WHERE delivery_id=$1', [item.item_id]);
      if (!delivery.rowCount) return { status:'SKIPPED', code:'DELIVERY_NOT_FOUND', evidence:{} };
      try {
        await options.db.tx((client) => retryAdminDelivery(client, { operationId: delivery.rows[0]!.operation_id, deliveryId: item.item_id, tenantId: delivery.rows[0]!.tenant_id, expectedAttempts: Number(data.attempts) }, callbackCapabilities));
        return { status:'APPLIED', code:null, evidence:{ attempts: Number(data.attempts) } };
      } catch (error) { return { status:'SKIPPED', code:safeCode((error as any)?.code), evidence:{ attempts: Number(delivery.rows[0]!.attempts) } }; }
    }
    if (item.item_type === 'backup' && kind === 'backup') {
      if (!options.backupAdapter || options.backupAdapter.trusted !== true) return { status:'SKIPPED', code:'BACKUP_ADAPTER_UNAVAILABLE', evidence:{} };
      const targets = await options.backupAdapter.listTargets();
      const target = targets.find((entry) => entry.name === item.item_id && entry.allowlisted && entry.immutable);
      if (!target) return { status:'SKIPPED', code:'BACKUP_TARGET_NOT_ALLOWLISTED', evidence:{} };
      if (target.targetPinDigest !== data.targetPinDigest || target.manifestSha256 !== data.manifestSha256) {
        return { status:'SKIPPED', code:'BACKUP_TARGET_VERSION_CHANGED', evidence:{} };
      }
      const backupId = randomUUID();
      await options.db.query(`INSERT INTO maintenance_backup_bundles(backup_id,target_name,scope,state,created_by) VALUES($1,$2,$3,'CREATING',$4)`, [backupId,target.name,JSON.stringify(storedRequest.scope),actor.actor]);
      try {
        const bundle = await options.backupAdapter.createBundle({ backupId, target, scope: storedRequest.scope, execution });
        if (!bundle.immutable || !bundle.verified || !/^[a-f0-9]{64}$/.test(bundle.sha256) || !Number.isSafeInteger(bundle.byteSize) || bundle.byteSize < 0
          || !sameSet(bundle.credentialVersionRefs,target.credentialVersionRefs) || !sameSet(bundle.encryptionKeyVersionRefs,target.encryptionKeyVersionRefs)) {
          await options.db.query(`UPDATE maintenance_backup_bundles SET state='UNKNOWN',completed_at=now() WHERE backup_id=$1`, [backupId]);
          return { status:'UNKNOWN', code:'BACKUP_INTEGRITY_OR_VERSION_PIN_UNVERIFIED', evidence:{ backupId } };
        }
        await options.db.query(`UPDATE maintenance_backup_bundles SET state='READY',bundle_ref=$2,bundle_sha256=$3,byte_size=$4,manifest=$5,completed_at=now() WHERE backup_id=$1`, [backupId,bundle.bundleRef,bundle.sha256,bundle.byteSize,JSON.stringify({ credentialVersionRefs: bundle.credentialVersionRefs, encryptionKeyVersionRefs: bundle.encryptionKeyVersionRefs, manifest: bundle.manifest })]);
        return { status:'APPLIED', code:null, evidence:{ backupId, sha256:bundle.sha256, byteSize:bundle.byteSize } };
      } catch {
        await options.db.query(`UPDATE maintenance_backup_bundles SET state='UNKNOWN',completed_at=now() WHERE backup_id=$1`, [backupId]).catch(() => undefined);
        return { status:'UNKNOWN', code:'BACKUP_OUTCOME_UNKNOWN', evidence:{ backupId } };
      }
    }
    if (item.item_type === 'restore-target' && kind === 'restore') {
      if (!options.backupAdapter || options.backupAdapter.trusted !== true) return { status:'SKIPPED', code:'BACKUP_ADAPTER_UNAVAILABLE', evidence:{} };
      const backup = await options.db.query<PlainRow>('SELECT state,bundle_ref,bundle_sha256 FROM maintenance_backup_bundles WHERE backup_id=$1', [filters.backupId]);
      if (!backup.rowCount || backup.rows[0]!.state !== 'READY') return { status:'SKIPPED', code:'BACKUP_NOT_READY', evidence:{} };
      try {
        const result = await options.backupAdapter.restoreBundle({ backupId: filters.backupId, bundleRef: backup.rows[0]!.bundle_ref, expectedSha256: backup.rows[0]!.bundle_sha256, targetGenerationId: filters.targetGenerationId, isolated:true, dispatchDisabled:true, providerCallsDisabled:true, execution });
        if (!result.isolated || !result.dispatchDisabled || !result.providerCallsDisabled || !result.checksummed || !result.reconciled
          || result.targetGenerationId !== filters.targetGenerationId || result.cutover !== 'NOT_PERFORMED') {
          return { status:'UNKNOWN', code:'RESTORE_ISOLATION_OR_RECONCILIATION_UNVERIFIED', evidence:{} };
        }
        return { status:'APPLIED', code:null, evidence:{ artifacts:result.counts.artifacts, objects:result.counts.objects,
          keys:result.counts.keys, isolated:true, cutover:result.cutover, runtimeProbe:result.runtimeProbe } };
      } catch { return { status:'UNKNOWN', code:'RESTORE_OUTCOME_UNKNOWN', evidence:{} }; }
    }
    return { status: 'SKIPPED', code: 'MAINTENANCE_ADAPTER_UNAVAILABLE', evidence: {} };
  }

  function sameSet(a: readonly string[], b: readonly string[]): boolean { return [...a].sort().join('\0') === [...b].sort().join('\0'); }

  async function runMaintenanceJob(jobId: string, actor: { actor: string; actorRole?: string }, executorIdentity = options.runnerRuntimeIdentity ?? '', limit = MAX_RUN_ITEMS): Promise<MaintenanceJob> {
    if (!executorIdentity) throw unavailable('durable maintenance runner identity is not configured');
    const bounded = Math.max(1, Math.min(Math.trunc(limit), MAX_RUN_ITEMS));
    const job = await options.db.query<PlainRow>('SELECT * FROM maintenance_jobs WHERE job_id=$1', [jobId]);
    if (!job.rowCount) throw notFound('maintenance job not found');
    const config = parseJson<PlainRow>(job.rows[0]!.config, {} as any);
    const request = parseJson<PlainRow>(config.request, {} as any);
    // An expired RUNNING effect has an ambiguous outcome. Preserve its owner
    // identity as evidence and never claim it again automatically.
    await options.db.tx(async (client) => {
      await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
        tenantId: null, domain: 'maintenance-execution', requestKey: `maintenance-expiry:${jobId}`,
      });
      const expired = await client.query<PlainRow>(
        `UPDATE maintenance_job_items SET status='UNKNOWN',code='ITEM_OWNER_LOST',updated_at=now(),claim_until=NULL
          WHERE job_id=$1 AND status='RUNNING' AND owner_runtime_identity IS NOT NULL AND claim_until<now() RETURNING item_id,item_type`, [jobId],
      );
      for (const item of expired.rows) {
        await audit(client, actor, `maintenance.${String(request.kind)}.item.unknown`, `${item.item_type}:${item.item_id}`, 'warning');
      }
    });
    for (let index = 0; index < bounded; index += 1) {
      const claim = await options.db.tx(async (client) => {
        await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
          tenantId: null, domain: 'maintenance-execution', requestKey: `maintenance-claim:${jobId}`,
        });
        const picked = await client.query<PlainRow>(
          `SELECT * FROM maintenance_job_items WHERE job_id=$1 AND status='PENDING' ORDER BY ordinal LIMIT 1 FOR UPDATE SKIP LOCKED`, [jobId],
        );
        if (!picked.rowCount) return null;
        const executionToken = randomBytes(32).toString('base64url');
        const executionTokenSha256 = createHash('sha256').update(executionToken).digest('hex');
        const claimed = await client.query<PlainRow>(
          `UPDATE maintenance_job_items SET status='RUNNING',attempt=attempt+1,owner_runtime_identity=$3,
              owner_boot_id=$4,backup_execution_token_sha256=$5,
              execution_fence=execution_fence+1,claim_until=now()+interval '15 minutes',updated_at=now()
            WHERE job_id=$1 AND item_id=$2 AND status='PENDING' RETURNING *`,
          [jobId,picked.rows[0]!.item_id,executorIdentity,ownerBootId,executionTokenSha256],
        );
        if (!claimed.rowCount) return null;
        await client.query(`UPDATE maintenance_jobs SET state='RUNNING',started_at=COALESCE(started_at,now()),updated_at=now() WHERE job_id=$1 AND state IN ('QUEUED','RUNNING')`, [jobId]);
        return { item:claimed.rows[0]!, executionToken };
      });
      if (!claim) break;
      const { item, executionToken } = claim;
      const itemFence = Number(item.execution_fence);
      const executionTokenSha256 = createHash('sha256').update(executionToken).digest('hex');
      let heartbeatLost = false;
      const heartbeat = setInterval(() => {
        void options.db.query(
          `UPDATE maintenance_job_items SET claim_until=now()+interval '15 minutes',updated_at=now()
            WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3
              AND owner_boot_id=$4 AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now()`,
          [jobId,item.item_id,executorIdentity,ownerBootId,itemFence,executionTokenSha256],
        ).then((result) => { if (!result.rowCount) heartbeatLost = true; }).catch(() => { heartbeatLost = true; });
      }, 30_000);
      heartbeat.unref?.();
      let result: { status: 'APPLIED' | 'SKIPPED' | 'FAILED' | 'UNKNOWN'; code: string | null; evidence: Record<string, unknown> };
      try {
        result = await processCandidate(jobId,item,config,actor,{
          jobId,itemId:String(item.item_id),ownerRuntimeIdentity:executorIdentity,ownerBootId,
          executionFence:itemFence,executionToken,
        });
      } catch (error) {
        // Adapter exceptions do not prove that a side effect was absent.
        result = { status:'UNKNOWN', code:safeCode((error as any)?.code), evidence:{ outcome:'ambiguous' } };
      } finally { clearInterval(heartbeat); }
      if (heartbeatLost) result = { status:'UNKNOWN', code:'MAINTENANCE_OWNER_FENCE_LOST', evidence:{ outcome:'ambiguous' } };
      await options.db.tx(async (client) => {
        const saved = await client.query(
          `UPDATE maintenance_job_items SET status=$6,code=$7,evidence=$8,claim_until=NULL,
              owner_runtime_identity=CASE WHEN $6='UNKNOWN' THEN owner_runtime_identity ELSE NULL END,
              owner_boot_id=CASE WHEN $6='UNKNOWN' THEN owner_boot_id ELSE NULL END,
              backup_execution_token_sha256=CASE WHEN $6='UNKNOWN' THEN backup_execution_token_sha256 ELSE NULL END,
              updated_at=now()
            WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3
              AND owner_boot_id=$4 AND execution_fence=$5 AND backup_execution_token_sha256=$9`,
          [jobId,item.item_id,executorIdentity,ownerBootId,itemFence,result.status,result.code,
            JSON.stringify(result.evidence),executionTokenSha256],
        );
        if (saved.rowCount) {
          const severity = result.status === 'APPLIED' ? 'success' : result.status === 'FAILED' ? 'error' : result.status === 'UNKNOWN' ? 'warning' : 'info';
          await audit(client, actor, `maintenance.${String(request.kind)}.item.${String(result.status).toLowerCase()}`, `${item.item_type}:${item.item_id}`, severity);
        }
      });
    }
    await options.db.tx(async (client) => {
      const counts = await client.query<{ pending: number; running: number; applied: number; skipped: number; failed: number; unknown: number; total: number }>(
        `SELECT count(*) FILTER(WHERE status='PENDING')::int AS pending,count(*) FILTER(WHERE status='RUNNING')::int AS running,
          count(*) FILTER(WHERE status='APPLIED')::int AS applied,count(*) FILTER(WHERE status='SKIPPED')::int AS skipped,
          count(*) FILTER(WHERE status='FAILED')::int AS failed,count(*) FILTER(WHERE status='UNKNOWN')::int AS unknown,count(*)::int AS total
          FROM maintenance_job_items WHERE job_id=$1`,[jobId],
      );
      const c = counts.rows[0]!;
      const done = Number(c.pending) === 0 && Number(c.running) === 0;
      const state = !done ? (Number(c.running) > 0 ? 'RUNNING' : 'QUEUED') : Number(c.unknown) > 0 ? 'UNKNOWN' : Number(c.failed) || Number(c.skipped) ? Number(c.applied) ? 'PARTIAL' : 'FAILED' : 'SUCCEEDED';
      await client.query(
        `UPDATE maintenance_jobs SET state=$2,total_items=$3,completed_items=$4,applied_items=$5,skipped_items=$6,failed_items=$7,unknown_items=$8,
          last_error_code=CASE WHEN $7>0 THEN 'MAINTENANCE_ITEM_FAILED' WHEN $8>0 THEN 'MAINTENANCE_ITEM_UNKNOWN' ELSE NULL END,
          updated_at=now(),completed_at=CASE WHEN $9 THEN now() ELSE NULL END WHERE job_id=$1`,
        [jobId,state,c.total,Number(c.total)-Number(c.pending)-Number(c.running),c.applied,c.skipped,c.failed,c.unknown,done],
      );
    });
    return options.db.tx((client) => loadMaintenanceJob(client,jobId));
  }

  async function getMaintenanceJob(jobId: string): Promise<MaintenanceJob> {
    const current = await options.db.query<PlainRow>('SELECT state FROM maintenance_jobs WHERE job_id=$1',[jobId]);
    if (!current.rowCount) throw notFound('maintenance job not found');
    return options.db.tx((client) => loadMaintenanceJob(client,jobId));
  }

  async function runQueuedMaintenanceJobs(executorIdentity = options.runnerRuntimeIdentity ?? '', limit = 2): Promise<MaintenanceJob[]> {
    if (!executorIdentity) return [];
    const bounded = Math.max(1, Math.min(10, Math.trunc(limit)));
    const pending = await options.db.query<PlainRow>(
      `SELECT j.job_id,j.actor FROM maintenance_jobs j
        WHERE j.state IN ('QUEUED','RUNNING') AND EXISTS (
          SELECT 1 FROM maintenance_job_items i WHERE i.job_id=j.job_id AND i.status='PENDING'
        ) ORDER BY j.created_at LIMIT $1`, [bounded],
    );
    const results: MaintenanceJob[] = [];
    for (const row of pending.rows) {
      try { results.push(await runMaintenanceJob(row.job_id,{actor:row.actor,actorRole:'platform'},executorIdentity,MAX_RUN_ITEMS)); }
      catch { /* Persisted owner and outcome evidence remain authoritative. */ }
    }
    return results;
  }

  return {
    ...rolloutService,
    getServiceInventory: observeServiceInventory,
    getQueueInventory: observeQueueInventory,
    createQueueActionPreview,
    executeQueueAction,
    getQueueActionJob,
    createMaintenancePreview,
    startMaintenanceJob,
    getMaintenanceJob,
    runMaintenanceJob,
    runQueuedMaintenanceJobs,
    // Storage-generation CRUD is routed through this same owner service so
    // routes never grow a second storage implementation.
    currentStorageGeneration: () => options.storageGenerations?.current() ?? Promise.reject(unavailable('storage generation service is not configured')),
    listStorageGenerations: () => options.storageGenerations?.listGenerations() ?? Promise.reject(unavailable('storage generation service is not configured')),
    stageStorageGeneration: (body: StorageGenerationStageRequest, actor: any) => options.storageGenerations?.stage(body,actor) ?? Promise.reject(unavailable('storage generation service is not configured')),
    testStorageGeneration: (id: string, body: any, actor: any) => options.storageGenerations?.test(id,body,actor) ?? Promise.reject(unavailable('storage generation service is not configured')),
    activateStorageGeneration: (id: string, body: StorageGenerationActionRequest, actor: any) => options.storageGenerations?.activate(id,body,actor) ?? Promise.reject(unavailable('storage generation service is not configured')),
    rollbackStorageGeneration: (id: string, body: StorageGenerationActionRequest, actor: any) => options.storageGenerations?.rollback(id,body,actor) ?? Promise.reject(unavailable('storage generation service is not configured')),
  };
}
