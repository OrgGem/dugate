import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  ProviderTestGrantClaimsSchema,
  ProviderTestRequestSchema,
  ProviderTestResultSchema,
  InvocationInputSchema,
  InvocationArtifactContentSchema,
  InvocationArtifactPinWithGenerationSchema,
  hashInvocationInput,
  canonicalize,
  type ConnectorProviderTestEvidence,
  type InvocationArtifactContent,
  type InvocationArtifactPin,
  type ProviderTestRequest,
  type ProviderTestResult,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { RouteContext } from '../../http/route-context';
import { HttpError } from '../../http/errors';
import type { AdminActionAuth } from '../admin-actions/rbac';
import {
  adminWorkbenchActor,
  adminWorkbenchPrincipal,
  assertAdminWorkbenchAdmissionScope,
  trustedLocalAdminWorkbenchActor,
} from '../admin-workbench/service';
import { createInvocationCostContext } from '../cost-control/cost-context';
import type { ArtifactService } from '../artifacts/artifacts';

const MAX_ACTIVE_PER_KEY = 2;
const MAX_ACCEPTED_PER_KEY_WINDOW = 5;
const RATE_WINDOW_SECONDS = 600;
const GRANT_SECONDS = 120;

interface ExistingRun extends QueryResultRow {
  api_key_id: string;
  profile_id: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  connector_id: string;
  connector_revision: number;
  state: string;
  state_version: number;
  result: unknown;
  request_hash: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function signProviderTestGrant(claims: unknown, secret: string): string {
  const parsed = ProviderTestGrantClaimsSchema.parse(claims);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

type ProviderTestArtifactRead = Awaited<ReturnType<ArtifactService['readInvocationArtifacts']>>;

/** Project internal authenticated-read evidence onto the strict Connector
 * wire DTOs. Integrity diagnostics remain in Orchestrator and never enter the
 * invocation input or signed grant. */
export function projectProviderTestArtifactRead(read: ProviderTestArtifactRead): {
  artifacts: InvocationArtifactContent[];
  artifactPins: InvocationArtifactPin[];
} {
  const artifacts = read.contents.map((item) => InvocationArtifactContentSchema.parse({
    artifactId: item.artifactId,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    storageVersionId: item.storageVersionId,
    contentBase64: item.contentBase64,
  }));
  const artifactPins = read.pins.map((item) => InvocationArtifactPinWithGenerationSchema.parse({
    artifactId: item.artifactId,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    storageVersionId: item.storageVersionId,
    ...(item.storageGenerationId === undefined ? {} : { storageGenerationId: item.storageGenerationId }),
  }));
  return { artifacts, artifactPins };
}

export function isPlatformAdminProviderTestActor(auth: AdminActionAuth): boolean {
  try {
    // Match the verified Admin-action role decision used by the parity route:
    // a validated local ADMIN is a platform Admin, while a local USER remains
    // a tenant_operator regardless of their cookie's local issuer.
    return adminWorkbenchPrincipal(auth).role === 'platform';
  } catch {
    return false;
  }
}

export function assertProviderTestRevisionAccess(
  auth: AdminActionAuth,
  input: { revisionState: string; bindingSlot?: string },
): void {
  if (input.revisionState === 'PENDING') {
    if (!isPlatformAdminProviderTestActor(auth)) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'only platform Admin can test a pending Connector revision');
    }
    if (!input.bindingSlot) throw new HttpError(422, 'INVALID_SCHEMA', 'select a declared binding slot for the PENDING candidate test');
    return;
  }
  if (input.revisionState !== 'ACTIVE') {
    throw new HttpError(409, 'STATE_CONFLICT', 'Connector revision cannot be tested in its current state');
  }
  if (input.bindingSlot !== undefined) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'bindingSlot is only accepted for a platform-admin PENDING candidate test');
  }
}

function unknownResult(invocationId: string): ProviderTestResult {
  return {
    invocationId,
    state: 'UNKNOWN',
    statusCode: null,
    content: null,
    contentTruncated: false,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    usageEventId: null,
    errorCode: 'INVOCATION_UNKNOWN',
  };
}

/** Only retain content the Connector credential-aware sanitizer explicitly marked. */
export function redactProviderTestResult(result: ProviderTestResult): ProviderTestResult {
  const parsed = ProviderTestResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  if (result.contentSanitized === true) return ProviderTestResultSchema.parse(result);
  const safe = { ...result, content: null, contentTruncated: false };
  delete safe.contentSanitized;
  return ProviderTestResultSchema.parse(safe);
}

function resultForRun(row: ExistingRun): ProviderTestResult | null {
  const parsed = ProviderTestResultSchema.safeParse(row.result);
  return parsed.success ? redactProviderTestResult(parsed.data) : null;
}

export function recoverProviderTestResult(evidence: ConnectorProviderTestEvidence): ProviderTestResult | null {
  if (!evidence.recoveryReady || evidence.result === null || evidence.usageEvent === null) return null;
  const contentSanitized = evidence.result.contentSanitized === true;
  return ProviderTestResultSchema.parse({
    invocationId: evidence.invocationId,
    state: 'SUCCEEDED',
    statusCode: evidence.result.statusCode,
    content: contentSanitized ? evidence.result.content : null,
    contentTruncated: contentSanitized ? evidence.result.contentTruncated : false,
    ...(contentSanitized ? { contentSanitized: true } : {}),
    latencyMs: evidence.result.latencyMs ?? 0,
    inputTokens: evidence.usageEvent.inputTokens,
    outputTokens: evidence.usageEvent.outputTokens,
    usageEventId: evidence.usageEvent.eventId,
    errorCode: null,
  });
}

async function validateLocalActorInTransaction(
  client: PoolClient,
  auth: AdminActionAuth,
  input: { tenantId: string; apiKeyId: string; profileId: string; profileRevision: number; businessId: string; businessVersion: string; action: string },
): Promise<void> {
  const actor = trustedLocalAdminWorkbenchActor(auth);
  if (!actor) return;
  if (actor.tenantId !== input.tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');

  const user = await client.query<{ id: string }>(
    `SELECT id FROM admin_local_users
      WHERE id=$1 AND tenant_id=$2 AND role='operator' AND is_enabled=true AND is_locked=false AND version=$3
      FOR SHARE`,
    [actor.userId, input.tenantId, actor.roleVersion],
  );
  if (!user.rowCount) throw new HttpError(403, 'PERMISSION_DENIED', 'local USER session is stale or no longer enabled');

  const key = await client.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'
       AND lower(trim(coalesce(name,''))) <> 'global' FOR SHARE`,
    [input.apiKeyId, input.tenantId],
  );
  if (!key.rowCount) throw new HttpError(403, 'PERMISSION_DENIED', 'provider tests require an assigned active API key');

  const keyGrant = await client.query(
    `SELECT 1 FROM admin_local_user_api_key_grants
      WHERE tenant_id=$1 AND user_id=$2 AND api_key_id=$3 FOR SHARE`,
    [input.tenantId, actor.userId, input.apiKeyId],
  );
  const profileGrant = await client.query(
    `SELECT 1 FROM admin_local_user_profile_grants
      WHERE tenant_id=$1 AND user_id=$2 AND profile_id=$3 FOR SHARE`,
    [input.tenantId, actor.userId, input.profileId],
  );
  const binding = await client.query(
    `SELECT 1 FROM profile_bindings b
      JOIN profile_api_keys m ON m.profile_id=b.profile_id AND m.tenant_id=b.tenant_id
     WHERE b.tenant_id=$1 AND b.profile_id=$2 AND b.revision=$3 AND m.api_key_id=$4 AND m.state='ACTIVE'
       AND b.business_id=$5 AND b.business_version=$6 AND b.action=$7
     FOR SHARE OF b,m`,
    [input.tenantId, input.profileId, input.profileRevision, input.apiKeyId, input.businessId, input.businessVersion, input.action],
  );
  if (!keyGrant.rowCount || !profileGrant.rowCount || !binding.rowCount) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'local USER must have current assignments to the selected active API key and Profile');
  }
}

async function validateLocalHistoryAccess(
  client: PoolClient,
  auth: AdminActionAuth,
  input: { tenantId: string; apiKeyId: string; profileId: string },
): Promise<void> {
  const actor = trustedLocalAdminWorkbenchActor(auth);
  if (!actor) return;
  if (actor.tenantId !== input.tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  const user = await client.query<{ id: string }>(
    `SELECT id FROM admin_local_users
      WHERE id=$1 AND tenant_id=$2 AND role='operator' AND is_enabled=true AND is_locked=false AND version=$3 FOR SHARE`,
    [actor.userId, input.tenantId, actor.roleVersion],
  );
  const key = await client.query<{ id: string }>(
    `SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'
      AND lower(trim(coalesce(name,''))) <> 'global' FOR SHARE`,
    [input.apiKeyId, input.tenantId],
  );
  const keyGrant = await client.query(
    `SELECT 1 FROM admin_local_user_api_key_grants
      WHERE tenant_id=$1 AND user_id=$2 AND api_key_id=$3 FOR SHARE`,
    [input.tenantId, actor.userId, input.apiKeyId],
  );
  const profileGrant = await client.query(
    `SELECT 1 FROM admin_local_user_profile_grants
      WHERE tenant_id=$1 AND user_id=$2 AND profile_id=$3 FOR SHARE`,
    [input.tenantId, actor.userId, input.profileId],
  );
  const profile = await client.query(
    `SELECT 1 FROM profile_names WHERE tenant_id=$1 AND profile_id=$2 FOR SHARE`,
    [input.tenantId, input.profileId],
  );
  if (!user.rowCount || !key.rowCount || !keyGrant.rowCount || !profileGrant.rowCount || !profile.rowCount) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'local USER no longer has current access to this provider test');
  }
}

async function reserveProviderTestRun(
  ctx: RouteContext,
  auth: AdminActionAuth,
  request: ProviderTestRequest,
  admitted: Awaited<ReturnType<RouteContext['submission']['admitProviderTest']>>,
  input: { expectedHash: string; idempotencyHash: string; invocationId: string; operationId: string; taskId: string; reservationGroupId: string; deadlineAt: string },
): Promise<{ existing: ExistingRun | null }> {
  const actor = adminWorkbenchActor(auth);
  const connectorBindings = { [admitted.bindingSlot]: `${request.connectorId}@${request.revision}` };
  return ctx.db.tx(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('admin-provider-test:' || $1 || ':' || $2, 0))`,
      [request.tenantId, request.apiKeyId],
    );

    const existing = await client.query<ExistingRun>(
      `SELECT r.api_key_id,r.profile_id,r.operation_id,r.task_id,r.invocation_id,r.connector_id,r.connector_revision,
              r.state,r.state_version,r.result,r.request_hash
         FROM admin_connector_test_runs r
        WHERE r.tenant_id=$1 AND r.idempotency_hash=$2 FOR UPDATE`,
      [request.tenantId, input.idempotencyHash],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== input.expectedHash) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different provider-test request');
      }
      await validateLocalHistoryAccess(client, auth, {
        tenantId: request.tenantId,
        apiKeyId: existing.rows[0].api_key_id,
        profileId: existing.rows[0].profile_id,
      });
      return { existing: existing.rows[0] };
    }

    // Lock the key and profile membership before checking assignments so a
    // concurrent revoke/rotation cannot race the durable admission point.
    const activeKey = await client.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'
         AND lower(trim(coalesce(name,''))) <> 'global' FOR SHARE`,
      [request.apiKeyId, request.tenantId],
    );
    if (!activeKey.rowCount) throw new HttpError(409, 'ADMISSION_REJECTED', 'selected API key is not active or is protected');

    const membership = await client.query(
      `SELECT 1 FROM profile_api_keys WHERE tenant_id=$1 AND profile_id=$2 AND api_key_id=$3 AND state='ACTIVE' FOR SHARE`,
      [request.tenantId, admitted.profileId, request.apiKeyId],
    );
    const profileRevision = await client.query(
      `SELECT p.profile_id FROM profile_active_revisions a
         JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
        WHERE a.profile_id=$1 AND a.revision=$2 AND p.tenant_id=$3 AND p.enabled IS DISTINCT FROM false
          AND p.business_id=$4 AND p.business_version=$5 AND p.action=$6
        FOR SHARE OF a,p`,
      [admitted.profileId, admitted.profileRevision, request.tenantId, request.businessId, request.businessVersion, request.action],
    );
    const business = await client.query<{ version: string }>(
      `SELECT version FROM business_versions WHERE business_id=$1 AND version=$2 AND is_active=true FOR SHARE`,
      [request.businessId, request.businessVersion],
    );
    if (!membership.rowCount || !profileRevision.rowCount || !business.rowCount) {
      throw new HttpError(409, 'ADMISSION_CHANGED', 'Profile, key or business version changed before test acceptance');
    }
    await validateLocalActorInTransaction(client, auth, {
      tenantId: request.tenantId,
      apiKeyId: request.apiKeyId,
      profileId: admitted.profileId,
      profileRevision: admitted.profileRevision,
      businessId: request.businessId,
      businessVersion: request.businessVersion,
      action: request.action,
    });

    const rate = await client.query<{ recent: number; active: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= now() - ($3 || ' seconds')::interval)::int AS recent,
              count(*) FILTER (WHERE state IN ('PREPARED','RUNNING','UNKNOWN'))::int AS active
         FROM admin_connector_test_runs WHERE tenant_id=$1 AND api_key_id=$2`,
      [request.tenantId, request.apiKeyId, String(RATE_WINDOW_SECONDS)],
    );
    if (Number(rate.rows[0]?.active ?? 0) >= MAX_ACTIVE_PER_KEY || Number(rate.rows[0]?.recent ?? 0) >= MAX_ACCEPTED_PER_KEY_WINDOW) {
      throw new HttpError(429, 'CAPACITY', 'provider-test concurrency or rate limit reached; try again later');
    }

    const targetBinding = `${request.connectorId}@${request.revision}`;
    await client.query(
      `INSERT INTO operations
        (id,tenant_id,api_key_id,business_id,business_version,action,state,state_version,root_task_id,deadline_at,input_ref,
         correlation_id,profile_id,profile_revision,connector_bindings,submit_artifacts,profile_policy_snapshot,endpoint_slug)
       VALUES ($1,$2,$3,$4,$5,$6,'RUNNING',1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [input.operationId, request.tenantId, request.apiKeyId, request.businessId, request.businessVersion, request.action,
        input.taskId, input.deadlineAt, JSON.stringify({ purpose: 'admin-provider-test', requestHash: input.expectedHash }),
        ctx.correlationId, admitted.profileId, admitted.profileRevision, JSON.stringify({ [admitted.bindingSlot]: targetBinding }),
        JSON.stringify(request.artifactIds.map((artifactId) => ({ artifactId, role: 'input' }))),
        JSON.stringify(admitted.profilePolicySnapshot), request.endpointSlug],
    );
    await client.query(
      `INSERT INTO tasks (id,operation_id,task_key,kind,payload_ref,state,attempt,max_attempts,due_at)
       VALUES ($1,$2,'admin-provider-test','admin-provider-test',$3,'RUNNING',1,1,now())`,
      [input.taskId, input.operationId, JSON.stringify({ purpose: 'admin-provider-test', requestHash: input.expectedHash })],
    );
    await client.query(
      `INSERT INTO admin_connector_test_runs
        (tenant_id,api_key_id,profile_id,business_id,business_version,endpoint_slug,connector_id,connector_revision,
         operation_id,task_id,invocation_id,budget_reservation_group_id,idempotency_hash,request_hash,state,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'RUNNING',$15)`,
      [request.tenantId, request.apiKeyId, admitted.profileId, request.businessId, request.businessVersion, request.endpointSlug,
        request.connectorId, request.revision, input.operationId, input.taskId, input.invocationId,
        input.reservationGroupId, input.idempotencyHash, input.expectedHash, actor.actor],
    );
    await ctx.audit.record({
      tenantId: request.tenantId,
      ...actor,
      action: 'admin_connector_provider_test.accept',
      resource: `connector:${request.connectorId}@${request.revision}`,
      severity: 'info',
      correlationId: ctx.correlationId,
    }, client);
    return { existing: null };
  });
}

async function updateProviderTestRun(
  ctx: RouteContext,
  input: { tenantId: string; operationId: string; taskId: string; invocationId: string; result: ProviderTestResult; evidence?: ConnectorProviderTestEvidence },
): Promise<void> {
  const result = redactProviderTestResult(input.result);
  const state = result.state;
  const operationState = state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
  const taskState = state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
  const evidence = input.evidence && input.evidence.recoveryReady
    ? { stateVersion: input.evidence.stateVersion, evidenceDigest: input.evidence.evidenceDigest, eventId: input.evidence.usageEvent?.eventId ?? null }
    : [];
  await ctx.db.tx(async (client) => {
    const run = await client.query<{ state: string; state_version: number; result: unknown; operation_id: string; task_id: string }>(
      `SELECT state,state_version,result,operation_id,task_id FROM admin_connector_test_runs
        WHERE tenant_id=$1 AND invocation_id=$2 FOR UPDATE`,
      [input.tenantId, input.invocationId],
    );
    const current = run.rows[0];
    if (!current || current.operation_id !== input.operationId || current.task_id !== input.taskId) {
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run pins changed before settlement');
    }
    const taskRow = await client.query<{ state: string; error_code: string | null }>(
      `SELECT state,error_code FROM tasks WHERE id=$1 AND operation_id=$2 FOR UPDATE`,
      [input.taskId, input.operationId],
    );
    const operationRow = await client.query<{ state: string; state_version: number; error_code: string | null }>(
      `SELECT state,state_version,error_code FROM operations WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [input.operationId, input.tenantId],
    );
    const taskSource = taskRow.rows[0];
    const operationSource = operationRow.rows[0];
    if (!taskSource || !operationSource) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test task or operation was not found during settlement');
    if (current.state === state) {
      const currentResult = ProviderTestResultSchema.safeParse(current.result);
      const settledConsistently = taskSource.state === taskState && taskSource.error_code === result.errorCode
        && operationSource.state === operationState && operationSource.error_code === result.errorCode;
      if (currentResult.success && canonicalize(redactProviderTestResult(currentResult.data)) === canonicalize(result) && settledConsistently) return;
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test result conflicts with the recorded settlement');
    }
    if (current.state !== 'RUNNING' && current.state !== 'UNKNOWN') {
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run is already settled');
    }
    const recoveringUnknown = current.state === 'UNKNOWN' && state === 'SUCCEEDED';
    const sourceState = recoveringUnknown ? 'FAILED' : 'RUNNING';
    const sourceError = recoveringUnknown ? 'INVOCATION_UNKNOWN' : null;
    if (taskSource.state !== sourceState || taskSource.error_code !== sourceError
        || operationSource.state !== sourceState || operationSource.error_code !== sourceError) {
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test task or operation diverged from its guarded source state');
    }
    if (recoveringUnknown && (!input.evidence?.recoveryReady || !input.evidence.result || !input.evidence.usageEvent
        || input.evidence.invocationId !== input.invocationId || input.evidence.operationId !== input.operationId
        || input.evidence.taskId !== input.taskId || input.evidence.usageEvent.eventId !== result.usageEventId
        || input.evidence.tenantId !== input.tenantId || input.evidence.state !== 'SUCCEEDED')) {
      throw new HttpError(409, 'EVIDENCE_REQUIRED', 'UNKNOWN can become successful only with matching persisted Connector evidence');
    }
    const runUpdate = await client.query(
      `UPDATE admin_connector_test_runs SET state=$3,state_version=state_version+1,result=$4,evidence=$5,updated_at=now()
        WHERE tenant_id=$1 AND invocation_id=$2 AND state=$6 AND state_version=$7`,
      [input.tenantId, input.invocationId, state, JSON.stringify(result), JSON.stringify(evidence), current.state, current.state_version],
    );
    if (runUpdate.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run changed during settlement');
    const task = await client.query(
      `UPDATE tasks SET state=$2,error_code=$3,updated_at=now()
        WHERE id=$1 AND operation_id=$4 AND state=$5 AND error_code IS NOT DISTINCT FROM $6`,
      [input.taskId, taskState, result.errorCode, input.operationId, sourceState, sourceError],
    );
    if (task.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test task changed during settlement');
    const operation = await client.query(
      `UPDATE operations SET state=$2,state_version=state_version+1,error_code=$3,completed_at=now(),updated_at=now()
        WHERE id=$1 AND tenant_id=$4 AND state=$5 AND state_version=$6 AND error_code IS NOT DISTINCT FROM $7`,
      [input.operationId, operationState, result.errorCode, input.tenantId, sourceState, operationSource.state_version, sourceError],
    );
    if (operation.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test operation changed during settlement');
    if (recoveringUnknown) {
      await ctx.audit.record({ tenantId: input.tenantId, actor: 'connector-ledger', actorRole: 'SYSTEM',
        action: 'admin_connector_provider_test.reconcile_success', resource: `invocation:${input.invocationId}`,
        severity: 'success', correlationId: ctx.correlationId }, client);
    }
  });
}

async function markUnknown(ctx: RouteContext, input: { tenantId: string; operationId: string; taskId: string; invocationId: string }): Promise<ProviderTestResult> {
  const result = unknownResult(input.invocationId);
  await ctx.db.tx(async (client) => {
    const run = await client.query<{ state: string; state_version: number }>(
      `SELECT state,state_version FROM admin_connector_test_runs WHERE tenant_id=$1 AND invocation_id=$2 FOR UPDATE`,
      [input.tenantId, input.invocationId],
    );
    const current = run.rows[0];
    if (!current) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run was not found during UNKNOWN reconciliation');
    if (current.state === 'UNKNOWN') return;
    if (current.state !== 'RUNNING') throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run is already settled');
    const taskSource = await client.query<{ state: string; error_code: string | null }>(
      `SELECT state,error_code FROM tasks WHERE id=$1 AND operation_id=$2 FOR UPDATE`,
      [input.taskId, input.operationId],
    );
    const operationSource = await client.query<{ state: string; state_version: number; error_code: string | null }>(
      `SELECT state,state_version,error_code FROM operations WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [input.operationId, input.tenantId],
    );
    if (taskSource.rows[0]?.state !== 'RUNNING' || taskSource.rows[0]?.error_code !== null
        || operationSource.rows[0]?.state !== 'RUNNING' || operationSource.rows[0]?.error_code !== null) {
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test task or operation diverged before UNKNOWN was recorded');
    }
    const runUpdate = await client.query(
      `UPDATE admin_connector_test_runs SET state='UNKNOWN',state_version=state_version+1,result=$3,updated_at=now()
        WHERE tenant_id=$1 AND invocation_id=$2 AND state='RUNNING' AND state_version=$4`,
      [input.tenantId, input.invocationId, JSON.stringify(result), current.state_version],
    );
    if (runUpdate.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test run changed during UNKNOWN reconciliation');
    // UNKNOWN is represented as a terminal failed synthetic task/operation so
    // ordinary queue workers can never pick up and retry the test.
    const task = await client.query(`UPDATE tasks SET state='FAILED',error_code='INVOCATION_UNKNOWN',updated_at=now() WHERE id=$1 AND operation_id=$2 AND state='RUNNING' AND error_code IS NULL`, [input.taskId, input.operationId]);
    if (task.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test task changed before UNKNOWN was recorded');
    const operation = await client.query(`UPDATE operations SET state='FAILED',state_version=state_version+1,error_code='INVOCATION_UNKNOWN',completed_at=now(),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='RUNNING' AND state_version=$3 AND error_code IS NULL`, [input.operationId, input.tenantId, operationSource.rows[0]!.state_version]);
    if (operation.rowCount !== 1) throw new HttpError(409, 'STATE_CONFLICT', 'provider-test operation changed before UNKNOWN was recorded');
  });
  return result;
}

async function readRecovery(ctx: RouteContext, row: ExistingRun, tenantId: string): Promise<ConnectorProviderTestEvidence | undefined> {
  if (!ctx.connectorManagement) return undefined;
  try {
    return await ctx.connectorManagement.getProviderTestEvidence({
      tenantId,
      operationId: row.operation_id,
      taskId: row.task_id,
      invocationId: row.invocation_id,
      connectorId: row.connector_id,
      revision: row.connector_revision,
    });
  } catch {
    return undefined;
  }
}

async function readExistingIdempotentRun(
  ctx: RouteContext,
  auth: AdminActionAuth,
  request: ProviderTestRequest,
  expectedRequestHash: string,
  idempotencyHash: string,
): Promise<ProviderTestResult | null> {
  const result = await ctx.db.query<ExistingRun>(
    `SELECT api_key_id,profile_id,operation_id,task_id,invocation_id,connector_id,connector_revision,
            state,state_version,result,request_hash
       FROM admin_connector_test_runs WHERE tenant_id=$1 AND idempotency_hash=$2`,
    [request.tenantId, idempotencyHash],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.request_hash !== expectedRequestHash) {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different provider-test request');
  }
  await ctx.db.tx((client) => validateLocalHistoryAccess(client, auth, {
    tenantId: request.tenantId,
    apiKeyId: existing.api_key_id,
    profileId: existing.profile_id,
  }));
  if (existing.state === 'SUCCEEDED' || existing.state === 'FAILED' || existing.state === 'BLOCKED') {
    return resultForRun(existing) ?? unknownResult(existing.invocation_id);
  }
  const evidence = await readRecovery(ctx, existing, request.tenantId);
  const recovered = evidence ? recoverProviderTestResult(evidence) : null;
  if (recovered) {
    try {
      await updateProviderTestRun(ctx, {
        tenantId: request.tenantId,
        operationId: existing.operation_id,
        taskId: existing.task_id,
        invocationId: existing.invocation_id,
        result: recovered,
        evidence,
      });
    } catch {
      const latest = await ctx.db.query<ExistingRun>(
        `SELECT api_key_id,profile_id,operation_id,task_id,invocation_id,connector_id,connector_revision,
                state,state_version,result,request_hash FROM admin_connector_test_runs
          WHERE tenant_id=$1 AND invocation_id=$2`,
        [request.tenantId, existing.invocation_id],
      );
      const latestRow = latest.rows[0];
      if (latestRow?.state === 'SUCCEEDED' && resultForRun(latestRow)) return resultForRun(latestRow);
      throw new HttpError(409, 'STATE_CONFLICT', 'provider-test evidence could not be reconciled against its current run version');
    }
    return recovered;
  }
  // A concurrent original request may still be completing. This duplicate
  // observes UNKNOWN to the caller but never changes a live run or retries it.
  return unknownResult(existing.invocation_id);
}

/**
 * Run one real Connector invocation after ordinary profile/key/action/artifact
 * admission. This leaf never reads provider credentials or calls a provider
 * URL; Connector is the sole credential and transport owner.
 */
export async function runConnectorProviderTest(ctx: RouteContext, auth: AdminActionAuth, value: unknown): Promise<ProviderTestResult> {
  const parsed = ProviderTestRequestSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'provider-test request is invalid or exceeds its bounds');
  const request = parsed.data;
  if (!ctx.connectorManagement) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector management is unavailable');
  if (!ctx.config.invocationGrantSecret || Buffer.byteLength(ctx.config.invocationGrantSecret) < 32) {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector invocation grant signing is unavailable');
  }

  const principal = adminWorkbenchPrincipal(auth);
  if (principal.role === 'tenant_operator' && principal.tenantId !== request.tenantId) {
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
  const { idempotencyKey, ...requestParts } = request;
  const requestHash = digest(canonicalize(requestParts));
  const idemHash = digest(idempotencyKey);
  const existing = await readExistingIdempotentRun(ctx, auth, request, requestHash, idemHash);
  if (existing) return existing;

  const target = await ctx.connectorManagement.getRecipeRevision({ tenantId: request.tenantId, connectorId: request.connectorId, revision: request.revision });
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'tenant-owned Connector revision was not found');
  const pendingCandidate = target.state === 'PENDING';
  assertProviderTestRevisionAccess(auth, { revisionState: target.state, ...(request.bindingSlot ? { bindingSlot: request.bindingSlot } : {}) });

  const admitted = await ctx.submission.admitProviderTest({
    tenantId: request.tenantId,
    apiKeyId: request.apiKeyId,
    profileId: request.profileId,
    expectedProfileRevision: request.expectedProfileRevision,
    businessId: request.businessId,
    businessVersion: request.businessVersion,
    action: request.action,
    endpointSlug: request.endpointSlug,
    connectorId: request.connectorId,
    ...(pendingCandidate ? { candidateBindingSlot: request.bindingSlot!, candidateConnectorRevision: request.revision } : {}),
    ...(request.model === undefined ? {} : { model: request.model }),
    parameters: request.parameters,
    artifactIds: request.artifactIds,
  });
  if (admitted.tenantId !== request.tenantId || admitted.profileId !== request.profileId
      || admitted.apiKeyId !== request.apiKeyId || admitted.profileRevision !== request.expectedProfileRevision) {
    throw new HttpError(409, 'ADMISSION_CHANGED', 'Provider-test admission no longer matches the selected key and Profile');
  }
  const binding = admitted.connectorBindings[admitted.bindingSlot];
  if (!binding || binding.connectorId !== request.connectorId || binding.revision !== request.revision) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'selected Connector revision does not match the admitted Profile binding or test-only candidate overlay');
  }
  const localActor = trustedLocalAdminWorkbenchActor(auth);
  if (localActor && target.state !== 'ACTIVE') throw new HttpError(403, 'PERMISSION_DENIED', 'local USER may test only the exact active assigned Profile binding');
  await assertAdminWorkbenchAdmissionScope(ctx.identity, auth, {
    tenantId: request.tenantId,
    apiKeyId: request.apiKeyId,
    profileId: admitted.profileId,
  });

  const artifactRead = await ctx.artifacts.readInvocationArtifacts({ tenantId: request.tenantId, artifactIds: request.artifactIds });
  const admittedArtifacts = new Map(admitted.artifacts.map((item) => [item.artifactId, item]));
  if (artifactRead.contents.length !== request.artifactIds.length || artifactRead.pins.length !== request.artifactIds.length
      || artifactRead.contents.some((item) => admittedArtifacts.get(item.artifactId)?.fileName !== item.fileName
        || item.integrity.verified !== true
        || admittedArtifacts.get(item.artifactId)?.sizeBytes !== item.integrity.databaseMetadata.sizeBytes)) {
    throw new HttpError(409, 'ARTIFACT_CHANGED', 'Provider-test artifact pins changed after admission');
  }

  const { artifactIds: _artifactIds, ...effectiveParameters } = admitted.effectiveInput;
  void _artifactIds;
  const { artifacts, artifactPins } = projectProviderTestArtifactRead(artifactRead);
  const invocationInput = InvocationInputSchema.parse({ prompt: request.prompt, parameters: effectiveParameters, ...(artifacts.length ? { artifacts } : {}) });
  const policyModel = admitted.profilePolicySnapshot.parameters['model'];
  const pinnedModel = policyModel && typeof policyModel.value === 'string' && policyModel.isLocked === true
    ? policyModel.value
    : undefined;
  const model = request.model ?? pinnedModel ?? (typeof effectiveParameters['model'] === 'string' ? effectiveParameters['model'] : undefined);
  const options = model === undefined ? undefined : { model };
  const operationId = randomUUID();
  const taskId = randomUUID();
  const invocationId = randomUUID();
  const stepKey = `admin-provider-test:${request.endpointSlug}`;
  const deadlineAt = new Date(Date.now() + request.timeoutMs).toISOString();
  const costContext = createInvocationCostContext({
    tenantId: request.tenantId,
    operationId,
    taskId,
    stepKey,
    bindingSlot: admitted.bindingSlot,
    invocationId,
    attempt: 1,
    apiKeyId: admitted.apiKeyId,
    profileId: admitted.profileId,
    profileRevision: admitted.profileRevision,
    businessId: admitted.businessId,
    businessVersion: admitted.businessVersion,
    action: admitted.action,
  });
  const invocationHash = hashInvocationInput({
    contractVersion: '1', tenantId: request.tenantId, operationId, taskId, stepKey,
    bindingSlot: admitted.bindingSlot, input: invocationInput, options, deadlineAt,
    purpose: 'admin-provider-test',
  });
  const now = Math.floor(Date.now() / 1000);
  const grant = signProviderTestGrant({
    audience: 'connector',
    purpose: 'admin-provider-test',
    tenantId: request.tenantId,
    apiKeyId: admitted.apiKeyId,
    profileId: admitted.profileId,
    businessId: admitted.businessId,
    businessVersion: admitted.businessVersion,
    endpointSlug: admitted.endpointSlug,
    connectorId: request.connectorId,
    connectorRevision: request.revision,
    revisionState: target.state,
    operationId,
    taskId,
    invocationId,
    inputHash: invocationHash,
    bindingSlot: admitted.bindingSlot,
    reservationGroupId: costContext.budgetReservationGroupId,
    costContext,
    ...(model === undefined ? {} : { allowedModel: model }),
    artifactIds: request.artifactIds,
    artifactPins,
    iat: now,
    exp: now + GRANT_SECONDS,
  }, ctx.config.invocationGrantSecret);

  const accepted = await reserveProviderTestRun(ctx, auth, request, admitted, {
    expectedHash: requestHash,
    idempotencyHash: idemHash,
    invocationId,
    operationId,
    taskId,
    reservationGroupId: costContext.budgetReservationGroupId,
    deadlineAt,
  });

  if (accepted.existing) {
    const existing = accepted.existing;
    if (existing.state === 'SUCCEEDED' || existing.state === 'FAILED' || existing.state === 'BLOCKED') {
      return resultForRun(existing) ?? unknownResult(existing.invocation_id);
    }
    const evidence = await readRecovery(ctx, existing, request.tenantId);
    const recovered = evidence ? recoverProviderTestResult(evidence) : null;
    if (recovered) {
      await updateProviderTestRun(ctx, { tenantId: request.tenantId, operationId: existing.operation_id, taskId: existing.task_id, invocationId: existing.invocation_id, result: recovered, evidence });
      return recovered;
    }
    return unknownResult(existing.invocation_id);
  }

  try {
    const response = await ctx.connectorManagement.invokeProviderTest({ grant, input: invocationInput, deadlineAt });
    const safeResponse = redactProviderTestResult(response);
    if (safeResponse.invocationId !== invocationId) throw new Error('connector invocation id mismatch');
    if (safeResponse.state === 'UNKNOWN' || (safeResponse.state === 'SUCCEEDED' && safeResponse.usageEventId === null)) {
      const evidence = await ctx.connectorManagement.getProviderTestEvidence({
        tenantId: request.tenantId, operationId, taskId, invocationId, connectorId: request.connectorId, revision: request.revision,
      }).catch(() => undefined);
      const recovered = evidence ? recoverProviderTestResult(evidence) : null;
      if (recovered) {
        await updateProviderTestRun(ctx, { tenantId: request.tenantId, operationId, taskId, invocationId, result: recovered, evidence });
        return recovered;
      }
      return await markUnknown(ctx, { tenantId: request.tenantId, operationId, taskId, invocationId });
    }
    await updateProviderTestRun(ctx, { tenantId: request.tenantId, operationId, taskId, invocationId, result: safeResponse });
    return safeResponse;
  } catch {
    const evidence = await ctx.connectorManagement.getProviderTestEvidence({
      tenantId: request.tenantId, operationId, taskId, invocationId, connectorId: request.connectorId, revision: request.revision,
    }).catch(() => undefined);
    const recovered = evidence ? recoverProviderTestResult(evidence) : null;
    if (recovered) {
      await updateProviderTestRun(ctx, { tenantId: request.tenantId, operationId, taskId, invocationId, result: recovered, evidence });
      return recovered;
    }
    return await markUnknown(ctx, { tenantId: request.tenantId, operationId, taskId, invocationId });
  }
}
