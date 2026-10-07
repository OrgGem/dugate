import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import {
  createOidcClient,
  createPkcePair,
  OidcConfigError,
  OidcError,
  ReplayGuard,
  validateOidcConfig,
  type FetchLike,
  type FetchResponseLite,
} from '../src/modules/auth/oidc-client';

/**
 * SEC-01 offline suite — a fully IN-MEMORY fake IdP (real RSA key pairs,
 * real RS256 signatures, injected fetch). Zero DB, zero Redis, zero
 * sockets. Proves valid tokens verify AND every hostile path from the
 * OIDC-01 row (issuer / audience / signature / expiry / nonce replay /
 * alg confusion / kid-storm / state replay) fails closed.
 */

const ISS = 'http://localhost:9999/realm/du'; // loopback dev IdP — allowed by policy
const CLIENT_ID = 'du-admin';
const CLIENT_SECRET = 's3cr3t-not-a-real-secret';
const REDIRECT = 'http://localhost:2023/admin/callback';

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TestKey {
  kid: string;
  privatePem: string;
  jwk: { kty: string; use: string; alg: string; kid: string; n: string; e: string };
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return {
    kid,
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    jwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e },
  };
}

function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: TestKey): string {
  const h = b64u(Buffer.from(JSON.stringify(header), 'utf8'));
  const p = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = cryptoSign('RSA-SHA256', Buffer.from(h + '.' + p, 'ascii'), key.privatePem);
  return h + '.' + p + '.' + b64u(sig);
}

function signHS256(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): string {
  const h = b64u(Buffer.from(JSON.stringify(header), 'utf8'));
  const p = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = createHmac('sha256', secret).update(h + '.' + p, 'ascii').digest();
  return h + '.' + p + '.' + b64u(sig);
}

interface Harness {
  now: number;
  calls: string[];
  lastTokenRequest: { headers: Record<string, string>; body?: string };
  keys: Record<string, TestKey>;
  idToken(overrides: Record<string, unknown>, kid?: string): string;
  fetch: FetchLike;
  addRotatedKey(kid: string): TestKey;
  discoveryOver(doc: Record<string, unknown> | null): void;
  tokenResponse(res: unknown, status?: number): void;
  client(): ReturnType<typeof createOidcClient>;
}

function harness(): Harness {
  let nowMs = Date.UTC(2026, 8, 25, 0, 0, 0);
  const k1 = makeKey('kid-1');
  const keys: Record<string, TestKey> = { 'kid-1': k1 };
  const calls: string[] = [];
  let discoveryDoc: Record<string, unknown> | null = null;
  let tokenRes: unknown = {};
  let tokenStatus = 200;
  const lastTokenRequest = { headers: {} as Record<string, string>, body: undefined as string | undefined };

  const h: Harness = {
    now: 0,
    calls,
    lastTokenRequest,
    keys,
    idToken(overrides, kid = 'kid-1') {
      const nowSec = Math.floor(nowMs / 1000);
      const payload: Record<string, unknown> = {
        iss: ISS,
        aud: CLIENT_ID,
        sub: 'user-1',
        iat: nowSec,
        exp: nowSec + 300,
        ...overrides,
      };
      return signJwt({ alg: 'RS256', kid, typ: 'JWT' }, payload, keys[kid] ?? k1);
    },
    addRotatedKey(kid) {
      const k = makeKey(kid);
      keys[kid] = k;
      return k;
    },
    discoveryOver(doc) {
      discoveryDoc = doc;
    },
    tokenResponse(res, status = 200) {
      tokenRes = res;
      tokenStatus = status;
    },
    client() {
      return createOidcClient(
        { issuer: ISS, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, allowedIssuers: [ISS] },
        { fetchImpl: (url, init) => h.fetch(url, init), now: () => nowMs }
      );
    },
    fetch: async (url, init) => {
      calls.push(url + '|' + init.method);
      const json = (obj: unknown, ok = true, status = 200): FetchResponseLite => ({
        status,
        ok,
        json: async () => obj,
      });
      if (url.endsWith('/.well-known/openid-configuration')) {
        const base = discoveryDoc ?? {
          issuer: ISS,
          jwks_uri: ISS + '/jwks',
          authorization_endpoint: ISS + '/authorize',
          token_endpoint: ISS + '/token',
        };
        return json(base);
      }
      if (url.endsWith('/jwks')) {
        return json({ keys: Object.values(keys).map((k) => k.jwk) });
      }
      if (url.endsWith('/token') && init.method === 'POST') {
        lastTokenRequest.headers = init.headers;
        lastTokenRequest.body = init.body;
        return json(tokenRes, tokenStatus === 200, tokenStatus);
      }
      return json({}, false, 404);
    },
  };
  Object.defineProperty(h, 'now', {
    get: () => nowMs,
    set: (v: number) => {
      nowMs = v;
    },
    enumerable: true,
  });
  return h;
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'RESOLVED-expected-rejection';
  } catch (e) {
    if (e instanceof OidcError) return e.reason;
    return 'unexpected:' + String(e);
  }
}
describe('SEC-01 validateOidcConfig — fail closed at construction', () => {
  it('accepts https IdP and loopback-http dev IdP', () => {
    expect(() =>
      validateOidcConfig({
        issuer: 'https://idp.example/realms/du',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://app.example/cb',
        allowedIssuers: ['https://idp.example/realms/du'],
      })
    ).not.toThrow();
    expect(() =>
      validateOidcConfig({ issuer: ISS, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: [ISS] })
    ).not.toThrow();
  });
  it('rejects non-https public IdP, missing fields, empty allowlist, issuer outside allowlist, embedded credentials, oversized clock tolerance', () => {
    expect(() =>
      validateOidcConfig({
        issuer: 'http://idp.example/',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'http://app.example/cb',
        allowedIssuers: ['http://idp.example/'],
      })
    ).toThrow(OidcConfigError);
    expect(() => validateOidcConfig({ clientId: 'c', clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: [ISS] } as never)).toThrow(/issuer/);
    expect(() => validateOidcConfig({ issuer: ISS, clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: [ISS] } as never)).toThrow(/clientId/);
    expect(() => validateOidcConfig({ issuer: ISS, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: [] })).toThrow(/allowedIssuers/);
    expect(() => validateOidcConfig({ issuer: ISS, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: ['https://someone-else/'] })).toThrow(/member/);
    expect(() =>
      validateOidcConfig({
        issuer: 'https://u:p@idp.example/',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: REDIRECT,
        allowedIssuers: ['https://u:p@idp.example/'],
      })
    ).toThrow(/credentials/);
    expect(() => validateOidcConfig({ issuer: ISS, clientId: 'c', clientSecret: 's', redirectUri: REDIRECT, allowedIssuers: [ISS], clockToleranceSec: 3600 })).toThrow(/clockTolerance/);
  });
});

describe('SEC-01 PKCE (S256)', () => {
  it('challenge = BASE64URL(SHA256(verifier)); verifiers are fresh 43-char tokens', () => {
    const a = createPkcePair();
    expect(a.challenge).toBe(b64u(createHash('sha256').update(a.verifier, 'ascii').digest()));
    expect(a.verifier).not.toBe(createPkcePair().verifier);
    expect(/^[A-Za-z0-9_-]{43}$/.test(a.verifier)).toBe(true);
  });
});

describe('SEC-01 discovery', () => {
  it('caches the document between discover() calls', async () => {
    const h = harness();
    const c = h.client();
    await c.discover();
    await c.discover();
    expect(h.calls.filter((x) => x.includes('openid-configuration'))).toHaveLength(1);
  });
  it('metadata issuer mismatch is refused', async () => {
    const h = harness();
    h.discoveryOver({ issuer: 'http://evil.example/', jwks_uri: ISS + '/jwks', authorization_endpoint: ISS + '/a', token_endpoint: ISS + '/t' });
    expect(await reasonOf(h.client().discover())).toBe('discovery-issuer-mismatch');
  });
  it('missing endpoint field is refused', async () => {
    const h = harness();
    h.discoveryOver({ issuer: ISS, authorization_endpoint: ISS + '/a', token_endpoint: ISS + '/t' });
    expect(await reasonOf(h.client().discover())).toBe('discovery-invalid');
  });
});

describe('SEC-01 verifyIdToken — positive paths', () => {
  it('valid RS256 token verifies into claims', async () => {
    const h = harness();
    const v = await h.client().verifyIdToken(h.idToken({ nonce: 'nonce-1' }), 'nonce-1');
    expect(v).toMatchObject({ sub: 'user-1', iss: ISS, aud: [CLIENT_ID] });
  });
  it('multi-aud token with azp=clientId passes', async () => {
    const h = harness();
    const v = await h.client().verifyIdToken(h.idToken({ aud: [CLIENT_ID, 'other'], azp: CLIENT_ID, nonce: 'n' }), 'n');
    expect(v.aud).toEqual([CLIENT_ID, 'other']);
  });
});

describe('SEC-01 verifyIdToken — hostile paths fail closed', () => {
  it('alg-confusion: HS256 forged with public JWK material rejected BEFORE key lookup', async () => {
    const h = harness();
    const nowSec = Math.floor(h.now / 1000);
    const forged = signHS256(
      { alg: 'HS256', kid: 'kid-1', typ: 'JWT' },
      { iss: ISS, aud: CLIENT_ID, sub: 'mallory', exp: nowSec + 300, iat: nowSec, nonce: 'x' },
      JSON.stringify(h.keys['kid-1']!.jwk)
    );
    expect(await reasonOf(h.client().verifyIdToken(forged, 'x'))).toBe('unsupported-alg');
  });
  it('alg none is rejected', async () => {
    const h = harness();
    const nowSec = Math.floor(h.now / 1000);
    const hh = b64u(Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-1', typ: 'JWT' }), 'utf8'));
    const pp = b64u(Buffer.from(JSON.stringify({ iss: ISS, aud: CLIENT_ID, sub: 'm', exp: nowSec + 300, iat: nowSec, nonce: 'x' }), 'utf8'));
    expect(await reasonOf(h.client().verifyIdToken(hh + '.' + pp + '.', 'x'))).toBe('unsupported-alg');
  });
  it('tampered signature and non-canonical base64 are rejected', async () => {
    const h = harness();
    const tok = h.idToken({ nonce: 'x' });
    const [a, b, c] = tok.split('.') as [string, string, string];
    const flippedSig = c.slice(0, 10) + (c.slice(10, 11) === 'A' ? 'B' : 'A') + c.slice(11);
    expect(await reasonOf(h.client().verifyIdToken(a + '.' + b + '.' + flippedSig, 'x'))).toBe('bad-signature');
    expect(['malformed-jwt', 'malformed-base64']).toContain(
      await reasonOf(h.client().verifyIdToken(tok + '==', 'x'))
    );
  });
  it('wrong issuer / wrong audience / missing azp / unknown kid', async () => {
    const h = harness();
    const c = h.client();
    expect(await reasonOf(c.verifyIdToken(h.idToken({ iss: 'http://mallory/', nonce: 'x' }), 'x'))).toBe('iss-not-allowed');
    expect(await reasonOf(c.verifyIdToken(h.idToken({ aud: 'not-us', nonce: 'x' }), 'x'))).toBe('aud-mismatch');
    expect(await reasonOf(c.verifyIdToken(h.idToken({ aud: [CLIENT_ID, 'two'], nonce: 'x' }), 'x'))).toBe('azp-missing-for-multi-aud');
    h.addRotatedKey('kid-9');
    delete h.keys['kid-9'];
    const r = await reasonOf(c.verifyIdToken(h.idToken({ nonce: 'x' }, 'kid-9'), 'x'));
    expect(['unknown-kid', 'jwks-refresh-throttled']).toContain(r);
  });
  it('clock: expired refused, tolerance passes, nbf future refused', async () => {
    const h = harness();
    const nowSec = Math.floor(h.now / 1000);
    expect(await reasonOf(h.client().verifyIdToken(h.idToken({ exp: nowSec - 100, nonce: 'x' }), 'x'))).toBe('expired');
    await expect(h.client().verifyIdToken(h.idToken({ exp: nowSec - 10, nonce: 'x2' }), 'x2')).resolves.toBeTruthy();
    expect(await reasonOf(h.client().verifyIdToken(h.idToken({ nbf: nowSec + 100, nonce: 'x' }), 'x'))).toBe('not-yet-valid');
  });
  it('missing exp / iat / sub are refused (re-signed payloads)', async () => {
    const h = harness();
    for (const drop of ['exp', 'iat', 'sub']) {
      // FRESH token per iteration: each nonce is single-use by design.
      const t = h.idToken({ nonce: 'nx-' + drop });
      const hh = t.split('.')[0]!;
      const payload = JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
      delete payload[drop];
      const p2 = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
      const sig = cryptoSign('RSA-SHA256', Buffer.from(hh + '.' + p2, 'ascii'), h.keys['kid-1']!.privatePem);
      expect(await reasonOf(h.client().verifyIdToken(hh + '.' + p2 + '.' + b64u(sig), 'nx-' + drop))).toBe('missing-' + drop);
    }
  });
  it('nonce: mismatch refused, SAME nonce twice replay-refused', async () => {
    const h = harness();
    const c = h.client();
    const tok = h.idToken({ nonce: 'aaa' });
    expect(await reasonOf(c.verifyIdToken(tok, 'bbb'))).toBe('nonce-mismatch');
    await c.verifyIdToken(tok, 'aaa');
    expect(await reasonOf(c.verifyIdToken(tok, 'aaa'))).toBe('nonce-replay');
    expect(await reasonOf(c.verifyIdToken(tok, ''))).toBe('missing-expected-nonce');
  });
});

describe('SEC-01 JWKS rotation + storm guard', () => {
  it('unknown kid triggers exactly ONE forced refresh and verifies after rotation', async () => {
    const h = harness();
    const c = h.client();
    await c.verifyIdToken(h.idToken({ nonce: 'n1' }), 'n1');
    const before = c.stats().jwksFetches;
    h.addRotatedKey('kid-2');
    h.now += 31_000; // past the refresh floor: rotation-on-unknown-kid must be allowed once
    const v = await c.verifyIdToken(h.idToken({ nonce: 'n2' }, 'kid-2'), 'n2');
    expect(v.sub).toBe('user-1');
    expect(c.stats().jwksFetches).toBe(before + 1);
  });
  it('second unknown kid inside the throttle window refuses WITHOUT refetching; after the window it fails closed anyway', async () => {
    const h = harness();
    const c = h.client();
    await c.verifyIdToken(h.idToken({ nonce: 'n1' }), 'n1');
    h.addRotatedKey('kid-2');
    h.now += 31_000; // outside the floor so the rotation refresh is allowed
    await c.verifyIdToken(h.idToken({ nonce: 'n2' }, 'kid-2'), 'n2');
    h.addRotatedKey('kid-3');
    expect(await reasonOf(c.verifyIdToken(h.idToken({ nonce: 'n3' }, 'kid-3'), 'n3'))).toBe('jwks-refresh-throttled');
    h.now += 31_000;
    delete h.keys['kid-3'];
    const r = await reasonOf(c.verifyIdToken(h.idToken({ nonce: 'n4' }, 'kid-3'), 'n4'));
    expect(['unknown-kid', 'bad-signature']).toContain(r);
  });
  it('jwks TTL expiry re-fetches', async () => {
    const h = harness();
    const c = h.client();
    await c.verifyIdToken(h.idToken({ nonce: 'n1' }), 'n1');
    const before = c.stats().jwksFetches;
    h.now += 301_000;
    await c.verifyIdToken(h.idToken({ nonce: 'n2' }), 'n2');
    expect(c.stats().jwksFetches).toBeGreaterThan(before);
  });
});

describe('SEC-01 authorization URL + single-use state', () => {
  it('builds the S256 URL; state is minted once and consumable at callback', async () => {
    const h = harness();
    const c = h.client();
    const url = await c.authorizationUrl({ state: 'st-1', nonce: 'n-1', codeChallenge: 'ch', prompt: 'consent' });
    const u = new URL(url);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('nonce')).toBe('n-1');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(c.consumeState('st-1')).toBe(true);
    expect(c.consumeState('never-minted')).toBe(false);
    expect(await reasonOf(Promise.resolve().then(() => c.authorizationUrl({ state: 'st-1', nonce: 'n-2', codeChallenge: 'ch' })))).toBe('state-replay');
    expect(await reasonOf(Promise.resolve().then(() => c.authorizationUrl({ state: '', nonce: 'n', codeChallenge: 'ch' })))).toBe('missing-state');
  });
});

describe('SEC-01 exchangeAuthorizationCode', () => {
  it('posts code+verifier with basic auth; verifies id_token; opaque access_token => null', async () => {
    const h = harness();
    const nonce = 'flow-nonce';
    h.tokenResponse({ id_token: h.idToken({ nonce }), access_token: 'opaque-not-a-jwt' });
    const set = await h.client().exchangeAuthorizationCode('the-code', 'the-verifier', nonce);
    expect(set.idToken.sub).toBe('user-1');
    expect(set.accessToken).toBeNull();
    expect(h.lastTokenRequest.headers['authorization']).toBe(
      'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET, 'utf8').toString('base64')
    );
    const form = new URLSearchParams(h.lastTokenRequest.body!);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code_verifier')).toBe('the-verifier');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
  });
  it('response without id_token is refused; upstream failure is refused', async () => {
    const h = harness();
    h.tokenResponse({ access_token: 'x' });
    expect(await reasonOf(h.client().exchangeAuthorizationCode('c', 'v', 'n'))).toBe('token-response-missing-id-token');
    h.tokenResponse({ error: 'invalid_grant' }, 400);
    expect(await reasonOf(h.client().exchangeAuthorizationCode('c', 'v', 'n'))).toBe('upstream-http');
  });
});

describe('SEC-01 access-token at_hash binding', () => {
  it('matching at_hash verifies; tampered access token is refused', async () => {
    const h = harness();
    const c = h.client();
    const accessTok = h.idToken({ sub: 'user-1' });
    // OIDC Core: at_hash = left-128-bits of SHA-256 over the FULL access_token ASCII value.
    const atHash = b64u(createHash('sha256').update(accessTok, 'ascii').digest().subarray(0, 16));
    const verified = await c.verifyIdToken(h.idToken({ nonce: 'n-hash', at_hash: atHash }), 'n-hash');
    const at = await c.verifyAccessToken(accessTok, verified);
    expect(at.sub).toBe('user-1');
    const parts = accessTok.split('.');
    const tampered = parts[0] + '.' + parts[1] + '.' + b64u(Buffer.from('deadbeefdead'));
    const r = await reasonOf(c.verifyAccessToken(tampered, verified));
    expect(['at-hash-mismatch', 'bad-signature']).toContain(r);
  });
});

describe('SEC-01 ReplayGuard', () => {
  it('single use within the window; empty rejected', () => {
    const g = new ReplayGuard(60_000);
    const expSec = Math.floor(Date.now() / 1000) + 60;
    expect(g.consume('v', expSec)).toBe(true);
    expect(g.consume('v', expSec)).toBe(false);
    expect(g.consume('', expSec)).toBe(false);
    expect(g.has('v')).toBe(true);
  });
});
