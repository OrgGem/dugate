import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import { HttpError, zodIssuesToProblem } from '../../http/errors';
import {
  ComposeCatalogSchema,
  ComposeJobListQuerySchema,
  ComposeJobPageSchema,
  ComposeJobSchema,
  ComposePerServiceOutcomeSchema,
  ComposePreviewRequestSchema,
  ComposePreviewSchema,
  ComposeRunnerClaimResponseSchema,
  ComposeRunnerCompleteAckSchema,
  ComposeRunnerCompleteRequestSchema,
  ComposeRunnerReconcileRequestSchema,
  ComposeRunnerReconcileAckSchema,
  ComposeRunnerSnapshotAckSchema,
  ComposeRunnerSnapshotRequestSchema,
  ComposeRunnerStartAckSchema,
  ComposeRunnerStartRequestSchema,
  ComposeSubmitJobRequestSchema,
  ComposeRunnerConfigSchema,
  type ComposeCatalog,
  type ComposeCatalogRelease,
  type ComposeJob,
  type ComposeJobListQuery,
  type ComposeJobPage,
  type ComposeJobSubmission,
  type ComposePreview,
  type ComposePreviewRequest,
  type ComposeRunnerClaimResponse,
  type ComposeRunnerCompleteRequest,
  type ComposeRunnerReconcileRequest,
  type ComposeRunnerSnapshotRequest,
  type ComposeRunnerStartRequest,
  type ComposeSafeErrorCode,
  type ComposeSubmitJobRequest,
  type ComposeRunnerConfig,
} from './contracts';

const JOB_COLUMNS = `job_id, preview_id, host_id, project_id, action, release_id, service_id,
  target_release_digest, target_services, reason, actor_label, state, state_version,
  expected_target_revision, target_revision, created_at, started_at, completed_at,
  claim_expires_at, observed_before_digest, start_expected_observed_digest,
  observed_before, observed_after, observed_after_digest, per_service_outcomes, uncertain_reason`;
const JOB_COLUMNS_J = JOB_COLUMNS.split(',').map((column) => `j.${column.trim()}`).join(', ');
const ACTIVE_STATES = ['QUEUED', 'CLAIMED', 'RUNNING', 'UNKNOWN'] as const;
const MAX_CLOCK_FUTURE_MS = 30_000;
const MAX_CLOCK_PAST_MS = 24 * 60 * 60 * 1000;
const RUNNING_JOB_LEASE_MS = 5 * 60 * 1000;
const JOB_PAGE_CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface JobRow extends QueryResultRow {
  job_id: string;
  preview_id: string;
  host_id: string;
  project_id: string;
  action: string;
  release_id: string | null;
  service_id: string | null;
  target_release_digest: string | null;
  target_services: unknown;
  reason: string;
  actor_label: string;
  state: string;
  state_version: number | string;
  expected_target_revision: number | string;
  target_revision: number | string;
  created_at: Date | string;
  cursor_created_at?: string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  claim_expires_at: Date | string | null;
  observed_before_digest: string;
  start_expected_observed_digest: string;
  observed_before: unknown;
  observed_after: unknown;
  observed_after_digest: string | null;
  per_service_outcomes: unknown;
  uncertain_reason: string | null;
  request_hash?: string;
  completion_report_hash?: string | null;
  completion_ack?: unknown;
  reconcile_report_hash?: string | null;
  reconcile_ack?: unknown;
}

interface ProjectRow extends QueryResultRow {
  host_id: string;
  project_id: string;
  display_name: string;
  catalog_revision: string;
  manifest_digest: string;
  sampled_at: Date | string;
  received_at: Date | string;
  observed_digest: string;
  services: unknown;
  releases: unknown;
  observed_services: unknown;
  target_revision: number | string;
  desired_release_id: string | null;
  active_job_id: string | null;
  active_job_state: string | null;
}

interface HostRow extends QueryResultRow {
  host_id: string;
  manifest_digest: string;
  sampled_at: Date | string;
  received_at: Date | string;
}

export interface ComposeOperationsService {
  getCatalog(): Promise<ComposeCatalog>;
  createPreview(actor: ComposeAdminActor, input: ComposePreviewRequest): Promise<ComposePreview>;
  submitJob(actor: ComposeAdminActor, input: ComposeSubmitJobRequest, idempotencyKey: string): Promise<ComposeJobSubmission>;
  listJobs(query: ComposeJobListQuery): Promise<ComposeJobPage>;
  getJob(jobId: string): Promise<ComposeJob>;
  publishSnapshot(input: ComposeRunnerSnapshotRequest): Promise<ReturnType<typeof ComposeRunnerSnapshotAckSchema.parse>>;
  claimNextJob(): Promise<ComposeRunnerClaimResponse>;
  startJob(input: ComposeRunnerStartRequest): Promise<ReturnType<typeof ComposeRunnerStartAckSchema.parse>>;
  completeJob(input: ComposeRunnerCompleteRequest): Promise<{ job: ComposeJob }>;
  reconcileJob(input: ComposeRunnerReconcileRequest): Promise<{ job: ComposeJob }>;
}

export interface ComposeAdminActor {
  actorLabel: string;
  actorIssuer?: string;
  actorSub?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) normalized[key] = stableValue(source[key]);
    return normalized;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new HttpError(500, 'TEMPORARY_UNAVAILABLE', 'stored Compose timestamp is invalid');
  return parsed.toISOString();
}

function safeInt(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(500, 'TEMPORARY_UNAVAILABLE', 'stored Compose revision is invalid');
  return parsed;
}

function targetObservationDigest(input: {
  targetRevision: number;
  desiredReleaseId: string | null;
  observedServices: unknown;
}): string {
  const services = parseJson<Array<Record<string, unknown>>>(input.observedServices)
    .slice()
    .sort((a, b) => String(a['serviceId']).localeCompare(String(b['serviceId']))
      || String(a['containerId'] ?? '').localeCompare(String(b['containerId'] ?? '')));
  return sha256(stableJson({
    targetRevision: input.targetRevision,
    desiredReleaseId: input.desiredReleaseId,
    observedServices: services,
  }));
}

function catalogRevision(project: ComposeRunnerSnapshotRequest['projects'][number]): string {
  const services = project.services.slice().sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const releases = project.releases.slice().sort((a, b) => a.releaseId.localeCompare(b.releaseId));
  return sha256(stableJson({ projectId: project.projectId, displayName: project.displayName, services, releases }));
}

function validateProjectSnapshot(project: ComposeRunnerSnapshotRequest['projects'][number]): void {
  const serviceIds = new Set(project.services.map((service) => service.serviceId));
  if (serviceIds.size !== project.services.length) throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot contains duplicate service identifiers');
  const releaseIds = new Set(project.releases.map((release) => release.releaseId));
  if (releaseIds.size !== project.releases.length) throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot contains duplicate release identifiers');
  const observedIds = new Set(project.observedServices.map((service) => `${service.serviceId}\0${service.containerId ?? ''}`));
  if (observedIds.size !== project.observedServices.length || project.observedServices.some((service) => !serviceIds.has(service.serviceId))) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot observation is outside the approved service catalog');
  }
  for (const release of project.releases) {
    if (release.targetServices.some((id) => !serviceIds.has(id)) ||
        release.images.some((image) => !serviceIds.has(image.serviceId) || !release.targetServices.includes(image.serviceId)) ||
        release.rollbackAllowedFrom.some((id) => !releaseIds.has(id))) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot release references an unknown service or release');
    }
  }
  if (project.observedServices.some((service) => service.observedReleaseId !== null && !releaseIds.has(service.observedReleaseId))) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot observation references an unknown release');
  }
}

function jobWire(row: JobRow): ComposeJob {
  return ComposeJobSchema.parse({
    jobId: row.job_id,
    previewId: row.preview_id,
    hostId: row.host_id,
    projectId: row.project_id,
    action: row.action,
    releaseId: row.release_id,
    serviceId: row.service_id,
    targetReleaseDigest: row.target_release_digest,
    targetServices: parseJson(row.target_services),
    reason: row.reason,
    actorLabel: row.actor_label,
    state: row.state,
    stateVersion: safeInt(row.state_version),
    expectedTargetRevision: safeInt(row.expected_target_revision),
    targetRevision: safeInt(row.target_revision),
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    claimExpiresAt: iso(row.claim_expires_at),
    observedBeforeDigest: row.observed_before_digest,
    startExpectedObservedDigest: row.start_expected_observed_digest,
    observedBefore: parseJson(row.observed_before),
    observedAfter: row.observed_after === null ? null : parseJson(row.observed_after),
    observedAfterDigest: row.observed_after_digest,
    perServiceOutcomes: parseJson(row.per_service_outcomes),
    uncertainReason: row.uncertain_reason,
  });
}

function checkSampleTime(sampledAt: string, now: Date): void {
  const timestamp = Date.parse(sampledAt);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + MAX_CLOCK_FUTURE_MS || timestamp < now.getTime() - MAX_CLOCK_PAST_MS) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'host sample timestamp is outside the accepted clock window');
  }
}

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function scopeError(): HttpError {
  return new HttpError(403, 'PERMISSION_DENIED', 'Compose runner request is outside its configured host scope');
}

function freshness(sampledAt: Date | string, now: Date, config: ComposeRunnerConfig): boolean {
  const time = sampledAt instanceof Date ? sampledAt.getTime() : Date.parse(sampledAt);
  return Number.isFinite(time) && time <= now.getTime() + MAX_CLOCK_FUTURE_MS && now.getTime() - time <= config.maxSampleAgeMs;
}

function jobPageCursor(queryHash: string, createdAt: string, jobId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, queryHash, createdAt, jobId }), 'utf8').toString('base64url');
}

function exactJobCursorTimestamp(value: string | undefined): string {
  if (typeof value !== 'string' || !JOB_PAGE_CURSOR_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(500, 'TEMPORARY_UNAVAILABLE', 'stored Compose job cursor timestamp is invalid');
  }
  return value;
}

function decodeJobPageCursor(cursor: string, queryHash: string): { createdAt: string; jobId: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value['v'] !== 1 || value['queryHash'] !== queryHash || typeof value['createdAt'] !== 'string' ||
        !JOB_PAGE_CURSOR_TIMESTAMP_PATTERN.test(value['createdAt']) || !Number.isFinite(Date.parse(value['createdAt'])) || typeof value['jobId'] !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(value['jobId'])) throw new Error('invalid cursor');
    // Keep the database's exact six-fraction UTC value. Converting through a
    // JavaScript Date here would truncate PostgreSQL microseconds and can make
    // a descending keyset page repeat or skip jobs within one millisecond.
    return { createdAt: value['createdAt'], jobId: value['jobId'] };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Compose job cursor is invalid for this query');
  }
}

export function createComposeOperationsService(
  db: Db,
  audit: AuditService,
  runnerConfigInput?: ComposeRunnerConfig,
  now: () => Date = () => new Date(),
): ComposeOperationsService {
  const runnerConfig = runnerConfigInput === undefined
    ? undefined
    : ComposeRunnerConfigSchema.parse(runnerConfigInput);

  function requireConfigured(): ComposeRunnerConfig {
    if (!runnerConfig) throw new HttpError(503, 'RUNNER_NOT_CONFIGURED', 'Compose host runner is not configured');
    return runnerConfig;
  }

  async function recordAudit(
    executor: PoolClient,
    action: string,
    resource: string,
    actor = 'admin',
    severity: 'info' | 'warning' | 'error' = 'info',
    principal?: { issuer?: string; sub?: string },
  ): Promise<void> {
    await audit.record({ tenantId: null, actor, actorRole: actor.startsWith('compose-runner:') ? 'runner' : 'platform',
      ...(principal?.issuer ? { actorIssuer: principal.issuer } : {}),
      ...(principal?.sub ? { actorSub: principal.sub } : {}), action, resource, severity }, executor);
  }

  async function ensureTarget(executor: PoolClient, hostId: string, projectId: string): Promise<void> {
    await executor.query(
      `INSERT INTO compose_target_state(host_id,project_id,target_revision,desired_release_id,active_job_id)
       VALUES ($1,$2,0,NULL,NULL) ON CONFLICT (host_id,project_id) DO NOTHING`,
      [hostId, projectId],
    );
  }

  async function markExpiredClaimsUnknown(executor: PoolClient, hostId?: string): Promise<void> {
    const rows = await executor.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM compose_jobs
       WHERE state IN ('CLAIMED','RUNNING') AND claim_expires_at < now()
         AND ($1::text IS NULL OR host_id = $1)
       ORDER BY claim_expires_at ASC, job_id ASC
       FOR UPDATE SKIP LOCKED LIMIT 50`,
      [hostId ?? null],
    );
    for (const row of rows.rows) {
      const reason = row.state === 'CLAIMED' ? 'CLAIM_EXPIRED' : 'RUNNER_LOST';
      await executor.query(
        `UPDATE compose_jobs SET state='UNKNOWN', state_version=state_version+1,
           completed_at=now(), execution_token_hash=NULL, uncertain_reason=$2
         WHERE job_id=$1 AND state_version=$3`,
        [row.job_id, reason, row.state_version],
      );
      await recordAudit(executor, 'compose.job.unknown', `compose-job:${row.job_id}`, `compose-runner:${row.host_id}`, 'warning');
    }
  }

  async function getProjectRow(
    executor: PoolClient | Db,
    hostId: string,
    projectId: string,
    lock = false,
  ): Promise<ProjectRow | undefined> {
    const query = (executor.query as unknown as (text: string, params?: unknown[]) => Promise<{ rows: ProjectRow[] }>)
      .bind(executor);
    const result = await query(
      `SELECT p.host_id,p.project_id,p.display_name,p.catalog_revision,p.manifest_digest,
              p.sampled_at,p.received_at,p.observed_digest,p.services,p.releases,p.observed_services,
              t.target_revision,t.desired_release_id,t.active_job_id,
              j.state AS active_job_state
       FROM compose_project_snapshots p
       JOIN compose_target_state t ON t.host_id=p.host_id AND t.project_id=p.project_id
       LEFT JOIN compose_jobs j ON j.job_id=t.active_job_id
       WHERE p.host_id=$1 AND p.project_id=$2 ${lock ? 'FOR UPDATE OF p,t' : ''}`,
      [hostId, projectId],
    );
    return result.rows[0];
  }

  function requireFreshProject(project: ProjectRow | undefined, config: ComposeRunnerConfig, code: ComposeSafeErrorCode = 'STALE_SAMPLE'): ProjectRow {
    if (!project) throw new HttpError(503, 'SNAPSHOT_NOT_RECEIVED', 'Compose host has not published this project');
    if (project.manifest_digest !== config.manifestDigest) throw new HttpError(503, 'MANIFEST_DIGEST_MISMATCH', 'Compose host manifest does not match configured deployment');
    if (!freshness(project.sampled_at, now(), config)) throw new HttpError(409, code, 'Compose host observation is stale');
    return project;
  }

  async function writeObservedServices(
    executor: PoolClient,
    input: {
      hostId: string;
      projectId: string;
      manifestDigest: string;
      sampledAt: string;
      observedServices: unknown;
      targetRevision: number;
      desiredReleaseId: string | null;
    },
  ): Promise<string> {
    const sampled = new Date(input.sampledAt);
    const observedDigest = targetObservationDigest({
      targetRevision: input.targetRevision,
      desiredReleaseId: input.desiredReleaseId,
      observedServices: input.observedServices,
    });
    const updated = await executor.query(
      `UPDATE compose_project_snapshots SET sampled_at=$3::timestamptz, received_at=now(),
         manifest_digest=$4, observed_services=$5::jsonb, observed_digest=$6
       WHERE host_id=$1 AND project_id=$2 AND manifest_digest=$4 AND sampled_at <= $3::timestamptz`,
      [input.hostId, input.projectId, sampled.toISOString(), input.manifestDigest, JSON.stringify(input.observedServices), observedDigest],
    );
    if (updated.rowCount !== 1) throw new HttpError(409, 'STALE_SAMPLE', 'Compose host observation is older than the stored sample');
    await executor.query(
      `UPDATE compose_host_snapshots SET sampled_at=GREATEST(sampled_at,$2::timestamptz), received_at=now()
       WHERE host_id=$1 AND manifest_digest=$3`,
      [input.hostId, sampled.toISOString(), input.manifestDigest],
    );
    return observedDigest;
  }

  function validateTargetOutcomes(targetServices: string[], outcomes: unknown, outcome: string): void {
    const parsed = parseOrThrow(ComposePerServiceOutcomeSchema.array().max(64), outcomes);
    const ids = parsed.map((item) => item.serviceId);
    if (ids.length !== targetServices.length || new Set(ids).size !== ids.length ||
        targetServices.some((serviceId) => !ids.includes(serviceId))) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'runner outcomes must identify each approved target service exactly once');
    }
    if (outcome === 'SUCCEEDED' && parsed.some((item) => item.status !== 'SUCCEEDED')) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'successful job requires every target service to be observed successful');
    }
  }

  function validateSuccessfulObservation(input: {
    action: string;
    releaseId: string | null;
    release: ComposeCatalogRelease | undefined;
    targetServices: string[];
    observedServices: ComposeRunnerCompleteRequest['observedServices'];
  }): void {
    if (!input.observedServices) throw new HttpError(422, 'INVALID_SCHEMA', 'successful job requires a post-action observation');
    if ((input.action === 'apply_release' || input.action === 'rollback_release') &&
        (!input.release || input.release.releaseId !== input.releaseId)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'successful release requires a trusted pinned catalog entry');
    }
    const byId = new Map<string, Array<NonNullable<ComposeRunnerCompleteRequest['observedServices']>[number]>>();
    for (const item of input.observedServices) {
      if (item === null) continue;
      const rows = byId.get(item.serviceId) ?? [];
      rows.push(item);
      byId.set(item.serviceId, rows);
    }
    for (const serviceId of input.targetServices) {
      const observations = byId.get(serviceId) ?? [];
      if (observations.length === 0 || observations.some((observation) => !observation || observation.state !== 'RUNNING' || observation.health === 'UNHEALTHY' ||
          observation.health === 'STARTING' || observation.health === 'UNKNOWN' ||
          ((input.action === 'apply_release' || input.action === 'rollback_release') &&
            (observation.observedReleaseId !== null && observation.observedReleaseId !== input.releaseId ||
             !imageDigestMatches(observation.imageDigest, input.release!.images.find((image) => image.serviceId === serviceId)?.imageDigest ?? ''))))) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'success requires healthy observations for every approved target service');
      }
    }
  }

  function imageDigestMatches(observed: string | null, expected: string): boolean {
    const observedHash = observed?.match(/(?:@|^)sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() ?? null;
    const expectedHash = expected.match(/@sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() ?? null;
    return observedHash !== null && expectedHash !== null && observedHash === expectedHash;
  }

  return {
    async getCatalog() {
      await db.tx(async (client) => markExpiredClaimsUnknown(client, runnerConfig?.hostId));
      if (!runnerConfig) {
        return ComposeCatalogSchema.parse({
          configured: false, hostId: null, manifestDigest: null, availability: 'UNAVAILABLE',
          receivedAt: null, lastErrorCode: 'RUNNER_NOT_CONFIGURED', projects: [],
        });
      }
      const hostResult = await db.query<HostRow>(
        'SELECT host_id,manifest_digest,sampled_at,received_at FROM compose_host_snapshots WHERE host_id=$1',
        [runnerConfig.hostId],
      );
      const host = hostResult.rows[0];
      if (!host) {
        return ComposeCatalogSchema.parse({
          configured: true, hostId: runnerConfig.hostId, manifestDigest: runnerConfig.manifestDigest,
          availability: 'UNAVAILABLE', receivedAt: null, lastErrorCode: 'SNAPSHOT_NOT_RECEIVED', projects: [],
        });
      }
      if (host.manifest_digest !== runnerConfig.manifestDigest) {
        return ComposeCatalogSchema.parse({
          configured: true, hostId: runnerConfig.hostId, manifestDigest: runnerConfig.manifestDigest,
          availability: 'UNAVAILABLE', receivedAt: iso(host.received_at), lastErrorCode: 'MANIFEST_DIGEST_MISMATCH', projects: [],
        });
      }
      const projectResult = await db.query<ProjectRow>(
        `SELECT p.host_id,p.project_id,p.display_name,p.catalog_revision,p.manifest_digest,
                p.sampled_at,p.received_at,p.observed_digest,p.services,p.releases,p.observed_services,
                t.target_revision,t.desired_release_id,t.active_job_id,j.state AS active_job_state
         FROM compose_project_snapshots p
         LEFT JOIN compose_target_state t ON t.host_id=p.host_id AND t.project_id=p.project_id
         LEFT JOIN compose_jobs j ON j.job_id=t.active_job_id
         WHERE p.host_id=$1 ORDER BY p.project_id ASC LIMIT 64`,
        [runnerConfig.hostId],
      );
      const currentTime = now();
      const projects = projectResult.rows.map((row) => {
        const isFresh = freshness(row.sampled_at, currentTime, runnerConfig);
        const activeJobId = row.active_job_id;
        const activeJobState = row.active_job_state;
        return {
          projectId: row.project_id,
          displayName: row.display_name,
          catalogRevision: row.catalog_revision,
          manifestDigest: row.manifest_digest,
          availability: isFresh ? 'FRESH' as const : 'STALE' as const,
          sampledAt: iso(row.sampled_at),
          receivedAt: iso(row.received_at),
          lastErrorCode: isFresh ? null : 'STALE_SAMPLE' as const,
          observedDigest: row.observed_digest,
          targetRevision: row.target_revision === undefined || row.target_revision === null ? 0 : safeInt(row.target_revision),
          desiredReleaseId: row.desired_release_id ?? null,
          activeJob: activeJobId && activeJobState && (ACTIVE_STATES as readonly string[]).includes(activeJobState)
            ? { jobId: activeJobId, state: activeJobState }
            : null,
          services: parseJson(row.services),
          releases: parseJson(row.releases),
          observedServices: parseJson(row.observed_services),
        };
      });
      const isFresh = freshness(host.sampled_at, currentTime, runnerConfig);
      return ComposeCatalogSchema.parse({
        configured: true,
        hostId: runnerConfig.hostId,
        manifestDigest: runnerConfig.manifestDigest,
        availability: isFresh ? 'FRESH' : 'STALE',
        receivedAt: iso(host.received_at),
        lastErrorCode: isFresh ? null : 'STALE_SAMPLE',
        projects,
      });
    },

    async publishSnapshot(input) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposeRunnerSnapshotRequestSchema, input);
      if (request.hostId !== config.hostId) throw scopeError();
      if (request.manifestDigest !== config.manifestDigest) throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', 'host manifest digest does not match configured deployment');
      const sampledAt = new Date(request.sampledAt);
      checkSampleTime(request.sampledAt, now());
      const projectIds = new Set(request.projects.map((project) => project.projectId));
      if (projectIds.size !== request.projects.length) throw new HttpError(422, 'INVALID_SCHEMA', 'snapshot contains duplicate project identifiers');
      request.projects.forEach(validateProjectSnapshot);
      return db.tx(async (client) => {
        const existing = await client.query<HostRow>(
          'SELECT host_id,manifest_digest,sampled_at,received_at FROM compose_host_snapshots WHERE host_id=$1 FOR UPDATE',
          [config.hostId],
        );
        if (existing.rows[0] && new Date(existing.rows[0].sampled_at).getTime() > sampledAt.getTime()) {
          throw new HttpError(409, 'STALE_SAMPLE', 'host snapshot is older than the stored sample');
        }
        await client.query(
          `INSERT INTO compose_host_snapshots(host_id,manifest_digest,sampled_at,received_at)
           VALUES ($1,$2,$3::timestamptz,now())
           ON CONFLICT (host_id) DO UPDATE SET manifest_digest=EXCLUDED.manifest_digest,
             sampled_at=EXCLUDED.sampled_at,received_at=now()`,
          [config.hostId, request.manifestDigest, sampledAt.toISOString()],
        );
        const ackProjects: Array<{ projectId: string; catalogRevision: string; observedDigest: string; targetRevision: number }> = [];
        for (const project of request.projects) {
          await ensureTarget(client, config.hostId, project.projectId);
          const targetResult = await client.query<{ target_revision: number | string; desired_release_id: string | null } & QueryResultRow>(
            `SELECT target_revision,desired_release_id FROM compose_target_state
             WHERE host_id=$1 AND project_id=$2 FOR UPDATE`,
            [config.hostId, project.projectId],
          );
          const target = targetResult.rows[0]!;
          const targetRevision = safeInt(target.target_revision);
          const revision = catalogRevision(project);
          const observedDigest = targetObservationDigest({
            targetRevision,
            desiredReleaseId: target.desired_release_id,
            observedServices: project.observedServices,
          });
          await client.query(
            `INSERT INTO compose_project_snapshots(
               host_id,project_id,display_name,catalog_revision,manifest_digest,sampled_at,received_at,
               observed_digest,services,releases,observed_services)
             VALUES ($1,$2,$3,$4,$5,$6::timestamptz,now(),$7,$8::jsonb,$9::jsonb,$10::jsonb)
             ON CONFLICT (host_id,project_id) DO UPDATE SET display_name=EXCLUDED.display_name,
               catalog_revision=EXCLUDED.catalog_revision,manifest_digest=EXCLUDED.manifest_digest,
               sampled_at=EXCLUDED.sampled_at,received_at=now(),observed_digest=EXCLUDED.observed_digest,
               services=EXCLUDED.services,releases=EXCLUDED.releases,observed_services=EXCLUDED.observed_services`,
            [config.hostId, project.projectId, project.displayName, revision, request.manifestDigest, sampledAt.toISOString(), observedDigest,
              JSON.stringify(project.services), JSON.stringify(project.releases), JSON.stringify(project.observedServices)],
          );
          ackProjects.push({ projectId: project.projectId, catalogRevision: revision, observedDigest, targetRevision });
        }
        return ComposeRunnerSnapshotAckSchema.parse({
          hostId: config.hostId, manifestDigest: config.manifestDigest, receivedAt: now().toISOString(), projects: ackProjects,
        });
      });
    },

    async createPreview(actor, input) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposePreviewRequestSchema, input);
      const actorLabel = actor.actorLabel;
      if (request.hostId !== config.hostId) throw new HttpError(404, 'NOT_FOUND', 'Compose host or project was not found');
      return db.tx(async (client) => {
        await markExpiredClaimsUnknown(client, config.hostId);
        const project = requireFreshProject(await getProjectRow(client, config.hostId, request.projectId, true), config);
        const services = parseJson<Array<{ serviceId: string; displayName: string; restartAllowed: boolean }>>(project.services);
        const releases = parseJson<Array<{
          releaseId: string;
          displayName: string;
          releaseDigest: string;
          targetServices: string[];
          migrationCompatibility: 'acknowledged' | 'not_acknowledged';
          rollbackAllowedFrom: string[];
        }>>(project.releases);
        const observedServices = parseJson<unknown>(project.observed_services);
        if (project.active_job_id) throw new HttpError(409, 'TARGET_BUSY', 'Compose project already has an active or unresolved job');
        const targetRevision = safeInt(project.target_revision ?? 0);
        let targetServices: string[];
        let targetReleaseDigest: string | null = null;
        let warningCodes: Array<'POSSIBLE_SERVICE_INTERRUPTION' | 'MIGRATION_COMPATIBILITY_ACKNOWLEDGED'> = ['POSSIBLE_SERVICE_INTERRUPTION'];
        if (request.action === 'restart_service') {
          const service = services.find((item) => item.serviceId === request.serviceId);
          if (!service || !service.restartAllowed) throw new HttpError(422, 'INVALID_ARGUMENT', 'service is not an approved restart target');
          targetServices = [service.serviceId];
        } else {
          const release = releases.find((item) => item.releaseId === request.releaseId);
          if (!release || release.migrationCompatibility !== 'acknowledged') {
            throw new HttpError(422, 'INVALID_ARGUMENT', 'release is not approved for this deployment action');
          }
          if (request.action === 'rollback_release' &&
              (!project.desired_release_id || !release.rollbackAllowedFrom.includes(project.desired_release_id))) {
            throw new HttpError(422, 'INVALID_ARGUMENT', 'release is not an approved rollback target from the current desired release');
          }
          if (release.targetServices.some((serviceId) => !services.some((service) => service.serviceId === serviceId))) {
            throw new HttpError(422, 'INVALID_ARGUMENT', 'release target contains a service outside the approved catalog');
          }
          targetServices = release.targetServices;
          targetReleaseDigest = release.releaseDigest;
          warningCodes.push('MIGRATION_COMPATIBILITY_ACKNOWLEDGED');
        }
        const previewId = randomUUID();
        const createdAt = now();
        const expiresAt = new Date(createdAt.getTime() + config.previewTtlMs);
        const impact = {
          affectedServices: targetServices,
          downtime: request.action === 'restart_service' ? 'likely' as const : 'possible' as const,
          statefulServicesExcluded: true as const,
        };
        await client.query(
          `INSERT INTO compose_previews(
             preview_id,host_id,project_id,action,release_id,service_id,reason,actor_label,created_at,expires_at,
             manifest_digest,observed_digest,expected_target_revision,target_services,target_release_digest,impact,warnings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17::jsonb)`,
          [previewId, request.hostId, request.projectId, request.action, request.releaseId ?? null, request.serviceId ?? null,
            request.reason, actorLabel, createdAt.toISOString(), expiresAt.toISOString(), config.manifestDigest,
            project.observed_digest, targetRevision, JSON.stringify(targetServices), targetReleaseDigest,
            JSON.stringify(impact), JSON.stringify(warningCodes)],
        );
        await recordAudit(client, 'compose.preview.create', `compose-preview:${previewId}`, actorLabel, 'info', { issuer: actor.actorIssuer, sub: actor.actorSub });
        return ComposePreviewSchema.parse({
          previewId, hostId: request.hostId, projectId: request.projectId, action: request.action,
          releaseId: request.releaseId ?? null, serviceId: request.serviceId ?? null, reason: request.reason,
          createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), manifestDigest: config.manifestDigest,
          observedDigest: project.observed_digest, expectedTargetRevision: targetRevision, targetServices,
          targetReleaseDigest, impact, warnings: warningCodes,
        });
      });
    },

    async submitJob(actor, input, idempotencyKey) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposeSubmitJobRequestSchema, input);
      const actorLabel = actor.actorLabel;
      if (typeof idempotencyKey !== 'string' || !/^[!-~]{8,200}$/.test(idempotencyKey)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'Idempotency-Key must be 8-200 printable ASCII characters');
      }
      const idempotencyScope = 'platform-admin';
      const idempotencyHash = sha256(idempotencyKey);
      const requestHash = sha256(stableJson(request));
      return db.tx(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`compose:${idempotencyScope}:${idempotencyHash}`]);
        const existing = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS},request_hash FROM compose_jobs WHERE idempotency_scope=$1 AND idempotency_key_hash=$2 FOR UPDATE`,
          [idempotencyScope, idempotencyHash],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different Compose request');
          return { job: jobWire(existing.rows[0]), replayed: true };
        }
        const previewResult = await client.query<Record<string, unknown> & QueryResultRow>(
          `SELECT preview_id,host_id,project_id,action,release_id,service_id,reason,created_at,expires_at,
                  manifest_digest,observed_digest,expected_target_revision,target_services,target_release_digest,
                  consumed_at
           FROM compose_previews WHERE preview_id=$1 FOR UPDATE`,
          [request.previewId],
        );
        const preview = previewResult.rows[0];
        if (!preview || preview['host_id'] !== config.hostId) throw new HttpError(404, 'NOT_FOUND', 'Compose preview was not found');
        const expiresAt = new Date(String(preview['expires_at']));
        if (expiresAt.getTime() <= now().getTime() || preview['consumed_at'] !== null) throw new HttpError(409, 'STALE_PREVIEW', 'Compose preview expired or was already consumed');
        const expectedRevision = safeInt(String(preview['expected_target_revision']));
        if (request.expectedTargetRevision !== expectedRevision) throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose preview target revision changed');
        if (preview['manifest_digest'] !== config.manifestDigest) throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', 'Compose preview manifest is no longer configured');
        await ensureTarget(client, config.hostId, String(preview['project_id']));
        const targetResult = await client.query<{ target_revision: number | string; desired_release_id: string | null; active_job_id: string | null } & QueryResultRow>(
          `SELECT target_revision,desired_release_id,active_job_id FROM compose_target_state
           WHERE host_id=$1 AND project_id=$2 FOR UPDATE`,
          [config.hostId, preview['project_id']],
        );
        const target = targetResult.rows[0]!;
        const currentRevision = safeInt(target.target_revision);
        if (currentRevision !== expectedRevision) throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose target revision changed after preview');
        if (target.active_job_id) throw new HttpError(409, 'TARGET_BUSY', 'Compose project already has an active or unresolved job');
        const project = requireFreshProject(await getProjectRow(client, config.hostId, String(preview['project_id']), true), config);
        if (project.observed_digest !== preview['observed_digest']) throw new HttpError(409, 'STALE_PREVIEW', 'Compose host observation changed after preview');
        const targetServices = parseJson<string[]>(preview['target_services']);
        const newTargetRevision = currentRevision + 1;
        if (!Number.isSafeInteger(newTargetRevision)) throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose target revision reached its supported limit');
        const newDesiredRelease = preview['release_id'] === null ? target.desired_release_id : String(preview['release_id']);
        const startExpectedObservedDigest = targetObservationDigest({
          targetRevision: newTargetRevision,
          desiredReleaseId: newDesiredRelease,
          observedServices: project.observed_services,
        });
        const jobId = randomUUID();
        await client.query(
          `INSERT INTO compose_jobs(
             job_id,preview_id,host_id,project_id,action,release_id,service_id,target_release_digest,target_services,
             reason,actor_label,idempotency_scope,idempotency_key_hash,request_hash,state,state_version,
             expected_target_revision,target_revision,observed_before_digest,start_expected_observed_digest,
             observed_before,observed_after,observed_after_digest,per_service_outcomes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,'QUEUED',1,$15,$16,$17,$18,$19::jsonb,NULL,NULL,'[]'::jsonb)`,
          [jobId, request.previewId, config.hostId, preview['project_id'], preview['action'], preview['release_id'], preview['service_id'],
            preview['target_release_digest'], JSON.stringify(targetServices), preview['reason'], actorLabel,
            idempotencyScope, idempotencyHash, requestHash, expectedRevision, newTargetRevision,
            preview['observed_digest'], startExpectedObservedDigest, JSON.stringify(parseJson(project.observed_services))],
        );
        await client.query(
          `UPDATE compose_target_state SET target_revision=$3,desired_release_id=$4,active_job_id=$5,updated_at=now()
           WHERE host_id=$1 AND project_id=$2`,
          [config.hostId, preview['project_id'], newTargetRevision, newDesiredRelease, jobId],
        );
        const observedDigest = targetObservationDigest({
          targetRevision: newTargetRevision,
          desiredReleaseId: newDesiredRelease,
          observedServices: project.observed_services,
        });
        await client.query(
          `UPDATE compose_project_snapshots SET observed_digest=$3 WHERE host_id=$1 AND project_id=$2`,
          [config.hostId, preview['project_id'], observedDigest],
        );
        await client.query('UPDATE compose_previews SET consumed_at=now() WHERE preview_id=$1 AND consumed_at IS NULL', [request.previewId]);
        await recordAudit(client, 'compose.job.submit', `compose-job:${jobId}`, actorLabel, 'info', { issuer: actor.actorIssuer, sub: actor.actorSub });
        const created = await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM compose_jobs WHERE job_id=$1`, [jobId]);
        return { job: jobWire(created.rows[0]!), replayed: false };
      });
    },

    async listJobs(queryInput) {
      const query = parseOrThrow(ComposeJobListQuerySchema, queryInput);
      const config = runnerConfig;
      const hostId = query.hostId ?? config?.hostId;
      if (query.hostId && config && query.hostId !== config.hostId) throw new HttpError(404, 'NOT_FOUND', 'Compose jobs were not found');
      const normalized = { hostId: hostId ?? null, projectId: query.projectId ?? null, state: query.state ?? null, limit: query.limit };
      const queryHash = sha256(stableJson(normalized));
      const after = query.cursor ? decodeJobPageCursor(query.cursor, queryHash) : undefined;
      await db.tx(async (client) => markExpiredClaimsUnknown(client, hostId));
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (value: unknown): string => { params.push(value); return `$${params.length}`; };
      if (hostId !== undefined) where.push(`host_id=${add(hostId)}`);
      if (query.projectId !== undefined) where.push(`project_id=${add(query.projectId)}`);
      if (query.state !== undefined) where.push(`state=${add(query.state)}`);
      if (after) {
        const createdAt = add(after.createdAt);
        const jobId = add(after.jobId);
        where.push(`(created_at,job_id) < (${createdAt}::timestamptz,${jobId}::uuid)`);
      }
      const limitPlaceholder = add(query.limit + 1);
      const result = await db.query<JobRow>(
        `SELECT ${JOB_COLUMNS},
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
         FROM compose_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC,job_id DESC LIMIT ${limitPlaceholder}`,
        params,
      );
      const hasMore = result.rows.length > query.limit;
      const pageRows = result.rows.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      return ComposeJobPageSchema.parse({
        items: pageRows.map(jobWire), limit: query.limit, hasMore,
        ...(hasMore && last ? { nextCursor: jobPageCursor(queryHash, exactJobCursorTimestamp(last.cursor_created_at), last.job_id) } : {}),
      });
    },

    async getJob(jobId) {
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
      await db.tx(async (client) => markExpiredClaimsUnknown(client, runnerConfig?.hostId));
      const result = await db.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM compose_jobs WHERE job_id=$1 ${runnerConfig ? 'AND host_id=$2' : ''}`,
        runnerConfig ? [jobId, runnerConfig.hostId] : [jobId],
      );
      if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
      return jobWire(result.rows[0]);
    },

    async claimNextJob() {
      const config = requireConfigured();
      return db.tx(async (client) => {
        await markExpiredClaimsUnknown(client, config.hostId);
        const queued = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS_J} FROM compose_jobs j
           JOIN compose_target_state t ON t.active_job_id=j.job_id
           WHERE j.host_id=$1 AND j.state='QUEUED'
           ORDER BY j.created_at ASC,j.job_id ASC FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
          [config.hostId],
        );
        if (!queued.rows[0]) return ComposeRunnerClaimResponseSchema.parse({ claim: null });
        const row = queued.rows[0];
        const token = randomBytes(32).toString('base64url');
        await client.query(
          `UPDATE compose_jobs SET state='CLAIMED',state_version=state_version+1,
             claim_expires_at=now()+($2::bigint * interval '1 millisecond'),execution_token_hash=$3
           WHERE job_id=$1 AND state='QUEUED'`,
          [row.job_id, config.claimTtlMs, sha256(token)],
        );
        await recordAudit(client, 'compose.job.claim', `compose-job:${row.job_id}`, `compose-runner:${config.hostId}`);
        const claimed = await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM compose_jobs WHERE job_id=$1`, [row.job_id]);
        return ComposeRunnerClaimResponseSchema.parse({ claim: { job: jobWire(claimed.rows[0]!), executionToken: token } });
      });
    },

    async startJob(input) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposeRunnerStartRequestSchema, input);
      if (request.manifestDigest !== config.manifestDigest) throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', 'host manifest digest changed before start');
      const result = await db.tx(async (client) => {
        const result = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS},execution_token_hash FROM compose_jobs
           WHERE job_id=$1 AND host_id=$2 FOR UPDATE`,
          [request.jobId, config.hostId],
        );
        const row = result.rows[0] as (JobRow & { execution_token_hash: string | null }) | undefined;
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
        if (row.state !== 'CLAIMED' || safeInt(row.state_version) !== request.expectedStateVersion ||
            row.execution_token_hash !== sha256(request.executionToken) || !row.claim_expires_at ||
            new Date(row.claim_expires_at).getTime() <= now().getTime()) {
          throw new HttpError(409, 'RUNNER_REPORT_REJECTED', 'Compose job claim is stale or no longer valid');
        }
        const target = await client.query<{ target_revision: number | string; active_job_id: string | null } & QueryResultRow>(
          `SELECT target_revision,active_job_id FROM compose_target_state WHERE host_id=$1 AND project_id=$2 FOR UPDATE`,
          [config.hostId, row.project_id],
        );
        if (!target.rows[0] || target.rows[0].active_job_id !== row.job_id || safeInt(target.rows[0].target_revision) !== safeInt(row.target_revision)) {
          throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose target revision changed before start');
        }
        const project = requireFreshProject(await getProjectRow(client, config.hostId, row.project_id), config);
        if (project.observed_digest !== request.observedDigest || request.observedDigest !== row.start_expected_observed_digest) {
          const targets = parseJson<string[]>(row.target_services);
          await client.query(
            `UPDATE compose_jobs SET state='FAILED',state_version=state_version+1,completed_at=now(),
               claim_expires_at=NULL,execution_token_hash=NULL,per_service_outcomes=$2::jsonb
             WHERE job_id=$1 AND state='CLAIMED' AND state_version=$3`,
            [row.job_id, JSON.stringify(targets.map((serviceId) => ({ serviceId, status: 'FAILED', errorCode: 'STALE_SAMPLE' }))), row.state_version],
          );
          await client.query(
            'UPDATE compose_target_state SET active_job_id=NULL,updated_at=now() WHERE host_id=$1 AND project_id=$2 AND active_job_id=$3',
            [row.host_id, row.project_id, row.job_id],
          );
          await recordAudit(client, 'compose.job.prestart_rejected', `compose-job:${row.job_id}`, `compose-runner:${config.hostId}`, 'warning');
          return { rejected: true as const };
        }
        const startedAt = now();
        await client.query(
          `UPDATE compose_jobs SET state='RUNNING',state_version=state_version+1,started_at=$2::timestamptz,
             claim_expires_at=$3::timestamptz WHERE job_id=$1 AND state_version=$4`,
          [row.job_id, startedAt.toISOString(), new Date(startedAt.getTime() + Math.max(RUNNING_JOB_LEASE_MS, config.claimTtlMs)).toISOString(), row.state_version],
        );
        await recordAudit(client, 'compose.job.start', `compose-job:${row.job_id}`, `compose-runner:${config.hostId}`);
        const ack = ComposeRunnerStartAckSchema.parse({
          jobId: row.job_id, state: 'RUNNING', stateVersion: safeInt(row.state_version) + 1, startedAt: startedAt.toISOString(),
        });
        return { rejected: false as const, ack };
      });
      if (result.rejected) throw new HttpError(409, 'STALE_SAMPLE', 'Compose observation changed before durable start; no host action was started');
      return result.ack;
    },

    async completeJob(input) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposeRunnerCompleteRequestSchema, input);
      const reportHash = sha256(stableJson(request));
      return db.tx(async (client) => {
        const result = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS},execution_token_hash,completion_report_hash,completion_ack FROM compose_jobs
           WHERE job_id=$1 AND host_id=$2 FOR UPDATE`,
          [request.jobId, config.hostId],
        );
        const row = result.rows[0] as (JobRow & { execution_token_hash: string | null; completion_report_hash: string | null; completion_ack: unknown }) | undefined;
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
        if (row.completion_report_hash !== null) {
          if (row.completion_report_hash !== reportHash || row.completion_ack === null) {
            throw new HttpError(409, 'RUNNER_REPORT_REJECTED', 'Compose job already accepted a different completion report');
          }
          return ComposeRunnerCompleteAckSchema.parse(parseJson(row.completion_ack));
        }
        if (request.manifestDigest !== config.manifestDigest) throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', 'host manifest digest changed before report');
        checkSampleTime(request.sampledAt, now());
        const tokenMatches = row.execution_token_hash === sha256(request.executionToken);
        const versionMatches = safeInt(row.state_version) === request.expectedStateVersion;
        const runningReport = row.state === 'RUNNING' && versionMatches && tokenMatches && !!row.claim_expires_at &&
          new Date(row.claim_expires_at).getTime() > now().getTime();
        const prestartRejection = row.state === 'CLAIMED' && versionMatches && tokenMatches && !!row.claim_expires_at &&
          new Date(row.claim_expires_at).getTime() > now().getTime() && row.started_at === null &&
          request.outcome === 'FAILED' && request.errorCode === 'STALE_SAMPLE' && request.uncertainReason === null;
        if (!runningReport && !prestartRejection) {
          throw new HttpError(409, 'RUNNER_REPORT_REJECTED', 'Compose job report is stale or no longer valid');
        }
        const targetServices = parseJson<string[]>(row.target_services);
        validateTargetOutcomes(targetServices, request.perServiceOutcomes, request.outcome);
        const target = await client.query<{ target_revision: number | string; desired_release_id: string | null; active_job_id: string | null } & QueryResultRow>(
          `SELECT target_revision,desired_release_id,active_job_id FROM compose_target_state WHERE host_id=$1 AND project_id=$2 FOR UPDATE`,
          [row.host_id, row.project_id],
        );
        if (!target.rows[0] || target.rows[0].active_job_id !== row.job_id) throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose job no longer owns its target fence');
        if (runningReport && request.outcome === 'SUCCEEDED') {
          const project = requireFreshProject(await getProjectRow(client, row.host_id, row.project_id, true), config);
          const releases = parseJson<ComposeCatalogRelease[]>(project.releases);
          validateSuccessfulObservation({
            action: row.action,
            releaseId: row.release_id,
            release: releases.find((release) => release.releaseId === row.release_id),
            targetServices,
            observedServices: request.observedServices,
          });
        }
        let observedAfterDigest: string | null = null;
        let observedAfter = request.observedServices;
        if (prestartRejection) {
          const project = requireFreshProject(await getProjectRow(client, row.host_id, row.project_id, true), config);
          if (project.observed_digest === row.start_expected_observed_digest || request.observedServices === null ||
              new Date(project.sampled_at).getTime() !== Date.parse(request.sampledAt) ||
              stableJson(parseJson(project.observed_services)) !== stableJson(request.observedServices)) {
            throw new HttpError(409, 'RUNNER_REPORT_REJECTED', 'pre-start rejection did not match the current fresh observation');
          }
          observedAfterDigest = project.observed_digest;
          observedAfter = parseJson(project.observed_services);
        } else if (request.observedServices !== null) {
          observedAfterDigest = await writeObservedServices(client, {
            hostId: row.host_id, projectId: row.project_id, manifestDigest: config.manifestDigest,
            sampledAt: request.sampledAt, observedServices: request.observedServices,
            targetRevision: safeInt(target.rows[0].target_revision), desiredReleaseId: target.rows[0].desired_release_id,
          });
        }
        const completedAt = now();
        const acceptedOutcome = prestartRejection ? 'FAILED' : request.outcome;
        const keepFence = acceptedOutcome === 'UNKNOWN';
        await client.query(
          `UPDATE compose_jobs SET state=$2,state_version=state_version+1,completed_at=$3::timestamptz,
             claim_expires_at=NULL,execution_token_hash=NULL,uncertain_reason=$4,
             observed_after=$5::jsonb,observed_after_digest=$6,per_service_outcomes=$7::jsonb,
             completion_report_hash=$9
           WHERE job_id=$1 AND state_version=$8`,
          [row.job_id, acceptedOutcome, completedAt.toISOString(), request.uncertainReason,
            observedAfter === null ? null : JSON.stringify(observedAfter), observedAfterDigest,
            JSON.stringify(request.perServiceOutcomes), row.state_version, reportHash],
        );
        if (!keepFence) {
          await client.query(
            'UPDATE compose_target_state SET active_job_id=NULL,updated_at=now() WHERE host_id=$1 AND project_id=$2 AND active_job_id=$3',
            [row.host_id, row.project_id, row.job_id],
          );
        }
        await recordAudit(client, prestartRejection ? 'compose.job.prestart_rejected' : `compose.job.${acceptedOutcome.toLowerCase()}`,
          `compose-job:${row.job_id}`, `compose-runner:${config.hostId}`, acceptedOutcome === 'SUCCEEDED' ? 'info' : 'warning');
        const updated = await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM compose_jobs WHERE job_id=$1`, [row.job_id]);
        const ack = ComposeRunnerCompleteAckSchema.parse({ job: jobWire(updated.rows[0]!) });
        await client.query('UPDATE compose_jobs SET completion_ack=$2::jsonb WHERE job_id=$1', [row.job_id, JSON.stringify(ack)]);
        return ack;
      });
    },

    async reconcileJob(input) {
      const config = requireConfigured();
      const request = parseOrThrow(ComposeRunnerReconcileRequestSchema, input);
      const reportHash = sha256(stableJson(request));
      return db.tx(async (client) => {
        const result = await client.query<JobRow>(
          `SELECT ${JOB_COLUMNS},reconcile_report_hash,reconcile_ack FROM compose_jobs WHERE job_id=$1 AND host_id=$2 FOR UPDATE`,
          [request.jobId, config.hostId],
        );
        const row = result.rows[0] as (JobRow & { reconcile_report_hash: string | null; reconcile_ack: unknown }) | undefined;
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
        if (row.reconcile_report_hash === reportHash && row.reconcile_ack !== null) {
          return ComposeRunnerReconcileAckSchema.parse(parseJson(row.reconcile_ack));
        }
        if (request.manifestDigest !== config.manifestDigest) throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', 'host manifest digest changed before reconciliation');
        checkSampleTime(request.sampledAt, now());
        if (row.state !== 'UNKNOWN' || safeInt(row.state_version) !== request.expectedStateVersion) {
          throw new HttpError(409, 'RUNNER_REPORT_REJECTED', 'Compose job is not in the expected UNKNOWN revision');
        }
        const targetServices = parseJson<string[]>(row.target_services);
        validateTargetOutcomes(targetServices, request.perServiceOutcomes, request.executorQuiescent ? 'RECONCILED' : 'UNKNOWN');
        const target = await client.query<{ target_revision: number | string; desired_release_id: string | null; active_job_id: string | null } & QueryResultRow>(
          `SELECT target_revision,desired_release_id,active_job_id FROM compose_target_state WHERE host_id=$1 AND project_id=$2 FOR UPDATE`,
          [row.host_id, row.project_id],
        );
        if (!target.rows[0] || target.rows[0].active_job_id !== row.job_id) throw new HttpError(409, 'TARGET_REVISION_CONFLICT', 'Compose UNKNOWN job no longer owns its target fence');
        let observedAfterDigest: string | null = null;
        if (request.observedServices !== null) {
          observedAfterDigest = await writeObservedServices(client, {
            hostId: row.host_id, projectId: row.project_id, manifestDigest: config.manifestDigest,
            sampledAt: request.sampledAt, observedServices: request.observedServices,
            targetRevision: safeInt(target.rows[0].target_revision), desiredReleaseId: target.rows[0].desired_release_id,
          });
        }
        if (request.executorQuiescent && request.observedServices === null) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'quiescent reconciliation requires a fresh observed state');
        }
        const nextState = request.executorQuiescent ? 'RECONCILED' : 'UNKNOWN';
        await client.query(
          `UPDATE compose_jobs SET state=$2,state_version=state_version+1,completed_at=COALESCE(completed_at,now()),
             claim_expires_at=NULL,execution_token_hash=NULL,uncertain_reason=COALESCE(uncertain_reason,'EXECUTION_UNCERTAIN'),
             observed_after=COALESCE($3::jsonb,observed_after),observed_after_digest=COALESCE($4,observed_after_digest),
             per_service_outcomes=$5::jsonb
           WHERE job_id=$1 AND state_version=$6`,
          [row.job_id, nextState, request.observedServices === null ? null : JSON.stringify(request.observedServices),
            observedAfterDigest, JSON.stringify(request.perServiceOutcomes), row.state_version],
        );
        if (request.executorQuiescent) {
          await client.query(
            'UPDATE compose_target_state SET active_job_id=NULL,updated_at=now() WHERE host_id=$1 AND project_id=$2 AND active_job_id=$3',
            [row.host_id, row.project_id, row.job_id],
          );
        }
        await recordAudit(client, request.executorQuiescent ? 'compose.job.reconcile' : 'compose.job.reconcile.uncertain',
          `compose-job:${row.job_id}`, `compose-runner:${config.hostId}`, request.executorQuiescent ? 'warning' : 'error');
        const updated = await client.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM compose_jobs WHERE job_id=$1`, [row.job_id]);
        const ack = ComposeRunnerReconcileAckSchema.parse({ job: jobWire(updated.rows[0]!) });
        await client.query(
          'UPDATE compose_jobs SET reconcile_report_hash=$2,reconcile_ack=$3::jsonb WHERE job_id=$1',
          [row.job_id, reportHash, JSON.stringify(ack)],
        );
        return ack;
      });
    },
  };
}
