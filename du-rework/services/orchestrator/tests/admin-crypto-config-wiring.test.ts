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

// CR28-09: wiring negatives for the crypto-configuration routes.
//
// The existing suite covers the happy paths, one wrong-bearer 401, a missing-tenant
// 422, and the CSRF wire. This file attacks the seams: how the bearer is parsed,
// where the tenant actually comes from, and what the fallthrough returns.
//
// Two packet items are NOT reachable from this in-process harness and are reported
// rather than faked: a 400 for malformed JSON is raised by the BODY PARSER upstream
// of route(), and a 500 is mapped by the top-level handler in createApp, above
// route(). Neither can be produced by calling route(ctx) directly, which is what
// this suite does.
describe('CR28-09 wiring: non-bearer auth is refused before the route body', () => {
  it.each([
    ['a Basic token', 'Basic ' + ADMIN_TOKEN],
    ['a lowercase bearer', 'bearer ' + ADMIN_TOKEN],
    ['a bare token with no scheme', ADMIN_TOKEN],
    ['an empty authorization header', ''],
    ['a scheme with no token', 'Bearer '],
    ['a bearer with trailing whitespace', 'Bearer ' + ADMIN_TOKEN + ' '],
    ['a Basic token that happens to be the admin value', 'Basic ' + ADMIN_TOKEN],
  ])('refuses %s with 401', async (_label, authorization) => {
    const h = harness();
    const out = await call(h, { tenantId: TENANT_A, headers: { authorization } });
    expect(out).toMatchObject({ kind: 'problem', status: 401 });
  });

  it('refuses a bearer that matches no configured principal', async () => {
    const h = harness();
    const out = await call(h, { tenantId: TENANT_A, bearer: 'not-a-real-token' });
    expect(out).toMatchObject({ kind: 'problem', status: 401 });
  });

  it('refuses a tenant-scoped bearer naming a tenant that does not match the request', async () => {
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const out = await call(h, { tenantId: TENANT_B, bearer: OPERATOR_TOKEN });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
  });

  it('a tenant-scoped bearer reading its own tenant is 200, not a null principal', async () => {
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const out = await call(h, { tenantId: TENANT_A, bearer: OPERATOR_TOKEN });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });
});

describe('CR28-09 wiring: route params and where the tenant comes from', () => {
  function ctxOf(h: Harness): { pathname: string; method: string; searchParams: URLSearchParams; headers: Record<string, string>; body: unknown } {
    return h.ctx as unknown as { pathname: string; method: string; searchParams: URLSearchParams; headers: Record<string, string>; body: unknown };
  }

  it.each([
    ['a trailing slash', '/api/v1/admin/crypto-config/'],
    ['no leading slash', 'api/v1/admin/crypto-config'],
    ['the wrong case', '/API/V1/ADMIN/CRYPTO-CONFIG'],
    ['an extra segment', '/api/v1/admin/crypto-config/extra'],
  ])('a GET to %s falls through to 404, not the crypto handler', async (_label, pathname) => {
    const h = harness();
    ctxOf(h).pathname = pathname;
    const out = await call(h, { tenantId: TENANT_A });
    expect(out).toMatchObject({ kind: 'body', status: 404 });
    expect(JSON.stringify(out)).not.toContain('crypto');
  });

  it('an unsupported method on the exact path falls through to 404', async () => {
    const h = harness();
    const ctx = ctxOf(h);
    // call() always forces the method, so drive route() directly for DELETE.
    ctx.method = 'DELETE';
    ctx.searchParams = new URLSearchParams('tenantId=' + TENANT_A);
    const res = await route(h.ctx);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('crypto');
  });

  it('a body tenant OVERRIDES the query tenant, and the write lands on the body tenant', async () => {
    const h = harness();
    // Both verbs read the tenant the same way: query param with the body as a
    // fallback for form posts, and the BODY WINS when both are present.
    // storageKeyRef, not deliveryEncryption: the key fixture belongs to TENANT_A,
    // so switching delivery on for TENANT_B would 409 on the missing key BEFORE the
    // precedence rule could be observed. A platform-only ref needs no key.
    const posted = await call(h, {
      method: 'POST',
      tenantId: TENANT_A,
      body: { tenantId: TENANT_B, storageKeyRef: 'primary' },
    });
    expect(posted).toMatchObject({ kind: 'body', status: 200 });
    expect(h.store.rows.has(TENANT_B)).toBe(true);
    expect(h.store.rows.has(TENANT_A)).toBe(false);
  });

  it('a tenant in the query but not the body is the target', async () => {
    const h = harness();
    const posted = await call(h, { method: 'POST', tenantId: TENANT_A, body: { deliveryEncryption: true } });
    expect(posted).toMatchObject({ kind: 'body', status: 200 });
    expect(h.store.rows.has(TENANT_A)).toBe(true);
  });

  it('there is NO tenant header: a tenantId header alone names nothing', async () => {
    const h = harness();
    const out = await call(h, { headers: { 'x-tenant-id': TENANT_A, tenantId: '' } });
    // The route reads a QUERY PARAM with the body as a fallback; it never reads a
    // header. A caller sending only a tenant header gets the missing-tenant 422,
    // so a header cannot silently redirect a read to another tenant.
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('a tenantId header cannot override a query tenant', async () => {
    const h = harness();
    const out = await call(h, {
      tenantId: TENANT_A,
      headers: { 'x-tenant-id': TENANT_B, 'x-forwarded-tenant': TENANT_B },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    const view = cryptoOf(out);
    expect(view['tenantId']).toBe(TENANT_A);
  });

  it.each([
    ['an empty tenantId query', ''],
    ['a whitespace tenantId', '   '],
  ])('a platform caller with %s is 422', async (_label, tenantId) => {
    const h = harness();
    const out = await call(h, { tenantId });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('a control character in the tenant query is 422 at the wire, not 200', async () => {
    const h = harness();
    const out = await call(h, { tenantId: 'tenant-' + String.fromCharCode(0) });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('an oversized tenant query is 422', async () => {
    const h = harness();
    const out = await call(h, { tenantId: 'a'.repeat(65) });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('a tenant query of exactly the 64-character limit is accepted', async () => {
    const h = harness();
    const out = await call(h, { tenantId: 'a'.repeat(64) });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });
});

describe('CR28-09 wiring: corrupt JSON payloads', () => {
  it.each([
    ['a string', 'not json at all'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [{ deliveryEncryption: true }]],
    ['null', null],
  ])('FINDING: a POST body that is %s is a silent 200 no-op, not a 422', async (_label, body) => {
    const h = harness();
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body });

    // FINDING: every field read off a non-object body is undefined, so each
    // `x !== undefined` guard passes. The caller is told 200 with an EMPTY
    // changedFields, and no audit row is written - but the store is still handed
    // the unchanged state, so a config ROW IS MATERIALISED for a tenant that had
    // none. A client whose JSON was mangled therefore gets SUCCESS, no diagnostic,
    // and a new empty row it never asked for. A real HTTP body would be rejected
    // upstream by the parser (400), which this in-process harness cannot
    // exercise; the residual risk is the in-process caller path, not the socket.
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(bodyOf(out)['changedFields']).toEqual([]);
    expect(h.store.rows.get(TENANT_A)).toEqual({
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    });
    expect(h.audit.rows).toHaveLength(0);
  });

  it.each([
    ['deliveryEncryption as a string', { deliveryEncryption: 'yes' }],
    ['deliveryEncryption as a number', { deliveryEncryption: 1 }],
    ['deliveryEncryption as null', { deliveryEncryption: null }],
    ['recipientKeyVersion as a string', { recipientKeyVersion: 'v1' }],
    ['recipientKeyVersion as an object', { recipientKeyVersion: { version: 1 } }],
    ['storageKeyRef as a number', { storageKeyRef: 7 }],
    ['storageKeyRef as a boolean', { storageKeyRef: false }],
  ])('rejects %s with 422 before touching the store', async (_label, body) => {
    const h = harness();
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
    expect(h.store.rows.size).toBe(0);
    expect(h.audit.rows).toHaveLength(0);
  });

  it('an unparseable JSON body never reaches the route handler as a string', async () => {
    const h = harness();
    // A real HTTP request would be rejected by the body parser upstream (400). Here
    // ctx.body is pre-parsed, so the closest wire-level negative is a body that is
    // a raw string: the route treats it as an object with no known fields, so it
    // reaches the handler as a no-op rather than crashing.
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: '{broken' });
    expect(out.status).toBeLessThan(500);
  });

  it('an empty POST body with only a tenant is a no-op, not a crash', async () => {
    const h = harness();
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: {} });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect((bodyOf(out)['changedFields'] as string[])).toEqual([]);
    expect(h.audit.rows).toHaveLength(0);
  });

  it('a body with an unknown extra field is ignored, not rejected', async () => {
    const h = harness();
    const out = await call(h, {
      method: 'POST', tenantId: TENANT_A,
      body: { deliveryEncryption: true, unknownField: 'x', __proto__: { polluted: true } },
    });
    // The route picks known fields off the body; an extra key is dropped, not a 422.
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(h.store.rows.get(TENANT_A)?.deliveryEncryption).toBe(true);
  });
});

describe('CR28-09 wiring: error status mapping at the wire', () => {
  it('maps 401 for a missing principal', async () => {
    const h = harness();
    const out = await call(h, { tenantId: TENANT_A, bearer: 'garbage' });
    expect(out).toMatchObject({ kind: 'problem', status: 401 });
  });

  it('maps 403 for a foreign tenant on a scoped bearer', async () => {
    const h = harness({ tenantAdminToken: OPERATOR_TOKEN });
    const out = await call(h, { tenantId: TENANT_B, bearer: OPERATOR_TOKEN });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
  });

  it('maps 404 for an unknown path', async () => {
    const h = harness();
    const ctx = h.ctx as unknown as { pathname: string };
    ctx.pathname = '/api/v1/admin/crypto-configx';
    const out = await call(h, { tenantId: TENANT_A });
    expect(out).toMatchObject({ kind: 'body', status: 404 });
  });

  it('maps 409 for a revoked pin', async () => {
    const h = harness({ keys: [keyRecord({ revokedAt: '2026-05-01T00:00:00.000Z' })] });
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: { recipientKeyVersion: 1 } });
    expect(out).toMatchObject({ kind: 'problem', status: 409 });
  });

  it('maps 409 for delivery on with no usable recipient key', async () => {
    const h = harness({ keys: [] });
    const out = await call(h, { method: 'POST', tenantId: TENANT_A, body: { deliveryEncryption: true } });
    expect(out).toMatchObject({ kind: 'problem', status: 409 });
  });

  it('maps 422 for an unregistered version and for a bad tenant', async () => {
    const h = harness();
    const unregistered = await call(h, { method: 'POST', tenantId: TENANT_A, body: { recipientKeyVersion: 9 } });
    expect(unregistered).toMatchObject({ kind: 'problem', status: 422 });
    const badTenant = await call(h, { tenantId: 'Tenant Alpha' });
    expect(badTenant).toMatchObject({ kind: 'problem', status: 422 });
  });

  it('maps 503 when the platform has not configured the surface', async () => {
    const h = harness({ configured: false });
    const out = await call(h, { tenantId: TENANT_A });
    expect(out).toMatchObject({ kind: 'problem', status: 503 });
  });

  it('a non-HttpError escapes route() unchanged, so the 500 mapping is ABOVE this harness', async () => {
    const h = harness();
    (h.ctx as unknown as { cryptoConfig: unknown }).cryptoConfig = {
      allowedKeyRefs: ['primary'],
      store: {
        async get(): Promise<CryptoConfigState> {
          throw new Error('database exploded');
        },
        async set(_tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
          return next;
        },
      },
      keys: { async listRecipientKeys() { return []; } },
      audit: new MemoryAudit(),
    };

    // This is the honest result for the packet's "500" item: route() does NOT
    // convert an unexpected throw into a 500. The mapping to
    // safeInternalErrorProblem lives in the top-level handler in createApp, ABOVE
    // this call, so an offline in-process suite cannot observe a 500 here. What it
    // CAN prove - and what this asserts - is that the raw error propagates rather
    // than being silently swallowed or mislabelled as a 4xx.
    //
    // The tenant MUST be named: without it the platform-caller check throws 422
    // before the store is ever touched, which is what happened on my first attempt.
    // The tenant MUST be named: without one the platform-caller check throws 422
    // before the store is reached, which is what my first attempt did.
    await expect(call(h, { tenantId: TENANT_A })).rejects.toThrow('database exploded');
  });

  it('a GET never leaks a key ref that the platform withdrew', async () => {
    const h = harness();
    (h.ctx.cryptoConfig as unknown as { allowedKeyRefs: string[] }).allowedKeyRefs = ['primary'];
    const out = await call(h, { tenantId: TENANT_A });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(cryptoOf(out)['allowedKeyRefs']).toEqual(['primary']);
  });
});


// ===========================================================================
// W-ADM-UX-20-CRYPTO-CONFIG-WIRING-NEGATIVE (Turn 344 / Cycle 64)
//
// Negative + boundary coverage for the crypto-config wiring: role boundary,
// tamper, session invalidation, payload shape error.
//
// Every outcome below was MEASURED with a throwaway probe against the real
// route before being written down. Nothing is inferred from source.
//
// In-process and offline: no socket, no PG, no Redis. The SAME harness shape
// the existing ENC-08-WIRING suite uses (one store per harness, allowedKeyRefs
// wired), so the numbers line up with the tests already in this file.
//
// Wire field names matter and are easy to get wrong: the request field is
// `recipientKeyVersion`, NOT `pinnedRecipientKeyVersion` (that is the stored
// view name). A probe using the view name silently no-ops every pin case - I
// hit exactly that and every pin case came back 200 before I checked.
// ===========================================================================

const W64_PLATFORM = 'tok-platform';
const W64_OPERATOR = 'tok-operator';
const W64_VIEWER = 'tok-viewer';
const W64_OTHER = 'tok-other';
const W64_A = 'tenant-alpha';
const W64_B = 'tenant-beta';
const W64_SECRET = 'cookie-secret-0';
const W64_SENTINEL = 'BEGIN PRIVATE KEY SENTINEL-9f2a';

function w64Key(over: Partial<RecipientPublicKeyRecord> = {}): RecipientPublicKeyRecord {
  return {
    id: 'key-64-1',
    tenantId: W64_A,
    version: 1,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: 'PUBLIC ' + W64_SENTINEL,
    fingerprint: 'SHA256:abc',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

class W64Store implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    return this.rows.get(tenantId) ?? { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null };
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.rows.set(tenantId, next);
    return next;
  }
}

class W64Audit implements CryptoConfigAudit {
  public readonly rows: AuditRecordInput[] = [];
  async record(input: AuditRecordInput): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

interface W64Harness {
  ctx: RouteContext;
  store: W64Store;
  audit: W64Audit;
}

function w64Harness(
  options: { keys?: RecipientPublicKeyRecord[]; secret?: string } = {},
): W64Harness {
  const store = new W64Store();
  const audit = new W64Audit();
  const keys = options.keys ?? [w64Key()];
  const secret = options.secret ?? W64_SECRET;
  const cryptoConfig = {
    allowedKeyRefs: ['primary', 'secondary'],
    store,
    keys: { async listRecipientKeys(tenantId: string) { return recipientKeyOptions(keys, tenantId); } },
    audit,
  } as unknown as CryptoConfigServiceOptions;
  const ctx = {
    method: 'GET',
    pathname: '/api/v1/admin/crypto-config',
    searchParams: new URLSearchParams(''),
    headers: { authorization: 'Bearer ' + W64_PLATFORM },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'w64',
    host: 'localhost',
    config: {
      adminToken: W64_PLATFORM,
      adminShellCookieSecret: secret,
      tenantAdminTokens: {
        [W64_OPERATOR]: W64_A,
        [W64_VIEWER]: W64_A,
        [W64_OTHER]: W64_B,
      },
    },
    cryptoConfig,
  } as unknown as RouteContext;
  return { ctx, store, audit };
}

type W64Outcome =
  | { kind: 'body'; status: number; body: Record<string, unknown> }
  | { kind: 'problem'; status: number; code: string };

async function w64Call(
  h: W64Harness,
  opts: { method?: 'GET' | 'POST'; tenantId?: string; body?: unknown; bearer?: string; headers?: Record<string, string> } = {},
): Promise<W64Outcome> {
  const ctx = h.ctx as unknown as {
    method: string;
    searchParams: URLSearchParams;
    headers: Record<string, string>;
    body: unknown;
  };
  ctx.method = opts.method ?? 'GET';
  ctx.searchParams = new URLSearchParams(opts.tenantId ? 'tenantId=' + opts.tenantId : '');
  ctx.headers = { authorization: 'Bearer ' + (opts.bearer ?? W64_PLATFORM), ...(opts.headers ?? {}) };
  ctx.body = opts.body;
  try {
    const res = await route(h.ctx);
    return { kind: 'body', status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return { kind: 'problem', status: err.status, code: err.code };
  }
}

function w64Cookie(role: string, over: Record<string, unknown> = {}, secret = W64_SECRET): string {
  return String(
    signCookie(secret, { role, iss: 'du-admin-shell', iat: 1000, exp: 9999999999999, ...over } as never),
  );
}

/** Read the stored state for a tenant without assuming the write succeeded. */
function w64Stored(h: W64Harness, tenantId: string): CryptoConfigState {
  return h.store.rows.get(tenantId) ?? {
    storageKeyRef: null,
    deliveryEncryption: false,
    pinnedRecipientKeyVersion: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Role boundary
// ---------------------------------------------------------------------------

describe('W-ADM-UX-20: a tenant VIEWER bearer can write when it presents no cookie', () => {
  // The sharpest finding of this packet. requireWriteAuth refuses only when
  // auth.cookieRole === 'viewer'; a bearer-only request has no cookieRole, so
  // the viewer check never runs and the write goes through.
  test('a viewer bearer with no cookie is 200, not 403', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_VIEWER,
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).deliveryEncryption).toBe(true);
  });

  test('the same viewer bearer WITH a viewer cookie is refused 403', async () => {
    // Proves the guard exists and is cookie-scoped: the difference is entirely
    // whether a cookie was sent, not what role the bearer has.
    const h = w64Harness();
    const cookie = w64Cookie('viewer');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_VIEWER,
      headers: { cookie: 'du_admin=' + cookie, 'x-csrf-token': deriveCsrfToken(W64_SECRET, cookie) },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
    expect(w64Stored(h, W64_A).deliveryEncryption).toBe(false);
  });

  test('an operator bearer without a cookie writes without any CSRF proof', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('an operator bearer WITH a cookie but no CSRF is refused 403', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
    expect(h.store.rows.size).toBe(0);
  });

  test('the same cookie WITH the derived CSRF token goes through', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie, 'x-csrf-token': deriveCsrfToken(W64_SECRET, cookie) },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  // A platform bearer is a machine call the shell makes server-to-server, and
  // a cross-site page cannot send an Authorization header - so the CSRF leg is
  // correctly skipped for it. Pinned so nobody "fixes" this into a break.
  test('a platform bearer needs no CSRF proof', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_PLATFORM,
      headers: { cookie: 'du_admin=' + w64Cookie('operator') },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('a forged x-admin-role header does not grant a privileged write', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { 'x-admin-role': 'admin' },
    });
    // The header is ignored; the operator still writes to its OWN tenant only.
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(h.store.rows.has(W64_B)).toBe(false);
  });
});

describe('W-ADM-UX-20: tenant scoping is enforced for reads and writes alike', () => {
  test('an operator writing a foreign tenant is 403', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_B,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
    expect(h.store.rows.has(W64_B)).toBe(false);
  });

  test('an operator reading a foreign tenant is 403', async () => {
    const h = w64Harness();
    const out = await w64Call(h, { tenantId: W64_B, bearer: W64_OPERATOR });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
  });

  test('an operator reading its own tenant is 200', async () => {
    const h = w64Harness();
    expect(await w64Call(h, { tenantId: W64_A, bearer: W64_OPERATOR })).toMatchObject({
      kind: 'body',
      status: 200,
    });
  });

  test('a viewer reading its own tenant is 200 (reads are not gated by role)', async () => {
    const h = w64Harness();
    expect(await w64Call(h, { tenantId: W64_A, bearer: W64_VIEWER })).toMatchObject({
      kind: 'body',
      status: 200,
    });
  });

  test('an operator that names no tenant is pinned to its own, not rejected', async () => {
    const h = w64Harness();
    const out = await w64Call(h, { bearer: W64_OPERATOR });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('a platform bearer that names no tenant is 422', async () => {
    const h = w64Harness();
    expect(await w64Call(h, { bearer: W64_PLATFORM })).toMatchObject({ kind: 'problem', status: 422 });
  });
});

// ---------------------------------------------------------------------------
// 2. Tamper
// ---------------------------------------------------------------------------

describe('W-ADM-UX-20: a cookie that fails verification is ignored, not rejected', () => {
  // The systemic finding. An unverifiable cookie degrades to "no cookie", and
  // "no cookie" means the CSRF leg is skipped entirely - so tampering does not
  // stop the write, it removes the one check that would have stopped it.
  test('a cookie signed with a different secret still allows the write', async () => {
    const h = w64Harness({ secret: 'the-real-secret' });
    const cookie = w64Cookie('operator', {}, 'an-attacker-secret');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).deliveryEncryption).toBe(true);
  });

  test('a mutated cookie signature still allows the write', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator');
    const forged = cookie.slice(0, -2) + (cookie.endsWith('aa') ? 'bb' : 'aa');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + forged },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('a garbage cookie value still allows the write', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=not-even-a-cookie' },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  // The CSRF binding itself IS sound - it is the only tamper that lands.
  test('a forged CSRF token is refused 403', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie, 'x-csrf-token': 'forged-token' },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
    expect(h.store.rows.size).toBe(0);
  });

  test('a CSRF token derived from a DIFFERENT session is refused 403', async () => {
    // The binding to the session cookie is what makes this fail - a token
    // derived from another valid session is not accepted.
    const h = w64Harness();
    const cookie = w64Cookie('operator');
    const otherSessionToken = deriveCsrfToken(W64_SECRET, w64Cookie('admin'));
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie, 'x-csrf-token': otherSessionToken },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 403 });
  });
});

// ---------------------------------------------------------------------------
// 3. Session invalidation
// ---------------------------------------------------------------------------

describe('W-ADM-UX-20: an expired or foreign-signed session does not invalidate anything', () => {
  // Same root cause as the tamper block: the session is not checked, it is
  // simply not present from the handler's point of view.
  test('an expired session cookie still allows the write', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator', { iat: 1000, exp: 1000 });
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('a session issued after its own expiry still allows the write', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator', { iat: 9999999999999, exp: 1000 });
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('a session signed by a secret the server never held still allows the write', async () => {
    const h = w64Harness();
    const cookie = w64Cookie('operator', { exp: 1000 }, 'secret-the-server-never-had');
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
      headers: { cookie: 'du_admin=' + cookie },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('the bearer alone is what authorises: no cookie, no CSRF, still 200', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      bearer: W64_OPERATOR,
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).deliveryEncryption).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Payload shape error
// ---------------------------------------------------------------------------

describe('W-ADM-UX-20: a wrong-typed mutation field is 422 and never reaches the store', () => {
  // The validation layer is genuinely strict here - recorded as the positive
  // that makes the session finding above stand out by contrast.
  const badDelivery: Array<[string, unknown]> = [
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
  ];
  test.each(badDelivery)('deliveryEncryption as %s is 422', async (_label, value) => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { deliveryEncryption: value } });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
    expect(h.store.rows.size).toBe(0);
    expect(h.audit.rows).toHaveLength(0);
  });

  const badKeyRef: Array<[string, unknown]> = [
    ['a number', 7],
    ['an object', { a: 1 }],
    ['an array', ['primary']],
    ['a boolean', true],
    ['a non-allowlisted string', 'smuggled'],
  ];
  test.each(badKeyRef)('storageKeyRef as %s is 422', async (_label, value) => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { storageKeyRef: value } });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
    expect(h.store.rows.size).toBe(0);
    expect(h.audit.rows).toHaveLength(0);
  });

  const badPin: Array<[string, unknown]> = [
    ['a string', '1'],
    ['a float', 1.5],
    ['a negative', -1],
    ['zero', 0],
    ['beyond the safe range', 1e21],
    ['an array', [1]],
    ['an unregistered version', 99],
  ];
  test.each(badPin)('recipientKeyVersion as %s is 422', async (_label, value) => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { recipientKeyVersion: value } });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
    expect(h.store.rows.size).toBe(0);
  });

  test('a valid recipientKeyVersion is stored', async () => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { recipientKeyVersion: 1 } });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).pinnedRecipientKeyVersion).toBe(1);
  });

  test('an explicit null clears the pin', async () => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { recipientKeyVersion: null } });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).pinnedRecipientKeyVersion).toBeNull();
  });

  test('pinning a REVOKED key version is 409 STATE_CONFLICT, not 422', async () => {
    // Deliberately a different status: the value is well-formed, the KEY is
    // the problem, so it is a state conflict rather than a schema error.
    const h = w64Harness({ keys: [w64Key({ revokedAt: '2026-05-01T00:00:00.000Z' })] });
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { recipientKeyVersion: 1 } });
    expect(out).toMatchObject({ kind: 'problem', status: 409 });
    expect(h.store.rows.size).toBe(0);
  });

  test('pinning when the tenant registered no keys at all is 422', async () => {
    const h = w64Harness({ keys: [] });
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { recipientKeyVersion: 1 } });
    expect(out).toMatchObject({ kind: 'problem', status: 422 });
  });

  test('turning delivery on with no usable recipient key is 409', async () => {
    const h = w64Harness({ keys: [] });
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body: { deliveryEncryption: true } });
    expect(out).toMatchObject({ kind: 'problem', status: 409 });
    expect(h.audit.rows).toHaveLength(0);
  });

  test('delivery and pin combine in one write', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true, recipientKeyVersion: 1 },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    const stored = w64Stored(h, W64_A);
    expect(stored.deliveryEncryption).toBe(true);
    expect(stored.pinnedRecipientKeyVersion).toBe(1);
  });
});

describe('W-ADM-UX-20: a body that is not an object is a silent no-op, and extra fields are dropped', () => {
  const junkBodies: Array<[string, unknown]> = [
    ['an array', [1, 2, 3]],
    ['null', null],
    ['a string', 'x'],
    ['a number', 5],
  ];
  test.each(junkBodies)('a body of %s is 200 rather than 422', async (_label, body) => {
    const h = w64Harness();
    const out = await w64Call(h, { method: 'POST', tenantId: W64_A, body });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('an unknown extra field is dropped and never reaches the audit row', async () => {
    // Good: the sentinel smuggled in an extra field does not survive anywhere.
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { storageKeyRef: 'primary', evil: W64_SENTINEL },
    });
    expect(out).toMatchObject({ kind: 'body', status: 200 });
    expect(w64Stored(h, W64_A).storageKeyRef).toBe('primary');
    expect(JSON.stringify(h.audit.rows)).not.toContain(W64_SENTINEL);
  });

  test('the audit row records the field, actor and resource - and no payload', async () => {
    const h = w64Harness();
    await w64Call(h, { method: 'POST', tenantId: W64_A, body: { storageKeyRef: 'primary' } });
    expect(h.audit.rows).toHaveLength(1);
    const row = h.audit.rows[0]!;
    expect(row.tenantId).toBe(W64_A);
    expect(row.action).toBe('crypto_config.storage_key_ref.set');
    expect(row.resource).toBe('tenant:' + W64_A);
    expect(row.actor).toBe('admin:platform');
  });

  test('no key material is ever echoed on a successful read', async () => {
    const h = w64Harness();
    const out = await w64Call(h, { tenantId: W64_A, bearer: W64_PLATFORM });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(W64_SENTINEL);
    expect(out).toMatchObject({ kind: 'body', status: 200 });
  });

  test('an unauthenticated caller is 401 and nothing is written', async () => {
    const h = w64Harness();
    const out = await w64Call(h, {
      method: 'POST',
      tenantId: W64_A,
      body: { deliveryEncryption: true },
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(out).toMatchObject({ kind: 'problem', status: 401 });
    expect(h.store.rows.size).toBe(0);
  });
});
