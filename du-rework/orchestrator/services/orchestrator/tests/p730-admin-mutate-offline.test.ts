import type { PoolClient } from 'pg';
import { createAuditService } from '../src/modules/audit/audit';
import {
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';
import { createProfileService } from '../src/modules/profiles/profiles';

/**
 * P730-ADMIN-MUTATE / W3 (T-API-02 + T-AUD-01, offline) — the profile.*
 * dispatcher slice driven end-to-end through the REAL gates, leaf, profile
 * service, pointer service and audit service, against a stateful fake Db with
 * journal + rollback semantics (same shape as admin-mutation-atomicity.test.ts,
 * extended with the tables this slice reads/writes: api_keys, profile_names,
 * profile_bindings, profile_active_revisions, admin_audit_events,
 * admin_idempotency).
 *
 * No PG/Redis: offline only. The fake enforces the constraints the real
 * database would: unique profile_names identity, composite pin target
 * (unknown revision -> 23503), and rollback discards every staged write.
 */

interface ApiKeySeed {
  id: string;
  tenant_id: string;
  hash: string;
  status?: string;
}

interface NameRow {
  profile_id: string;
  tenant_id: string;
  api_key_id: string;
  business_id: string;
  business_version: string;
  action: string;
  profile_name: string;
}

interface BindingRow {
  profile_id: string;
  revision: number;
  policy: {
    enabled: boolean;
    parameters: unknown;
    jobPriority: string;
    allowedFileExtensions: string;
    cipher: string | null;
    connectionsOverride: unknown;
  };
}

interface MarkerRow {
  key: string;
  route: string;
  payload_hash: string;
  response_code: number;
  response_body: unknown;
}

interface Attempted {
  sql: string;
  params: unknown[];
  via: 'pool' | 'tx';
}

const TENANT = '10000000-0000-4000-8000-000000000001';
const KEY_ID = '20000000-0000-4000-8000-000000000002';
const KEY_HASH = 'a'.repeat(64);
const KEY2_ID = '30000000-0000-4000-8000-000000000003';
const KEY2_HASH = 'b'.repeat(64);

function makeStatefulDb(seed?: { apiKeys?: ApiKeySeed[] }) {
  const state = {
    apiKeys: (seed?.apiKeys ?? [
      { id: KEY_ID, tenant_id: TENANT, hash: KEY_HASH, status: 'ACTIVE' },
      { id: KEY2_ID, tenant_id: TENANT, hash: KEY2_HASH, status: 'ACTIVE' },
    ]).map((k) => ({ ...k })),
    names: [] as NameRow[],
    bindings: [] as BindingRow[],
    pointers: new Map<string, number>(),
    markers: new Map<string, MarkerRow>(),
    audit: [] as Attempted[],
  };
  const attempted: Attempted[] = [];
  const committed: Attempted[] = [];
  let staged: Attempted[] = [];
  let undo: Array<() => void> = [];
  let txCount = 0;
  let failOn: ((sql: string) => boolean) | undefined;

  const keyBy = (sql: string, params: unknown[]) => {
    if (/WHERE id=\$1/.test(sql)) return state.apiKeys.find((k) => k.id === params[0] && k.status === 'ACTIVE');
    return state.apiKeys.find((k) => k.hash === params[0] && k.status === 'ACTIVE');
  };

  const query = (via: 'pool' | 'tx', sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } => {
    attempted.push({ sql, params, via });
    if (via === 'tx') staged.push({ sql, params, via });
    else committed.push({ sql, params, via });
    if (failOn?.(sql)) throw new Error(`injected failure: ${sql.trim().slice(0, 48)}`);

    // --- idempotency markers ---
    if (/SELECT key, route, payload_hash/.test(sql)) {
      const row = state.markers.get(String(params[0]));
      return { rows: row ? [row as unknown as Record<string, unknown>] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO admin_idempotency/.test(sql)) {
      const key = String(params[0]);
      const prev = state.markers.get(key);
      state.markers.set(key, {
        key,
        route: String(params[1]),
        payload_hash: String(params[2]),
        response_code: Number(params[3]),
        response_body: JSON.parse(String(params[4])) as unknown,
      });
      undo.push(() => {
        if (prev === undefined) state.markers.delete(key);
        else state.markers.set(key, prev);
      });
      return { rows: [], rowCount: 1 };
    }

    // --- api_keys ---
    if (/SELECT id, tenant_id, hash FROM api_keys/.test(sql)) {
      const hit = keyBy(sql, params);
      return { rows: hit ? [{ id: hit.id, tenant_id: hit.tenant_id, hash: hit.hash }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/SELECT id, tenant_id FROM api_keys/.test(sql)) {
      const hit = keyBy(sql, params);
      return { rows: hit ? [{ id: hit.id, tenant_id: hit.tenant_id }] : [], rowCount: hit ? 1 : 0 };
    }

    // --- profile_names registry ---
    if (/SELECT profile_id FROM profile_names/.test(sql)) {
      const [tenant, keyId, biz, ver, action, name] = params;
      const hit = state.names.find(
        (n) =>
          n.tenant_id === tenant &&
          n.api_key_id === keyId &&
          n.business_id === biz &&
          n.business_version === ver &&
          n.action === action &&
          n.profile_name === name
      );
      return { rows: hit ? [{ profile_id: hit.profile_id }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/INSERT INTO profile_names/.test(sql)) {
      const [profileId, tenant, keyId, biz, ver, action, name] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const exists = state.names.some(
        (n) =>
          n.tenant_id === tenant &&
          n.api_key_id === keyId &&
          n.business_id === biz &&
          n.business_version === ver &&
          n.action === action &&
          n.profile_name === name
      );
      if (exists) return { rows: [], rowCount: 0 };
      state.names.push({
        profile_id: profileId,
        tenant_id: tenant,
        api_key_id: keyId,
        business_id: biz,
        business_version: ver,
        action,
        profile_name: name,
      });
      undo.push(() => {
        state.names.pop();
      });
      return { rows: [], rowCount: 1 };
    }

    // --- pointer ---
    if (/SELECT revision FROM profile_active_revisions WHERE profile_id=\$1 FOR UPDATE/.test(sql)) {
      const rev = state.pointers.get(String(params[0]));
      return { rows: rev === undefined ? [] : [{ revision: rev }], rowCount: rev === undefined ? 0 : 1 };
    }
    if (/INSERT INTO profile_active_revisions/.test(sql)) {
      const [profileId, revision] = params as [string, number];
      // Composite FK: the (profile_id, revision) target must exist in
      // profile_bindings — applied state (not a staged overlay), so a binding
      // INSERT earlier in the SAME tx is visible here, exactly like PG.
      const known = state.bindings.some((b) => b.profile_id === profileId && b.revision === revision);
      if (!known) {
        const err = new Error('insert or update violates foreign key constraint') as Error & { code?: string };
        err.code = '23503';
        throw err;
      }
      const prev = state.pointers.get(profileId);
      state.pointers.set(profileId, revision);
      undo.push(() => {
        if (prev === undefined) state.pointers.delete(profileId);
        else state.pointers.set(profileId, prev);
      });
      return { rows: [], rowCount: 1 };
    }

    // --- bindings ---
    if (/SELECT max\(revision\) AS m FROM profile_bindings/.test(sql)) {
      const rows = state.bindings.filter((b) => b.profile_id === params[0]);
      const m = rows.length ? Math.max(...rows.map((r) => r.revision)) : null;
      return { rows: [{ m }], rowCount: 1 };
    }
    if (/SELECT enabled, parameters, job_priority/.test(sql)) {
      const hit = state.bindings.find((b) => b.profile_id === params[0] && b.revision === params[1]);
      return {
        rows: hit
          ? [
              {
                enabled: hit.policy.enabled,
                parameters: hit.policy.parameters,
                job_priority: hit.policy.jobPriority,
                allowed_file_extensions: hit.policy.allowedFileExtensions,
                connections_override: hit.policy.connectionsOverride,
                file_url_auth_cipher: hit.policy.cipher,
              },
            ]
          : [],
        rowCount: hit ? 1 : 0,
      };
    }
    if (/INSERT INTO profile_bindings/.test(sql)) {
      const [
        profileId,
        revision,
        ,
        ,
        ,
        ,
        ,
        ,
        enabled,
        parameters,
        jobPriority,
        allowedFileExtensions,
        cipher,
        connectionsOverride,
      ] = params as [string, number, ...unknown[]];
      state.bindings.push({
        profile_id: profileId,
        revision,
        policy: {
          enabled: enabled as boolean,
          parameters: JSON.parse(String(parameters)) as unknown,
          jobPriority: jobPriority as string,
          allowedFileExtensions: allowedFileExtensions as string,
          cipher: (cipher as string | null) ?? null,
          connectionsOverride: JSON.parse(String(connectionsOverride)) as unknown,
        },
      });
      undo.push(() => {
        state.bindings.pop();
      });
      return { rows: [], rowCount: 1 };
    }

    // --- audit ---
    if (/INSERT INTO admin_audit_events/.test(sql)) {
      state.audit.push({ sql, params, via: 'tx' });
      undo.push(() => {
        state.audit.pop();
      });
      return { rows: [{ id: 'audit-row-1' }], rowCount: 1 };
    }

    throw new Error(`unhandled SQL: ${sql.slice(0, 90)}`);
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => query('tx', text, params),
  };
  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => query('pool', text, params),
    tx: async (fn: (c: unknown) => Promise<unknown>) => {
      txCount += 1;
      staged = [];
      undo = [];
      try {
        const result = await fn(client);
        committed.push(...staged);
        staged = [];
        undo = [];
        return result;
      } catch (err) {
        staged = [];
        // ROLLBACK: replay the journal backwards so reads-into-state never
        // leak a half-transaction (mirrors the real BEGIN/ROLLBACK).
        for (const op of undo.reverse()) op();
        undo = [];
        throw err;
      }
    },
    close: async () => undefined,
  };

  return {
    db: db as never,
    state,
    attempted,
    committed,
    txCount: () => txCount,
    injectFailure: (fn: (sql: string) => boolean) => {
      failOn = fn;
    },
  };
}

function makeDeps(f: ReturnType<typeof makeStatefulDb>): AdminActionDeps {
  return {
    db: f.db,
    audit: createAuditService(f.db),
    registry: {} as never,
    profiles: createProfileService(f.db, { cryptoEnv: { ENCRYPTION_KEY: 'test-encryption-key' } }),
    lifecycle: {} as never,
    runtime: { resumeOperation: async () => ({}) },
    hashApiKey: (raw: string) => raw,
    correlationId: 'corr-p730-w3',
  };
}

const platformAuth: AdminActionAuth = { kind: 'bearer', principal: { role: 'platform' } };
const adminCookie = (over?: Partial<Extract<AdminActionAuth, { kind: 'cookie' }>>): AdminActionAuth => ({
  kind: 'cookie',
  role: 'admin',
  csrfOk: true,
  ...over,
});

const upsertParams = (over?: Record<string, unknown>): Record<string, unknown> => ({
  businessId: 'document-core',
  businessVersion: '1.0.0',
  profileName: 'extract.invoice',
  apiKey: { apiKeyId: KEY_ID },
  policy: { jobPriority: 'HIGH' },
  ...over,
});

/** publish/rollback commands are strict: no `policy` key on the wire. */
const moveParams = (over?: Record<string, unknown>): Record<string, unknown> => {
  const base = upsertParams(over);
  delete base.policy;
  return base;
};

async function expectHttpError(promise: Promise<unknown>, status: number, code?: string) {
  try {
    await promise;
  } catch (err) {
    const e = err as { status?: number; code?: string };
    expect(e.status).toBe(status);
    if (code) expect(e.code).toBe(code);
    return;
  }
  throw new Error(`expected HttpError ${status}/${code ?? ''} but the call resolved`);
}

describe('P730-ADMIN-MUTATE W3 — profile.upsert through the real dispatcher (offline)', () => {
  it('creates profile: registry + revision + pointer + audit commit as ONE tx', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    const outcome = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams(),
    });
    expect(outcome.status).toBe(201);
    const body = outcome.body as { profileId: string; revision: number; tenantId: string; apiKeyId: string };
    expect(body.revision).toBe(1);
    expect(body.tenantId).toBe(TENANT);
    expect(body.apiKeyId).toBe(KEY_ID);
    expect(f.txCount()).toBe(1);
    // registry + binding + pointer + audit all committed
    expect(f.state.names).toHaveLength(1);
    expect(f.state.bindings).toHaveLength(1);
    expect(f.state.pointers.get(body.profileId)).toBe(1);
    expect(f.state.audit).toHaveLength(1);
    const audit = f.state.audit[0]!;
    expect(audit.params).toContain(TENANT);
    expect(audit.params).toContain('profile.upsert');
    expect(audit.params).toContain(`profile:${body.profileId}@rev1`);
  });

  it('second save appends revision 2 with policy carry-forward, same profileId', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    const first = await dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams() });
    const firstBody = first.body as { profileId: string };
    const second = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams({ policy: {} }),
    });
    const secondBody = second.body as { profileId: string; revision: number };
    expect(secondBody.profileId).toBe(firstBody.profileId);
    expect(secondBody.revision).toBe(2);
    // carry-forward: HIGH from rev1 survives an empty policy
    expect(f.state.bindings[1]!.policy.jobPriority).toBe('HIGH');
    expect(f.state.pointers.get(firstBody.profileId)).toBe(2);
  });

  it('CAS: stale expectedRevision is 409 REVISION_CONFLICT with zero new rows', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams() });
    const namesBefore = f.state.names.length;
    const bindingsBefore = f.state.bindings.length;
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.upsert',
        params: upsertParams({ expectedRevision: 5 }),
      }),
      409,
      'REVISION_CONFLICT'
    );
    expect(f.state.names).toHaveLength(namesBefore);
    expect(f.state.bindings).toHaveLength(bindingsBefore);
  });

  it('CAS: matching expectedRevision appends revision 2', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams() });
    const ok = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams({ expectedRevision: 1 }),
    });
    expect((ok.body as { revision: number }).revision).toBe(2);
  });

  it('apiKeyHash wire arm resolves the same key (both wires parse end-to-end)', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    const outcome = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams({ apiKey: { apiKeyHash: KEY_HASH } }),
    });
    expect(outcome.status).toBe(201);
    expect(f.state.names[0]!.api_key_id).toBe(KEY_ID);
  });

  it('T-AUD-01: the admin cookie principal lands on the ledger row', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await dispatchAdminAction(
      deps,
      adminCookie({ principalId: 'sub-1', issuer: 'https://idp.test' }),
      { action: 'profile.upsert', params: upsertParams() }
    );
    const audit = f.state.audit[0]!;
    expect(audit.params).toContain('shell:admin');
    expect(audit.params).toContain('https://idp.test');
    expect(audit.params).toContain('sub-1');
    expect(audit.params).toContain('admin');
  });

  it('CSRF denied -> 403 before any query runs', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await expectHttpError(
      dispatchAdminAction(deps, adminCookie({ csrfOk: false }), { action: 'profile.upsert', params: upsertParams() }),
      403,
      'PERMISSION_DENIED'
    );
    expect(f.attempted).toHaveLength(0);
  });

  it('role table: viewer cookie and tenant_operator bearer are 403 with zero queries', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await expectHttpError(
      dispatchAdminAction(deps, adminCookie({ role: 'viewer' }), { action: 'profile.upsert', params: upsertParams() }),
      403
    );
    await expectHttpError(
      dispatchAdminAction(deps, { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT } }, {
        action: 'profile.upsert',
        params: upsertParams(),
      }),
      403
    );
    expect(f.attempted).toHaveLength(0);
  });

  it('strict params: unknown key, both apiKey arms and missing apiKey are 422 with zero queries', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams({ extra: 1 }) }),
      422,
      'INVALID_SCHEMA'
    );
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.upsert',
        params: upsertParams({ apiKey: { apiKeyId: KEY_ID, apiKeyHash: KEY_HASH } }),
      }),
      422
    );
    const noKey = upsertParams();
    delete noKey.apiKey;
    await expectHttpError(dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: noKey }), 422);
    expect(f.attempted).toHaveLength(0);
  });

  it('T-AUD-01 atomicity: audit-insert failure rolls back registry+revision+pointer', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    f.injectFailure((sql) => /INSERT INTO admin_audit_events/.test(sql));
    await expect(
      dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams() })
    ).rejects.toThrow(/injected failure/);
    expect(f.state.names).toHaveLength(0);
    expect(f.state.bindings).toHaveLength(0);
    expect(f.state.pointers.size).toBe(0);
    expect(f.state.audit).toHaveLength(0);
  });

  it('no-secret: fileUrlAuthConfig is encrypted at rest; raw token absent from every committed statement', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams({ policy: { fileUrlAuthConfig: { type: 'bearer', token: 'SENTINEL-TOKEN-123' } } }),
    });
    expect(f.state.bindings[0]!.policy.cipher).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    const flat = JSON.stringify(f.committed);
    expect(flat).not.toContain('SENTINEL-TOKEN-123');
  });
});

describe('P730-ADMIN-MUTATE W3 — publish / rollback over the pointer (offline)', () => {
  async function seeded() {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    const first = await dispatchAdminAction(deps, platformAuth, { action: 'profile.upsert', params: upsertParams() });
    const second = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams({ policy: { jobPriority: 'LOW' }, expectedRevision: 1 }),
    });
    const body = second.body as { profileId: string };
    expect((first.body as { revision: number }).revision).toBe(1);
    return { f, deps, profileId: body.profileId };
  }

  it('rollback moves the pointer to an older revision; publish CAS moves it back to max', async () => {
    const { f, deps, profileId } = await seeded();
    const rb = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.rollback',
      params: moveParams({ targetRevision: 1, expectedRevision: 2 }),
    });
    expect(rb.status).toBe(200);
    expect((rb.body as { revision: number }).revision).toBe(1);
    expect(f.state.pointers.get(profileId)).toBe(1);

    const pub = await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.publish',
      params: moveParams({ expectedRevision: 1 }),
    });
    expect(pub.status).toBe(200);
    expect((pub.body as { revision: number }).revision).toBe(2);
    expect(f.state.pointers.get(profileId)).toBe(2);
    // audit kinds recorded for both moves
    const kinds = f.state.audit.map((a) => a.params[5]);
    expect(kinds).toContain('profile.rollback');
    expect(kinds).toContain('profile.publish');
  });

  it('stale publish CAS is 409 and the pointer does not move', async () => {
    const { f, deps, profileId } = await seeded();
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.publish',
        params: moveParams({ expectedRevision: 1 }),
      }),
      409,
      'REVISION_CONFLICT'
    );
    expect(f.state.pointers.get(profileId)).toBe(2);
  });

  it('rollback to a nonexistent target is 404 (composite-FK 23503 mapped, not a 500)', async () => {
    const { deps } = await seeded();
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.rollback',
        params: moveParams({ targetRevision: 7 }),
      }),
      404
    );
  });

  it('publish for a name under another api key is 404 (registry scoping)', async () => {
    const { deps } = await seeded();
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.publish',
        params: moveParams({ apiKey: { apiKeyId: KEY2_ID }, expectedRevision: 2 }),
      }),
      404
    );
  });

  it('publish without expectedRevision is 422 (CAS is mandatory in the command schema)', async () => {
    const { deps } = await seeded();
    const params = upsertParams();
    delete params.policy;
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, { action: 'profile.publish', params }),
      422,
      'INVALID_SCHEMA'
    );
  });
});

describe('P730-ADMIN-MUTATE W3 — idempotency (offline)', () => {
  it('replay of the same key+payload returns the stored response with NO second revision', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    const call = {
      action: 'profile.upsert',
      params: upsertParams(),
      idempotencyKey: 'idem-key-0001',
    };
    const first = await dispatchAdminAction(deps, platformAuth, call);
    const bindingsAfterFirst = f.state.bindings.length;
    const replay = await dispatchAdminAction(deps, platformAuth, call);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(f.state.bindings).toHaveLength(bindingsAfterFirst);
  });

  it('same key with a different payload is 409 IDEMPOTENCY_CONFLICT', async () => {
    const f = makeStatefulDb();
    const deps = makeDeps(f);
    await dispatchAdminAction(deps, platformAuth, {
      action: 'profile.upsert',
      params: upsertParams(),
      idempotencyKey: 'idem-key-0002',
    });
    await expectHttpError(
      dispatchAdminAction(deps, platformAuth, {
        action: 'profile.upsert',
        params: upsertParams({ policy: { jobPriority: 'LOW' } }),
        idempotencyKey: 'idem-key-0002',
      }),
      409,
      'IDEMPOTENCY_CONFLICT'
    );
  });
});
