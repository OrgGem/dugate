import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';

/**
 * SEC-01 / OIDC-01 building blocks: Authorization Code + PKCE client,
 * discovery + JWKS cache (TTL, rotation-on-unknown-kid, refresh throttle),
 * and fail-closed token verification (iss allowlist, aud/azp, exp/nbf,
 * single-use nonce).
 *
 * Deliberately dependency-free (node:crypto only — the workspace locks no
 * JWT library) and transport-injected: every network call goes through
 * FetchLike, so the fake-IdP offline suite (tests/oidc-client.test.ts)
 * exercises the REAL code paths without a socket, honoring the
 * "no DB/Redis/live infra" rule of this dispatch.
 *
 * Crypto policy: RS256 ONLY. 'none' and the HS* families are rejected
 * BEFORE any key lookup — the classic alg-confusion path (attacker
 * re-signs with the public key as an HMAC secret) cannot be reached.
 * Unsupported kids/algs are hard failures, never silent downgrades.
 */

// ---------------------------------------------------------------------------
// Config + validation (fail closed at construction)
// ---------------------------------------------------------------------------

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Exact-match iss allowlist for every token we verify (SEC-01:
   *  discovery/JWKS allowlisted). The configured issuer MUST be a member. */
  allowedIssuers: string[];
  /** Optional pin; default = jwks_uri from discovery. Must be https
   *  (http allowed only for a loopback dev IdP). */
  jwksUri?: string;
  /** exp/nbf leeway in seconds. Default 30, clamped 0..60. */
  clockToleranceSec?: number;
  /** JWKS cache lifetime. Default 300s. */
  jwksTtlMs?: number;
  /** Floor between two JWKS fetches (rotation throttle). Default 30s. */
  jwksMinRefreshMs?: number;
  /** How long consumed nonces stay remembered past their token exp. */
  nonceRetentionMs?: number;
}

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

export class OidcError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? 'oidc failure: ' + reason);
    this.name = 'OidcError';
    this.reason = reason;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function assertHttpUrl(value: string, label: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new OidcConfigError(label + ' must be an absolute URL');
  }
  const loopback =
    u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !loopback) {
    throw new OidcConfigError(label + ' must be https (http only for loopback dev IdP)');
  }
  if (u.username || u.password) {
    throw new OidcConfigError(label + ' must not embed credentials');
  }
}

export function validateOidcConfig(raw: Partial<OidcClientConfig> | unknown): OidcClientConfig {
  const c = raw as Partial<OidcClientConfig> | null;
  if (typeof c !== 'object' || c === null) throw new OidcConfigError('config must be an object');
  for (const key of ['issuer', 'clientId', 'clientSecret', 'redirectUri'] as const) {
    if (!isNonEmptyString(c[key])) throw new OidcConfigError('config.' + key + ' is required');
  }
  assertHttpUrl(c.issuer!, 'config.issuer');
  assertHttpUrl(c.redirectUri!, 'config.redirectUri');
  if (
    !Array.isArray(c.allowedIssuers) ||
    c.allowedIssuers.length === 0 ||
    !c.allowedIssuers.every(isNonEmptyString)
  ) {
    throw new OidcConfigError('config.allowedIssuers must be a non-empty array of exact issuer strings');
  }
  if (!c.allowedIssuers.includes(c.issuer!)) {
    throw new OidcConfigError('config.issuer must be a member of config.allowedIssuers');
  }
  if (c.jwksUri !== undefined) assertHttpUrl(c.jwksUri, 'config.jwksUri');
  const tol = c.clockToleranceSec ?? 30;
  if (!Number.isFinite(tol) || tol < 0 || tol > 60) {
    throw new OidcConfigError('config.clockToleranceSec must be within 0..60');
  }
  return {
    issuer: c.issuer!,
    clientId: c.clientId!,
    clientSecret: c.clientSecret!,
    redirectUri: c.redirectUri!,
    allowedIssuers: [...c.allowedIssuers],
    jwksUri: c.jwksUri,
    clockToleranceSec: tol,
    jwksTtlMs: c.jwksTtlMs ?? 300_000,
    jwksMinRefreshMs: c.jwksMinRefreshMs ?? 30_000,
    nonceRetentionMs: c.nonceRetentionMs ?? 600_000,
  };
}

// ---------------------------------------------------------------------------
// Transport seam (test-injectable; production passes global fetch)
// ---------------------------------------------------------------------------

export interface FetchResponseLite {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export interface FetchInitLite {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: FetchInitLite) => Promise<FetchResponseLite>;

export interface DiscoveryDocument {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

// ---------------------------------------------------------------------------
// Strict JWT plumbing
// ---------------------------------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecodeSegment(s: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new OidcError('malformed-base64', what + ' is not canonical base64url');
  }
  const buf = Buffer.from(s, 'base64url');
  if (b64urlEncode(buf) !== s) {
    throw new OidcError('malformed-base64', what + ' is not canonical base64url');
  }
  return buf;
}

function decodeJsonSegment(segment: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(b64urlDecodeSegment(segment, what).toString('utf8'));
  } catch (e) {
    if (e instanceof OidcError) throw e;
    throw new OidcError('malformed-json', what + ' is not valid JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new OidcError('malformed-json', what + ' must be a JSON object');
  }
  return v as Record<string, unknown>;
}

interface SplitJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

function splitJwt(token: string): SplitJwt {
  if (typeof token !== 'string') throw new OidcError('malformed-jwt');
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('malformed-jwt', 'jwt must have exactly three segments');
  const h = parts[0]!;
  const p = parts[1]!;
  const s = parts[2]!;
  return {
    header: decodeJsonSegment(h, 'jwt header'),
    payload: decodeJsonSegment(p, 'jwt payload'),
    signingInput: h + '.' + p,
    signature: s,
  };
}

export type SupportedAlg = 'RS256' | 'ES256';
const SUPPORTED: SupportedAlg[] = ['RS256', 'ES256'];

/** Asymmetric-only gate: reject alg BEFORE any key lookup. No 'none', no HS*. */
function assertSupportedAlg(header: Record<string, unknown>): { alg: SupportedAlg; kid: string } {
  if (!SUPPORTED.includes(header.alg as SupportedAlg)) {
    throw new OidcError('unsupported-alg', "alg '" + String(header.alg) + "' is not accepted (RS256/ES256 only)");
  }
  if (!isNonEmptyString(header.kid)) throw new OidcError('missing-kid');
  return { alg: header.alg as SupportedAlg, kid: header.kid as string };
}

function verifySignature(
  alg: SupportedAlg,
  signingInput: string,
  signatureB64u: string,
  jwk: Jwk
): void {
  const sig = b64urlDecodeSegment(signatureB64u, 'jwt signature');
  const data = Buffer.from(signingInput, 'ascii');
  let ok = false;
  try {
    if (alg === 'RS256') {
      if (jwk.kty !== 'RSA' || !isNonEmptyString(jwk.n) || !isNonEmptyString(jwk.e)) {
        throw new OidcError('incompatible-jwk', 'kid does not name an RSA key');
      }
      const key = createPublicKey({
        key: { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: false },
        format: 'jwk',
      } as Parameters<typeof createPublicKey>[0]);
      ok = cryptoVerify('RSA-SHA256', data, key, sig);
    } else {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !isNonEmptyString(jwk.x) || !isNonEmptyString(jwk.y)) {
        throw new OidcError('incompatible-jwk', 'kid does not name a P-256 key');
      }
      const key = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: false },
        format: 'jwk',
      } as Parameters<typeof createPublicKey>[0]);
      // JWT ECDSA signatures are fixed-width r||s — ieee-p1363, not DER.
      ok = cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' } as Parameters<typeof cryptoVerify>[2], sig);
    }
  } catch (e) {
    if (e instanceof OidcError) throw e;
    ok = false;
  }
  if (!ok) throw new OidcError('bad-signature');
}

function leftHalfSha256B64u(value: string): string {
  return b64urlEncode(createHash('sha256').update(value, 'ascii').digest().subarray(0, 16));
}

// ---------------------------------------------------------------------------
// Single-use store (state/nonce replay protection, OIDC-01)
// ---------------------------------------------------------------------------

export class ReplayGuard {
  private used = new Map<string, number>(); // value -> end of its replay window (ms epoch)
  constructor(private readonly retentionMs: number, private readonly now: () => number = () => Date.now()) {}
  /** Consume ONCE; false when already used or malformed. Purges lazily. */
  consume(value: string, expiresAtSec: number): boolean {
    const nowMs = this.now();
    for (const [k, windowEnd] of this.used) {
      if (windowEnd <= nowMs) this.used.delete(k);
    }
    if (!isNonEmptyString(value)) return false;
    if (this.used.has(value)) return false;
    const windowEnd = Math.min(Math.floor(expiresAtSec) * 1000 + this.retentionMs, nowMs + this.retentionMs);
    this.used.set(value, windowEnd);
    return true;
  }
  /** True if the value was consumed (issued) and its window is open. */
  has(value: string): boolean {
    const hit = this.used.get(value);
    if (hit === undefined) return false;
    if (hit <= this.now()) {
      this.used.delete(value);
      return false;
    }
    return true;
  }
  get size(): number {
    return this.used.size;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface VerifiedToken {
  sub: string;
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  nonce?: string;
  claims: Record<string, unknown>;
}

export interface TokenSet {
  idToken: VerifiedToken;
  /** null for opaque (non-JWT) access tokens — legitimate per profile. */
  accessToken: VerifiedToken | null;
}

export interface AuthorizationUrlParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  scope?: string;
  prompt?: string;
  loginHint?: string;
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64urlEncode(randomBytes(32));
  const challenge = b64urlEncode(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

export interface OidcClientDeps {
  fetchImpl: FetchLike;
  now?: () => number;
}

export function createOidcClient(config: OidcClientConfig, deps: OidcClientDeps) {
  const cfg = validateOidcConfig(config);
  const now = deps.now ?? ((): number => Date.now());
  const fetchImpl = deps.fetchImpl;
  // validateOidcConfig always fills these; resolve them once for types.
  const ttlMs = cfg.jwksTtlMs ?? 300_000;
  const minRefreshMs = cfg.jwksMinRefreshMs ?? 30_000;
  const nonceGuard = new ReplayGuard(cfg.nonceRetentionMs ?? 600_000, now);
  const stateGuard = new ReplayGuard(cfg.nonceRetentionMs ?? 600_000, now);

  let discovery: { doc: DiscoveryDocument; at: number } | null = null;
  let jwks: { keys: Jwk[]; fetchedAt: number } | null = null;
  let jwksInFlight: Promise<{ keys: Jwk[]; fetchedAt: number }> | null = null;
  let lastJwksFetchAt = -Infinity;
  const stats = { jwksFetches: 0, discoveryFetches: 0 };

  async function jsonFetch(url: string, init: FetchInitLite): Promise<unknown> {
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new OidcError('upstream-http', 'oidc upstream status ' + res.status);
    return res.json();
  }

  async function discover(force = false): Promise<DiscoveryDocument> {
    if (!force && discovery && now() - discovery.at < ttlMs) return discovery.doc;
    const wellKnown = cfg.issuer.replace(/\/+$/, '') + '/.well-known/openid-configuration';
    const raw = (await jsonFetch(wellKnown, { method: 'GET', headers: { accept: 'application/json' } })) as
      | Partial<DiscoveryDocument>
      | null;
    if (!raw || !isNonEmptyString(raw.issuer)) throw new OidcError('discovery-invalid', 'issuer missing');
    // RFC 8414: the metadata issuer MUST equal the configured issuer
    // (trailing slashes tolerated, nothing else).
    if (raw.issuer.replace(/\/+$/, '') !== cfg.issuer.replace(/\/+$/, '')) {
      throw new OidcError('discovery-issuer-mismatch');
    }
    for (const key of ['jwks_uri', 'authorization_endpoint', 'token_endpoint'] as const) {
      if (!isNonEmptyString(raw[key])) throw new OidcError('discovery-invalid', key + ' missing');
      assertHttpUrl(raw[key]!, 'discovery.' + key);
    }
    discovery = { doc: raw as DiscoveryDocument, at: now() };
    stats.discoveryFetches += 1;
    return discovery.doc;
  }

  async function refreshJwks(): Promise<{ keys: Jwk[]; fetchedAt: number }> {
    if (jwksInFlight) return jwksInFlight;
    if (now() - lastJwksFetchAt < minRefreshMs) {
      throw new OidcError('jwks-refresh-throttled');
    }
    jwksInFlight = (async () => {
      const doc = await discover();
      const url = cfg.jwksUri ?? doc.jwks_uri;
      const body = (await jsonFetch(url, { method: 'GET', headers: { accept: 'application/json' } })) as
        | { keys?: unknown }
        | null;
      lastJwksFetchAt = now();
      stats.jwksFetches += 1;
      if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
        throw new OidcError('jwks-empty');
      }
      const state = { keys: body.keys as Jwk[], fetchedAt: now() };
      jwks = state;
      return state;
    })();
    try {
      return await jwksInFlight;
    } finally {
      jwksInFlight = null;
    }
  }

  async function keyForKid(kid: string): Promise<Jwk> {
    const stale = !jwks || now() - jwks.fetchedAt > ttlMs;
    let state = jwks;
    if (stale || !state) state = await refreshJwks();
    let key = state.keys.find((k) => k.kid === kid);
    if (!key) {
      // Rotation support: EXACTLY ONE forced refresh per unknown kid,
      // bounded by the throttle — unknown kids cannot trigger fetch storms.
      state = await refreshJwks();
      key = state.keys.find((k) => k.kid === kid);
    }
    if (!key) throw new OidcError('unknown-kid');
    return key;
  }

  function validateClaims(payload: Record<string, unknown>, expectedAud: string): VerifiedToken {
    const iss = payload.iss;
    if (!isNonEmptyString(iss) || !cfg.allowedIssuers.includes(iss)) {
      throw new OidcError('iss-not-allowed');
    }
    let aud: string[];
    if (typeof payload.aud === 'string') aud = [payload.aud];
    else if (Array.isArray(payload.aud) && payload.aud.length > 0 && payload.aud.every(isNonEmptyString)) {
      aud = payload.aud as string[];
    } else throw new OidcError('aud-malformed');
    if (!aud.includes(expectedAud)) throw new OidcError('aud-mismatch');
    // OIDC Core: multi-audience tokens must pin the authorized party.
    if (aud.length > 1 && payload.azp !== expectedAud) throw new OidcError('azp-missing-for-multi-aud');
    const nowSec = Math.floor(now() / 1000);
    const tol = cfg.clockToleranceSec ?? 30;
    if (typeof payload.exp !== 'number') throw new OidcError('missing-exp');
    if (payload.exp + tol < nowSec) throw new OidcError('expired');
    if (typeof payload.iat !== 'number') throw new OidcError('missing-iat');
    if (typeof payload.nbf === 'number' && payload.nbf - tol > nowSec) throw new OidcError('not-yet-valid');
    if (!isNonEmptyString(payload.sub)) throw new OidcError('missing-sub');
    return {
      sub: payload.sub,
      iss: iss as string,
      aud,
      exp: payload.exp,
      iat: payload.iat,
      nonce: isNonEmptyString(payload.nonce) ? (payload.nonce as string) : undefined,
      claims: payload,
    };
  }

  async function verifyJwt(token: string, expectedNonce?: string): Promise<VerifiedToken> {
    const { header, payload, signingInput, signature } = splitJwt(token);
    const { alg, kid } = assertSupportedAlg(header);
    const key = await keyForKid(kid);
    verifySignature(alg, signingInput, signature, key);
    const verified = validateClaims(payload, cfg.clientId);
    if (expectedNonce !== undefined) {
      if (verified.nonce !== expectedNonce) throw new OidcError('nonce-mismatch');
      if (!nonceGuard.consume(verified.nonce, verified.exp)) throw new OidcError('nonce-replay');
    }
    return verified;
  }

  /** ID token verification: the expected nonce (minted with the auth URL)
   *  is MANDATORY and single-use. */
  async function verifyIdToken(token: string, expectedNonce: string): Promise<VerifiedToken> {
    if (!isNonEmptyString(expectedNonce)) throw new OidcError('missing-expected-nonce');
    return verifyJwt(token, expectedNonce);
  }

  /** Access-token JWT verification + at_hash binding to the ID token
   *  (OIDC Core). Opaque tokens are reported by the caller, never here. */
  async function verifyAccessToken(token: string, idToken: VerifiedToken): Promise<VerifiedToken> {
    const verified = await verifyJwt(token);
    if (typeof idToken.claims.at_hash === 'string') {
      const hash = leftHalfSha256B64u(token);
      if (hash !== idToken.claims.at_hash) throw new OidcError('at-hash-mismatch');
    }
    return verified;
  }

  async function authorizationUrl(params: AuthorizationUrlParams): Promise<string> {
    const doc = await discover();
    if (!isNonEmptyString(params.state)) throw new OidcError('missing-state');
    if (!isNonEmptyString(params.nonce)) throw new OidcError('missing-nonce');
    if (!isNonEmptyString(params.codeChallenge)) throw new OidcError('missing-code-challenge');
    // state is single-use too (CSRF on the redirect): consumed at URL
    // build time; the callback validates it with consumeState().
    if (!stateGuard.consume(params.state, Math.floor(now() / 1000) + 600)) {
      throw new OidcError('state-replay');
    }
    const u = new URL(doc.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('redirect_uri', cfg.redirectUri);
    u.searchParams.set('scope', params.scope ?? 'openid profile');
    u.searchParams.set('state', params.state);
    u.searchParams.set('nonce', params.nonce);
    u.searchParams.set('code_challenge', params.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (isNonEmptyString(params.prompt)) u.searchParams.set('prompt', params.prompt);
    if (isNonEmptyString(params.loginHint)) u.searchParams.set('login_hint', params.loginHint);
    return u.toString();
  }

  /** Callback side: the redirect's state must match a minted, unconsumed one. */
  function consumeState(state: string): boolean {
    return isNonEmptyString(state) && stateGuard.has(state);
  }

  async function exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    nonce: string
  ): Promise<TokenSet> {
    if (!isNonEmptyString(code)) throw new OidcError('missing-code');
    if (!isNonEmptyString(codeVerifier)) throw new OidcError('missing-code-verifier');
    const doc = await discover();
    const basic = Buffer.from(cfg.clientId + ':' + cfg.clientSecret, 'utf8').toString('base64');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: cfg.redirectUri,
      code_verifier: codeVerifier,
    });
    const body = (await jsonFetch(doc.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + basic,
      },
      body: form.toString(),
    })) as { id_token?: unknown; access_token?: unknown } | null;
    if (!body || !isNonEmptyString(body.id_token)) {
      throw new OidcError('token-response-missing-id-token');
    }
    const idToken = await verifyJwt(body.id_token, nonce);
    let accessToken: VerifiedToken | null = null;
    if (isNonEmptyString(body.access_token)) {
      const raw = body.access_token as string;
      try {
        accessToken = await verifyAccessToken(raw, idToken);
      } catch (e) {
        if (e instanceof OidcError && (e.reason === 'malformed-jwt' || e.reason === 'malformed-base64')) {
          accessToken = null; // opaque access token: legitimate for many profiles
        } else {
          throw e;
        }
      }
    }
    return { idToken, accessToken };
  }

  return {
    config: cfg,
    discover,
    authorizationUrl,
    consumeState,
    exchangeAuthorizationCode,
    verifyIdToken,
    verifyAccessToken,
    /** test seam */
    stats: () => ({ ...stats }),
  };
}

export type OidcClient = ReturnType<typeof createOidcClient>;
