import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  type ApiKeyRef,
  type ProfilePublishCommand,
  type ProfileRollbackCommand,
  type ProfileUpsertCommand,
} from '@du/contracts';
import type { Db } from '../../db/db';
import { conflict, notFound } from '../../http/errors';
import { createProfileRevisionService, isUnknownRevisionError } from '../profiles/publish';
import type { ProfileService } from '../profiles/profiles';

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
}

/** Dispatcher's tenant gate: throws HttpError on a foreign/denied tenant. */
export type ProfileFence = (tenantId: string) => void;

export interface ProfileMutationOutcome {
  profileId: string;
  revision: number;
  tenantId: string;
  apiKeyId: string;
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
  if (!res.rowCount) throw notFound('api key not found or not ACTIVE');
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
    `SELECT profile_id FROM profile_names
      WHERE tenant_id=$1 AND api_key_id=$2 AND business_id=$3 AND business_version=$4
        AND action=$5 AND profile_name=$6`,
    [key.tenant_id, key.id, businessId, businessVersion, action, profileName]
  );
  return res.rowCount ? res.rows[0]!.profile_id : null;
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
  if (inserted.rowCount) return { profileId, created: true };

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
  const actual = current.rowCount ? current.rows[0]!.revision : null;
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
  const key = await resolveApiKey(client, cmd.apiKey);
  fence(key.tenant_id);

  const action = cmd.action ?? cmd.profileName;
  const { profileId, created } = await ensureProfileId(client, key, {
    businessId: cmd.businessId,
    businessVersion: cmd.businessVersion,
    action,
    profileName: cmd.profileName,
  });
  await assertUpsertCas(client, profileId, created, cmd.expectedRevision);

  return deps.profiles.createRevision(
    {
      profileId,
      apiKeyHash: key.hash,
      businessId: cmd.businessId,
      businessVersion: cmd.businessVersion,
      action,
      connectorBindings: {},
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

export async function runProfilePublish(
  client: PoolClient,
  deps: ProfileActionDeps,
  cmd: ProfilePublishCommand,
  fence: ProfileFence
): Promise<ProfileMutationOutcome> {
  const key = await resolveApiKey(client, cmd.apiKey);
  fence(key.tenant_id);
  const profileId = await resolveExistingProfile(client, key, cmd);
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
  const key = await resolveApiKey(client, cmd.apiKey);
  fence(key.tenant_id);
  const profileId = await resolveExistingProfile(client, key, cmd);
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
