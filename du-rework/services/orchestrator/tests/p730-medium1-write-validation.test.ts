import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';
import { HttpError } from '../src/http/errors';
import {
  PROFILE_PARAMETER_MAX_KEYS,
  PROFILE_PARAMETER_MAX_VALUE_LENGTH,
} from '../src/modules/profiles/policy';

/**
 * P745 / MEDIUM-1 A-lite - the write path.
 *
 * The rule under test: a bad `parameters` payload must be refused BEFORE any
 * row is written, and what a good one stores must read back unchanged.
 *
 * `store` mirrors the DD-05 fake's shape (committed vs pending) so "0 rows"
 * means "0 rows after rollback", not "0 rows recorded". Without that split a
 * rejection test would pass even if the INSERT had already been applied - it
 * would only be checking the message, not the absence of the write.
 *
 * The `INSERT INTO profile_bindings` params are asserted directly for the
 * admin-trusted pin: index 9 is `JSON.stringify(parameters)`.
 */

const PROFILE = '7d000000-0000-4000-8000-000000000001';
const TENANT = '7d000000-0000-4000-8000-000000000002';
const KEY_ID = '7d000000-0000-4000-8000-000000000003';
const KEY_HASH = 'hash-active-key';
const SENTINEL = 'sk-live-7f3a9c1e5b2d8f4a6c0e1d2b3a4f5e6d';

interface StoredRevision {
  revision: number;
  parameters: unknown;
  enabled: boolean;
  job_priority: string;
  allowed_file_extensions: string;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
}

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

type Call = { sql: string; params: unknown[] };

class Store {
  committed: StoredRevision[] = [];
  pending: StoredRevision[] | null = null;
  committedPointers = new Map<string, number>();

  begin(): void {
    if (this.pending) throw new Error('nested transaction in fake');
    this.pending = [...this.committed];
  }
  commit(): void {
    if (!this.pending) throw new Error('commit without begin');
    this.committed = this.pending;
    this.pending = null;
  }
  rollback(): void {
    this.pending = null;
  }
  get view(): StoredRevision[] {
    return this.pending ?? this.committed;
  }
}

function txDb(store: Store) {
  const calls: Call[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ): Promise<QueryResult<T>> => {
      calls.push({ sql, params });
      const view = store.view;

      if (/INSERT INTO profile_active_revisions/i.test(sql)) {
        store.committedPointers.set(params[0] as string, Number(params[1]));
        return result<T>([]);
      }
      if (/INSERT INTO profile_bindings/i.test(sql)) {
        view.push({
          revision: Number(params[1]),
          // index 9 = JSON.stringify(parameters)
          parameters: JSON.parse(params[9] as string),
          enabled: params[8] as boolean,
          job_priority: params[10] as string,
          allowed_file_extensions: params[11] as string,
          connections_override: JSON.parse(params[13] as string),
          file_url_auth_cipher: params[12] as string | null,
        });
        return result<T>([]);
      }
      if (/SELECT max\(revision\) AS m/i.test(sql)) {
        const m = view.length === 0 ? null : Math.max(...view.map((r) => r.revision));
        return result<T>([{ m } as unknown as T]);
      }
      if (/FROM api_keys/i.test(sql)) {
        return result<T>([{ id: KEY_ID, tenant_id: TENANT }] as unknown as T[]);
      }
      if (/FROM profile_bindings/i.test(sql)) {
        // The carry-forward read: (profile_id, revision = previous).
        const want = Number(params[1]);
        const hit = view.find((r) => r.revision === want);
        return result<T>(hit ? ([hit] as unknown as T[]) : []);
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

  return { db, calls };
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

function status(err: unknown): number {
  return err instanceof HttpError ? err.status : -1;
}

function code(err: unknown): string {
  return err instanceof HttpError ? err.code : '';
}

function insertIssued(calls: Call[]): boolean {
  return calls.some((c) => /INSERT INTO profile_bindings/i.test(c.sql));
}

describe('P745 MEDIUM-1 A-lite: createRevision write validation', () => {
  it('accepts a well-formed parameters map', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    const out = await svc.createRevision(binding({ policy: { parameters: { a: { value: 1 } } } }));
    expect(out.revision).toBe(1);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]!.parameters).toEqual({ a: { value: 1 } });
  });

  it('refuses a reserved __proto__ key BEFORE the INSERT (422, 0 rows)', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    let err: unknown;
    try {
      await svc.createRevision(
        binding({ policy: { parameters: JSON.parse('{"__proto__":{"value":1}}') } })
      );
    } catch (e) { err = e; }
    expect(status(err)).toBe(422);
    expect(code(err)).toBe('INVALID_SCHEMA');
    // Not merely rolled back - never issued at all.
    expect(insertIssued(calls)).toBe(false);
    expect(store.committed).toHaveLength(0);
    expect(store.pending).toBeNull();
  });

  it('refuses a key over the cap BEFORE the INSERT (422, 0 rows)', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    const parameters: Record<string, unknown> = {};
    for (let i = 0; i < PROFILE_PARAMETER_MAX_KEYS + 1; i++) parameters['k' + i] = { value: i };
    let err: unknown;
    try { await svc.createRevision(binding({ policy: { parameters } })); } catch (e) { err = e; }
    expect(status(err)).toBe(422);
    expect(insertIssued(calls)).toBe(false);
    expect(store.committed).toHaveLength(0);
  });

  it('refuses an oversized value BEFORE the INSERT (422, 0 rows)', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    const parameters = { big: { value: 'x'.repeat(PROFILE_PARAMETER_MAX_VALUE_LENGTH + 1) } };
    let err: unknown;
    try { await svc.createRevision(binding({ policy: { parameters } })); } catch (e) { err = e; }
    expect(status(err)).toBe(422);
    expect(insertIssued(calls)).toBe(false);
    expect(store.committed).toHaveLength(0);
  });

  it('refuses an entry with no `value` BEFORE the INSERT (422, 0 rows)', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    let err: unknown;
    try {
      await svc.createRevision(binding({ policy: { parameters: { bad: { isLocked: true } } } }));
    } catch (e) { err = e; }
    expect(status(err)).toBe(422);
    expect(insertIssued(calls)).toBe(false);
    expect(store.committed).toHaveLength(0);
  });

  it('keeps the legacy `parameters: null` gesture working (stored as {})', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    const out = await svc.createRevision(binding({ policy: { parameters: null } }));
    expect(out.revision).toBe(1);
    expect(store.committed[0]!.parameters).toEqual({});
  });

  it('carries a previous revision forward when parameters is absent', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding({ policy: { parameters: { a: { value: 'kept' } } } }));
    // Second revision does NOT resend parameters.
    const second = await svc.createRevision(binding({ policy: { enabled: true } }));
    expect(second.revision).toBe(2);
    expect(store.committed[1]!.parameters).toEqual({ a: { value: 'kept' } });
  });

  it('a carried-forward legacy shape is NOT re-validated (read tolerance preserved)', async () => {
    const store = new Store();
    // Simulate a legacy row the strict shape would reject: entry with no `value`.
    store.committed.push({
      revision: 1,
      parameters: { legacy: { isLocked: true } },
      enabled: true,
      job_priority: 'MEDIUM',
      allowed_file_extensions: '',
      connections_override: [],
      file_url_auth_cipher: null,
    });
    const { db } = txDb(store);
    const svc = createProfileService(db);
    const out = await svc.createRevision(binding({ policy: { enabled: true } }));
    expect(out.revision).toBe(2);
    expect(store.committed[1]!.parameters).toEqual({ legacy: { isLocked: true } });
  });

  it('ADMIN-TRUSTED PIN: a sentinel secret is stored verbatim, unredacted', async () => {
    const store = new Store();
    const { db, calls } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding({ policy: { parameters: { apiKey: { value: SENTINEL } } } }));
    const insert = calls.find((c) => /INSERT INTO profile_bindings/i.test(c.sql));
    expect(insert).toBeDefined();
    const stored = JSON.parse(insert!.params[9] as string) as Record<string, { value: string }>;
    expect(stored.apiKey?.value).toBe(SENTINEL);
    expect(insert!.params[9] as string).not.toMatch(/redacted|scrubbed/);
  });

  it('write/read agreement: what is stored reads back unchanged', async () => {
    const store = new Store();
    const { db } = txDb(store);
    const svc = createProfileService(db);
    await svc.createRevision(binding({ policy: { parameters: { a: { value: 7, isLocked: true } } } }));
    expect(store.committed[0]!.parameters).toEqual({ a: { value: 7, isLocked: true } });
  });
});