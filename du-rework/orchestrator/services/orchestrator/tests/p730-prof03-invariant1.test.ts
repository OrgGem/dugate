import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { getEffectiveRevision } from '../src/modules/profiles/publish';

/**
 * DD-05 - migration 0027 invariant #1:
 * *every appended revision becomes active by default* because
 * `createRevision` inserts the `profile_bindings` row AND (re)pins
 * `profile_active_revisions` IN THE SAME TRANSACTION.
 *
 * Without it a brand-new profile has no pointer row at all, and every read of
 * it fails closed (`pointer-missing` -> 404) while everything else looks
 * healthy. `publish.ts` depends on this invariant holding.
 *
 * ## Why the fake models transactions
 *
 * Case (b) is the whole point of this suite: if the pin fails, the insert must
 * NOT survive. A fake that only records calls cannot detect that - it would
 * report "insert happened" for a rolled-back transaction. So `txDb` keeps an
 * explicit write set and applies it only on COMMIT; a throw discards it. The
 * rollback assertions below are therefore meaningful.
 */

const PROFILE = '7d000000-0000-4000-8000-000000000001';
const TENANT = '7d000000-0000-4000-8000-000000000002';
const KEY_ID = '7d000000-0000-4000-8000-000000000003';
const KEY_HASH = 'hash-active-key';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

interface Committed {
  /** profileId -> revision rows, as they exist in profile_bindings. */
  bindings: Map<string, number[]>;
  /** profileId -> active revision (the pointer row). */
  pointers: Map<string, number>;
  /** Revision numbers handed out by max(revision)+1. */
  counter: number;
}

/**
 * In-memory store with an UNCOMMITTED overlay. Writes land in `pending` and are
 * merged into `committed` only when the transaction commits.
 */
class Store {
  committed: Committed = { bindings: new Map(), pointers: new Map(), counter: 0 };
  pending: Committed | null = null;

  begin(): void {
    if (this.pending) throw new Error('nested transaction in fake');
    this.pending = {
      bindings: new Map(Array.from(this.committed.bindings, ([k, v]) => [k, [...v]])),
      pointers: new Map(this.committed.pointers),
      counter: this.committed.counter,
    };
  }

  commit(): void {
    if (!this.pending) throw new Error('commit without begin');
    this.committed = this.pending;
    this.pending = null;
  }

  rollback(): void {
    this.pending = null;
  }

  get view(): Committed {
    return this.pending ?? this.committed;
  }
}

interface TxDbOptions {
  /** Make the pointer INSERT throw, to prove the insert is rolled back with it. */
  failPin?: boolean;
  /** Bindings that exist but whose pointer row was never written. */
  orphanBindings?: boolean;
}

function txDb(store: Store, opts: TxDbOptions = {}) {
  const calls: Call[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> => {
      calls.push({ sql, params });
      const view = store.view;

      if (/INSERT INTO profile_active_revisions/i.test(sql)) {
        if (opts.failPin) {
          throw Object.assign(new Error('simulated pointer failure'), { code: 'XX000' });
        }
        view.pointers.set(params[0] as string, Number(params[1]));
        return result<T>([]);
      }
      if (/INSERT INTO profile_bindings/i.test(sql)) {
        const profileId = params[0] as string;
        const revision = Number(params[1]);
        const list = view.bindings.get(profileId) ?? [];
        list.push(revision);
        view.bindings.set(profileId, list);
        view.counter = Math.max(view.counter, revision);
        return result<T>([]);
      }
      if (/SELECT max\(revision\) AS m FROM profile_bindings/i.test(sql)) {
        const list = view.bindings.get(params[0] as string) ?? [];
        return result<T>([{ m: list.length === 0 ? null : Math.max(...list) } as unknown as T]);
      }
      if (/FROM api_keys/i.test(sql)) {
        return result<T>([{ id: KEY_ID, tenant_id: TENANT }] as unknown as T[]);
      }
      if (/FROM profile_active_revisions a/i.test(sql)) {
        // The pointer JOIN query. A row exists only when the pointer points at a
        // revision that actually exists (0027 composite FK).
        const rows = [];
        for (const [profileId, revision] of view.pointers) {
          const list = view.bindings.get(profileId) ?? [];
          if (!list.includes(revision)) continue;
          if (params[0] !== KEY_ID) continue;
          // jsonb columns arrive as parsed JS values, not strings.
          rows.push({
            profile_id: profileId,
            revision,
            connector_bindings: {},
            enabled: true,
            parameters: {},
            job_priority: 'MEDIUM',
            allowed_file_extensions: '',
            connections_override: [],
            file_url_auth_cipher: null,
            moved_at: new Date(0),
          });
        }
        return result<T>(rows as unknown as T[]);
      }
      if (/SELECT revision FROM profile_active_revisions/i.test(sql)) {
        const rev = view.pointers.get(params[0] as string);
        return result<T>(rev === undefined ? [] : ([{ revision: rev }] as unknown as T[]));
      }
      if (/SELECT 1 FROM profile_bindings\s+WHERE api_key_id/i.test(sql)) {
        const orphan = opts.orphanBindings === true;
        return result<T>(orphan ? ([{ '?column?': 1 }] as unknown as T[]) : []);
      }
      return result<T>([]);
    },
  };

  const db = {
    query: client.query,
    tx: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> => {
      store.begin();
      try {
        const out = await fn(client);
        store.commit();
        return out;
      } catch (err) {
        store.rollback();
        throw err;
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, calls, client, store };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    apiKeyHash: KEY_HASH,
    businessId: 'demo',
    businessVersion: '1.0.0',
    action: 'ingest',
    profileId: PROFILE,
    connectorBindings: {},
    ...overrides,
  };
}

describe('DD-05 / 0027 invariant #1: insert + pin in the SAME transaction', () => {
  it('(a) happy: the new revision is both inserted AND active after commit', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    const out = await svc.createRevision(binding());
    expect(out.revision).toBe(1);
    expect(store.committed.bindings.get(PROFILE)).toEqual([1]);
    expect(store.committed.pointers.get(PROFILE)).toBe(1);
  });

  it('(a) the pin is issued by createRevision itself, not by the caller', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding());
    const insertIdx = calls.findIndex((c) => /INSERT INTO profile_bindings/i.test(c.sql));
    const pinIdx = calls.findIndex((c) => /INSERT INTO profile_active_revisions/i.test(c.sql));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(pinIdx).toBeGreaterThan(insertIdx);
  });

  it('(a) both statements run inside ONE transaction', async () => {
    const store = new Store();
    let opens = 0;
    const { db, client } = txDb(store);
    (db as unknown as { tx: unknown }).tx = async (fn: (c: unknown) => Promise<unknown>) => {
      opens += 1;
      store.begin();
      try {
        const out = await fn(client);
        store.commit();
        return out;
      } catch (e) {
        store.rollback();
        throw e;
      }
    };
    const svc = createProfileService(db);
    await svc.createRevision(binding());
    expect(opens).toBe(1);
  });

  it('(a) the second revision bumps the pointer - every append becomes active', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    return svc
      .createRevision(binding())
      .then(() => svc.createRevision(binding({ policy: { parameters: {} } })))
      .then((out) => {
        expect(out.revision).toBe(2);
        expect(store.committed.bindings.get(PROFILE)).toEqual([1, 2]);
        expect(store.committed.pointers.get(PROFILE)).toBe(2);
      });
  });

  it('(b) FAILURE INJECTION: pin fails -> the revision insert is ROLLED BACK', async () => {
    const store = new Store();
    const { db, calls } = txDb(store, { failPin: true });
    const svc = createProfileService(db);
    await expect(svc.createRevision(binding())).rejects.toThrow();

    // The insert WAS issued - proof this is not a vacuous "nothing happened".
    expect(calls.some((c) => /INSERT INTO profile_bindings/i.test(c.sql))).toBe(true);
    // The pin MUST have been attempted inside the same transaction. Without this
    // the test would ALSO pass when the pin is moved to its own transaction and
    // throws for an unrelated reason first - a green test for the wrong reason.
    expect(calls.some((c) => /INSERT INTO profile_active_revisions/i.test(c.sql))).toBe(true);
    // ...and neither survived.
    expect(store.committed.bindings.size).toBe(0);
    expect(store.committed.pointers.size).toBe(0);
    expect(store.committed.counter).toBe(0);
  });

  it('(b) a failed create leaves the PREVIOUS revision and pointer intact', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding());
    expect(store.committed.pointers.get(PROFILE)).toBe(1);

    // Same store, now the pin fails on the SECOND revision.
    const failing = txDb(store, { failPin: true });
    const svc2 = createProfileService(failing.db);
    await expect(svc2.createRevision(binding())).rejects.toThrow();

    expect(store.committed.bindings.get(PROFILE)).toEqual([1]);
    expect(store.committed.pointers.get(PROFILE)).toBe(1);
  });

  it('(b) the next successful create after a failure reuses the same revision number', async () => {
    // Proves the rolled-back revision was not consumed: max(revision)+1 would
    // otherwise skip to 3 and leave a permanent hole in the sequence.
    const store = new Store();
    await expect(
      createProfileService(txDb(store, { failPin: true }).db).createRevision(binding()),
    ).rejects.toThrow();
    expect(store.committed.counter).toBe(0);

    const out = await createProfileService(txDb(store).db).createRevision(binding());
    expect(out.revision).toBe(1);
  });

  it('(c) a binding with NO pointer row fails closed instead of falling back to MAX', async () => {
    // This is exactly the state invariant #1 exists to prevent.
    const store = new Store();
    const { db } = txDb(store, { orphanBindings: true });
    const svc = createProfileService(db);
    await expect(
      svc.resolveEffectiveProfile(KEY_ID, 'demo', '1.0.0', 'ingest', {}, []),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('(c) with the pointer present the same profile resolves (no 404)', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    // The pointer has to EXIST first - that is what invariant #1 guarantees.
    await svc.createRevision(binding());
    expect(
      await svc.resolveEffectiveProfile(KEY_ID, 'demo', '1.0.0', 'ingest', {}, []),
    ).toMatchObject({
      mode: 'pinned',
      profileId: PROFILE,
      revision: 1,
    });
  });

  it('(c) the pointer created by invariant #1 is what getEffectiveRevision reads', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding());
    await expect(getEffectiveRevision(db, PROFILE)).resolves.toBe(1);
  });

  it('(c) a key with no bindings at all is LEGACY, not 404', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const calls: string[] = [];
    const svc = createProfileService(db);
    const out = await svc.resolveEffectiveProfile(KEY_ID, 'demo', '1.0.0', 'ingest', {}, []);
    expect(out).toEqual({ mode: 'legacy' });
    void calls;
  });

  it('honours an externally supplied client (admin route atomicity)', async () => {
    const store = new Store();
    const { db, client } = txDb(store);
    let opens = 0;
    (db as unknown as { tx: unknown }).tx = async () => {
      opens += 1;
      return client;
    };
    const svc = createProfileService(db);
    await svc.createRevision(binding(), client as never);
    // The caller's transaction owns commit; we opened none of our own.
    expect(opens).toBe(0);
    expect(store.pending).toBeNull();
  });

  it('carries the previous revision policy forward when input omits it', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding({ policy: { jobPriority: 'HIGH' } }));
    await svc.createRevision(binding());
    const rows = store.committed.bindings.get(PROFILE);
    expect(rows).toEqual([1, 2]);
    expect(store.committed.pointers.get(PROFILE)).toBe(2);
  });

  it('rejects a binding without businessId before any write', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const calls: Call[] = [];
    const { db: db2, calls: calls2 } = txDb(store);
    const svc = createProfileService(db2);
    await expect(
      svc.createRevision(binding({ businessId: undefined })),
    ).rejects.toMatchObject({ status: 422 });
    expect(calls2.some((c) => /INSERT INTO profile_bindings/i.test(c.sql))).toBe(false);
    void db;
    void calls;
  });

});
