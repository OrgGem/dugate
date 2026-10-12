import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalLegacyWorkflowPinBytes,
  canonicalize,
  CONNECTOR_ARTIFACT_MAX_BYTES,
  InvocationGrantRequestSchema,
  InvocationGrantClaimsSchema,
  LegacyWorkflowSchemaSchema,
  LegacyWorkflowSchemaPinSchema,
  type InvocationArtifactPin,
  type InvocationGrant,
  type ConnectorWorkflowOverrides,
  type LegacyWorkflowNode,
  validateLegacyWorkflowConnectorSlotMap,
  validateLegacyWorkflowEgressOrigins,
  workflowOverridesDigest,
} from '@du/contracts';
import type { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { parseConnectorBindings } from '../profiles/profiles';
import { createInvocationCostContext } from '../cost-control/cost-context';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import { openConnectorRecipePins } from '../global-settings/workflow-recipe-pins';

/**
 * Invocation grant issuance (P2-07 / R08-02). The worker asks the Orchestrator
 * for a short-lived Connector invocation grant bound to (task, step, slot,
 * inputHash). The Orchestrator signs it HS256 with INVOCATION_GRANT_SECRET
 * using the exact header/claims shape the Connector's ContractSignedGrantVerifier
 * expects. Fail-closed: if the secret is absent the service throws instead of
 * issuing an unsigned grant.
 *
 * Stable identity (R08-02 / W11-C1 / W12-C): the invocationId is a deterministic
 * function of the LOGICAL key (taskId, stepKey, bindingSlot) only. It deliberately omits
 * both the inputHash (a differing hash for the same key is a 409 conflict, not
 * a new identity) and any checkpoint generation (generations version step
 * OUTPUTS; the invocation identity is the logical request, reconciled against
 * the stored input_hash row). Fields are length-prefixed before HMAC so no
 * delimiter collision across field boundaries can alias two logical keys.
 * request. A transport retry or a real recovery reuses the same ID, so the
 * Connector ledger dedupes to one provider execution. A conflicting input hash
 * for the same (task, step, slot) is rejected (INPUT_HASH_MISMATCH) — never
 * blind-retried as a new provider call.
 */

const GRANT_TTL_SECONDS = 15 * 60;

export interface GrantService {
  /** Connector identity the worker is allowed to invoke for this task's slots. */
  connectorId: string;
  connectorRevision: number;
  issue(taskId: string, leaseEpoch: number, body: unknown): Promise<InvocationGrant>;
}

interface WorkflowPinTaskFacts {
  operation_id: string;
  tenant_id: string;
  task_key: string;
  task_kind: string;
  parent_id: string | null;
  payload_ref: unknown;
  connector_bindings: unknown;
  connector_recipe_pins_ref: unknown;
  workflow_schema_slug: string | null;
  workflow_schema_revision: number | string | null;
  workflow_schema_digest: string | null;
}

interface AuthorizedWorkflowOverride {
  digest?: string;
}

function findParallelNode(nodes: readonly LegacyWorkflowNode[], nodeId: string): (LegacyWorkflowNode & { type: 'parallel' }) | undefined {
  for (const node of nodes) {
    if (node.type === 'parallel') {
      if (node.id === nodeId) return node as LegacyWorkflowNode & { type: 'parallel' };
      for (const branch of node.branches ?? []) {
        const nested = findParallelNode(branch, nodeId);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

interface WorkflowExecutionStep {
  taskKind: 'root' | 'branch';
  branch: string;
  nodes: readonly LegacyWorkflowNode[];
}

function requireWorkflowExecutionStep(input: {
  task: WorkflowPinTaskFacts;
  taskId: string;
  admittedDigest: string;
  schema: ReturnType<typeof LegacyWorkflowSchemaSchema.parse>;
  metadataCrypto: MetadataCrypto;
}): Promise<WorkflowExecutionStep> {
  return (async () => {
    let payload: unknown;
    try {
      payload = await input.metadataCrypto.readStored(input.task.payload_ref, {
        tenantId: input.task.tenant_id,
        slot: 'tasks.payload_ref',
        refId: input.taskId,
      }, false);
    } catch {
      throw conflict('BINDING_DENIED', 'workflow task payload could not be authenticated');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw conflict('BINDING_DENIED', 'workflow task payload is malformed');
    }
    const record = payload as Record<string, unknown>;
    const taskPinResult = LegacyWorkflowSchemaPinSchema.safeParse(record['legacyWorkflowSchema']);
    if (!taskPinResult.success) throw conflict('BINDING_DENIED', 'workflow task pin is malformed');
    const taskPin = taskPinResult.data;
    const taskPinDigest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
      taskPin.schema,
      taskPin.connectorSlotMap ?? {},
      taskPin.approvedEgressOrigins ?? [],
      taskPin.connectorRecipePins,
    )).digest('hex')}`;
    if (taskPin.tenantId !== input.task.tenant_id || taskPin.slug !== input.task.workflow_schema_slug
        || taskPin.revision !== Number(input.task.workflow_schema_revision)
        || taskPin.digest !== input.admittedDigest || taskPinDigest !== input.admittedDigest
        || canonicalize(taskPin.schema) !== canonicalize(input.schema)) {
      throw conflict('BINDING_DENIED', 'workflow task payload does not match its immutable operation pin');
    }

    const branchMarker = record['__legacyWorkflowBranch'];
    if (input.task.parent_id === null) {
      if (input.task.task_key !== 'root' || input.task.task_kind !== 'root' || branchMarker !== undefined) {
        throw conflict('BINDING_DENIED', 'workflow root task identity is invalid');
      }
      return { taskKind: 'root', branch: 'root', nodes: input.schema.nodes };
    }

    if (input.task.task_kind !== 'legacy-workflow-branch'
        || typeof branchMarker !== 'object' || branchMarker === null || Array.isArray(branchMarker)) {
      throw conflict('BINDING_DENIED', 'workflow branch task identity is invalid');
    }
    const branch = branchMarker as Record<string, unknown>;
    const parallelNodeId = branch['parallelNodeId'];
    const branchIndex = branch['branchIndex'];
    if (typeof parallelNodeId !== 'string' || !Number.isSafeInteger(branchIndex) || Number(branchIndex) < 0
        || !Array.isArray(branch['nodes']) || typeof branch['baseResults'] !== 'object'
        || branch['baseResults'] === null || Array.isArray(branch['baseResults'])) {
      throw conflict('BINDING_DENIED', 'workflow branch payload is invalid');
    }
    const index = Number(branchIndex);
    const parallel = findParallelNode(input.schema.nodes, parallelNodeId);
    const expectedNodes = parallel?.branches?.[index];
    const expectedTaskKey = `legacy-workflow:${parallelNodeId}:branch:${String(index).padStart(2, '0')}`;
    if (!expectedNodes || input.task.task_key !== expectedTaskKey
        || canonicalize(branch['nodes']) !== canonicalize(expectedNodes)) {
      throw conflict('BINDING_DENIED', 'workflow branch task does not match its immutable schema branch');
    }
    return { taskKind: 'branch', branch: `${parallelNodeId}-${index}`, nodes: expectedNodes };
  })();
}

function checkpointKey(digest: string, taskKind: WorkflowExecutionStep['taskKind'], branch: string, nodeId: string): string {
  return `legacy-workflow:node:${digest}:${taskKind}:${branch}:${nodeId}`;
}

/**
 * Resolve the node recipe only from the operation's authenticated immutable
 * admission pins. The worker's copy is a transport echo; it never supplies
 * authority. We re-open the operation-bound envelope and the exact catalog
 * schema revision, re-derive the admitted workflow digest and node-to-slot
 * mapping, then compare the request leaf before signing its invocation
 * binding.
 */
async function authorizeWorkflowOverride(input: {
  client: PoolClient;
  task: WorkflowPinTaskFacts;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  requestOverride?: ConnectorWorkflowOverrides;
  connectorId: string;
  connectorRevision: number;
  invocationId: string;
  metadataCrypto?: MetadataCrypto;
}): Promise<AuthorizedWorkflowOverride> {
  const { client, task } = input;
  const schemaFacts = [task.workflow_schema_slug, task.workflow_schema_revision, task.workflow_schema_digest];
  const hasAnySchemaFact = schemaFacts.some((value) => value !== null && value !== undefined);
  const hasCompleteSchemaPin = schemaFacts.every((value) => value !== null && value !== undefined);

  if (!hasAnySchemaFact) {
    if (task.connector_recipe_pins_ref !== null && task.connector_recipe_pins_ref !== undefined) {
      throw conflict('BINDING_DENIED', 'operation workflow recipe pin has no schema identity');
    }
    if (input.requestOverride !== undefined) {
      throw conflict('BINDING_DENIED', 'workflow recipe overrides are not admitted for this operation');
    }
    return {};
  }
  if (!hasCompleteSchemaPin || task.connector_recipe_pins_ref === null || task.connector_recipe_pins_ref === undefined) {
    throw conflict('BINDING_DENIED', 'operation workflow recipe pin is incomplete');
  }
  if (!input.metadataCrypto) {
    throw conflict('BINDING_DENIED', 'operation workflow recipe pin cannot be authenticated');
  }

  const workflowSchemaSlug = String(task.workflow_schema_slug);
  const workflowSchemaRevision = Number(task.workflow_schema_revision);
  const workflowSchemaDigest = String(task.workflow_schema_digest);
  if (!Number.isSafeInteger(workflowSchemaRevision) || workflowSchemaRevision < 1
      || !/^sha256:[a-f0-9]{64}$/.test(workflowSchemaDigest)) {
    throw conflict('BINDING_DENIED', 'operation workflow schema identity is malformed');
  }

  let operationPin;
  try {
    operationPin = await openConnectorRecipePins(input.metadataCrypto, task.connector_recipe_pins_ref, {
      tenantId: task.tenant_id,
      operationId: task.operation_id,
    });
  } catch {
    throw conflict('BINDING_DENIED', 'operation workflow recipe pin could not be authenticated');
  }
  if (!operationPin
      || operationPin.workflowSchemaSlug !== workflowSchemaSlug
      || operationPin.workflowSchemaRevision !== workflowSchemaRevision
      || operationPin.workflowSchemaDigest !== workflowSchemaDigest) {
    throw conflict('BINDING_DENIED', 'operation workflow recipe pin does not match its schema identity');
  }

  const catalog = await client.query(
    `SELECT tenant_id, slug, revision, digest, schema_ref
       FROM legacy_workflow_schemas
      WHERE tenant_id=$1 AND slug=$2 AND revision=$3
      FOR SHARE`,
    [task.tenant_id, workflowSchemaSlug, workflowSchemaRevision],
  );
  if (catalog.rowCount !== 1) {
    throw conflict('BINDING_DENIED', 'operation workflow schema revision is unavailable');
  }
  const row = catalog.rows[0] as {
    tenant_id: string;
    slug: string;
    revision: number | string;
    digest: string;
    schema_ref: unknown;
  };
  if (row.tenant_id !== task.tenant_id || row.slug !== workflowSchemaSlug
      || Number(row.revision) !== workflowSchemaRevision) {
    throw conflict('BINDING_DENIED', 'operation workflow schema revision identity changed');
  }

  let storedSchema: unknown;
  try {
    storedSchema = await input.metadataCrypto.readStored(row.schema_ref, {
      tenantId: task.tenant_id,
      slot: 'legacy_workflow_schemas.schema_ref',
      refId: `${workflowSchemaSlug}:${workflowSchemaRevision}`,
    }, false);
  } catch {
    throw conflict('BINDING_DENIED', 'operation workflow schema could not be authenticated');
  }
  if (typeof storedSchema !== 'object' || storedSchema === null || Array.isArray(storedSchema)) {
    throw conflict('BINDING_DENIED', 'operation workflow schema envelope is malformed');
  }
  const storedEnvelope = storedSchema as Record<string, unknown>;
  if (Object.keys(storedEnvelope).length !== 3
      || !Object.hasOwn(storedEnvelope, 'schema')
      || !Object.hasOwn(storedEnvelope, 'connectorSlotMap')
      || !Object.hasOwn(storedEnvelope, 'approvedEgressOrigins')) {
    throw conflict('BINDING_DENIED', 'operation workflow schema envelope is malformed');
  }

  let schema: ReturnType<typeof LegacyWorkflowSchemaSchema.parse>;
  let connectorSlotMap: Record<string, string>;
  let approvedEgressOrigins: string[];
  try {
    schema = LegacyWorkflowSchemaSchema.parse(storedEnvelope['schema']);
    connectorSlotMap = validateLegacyWorkflowConnectorSlotMap(schema, storedEnvelope['connectorSlotMap']);
    approvedEgressOrigins = validateLegacyWorkflowEgressOrigins(schema, storedEnvelope['approvedEgressOrigins']);
  } catch {
    throw conflict('BINDING_DENIED', 'operation workflow schema failed immutable validation');
  }

  const catalogDigest = `sha256:${createHash('sha256')
    .update(canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins))
    .digest('hex')}`;
  const admittedDigest = `sha256:${createHash('sha256')
    .update(canonicalLegacyWorkflowPinBytes(
      schema,
      connectorSlotMap,
      approvedEgressOrigins,
      operationPin.connectorRecipePins,
    ))
    .digest('hex')}`;
  if (row.digest !== catalogDigest || admittedDigest !== workflowSchemaDigest
      || schema.slug !== workflowSchemaSlug) {
    throw conflict('BINDING_DENIED', 'operation workflow schema digest does not match its immutable pins');
  }

  const executionStep = await requireWorkflowExecutionStep({
    task,
    taskId: input.taskId,
    admittedDigest,
    schema,
    metadataCrypto: input.metadataCrypto,
  });
  const node = executionStep.nodes.find((candidate) => candidate.type === 'connector'
    && checkpointKey(admittedDigest, executionStep.taskKind, executionStep.branch, candidate.id) === input.stepKey);
  if (!node || node.type !== 'connector' || typeof node.connector !== 'string') {
    throw conflict('BINDING_DENIED', 'invocation step is not an admitted Connector workflow node');
  }
  const slot = connectorSlotMap[node.connector];
  const operationBindings = task.connector_bindings == null ? null : parsePinnedBindings(task.connector_bindings);
  const operationBinding = slot === undefined ? undefined : operationBindings?.[slot];
  const frozenOverride = operationPin.connectorRecipePins[node.id];
  if (!slot || slot !== input.bindingSlot || !operationBinding || !frozenOverride
      || operationBinding.connectorId !== frozenOverride.connectorId
      || operationBinding.revision !== frozenOverride.connectorRevision
      || frozenOverride.connectorId !== input.connectorId
      || frozenOverride.connectorRevision !== input.connectorRevision) {
    throw conflict('BINDING_DENIED', 'invocation node, slot, and immutable Connector revision do not match');
  }
  if (input.requestOverride === undefined
      || canonicalize(input.requestOverride) !== canonicalize(frozenOverride)) {
    throw conflict('BINDING_DENIED', 'workflow recipe override differs from the immutable operation pin');
  }

  return {
    digest: workflowOverridesDigest({
      tenantId: task.tenant_id,
      operationId: task.operation_id,
      taskId: input.taskId,
      stepKey: input.stepKey,
      invocationId: input.invocationId,
      connectorId: input.connectorId,
      connectorRevision: input.connectorRevision,
      workflowOverrides: frozenOverride,
    }),
  };
}

/**
 * Deterministic UUIDv5-style invocation identity from the logical key. The
 * namespace seed is fixed; the digest is folded into RFC-4122 layout so the
 * value is a valid UUID without a real v5 library.
 */
/** Length-prefix one frame so delimiter collisions across fields are impossible. */
function frame(value: string): string {
  return `${value.length}:${value}`;
}

function stableInvocationId(taskId: string, stepKey: string, bindingSlot: string): string {
  const ns = '1b671a64-40d5-491e-99b0-190777e0c4e3';
  const digest = createHmac('sha256', ns).update(frame(taskId) + '|' + frame(stepKey) + '|' + frame(bindingSlot)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Set version (5) and variant (RFC 4122) bits per RFC 4122 §4.4.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function hasDeclaredArtifactReference(value: unknown, artifactId: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      'artifactId' in entry &&
      entry.artifactId === artifactId,
  );
}

/**
 * Parse the operation pin ("connectorId@revision" per slot) back to the
 * structured pin. Submission writes the pin via renderPinnedBindings; claims
 * and grants read this row — never the live profile (PRF-02).
 */
function parsePinnedBindings(raw: unknown): Record<string, { connectorId: string; revision: number }> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw conflict('BINDING_DENIED', 'operation carries a malformed connector pin');
  }
  const structured: Record<string, unknown> = {};
  for (const [slot, rendered] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rendered !== 'string') {
      throw conflict('BINDING_DENIED', `operation pin for slot ${slot} is malformed`);
    }
    const at = rendered.lastIndexOf('@');
    if (at <= 0) throw conflict('BINDING_DENIED', `operation pin for slot ${slot} is malformed`);
    const revision = Number(rendered.slice(at + 1));
    if (!Number.isInteger(revision) || revision < 1) {
      throw conflict('BINDING_DENIED', `operation pin for slot ${slot} has an invalid revision`);
    }
    structured[slot] = { connectorId: rendered.slice(0, at), revision };
  }
  return parseConnectorBindings(structured);
}

export function createGrantService(
  db: Db,
  registry: { getEnabledVersion(businessId: string, version: string): Promise<{ manifest: { actions: { name: string; connectorSlots: { name: string }[] }[] } }> },
  opts: { connectorId: string; connectorRevision: number; secret: Uint8Array; metadataCrypto?: MetadataCrypto }
): GrantService {
  function sign(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', opts.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  function verifyStoredGrant(token: unknown): ReturnType<typeof InvocationGrantClaimsSchema.parse> {
    if (typeof token !== 'string') throw conflict('GRANT_INVALID', 'stored invocation grant is unavailable');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw conflict('GRANT_INVALID', 'stored invocation grant is malformed');
    }
    const expected = createHmac('sha256', opts.secret).update(`${parts[0]}.${parts[1]}`).digest();
    let actual: Buffer;
    try { actual = Buffer.from(parts[2]!, 'base64url'); }
    catch { throw conflict('GRANT_INVALID', 'stored invocation grant is malformed'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw conflict('GRANT_INVALID', 'stored invocation grant signature is invalid');
    }
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown; }
    catch { throw conflict('GRANT_INVALID', 'stored invocation grant is malformed'); }
    const parsed = InvocationGrantClaimsSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.costContext) {
      throw conflict('GRANT_INVALID', 'stored invocation grant has no trusted cost attribution');
    }
    return parsed.data;
  }

  function buildClaims(
    taskId: string,
    t: {
      operation_id: string;
      tenant_id: string;
      api_key_id: string | null;
      profile_id: string | null;
      profile_revision: number | null;
      business_id: string;
      business_version: string;
      action: string;
      attempt: number;
    },
    invocationId: string,
    req: { stepKey: string; bindingSlot: string; inputHash: string; artifactIds: string[] },
    now: number,
    connectorId: string,
    connectorRevision: number,
    artifactPins: InvocationArtifactPin[],
    costContext: ReturnType<typeof createInvocationCostContext>,
    workflowDigest?: string,
  ): Record<string, unknown> {
    return {
      audience: 'connector',
      tenantId: t.tenant_id,
      operationId: t.operation_id,
      taskId,
      stepKey: req.stepKey,
      invocationId,
      inputHash: req.inputHash,
      connectorId,
      connectorRevision,
      bindingSlot: req.bindingSlot,
      artifactIds: req.artifactIds,
      artifactPins,
      costContext,
      ...(workflowDigest === undefined ? {} : { workflowOverridesDigest: workflowDigest }),
      iat: now,
      exp: now + GRANT_TTL_SECONDS,
    };
  }

  return {
    connectorId: opts.connectorId,
    connectorRevision: opts.connectorRevision,
    async issue(taskId, leaseEpoch, body): Promise<InvocationGrant> {
      const parsed = InvocationGrantRequestSchema.safeParse(body);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'invocation grant request failed', {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
      });
      const req = parsed.data;

      // Resolve and fence inside a single transaction: only the current lease
      // holder of a RUNNING task may request a grant.
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.lease_expires_at, t.state, t.operation_id, t.attempt,
                  t.task_key, t.kind AS task_kind, t.parent_id, t.payload_ref,
                  o.tenant_id, o.api_key_id::text AS api_key_id, o.profile_id::text AS profile_id,
                  o.profile_revision, o.business_id, o.business_version, o.action,
                  o.connector_bindings, o.submit_artifacts AS "submitArtifacts",
                  o.connector_recipe_pins_ref, o.workflow_schema_slug, o.workflow_schema_revision,
                  o.workflow_schema_digest
           FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1 FOR UPDATE`,
          [taskId]
        );
        if (!tRes.rowCount) throw notFound(`task ${taskId} not found`);
        const t = tRes.rows[0] as {
          lease_epoch: number;
          lease_expires_at: string | null;
          state: string;
          operation_id: string;
          task_key: string;
          task_kind: string;
          parent_id: string | null;
          payload_ref: unknown;
          tenant_id: string;
          api_key_id: string | null;
          profile_id: string | null;
          profile_revision: number | null;
          business_id: string;
          business_version: string;
          action: string;
          attempt: number;
          connector_bindings: unknown;
          submitArtifacts: unknown;
          connector_recipe_pins_ref: unknown;
          workflow_schema_slug: string | null;
          workflow_schema_revision: number | string | null;
          workflow_schema_digest: string | null;
        };
        if (t.lease_epoch !== leaseEpoch) {
          throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${t.lease_epoch}`);
        }
        if (t.lease_expires_at && new Date(t.lease_expires_at).getTime() <= Date.now()) {
          throw conflict('LEASE_LOST', `lease for task ${taskId} expired at ${t.lease_expires_at}`);
        }
        if (t.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', `task ${taskId} is ${t.state}, not RUNNING`);
        }

        // Pinned binding slot (P2-02/R08-02, W13-C): the requested slot must
        // be declared by the enabled manifest's action. An action declaring
        // NO slots grants none — fail closed. When the operation carries a
        // profile pin, the pin additionally confines the grant: the slot must
        // be pinned for this operation, and the grant is issued for the
        // PINNED connector identity/revision — never the deployment opts.
        const enabled = await registry.getEnabledVersion(t.business_id, t.business_version);
        const action = enabled.manifest.actions.find((a) => a.name === t.action);
        if (!action) throw unprocessable('INVALID_SCHEMA', `action ${t.action} not found in enabled manifest`);
        const declaredSlots = (action.connectorSlots ?? []).map((s) => s.name);
        if (!declaredSlots.includes(req.bindingSlot)) {
          throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} not declared by action ${t.action}`);
        }
        const pin = t.connector_bindings == null ? null : parsePinnedBindings(t.connector_bindings);
        const pinSlot = pin?.[req.bindingSlot];
        if (pin && !pinSlot) {
          throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} is not pinned for this operation`);
        }
        const connectorId = pinSlot?.connectorId ?? opts.connectorId;
        const connectorRevision = pinSlot?.revision ?? opts.connectorRevision;

        // Bind every content reference to the tenant, operation and immutable
        // READY version before minting a connector grant. Cross-operation reads
        // are limited to public input/output artifacts explicitly submitted on
        // this operation, matching the worker artifact access policy.
        const artifactPins: InvocationArtifactPin[] = [];
        if (req.artifactIds.length > 0) {
          const artifactsRes = await client.query(
            `SELECT id AS "artifactId", tenant_id AS "tenantId", operation_id AS "operationId",
                    purpose, state, storage_backend AS "storageBackend", storage_version_id AS "storageVersionId",
                    file_name AS "fileName", mime_type AS "mimeType", size_bytes AS "sizeBytes", sha256
             FROM artifacts WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
            [req.artifactIds]
          );
          const rows = artifactsRes.rows as Array<{
            artifactId: string;
            tenantId: string;
            operationId: string | null;
            purpose: string;
            state: string;
            storageBackend: string | null;
            storageVersionId: string | null;
            fileName: string | null;
            mimeType: string | null;
            sizeBytes: number | string | null;
            sha256: string | null;
          }>;
          const byId = new Map(rows.map((row) => [row.artifactId, row]));
          let totalBytes = 0;
          for (const artifactId of req.artifactIds) {
            const artifact = byId.get(artifactId);
            if (!artifact || artifact.tenantId !== t.tenant_id || artifact.state !== 'READY') {
              throw conflict('BINDING_DENIED', 'connector grant references an unauthorized or non-ready artifact');
            }
            const sameOperation = artifact.operationId === t.operation_id;
            const declaredReference =
              (artifact.purpose === 'input' || artifact.purpose === 'output') &&
              hasDeclaredArtifactReference(t.submitArtifacts, artifactId);
            if (!sameOperation && !declaredReference) {
              throw conflict('BINDING_DENIED', 'connector grant references an artifact outside the task operation');
            }
            const sizeBytes = Number(artifact.sizeBytes);
            const storageVersionId = artifact.storageVersionId ??
              ((artifact.storageBackend ?? 'postgres') === 'postgres' ? artifact.sha256 ?? undefined : undefined);
            if (
              !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 ||
              !artifact.fileName || !artifact.mimeType || !artifact.sha256 || !storageVersionId
            ) {
              throw conflict('BINDING_DENIED', 'connector grant references an artifact without immutable integrity metadata');
            }
            if ((artifact.storageBackend ?? 'postgres') === 's3' && storageVersionId === 'null') {
              throw conflict('BINDING_DENIED', 'connector grant requires an immutable object version');
            }
            totalBytes += sizeBytes;
            if (totalBytes > CONNECTOR_ARTIFACT_MAX_BYTES) {
              throw conflict('BINDING_DENIED', 'connector grant artifact payload exceeds the size limit');
            }
            artifactPins.push({
              artifactId: artifact.artifactId,
              fileName: artifact.fileName,
              mimeType: artifact.mimeType,
              sizeBytes,
              sha256: artifact.sha256,
              storageVersionId,
            });
          }
        }

        const invocationId = stableInvocationId(taskId, req.stepKey, req.bindingSlot);
        if (!Number.isSafeInteger(t.attempt) || t.attempt < 1) {
          throw conflict('STATE_CONFLICT', `task ${taskId} has no valid running attempt for signed cost attribution`);
        }
        const expectedCostContext = createInvocationCostContext({
          tenantId: t.tenant_id,
          operationId: t.operation_id,
          taskId,
          stepKey: req.stepKey,
          bindingSlot: req.bindingSlot,
          invocationId,
          attempt: t.attempt,
          apiKeyId: t.api_key_id,
          profileId: t.profile_id,
          profileRevision: t.profile_revision,
          businessId: t.business_id,
          businessVersion: t.business_version,
          action: t.action,
        });
        const workflowAuthorization = await authorizeWorkflowOverride({
          client,
          task: {
            operation_id: t.operation_id,
            tenant_id: t.tenant_id,
            task_key: t.task_key,
            task_kind: t.task_kind,
            parent_id: t.parent_id,
            payload_ref: t.payload_ref,
            connector_bindings: t.connector_bindings,
            connector_recipe_pins_ref: t.connector_recipe_pins_ref,
            workflow_schema_slug: t.workflow_schema_slug,
            workflow_schema_revision: t.workflow_schema_revision,
            workflow_schema_digest: t.workflow_schema_digest,
          },
          taskId,
          stepKey: req.stepKey,
          bindingSlot: req.bindingSlot,
          requestOverride: req.workflowOverrides,
          connectorId,
          connectorRevision,
          invocationId,
          metadataCrypto: opts.metadataCrypto,
        });
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = new Date((now + GRANT_TTL_SECONDS) * 1000).toISOString();

        // Stable identity: reuse the existing grant when the logical key
        // matches and it has not expired. A differing hash for the same
        // (task, step, slot) is a conflict — the worker must not blind-retry
        // as a fresh provider invocation.
        const existing = await client.query(
          `SELECT input_hash, expires_at, grant_token FROM invocation_grants WHERE task_id=$1 AND step_key=$2 AND invocation_id=$3`,
          [taskId, req.stepKey, invocationId]
        );
        if (existing.rowCount) {
          const row = existing.rows[0] as { input_hash: string; expires_at: Date | string; grant_token: unknown };
          if (row.input_hash !== req.inputHash) {
            throw conflict('INPUT_HASH_MISMATCH', `invocation ${invocationId} already issued for a different input`);
          }
          // The invocation ID is stable across transport retries. Replays must
          // retain the first signed attempt/group context, including when the
          // stored token expired. If a task retry has advanced the attempt,
          // issuing a new group for the same Connector ledger identity would
          // split UNKNOWN/idempotent accounting and is rejected fail-closed.
          const prior = verifyStoredGrant(row.grant_token);
          const storedCostContext = prior.costContext!;
          if (prior.tenantId !== t.tenant_id || prior.operationId !== t.operation_id
              || prior.taskId !== taskId || prior.invocationId !== invocationId
              || prior.stepKey !== req.stepKey || prior.bindingSlot !== req.bindingSlot
              || prior.inputHash !== req.inputHash
              || storedCostContext.attempt !== expectedCostContext.attempt
              || storedCostContext.apiKeyId !== expectedCostContext.apiKeyId
              || storedCostContext.profileId !== expectedCostContext.profileId
              || storedCostContext.profileRevision !== expectedCostContext.profileRevision
              || storedCostContext.businessId !== expectedCostContext.businessId
              || storedCostContext.businessVersion !== expectedCostContext.businessVersion
              || storedCostContext.action !== expectedCostContext.action
              || storedCostContext.budgetReservationGroupId !== expectedCostContext.budgetReservationGroupId
              || storedCostContext.selectionState !== 'DEFERRED'
              || storedCostContext.budgetPins.length !== 0 || storedCostContext.priceRevision !== null
              || prior.workflowOverridesDigest !== workflowAuthorization.digest) {
            throw conflict('COST_CONTEXT_STALE', 'stable invocation identity is already bound to a different signed cost attempt');
          }
          const costContext = storedCostContext;
          if (new Date(row.expires_at).getTime() > Date.now()) {
            // Unexpired: re-sign the same identity and refresh the row so a
            // transport retry reuses the stable invocationId end to end.
            const claims = buildClaims(taskId, t, invocationId, req, now, connectorId, connectorRevision, artifactPins, costContext, workflowAuthorization.digest);
            const grantToken = sign(claims);
            await client.query(
              'UPDATE invocation_grants SET grant_token=$1, expires_at=$2 WHERE task_id=$3 AND step_key=$4 AND invocation_id=$5',
              [grantToken, new Date((now + GRANT_TTL_SECONDS) * 1000), taskId, req.stepKey, invocationId]
            );
            return {
              grant: grantToken,
              invocationId,
              connectorId,
              connectorRevision,
              expiresAt,
              allowedOptions: {},
            };
          }
          const claims = buildClaims(taskId, t, invocationId, req, now, connectorId, connectorRevision, artifactPins, costContext, workflowAuthorization.digest);
          const grantToken = sign(claims);
          await client.query(
            'UPDATE invocation_grants SET grant_token=$1, expires_at=$2 WHERE task_id=$3 AND step_key=$4 AND invocation_id=$5',
            [grantToken, new Date((now + GRANT_TTL_SECONDS) * 1000), taskId, req.stepKey, invocationId]
          );
          return {
            grant: grantToken,
            invocationId,
            connectorId,
            connectorRevision,
            expiresAt,
            allowedOptions: {},
          };
        }

        const claims = buildClaims(taskId, t, invocationId, req, now, connectorId, connectorRevision, artifactPins, expectedCostContext, workflowAuthorization.digest);
        const grantToken = sign(claims);

        await client.query(
          `INSERT INTO invocation_grants
             (task_id, step_key, operation_id, tenant_id, business_id, connector_id, connector_revision, binding_slot, invocation_id, input_hash, grant_token, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (task_id, step_key, invocation_id) DO UPDATE SET grant_token=$11, expires_at=$12`,
          [
            taskId,
            req.stepKey,
            t.operation_id,
            t.tenant_id,
            t.business_id,
            connectorId,
            connectorRevision,
            req.bindingSlot,
            invocationId,
            req.inputHash,
            grantToken,
            new Date((now + GRANT_TTL_SECONDS) * 1000),
          ]
        );

        return {
          grant: grantToken,
          invocationId,
          connectorId,
          connectorRevision,
          expiresAt,
          allowedOptions: {},
        };
      });
    },
  };
}

/** Constant-time grant string equality (for any future local verify). */
export function equalGrantTokens(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
