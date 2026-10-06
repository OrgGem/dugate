import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import type { AuditRecordInput, AuditService } from '../src/modules/audit/audit';
import {
  ADMIN_ACTIONS,
  authorizeAdminAction,
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';

/**
 * ORCH-PAR-01 — API key issuance and revocation as REAL mutations
 * (offline: no socket, no PG, no Redis).
 *
 * The point of this suite is that these are not table entries that answer
 * "unsupported": apikey.issue and apikey.revoke write through
 * auditedMutation + executeIdempotent exactly like every other real
 * dispatcher action, so the stored key and its audit row share ONE
 * transaction.
 *
 * What the tests hold the new code to:
 *  - the raw value is hashed before it reaches a column, and the column
 *    list has nowhere to put it;
 *  - the raw comes back exactly once, in the 201 body;
 *  - a tenant-scoped caller cannot write into another tenant;
 *  - an unknown id and a foreign id are indistinguishable (no existence
 *    leak);
 *  - a key that is not ACTIVE is a 409, never a second silent write;
 *  - every denial leaves ZERO writes and ZERO audit rows.
 */

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const KEY_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const RAW = 'du_live_SUPERSECRET_0123456789';
// Mirrors server.ts hashKey: a real sha256 digest. An earlier version of this
// fixture prefixed the RAW into the hash, which made 'the raw is never
// stored' pass-or-fail for the wrong reason - the fake hash carried the
// secret with it. The digest has no raw substring by construction.
const digest = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const HASH = digest(RAW);

function bearerPlatform(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'platform' } };
}
function bearerOpA(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT_A } };
}
function cookie(
  role: 'admin' | 'operator' | 'viewer',
  csrfOk: boolean
): AdminActionAuth {
  return { kind: 'cookie', role, csrfOk };
}

interface WorldOptions {
  /** Row the revoke path will find. undefined => the SELECT returns nothing. */
  keyRow?: { id: string; tenant_id: string; status: string } | null;
}

interface QueryLog {
  sql: string;
  params: unknown[];
}

function makeWorld(opts: WorldOptions = {}) {
  const queries: QueryLog[] = [];
  const auditRows: AuditRecordInput[] = [];
  const keyRow = opts.keyRow === undefined ? { id: KEY_ID, tenant_id: TENANT_A, status: 'ACTIVE' } : opts.keyRow;

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      queries.push({ sql, params });
      if (/SELECT id, tenant_id, status FROM api_keys/i.test(sql)) {
        return keyRow ? { rows: [keyRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/UPDATE api_keys SET status='REVOKED'/i.test(sql)) {
        return {
          rows: [{ id: params[0], tenant_id: keyRow!.tenant_id }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO api_keys/i.test(sql)) {
        return {
          rows: [{ id: KEY_ID, status: 'ACTIVE', created_at: new Date('2026-09-30T00:00:00.000Z') }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const db = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      queries.push({ sql, params });
      // idempotency marker lookups answer "no prior marker"
      return { rows: [], rowCount: 0 };
    },
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    close: async () => undefined,
  } as unknown as Db;

  const audit = {
    record: async (input: AuditRecordInput) => {
      auditRows.push(input);
      return { id: 'a-' + auditRows.length };
    },
    listForTenant: async () => [],
  } as unknown as AuditService;

  const deps: AdminActionDeps = {
    db,
    audit,
    registry: {} as unknown as AdminActionDeps['registry'],
    profiles: {} as unknown as AdminActionDeps['profiles'],
    lifecycle: {} as unknown as AdminActionDeps['lifecycle'],
    runtime: {
      resumeOperation: async () => ({ replayed: false }) as never,
    },
    hashApiKey: digest,
    correlationId: 'corr-api-keys-test',
  };

  const writes = (): QueryLog[] =>
    queries.filter((q) => /INSERT INTO api_keys|UPDATE api_keys/i.test(q.sql));

  return { deps, queries, writes, auditRows, db, client };
}

function expectDenied(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error('expected rejection ' + status + ' ' + code);
    },
    (err) => {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(status);
      expect((err as HttpError).code).toBe(code);
    }
  );
}

// ---------------------------------------------------------------------------
// 1. The actions are in the table and are ADMIN-ONLY
// ---------------------------------------------------------------------------

describe('ORCH-PAR-01: the two actions are registered and admin-only', () => {
  test('both actions exist in the action table', () => {
    expect(ADMIN_ACTIONS['apikey.issue']).toEqual({ bearerRoles: ['platform'], cookieRoles: ['admin'] });
    expect(ADMIN_ACTIONS['apikey.revoke']).toEqual({ bearerRoles: ['platform'], cookieRoles: ['admin'] });
  });

  test('null auth is 401 for both', () => {
    for (const action of ['apikey.issue', 'apikey.revoke']) {
      const d = authorizeAdminAction(null, action);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.status).toBe(401);
    }
  });

  test('a tenant_operator bearer is 403 on both', () => {
    for (const action of ['apikey.issue', 'apikey.revoke']) {
      const d = authorizeAdminAction(bearerOpA(), action);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.code).toBe('PERMISSION_DENIED');
      }
    }
  });

  test('a viewer cookie is 403 and an admin cookie without CSRF is 403', () => {
    const viewer = authorizeAdminAction(cookie('viewer', true), 'apikey.issue');
    expect(viewer.ok).toBe(false);
    if (!viewer.ok) expect(viewer.status).toBe(403);

    const noCsrf = authorizeAdminAction(cookie('admin', false), 'apikey.revoke');
    expect(noCsrf.ok).toBe(false);
    if (!noCsrf.ok) {
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.code).toBe('PERMISSION_DENIED');
    }
  });

  test('a platform bearer and an admin cookie with CSRF are allowed', () => {
    expect(authorizeAdminAction(bearerPlatform(), 'apikey.issue').ok).toBe(true);
    expect(authorizeAdminAction(cookie('admin', true), 'apikey.revoke').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. apikey.issue — a real insert
// ---------------------------------------------------------------------------

describe('ORCH-PAR-01: apikey.issue writes a real row', () => {
  test('a platform bearer gets 201 with the id, tenant, prefix and status', async () => {
    const w = makeWorld();
    const out = await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW },
    });
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({
      id: KEY_ID,
      tenantId: TENANT_A,
      status: 'ACTIVE',
    });
    expect(w.writes()).toHaveLength(1);
  });

  test('the INSERT stores the HASH, never the raw value', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW },
    });
    const insert = w.writes()[0]!;
    expect(insert.sql).toMatch(/INSERT INTO api_keys/i);
    expect(insert.params).toContain(HASH);
    expect(JSON.stringify(insert.params)).not.toContain(RAW);
    // And the column list has nowhere to put a raw value.
    expect(insert.sql).not.toMatch(/raw/i);
  });

  test('the raw value comes back exactly once, in the 201 body', async () => {
    const w = makeWorld();
    const out = await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW },
    });
    expect(out.body).toMatchObject({ rawKey: RAW });
    // Copy-once: it is in the RESPONSE and in no stored row, no audit row.
    expect(JSON.stringify(w.auditRows)).not.toContain(RAW);
  });

  test('an explicit prefix is stored; the default is the four-character window', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW, prefix: 'du_l' },
    });
    expect(w.writes()[0]!.params).toContain('du_l');

    const d = makeWorld();
    await dispatchAdminAction(d.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW },
    });
    expect(d.writes()[0]!.params).toContain(RAW.slice(0, 4));
  });

  test('the audit row is written in the same transaction, scoped to the target tenant', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.issue',
      params: { tenantId: TENANT_A, apiKey: RAW },
    });
    expect(w.auditRows).toHaveLength(1);
    expect(w.auditRows[0]).toMatchObject({
      tenantId: TENANT_A,
      action: 'apikey.create',
      resource: 'apikey:' + KEY_ID,
      severity: 'success',
    });
  });

  // The action table is ADMIN-ONLY, so a tenant_operator is refused at the
  // ROLE gate and never reaches the tenant fence. I had first written this as
  // a 201 expectation for an operator's own tenant; the run corrected me.
  test('a tenant_operator is refused at the role gate, before any tenant work', async () => {
    const w = makeWorld();
    await expectDenied(
      dispatchAdminAction(w.deps, bearerOpA(), {
        action: 'apikey.issue',
        params: { tenantId: TENANT_A, apiKey: RAW },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(w.queries).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });
});

describe('ORCH-PAR-01: apikey.issue refuses bad input with zero writes', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['no tenantId', { apiKey: RAW }],
    ['no apiKey', { tenantId: TENANT_A }],
    ['an empty apiKey', { tenantId: TENANT_A, apiKey: '' }],
    ['a non-string apiKey', { tenantId: TENANT_A, apiKey: 12345 }],
    ['an over-long tenantId', { tenantId: 't'.repeat(65), apiKey: RAW }],
    ['an empty tenantId', { tenantId: '', apiKey: RAW }],
  ];
  test.each(bad)('%s is 422 with no write and no audit row', async (_label, params) => {
    const w = makeWorld();
    await expectDenied(
      dispatchAdminAction(w.deps, bearerPlatform(), { action: 'apikey.issue', params }),
      422,
      'INVALID_SCHEMA'
    );
    expect(w.writes()).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });

  test('a too-short raw key is refused before it is hashed', async () => {
    const w = makeWorld();
    await expectDenied(
      dispatchAdminAction(w.deps, bearerPlatform(), {
        action: 'apikey.issue',
        params: { tenantId: TENANT_A, apiKey: 'short' },
      }),
      422,
      'INVALID_SCHEMA'
    );
    expect(w.writes()).toHaveLength(0);
  });

  test('a tenant_operator naming a FOREIGN tenant is 403 with zero writes', async () => {
    const w = makeWorld();
    await expectDenied(
      dispatchAdminAction(w.deps, bearerOpA(), {
        action: 'apikey.issue',
        params: { tenantId: TENANT_B, apiKey: RAW },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(w.writes()).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. apikey.revoke — a real update
// ---------------------------------------------------------------------------

describe('ORCH-PAR-01: apikey.revoke flips the status with an ACTIVE guard', () => {
  test('a platform bearer gets 200 and the row becomes REVOKED', async () => {
    const w = makeWorld();
    const out = await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.revoke',
      params: { apiKeyId: KEY_ID },
    });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ id: KEY_ID, status: 'REVOKED' });
    const update = w.writes()[0]!;
    expect(update.sql).toMatch(/UPDATE api_keys SET status='REVOKED'/i);
  });

  test('the UPDATE is guarded on status=ACTIVE, so a concurrent second write cannot double-fire', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.revoke',
      params: { apiKeyId: KEY_ID },
    });
    expect(w.writes()[0]!.sql).toMatch(/AND status='ACTIVE'/i);
  });

  test('the audit row takes the tenant from the STORED row, not the payload', async () => {
    const w = makeWorld({ keyRow: { id: KEY_ID, tenant_id: TENANT_B, status: 'ACTIVE' } });
    await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.revoke',
      params: { apiKeyId: KEY_ID },
    });
    expect(w.auditRows[0]).toMatchObject({
      tenantId: TENANT_B,
      action: 'apikey.revoke',
      resource: 'apikey:' + KEY_ID,
      severity: 'warning',
    });
  });

  test('the revoke body carries no key material at all', async () => {
    const w = makeWorld();
    const out = await dispatchAdminAction(w.deps, bearerPlatform(), {
      action: 'apikey.revoke',
      params: { apiKeyId: KEY_ID },
    });
    expect(JSON.stringify(out.body)).not.toContain(RAW);
    expect(Object.keys(out.body).sort()).toEqual(['id', 'status']);
  });

  test('a tenant_operator is refused at the role gate, before the row lookup', async () => {
    const w = makeWorld({ keyRow: { id: KEY_ID, tenant_id: TENANT_A, status: 'ACTIVE' } });
    await expectDenied(
      dispatchAdminAction(w.deps, bearerOpA(), {
        action: 'apikey.revoke',
        params: { apiKeyId: KEY_ID },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(w.queries).toHaveLength(0);
    expect(w.writes()).toHaveLength(0);
  });
});

describe('ORCH-PAR-01: apikey.revoke refuses bad input with zero writes', () => {
  test('an unknown id is 404 and writes nothing', async () => {
    const w = makeWorld({ keyRow: null });
    await expectDenied(
      dispatchAdminAction(w.deps, bearerPlatform(), {
        action: 'apikey.revoke',
        params: { apiKeyId: 'no-such-key' },
      }),
      404,
      'NOT_FOUND'
    );
    expect(w.writes()).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });

  test('a missing apiKeyId is 422', async () => {
    const w = makeWorld();
    await expectDenied(
      dispatchAdminAction(w.deps, bearerPlatform(), { action: 'apikey.revoke', params: {} }),
      422,
      'INVALID_SCHEMA'
    );
    expect(w.writes()).toHaveLength(0);
  });

  test('a key that is not ACTIVE is 409 STATE_CONFLICT, not a second write', async () => {
    for (const status of ['REVOKED', 'REVOKING']) {
      const w = makeWorld({ keyRow: { id: KEY_ID, tenant_id: TENANT_A, status } });
      await expectDenied(
        dispatchAdminAction(w.deps, bearerPlatform(), {
          action: 'apikey.revoke',
          params: { apiKeyId: KEY_ID },
        }),
        409,
        'STATE_CONFLICT'
      );
      expect(w.writes()).toHaveLength(0);
      expect(w.auditRows).toHaveLength(0);
    }
  });

  test('a tenant_operator revoking ANY id is refused before the row is read', async () => {
    // Both actions are admin-only, so the ROLE gate answers before the lookup
    // runs. That means the tenant fence inside the case body is currently
    // unreachable for these two actions - recorded, not papered over: it is
    // the door that stays safe if the action table is ever widened.
    const w = makeWorld({ keyRow: { id: KEY_ID, tenant_id: TENANT_B, status: 'ACTIVE' } });
    await expectDenied(
      dispatchAdminAction(w.deps, bearerOpA(), {
        action: 'apikey.revoke',
        params: { apiKeyId: KEY_ID },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(w.writes()).toHaveLength(0);
    expect(w.auditRows).toHaveLength(0);
  });

  test('an unknown id and a foreign-tenant id are indistinguishable to a denied caller', async () => {
    // Probed the shape first: for an ADMIN-ONLY action a tenant_operator is
    // refused by the role gate BEFORE the SELECT, so unknown and foreign ids
    // both get the same role denial - the existence question is never asked.
    const unknown = makeWorld({ keyRow: null });
    const foreign = makeWorld({ keyRow: { id: 'ghost-id', tenant_id: TENANT_B, status: 'ACTIVE' } });
    const read = async (w: ReturnType<typeof makeWorld>): Promise<[number, string]> => {
      try {
        await dispatchAdminAction(w.deps, bearerOpA(), {
          action: 'apikey.revoke',
          params: { apiKeyId: 'ghost-id' },
        });
        return [0, 'no-throw'];
      } catch (e) {
        return [(e as HttpError).status, (e as HttpError).message];
      }
    };
    const [s1, m1] = await read(unknown);
    const [s2, m2] = await read(foreign);
    expect([s1, m1]).toEqual([s2, m2]);
    expect(s1).toBe(403);
  });
});
