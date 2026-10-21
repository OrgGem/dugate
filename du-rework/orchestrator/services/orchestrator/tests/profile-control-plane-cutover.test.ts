import {
  PC09_ACTIONS,
  PC09_BUSINESS,
  PC09_VERSION_V2,
  buildCohortA,
  buildCohortB,
  buildCohortC1,
  buildCohortC2,
  buildCohortC3,
  buildCohortD,
  createPc09Tenant,
  pc09SelectorFor,
  pc09Submission,
  seedPc09Business,
  type Pc09Action,
  type Pc09ChildPin,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import { withScratchDatabase, type ScratchDatabase } from './helpers/scratch-db';
import { createRegistryService } from '../src/modules/registry/registry';
import { createProfileService } from '../src/modules/profiles/profiles';
import {
  createSubmissionService,
  type GroupAdmissionPin,
  type SubmitResult,
} from '../src/modules/operations/submission';

/**
 * PC-09 — 6 × 5 profile-control-plane cutover matrix.
 *
 * Drives every core gateway action through the real admission service against a
 * real PostgreSQL built by the real migration chain, once per cohort:
 *
 *   A   legacy standalone profile   → pinned through child membership
 *   B   unmanaged legacy key        → admitted in `legacy` mode, no pin
 *   C1  group before conversion     → still resolves through child memberships
 *   C2  group after conversion      → resolves ONLY through the root grant
 *   C3  defensive illegal mix       → 409, never a legacy fallback
 *   D   multi-key group             → independent admissions, identical pins
 *
 * Plus the v2 dimension on C2: preview → fingerprinted submit → stored
 * fingerprint → stale-fingerprint refusal with zero durable rows.
 *
 * The matrix asserts the OPERATION ROW, not a service return value: the pin
 * columns are the durable fact every later consumer (claim, grant, retry,
 * projection) reads, so a green test here means the worker will actually get
 * that configuration.
 *
 * Window-gated: without `DU_LIVE_INFRA=1` every test self-skips.
 */

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('profile-control-plane-cutover.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const MATRIX_COHORTS = ['A', 'B', 'C1', 'C2', 'C3'] as const;
type MatrixCohort = (typeof MATRIX_COHORTS)[number];

interface OperationPinRow {
  api_key_id: string;
  profile_id: string | null;
  profile_revision: number | null;
  profile_policy_snapshot: unknown;
  business_version: string;
  action: string;
}

liveDescribe('PC-09 6 × 5 cutover matrix', () => {
  let scratch: ScratchDatabase;
  let submission: ReturnType<typeof createSubmissionService>;
  const cohorts = new Map<MatrixCohort, Pc09Cohort>();
  let multiKey: Pc09Cohort;

  async function childFor(cohort: Pc09Cohort, action: Pc09Action): Promise<Pc09ChildPin> {
    const child = cohort.children.find((candidate) => candidate.action === action);
    if (!child) throw new Error(`cohort ${cohort.kind} has no child for action ${action}`);
    return child;
  }

  async function operationPin(operationId: string): Promise<OperationPinRow> {
    const result = await scratch.db.query<OperationPinRow>(
      `SELECT api_key_id, profile_id, profile_revision, profile_policy_snapshot,
              business_version, action
         FROM operations WHERE id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`operation ${operationId} was not written`);
    return row;
  }

  async function operationCountForKey(apiKeyId: string): Promise<number> {
    const result = await scratch.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM operations WHERE api_key_id = $1',
      [apiKeyId],
    );
    return Number(result.rows[0]!.n);
  }

  beforeAll(async () => {
    scratch = await withScratchDatabase({ suite: 'pc09-cutover-matrix' });
    // Version 2.0.0 is the one whose digest the seeded group members pin, and it
    // is the opt-in manifest, so the matrix runs against the strictest shape.
    await seedPc09Business(scratch.db, { activeVersion: PC09_VERSION_V2 });
    const profiles = createProfileService(scratch.db, { cryptoEnv: {} });
    submission = createSubmissionService(scratch.db, createRegistryService(scratch.db), profiles, {});

    const seeds: Array<[MatrixCohort, string, (input: { tenantId: string; businessVersion: string }) => Promise<Pc09Cohort>]> = [
      ['A', 'matrix-a', (input) => buildCohortA(scratch.db, input)],
      ['B', 'matrix-b', (input) => buildCohortB(scratch.db, input)],
      ['C1', 'matrix-c1', (input) => buildCohortC1(scratch.db, input)],
      ['C2', 'matrix-c2', (input) => buildCohortC2(scratch.db, input)],
      ['C3', 'matrix-c3', (input) => buildCohortC3(scratch.db, input)],
    ];
    for (const [kind, label, build] of seeds) {
      const tenantId = await createPc09Tenant(scratch.db, label);
      cohorts.set(kind, await build({ tenantId, businessVersion: PC09_VERSION_V2 }));
    }
    const multiTenant = await createPc09Tenant(scratch.db, 'matrix-d');
    multiKey = await buildCohortD(
      scratch.db,
      { tenantId: multiTenant, businessVersion: PC09_VERSION_V2, keyCount: 3 },
    );
  }, 300_000);

  afterAll(async () => {
    await scratch?.close();
  }, 60_000);

  describe('cohort state invariants', () => {
    test('C2 is post-cutover: GROUP_GRANT with zero child memberships for all six actions', async () => {
      const cohort = cohorts.get('C2')!;
      expect(cohort.authAuthority).toBe('GROUP_GRANT');
      expect(cohort.keys[0]!.keyMode).toBe('GROUP_MANAGED');
      expect(cohort.children.map((child) => child.action)).toEqual([...PC09_ACTIONS]);
      const memberships = await scratch.db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM profile_api_keys WHERE api_key_id = $1',
        [cohort.keys[0]!.apiKeyId],
      );
      expect(Number(memberships.rows[0]!.n)).toBe(0);
      const grants = await scratch.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM profile_group_api_keys
          WHERE api_key_id = $1 AND state = 'ACTIVE'`,
        [cohort.keys[0]!.apiKeyId],
      );
      expect(Number(grants.rows[0]!.n)).toBe(1);
    });

    test('C3 is the defensive mix: grant AND membership both present', async () => {
      const cohort = cohorts.get('C3')!;
      expect(cohort.keys[0]!.keyMode).toBe('GROUP_MANAGED');
      expect(cohort.authAuthority).toBe('CHILD_PROJECTION');
      const membership = await scratch.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM profile_api_keys
          WHERE api_key_id = $1 AND state = 'ACTIVE'`,
        [cohort.keys[0]!.apiKeyId],
      );
      // A fallback would succeed here — the denial must come from authority.
      expect(Number(membership.rows[0]!.n)).toBe(1);
    });

    test('D holds three independent ACTIVE grants on one group', async () => {
      expect(multiKey.keys).toHaveLength(3);
      expect(multiKey.children.map((child) => child.action)).toEqual([...PC09_ACTIONS]);
      const grants = await scratch.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM profile_group_api_keys
          WHERE group_id = $1 AND state = 'ACTIVE'`,
        [multiKey.groupId!],
      );
      expect(Number(grants.rows[0]!.n)).toBe(3);
    });
  });

  describe.each(MATRIX_COHORTS)('cohort %s', (kind) => {
    test.each(PC09_ACTIONS)('admits %s with the designed pin', async (action) => {
      const cohort = cohorts.get(kind)!;
      const key = cohort.keys[0]!;

      if (kind === 'C3') {
        // The defensive mix denies before any selector is matched: C3 seeds one
        // action on purpose, and passing an endpoint would prove nothing extra.
        const before = await operationCountForKey(key.apiKeyId);
        await expect(submission.submit({
          tenantId: cohort.tenantId,
          apiKeyId: key.apiKeyId,
          businessId: PC09_BUSINESS,
          action,
          submission: pc09Submission(),
        })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
        expect(await operationCountForKey(key.apiKeyId)).toBe(before);
        return;
      }

      if (kind === 'B') {
        // Unmanaged legacy: no profile, no selector, no pin.
        const result: SubmitResult = await submission.submit({
          tenantId: cohort.tenantId,
          apiKeyId: key.apiKeyId,
          businessId: PC09_BUSINESS,
          action,
          submission: pc09Submission(),
        });
        expect(result.replayed).toBe(false);
        const pin = await operationPin(result.operation.id);
        expect(pin.api_key_id).toBe(key.apiKeyId);
        expect(pin.business_version).toBe(PC09_VERSION_V2);
        expect(pin.action).toBe(action);
        expect(pin.profile_id).toBeNull();
        expect(pin.profile_revision).toBeNull();
        expect(pin.profile_policy_snapshot).toBeNull();
        return;
      }

      const child = await childFor(cohort, action);
      const result: SubmitResult = await submission.submit({
        tenantId: cohort.tenantId,
        apiKeyId: key.apiKeyId,
        businessId: PC09_BUSINESS,
        action,
        // Every endpoint-kind function carries a selector (0070's member CHECK
        // forbids a NULL one), and a v1 client addresses an endpoint by it. The
        // service reads it from this field for both resolver branches.
        profileEndpointSlug: child.endpointSlug,
        submission: pc09Submission(),
      });
      expect(result.replayed).toBe(false);

      const pin = await operationPin(result.operation.id);
      expect(pin.api_key_id).toBe(key.apiKeyId);
      expect(pin.business_version).toBe(PC09_VERSION_V2);
      expect(pin.action).toBe(action);
      // A pins through membership; C1 pins through membership; C2 pins the
      // group child through the root grant. All three end at the same columns.
      expect(pin.profile_id).toBe(child.profileId);
      expect(Number(pin.profile_revision)).toBe(child.revision);
      expect(pin.profile_policy_snapshot).not.toBeNull();
    });
  });

  describe('cohort D — multi-key group', () => {
    test.each(PC09_ACTIONS)('every key admits %s with identical configuration pins', async (action) => {
      const child = await childFor(multiKey, action);
      const pins: OperationPinRow[] = [];
      for (const key of multiKey.keys) {
        const result = await submission.submit({
          tenantId: multiKey.tenantId,
          apiKeyId: key.apiKeyId,
          businessId: PC09_BUSINESS,
          action,
          profileEndpointSlug: child.endpointSlug,
          submission: pc09Submission(),
        });
        const pin = await operationPin(result.operation.id);
        // Ownership is per key even though the configuration is shared.
        expect(pin.api_key_id).toBe(key.apiKeyId);
        pins.push(pin);      }
      expect(pins).toHaveLength(multiKey.keys.length);
      const profileIds = new Set(pins.map((pin) => pin.profile_id));
      const revisions = new Set(pins.map((pin) => Number(pin.profile_revision)));
      expect(profileIds).toEqual(new Set([child.profileId]));
      expect(revisions).toEqual(new Set([child.revision]));
      expect(pins.every((pin) => pin.profile_policy_snapshot !== null)).toBe(true);
    });
  });

  describe('v2 dimension on the converted cohort', () => {
    test('preview returns refs + fingerprint, and submit stores that fingerprint', async () => {
      const cohort = cohorts.get('C2')!;
      const child = await childFor(cohort, 'extract');
      const request = {
        tenantId: cohort.tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        groupId: cohort.groupId!,
        selector: pc09SelectorFor(cohort, child),
        submission: pc09Submission({ note: 'v2-matrix' }),
      };

      const preview = await submission.previewProfileV2(request);
      expect(preview.refs).toMatchObject({
        groupId: cohort.groupId,
        groupRevision: cohort.groupRevision,
        accessVersion: cohort.accessVersion,
        childProfileId: child.profileId,
        childRevision: child.revision,
        businessId: PC09_BUSINESS,
        action: 'extract',
      });
      expect(preview.resolutionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      // `mode` is a requestDefaults source on the v2 manifest, so the preview
      // reports it as filled rather than as client input.
      expect(preview.effective.parameters.mode).toBe('standard');
      expect(preview.effective.appliedSchemaDefaults).toContain('mode');

      const result = await submission.submitProfileV2({
        ...request,
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc09-matrix-v2-extract',
      });
      const pin = await operationPin(result.operation.id);
      expect(pin.profile_id).toBe(child.profileId);
      const stored = await scratch.db.query<{ resolution_fingerprint: string | null }>(
        `SELECT resolution_fingerprint FROM submission_keys
          WHERE tenant_id = $1 AND api_key_id = $2 AND key = $3`,
        [cohort.tenantId, cohort.keys[0]!.apiKeyId, 'pc09-matrix-v2-extract'],
      );
      expect(stored.rows[0]!.resolution_fingerprint).toBe(preview.resolutionFingerprint);
    });

    test('an exact replay returns the pinned operation after the access version drifts', async () => {
      const cohort = cohorts.get('C2')!;
      const child = await childFor(cohort, 'analyze');
      const request = {
        tenantId: cohort.tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        groupId: cohort.groupId!,
        selector: pc09SelectorFor(cohort, child),
        submission: pc09Submission(),
      };
      const preview = await submission.previewProfileV2(request);
      const first = await submission.submitProfileV2({
        ...request,
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc09-matrix-v2-drift',
      });
      await scratch.db.query(
        'UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id = $1',
        [cohort.groupId!],
      );
      const replay = await submission.submitProfileV2({
        ...request,
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc09-matrix-v2-drift',
      });
      expect(replay.replayed).toBe(true);
      expect(replay.operation.id).toBe(first.operation.id);
    });

    test('a stale fingerprint on a new submission is 409 with zero durable rows', async () => {
      const cohort = cohorts.get('C2')!;
      const child = await childFor(cohort, 'generate');
      const request = {
        tenantId: cohort.tenantId,
        apiKeyId: cohort.keys[0]!.apiKeyId,
        groupId: cohort.groupId!,
        selector: pc09SelectorFor(cohort, child),
        submission: pc09Submission(),
      };
      const preview = await submission.previewProfileV2(request);
      await scratch.db.query(
        'UPDATE profile_groups SET access_version = access_version + 1 WHERE group_id = $1',
        [cohort.groupId!],
      );
      const before = await operationCountForKey(cohort.keys[0]!.apiKeyId);
      await expect(submission.submitProfileV2({
        ...request,
        resolutionFingerprint: preview.resolutionFingerprint,
        idempotencyKey: 'pc09-matrix-v2-stale',
      })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CHANGED' });
      expect(await operationCountForKey(cohort.keys[0]!.apiKeyId)).toBe(before);
    });
  });

  describe('cross-cohort isolation', () => {
    test('each cohort operation belongs to its own tenant and key', async () => {
      const rows = await scratch.db.query<{ tenant_id: string; api_key_id: string; n: string }>(
        `SELECT tenant_id, api_key_id, count(*)::text AS n
           FROM operations
          WHERE business_id = $1
          GROUP BY tenant_id, api_key_id
          ORDER BY n DESC`,
        [PC09_BUSINESS],
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(5);
      // No key may appear under two tenants (the matrix coerced each key with
      // exactly one tenant, so a violation would mean a cross-tenant write).
      const tenantsByKey = new Map<string, Set<string>>();
      for (const row of rows.rows) {
        const set = tenantsByKey.get(row.api_key_id) ?? new Set<string>();
        set.add(row.tenant_id);
        tenantsByKey.set(row.api_key_id, set);
      }
      for (const [, tenants] of tenantsByKey) expect(tenants.size).toBe(1);
    });
  });
});
