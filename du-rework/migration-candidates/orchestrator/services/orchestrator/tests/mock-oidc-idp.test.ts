import { createHmac } from 'node:crypto';
import {
  createOidcClient,
  createPkcePair,
  OidcError,
  type FetchLike,
} from '../src/modules/auth/oidc-client';
import { startMockOidcIdp, type MockOidcIdp } from './stubs/mock-oidc-idp';

/**
 * CYCLE-102 — mock OIDC IdP harness proof: the REAL OidcClient against a
 * REAL in-process HTTP provider on loopback. No DB, no Redis, no app
 * services — just the IdP the OIDC-01 row asks to fake. Full auth-code
 * + PKCE(S256) flow plus every hostile path the spec names.
 */

let idp: MockOidcIdp;

const fetchImpl: FetchLike = async (url, init) => {
  const r = await fetch(url, {
    method: init.method as 'GET' | 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
  });
  return { status: r.status, ok: r.ok, json: async () => (await r.json()) as unknown };
};

function client() {
  return createOidcClient(
    {
      issuer: idp.issuer,
      clientId: 'du-admin',
      clientSecret: 'shhh',
      redirectUri: idp.url + '/admin/oidc/callback',
      allowedIssuers: [idp.issuer],
    },
    { fetchImpl }
  );
}

async function authorizeLocation(c: ReturnType<typeof client>, state: string, nonce: string, challenge: string): Promise<URL> {
  const authUrl = await c.authorizationUrl({ state, nonce, codeChallenge: challenge });
  const r = await fetch(authUrl, { redirect: 'manual' });
  expect(r.status).toBe(302);
  return new URL(r.headers.get('location') ?? '');
}

beforeAll(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  idp = await startMockOidcIdp();
});
afterAll(async () => {
  await idp?.close();
});
beforeEach(() => idp.reset());

describe('mock IdP discovery + JWKS', () => {
  it('serves RFC8414 metadata and BOTH RS256 and ES256 keys', async () => {
    const meta = (await (await fetch(idp.url + '/.well-known/openid-configuration')).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(idp.issuer);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    const jwks = (await (await fetch(idp.url + '/jwks')).json()) as { keys: Array<Record<string, string>> };
    expect(jwks.keys.map((k) => k.alg).sort()).toEqual(['ES256', 'RS256']);
  });
});

describe('full PKCE auth-code flow', () => {
  it('authorize -> exchange -> verified id_token with matching claims', async () => {
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 'state-A', 'nonce-A', challenge);
    expect(loc.searchParams.get('state')).toBe('state-A');
    const code = loc.searchParams.get('code') ?? '';
    expect(code).toMatch(/^code-/);
    const set = await c.exchangeAuthorizationCode(code, verifier, 'nonce-A');
    expect(set.idToken.sub).toBe('mock-user-1');
    expect(set.idToken.claims.platformAdmin).toBe(true);
    expect(set.accessToken).not.toBeNull();
  });
  it('ES256 signing verifies too (alg-selectable mock)', async () => {
    idp.setSigningAlg('ES256');
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's2', 'n2', challenge);
    const set = await c.exchangeAuthorizationCode(loc.searchParams.get('code') ?? '', verifier, 'n2');
    expect(set.idToken.sub).toBe('mock-user-1');
  });
});

describe('PKCE + flow hostility fail closed', () => {
  it('wrong code_verifier -> exchange fails', async () => {
    const c = client();
    const { challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's', 'n', challenge);
    await expect(c.exchangeAuthorizationCode(loc.searchParams.get('code') ?? '', 'x'.repeat(43), 'n'))
      .rejects.toBeInstanceOf(Error);
  });
  it('code is single-use: replay fails even with the right verifier', async () => {
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's', 'n', challenge);
    const code = loc.searchParams.get('code') ?? '';
    await c.exchangeAuthorizationCode(code, verifier, 'n');
    await expect(c.exchangeAuthorizationCode(code, verifier, 'n')).rejects.toBeInstanceOf(Error);
  });
  it('authorize without PKCE challenge / without nonce -> 400', async () => {
    const noChallenge = await fetch(idp.url + '/authorize?response_type=code&client_id=du-admin&redirect_uri=' + encodeURIComponent(idp.url + '/cb') + '&nonce=nn&state=st', { redirect: 'manual' });
    expect(noChallenge.status).toBe(400);
    const noNonce = await fetch(idp.url + '/authorize?response_type=code&client_id=du-admin&redirect_uri=' + encodeURIComponent(idp.url + '/cb') + '&code_challenge=abc&code_challenge_method=S256&state=st', { redirect: 'manual' });
    expect(noNonce.status).toBe(400);
  });
  it('nonce mismatch on exchange -> OidcError nonce-mismatch', async () => {
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's', 'real-nonce', challenge);
    const p = c.exchangeAuthorizationCode(loc.searchParams.get('code') ?? '', verifier, 'wrong-nonce');
    await expect(p).rejects.toBeInstanceOf(OidcError);
    await p.catch((e: unknown) => expect((e as OidcError).reason).toBe('nonce-mismatch'));
  });
  it('HS256 forged on the RSA PUBLIC key material is refused (alg confusion dead)', async () => {
    const jwks = (await (await fetch(idp.url + '/jwks')).json()) as { keys: Array<Record<string, string>> };
    const rsa = jwks.keys.find((k) => k.kty === 'RSA')!;
    const nowSec = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'mock-rs-1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: idp.issuer, aud: 'du-admin', sub: 'mallory', iat: nowSec, exp: nowSec + 300, nonce: 'nn' })).toString('base64url');
    const sig = createHmac('sha256', JSON.stringify(rsa)).update(h + '.' + p).digest().toString('base64url');
    await expect(client().verifyIdToken(h + '.' + p + '.' + sig, 'nn')).rejects.toThrow(/RS256\/ES256 only|unsupported/i);
  });
  it('token endpoint 503 -> upstream-http; stale code after reset -> invalid grant', async () => {
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's', 'n', challenge);
    const code = loc.searchParams.get('code') ?? '';
    idp.failNextTokenEndpoint(503);
    await expect(c.exchangeAuthorizationCode(code, verifier, 'n')).rejects.toBeInstanceOf(OidcError);
    idp.reset();
    await expect(c.exchangeAuthorizationCode(code, verifier, 'n')).rejects.toBeInstanceOf(OidcError);
  });
});

describe('revoke endpoint semantics', () => {
  it('issued tokens introspect active; after /revoke they are not', async () => {
    const c = client();
    const { verifier, challenge } = createPkcePair();
    const loc = await authorizeLocation(c, 's', 'n', challenge);
    await c.exchangeAuthorizationCode(loc.searchParams.get('code') ?? '', verifier, 'n');
    const idTok = idp.lastIssued!.idToken;
    expect(idp.introspect(idTok)).toEqual({ active: true, sub: 'mock-user-1' });
    const rv = await fetch(idp.url + '/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: idTok }).toString(),
    });
    expect(rv.status).toBe(200);
    expect(idp.introspect(idTok)).toEqual({ active: false });
    const viaHttp = await (await fetch(idp.url + '/introspect?token=' + encodeURIComponent(idp.lastIssued!.accessToken))).json() as { active: boolean };
    expect(viaHttp.active).toBe(true);
  });
});
