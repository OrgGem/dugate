import {
  PC09_ACTIONS,
  PC09_BUSINESS,
  PC09_MANIFEST_V1,
  PC09_MANIFEST_V2,
  PC09_MANIFEST_DIGEST_V1,
  PC09_MANIFEST_DIGEST_V2,
  PC09_VERSION_V1,
  PC09_VERSION_V2,
  activatePc09Version,
  buildCohortA,
  buildCohortB,
  buildCohortC1,
  buildCohortC2,
  buildCohortC3,
  buildCohortD,
  createPc09Tenant,
  pc09ManifestFor,
  pc09SelectorFor,
  seedPc09Business,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import {
  SCRATCH_MIGRATIONS_DIR,
  expectedMigrationCount,
  withScratchDatabase,
  type ScratchDatabase,
} from './helpers/scratch-db';
import { createProfileService, type ProfileService } from '../src/modules/profiles/profiles';
import { verifyMigrations } from '../src/db/migrations';
import { resolveGroupAdmission, type AdmissionActionShape } from '../src/modules/operations/submission';
import { validateManifest } from '@du/contracts';

/**
 * PC-09 harness smoke test (WINDOW-GATED: DU_LIVE_INFRA=1).
 *
 * Proves the two shared helpers work before any matrix suite depends on them:
 *
 *   - `withScratchDatabase` creates, migrates and drops a scratch database, and
 *     refuses a non-test target before connecting;
 *   - `seedPc09Business` registers both immutable versions with one active
 *     pointer;
 *   - every cohort builder seeds without violating PC-02's row-shape CHECKs, and
 *     resolves the way the design says it must — including the defensive C3 mix
 *     and cohort C2's "no membership to fall back to".
 *
 * This is deliberately NOT the matrix: one action per cohort (except the
 * six-action resolution loop) keeps the smoke run fast.
 */

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('profile-control-plane-harness.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';

function actionShape(action: string): AdmissionActionShape {
  const definition = PC09_MANIFEST_V2.actions.find((candidate) => candidate.name === action);
  if (!definition) throw new Error(`no PC09 action ${action}`);
  return definition as unknown as AdmissionActionShape;
}

function declaredKeys(action: string): string[] {
  const definition = PC09_MANIFEST_V2.actions.find((candidate) => candidate.name === action);
  const properties = (definition?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.keys(properties ?? {});
}

liveDescribe('PC-09 harness smoke', () => {
  let scratch: ScratchDatabase;
  let profiles: ProfileService;
  let tenantId: string;

  beforeAll(async () => {
    scratch = await withScratchDatabase({ suite: 'pc09-harness-smoke' });
    // Everything below runs against version 2.0.0, whose digest is what the
    // seeded group members pin.
    await seedPc09Business(scratch.db, { activeVersion: PC09_VERSION_V2 });
    tenantId = await createPc09Tenant(scratch.db, 'smoke');
    profiles = createProfileService(scratch.db, { cryptoEnv: {} });
  }, 300_000);

  afterAll(async () => {
    await scratch?.close();
  }, 60_000);

  describe('withScratchDatabase', () => {
    test('applies every migration through the real runner and verifies clean', async () => {
      const expected = expectedMigrationCount();
      expect(expected).toBeGreaterThanOrEqual(68); // 0001..0071 minus the 3 historical gaps
      expect(scratch.applied).toHaveLength(expected);
      expect(scratch.applied).toContain('0071_resolution_fingerprint.sql');
      expect(scratch.databaseName).toBe('du_scratch_pc09_harness_smoke_test');
      const ledger = await scratch.db.query<{ n: string; max_sequence: number }>(
        'SELECT count(*)::text AS n, max(sequence) AS max_sequence FROM schema_migrations',
      );
      expect(Number(ledger.rows[0]!.n)).toBe(expected);
      expect(Number(ledger.rows[0]!.max_sequence)).toBe(71);
      // The declared-object drift guard must be green on a freshly migrated DB.
      await expect(verifyMigrations(scratch.db, SCRATCH_MIGRATIONS_DIR)).resolves.toBeUndefined();
    });

    test('refuses a non-test target before opening a connection', async () => {
      await expect(withScratchDatabase({
        suite: 'guard',
        databaseUrl: 'postgresql://user:secret@localhost:5432/du_production',
      })).rejects.toThrow(/not an authorized test database|guard rejected/i);
    });
  });

  describe('manifests', () => {
    test('both versions validate and the opt-in version differs only by the capability', () => {
      const v1 = validateManifest(PC09_MANIFEST_V1);
      const v2 = validateManifest(PC09_MANIFEST_V2);
      expect(v1.ok).toBe(true);
      expect(v2.ok).toBe(true);
      if (!v1.ok || !v2.ok) return;
      expect(v1.digest).toBe(PC09_MANIFEST_DIGEST_V1);
      expect(v2.digest).toBe(PC09_MANIFEST_DIGEST_V2);
      expect(v1.digest).not.toBe(v2.digest);
      expect(PC09_MANIFEST_V1.actions).toHaveLength(PC09_ACTIONS.length);
      expect(PC09_MANIFEST_V1.actions.every((action) => action.parameterResolution === undefined)).toBe(true);
      const extract = PC09_MANIFEST_V2.actions.find((action) => action.name === 'extract');
      expect(extract!.parameterResolution).toEqual({
        version: 2,
        fields: {
          mode: 'requestDefaults',
          enableReasoning: 'requestDefaults',
          maxParallel: 'profileSettings',
          reviewDepth: 'profileSettings',
        },
        applyTopLevelDefaults: true,
      });
      // Connector-free is the whole point: no slot can drag a provider in.
      expect(PC09_MANIFEST_V2.actions.every((action) => action.connectorSlots.length === 0)).toBe(true);
    });
  });

  describe('business seeding', () => {
    test('registers both immutable versions with exactly one active pointer', async () => {
      const rows = await scratch.db.query<{ version: string; is_active: boolean; digest: string }>(
        'SELECT version, is_active, digest FROM business_versions WHERE business_id=$1 ORDER BY version',
        [PC09_BUSINESS],
      );
      expect(rows.rows.map((row) => row.version)).toEqual([PC09_VERSION_V1, PC09_VERSION_V2]);
      expect(rows.rows.filter((row) => row.is_active)).toHaveLength(1);
      expect(rows.rows.find((row) => row.version === PC09_VERSION_V2)!.is_active).toBe(true);
      const catalog = await scratch.db.query<{ enabled: boolean; submissions_paused: boolean }>(
        'SELECT enabled, submissions_paused FROM business_catalog WHERE business_id=$1',
        [PC09_BUSINESS],
      );
      expect(catalog.rows[0]).toMatchObject({ enabled: true, submissions_paused: false });
    });

    test('activatePc09Version moves the single pointer and can move it back', async () => {
      await activatePc09Version(scratch.db, PC09_VERSION_V1);
      const first = await scratch.db.query<{ version: string }>(
        'SELECT version FROM business_versions WHERE business_id=$1 AND is_active',
        [PC09_BUSINESS],
      );
      expect(first.rows).toEqual([{ version: PC09_VERSION_V1 }]);
      await activatePc09Version(scratch.db, PC09_VERSION_V2);
      const second = await scratch.db.query<{ version: string }>(
        'SELECT version FROM business_versions WHERE business_id=$1 AND is_active',
        [PC09_BUSINESS],
      );
      expect(second.rows).toEqual([{ version: PC09_VERSION_V2 }]);
    });

    test('pc09ManifestFor matches the registered digest', () => {
      expect(pc09ManifestFor(PC09_VERSION_V1).digest).toBe(PC09_MANIFEST_DIGEST_V1);
      expect(pc09ManifestFor(PC09_VERSION_V2).digest).toBe(PC09_MANIFEST_DIGEST_V2);
      expect(() => pc09ManifestFor('9.9.9')).toThrow(/unknown harness version/);
    });
  });

  describe('cohort builders', () => {
    async function seedCohort(
      build: (input: { tenantId: string; businessVersion: string }) => Promise<Pc09Cohort>,
    ): Promise<Pc09Cohort> {
      return build({ tenantId, businessVersion: PC09_VERSION_V2 });
    }

    test('A — legacy standalone resolves through its membership', async () => {
      const cohort = await seedCohort((input) => buildCohortA(scratch.db, input));
      expect(cohort.keys[0]!.keyMode).toBe('LEGACY_STANDALONE');
      expect(cohort.children.length).toBeGreaterThan(0);

      const group = await resolveGroupAdmission(scratch.db as never, {}, {
        apiKeyId: cohort.keys[0]!.apiKeyId,
        tenantId,
        selector: { ...pc09SelectorFor(cohort, cohort.children[0]!), groupId: undefined },
        action: actionShape(cohort.children[0]!.action),
        clientInput: {},
        declaredKeys: declaredKeys(cohort.children[0]!.action),
      });
      expect(group).toBeNull();

      const resolved = await profiles.resolveEffectiveProfile(
        cohort.keys[0]!.apiKeyId,
        PC09_BUSINESS,
        cohort.businessVersion,
        cohort.children[0]!.action,
        {},
        declaredKeys(cohort.children[0]!.action),
        cohort.children[0]!.endpointSlug,
      );
      expect(resolved.mode).toBe('pinned');
      if (resolved.mode === 'pinned') {
        expect(resolved.profileId).toBe(cohort.children[0]!.profileId);
        expect(resolved.revision).toBe(cohort.children[0]!.revision);
      }
    });

    test('B — unmanaged legacy key has no profile at all', async () => {
      const cohort = await seedCohort((input) => buildCohortB(scratch.db, input));
      expect(cohort.keys[0]!.keyMode).toBe('UNMANAGED_LEGACY');
      expect(cohort.children).toHaveLength(0);
      const counts = await scratch.db.query<{ profile_rows: string; membership_rows: string }>(
        `SELECT
           (SELECT count(*)::text FROM profile_names WHERE api_key_id = $1) AS profile_rows,
           (SELECT count(*)::text FROM profile_api_keys WHERE api_key_id = $1) AS membership_rows`,
        [cohort.keys[0]!.apiKeyId],
      );
      expect(counts.rows[0]).toEqual({ profile_rows: '0', membership_rows: '0' });
      const resolved = await profiles.resolveEffectiveProfile(
        cohort.keys[0]!.apiKeyId,
        PC09_BUSINESS,
        cohort.businessVersion,
        'extract',
        {},
        [],
      );
      expect(resolved.mode).toBe('legacy');
    });

    test('C1 — pre-cutover group still resolves through child memberships', async () => {
      const cohort = await seedCohort((input) => buildCohortC1(scratch.db, input));
      expect(cohort.kind).toBe('C1');
      expect(cohort.authAuthority).toBe('CHILD_PROJECTION');
      const group = await resolveGroupAdmission(scratch.db as never, {}, {
        apiKeyId: cohort.keys[0]!.apiKeyId,
        tenantId,
        selector: pc09SelectorFor(cohort, cohort.children[0]!),
        action: actionShape(cohort.children[0]!.action),
        clientInput: {},
        declaredKeys: [],
      });
      expect(group).toBeNull(); // key is still LEGACY_STANDALONE
      const resolved = await profiles.resolveEffectiveProfile(
        cohort.keys[0]!.apiKeyId,
        PC09_BUSINESS,
        cohort.businessVersion,
        cohort.children[0]!.action,
        {},
        declaredKeys(cohort.children[0]!.action),
        cohort.children[0]!.endpointSlug,
      );
      expect(resolved.mode).toBe('pinned');
    });

    test('C2 — post-cutover group resolves through the grant with NO membership to fall back to', async () => {
      const cohort = await seedCohort((input) => buildCohortC2(scratch.db, input));
      expect(cohort.authAuthority).toBe('GROUP_GRANT');
      const memberships = await scratch.db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM profile_api_keys WHERE api_key_id=$1',
        [cohort.keys[0]!.apiKeyId],
      );
      expect(Number(memberships.rows[0]!.n)).toBe(0);

      const resolved = await resolveGroupAdmission(scratch.db as never, {}, {
        apiKeyId: cohort.keys[0]!.apiKeyId,
        tenantId,
        selector: { ...pc09SelectorFor(cohort, cohort.children[0]!), groupId: cohort.groupId! },
        action: actionShape(cohort.children[0]!.action),
        clientInput: {},
        declaredKeys: declaredKeys(cohort.children[0]!.action),
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.groupPin).toMatchObject({
        groupId: cohort.groupId,
        groupRevision: cohort.groupRevision,
        accessVersion: cohort.accessVersion,
        childProfileId: cohort.children[0]!.profileId,
        childRevision: cohort.children[0]!.revision,
      });

      // The v1 resolver alone would answer `legacy` here: this is exactly why
      // the front resolver branches on key_mode before touching it.
      const v1Only = await profiles.resolveEffectiveProfile(
        cohort.keys[0]!.apiKeyId,
        PC09_BUSINESS,
        cohort.businessVersion,
        cohort.children[0]!.action,
        {},
        declaredKeys(cohort.children[0]!.action),
      );
      expect(v1Only.mode).toBe('legacy');
    });

    test('C3 — GROUP_MANAGED on a CHILD_PROJECTION group is denied, never resolved', async () => {
      const cohort = await seedCohort((input) => buildCohortC3(scratch.db, input));
      expect(cohort.kind).toBe('C3');
      expect(cohort.keys[0]!.keyMode).toBe('GROUP_MANAGED');
      expect(cohort.authAuthority).toBe('CHILD_PROJECTION');
      await expect(resolveGroupAdmission(scratch.db as never, {}, {
        apiKeyId: cohort.keys[0]!.apiKeyId,
        tenantId,
        selector: { ...pc09SelectorFor(cohort, cohort.children[0]!), groupId: cohort.groupId! },
        action: actionShape(cohort.children[0]!.action),
        clientInput: {},
        declaredKeys: [],
      })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
    });

    test('D — every key of a multi-key group resolves the same children', async () => {
      const cohort = await seedCohort((input) => buildCohortD(scratch.db, { ...input, keyCount: 3 }));
      expect(cohort.keys).toHaveLength(3);
      const pins = [];
      for (const key of cohort.keys) {
        const resolved = await resolveGroupAdmission(scratch.db as never, {}, {
          apiKeyId: key.apiKeyId,
          tenantId,
          selector: { ...pc09SelectorFor(cohort, cohort.children[0]!), groupId: cohort.groupId! },
          action: actionShape(cohort.children[0]!.action),
          clientInput: {},
          declaredKeys: [],
        });
        pins.push(resolved!.groupPin!);
      }
      expect(pins.every((pin) => pin.groupId === cohort.groupId)).toBe(true);
      expect(pins.every((pin) => pin.childProfileId === cohort.children[0]!.profileId)).toBe(true);
    });

    test('all six actions resolve on one converted group', async () => {
      const cohort = await seedCohort((input) => buildCohortC2(scratch.db, input));
      expect(cohort.children.map((child) => child.action)).toEqual([...PC09_ACTIONS]);
      for (const child of cohort.children) {
        const resolved = await resolveGroupAdmission(scratch.db as never, {}, {
          apiKeyId: cohort.keys[0]!.apiKeyId,
          tenantId,
          selector: { ...pc09SelectorFor(cohort, child), groupId: cohort.groupId! },
          action: actionShape(child.action),
          clientInput: { note: 'smoke' },
          declaredKeys: declaredKeys(child.action),
        });
        expect(resolved!.groupPin?.functionId).toBe(child.functionId);
        expect(resolved!.groupPin?.action).toBe(child.action);
      }
    });
  });
});
