import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { conflict, notFound } from '../../http/errors';
import type { MetadataCrypto, MetadataSlot } from '../runtime/metadata-crypto';
import { compatibilityMetadataReader, type MetadataReader } from '../encryption/metadata-read-policy';

/** Retry is a fresh execution of the original pinned request, never a reset. */
export async function retryOperation(
  client: PoolClient, operationId: string, tenantId: string,
  crypto?: MetadataCrypto, reader: MetadataReader = compatibilityMetadataReader(crypto),
): Promise<Record<string, unknown>> {
  const rows = await client.query('SELECT * FROM operations WHERE id=$1 FOR UPDATE', [operationId]);
  const op = rows.rows[0] as Record<string, unknown> | undefined;
  if (!op || op.tenant_id !== tenantId) throw notFound('operation not found');
  if (!['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(op.state))) {
    throw conflict('STATE_CONFLICT', 'retry requires a failed, stopped or timed-out operation');
  }
  const root = await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [op.root_task_id]);
  const task = root.rows[0] as Record<string, unknown> | undefined;
  if (!task || op.input_ref == null) throw conflict('RETRY_INPUT_UNAVAILABLE', 'original request input is unavailable');
  const open = async (value: unknown, slot: MetadataSlot, refId: string): Promise<unknown> =>
    reader.readStored(value, { tenantId, slot, refId });
  const input = await open(op.input_ref, 'operations.input_ref', operationId);
  const payload = await open(task.payload_ref, 'tasks.payload_ref', String(task.id));
  const pendingSource = typeof payload === 'object' && payload !== null
    && (payload as Record<string, unknown>).ingestionState === 'PENDING'
    && typeof (payload as Record<string, unknown>).sourceUrl === 'string'
    ? (payload as Record<string, unknown>).sourceUrl as string : undefined;

  // A deleted/expired cached input cannot silently become an empty request.
  const artifactIds = new Set<string>();
  const scan = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(scan); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.artifactId === 'string') artifactIds.add(record.artifactId);
    Object.values(record).forEach(scan);
  };
  scan(input); scan(op.submit_artifacts);
  const source = typeof input === 'object' && input !== null
    ? ((input as Record<string, unknown>).source ?? (input as Record<string, unknown>).__source) : null;
  if (typeof source === 'object' && source !== null && 'storageKey' in source && 'versionId' in source) {
    const pin = source as Record<string, unknown>;
    const cached = await client.query(
      "SELECT id FROM artifacts WHERE tenant_id=$1 AND storage_key=$2 AND storage_version_id=$3 AND state='READY' AND (expires_at IS NULL OR expires_at>now()) FOR SHARE",
      [tenantId, pin.storageKey, pin.versionId],
    );
    if (!cached.rowCount) throw conflict('RETRY_INPUT_UNAVAILABLE', 'cached source has expired or is unavailable; submit a new request');
  }
  for (const id of artifactIds) {
    const artifact = await client.query(
      "SELECT id FROM artifacts WHERE id=$1 AND tenant_id=$2 AND state='READY' AND (expires_at IS NULL OR expires_at>now()) FOR SHARE",
      [id, tenantId],
    );
    if (!artifact.rowCount) throw conflict('RETRY_INPUT_UNAVAILABLE', 'request input has expired or is unavailable; submit a new request');
  }
  // Coalesce double clicks/concurrent retries while the child is active.
  const existing = await client.query(
    "SELECT id, state FROM operations WHERE retry_of=$1 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') ORDER BY created_at DESC LIMIT 1", [operationId],
  );
  if (existing.rowCount) return { operationId: existing.rows[0].id, state: existing.rows[0].state, retryOf: operationId, replayed: true };

  const newId = randomUUID();
  const taskId = randomUUID();
  const correlationId = randomUUID();
  const seal = async (value: unknown, slot: MetadataSlot, refId: string): Promise<string> =>
    JSON.stringify(crypto ? await crypto.seal(value, { tenantId, slot, refId }) : value);
  const sealedInput = await seal(input, 'operations.input_ref', newId);
  const sealedPayload = await seal(pendingSource ? { input, sourceUrl: pendingSource, ingestionState: 'PENDING' } : input, 'tasks.payload_ref', taskId);
  const prompts = op.prompt_overrides_ref == null ? null
    : await seal(await open(op.prompt_overrides_ref, 'operations.prompt_overrides_ref', operationId), 'operations.prompt_overrides_ref', newId);
  const state = pendingSource ? 'PENDING_INGESTION' : 'ACCEPTED';
  await client.query(
    `INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,root_task_id,input_ref,
      correlation_id,callback_url,profile_id,profile_revision,connector_bindings,submit_artifacts,profile_policy_snapshot,
      callback_policy,prompt_revisions_pin,prompt_overrides_ref,retry_of,deadline_at)
     SELECT $2,tenant_id,api_key_id,business_id,business_version,action,$3,$4,$5,$6,callback_url,profile_id,profile_revision,
       connector_bindings,submit_artifacts,profile_policy_snapshot,callback_policy,prompt_revisions_pin,$7,id,
       CASE WHEN deadline_at>created_at THEN now()+(deadline_at-created_at) ELSE NULL END
     FROM operations WHERE id=$1`,
    [operationId, newId, state, taskId, sealedInput, correlationId, prompts],
  );
  await client.query(
    `INSERT INTO tasks (id,operation_id,task_key,kind,payload_ref,state,max_attempts,due_at)
     VALUES ($1,$2,'root',$3,$4,$5,$6,now())`,
    [taskId, newId, task.kind, sealedPayload, pendingSource ? 'PENDING_INGESTION' : 'READY', task.max_attempts],
  );
  const originalDispatch = await client.query(
    "SELECT payload FROM outbox WHERE aggregate_id=$1 AND type='task.dispatch' ORDER BY created_at ASC LIMIT 1", [task.id],
  );
  const original = originalDispatch.rows[0]?.payload as Record<string, unknown> | undefined;
  await client.query(
    "INSERT INTO outbox (aggregate_id,type,delivery_id,payload) VALUES ($1,'task.dispatch',$2,$3)",
    [taskId, `${taskId}:initial`, JSON.stringify({ contractVersion: '1', deliveryId: `${taskId}:initial`, taskId,
      operationId: newId, businessId: op.business_id, businessVersion: op.business_version, action: op.action,
      kind: task.kind, correlationId, priority: original?.priority,
      gate: pendingSource ? 'ingestion' : undefined,
      sourceUrl: pendingSource ? (crypto ? await crypto.seal(pendingSource, { tenantId, slot: 'tasks.payload_ref', refId: taskId }) : pendingSource) : undefined,
    })],
  );
  return { operationId: newId, state, retryOf: operationId, replayed: false };
}
