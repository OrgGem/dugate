/**
 * ENC-08-WIRING (Delta 97): the crypto-configuration surface mounted on the real
 * transports - `GET/POST /api/v1/admin/crypto-config` in server.ts and
 * `GET /admin/crypto-config` in the Admin shell.
 *
 * In-process and offline: no socket, no PG, no Redis, no Vault. What these tests are
 * for is the WIRING, which the Mục 23 suite deliberately did not cover:
 *
 *   1. The API route is reachable, is admin-authenticated, and delegates to the same
 *      handler the unit tests drive (one rule set, two entry points).
 *   2. A write is READABLE BY THE NEXT REQUEST. The store is built once per app, so a
 *      per-request store would make 'the Admin save did nothing' - the failure this
 *      wiring is most likely to introduce.
 *   3. A cookie-authenticated mutation without the CSRF proof is refused AT THE WIRE.
 *   4. Unconfigured platform -> 503, never a fake empty configuration.
 *   5. The shell route resolves, is admin-gated, and renders the pane - or an honest
 *      error pane when no resolver is wired, never a blank one.
 */

import {
  buildCryptoConfigOptions,
  route,
  type RouteContext,
  type ServerConfig,
} from '../src/server';
import { isHttpError } from '../src/http/errors';
import { signCookie } from '../src/app/admin/shell-auth';
import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import { dispatchShellRequest, matchShellRoute } from '../src/app/admin/shell-router';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { AuditRecordInput } from '../src/modules/audit/audit';
import type { RecipientPublicKeyRecord } from '../src/modules/encryption/recipient-key-registry';
import type { Db } from '../src/db/db';
import { PostgresCryptoConfigStore } from '../src/app/admin/crypto-config-store';
import {
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigState,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';

const ADMIN_TOKEN = 'enc08-wiring-admin-token';
const OPERATOR_TOKEN = 'enc08-wiring-operator-token';
const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const COOKIE_SECRET = 'enc08-wiring-cookie-secret';
const SECRET_SENTINEL = 'BEGIN PRIVATE KEY SENTINEL-9f2a';

function keyRecord(over: Partial<RecipientPublicKeyRecord> = {}): RecipientPublicKeyRecord {
  return {
    id: 'key-wiring-1',
    tenantId: TENANT_A,
    version: 1,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: 'BEGIN PUBLIC KEY SENTINEL',
    fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz012345',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    return this.rows.get(tenantId) ?? { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null };
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.rows.set(tenantId, next);
    return next;
  }
}

class MemoryAudit implements CryptoConfigAudit {
  public readonly rows: AuditRecordInput[] = [];
  async record(input: AuditRecordInput): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

interface Harness {
  ctx: RouteContext;
  store: MemoryStore;
  audit: MemoryAudit;
}

/**
 * A route context wired exactly the way createApp wires it: ONE store instance
 * shared by every request, the crypto options built from platform config.
 */
function harness(options: { keys?: RecipientPublicKeyRecord[]; configured?: boolean; tenantAdminToken?: string } = {}): Harness {
  const store = new MemoryStore();
  const audit = new MemoryAudit();
  const keys = options.keys ?? [keyRecord()];
  const configured = options.configured !== false;
  const cryptoConfig: CryptoConfigServiceOptions | null = configured
    ? {
        allowedKeyRefs: ['primary', 'secondary'],
        store,
        keys: {
          async listRecipientKeys(tenantId: string) {
            return recipientKeyOptions(keys, tenantId);
          },
        },
        audit,
      }
    : null;
  const ctx = {
    method: 'GET',
    pathname: '/api/v1/admin/crypto-config',
    searchParams: new URLSearchParams(''),
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'enc08-wiring',
    host: 'localhost',
    config: {
      adminToken: ADMIN_TOKEN,
      adminShellCookieSecret: COOKIE_SECRET,
      tenantAdminTokens: options.tenantAdminToken ? { [options.tenantAdminToken]: TENANT_A } : {},
    },
    cryptoConfig,
  } as unknown as RouteContext;
  return { ctx, store, audit };
}

type Outcome =
  | { kind: 'body'; status: number; body: Record<string, unknown> }
  | { kind: 'problem'; status: number; code: string };

async function call(
  h: Harness,
  opts: { method?: 'GET' | 'POST'; tenantId?: string; body?: unknown; bearer?: string; headers?: Record<string, string> } = {},
): Promise<Outcome> {
  const ctx = h.ctx as unknown as {
    method: string;
    searchParams: URLSearchParams;
    headers: Record<string, string>;
    body: unknown;
  };
  ctx.method = opts.method ?? 'GET';
  ctx.searchParams = new URLSearchParams(opts.tenantId ? 'tenantId=' + opts.tenantId : '');
  const bearer = opts.bearer ?? ADMIN_TOKEN;
  ctx.headers = { authorization: 'Bearer ' + bearer, ...(opts.headers ?? {}) };
  ctx.body = opts.body;
  try {
    const res = await route(h.ctx);
    return { kind: 'body', status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return { kind: 'problem', status: err.status, code: err.code };
  }
}

function cryptoOf(out: Outcome): Record<string, unknown> {
  if (out.kind !== 'body') throw new Error('expected a body, got ' + out.status);
  return out.body['crypto'] as Record<string, unknown>;
}

/** Narrow an outcome to its body, or fail loudly rather than reading a missing field. */
function bodyOf(out: Outcome): Record<string, unknown> {
  if (out.kind !== 'body') throw new Error('expected a body, got ' + out.status);
  return out.body;
}

describe('ENC-08-WIRING: GET /api/v1/admin/crypto-config', () => {
  it('serves the configuration for a named tenant', async () => {
    const h = harness();
    const out = await call(h, { tenantId: TENANT_A });
    expect(out.kind).toBe('body');
    expect(out.status).toBe(200);
    const view = cryptoOf(out);
    expect(view['tenantId']).toBe(TENANT_A);
    expect(view['allowedKeyRefs']).toEqual(['primary', 'secondary']);
    expect((view['recipientKeys'] as unknown[]).length).toBe(1);
  });

  it('never returns key material, only the fingerprint', async () => {
    const h = harness({ keys: [keyRecord({ publicKeyPem: 'PUBLIC ' + SECRET_SENTINEL })] });
    const out = await call(h, { tenantId: TENANT_A });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(SECRET_SENTINEL);
    expect(wire).toContain('SHA256:abcdefghijklmnopqrstuvwxyz012345');
  });

  it('an unauthenticated caller is 401', async () => {
    const h = harness();
    const out = await call(h, { headers: { authorization: 'Bearer wrong' } });
    expect(out).toMatchObject({ kind: 'problem', status: 401 });
  });

  it('a platform caller must still name the tenant', async () => {
    const h = harness();
    const out = await call(h, {});
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('an unconfigured platform answers 503, not an empty configuration', async () => {
    const h = harness({ configured: false });
    const out = await call(h, { tenantId: TENANT_A });
    expect(out).toMatchObject({ kind: 'problem', status: 503 });
  });
});

describe('ENC-08-WIRING: composition store selection', () => {
  function serverConfig(): ServerConfig {
    return {
      port: 2023,
      databaseUrl: 'postgresql://unused:test@localhost/unused_test',
      redisUrl: 'redis://localhost:6379',
      cryptoConfig: { allowedKeyRefs: ['primary', 'secondary'] },
    };
  }

  it('uses the Postgres adapter when the composition root supplies a database', async () => {
    const audit = new MemoryAudit();
    const query = jest.fn(async () => ({ rows: [] }));
    const db = { query } as unknown as Pick<Db, 'query'>;
    const options = buildCryptoConfigOptions(serverConfig(), audit, db);

    expect(options?.store).toBeInstanceOf(PostgresCryptoConfigStore);
    await expect(options?.store.get(TENANT_A)).resolves.toEqual({
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM admin_crypto_config'), [TENANT_A]);
  });

  it('keeps the in-memory store when no database is supplied', async () => {
    const options = buildCryptoConfigOptions(serverConfig(), new MemoryAudit());
    const next: CryptoConfigState = {
      storageKeyRef: 'primary',
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: 1,
    };

    expect(options?.store).not.toBeInstanceOf(PostgresCryptoConfigStore);
    await expect(options?.store.set(TENANT_A, next)).resolves.toEqual(next);
    await expect(options?.store.get(TENANT_A)).resolves.toEqual(next);
  });
});

describe('ENC-08-WIRING: POST /api/v1/admin/crypto-config', () => {
  it('applies a change and the NEXT request reads it back', async () => {
    const h = harness();
    const before = cryptoOf(await call(h, { tenantId: TENANT_A }));
    expect((before['state'] as Record<string, unknown>)['deliveryEncryption']).toBe(false);

    const posted = await call(h, {
      method: 'POST',
      tenantId: TENANT_A,
      body: { deliveryEncryption: true, recipientKeyVersion: 1 },
    });
    expect(posted.status).toBe(200);
    const changed = (bodyOf(posted)['changedFields'] as string[]).slice().sort();
    expect(changed).toEqual(['deliveryEncryption', 'recipientKeyVersion']);

    const after = cryptoOf(await call(h, { tenantId: TENANT_A }));
    const state = after['state'] as Record<string, unknown>;
    expect(state['deliveryEncryption']).toBe(true);
    expect(state['pinnedRecipientKeyVersion']).toBe(1);
    expect(after['deliveryReady']).toBe(true);
  });

  it('writes one audit row per changed field', async () => {
    const h = harness();
    await call(h, { method: 'POST', tenantId: TENANT_A, body: { storageKeyRef: 'primary' } });
    expect(h.audit.rows.map((row) => row.action)).toEqual(['crypto_config.storage_key_ref.set']);
    expect(h.audit.rows[0]?.resource).toBe('tenant:' + TENANT_A);
  });

  it('refuses a key ref outside the allowlist', async () => {
    const h = harness();
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: { storageKeyRef: 'smuggled' } });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
    expect(h.audit.rows).toHaveLength(0);
  });

  it('refuses a revoked pin and an unregistered version', async () => {
    const revoked = harness({ keys: [keyRecord({ revokedAt: '2026-05-01T00:00:00.000Z' })] });
    const a = await call(revoked, { method: 'POST', tenantId: TENANT_A, body: { recipientKeyVersion: 1 } });
    expect(a).toMatchObject({ status: 409 });
    const missing = harness();
    const b = await call(missing, { method: 'POST', tenantId: TENANT_A, body: { recipientKeyVersion: 9 } });
    expect(b).toMatchObject({ status: 422 });
  });

  it('refuses to switch delivery on without a usable recipient key', async () => {
    const h = harness({ keys: [] });
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: { deliveryEncryption: true } });
    expect(out).toMatchObject({ status: 409 });
    expect(h.audit.rows).toHaveLength(0);
  });

  it('rejects wrong field types before touching the store', async () => {
    const h = harness();
    const a = await call(h, { method: 'POST', tenantId: TENANT_A, body: { deliveryEncryption: 'yes' } });
    const b = await call(h, { method: 'POST', tenantId: TENANT_A, body: { recipientKeyVersion: 'v1' } });
    const c = await call(h, { method: 'POST', tenantId: TENANT_A, body: { storageKeyRef: 7 } });
    expect(a).toMatchObject({ status: 422 });
    expect(b).toMatchObject({ status: 422 });
    expect(c).toMatchObject({ status: 422 });
    expect(h.store.rows.size).toBe(0);
  });

  it('a cookie mutation without the CSRF proof is refused at the wire', async () => {
    // A TENANT-OPERATOR bearer is what makes the cookie leg reachable: a platform
    // bearer is a machine call the shell server makes server-to-server, and no
    // cross-site page can send an Authorization header at all.
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const sessionCookie = signCookie(COOKIE_SECRET, { role: 'operator', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
    expect(sessionCookie).not.toBeNull();
    const out = await call(h, {
      method: 'POST',
      tenantId: TENANT_A,
      body: { deliveryEncryption: true },
      bearer: OPERATOR_TOKEN,
      headers: { cookie: 'du_admin=' + sessionCookie },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
    expect(h.store.rows.size).toBe(0);
  });

  it('the same cookie mutation WITH the derived CSRF token goes through', async () => {
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const sessionCookie = signCookie(COOKIE_SECRET, { role: 'operator', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
    const out = await call(h, {
      method: 'POST',
      tenantId: TENANT_A,
      body: { deliveryEncryption: true },
      bearer: OPERATOR_TOKEN,
      headers: {
        cookie: 'du_admin=' + sessionCookie,
        'x-csrf-token': deriveCsrfToken(COOKIE_SECRET, sessionCookie ?? ''),
      },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  it('a forged role header cannot replace a real cookie to skip CSRF', async () => {
    // The role must come from the VERIFIED cookie, never from a request header. The
    // route used to read `x-admin-role`, which let a caller assert any role. The real
    // property is that a header claiming 'admin' does not turn a cookie-less
    // tenant-operator call into a privileged one, and that a forged role alongside a
    // REAL cookie still has to pass CSRF.
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const realCookie = signCookie(COOKIE_SECRET, { role: 'operator', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
    const forged = await call(h, {
      method: 'POST',
      tenantId: TENANT_A,
      body: { deliveryEncryption: true },
      bearer: OPERATOR_TOKEN,
      headers: { cookie: 'du_admin=' + realCookie, 'x-admin-role': 'admin', 'x-csrf-token': 'guessed' },
    });
    expect(forged).toMatchObject({ kind: 'problem', status: 403 });
    expect(h.store.rows.size).toBe(0);
  });
});

describe('ENC-08-WIRING: GET /admin/crypto-config (Admin shell)', () => {
  const adminCookie = signCookie(COOKIE_SECRET, { role: 'admin', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });
  const viewerCookie = signCookie(COOKIE_SECRET, { role: 'viewer', iss: 'du-admin-shell', iat: 1000, exp: 9999999999999 });

  function request(over: Partial<AdminShellRequest> = {}): AdminShellRequest {
    const base: AdminShellRequest = {
      method: 'GET',
      pathname: '/admin/crypto-config',
      cookies: { du_admin: adminCookie ?? '' },
      body: {},
    };
    return { ...base, ...over };
  }

  function config(over: Record<string, unknown> = {}): never {
    return { cookieSecret: COOKIE_SECRET, adminToken: ADMIN_TOKEN, ...over } as never;
  }

  const readyPane = {
    status: 'ready' as const,
    view: {
      tenantId: TENANT_A,
      state: { storageKeyRef: 'primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 1 },
      allowedKeyRefs: ['primary', 'secondary'],
      recipientKeys: [
        { version: 1, fingerprint: 'SHA256:abcdefghijklmnop', revokedAt: null, effectiveAt: '2026-01-01T00:00:00.000Z' },
      ],
      effectiveRecipientKeyVersion: 1,
      pinInvalid: null,
      deliveryReady: true,
      deliveryBlockedReason: null,
    },
  };

  it('the matcher resolves it to an admin-only route', () => {
    const matched = matchShellRoute('GET', '/admin/crypto-config');
    expect(matched).not.toBeNull();
    expect(matched?.id).toBe('admin-crypto-config');
    expect(matched?.requiredRole).toBe('admin');
  });

  it('a POST to the same path is now a route, gated by CSRF in the shell', () => {
    // W-ADM-UX-08-SHELL (Delta 106) opened this door: the pane form needs
    // somewhere to post, and the gate is the server-derived CSRF proof, proven
    // in tests/admin-crypto-config-shell.test.ts. It was null before that cycle.
    expect(matchShellRoute('POST', '/admin/crypto-config')).toMatchObject({
      id: 'admin-crypto-config',
      requiredRole: 'admin',
    });
  });

  it('a signed-out visitor gets the 401 page', () => {
    const out = dispatchShellRequest(request({ cookies: {} }), config());
    expect(out.routeId).toBe('admin-crypto-config');
    expect(out.response.status).toBe(401);
  });

  it('a viewer session is denied', () => {
    const out = dispatchShellRequest(request({ cookies: { du_admin: viewerCookie ?? '' } }), config());
    expect(out.response.status).toBe(403);
  });

  it('renders the pane from the injected resolver', async () => {
    let asked = 0;
    const resolver = async () => {
      asked += 1;
      return readyPane;
    };
    const out = dispatchShellRequest(request(), config({ cryptoConfigPane: resolver }));
    expect(out.response.status).toBe(200);
    const extras = await out.response.deferredSectionExtras?.();
    expect(asked).toBe(1);
    expect(extras).toContain('data-crypto-config-form');
    expect(extras).toContain('data-delivery-encryption-toggle');
  });

  it('without a resolver it renders an honest error pane, not a blank one', async () => {
    const out = dispatchShellRequest(request(), config());
    const extras = await out.response.deferredSectionExtras?.();
    expect(extras).toContain('CRYPTO_CONFIG_NOT_WIRED');
  });

  it('a resolver that throws renders the error pane instead of crashing', async () => {
    const resolver = async () => {
      throw new Error('upstream exploded');
    };
    const out = dispatchShellRequest(request(), config({ cryptoConfigPane: resolver }));
    const extras = await out.response.deferredSectionExtras?.();
    expect(extras).toContain('CRYPTO_CONFIG_UNAVAILABLE');
    expect(extras).not.toContain('upstream exploded');
  });
});
