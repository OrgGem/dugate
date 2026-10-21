import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  WIRE_CONTRACT_VERSION,
  hashManifest,
  type ActionManifest,
  type BusinessManifest,
} from '@du/contracts';
import type { Db } from '../../src/db/db';

/**
 * PC-09 profile-control-plane harness.
 *
 * Seeds the cohorts the verification matrix needs — without a Connector, a
 * provider, Redis or an app boot — so a suite can assert *admission semantics*
 * instead of plumbing.
 *
 * Why a synthetic business: the shared runtime fixture registers a single
 * `extract` action with a **required** connector slot, so every cell of a
 * six-endpoint matrix would drag a connector pin into what is really a
 * profile/authorization test. `pc09-core` declares the six gateway actions with
 * `connectorSlots: []`, which makes admission deterministic and provider-free.
 *
 * Two immutable versions exist on purpose:
 *   - `1.0.0` has no `parameterResolution`  → v1 merge semantics
 *   - `2.0.0` declares the capability       → partitioned sources
 * so the same matrix can prove "absence means v1 exactly" next to the opt-in
 * behaviour, on the same database, without rewriting a registered manifest.
 *
 * Cohort shapes (see `prep-pc09-cutover-spec.md` §3.1):
 *
 *   A  legacy standalone profile   LEGACY_STANDALONE   no group, ACTIVE membership
 *   B  unmanaged legacy key        UNMANAGED_LEGACY    no profile at all
 *   C1 group pre-cutover           LEGACY_STANDALONE   CHILD_PROJECTION, memberships
 *   C2 group post-cutover          GROUP_MANAGED       GROUP_GRANT, grant, NO membership
 *   C3 illegal mix (defensive)     GROUP_MANAGED       CHILD_PROJECTION + membership
 *   D  multi-key group             GROUP_MANAGED       GROUP_GRANT, >=2 grants
 *
 * Every builder runs in one transaction because `profile_groups.active_revision`
 * is a DEFERRABLE FK: the group row must exist before its first revision does.
 */

export const PC09_BUSINESS = 'pc09-core';
export const PC09_VERSION_V1 = '1.0.0';
export const PC09_VERSION_V2 = '2.0.0';
export const PC09_ACTIONS = [
  'ingest',
  'extract',
  'analyze',
  'transform',
  'generate',
  'compare',
] as const;

export type Pc09Action = (typeof PC09_ACTIONS)[number];
export type Pc09CohortKind = 'A' | 'B' | 'C1' | 'C2' | 'C3' | 'D';
export type Pc09KeyMode = 'LEGACY_STANDALONE' | 'UNMANAGED_LEGACY' | 'GROUP_MANAGED';
export type Pc09AuthAuthority = 'CHILD_PROJECTION' | 'GROUP_GRANT';

const HARNESS_ACTOR = 'pc09-harness';

/** The immutable function identity used for every seeded action. */
export function pc09FunctionId(action: Pc09Action | string): string {
  return `${action}.default`;
}

/** The immutable endpoint selector used for every seeded action. */
export function pc09EndpointSlug(action: Pc09Action | string): string {
  return `${action}:default`;
}

/**
 * Per-action schemas.
 *
 * `mode` and `enableReasoning` are `requestDefaults`; `maxParallel` and
 * `reviewDepth` are `profileSettings`; `enableReasoning` is the **intentional
 * overlap** (declared by both schemas) that the capability must resolve to one
 * source instead of inferring. `reviewDepth` carries `defaultLocked: true` so the
 * `explicit ?? schema.defaultLocked ?? false` normalization is exercised.
 */
function buildAction(name: Pc09Action, withCapability: boolean): ActionManifest {
  const action: ActionManifest = {
    name,
    displayName: `PC-09 ${name}`,
    description: 'Connector-free harness action for profile control plane admission tests.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', default: 'standard' },
        enableReasoning: { type: 'boolean' },
        note: { type: 'string' },
      },
      additionalProperties: true,
    },
    outputSchema: { type: 'object' },
    profileSchema: {
      type: 'object',
      properties: {
        maxParallel: { type: 'integer', minimum: 1, maximum: 8 },
        reviewDepth: { type: 'string', defaultLocked: true },
      },
      additionalProperties: false,
    },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 10 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: { timeoutSeconds: 60 },
  };
  if (!withCapability) return action;
  return {
    ...action,
    parameterResolution: {
      version: 2,
      fields: {
        mode: 'requestDefaults',
        enableReasoning: 'requestDefaults',
        maxParallel: 'profileSettings',
        reviewDepth: 'profileSettings',
      },
      applyTopLevelDefaults: true,
    },
  };
}

function buildManifest(version: string, withCapability: boolean): BusinessManifest {
  return {
    contractVersion: WIRE_CONTRACT_VERSION,
    businessId: PC09_BUSINESS,
    version,
    displayName: 'PC-09 Harness Business',
    description: 'Connector-free six-action business used by the profile control plane matrix.',
    imageDigest: `sha256:pc09-harness-${withCapability ? 'v2' : 'v1'}`,
    runtime: { wireVersion: '1', handlerKinds: [...PC09_ACTIONS, 'root'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: PC09_ACTIONS.map((action) => buildAction(action, withCapability)),
  };
}

export const PC09_MANIFEST_V1: BusinessManifest = buildManifest(PC09_VERSION_V1, false);
export const PC09_MANIFEST_V2: BusinessManifest = buildManifest(PC09_VERSION_V2, true);
export const PC09_MANIFEST_DIGEST_V1 = hashManifest(PC09_MANIFEST_V1);
export const PC09_MANIFEST_DIGEST_V2 = hashManifest(PC09_MANIFEST_V2);

/** The manifest + digest that matches a seeded business version. */
export function pc09ManifestFor(version: string): { manifest: BusinessManifest; digest: string } {
  if (version === PC09_VERSION_V1) {
    return { manifest: PC09_MANIFEST_V1, digest: PC09_MANIFEST_DIGEST_V1 };
  }
  if (version === PC09_VERSION_V2) {
    return { manifest: PC09_MANIFEST_V2, digest: PC09_MANIFEST_DIGEST_V2 };
  }
  throw new Error(`pc09ManifestFor: unknown harness version "${version}"`);
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                      */
/* ------------------------------------------------------------------ */

export interface Pc09Key {
  apiKeyId: string;
  /** The only place the raw key exists; the database stores only its sha256. */
  rawApiKey: string;
  keyMode: Pc09KeyMode;
}

export interface Pc09ChildPin {
  action: Pc09Action;
  functionId: string;
  endpointSlug: string;
  profileId: string;
  revision: number;
}

export interface Pc09Cohort {
  kind: Pc09CohortKind;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  keys: Pc09Key[];
  /** One pin per seeded action; empty for cohort B. */
  children: Pc09ChildPin[];
  groupId?: string;
  groupRevision?: number;
  accessVersion?: number;
  authAuthority?: Pc09AuthAuthority;
}

export interface Pc09CohortInput {
  tenantId: string;
  /** Defaults to every action; pass a subset to keep a suite fast. */
  actions?: readonly Pc09Action[];
  businessVersion?: string;
}

export interface Pc09BusinessSeed {
  businessId: string;
  activeVersion: string;
  versions: readonly { version: string; digest: string }[];
}

function actionsOf(input: Pc09CohortInput): readonly Pc09Action[] {
  const actions = input.actions ?? PC09_ACTIONS;
  if (actions.length === 0) throw new Error('pc09 cohort: at least one action is required');
  return actions;
}

function versionOf(input: Pc09CohortInput): string {
  return input.businessVersion ?? PC09_VERSION_V1;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function hashRawKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* Business registration                                              */
/* ------------------------------------------------------------------ */

/**
 * Register `pc09-core` with both immutable versions and make one of them the
 * active version. Idempotent: re-seeding the same database updates availability
 * and the active pointer without duplicating rows.
 */
export async function seedPc09Business(
  db: Db,
  options: { activeVersion?: string } = {},
): Promise<Pc09BusinessSeed> {
  const activeVersion = options.activeVersion ?? PC09_VERSION_V1;
  const versions = [
    { version: PC09_VERSION_V1, manifest: PC09_MANIFEST_V1, digest: PC09_MANIFEST_DIGEST_V1 },
    { version: PC09_VERSION_V2, manifest: PC09_MANIFEST_V2, digest: PC09_MANIFEST_DIGEST_V2 },
  ];
  await db.tx(async (client) => {
    await client.query(
      `INSERT INTO business_catalog (business_id, enabled, activation_revision, submissions_paused)
       VALUES ($1, true, 1, false)
       ON CONFLICT (business_id) DO UPDATE SET enabled = true, submissions_paused = false`,
      [PC09_BUSINESS],
    );
    for (const entry of versions) {
      await client.query(
        `INSERT INTO business_versions
           (business_id, version, contract_version, manifest, digest, status, queue, is_active)
         VALUES ($1,$2,$3,$4::jsonb,$5,'REGISTERED_DISABLED',$6,false)
         ON CONFLICT (business_id, version) DO UPDATE
           SET manifest = EXCLUDED.manifest,
               digest = EXCLUDED.digest,
               contract_version = EXCLUDED.contract_version`,
        [
          PC09_BUSINESS,
          entry.version,
          WIRE_CONTRACT_VERSION,
          JSON.stringify(entry.manifest),
          entry.digest,
          `du-business-${PC09_BUSINESS}-${entry.version}`,
        ],
      );
    }
    await client.query(
      'UPDATE business_versions SET is_active = false WHERE business_id = $1',
      [PC09_BUSINESS],
    );
  });
  await activatePc09Version(db, activeVersion);
  return {
    businessId: PC09_BUSINESS,
    activeVersion,
    versions: versions.map((entry) => ({ version: entry.version, digest: entry.digest })),
  };
}

/** Move the single active-version pointer (the partial unique index allows one). */
export async function activatePc09Version(db: Db, version: string): Promise<void> {
  const { digest } = pc09ManifestFor(version);
  await db.tx(async (client) => {
    await client.query('UPDATE business_versions SET is_active = false WHERE business_id = $1', [PC09_BUSINESS]);
    const updated = await client.query(
      `UPDATE business_versions
          SET is_active = true, status = 'ENABLED', digest = $3
        WHERE business_id = $1 AND version = $2`,
      [PC09_BUSINESS, version, digest],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`activatePc09Version: ${PC09_BUSINESS}@${version} is not registered`);
    }
  });
}

/** A fresh tenant for one cohort; names are unique per call. */
export async function createPc09Tenant(db: Db, label: string): Promise<string> {
  const tenantId = randomUUID();
  await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [
    tenantId,
    `pc09-${label}-${tenantId.slice(0, 8)}`,
  ]);
  return tenantId;
}

/* ------------------------------------------------------------------ */
/* Internal seeding primitives                                        */
/* ------------------------------------------------------------------ */

interface SeedKeyInput {
  tenantId: string;
  keyMode: Pc09KeyMode;
  label: string;
}

async function insertKey(client: PoolClient, input: SeedKeyInput): Promise<Pc09Key> {
  const apiKeyId = randomUUID();
  const rawApiKey = `du_pc09_${randomUUID().replace(/-/g, '')}`;
  await client.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode, name)
     VALUES ($1,$2,$3,$4,'ACTIVE',$5,$6)`,
    [apiKeyId, input.tenantId, hashRawKey(rawApiKey), `pc09_${input.label}`.slice(0, 12), input.keyMode,
      `pc09 ${input.label}`],
  );
  return { apiKeyId, rawApiKey, keyMode: input.keyMode };
}

interface SeedChildInput {
  tenantId: string;
  businessVersion: string;
  action: Pc09Action;
  /** Set for a group-owned child; `null` for a standalone profile. */
  groupId: string | null;
  /** Historical author for a standalone profile; `null` for a group child. */
  apiKeyId: string | null;
  cohortTag: string;
}

/**
 * One immutable child revision + its registry row + its active pointer.
 *
 * Attribution follows PC-02's CHECK: a row carries the historical `api_key_id`
 * **or** the Admin `created_by`, never neither. Ownership follows PC-02's other
 * CHECK: a registry row carries a key or a group.
 */
async function insertChildProfile(client: PoolClient, input: SeedChildInput): Promise<Pc09ChildPin> {
  const profileId = randomUUID();
  const endpointSlug = pc09EndpointSlug(input.action);
  const profileName = `__pc09_${input.cohortTag}_${input.action}_${shortId()}`;
  await client.query(
    `INSERT INTO profile_bindings
       (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
        enabled, parameters, request_defaults, endpoint_slug, created_by)
     VALUES ($1,1,$2,$3,$4,$5,$6,true,'{}'::jsonb,'{}'::jsonb,$7,$8)`,
    [
      profileId,
      input.tenantId,
      input.apiKeyId,
      PC09_BUSINESS,
      input.businessVersion,
      input.action,
      endpointSlug,
      input.apiKeyId === null ? HARNESS_ACTOR : null,
    ],
  );
  await client.query(
    `INSERT INTO profile_names
       (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name, group_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      profileId,
      input.tenantId,
      input.apiKeyId,
      PC09_BUSINESS,
      input.businessVersion,
      input.action,
      profileName,
      input.groupId,
    ],
  );
  await client.query('INSERT INTO profile_active_revisions (profile_id, revision) VALUES ($1, 1)', [profileId]);
  return {
    action: input.action,
    functionId: pc09FunctionId(input.action),
    endpointSlug,
    profileId,
    revision: 1,
  };
}

interface SeedGroupRootInput {
  tenantId: string;
  authority: Pc09AuthAuthority;
  tag: string;
}

/**
 * The group root + its first immutable revision, committed with
 * `active_revision = 0`.
 *
 * The two-phase shape is forced by two constraints working together:
 * `profile_groups.active_revision` is a DEFERRABLE FK to the revision, and
 * `profile_names_owner_shape` requires a child registry row to carry a key **or**
 * a group. So the group must exist before the children do, and the pointer must
 * be moved only after the members are in place.
 */
async function insertGroupRoot(client: PoolClient, input: SeedGroupRootInput): Promise<{ groupId: string }> {
  const groupId = randomUUID();
  await client.query(
    `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision, auth_authority, access_version)
     VALUES ($1,$2,$3,0,$4,1)`,
    [groupId, input.tenantId, `pc09-${input.tag}-${shortId()}`, input.authority],
  );
  await client.query(
    `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id, created_by)
     VALUES ($1,1,$2,$3,NULL,$4)`,
    [groupId, input.tenantId, `pc09-${input.tag}-1`, HARNESS_ACTOR],
  );
  return { groupId };
}

async function insertMember(
  client: PoolClient,
  input: { groupId: string; businessVersion: string; child: Pc09ChildPin },
): Promise<void> {
  const manifestDigest = pc09ManifestFor(input.businessVersion).digest;
  await client.query(
    `INSERT INTO profile_group_members
       (group_id, group_revision, business_id, business_version, manifest_digest, function_kind,
        function_id, action, endpoint_slug, workflow_revision, profile_id, binding_revision)
     VALUES ($1,1,$2,$3,$4,'endpoint',$5,$6,$7,NULL,$8,$9)`,
    [
      input.groupId,
      PC09_BUSINESS,
      input.businessVersion,
      manifestDigest,
      input.child.functionId,
      input.child.action,
      input.child.endpointSlug,
      input.child.profileId,
      input.child.revision,
    ],
  );
}

/** Point the group at revision 1 once its members exist. */
async function activateGroupRevision(client: PoolClient, groupId: string): Promise<void> {
  await client.query('UPDATE profile_groups SET active_revision = 1 WHERE group_id = $1', [groupId]);
}

async function insertGrant(client: PoolClient, input: {
  apiKeyId: string;
  groupId: string;
  tenantId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO profile_group_api_keys (api_key_id, group_id, tenant_id, state, granted_by)
     VALUES ($1,$2,$3,'ACTIVE',$4)`,
    [input.apiKeyId, input.groupId, input.tenantId, HARNESS_ACTOR],
  );
}

async function insertMembership(client: PoolClient, input: {
  profileId: string;
  apiKeyId: string;
  tenantId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
     VALUES ($1,$2,$3,'ACTIVE')`,
    [input.profileId, input.apiKeyId, input.tenantId],
  );
}

/* ------------------------------------------------------------------ */
/* Cohort builders                                                    */
/* ------------------------------------------------------------------ */

/**
 * Cohort A — a legacy standalone profile reached through a child membership.
 * The v1 resolver must return `pinned` for every seeded action.
 */
export async function buildCohortA(db: Db, input: Pc09CohortInput): Promise<Pc09Cohort> {
  const actions = actionsOf(input);
  const businessVersion = versionOf(input);
  return db.tx(async (client) => {
    const key = await insertKey(client, {
      tenantId: input.tenantId,
      keyMode: 'LEGACY_STANDALONE',
      label: 'a',
    });
    const children: Pc09ChildPin[] = [];
    for (const action of actions) {
      const child = await insertChildProfile(client, {
        tenantId: input.tenantId,
        businessVersion,
        action,
        groupId: null,
        apiKeyId: key.apiKeyId,
        cohortTag: 'a',
      });
      await insertMembership(client, {
        profileId: child.profileId,
        apiKeyId: key.apiKeyId,
        tenantId: input.tenantId,
      });
      children.push(child);
    }
    return {
      kind: 'A',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys: [key],
      children,
    };
  });
}

/**
 * Cohort B — an unmanaged legacy key: no profile, no membership, no group.
 * The resolver must fall through to `mode: 'legacy'`.
 */
export async function buildCohortB(db: Db, input: Omit<Pc09CohortInput, 'actions'>): Promise<Pc09Cohort> {
  const businessVersion = input.businessVersion ?? PC09_VERSION_V1;
  return db.tx(async (client) => {
    const key = await insertKey(client, {
      tenantId: input.tenantId,
      keyMode: 'UNMANAGED_LEGACY',
      label: 'b',
    });
    return {
      kind: 'B',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys: [key],
      children: [],
    };
  });
}

/**
 * Cohort C1 — the pre-cutover group: `CHILD_PROJECTION`, its children still hold
 * ACTIVE memberships, and no root grant exists yet.
 */
export async function buildCohortC1(db: Db, input: Pc09CohortInput): Promise<Pc09Cohort> {
  const actions = actionsOf(input);
  const businessVersion = versionOf(input);
  return db.tx(async (client) => {
    const key = await insertKey(client, {
      tenantId: input.tenantId,
      keyMode: 'LEGACY_STANDALONE',
      label: 'c1',
    });
    const { groupId } = await insertGroupRoot(client, {
      tenantId: input.tenantId,
      authority: 'CHILD_PROJECTION',
      tag: 'c1',
    });
    const children: Pc09ChildPin[] = [];
    for (const action of actions) {
      const child = await insertChildProfile(client, {
        tenantId: input.tenantId,
        businessVersion,
        action,
        groupId,
        apiKeyId: null,
        cohortTag: 'c1',
      });
      await insertMembership(client, {
        profileId: child.profileId,
        apiKeyId: key.apiKeyId,
        tenantId: input.tenantId,
      });
      await insertMember(client, { groupId, businessVersion, child });
      children.push(child);
    }
    await activateGroupRevision(client, groupId);
    return {
      kind: 'C1',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys: [key],
      children,
      groupId,
      groupRevision: 1,
      accessVersion: 1,
      authAuthority: 'CHILD_PROJECTION',
    };
  });
}

/**
 * Cohort C2 — the converted group: `GROUP_GRANT`, one ACTIVE root grant, and
 * **no** child memberships. This is the shape conversion produces, so it is also
 * the proof that a group-managed key cannot fall back to membership.
 */
export async function buildCohortC2(db: Db, input: Pc09CohortInput): Promise<Pc09Cohort> {
  const actions = actionsOf(input);
  const businessVersion = versionOf(input);
  return db.tx(async (client) => {
    const { groupId } = await insertGroupRoot(client, {
      tenantId: input.tenantId,
      authority: 'GROUP_GRANT',
      tag: 'c2',
    });
    const children: Pc09ChildPin[] = [];
    for (const action of actions) {
      const child = await insertChildProfile(client, {
        tenantId: input.tenantId,
        businessVersion,
        action,
        groupId,
        apiKeyId: null,
        cohortTag: 'c2',
      });
      await insertMember(client, { groupId, businessVersion, child });
      children.push(child);
    }
    await activateGroupRevision(client, groupId);
    const key = await insertKey(client, {
      tenantId: input.tenantId,
      keyMode: 'GROUP_MANAGED',
      label: 'c2',
    });
    await insertGrant(client, { apiKeyId: key.apiKeyId, groupId, tenantId: input.tenantId });
    return {
      kind: 'C2',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys: [key],
      children,
      groupId,
      groupRevision: 1,
      accessVersion: 1,
      authAuthority: 'GROUP_GRANT',
    };
  });
}

/**
 * Cohort C3 — the defensive illegal mix: a `GROUP_MANAGED` key whose group is
 * still `CHILD_PROJECTION`. It holds BOTH a grant and an ACTIVE membership, so
 * the only reason to deny is the authority check — a fallback would succeed,
 * which is exactly what this cohort proves cannot happen.
 */
export async function buildCohortC3(db: Db, input: Pc09CohortInput): Promise<Pc09Cohort> {
  const actions = actionsOf(input).slice(0, 1);
  const businessVersion = versionOf(input);
  return db.tx(async (client) => {
    const key = await insertKey(client, {
      tenantId: input.tenantId,
      keyMode: 'GROUP_MANAGED',
      label: 'c3',
    });
    const { groupId } = await insertGroupRoot(client, {
      tenantId: input.tenantId,
      authority: 'CHILD_PROJECTION',
      tag: 'c3',
    });
    const child = await insertChildProfile(client, {
      tenantId: input.tenantId,
      businessVersion,
      action: actions[0]!,
      groupId,
      apiKeyId: null,
      cohortTag: 'c3',
    });
    await insertMember(client, { groupId, businessVersion, child });
    await activateGroupRevision(client, groupId);
    await insertGrant(client, { apiKeyId: key.apiKeyId, groupId, tenantId: input.tenantId });
    await insertMembership(client, {
      profileId: child.profileId,
      apiKeyId: key.apiKeyId,
      tenantId: input.tenantId,
    });
    return {
      kind: 'C3',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys: [key],
      children: [child],
      groupId,
      groupRevision: 1,
      accessVersion: 1,
      authAuthority: 'CHILD_PROJECTION',
    };
  });
}

/**
 * Cohort D — a multi-key group: `GROUP_GRANT` with `keyCount` ACTIVE grants and
 * no memberships. Every key resolves the same children; cross-key isolation is
 * an operation-ownership assertion, not a resolution one.
 */
export async function buildCohortD(
  db: Db,
  input: Pc09CohortInput & { keyCount?: number },
): Promise<Pc09Cohort> {
  const actions = actionsOf(input);
  const businessVersion = versionOf(input);
  const keyCount = input.keyCount ?? 2;
  if (!Number.isSafeInteger(keyCount) || keyCount < 2) {
    throw new Error('buildCohortD: keyCount must be an integer >= 2');
  }
  return db.tx(async (client) => {
    const { groupId } = await insertGroupRoot(client, {
      tenantId: input.tenantId,
      authority: 'GROUP_GRANT',
      tag: 'd',
    });
    const children: Pc09ChildPin[] = [];
    for (const action of actions) {
      const child = await insertChildProfile(client, {
        tenantId: input.tenantId,
        businessVersion,
        action,
        groupId,
        apiKeyId: null,
        cohortTag: 'd',
      });
      await insertMember(client, { groupId, businessVersion, child });
      children.push(child);
    }
    await activateGroupRevision(client, groupId);
    const keys: Pc09Key[] = [];
    for (let index = 0; index < keyCount; index += 1) {
      const key = await insertKey(client, {
        tenantId: input.tenantId,
        keyMode: 'GROUP_MANAGED',
        label: `d${index}`,
      });
      await insertGrant(client, { apiKeyId: key.apiKeyId, groupId, tenantId: input.tenantId });
      keys.push(key);
    }
    return {
      kind: 'D',
      tenantId: input.tenantId,
      businessId: PC09_BUSINESS,
      businessVersion,
      keys,
      children,
      groupId,
      groupRevision: 1,
      accessVersion: 1,
      authAuthority: 'GROUP_GRANT',
    };
  });
}

/** The selector a v2 preview/submit for `child` would carry. */
export function pc09SelectorFor(cohort: Pc09Cohort, child: Pc09ChildPin): {
  businessId: string;
  businessVersion: string;
  action: string;
  functionId: string;
  endpointSlug: string;
} {
  return {
    businessId: cohort.businessId,
    businessVersion: cohort.businessVersion,
    action: child.action,
    functionId: child.functionId,
    endpointSlug: child.endpointSlug,
  };
}

/** A minimal Submission body accepted by every seeded action schema. */
export function pc09Submission(input: Record<string, unknown> = {}): { input: Record<string, unknown> } {
  return { input };
}
