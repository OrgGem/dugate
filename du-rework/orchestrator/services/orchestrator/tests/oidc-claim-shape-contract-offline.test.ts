import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  OIDC_CLAIM_SHAPE_CONTRACT,
  assertOidcClaimShapeContract,
  dominatesOidcPrivilege,
  type OidcClaimShapeEntry,
  type OidcPrivilege,
} from '@du/contracts';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import {
  SESSION_COOKIE_NAME,
  createMemorySessionRepository,
  createSessionStore,
  isValidSessionId,
} from '../src/modules/auth/session-store';
import { createMemoryChallengeStore, createOidcFlow } from '../src/app/admin/oidc-flow';
import { mapOidcClaimsToPrincipal, type AdminPrincipal, type OidcAdminClaims } from '../src/modules/admin-actions/rbac';

/**
 * SEC claim-shape consistency contract, bound to the LIVE mappers
 * (Reviewer Turn 40 finding "SEC claim-shape consistency").
 *
 * packages/contracts/src/oidc-claim-shapes.ts owns the RULE; this suite
 * proves the two production mappers obey it:
 *   - Platform API (bearer): mapOidcClaimsToPrincipal(), called directly.
 *   - Admin shell (browser): roleFor(), reached through the REAL callback
 *     handler of the REAL OidcClient, with a real RSA key pair signing real
 *     RS256 id_tokens. Only the HTTP transport is injected (FetchLike), so
 *     signature, iss allowlist, aud, exp and nonce checks all really run;
 *     the claim SHAPE is the only thing this suite varies.
 * The privilege is read back from the server-side SessionRecord the
 * dispatcher gate would later consult, not from roleFor's return value.
 *
 * Deliberate property of the assertions: the ADR invariant is re-derived
 * from the OBSERVED output of both mappers, not from the contract table, so
 * editing the table to match a widened mapper does not make this pass.
 *
 * Offline: no DB, no Redis, no S3, no socket.
 */

const ISS = 'http://localhost:9999/realm/du';
const CLIENT_ID = 'du-admin';
const PUBLIC_ORIGIN = 'http://localhost:2023';
const SUB = 'u-contract';
const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return {
    kid: 'kid-contract',
    privateKey,
    jwk: { kty: 'RSA', use: 'sig' as const, alg: 'RS256', kid: 'kid-contract', n: jwk.n, e: jwk.e },
  };
}

function harness() {
  const nowMs = T0;
  const key = makeKey();
  const st = { overrides: {} as Record<string, unknown>, pendingNonce: 'no-nonce' };
  const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => nowMs });
  const fetchImpl: FetchLike = async (url, init) => {
    const json = (obj: unknown, ok = true, status = 200) => ({ status, ok, json: async () => obj });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({
        issuer: ISS,
        jwks_uri: ISS + '/jwks',
        authorization_endpoint: ISS + '/authorize',
        token_endpoint: ISS + '/token',
      });
    }
    if (url.endsWith('/jwks')) return json({ keys: [key.jwk] });
    if (url.endsWith('/token') && init.method === 'POST') {
      const nowSec = Math.floor(nowMs / 1000);
      // platformAdmin defaults so a row carrying only tenantIds is not
      // silently promoted; a row that omits the claim overrides it away.
      const payload = {
        iss: ISS,
        aud: CLIENT_ID,
        sub: SUB,
        iat: nowSec,
        exp: nowSec + 300,
        nonce: st.pendingNonce,
        platformAdmin: true,
        ...st.overrides,
      };
      const h = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' }), 'utf8'));
      const p = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
      const sig = cryptoSign('RSA-SHA256', Buffer.from(h + '.' + p, 'ascii'), key.privateKey);
      return json({ id_token: h + '.' + p + '.' + b64u(sig), token_type: 'Bearer' });
    }
    return json({}, false, 404);
  };
  const client = createOidcClient(
    {
      issuer: ISS,
      clientId: CLIENT_ID,
      clientSecret: 'sec',
      redirectUri: PUBLIC_ORIGIN + '/admin/oidc/callback',
      allowedIssuers: [ISS],
    },
    { fetchImpl, now: () => nowMs }
  );
  const flow = createOidcFlow({
    client,
    sessions,
    challenges: createMemoryChallengeStore(() => nowMs),
    publicOrigin: PUBLIC_ORIGIN,
    now: () => nowMs,
  });
  return { flow, sessions, st };
}

const h = harness();

function sidFrom(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const prefix = SESSION_COOKIE_NAME + '=';
  if (!cookie.startsWith(prefix)) return null;
  const rest = cookie.slice(prefix.length);
  const semi = rest.indexOf(';');
  const sid = semi === -1 ? rest : rest.slice(0, semi);
  return isValidSessionId(sid) ? sid : null;
}

function apiPrivilege(p: AdminPrincipal | null): OidcPrivilege {
  if (!p) return { kind: 'none' };
  if (p.role === 'platform') return { kind: 'platform-write' };
  return { kind: 'tenant-write', tenantId: p.tenantId };
}

/** Observed Platform-API privilege. The cast is the point: the claim set is
 *  JSON out of a verified token, so tenantIds: [42] must survive to the
 *  mapper even though OidcAdminClaims claims otherwise. */
function observeApi(entry: OidcClaimShapeEntry): OidcPrivilege {
  const claims = { sub: SUB, iss: ISS, ...entry.claims } as unknown as OidcAdminClaims;
  return apiPrivilege(mapOidcClaimsToPrincipal(claims, [ISS]));
}

/** Observed Admin-shell privilege, read from the server-side session record. */
async function observeShell(claims: Record<string, unknown>): Promise<OidcPrivilege> {
  const overrides: Record<string, unknown> = { ...claims };
  if (!('platformAdmin' in overrides)) overrides['platformAdmin'] = undefined;
  h.st.overrides = overrides;
  const login = await h.flow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} });
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers['location'] ?? '');
  const state = authorize.searchParams.get('state') ?? '';
  h.st.pendingNonce = authorize.searchParams.get('nonce') ?? 'no-nonce';
  const cb = await h.flow.handleCallback({
    method: 'GET',
    path: '/admin/oidc/callback',
    query: { code: 'c-contract', state },
    cookies: {},
  });
  if (cb.status === 403) return { kind: 'none' };
  expect(cb.status).toBe(302);
  const sid = sidFrom(cb.headers['set-cookie']);
  if (!sid) return { kind: 'none' };
  const rec = await h.sessions.get(sid);
  if (!rec) return { kind: 'none' };
  if (rec.role === 'admin') return { kind: 'platform-write' };
  if (rec.role === 'viewer') return { kind: 'read-only' };
  if (typeof rec.tenantId === 'string' && rec.tenantId.length > 0) {
    return { kind: 'tenant-write', tenantId: rec.tenantId };
  }
  throw new Error('operator session without a tenant: ' + rec.sessionId);
}

interface Observed {
  id: string;
  hostile: boolean;
  shell: OidcPrivilege;
  api: OidcPrivilege;
}

async function observeAll(): Promise<Observed[]> {
  const out: Observed[] = [];
  for (const entry of OIDC_CLAIM_SHAPE_CONTRACT) {
    out.push({
      id: entry.id,
      hostile: entry.hostile,
      shell: await observeShell(entry.claims),
      api: observeApi(entry),
    });
  }
  return out;
}

describe('SEC claim-shape contract: the pinned table is admissible', () => {
  it('satisfies its own assertion (no drift inside @du/contracts)', () => {
    expect(() => assertOidcClaimShapeContract()).not.toThrow();
  });
});

describe('SEC claim-shape contract: both live mappers match the pinned table', () => {
  it('maps every contract row to the pinned privilege on BOTH surfaces', async () => {
    const drift: string[] = [];
    for (const entry of OIDC_CLAIM_SHAPE_CONTRACT) {
      const shell = await observeShell(entry.claims);
      const api = observeApi(entry);
      if (JSON.stringify(shell) !== JSON.stringify(entry.adminShell)) {
        drift.push(entry.id + ': shell ' + JSON.stringify(shell) + ' != contract ' + JSON.stringify(entry.adminShell));
      }
      if (JSON.stringify(api) !== JSON.stringify(entry.platformApi)) {
        drift.push(entry.id + ': api ' + JSON.stringify(api) + ' != contract ' + JSON.stringify(entry.platformApi));
      }
    }
    expect(drift).toEqual([]);
  });
});

describe('SEC claim-shape contract: ADR invariant, re-derived from live output', () => {
  it('the bearer API never grants more than the admin shell for the same claims', async () => {
    const offenders: string[] = [];
    for (const row of await observeAll()) {
      if (!dominatesOidcPrivilege(row.shell, row.api)) {
        offenders.push(row.id + ': shell ' + row.shell.kind + ' < api ' + row.api.kind);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no API write exists without the same write on the shell', async () => {
    for (const row of await observeAll()) {
      if (row.api.kind === 'platform-write' || row.api.kind === 'tenant-write') {
        expect(row.shell.kind).toBe(row.api.kind);
      }
    }
  });

  it('the only well-formed rows where the shell grants more are the documented ones', async () => {
    const shellHeavier = (await observeAll())
      .filter((r) => r.shell.kind !== r.api.kind && !r.hostile)
      .map((r) => r.id);
    expect(shellHeavier).toEqual(['multi-tenant-deliberate-divergence', 'no-flag-no-tenant']);
  });
});

describe('SEC claim-shape contract: hostile shapes stay inert', () => {
  it('a hostile claim shape mints no write privilege on either surface', async () => {
    for (const row of (await observeAll()).filter((r) => r.hostile)) {
      expect(row.api).toEqual({ kind: 'none' });
      expect(row.shell).toEqual({ kind: 'read-only' });
    }
  });

  it('a non-string or empty tenant member yields no bearer principal', () => {
    // Regression for the escalation path this contract closed: the mapper
    // used to hand out a tenant_operator principal for tenantIds: [42] and
    // [''] while the browser mapper denied both. Such a principal is bound
    // to a tenant id that can never match a stored row, so it was dead
    // weight today and a live hole the moment any comparison coerces.
    for (const tenantIds of [[42], [''], [null], [{}], [[]]]) {
      const claims = { sub: SUB, iss: ISS, tenantIds } as unknown as OidcAdminClaims;
      expect(mapOidcClaimsToPrincipal(claims, [ISS])).toBeNull();
    }
  });

  it('a well-formed single tenant is still mapped (the tightening did not over-reach)', () => {
    expect(mapOidcClaimsToPrincipal({ sub: SUB, iss: ISS, tenantIds: ['tenant-a'] }, [ISS])).toEqual({
      role: 'tenant_operator',
      tenantId: 'tenant-a',
    });
  });
});
