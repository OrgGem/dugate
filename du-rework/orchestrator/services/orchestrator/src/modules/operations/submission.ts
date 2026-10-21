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
  computeResolutionFingerprint,
  CredentialAllowedOriginsSchema,
  ProfileCallbackPolicySchema,
  type ProfileGroupResolutionRefsV2,
  type ProfileParameterValue,
  type Submission,
} from '@du/contracts';
import { normalizeCorrelationId } from '@du/observability';
import type { MetadataCrypto, MetadataSlot } from '../runtime/metadata-crypto';
import { readBusinessAdmission } from '../registry/version-admission';
import { z } from 'zod';
import { Db } from '../../db/db';
import { RegistryService } from '../registry/registry';
import {
  ProfileService,
  normalizeStoredRequestDefaults,
  parseConnectorBindings,
  renderPinnedBindings,
  type ConnectorPinMap,
  type EffectiveProfile,
  type EffectiveProfilePolicy,
} from '../profiles/profiles';
import {
  bullMqPriorityFor,
  coerceAllowedFileExtensions,
  coerceConnectionsOverride,
  coerceEnabled,
  coerceJobPriority,
  coerceRowParameters,
  extensionDeniedReason,
  fileUrlEntryName,
  mergeParameters,
  resolveRequestParameters,
} from '../profiles/policy';
import { readGroupAuthority, resolveRootGrant } from '../profiles/profile-groups';
import { decryptFileUrlAuthConfig, fileUrlAuthConfigCarriesSecret, type ProfileEnv } from '../profiles/file-url-auth';
import type { PromptOverrideService } from '../profiles/prompt-overrides';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { compileConnectorRecipePins, type ConnectorRecipeNodeInput } from '../connectors/recipe-compiler';
import { sealTenantDefaultsSnapshot } from '../global-settings/snapshot';
import { LegacyWorkflowSchemaCatalogError, resolveLegacyWorkflowSchema } from '../workflow-schemas/workflow-schemas';
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
  /** Endpoint selector from a saved Profile, verified by the Admin Workbench before submission. */
  profileEndpointSlug?: string;
  /** Admin Workbench request identity; kept out of public and legacy request hashes. */
  adminWorkbenchProfileIdentity?: { profileId: string; profileName: string; revision: number; endpointSlug: string | null };
  legacyExpectedProfile?: { profileId: string; revision: number; profileName?: string } | null;
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
  /**
   * PC-05: a v2 admission already resolved and authorized this request.
   * Passing it prevents a second, racing resolution between fingerprint
   * verification and the write.
   */
  resolvedAdmission?: ResolvedAdmission;
  /**
   * PC-05: v2 idempotency. The fingerprint is compared with the value the
   * FIRST accepted request stored (`submission_keys.resolution_fingerprint`),
   * and `routeAction` keeps the v2 scope separate from the v1 route.
   */
  v2?: { resolutionFingerprint: string; routeAction: string };
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

/* ------------------------------------------------------------------ */
/* PC-05: root-grant admission (the front resolver)                   */
/* ------------------------------------------------------------------ */

/** The immutable group pin an admission resolved and must persist/verify. */
export interface GroupAdmissionPin {
  groupId: string;
  tenantId: string;
  groupRevision: number;
  accessVersion: number;
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  kind: 'endpoint' | 'workflow';
  functionId: string;
  action: string;
  endpointSlug: string | null;
  workflowRevision: number | null;
  childProfileId: string;
  childRevision: number;
}

export interface ResolvedAdmission {
  profile: EffectiveProfile;
  /**
   * Finding 3: the tenant-defaults snapshot the fingerprint was computed over.
   * Forwarded from the preview so admission seals the SAME defaults instead of
   * reading them a second time — a concurrent settings publish would otherwise
   * make the stored defaults disagree with the fingerprinted ones. `undefined`
   * means "not forwarded" (v1 path); `null` means "forwarded, no snapshot".
   */
  tenantDefaults?: TenantDefaultsSnapshot | null;
  /** Non-null only for a `GROUP_MANAGED` key resolved through a root grant. */
  groupPin: GroupAdmissionPin | null;
  /**
   * PC-05: the projection the v2 preview returns. Present only when the action
   * declares `parameterResolution`; absent means v1 merge semantics applied.
   */
  requestResolution?: {
    appliedRequestDefaults: string[];
    appliedSchemaDefaults: string[];
    lockedParameters: string[];
  };
}

/** PC-05: the shared v2 request, used by the public route and the workbench. */
export interface ProfileResolutionV2Request {
  tenantId: string;
  apiKeyId: string;
  /** Group addressed by the route, or the key's root-grant group for workbench. */
  groupId: string;
  selector: {
    businessId: string;
    businessVersion: string;
    action: string;
    functionId: string;
    endpointSlug?: string;
  };
  submission: unknown;
  /** Required for submit; preview ignores it. */
  idempotencyKey?: string;
  correlationId?: string;
  /** Required for submit: the fingerprint the preview returned. */
  resolutionFingerprint?: string;
}

export interface ProfileResolutionV2Preview {
  groupId: string;
  refs: ProfileGroupResolutionRefsV2;
  resolutionFingerprint: string;
  effective: {
    parameters: Record<string, unknown>;
    appliedRequestDefaults: string[];
    appliedSchemaDefaults: string[];
    lockedParameters: string[];
  };
}

export interface AdmissionSelector {
  businessId: string;
  businessVersion: string;
  action: string;
  endpointSlug?: string;
  /** v2: exact function id. v1 omits it and uses the unique-match rule. */
  functionId?: string;
  /** v2: the group addressed by the route; must equal the key's root grant. */
  groupId?: string;
}

/** The action slice the resolver needs; keeps it independent of registry internals. */
export interface AdmissionActionShape {
  inputSchema: object;
  profileSchema: object;
  parameterResolution?: {
    fields: Readonly<Record<string, 'requestDefaults' | 'profileSettings'>>;
    applyTopLevelDefaults: boolean;
  };
}

export interface ResolveAdmissionInput {
  apiKeyId: string;
  tenantId: string;
  selector: AdmissionSelector;
  action: AdmissionActionShape;
  clientInput: Record<string, unknown>;
  declaredKeys: readonly string[];
}

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface GroupMemberAdmissionRow extends Record<string, unknown> {
  group_id: string;
  tenant_id: string;
  group_revision: number;
  auth_authority: string;
  access_version: string | number;
  business_id: string;
  business_version: string;
  manifest_digest: string;
  function_kind: 'endpoint' | 'workflow';
  function_id: string;
  action: string;
  endpoint_slug: string | null;
  workflow_revision: number | null;
  profile_id: string;
  binding_revision: number;
  enabled: boolean | null;
  parameters: unknown;
  request_defaults: unknown;
  connector_bindings: unknown;
  job_priority: string | null;
  allowed_file_extensions: string | null;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
  callback_policy: unknown;
  allowed_origins: unknown;
  profile_name: string | null;
  group_owned: boolean | null;
}

function groupDenied(detail: string): HttpError {
  return new HttpError(403, 'PROFILE_GROUP_UNAUTHORIZED', detail);
}

async function readApiKeyAuthorization(
  client: Queryable,
  apiKeyId: string,
): Promise<{ id: string; tenantId: string; status: string; keyMode: string | null } | null> {
  const result = await client.query<{ id: string; tenant_id: string; status: string; key_mode: string | null }>(
    'SELECT id, tenant_id, status, key_mode FROM api_keys WHERE id=$1',
    [apiKeyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, tenantId: row.tenant_id, status: row.status, keyMode: row.key_mode };
}

/** Same tolerance as the profile read path: a stored value never fails a read. */
function parseStoredAllowedOrigins(raw: unknown): string[] {
  let value = raw;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile allowed origins are invalid');
    }
  }
  const parsed = CredentialAllowedOriginsSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile allowed origins do not satisfy their contract');
  }
  return parsed.data;
}

function parseStoredCallbackPolicy(raw: unknown) {
  if (raw === null || raw === undefined) return null;
  const parsed = ProfileCallbackPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile callback policy does not satisfy its contract');
  }
  return parsed.data;
}

/**
 * Decode one immutable `profile_bindings` row into the policy the admission
 * hands downstream.
 *
 * This mirrors `profiles.ts`' `decodePolicy` (module-private, PC-03's file).
 * Every helper it needs is exported except the two stored-value parsers, which
 * are reproduced above with identical semantics so a malformed stored row fails
 * closed exactly once and in the same way.
 */
function decodeGroupPolicy(row: GroupMemberAdmissionRow, cryptoEnv: ProfileEnv): EffectiveProfilePolicy {
  const decrypted = decryptFileUrlAuthConfig(row.file_url_auth_cipher, cryptoEnv);
  return {
    enabled: coerceEnabled(row.enabled),
    parameters: coerceRowParameters(row.parameters),
    jobPriority: coerceJobPriority(row.job_priority),
    allowedFileExtensions: coerceAllowedFileExtensions(row.allowed_file_extensions),
    connectionsOverride: coerceConnectionsOverride(row.connections_override),
    fileUrlAuthConfig: decrypted?.config ?? null,
    allowedOrigins: parseStoredAllowedOrigins(row.allowed_origins),
    callbackPolicy: parseStoredCallbackPolicy(row.callback_policy),
  };
}

function buildPinnedProfile(
  row: GroupMemberAdmissionRow,
  policy: EffectiveProfilePolicy,
  action: AdmissionActionShape,
  clientInput: Record<string, unknown>,
  declaredKeys: readonly string[],
): {
  profile: EffectiveProfile;
  requestResolution?: ResolvedAdmission['requestResolution'];
} {
  const requestDefaults = normalizeStoredRequestDefaults(row.request_defaults) as Record<string, ProfileParameterValue>;
  let effectiveParameters: Record<string, unknown>;
  let passthrough: Record<string, unknown> = {};
  let requestResolution: ResolvedAdmission['requestResolution'];

  if (action.parameterResolution) {
    // v2 semantics: `profileSettings` never reaches request input; only
    // `requestDefaults` and top-level schema defaults fill absent properties.
    const resolved = resolveRequestParameters({
      clientInput,
      requestDefaults,
      profileSettings: policy.parameters,
      fields: action.parameterResolution.fields,
      applyTopLevelDefaults: action.parameterResolution.applyTopLevelDefaults,
      inputProperties: (action.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown> ?? {},
      profileProperties: (action.profileSchema as Record<string, unknown>)['properties'] as Record<string, unknown> ?? {},
    });
    effectiveParameters = resolved.parameters;
    requestResolution = {
      appliedRequestDefaults: resolved.appliedRequestDefaults,
      appliedSchemaDefaults: resolved.appliedSchemaDefaults,
      lockedParameters: resolved.lockedParameters,
    };
  } else {
    // No capability ⇒ v1 semantics exactly: the profile settings merge in, and
    // stored request defaults are inert because nothing maps to that source.
    const managed = new Set<string>([...declaredKeys, ...Object.keys(policy.parameters)]);
    const clientManaged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(clientInput)) {
      (managed.has(key) ? clientManaged : passthrough)[key] = value;
    }
    effectiveParameters = mergeParameters(policy.parameters, clientManaged, declaredKeys);
  }

  return {
    profile: {
      mode: 'pinned',
      profileId: row.profile_id,
      revision: Number(row.binding_revision),
      bindings: parseConnectorBindings(row.connector_bindings),
      profileName: typeof row.profile_name === 'string' && row.profile_name.length > 0 ? row.profile_name : null,
      policy,
      effectiveParameters,
      passthrough,
      effectiveInput: { ...effectiveParameters, ...passthrough },
      bullMqPriority: bullMqPriorityFor(policy.jobPriority),
    },
    ...(requestResolution ? { requestResolution } : {}),
  };
}

/**
 * Root-grant resolution. Returns `null` when the key is not `GROUP_MANAGED`,
 * so the caller can fall through to the legacy standalone resolver.
 *
 * A `GROUP_MANAGED` key NEVER falls through: every failure below throws. That
 * is the plan's "no fallback to child membership" rule and the one behaviour
 * the acceptance matrix pins.
 */
export async function resolveGroupAdmission(
  client: Queryable,
  cryptoEnv: ProfileEnv,
  input: ResolveAdmissionInput,
): Promise<ResolvedAdmission | null> {
  const key = await readApiKeyAuthorization(client, input.apiKeyId);
  if (!key) throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
  if (key.keyMode !== 'GROUP_MANAGED') return null;
  if (key.status !== 'ACTIVE') throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
  if (key.tenantId !== input.tenantId) throw forbidden('api key tenant does not match the admission tenant');

  const grant = await resolveRootGrant(client as never, input.apiKeyId, input.tenantId);
  if (!grant) throw groupDenied('no active profile-group grant authorizes this API key');
  if (input.selector.groupId !== undefined && input.selector.groupId !== grant.groupId) {
    throw groupDenied('the presented API key is not granted to this profile group');
  }

  const authority = await readGroupAuthority(client as never, grant.groupId, input.tenantId);
  if (authority.authority !== 'GROUP_GRANT') {
    throw conflict('PROFILE_CHANGED', 'profile group authority is not GROUP_GRANT');
  }
  if (authority.accessVersion !== grant.accessVersion) {
    throw conflict('PROFILE_CHANGED', 'profile group access version changed; reload before submitting');
  }

  const endpointSlug = input.selector.endpointSlug;
  const members = await client.query<GroupMemberAdmissionRow>(
    `SELECT g.group_id, g.tenant_id, g.active_revision AS group_revision,
            g.auth_authority, g.access_version,
            m.business_id, m.business_version, m.manifest_digest, m.function_kind, m.function_id,
            m.action, m.endpoint_slug, m.workflow_revision, m.profile_id, m.binding_revision,
            b.enabled, b.parameters, b.request_defaults, b.connector_bindings, b.job_priority,
            b.allowed_file_extensions, b.connections_override, b.file_url_auth_cipher,
            b.callback_policy, b.allowed_origins,
            n.profile_name, (n.group_id = g.group_id) AS group_owned
       FROM profile_groups g
       JOIN profile_group_members m
         ON m.group_id = g.group_id AND m.group_revision = g.active_revision
       JOIN profile_bindings b
         ON b.profile_id = m.profile_id AND b.revision = m.binding_revision
       LEFT JOIN profile_names n ON n.profile_id = m.profile_id
      WHERE g.group_id = $1 AND g.tenant_id = $2
        AND m.business_id = $3 AND m.business_version = $4 AND m.action = $5
        AND (($6::text IS NULL AND m.endpoint_slug IS NULL)
          OR ($6::text IS NOT NULL AND (m.endpoint_slug IS NULL OR m.endpoint_slug = $6)))
        AND ($7::text IS NULL OR m.function_id = $7)
      LIMIT 2`,
    [
      grant.groupId,
      input.tenantId,
      input.selector.businessId,
      input.selector.businessVersion,
      input.selector.action,
      endpointSlug ?? null,
      input.selector.functionId ?? null,
    ],
  );

  if (members.rows.length === 0) {
    throw notFound('no profile-group function matches this selector');
  }
  if (members.rows.length > 1) {
    // v1 has no functionId, so a generic and an endpoint-specific function can
    // both match. The plan forbids choosing one.
    throw groupDenied('the selector matches more than one group function; address one function explicitly');
  }

  const row = members.rows[0]!;
  if (input.selector.functionId !== undefined) {
    if (row.function_id !== input.selector.functionId) throw notFound('profile-group function was not found');
    if ((row.endpoint_slug ?? null) !== (endpointSlug ?? null)) {
      throw notFound('profile-group function endpoint selector does not match the request');
    }
  }
  if (row.group_owned !== true) {
    throw conflict('PROFILE_CHANGED', 'profile group child is not owned by the resolved group');
  }

  const policy = decodeGroupPolicy(row, cryptoEnv);
  if (!policy.enabled) throw forbidden('profile-group function is disabled');

  const profile = buildPinnedProfile(row, policy, input.action, input.clientInput, input.declaredKeys);
  return {
    profile: profile.profile,
    ...(profile.requestResolution ? { requestResolution: profile.requestResolution } : {}),
    groupPin: {
      groupId: row.group_id,
      tenantId: row.tenant_id,
      groupRevision: Number(row.group_revision),
      accessVersion: Number(row.access_version),
      businessId: row.business_id,
      businessVersion: row.business_version,
      manifestDigest: row.manifest_digest,
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      endpointSlug: row.endpoint_slug,
      workflowRevision: row.workflow_revision === null ? null : Number(row.workflow_revision),
      childProfileId: row.profile_id,
      childRevision: Number(row.binding_revision),
    },
  };
}

/**
 * The single front resolver every admission path uses.
 *
 * `GROUP_MANAGED` keys branch to the root-grant resolver and never touch the
 * child-membership edge; every other mode keeps the v1 resolver verbatim.
 */
export async function resolveAdmission(
  client: Queryable,
  profiles: ProfileService,
  cryptoEnv: ProfileEnv,
  input: ResolveAdmissionInput,
): Promise<ResolvedAdmission> {
  const group = await resolveGroupAdmission(client, cryptoEnv, input);
  if (group) return group;
  const profile = await profiles.resolveEffectiveProfile(
    input.apiKeyId,
    input.selector.businessId,
    input.selector.businessVersion,
    input.selector.action,
    input.clientInput,
    input.declaredKeys,
    input.selector.endpointSlug,
  );
  if (profile.mode === 'legacy') {
    // PC-R01 defence in depth: `selectActiveRow` now denies an unassigned
    // standalone key, so a `'legacy'` result here means the key was classified
    // unmanaged. Verify that against the explicit mode rather than trusting the
    // resolver's return alone — the unmanaged path is the only one without a
    // profile fence, and it must never be reachable by an unassigned
    // `LEGACY_STANDALONE` (or NULL-mode) key. One extra read, only on this
    // branch, so the pinned hot path is unchanged.
    const key = await readApiKeyAuthorization(client, input.apiKeyId);
    if (!key || key.status !== 'ACTIVE' || key.keyMode !== 'UNMANAGED_LEGACY') {
      throw forbidden('this API key has no assigned profile and is not an unmanaged legacy key');
    }
  }
  return { profile, groupPin: null };
}

/** `profile-v2:<groupId>:<business>/<action>/<functionId>` — the v2 idempotency scope. */
export function profileV2RouteAction(
  groupId: string,
  businessId: string,
  action: string,
  functionId: string,
): string {
  return `profile-v2:${groupId}:${businessId}/${action}/${functionId}`;
}

/**
 * The exact request hash `submit` computes for a v2 admission.
 *
 * v2 carries no legacy identity, no workflow schema pin and no workbench
 * identity, so the hash is the canonical submission alone. Kept as one function
 * so the pre-lookup and the in-transaction comparison cannot disagree.
 */
export function canonicalSubmissionHash(submission: Submission): string {
  return canonicalRequestHash({
    input: submission.input,
    artifacts: submission.artifacts,
    output: submission.output,
    callback: submission.callback,
    sourceUrl: submission.sourceUrl,
  });
}

/**
 * The authorization half of v2 admission, without any resolution that can
 * drift. Used BEFORE the idempotency lookup so that an exact replay survives a
 * configuration change but a revoked key/grant never replays.
 */
async function assertGroupKeyAuthorized(
  client: Queryable,
  apiKeyId: string,
  tenantId: string,
  groupId: string,
): Promise<void> {
  const key = await readApiKeyAuthorization(client, apiKeyId);
  if (!key || key.status !== 'ACTIVE') throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
  if (key.tenantId !== tenantId) throw forbidden('api key tenant does not match the admission tenant');
  if (key.keyMode !== 'GROUP_MANAGED') {
    throw groupDenied('the presented API key is not managed by a profile group');
  }
  const grant = await resolveRootGrant(client as never, apiKeyId, tenantId);
  if (!grant || grant.groupId !== groupId) {
    throw groupDenied('the presented API key is not granted to this profile group');
  }
  const authority = await readGroupAuthority(client as never, groupId, tenantId);
  if (authority.authority !== 'GROUP_GRANT') {
    throw conflict('PROFILE_CHANGED', 'profile group authority is not GROUP_GRANT');
  }
}

/**
 * PC-R08 — reauthorize an idempotent REPLAY before acknowledging it.
 *
 * A replay returns an operation that already exists, so it runs before — and
 * deliberately survives — every admission input that can drift (policy edits,
 * version switches, artifact expiry). Current AUTHORITY is not drift: a key
 * that lost its root grant, a revoked key, or a function disabled since the
 * original acceptance must not receive a `replayed: true` acknowledgement for
 * work it may no longer observe.
 *
 * Legacy keys keep their existing replay behaviour: they never had a group
 * authority to lose. Historical READ routes are untouched by design — an
 * active owner can still read a result after a grant revocation.
 */
async function assertManagedReplayAuthorized(
  client: Queryable,
  input: { tenantId: string; apiKeyId: string; operationId: string },
): Promise<void> {
  const key = await readApiKeyAuthorization(client, input.apiKeyId);
  if (!key || key.status !== 'ACTIVE') {
    throw conflict('API_KEY_REVOKED', 'the replay key is revoked; a replay cannot be acknowledged');
  }
  if (key.tenantId !== input.tenantId) throw notFound('operation not found');
  if (key.keyMode !== 'GROUP_MANAGED') return;

  const grant = await resolveRootGrant(client as never, input.apiKeyId, input.tenantId);
  if (!grant) {
    throw conflict('GRANT_REVOKED', 'the replay key no longer holds an ACTIVE profile-group grant');
  }
  const authority = await readGroupAuthority(client as never, grant.groupId, input.tenantId);
  if (authority.authority !== 'GROUP_GRANT') {
    throw conflict('PROFILE_CHANGED', 'profile group authority is not GROUP_GRANT');
  }

  const operation = await client.query<{
    business_id: string;
    business_version: string;
    action: string;
    endpoint_slug: string | null;
    profile_id: string | null;
  }>(
    `SELECT business_id, business_version, action, endpoint_slug, profile_id
       FROM operations WHERE id=$1 AND tenant_id=$2`,
    [input.operationId, input.tenantId],
  );
  const op = operation.rows[0];
  if (!op) throw notFound('operation not found');

  // The function must still be exposed, unique and enabled in the group's
  // CURRENT active revision. A pinned child identifies it; the legacy endpoint
  // selector is the fallback (the operation column is a legacy projection and
  // is NULL for v2 admissions).
  const members = await client.query<{ enabled: boolean | null }>(
    `SELECT b.enabled
       FROM profile_groups g
       JOIN profile_group_members m
         ON m.group_id = g.group_id AND m.group_revision = g.active_revision
       JOIN profile_bindings b
         ON b.profile_id = m.profile_id AND b.revision = m.binding_revision
      WHERE g.group_id=$1 AND g.tenant_id=$2 AND g.auth_authority='GROUP_GRANT'
        AND m.business_id=$3 AND m.business_version=$4 AND m.action=$5
        AND (
          ($7::uuid IS NOT NULL AND m.profile_id=$7::uuid)
          OR ($7::uuid IS NULL AND (
               ($6::text IS NULL AND m.endpoint_slug IS NULL)
               OR ($6::text IS NOT NULL AND (m.endpoint_slug IS NULL OR m.endpoint_slug=$6))))
        )
      LIMIT 2`,
    [grant.groupId, input.tenantId, op.business_id, op.business_version, op.action, op.endpoint_slug, op.profile_id],
  );
  if (members.rows.length !== 1) {
    throw conflict('ENDPOINT_DISABLED', 'the profile group no longer exposes exactly one function for this replay');
  }
  if (members.rows[0]!.enabled === false) {
    throw conflict('ENDPOINT_DISABLED', 'the profile-group function is disabled');
  }
}

/**
 * Lock step 2 of the plan's order: the group root, before business/version.
 * Re-reads authority, active revision and access version under the lock, so a
 * concurrent conversion/grant bump cannot slip between resolution and write.
 */
async function lockGroupRootForAdmission(client: Queryable, pin: GroupAdmissionPin): Promise<void> {
  const result = await client.query<{ auth_authority: string; active_revision: number; access_version: string | number }>(
    `SELECT auth_authority, active_revision, access_version
       FROM profile_groups WHERE group_id=$1 AND tenant_id=$2
      FOR SHARE`,
    [pin.groupId, pin.tenantId],
  );
  const row = result.rows[0];
  if (!row) throw conflict('PROFILE_CHANGED', 'profile group disappeared during admission');
  if (row.auth_authority !== 'GROUP_GRANT') {
    throw conflict('PROFILE_CHANGED', 'profile group authority changed during admission');
  }
  if (Number(row.active_revision) !== pin.groupRevision) {
    throw conflict('PROFILE_CHANGED', 'profile group revision changed during admission');
  }
  if (Number(row.access_version) !== pin.accessVersion) {
    throw conflict('PROFILE_CHANGED', 'profile group access version changed during admission');
  }
}

/**
 * Lock steps 4-6: the api key row, then its grant, then the child pin.
 *
 * The key row is locked BEFORE the grant, matching the plan's order. A grant
 * revoked between resolution and this point has to deny the write, and a key
 * whose status or mode changed must not be admitted on the strength of the
 * preflight read.
 */
async function lockGroupKeyAndGrant(
  client: Queryable,
  apiKeyId: string,
  pin: GroupAdmissionPin,
): Promise<void> {
  const key = await client.query<{ status: string; key_mode: string | null }>(
    'SELECT status, key_mode FROM api_keys WHERE id=$1 FOR SHARE',
    [apiKeyId],
  );
  const keyRow = key.rows[0];
  if (!keyRow || keyRow.status !== 'ACTIVE') {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
  }
  if (keyRow.key_mode !== 'GROUP_MANAGED') {
    throw groupDenied('api key is no longer group-managed');
  }
  const grant = await client.query<{ state: string }>(
    `SELECT state FROM profile_group_api_keys
      WHERE api_key_id=$1 AND group_id=$2 AND tenant_id=$3
      FOR SHARE`,
    [apiKeyId, pin.groupId, pin.tenantId],
  );
  if (!grant.rows[0] || grant.rows[0].state !== 'ACTIVE') {
    throw groupDenied('the root grant was revoked during admission');
  }
  const child = await client.query(
    'SELECT 1 FROM profile_bindings WHERE profile_id=$1 AND revision=$2 FOR SHARE',
    [pin.childProfileId, pin.childRevision],
  );
  if (!child.rows[0]) {
    throw conflict('PROFILE_CHANGED', 'group child revision disappeared during admission');
  }
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

  /**
   * PC-05: env used to decrypt a group child's `file_url_auth_cipher`.
   *
   * Defaults to `process.env`, matching `createProfileService`'s own default.
   * A deployment that passes a custom `profileCipherKey` to the profile service
   * must pass the same value here (create-app wiring, tracked in the receipt),
   * otherwise a group child with URL credentials decrypts to `null` and the
   * request is admitted without that credential configuration.
   */
  cryptoEnv?: ProfileEnv;
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
  // PC-05: same default as `createProfileService` (process.env) so a group
  // child's encrypted URL credentials decode with the deployment's key.
  const cryptoEnv: ProfileEnv = options.cryptoEnv ?? process.env;

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

  interface BuiltProfileResolutionV2 {
    submission: Submission;
    profile: EffectiveProfile;
    pin: GroupAdmissionPin;
    refs: ProfileGroupResolutionRefsV2;
    fingerprint: string;
    effective: ProfileResolutionV2Preview['effective'];
    /**
     * PC-R02: the registry snapshot the fingerprint was computed over. Forwarded
     * to submit as workflowSchemaPin so the compiler persists the identity
     * and the sealed recipe carrier; never part of the preview DTO.
     */
    workflowPin: LegacyWorkflowSchemaPin | null;
    /** Finding 3: the exact defaults snapshot the fingerprint covered. */
    tenantDefaults: TenantDefaultsSnapshot | null;
  }

  /**
   * PC-05: one builder behind preview and submit.
   *
   * Resolution, tenant-defaults pinning and fingerprint derivation happen here
   * exactly once so a preview and the submit that follows it cannot disagree
   * about what "the current configuration" was.
   */
  async function buildProfileResolutionV2(input: ProfileResolutionV2Request): Promise<BuiltProfileResolutionV2> {
    const parsed = SubmissionSchema.safeParse(input.submission);
    if (!parsed.success) {
      throw unprocessable('INVALID_SCHEMA', 'submission validation failed', {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/' + i.path.join('/'),
          message: i.message,
        })),
      });
    }
    const submission = parsed.data;

    // The group pins a business version + manifest digest; both must still be
    // the active one, which is the plan's "current business/version readiness".
    const enabled = await resolveEnabledVersion(db, input.selector.businessId, input.selector.action);
    if (enabled.version !== input.selector.businessVersion) {
      throw conflict('PROFILE_CHANGED', 'the selected business version is no longer active; re-run the preview');
    }
    const actionDef = enabled.manifest.actions.find((candidate) => candidate.name === input.selector.action);
    if (!actionDef) {
      throw badRequest(`action ${input.selector.action} not declared by ${input.selector.businessId}@${enabled.version}`);
    }

    const admission = await resolveGroupAdmission(db as unknown as Queryable, cryptoEnv, {
      apiKeyId: input.apiKeyId,
      tenantId: input.tenantId,
      selector: {
        businessId: input.selector.businessId,
        businessVersion: input.selector.businessVersion,
        action: input.selector.action,
        functionId: input.selector.functionId,
        ...(input.selector.endpointSlug ? { endpointSlug: input.selector.endpointSlug } : {}),
        groupId: input.groupId,
      },
      action: actionDef,
      clientInput: submission.input,
      declaredKeys: declaredParameterKeys(actionDef.inputSchema as object),
    });
    if (!admission || !admission.groupPin) {
      throw groupDenied('the presented API key is not managed by a profile group');
    }
    const pin = admission.groupPin;
    if (pin.businessVersion !== enabled.version || pin.manifestDigest !== enabled.digest) {
      throw conflict('PROFILE_CHANGED', 'the group function pin does not match the active business version');
    }

    const tenantDefaults = options.globalSettings
      ? await options.globalSettings.getTenantDefaultsSnapshot(input.tenantId)
      : null;
    const tenantDefaultsRevision = tenantDefaults?.aiRevision ?? null;

    // PC-R02: a workflow function is pinned to an exact registry revision. The
    // identity IS `functionId` (how the catalog declares workflow functions) and
    // the revision must still be ACTIVE: a retired revision can no longer be
    // executed, so preview must fail rather than advertise a fingerprint no
    // worker can honour. A member with no revision (legacy v1 semantics) keeps
    // `workflow: null` — it pins no registry snapshot.
    let workflowPin: LegacyWorkflowSchemaPin | null = null;
    let workflowRef: { slug: string; revision: number; digest: string } | null = null;
    if (pin.kind === 'workflow' && pin.workflowRevision !== null) {
      if (!metadataCrypto) {
        throw unavailable('workflow submissions require configured metadata encryption');
      }
      try {
        const resolved = await resolveLegacyWorkflowSchema(
          db,
          { tenantId: input.tenantId, slug: pin.functionId, revision: pin.workflowRevision },
          metadataCrypto,
        );
        if (!resolved || resolved.slug !== pin.functionId || resolved.revision !== pin.workflowRevision) {
          throw conflict('PROFILE_CHANGED', 'the pinned workflow revision is no longer available; re-run the preview');
        }
        workflowPin = resolved;
        workflowRef = { slug: resolved.slug, revision: resolved.revision, digest: resolved.digest };
      } catch (error) {
        if (error instanceof LegacyWorkflowSchemaCatalogError) {
          // Retired and tampered/invalid rows are the same operator answer: the
          // pin cannot be executed, so re-preview against a live revision. The
          // registry code is carried so on-call can tell them apart.

          throw conflict(
            'PROFILE_CHANGED',
            `workflow revision ${pin.functionId}@${pin.workflowRevision} cannot be used (${error.code}); re-run the preview`,
          );
        }
        throw error;
      }
    }

    const bindings = admission.profile.mode === 'pinned' ? admission.profile.bindings : {};
    const connectorBindings = Object.entries(bindings)
      .map(([slot, entry]) => ({ slot, connectorId: entry.connectorId, revision: entry.revision }))
      .sort((left, right) => (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0));

    const refs: ProfileGroupResolutionRefsV2 = {
      groupId: pin.groupId,
      groupRevision: pin.groupRevision,
      accessVersion: pin.accessVersion,
      businessId: pin.businessId,
      businessVersion: pin.businessVersion,
      manifestDigest: pin.manifestDigest,
      kind: pin.kind,
      functionId: pin.functionId,
      action: pin.action,
      ...(pin.endpointSlug ? { endpointSlug: pin.endpointSlug } : {}),
      ...(pin.workflowRevision ? { workflowRevision: pin.workflowRevision } : {}),
      childProfileId: pin.childProfileId,
      childRevision: pin.childRevision,
      tenantDefaultsRevision,
      connectorBindings,
    };

    const fingerprint = computeResolutionFingerprint({
      tenantId: input.tenantId,
      apiKeyId: input.apiKeyId,
      groupId: pin.groupId,
      groupRevision: pin.groupRevision,
      accessVersion: pin.accessVersion,
      function: {
        businessId: pin.businessId,
        businessVersion: pin.businessVersion,
        manifestDigest: pin.manifestDigest,
        kind: pin.kind,
        functionId: pin.functionId,
        action: pin.action,
        ...(pin.endpointSlug ? { endpointSlug: pin.endpointSlug } : {}),
        ...(pin.workflowRevision ? { workflowRevision: pin.workflowRevision } : {}),
      },
      children: [{
        functionId: pin.functionId,
        childProfileId: pin.childProfileId,
        childRevision: pin.childRevision,
      }],
      // PC-R04: AI revision, prompt revision and the exact defaults snapshot
      // digest are three distinct fingerprint inputs. A prompt-only publish
      // changes the prompt revision (and the digest) without touching the AI
      // revision, so a fingerprint that carried only the AI revision could not
      // tell that the admitted defaults had changed.
      tenantDefaultsAiRevision: tenantDefaults?.aiRevision ?? null,
      tenantDefaultsPromptRevision: tenantDefaults?.promptRevision ?? null,
      tenantDefaultsDigest: tenantDefaults?.settingsDigest ?? null,
      connectorBindings,
      // PC-R02: the registry snapshot is an execution input. Its digest moves
      // when the workflow body changes, so a preview taken against the old
      // revision cannot be submitted against the new one.
      workflow: workflowRef,
      submission,
    });

    const effective: ProfileResolutionV2Preview['effective'] = {
      parameters: admission.profile.mode === 'pinned' ? admission.profile.effectiveInput : {},
      appliedRequestDefaults: admission.requestResolution?.appliedRequestDefaults ?? [],
      appliedSchemaDefaults: admission.requestResolution?.appliedSchemaDefaults ?? [],
      lockedParameters: admission.requestResolution?.lockedParameters ?? [],
    };

    return { submission, profile: admission.profile, pin, refs, fingerprint, effective, workflowPin, tenantDefaults };
  }

  return {
    async replayLegacy(ctx: Pick<SubmitContext, 'tenantId' | 'apiKeyId' | 'businessId' | 'action' | 'idempotencyKey' | 'correlationId'>, identity: Parameters<typeof canonicalRequestHash>[0]): Promise<SubmitResult | null> {
      if (!ctx.idempotencyKey) return null;
      const existing = await findSubmissionKey(db, ctx.tenantId, ctx.apiKeyId, normalizeRouteAction(ctx.businessId, ctx.action), ctx.idempotencyKey);
      if (!existing) return null;
      if (existing.request_hash !== canonicalRequestHash(identity)) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
      // PC-R08: a managed key must still hold authority before its replay is acknowledged.
      await assertManagedReplayAuthorized(db, {
        tenantId: ctx.tenantId,
        apiKeyId: ctx.apiKeyId,
        operationId: existing.operation_id,
      });
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
      const key = await db.query<{ id: string; key_mode: string | null }>(
        "SELECT id, key_mode FROM api_keys WHERE id=$1 AND tenant_id=$2 AND status='ACTIVE'",
        [input.apiKeyId, input.tenantId],
      );
      if (!key.rowCount) throw notFound('active API key not found in tenant');
      const keyMode = key.rows[0]!.key_mode;

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
      // Finding 2: a GROUP_MANAGED key holds no `profile_api_keys` rows (a
      // conversion tombstones them), so the legacy resolver denies it before the
      // caller can reserve a run. Managed keys are authorized by the same
      // current root grant the submission path uses, and the child pin the
      // caller selected must match it exactly.
      let profile: EffectiveProfile;
      if (keyMode === 'GROUP_MANAGED') {
        const admission = await resolveGroupAdmission(db as unknown as Queryable, cryptoEnv, {
          apiKeyId: input.apiKeyId,
          tenantId: input.tenantId,
          selector: {
            businessId: input.businessId,
            businessVersion: enabled.version,
            action: input.action,
            ...(input.endpointSlug ? { endpointSlug: input.endpointSlug } : {}),
          },
          action: actionDef,
          clientInput: actionInput,
          declaredKeys: declaredParameterKeys(actionDef.inputSchema as object),
        });
        if (!admission?.groupPin) {
          throw forbidden('the selected API key is not managed by a profile group');
        }
        if (admission.groupPin.childProfileId !== input.profileId) {
          throw forbidden('the selected API key is not assigned to the selected active Profile and action');
        }
        if (admission.groupPin.childRevision !== input.expectedProfileRevision) {
          throw conflict('PROFILE_CHANGED', 'Profile revision changed; reload before testing');
        }
        profile = admission.profile;
      } else {
        profile = await profiles.resolveEffectiveProfile(
          input.apiKeyId,
          input.businessId,
          enabled.version,
          input.action,
          actionInput,
          declaredParameterKeys(actionDef.inputSchema as object),
          input.endpointSlug,
        );
      }
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
      // PC-05: a v2 admission supplies its own scope string so a v1 and a v2
      // request can never collide under one Idempotency-Key.
      const routeAction = ctx.v2?.routeAction ?? normalizeRouteAction(ctx.businessId, ctx.action, ctx.alias);
      // T-SUB-04: the idempotency hash stays on the RAW client input, never on
      // the effective input. A profile edit between two retries of the same
      // Idempotency-Key must replay the original operation, not a second one
      // built from the new defaults — hashing the merged map would turn every
      // admin edit into an IDEMPOTENCY_CONFLICT for in-flight clients.
      const requestInput = ctx.adminWorkbenchProfileIdentity === undefined
        ? submission.input
        : { adminWorkbenchProfile: ctx.adminWorkbenchProfileIdentity, requestInput: submission.input };
      const requestHash = canonicalRequestHash(ctx.legacyRequestIdentity ?? {
        input: ctx.workflowSchemaPin === undefined
          ? requestInput
          : { input: requestInput, legacyWorkflowSchema: ctx.workflowSchemaPin },
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
          // PC-05: a v2 replay must also match the fingerprint the first
          // accepted request carried. A NULL stored fingerprint is never a
          // match.
          if (ctx.v2 && existing.resolution_fingerprint !== ctx.v2.resolutionFingerprint) {
            throw conflict(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different resolution fingerprint'
            );
          }
          // PC-R08: authorization is checked on the replay itself, not only on
          // the original acceptance. A revoked grant, a revoked key or a
          // disabled function denies here; allowed configuration drift does not.
          await assertManagedReplayAuthorized(db, {
            tenantId: ctx.tenantId,
            apiKeyId: ctx.apiKeyId,
            operationId: existing.operation_id,
          });
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
      //
      // PC-05: the front resolver branches on `api_keys.key_mode`. A
      // GROUP_MANAGED key resolves ONLY through its root grant (no child
      // membership fallback); every other mode delegates to the v1 resolver
      // unchanged. A v2 caller passes `resolvedAdmission` so the refs the
      // fingerprint was computed over are the refs this write persists.
      const admission = ctx.resolvedAdmission ?? await resolveAdmission(
        db as unknown as Queryable,
        profiles,
        cryptoEnv,
        {
          apiKeyId: ctx.apiKeyId,
          tenantId: ctx.tenantId,
          selector: {
            businessId: ctx.businessId,
            businessVersion: version,
            action: canonicalAction,
            ...(ctx.legacyEndpointSlug ?? ctx.legacyProjection?.endpointSlug ?? ctx.profileEndpointSlug
              ? { endpointSlug: (ctx.legacyEndpointSlug ?? ctx.legacyProjection?.endpointSlug ?? ctx.profileEndpointSlug)! }
              : {}),
          },
          action: actionDef,
          clientInput: submission.input as Record<string, unknown>,
          declaredKeys: declaredParameterKeys(actionDef.inputSchema as object).filter((key) =>
            ctx.legacyProjection === undefined || key !== 'legacyWorkflow'
          ),
        },
      );
      const profile = admission.profile;
      const tenantDefaults = ctx.resolvedAdmission?.tenantDefaults !== undefined
        ? ctx.resolvedAdmission.tenantDefaults
        : options.globalSettings
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
        const matches = expected === null ? profile.mode === 'legacy' : profile.mode === 'pinned'
          && profile.profileId === expected.profileId
          && profile.revision === expected.revision
          && (expected.profileName === undefined || profile.profileName === expected.profileName);
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
          ? await promptOverrides.listFor(ctx.apiKeyId, ctx.legacyEndpointSlug ?? ctx.legacyProjection?.endpointSlug ?? ctx.profileEndpointSlug ?? canonicalAction, ctx.tenantId)
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
      // Finding 1: the `{ input, legacyWorkflowSchema }` carrier is consumed by
      // the LEGACY workflow engine only — it is a legacy-route artifact. A v2
      // workflow member now also carries a compiled pin (PC-R02), but its
      // business action may be a plain handler (example-review and every other
      // non-Core business catalogues its actions as `workflow`); wrapping their
      // payload would hand the worker a carrier it never reads. The route, not
      // the presence of a pin, decides.
      const legacyWorkflowCarrier = ctx.legacyProjection !== undefined ? workflowPin : undefined;
      const taskPayloadValue = legacyWorkflowCarrier !== undefined
        ? { input: effectiveInput, legacyWorkflowSchema: legacyWorkflowCarrier }
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

        // PC-05 (plan §7 lock order): the group root is the FIRST profile lock,
        // ahead of the business/version rows and the api-key row. A v1
        // GROUP_MANAGED admission resolved here too, so `admission.groupPin`
        // (not `ctx.v2`) is what decides.
        const groupPin = admission.groupPin;
        if (groupPin) await lockGroupRootForAdmission(client, groupPin);

        // Re-check idempotency inside the tx to close the concurrent-submit race
        // (unique constraint is the ultimate authority; this avoids a duplicate
        // operation row before the constraint fires).
        if (ctx.idempotencyKey) {
          // Serialize the absent-row case too: SELECT FOR UPDATE cannot lock a key that does not exist yet.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey])]);
          const dup = await client.query(
            `SELECT operation_id, request_hash, resolution_fingerprint FROM submission_keys
             WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 FOR UPDATE`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey]
          );
          if (dup.rowCount && dup.rowCount > 0) {
            const row = dup.rows[0] as { operation_id: string; request_hash: string; resolution_fingerprint: string | null };
            if (row.request_hash !== requestHash) {
              throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
            }
            if (ctx.v2 && row.resolution_fingerprint !== ctx.v2.resolutionFingerprint) {
              throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different resolution fingerprint');
            }
            // PC-R08: the in-tx replay answer is gated on current authority
            // too. The group root is already held FOR SHARE above when this
            // admission resolved a group pin, so a concurrent revoke cannot
            // commit between this check and the answer.
            await assertManagedReplayAuthorized(client, {
              tenantId: ctx.tenantId,
              apiKeyId: ctx.apiKeyId,
              operationId: row.operation_id,
            });
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

        // PC-05: key row, then grant, then the child pin — the plan's steps
        // 4-6. The preflight authorization is never trusted on its own.
        if (groupPin) await lockGroupKeyAndGrant(client, ctx.apiKeyId, groupPin);

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
            `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, request_hash,
                                         operation_id, expires_at, resolution_fingerprint)
             VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval, $8)`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey, requestHash, operationId, String(ttlSeconds),
              ctx.v2?.resolutionFingerprint ?? null]
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

    /**
     * PC-05 — the v2 preview behind `POST /api/v2/profile-groups/:groupId/preview`
     * and `/api/internal/admin-workbench/v2/preview`.
     *
     * Resolves through the root grant only, computes the resolution fingerprint
     * with the contract implementation (`computeResolutionFingerprint`), and
     * returns the redacted effective parameters. It writes nothing.
     */
    async previewProfileV2(input: ProfileResolutionV2Request): Promise<ProfileResolutionV2Preview> {
      const resolved = await buildProfileResolutionV2(input);
      return {
        groupId: resolved.pin.groupId,
        refs: resolved.refs,
        resolutionFingerprint: resolved.fingerprint,
        effective: resolved.effective,
      };
    },

    /**
     * PC-05 — the v2 submit behind `POST /api/v2/profile-groups/:groupId/operations`
     * and `/api/internal/admin-workbench/v2/submit`.
     *
     * Order is the plan's, and it is not interchangeable:
     *   1. authenticate the presented key (401)
     *   2. authorize the root grant + authority for the addressed group (403/409)
     *   3. idempotency lookup — an exact replay returns the ORIGINAL operation
     *      even after configuration drift (the stored fingerprint, not a
     *      recomputed one, is what it is compared against)
     *   4. resolve current refs and verify the client fingerprint (409 before
     *      any durable write)
     *   5. hand the resolved admission to `submit`, which re-verifies inside
     *      the write transaction under the plan's lock order
     */
    async submitProfileV2(input: ProfileResolutionV2Request): Promise<SubmitResult> {
      if (!input.idempotencyKey) {
        throw unprocessable('INVALID_SCHEMA', 'v2 profile submission requires an Idempotency-Key');
      }
      const expectedFingerprint = input.resolutionFingerprint;
      if (!expectedFingerprint) {
        throw unprocessable('INVALID_SCHEMA', 'v2 profile submission requires resolutionFingerprint');
      }
      const correlationId = normalizeCorrelationId(input.correlationId);
      const parsedSubmission = SubmissionSchema.safeParse(input.submission);
      if (!parsedSubmission.success) {
        throw unprocessable('INVALID_SCHEMA', 'submission validation failed', {
          errors: parsedSubmission.error.issues.slice(0, 50).map((i) => ({
            pointer: '/' + i.path.join('/'),
            message: i.message,
          })),
        });
      }
      const submission = parsedSubmission.data;

      // (1)+(2) authenticate, then authorize the grant. Deliberately does NOT
      // resolve members/manifests yet: a replay must survive configuration
      // drift, so anything that can drift waits until after the lookup.
      await assertGroupKeyAuthorized(db as unknown as Queryable, input.apiKeyId, input.tenantId, input.groupId);

      const routeAction = profileV2RouteAction(
        input.groupId,
        input.selector.businessId,
        input.selector.action,
        input.selector.functionId,
      );
      const requestHash = canonicalSubmissionHash(submission);

      // (3) idempotency, now that authorization has passed.
      const existing = await findSubmissionKey(db, input.tenantId, input.apiKeyId, routeAction, input.idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
        }
        if (existing.resolution_fingerprint === null
            || existing.resolution_fingerprint !== expectedFingerprint) {
          throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different resolution fingerprint');
        }
        // PC-R08: the grant was re-checked above, but the function may have
        // been disabled since the original acceptance. A v2 replay must not
        // acknowledge work the group no longer exposes.
        await assertManagedReplayAuthorized(db, {
          tenantId: input.tenantId,
          apiKeyId: input.apiKeyId,
          operationId: existing.operation_id,
        });
        return {
          operation: await loadOperationView(db, existing.operation_id),
          replayed: true,
          correlationId,
        };
      }

      // (4) current resolution and fingerprint verification, before any write.
      const resolved = await buildProfileResolutionV2({
        ...input,
        selector: input.selector,
        submission,
      });
      if (resolved.fingerprint !== expectedFingerprint) {
        throw conflict(
          'PROFILE_CHANGED',
          'resolution fingerprint no longer matches the current profile configuration; re-run the preview',
        );
      }

      // (5) the ordinary transaction, seeded with the refs the fingerprint was
      // computed over. `submit` re-verifies them under row locks.
      return this.submit({
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        businessId: input.selector.businessId,
        action: input.selector.action,
        idempotencyKey: input.idempotencyKey,
        correlationId,
        submission,
        resolvedAdmission: {
          profile: resolved.profile,
          groupPin: resolved.pin,
          // Finding 3: admission seals the snapshot the fingerprint covered.
          tenantDefaults: resolved.tenantDefaults,
        },
        v2: { resolutionFingerprint: resolved.fingerprint, routeAction },
        // PC-R02: the resolved registry snapshot flows into the same compiler the
        // legacy workflow path uses, so the operation/task carry the slug,
        // revision, digest and the sealed recipe carrier.
        ...(resolved.workflowPin ? { workflowSchemaPin: resolved.workflowPin } : {}),
        ...(input.selector.endpointSlug ? { profileEndpointSlug: input.selector.endpointSlug } : {}),
      });
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
): Promise<{ operation_id: string; request_hash: string; resolution_fingerprint: string | null } | null> {
  const res = await db.query(
    `SELECT operation_id, request_hash, resolution_fingerprint FROM submission_keys
     WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 AND expires_at > now()`,
    [tenantId, apiKeyId, routeAction, key]
  );
  return res.rowCount
    ? (res.rows[0] as { operation_id: string; request_hash: string; resolution_fingerprint: string | null })
    : null;
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
