import { assertKeySpendAvailable } from '../usage/spend-admission';
import { createHash, randomUUID } from 'node:crypto';
import { authorizeS3Source, parseS3Source, type S3SourceRule } from './s3-source';
import {
  canonicalLegacyWorkflowPinBytes,
  BusinessManifest,
  OperationView,
  PROFILE_JOB_PRIORITY_DEFAULT,
  ProfileCallbackPolicySnapshotSchema,
  ProfilePolicySnapshotSchema,
  LegacyWorkflowSchemaPinSchema,
  legacyWorkflowConnectorNames,
  findSecretParameterKeys,
  SubmissionSchema,
  canonicalRequestHash,
  normalizeRouteAction,
  adjudicateUrlDestination,
  withIngestionSource,
  type IngestionReceipt,
  type ProfileCallbackPolicySnapshot,
  type ProfilePolicySnapshot,
  type LegacyWorkflowNode,
  type LegacyWorkflowSchemaPin,
  type TenantDefaultsSnapshot,
  type ConnectorWorkflowOverrides,
  type PromptOverrideRead,
  type PinnedPromptOverride,
} from '@du/contracts';
import { normalizeCorrelationId } from '@du/observability';
import type { MetadataCrypto, MetadataSlot } from '../runtime/metadata-crypto';
import { readBusinessAdmission } from '../registry/version-admission';
import { z } from 'zod';
import { Db } from '../../db/db';
import { RegistryService } from '../registry/registry';
import {
  ProfileService,
  renderPinnedBindings,
  type ConnectorPinMap,
  type EffectiveProfile,
} from '../profiles/profiles';
import { bullMqPriorityFor, extensionDeniedReason, fileUrlEntryName } from '../profiles/policy';
import { fileUrlAuthConfigCarriesSecret } from '../profiles/file-url-auth';
import type { PromptOverrideService } from '../profiles/prompt-overrides';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { compileConnectorRecipePins, type ConnectorRecipeNodeInput } from '../connectors/recipe-compiler';
import { sealTenantDefaultsSnapshot } from '../global-settings/snapshot';
import { compileWorkflowSchemaPinDigest, sealConnectorRecipePins } from '../global-settings/workflow-recipe-pins';
import type { GlobalSettingsService } from '../global-settings/service';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import { HttpError, badRequest, conflict, notFound, unprocessable, unavailable, forbidden } from '../../http/errors';
import type { DbClient } from '../webhooks/webhooks';
import Ajv from 'ajv';

/**
 * Submission + idempotency + admission (docs 06, P2-04, OPS-01..03).
 *
 * One transaction writes: operation, root task, idempotency key, and the
 * outbox dispatch row. The queue publish happens AFTER commit (dispatchOutbox)
 * so a crash between DB write and publish is recovered by the outbox sweeper —
 * never a lost or double job. Idempotency scope is
 * (tenantId, apiKeyId, routeAction, key); same key + same request hash replays
 * the original operation, same key + different hash is a 409.
 *
 * Profile pinning (P2-02 / R08-02, W13-C): before writing anything, the key's
 * latest binding for (business, version, action) is resolved. The winning
 * profile (id, revision) and its connector pin map are stored on the operation
 * row; claim snapshots and grant issuance read that pin, never the live
 * profile, so a revision change affects new submissions only (PRF-02). A key
 * in profile mode (≥1 binding row) with no match for this action is rejected
 * with 403 and nothing is enqueued (PRF-01); a key with no rows stays legacy.
 */

/** Reserved worker metadata: only the authenticated compatibility adapter may produce it. */
export function assertNoLegacyArtifactCount(input: Record<string, unknown>): void {
  if (Object.hasOwn(input, 'legacyArtifactCount')) throw unprocessable('INVALID_SCHEMA', 'legacyArtifactCount is reserved for the legacy transport');
}

export function withLegacyArtifactCount(input: Record<string, unknown>): Record<string, unknown> {
  assertNoLegacyArtifactCount(input);
  const ids = input.artifactIds;
  return { ...input, legacyArtifactCount: Array.isArray(ids) ? ids.length : 0 };
}

export interface SubmitContext {
  /** Trusted compatibility adapter content identity, computed before uploading. */
  legacyRequestIdentity?: Parameters<typeof canonicalRequestHash>[0];
  legacyEndpointSlug?: string;
  legacyExpectedProfile?: { profileId: string; revision: number } | null;
  tenantId: string;
  apiKeyId: string;
  businessId: string;
  action: string;
  alias?: string;
  idempotencyKey?: string;
  correlationId?: string;
  submission: unknown;
  /**
   * Immutable legacy schema pin carried with the root task payload. This is
   * intentionally separate from action input so the registered action schema
   * still validates only business input while the worker receives the exact
   * admitted schema snapshot.
   */
  workflowSchemaPin?: unknown;
  /** Safe fields projected into the legacy operation columns at admission. */
  legacyProjection?: {
    endpointSlug: string;
    pipelineJson: readonly Record<string, unknown>[];
    progressMessage: string;
  };
  /** Seconds an idempotency record is retained (>= retry/replay window). */
  idempotencyTtlSeconds?: number;
}

/**
 * Non-writing authorization and schema checks performed by the legacy
 * multipart facade before it publishes caller bytes. `input` contains the
 * decoded variables and empty artifact arrays; final submission repeats the
 * complete admission against the concrete artifacts and current profile.
 */
export interface LegacyWorkflowPreflightContext {
  tenantId: string;
  apiKeyId: string;
  businessId: string;
  action: string;
  input: Record<string, unknown>;
  fileNames: readonly string[];
  workflowSchemaPin?: unknown;
  endpointSlug?: string;
}

export interface SubmitResult {
  operation: OperationView;
  replayed: boolean;
  correlationId: string;
}

/**
 * Keep the legacy result/poll projection aligned with the exact schema pin
 * admitted on the operation. Admission may add compiled Connector recipe
 * pins to a schema digest, so the caller's catalog digest is no longer the
 * execution digest once the operation is accepted.
 */
export function projectAdmittedWorkflowSchemaDigest(
  pipelineJson: readonly Record<string, unknown>[],
  pin: Pick<LegacyWorkflowSchemaPin, 'slug' | 'revision' | 'digest'> | null | undefined,
): Record<string, unknown>[] {
  if (!pin) return pipelineJson.map((entry) => ({ ...entry }));
  return pipelineJson.map((entry) => (
    entry['workflow'] === pin.slug && entry['schemaRevision'] === pin.revision
      ? { ...entry, schemaDigest: pin.digest }
      : { ...entry }
  ));
}

/** Read-only authorization and policy preflight for an actual Connector test. */
export interface ProviderTestAdmissionInput {
  tenantId: string;
  apiKeyId: string;
  profileId: string;
  expectedProfileRevision: number;
  businessId: string;
  businessVersion: string;
  action: string;
  endpointSlug: string;
  connectorId: string;
  /** Server-derived only after an Admin-authorized PENDING target revision is verified. */
  candidateBindingSlot?: string;
  candidateConnectorRevision?: number;
  model?: string;
  parameters: Record<string, unknown>;
  artifactIds: string[];
}

export interface ProviderTestAdmission {
  tenantId: string;
  apiKeyId: string;
  profileId: string;
  profileRevision: number;
  businessId: string;
  businessVersion: string;
  action: string;
  endpointSlug: string;
  bindingSlot: string;
  connectorBindings: Record<string, { connectorId: string; revision: number }>;
  effectiveInput: Record<string, unknown>;
  profilePolicySnapshot: ProfilePolicySnapshot;
  artifacts: Array<{ artifactId: string; fileName: string; sizeBytes: number }>;
}

export interface SubmissionServiceOptions {
  /** Backup snapshot barrier. When composed, admission takes this as the
   * first row lock in the write transaction and holds it through operation,
   * task, idempotency and outbox persistence. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  /** Maximum aggregate size of file-like bytes embedded in input JSON. */
  maxBlobBytes?: number;
  /**
   * W-INGEST-PG-FAILCLOSED-1 (Reviewer T180-D3): the deployment artifact
   * storage backend. URL ingestion needs the version-capable private store
   * behind the ingestion gate; anything other than s3 rejects URL
   * submissions at admission instead of stranding a forever-undispatched
   * PENDING_INGESTION row (the dispatcher excludes gate-ingestion by
   * design, and no consumer exists on a non-s3 backend). Absent =
   * fail-closed: treated as non-s3.
   */
  storageBackend?: 'postgres' | 's3';
  s3SourceRules?: readonly S3SourceRule[];

  /**
   * P745-PRODUCER (step 1, marker-only): the prompt-override bucket, read
   * ONCE at admission for pinned-mode submissions. What lands on the row is
   * non-secret revision markers only (per-step content digests) — the prompt
   * content itself stays in `connector_prompt_overrides` until the phase-2
   * sealed carrier (Δ-1). Absent = the historical NULL pin; the claim then
   * keeps its zero-value `{}` map, so an unwired deployment is byte-identical.
   */
  promptOverrides?: PromptOverrideService;

  /** Immutable per-operation settings snapshot source; only composed with metadata crypto. */
  globalSettings?: Pick<GlobalSettingsService, 'getTenantDefaultsSnapshot'>;

  /** Tenant-fenced immutable recipe reader used to compile legacy workflow overrides at admission. */
  connectorManagement?: ConnectorManagementStore;

  /**
   * CR28-04: seal `operations.input_ref` / `tasks.payload_ref` before the
   * writing transaction opens, so tenant content never rests as plaintext.
   *
   * Optional, exactly like the runtime seam: absent means the deployment has
   * control-plane encryption OFF and every statement below is byte-identical to
   * the historical body. It is a seam, NOT a policy: this module never
   * decides whether a key is required.
   */
  metadataCrypto?: MetadataCrypto;
}

// W-DATA01-S3-FACADE-1 (Δ14): the receipt shape is no longer a private copy of
// this module — @du/contracts owns it, so the producer (worker SDK), the gate
// writer (this service) and the business consumer validate the same schema.
export type { IngestionReceipt } from '@du/contracts';

export interface SourceAcquirer {
  acquire(sourceUrl: string): Promise<IngestionReceipt>;
}

const ajv = new Ajv({ allErrors: true, strict: false });

const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WorkflowStaticFieldsSchema = z.array(z.object({
  name: z.string().min(1).max(128),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict()).max(32);
const WorkflowExtraHeadersSchema = z.array(z.object({
  name: z.string().min(1).max(64),
  value: z.string().max(256),
}).strict()).max(16);

/**
 * Apply the immutable tenant AI Connector as a fallback for unbound chat
 * slots. Existing Profile pins always win. The recipe must be the exact
 * tenant-owned ACTIVE revision selected by the tenant snapshot and its
 * adapter must match the selected provider; no live "current" lookup or
 * caller-supplied connector identity participates in the decision.
 */
export async function resolveAdmittedConnectorBindings(
  tenantId: string,
  profile: EffectiveProfile,
  connectorSlots: readonly { name: string; acceptedCapabilities?: readonly string[] }[],
  tenantDefaults: TenantDefaultsSnapshot | null,
  connectorManagement: ConnectorManagementStore | undefined,
): Promise<ConnectorPinMap> {
  const bindings: ConnectorPinMap = profile.mode === 'pinned' ? { ...profile.bindings } : {};
  const ai = tenantDefaults?.ai;
  if (!ai?.connectorId || ai.connectorRevision === null) return bindings;

  const fallbackSlots = connectorSlots.filter((slot) =>
    bindings[slot.name] === undefined && (slot.acceptedCapabilities ?? []).includes('chat-completion')
  );
  if (fallbackSlots.length === 0) return bindings;
  if (!connectorManagement) {
    throw unavailable('tenant AI Connector fallback requires configured Connector revision lookup');
  }

  const revision = await connectorManagement.getRecipeRevision({
    tenantId,
    connectorId: ai.connectorId,
    revision: ai.connectorRevision,
  });
  if (!revision || revision.tenantId !== tenantId || revision.connectorId !== ai.connectorId
      || revision.revision !== ai.connectorRevision || revision.state !== 'ACTIVE'
      || revision.recipe.adapter !== ai.provider) {
    throw conflict('CONNECTOR_REVISION_CHANGED', 'tenant AI Connector fallback is not the exact active provider revision');
  }

  for (const slot of fallbackSlots) {
    bindings[slot.name] = { connectorId: ai.connectorId, revision: ai.connectorRevision };
  }
  return bindings;
}

function parseWorkflowOverrideArray<T>(raw: unknown, schema: z.ZodType<T>, label: string): T {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw unprocessable('INVALID_SCHEMA', `${label} must be a JSON array`);
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch { throw unprocessable('INVALID_SCHEMA', `${label} must be valid JSON`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unprocessable('INVALID_SCHEMA', `${label} must use the bounded workflow override shape`);
  return parsed.data;
}

function connectorNodes(nodes: readonly LegacyWorkflowNode[]): LegacyWorkflowNode[] {
  const found: LegacyWorkflowNode[] = [];
  for (const node of nodes) {
    if (node.type === 'connector') found.push(node);
    if (node.type === 'parallel') for (const branch of node.branches ?? []) found.push(...connectorNodes(branch));
  }
  return found;
}

/**
 * CR28-04: seal a submit-side control-plane value.
 *
 * Mirrors the runtime seam's `sealMetadata` (runtime.ts:206) rather than
 * importing it, because that helper is module-private and importing across
 * operations -> runtime would invert the dependency the modules currently
 * have. The duplication is three lines on purpose: if the two ever diverge,
 * the cross-check test in runtime-encryption-metadata.test.ts fails, because
 * an envelope written by one and opened by the other must still agree.
 *
 * CRX-01: the VALUE is sealed as given (an object for the control-plane JSON
 * columns), not its pre-serialized text — an opened envelope then reproduces
 * the exact JSON shape the plaintext column held (`operations.input_ref` /
 * `tasks.payload_ref` read back as objects, which is what the execution
 * snapshot the worker SDK parses requires). Sealing the JSON text instead
 * made opened values come back as strings, a shape no reader of a jsonb
 * object column expects.
 */
export async function sealSubmitMetadata(
  crypto: MetadataCrypto | undefined,
  value: unknown,
  tenantId: string,
  slot: MetadataSlot,
  refId: string
): Promise<string> {
  // The return value is the COLUMN VALUE ready to bind: these are jsonb
  // columns, so both branches produce the JSON text the driver binds. With no
  // seam this is the historical serialization byte-for-byte (a string value is
  // already text and is not double-encoded).
  if (!crypto) return typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(await crypto.seal(value, { tenantId, slot, refId }));
}

/**
 * ENC-META-FIX-G1: the outbox dispatch payload carries the submission's
 * sourceUrl so the ingestion gate can cross-check it against the task row.
 * That copy is sealed with the SAME seam as the columns, under the SAME
 * binding the root task payload uses (tenant + 'tasks.payload_ref' + root
 * task id), so the pg `outbox.payload` row never holds the URL in plaintext
 * while the sealed task row holds the same value: the gate opens BOTH copies
 * with the one context it already builds. With no seam the value passes
 * through as the historical plaintext string, byte-for-byte (the seam stays
 * opt-in per deployment). Unlike `sealSubmitMetadata`, the result is the
 * envelope OBJECT, not column text: this value is embedded inside the outbox
 * payload JSON instead of bound to a jsonb column.
 */
async function sealOutboxSourceUrl(
  crypto: MetadataCrypto | undefined,
  sourceUrl: string | undefined,
  tenantId: string,
  rootTaskId: string
): Promise<unknown> {
  if (sourceUrl === undefined) return undefined;
  if (!crypto) return sourceUrl;
  return crypto.seal(sourceUrl, { tenantId, slot: 'tasks.payload_ref', refId: rootTaskId });
}

export function createSubmissionService(
  db: Db,
  registry: RegistryService,
  profiles: ProfileService,
  options: SubmissionServiceOptions = {}
) {
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 0) {
    throw new Error('maxBlobBytes must be a non-negative safe integer');
  }
  // W-INGEST-PG-FAILCLOSED-1 fail-closed default: an unwired deployment
  // cannot accept URL work it has no store to materialize into.
  const storageBackend = options.storageBackend ?? 'postgres';
  // CR28-04: optional seam; absent = plaintext, historical statements.
  const metadataCrypto = options.metadataCrypto;
  // P745-PRODUCER (step 1): optional; absent = NULL pin, historical claims.
  const promptOverrides = options.promptOverrides;

  async function compileAdmittedWorkflowPin(
    tenantId: string,
    rawPin: unknown,
    profile: EffectiveProfile,
    admittedBindings: ConnectorPinMap = profile.mode === 'pinned' ? profile.bindings : {},
  ): Promise<{ pin: LegacyWorkflowSchemaPin; connectorRecipePins: Record<string, ConnectorWorkflowOverrides> } | null> {
    if (rawPin === undefined) return null;
    const parsed = LegacyWorkflowSchemaPinSchema.safeParse(rawPin);
    if (!parsed.success || parsed.data.tenantId !== tenantId || parsed.data.slug !== parsed.data.schema.slug) {
      throw unprocessable('INVALID_SCHEMA', 'workflow schema pin is invalid for this tenant');
    }
    const base = parsed.data;
    const slotMap = base.connectorSlotMap ?? {};
    const approvedEgressOrigins = base.approvedEgressOrigins ?? [];
    const baseDigest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
      base.schema, slotMap, approvedEgressOrigins,
    )).digest('hex')}`;
    if (base.connectorRecipePins !== undefined || base.digest !== baseDigest) {
      throw unprocessable('INVALID_SCHEMA', 'workflow schema pin digest does not match its immutable catalog data');
    }

    const nodes = connectorNodes(base.schema.nodes);
    if (nodes.length > 32) throw unprocessable('INVALID_SCHEMA', 'workflow schema has too many Connector nodes');
    if (nodes.length > 0 && Object.keys(admittedBindings).length === 0) {
      throw forbidden('workflow connectors require a profile with explicit connector revision pins');
    }
    if (nodes.length > 0 && !options.connectorManagement) {
      throw unavailable('workflow Connector recipe resolution is not configured');
    }
    const compileNodes: ConnectorRecipeNodeInput[] = [];
    for (const node of nodes) {
      const name = typeof node.connector === 'string' ? node.connector : '';
      const slot = slotMap[name];
      const binding = typeof slot === 'string' ? admittedBindings[slot] : undefined;
      if (!binding) throw forbidden(`workflow connector slot ${String(slot)} is not pinned by the authorized profile`);
      const revision = await options.connectorManagement!.getRecipeRevision({
        tenantId,
        connectorId: binding.connectorId,
        revision: binding.revision,
      });
      if (!revision || revision.tenantId !== tenantId || revision.connectorId !== binding.connectorId
          || revision.revision !== binding.revision || revision.state !== 'ACTIVE') {
        throw conflict('CONNECTOR_REVISION_CHANGED', 'workflow Connector revision is no longer available for new submissions');
      }
      const rawNode = node as Record<string, unknown>;
      const override = typeof rawNode.overrideConnector === 'object' && rawNode.overrideConnector !== null
        && !Array.isArray(rawNode.overrideConnector)
        ? rawNode.overrideConnector as Record<string, unknown>
        : {};
      const staticFormFields = override.staticFormFields === undefined
        ? undefined
        : parseWorkflowOverrideArray(override.staticFormFields, WorkflowStaticFieldsSchema, 'staticFormFields');
      const extraHeaders = override.extraHeaders === undefined
        ? undefined
        : parseWorkflowOverrideArray(override.extraHeaders, WorkflowExtraHeadersSchema, 'extraHeaders');
      compileNodes.push({
        nodeId: node.id,
        tenantId,
        revisionTenantId: revision.tenantId,
        connectorId: binding.connectorId,
        connectorRevision: binding.revision,
        recipe: revision.recipe,
        ...(staticFormFields !== undefined ? { staticFormFields } : {}),
        ...(extraHeaders !== undefined ? { extraHeaders } : {}),
      });
    }
    const connectorRecipePins = compileConnectorRecipePins({ tenantId, nodes: compileNodes });
    const digest = compileWorkflowSchemaPinDigest(base, connectorRecipePins);
    const pin = LegacyWorkflowSchemaPinSchema.parse({
      ...base,
      digest,
      connectorRecipePins,
    });
    return { pin, connectorRecipePins };
  }

  return {
    async replayLegacy(ctx: Pick<SubmitContext, 'tenantId' | 'apiKeyId' | 'businessId' | 'action' | 'idempotencyKey' | 'correlationId'>, identity: Parameters<typeof canonicalRequestHash>[0]): Promise<SubmitResult | null> {
      if (!ctx.idempotencyKey) return null;
      const existing = await findSubmissionKey(db, ctx.tenantId, ctx.apiKeyId, normalizeRouteAction(ctx.businessId, ctx.action), ctx.idempotencyKey);
      if (!existing) return null;
      if (existing.request_hash !== canonicalRequestHash(identity)) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
      return { operation: await loadOperationView(db, existing.operation_id), replayed: true, correlationId: normalizeCorrelationId(ctx.correlationId) };
    },
    /**
     * Reuse the ordinary submission policy gates for a provider test without
     * creating a customer operation, task, idempotency row, or outbox entry.
     * The provider-test service owns its separate durable test-run acceptance,
     * actor assignment check, and invocation deadline.
     */
    async admitProviderTest(input: ProviderTestAdmissionInput): Promise<ProviderTestAdmission> {
      if (!Array.isArray(input.artifactIds) || new Set(input.artifactIds).size !== input.artifactIds.length) {
        throw unprocessable('INVALID_SCHEMA', 'provider-test artifacts must be unique');
      }
      if (Object.hasOwn(input.parameters, 'artifactIds') || Object.hasOwn(input.parameters, 'sourceUrl')) {
        throw unprocessable('INVALID_SCHEMA', 'provider-test artifact and source references must use their dedicated fields');
      }
      const key = await db.query<{ id: string }>(
        "SELECT id FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [input.apiKeyId, input.tenantId],
      );
      if (!key.rowCount) throw notFound('active API key not found in tenant');

      const enabled = await resolveEnabledVersion(db, input.businessId, input.action);
      if (enabled.version !== input.businessVersion) {
        throw conflict('PROFILE_CHANGED', 'selected business version is no longer active; reload before testing');
      }
      const actionDef = enabled.manifest.actions.find((action) => action.name === input.action);
      if (!actionDef) throw badRequest(`action ${input.action} not declared by ${input.businessId}@${enabled.version}`);

      const actionInput: Record<string, unknown> = {
        ...input.parameters,
        ...(input.artifactIds.length > 0 ? { artifactIds: [...input.artifactIds] } : {}),
      };
      if (input.businessId === 'document-core') assertNoLegacyArtifactCount(actionInput);
      assertEmbeddedInputByteBudget(actionInput, maxBlobBytes);
      const profile = await profiles.resolveEffectiveProfile(
        input.apiKeyId,
        input.businessId,
        enabled.version,
        input.action,
        actionInput,
        declaredParameterKeys(actionDef.inputSchema as object),
        input.endpointSlug,
      );
      if (profile.mode !== 'pinned' || profile.profileId !== input.profileId) {
        throw forbidden('the selected API key is not assigned to the selected active Profile and action');
      }
      if (profile.revision !== input.expectedProfileRevision) {
        throw conflict('PROFILE_CHANGED', 'Profile revision changed; reload before testing');
      }
      const pinnedModel = profile.policy.parameters.model;
      if (pinnedModel && typeof pinnedModel === 'object' && pinnedModel.isLocked === true
          && input.model !== pinnedModel.value) {
        throw forbidden('the selected model differs from the locked Profile model');
      }
      let bindings = profile.bindings;
      let binding: [string, { connectorId: string; revision: number }] | undefined;
      if (input.candidateBindingSlot !== undefined || input.candidateConnectorRevision !== undefined) {
        if (input.candidateBindingSlot === undefined || input.candidateConnectorRevision === undefined
            || !Number.isSafeInteger(input.candidateConnectorRevision) || input.candidateConnectorRevision < 1) {
          throw unprocessable('INVALID_SCHEMA', 'pending Connector candidate admission is incomplete');
        }
        if (!actionDef.connectorSlots.some((slot) => slot.name === input.candidateBindingSlot)) {
          throw forbidden('pending Connector candidate slot is not declared by the selected business action');
        }
        binding = [input.candidateBindingSlot, { connectorId: input.connectorId, revision: input.candidateConnectorRevision }];
        // This is an ephemeral test-only overlay. It is returned to the
        // provider-test caller and is never written into the active Profile.
        bindings = { ...profile.bindings, [input.candidateBindingSlot]: binding[1] };
      } else {
        binding = Object.entries(profile.bindings).find(([, pin]) => pin.connectorId === input.connectorId);
      }
      if (!binding) throw forbidden('the selected Connector is not pinned by the selected Profile');

      const effectiveInput = profile.effectiveInput;
      assertEmbeddedInputByteBudget(effectiveInput, maxBlobBytes);
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(effectiveInput)) {
        throw unprocessable('INVALID_SCHEMA', 'provider-test input failed the selected action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((error) => ({
            pointer: error.instancePath || '/', message: error.message ?? 'invalid',
          })),
        });
      }
      const artifacts = await assertReadyTenantArtifacts(
        (ids, tenantId) => db.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId, input.apiKeyId]),
        input.artifactIds,
        input.tenantId,
      );
      assertProfileExtensionAllowed(profile.policy.allowedFileExtensions, artifacts, effectiveInput, undefined);
      await assertKeySpendAvailable(db, input.apiKeyId, input.tenantId);

      return {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        profileId: profile.profileId,
        profileRevision: profile.revision,
        businessId: input.businessId,
        businessVersion: enabled.version,
        action: input.action,
        endpointSlug: input.endpointSlug,
        bindingSlot: binding[0],
        connectorBindings: bindings,
        effectiveInput,
        profilePolicySnapshot: buildProfilePolicySnapshot(profile, input.tenantId),
        artifacts: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          fileName: artifact.fileName ?? '',
          sizeBytes: Number(artifact.sizeBytes ?? 0),
        })),
      };
    },
    async preflightLegacyWorkflow(ctx: LegacyWorkflowPreflightContext): Promise<EffectiveProfile> {
      if (ctx.businessId === 'document-core') assertNoLegacyArtifactCount(ctx.input);
      if (!metadataCrypto) {
        throw unavailable('workflow submissions require configured metadata encryption');
      }
      const canonicalAction = ctx.action;
      const { version, manifest } = await resolveEnabledVersion(db, ctx.businessId, canonicalAction);
      const actionDef = manifest.actions.find((action) => action.name === canonicalAction);
      if (!actionDef) throw badRequest(`action ${canonicalAction} not declared by ${ctx.businessId}@${version}`);

      const profile = await profiles.resolveEffectiveProfile(
        ctx.apiKeyId,
        ctx.businessId,
        version,
        canonicalAction,
        ctx.input,
        declaredParameterKeys(actionDef.inputSchema as object).filter((key) => key !== 'legacyWorkflow'),
        ctx.endpointSlug,
      );
      const tenantDefaults = options.globalSettings
        ? await options.globalSettings.getTenantDefaultsSnapshot(ctx.tenantId)
        : null;
      const admittedBindings = await resolveAdmittedConnectorBindings(
        ctx.tenantId,
        profile,
        actionDef.connectorSlots,
        tenantDefaults,
        options.connectorManagement,
      );
      const effectiveInput = profile.mode === 'pinned' ? profile.effectiveInput : ctx.input;
      if (ctx.businessId === 'document-core') assertNoLegacyArtifactCount(effectiveInput);
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(effectiveInput)) {
        throw unprocessable('INVALID_SCHEMA', 'input failed action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((error) => ({
            pointer: error.instancePath || '/',
            message: error.message ?? 'invalid',
          })),
        });
      }

      if (profile.mode === 'pinned') {
        for (const fileName of ctx.fileNames) {
          const reason = extensionDeniedReason(profile.policy.allowedFileExtensions, fileName);
          if (reason) {
            throw unprocessable('PROFILE_EXTENSION_DENIED', `file ${fileName}: ${reason}`, {
              errors: [{ pointer: '/artifacts', message: reason }],
            });
          }
        }
      }

      const legacyNamedProcess = legacyNamedWorkflowProcess(ctx.businessId, canonicalAction, ctx.input);
      if (legacyNamedProcess !== null) {
        requireLegacyNamedWorkflowBindings(admittedBindings, legacyNamedProcess);
      }

      if (ctx.workflowSchemaPin === undefined) return profile;
      if (canonicalAction !== 'schema-workflow') {
        throw badRequest('workflow schema pin is only valid for schema-workflow submissions');
      }
      const parsedPin = LegacyWorkflowSchemaPinSchema.safeParse(ctx.workflowSchemaPin);
      if (!parsedPin.success || parsedPin.data.tenantId !== ctx.tenantId
          || parsedPin.data.slug !== parsedPin.data.schema.slug) {
        throw unprocessable('INVALID_SCHEMA', 'workflow schema pin is invalid for this tenant');
      }
      const names = legacyWorkflowConnectorNames(parsedPin.data.schema);
      const slots = parsedPin.data.connectorSlotMap ?? {};
      const mapped = names.map((name) => slots[name]);
      if (names.length > 32 || mapped.some((slot) => typeof slot !== 'string')
          || new Set(mapped).size !== mapped.length) {
        throw unprocessable('INVALID_SCHEMA', 'workflow schema connector slot map is missing or invalid');
      }
      if (mapped.length > 0) {
        for (const slot of mapped) {
          if (slot === undefined || admittedBindings[slot] === undefined) {
            throw forbidden(`workflow connector slot ${String(slot)} is not pinned by the authorized profile or tenant defaults`);
          }
        }
      }
      await compileAdmittedWorkflowPin(ctx.tenantId, parsedPin.data, profile, admittedBindings);
      return profile;
    },

    async submit(ctx: SubmitContext): Promise<SubmitResult> {
      if (ctx.legacyProjection && !metadataCrypto) {
        throw unavailable('workflow submissions require configured metadata encryption');
      }
      const parsed = SubmissionSchema.safeParse(ctx.submission);
      if (!parsed.success) {
        throw unprocessable('INVALID_SCHEMA', 'submission validation failed', {
          errors: parsed.error.issues.slice(0, 50).map((i) => ({
            pointer: '/' + i.path.join('/'),
            message: i.message,
          })),
        });
      }
      const submission = parsed.data;
      if (ctx.businessId === 'document-core') assertNoLegacyArtifactCount(submission.input);
      // RCR-03: the replay lookup is scoped by the CALLER (tenant, apiKeyId,
      // route) and decided BEFORE any admission-policy read. A version that
      // was deactivated, a profile edit, an artifact expiry, or the storage
      // backend flipping since the ORIGINAL acceptance must not turn a
      // same-key replay of an ACCEPTED operation into a 404/409 — T-SUB-04's
      // own rationale ("a profile edit cannot break a replay") extended to
      // every admission input. Current admission rules still apply to NEW
      // requests, immediately below. The key/tenant fence is untouched: the
      // lookup is scoped by (tenant, apiKeyId, routeAction).
      const correlationId = normalizeCorrelationId(ctx.correlationId);
      const canonicalAction = ctx.alias ?? ctx.action;
      const routeAction = normalizeRouteAction(ctx.businessId, ctx.action, ctx.alias);
      // T-SUB-04: the idempotency hash stays on the RAW client input, never on
      // the effective input. A profile edit between two retries of the same
      // Idempotency-Key must replay the original operation, not a second one
      // built from the new defaults — hashing the merged map would turn every
      // admin edit into an IDEMPOTENCY_CONFLICT for in-flight clients.
      const requestHash = canonicalRequestHash(ctx.legacyRequestIdentity ?? {
        input: ctx.workflowSchemaPin === undefined
          ? submission.input
          : { input: submission.input, legacyWorkflowSchema: ctx.workflowSchemaPin },
        artifacts: submission.artifacts,
        output: submission.output,
        callback: submission.callback,
        sourceUrl: submission.sourceUrl,
      });

      // Fast path: existing idempotency record for this scope+key.
      if (ctx.idempotencyKey) {
        const existing = await findSubmissionKey(
          db,
          ctx.tenantId,
          ctx.apiKeyId,
          routeAction,
          ctx.idempotencyKey
        );
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw conflict(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different request body'
            );
          }
          const op = await loadOperationView(db, existing.operation_id);
          return { operation: op, replayed: true, correlationId };
        }
      }

      if (submission.sourceUrl && storageBackend !== 's3') {
        // T180-D3 admission-time fail-closed: schema parsing above is
        // pure, so this throws with ZERO database calls - no operation
        // row, no task row, no outbox row, no parked PENDING_INGESTION
        // that no consumer can ever open on a non-s3 backend.
        throw unprocessable(
          'UNSUPPORTED_STORAGE_BACKEND',
          'URL ingestion requires an S3-compatible storage backend'
        );
      }
      if (submission.sourceUrl) {
        validateSourceUrl(submission.sourceUrl);
        if (submission.sourceUrl.startsWith('s3://')) {
          try { authorizeS3Source(submission.sourceUrl, ctx.tenantId, options.s3SourceRules ?? []); }
          catch { throw new HttpError(403, 'PERMISSION_DENIED', 'S3 source is not allowed for this tenant'); }
        }
      }
      assertEmbeddedInputByteBudget(submission.input, maxBlobBytes);
      const referencedArtifactIds = collectArtifactReferences(submission);
      await assertReadyTenantArtifacts(
        (ids, tenantId) => db.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId, ctx.apiKeyId]),
        referencedArtifactIds,
        ctx.tenantId
      );

      // Resolve the registered+enabled version (slice submits against the
      // single enabled version per business/action).
      const enabled = await resolveEnabledVersion(db, ctx.businessId, canonicalAction);
      const { version, manifest, digest, queue, activationRevision } = enabled;

      const actionDef = manifest.actions.find((a) => a.name === canonicalAction);
      if (!actionDef) {
        throw badRequest(`action ${canonicalAction} not declared by ${ctx.businessId}@${version}`);
      }

      // PAR-XA-03: the ONE admission seam. T-SUB-01 — everything this call can
      // refuse (profile disabled, profile unknown, unauthorized key, a locked
      // parameter) is refused HERE, before the first `randomUUID` (:314) and therefore
      // before the operations/tasks/submission_keys/outbox inserts. A denied
      // submit leaves zero rows behind.
      //
      // T-SUB-02 note: the same call that authorizes the profile also returns
      // the whole effective policy, so the snapshot below is a value we already
      // hold rather than a second read that could disagree with the decision.
      const profile = await profiles.resolveEffectiveProfile(
        ctx.apiKeyId,
        ctx.businessId,
        version,
        canonicalAction,
        submission.input as Record<string, unknown>,
        declaredParameterKeys(actionDef.inputSchema as object).filter((key) =>
          ctx.legacyProjection === undefined || key !== 'legacyWorkflow'
        ),
        ctx.legacyEndpointSlug ?? ctx.legacyProjection?.endpointSlug
      );
      const tenantDefaults = options.globalSettings
        ? await options.globalSettings.getTenantDefaultsSnapshot(ctx.tenantId)
        : null;
      const admittedBindings = await resolveAdmittedConnectorBindings(
        ctx.tenantId,
        profile,
        actionDef.connectorSlots,
        tenantDefaults,
        options.connectorManagement,
      );
      if (tenantDefaults && !metadataCrypto) {
        throw unavailable('tenant defaults require configured metadata encryption');
      }
      if (ctx.legacyExpectedProfile !== undefined) {
        const expected = ctx.legacyExpectedProfile;
        const matches = expected === null ? profile.mode === 'legacy' : profile.mode === 'pinned' && profile.profileId === expected.profileId && profile.revision === expected.revision;
        if (!matches) throw conflict('PROFILE_CHANGED', 'Profile changed during source admission; retry the request');
      }
      // The profile already split its managed keys from the rest; the merged
      // result is what the worker runs, and AJV still judges the remainder.
      let effectiveInput: Record<string, unknown> =
        profile.mode === 'pinned' ? profile.effectiveInput : (submission.input as Record<string, unknown>);

      // Validate the EFFECTIVE input (client values merged over profile
      // defaults) against the action's inputSchema (422 on mismatch). Validating
      // the merged map rather than the raw client body is a deliberate change:
      // it is the map the worker will actually run, so a profile default that no
      // longer satisfies the action schema fails here — at submit, with a 422
      // the caller can act on — instead of surfacing as a worker error hours
      // later. The two cases differ only when the client OMITTED a key, which
      // is exactly the case where the default decides the outcome.
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(effectiveInput)) {
        throw unprocessable('INVALID_SCHEMA', 'input failed action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((e) => ({
            pointer: e.instancePath || '/',
            message: e.message ?? 'invalid',
          })),
        });
      }

      if (ctx.businessId === 'document-core') {
        assertNoLegacyArtifactCount(effectiveInput);
        if (ctx.legacyEndpointSlug !== undefined && canonicalAction !== 'compare') effectiveInput = withLegacyArtifactCount(effectiveInput);
      }

      const legacyNamedProcess = ctx.legacyProjection
        ? legacyNamedWorkflowProcess(ctx.businessId, canonicalAction, effectiveInput)
        : null;
      if (legacyNamedProcess !== null) {
        requireLegacyNamedWorkflowBindings(admittedBindings, legacyNamedProcess);
      }

      const workflowPinData = await compileAdmittedWorkflowPin(ctx.tenantId, ctx.workflowSchemaPin, profile, admittedBindings);
      const workflowPin = workflowPinData?.pin;
      const legacyPipelineJson = ctx.legacyProjection
        ? projectAdmittedWorkflowSchemaDigest(ctx.legacyProjection.pipelineJson, workflowPin)
        : null;

      // T-SUB-04 note: the idempotency hash / replay lookup now run BEFORE
      // admission (RCR-03) — see the top of submit(). Everything from here
      // down applies to NEW requests only.

      const operationId = randomUUID();
      const rootTaskId = randomUUID();
      const deliveryId = randomUUID();
      const ttlSeconds = ctx.idempotencyTtlSeconds ?? 24 * 3600;

      // Resolve current tenant defaults exactly once for this newly accepted
      // operation. The complete values travel only in the operation-bound
      // encrypted carrier; revision markers are safe immutable metadata.
      const sealedTenantDefaults = tenantDefaults
        ? await sealTenantDefaultsSnapshot(metadataCrypto, tenantDefaults, { tenantId: ctx.tenantId, operationId })
        : null;
      const sealedConnectorRecipePins = workflowPinData
        ? await sealConnectorRecipePins(metadataCrypto, {
            workflowSchemaSlug: workflowPinData.pin.slug,
            workflowSchemaRevision: workflowPinData.pin.revision,
            workflowSchemaDigest: workflowPinData.pin.digest,
            connectorRecipePins: workflowPinData.connectorRecipePins,
          }, { tenantId: ctx.tenantId, operationId })
        : null;

      // P745-CARRIER-IMPL-A (Δ-PC-1): resolve the override bucket ONCE here,
      // at admission, and build BOTH pins from the same rows so they cannot
      // disagree by construction. Caps are checked first: a 422 leaves zero
      // rows and zero Vault calls behind. Markers stay exactly the phase-1
      // shape (non-secret digests); the carrier (below) is the content.
      const promptOverrideRows =
        profile.mode === 'pinned' && promptOverrides
          ? await promptOverrides.listFor(ctx.apiKeyId, ctx.legacyEndpointSlug ?? ctx.legacyProjection?.endpointSlug ?? canonicalAction, ctx.tenantId)
          : [];
      const promptRevisionsPin =
        profile.mode === 'pinned' && promptOverrides
          ? JSON.stringify(buildPromptRevisionsPin(promptOverrideRows))
          : null;
      const promptCarrierRows = buildPromptCarrier(promptOverrideRows);
      assertPromptCarrierCaps(promptCarrierRows);

      // CR28-04/CRX-01: seal BEFORE the writing transaction, not inside it. Two
      // reasons, both load-bearing:
      //  1. A key-provider failure must abort the submit with nothing written.
      //     Sealing inside the tx would still roll back, but it would hold a
      //     write transaction open across a network call to Vault.
      //  2. The AAD binds each envelope to its OWN row (operationId for
      //     input_ref, rootTaskId for payload_ref), which is why these cannot
      //     be one shared value even though both derive from `submission`.
      // The sealed value replaces the plaintext in the column and opens back to
      // the same JSON shape the plaintext had (object in, object out).
      // T-SUB-02 / PRF-02: the sealed payload carries the EFFECTIVE input, the
      // same map AJV validated above — not the raw client body. The profile's
      // defaults are what the worker must run; storing the raw body would make
      // the stored input disagree with the validated one and force the worker
      // to re-derive (or ignore) the merge. The idempotency hash above is the
      // deliberate exception: it stays on the raw body so an admin edit cannot
      // turn a retry into IDEMPOTENCY_CONFLICT.
      const taskPayloadValue = workflowPin !== undefined
        ? { input: effectiveInput, legacyWorkflowSchema: workflowPin }
        : submission.sourceUrl
          ? { input: effectiveInput, sourceUrl: submission.sourceUrl, ingestionState: 'PENDING' }
          : effectiveInput;
      const sealedInputRef = await sealSubmitMetadata(metadataCrypto, effectiveInput, ctx.tenantId, 'operations.input_ref', operationId);
      const sealedTaskPayload = await sealSubmitMetadata(metadataCrypto, taskPayloadValue, ctx.tenantId, 'tasks.payload_ref', rootTaskId);
      // P745-CARRIER-IMPL-A (Δ-PC-1): adjudication 1c — no seam OR no rows ⇒
      // NULL carrier (markers stay; content never degrades to plaintext). The
      // seal happens BEFORE the tx like input_ref: a key-provider failure must
      // abort the submit with nothing written (CR28-04 reasons above).
      const sealedPromptCarrier =
        metadataCrypto && promptCarrierRows.length > 0
          ? await sealSubmitMetadata(
              metadataCrypto,
              promptCarrierRows,
              ctx.tenantId,
              'operations.prompt_overrides_ref',
              operationId
            )
          : null;
      // ENC-META-FIX-G1: the outbox copy of the URL is sealed BEFORE the
      // transaction for the same reason as the columns: a key-provider
      // failure must abort the submit with nothing written, and no Vault call
      // may sit inside the write tx.
      const sealedOutboxSourceUrl = await sealOutboxSourceUrl(metadataCrypto, submission.sourceUrl, ctx.tenantId, rootTaskId);
      // CB-02 (B3): the admission-time callback pin. NULL for profiles without
      // a callback policy (or legacy mode), preserving notification-only.
      const callbackPolicyPin = profile.mode === 'pinned'
        ? buildCallbackPolicySnapshot(profile, {
            tenantId: ctx.tenantId,
            businessId: ctx.businessId,
            businessVersion: version,
            endpointKey: canonicalAction,
          })
        : null;

      const created = await db.tx(async (client) => {
        // Backup-only admission barrier. Keep this as the first row lock so
        // a snapshot either observes the complete accepted operation/outbox
        // pair or blocks admission until capture is finished.
        if (options.backupSnapshotWriteGate) {
          const requestKey = createHash('sha256')
            .update(JSON.stringify([ctx.tenantId, ctx.apiKeyId, routeAction, requestHash]))
            .digest('hex');
          await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
            tenantId: ctx.tenantId,
            domain: 'work-admission',
            requestKey: `submission:${requestKey}`,
          });
        }

        // Re-check idempotency inside the tx to close the concurrent-submit race
        // (unique constraint is the ultimate authority; this avoids a duplicate
        // operation row before the constraint fires).
        if (ctx.idempotencyKey) {
          // Serialize the absent-row case too: SELECT FOR UPDATE cannot lock a key that does not exist yet.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey])]);
          const dup = await client.query(
            `SELECT operation_id, request_hash FROM submission_keys
             WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 FOR UPDATE`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey]
          );
          if (dup.rowCount && dup.rowCount > 0) {
            const row = dup.rows[0] as { operation_id: string; request_hash: string };
            if (row.request_hash !== requestHash) {
              throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
            }
            return { operationId: row.operation_id, replayed: true };
          }
        }

        // Revalidate the exact version and activation revision selected by
        // preflight. This shared root lock is held through the durable writes;
        // activation takes the conflicting root lock FOR UPDATE first. A
        // version switch during profile/schema resolution therefore refuses
        // this request instead of silently repinning its validated input.
        const businessAdmission = await readBusinessAdmission(client, ctx.businessId, version, 'SHARE');
        if (!businessAdmission) throw notFound(`business ${ctx.businessId} is not registered`);
        if (!businessAdmission.enabled) throw conflict('STATE_CONFLICT', `business ${ctx.businessId} is disabled`);
        if (businessAdmission.submissionsPaused) {
          throw conflict('BUSINESS_SUBMISSIONS_PAUSED', `new submissions are paused while ${businessAdmission.preDrainVersion ?? version} drains`);
        }
        if (businessAdmission.activeVersion !== version
          || businessAdmission.targetStatus !== 'ENABLED'
          || businessAdmission.activationRevision !== activationRevision) {
          throw conflict('VERSION_NOT_ACTIVE', 'active business version changed during admission; retry the request');
        }
        const versionPin = await client.query<{ digest: string; manifest: BusinessManifest }>(
          `SELECT digest,manifest FROM business_versions WHERE business_id=$1 AND version=$2`,
          [ctx.businessId, version],
        );
        if (!versionPin.rows[0] || versionPin.rows[0].digest !== digest) {
          throw conflict('VERSION_NOT_ACTIVE', 'registered business version changed during admission; reload and retry');
        }
        if (!versionPin.rows[0].manifest.actions.some((candidate) => candidate.name === canonicalAction)) {
          throw badRequest(`action ${canonicalAction} is no longer offered by ${ctx.businessId}@${version}`);
        }

        // Recheck artifact state under row locks after idempotency and business
        // admission have been decided. This keeps the common lock order rooted
        // at business_catalog while preserving accepted-operation replays.
        const lockedArtifacts = await assertReadyTenantArtifacts(
          (ids, tenantId) => client.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId, ctx.apiKeyId]),
          referencedArtifactIds,
          ctx.tenantId,
        );
        if (ctx.legacyEndpointSlug !== undefined) {
          const totalArtifactBytes = lockedArtifacts.reduce((sum, artifact) => sum + Number(artifact.sizeBytes), 0);
          if (!Number.isSafeInteger(totalArtifactBytes) || totalArtifactBytes > maxBlobBytes) {
            throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Legacy input artifacts exceed the aggregate byte budget');
          }
        }

        await assertKeySpendAvailable(client, ctx.apiKeyId, ctx.tenantId);

        // T-SUB-03: the extension list, enforced AFTER the replay check so a
        // same-key retry still replays its original operation even if an admin
        // has since narrowed the profile, and BEFORE the first INSERT so a
        // refused submission leaves zero rows behind.
      if (profile.mode === 'pinned') {
          assertProfileExtensionAllowed(
            profile.policy.allowedFileExtensions,
            lockedArtifacts,
            effectiveInput,
            submission.sourceUrl
          );
        }

        await client.query(
          `INSERT INTO operations
             (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version,
              root_task_id, input_ref, correlation_id, callback_url,
              profile_id, profile_revision, connector_bindings, submit_artifacts,
              profile_policy_snapshot, prompt_revisions_pin, prompt_overrides_ref, callback_policy,
              pipeline_json, current_step, progress_percent, progress_message, endpoint_slug, output_format,
              tenant_defaults_ref, tenant_defaults_digest, tenant_defaults_ai_revision, tenant_defaults_prompt_revision,
              tenant_default_connector_id, tenant_default_connector_revision, connector_recipe_pins_ref,
              workflow_schema_slug, workflow_schema_revision, workflow_schema_digest)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                     $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35)`,
          [
            operationId,
            ctx.tenantId,
            ctx.apiKeyId,
            ctx.businessId,
            version,
            canonicalAction,
            submission.sourceUrl ? 'PENDING_INGESTION' : 'ACCEPTED',
            rootTaskId,
            sealedInputRef,
            correlationId,
            // P2-08: callback destination pinned at submit (docs 06). The
            // webhook scheduler reads this on the terminal transition.
            submission.callback?.url ?? null,
            profile.mode === 'pinned' ? profile.profileId : null,
            profile.mode === 'pinned' ? profile.revision : null,
            // Post-pinned snapshot, not post-live: grants and claims read this
            // row; a revision change after submit affects new ops only.
            profile.mode === 'pinned' || Object.keys(admittedBindings).length > 0
              ? JSON.stringify(renderPinnedBindings(admittedBindings))
              : null,
            // CR-12/MM-02: the submission-declared artifact refs (top-level
            // [{artifactId, role}], docs 06) are otherwise discarded here —
            // only `input` reached input_ref. Storing them verbatim lets the
            // result route project input roles without re-reading the
            // request; input_ref keeps its shape (claim snapshots read it as
            // the resolved action input). Migration 0009 defaults to '[]'
            // for pre-existing rows.
            JSON.stringify(submission.artifacts ?? []),
            // T-SUB-02 / PRF-02: the admission-time policy record. NULL means
            // "no profile policy applied" (legacy mode, or a pre-0026 row) and
            // must never be coalesced into an empty policy by a consumer.
            //
            // PLAN04-01: this is the snapshot DTO, NOT the resolved
            // `profile.policy`. `profile.policy.fileUrlAuthConfig` is DECRYPTED
            // PLAINTEXT (profiles.ts decodePolicy), so serializing it here wrote
            // a live token/header/query into a jsonb column that no encryption
            // seam covers, and the claim then handed it to the worker. The
            // builder drops the secret and keeps the immutable
            // `(tenantId, profileId, profileRevision)` ref instead.
            profile.mode === 'pinned'
              ? JSON.stringify(
                  buildProfilePolicySnapshot(profile, ctx.tenantId)
                )
              : null,
            // P745-PRODUCER (step 1): the admission-time prompt-revision
            // markers (non-secret digests). NULL for legacy mode / unwired.
            promptRevisionsPin,
            // P745-CARRIER-IMPL-A (Δ-PC-1): the sealed content carrier (JSON
            // text of the ENC-META envelope), or NULL per adjudication 1c.
            sealedPromptCarrier,
            // CB-02 (B3): the admission-time callback policy snapshot
            // (migration 0035 column). Secret REFERENCES only; NULL keeps the
            // legacy notification-only path byte-identical.
            callbackPolicyPin === null ? null : JSON.stringify(callbackPolicyPin),
            // Legacy workflow projection only. It stores non-secret workflow
            // identity/progress markers; request variables and the schema
            // snapshot remain in the encrypted task payload.
            legacyPipelineJson ? JSON.stringify(legacyPipelineJson) : null,
            ctx.legacyProjection ? 0 : null,
            ctx.legacyProjection ? 0 : null,
            ctx.legacyProjection?.progressMessage ?? null,
            ctx.legacyProjection?.endpointSlug ?? null,
            typeof effectiveInput.outputFormat === 'string' ? effectiveInput.outputFormat : typeof submission.output?.format === 'string' ? submission.output.format : null,
            sealedTenantDefaults,
            tenantDefaults?.settingsDigest ?? null,
            tenantDefaults?.aiRevision ?? null,
            tenantDefaults?.promptRevision ?? null,
            tenantDefaults?.ai.connectorId ?? null,
            tenantDefaults?.ai.connectorRevision ?? null,
            sealedConnectorRecipePins,
            workflowPin?.slug ?? null,
            workflowPin?.revision ?? null,
            workflowPin?.digest ?? null,
          ]
        );

        await client.query(
          `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
           VALUES ($1,$2,'root',$3,$4,$5,0, now())`,
          [rootTaskId, operationId, manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
            sealedTaskPayload,
            submission.sourceUrl ? 'PENDING_INGESTION' : 'READY']
        );

        // Admission-time uploads (legacy facade, public upload) start with a
        // NULL operation_id, and the worker access-grant route joins artifacts
        // to operations — leaving them unlinked 404s every worker read of the
        // submitted document. Attach them inside the same transaction, fenced
        // to same-tenant READY rows this admission already locked and only
        // while they are still unlinked; a row claimed by another operation is
        // never re-pointed and stays reachable through its declared reference.
        if (referencedArtifactIds.length > 0) {
          await client.query(
            `UPDATE artifacts SET operation_id=$2
              WHERE id = ANY($1::uuid[]) AND tenant_id=$3 AND state='READY'
                AND operation_id IS NULL AND task_id IS NULL`,
            [referencedArtifactIds, operationId, ctx.tenantId],
          );
        }

        if (ctx.idempotencyKey) {
          await client.query(
            `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, request_hash, operation_id, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey, requestHash, operationId, String(ttlSeconds)]
          );
        }

        // Outbox dispatch row written in the SAME transaction as the state.
        await client.query(
          `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
           VALUES ($1,'task.dispatch',$2,$3)`,
          [
            rootTaskId,
            deliveryId,
            JSON.stringify({
              contractVersion: '1',
              deliveryId,
              taskId: rootTaskId,
              operationId,
              businessId: ctx.businessId,
              businessVersion: version,
              action: canonicalAction,
              kind: manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
              correlationId,
              // T-SUB-03: the BullMQ priority travels in the outbox row because
              // the outbox is what actually enqueues (dispatcher.ts). Legacy
              // mode has no profile priority, and legacy's
              // `resolveBullPriority(undefined)` returned MEDIUM — so an
              // unbound key keeps exactly the number it had before.
              priority:
                profile.mode === 'pinned'
                  ? profile.bullMqPriority
                  : bullMqPriorityFor(PROFILE_JOB_PRIORITY_DEFAULT),
              gate: submission.sourceUrl ? 'ingestion' : undefined,
              // ENC-META-FIX-G1: sealed envelope (or the historical plaintext
              // string when no seam is configured) - see sealOutboxSourceUrl.
              sourceUrl: sealedOutboxSourceUrl,
            }),
          ]
        );

        return { operationId, replayed: false };
      });

      const op = await loadOperationView(db, created.operationId);
      return { operation: op, replayed: created.replayed, correlationId };
    },
  };
}

/**
 * T-SUB-02 / PLAN04-01 — build the admission-time policy snapshot.
 *
 * The resolved `profile.policy` carries `fileUrlAuthConfig` as DECRYPTED
 * PLAINTEXT. This builder is the single place that decides what leaves the
 * process, and the decision is: keep the effective non-secret policy, replace
 * the credential with a boolean plus an immutable ref to the pinned revision.
 *
 * `fileUrlAuthConfigCarriesSecret` is the same predicate the write path uses
 * to decide whether a config is a credential at all; reusing it here means the
 * snapshot cannot disagree with the encrypt path about what counts as a secret.
 *
 * Runtime-validated before it is written. A snapshot that does not satisfy the
 * contract fails the SUBMIT (500) rather than being persisted and failing
 * closed later at claim time — an admission record that cannot be read back
 * is not an admission record.
 */
/** CR06-06: exported so the 422 sentinel is testable without a database. */
export function buildProfilePolicySnapshot(
  profile: Extract<EffectiveProfile, { mode: 'pinned' }>,
  tenantId: string
): ProfilePolicySnapshot {
  // CR06-06: `parameters` is a passthrough bag, so a credential in it would be
  // copied into the admission snapshot verbatim. Refuse the SUBMIT here — 422,
  // caller-fixable — instead of letting the snapshot contract fail later as a
  // 500. Only key NAMES are echoed back; values never leave this point.
  const secretParameterKeys = findSecretParameterKeys(profile.policy.parameters);
  if (secretParameterKeys.length > 0) {
    throw new HttpError(
      422,
      'SECRET_IN_PARAMETERS',
      'profile policy parameters must not carry credential keys',
      {
        errors: secretParameterKeys.map((key) => ({
          pointer: '/profilePolicy/parameters/' + key,
          message: 'parameter key must not carry a credential; configure it through the profile credential surface',
        })),
      }
    );
  }
  const parsed = ProfilePolicySnapshotSchema.safeParse({
    enabled: profile.policy.enabled,
    parameters: profile.policy.parameters,
    jobPriority: profile.policy.jobPriority,
    allowedFileExtensions: profile.policy.allowedFileExtensions,
    connectionsOverride: profile.policy.connectionsOverride,
    fileUrlAuthConfigured: fileUrlAuthConfigCarriesSecret(profile.policy.fileUrlAuthConfig),
    credentialRef: {
      tenantId,
      profileId: profile.profileId,
      profileRevision: profile.revision,
    },
  });
  if (!parsed.success) {
    throw new HttpError(
      500,
      'INVALID_SCHEMA',
      'resolved profile policy does not satisfy the snapshot contract',
      {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/profilePolicy/' + i.path.join('/'),
          message: i.message,
        })),
      }
    );
  }
  return parsed.data;
}

/**
 * CB-02 (B3) — the admission-time callback-policy pin written to
 * `operations.callback_policy` (migration 0035). Returns null when the pinned
 * profile carries no callback policy, preserving the legacy notification-only
 * delivery byte-for-byte. The snapshot copies tenant/profile/endpoint identity
 * plus the revision so a later publish/rollback cannot retarget an already
 * admitted callback.
 */
export function buildCallbackPolicySnapshot(
  profile: Extract<EffectiveProfile, { mode: 'pinned' }>,
  input: { tenantId: string; businessId: string; businessVersion: string; endpointKey: string }
): ProfileCallbackPolicySnapshot | null {
  const policy = profile.policy.callbackPolicy;
  if (policy == null) return null;
  const parsed = ProfileCallbackPolicySnapshotSchema.safeParse({
    tenantId: input.tenantId,
    businessId: input.businessId,
    businessVersion: input.businessVersion,
    // The `profile_names` registry name is the display identity; profileId is
    // the stable fallback for legacy rows that predate the registry.
    profileName: profile.profileName ?? profile.profileId,
    endpointKey: input.endpointKey,
    profileRevision: profile.revision,
    policy,
  });
  if (!parsed.success) {
    throw new HttpError(
      500,
      'INVALID_SCHEMA',
      'resolved callback policy does not satisfy the snapshot contract',
      {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/callbackPolicy/' + i.path.join('/'),
          message: i.message,
        })),
      }
    );
  }
  return parsed.data;
}

/**
 * P745-PRODUCER (step 1, marker-only): the non-secret prompt-revision markers.
 *
 * One marker per override row that actually carries a prompt (named steps and
 * `_default` alike). A cleared row (`promptOverride: null`) pins NOTHING: the
 * effective prompt at that step is the default, and a marker would claim a
 * revision that does not exist. The revision is a content digest scoped to
 * its row identity; the prompt content itself never leaves
 * `connector_prompt_overrides` in this phase (Δ-1 owns the sealed carrier).
 * The array is sorted so two admissions of the same bucket pin byte-identical
 * JSON regardless of row order.
 */
export interface PromptRevisionMarker {
  connectionId: string;
  stepId: string;
  revision: string;
}

export function buildPromptRevisionsPin(
  rows: readonly PromptOverrideRead[]
): PromptRevisionMarker[] {
  return rows
    .filter((row) => typeof row.promptOverride === 'string' && row.promptOverride.length > 0)
    .map((row) => ({
      connectionId: row.connectionId,
      stepId: row.stepId,
      revision:
        'sha256:' +
        createHash('sha256')
          .update(`${row.connectionId}|${row.stepId}|${row.promptOverride}`)
          .digest('hex'),
    }))
    .sort((a, b) => {
      if (a.connectionId !== b.connectionId) return a.connectionId < b.connectionId ? -1 : 1;
      if (a.stepId !== b.stepId) return a.stepId < b.stepId ? -1 : 1;
      return 0;
    });
}

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1, adjudication 1d): the content-carrier caps.
 * Exceeded ⇒ 422 `PROMPT_CARRIER_TOO_LARGE` BEFORE any seal or write, so an
 * oversized bucket can never hold a submit transaction open against Vault
 * (and can never silently truncate a prompt).
 */
export const PROMPT_CARRIER_LIMITS = {
  maxRows: 64,
  maxRowBytes: 16 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1): the CONTENT carrier rows.
 *
 * Built from the SAME filtered/sorted row set as `buildPromptRevisionsPin`
 * (content-bearing rows only; cleared rows pin nothing in either shape), so
 * the claim's cross-check is an equality of two views of one list, not a
 * reconciliation of two reads. The revision formula is identical to the
 * marker's — phase 1 and phase 2 describe the same content with one hash.
 */
export function buildPromptCarrier(
  rows: readonly PromptOverrideRead[]
): PinnedPromptOverride[] {
  return rows
    .filter(
      (row): row is PromptOverrideRead & { promptOverride: string } =>
        typeof row.promptOverride === 'string' && row.promptOverride.length > 0
    )
    .map((row) => ({
      connectionId: row.connectionId,
      stepId: row.stepId,
      promptOverride: row.promptOverride,
      revision:
        'sha256:' +
        createHash('sha256')
          .update(`${row.connectionId}|${row.stepId}|${row.promptOverride}`)
          .digest('hex'),
    }))
    .sort((a, b) => {
      if (a.connectionId !== b.connectionId) return a.connectionId < b.connectionId ? -1 : 1;
      if (a.stepId !== b.stepId) return a.stepId < b.stepId ? -1 : 1;
      return 0;
    });
}

export function assertPromptCarrierCaps(rows: readonly PinnedPromptOverride[]): void {
  const { maxRows, maxRowBytes, maxTotalBytes } = PROMPT_CARRIER_LIMITS;
  if (rows.length > maxRows) {
    throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `prompt override bucket exceeds ${maxRows} rows`);
  }
  let total = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.promptOverride, 'utf8');
    if (bytes > maxRowBytes) {
      throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `a prompt override exceeds ${maxRowBytes} bytes`);
    }
    total += bytes;
  }
  if (total > maxTotalBytes) {
    throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `prompt override bucket exceeds ${maxTotalBytes} bytes in total`);
  }
}

/**
 * The parameter keys the action's inputSchema declares.
 *
 * These are the keys the profile is allowed to default or lock. Legacy
 * `mergeParameters` walked the union of the manifest's declared keys and the
 * DB profile's keys; the manifest half is what this extracts.
 */
export function declaredParameterKeys(inputSchema: object): string[] {
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties as Record<string, unknown>);
}

const LEGACY_NAMED_WORKFLOW_CONNECTOR_SLOTS: Readonly<Record<string, readonly string[]>> = {
  'lc-checker': ['legacy-ocr', 'legacy-compliance', 'legacy-report'],
  'doc-compare': ['legacy-ocr', 'legacy-toc', 'legacy-compare', 'legacy-report'],
};

function legacyNamedWorkflowProcess(businessId: string, action: string, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const marker = (input as Record<string, unknown>)['legacyWorkflow'];
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return null;
  const value = marker as Record<string, unknown>;
  if (value['version'] !== 'legacy-workflow-named-input-v1' || typeof value['process'] !== 'string') return null;
  const process = value['process'];
  if (process === 'lc-checker' && businessId === 'lc-checker' && action === 'lc-checker') return process;
  if (process === 'doc-compare' && businessId === 'document-core' && action === 'doc-compare') return process;
  return null;
}

function requireLegacyNamedWorkflowBindings(bindings: ConnectorPinMap, process: string): void {
  const requiredSlots = LEGACY_NAMED_WORKFLOW_CONNECTOR_SLOTS[process];
  if (!requiredSlots) return;
  for (const slot of requiredSlots) {
    if (bindings[slot] === undefined) {
      throw forbidden(`legacy ${process} workflow connector slot ${slot} is not pinned by the Profile or tenant defaults`);
    }
  }
}

/** Validate URL syntax and the same outbound policy used by callback delivery. */
export function validateSourceUrl(value: string): URL {
  if (value.startsWith('s3://')) {
    try { parseS3Source(value); return new URL(value); }
    catch { throw unprocessable('INVALID_SCHEMA', 'sourceUrl must identify a valid S3 object'); }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl must be an HTTPS URL without credentials');
  }
  const decision = adjudicateUrlDestination(value);
  if (decision.kind === 'DENIED') {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl destination is not allowed');
  }
  return parsed;
}

/**
 * Completes the ingestion gate after the worker has acquired and pinned the
 * source. The business task is made READY only after the immutable version
 * and SHA-256 are recorded in its payload.
 *
 * Δ14 fix: BOTH rows — `operations.input_ref` and `tasks.payload_ref` — now
 * carry the byte-identical READY envelope built by the contract
 * (`withIngestionSource`: action input + canonical `source` pin, legacy
 * `__source` dropped). The worker-SDK claim resolution picks
 * `tasks.payload_ref` when it is non-empty and `operations.input_ref`
 * otherwise, so previously the pin could exist in one view and not the other
 * — the same task resolving to two different inputs depending on a branch
 * nobody owns. Envelope validation fails closed BEFORE any write: a receipt
 * that cannot pass `IngestionReceiptSchema` can never open a READY gate.
 */
export async function markIngestionReady(
  db: Db,
  operationId: string,
  receipt: IngestionReceipt,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  /**
   * W-INGEST-POST-LEASE-FENCE-1 (T180-D1): optional ownership fence executed
   * INSIDE the gate transaction, before any gate write. A preempted consumer
   * must abort atomically with the gate statements un-run; checking outside
   * the tx would leave the classic check-then-write race the fence exists
   * to close. The guard throws its own typed error; markIngestionReady
   * neither invents nor swallows it.
   */
  commitGuard?: (client: DbClient) => Promise<void>,
  /** CR28-04: forwarded verbatim into the gate transaction. */
  metadataCrypto?: MetadataCrypto
): Promise<void> {
  const envelope = JSON.stringify(withIngestionSource(input, receipt));
  await db.tx(async (client) => {
    if (commitGuard) await commitGuard(client);
    await markIngestionReadyOn(client, operationId, receipt, input, dispatch, envelope, metadataCrypto);
  });
}

/**
 * The three gate statements, split from markIngestionReady so the
 * transaction (and any commit guard) belongs to the caller - this is how
 * the ingestion consumer runs fence and gate as ONE atomic unit while
 * every existing caller keeps the exact one-call behavior. Statements are
 * byte-identical to the historical body.
 */
export async function markIngestionReadyOn(
  client: DbClient,
  operationId: string,
  receipt: IngestionReceipt,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  envelope: string = JSON.stringify(withIngestionSource(input, receipt)),
  /** CR28-04: seal the gate values; absent = plaintext, historical behaviour. */
  metadataCrypto?: MetadataCrypto
): Promise<void> {
    // CR28-04: the gate writes the SAME logical envelope into two columns, but
    // the AAD binds an envelope to (tenant, slot, row). One sealed value
    // therefore CANNOT serve both: a payload_ref blob copied into input_ref is
    // exactly what the slot binding exists to refuse. So each column is sealed
    // for its own row, which means the row identities have to be read first.
    // The read locks both rows in the SAME transaction as the gate writes, so
    // the id and tenant cannot change under the seal.
    let sealedOperationInput = envelope;
    let sealedTaskPayload = envelope;
    if (metadataCrypto) {
      const bound = await client.query(
        `SELECT o.tenant_id AS tenant_id, t.id AS task_id
           FROM operations o
           JOIN tasks t ON t.operation_id = o.id AND t.task_key = 'root'
          WHERE o.id=$1 AND o.state='PENDING_INGESTION' AND t.state='PENDING_INGESTION'
          FOR UPDATE OF o, t`,
        [operationId]
      );
      const row = bound.rows[0];
      // No row means the gate is already closed. The UPDATEs below are
      // rowCount-guarded and will simply not fire; sealing under a guessed
      // identity would be worse than writing nothing.
      if (row) {
        // CRX-01: seal the envelope VALUE (object), not its serialized text —
        // an opened gate envelope then has the same JSON shape the plaintext
        // column would have held, which is what the claim execution snapshot
        // (executionSnapshot.payloadRef, parsed by the worker SDK) requires.
        const readyEnvelope = withIngestionSource(input, receipt);
        sealedOperationInput = await sealSubmitMetadata(
          metadataCrypto, readyEnvelope, row.tenant_id as string, 'operations.input_ref', operationId
        );
        sealedTaskPayload = await sealSubmitMetadata(
          metadataCrypto, readyEnvelope, row.tenant_id as string, 'tasks.payload_ref', row.task_id as string
        );
      }
    }
    await client.query(
      `UPDATE operations
          SET state='QUEUED', state_version=state_version+1, input_ref=$2, updated_at=now()
        WHERE id=$1 AND state='PENDING_INGESTION'`,
      [operationId, sealedOperationInput]
    );
    await client.query(
      `UPDATE tasks
          SET state='READY', payload_ref=$2, updated_at=now()
        WHERE operation_id=$1 AND task_key='root' AND state='PENDING_INGESTION'`,
      [operationId, sealedTaskPayload]
    );
    await client.query(
      `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
       SELECT id, 'task.dispatch', $2, $3 FROM tasks
        WHERE operation_id=$1 AND task_key='root' AND state='READY'`,
      [operationId, dispatch.deliveryId, JSON.stringify({
        contractVersion: '1', deliveryId: dispatch.deliveryId, operationId,
        kind: dispatch.kind, correlationId: dispatch.correlationId, gate: 'ready',
      })]
    );
}

/** Execute one durable ingestion task. The acquirer owns bounded HTTP/S3
 * transfer policy; this boundary only accepts its immutable receipt and then
 * opens the READY gate, so retries can reuse the pinned copy. */
export async function processIngestionTask(
  db: Db,
  operationId: string,
  sourceUrl: string,
  acquirer: SourceAcquirer,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  /** W-INGEST-POST-LEASE-FENCE-1: forwarded verbatim into the gate tx (see markIngestionReady). */
  commitGuard?: (client: DbClient) => Promise<void>,
  /** CR28-04: forwarded verbatim into the gate transaction. */
  metadataCrypto?: MetadataCrypto
): Promise<IngestionReceipt> {
  validateSourceUrl(sourceUrl);
  const receipt = await acquirer.acquire(sourceUrl);
  if (!/^sha256:[0-9a-f]{64}$/i.test(`sha256:${receipt.sha256.replace(/^sha256:/i, '')}`)) {
    throw new Error('ingestion acquirer returned an invalid SHA-256 receipt');
  }
  await markIngestionReady(db, operationId, receipt, input, dispatch, commitGuard, metadataCrypto);
  return receipt;
}

interface SubmissionArtifactRow {
  id: string;
  state: string;
  expired: boolean;
  fileName: string | null;
  sizeBytes?: number | string;
}

const ARTIFACT_REFERENCE_QUERY = `
  SELECT id, state, file_name AS "fileName", size_bytes AS "sizeBytes", (expires_at IS NOT NULL AND expires_at <= now()) AS expired
  FROM artifacts
  WHERE id = ANY($1::uuid[]) AND tenant_id = $2
    AND ((operation_id IS NULL AND upload_api_key_id=$3) OR EXISTS (
      SELECT 1 FROM operations owner WHERE owner.id=artifacts.operation_id
        AND owner.tenant_id=$2 AND owner.api_key_id=$3 AND owner.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM operations owner WHERE owner.tenant_id=$2 AND owner.api_key_id=$3 AND owner.deleted_at IS NULL
        AND owner.submit_artifacts @> jsonb_build_array(jsonb_build_object('artifactId', artifacts.id::text))
    ))
    AND NOT EXISTS (
      SELECT 1 FROM operations owner WHERE owner.tenant_id=$2 AND owner.api_key_id<>$3
        AND owner.submit_artifacts @> jsonb_build_array(jsonb_build_object('artifactId', artifacts.id::text))
    )
  ORDER BY id
  FOR SHARE
`;

type ArtifactReferenceLookup = (
  artifactIds: string[],
  tenantId: string
) => Promise<{ rowCount: number | null; rows: SubmissionArtifactRow[] }>;

async function assertReadyTenantArtifacts(
  lookup: ArtifactReferenceLookup,
  artifactIds: string[],
  tenantId: string
): Promise<SubmissionArtifactRow[]> {
  if (artifactIds.length === 0) return [];
  const result = await lookup(artifactIds, tenantId);
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  for (const artifactId of artifactIds) {
    const artifact = rowsById.get(artifactId);
    // Tenant-scoped lookup deliberately treats unknown and foreign artifacts
    // alike, so the public API does not confirm another tenant's resource.
    if (!artifact || artifact.expired || artifact.state === 'EXPIRED' || artifact.state === 'DELETED') {
      throw notFound('artifact not found or expired');
    }
    if (artifact.state !== 'READY') {
      throw conflict('STATE_CONFLICT', 'all submitted artifacts must be READY');
    }
  }
  return result.rows;
}

/**
 * T-SUB-03 — the profile's `allowedFileExtensions` enforced at the ONE point
 * that knows which action (and therefore which profile) applies.
 *
 * Legacy enforced the same CSV in two places, both of which knew the endpoint:
 * `saveUploadedFile` at submit (lib/pipelines/submit.ts:195) and
 * `downloadAllFileUrls` at download (:278). du-rework's upload-init route
 * (`POST /api/v1/uploads`) is deliberately NOT one of them: it carries no
 * business/action, so the profile it would have to check is unknowable, and
 * guessing would 422 a legitimate upload against the wrong action's policy.
 * Submission is the gate; the download side is covered by the pinned snapshot
 * the worker reads (T-SUB-04).
 *
 * Only the EFFECTIVE input's `fileUrls` are checked — the raw body's copy is
 * what the idempotency hash covers, and a profile edit between two retries
 * must not turn a replay into a 422.
 */
function assertProfileExtensionAllowed(
  csv: string,
  artifacts: readonly SubmissionArtifactRow[],
  effectiveInput: Record<string, unknown>,
  sourceUrl: string | undefined
): void {
  // PLAN04-01: the top-level `sourceUrl` is a source acquisition path like any
  // other, and the plan names this gap explicitly. It is checked here rather
  // than left to the acquisition leg because admission is the ONE point that
  // knows which action (and therefore which profile) applies.
  //
  // The name comes from the URL path alone: this runs BEFORE any network call,
  // so it is a policy check on caller-supplied metadata, not a conclusion
  // about what the host will actually serve.
  if (sourceUrl !== undefined) {
    // `fileUrlEntryName` takes a `file_urls` ENTRY, not a bare string: it
    // returns null for anything that is not an object. Wrapping keeps the
    // extension resolution identical to the other two paths instead of
    // re-implementing the pathname rule a second time.
    const fileName = fileUrlEntryName({ url: sourceUrl });
    if (fileName !== null) {
      const reason = extensionDeniedReason(csv, fileName);
      if (reason) {
        throw unprocessable('PROFILE_EXTENSION_DENIED', `sourceUrl: ${reason}`, {
          errors: [{ pointer: '/sourceUrl', message: reason }],
        });
      }
    }
  }

  for (const artifact of artifacts) {
    if (!artifact.fileName) continue;
    const reason = extensionDeniedReason(csv, artifact.fileName);
    if (reason) {
      throw unprocessable('PROFILE_EXTENSION_DENIED', `artifact ${artifact.id}: ${reason}`, {
        errors: [{ pointer: '/artifacts', message: reason }],
      });
    }
  }

  const fileUrls = effectiveInput.fileUrls;
  if (!Array.isArray(fileUrls)) return;
  for (const [index, entry] of fileUrls.entries()) {
    // Legacy's own name resolution, minus Content-Disposition, which needs the
    // HTTP response and therefore belongs to the download leg.
    const fileName = fileUrlEntryName(entry);
    if (fileName === null) continue;
    const reason = extensionDeniedReason(csv, fileName);
    if (reason) {
      throw unprocessable('PROFILE_EXTENSION_DENIED', `file_urls[${index}]: ${reason}`, {
        errors: [{ pointer: `/fileUrls/${index}`, message: reason }],
      });
    }
  }
}

function collectArtifactReferences(value: unknown): string[] {
  const ids = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    const record = current as Record<string, unknown>;
    const artifactId = record.artifactId;
    if (typeof artifactId === 'string' && ARTIFACT_ID_PATTERN.test(artifactId)) {
      ids.add(artifactId.toLowerCase());
    }
    pending.push(...Object.values(record));
  }
  return [...ids].sort();
}

function assertEmbeddedInputByteBudget(input: unknown, maxBytes: number): void {
  let totalBytes = 0;
  const pending: Array<{ value: unknown; key: string; inFileContainer: boolean }> = [
    { value: input, key: '', inFileContainer: false },
  ];

  const addBytes = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'embedded file data exceeds the configured byte limit');
    }
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    const { value, key, inFileContainer } = current;
    if (typeof value === 'string') {
      const dataUri = /^data:[^,]*;base64,([\s\S]*)$/i.exec(value);
      if (dataUri) {
        addBytes(base64ByteLength(dataUri[1]!));
      } else if (isEmbeddedByteField(key) || (inFileContainer && /^(data|content|body)$/i.test(key))) {
        addBytes(isBase64(value) ? base64ByteLength(value) : Buffer.byteLength(value, 'utf8'));
      }
      continue;
    }
    if (Array.isArray(value)) {
      if ((isEmbeddedByteField(key) || (inFileContainer && /^(data|content|body)$/i.test(key))) &&
          value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
        addBytes(value.length);
        continue;
      }
      for (const item of value) pending.push({ value: item, key: '', inFileContainer });
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;

    const record = value as Record<string, unknown>;
    if (record.type === 'Buffer' && Array.isArray(record.data) &&
        record.data.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
      addBytes(record.data.length);
      continue;
    }
    const objectHasFileName = Object.keys(record).some((childKey) => {
      const normalizedKey = childKey.toLowerCase().replace(/[_-]/g, '');
      return normalizedKey === 'filename' || normalizedKey === 'originalfilename';
    });
    for (const [childKey, childValue] of Object.entries(record)) {
      const normalizedKey = childKey.toLowerCase().replace(/[_-]/g, '');
      const childInFileContainer = inFileContainer || normalizedKey === 'file' || normalizedKey === 'files' ||
        normalizedKey === 'upload' || normalizedKey === 'uploads' || objectHasFileName;
      pending.push({ value: childValue, key: childKey, inFileContainer: childInFileContainer });
    }
  }
}

function isEmbeddedByteField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return normalized.includes('base64') || [
    'bytes', 'file', 'filebytes', 'rawbytes', 'binary', 'binarydata', 'blob', 'blobdata', 'filedata', 'filecontent',
  ].includes(normalized);
}

function isBase64(value: string): boolean {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized);
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!isBase64(normalized)) return Buffer.byteLength(value, 'utf8');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, (normalized.length * 3) / 4 - padding);
}

async function resolveEnabledVersion(db: Db, businessId: string, action: string) {
  const logicalBusiness = await db.query<{
    enabled: boolean;
    activation_revision: number | string;
    submissions_paused: boolean;
    pre_drain_version: string | null;
  }>(
    'SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog WHERE business_id=$1 LIMIT 1',
    [businessId],
  );
  if (!logicalBusiness.rowCount) throw notFound(`business ${businessId} is not registered`);
  if (!logicalBusiness.rows[0]!.enabled) throw conflict('STATE_CONFLICT', `business ${businessId} is disabled`);
  if (logicalBusiness.rows[0]!.submissions_paused) {
    throw conflict('BUSINESS_SUBMISSIONS_PAUSED', `new submissions are paused while ${logicalBusiness.rows[0]!.pre_drain_version ?? 'the active version'} drains`);
  }
  // New submissions target the explicitly ACTIVE enabled version (W28-C).
  // The admin activate/deactivate routes and enableVersionForTest maintain
  // the active pointer. Fail-closed: if no version is active, the business
  // cannot receive new submissions until an operator activates a version.
  // This prevents a drained version from being silently re-selected by a
  // "newest ENABLED" ordering heuristic (W27-A Case 10 / W28-C review).
  const res = await db.query(
    `SELECT version,manifest,digest,queue,status FROM business_versions
     WHERE business_id=$1 AND is_active=true
     LIMIT 1`,
    [businessId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new HttpError(404, 'NOT_FOUND', `no active version for business ${businessId}; activate one via the admin API`);
  }
  const row = res.rows[0] as { version: string; manifest: BusinessManifest; digest: string; queue: string; status: string };
  if (row.status !== 'ENABLED') throw conflict('VERSION_NOT_ENABLED', `active version ${businessId}@${row.version} is not enabled`);
  if (!row.manifest.actions.some((a) => a.name === action)) {
    throw badRequest(`action ${action} not offered by ${businessId}@${row.version}`);
  }
  const activationRevision = Number(logicalBusiness.rows[0]!.activation_revision);
  if (!Number.isSafeInteger(activationRevision) || activationRevision < 1) {
    throw new Error('business activation revision is invalid');
  }
  return { version: row.version, manifest: row.manifest, digest: row.digest, queue: row.queue, activationRevision };
}

async function findSubmissionKey(
  db: Db,
  tenantId: string,
  apiKeyId: string,
  routeAction: string,
  key: string
): Promise<{ operation_id: string; request_hash: string } | null> {
  const res = await db.query(
    `SELECT operation_id, request_hash FROM submission_keys
     WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 AND expires_at > now()`,
    [tenantId, apiKeyId, routeAction, key]
  );
  return res.rowCount ? (res.rows[0] as { operation_id: string; request_hash: string }) : null;
}

export async function loadOperationView(db: Db, operationId: string): Promise<OperationView> {
  const res = await db.query(
    `SELECT id, tenant_id, business_id, business_version, action, state, state_version,
            created_at, updated_at, deadline_at, result_ref
     FROM operations WHERE id=$1`,
    [operationId]
  );
  if (!res.rowCount) {
    throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
  }
  const r = res.rows[0] as Record<string, unknown>;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    businessId: r.business_id as string,
    businessVersion: r.business_version as string,
    action: r.action as string,
    state: r.state as OperationView['state'],
    stateVersion: r.state_version as number,
    createdAt: new Date((r.created_at as string) ?? new Date().toISOString()).toISOString(),
    updatedAt: new Date((r.updated_at as string) ?? new Date().toISOString()).toISOString(),
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string).toISOString() : null,
    progress: { percent: 0, message: r.state as string },
    links: {
      self: `/api/v1/operations/${String(r.id)}`,
      result: `/api/v1/operations/${String(r.id)}/result`,
    },
  };
}
