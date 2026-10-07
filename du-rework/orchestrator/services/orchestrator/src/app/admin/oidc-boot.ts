import { readFileSync } from 'node:fs';
import { createOidcClient, type FetchLike } from '../../modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore, type SessionRepository } from '../../modules/auth/session-store';
import {
  createIoredisSessionGateway,
  createRedisChallengeStore,
  createRedisSessionRepository,
  type RedisSessionGateway,
} from '../../modules/auth/redis-session-repository';

// ORCHESTRATOR REMINDER (cycle 122+): re-export the Redis repository
// surface here too — oidc-boot is the single integration point for the
// persistent admin-identity plane, and consumers wiring their own
// gateway (dev fakes, future Postgres repo) should not have to reach
// past this module into modules/auth internals.
export {
  createIoredisSessionGateway,
  createRedisChallengeStore,
  createRedisSessionRepository,
  type RedisChallengeStoreOptions,
  type RedisSessionGateway,
  type RedisSessionRepositoryOptions,
} from '../../modules/auth/redis-session-repository';
import type { AdminSessionStore } from '../../modules/admin-actions/rbac';
import {
  createMemoryChallengeStore,
  createOidcFlow,
  type OidcChallengeStore,
  type OidcFlow,
} from './oidc-flow';

/**
 * CYCLE-108/113 REVIEW (finding 2): turn the DU_ADMIN_OIDC_* environment
 * (names from docs/runbooks/vault-oidc-operations.md) into the live
 * OIDC-04 components the orchestrator boots with — an OidcClient over
 * real fetch, the opaque session store behind AdminSessionStore, and the
 * shell login/callback/logout flow — and hand them to createApp.
 *
 * Fail-closed boot rules:
 *  - NONE of the required vars set -> null: the OIDC plane stays off and
 *    the deployment keeps the bearer + legacy du_admin surfaces (the
 *    pre-OIDC behavior, byte-for-byte).
 *  - PARTIAL config -> throw. A half-mounted identity plane is how
 *    'login works but sessions resolve nothing' incidents start; the
 *    process must not boot into that state.
 *  - The client secret is a FILE per the runbook (mounted secret); an
 *    inline env value is tolerated for local dev but the file wins when
 *    both are set. The secret value is never logged or echoed into an
 *    error message.
 *  - PKCE method is fixed S256 (SEC-01); any other configured value is
 *    a boot error, not a silent downgrade.
 *  - W-SEC-OIDC04-PROXY-1 (delta-26): session cookies are NEVER minted
 *    insecure in an enforced environment. requireSecure = NODE_ENV=
 *    production OR DU_ADMIN_COOKIE_SECURE=enforce. When the configured
 *    public origin is not https, the ONLY admissible proof of TLS
 *    termination is DU_ADMIN_TRUST_PROXY_PROTOCOL=true (per-request
 *    x-forwarded-proto, strict single-token https, consulted ONLY while
 *    that knob is on). requireSecure + http origin + no proxy trust means
 *    every callback would denial-loop, so the process refuses to boot
 *    rather than let an operator assume the flag was on. Garbage values
 *    for either knob are boot errors, never silent defaults.
 *
 * Session persistence (ORCHESTRATOR REQUESTS, cycles 113+/121+):
 * DU_ADMIN_OIDC_SESSION_BACKEND selects the persistent plane —
 * UNSET auto-detects ('redis' whenever REDIS_URL is present, else
 * 'memory'), an explicit value always wins, and NO mode silently
 * degrades redis->memory. 'memory' keeps per-process behavior
 * byte-for-byte (dev/tests); 'redis' runs BOTH the OIDC-02 session
 * store AND the OIDC-04 challenge store on one DEDICATED connection
 * (never shared with BullMQ): sessions are shared across replicas with
 * Redis-owned TTLs, revokePrincipal rides a hashed principal index, and
 * login challenges (state -> PKCE verifier/nonce/returnTo) are consumed
 * by atomic GETDEL so replica A can start a login replica B finishes.
 * A Redis outage FAILS CLOSED — commands reject without an offline
 * queue, auth resolves deny, never a stale-grant. components.close()
 * tears the connection down in the graceful-shutdown chain.
 */

const REQUIRED = {
  issuer: 'DU_ADMIN_OIDC_ISSUER',
  clientId: 'DU_ADMIN_OIDC_CLIENT_ID',
  redirectUri: 'DU_ADMIN_OIDC_REDIRECT_URI',
} as const;
const SECRET_FILE = 'DU_ADMIN_OIDC_CLIENT_SECRET_FILE';
const SECRET_INLINE = 'DU_ADMIN_OIDC_CLIENT_SECRET';

export interface OidcAdminComponents {
  adminSessionStore: AdminSessionStore;
  adminOidcFlow: OidcFlow;
  /** Present only when the backend OWNS a connection (redis): the
   *  shutdown chain calls this AFTER app.close() drains the shell. */
  close?: () => Promise<void>;
  /**
   * ROOT-CAUSE FIX (Tester-1 mintLive 500): with enableOfflineQueue:false
   * the FIRST command that lands before the ioredis 'ready' event (the
   * challenges.put behind the very first /admin/login) rejects with
   * 'Stream isn't writeable' — a 500 that looks like a product failure
   * but is a connect race. The redis backend exposes ready(); main.ts
   * AWAITS it before app.listen() so no request can ever hit a cold
   * identity plane. Memory/fake gateways have no connect phase -> absent.
   */
  ready?: () => Promise<void>;
}

/** Test/dev seam: production builds the ioredis gateway itself; offline
 *  suites inject an in-process fake to exercise THE SAME repository. */
export interface OidcBootDeps {
  createRedisGateway?: (url: string) => RedisSessionGateway;
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * W-SEC-OIDC04-PROXY-1 (delta-26/delta-27). The cookie Secure-posture
 * policy, shared by the OIDC boot below and — since W-SEC-COOKIE-CONFIG-1
 * (delta-33 closure) — by the legacy du_admin surface too: shell-server
 * parses it once at mount into ShellRuntimeConfig.cookiePolicy and
 * shell-router's legacyCookiePosture applies it to mint/clear. Parsing is
 * fail-closed on garbage values, mirroring the DU_ADMIN_OIDC_PKCE_METHOD
 * rule (a garbage knob refuses BOTH mounts).
 *  - trustProxyProtocol: DU_ADMIN_TRUST_PROXY_PROTOCOL — true|1|false|0|unset.
 *  - requireSecure: DU_ADMIN_COOKIE_SECURE=enforce, or NODE_ENV=production.
 *    'auto' (or unset) keeps the NODE_ENV derivation — production can NEVER
 *    opt OUT of Secure enforcement through this env surface.
 */
export function parseCookieSecurePolicy(env: NodeJS.ProcessEnv): {
  trustProxyProtocol: boolean;
  requireSecure: boolean;
} {
  const trustRaw = trimmed(env['DU_ADMIN_TRUST_PROXY_PROTOCOL']).toLowerCase();
  let trustProxyProtocol = false;
  if (trustRaw === 'true' || trustRaw === '1') trustProxyProtocol = true;
  else if (trustRaw.length > 0 && trustRaw !== 'false' && trustRaw !== '0') {
    throw new Error("DU_ADMIN_TRUST_PROXY_PROTOCOL must be 'true' or 'false' (1/0 accepted), got '" + trustRaw + "'");
  }
  const secureRaw = trimmed(env['DU_ADMIN_COOKIE_SECURE']).toLowerCase();
  if (secureRaw.length > 0 && secureRaw !== 'auto' && secureRaw !== 'enforce') {
    throw new Error("DU_ADMIN_COOKIE_SECURE must be 'auto' or 'enforce', got '" + secureRaw + "'");
  }
  const requireSecure = secureRaw === 'enforce' || trimmed(env['NODE_ENV']).toLowerCase() === 'production';
  return { trustProxyProtocol, requireSecure };
}

export function buildOidcAdminComponents(
  env: NodeJS.ProcessEnv,
  deps: OidcBootDeps = {}
): OidcAdminComponents | null {
  const want = [
    REQUIRED.issuer, REQUIRED.clientId, REQUIRED.redirectUri, SECRET_FILE, SECRET_INLINE,
  ].filter((name) => trimmed(env[name]).length > 0);
  if (want.length === 0) return null;
  const missing: string[] = [];
  if (!trimmed(env[REQUIRED.issuer])) missing.push(REQUIRED.issuer);
  if (!trimmed(env[REQUIRED.clientId])) missing.push(REQUIRED.clientId);
  if (!trimmed(env[REQUIRED.redirectUri])) missing.push(REQUIRED.redirectUri);
  if (!trimmed(env[SECRET_FILE]) && !trimmed(env[SECRET_INLINE])) missing.push(SECRET_FILE + ' (or ' + SECRET_INLINE + ')');
  if (missing.length > 0) {
    throw new Error('OIDC partially configured — refusing to boot. Missing: ' + missing.join(', '));
  }
  const pkce = trimmed(env['DU_ADMIN_OIDC_PKCE_METHOD']).toUpperCase();
  if (pkce.length > 0 && pkce !== 'S256') {
    throw new Error('DU_ADMIN_OIDC_PKCE_METHOD must be S256 (SEC-01 PKCE policy)');
  }
  const issuer = trimmed(env[REQUIRED.issuer]);
  const redirectUri = trimmed(env[REQUIRED.redirectUri]);
  const allowedIssuers = trimmed(env['DU_ADMIN_OIDC_ALLOWED_ISSUERS']).length > 0
    ? trimmed(env['DU_ADMIN_OIDC_ALLOWED_ISSUERS']).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [issuer];
  const secret = trimmed(env[SECRET_FILE])
    ? readFileSync(trimmed(env[SECRET_FILE]), 'utf8').trim()
    : trimmed(env[SECRET_INLINE]);
  if (secret.length === 0) throw new Error('OIDC client secret file is empty: ' + trimmed(env[SECRET_FILE]));

  const fetchImpl: FetchLike = async (url, init) => {
    const r = await fetch(url, {
      method: init.method as 'GET' | 'POST',
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
    });
    return { status: r.status, ok: r.ok, json: async () => (await r.json()) as unknown };
  };
  const client = createOidcClient(
    { issuer, clientId: trimmed(env[REQUIRED.clientId]), clientSecret: secret, redirectUri, allowedIssuers },
    { fetchImpl }
  );
  // Backend selection (orchestrator request, cycle 108+2): an explicit
  // DU_ADMIN_OIDC_SESSION_BACKEND always wins; UNSET auto-detects —
  // REDIS_URL present means 'this deployment wants the persistent
  // plane', absent keeps single-process memory (dev/tests byte-for-byte
  // unchanged). Neither mode ever SILENTLY degrades redis->memory.
  const redisUrl = trimmed(env['REDIS_URL']);
  const backendRaw = trimmed(env['DU_ADMIN_OIDC_SESSION_BACKEND']).toLowerCase();
  const backend = backendRaw.length > 0 ? backendRaw : redisUrl.length > 0 ? 'redis' : 'memory';
  if (backend !== 'memory' && backend !== 'redis') {
    throw new Error("DU_ADMIN_OIDC_SESSION_BACKEND must be 'memory' or 'redis', got '" + backendRaw + "'");
  }
  let sessionClose: (() => Promise<void>) | undefined;
  let sessionReady: (() => Promise<void>) | undefined;
  let repo: SessionRepository = createMemorySessionRepository();
  let challenges: OidcChallengeStore = createMemoryChallengeStore();
  if (backend === 'redis') {
    if (redisUrl.length === 0) {
      throw new Error('DU_ADMIN_OIDC_SESSION_BACKEND=redis requires REDIS_URL (fail closed: no silent per-process fallback)');
    }
    const gateway = deps.createRedisGateway
      ? deps.createRedisGateway(redisUrl)
      : createIoredisSessionGateway(redisUrl);
    repo = createRedisSessionRepository(gateway);
    // THE cross-replica login fix: the state->PKCE-challenge rides the
    // SAME connection, consumed by atomic GETDEL — replica A can start
    // the flow and replica B finish it, exactly once.
    challenges = createRedisChallengeStore(gateway);
    sessionClose = gateway.close ? async () => { await gateway.close?.(); } : undefined;
    sessionReady = gateway.ready ? async () => { await gateway.ready!(); } : undefined;
  }
  const sessions = createSessionStore({ repo });
  const publicOrigin = trimmed(env['DU_ADMIN_OIDC_PUBLIC_ORIGIN']) || new URL(redirectUri).origin;
  const cookiePolicy = parseCookieSecurePolicy(env);
  const configSecure = new URL(publicOrigin).protocol === 'https:';
  if (cookiePolicy.requireSecure && !configSecure && !cookiePolicy.trustProxyProtocol) {
    throw new Error(
      'OIDC session cookies would be minted WITHOUT the Secure flag in an enforced ' +
      'environment (NODE_ENV=production or DU_ADMIN_COOKIE_SECURE=enforce). Set ' +
      'DU_ADMIN_OIDC_PUBLIC_ORIGIN to the https public origin, or ' +
      'DU_ADMIN_TRUST_PROXY_PROTOCOL=true when TLS terminates at a proxy that ' +
      'overwrites x-forwarded-proto. Refusing to boot (fail closed).'
    );
  }
  const flow = createOidcFlow({
    client,
    sessions,
    challenges,
    publicOrigin,
    cookie: cookiePolicy,
  });
  return {
    adminSessionStore: sessions,
    adminOidcFlow: flow,
    ...(sessionClose ? { close: sessionClose } : {}),
    ...(sessionReady ? { ready: sessionReady } : {}),
  };
}
