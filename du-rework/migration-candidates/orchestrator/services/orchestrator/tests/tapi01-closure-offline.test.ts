import { ProfileDetailReadSchema } from '@du/contracts';
import { handleAdminRoutes } from '../src/http/routes/admin';
import type { RouteContext } from '../src/http/route-context';
import { createAuditService } from '../src/modules/audit/audit';
import {
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';
import { createProfileService } from '../src/modules/profiles/profiles';
import { HttpError } from '../src/http/errors';

/**
 * T-API-01 closure (offline) — the profile detail route reads REAL data
 * (registry `profile_names` + `profile_active_revisions` + the pinned
 * `profile_bindings` revision), reveals ONLY the opaque `apiKeyId` as the
 * write identity, and the value returned by the READ can drive `profile.upsert`
 * end-to-end through the REAL dispatcher/leaf against the same state.
 *
 * Fake Db: stateful write-journal (rollback discards), covering the SQL the
 * route and the upsert slice actually issue. No PG/Redis.
 */

const TENANT = '10000000-0000-4000-8000-000000000001';
const KEY_ID = '20000000-0000-4000-8000-000000000002';
const KEY_HASH = 'a'.repeat(64);
const PROFILE_ID = '30000000-0000-4000-8000-000000000003';
const CIPHER = `${'ab'.repeat(12)}:${'cd'.repeat(16)}:${'ef'.repeat(4)}`;
const BIZ = 'document-core';
const VER = '1.0.0';
const NAME = 'extract.invoice';

interface BindingRow {
  profile_id: string;
  revision: number;
  enabled: boolean;
  parameters: unknown;
  job_priority: string;
  allowed_file_extensions: string;
  connections_override: unknown;
  cipher: string | null;
}

function makeFake(opts: { pointer?: boolean; seedProfile?: boolean } = {}) {
  const seedProfile = opts.seedProfile !== false;
  const withPointer = opts.pointer !== false;
  const state = {
    businessVersions: [{ business_id: BIZ, version: VER, manifest: { actions: [{ name: 'extract' }] }, is_active: true }],
    apiKeys: [{ id: KEY_ID, tenant_id: TENANT, hash: KEY_HASH, status: 'ACTIVE' }],
    names: seedProfile
      ? [
          {
            profile_id: PROFILE_ID,
            tenant_id: TENANT,
            api_key_id: KEY_ID,
            business_id: BIZ,
            business_version: VER,
            action: NAME,
            profile_name: NAME,
          },
        ]
      : [],
    bindings: seedProfile
      ? ([
          {
            profile_id: PROFILE_ID,
            revision: 1,
            enabled: true,
            parameters: {},
            job_priority: 'MEDIUM',
            allowed_file_extensions: '',
            connections_override: [],
            cipher: null,
          },
          {
            profile_id: PROFILE_ID,
            revision: 2,
            enabled: true,
            parameters: { model: { value: 'gemini-2.0', isLocked: true }, temperature: { value: 0.2 } },
            job_priority: 'HIGH',
            allowed_file_extensions: '.pdf',
            connections_override: [],
            cipher: CIPHER,
          },
        ] as BindingRow[])
      : [],
    pointers: new Map<string, number>(seedProfile && withPointer ? [[PROFILE_ID, 2]] : []),
    audit: [] as Array<{ params: unknown[] }>,
  };
  let undo: Array<() => void> = [];

  const query = (_via: 'pool' | 'tx', sql: string, params: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } => {
    // --- route reads ---
    if (/FROM business_versions/.test(sql)) {
      const bv = state.businessVersions.find((r) =>
        sql.includes('is_active = true') ? r.business_id === params[0] && r.is_active : r.business_id === params[0] && r.version === params[1]
      );
      return { rows: bv ? [bv as unknown as Record<string, unknown>] : [], rowCount: bv ? 1 : 0 };
    }
    if (/SELECT n\.profile_id, a\.revision/.test(sql)) {
      const name = state.names.find(
        (n) => n.business_id === params[0] && n.business_version === params[1] && n.profile_name === params[2]
      );
      const revision = name ? state.pointers.get(name.profile_id) : undefined;
      const binding = name && revision !== undefined
        ? state.bindings.find((b) => b.profile_id === name.profile_id && b.revision === revision)
        : undefined;
      if (!name || revision === undefined || !binding) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            profile_id: name.profile_id,
            revision,
            api_key_id: name.api_key_id,
            enabled: binding.enabled,
            parameters: binding.parameters,
            job_priority: binding.job_priority,
            allowed_file_extensions: binding.allowed_file_extensions,
            connections_override: binding.connections_override,
            file_url_auth_cipher: binding.cipher,
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT 1 FROM profile_names/.test(sql)) {
      const hit = state.names.some(
        (n) => n.business_id === params[0] && n.business_version === params[1] && n.profile_name === params[2]
      );
      return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    // --- upsert slice ---
    if (/SELECT profile_id FROM profile_names/.test(sql)) {
      const [tenant, keyId, biz, ver, action, name] = params as string[];
      const hit = state.names.find(
        (n) =>
          n.tenant_id === tenant && n.api_key_id === keyId && n.business_id === biz &&
          n.business_version === ver && n.action === action && n.profile_name === name
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
      state.names.push({
        profile_id: profileId, tenant_id: tenant, api_key_id: keyId,
        business_id: biz, business_version: ver, action, profile_name: name,
      });
      undo.push(() => state.names.pop());
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id, tenant_id, hash FROM api_keys/.test(sql)) {
      const hit = state.apiKeys.find((k) => k.id === params[0] && k.status === 'ACTIVE');
      return { rows: hit ? [{ id: hit.id, tenant_id: hit.tenant_id, hash: hit.hash }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/SELECT id, tenant_id FROM api_keys/.test(sql)) {
      const hit = state.apiKeys.find((k) => k.hash === params[0] && k.status === 'ACTIVE');
      return { rows: hit ? [{ id: hit.id, tenant_id: hit.tenant_id }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/SELECT revision FROM profile_active_revisions/.test(sql)) {
      const rev = state.pointers.get(String(params[0]));
      return { rows: rev === undefined ? [] : [{ revision: rev }], rowCount: rev === undefined ? 0 : 1 };
    }
    if (/SELECT max\(revision\) AS m/.test(sql)) {
      const rows = state.bindings.filter((b) => b.profile_id === params[0]);
      return { rows: [{ m: rows.length ? Math.max(...rows.map((r) => r.revision)) : null }], rowCount: 1 };
    }
    if (/SELECT enabled, parameters, job_priority/.test(sql)) {
      const hit = state.bindings.find((b) => b.profile_id === params[0] && b.revision === params[1]);
      return {
        rows: hit
          ? [{ enabled: hit.enabled, parameters: hit.parameters, job_priority: hit.job_priority, allowed_file_extensions: hit.allowed_file_extensions, connections_override: hit.connections_override, file_url_auth_cipher: hit.cipher }]
          : [],
        rowCount: hit ? 1 : 0,
      };
    }
    if (/INSERT INTO profile_bindings/.test(sql)) {
      const p = params as unknown[];
      state.bindings.push({
        profile_id: String(p[0]),
        revision: Number(p[1]),
        enabled: Boolean(p[8]),
        parameters: JSON.parse(String(p[9])) as unknown,
        job_priority: String(p[10]),
        allowed_file_extensions: String(p[11]),
        cipher: (p[12] as string | null) ?? null,
        connections_override: JSON.parse(String(p[13])) as unknown,
      });
      undo.push(() => state.bindings.pop());
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO profile_active_revisions/.test(sql)) {
      const [profileId, revision] = params as [string, number];
      const known = state.bindings.some((b) => b.profile_id === profileId && b.revision === revision);
      if (!known) {
        const err = new Error('fkViolation') as Error & { code?: string };
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
    if (/INSERT INTO admin_audit_events/.test(sql)) {
      state.audit.push({ params });
      undo.push(() => state.audit.pop());
      return { rows: [{ id: 'audit-1' }], rowCount: 1 };
    }
    throw new Error(`unhandled SQL: ${sql.slice(0, 90)}`);
  };

  const client = { query: async (sql: string, params: unknown[] = []) => query('tx', sql, params) };
  const db = {
    pool: undefined,
    query: async (sql: string, params: unknown[] = []) => query('pool', sql, params),
    tx: async (fn: (c: unknown) => Promise<unknown>) => {
      undo = [];
      try {
        const result = await fn(client);
        undo = [];
        return result;
      } catch (err) {
        for (const op of undo.reverse()) op();
        undo = [];
        throw err;
      }
    },
    close: async () => undefined,
  };
  return { db, state };
}

interface FakedCtx {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  correlationId: string;
  host: string;
  db: unknown;
  config: { adminToken?: string };
}

function adminCtx(fake: ReturnType<typeof makeFake>, pathname: string, over?: Partial<FakedCtx>): RouteContext {
  const ctx: FakedCtx = {
    method: 'GET',
    pathname,
    searchParams: new URLSearchParams(),
    headers: { authorization: 'Bearer tok' },
    body: null,
    rawBody: Buffer.alloc(0),
    correlationId: 'corr-tapi01',
    host: 'localhost',
    db: fake.db,
    config: { adminToken: 'tok' },
    ...over,
  };
  return ctx as unknown as RouteContext;
}

function makeDispatchDeps(fake: ReturnType<typeof makeFake>): AdminActionDeps {
  return {
    db: fake.db as never,
    audit: createAuditService(fake.db as never),
    registry: {} as never,
    profiles: createProfileService(fake.db as never, { cryptoEnv: { ENCRYPTION_KEY: 'test-encryption-key' } }),
    lifecycle: {} as never,
    runtime: { resumeOperation: async () => ({}) },
    hashApiKey: (raw: string) => raw,
    correlationId: 'corr-tapi01',
  };
}

const platform: AdminActionAuth = { kind: 'bearer', principal: { role: 'platform' } };

async function expectHttpError(promise: Promise<unknown>, status: number, messageMatch?: RegExp) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const e = err as HttpError;
    expect(e.status).toBe(status);
    if (messageMatch) expect(e.message).toMatch(messageMatch);
    return;
  }
  throw new Error(`expected HttpError ${status} but the call resolved`);
}

describe('T-API-01 closure — profile detail reads REAL data', () => {
  it('returns the active revision, read policy and ONLY the opaque apiKeyId (no cipher)', async () => {
    const fake = makeFake();
    const res = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/${NAME}`));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const parsed = ProfileDetailReadSchema.parse(res!.body);
    expect(parsed.revision).toBe(2);
    expect(parsed.apiKeyId).toBe(KEY_ID);
    expect(parsed.currentValues).toEqual({ model: 'gemini-2.0', temperature: '0.2' });
    expect(parsed.policy.jobPriority).toBe('HIGH');
    expect(parsed.policy.allowedFileExtensions).toBe('.pdf');
    expect(parsed.policy.fileUrlAuthConfigured).toBe(true);
    expect(parsed.policy.parameters.model).toEqual({ value: 'gemini-2.0', isLocked: true });
    const wire = JSON.stringify(res!.body);
    expect(wire).not.toContain(CIPHER);
    expect(wire).not.toContain('fileUrlAuthCipher');
  });

  it('`/new` yields the blank editor with no write identity (sentinel predates the stored-profile schema)', async () => {
    const fake = makeFake();
    const res = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/new`));
    const body = res!.body as Record<string, unknown>;
    // The /new sentinel keeps its historical empty-name shape (the frozen
    // schema's `profileName.min(1)` describes STORED profiles); what the
    // closure pins here is: no revision, no write identity, empty policy.
    expect(body.profileName).toBe('');
    expect(body.revision).toBe(0);
    expect('apiKeyId' in body).toBe(false);
    // WT-02: the blank editor now carries `callbackPolicy: null` as well. That is
    // deliberate tri-state, not drift: `undefined` = key absent from the read DTO,
    // `null` = "no callback policy stored" (which is also what an explicit Clear
    // produces), object = a valid stored pin. The Portal needs all three so that
    // clearing a policy is expressible.
    expect(body.policy).toEqual({
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '',
      fileUrlAuthConfigured: false,
      connectionsOverride: [],
      callbackPolicy: null,
    });
  });

  it('a named-but-unstored profile keeps the legacy blank editor (R-12 blind first save)', async () => {
    const fake = makeFake({ seedProfile: false });
    const res = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/missing.profile`));
    expect(res!.status).toBe(200);
    const parsed = ProfileDetailReadSchema.parse(res!.body);
    expect(parsed.profileName).toBe('missing.profile');
    expect(parsed.revision).toBe(0);
    expect(parsed.apiKeyId).toBeUndefined();
  });

  it('registry row without a pointer fails closed (404), never a guessed revision', async () => {
    const fake = makeFake({ pointer: false });
    await expectHttpError(
      handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/${NAME}`)) as Promise<unknown>,
      404,
      /active revision pointer/
    );
  });

  it('latest sentinel resolves the active version and still returns the real revision', async () => {
    const fake = makeFake();
    const res = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/latest/${NAME}`));
    const parsed = ProfileDetailReadSchema.parse(res!.body);
    expect(parsed.businessVersion).toBe(VER);
    expect(parsed.revision).toBe(2);
  });

  it('requires the admin bearer token (fail-closed 401)', async () => {
    const fake = makeFake();
    await expectHttpError(
      handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/${NAME}`, { config: {} })) as Promise<unknown>,
      401
    );
  });
});

describe('T-API-01 closure — detail → upsert end-to-end (offline)', () => {
  it('the apiKeyId from the READ drives profile.upsert; a re-READ sees the new revision', async () => {
    const fake = makeFake();
    const deps = makeDispatchDeps(fake);

    const res = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/${NAME}`));
    const detail = ProfileDetailReadSchema.parse(res!.body);
    expect(detail.apiKeyId).toBe(KEY_ID);

    const upsert = await dispatchAdminAction(deps, platform, {
      action: 'profile.upsert',
      params: {
        businessId: detail.businessId,
        businessVersion: detail.businessVersion,
        profileName: detail.profileName,
        apiKey: { apiKeyId: detail.apiKeyId },
        policy: {},
      },
    });
    expect(upsert.status).toBe(201);
    expect((upsert.body as { revision: number }).revision).toBe(3);
    expect(fake.state.names).toHaveLength(1); // same profile, appended — never a second identity
    expect(fake.state.bindings).toHaveLength(3);

    // Read-after-write through the REAL route: the new revision is visible,
    // policy carried forward, cipher preserved (never re-exposed).
    const res2 = await handleAdminRoutes(adminCtx(fake, `/api/v1/admin/profiles/${BIZ}/${VER}/${NAME}`));
    const after = ProfileDetailReadSchema.parse(res2!.body);
    expect(after.revision).toBe(3);
    expect(after.policy.jobPriority).toBe('HIGH');
    expect(after.policy.fileUrlAuthConfigured).toBe(true);
    expect(after.apiKeyId).toBe(KEY_ID);
  });
});
