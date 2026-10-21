/**
 * PC-09 — phased cutover and authority-conversion drill (live PostgreSQL).
 *
 * This is the **drill**, not a re-proof of the conversion function: PC-03's
 * `profile-groups-v2-pg.test.ts` already owns the happy path and the shared-key
 * block. What is proved here is the *sequence* an operator runs, and the
 * invariants that must survive it:
 *
 *   D1  the pre-cutover cohort (`CHILD_PROJECTION`, `LEGACY_STANDALONE` key,
 *       ACTIVE child memberships) passes the dry-run inventory cleanly;
 *   D2  conversion reports `CHILD_PROJECTION → GROUP_GRANT` and bumps
 *       `access_version` by exactly one;
 *   D3  afterwards: grant ACTIVE, child memberships tombstoned, key promoted to
 *       `GROUP_MANAGED`, config revision untouched;
 *   P1–P7 each block the conversion on exactly one dirty fact, with the named
 *       `/check` pointer and **zero** writes;
 *   D4  a v1 submission still succeeds and now pins through the grant;
 *   D5  a v2 preview → submit succeeds and stores a resolution fingerprint;
 *   D6  re-running the conversion is idempotent (no second bump, no duplicate
 *       grant);
 *   D7  every legacy write surface refuses the converted group with
 *       `409 PROFILE_GROUP_V2_REQUIRED`;
 *   R1  a config rollback never touches the grant ledger and never decreases
 *       `access_version`, and never resurrects a revoked grant.
 *
 * Tier: **T2** (real PostgreSQL, direct service calls). No HTTP server, no
 * Redis, no provider.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ProfileGroupV2Save } from '@du/contracts';
import { warnIfSkipped, liveDescribe } from './helpers/runtime-harness';
import { withScratchDatabase, type ScratchDatabase } from './helpers/scratch-db';
import {
  PC09_ACTIONS,
  PC09_BUSINESS,
  PC09_MANIFEST_DIGEST_V1,
  PC09_VERSION_V1,
  buildCohortC1,
  createPc09Tenant,
  pc09EndpointSlug,
  pc09FunctionId,
  pc09SelectorFor,
  pc09Submission,
  seedPc09Business,
  type Pc09Action,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createRegistryService } from '../src/modules/registry/registry';
import { createSubmissionService } from '../src/modules/operations/submission';
import {
  assertLegacyGroupWriteAllowed,
  convertGroupToGrantAuthority,
  issueGroupKey,
  readGroupAuthority,
  resolveRootGrant,
  revokeGroupGrant,
  rollbackProfileGroup,
  rollbackProfileGroupV2,
  saveProfileGroup,
  saveProfileGroupV2,
  type ProfileGroupActor,
} from '../src/modules/profiles/profile-groups';
import { hashKey } from '../src/http/routes/api-key-auth';

warnIfSkipped('profile-control-plane-cutover-drill.test.ts');

const ACTOR: ProfileGroupActor = { actor: 'pc09-drill', role: 'platform' };

interface DrillState {
  scratch: ScratchDatabase;
  submission: ReturnType<typeof createSubmissionService>;
  profiles: ReturnType<typeof createProfileService>;
}

const state: { value?: DrillState } = {};

function ctx(): DrillState {
  if (!state.value) throw new Error('drill state is not initialised');
  return state.value;
}

/* ------------------------------------------------------------------ */
/* Read helpers — always read the database, never a cached value       */
/* ------------------------------------------------------------------ */

async function groupRow(groupId: string): Promise<{
  auth_authority: string;
  access_version: number;
  active_revision: number;
}> {
  const result = await ctx().scratch.db.query<{
    auth_authority: string;
    access_version: string | number;
    active_revision: number;
  }>(
    'SELECT auth_authority, access_version, active_revision FROM profile_groups WHERE group_id=$1',
    [groupId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`profile group ${groupId} disappeared`);
  return {
    auth_authority: row.auth_authority,
    access_version: Number(row.access_version),
    active_revision: Number(row.active_revision),
  };
}

async function keyMode(apiKeyId: string): Promise<string | null> {
  const result = await ctx().scratch.db.query<{ key_mode: string | null }>(
    'SELECT key_mode FROM api_keys WHERE id=$1',
    [apiKeyId],
  );
  return result.rows[0]?.key_mode ?? null;
}

/** ACTIVE root grants only — tombstones are read explicitly where they matter. */
async function grants(groupId: string): Promise<Array<{ api_key_id: string; state: string }>> {
  const result = await ctx().scratch.db.query<{ api_key_id: string; state: string }>(
    `SELECT api_key_id, state FROM profile_group_api_keys
      WHERE group_id=$1 AND state='ACTIVE' ORDER BY api_key_id`,
    [groupId],
  );
  return result.rows;
}

async function membershipStates(profileIds: readonly string[]): Promise<string[]> {
  const result = await ctx().scratch.db.query<{ state: string }>(
    'SELECT state FROM profile_api_keys WHERE profile_id = ANY($1::uuid[])',
    [profileIds],
  );
  return result.rows.map((row) => row.state);
}

async function operationPins(operationId: string): Promise<{
  profile_id: string | null;
  profile_revision: number | null;
  profile_policy_snapshot: unknown;
  api_key_id: string | null;
}> {
  const result = await ctx().scratch.db.query<{
    profile_id: string | null;
    profile_revision: number | null;
    profile_policy_snapshot: unknown;
    api_key_id: string | null;
  }>(
    'SELECT profile_id, profile_revision, profile_policy_snapshot, api_key_id FROM operations WHERE id=$1',
    [operationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`operation ${operationId} was not written`);
  return row;
}

/** The conversion report's failed proof, as the wire would carry it. */
function checkOf(error: unknown): string | undefined {
  const extra = (error as { extra?: { errors?: Array<{ pointer: string; message: string }> } }).extra;
  return extra?.errors?.find((entry) => entry.pointer === '/check')?.message;
}

async function expectBlocked(
  tenantId: string,
  dirty: (client: PoolClient, cohort: Pc09Cohort) => Promise<void>,
  check: string,
  actions: readonly Pc09Action[] = ['ingest'],
): Promise<Pc09Cohort> {
  const cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions });
  const groupId = cohort.groupId!;
  await ctx().scratch.db.tx((client) => dirty(client, cohort));

  const before = await groupRow(groupId);
  let thrown: unknown;
  try {
    await ctx().scratch.db.tx((client) => convertGroupToGrantAuthority(client, groupId, ACTOR));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
  expect(checkOf(thrown)).toBe(check);

  // Zero writes: the group still projects, no grant appeared, the key mode and
  // the child memberships are untouched.
  expect(await groupRow(groupId)).toEqual(before);
  expect(await grants(groupId)).toEqual([]);
  expect(await keyMode(cohort.keys[0]!.apiKeyId)).toBe('LEGACY_STANDALONE');
  return cohort;
}

/* ------------------------------------------------------------------ */

liveDescribe('PC-09 cutover drill (real PostgreSQL)', () => {
  beforeAll(async () => {
    const scratch = await withScratchDatabase({ suite: 'pc09-cutover-drill' });
    const db = scratch.db;
    await seedPc09Business(db, { activeVersion: PC09_VERSION_V1 });
    state.value = {
      scratch,
      submission: createSubmissionService(
        db,
        createRegistryService(db),
        createProfileService(db, { cryptoEnv: {} }),
        { storageBackend: 'postgres' },
      ),
      profiles: createProfileService(db, { cryptoEnv: {} }),
    };
  }, 300_000);

  afterAll(async () => {
    await state.value?.scratch.close().catch(() => undefined);
    state.value = undefined;
  }, 60_000);

  /* ---------------------------------------------------------------- */
  /* D1 — dry-run inventory on the pre-cutover cohort                  */
  /* ---------------------------------------------------------------- */

  describe('D1 — pre-cutover inventory', () => {
    it('the C1 cohort is clean: one candidate key, no sharing, no overlap, no in-flight work', async () => {
      const tenantId = await createPc09Tenant(ctx().scratch.db, 'd1');
      const cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions: PC09_ACTIONS });
      const groupId = cohort.groupId!;

      const before = await groupRow(groupId);
      expect(before).toEqual({ auth_authority: 'CHILD_PROJECTION', access_version: 1, active_revision: 1 });
      expect(await keyMode(cohort.keys[0]!.apiKeyId)).toBe('LEGACY_STANDALONE');
      expect(await grants(groupId)).toEqual([]);

      // INV — exactly one candidate: an ACTIVE key that is a member of every child.
      const candidates = await ctx().scratch.db.query<{ id: string }>(
        `SELECT k.id
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
        [tenantId, cohort.children.map((child) => child.profileId)],
      );
      expect(candidates.rows.map((row) => row.id)).toEqual([cohort.keys[0]!.apiKeyId]);

      // INV — no shared key across groups, no standalone/group mix.
      const shared = await ctx().scratch.db.query<{ api_key_id: string }>(
        `SELECT m.api_key_id
           FROM profile_api_keys m JOIN profile_names n ON n.profile_id=m.profile_id
          WHERE m.state='ACTIVE' AND n.group_id IS NOT NULL
          GROUP BY m.api_key_id HAVING count(DISTINCT n.group_id) > 1`,
      );
      expect(shared.rowCount).toBe(0);
      const mixed = await ctx().scratch.db.query<{ api_key_id: string }>(
        `SELECT m.api_key_id
           FROM profile_api_keys m JOIN profile_names n ON n.profile_id=m.profile_id
          WHERE m.state='ACTIVE'
          GROUP BY m.api_key_id
         HAVING count(*) FILTER (WHERE n.group_id IS NULL) > 0
            AND count(*) FILTER (WHERE n.group_id IS NOT NULL) > 0`,
      );
      expect(mixed.rowCount).toBe(0);

      // INV — the endpoint-aware selector overlap is empty.
      const overlap = await ctx().scratch.db.query<{ api_key_id: string }>(
        `SELECT api_key_id
           FROM (SELECT m.api_key_id, p.business_id, p.business_version, p.action,
                        p.endpoint_slug, p.profile_id
                   FROM profile_api_keys m
                   JOIN profile_active_revisions a ON a.profile_id=m.profile_id
                   JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
                  WHERE m.state='ACTIVE') s
          GROUP BY api_key_id, business_id, business_version, action, endpoint_slug
         HAVING count(DISTINCT profile_id) > 1`,
      );
      expect(overlap.rowCount).toBe(0);

      // INV — no in-flight operation is attached to a child (proof P7's precondition).
      const inflight = await ctx().scratch.db.query(
        `SELECT id FROM operations
          WHERE profile_id = ANY($1::uuid[]) AND deleted_at IS NULL
            AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','EXPIRED')`,
        [cohort.children.map((child) => child.profileId)],
      );
      expect(inflight.rowCount).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */
  /* D2/D3 — conversion                                                */
  /* ---------------------------------------------------------------- */

  describe('D2/D3 — conversion flips authority and cleans the cohort', () => {
    let tenantId: string;
    let cohort: Pc09Cohort;

    beforeAll(async () => {
      tenantId = await createPc09Tenant(ctx().scratch.db, 'd2');
      cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions: PC09_ACTIONS });
    });

    it('reports CHILD_PROJECTION → GROUP_GRANT and bumps access_version by exactly one', async () => {
      const before = await groupRow(cohort.groupId!);
      const report = await ctx().scratch.db.tx((client) =>
        convertGroupToGrantAuthority(client, cohort.groupId!, ACTOR));

      expect(report).toMatchObject({
        groupId: cohort.groupId,
        previousAuthority: 'CHILD_PROJECTION',
        authority: 'GROUP_GRANT',
        grantedKeyId: cohort.keys[0]!.apiKeyId,
        alreadyConverted: false,
      });
      expect(report.revokedChildMemberships).toBe(PC09_ACTIONS.length);
      expect(report.accessVersion).toBe(before.access_version + 1);

      const after = await groupRow(cohort.groupId!);
      expect(after.auth_authority).toBe('GROUP_GRANT');
      expect(after.access_version).toBe(before.access_version + 1);
      // A conversion is not a configuration edit.
      expect(after.active_revision).toBe(before.active_revision);
    });

    it('creates one ACTIVE root grant and promotes the key mode', async () => {
      const rows = await grants(cohort.groupId!);
      expect(rows).toEqual([{ api_key_id: cohort.keys[0]!.apiKeyId, state: 'ACTIVE' }]);
      expect(await keyMode(cohort.keys[0]!.apiKeyId)).toBe('GROUP_MANAGED');
    });

    it('tombstones every child membership instead of deleting it', async () => {
      const states = await membershipStates(cohort.children.map((child) => child.profileId));
      expect(states).toHaveLength(PC09_ACTIONS.length);
      expect(states.every((entry) => entry === 'REVOKED')).toBe(true);
    });

    it('the key now resolves through the root grant and nothing else', async () => {
      const grant = await ctx().scratch.db.tx((client) =>
        resolveRootGrant(client, cohort.keys[0]!.apiKeyId, tenantId));
      expect(grant).toMatchObject({
        groupId: cohort.groupId,
        tenantId,
        accessVersion: (await groupRow(cohort.groupId!)).access_version,
      });
      const authority = await ctx().scratch.db.tx((client) =>
        readGroupAuthority(client, cohort.groupId!, tenantId));
      expect(authority.authority).toBe('GROUP_GRANT');
    });
  });

  /* ---------------------------------------------------------------- */
  /* P1..P7 — every proof blocks on exactly its own dirty fact          */
  /* ---------------------------------------------------------------- */

  describe('P-blocks — each proof blocks the conversion with zero writes', () => {
    it('P1_CANDIDATE_KEY — two keys are members of every child', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p1'), async (client, cohort) => {
        const rivalId = randomUUID();
        await client.query(
          `INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode)
           VALUES ($1,$2,$3,'rival','ACTIVE','LEGACY_STANDALONE')`,
          [rivalId, cohort.tenantId, randomUUID().replace(/-/g, '').padEnd(64, '0')],
        );
        for (const child of cohort.children) {
          await client.query(
            `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
             VALUES ($1,$2,$3,'ACTIVE')`,
            [child.profileId, rivalId, cohort.tenantId],
          );
        }
      }, 'P1_CANDIDATE_KEY');
    });

    it('P1_CANDIDATE_KEY — the only candidate key is not ACTIVE', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p1b'), async (client, cohort) => {
        await client.query("UPDATE api_keys SET status='REVOKED' WHERE id=$1", [cohort.keys[0]!.apiKeyId]);
      }, 'P1_CANDIDATE_KEY');
    });

    it('P2_CHILD_MEMBERSHIP — one child holds a second ACTIVE membership', async () => {
      // Two actions: the rival key joins only ONE child, so it is not a
      // candidate for P1 (that requires membership of every child) and the
      // conversion reaches P2, which sees two ACTIVE memberships on that child.
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p2'), async (client, cohort) => {
        const extraId = randomUUID();
        await client.query(
          `INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode)
           VALUES ($1,$2,$3,'extra','ACTIVE','LEGACY_STANDALONE')`,
          [extraId, cohort.tenantId, randomUUID().replace(/-/g, '').padEnd(64, '1')],
        );
        await client.query(
          `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
           VALUES ($1,$2,$3,'ACTIVE')`,
          [cohort.children[0]!.profileId, extraId, cohort.tenantId],
        );
      }, 'P2_CHILD_MEMBERSHIP', ['ingest', 'extract']);
    });

    it('P3_SHARED_KEY — the candidate is also active on a standalone profile', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p3'), async (client, cohort) => {
        const profileId = randomUUID();
        await client.query(
          `INSERT INTO profile_bindings
             (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
              enabled, parameters, request_defaults, endpoint_slug)
           VALUES ($1,1,$2,$3,$4,$5,'ingest',true,'{}'::jsonb,'{}'::jsonb,$6)`,
          [profileId, cohort.tenantId, cohort.keys[0]!.apiKeyId, PC09_BUSINESS, PC09_VERSION_V1, pc09EndpointSlug('ingest')],
        );
        await client.query(
          `INSERT INTO profile_names (profile_id, tenant_id, api_key_id, business_id, business_version, action, profile_name)
           VALUES ($1,$2,$3,$4,$5,'ingest',$6)`,
          [profileId, cohort.tenantId, cohort.keys[0]!.apiKeyId, PC09_BUSINESS, PC09_VERSION_V1, `p3-standalone-${randomUUID().slice(0, 8)}`],
        );
        await client.query('INSERT INTO profile_active_revisions (profile_id, revision) VALUES ($1,1)', [profileId]);
        await client.query(
          `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
           VALUES ($1,$2,$3,'ACTIVE')`,
          [profileId, cohort.keys[0]!.apiKeyId, cohort.tenantId],
        );
      }, 'P3_SHARED_KEY');
    });

    it('P4_FOREIGN_AUTHOR — the candidate authored another group revision', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p4'), async (client, cohort) => {
        const otherGroupId = randomUUID();
        await client.query(
          `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision, auth_authority, access_version)
           VALUES ($1,$2,$3,0,'CHILD_PROJECTION',1)`,
          [otherGroupId, cohort.tenantId, `p4-other-${randomUUID().slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, api_key_id, created_by)
           VALUES ($1,1,$2,$3,$4,NULL)`,
          [otherGroupId, cohort.tenantId, 'p4-other-1', cohort.keys[0]!.apiKeyId],
        );
        await client.query('UPDATE profile_groups SET active_revision=1 WHERE group_id=$1', [otherGroupId]);
      }, 'P4_FOREIGN_AUTHOR');
    });

    it('P5_CHILD_OWNERSHIP — the schema FK makes the dirty state unrepresentable', async () => {
      // P5 blocks when a member's `profile_names.group_id` is not the group. The
      // (profile_id, group_id) FK from `profile_group_members` to `profile_names`
      // makes that state impossible to create, which is the stronger guarantee:
      // the proof is defence-in-depth, and the FK is what actually holds.
      const tenantId = await createPc09Tenant(ctx().scratch.db, 'p5');
      const cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions: ['ingest'] });
      const otherGroupId = randomUUID();
      // `profile_groups_active_revision_fk` is deferrable, so the root and its
      // first revision must be created in ONE transaction (autocommit would
      // check the FK at statement end).
      await ctx().scratch.db.tx(async (client) => {
        await client.query(
          `INSERT INTO profile_groups (group_id, tenant_id, name, active_revision, auth_authority, access_version)
           VALUES ($1,$2,$3,0,'CHILD_PROJECTION',1)`,
          [otherGroupId, tenantId, `p5-other-${randomUUID().slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO profile_group_revisions (group_id, revision, tenant_id, name, created_by)
           VALUES ($1,1,$2,$3,$4)`,
          [otherGroupId, tenantId, 'p5-other-1', ACTOR.actor],
        );
        await client.query('UPDATE profile_groups SET active_revision=1 WHERE group_id=$1', [otherGroupId]);
      });
      await expect(ctx().scratch.db.query(
        'UPDATE profile_names SET group_id=$2 WHERE profile_id=$1',
        [cohort.children[0]!.profileId, otherGroupId],
      )).rejects.toMatchObject({ code: '23503' });
      // And the clean cohort still converts, proving P5 did not block anything.
      const report = await ctx().scratch.db.tx((client) =>
        convertGroupToGrantAuthority(client, cohort.groupId!, ACTOR));
      expect(report.authority).toBe('GROUP_GRANT');
    });

    it('P6_CHILD_POINTER — the child pointer no longer matches its pinned revision', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p6'), async (client, cohort) => {
        const child = cohort.children[0]!;
        await client.query(
          `INSERT INTO profile_bindings
             (profile_id, revision, tenant_id, business_id, business_version, action,
              enabled, parameters, request_defaults, endpoint_slug, created_by)
           VALUES ($1,2,$2,$3,$4,$5,true,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
          [child.profileId, cohort.tenantId, PC09_BUSINESS, PC09_VERSION_V1, child.action,
            child.endpointSlug, ACTOR.actor],
        );
        await client.query(
          'UPDATE profile_active_revisions SET revision=2 WHERE profile_id=$1',
          [child.profileId],
        );
      }, 'P6_CHILD_POINTER');
    });

    it('P7_INFLIGHT_OPERATION — a child still has a non-terminal operation', async () => {
      await expectBlocked(await createPc09Tenant(ctx().scratch.db, 'p7'), async (client, cohort) => {
        await client.query(
          `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, state, profile_id)
           VALUES ($1,$2,$3,'ingest',$4,'RUNNING',$5)`,
          [cohort.tenantId, PC09_BUSINESS, PC09_VERSION_V1,
            `pc09-p7-${randomUUID()}`, cohort.children[0]!.profileId],
        );
      }, 'P7_INFLIGHT_OPERATION');
    });
  });

  /* ---------------------------------------------------------------- */
  /* D4/D5/D6/D7 — post-conversion behaviour                           */
  /* ---------------------------------------------------------------- */

  describe('D4/D5/D6/D7 — the converted cohort behaves as C2', () => {
    let tenantId: string;
    let cohort: Pc09Cohort;

    beforeAll(async () => {
      tenantId = await createPc09Tenant(ctx().scratch.db, 'c2');
      cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions: PC09_ACTIONS });
      await ctx().scratch.db.tx((client) => convertGroupToGrantAuthority(client, cohort.groupId!, ACTOR));
    });

    it('D4 — a v1 submission still succeeds and pins the child through the grant', async () => {
      const action = 'ingest';
      const child = cohort.children.find((entry) => entry.action === action)!;
      const result = await ctx().submission.submit({
        tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        businessId: PC09_BUSINESS,
        action,
        profileEndpointSlug: child.endpointSlug,
        submission: pc09Submission({ note: 'post-cutover v1' }),
      });

      const pins = await operationPins(result.operation.id);
      expect(pins.profile_id).toBe(child.profileId);
      expect(Number(pins.profile_revision)).toBe(child.revision);
      expect(pins.profile_policy_snapshot).not.toBeNull();
      expect(pins.api_key_id).toBe(cohort.keys[0]!.apiKeyId);
    });

    it('D5 — a v2 preview → submit records the resolution fingerprint', async () => {
      const action = 'extract';
      const child = cohort.children.find((entry) => entry.action === action)!;
      const selector = pc09SelectorFor(cohort, child);

      const preview = await ctx().submission.previewProfileV2({
        tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        groupId: cohort.groupId!,
        selector,
        submission: pc09Submission({ note: 'post-cutover v2' }),
      });
      expect(preview.resolutionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(preview.refs).toMatchObject({
        groupId: cohort.groupId,
        childProfileId: child.profileId,
        childRevision: child.revision,
      });

      const idempotencyKey = `pc09-drill-v2-${randomUUID()}`;
      const accepted = await ctx().submission.submitProfileV2({
        tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        groupId: cohort.groupId!,
        selector,
        submission: pc09Submission({ note: 'post-cutover v2' }),
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey,
      });
      expect(accepted.replayed).toBe(false);

      const stored = await ctx().scratch.db.query<{ resolution_fingerprint: string | null }>(
        `SELECT resolution_fingerprint FROM submission_keys
          WHERE tenant_id=$1 AND api_key_id=$2 AND key=$3`,
        [tenantId, cohort.keys[0]!.apiKeyId, idempotencyKey],
      );
      expect(stored.rows[0]?.resolution_fingerprint).toBe(preview.resolutionFingerprint);
    });

    it('D6 — converting again is idempotent: no second bump, no duplicate grant', async () => {
      const before = await groupRow(cohort.groupId!);
      const report = await ctx().scratch.db.tx((client) =>
        convertGroupToGrantAuthority(client, cohort.groupId!, ACTOR));
      expect(report).toMatchObject({ authority: 'GROUP_GRANT', alreadyConverted: true, revokedChildMemberships: 0 });
      expect(report.accessVersion).toBe(before.access_version);
      expect(await groupRow(cohort.groupId!)).toEqual(before);
      expect(await grants(cohort.groupId!)).toHaveLength(1);
    });

    it('D7 — every legacy write surface refuses the converted group', async () => {
      const groupId = cohort.groupId!;
      await expect(ctx().scratch.db.tx((client) =>
        assertLegacyGroupWriteAllowed(client, { groupId })))
        .rejects.toMatchObject({ status: 409, code: 'PROFILE_GROUP_V2_REQUIRED' });

      const child = cohort.children[0]!;
      await expect(ctx().scratch.db.tx((client) =>
        assertLegacyGroupWriteAllowed(client, { profileId: child.profileId })))
        .rejects.toMatchObject({ status: 409, code: 'PROFILE_GROUP_V2_REQUIRED' });

      // The v1 writer itself refuses before any registry or revision write.
      await expect(ctx().scratch.db.tx((client) => saveProfileGroup(client, ctx().profiles, undefined, {
        name: 'pc09 renamed',
        tenantId,
        apiKey: { apiKeyId: cohort.keys[0]!.apiKeyId },
        expectedRevision: 1,
        businesses: [{
          businessId: PC09_BUSINESS,
          businessVersion: PC09_VERSION_V1,
          manifestDigest: PC09_MANIFEST_DIGEST_V1,
          functions: [{
            kind: 'endpoint',
            functionId: pc09FunctionId('ingest'),
            action: 'ingest',
            endpointSlug: pc09EndpointSlug('ingest'),
            policy: {},
            connectorBindings: {},
          }],
        }],
      } as never, groupId)))
        .rejects.toMatchObject({ status: 409, code: 'PROFILE_GROUP_V2_REQUIRED' });

      await expect(ctx().scratch.db.tx((client) => rollbackProfileGroup(
        client, ctx().profiles, undefined, groupId, { expectedRevision: 1, targetRevision: 1 },
      )))
        .rejects.toMatchObject({ status: 409, code: 'PROFILE_GROUP_V2_REQUIRED' });

      // Nothing moved.
      const after = await groupRow(groupId);
      expect(after.active_revision).toBe(1);
      expect(await grants(groupId)).toEqual([{ api_key_id: cohort.keys[0]!.apiKeyId, state: 'ACTIVE' }]);
    });
  });

  /* ---------------------------------------------------------------- */
  /* R1 — config rollback never touches the grant ledger               */
  /* ---------------------------------------------------------------- */

  describe('R1 — config rollback keeps grants and access_version monotonic', () => {
    /**
     * The C1/C2 harness cohorts carry SYNTHETIC function identities
     * (`<action>.default` / `<action>:default`) that the real business catalog
     * does not declare, so they cannot be re-validated by a v2 config write.
     * The rollback leg therefore uses a **catalog-compatible** group authored
     * through the v2 service itself, which is the same state a real converted
     * cohort reaches.
     */
    async function authorCompliantGroup(tenantId: string): Promise<string> {
      // A workflow-kind function is what `pc09-core` declares for a non-Core
      // business, and it needs an ACTIVE registry revision to pin.
      await ctx().scratch.db.query(
        `INSERT INTO legacy_workflow_schemas (tenant_id, slug, revision, digest, schema_ref, status)
         VALUES ($1,'ingest',1,$2,'{}'::jsonb,'active')
         ON CONFLICT (tenant_id, slug, revision) DO NOTHING`,
        [tenantId, `sha256:${'a'.repeat(64)}`],
      );
      const body: ProfileGroupV2Save = {
        name: `pc09-rollback-${randomUUID().slice(0, 8)}`,
        tenantId,
        authMode: 'API_KEY',
        expectedRevision: 0,
        businesses: [{
          businessId: PC09_BUSINESS,
          businessVersion: PC09_VERSION_V1,
          manifestDigest: PC09_MANIFEST_DIGEST_V1,
          functions: [{
            kind: 'workflow',
            functionId: 'ingest',
            action: 'ingest',
            workflowRevision: 1,
            policy: { parameters: { maxParallel: { value: 2, isLocked: false } } },
            requestDefaults: { mode: { value: 'standard' } },
            connectorBindings: {},
          }],
        }],
      } as ProfileGroupV2Save;
      const group = await ctx().scratch.db.tx((client) =>
        saveProfileGroupV2(client, ctx().profiles, undefined, body, null, ACTOR));
      return group.groupId;
    }

    it('rollback to revision 1 moves only the pointer: grants intact, access_version unchanged', async () => {
      const tenantId = await createPc09Tenant(ctx().scratch.db, 'r1');
      const groupId = await authorCompliantGroup(tenantId);
      const created = await groupRow(groupId);
      expect(created).toMatchObject({ auth_authority: 'GROUP_GRANT', access_version: 1, active_revision: 1 });

      const issued = await ctx().scratch.db.tx((client) => issueGroupKey(
        client, { hashApiKey: hashKey }, groupId, { note: 'rollback drill' }, ACTOR, created.access_version,
      ));
      const afterGrant = await groupRow(groupId);
      expect(afterGrant.access_version).toBe(created.access_version + 1);

      // A second config revision, then a rollback to the first.
      const second = await ctx().scratch.db.tx((client) => saveProfileGroupV2(client, ctx().profiles, undefined, {
        name: `pc09-rollback-2-${randomUUID().slice(0, 8)}`,
        tenantId,
        authMode: 'API_KEY',
        expectedRevision: afterGrant.active_revision,
        businesses: [{
          businessId: PC09_BUSINESS,
          businessVersion: PC09_VERSION_V1,
          manifestDigest: PC09_MANIFEST_DIGEST_V1,
          functions: [{
            kind: 'workflow',
            functionId: 'ingest',
            action: 'ingest',
            workflowRevision: 1,
            policy: { parameters: { maxParallel: { value: 4, isLocked: false } } },
            requestDefaults: { mode: { value: 'strict' } },
            connectorBindings: {},
          }],
        }],
      } as ProfileGroupV2Save, groupId, ACTOR));
      expect(second.revision).toBe(afterGrant.active_revision + 1);
      // A config publish is not a grant change.
      expect((await groupRow(groupId)).access_version).toBe(afterGrant.access_version);

      const rolledBack = await ctx().scratch.db.tx((client) => rollbackProfileGroupV2(
        client, ctx().profiles, undefined, groupId,
        { expectedRevision: second.revision, targetRevision: 1 }, ACTOR,
      ));
      expect(rolledBack.revision).toBe(second.revision + 1);

      // The invariant triad: monotonic counter, one live grant, same key.
      expect((await groupRow(groupId)).access_version).toBe(afterGrant.access_version);
      expect(await grants(groupId)).toEqual([{ api_key_id: issued.grant.apiKeyId, state: 'ACTIVE' }]);

      // And the rolled-back config is the ORIGINAL function policy.
      const child = rolledBack.businesses[0]!.functions[0]!;
      expect(child.policy.parameters.maxParallel).toMatchObject({ value: 2 });
      expect(child.requestDefaults.mode).toMatchObject({ value: 'standard' });
    });

    it('a rollback after a grant revoke never resurrects the grant', async () => {
      const tenantId = await createPc09Tenant(ctx().scratch.db, 'r2');
      const groupId = await authorCompliantGroup(tenantId);
      const created = await groupRow(groupId);
      const issued = await ctx().scratch.db.tx((client) => issueGroupKey(
        client, { hashApiKey: hashKey }, groupId, {}, ACTOR, created.access_version,
      ));
      const afterIssue = await groupRow(groupId);

      const revoked = await ctx().scratch.db.tx((client) => revokeGroupGrant(
        client, groupId, issued.grant.apiKeyId, { expectedAccessVersion: afterIssue.access_version }, ACTOR,
      ));
      expect(revoked.accessVersion).toBe(afterIssue.access_version + 1);
      expect(await grants(groupId)).toEqual([]);

      const rolledBack = await ctx().scratch.db.tx((client) => rollbackProfileGroupV2(
        client, ctx().profiles, undefined, groupId,
        { expectedRevision: afterIssue.active_revision, targetRevision: 1 }, ACTOR,
      ));
      expect(rolledBack.revision).toBe(afterIssue.active_revision + 1);

      // Monotonic across revoke → rollback, and the tombstone survives it.
      expect((await groupRow(groupId)).access_version).toBe(revoked.accessVersion);
      expect(await grants(groupId)).toEqual([]);
      const status = await ctx().scratch.db.query<{ state: string }>(
        'SELECT state FROM profile_group_api_keys WHERE api_key_id=$1',
        [issued.grant.apiKeyId],
      );
      expect(status.rows[0]?.state).toBe('REVOKED');
      // The API key itself was never the rollback's business.
      const key = await ctx().scratch.db.query<{ status: string }>(
        'SELECT status FROM api_keys WHERE id=$1', [issued.grant.apiKeyId],
      );
      expect(key.rows[0]?.status).toBe('ACTIVE');
    });

    it('the converted C1 cohort cannot be config-edited, which is why the drill authors its own', async () => {
      // Documents the fixture boundary honestly: `rollbackProfileGroupV2` on the
      // synthetic cohort is refused by catalog validation, not by authority.
      const tenantId = await createPc09Tenant(ctx().scratch.db, 'r3');
      const cohort = await buildCohortC1(ctx().scratch.db, { tenantId, actions: ['ingest'] });
      await ctx().scratch.db.tx((client) => convertGroupToGrantAuthority(client, cohort.groupId!, ACTOR));
      const before = await groupRow(cohort.groupId!);

      await expect(ctx().scratch.db.tx((client) => rollbackProfileGroupV2(
        client, ctx().profiles, undefined, cohort.groupId!,
        { expectedRevision: before.active_revision, targetRevision: 1 }, ACTOR,
      ))).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

      // The refusal mutated nothing.
      expect(await groupRow(cohort.groupId!)).toEqual(before);
      expect(await grants(cohort.groupId!)).toHaveLength(1);
    });
  });
});
