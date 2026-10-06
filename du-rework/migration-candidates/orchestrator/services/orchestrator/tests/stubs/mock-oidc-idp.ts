import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { listenLoopback } from '../../../../tests/harness/listen-loopback';

/**
 * CYCLE-102 — in-process MOCK OIDC IdP for the orchestrator suites.
 * Real HTTP on loopback (NOT the DB/Redis window — zero app infra),
 * implementing the provider surface the OidcClient exercises:
 *   GET  /.well-known/openid-configuration   (RFC 8414 discovery)
 *   GET  /jwks                                RS256 + ES256 public keys
 *   GET  /authorize                           auth-code + PKCE(S256) checks,
 *                                             single-use codes, redirect-allowlist
 *   POST /token                               code+verifier exchange, signed
 *                                             id_token (alg-selectable) with
 *                                             nonce/aud, access JWT + at_hash
 *   POST /revoke  + GET /userinfo-like /introspect for revoke semantics
 *
 * Deterministic knobs for tests: setPrincipal(), setSigningAlg(),
 * setIdTokenTtl(), failNextTokenEndpoint(), reset().
 */

export interface MockPrincipal {
  sub: string;
  platformAdmin?: boolean;
  /**
   * Test-only: sign this RAW value as the platformAdmin claim instead of
   * coercing it to boolean true, so a suite can prove the flow fails closed
   * on a hostile claim shape. Absent = the historical boolean behaviour.
   */
  platformAdminClaim?: unknown;
  tenantIds?: string[];
}

export type MockAlg = 'RS256' | 'ES256';

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface KeyPairSet {
  kid: string;
  alg: MockAlg;
  sign: (data: Buffer) => Buffer;
  jwk: Record<string, string>;
}

function makeRsa(): KeyPairSet {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const j = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return {
    kid: 'mock-rs-1',
    alg: 'RS256',
    sign: (data) => createSign('RSA-SHA256').update(data).sign(privateKey),
    jwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid: 'mock-rs-1', n: j.n, e: j.e },
  };
}

function makeEc(): KeyPairSet {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return {
    kid: 'mock-es-1',
    alg: 'ES256',
    sign: (data) => createSign('sha256').update(data).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }),
    jwk: { kty: 'EC', use: 'sig', alg: 'ES256', kid: 'mock-es-1', crv: 'P-256', x: j.x, y: j.y },
  };
}

export interface MockOidcIdp {
  url: string;
  issuer: string;
  close(): Promise<void>;
  reset(): void;
  setPrincipal(p: MockPrincipal): void;
  setSigningAlg(alg: MockAlg): void;
  setIdTokenTtl(sec: number): void;
  failNextTokenEndpoint(status?: number): void;
  introspect(token: string): { active: boolean; sub?: string };
  lastAuthorizeParams: Record<string, string> | null;
  lastIssued: { idToken: string; accessToken: string } | null;
}

export async function startMockOidcIdp(): Promise<MockOidcIdp> {
  const keys: Record<MockAlg, KeyPairSet> = { RS256: makeRsa(), ES256: makeEc() };
  let signingAlg: MockAlg = 'RS256';
  let principal: MockPrincipal = { sub: 'mock-user-1', platformAdmin: true };
  let idTtlSec = 300;
  let failTokenStatus: number | null = null;
  interface CodeEntry { redirectUri: string; challenge: string; nonce: string; clientId: string; sub: string }
  const codes = new Map<string, CodeEntry>();
  const revoked = new Set<string>();
  const issued = new Map<string, { sub: string }>();

  const signJwt = (payload: Record<string, unknown>): string => {
    const k = keys[signingAlg];
    const h = b64u(Buffer.from(JSON.stringify({ alg: signingAlg, typ: 'JWT', kid: k.kid }), 'utf8'));
    const p = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = k.sign(Buffer.from(h + '.' + p, 'ascii'));
    return h + '.' + p + '.' + b64u(sig);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    };
    const redirect = (loc: string, status = 302) => {
      res.writeHead(status, { location: loc });
      res.end();
    };

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: api.issuer,
        jwks_uri: api.url + '/jwks',
        authorization_endpoint: api.url + '/authorize',
        token_endpoint: api.url + '/token',
        revocation_endpoint: api.url + '/revoke',
        introspection_endpoint: api.url + '/introspect',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') {
      return send(200, { keys: Object.values(keys).map((k) => k.jwk) });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams.entries());
      api.lastAuthorizeParams = q;
      const err = (d: string) => send(400, { error: d });
      if (q.response_type !== 'code') return err('unsupported_response_type');
      if (!q.client_id || !q.redirect_uri) return err('invalid_request');
      if (q.code_challenge_method !== 'S256' || !q.code_challenge) return err('invalid_request');
      if (!q.nonce) return err('invalid_request');
      const code = 'code-' + b64u(randomBytes(12));
      codes.set(code, {
        redirectUri: q.redirect_uri,
        challenge: q.code_challenge,
        nonce: q.nonce,
        clientId: q.client_id,
        sub: principal.sub,
      });
      const loc = new URL(q.redirect_uri);
      loc.searchParams.set('code', code);
      if (q.state) loc.searchParams.set('state', q.state);
      return redirect(loc.toString());
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      if (failTokenStatus !== null) {
        const s = failTokenStatus;
        failTokenStatus = null;
        return send(s, { error: 'server_error' });
      }
      let text2 = '';
      req.on('data', (c) => (text2 += c));
      req.on('end', () => {
        const f = new URLSearchParams(text2);
        if (f.get('grant_type') !== 'authorization_code') return send(400, { error: 'unsupported_grant_type' });
        const code = f.get('code') ?? '';
        const entry = codes.get(code);
        if (!entry) return send(400, { error: 'invalid_grant' });
        codes.delete(code); // single-use, always
        // client_id may arrive via client_secret_basic (the OidcClient does)
        const basic = String(req.headers['authorization'] ?? '');
        const cidFromAuth = basic.startsWith('Basic ')
          ? Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')[0]
          : '';
        const cid = f.get('client_id') || cidFromAuth;
        if (!cid || cid !== entry.clientId) return send(400, { error: 'invalid_grant' });
        if (f.get('redirect_uri') !== entry.redirectUri) return send(400, { error: 'invalid_grant' });
        const verifier = f.get('code_verifier') ?? '';
        const want = b64u(createHash('sha256').update(verifier, 'ascii').digest());
        if (want !== entry.challenge) return send(400, { error: 'invalid_grant' });
        const nowSec = Math.floor(Date.now() / 1000);
        const at = signJwt({ iss: api.issuer, aud: entry.clientId, sub: entry.sub, iat: nowSec, exp: nowSec + idTtlSec, jti: 'at-' + b64u(randomBytes(8)) });
        const atHash = b64u(createHash('sha256').update(at, 'ascii').digest().subarray(0, 16));
        const idClaims: Record<string, unknown> = {
          iss: api.issuer,
          aud: entry.clientId,
          sub: entry.sub,
          iat: nowSec,
          exp: nowSec + idTtlSec,
          nonce: entry.nonce,
          auth_time: nowSec,
          at_hash: atHash,
        };
        if ('platformAdminClaim' in principal) idClaims.platformAdmin = principal.platformAdminClaim;
        else if (principal.platformAdmin) idClaims.platformAdmin = true;
        if (principal.tenantIds) idClaims.tenantIds = principal.tenantIds;
        const id = signJwt(idClaims);
        issued.set(id, { sub: entry.sub });
        issued.set(at, { sub: entry.sub });
        api.lastIssued = { idToken: id, accessToken: at };
        return send(200, { token_type: 'Bearer', expires_in: idTtlSec, id_token: id, access_token: at, refresh_token: 'rt-' + b64u(randomBytes(8)) });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      let text3 = '';
      req.on('data', (c) => (text3 += c));
      req.on('end', () => {
        const token = new URLSearchParams(text3).get('token') ?? '';
        revoked.add(token);
        return send(200, {});
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/introspect') {
      const token = url.searchParams.get('token') ?? '';
      const hit = issued.get(token);
      if (!hit || revoked.has(token)) return send(200, { active: false });
      return send(200, { active: true, sub: hit.sub });
    }
    return send(404, { error: 'not_found' });
  });

  await listenLoopback(server, 44_800 + (process.pid % 100));
  // CYCLE 139 (W49-QW1-LIVE-001 Tester receipt): loopback keep-alive on
  // this box is a flake source (recorded connect-ETIMEDOUT storm). The
  // listener is IPv4-bound EXPLICITLY — clients never resolve
  // 'localhost' (Node 17+ may prefer ::1 and time out against a
  // 127.0.0.1-only socket) — and idle keep-alive sockets die fast so a
  // stale pooled connection cannot be handed to the next fetch.
  server.keepAliveTimeout = 500;
  const port = (server.address() as AddressInfo).port;
  const api: MockOidcIdp = {
    url: `http://127.0.0.1:${port}`,
    issuer: `http://127.0.0.1:${port}`,
    lastAuthorizeParams: null,
    lastIssued: null,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve()))
      );
    },
    reset() {
      codes.clear();
      revoked.clear();
      issued.clear();
      failTokenStatus = null;
      api.lastAuthorizeParams = null;
      api.lastIssued = null;
      principal = { sub: 'mock-user-1', platformAdmin: true };
      signingAlg = 'RS256';
      idTtlSec = 300;
    },
    setPrincipal(p) {
      principal = p;
    },
    setSigningAlg(alg) {
      signingAlg = alg;
    },
    setIdTokenTtl(sec) {
      idTtlSec = sec;
    },
    failNextTokenEndpoint(status = 503) {
      failTokenStatus = status;
    },
    introspect(token) {
      const hit = issued.get(token);
      if (!hit || revoked.has(token)) return { active: false };
      return { active: true, sub: hit.sub };
    },
  };

  // WARM-UP (reviewer ask): prove the fresh listener actually ANSWERS a
  // loopback connection before any suite/child process races toward it.
  // Bounded so it can never blow the default 5s jest hook budget: 3
  // attempts x 1.2s cap + 150/300ms backoff (<= ~4.1s worst case, then
  // a loud actionable failure instead of a cryptic downstream 500).
  const metaUrl = api.url + '/.well-known/openid-configuration';
  let warmed = false;
  let lastErr = '';
  for (let i = 0; i < 3 && !warmed; i++) {
    try {
      const r = await fetch(metaUrl, { signal: AbortSignal.timeout(1200) });
      warmed = r.status === 200;
      if (!warmed) lastErr = 'status ' + r.status;
    } catch (e) {
      lastErr = String((e as Error)?.message ?? e);
      await new Promise((res) => setTimeout(res, 150 * (i + 1)));
    }
  }
  if (!warmed) {
    await api.close().catch(() => undefined);
    throw new Error(
      'mock-oidc-idp warm-up failed at ' + metaUrl + ' (' + lastErr + ') — '
      + 'loopback appears congested (the documented connect-ETIMEDOUT storm). '
      + 'Retry the run; do not treat this as product behavior.'
    );
  }
  return api;
}
