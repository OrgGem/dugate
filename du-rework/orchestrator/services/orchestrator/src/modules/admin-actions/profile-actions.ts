import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  type ApiKeyRef,
  type ProfilePublishCommand,
  type ProfileRollbackCommand,
  type ProfileUpsertCommand,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { conflict, notFound, HttpError } from '../../http/errors';
import { createProfileRevisionService, isUnknownRevisionError } from '../profiles/publish';
import type { ProfileService } from '../profiles/profiles';
import { isActiveConnectorPin } from '../profiles/connector-pin-validation';

/**
 * P730-ADMIN-MUTATE / W3 (Δ7 ruling (A)) — the profile.* admin action leaf.
 *
 * The frozen `ProfileKey` (businessId, businessVersion, profileName) cannot
 * name a row: `profile_bindings` is keyed (profile_id, revision) and
 * `profile_id` is a random uuid per create. The new command schemas
 * (`@du/contracts` profile-commands) therefore carry an `apiKey` ref, and this
 * leaf resolves it — BEFORE any write — through the `profile_names` registry
 * (migration 0028), which maps
 * (tenant, api key, business, version, action, profile_name) -> profile_id
 * under a unique index (the race guard for concurrent first-saves).
 *
 * Everything here runs on the caller's OPEN transaction client: the dispatcher
 * wraps each runner in `auditedMutation`, so the registry row, the revision
 * row, its pointer move and the ledger row commit — or roll back — together
 * (T-AUD-01 / R3-01).
 *
 * Role policy: the three actions are ADMIN-ONLY (platform bearer / admin
 * cookie) for the same reason `apikey.*` is — they write admission policy.
 * `fence` is the dispatcher's tenant gate re-asserted with the SERVER-side
 * tenant of the resolved key; it runs before the first write, so a denied
 * caller leaves zero rows behind.
 */

interface ProfileActionDef {
  bearerRoles: Array<'platform' | 'tenant_operator'>;
  cookieRoles: Array<'admin' | 'operator' | 'viewer'>;
}

export const PROFILE_ACTIONS: Record<string, ProfileActionDef> = {
  'profile.upsert': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'profile.publish': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'profile.rollback': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
};

export interface ProfileActionDeps {
  db: Db;
  profiles: ProfileService;
  connectorManagement?: ConnectorManagementStore;
}

/** Dispatcher's tenant gate: throws HttpError on a foreign/denied tenant. */
export type ProfileFence = (tenantId: string) => void;

export interface ProfileMutationOutcome {
  profileId: string;
  revision: number;
  tenantId: string;
  /** PC-03: null when the revision was authored by an Admin actor, not a key. */
  apiKeyId: string | null;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  hash: string;
}

/**
 * Resolve the referenced API key to (id, tenant, hash) inside the tx. Only
 * ACTIVE keys answer; anything else is the same 404 — no existence oracle.
 */
async function resolveApiKey(client: PoolClient, ref: ApiKeyRef): Promise<ApiKeyRow> {
  const res =
    ref.kind === 'id'
      ? await client.query<ApiKeyRow>(
          'SELECT id, tenant_id, hash FROM api_keys WHERE id=$1 AND status=$2',
          [ref.id, 'ACTIVE']
        )
      : await client.query<ApiKeyRow>(
          'SELECT id, tenant_id, hash FROM api_keys WHERE hash=$1 AND status=$2',
          [ref.hash, 'ACTIVE']
        );
  if (res.rows.length === 0) throw notFound('api key not found or not ACTIVE');
  return res.rows[0]!;
}

async function resolveProfileByName(
  client: PoolClient,
  key: ApiKeyRow,
  businessId: string,
  businessVersion: string,
  action: string,
  profileName: string
): Promise<string | null> {
  const res = await client.query<{ profile_id: string }>(
    `SELECT n.profile_id FROM profile_names n
      LEFT JOIN profile_api_keys m ON m.profile_id=n.profile_id AND m.api_key_id=$2
        AND m.tenant_id=$1 AND m.state='ACTIVE'
      WHERE n.tenant_id=$1 AND (n.api_key_id=$2 OR m.profile_id IS NOT NULL)
        AND n.business_id=$3 AND n.business_version=$4
        AND n.action=$5 AND n.profile_name=$6
      ORDER BY n.profile_id
      LIMIT 2`,
    [key.tenant_id, key.id, businessId, businessVersion, action, profileName]
  );
  if (res.rows.length > 1) throw conflict('STATE_CONFLICT', 'multiple profiles match this API key and named function');
  return res.rows.length > 0 ? res.rows[0]!.profile_id : null;
}

/**
 * PC-03 compatibility firewall — resolve the registry identity ACROSS BOTH
 * SCOPES before any key-scoped work.
 *
 * `resolveProfileByName` below is deliberately key-scoped: it only matches a
 * row whose `api_key_id` is the caller's key or which has an ACTIVE membership.
 * A converted group child has neither, so a key-scoped lookup misses it and
 * `profile.upsert` would fall through to `ensureProfileId`, minting a SECOND
 * standalone registry row under the same name (the "shadow-profile fork").
 *
 * This guard runs first and refuses the mutation for any group-owned identity:
 *   * `GROUP_GRANT`      ⇒ 409 PROFILE_GROUP_V2_REQUIRED
 *   * `CHILD_PROJECTION` ⇒ 409 STATE_CONFLICT (today's wording, unchanged)
 */
async function assertProfileIdentityNotGroupOwned(
  client: PoolClient,
  tenantId: string,
  businessId: string,
  businessVersion: string,
  action: string,
  profileName: string,
): Promise<void> {
  const rows = await client.query<{ group_id: string | null; auth_authority: string | null }>(
    `SELECT n.group_id, g.auth_authority
       FROM profile_names n
       LEFT JOIN profile_groups g ON g.group_id = n.group_id
      WHERE n.tenant_id=$1 AND n.business_id=$2 AND n.business_version=$3
        AND n.action=$4 AND n.profile_name=$5
        AND n.group_id IS NOT NULL
      LIMIT 1`,
    [tenantId, businessId, businessVersion, action, profileName],
  );
  const grouped = rows.rows[0];
  if (!grouped) return;
  if (grouped.auth_authority === 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'this profile is owned by a profile group that uses root grants; edit it through the profile group',
    );
  }
  throw new HttpError(409, 'STATE_CONFLICT', 'this profile is owned by a profile group; edit it through the profile group');
}

/**
 * Find-or-register the profile_id for a name. The INSERT relies on the unique
 * index: a concurrent creator loses the race, sees zero rows inserted and
 * re-reads the winner's row (READ COMMITTED sees it after the conflict
 * resolution) instead of minting a second profile_id.
 */
async function ensureProfileId(
  client: PoolClient,
  key: ApiKeyRow,
  identity: {
    businessId: string;
    businessVersion: string;
    action: string;
    profileName: string;
  }
): Promise<{ profileId: string; created: boolean }> {
  const existing = await resolveProfileByName(
    client,
    key,
    identity.businessId,
    identity.businessVersion,
    identity.action,
    identity.profileName
  );
  if (existing) return { profileId: existing, created: false };

  const profileId = randomUUID();
  const inserted = await client.query(
    `INSERT INTO profile_names
       (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      profileId,
      key.tenant_id,
      key.id,
      identity.businessId,
      identity.businessVersion,
      identity.action,
      identity.profileName,
    ]
  );
  // INSERT ... ON CONFLICT DO NOTHING has no RETURNING rows. PostgreSQL's
  // rowCount may be null for commands without a command tag, so only an
  // explicit single inserted row establishes ownership here.
  if (inserted.rowCount === 1) return { profileId, created: true };

  const raced = await resolveProfileByName(
    client,
    key,
    identity.businessId,
    identity.businessVersion,
    identity.action,
    identity.profileName
  );
  if (raced) return { profileId: raced, created: false };
  throw conflict('STATE_CONFLICT', 'profile name is being created concurrently; retry');
}

/**
 * CAS for upsert. `expectedRevision` (when supplied) must equal the ACTIVE
 * revision the pointer holds; the pointer row is locked FOR UPDATE so two
 * concurrent upserts of one profile serialize here instead of both reading
 * the same "current". A brand-new profile has no pointer yet and may only be
 * created by a blind save (absent expectedRevision) or expectedRevision 0 —
 * the R-12 "first save" rule.
 */
async function assertUpsertCas(
  client: PoolClient,
  profileId: string,
  created: boolean,
  expectedRevision: number | undefined
): Promise<void> {
  const current = await client.query<{ revision: number }>(
    'SELECT revision FROM profile_active_revisions WHERE profile_id=$1 FOR UPDATE',
    [profileId]
  );
  const actual = current.rows.length > 0 ? current.rows[0]!.revision : null;
  if (created) {
    if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw conflict(
        'REVISION_CONFLICT',
        `expected active revision ${expectedRevision} but the profile is at no revision`
      );
    }
    return;
  }
  if (expectedRevision !== undefined && actual !== expectedRevision) {
    throw conflict(
      'REVISION_CONFLICT',
      `expected active revision ${expectedRevision} but the profile is at ` +
        `${actual === null ? 'no revision' : actual}`
    );
  }
}

export async function runProfileUpsert(
  client: PoolClient,
  deps: ProfileActionDeps,
  cmd: ProfileUpsertCommand,
  fence: ProfileFence
): Promise<ProfileMutationOutcome> {
  const candidate = await resolveApiKey(client, cmd.apiKey);
  fence(candidate.tenant_id);

  const action = cmd.action ?? cmd.profileName;
  // PC-03: refuse a group-owned identity BEFORE `ensureProfileId` can fork one.
  await assertProfileIdentityNotGroupOwned(
    client, candidate.tenant_id, cmd.businessId, cmd.businessVersion, action, cmd.profileName,
  );
  const existingProfileId = await resolveProfileByName(
    client, candidate, cmd.businessId, cmd.businessVersion, action, cmd.profileName,
  );
  const mutationLocks = await deps.profiles.lockProfileMutation(existingProfileId ?? null, [
    { businessId: cmd.businessId, businessVersion: cmd.businessVersion, action, endpointSlug: cmd.endpointSlug },
  ], [candidate.id], client);
  if (existingProfileId && !mutationLocks.memberships.some((membership) => membership.apiKeyId === candidate.id)) {
    throw notFound('profile not found for this api key');
  }
  const lockedKey = mutationLocks.keys.get(candidate.id);
  if (!lockedKey || lockedKey.status !== 'ACTIVE' || lockedKey.hash !== candidate.hash || lockedKey.tenant_id !== candidate.tenant_id) {
    throw notFound('api key not found or not ACTIVE');
  }
  const key: ApiKeyRow = { id: lockedKey.id, tenant_id: lockedKey.tenant_id, hash: lockedKey.hash };
  fence(key.tenant_id);

  if(cmd.connectorBindings && Object.keys(cmd.connectorBindings).length) {
    if(!deps.connectorManagement) throw new HttpError(503,'TEMPORARY_UNAVAILABLE','connector management is required to validate explicit profile pins');
    for(const pin of Object.values(cmd.connectorBindings)) {
      if(!await isActiveConnectorPin(deps.connectorManagement, key.tenant_id, pin)) throw new HttpError(422,'INVALID_SCHEMA','connector revision is not ACTIVE or available in this tenant');
    }
  }

  const { profileId, created } = await ensureProfileId(client, key, {
    businessId: cmd.businessId,
    businessVersion: cmd.businessVersion,
    action,
    profileName: cmd.profileName,
  });
  await assertProfileNotGroupOwned(client, profileId);
  await assertUpsertCas(client, profileId, created, cmd.expectedRevision);

  const currentPins = cmd.connectorBindings === undefined && !created ? await client.query('SELECT p.connector_bindings FROM profile_active_revisions a JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision WHERE a.profile_id=$1',[profileId]) : undefined;
  return deps.profiles.createRevision(
    {
      profileId,
      apiKeyHash: key.hash,
      businessId: cmd.businessId,
      businessVersion: cmd.businessVersion,
      action,
      connectorBindings: cmd.connectorBindings ?? currentPins?.rows[0]?.connector_bindings ?? {},
      endpointSlug: cmd.endpointSlug,
      policy: cmd.policy as Record<string, unknown>,
    },
    client
  );
}

async function resolveExistingProfile(
  client: PoolClient,
  key: ApiKeyRow,
  cmd: { businessId: string; businessVersion: string; profileName: string; action?: string }
): Promise<string> {
  const action = cmd.action ?? cmd.profileName;
  const profileId = await resolveProfileByName(
    client,
    key,
    cmd.businessId,
    cmd.businessVersion,
    action,
    cmd.profileName
  );
  if (!profileId) throw notFound('profile not found for this api key');
  return profileId;
}

/** Internal children are edited through their owning aggregate only. */
async function assertProfileNotGroupOwned(client: PoolClient, profileId: string): Promise<void> {
  // Shape kept from the pre-PC-03 guard; the authority lookup is an additional
  // read that only runs once a group actually owns the profile.
  const result = await client.query<{ group_id: string | null }>(
    'SELECT group_id FROM profile_names WHERE profile_id=$1 FOR UPDATE',
    [profileId],
  );
  const groupId = result.rows[0]?.group_id;
  if (!groupId) return;
  const authority = await client.query<{ auth_authority: string | null }>(
    'SELECT auth_authority FROM profile_groups WHERE group_id=$1',
    [groupId],
  );
  if (authority.rows[0]?.auth_authority === 'GROUP_GRANT') {
    throw new HttpError(
      409,
      'PROFILE_GROUP_V2_REQUIRED',
      'this profile is owned by a profile group that uses root grants; edit it through the profile group',
    );
  }
  throw new HttpError(409, 'STATE_CONFLICT', 'this profile is owned by a profile group; edit it through the profile group');
}

export async function runProfilePublish(
  client: PoolClient,
  deps: ProfileActionDeps,
  cmd: ProfilePublishCommand,
  fence: ProfileFence
): Promise<ProfileMutationOutcome> {
  const candidate = await resolveApiKey(client, cmd.apiKey);
  fence(candidate.tenant_id);
  const publishAction = cmd.action ?? cmd.profileName;
  await assertProfileIdentityNotGroupOwned(
    client, candidate.tenant_id, cmd.businessId, cmd.businessVersion, publishAction, cmd.profileName,
  );
  const profileId = await resolveExistingProfile(client, candidate, cmd);
  const target = await deps.profiles.getLatestRevisionSelector(profileId, client);
  if (!target) throw notFound('profile has no revisions to activate');
  const mutationLocks = await deps.profiles.lockProfileMutation(profileId, [target.selector], [candidate.id], client);
  if (!mutationLocks.memberships.some((membership) => membership.apiKeyId === candidate.id)) {
    throw notFound('profile not found for this api key');
  }
  const lockedKey = mutationLocks.keys.get(candidate.id);
  if (!lockedKey || lockedKey.status !== 'ACTIVE' || lockedKey.hash !== candidate.hash || lockedKey.tenant_id !== candidate.tenant_id) {
    throw notFound('api key not found or not ACTIVE');
  }
  const key: ApiKeyRow = { id: lockedKey.id, tenant_id: lockedKey.tenant_id, hash: lockedKey.hash };
  fence(key.tenant_id);
  const currentSelector = mutationLocks.activeSelector;
  if (!currentSelector) throw notFound('profile has no active binding selector');
  const currentTarget = await deps.profiles.getLatestRevisionSelector(profileId, client);
  if (!currentTarget || currentTarget.revision !== target.revision || JSON.stringify(currentTarget.selector) !== JSON.stringify(target.selector)) {
    throw conflict('STATE_CONFLICT', 'profile publish target changed while the revision was being prepared; retry');
  }
  await assertProfileNotGroupOwned(client, profileId);
  await deps.profiles.assertSelectorAvailableForMemberships({
    apiKeyIds: [...mutationLocks.memberships.map((membership) => membership.apiKeyId), key.id],
    ...target.selector,
    profileId,
  }, client);
  const revisions = createProfileRevisionService(deps.db);
  const revision = await revisions.publishRevision(
    { profileId, expectedRevision: cmd.expectedRevision },
    client
  );
  return { profileId, revision, tenantId: key.tenant_id, apiKeyId: key.id };
}

export async function runProfileRollback(
  client: PoolClient,
  deps: ProfileActionDeps,
  cmd: ProfileRollbackCommand,
  fence: ProfileFence
): Promise<ProfileMutationOutcome> {
  const candidate = await resolveApiKey(client, cmd.apiKey);
  fence(candidate.tenant_id);
  const rollbackAction = cmd.action ?? cmd.profileName;
  await assertProfileIdentityNotGroupOwned(
    client, candidate.tenant_id, cmd.businessId, cmd.businessVersion, rollbackAction, cmd.profileName,
  );
  const profileId = await resolveExistingProfile(client, candidate, cmd);
  const targetSelector = await deps.profiles.getRevisionSelector(profileId, cmd.targetRevision, client);
  if (!targetSelector) throw notFound('rollback target revision does not exist for this profile');
  const mutationLocks = await deps.profiles.lockProfileMutation(profileId, [targetSelector], [candidate.id], client);
  if (!mutationLocks.memberships.some((membership) => membership.apiKeyId === candidate.id)) {
    throw notFound('profile not found for this api key');
  }
  const lockedKey = mutationLocks.keys.get(candidate.id);
  if (!lockedKey || lockedKey.status !== 'ACTIVE' || lockedKey.hash !== candidate.hash || lockedKey.tenant_id !== candidate.tenant_id) {
    throw notFound('api key not found or not ACTIVE');
  }
  const key: ApiKeyRow = { id: lockedKey.id, tenant_id: lockedKey.tenant_id, hash: lockedKey.hash };
  fence(key.tenant_id);
  if (!mutationLocks.activeSelector) throw notFound('profile has no active binding selector');
  const currentTargetSelector = await deps.profiles.getRevisionSelector(profileId, cmd.targetRevision, client);
  if (!currentTargetSelector || JSON.stringify(currentTargetSelector) !== JSON.stringify(targetSelector)) {
    throw conflict('STATE_CONFLICT', 'profile rollback target changed while the revision was being prepared; retry');
  }
  await assertProfileNotGroupOwned(client, profileId);
  await deps.profiles.assertSelectorAvailableForMemberships({
    apiKeyIds: [...mutationLocks.memberships.map((membership) => membership.apiKeyId), key.id],
    ...targetSelector,
    profileId,
  }, client);
  const revisions = createProfileRevisionService(deps.db);
  try {
    const revision = await revisions.rollbackTo(
      {
        profileId,
        targetRevision: cmd.targetRevision,
        ...(cmd.expectedRevision !== undefined ? { expectedRevision: cmd.expectedRevision } : {}),
      },
      client
    );
    return { profileId, revision, tenantId: key.tenant_id, apiKeyId: key.id };
  } catch (err) {
    // Composite-FK 23503: the (profile_id, targetRevision) pair does not
    // exist. A bad rollback TARGET is a 404, not a 500.
    if (isUnknownRevisionError(err)) {
      throw notFound('rollback target revision does not exist for this profile');
    }
    throw err;
  }
}
