import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  PC09_ACTIONS,
  PC09_BUSINESS,
  PC09_VERSION_V2,
  buildCohortC2,
  createPc09Tenant,
  pc09EndpointSlug,
  seedPc09Business,
  type Pc09Cohort,
} from './helpers/profile-control-plane-harness';
import { withScratchDatabase, type ScratchDatabase } from './helpers/scratch-db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { createRegistryService } from '../src/modules/registry/registry';
import { createSubmissionService } from '../src/modules/operations/submission';
import { RETRY_AUTHORIZATION_CODES, retryOperation } from '../src/modules/operations/retry';
import { revokeAllGroupGrantsForApiKey } from '../src/modules/profiles/profile-groups';

/**
 * PC-R03 — retry authorization serialized with revocation.
 *
 * The defect: `retryOperation` reauthorized with plain reads and only then took
 * its write locks, so a `revokeGroupGrant` / global key revoke / endpoint
 * disable could commit between the authorization decision and the INSERT.
 *
 * The fix under test is an ORDER, not a flag: retry takes the same lock prefix
 * every authority writer takes, in the same order —
 *
 *   group root → business selector → key row → grant row → operation/task
 *
 * Each case below holds one of those rows in a second, real connection and
 * proves retry reacts to it. Synchronization is on OBSERVED PostgreSQL state
 * (`pg_stat_activity.wait_event_type = 'Lock'`), never on a sleep: the helper
 * polls until the blocked backend actually reports itself blocked, with a
 * bounded timeout that fails the test rather than racing it.
 *
 * Window-gated: without `DU_LIVE_INFRA=1` every test self-skips.
 */

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('profile-control-plane-retry-concurrency-pg.test.ts: SKIPPED - set DU_LIVE_INFRA=1 with a test PostgreSQL to run.');
}

const ACTION = 'extract' as const;

interface FailedOperation {
  operationId: string;
  rootTaskId: string;
  profileId: string;
}

liveDescribe('PC-R03 retry × revocation lock serialization', () => {
  let scratch: ScratchDatabase;
  let submission: ReturnType<typeof createSubmissionService>;
  let cohort: Pc09Cohort;
  let tenantId: string;
  /** Explicit BEGIN/COMMIT control connections (revokers, holders, observer). */
  let control: Pool;

  const groupId = () => cohort.groupId!;
  const apiKeyId = () => cohort.keys[0]!.apiKeyId;
  const childFor = (action: string) => cohort.children.find((child) => child.action === action)!;

  /** Poll until a backend in THIS database is waiting on a lock for `needle`. */
  async function waitForLockWait(needle: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastSeen = '';
    while (Date.now() < deadline) {
      const observed = await control.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE $1
            AND pid <> pg_backend_pid()`,
        [`%${needle}%`],
      );
      if (observed.rowCount && observed.rowCount > 0) return;
      const active = await control.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()`,
      );
      lastSeen = active.rows.map((row) => row.query.replace(/\s+/g, ' ').slice(0, 120)).join(' | ');
    }
    throw new Error(`timed out waiting for a lock wait matching "${needle}"; active: ${lastSeen}`);
  }

  async function asControl(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await control.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Admit a real operation through the real service, then terminalize it. */
  async function makeFailedOperation(): Promise<FailedOperation> {
    const child = childFor(ACTION);
    const result = await submission.submit({
      tenantId,
      apiKeyId: apiKeyId(),
      businessId: PC09_BUSINESS,
      action: ACTION,
      profileEndpointSlug: child.endpointSlug,
      idempotencyKey: `r03-${randomUUID()}`,
      submission: { input: { note: 'pc-r03' } },
    });
    const operationId = result.operation.id;
    const row = await scratch.db.query<{ root_task_id: string; profile_id: string }>(
      'SELECT root_task_id, profile_id FROM operations WHERE id=$1',
      [operationId],
    );
    await scratch.db.query(
      "UPDATE operations SET state='FAILED', error_code='PROVIDER_ERROR' WHERE id=$1",
      [operationId],
    );
    return {
      operationId,
      rootTaskId: row.rows[0]!.root_task_id,
      profileId: row.rows[0]!.profile_id,
    };
  }

  async function executionRows(operationId: string): Promise<{ operations: number; tasks: number }> {
    const result = await scratch.db.query<{ operations: string; tasks: string }>(
      `SELECT
         (SELECT count(*)::text FROM operations WHERE retry_of=$1) AS operations,
         (SELECT count(*)::text FROM tasks t
            JOIN operations o ON o.id = t.operation_id
           WHERE o.retry_of=$1) AS tasks`,
      [operationId],
    );
    return {
      operations: Number(result.rows[0]!.operations),
      tasks: Number(result.rows[0]!.tasks),
    };
  }

  /** Restore the authority facts each test mutates. */
  async function grantState(state: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await scratch.db.query(
      `UPDATE profile_group_api_keys
          SET state=$2,
              revoked_at = CASE WHEN $2='REVOKED' THEN now() ELSE NULL END,
              revoked_by = CASE WHEN $2='REVOKED' THEN 'pc-r03' ELSE NULL END
        WHERE api_key_id=$1`,
      [apiKeyId(), state],
    );
  }

  async function keyStatus(status: 'ACTIVE' | 'REVOKED'): Promise<void> {
    await scratch.db.query('UPDATE api_keys SET status=$2 WHERE id=$1', [apiKeyId(), status]);
  }

  async function childEnabled(enabled: boolean): Promise<void> {
    const child = childFor(ACTION);
    await scratch.db.query(
      'UPDATE profile_bindings SET enabled=$3 WHERE profile_id=$1 AND revision=$2',
      [child.profileId, child.revision, enabled],
    );
  }

  beforeAll(async () => {
    scratch = await withScratchDatabase({ suite: 'pc-r03-retry' });
    await seedPc09Business(scratch.db, { activeVersion: PC09_VERSION_V2 });
    tenantId = await createPc09Tenant(scratch.db, 'r03');
    cohort = await buildCohortC2(scratch.db, {
      tenantId,
      businessVersion: PC09_VERSION_V2,
      actions: [ACTION],
    });
    const profiles = createProfileService(scratch.db, { cryptoEnv: {} });
    submission = createSubmissionService(scratch.db, createRegistryService(scratch.db), profiles, {});
    control = new Pool({ connectionString: scratch.url, max: 8 });
  }, 300_000);

  afterAll(async () => {
    await control?.end().catch(() => undefined);
    await scratch?.close();
  }, 60_000);

  beforeEach(async () => {
    await grantState('ACTIVE');
    await keyStatus('ACTIVE');
    await childEnabled(true);
  });

  describe('grant revoke', () => {
    test('revoke wins: retry is denied and writes ZERO execution rows', async () => {
      const op = await makeFailedOperation();

      const revoker = await control.connect();
      try {
        await revoker.query('BEGIN');
        // Exactly the first lock `revokeGroupGrant` takes.
        await revoker.query('SELECT group_id FROM profile_groups WHERE group_id=$1 FOR UPDATE', [groupId()]);

        const retry = scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
        // Deterministic barrier: retry must be BLOCKED on the group root.
        await waitForLockWait('SELECT group_id FROM profile_groups WHERE group_id=$1 AND tenant_id=$2 FOR SHARE');

        await revoker.query(
          `UPDATE profile_group_api_keys
              SET state='REVOKED', revoked_at=now(), revoked_by='pc-r03'
            WHERE api_key_id=$1 AND group_id=$2`,
          [apiKeyId(), groupId()],
        );
        await revoker.query('UPDATE profile_groups SET access_version=access_version+1 WHERE group_id=$1', [groupId()]);
        await revoker.query('COMMIT');

        await expect(retry).rejects.toMatchObject({
          status: 409,
          code: RETRY_AUTHORIZATION_CODES.GRANT_REVOKED,
        });
      } finally {
        revoker.release();
      }

      expect(await executionRows(op.operationId)).toEqual({ operations: 0, tasks: 0 });
    });

    test('retry wins: revoke WAITS for the admission transaction, then a later retry is denied', async () => {
      const op = await makeFailedOperation();

      // Park the retry AFTER it has acquired group/key/grant/operation locks but
      // BEFORE it inserts, by holding the root task row it locks last.
      const holder = await control.connect();
      const revoker = await control.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM tasks WHERE id=$1 FOR UPDATE', [op.rootTaskId]);

        const retry = scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
        await waitForLockWait('FROM tasks WHERE id=$1 FOR UPDATE');

        // The retry now holds the group root FOR SHARE; escalate to the writer
        // lock the revoke needs and prove it cannot get it yet.
        await revoker.query('BEGIN');
        const revokeLock = revoker.query(
          'SELECT group_id FROM profile_groups WHERE group_id=$1 FOR UPDATE',
          [groupId()],
        );
        await waitForLockWait('SELECT group_id FROM profile_groups WHERE group_id=$1 FOR UPDATE');

        // Release the retry: it commits its admission while still holding the
        // group root, and only then can the revoke acquire it.
        await holder.query('COMMIT');
        const admitted = await retry;
        expect(admitted.replayed).toBe(false);
        await revokeLock;

        await revoker.query(
          `UPDATE profile_group_api_keys
              SET state='REVOKED', revoked_at=now(), revoked_by='pc-r03'
            WHERE api_key_id=$1 AND group_id=$2`,
          [apiKeyId(), groupId()],
        );
        await revoker.query('UPDATE profile_groups SET access_version=access_version+1 WHERE group_id=$1', [groupId()]);
        await revoker.query('COMMIT');

        const rows = await executionRows(op.operationId);
        expect(rows.operations).toBe(1);
        expect(rows.tasks).toBe(1);

        await expect(scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId)))
          .rejects.toMatchObject({ status: 409, code: RETRY_AUTHORIZATION_CODES.GRANT_REVOKED });
        expect(await executionRows(op.operationId)).toEqual({ operations: 1, tasks: 1 });
      } finally {
        holder.release();
        revoker.release();
      }
    });
  });

  describe('global key revoke', () => {
    test('revoke wins: the key row and the grant are tombstoned under the group lock, retry is denied', async () => {
      const op = await makeFailedOperation();

      const revoker = await control.connect();
      try {
        await revoker.query('BEGIN');
        // PC-04's order: the grant seam locks the group roots first.
        await revokeAllGroupGrantsForApiKey(
          revoker,
          apiKeyId(),
          tenantId,
          { actor: 'pc-r03', role: 'admin' },
        );
        await revoker.query(
          "UPDATE api_keys SET status='REVOKED', version=version+1 WHERE id=$1",
          [apiKeyId()],
        );

        const retry = scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
        await waitForLockWait('SELECT group_id FROM profile_groups WHERE group_id=$1 AND tenant_id=$2 FOR SHARE');
        await revoker.query('COMMIT');

        await expect(retry).rejects.toMatchObject({
          status: 409,
          code: RETRY_AUTHORIZATION_CODES.API_KEY_REVOKED,
        });
      } finally {
        revoker.release();
      }

      expect(await executionRows(op.operationId)).toEqual({ operations: 0, tasks: 0 });
    });
  });

  describe('endpoint disable', () => {
    test('a config write under the group lock makes the retry deny with ENDPOINT_DISABLED', async () => {
      const op = await makeFailedOperation();
      const child = childFor(ACTION);

      const writer = await control.connect();
      try {
        await writer.query('BEGIN');
        await writer.query('SELECT group_id FROM profile_groups WHERE group_id=$1 FOR UPDATE', [groupId()]);
        await writer.query(
          'UPDATE profile_bindings SET enabled=false WHERE profile_id=$1 AND revision=$2',
          [child.profileId, child.revision],
        );
        await writer.query('UPDATE profile_groups SET access_version=access_version+1 WHERE group_id=$1', [groupId()]);

        const retry = scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
        await waitForLockWait('SELECT group_id FROM profile_groups WHERE group_id=$1 AND tenant_id=$2 FOR SHARE');
        await writer.query('COMMIT');

        await expect(retry).rejects.toMatchObject({
          status: 409,
          code: RETRY_AUTHORIZATION_CODES.ENDPOINT_DISABLED,
        });
      } finally {
        writer.release();
      }

      expect(await executionRows(op.operationId)).toEqual({ operations: 0, tasks: 0 });
    });
  });

  describe('coalesced replay', () => {
    test('a sibling is replayed only while the caller is still authorized', async () => {
      const op = await makeFailedOperation();

      const first = await scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
      expect(first.replayed).toBe(false);
      expect(await executionRows(op.operationId)).toEqual({ operations: 1, tasks: 1 });

      // Still authorized: the double click is coalesced, not duplicated.
      const replay = await scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId));
      expect(replay).toMatchObject({ replayed: true, operationId: first.operationId });
      expect(await executionRows(op.operationId)).toEqual({ operations: 1, tasks: 1 });

      // Revoked: the caller may no longer even OBSERVE the sibling. Before the
      // fix this path returned the replay from an unlocked read.
      await grantState('REVOKED');
      await expect(scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId)))
        .rejects.toMatchObject({ status: 409, code: RETRY_AUTHORIZATION_CODES.GRANT_REVOKED });
      expect(await executionRows(op.operationId)).toEqual({ operations: 1, tasks: 1 });
    });
  });

  describe('deadlock probe', () => {
    test('concurrent retries and revokes never deadlock and never write twice', async () => {
      const op = await makeFailedOperation();
      const outcomes: string[] = [];
      for (let iteration = 0; iteration < 4; iteration += 1) {
        await grantState('ACTIVE');
        const retry = scratch.db.tx((client) => retryOperation(client, op.operationId, tenantId))
          .then(() => 'retry-ok')
          .catch((error: unknown) => `retry:${(error as { code?: string }).code ?? 'error'}`);
        const revoke = (async () => {
          const client = await control.connect();
          try {
            await client.query('BEGIN');
            await revokeAllGroupGrantsForApiKey(client, apiKeyId(), tenantId, { actor: 'pc-r03', role: 'admin' });
            await client.query('COMMIT');
            return 'revoke-ok';
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            return `revoke:${(error as { code?: string }).code ?? 'error'}`;
          } finally {
            client.release();
          }
        })();
        outcomes.push(...(await Promise.all([retry, revoke])));
      }
      // 40P01 is PostgreSQL deadlock_detected. A denied retry is a legitimate
      // interleaving; a deadlock is not.
      expect(outcomes.filter((outcome) => outcome.includes('40P01'))).toEqual([]);
      // Whatever the interleaving, coalescing holds: at most one execution.
      expect((await executionRows(op.operationId)).operations).toBeLessThanOrEqual(1);
    });
  });
});
