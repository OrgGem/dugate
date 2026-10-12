import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  type ProfileGroup,
  type ProfileGroupBusiness,
  type ProfileGroupBusinessInput,
  type ProfileGroupFunctionBinding,
  type ProfileGroupFunctionInput,
  type ProfileGroupRollback,
  type ProfileGroupSave,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { profileDetailConnectorBindingsRead, profileDetailPolicyRead, type ProfileDetailDbRow } from '../admin-read/profile-detail';
import { getBusinessFunctionCatalog } from '../admin-read/business-functions';
import { dateToIso } from '../admin-read/keyset';
import type { ProfileService } from './profiles';
import { pinActiveRevision } from './publish';

interface GroupRootRow extends QueryResultRow {
  group_id: string;
  tenant_id: string;
  name: string;
  active_revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GroupRevisionRow extends QueryResultRow {
  group_id: string;
  revision: number;
  tenant_id: string;
  name: string;
  api_key_id: string;
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
    const connector = await connectors.getRevision(pin.connectorId, pin.revision);
    if (!connector || connector.state !== 'ACTIVE' || (connector.tenantId && connector.tenantId !== tenantId)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'connector revision is not ACTIVE or available in this tenant');
    }
  }
}

async function validateRequestedMembers(
  client: PoolClient,
  connectors: ConnectorManagementStore | undefined,
  tenantId: string,
  members: readonly RequestedMember[],
): Promise<void> {
  const catalogs = new Map<string, Awaited<ReturnType<typeof getBusinessFunctionCatalog>>>();
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
    if (member.workflowRevision !== null) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'workflowRevision is not supported for manifest action functions');
    }
    await validateConnectorPins(connectors, tenantId, descriptor.connectorSlots, member.connectorBindings);
  }
}

async function assertNoAmbiguousBindings(
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
            b.callback_policy, b.allowed_origins, b.connector_bindings
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

async function readGroupOn(client: PoolClient, groupId: string, tenantId?: string): Promise<ProfileGroup> {
  const loaded = await loadActiveGroup(client, groupId, tenantId);
  const apiKey = await resolveCurrentGroupKey(client, loaded.root, loaded.revision, loaded.members);
  return toGroupWire(loaded.root, loaded.revision, apiKey, loaded.members);
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
            b.callback_policy, b.allowed_origins, b.connector_bindings
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

async function createChildRevision(
  client: PoolClient,
  profiles: ProfileService,
  key: ApiKeyRow,
  tenantId: string,
  groupId: string,
  member: RequestedMember,
): Promise<MemberSnapshot> {
  const existing = await lookupChildProfile(client, groupId, tenantId, member);
  const profileId = existing?.profileId ?? randomUUID();
  const profileName = existing?.profileName ?? childProfileName(groupId, member);
  if (!existing) {
    await client.query(
      `INSERT INTO profile_names
         (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [profileId, tenantId, key.id, member.businessId, member.businessVersion, member.action, profileName, groupId],
    );
  } else {
    await client.query(
      'UPDATE profile_names SET api_key_id=$2 WHERE profile_id=$1 AND group_id=$3',
      [profileId, key.id, groupId],
    );
  }
  const created = await profiles.createGroupChildRevision({
    profileId,
    apiKeyHash: key.hash,
    businessId: member.businessId,
    businessVersion: member.businessVersion,
    action: member.action,
    connectorBindings: member.connectorBindings,
    ...(member.endpointSlug ? { endpointSlug: member.endpointSlug } : {}),
    policy: member.policy,
  }, groupId, client);
  await profiles.addMembership({ profileId, apiKeyId: key.id, tenantId }, client);
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
  key: ApiKeyRow,
  tenantId: string,
  groupId: string,
  row: GroupMemberRow,
): Promise<void> {
  const existingPolicy = profileDetailPolicyRead(row as unknown as ProfileDetailDbRow);
  const connectorBindings = profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow);
  await client.query('UPDATE profile_names SET api_key_id=$2 WHERE profile_id=$1 AND group_id=$3', [row.profile_id, key.id, groupId]);
  await profiles.createGroupChildRevision({
    profileId: row.profile_id,
    apiKeyHash: key.hash,
    businessId: row.business_id,
    businessVersion: row.business_version,
    action: row.action,
    connectorBindings,
    ...(row.endpoint_slug ? { endpointSlug: row.endpoint_slug } : {}),
    policy: { ...existingPolicy, enabled: false },
  }, groupId, client);
  // This is a profile-wide revocation, while ProfileService.revokeMemberships
  // takes an API-key id. Query by profile id directly to avoid leaving the
  // removed child active under its selected key (or revoking an unrelated key
  // whose id happens to equal the child id).
  await client.query(
    `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
      WHERE profile_id=$1 AND state='ACTIVE'`,
    [row.profile_id],
  );
}

async function insertGroupSnapshot(
  client: PoolClient,
  input: {
    groupId: string;
    revision: number;
    tenantId: string;
    name: string;
    apiKeyId: string;
    members: readonly MemberSnapshot[];
    expectedRevision: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.groupId, input.revision, input.tenantId, input.name, input.apiKeyId],
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
  const key = await loadSelectedKey(client, input.apiKey.apiKeyId);
  if (key.tenant_id !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'selected API key is outside the profile group tenant');

  await validateRequestedMembers(client, connectors, tenantId, requestedMembers);
  await assertNoAmbiguousBindings(client, key.id, id, requestedMembers);

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
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  const revision = root.active_revision + 1;
  const members: MemberSnapshot[] = [];
  const requestedIds = new Set(requestedMembers.map(functionIdentity));
  for (const member of requestedMembers) {
    members.push(await createChildRevision(client, profiles, key, tenantId, id, member));
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
      await disableRemovedChild(client, profiles, key, tenantId, id, row);
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
    connectorBindings: profileDetailConnectorBindingsRead(row as unknown as ProfileDetailDbRow),
  }));
  await validateRequestedMembers(client, connectors, current.root.tenant_id, targetMembers);
  await assertNoAmbiguousBindings(client, key.id, groupId, targetMembers);

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
      await disableRemovedChild(client, profiles, key, current.root.tenant_id, groupId, row);
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
