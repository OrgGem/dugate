import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  ParameterResolutionSchema,
  type ParameterResolution,
  type ProfileGroup,
  type ProfileGroupAuthAuthority,
  type ProfileGroupBusiness,
  type ProfileGroupBusinessInput,
  type ProfileGroupFunctionBinding,
  type ProfileGroupFunctionInput,
  type ProfileGroupKeyGrant,
  type ProfileGroupKeyIssueInput,
  type ProfileGroupKeyIssueResult,
  type ProfileGroupKeyRevokeInput,
  type ProfileGroupKeyRevokeResult,
  type ProfileGroupRevokedKeyGrant,
  type ProfileGroupRollback,
  type ProfileGroupSave,
  type ProfileGroupV2,
  type ProfileGroupV2Save,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { profileDetailConnectorBindingsRead, profileDetailPolicyRead, type ProfileDetailDbRow } from '../admin-read/profile-detail';
import { getBusinessFunctionCatalog } from '../admin-read/business-functions';
import { dateToIso } from '../admin-read/keyset';
import type { ProfileRevisionActor, ProfileService } from './profiles';
import { normalizeStoredRequestDefaults } from './profiles';
import { pinActiveRevision } from './publish';
import { isActiveConnectorPin } from './connector-pin-validation';

/**
 * PC-03: the Admin actor recorded on group config revisions and root grants.
 * Aliased from the profile module so there is exactly one actor shape.
 */
export type ProfileGroupActor = ProfileRevisionActor;

/** Injected key primitives so PC-04 can re-point minting without touching this file. */
export interface ProfileGroupGrantDeps {
  hashApiKey(raw: string): string;
  /** `du_` + 32 random bytes, base64url — the same shape every key minter uses. */
  mintRawKey?(): string;
}

export interface GroupAuthorityRecord {
  groupId: string;
  tenantId: string;
  authority: ProfileGroupAuthAuthority;
  accessVersion: number;
  activeRevision: number;
}

/**
 * The read-only slice both `Db` and `PoolClient` satisfy.
 *
 * `Pick<PoolClient, 'query'>` is not assignable from `Db` because the two
 * `query` overload sets are incompatible (same reason as `profiles.ts`
 * `Queryable`), so the exported helpers declare this narrow shape instead.
 */
export interface GroupQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface GroupRootRow extends QueryResultRow {
  group_id: string;
  tenant_id: string;
  name: string;
  active_revision: number;
  auth_authority: ProfileGroupAuthAuthority;
  access_version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GroupRevisionRow extends QueryResultRow {
  group_id: string;
  revision: number;
  tenant_id: string;
  name: string;
  /** PC-03: historical author reference only. NULL for a group-owned append. */
  api_key_id: string | null;
  created_at: Date | string;
}

interface GroupMemberRow extends QueryResultRow {
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
  active_binding_revision: number | null;
  enabled: boolean | null;
  parameters: unknown;
  job_priority: string | null;
  allowed_file_extensions: string | null;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
  request_redaction: unknown;
  callback_policy: unknown;
  allowed_origins: unknown;
  connector_bindings: unknown;
  /** PC-03: per-field request defaults pinned with the child revision. */
  request_defaults: unknown;
}

interface ApiKeyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  hash: string;
  prefix: string;
  status: string;
}

interface RequestedMember {
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  kind: 'endpoint' | 'workflow';
  functionId: string;
  action: string;
  endpointSlug: string | null;
  workflowRevision: number | null;
  policy: ProfileGroupFunctionInput['policy'];
  /** PC-03: absent reads as `{}` — a real "no defaults declared" value. */
  requestDefaults: Record<string, { value: unknown; isLocked?: boolean }>;
  connectorBindings: ProfileGroupFunctionInput['connectorBindings'];
}

interface MemberSnapshot {
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  kind: 'endpoint' | 'workflow';
  functionId: string;
  action: string;
  endpointSlug: string | null;
  workflowRevision: number | null;
  profileId: string;
  bindingRevision: number;
}

function selectorOverlaps(a: { endpointSlug: string | null }, b: { endpointSlug: string | null }): boolean {
  return a.endpointSlug === null || b.endpointSlug === null || a.endpointSlug === b.endpointSlug;
}

function functionIdentity(member: Pick<RequestedMember,
  'businessId' | 'businessVersion' | 'kind' | 'functionId' | 'action' | 'endpointSlug'>): string {
  return JSON.stringify([
    member.businessId,
    member.businessVersion,
    member.kind,
    member.functionId,
    member.action,
    member.endpointSlug,
  ]);
}

function childProfileName(groupId: string, member: RequestedMember): string {
  const digest = createHash('sha256').update(functionIdentity(member)).digest('hex').slice(0, 32);
  return `__du_group_${groupId.replaceAll('-', '')}_${digest}`;
}

function memberFromInput(
  business: ProfileGroupBusinessInput,
  selection: ProfileGroupFunctionInput,
): RequestedMember {
  return {
    businessId: business.businessId,
    businessVersion: business.businessVersion,
    manifestDigest: business.manifestDigest,
    kind: selection.kind,
    functionId: selection.functionId,
    action: selection.action,
    endpointSlug: selection.endpointSlug ?? null,
    workflowRevision: selection.workflowRevision ?? null,
    policy: selection.policy,
    requestDefaults: normalizeStoredRequestDefaults(
      (selection as { requestDefaults?: unknown }).requestDefaults,
    ),
    connectorBindings: selection.connectorBindings,
  };
}

function normalizeRequestedFunctions(businesses: readonly ProfileGroupBusinessInput[]): RequestedMember[] {
  const members = businesses.flatMap((business) => business.functions.map((fn) => memberFromInput(business, fn)));
  if (members.length === 0) throw new HttpError(422, 'INVALID_SCHEMA', 'a profile group must select at least one function');

  const businessKeys = new Set<string>();
  for (const business of businesses) {
    const key = JSON.stringify([business.businessId, business.businessVersion]);
    if (businessKeys.has(key)) throw new HttpError(422, 'INVALID_SCHEMA', 'businessId and businessVersion may appear only once per group save');
    businessKeys.add(key);
  }

  for (let left = 0; left < members.length; left += 1) {
    const a = members[left]!;
    for (let right = left + 1; right < members.length; right += 1) {
      const b = members[right]!;
      if (a.businessId === b.businessId && a.businessVersion === b.businessVersion
          && a.action === b.action && selectorOverlaps(a, b)) {
        throw new HttpError(409, 'STATE_CONFLICT', 'profile group contains overlapping active API-key and function bindings');
      }
    }
  }
  return members;
}

async function loadSelectedKey(client: PoolClient, apiKeyId: string): Promise<ApiKeyRow> {
  const result = await client.query<ApiKeyRow>(
    `SELECT id, tenant_id, hash, prefix, status FROM api_keys
      WHERE id=$1 AND status='ACTIVE' FOR SHARE`,
    [apiKeyId],
  );
  const key = result.rows[0];
  if (!key) throw new HttpError(404, 'NOT_FOUND', 'selected API key was not found or is not ACTIVE');
  return key;
}

/**
 * PC-03: the key PREREQUISITE, read without a lock.
 *
 * Plan §"Transaction and lock order" item 7 orders *locks* (business/selector
 * rows before API-key rows), not validations. Resolving the selected key here —
 * before the business lock — keeps the pre-existing error precedence (404 for
 * an unknown/inactive key, 403 for a foreign tenant) instead of letting a
 * function-validation failure mask it. `loadSelectedKey` still takes the real
 * share lock later, and the tenant is re-checked after it.
 */
async function peekSelectedKey(client: PoolClient, apiKeyId: string): Promise<ApiKeyRow> {
  const result = await client.query<ApiKeyRow>(
    `SELECT id, tenant_id, hash, prefix, status FROM api_keys
      WHERE id=$1 AND status='ACTIVE'`,
    [apiKeyId],
  );
  const key = result.rows[0];
  if (!key) throw new HttpError(404, 'NOT_FOUND', 'selected API key was not found or is not ACTIVE');
  return key;
}

/**
 * PC-R07 — the manifest's declared parameter source mapping, per action.
 *
 * An immutable capability: `parameterResolution.fields[property]` names the ONE
 * source that owns that property (`requestDefaults` or `profileSettings`). A
 * manifest that does not declare it — every v1 manifest, and any v2 manifest
 * that opted out — yields no entry, and then nothing is inferred: intentional
 * `inputSchema`/`profileSchema` overlap stays legal and the legacy merge rules
 * apply unchanged.
 */
export type ParameterResolutionByAction = ReadonlyMap<string, ParameterResolution>;

/**
 * Read the capability out of the registered manifest.
 *
 * Read deliberately, in addition to the catalog's own `parameterResolution`:
 * save validation must fail closed on its own, so it re-applies the capability's
 * `version: 2` gate and the field schema here instead of trusting another
 * module's projection to keep them. The two reads agree by construction — both
 * come from `manifest.actions[].parameterResolution`.
 */
export async function readParameterResolutionByAction(
  client: GroupQueryable,
  businessId: string,
  businessVersion: string,
): Promise<ParameterResolutionByAction> {
  const result = await client.query<{ manifest: unknown }>(
    'SELECT manifest FROM business_versions WHERE business_id=$1 AND version=$2',
    [businessId, businessVersion],
  );
  const manifest = result.rows[0]?.manifest;
  const byAction = new Map<string, ParameterResolution>();
  if (typeof manifest !== 'object' || manifest === null) return byAction;
  const actions = (manifest as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return byAction;
  for (const action of actions) {
    if (typeof action !== 'object' || action === null) continue;
    const record = action as { name?: unknown; parameterResolution?: unknown };
    if (typeof record.name !== 'string') continue;
    const capability = record.parameterResolution;
    if (typeof capability !== 'object' || capability === null) continue;
    // `version: 2` is the only semantics this capability defines; anything else
    // is a manifest this code does not understand, and guessing would be worse
    // than staying inert.
    if ((capability as { version?: unknown }).version !== 2) continue;
    const parsed = ParameterResolutionSchema.safeParse((capability as { fields?: unknown }).fields);
    if (!parsed.success) continue;
    byAction.set(record.name, parsed.data);
  }
  return byAction;
}

/**
 * PC-R07 — reject a value saved to the wrong source.
 *
 * The rule is placement, not schema validation: a property declared as
 * `requestDefaults` must not arrive in the pinned profile policy (where it
 * would be injected as request input) and a property declared as
 * `profileSettings` must not arrive in the request defaults (where a client
 * would be able to override it). A property with no declared source is inert
 * under `requestDefaults` and is refused there, because storing it would look
 * like configuration that never applies.
 *
 * With no capability (`resolution === undefined`) this is a no-op, which is what
 * keeps v1 manifests byte-compatible.
 */
export function assertParameterSourcePlacement(
  action: string,
  resolution: ParameterResolution | undefined,
  policyParameters: Readonly<Record<string, unknown>> | undefined,
  requestDefaults: Readonly<Record<string, unknown>> | undefined,
): void {
  if (resolution === undefined) return;
  const misplaced: string[] = [];
  for (const [property, source] of Object.entries(resolution)) {
    if (source === 'requestDefaults' && policyParameters !== undefined
        && Object.hasOwn(policyParameters, property)) {
      misplaced.push(`'${property}' is declared as requestDefaults but was saved in policy.parameters`);
    }
    if (source === 'profileSettings' && requestDefaults !== undefined
        && Object.hasOwn(requestDefaults, property)) {
      misplaced.push(`'${property}' is declared as profileSettings but was saved in requestDefaults`);
    }
  }
  for (const property of Object.keys(requestDefaults ?? {})) {
    if (!Object.hasOwn(resolution, property)) {
      misplaced.push(`'${property}' is not declared as a requestDefaults parameter by ${action}`);
    }
  }
  if (misplaced.length > 0) {
    throw new HttpError(422, 'INVALID_SCHEMA', misplaced[0]!, {
      errors: misplaced.slice(0, 50).map((message) => ({ pointer: '/parameterResolution', message })),
    });
  }
}

async function validateConnectorPins(
  connectors: ConnectorManagementStore | undefined,
  tenantId: string,
  declaredSlots: readonly { name: string; required: boolean }[],
  pins: ProfileGroupFunctionInput['connectorBindings'],
): Promise<void> {
  const allowedSlots = new Set(declaredSlots.map((slot) => slot.name));
  for (const slot of declaredSlots) {
    if (slot.required && !pins[slot.name]) {
      throw new HttpError(422, 'INVALID_SCHEMA', `required connector slot '${slot.name}' must be pinned`);
    }
  }
  for (const [slot, pin] of Object.entries(pins)) {
    if (!allowedSlots.has(slot)) {
      throw new HttpError(422, 'INVALID_SCHEMA', `connector binding '${slot}' is not declared by the selected function`);
    }
    if (!connectors) {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector management is required to validate explicit profile pins');
    }
    if (!await isActiveConnectorPin(connectors, tenantId, pin)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'connector revision is not ACTIVE or available in this tenant');
    }
  }
}

/**
 * Validate the selected functions against the live registry.
 *
 * `requireWorkflowRevision` is true on the v2 path only. The v2 contract
 * (`ProfileGroupV2FunctionInputSchema`) makes the revision mandatory, while the
 * legacy v1 schema never did — a CHILD_PROJECTION group may hold a
 * workflow function without one, and keeping that legal is what "the
 * unconverted cohort is unaffected" means.
 */
async function validateRequestedMembers(
  client: PoolClient,
  connectors: ConnectorManagementStore | undefined,
  tenantId: string,
  members: readonly RequestedMember[],
  options: { requireWorkflowRevision?: boolean } = {},
): Promise<void> {
  const catalogs = new Map<string, Awaited<ReturnType<typeof getBusinessFunctionCatalog>>>();
  // PC-R07: the declared parameter sources, cached per business version beside
  // the catalog it belongs to. A manifest without the capability yields an empty
  // map, so v1 saves take exactly the path they took before.
  const parameterSources = new Map<string, ParameterResolutionByAction>();
  for (const member of members) {
    const key = JSON.stringify([member.businessId, member.businessVersion]);
    let catalog = catalogs.get(key);
    if (!catalog) {
      // A row-level share lock keeps a concurrent business disable from
      // committing between this validation and the aggregate transaction.
      // The lock is held by the caller's transaction through child materialization
      // and the group pointer commit.
      catalog = await getBusinessFunctionCatalog(client, member.businessId, member.businessVersion, { lockAvailability: true });
      catalogs.set(key, catalog);
      parameterSources.set(key, await readParameterResolutionByAction(client, member.businessId, member.businessVersion));
    }
    if (!catalog.businessEnabled) {
      throw new HttpError(409, 'STATE_CONFLICT', `business '${member.businessId}' is disabled and cannot be selected in a profile`);
    }
    if (catalog.manifestDigest !== member.manifestDigest) {
      throw new HttpError(409, 'MANIFEST_DIGEST_MISMATCH', `manifest for ${member.businessId}@${member.businessVersion} changed; reload its function catalog`);
    }
    const descriptor = catalog.functions.find((candidate) =>
      candidate.kind === member.kind
      && candidate.functionId === member.functionId
      && candidate.action === member.action
      && (candidate.endpointSlug ?? null) === member.endpointSlug,
    );
    if (!descriptor) {
      throw new HttpError(422, 'INVALID_SCHEMA', `function '${member.functionId}' is not declared by ${member.businessId}@${member.businessVersion}`);
    }
    if (!descriptor.available) {
      throw new HttpError(409, 'STATE_CONFLICT', descriptor.unavailableReason ?? 'function is not currently admitted');
    }
    // PC-R07: a saved value must land in the source its manifest declares. This
    // is payload validation, so it runs before the registry lookups below and
    // long before any child materialization: a misplaced save leaves no
    // registry, revision or member row behind.
    assertParameterSourcePlacement(
      member.action,
      parameterSources.get(key)?.get(member.action),
      member.policy.parameters as Readonly<Record<string, unknown>> | undefined,
      member.requestDefaults,
    );
    // PC-03 / plan §"Workflow and runtime": a workflow function is selectable and
    // pinned per group revision. The identity IS `functionId` (the manifest
    // action name) — that is how the catalog declares workflow functions. The
    // revision must exist and be ACTIVE for this tenant, otherwise the group
    // would pin a selector no worker can resolve.
    if (member.kind === 'endpoint') {
      if (member.workflowRevision !== null) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'workflowRevision is not supported for manifest action functions');
      }
    } else {
      if (member.workflowRevision === null) {
        if (options.requireWorkflowRevision === true) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'workflow functions require an explicit workflowRevision');
        }
        // Legacy v1 semantics: an unspecified workflow revision is recorded as
        // NULL on the group member row and resolved by the old facade.
        await validateConnectorPins(connectors, tenantId, descriptor.connectorSlots, member.connectorBindings);
        continue;
      }
      const workflow = await client.query<{ status: string }>(
        `SELECT status FROM legacy_workflow_schemas
          WHERE tenant_id=$1 AND slug=$2 AND revision=$3
          LIMIT 1`,
        [tenantId, member.functionId, member.workflowRevision],
      );
      if (!workflow.rowCount) {
        throw new HttpError(404, 'NOT_FOUND', `workflow revision ${member.functionId}@${member.workflowRevision} was not found in this tenant`);
      }
      // 0037 stores the status lowercase ('active' | 'retired').
      if (String(workflow.rows[0]!.status).toLowerCase() !== 'active') {
        throw new HttpError(409, 'STATE_CONFLICT', `workflow revision ${member.functionId}@${member.workflowRevision} is not active`);
      }
    }
    await validateConnectorPins(connectors, tenantId, descriptor.connectorSlots, member.connectorBindings);
  }
}

/**
 * PC-03: a v2 group has no selected key, so overlapping bindings are judged
 * against the group's OWN current root grants instead of one key: a key this
 * group already grants must not also hold an overlapping binding outside the
 * group. Zero grants (a brand-new group) trivially passes — there is no
 * authority to collide with.
 */
async function assertNoAmbiguousBindings(
  client: PoolClient,
  groupId: string,
  tenantId: string,
  members: readonly RequestedMember[],
): Promise<void> {
  for (const member of members) {
    const result = await client.query<{ profile_id: string }>(
      `SELECT p.profile_id
         FROM profile_active_revisions a
         JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
         JOIN profile_names n ON n.profile_id=p.profile_id
         JOIN profile_group_api_keys g
           ON g.api_key_id=p.api_key_id AND g.tenant_id=$1 AND g.state='ACTIVE' AND g.group_id=$6
        WHERE p.tenant_id=$1
          AND p.business_id=$2 AND p.business_version=$3 AND p.action=$4
          AND (p.endpoint_slug IS NULL OR $5::text IS NULL OR p.endpoint_slug=$5)
          AND n.group_id IS DISTINCT FROM $6
        LIMIT 1`,
      [tenantId, member.businessId, member.businessVersion, member.action, member.endpointSlug, groupId],
    );
    if (result.rowCount) {
      throw new HttpError(409, 'STATE_CONFLICT', 'another active profile already binds this API key and function');
    }
  }
}

/**
 * The legacy child-projection overlap rule: one API key may not hold two
 * overlapping ACTIVE bindings for the same function outside this group.
 * Kept verbatim for `CHILD_PROJECTION` groups; the v2 path uses
 * `assertNoAmbiguousBindings` against the root grant ledger instead.
 */
async function assertLegacyKeyOverlap(
  client: PoolClient,
  apiKeyId: string,
  groupId: string,
  members: readonly RequestedMember[],
): Promise<void> {
  for (const member of members) {
    const result = await client.query<{ profile_id: string }>(
      `SELECT p.profile_id
         FROM profile_active_revisions a
         JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
         JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$1
          AND m.state='ACTIVE' AND m.tenant_id=p.tenant_id
         LEFT JOIN profile_names n ON n.profile_id=p.profile_id
        WHERE p.business_id=$2 AND p.business_version=$3 AND p.action=$4
          AND (p.endpoint_slug IS NULL OR $5::text IS NULL OR p.endpoint_slug=$5)
          AND n.group_id IS DISTINCT FROM $6
        LIMIT 1`,
      [apiKeyId, member.businessId, member.businessVersion, member.action, member.endpointSlug, groupId],
    );
    if (result.rowCount) {
      throw new HttpError(409, 'STATE_CONFLICT', 'another active profile already binds this API key and function');
    }
  }
}

async function loadActiveGroup(client: PoolClient, groupId: string, tenantId?: string): Promise<{
  root: GroupRootRow;
  revision: GroupRevisionRow;
  members: GroupMemberRow[];
}> {
  const params: unknown[] = [groupId];
  const tenantFilter = tenantId ? ' AND g.tenant_id=$2' : '';
  if (tenantId) params.push(tenantId);
  const group = await client.query<GroupRootRow & GroupRevisionRow>(
    `SELECT g.group_id, g.tenant_id, g.name AS root_name, g.active_revision,
            g.auth_authority, g.access_version,
            g.created_at, g.updated_at,
            r.revision, r.name, r.api_key_id, r.created_at AS revision_created_at
       FROM profile_groups g
       JOIN profile_group_revisions r
         ON r.group_id=g.group_id AND r.revision=g.active_revision
      WHERE g.group_id=$1${tenantFilter}
      FOR UPDATE OF g`,
    params,
  );
  const row = group.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'profile group was not found');
  const root: GroupRootRow = {
    group_id: row.group_id,
    tenant_id: row.tenant_id,
    name: row.root_name,
    active_revision: Number(row.active_revision),
    auth_authority: row.auth_authority === 'GROUP_GRANT' ? 'GROUP_GRANT' : 'CHILD_PROJECTION',
    access_version: Number(row.access_version),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  const revision: GroupRevisionRow = {
    group_id: row.group_id,
    revision: Number(row.revision),
    tenant_id: row.tenant_id,
    name: row.name,
    api_key_id: row.api_key_id,
    created_at: row.revision_created_at,
  };
  const memberRows = await client.query<GroupMemberRow>(
    `SELECT m.business_id, m.business_version, m.manifest_digest, m.function_kind,
            m.function_id, m.action, m.endpoint_slug, m.workflow_revision,
            m.profile_id, m.binding_revision, active.revision AS active_binding_revision,
            b.enabled, b.parameters, b.job_priority, b.allowed_file_extensions,
            b.connections_override, b.file_url_auth_cipher, b.request_redaction,
            b.callback_policy, b.allowed_origins, b.connector_bindings,
            b.request_defaults
       FROM profile_group_members m
       JOIN profile_bindings b
         ON b.profile_id=m.profile_id AND b.revision=m.binding_revision
       LEFT JOIN profile_active_revisions active ON active.profile_id=m.profile_id
      WHERE m.group_id=$1 AND m.group_revision=$2
      ORDER BY m.business_id, m.business_version, m.action, m.endpoint_slug NULLS FIRST, m.function_id`,
    [groupId, root.active_revision],
  );
  return { root, revision, members: memberRows.rows };
}

async function resolveCurrentGroupKey(
  client: PoolClient,
  root: GroupRootRow,
  revision: GroupRevisionRow,
  members: readonly GroupMemberRow[],
): Promise<ApiKeyRow> {
  const profileIds = [...new Set(members.map((member) => member.profile_id))];
  if (profileIds.length === 0) {
    // Empty groups have no child-membership intersection to identify a rotated
    // replacement. Their explicit authorized key is the active revision's
    // existing key reference; it is never inferred from another tenant key.
    const historical = await client.query<ApiKeyRow>(
      'SELECT id, tenant_id, hash, prefix, status FROM api_keys WHERE id=$1 AND tenant_id=$2',
      [revision.api_key_id, root.tenant_id],
    );
    const key = historical.rows[0];
    if (!key) throw new HttpError(409, 'STATE_CONFLICT', 'empty profile group API-key reference is missing');
    return key;
  }

  const candidates = await client.query<ApiKeyRow>(
    `SELECT k.id, k.tenant_id, k.hash, k.prefix, k.status
       FROM api_keys k
      WHERE k.tenant_id=$1 AND k.status='ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM unnest($2::uuid[]) AS required(profile_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM profile_api_keys m
              WHERE m.profile_id=required.profile_id AND m.api_key_id=k.id
                AND m.tenant_id=$1 AND m.state='ACTIVE'
           )
        )
      ORDER BY k.id`,
    [root.tenant_id, profileIds],
  );
  if (candidates.rows.length !== 1) {
    throw new HttpError(
      409,
      'STATE_CONFLICT',
      candidates.rows.length === 0
        ? 'no single ACTIVE tenant API key is a member of every current profile group child'
        : 'multiple ACTIVE tenant API keys match every current profile group child; refusing to choose one',
    );
  }
  return candidates.rows[0]!;
}

function toGroupWire(
  root: GroupRootRow,
  revision: GroupRevisionRow,
  key: Pick<ApiKeyRow, 'id' | 'prefix' | 'status'>,
  rows: readonly GroupMemberRow[],
): ProfileGroup {
  const grouped = new Map<string, ProfileGroupBusiness>();
  for (const row of rows) {
    if (Number(row.active_binding_revision) !== Number(row.binding_revision)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'profile group child pointer does not match its immutable snapshot');
    }
    const businessKey = JSON.stringify([row.business_id, row.business_version]);
    let business = grouped.get(businessKey);
    if (!business) {
      business = {
        businessId: row.business_id,
        businessVersion: row.business_version,
        manifestDigest: row.manifest_digest,
        functions: [],
      };
      grouped.set(businessKey, business);
    }
    const binding: ProfileGroupFunctionBinding = {
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      ...(row.endpoint_slug ? { endpointSlug: row.endpoint_slug } : {}),
      ...(row.workflow_revision ? { workflowRevision: Number(row.workflow_revision) } : {}),
      manifestDigest: row.manifest_digest,
      childProfileId: row.profile_id,
      childRevision: Number(row.binding_revision),
      enabled: row.enabled !== false,
      policy: profileDetailPolicyRead(row as unknown as ProfileDetailDbRow),
      connectorBindings: profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow),
    };
    business.functions.push(binding);
  }

  return {
    groupId: root.group_id,
    name: revision.name,
    tenantId: root.tenant_id,
    revision: Number(revision.revision),
    apiKey: { apiKeyId: key.id, prefix: key.prefix, status: key.status },
    businesses: [...grouped.values()],
    createdAt: dateToIso(root.created_at),
    updatedAt: dateToIso(root.updated_at),
  };
}

/**
 * PC-03 v1 compatibility projection.
 *
 * A `CHILD_PROJECTION` group keeps today's behaviour byte-for-byte: the
 * singular `apiKey` is derived by intersecting the children's ACTIVE
 * memberships, including its 409 refusals.
 *
 * A `GROUP_GRANT` group is projected from the ROOT GRANT LEDGER and only when
 * exactly one ACTIVE grant exists. Zero or many grants cannot be represented by
 * the v1 DTO (one key field), so the read answers `409 PROFILE_GROUP_V2_REQUIRED`
 * instead of guessing. The message is identical for 0 and >1 so the refusal
 * cannot be used to count grants.
 */
async function readGroupOn(client: PoolClient, groupId: string, tenantId?: string): Promise<ProfileGroup> {
  const loaded = await loadActiveGroup(client, groupId, tenantId);
  if (loaded.root.auth_authority === 'GROUP_GRANT') {
    const grants = await loadActiveGrantKeys(client, groupId, loaded.root.tenant_id);
    if (grants.length !== 1) {
      throw new HttpError(
        409,
        'PROFILE_GROUP_V2_REQUIRED',
        'this profile group is managed by root grants; use /api/v2/admin/profile-groups',
      );
    }
    return toGroupWire(loaded.root, loaded.revision, grants[0]!, loaded.members);
  }
  const apiKey = await resolveCurrentGroupKey(client, loaded.root, loaded.revision, loaded.members);
  return toGroupWire(loaded.root, loaded.revision, apiKey, loaded.members);
}

/** The ACTIVE root grants of a group, joined to key metadata (never key material). */
async function loadActiveGrantKeys(
  client: GroupQueryable,
  groupId: string,
  tenantId: string,
): Promise<ApiKeyRow[]> {
  const result = await client.query<ApiKeyRow>(
    `SELECT k.id, k.tenant_id, k.hash, k.prefix, k.status
       FROM profile_group_api_keys g
       JOIN api_keys k ON k.id=g.api_key_id AND k.tenant_id=g.tenant_id
      WHERE g.group_id=$1 AND g.tenant_id=$2 AND g.state='ACTIVE'
      ORDER BY g.granted_at, k.id`,
    [groupId, tenantId],
  );
  return result.rows;
}

export async function getProfileGroup(
  db: Db,
  groupId: string,
  tenantId?: string,
): Promise<ProfileGroup> {
  const found = await db.query<{ group_id: string }>(
    `SELECT group_id FROM profile_groups WHERE group_id=$1${tenantId ? ' AND tenant_id=$2' : ''}`,
    tenantId ? [groupId, tenantId] : [groupId],
  );
  if (!found.rowCount) throw new HttpError(404, 'NOT_FOUND', 'profile group was not found');
  return db.tx((client) => readGroupOn(client, groupId, tenantId));
}

export async function listProfileGroups(db: Db, tenantId: string): Promise<{ groups: ProfileGroup[] }> {
  const result = await db.query<{ group_id: string }>(
    'SELECT group_id FROM profile_groups WHERE tenant_id=$1 ORDER BY updated_at DESC, group_id',
    [tenantId],
  );
  const groups = await Promise.all(result.rows.map((row) => getProfileGroup(db, row.group_id, tenantId)));
  return { groups };
}

async function existingGroupMembers(client: PoolClient, groupId: string, revision: number): Promise<GroupMemberRow[]> {
  const result = await client.query<GroupMemberRow>(
    `SELECT m.business_id, m.business_version, m.manifest_digest, m.function_kind,
            m.function_id, m.action, m.endpoint_slug, m.workflow_revision,
            m.profile_id, m.binding_revision, active.revision AS active_binding_revision,
            b.enabled, b.parameters, b.job_priority, b.allowed_file_extensions,
            b.connections_override, b.file_url_auth_cipher, b.request_redaction,
            b.callback_policy, b.allowed_origins, b.connector_bindings,
            b.request_defaults
       FROM profile_group_members m
       JOIN profile_bindings b ON b.profile_id=m.profile_id AND b.revision=m.binding_revision
       LEFT JOIN profile_active_revisions active ON active.profile_id=m.profile_id
      WHERE m.group_id=$1 AND m.group_revision=$2`,
    [groupId, revision],
  );
  return result.rows;
}

async function assertNameAvailable(
  client: PoolClient,
  tenantId: string,
  name: string,
  exceptGroupId: string | null,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`profile-group:${tenantId}:${name}`]);
  const result = await client.query<{ group_id: string }>(
    `SELECT group_id FROM profile_groups
      WHERE tenant_id=$1 AND name=$2 AND ($3::uuid IS NULL OR group_id<>$3)
      LIMIT 1`,
    [tenantId, name, exceptGroupId],
  );
  if (result.rowCount) throw new HttpError(409, 'STATE_CONFLICT', 'a profile group with this name already exists in the tenant');
}

async function lookupChildProfile(
  client: PoolClient,
  groupId: string,
  tenantId: string,
  member: RequestedMember,
): Promise<{ profileId: string; profileName: string } | null> {
  const profileName = childProfileName(groupId, member);
  const result = await client.query<{ profile_id: string; group_id: string | null }>(
    `SELECT profile_id, group_id FROM profile_names
      WHERE tenant_id=$1 AND profile_name=$2 AND business_id=$3 AND business_version=$4 AND action=$5
      LIMIT 1 FOR UPDATE`,
    [tenantId, profileName, member.businessId, member.businessVersion, member.action],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.group_id !== groupId) throw new HttpError(409, 'STATE_CONFLICT', 'profile group child identity is already owned by another profile');
  return { profileId: row.profile_id, profileName };
}

/**
 * PC-03: who authors a child revision.
 *
 * `key` is the legacy child-projection mode (v1 groups): the selected API key
 * authors the revision and owns an ACTIVE membership. `actor` is the v2
 * group-grant mode: an Admin actor authors it, `api_key_id` stays NULL, and no
 * membership ever appears.
 */
type ChildAuthor =
  | { kind: 'key'; key: ApiKeyRow; tenantId: string }
  | { kind: 'actor'; actor: ProfileGroupActor; tenantId: string };

async function createChildRevision(
  client: PoolClient,
  profiles: ProfileService,
  author: ChildAuthor,
  groupId: string,
  member: RequestedMember,
): Promise<MemberSnapshot> {
  const tenantId = author.tenantId;
  const existing = await lookupChildProfile(client, groupId, tenantId, member);
  const profileId = existing?.profileId ?? randomUUID();
  const profileName = existing?.profileName ?? childProfileName(groupId, member);
  if (!existing) {
    // A group child is owned by its GROUP, not by a key: `api_key_id` stays
    // NULL and `profile_names_owner_shape` is satisfied by `group_id`.
    await client.query(
      `INSERT INTO profile_names
         (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        profileId,
        tenantId,
        author.kind === 'key' ? author.key.id : null,
        member.businessId,
        member.businessVersion,
        member.action,
        profileName,
        groupId,
      ],
    );
  } else if (author.kind === 'key') {
    // Legacy projection keeps re-pointing the registry at the selected key.
    // A group-owned append never rewrites the historical author.
    await client.query(
      'UPDATE profile_names SET api_key_id=$2 WHERE profile_id=$1 AND group_id=$3',
      [profileId, author.key.id, groupId],
    );
  }
  const created = await profiles.createGroupChildRevision({
    profileId,
    businessId: member.businessId,
    businessVersion: member.businessVersion,
    action: member.action,
    connectorBindings: member.connectorBindings,
    ...(member.endpointSlug ? { endpointSlug: member.endpointSlug } : {}),
    policy: member.policy,
    requestDefaults: member.requestDefaults,
    ...(author.kind === 'key' ? { apiKeyHash: author.key.hash } : { actor: author.actor }),
  }, groupId, client, author.kind === 'actor' ? author.actor : undefined);
  if (author.kind === 'key') {
    await profiles.addMembership({ profileId, apiKeyId: author.key.id, tenantId }, client);
  }
  return {
    businessId: member.businessId,
    businessVersion: member.businessVersion,
    manifestDigest: member.manifestDigest,
    kind: member.kind,
    functionId: member.functionId,
    action: member.action,
    endpointSlug: member.endpointSlug,
    workflowRevision: member.workflowRevision,
    profileId,
    bindingRevision: created.revision,
  };
}

async function disableRemovedChild(
  client: PoolClient,
  profiles: ProfileService,
  author: ChildAuthor,
  groupId: string,
  row: GroupMemberRow,
): Promise<void> {
  const existingPolicy = profileDetailPolicyRead(row as unknown as ProfileDetailDbRow);
  const connectorBindings = profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow);
  if (author.kind === 'key') {
    await client.query('UPDATE profile_names SET api_key_id=$2 WHERE profile_id=$1 AND group_id=$3', [row.profile_id, author.key.id, groupId]);
  }
  await profiles.createGroupChildRevision({
    profileId: row.profile_id,
    businessId: row.business_id,
    businessVersion: row.business_version,
    action: row.action,
    connectorBindings,
    requestDefaults: normalizeStoredRequestDefaults(row.request_defaults),
    ...(row.endpoint_slug ? { endpointSlug: row.endpoint_slug } : {}),
    policy: { ...existingPolicy, enabled: false },
    ...(author.kind === 'key' ? { apiKeyHash: author.key.hash } : { actor: author.actor }),
  }, groupId, client, author.kind === 'actor' ? author.actor : undefined);
  // Legacy child-projection mode still ends the removed child's membership. A
  // group-owned child has none by construction, and revoking "whatever is
  // ACTIVE" here would destroy an unrelated membership.
  if (author.kind === 'key') {
    await client.query(
      `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
        WHERE profile_id=$1 AND state='ACTIVE'`,
      [row.profile_id],
    );
  }
}

async function insertGroupSnapshot(
  client: PoolClient,
  input: {
    groupId: string;
    revision: number;
    tenantId: string;
    name: string;
    /** PC-03: NULL for a group-owned config revision (no authoring key). */
    apiKeyId: string | null;
    actor?: ProfileGroupActor;
    members: readonly MemberSnapshot[];
    expectedRevision: number;
  },
): Promise<void> {
  // `profile_group_revisions_attribution_shape` requires a key OR an actor, so
  // a v2 revision without an actor fails at the database — the intended last
  // line of defence for "record the Admin actor separately".
  await client.query(
    `INSERT INTO profile_group_revisions
       (group_id, revision, tenant_id, name, api_key_id,
        created_by, created_by_issuer, created_by_sub)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.groupId,
      input.revision,
      input.tenantId,
      input.name,
      input.apiKeyId,
      input.actor?.actor ?? null,
      input.actor?.issuer ?? null,
      input.actor?.sub ?? null,
    ],
  );
  for (const member of input.members) {
    await client.query(
      `INSERT INTO profile_group_members
         (group_id, group_revision, business_id, business_version, manifest_digest,
          function_kind, function_id, action, endpoint_slug, workflow_revision,
          profile_id, binding_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.groupId,
        input.revision,
        member.businessId,
        member.businessVersion,
        member.manifestDigest,
        member.kind,
        member.functionId,
        member.action,
        member.endpointSlug,
        member.workflowRevision,
        member.profileId,
        member.bindingRevision,
      ],
    );
  }
  const updated = await client.query(
    `UPDATE profile_groups
        SET name=$2, active_revision=$3, updated_at=now()
      WHERE group_id=$1 AND active_revision=$4`,
    [input.groupId, input.name, input.revision, input.expectedRevision],
  );
  if (updated.rowCount !== 1) throw new HttpError(409, 'REVISION_CONFLICT', 'profile group changed while the new revision was being saved');
}

async function saveProfileGroupOn(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  input: ProfileGroupSave,
  groupId: string | null,
  tenantScope?: string,
): Promise<ProfileGroup> {
  const requestedMembers = normalizeRequestedFunctions(input.businesses);
  let root: GroupRootRow | null = null;
  let currentMembers: GroupMemberRow[] = [];
  let id = groupId;
  if (id) {
    const loaded = await loadActiveGroup(client, id, tenantScope);
    root = loaded.root;
    if (input.expectedRevision !== root.active_revision) {
      throw new HttpError(409, 'REVISION_CONFLICT', `expected profile group revision ${input.expectedRevision} but active revision is ${root.active_revision}`);
    }
    if (input.tenantId && input.tenantId !== root.tenant_id) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'profile group cannot move between tenants');
    }
    if (root.auth_authority === 'GROUP_GRANT') {
      // D-1: a converted group is never mutated (or silently re-converted) by
      // the legacy writer. Doing so would revoke child memberships and restore
      // exactly the child-projection authority the cutover removed.
      throw new HttpError(
        409,
        'PROFILE_GROUP_V2_REQUIRED',
        'this profile group is managed by root grants; use /api/v2/admin/profile-groups',
      );
    }
    currentMembers = await existingGroupMembers(client, id, root.active_revision);
  } else {
    if (input.expectedRevision !== 0) throw new HttpError(409, 'REVISION_CONFLICT', 'a new profile group must start at expectedRevision 0');
    if (!input.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required when creating a profile group');
    id = randomUUID();
  }

  const tenantId = root?.tenant_id ?? input.tenantId!;
  if (tenantScope && tenantScope !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'profile group is outside the caller tenant');
  await assertNameAvailable(client, tenantId, input.name, id);
  await profiles.lockSelectors([
    ...requestedMembers.map((member) => ({
      businessId: member.businessId,
      businessVersion: member.businessVersion,
      action: member.action,
      endpointSlug: member.endpointSlug,
    })),
    ...currentMembers.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
  ], client);
  // PC-03 lock order (plan §"Transaction and lock order" item 7): business /
  // version / selector rows are locked BEFORE API-key rows. The business
  // availability share lock lives inside `validateRequestedMembers`, so it runs
  // before `loadSelectedKey` takes its key lock. The key is resolved without a
  // lock first, purely to keep the historical 404/403 precedence.
  const peeked = await peekSelectedKey(client, input.apiKey.apiKeyId);
  if (peeked.tenant_id !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'selected API key is outside the profile group tenant');
  await validateRequestedMembers(client, connectors, tenantId, requestedMembers);
  const key = await loadSelectedKey(client, input.apiKey.apiKeyId);
  if (key.tenant_id !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'selected API key is outside the profile group tenant');

  // The legacy child-projection save keeps its key-overlap rule verbatim.
  await assertLegacyKeyOverlap(client, key.id, id, requestedMembers);

  const author: ChildAuthor = { kind: 'key', key, tenantId };

  if (!root) {
    const tenant = await client.query('SELECT id FROM tenants WHERE id=$1', [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, 'NOT_FOUND', 'profile group tenant was not found');
    await client.query(
      `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision)
       VALUES ($1,$2,$3,0)`,
      [id, tenantId, input.name],
    );
    root = {
      group_id: id,
      tenant_id: tenantId,
      name: input.name,
      active_revision: 0,
      auth_authority: 'CHILD_PROJECTION',
      access_version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  const revision = root.active_revision + 1;
  const members: MemberSnapshot[] = [];
  const requestedIds = new Set(requestedMembers.map(functionIdentity));
  for (const member of requestedMembers) {
    members.push(await createChildRevision(client, profiles, author, id, member));
  }

  const previousByIdentity = new Map<string, GroupMemberRow>();
  for (const row of currentMembers) {
    const identity = functionIdentity({
      businessId: row.business_id,
      businessVersion: row.business_version,
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      endpointSlug: row.endpoint_slug,
    });
    previousByIdentity.set(identity, row);
  }
  for (const [identity, row] of previousByIdentity) {
    if (!requestedIds.has(identity)) {
      await disableRemovedChild(client, profiles, author, id, row);
    }
  }

  const memberProfileIds = [...new Set(members.map((member) => member.profileId))];
  if (memberProfileIds.length) {
    await client.query(
      `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
        WHERE profile_id=ANY($1::uuid[]) AND api_key_id<>$2 AND state='ACTIVE'`,
      [memberProfileIds, key.id],
    );
  }
  await insertGroupSnapshot(client, {
    groupId: id,
    revision,
    tenantId,
    name: input.name,
    apiKeyId: key.id,
    members,
    expectedRevision: root.active_revision,
  });

  const updated = await loadActiveGroup(client, id, tenantId);
  const keyDto = await client.query<Pick<ApiKeyRow, 'id' | 'prefix' | 'status'>>(
    'SELECT id, prefix, status FROM api_keys WHERE id=$1 AND tenant_id=$2',
    [key.id, tenantId],
  );
  if (!keyDto.rows[0]) throw new HttpError(409, 'STATE_CONFLICT', 'selected API key disappeared while saving the profile group');
  return toGroupWire(updated.root, updated.revision, keyDto.rows[0], updated.members);
}

export async function saveProfileGroup(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  input: ProfileGroupSave,
  groupId: string | null,
  tenantScope?: string,
): Promise<ProfileGroup> {
  return saveProfileGroupOn(client, profiles, connectors, input, groupId, tenantScope);
}

async function loadTargetRevision(
  client: PoolClient,
  groupId: string,
  targetRevision: number,
  tenantId: string,
): Promise<{ revision: GroupRevisionRow; members: GroupMemberRow[] }> {
  const revisionResult = await client.query<GroupRevisionRow>(
    `SELECT group_id, revision, tenant_id, name, api_key_id, created_at
       FROM profile_group_revisions
      WHERE group_id=$1 AND revision=$2 AND tenant_id=$3`,
    [groupId, targetRevision, tenantId],
  );
  const revision = revisionResult.rows[0];
  if (!revision) throw new HttpError(404, 'NOT_FOUND', 'target profile group revision was not found');
  const members = await existingGroupMembers(client, groupId, targetRevision);
  return { revision, members };
}

async function rollbackProfileGroupOn(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  groupId: string,
  input: ProfileGroupRollback,
  tenantScope?: string,
): Promise<ProfileGroup> {
  const current = await loadActiveGroup(client, groupId, tenantScope);
  // PC-03 firewall: refuse a converted group before resolving its rollback
  // target, so a GROUP_GRANT cohort gets the migration code rather than a 404
  // about a revision it is not allowed to move.
  if (current.root.auth_authority === 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'this profile group is managed by root grants; use /api/v2/admin/profile-groups',
    );
  }
  if (current.root.active_revision !== input.expectedRevision) {
    throw new HttpError(409, 'REVISION_CONFLICT', `expected profile group revision ${input.expectedRevision} but active revision is ${current.root.active_revision}`);
  }
  const target = await loadTargetRevision(client, groupId, input.targetRevision, current.root.tenant_id);
  await profiles.lockSelectors([
    ...current.members.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
    ...target.members.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
  ], client);
  const currentKey = await resolveCurrentGroupKey(client, current.root, current.revision, current.members);
  const key = await loadSelectedKey(client, currentKey.id);
  if (key.tenant_id !== current.root.tenant_id) throw new HttpError(409, 'STATE_CONFLICT', 'current profile group API key no longer belongs to its tenant');

  const targetMembers = target.members.map((row): RequestedMember => ({
    businessId: row.business_id,
    businessVersion: row.business_version,
    manifestDigest: row.manifest_digest,
    kind: row.function_kind,
    functionId: row.function_id,
    action: row.action,
    endpointSlug: row.endpoint_slug,
    workflowRevision: row.workflow_revision === null ? null : Number(row.workflow_revision),
    policy: profileDetailPolicyRead(row as unknown as ProfileDetailDbRow),
    requestDefaults: normalizeStoredRequestDefaults(row.request_defaults),
    connectorBindings: profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow),
  }));
  await validateRequestedMembers(client, connectors, current.root.tenant_id, targetMembers);
  await assertLegacyKeyOverlap(client, key.id, groupId, targetMembers);

  const author: ChildAuthor = { kind: 'key', key, tenantId: current.root.tenant_id };
  const newRevision = current.root.active_revision + 1;
  const snapshots: MemberSnapshot[] = [];
  for (const row of target.members) {
    const pointer = await client.query<{ revision: number }>(
      'SELECT revision FROM profile_active_revisions WHERE profile_id=$1 FOR UPDATE',
      [row.profile_id],
    );
    const activeRevision = pointer.rows[0]?.revision;
    if (activeRevision === undefined) throw new HttpError(409, 'STATE_CONFLICT', 'target group child profile has no active revision pointer');
    if (Number(activeRevision) !== Number(row.active_binding_revision)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'target group child pointer changed while rollback was being prepared');
    }
    const targetBinding = await client.query(
      'SELECT 1 FROM profile_bindings WHERE profile_id=$1 AND revision=$2',
      [row.profile_id, row.binding_revision],
    );
    if (!targetBinding.rowCount) throw new HttpError(404, 'NOT_FOUND', 'target group child revision was not found');
    await pinActiveRevision(client, row.profile_id, Number(row.binding_revision));
    await client.query('UPDATE profile_names SET api_key_id=$2 WHERE profile_id=$1 AND group_id=$3', [row.profile_id, key.id, groupId]);
    await profiles.addMembership({ profileId: row.profile_id, apiKeyId: key.id, tenantId: current.root.tenant_id }, client);
    snapshots.push({
      businessId: row.business_id,
      businessVersion: row.business_version,
      manifestDigest: row.manifest_digest,
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      endpointSlug: row.endpoint_slug,
      workflowRevision: row.workflow_revision === null ? null : Number(row.workflow_revision),
      profileId: row.profile_id,
      bindingRevision: Number(row.binding_revision),
    });
  }

  const targetIds = new Set(target.members.map((row) => row.profile_id));
  for (const row of current.members) {
    if (!targetIds.has(row.profile_id)) {
      await disableRemovedChild(client, profiles, author, groupId, row);
    }
  }
  if (snapshots.length) {
    await client.query(
      `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
        WHERE profile_id=ANY($1::uuid[]) AND api_key_id<>$2 AND state='ACTIVE'`,
      [snapshots.map((member) => member.profileId), key.id],
    );
  }

  await insertGroupSnapshot(client, {
    groupId,
    revision: newRevision,
    tenantId: current.root.tenant_id,
    name: target.revision.name,
    apiKeyId: key.id,
    members: snapshots,
    expectedRevision: current.root.active_revision,
  });
  const updated = await loadActiveGroup(client, groupId, current.root.tenant_id);
  const keyDto = await client.query<Pick<ApiKeyRow, 'id' | 'prefix' | 'status'>>(
    'SELECT id, prefix, status FROM api_keys WHERE id=$1 AND tenant_id=$2',
    [key.id, current.root.tenant_id],
  );
  if (!keyDto.rows[0]) throw new HttpError(409, 'STATE_CONFLICT', 'target profile group API key disappeared during rollback');
  return toGroupWire(updated.root, updated.revision, keyDto.rows[0], updated.members);
}

export async function rollbackProfileGroup(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  groupId: string,
  input: ProfileGroupRollback,
  tenantScope?: string,
): Promise<ProfileGroup> {
  return rollbackProfileGroupOn(client, profiles, connectors, groupId, input, tenantScope);
}

/* ========================================================================== */
/* PC-03 — group-root configuration, root grants and the conversion proof     */
/* ========================================================================== */

function defaultMintRawKey(): string {
  return `du_${randomBytes(32).toString('base64url')}`;
}

/**
 * The authority a public/admission caller must use for this group.
 *
 * PC-05 uses this to select the resolver. It deliberately returns only the
 * authority pair, so no caller can read the grant ledger and then decide to
 * fall back to child memberships.
 */
export async function readGroupAuthority(
  client: GroupQueryable,
  groupId: string,
  tenantId?: string,
): Promise<GroupAuthorityRecord> {
  const result = await client.query<{
    group_id: string;
    tenant_id: string;
    auth_authority: string;
    access_version: string | number;
    active_revision: number;
  }>(
    `SELECT group_id, tenant_id, auth_authority, access_version, active_revision
       FROM profile_groups WHERE group_id=$1${tenantId ? ' AND tenant_id=$2' : ''}`,
    tenantId ? [groupId, tenantId] : [groupId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'profile group was not found');
  return {
    groupId: row.group_id,
    tenantId: row.tenant_id,
    authority: row.auth_authority === 'GROUP_GRANT' ? 'GROUP_GRANT' : 'CHILD_PROJECTION',
    accessVersion: Number(row.access_version),
    activeRevision: Number(row.active_revision),
  };
}

/** The group that owns `profileId`, or `null` for a standalone profile. */
export async function readGroupAuthorityForProfile(
  client: GroupQueryable,
  profileId: string,
): Promise<{ groupId: string | null; authority: ProfileGroupAuthAuthority | null }> {
  const result = await client.query<{ group_id: string | null; auth_authority: string | null }>(
    `SELECT n.group_id, g.auth_authority
       FROM profile_names n
       LEFT JOIN profile_groups g ON g.group_id = n.group_id
      WHERE n.profile_id=$1
      LIMIT 1`,
    [profileId],
  );
  const row = result.rows[0];
  if (!row || row.group_id === null) return { groupId: null, authority: null };
  return {
    groupId: row.group_id,
    authority: row.auth_authority === 'GROUP_GRANT' ? 'GROUP_GRANT' : 'CHILD_PROJECTION',
  };
}

/**
 * PC-03 compatibility firewall — one helper every legacy write path calls.
 *
 * `GROUP_GRANT` ⇒ `409 PROFILE_GROUP_V2_REQUIRED` with zero writes performed.
 * A `CHILD_PROJECTION` group keeps its legacy semantics, so the unconverted
 * cohort is unaffected.
 */
export async function assertLegacyGroupWriteAllowed(
  client: GroupQueryable,
  subject: { groupId: string } | { profileId: string },
): Promise<void> {
  const authority = 'groupId' in subject
    ? (await readGroupAuthority(client, subject.groupId)).authority
    : (await readGroupAuthorityForProfile(client, subject.profileId)).authority;
  if (authority === 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'this profile group is managed by root grants; use /api/v2/admin/profile-groups',
    );
  }
}

/**
 * PC-05 admission seam: the current ACTIVE root grant for a presented key.
 *
 * `null` means "no grant" and MUST be treated as a denial for a
 * `GROUP_MANAGED` key — never a cue to fall back to child memberships.
 */
export async function resolveRootGrant(
  client: GroupQueryable,
  apiKeyId: string,
  tenantId?: string,
): Promise<{
  groupId: string;
  tenantId: string;
  accessVersion: number;
  grantedAt: string;
} | null> {
  const result = await client.query<{
    group_id: string;
    tenant_id: string;
    access_version: string | number;
    granted_at: Date | string;
  }>(
    `SELECT g.group_id, g.tenant_id, p.access_version, g.granted_at
       FROM profile_group_api_keys g
       JOIN profile_groups p ON p.group_id=g.group_id AND p.tenant_id=g.tenant_id
      WHERE g.api_key_id=$1 AND g.state='ACTIVE'${tenantId ? ' AND g.tenant_id=$2' : ''}`,
    tenantId ? [apiKeyId, tenantId] : [apiKeyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    groupId: row.group_id,
    tenantId: row.tenant_id,
    accessVersion: Number(row.access_version),
    grantedAt: dateToIso(row.granted_at),
  };
}

/**
 * PC-04 seam — a global key revoke must tombstone every active root grant and
 * bump each affected group's access version IN THE SAME transaction as the
 * `api_keys.status` flip. Lock order: sorted group roots, then grant rows, then
 * the counters.
 */
export async function revokeAllGroupGrantsForApiKey(
  client: PoolClient,
  apiKeyId: string,
  tenantId: string,
  actor: ProfileGroupActor,
): Promise<{ revoked: number; groupIds: string[] }> {
  const candidates = await client.query<{ group_id: string }>(
    `SELECT group_id FROM profile_group_api_keys
      WHERE api_key_id=$1 AND tenant_id=$2 AND state='ACTIVE'
      ORDER BY group_id`,
    [apiKeyId, tenantId],
  );
  const groupIds = candidates.rows.map((row) => row.group_id);
  if (groupIds.length === 0) return { revoked: 0, groupIds: [] };
  for (const groupId of groupIds) {
    await client.query('SELECT group_id FROM profile_groups WHERE group_id=$1 FOR UPDATE', [groupId]);
  }
  const revoked = await client.query(
    `UPDATE profile_group_api_keys
        SET state='REVOKED', revoked_at=now(), revoked_by=$3,
            revoked_by_issuer=$4, revoked_by_sub=$5
      WHERE api_key_id=$1 AND tenant_id=$2 AND state='ACTIVE'`,
    [apiKeyId, tenantId, actor.actor, actor.issuer ?? null, actor.sub ?? null],
  );
  for (const groupId of groupIds) {
    await client.query(
      'UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id=$1',
      [groupId],
    );
  }
  return { revoked: revoked.rowCount ?? 0, groupIds };
}

function grantWire(row: {
  api_key_id: string;
  prefix: string;
  status: string;
  granted_at: Date | string;
  granted_by: string | null;
}): ProfileGroupKeyGrant {
  return {
    apiKeyId: row.api_key_id,
    prefix: row.prefix,
    status: row.status,
    grantedAt: dateToIso(row.granted_at),
    ...(row.granted_by ? { grantedBy: row.granted_by } : {}),
  };
}

type GroupV2FunctionWire = ProfileGroupV2['businesses'][number]['functions'][number];
type GroupV2BusinessWire = {
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  functions: GroupV2FunctionWire[];
};

function toGroupV2Wire(
  root: GroupRootRow,
  revision: GroupRevisionRow,
  members: readonly GroupMemberRow[],
  grants: readonly ProfileGroupKeyGrant[],
): ProfileGroupV2 {
  const grouped = new Map<string, GroupV2BusinessWire>();
  for (const row of members) {
    if (Number(row.active_binding_revision) !== Number(row.binding_revision)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'profile group child pointer does not match its immutable snapshot');
    }
    const businessKey = JSON.stringify([row.business_id, row.business_version]);
    let business = grouped.get(businessKey);
    if (!business) {
      business = {
        businessId: row.business_id,
        businessVersion: row.business_version,
        manifestDigest: row.manifest_digest,
        functions: [],
      };
      grouped.set(businessKey, business);
    }
    business.functions.push({
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      ...(row.endpoint_slug ? { endpointSlug: row.endpoint_slug } : {}),
      ...(row.workflow_revision ? { workflowRevision: Number(row.workflow_revision) } : {}),
      manifestDigest: row.manifest_digest,
      childProfileId: row.profile_id,
      childRevision: Number(row.binding_revision),
      enabled: row.enabled !== false,
      policy: profileDetailPolicyRead(row as unknown as ProfileDetailDbRow),
      // A v1 revision has no defaults: `{}` is the real "none declared" value.
      requestDefaults: normalizeStoredRequestDefaults(row.request_defaults),
      connectorBindings: profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow),
    });
  }

  return {
    groupId: root.group_id,
    tenantId: root.tenant_id,
    name: revision.name,
    authMode: 'API_KEY',
    authAuthority: root.auth_authority,
    revision: Number(revision.revision),
    accessVersion: Number(root.access_version),
    businesses: [...grouped.values()],
    apiKeyGrants: [...grants],
    createdAt: dateToIso(root.created_at),
    updatedAt: dateToIso(root.updated_at),
  };
}

async function loadActiveGrants(
  client: GroupQueryable,
  groupId: string,
  tenantId: string,
): Promise<ProfileGroupKeyGrant[]> {
  const result = await client.query<{
    api_key_id: string;
    prefix: string;
    status: string;
    granted_at: Date | string;
    granted_by: string | null;
  }>(
    `SELECT g.api_key_id, k.prefix, k.status, g.granted_at, g.granted_by
       FROM profile_group_api_keys g
       JOIN api_keys k ON k.id=g.api_key_id AND k.tenant_id=g.tenant_id
      WHERE g.group_id=$1 AND g.tenant_id=$2 AND g.state='ACTIVE'
      ORDER BY g.granted_at, g.api_key_id`,
    [groupId, tenantId],
  );
  return result.rows.map(grantWire);
}

async function readGroupV2On(client: PoolClient, groupId: string, tenantId?: string): Promise<ProfileGroupV2> {
  const loaded = await loadActiveGroup(client, groupId, tenantId);
  const grants = await loadActiveGrants(client, groupId, loaded.root.tenant_id);
  return toGroupV2Wire(loaded.root, loaded.revision, loaded.members, grants);
}

/** Zero-key-safe v2 read. Never derives a key and never 409s on grant count. */
export async function getProfileGroupV2(
  db: Db,
  groupId: string,
  tenantId?: string,
): Promise<ProfileGroupV2> {
  return db.tx((client) => readGroupV2On(client, groupId, tenantId));
}

export async function listProfileGroupsV2(db: Db, tenantId: string): Promise<{ groups: ProfileGroupV2[] }> {
  return db.tx(async (client) => {
    const result = await client.query<{ group_id: string }>(
      'SELECT group_id FROM profile_groups WHERE tenant_id=$1 ORDER BY updated_at DESC, group_id',
      [tenantId],
    );
    const groups: ProfileGroupV2[] = [];
    for (const row of result.rows) {
      groups.push(await readGroupV2On(client, row.group_id, tenantId));
    }
    return { groups };
  });
}

/** v2 body → the internal member shape. Same rules as v1, minus the key. */
function normalizeRequestedFunctionsV2(
  businesses: ProfileGroupV2Save['businesses'],
): RequestedMember[] {
  return normalizeRequestedFunctions(
    businesses as unknown as readonly ProfileGroupBusinessInput[],
  );
}

/**
 * Create / full-replace a group-root configuration revision. No API key is
 * involved: the Admin actor is recorded on the revision, the tenant is the
 * locked group's tenant, and no `profile_api_keys` membership is ever created.
 */
export async function saveProfileGroupV2(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  input: ProfileGroupV2Save,
  groupId: string | null,
  actor: ProfileGroupActor,
  tenantScope?: string,
): Promise<ProfileGroupV2> {
  if (!actor || actor.actor.trim().length === 0) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'a profile group write requires an authenticated Admin actor');
  }
  const requestedMembers = normalizeRequestedFunctionsV2(input.businesses);
  let root: GroupRootRow | null = null;
  let currentMembers: GroupMemberRow[] = [];
  let id = groupId;
  if (id) {
    const loaded = await loadActiveGroup(client, id, tenantScope);
    if (loaded.root.auth_authority !== 'GROUP_GRANT') {
      // D-1: never auto-convert. A v2 config save must not be able to revoke a
      // cohort's child memberships as a side effect of being written.
      throw new HttpError(
        409,
        'PROFILE_GROUP_V2_REQUIRED',
        'this profile group still uses child-projection authority; run the conversion first',
      );
    }
    root = loaded.root;
    currentMembers = loaded.members;
    if (input.expectedRevision !== root.active_revision) {
      throw new HttpError(409, 'REVISION_CONFLICT', `expected profile group revision ${input.expectedRevision} but active revision is ${root.active_revision}`);
    }
    if (input.tenantId && input.tenantId !== root.tenant_id) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'profile group cannot move between tenants');
    }
  } else {
    if (input.expectedRevision !== 0) throw new HttpError(409, 'REVISION_CONFLICT', 'a new profile group must start at expectedRevision 0');
    if (!input.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required when creating a profile group');
    id = randomUUID();
  }

  const tenantId = root?.tenant_id ?? input.tenantId!;
  if (tenantScope && tenantScope !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'profile group is outside the caller tenant');
  await assertNameAvailable(client, tenantId, input.name, id);
  await profiles.lockSelectors([
    ...requestedMembers.map((member) => ({
      businessId: member.businessId,
      businessVersion: member.businessVersion,
      action: member.action,
      endpointSlug: member.endpointSlug,
    })),
    ...currentMembers.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
  ], client);
  // Business / version / selector locks precede any key row (there is none on
  // this path) — plan §"Transaction and lock order" item 7.
  await validateRequestedMembers(client, connectors, tenantId, requestedMembers, { requireWorkflowRevision: true });
  await assertNoAmbiguousBindings(client, id, tenantId, requestedMembers);

  const author: ChildAuthor = { kind: 'actor', actor, tenantId };

  if (!root) {
    const tenant = await client.query('SELECT id FROM tenants WHERE id=$1', [tenantId]);
    if (!tenant.rowCount) throw new HttpError(404, 'NOT_FOUND', 'profile group tenant was not found');
    // A v2 group starts GROUP_GRANT, including with zero keys (plan item 1).
    await client.query(
      `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision, auth_mode, auth_authority, access_version)
       VALUES ($1,$2,$3,0,'API_KEY','GROUP_GRANT',1)`,
      [id, tenantId, input.name],
    );
    root = {
      group_id: id,
      tenant_id: tenantId,
      name: input.name,
      active_revision: 0,
      auth_authority: 'GROUP_GRANT',
      access_version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  const revision = root.active_revision + 1;
  const members: MemberSnapshot[] = [];
  const requestedIds = new Set(requestedMembers.map(functionIdentity));
  for (const member of requestedMembers) {
    members.push(await createChildRevision(client, profiles, author, id, member));
  }

  const previousByIdentity = new Map<string, GroupMemberRow>();
  for (const row of currentMembers) {
    previousByIdentity.set(functionIdentity({
      businessId: row.business_id,
      businessVersion: row.business_version,
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      endpointSlug: row.endpoint_slug,
    }), row);
  }
  for (const [identity, row] of previousByIdentity) {
    if (!requestedIds.has(identity)) {
      await disableRemovedChild(client, profiles, author, id, row);
    }
  }

  // Deliberately NO `profile_api_keys` mutation and NO `access_version` bump:
  // config revisions must not move the grant clock (plan item 3).
  await insertGroupSnapshot(client, {
    groupId: id,
    revision,
    tenantId,
    name: input.name,
    apiKeyId: null,
    actor,
    members,
    expectedRevision: root.active_revision,
  });

  return readGroupV2On(client, id, tenantId);
}

/**
 * Config-only rollback: CAS the revision pointer, move the child pointers, and
 * touch neither the grant ledger nor `access_version`.
 */
export async function rollbackProfileGroupV2(
  client: PoolClient,
  profiles: ProfileService,
  connectors: ConnectorManagementStore | undefined,
  groupId: string,
  input: ProfileGroupRollback,
  actor: ProfileGroupActor,
  tenantScope?: string,
): Promise<ProfileGroupV2> {
  if (!actor || actor.actor.trim().length === 0) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'a profile group write requires an authenticated Admin actor');
  }
  const loaded = await loadActiveGroup(client, groupId, tenantScope);
  if (loaded.root.auth_authority !== 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'this profile group still uses child-projection authority; run the conversion first',
    );
  }
  if (loaded.root.active_revision !== input.expectedRevision) {
    throw new HttpError(409, 'REVISION_CONFLICT', `expected profile group revision ${input.expectedRevision} but active revision is ${loaded.root.active_revision}`);
  }
  const target = await loadTargetRevision(client, groupId, input.targetRevision, loaded.root.tenant_id);
  await profiles.lockSelectors([
    ...loaded.members.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
    ...target.members.map((member) => ({
      businessId: member.business_id,
      businessVersion: member.business_version,
      action: member.action,
      endpointSlug: member.endpoint_slug,
    })),
  ], client);

  const targetMembers = target.members.map((row): RequestedMember => ({
    businessId: row.business_id,
    businessVersion: row.business_version,
    manifestDigest: row.manifest_digest,
    kind: row.function_kind,
    functionId: row.function_id,
    action: row.action,
    endpointSlug: row.endpoint_slug,
    workflowRevision: row.workflow_revision === null ? null : Number(row.workflow_revision),
    policy: profileDetailPolicyRead(row as unknown as ProfileDetailDbRow),
    requestDefaults: normalizeStoredRequestDefaults(row.request_defaults),
    connectorBindings: profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow),
  }));
  await validateRequestedMembers(client, connectors, loaded.root.tenant_id, targetMembers, { requireWorkflowRevision: true });
  await assertNoAmbiguousBindings(client, groupId, loaded.root.tenant_id, targetMembers);

  const author: ChildAuthor = { kind: 'actor', actor, tenantId: loaded.root.tenant_id };
  const snapshots: MemberSnapshot[] = [];
  for (const row of target.members) {
    const pointer = await client.query<{ revision: number }>(
      'SELECT revision FROM profile_active_revisions WHERE profile_id=$1 FOR UPDATE',
      [row.profile_id],
    );
    const activeRevision = pointer.rows[0]?.revision;
    if (activeRevision === undefined) throw new HttpError(409, 'STATE_CONFLICT', 'target group child profile has no active revision pointer');
    if (Number(activeRevision) !== Number(row.active_binding_revision)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'target group child pointer changed while rollback was being prepared');
    }
    const targetBinding = await client.query(
      'SELECT 1 FROM profile_bindings WHERE profile_id=$1 AND revision=$2',
      [row.profile_id, row.binding_revision],
    );
    if (!targetBinding.rowCount) throw new HttpError(404, 'NOT_FOUND', 'target group child revision was not found');
    await pinActiveRevision(client, row.profile_id, Number(row.binding_revision));
    snapshots.push({
      businessId: row.business_id,
      businessVersion: row.business_version,
      manifestDigest: row.manifest_digest,
      kind: row.function_kind,
      functionId: row.function_id,
      action: row.action,
      endpointSlug: row.endpoint_slug,
      workflowRevision: row.workflow_revision === null ? null : Number(row.workflow_revision),
      profileId: row.profile_id,
      bindingRevision: Number(row.binding_revision),
    });
  }

  const targetIds = new Set(target.members.map((row) => row.profile_id));
  for (const row of loaded.members) {
    if (!targetIds.has(row.profile_id)) {
      await disableRemovedChild(client, profiles, author, groupId, row);
    }
  }

  await insertGroupSnapshot(client, {
    groupId,
    revision: loaded.root.active_revision + 1,
    tenantId: loaded.root.tenant_id,
    name: target.revision.name,
    apiKeyId: null,
    actor,
    members: snapshots,
    expectedRevision: loaded.root.active_revision,
  });

  return readGroupV2On(client, groupId, loaded.root.tenant_id);
}

async function lockGroupRoot(
  client: PoolClient,
  groupId: string,
  tenantScope?: string,
): Promise<GroupRootRow> {
  const result = await client.query<GroupRootRow>(
    `SELECT group_id, tenant_id, name, active_revision, auth_authority, access_version, created_at, updated_at
       FROM profile_groups WHERE group_id=$1${tenantScope ? ' AND tenant_id=$2' : ''}
       FOR UPDATE`,
    tenantScope ? [groupId, tenantScope] : [groupId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'profile group was not found');
  row.auth_authority = row.auth_authority === 'GROUP_GRANT' ? 'GROUP_GRANT' : 'CHILD_PROJECTION';
  row.access_version = Number(row.access_version);
  row.active_revision = Number(row.active_revision);
  return row;
}

async function bumpAccessVersion(
  client: PoolClient,
  groupId: string,
  expectedAccessVersion: number,
): Promise<number> {
  const updated = await client.query<{ access_version: string | number }>(
    `UPDATE profile_groups
        SET access_version = access_version + 1
      WHERE group_id=$1 AND access_version=$2
      RETURNING access_version`,
    [groupId, expectedAccessVersion],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new HttpError(412, 'PRECONDITION_FAILED', 'access version is stale; reload the group');
  }
  return Number(row.access_version);
}

const GRANT_SELECT = `SELECT g.api_key_id, k.prefix, k.status, g.granted_at, g.granted_by
   FROM profile_group_api_keys g JOIN api_keys k ON k.id=g.api_key_id`;

/**
 * Issue and grant one group-managed API key, atomically.
 *
 * The raw secret is returned exactly once. The caller (route) owns
 * `Cache-Control: no-store` and must store a REDACTED body in the idempotency
 * marker (D-5); this function never re-derives an existing secret.
 *
 * `tenantId` is returned for the audit ledger only and is never part of the
 * strict wire DTO.
 */
export async function issueGroupKey(
  client: PoolClient,
  deps: ProfileGroupGrantDeps,
  groupId: string,
  input: ProfileGroupKeyIssueInput,
  actor: ProfileGroupActor,
  expectedAccessVersion: number,
  tenantScope?: string,
): Promise<ProfileGroupKeyIssueResult & { tenantId: string }> {
  const root = await lockGroupRoot(client, groupId, tenantScope);
  if (root.auth_authority !== 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'root grants exist only for groups that use GROUP_GRANT authority',
    );
  }
  await bumpAccessVersion(client, groupId, expectedAccessVersion);

  const raw = (deps.mintRawKey ?? defaultMintRawKey)();
  const hash = deps.hashApiKey(raw);
  const keyId = randomUUID();
  const note = typeof input.note === 'string' && input.note.trim().length > 0 ? input.note.trim() : null;
  // The key is minted GROUP_MANAGED: its authority comes only from this grant.
  await client.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, name, status, version, key_mode)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,'GROUP_MANAGED')`,
    [keyId, root.tenant_id, hash, raw.slice(0, 4), note],
  );
  const existing = await client.query<{ group_id: string; state: string }>(
    'SELECT group_id, state FROM profile_group_api_keys WHERE api_key_id=$1 FOR UPDATE',
    [keyId],
  );
  const prior = existing.rows[0];
  if (prior && prior.group_id !== groupId) {
    // The primary key makes "one key id, one group, forever" structural.
    throw new HttpError(409, 'STATE_CONFLICT', 'this API key is permanently associated with another profile group');
  }
  if (prior) {
    await client.query(
      `UPDATE profile_group_api_keys
          SET state='ACTIVE', granted_at=now(), granted_by=$2, granted_by_issuer=$3, granted_by_sub=$4,
              revoked_at=NULL, revoked_by=NULL, revoked_by_issuer=NULL, revoked_by_sub=NULL
        WHERE api_key_id=$1`,
      [keyId, actor.actor, actor.issuer ?? null, actor.sub ?? null],
    );
  } else {
    await client.query(
      `INSERT INTO profile_group_api_keys
         (api_key_id, group_id, tenant_id, state, granted_by, granted_by_issuer, granted_by_sub)
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6)`,
      [keyId, groupId, root.tenant_id, actor.actor, actor.issuer ?? null, actor.sub ?? null],
    );
  }

  const granted = await client.query<{
    api_key_id: string;
    prefix: string;
    status: string;
    granted_at: Date | string;
    granted_by: string | null;
  }>(`${GRANT_SELECT} WHERE g.api_key_id=$1`, [keyId]);
  return {
    grant: grantWire(granted.rows[0]!),
    secret: raw,
    secretAvailable: true,
    tenantId: root.tenant_id,
  };
}

/**
 * Revoke ONE root grant. The API key's `status` is deliberately untouched: a
 * grant revoke must deny this group and nothing else (plan item 5).
 */
export async function revokeGroupGrant(
  client: PoolClient,
  groupId: string,
  apiKeyId: string,
  input: ProfileGroupKeyRevokeInput,
  actor: ProfileGroupActor,
  tenantScope?: string,
): Promise<ProfileGroupKeyRevokeResult & { tenantId: string }> {
  const root = await lockGroupRoot(client, groupId, tenantScope);
  if (root.auth_authority !== 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'root grants exist only for groups that use GROUP_GRANT authority',
    );
  }
  const accessVersion = await bumpAccessVersion(client, groupId, input.expectedAccessVersion);

  const current = await client.query<{
    api_key_id: string;
    prefix: string;
    status: string;
    state: string;
    granted_at: Date | string;
    granted_by: string | null;
  }>(
    `SELECT g.api_key_id, g.state, g.granted_at, g.granted_by, k.prefix, k.status
       FROM profile_group_api_keys g JOIN api_keys k ON k.id=g.api_key_id
      WHERE g.api_key_id=$1 AND g.group_id=$2 AND g.tenant_id=$3
      FOR UPDATE OF g`,
    [apiKeyId, groupId, root.tenant_id],
  );
  const row = current.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'this API key has no grant on the profile group');
  if (row.state !== 'ACTIVE') {
    throw new HttpError(409, 'STATE_CONFLICT', 'this API key grant is already revoked');
  }
  const revoked = await client.query<{ revoked_at: Date | string; revoked_by: string | null }>(
    `UPDATE profile_group_api_keys
        SET state='REVOKED', revoked_at=now(), revoked_by=$2,
            revoked_by_issuer=$3, revoked_by_sub=$4
      WHERE api_key_id=$1
      RETURNING revoked_at, revoked_by`,
    [apiKeyId, actor.actor, actor.issuer ?? null, actor.sub ?? null],
  );
  const tombstone: ProfileGroupRevokedKeyGrant = {
    ...grantWire(row),
    revokedAt: dateToIso(revoked.rows[0]!.revoked_at),
    ...(revoked.rows[0]!.revoked_by ? { revokedBy: revoked.rows[0]!.revoked_by } : {}),
  };
  return { grant: tombstone, accessVersion, tenantId: root.tenant_id };
}

/**
 * One-way cutover `CHILD_PROJECTION → GROUP_GRANT`.
 *
 * SERVICE ONLY — the plan defines no route for it, because conversion revokes
 * the children's child-projection memberships and therefore makes those
 * children unreachable through the legacy resolver. PC-09 invokes it only after
 * PC-05's root-grant resolver is deployed.
 *
 * Every proof runs before the first write; a failure returns `409
 * STATE_CONFLICT` naming the failed proof and leaves zero rows changed.
 */
export async function convertGroupToGrantAuthority(
  client: PoolClient,
  groupId: string,
  actor: ProfileGroupActor,
  tenantScope?: string,
): Promise<{
  groupId: string;
  previousAuthority: ProfileGroupAuthAuthority;
  authority: ProfileGroupAuthAuthority;
  accessVersion: number;
  grantedKeyId: string | null;
  revokedChildMemberships: number;
  alreadyConverted: boolean;
}> {
  const root = await lockGroupRoot(client, groupId, tenantScope);
  if (root.auth_authority === 'GROUP_GRANT') {
    const existing = await client.query<{ api_key_id: string }>(
      `SELECT api_key_id FROM profile_group_api_keys
        WHERE group_id=$1 AND state='ACTIVE' ORDER BY granted_at LIMIT 1`,
      [groupId],
    );
    return {
      groupId,
      previousAuthority: 'GROUP_GRANT',
      authority: 'GROUP_GRANT',
      accessVersion: Number(root.access_version),
      grantedKeyId: existing.rows[0]?.api_key_id ?? null,
      revokedChildMemberships: 0,
      alreadyConverted: true,
    };
  }
  const loaded = await loadActiveGroup(client, groupId, root.tenant_id);
  const children = [...new Set(loaded.members.map((member) => member.profile_id))];

  // D-4: the proof name travels in the contract's field-level channel because
  // `ProblemDetails` is frozen and has no free-form `check` property.
  const block = (check: string, detail: string): never => {
    throw new HttpError(409, 'STATE_CONFLICT', detail, {
      errors: [{ pointer: '/check', message: check }],
    });
  };

  // P1 — the derived candidate key, exactly as the v1 read path would pick it.
  let candidate: ApiKeyRow;
  try {
    candidate = await resolveCurrentGroupKey(client, loaded.root, loaded.revision, loaded.members);
  } catch {
    return block('P1_CANDIDATE_KEY', 'no single ACTIVE API key is a member of every current child');
  }
  if (candidate.tenant_id !== loaded.root.tenant_id) return block('P1_CANDIDATE_KEY', 'candidate key belongs to another tenant');
  if (candidate.status !== 'ACTIVE') return block('P1_CANDIDATE_KEY', 'candidate key is not ACTIVE');

  // P2 — every child holds exactly one ACTIVE membership and it is the candidate.
  const memberships = await client.query<{ profile_id: string; api_key_id: string }>(
    `SELECT profile_id, api_key_id FROM profile_api_keys
      WHERE profile_id = ANY($1::uuid[]) AND state='ACTIVE'`,
    [children.length === 0 ? [randomUUID()] : children],
  );
  for (const childId of children) {
    const rows = memberships.rows.filter((row) => row.profile_id === childId);
    if (rows.length !== 1 || rows[0]!.api_key_id !== candidate.id) {
      return block('P2_CHILD_MEMBERSHIP', 'a child does not hold exactly the candidate key as its single ACTIVE membership');
    }
  }

  // P3 — the candidate key is not active on any profile outside this group.
  const outside = await client.query<{ profile_id: string }>(
    `SELECT m.profile_id
       FROM profile_api_keys m
       LEFT JOIN profile_names n ON n.profile_id=m.profile_id
      WHERE m.api_key_id=$1 AND m.state='ACTIVE'
        AND (n.group_id IS NULL OR n.group_id <> $2)
      LIMIT 1`,
    [candidate.id, groupId],
  );
  if (outside.rowCount) return block('P3_SHARED_KEY', 'the candidate key is also active on a profile outside this group');

  // P4 — no other group's revision names the candidate key as its author.
  const foreignAuthor = await client.query<{ group_id: string }>(
    'SELECT group_id FROM profile_group_revisions WHERE api_key_id=$1 AND group_id <> $2 LIMIT 1',
    [candidate.id, groupId],
  );
  if (foreignAuthor.rowCount) return block('P4_FOREIGN_AUTHOR', 'the candidate key authored another group revision');

  // P5/P6 — ownership and pointer integrity for every child.
  const pointers = await client.query<{ profile_id: string; group_id: string | null; revision: number | null }>(
    `SELECT n.profile_id, n.group_id, a.revision
       FROM profile_names n
       LEFT JOIN profile_active_revisions a ON a.profile_id=n.profile_id
      WHERE n.profile_id = ANY($1::uuid[])`,
    [children.length === 0 ? [randomUUID()] : children],
  );
  for (const member of loaded.members) {
    const row = pointers.rows.find((candidateRow) => candidateRow.profile_id === member.profile_id);
    if (!row || row.group_id !== groupId) return block('P5_CHILD_OWNERSHIP', 'a group member is not owned by the group registry');
    if (Number(row.revision) !== Number(member.binding_revision)) {
      return block('P6_CHILD_POINTER', 'a child pointer does not match its pinned revision');
    }
  }

  // P7 — no in-flight operation is attached to a child.
  if (children.length > 0) {
    const inflight = await client.query<{ id: string }>(
      `SELECT id FROM operations
        WHERE profile_id = ANY($1::uuid[]) AND deleted_at IS NULL
          AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','EXPIRED')
        LIMIT 1`,
      [children],
    );
    if (inflight.rowCount) return block('P7_INFLIGHT_OPERATION', 'a child still has an in-flight operation');
  }

  // ---- writes --------------------------------------------------------------
  await client.query(
    `INSERT INTO profile_group_api_keys
       (api_key_id, group_id, tenant_id, state, granted_by, granted_by_issuer, granted_by_sub)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6)
     ON CONFLICT (api_key_id) DO UPDATE
       SET state='ACTIVE', granted_at=now(), granted_by=EXCLUDED.granted_by,
           granted_by_issuer=EXCLUDED.granted_by_issuer, granted_by_sub=EXCLUDED.granted_by_sub,
           revoked_at=NULL, revoked_by=NULL, revoked_by_issuer=NULL, revoked_by_sub=NULL
     WHERE profile_group_api_keys.group_id = EXCLUDED.group_id
       AND profile_group_api_keys.state = 'REVOKED'`,
    [candidate.id, groupId, loaded.root.tenant_id, actor.actor, actor.issuer ?? null, actor.sub ?? null],
  );
  const updated = await client.query<{ access_version: string | number }>(
    `UPDATE profile_groups SET auth_authority='GROUP_GRANT', access_version = access_version + 1
      WHERE group_id=$1 RETURNING access_version`,
    [groupId],
  );
  const revoked = children.length === 0
    ? { rowCount: 0 }
    : await client.query(
      `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
        WHERE profile_id = ANY($1::uuid[]) AND api_key_id=$2 AND state='ACTIVE'`,
      [children, candidate.id],
    );
  await client.query("UPDATE api_keys SET key_mode='GROUP_MANAGED' WHERE id=$1", [candidate.id]);

  return {
    groupId,
    previousAuthority: 'CHILD_PROJECTION',
    authority: 'GROUP_GRANT',
    accessVersion: Number(updated.rows[0]!.access_version),
    grantedKeyId: candidate.id,
    revokedChildMemberships: revoked.rowCount ?? 0,
    alreadyConverted: false,
  };
}
