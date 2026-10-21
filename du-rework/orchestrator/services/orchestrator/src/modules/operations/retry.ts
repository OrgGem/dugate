import { assertKeySpendAvailable } from '../usage/spend-admission';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { conflict, notFound } from '../../http/errors';
import type { MetadataCrypto, MetadataSlot } from '../runtime/metadata-crypto';
import { compatibilityMetadataReader, type MetadataReader } from '../encryption/metadata-read-policy';
import { admissionReasonForVersion, readBusinessAdmission } from '../registry/version-admission';
import { resolveRootGrant } from '../profiles/profile-groups';

/**
 * PC-07 — retry is a fresh execution of the ORIGINAL pinned request, never a
 * reset. Three rules make that safe:
 *
 *  1. Reauthorization happens before the coalesced-replay check AND again
 *     before the insert, against CURRENT authority (never the pinned grant).
 *     A revoked key, a revoked root grant or a disabled group function denies
 *     the retry instead of resurrecting the old authorization.
 *  2. Every encrypted carrier is opened under the OLD AAD and re-sealed under
 *     the NEW one. Ciphertext is never copied between rows: the AAD binds an
 *     envelope to (tenant, slot, row id), so a copied envelope would either
 *     fail to open or — worse — open for the wrong row.
 *  3. Unknown provider outcomes stay blocked, and in-flight operations keep
 *     running on their pinned snapshots.
 */

/** Authorization failures the retry surface can answer with (409). */
export const RETRY_AUTHORIZATION_CODES = {
  /** The owning API key no longer exists, or the operation never recorded one. */
  KEY_INACTIVE: 'KEY_INACTIVE',
  /** The owning API key was globally revoked. */
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  /** The key's profile-group root grant is gone / revoked / not GROUP_GRANT. */
  GRANT_REVOKED: 'GRANT_REVOKED',
  /** The pinned function was removed from, or disabled in, the current group config. */
  ENDPOINT_DISABLED: 'ENDPOINT_DISABLED',
} as const;
export type RetryAuthorizationCode =
  (typeof RETRY_AUTHORIZATION_CODES)[keyof typeof RETRY_AUTHORIZATION_CODES];

const KEY_MODE_GROUP_MANAGED = 'GROUP_MANAGED';

export interface RetryKeyAuthorization {
  readonly apiKeyId: string;
  readonly tenantId: string;
  /** `GROUP_MANAGED` | `LEGACY_STANDALONE` | `UNMANAGED_LEGACY`. */
  readonly keyMode: 'GROUP_MANAGED' | 'LEGACY_STANDALONE' | 'UNMANAGED_LEGACY';
  /** Non-null only for a group-managed retry resolved through a live grant. */
  readonly group?: {
    groupId: string;
    groupRevision: number;
    accessVersion: number;
    functionId: string;
    childProfileId: string;
  };
}

function retryDenied(code: RetryAuthorizationCode, detail: string) {
  return conflict(code, detail);
}

/* ------------------------------------------------------------------ */
/* PC-R03: the retry lock protocol                                    */
/* ------------------------------------------------------------------ */
/**
 * Retry admission and every authority change share ONE lock order:
 *
 *   group root → business selector → key row → grant row → operation/task
 *
 * Revocation paths already obey it:
 *   - `revokeGroupGrant`            : group FOR UPDATE → grant FOR UPDATE
 *   - `revokeAllGroupGrantsForApiKey`: group FOR UPDATE (per group) → key FOR UPDATE
 *   - group save / conversion       : group FOR UPDATE first
 *
 * so a retry that takes the same prefix can never deadlock with them, and no
 * revocation can commit between its authorization read and its INSERT.
 *
 * The three helpers below acquire that prefix. They are deliberately small and
 * explicit: a shared helper that "knew" about authority would be a second
 * authorization implementation, and the whole point of the packet is that the
 * decision comes from `authorizeRetry` under these locks.
 *
 * FOR SHARE (not FOR UPDATE) on purpose: it conflicts with each writer's
 * FOR UPDATE, which is all the serialization the retry needs, while two
 * independent retries of different operations do not queue behind each other.
 */

/** Lock 1 — the profile-group root, before ANY other row lock. */
async function lockRetryGroupRoot(
  client: PoolClient,
  groupId: string,
  tenantId: string,
): Promise<void> {
  const locked = await client.query(
    'SELECT group_id FROM profile_groups WHERE group_id=$1 AND tenant_id=$2 FOR SHARE',
    [groupId, tenantId],
  );
  if (!locked.rowCount) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
      'the profile group that authorized this operation no longer exists',
    );
  }
}

/** Lock 3 — the owning API-key row, after the business selector. */
async function lockRetryKeyRow(
  client: PoolClient,
  preflight: RetryKeyAuthorization,
): Promise<void> {
  const locked = await client.query<{ status: string; key_mode: string | null }>(
    'SELECT status, key_mode FROM api_keys WHERE id=$1 FOR SHARE',
    [preflight.apiKeyId],
  );
  const row = locked.rows[0];
  if (!row) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.KEY_INACTIVE,
      'the API key that owns this operation no longer exists',
    );
  }
  if (row.status !== 'ACTIVE') {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.API_KEY_REVOKED,
      'the API key that owns this operation is revoked',
    );
  }
  const mode: RetryKeyAuthorization['keyMode'] =
    row.key_mode === KEY_MODE_GROUP_MANAGED
      ? 'GROUP_MANAGED'
      : row.key_mode === 'UNMANAGED_LEGACY'
        ? 'UNMANAGED_LEGACY'
        : 'LEGACY_STANDALONE';
  if (mode !== preflight.keyMode) {
    // A conversion flipped the key between the unlocked preflight and this
    // lock. The retry did NOT take a group lock (the preflight saw a legacy
    // key), so continuing would authorize without the group root. Fail closed
    // and let the caller retry against the new state.
    throw conflict(
      'STATE_CONFLICT',
      'retry authorization changed while locks were being acquired; retry the request',
    );
  }
}

/** An in-flight execution of the same original operation, if one exists. */
const IN_FLIGHT_RETRY_SQL =
  "SELECT id, state FROM operations WHERE retry_of=$1 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') ORDER BY created_at DESC LIMIT 1";

/**
 * Finding 5 — answer a coalesced retry under the locks, before the expired-input
 * checks, so a second click returns the in-flight execution instead of
 * `RETRY_INPUT_UNAVAILABLE` just because the ORIGINAL input expired.
 *
 * It is not a shortcut around PC-R03: the full lock prefix is taken in order and
 * the caller is reauthorized under it, so a revoked grant still denies
 * immediately. Only the cheap replay read is answered early.
 */
async function replayCoalescedRetryUnderLock(
  client: PoolClient,
  preflight: RetryKeyAuthorization,
  op: Record<string, unknown>,
  operationId: string,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  if (preflight.group) await lockRetryGroupRoot(client, preflight.group.groupId, tenantId);
  await readBusinessAdmission(client, String(op.business_id), String(op.business_version), 'UPDATE');
  await lockRetryKeyRow(client, preflight);
  await lockRetryGrantRow(client, preflight, tenantId);
  const lockedRows = await client.query('SELECT * FROM operations WHERE id=$1 FOR UPDATE', [operationId]);
  const lockedOp = lockedRows.rows[0] as Record<string, unknown> | undefined;
  if (!lockedOp || lockedOp.tenant_id !== tenantId) throw notFound('operation not found');
  // Current authority first: a revoked key or grant never reaches the replay.
  await authorizeRetry(client, lockedOp, tenantId);
  const existing = await client.query(IN_FLIGHT_RETRY_SQL, [operationId]);
  const row = existing.rows[0] as { id: string; state: string } | undefined;
  if (!row) return null;
  return { operationId: row.id, state: row.state, retryOf: operationId, replayed: true };
}

/** Lock 4 — the root grant row, after the key row and before the operation. */
async function lockRetryGrantRow(
  client: PoolClient,
  preflight: RetryKeyAuthorization,
  tenantId: string,
): Promise<void> {
  const group = preflight.group;
  if (!group) return;
  const locked = await client.query<{ state: string }>(
    `SELECT state FROM profile_group_api_keys
      WHERE api_key_id=$1 AND group_id=$2 AND tenant_id=$3
      FOR SHARE`,
    [preflight.apiKeyId, group.groupId, tenantId],
  );
  if (!locked.rows[0] || locked.rows[0].state !== 'ACTIVE') {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
      'the retry key no longer holds an ACTIVE profile-group grant',
    );
  }
}

/**
 * Current-authority reauthorization for a retry.
 *
 * Reads only: it must be callable both before the coalesced-replay check (so a
 * denied caller never learns whether a sibling execution exists) and again
 * under the operation lock before the insert.
 */
export async function authorizeRetry(
  client: PoolClient,
  op: Record<string, unknown>,
  tenantId: string,
): Promise<RetryKeyAuthorization> {
  const apiKeyId = typeof op.api_key_id === 'string' && op.api_key_id.length > 0
    ? op.api_key_id
    : null;
  if (apiKeyId === null) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.KEY_INACTIVE,
      'the operation has no recorded owner API key; retry cannot reauthorize it',
    );
  }

  const keyRes = await client.query<{
    id: string;
    tenant_id: string;
    status: string;
    key_mode: string | null;
  }>('SELECT id, tenant_id, status, key_mode FROM api_keys WHERE id=$1', [apiKeyId]);
  const key = keyRes.rows[0];
  if (!key) {
    // Unknown and foreign keys are the same answer: the operation lookup already
    // fenced the tenant, so this cannot become a cross-tenant oracle.
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.KEY_INACTIVE,
      'the API key that owns this operation no longer exists',
    );
  }
  if (key.tenant_id !== tenantId) throw notFound('operation not found');
  if (key.status !== 'ACTIVE') {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.API_KEY_REVOKED,
      'the API key that owns this operation is revoked',
    );
  }

  // An unknown mode is not a reason to skip authority: it means the key was
  // never classified, which is only reachable for pre-0070 rows or fixtures.
  // Those keys have always been standalone, so they take the legacy branch —
  // the same authority that admitted the original operation.
  const keyMode: RetryKeyAuthorization['keyMode'] =
    key.key_mode === KEY_MODE_GROUP_MANAGED
      ? 'GROUP_MANAGED'
      : key.key_mode === 'UNMANAGED_LEGACY'
        ? 'UNMANAGED_LEGACY'
        : 'LEGACY_STANDALONE';

  if (keyMode === KEY_MODE_GROUP_MANAGED) {
    const grant = await resolveRootGrant(client as never, apiKeyId, tenantId);
    if (!grant) {
      throw retryDenied(
        RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
        'the retry key no longer holds an ACTIVE profile-group grant',
      );
    }
    const group = await readCurrentGroupFunction(client, grant.groupId, tenantId, op);
    await assertKeySpendAvailable(client, apiKeyId, tenantId);
    return {
      apiKeyId,
      tenantId,
      keyMode,
      group: {
        groupId: grant.groupId,
        groupRevision: group.groupRevision,
        accessVersion: grant.accessVersion,
        functionId: group.functionId,
        childProfileId: group.childProfileId,
      },
    };
  }

  // Legacy standalone / unmanaged: the same two facts that admitted the
  // original operation — the profile membership (when one was pinned) and the
  // key's spend admission.
  const profileId = typeof op.profile_id === 'string' ? op.profile_id : null;
  if (profileId !== null) {
    const membership = await client.query(
      `SELECT 1 FROM profile_api_keys
        WHERE profile_id=$1 AND api_key_id=$2 AND tenant_id=$3 AND state='ACTIVE'`,
      [profileId, apiKeyId, tenantId],
    );
    if (!membership.rowCount) {
      throw retryDenied(
        RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
        'the legacy profile membership for the retry key is revoked',
      );
    }
  }
  await assertKeySpendAvailable(client, apiKeyId, tenantId);
  return { apiKeyId, tenantId, keyMode };
}

/**
 * The function must still exist, match the operation's selector and be enabled
 * in the group's CURRENT active revision. A retry that survived a config edit
 * would otherwise execute a function nobody authorizes any more.
 */
async function readCurrentGroupFunction(
  client: PoolClient,
  groupId: string,
  tenantId: string,
  op: Record<string, unknown>,
): Promise<{ groupRevision: number; functionId: string; childProfileId: string }> {
  const businessId = String(op.business_id);
  const businessVersion = String(op.business_version);
  const action = String(op.action);
  const endpointSlug = typeof op.endpoint_slug === 'string' ? op.endpoint_slug : null;
  const childProfileId = typeof op.profile_id === 'string' ? op.profile_id : null;

  const members = await client.query<{
    group_revision: number;
    profile_id: string;
    function_id: string;
    enabled: boolean | null;
  }>(
    `SELECT g.active_revision AS group_revision, m.profile_id, m.function_id, b.enabled
       FROM profile_groups g
       JOIN profile_group_members m
         ON m.group_id = g.group_id AND m.group_revision = g.active_revision
       JOIN profile_bindings b
         ON b.profile_id = m.profile_id AND b.revision = m.binding_revision
      WHERE g.group_id=$1 AND g.tenant_id=$2 AND g.auth_authority='GROUP_GRANT'
        AND m.business_id=$3 AND m.business_version=$4 AND m.action=$5
        -- PC-R03: an operation that pinned a child profile is identified by that
        -- pin. The endpoint_slug column is a LEGACY PROJECTION and is NULL for
        -- every admission that did not carry a legacy projection (a v2 submit, or
        -- a v1 body without one), so requiring it to be NULL here would deny a
        -- perfectly authorized retry with ENDPOINT_DISABLED. The selector is the
        -- fallback for operations that pinned no child.
        AND (
          ($7::uuid IS NOT NULL AND m.profile_id=$7::uuid)
          OR ($7::uuid IS NULL AND (
               ($6::text IS NULL AND m.endpoint_slug IS NULL)
               OR ($6::text IS NOT NULL AND (m.endpoint_slug IS NULL OR m.endpoint_slug=$6))))
        )
      LIMIT 2`,
    [groupId, tenantId, businessId, businessVersion, action, endpointSlug, childProfileId],
  );
  if (members.rows.length === 0) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
      'the profile group no longer exposes this function',
    );
  }
  if (members.rows.length > 1) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
      'the operation selector matches more than one current group function',
    );
  }
  const member = members.rows[0]!;
  if (member.enabled === false) {
    throw retryDenied(
      RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
      'the profile-group function is disabled',
    );
  }
  return {
    groupRevision: Number(member.group_revision),
    functionId: member.function_id,
    childProfileId: member.profile_id,
  };
}

/** Retry is a fresh execution of the original pinned request, never a reset. */
export async function retryOperation(
  client: PoolClient, operationId: string, tenantId: string,
  crypto?: MetadataCrypto, reader: MetadataReader = compatibilityMetadataReader(crypto),
): Promise<Record<string, unknown>> {
  // Read immutable routing identity without locking. The business root is the
  // common admission mutex and must precede operation/task locks to serialize
  // fresh retries with pre-drain and activation.
  const rows = await client.query('SELECT * FROM operations WHERE id=$1', [operationId]);
  let op = rows.rows[0] as Record<string, unknown> | undefined;
  if (!op || op.tenant_id !== tenantId) throw notFound('operation not found');
  if (!['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(op.state))) {
    throw conflict('STATE_CONFLICT', 'retry requires a failed, stopped or timed-out operation');
  }

  // PC-07: reauthorize BEFORE the coalesced-replay check. A denied caller must
  // not learn whether a sibling execution exists, and a revoked key/grant must
  // never produce a "replayed" acknowledgement for work it may no longer run.
  //
  // PC-R03: this pass is a PREFLIGHT, not the authorization the write relies
  // on — it reads without holding a single lock. It exists to deny early (and
  // to learn which group root to lock), and its answer is re-derived below
  // under the full lock order.
  const preflight = await authorizeRetry(client, op, tenantId);

  // Finding 5: resolve a coalesced retry BEFORE touching the original payload.
  // The expired-input checks below would otherwise turn a legitimate second
  // click into RETRY_INPUT_UNAVAILABLE while a perfectly valid execution of the
  // same operation is already in flight.
  const inFlightProbe = await client.query(IN_FLIGHT_RETRY_SQL, [operationId]);
  if (inFlightProbe.rowCount) {
    const coalesced = await replayCoalescedRetryUnderLock(client, preflight, op, operationId, tenantId);
    if (coalesced) return coalesced;
  }

  // PC-R03: the coalesced-replay answer is deliberately NOT returned from here
  // any more. Returning it from this unlocked read let a caller whose grant had
  // just been revoked receive a "replayed" acknowledgement for an execution it
  // may no longer observe. The only replay return left is the one after the
  // locked reauthorization below.

  // A replay returns the existing execution, but a fresh request must never
  // turn an uncertain provider outcome into a duplicate charge/side effect.
  const tasks = await client.query('SELECT id, state, error_code FROM tasks WHERE operation_id=$1', [operationId]);
  const uncertain = (value: unknown): boolean => typeof value === 'string' && /(?:INVOCATION|OUTCOME|REASONING).*UNKNOWN|UNKNOWN.*(?:INVOCATION|OUTCOME)/.test(value);
  if (uncertain(op.error_code) || op.state === 'UNKNOWN' || tasks.rows.some(t => uncertain(t.error_code) || t.state === 'UNKNOWN')) {
    throw conflict('INVOCATION_UNKNOWN', 'Provider outcome is unknown. Reconcile the original invocation before starting another execution.');
  }
  const root = await client.query('SELECT * FROM tasks WHERE id=$1', [op.root_task_id]);
  let task = root.rows[0] as Record<string, unknown> | undefined;
  if (!task || op.input_ref == null) throw conflict('RETRY_INPUT_UNAVAILABLE', 'original request input is unavailable');
  const open = async (value: unknown, slot: MetadataSlot, refId: string): Promise<unknown> =>
    reader.readStored(value, { tenantId, slot, refId });
  const input = await open(op.input_ref, 'operations.input_ref', operationId);
  const payload = await open(task.payload_ref, 'tasks.payload_ref', String(task.id));
  const payloadSnapshot = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown> : undefined;
  const pendingSource = payloadSnapshot?.ingestionState === 'PENDING'
    && typeof payloadSnapshot.sourceUrl === 'string' ? payloadSnapshot.sourceUrl : undefined;
  // PC-07: the two operation-bound snapshot carriers are sealed under THIS
  // operation's AAD exactly like input_ref. They are opened here and resealed
  // below; copying the column would carry an envelope the new row can never
  // open (or could open for the wrong identity).
  const tenantDefaultsSnapshot = await openNullable(
    open, op.tenant_defaults_ref, 'operations.tenant_defaults_ref', operationId,
  );
  const connectorRecipePins = await openNullable(
    open, op.connector_recipe_pins_ref, 'operations.connector_recipe_pins_ref', operationId,
  );

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
  const newId = randomUUID();
  const taskId = randomUUID();
  const correlationId = randomUUID();
  const seal = async (value: unknown, slot: MetadataSlot, refId: string): Promise<string> =>
    JSON.stringify(crypto ? await crypto.seal(value, { tenantId, slot, refId }) : value);
  const sealedInput = await seal(input, 'operations.input_ref', newId);
  // Retry the admitted execution snapshot, including its pinned legacy workflow
  // schema. Do not resolve the current catalog revision: retries must execute
  // against the same schema that was admitted for the original operation.
  const retryPayloadValue = pendingSource
    ? { ...(payloadSnapshot ?? {}), input, sourceUrl: pendingSource, ingestionState: 'PENDING' }
    : payloadSnapshot && Object.hasOwn(payloadSnapshot, 'legacyWorkflowSchema')
      ? payloadSnapshot
      : input;
  const sealedPayload = await seal(retryPayloadValue, 'tasks.payload_ref', taskId);
  const prompts = op.prompt_overrides_ref == null ? null
    : await seal(await open(op.prompt_overrides_ref, 'operations.prompt_overrides_ref', operationId), 'operations.prompt_overrides_ref', newId);
  const sealedTenantDefaults = tenantDefaultsSnapshot === null ? null
    : await seal(tenantDefaultsSnapshot, 'operations.tenant_defaults_ref', newId);
  const sealedRecipePins = connectorRecipePins === null ? null
    : await seal(connectorRecipePins, 'operations.connector_recipe_pins_ref', newId);
  const sealedSourceUrl = pendingSource
    ? crypto ? await crypto.seal(pendingSource, { tenantId, slot: 'tasks.payload_ref', refId: taskId }) : pendingSource
    : undefined;
  const state = pendingSource ? 'PENDING_INGESTION' : 'ACCEPTED';
  const originalDispatch = await client.query(
    "SELECT payload FROM outbox WHERE aggregate_id=$1 AND type='task.dispatch' ORDER BY created_at ASC LIMIT 1", [task.id],
  );
  const original = originalDispatch.rows[0]?.payload as Record<string, unknown> | undefined;

  const businessId = String(op.business_id);
  const businessVersion = String(op.business_version);
  // PC-R03 lock 1: the group root is taken BEFORE the business selector, the
  // key row and the operation row. Every authority writer takes this row FOR
  // UPDATE first, so holding it FOR SHARE here is what makes "reauthorize →
  // insert" atomic with respect to a revoke, a disable or a conversion.
  if (preflight.group) await lockRetryGroupRoot(client, preflight.group.groupId, tenantId);
  const admission = await readBusinessAdmission(client, businessId, businessVersion, 'UPDATE');
  if (!admission) throw conflict('BUSINESS_DISABLED', 'retry business is no longer registered');

  // PC-R03 locks 3-4: key row, then grant row. Both sit after the business
  // selector and BEFORE the operation lock, so the whole prefix keeps the
  // universal order and no path can invert it.
  await lockRetryKeyRow(client, preflight);
  await lockRetryGrantRow(client, preflight, tenantId);

  // PC-R03: the AUTHORITATIVE reauthorization. Every row it reads is now held
  // (group FOR SHARE, key FOR SHARE, grant FOR SHARE), so a revoke cannot
  // commit between this decision and the INSERT below. It runs before the
  // operation lock because the operation row is not an authority input: the
  // immutable identity it contributes is re-verified under that lock below.
  const authoritative = await authorizeRetry(client, op, tenantId);
  if ((authoritative.group?.groupId ?? null) !== (preflight.group?.groupId ?? null)) {
    // Belt and braces: the preflight planned its locks for one group and the
    // locked read resolved another (or none). Fail closed rather than write
    // under an authorization whose group root was never locked.
    throw conflict(
      'STATE_CONFLICT',
      'retry authorization changed while locks were being acquired; retry the request',
    );
  }

  // The ONLY coalesced-replay return: after the locked reauthorization, so a
  // sibling execution is reported only to a caller that is still authorized to
  // observe this operation, and before the business availability checks, so a
  // pre-drain window does not turn a double click into a pause error.
  const existingRetry = await client.query(
    "SELECT id, state FROM operations WHERE retry_of=$1 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') ORDER BY created_at DESC LIMIT 1", [operationId],
  );
  if (existingRetry.rowCount) {
    return { operationId: existingRetry.rows[0].id, state: existingRetry.rows[0].state, retryOf: operationId, replayed: true };
  }

  const admissionReason = admissionReasonForVersion(admission, businessVersion);
  if (admissionReason !== 'ELIGIBLE') {
    throw conflict(admissionReason, 'retry is only allowed while its pinned business version is enabled and active');
  }
  if (admission.submissionsPaused) {
    throw conflict('BUSINESS_SUBMISSIONS_PAUSED', 'retries are paused while the active business version drains');
  }

  // Take operation/task locks only after the business mutex and after every
  // authority row is held. Recheck the immutable identity: preparation above
  // may have used crypto or artifact reads that ran before the root lock.
  const lockedRows = await client.query('SELECT * FROM operations WHERE id=$1 FOR UPDATE', [operationId]);
  const lockedOp = lockedRows.rows[0] as Record<string, unknown> | undefined;
  if (!lockedOp || lockedOp.tenant_id !== tenantId) throw notFound('operation not found');
  if (!['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(String(lockedOp.state))) {
    throw conflict('STATE_CONFLICT', 'retry requires a failed, stopped or timed-out operation');
  }
  if (lockedOp.business_id !== businessId || lockedOp.business_version !== businessVersion
    || lockedOp.action !== op.action
    || lockedOp.profile_id !== op.profile_id
    || lockedOp.endpoint_slug !== op.endpoint_slug
    || lockedOp.root_task_id !== op.root_task_id || !isDeepStrictEqual(lockedOp.input_ref, op.input_ref)) {
    throw conflict('STATE_CONFLICT', 'retry source changed while preparing the pinned execution');
  }
  // PC-R03: the FINAL read, after the operation lock and immediately before
  // the durable write. The authority rows are already held, so this cannot
  // change under us; it re-reads the operation's own identity contribution
  // (profile/selector) that the pre-lock pass could not have locked.
  await authorizeRetry(client, lockedOp, tenantId);
  const lockedRoot = await client.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [lockedOp.root_task_id]);
  const lockedTask = lockedRoot.rows[0] as Record<string, unknown> | undefined;
  if (!lockedTask || !isDeepStrictEqual(lockedTask.payload_ref, task.payload_ref) || lockedTask.kind !== task.kind
    || lockedTask.max_attempts !== task.max_attempts) {
    throw conflict('STATE_CONFLICT', 'retry task snapshot changed while preparing the pinned execution');
  }
  const lockedTasks = await client.query('SELECT id, state, error_code FROM tasks WHERE operation_id=$1', [operationId]);
  if (uncertain(lockedOp.error_code) || lockedOp.state === 'UNKNOWN'
    || lockedTasks.rows.some(t => uncertain(t.error_code) || t.state === 'UNKNOWN')) {
    throw conflict('INVOCATION_UNKNOWN', 'Provider outcome is unknown. Reconcile the original invocation before starting another execution.');
  }
  op = lockedOp;
  task = lockedTask;

  // The retry row is a copy of the pinned original with exactly four columns
  // replaced: identity/correlation/state are new, and every SEALED carrier is a
  // parameter holding an envelope re-sealed under the NEW AAD. Unlisted columns
  // are deliberately left to their defaults (`state_version`,
  // `current_step`, `progress_*`), matching the pre-PC-07 behaviour.
  await client.query(
    `INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,root_task_id,input_ref,
      correlation_id,callback_url,profile_id,profile_revision,connector_bindings,submit_artifacts,profile_policy_snapshot,
      callback_policy,prompt_revisions_pin,prompt_overrides_ref,retry_of,deadline_at,endpoint_slug,pipeline_json,output_format,
      tenant_defaults_ref,tenant_defaults_digest,tenant_defaults_ai_revision,tenant_defaults_prompt_revision,
      tenant_default_connector_id,tenant_default_connector_revision,connector_recipe_pins_ref,
      workflow_schema_slug,workflow_schema_revision,workflow_schema_digest)
     SELECT $2,tenant_id,api_key_id,business_id,business_version,action,$3,$4,$5,$6,callback_url,profile_id,profile_revision,
       connector_bindings,submit_artifacts,profile_policy_snapshot,callback_policy,prompt_revisions_pin,$7,id,
       CASE WHEN deadline_at>created_at THEN now()+(deadline_at-created_at) ELSE NULL END,
       endpoint_slug,pipeline_json,output_format,
       $8,tenant_defaults_digest,tenant_defaults_ai_revision,tenant_defaults_prompt_revision,
       tenant_default_connector_id,tenant_default_connector_revision,$9,
       workflow_schema_slug,workflow_schema_revision,workflow_schema_digest
     FROM operations WHERE id=$1`,
    [
      operationId, newId, state, taskId, sealedInput, correlationId, prompts,
      sealedTenantDefaults, sealedRecipePins,
    ],
  );
  await client.query(
    `INSERT INTO tasks (id,operation_id,task_key,kind,payload_ref,state,max_attempts,due_at)
     VALUES ($1,$2,'root',$3,$4,$5,$6,now())`,
    [taskId, newId, task.kind, sealedPayload, pendingSource ? 'PENDING_INGESTION' : 'READY', task.max_attempts],
  );
  await client.query(
    "INSERT INTO outbox (aggregate_id,type,delivery_id,payload) VALUES ($1,'task.dispatch',$2,$3)",
    [taskId, `${taskId}:initial`, JSON.stringify({ contractVersion: '1', deliveryId: `${taskId}:initial`, taskId,
      operationId: newId, businessId: op.business_id, businessVersion: op.business_version, action: op.action,
      kind: task.kind, correlationId, priority: original?.priority,
      gate: pendingSource ? 'ingestion' : undefined,
      sourceUrl: sealedSourceUrl,
    })],
  );
  return { operationId: newId, state, retryOf: operationId, replayed: false };
}

/** Open a nullable sealed carrier under the OLD operation AAD. */
async function openNullable(
  open: (value: unknown, slot: MetadataSlot, refId: string) => Promise<unknown>,
  value: unknown,
  slot: MetadataSlot,
  refId: string,
): Promise<unknown> {
  if (value === null || value === undefined) return null;
  return open(value, slot, refId);
}
