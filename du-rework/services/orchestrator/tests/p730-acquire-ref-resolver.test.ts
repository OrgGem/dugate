import type { Db } from '../src/db/db';
import {
  createAcquisitionRefResolver,
  SourceAuthDeniedError,
  withSourceAuth,
} from '../src/modules/operations/acquisition-ref-resolver';
import { encryptFileUrlAuthConfig } from '../src/modules/profiles/file-url-auth';

/**
 * P730-ACQUIRE (W1c) — resolver unit suite.
 *
 * Every denial case asserts the TYPED code and that the fetch seam was never
 * reached (there is no fetch here at all — the wrapper suite below owns the
 * transport half). The credential never appears in an error message: each
 * rejection is checked against a fixed, secret-free shape.
 */

const OP = '61000000-0000-4000-8000-000000000001';
const TENANT = '60000000-0000-4000-8000-000000000001';
const PROFILE = '63000000-0000-4000-8000-000000000001';
const REVISION = 7;

const ENV_A = { ENCRYPTION_KEY: 'unit-test-key-alpha-0000000000000' };
const ENV_B = { ENCRYPTION_KEY: 'unit-test-key-bravo-0000000000000' };

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

interface ResolverDbConfig {
  snapshot?: unknown;
  opAbsent?: boolean;
  binding?: { tenantId: string; cipher: unknown } | null;
}

function makeResolverDb(config: ResolverDbConfig): { db: Db; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    const sql = normalize(text);
    calls.push({ sql, params });
    if (sql.includes('FROM operations WHERE id=$1 AND tenant_id=$2')) {
      return config.opAbsent === true
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ snapshot: config.snapshot ?? null }] };
    }
    if (sql.includes('FROM profile_bindings WHERE profile_id=$1 AND revision=$2')) {
      return config.binding == null
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [config.binding] };
    }
    throw new Error('unrouted SQL in resolver test: ' + sql);
  };
  return { db: { query, tx: async (fn: never) => fn, pool: {} } as unknown as Db, calls };
}

function resolverWith(config: ResolverDbConfig, env: Record<string, string | undefined> = ENV_A, onLegacyPlaintext?: () => void) {
  const handled = makeResolverDb(config);
  const resolver = createAcquisitionRefResolver({ db: handled.db, env, onLegacyPlaintext });
  return { resolver, calls: handled.calls };
}

function pinnedSnapshot(overrides: Partial<{ configured: boolean; ref: unknown }> = {}) {
  return {
    fileUrlAuthConfigured: overrides.configured ?? true,
    credentialRef: overrides.ref ?? { tenantId: TENANT, profileId: PROFILE, profileRevision: REVISION },
    enabled: true,
  };
}

async function expectDenied(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'SourceAuthDeniedError', code });
}

describe('P730-ACQUIRE resolver — happy paths', () => {
  it('returns bearer auth from the pinned revision cipher', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token-1' }, ENV_A);
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await expect(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT })).resolves.toEqual({
      kind: 'bearer',
      token: 'source-token-1',
    });
  });

  it('returns header auth from the pinned revision cipher', async () => {
    const cipher = encryptFileUrlAuthConfig(
      { type: 'header', header_name: 'x-api-key', header_value: 'hk-1' },
      ENV_A
    );
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await expect(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT })).resolves.toEqual({
      kind: 'header',
      headerName: 'x-api-key',
      headerValue: 'hk-1',
    });
  });

  it('NULL snapshot (legacy-mode operation) resolves to no auth', async () => {
    const { resolver } = resolverWith({ snapshot: null });
    await expect(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT })).resolves.toEqual({ kind: 'none' });
  });

  it('configured=false resolves to no auth without touching the binding table', async () => {
    const { resolver, calls } = resolverWith({ snapshot: pinnedSnapshot({ configured: false }) });
    await expect(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT })).resolves.toEqual({ kind: 'none' });
    expect(calls.some((c) => c.sql.includes('profile_bindings'))).toBe(false);
  });

  it('reads a legacy plaintext row with the warn-once callback and still resolves auth', async () => {
    const stored = JSON.stringify({ type: 'bearer', token: 'legacy-token' });
    const warn = jest.fn();
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher: stored } }, ENV_A, warn);
    await expect(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT })).resolves.toEqual({
      kind: 'bearer',
      token: 'legacy-token',
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('P730-ACQUIRE resolver — typed denials before any network', () => {
  it('denies URL-query credentials by design (Δ2) even when decryptable', async () => {
    const cipher = encryptFileUrlAuthConfig(
      { type: 'query', query_key: 'token', query_value: 'should-never-travel' },
      ENV_A
    );
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'QUERY_AUTH_FORBIDDEN');
  });

  it('denies a wrong deployment key (AUTH_DECRYPT_FAILED)', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token-1' }, ENV_A);
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } }, ENV_B);
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'AUTH_DECRYPT_FAILED');
  });

  it('denies a tampered tag/ciphertext (AUTH_DECRYPT_FAILED)', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token-1' }, ENV_A);
    const tampered = cipher.slice(0, -1) + (cipher.endsWith('a') ? 'b' : 'a');
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher: tampered } });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'AUTH_DECRYPT_FAILED');
  });

  it('denies a foreign pinned ref tenant (REF_TENANT_MISMATCH)', async () => {
    const { resolver } = resolverWith({
      snapshot: pinnedSnapshot({ ref: { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', profileId: PROFILE, profileRevision: REVISION } }),
    });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'REF_TENANT_MISMATCH');
  });

  it('denies a binding row owned by another tenant (REF_TENANT_MISMATCH)', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 't' }, ENV_A);
    const { resolver } = resolverWith({
      snapshot: pinnedSnapshot(),
      binding: { tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', cipher },
    });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'REF_TENANT_MISMATCH');
  });

  it('denies a vanished pinned revision (REF_NOT_FOUND)', async () => {
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: null });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'REF_NOT_FOUND');
  });

  it('denies a missing operation row (REF_NOT_FOUND)', async () => {
    const { resolver } = resolverWith({ opAbsent: true });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'REF_NOT_FOUND');
  });

  it.each([
    ['no flag', {}],
    ['bad ref', { fileUrlAuthConfigured: true, credentialRef: { tenantId: TENANT } }],
    ['revision 0', { fileUrlAuthConfigured: true, credentialRef: { tenantId: TENANT, profileId: PROFILE, profileRevision: 0 } }],
  ])('denies a malformed pinned snapshot (%s) with REF_INVALID', async (_label, snapshot) => {
    const { resolver } = resolverWith({ snapshot });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'REF_INVALID');
  });

  it('denies configured=true with a NULL cipher (AUTH_CONFIG_MISSING)', async () => {
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher: null } });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'AUTH_CONFIG_MISSING');
  });

  it('denies a config that carries nothing despite configured=true (AUTH_CONFIG_MISSING)', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer' }, ENV_A);
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'AUTH_CONFIG_MISSING');
  });

  it('denies a whitespace-only bearer token (AUTH_CONFIG_MISSING)', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: '   ' }, ENV_A);
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await expectDenied(resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }), 'AUTH_CONFIG_MISSING');
  });

  it('denial messages never contain the credential material', async () => {
    const cipher = encryptFileUrlAuthConfig(
      { type: 'query', query_key: 'token', query_value: 'sentinel-query-secret-42' },
      ENV_A
    );
    const { resolver } = resolverWith({ snapshot: pinnedSnapshot(), binding: { tenantId: TENANT, cipher } });
    await resolver.resolveSourceAuth({ operationId: OP, tenantId: TENANT }).catch((err: SourceAuthDeniedError) => {
      expect(err.message).not.toContain('sentinel-query-secret-42');
    });
  });
});

describe('P730-ACQUIRE withSourceAuth — same-origin attachment, cross-origin redaction', () => {
  interface FetchCall {
    href: string;
    headers: Headers;
    init: RequestInit | undefined;
  }
  function spyFetcher(): { fetcher: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ href, headers: new Headers(init?.headers), init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    return { fetcher, calls };
  }

  it('attaches bearer auth to the first origin and to same-origin follow-ups, and preserves init', async () => {
    const { fetcher, calls } = spyFetcher();
    const wrapped = withSourceAuth(fetcher, { kind: 'bearer', token: 'source-token-1' });
    await wrapped('https://files.example/a', { method: 'GET', redirect: 'manual' });
    await wrapped('https://files.example/b', { method: 'GET', redirect: 'manual' });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer source-token-1');
    expect(calls[1]!.headers.get('authorization')).toBe('Bearer source-token-1');
    expect(calls[1]!.init?.redirect).toBe('manual');
  });

  it('omits the credential on a cross-origin redirect hop (deliberate redaction)', async () => {
    const { fetcher, calls } = spyFetcher();
    const wrapped = withSourceAuth(fetcher, { kind: 'bearer', token: 'source-token-1' });
    await wrapped('https://files.example/a', { method: 'GET' });
    await wrapped('https://cdn.evil.example/b', { method: 'GET' });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer source-token-1');
    expect(calls[1]!.headers.get('authorization')).toBeNull();
  });

  it('attaches custom header auth with its exact name', async () => {
    const { fetcher, calls } = spyFetcher();
    const wrapped = withSourceAuth(fetcher, { kind: 'header', headerName: 'x-api-key', headerValue: 'hk-1' });
    await wrapped('https://files.example/a', { method: 'GET' });
    expect(calls[0]!.headers.get('x-api-key')).toBe('hk-1');
    expect(calls[0]!.headers.get('authorization')).toBeNull();
  });

  it('returns the inner response untouched', async () => {
    const { fetcher } = spyFetcher();
    const wrapped = withSourceAuth(fetcher, { kind: 'bearer', token: 't' });
    const res = await wrapped('https://files.example/a', { method: 'GET' });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('ok');
  });
});
