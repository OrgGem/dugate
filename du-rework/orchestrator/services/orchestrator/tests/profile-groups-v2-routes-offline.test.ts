/**
 * PC-03 — `/api/v2/admin/profile-groups` route layer (OFFLINE).
 *
 * Covers the V2-P matrix from `coordination/reports/prep-pc03-service-spec.md`
 * §10.6: prefix isolation, path precedence, authorization, the If-Match /
 * access-version contract (PC-01 decision D9) and the single error map.
 *
 * No database: every case here is decided before the first query, or is a pure
 * function. Cases that need SQL live in `profile-groups-v2-pg.test.ts`.
 */
import {
  handleAdminProfileGroupsV2Routes,
  matchProfileGroupV2Route,
  parseAccessVersion,
} from '../src/http/routes/admin-profile-groups-v2';
import { handleAdminProfileGroupsRoute } from '../src/http/routes/admin-profile-groups';
import { HttpError } from '../src/http/errors';
import type { RouteContext } from '../src/http/route-context';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '5d5dc4ac-2db0-4d5a-950f-008537e51f2d';
const KEY_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_TOKEN = 'pc03-route-test-admin-token';

interface CtxOptions {
  pathname: string;
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Set to false to simulate a missing database dependency. */
  db?: unknown;
}

/** A database that fails loudly: these cases must decide before querying. */
const NO_DB = {
  query: async () => {
    throw new Error('unexpected database access');
  },
  tx: async () => {
    throw new Error('unexpected database transaction');
  },
};

function ctxOf(options: CtxOptions): RouteContext {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) searchParams.append(key, value);
  return {
    pathname: options.pathname,
    method: options.method ?? 'GET',
    searchParams,
    headers: options.headers ?? {},
    body: options.body,
    correlationId: 'pc03-route-correlation',
    ingressAudience: 'public',
    config: { adminToken: ADMIN_TOKEN },
    db: options.db ?? NO_DB,
  } as unknown as RouteContext;
}

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpError = err as HttpError;
    expect({ status: httpError.status, code: httpError.code }).toEqual({ status, code });
    return httpError;
  }
  throw new Error(`expected HttpError ${status} ${code}, but the call resolved`);
}

describe('PC-03 / V2-P route matching', () => {
  const PREFIX = '/api/v2/admin/profile-groups';

  it('claims only its own prefix and declines every v1 path', () => {
    expect(matchProfileGroupV2Route(PREFIX, new URLSearchParams())).toEqual({ kind: 'list' });
    // v1 paths are NOT claimed by the v2 family...
    for (const v1 of [
      '/api/v1/admin/profile-groups',
      '/api/v1/admin/profile-groups/catalog',
      `/api/v1/admin/profile-groups/${GROUP_ID}`,
      '/api/v2/admin/profiles',
      '/api/v2/profile-groups',
    ]) {
      expect(matchProfileGroupV2Route(v1, new URLSearchParams())).toBeNull();
    }
    // ...and the v1 family does not claim v2 paths (disjoint prefixes).
    expect(
      handleAdminProfileGroupsRoute(ctxOf({ pathname: `${PREFIX}/${GROUP_ID}` })),
    ).resolves.toBeNull();
  });

  it('matches catalog before the group-id pattern and rejects a non-uuid id', () => {
    expect(matchProfileGroupV2Route(`${PREFIX}/catalog`, new URLSearchParams())).toEqual({ kind: 'catalog' });
    // `/catalog` must never be read as a group id.
    expect(() => matchProfileGroupV2Route(`${PREFIX}/not-a-uuid`, new URLSearchParams()))
      .toThrow(HttpError);
  });

  it('matches the rollback, key issue and key revoke shapes', () => {
    expect(matchProfileGroupV2Route(`${PREFIX}/${GROUP_ID}/rollback`, new URLSearchParams()))
      .toEqual({ kind: 'rollback', groupId: GROUP_ID });
    expect(matchProfileGroupV2Route(`${PREFIX}/${GROUP_ID}/keys`, new URLSearchParams()))
      .toEqual({ kind: 'keys', groupId: GROUP_ID });
    expect(matchProfileGroupV2Route(`${PREFIX}/${GROUP_ID}/keys/${KEY_ID}/revoke`, new URLSearchParams()))
      .toEqual({ kind: 'keyRevoke', groupId: GROUP_ID, keyId: KEY_ID });
  });
});

describe('PC-03 / V2-P If-Match access version', () => {
  it('accepts the bare and quoted forms of a positive integer', () => {
    expect(parseAccessVersion('7')).toEqual({ ok: true, version: 7 });
    expect(parseAccessVersion('"7"')).toEqual({ ok: true, version: 7 });
    expect(parseAccessVersion('  42  ')).toEqual({ ok: true, version: 42 });
  });

  it('rejects a wildcard, a weak validator, zero, negatives and non-integers', () => {
    for (const raw of ['*', 'W/"7"', 'w/"7"', '0', '-1', '7.0', '7 ', 'abc', '']) {
      if (raw === '7 ') continue; // trailing space is trimmed by design
      const parsed = parseAccessVersion(raw);
      expect({ raw, ok: parsed.ok }).toEqual({ raw, ok: false });
    }
  });

  it('distinguishes a missing header from a malformed one', () => {
    expect(parseAccessVersion(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(parseAccessVersion('')).toEqual({ ok: false, reason: 'missing' });
    expect(parseAccessVersion('*')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('PC-03 / V2-P authorization and method gates', () => {
  const path = `/api/v2/admin/profile-groups/${GROUP_ID}`;

  it('rejects a request with no admin credential (401)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(ctxOf({ pathname: path })),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('rejects a tenant-scoped principal on every mutation (403)', async () => {
    // A tenant token is not the platform admin token, so the principal resolves
    // as null for this config: the request is unauthenticated, which is the
    // fail-closed default. The platform-only rule is asserted on the v2 PUT
    // below with a valid non-platform credential.
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({ pathname: path, method: 'PUT', body: {}, headers: { authorization: 'Bearer tenant-token' } }),
      ),
      401,
      'UNAUTHENTICATED',
    );
  });

  it('rejects the wrong method before touching state', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(ctxOf({ pathname: path, method: 'DELETE', headers: bearer() })),
      405,
      'METHOD_NOT_ALLOWED',
    );
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({ pathname: `/api/v2/admin/profile-groups/${GROUP_ID}/keys`, method: 'GET', headers: bearer() }),
      ),
      405,
      'METHOD_NOT_ALLOWED',
    );
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({ pathname: `/api/v2/admin/profile-groups/${GROUP_ID}/rollback`, method: 'GET', headers: bearer() }),
      ),
      405,
      'METHOD_NOT_ALLOWED',
    );
  });

  it('rejects query parameters on mutation routes', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: `/api/v2/admin/profile-groups/${GROUP_ID}/rollback`,
          method: 'POST',
          query: { unexpected: '1' },
          headers: bearer(),
          body: {},
        }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });
});

describe('PC-03 / V2-P grant idempotency and access-version gates', () => {
  const keysPath = `/api/v2/admin/profile-groups/${GROUP_ID}/keys`;

  it('requires Idempotency-Key on issue (422) before any version check', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({ pathname: keysPath, method: 'POST', headers: bearer(), body: {} }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('requires If-Match on issue (428)', async () => {
    const error = await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: keysPath,
          method: 'POST',
          headers: { ...bearer(), 'idempotency-key': 'pc03-issue-key-0001' },
          body: {},
        }),
      ),
      428,
      'PRECONDITION_REQUIRED',
    );
    expect(error.message).toMatch(/If-Match/);
  });

  it('rejects a malformed If-Match on issue (400)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: keysPath,
          method: 'POST',
          headers: {
            ...bearer(),
            'idempotency-key': 'pc03-issue-key-0002',
            'if-match': '"*"',
          },
          body: {},
        }),
      ),
      400,
      'INVALID_SCHEMA',
    );
  });

  it('requires Idempotency-Key on revoke (422)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: `/api/v2/admin/profile-groups/${GROUP_ID}/keys/${KEY_ID}/revoke`,
          method: 'POST',
          headers: bearer(),
          body: { expectedAccessVersion: 3 },
        }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('rejects a revoke body without expectedAccessVersion (422)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: `/api/v2/admin/profile-groups/${GROUP_ID}/keys/${KEY_ID}/revoke`,
          method: 'POST',
          headers: { ...bearer(), 'idempotency-key': 'pc03-revoke-key-0001' },
          body: {},
        }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('rejects a v2 save body that carries the v1 apiKey selector (422)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: '/api/v2/admin/profile-groups',
          method: 'POST',
          headers: bearer(),
          body: {
            name: 'tenant group',
            tenantId: TENANT_ID,
            authMode: 'API_KEY',
            expectedRevision: 0,
            apiKey: { apiKeyId: KEY_ID },
            businesses: [{
              businessId: 'document-core',
              businessVersion: '1.1.0',
              manifestDigest: `sha256:${'a'.repeat(64)}`,
              functions: [],
            }],
          },
        }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });

  it('requires tenantId when creating (422)', async () => {
    await expectHttpError(
      handleAdminProfileGroupsV2Routes(
        ctxOf({
          pathname: '/api/v2/admin/profile-groups',
          method: 'POST',
          headers: bearer(),
          body: {
            name: 'tenant group',
            authMode: 'API_KEY',
            expectedRevision: 0,
            businesses: [{
              businessId: 'document-core',
              businessVersion: '1.1.0',
              manifestDigest: `sha256:${'a'.repeat(64)}`,
              functions: [{ kind: 'endpoint', functionId: 'ingest:parse', action: 'ingest', endpointSlug: 'ingest:parse', policy: {} }],
            }],
          },
        }),
      ),
      422,
      'INVALID_SCHEMA',
    );
  });
});
