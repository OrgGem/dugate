import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import {
  createProfileRevisionService,
  getEffectiveRevision,
  isUnknownRevisionError,
  pinActiveRevision,
  REVISION_CONFLICT,
  type ProfileRevisionService,
} from '../src/modules/profiles/publish';

/**
 * T-PROF-03 CLOSURE - publish / rollback / CAS evidence for the
 * `profile_active_revisions` pointer (migration 0027).
 *
 * This module was written at 15:27 and had NEVER been exercised by a test:
 * the only grep hit in `tests/` was `aweb04-bff-profiles.test.ts`, which stops
 * at the BFF wire and never calls `publish.ts`. So every invariant below is
 * newly proven here, not re-confirmed.
 *
 * ## What this suite can and cannot prove
 *
 * It CAN prove the code's decision logic (CAS compare, target resolution,
 * which SQL is issued, that `profile_bindings` is never written) and that the
 * code TAKES a `FOR UPDATE` lock before reading the pointer.
 *
 * It CANNOT prove real PostgreSQL serialization. A fake lock models what the
 * code requests; it does not model MVCC, EvalPlanQual re-read, or the
 * unique-index wait that a real concurrent insert takes. That half is a live
 * window item and is recorded as such in the receipt.
 */

const PROFILE = '7c000000-0000-4000-8000-000000000001';
const OTHER = '7c000000-0000-4000-8000-000000000002';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

interface FakeState {
  /** profileId -> active revision (the pointer row). Absent = no pointer row. */
  pointers: Map<string, number>;
  /** profileId -> every revision that exists in profile_bindings. */
  revisions: Map<string, number[]>;
  /** Set when a statement targets profile_bindings for a WRITE. */
  wroteBindings: boolean;
  /** Profile ids whose pointer row is currently held under FOR UPDATE. */
  locked: Set<string>;
}

function fakeDb(state: FakeState) {
  const calls: Call[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> => {
      calls.push({ sql, params });
      const profileId = params[0] as string;

      if (/INSERT\s+INTO\s+profile_active_revisions/i.test(sql)) {
        state.pointers.set(profileId, Number(params[1]));
        return result<T>([]);
      }
      if (/SELECT\s+max\(revision\)/i.test(sql)) {
        const list = state.revisions.get(profileId) ?? [];
        const m = list.length === 0 ? null : Math.max(...list);
        return result<T>([{ m } as unknown as T]);
      }
      if (/FROM\s+profile_active_revisions/i.test(sql)) {
        const has = state.pointers.has(profileId);
        if (/FOR\s+UPDATE/i.test(sql)) state.locked.add(profileId);
        const revision = state.pointers.get(profileId);
        return result<T>(has ? ([{ revision }] as unknown as T[]) : []);
      }
      if (/INSERT\s+INTO\s+profile_bindings/i.test(sql) || /UPDATE\s+profile_bindings/i.test(sql)) {
        state.wroteBindings = true;
        return result<T>([]);
      }
      return result<T>([]);
    },
  };

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) =>
      client.query<T>(sql, params),
    tx: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> => fn(client),
    close: async () => undefined,
  } as unknown as Db;

  return { db, calls, client, state };
}

function stateWith(pointers: Array<[string, number]>, revisions: Array<[string, number[]]>): FakeState {
  return {
    pointers: new Map(pointers),
    revisions: new Map(revisions),
    wroteBindings: false,
    locked: new Set(),
  };
}

describe('T-PROF-03 publish moves the pointer under a CAS guard', () => {
  it('publish activates the newest revision and returns it', async () => {
    const state = stateWith([[PROFILE, 4]], [[PROFILE, [4, 5, 6]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    const at = await svc.publishRevision({ profileId: PROFILE, expectedRevision: 4 });
    expect(at).toBe(6);
    expect(state.pointers.get(PROFILE)).toBe(6);
  });

  it('publish on an already-current pointer is a no-op that still succeeds', async () => {
    // createRevision pins the new revision in the same transaction (0027
    // invariant #1), so the common publish is at max already.
    const state = stateWith([[PROFILE, 7]], [[PROFILE, [7]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.publishRevision({ profileId: PROFILE, expectedRevision: 7 })).resolves.toBe(7);
    expect(state.pointers.get(PROFILE)).toBe(7);
  });

  it('a stale expectedRevision is 409 REVISION_CONFLICT and does NOT move the pointer', async () => {
    const state = stateWith([[PROFILE, 9]], [[PROFILE, [9, 10]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.publishRevision({ profileId: PROFILE, expectedRevision: 4 })).rejects.toMatchObject({
      status: 409,
      code: REVISION_CONFLICT,
    });
    expect(state.pointers.get(PROFILE)).toBe(9);
  });

  it('expectedRevision against a profile with NO pointer row is 409, not a guess', async () => {
    // 0027 invariant #3: pointer missing <=> no revisions. The code must not
    // treat a missing pointer as revision 0 and proceed.
    const state = stateWith([], [[PROFILE, [1, 2]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.publishRevision({ profileId: PROFILE, expectedRevision: 0 })).rejects.toMatchObject({
      status: 409,
      code: REVISION_CONFLICT,
    });
    expect(state.pointers.has(PROFILE)).toBe(false);
  });

  it('publish with no pointer row and no revisions is 409, NOT 404 - the CAS guard runs first', async () => {
    // The guard is checked before any target resolution, so the loser of a race
    // gets "retry" (409) rather than "this profile is empty" (404). That is the
    // right precedence: a stale operator must not be told the profile is empty.
    const state = stateWith([], []);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.publishRevision({ profileId: PROFILE, expectedRevision: 1 })).rejects.toMatchObject({
      status: 409,
      code: REVISION_CONFLICT,
    });
  });

  it('the 404 no-revisions branch is UNREACHABLE through the public service', async () => {
    // Recorded as a finding, not asserted as desired behaviour. `moveActiveRevision`
    // throws 404 when the resolved target is NULL, but:
    //   * publishRevision ALWAYS passes expectedRevision (type-enforced), so the CAS
    //     must match an existing pointer row first;
    //   * a pointer row implies a referenced profile_bindings row via the 0027
    //     composite FK, so MAX(revision) can never be NULL at that point;
    //   * rollbackTo ALWAYS passes targetRevision, so the MAX() path is not taken.
    // Hence both public entry points short-circuit before the 404. This test
    // pins the observable consequence: neither entry point can produce a 404.
    const empty = stateWith([], []);
    const dbA = fakeDb(empty);
    const svcA = createProfileRevisionService(dbA.db);
    const publishErr = await svcA
      .publishRevision({ profileId: PROFILE, expectedRevision: 1 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect((publishErr as HttpError).status).toBe(409);

    const missingTarget = stateWith([[PROFILE, 1]], []);
    const dbB = fakeDb(missingTarget);
    const svcB = createProfileRevisionService(dbB.db);
    const rollbackErr = await svcB
      .rollbackTo({ profileId: PROFILE, targetRevision: 1, expectedRevision: 1 })
      .then(() => null)
      .catch((e: unknown) => e);
    // targetRevision is explicit, so the MAX() lookup never runs and the move
    // proceeds - the 404 is skipped entirely.
    expect(rollbackErr).toBeNull();
    expect(missingTarget.pointers.get(PROFILE)).toBe(1);
  });

  it('publish NEVER writes profile_bindings (0027 invariant #2)', async () => {
    const state = stateWith([[PROFILE, 2]], [[PROFILE, [2, 3]]]);
    const { db, calls } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 2 });
    expect(state.wroteBindings).toBe(false);
    expect(calls.some((c) => /INSERT INTO profile_bindings|UPDATE profile_bindings/i.test(c.sql))).toBe(false);
  });

  it('the pointer is read FOR UPDATE before the CAS compare', async () => {
    const state = stateWith([[PROFILE, 1]], [[PROFILE, [1, 2]]]);
    const { db, calls } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 1 });
    const lockRead = calls.find((c) => /FOR UPDATE/i.test(c.sql));
    expect(lockRead).toBeDefined();
    expect(lockRead!.params).toEqual([PROFILE]);
    expect(state.locked.has(PROFILE)).toBe(true);
  });

  it('the CAS read happens BEFORE the pin write', async () => {
    // Ordering is the whole guard: compare against the locked value, then write.
    const state = stateWith([[PROFILE, 1]], [[PROFILE, [1, 2]]]);
    const { db, calls } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 1 });
    const lockIdx = calls.findIndex((c) => /FOR UPDATE/i.test(c.sql));
    const pinIdx = calls.findIndex((c) => /INSERT INTO profile_active_revisions/i.test(c.sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(pinIdx).toBeGreaterThan(lockIdx);
  });

});

describe('T-PROF-03 rollback re-points without touching the target row', () => {
  it('rollback moves the pointer back to an older revision', async () => {
    const state = stateWith([[PROFILE, 6]], [[PROFILE, [3, 4, 5, 6]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    const at = await svc.rollbackTo({ profileId: PROFILE, targetRevision: 3, expectedRevision: 6 });
    expect(at).toBe(3);
    expect(state.pointers.get(PROFILE)).toBe(3);
  });

  it('rollback leaves every profile_bindings revision in place (byte-identical target)', async () => {
    const state = stateWith([[PROFILE, 6]], [[PROFILE, [3, 4, 5, 6]]]);
    const { db, calls } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await svc.rollbackTo({ profileId: PROFILE, targetRevision: 3, expectedRevision: 6 });
    expect(state.revisions.get(PROFILE)).toEqual([3, 4, 5, 6]);
    expect(state.wroteBindings).toBe(false);
    expect(calls.some((c) => /INSERT INTO profile_bindings|UPDATE profile_bindings|DELETE FROM profile_bindings/i.test(c.sql))).toBe(false);
  });

  it('rollback WITHOUT expectedRevision is allowed (contract makes it optional)', async () => {
    // Deliberate: a rollback is the operator's escape hatch, so the CAS guard
    // is optional there but REQUIRED on publish.
    const state = stateWith([[PROFILE, 6]], [[PROFILE, [3, 6]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.rollbackTo({ profileId: PROFILE, targetRevision: 3 })).resolves.toBe(3);
    expect(state.pointers.get(PROFILE)).toBe(3);
  });

  it('rollback WITH a stale expectedRevision is still 409', async () => {
    const state = stateWith([[PROFILE, 8]], [[PROFILE, [3, 8]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.rollbackTo({ profileId: PROFILE, targetRevision: 3, expectedRevision: 4 })).rejects.toMatchObject({
      status: 409,
      code: REVISION_CONFLICT,
    });
    expect(state.pointers.get(PROFILE)).toBe(8);
  });

  it('rollback forwards too - it is a pointer move, not a decrement', async () => {
    const state = stateWith([[PROFILE, 2]], [[PROFILE, [2, 9]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await expect(svc.rollbackTo({ profileId: PROFILE, targetRevision: 9 })).resolves.toBe(9);
  });

});

describe('T-PROF-03 pointer read never falls back to MAX(revision)', () => {
  it('getEffectiveRevision returns the pointer value', async () => {
    const state = stateWith([[PROFILE, 3]], [[PROFILE, [3, 8, 9]]]);
    const { db } = fakeDb(state);
    await expect(getEffectiveRevision(db, PROFILE)).resolves.toBe(3);
  });

  it('a rolled-back profile still reads the ROLLED-BACK revision, not the newest', async () => {
    // This is the exact failure 0027 invariant #3 forbids: if the read guessed
    // MAX, rollback would silently no-op.
    const state = stateWith([[PROFILE, 2]], [[PROFILE, [2, 7]]]);
    const { db } = fakeDb(state);
    await expect(getEffectiveRevision(db, PROFILE)).resolves.toBe(2);
    expect(state.pointers.get(PROFILE)).not.toBe(7);
  });

  it('null means no pointer row - and it never substitutes a revision', async () => {
    const state = stateWith([], []);
    const { db } = fakeDb(state);
    await expect(getEffectiveRevision(db, PROFILE)).resolves.toBeNull();
  });

  it('the service method delegates to the same reader', async () => {
    const state = stateWith([[PROFILE, 5]], [[PROFILE, [5]]]);
    const { db } = fakeDb(state);
    const svc: ProfileRevisionService = createProfileRevisionService(db);
    await expect(svc.getEffectiveRevision(PROFILE)).resolves.toBe(5);
  });

});

describe('T-PROF-03 pinActiveRevision upsert + error classification', () => {
  it('pinActiveRevision writes the pointer with an upsert, not an insert-or-fail', async () => {
    const state = stateWith([], []);
    const { db, calls, client } = fakeDb(state);
    await pinActiveRevision(client as never, PROFILE, 5);
    const sql = calls[0]!.sql;
    expect(sql).toMatch(/ON CONFLICT \(profile_id\)/i);
    expect(sql).toMatch(/DO UPDATE SET revision = EXCLUDED\.revision/i);
    expect(state.pointers.get(PROFILE)).toBe(5);
    void db;
  });

  it('re-pinning an existing profile updates in place', async () => {
    const state = stateWith([[PROFILE, 1]], []);
    const { client } = fakeDb(state);
    await pinActiveRevision(client as never, PROFILE, 12);
    expect(state.pointers.get(PROFILE)).toBe(12);
  });

  it('a bad rollback target is refused by the FK (23503), not by a read path', async () => {
    // The fake has no FK, so we assert the classifier the route relies on.
    const fk: unknown = Object.assign(new Error('foreign key violation'), { code: '23503' });
    expect(isUnknownRevisionError(fk)).toBe(true);
    const other: unknown = Object.assign(new Error('unique'), { code: '23505' });
    expect(isUnknownRevisionError(other)).toBe(false);
    expect(isUnknownRevisionError(null)).toBe(false);
    expect(isUnknownRevisionError(new Error('boom'))).toBe(false);
  });

  it('isUnknownRevisionError does not swallow our own HttpError', async () => {
    const err = new HttpError(409, REVISION_CONFLICT, 'conflict');
    expect(isUnknownRevisionError(err)).toBe(false);
  });

  it('caller-supplied client is used instead of opening a new transaction', async () => {
    const state = stateWith([[PROFILE, 2]], [[PROFILE, [2, 3]]]);
    const { db, client } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    let openedTx = 0;
    (db as unknown as { tx: () => Promise<unknown> }).tx = async () => {
      openedTx += 1;
      return client;
    };
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 2 }, client as never);
    expect(openedTx).toBe(0);
    expect(state.pointers.get(PROFILE)).toBe(3);
  });

  it('without a client the service opens exactly one transaction', async () => {
    const state = stateWith([[PROFILE, 2]], [[PROFILE, [2, 3]]]);
    const { db, client } = fakeDb(state);
    let openedTx = 0;
    (db as unknown as { tx: unknown }).tx = async (fn: (c: unknown) => Promise<unknown>) => {
      openedTx += 1;
      return fn(client);
    };
    const svc = createProfileRevisionService(db);
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 2 });
    expect(openedTx).toBe(1);
  });

  it('profiles are independent - a move never touches another profile', async () => {
    const state = stateWith([[PROFILE, 1], [OTHER, 5]], [[PROFILE, [1, 2]], [OTHER, [5, 6]]]);
    const { db } = fakeDb(state);
    const svc = createProfileRevisionService(db);
    await svc.publishRevision({ profileId: PROFILE, expectedRevision: 1 });
    expect(state.pointers.get(OTHER)).toBe(5);
    expect(state.revisions.get(OTHER)).toEqual([5, 6]);
  });

});
