import { createOidcClient, type FetchLike } from '../../src/modules/auth/oidc-client';
import {
  createRedisChallengeStore,
  createRedisSessionRepository,
  type RedisSessionGateway,
} from '../../src/modules/auth/redis-session-repository';
import { createSessionStore, type SessionRecord } from '../../src/modules/auth/session-store';
import { createOidcFlow, type OidcFlow } from '../../src/app/admin/oidc-flow';
import { dispatchShellRequestAsync, type ShellRuntimeConfig } from '../../src/app/admin/shell-router';
import type { AdminShellRequest, AdminShellResponse } from '../../src/app/admin/shell-types';

/**
 * CYCLE 138 — OIDC-02 MULTI-REPLICA HARNESS (Reviewer audit 132-137).
 *
 * WHAT THIS IS: the scenario library behind
 * tests/oidc02-process-replicas-offline.test.ts. A 'replica' here is an
 * ENTIRELY FRESH component graph — its own OidcClient, its own session
 * store, its own challenge store, its own ShellRuntimeConfig — the exact
 * set main.ts builds per process via oidc-boot. Two replicas share
 * NOTHING in JavaScript object space except (a) the Redis gateway and
 * (b) the mock IdP: every cross-replica effect travels through storage,
 * which is precisely what the current in-process store-pair tests cannot
 * prove (they share the store code path, not an HTTP/cookie surface).
 *
 * WHAT THE SCENARIOS COVER (the reviewer's list):
 *  - browser-shaped callback completing on a FOREIGN replica, the minted
 *    du_session then served by BOTH replicas through the real router;
 *  - cookie logout on one replica killing the session on the other;
 *  - rotation (fixation defense) across process boundaries;
 *  - RESTART = discard the whole graph, rebuild over the same gateway;
 *  - expiry (absolute + idle) propagating cluster-wide on the real clock;
 *  all under the SEC-00 issuer/origin config below — one identity plane
 *  (same issuer, client id, redirect, public origin) shared by replicas,
 *  exactly as the runbook's DU_ADMIN_OIDC_* contract requires.
 *
 * LIVE EXTENSION CONTRACT (Tester-1, separate-window task — NOT run here):
 *  1. swap the gateway: RedisSessionGateway := createIoredisSessionGateway(
 *     process.env.REDIS_URL) — the deploy's Redis server;
 *  2. per REAL PROCESS: spawn node children running a probe that calls
 *     makeReplica() and serves the router over HTTP (startAdminShell from
 *     src/app/admin/shell-server.ts) on two distinct loopback ports;
 *  3. drive the SAME helpers against http://127.0.0.1:(portA|portB) via
 *     fetch instead of in-process dispatchShellRequestAsync (copy the
 *     set-cookie header verbatim between hops);
 *  4. keep the SEC00 constants EXCEPT the IdP: use the deploy issuer and
 *     secret per docs/runbooks/vault-oidc-operations.md;
 *  5. gate everything behind DU_LIVE_INFRA=true exactly like
 *     oidc02-multi-replica-offline.test.ts does today.
 *  This file is fixture-only: it matches no jest testMatch, so adding it
 *  cannot break the existing suites; it compiles inside the jest runs
 *  that import it.
 */

/** SEC-00 identity plane: replicas MUST agree on every value here. */
export const SEC00 = {
  clientId: 'du-admin-replicas',
  clientSecret: 'replica-shared-secret',
  publicOrigin: 'http://localhost:2023',
  redirectUri: 'http://localhost:2023/admin/oidc/callback',
} as const;

export interface ReplicaTuning {
  absoluteTtlMs?: number;
  idleTtlMs?: number;
}

/** The harness's 'separate process': a complete component graph. */
export interface Replica {
  readonly name: string;
  readonly config: ShellRuntimeConfig;
  /** full store (rotate/revoke live here in-process; a child process
   *  would call the same API — the type is intentionally the raw one) */
  readonly store: {
    create(i: { issuer: string; sub: string; tenantId?: string | null; role: 'admin' | 'operator' | 'viewer' }): Promise<SessionRecord>;
    get(id: string): Promise<SessionRecord | null>;
    rotate(id: string): Promise<SessionRecord | null>;
    destroy(id: string): Promise<boolean>;
    revokePrincipal(iss: string, sub: string): Promise<number>;
  };
  readonly flow: OidcFlow;
}

/**
 * CYCLE 139 (Tester-1 receipt, W49-QW1-LIVE-001): loopback on this box
 * intermittently swallows fresh-connection SYNs (the recorded
 * `connect ETIMEDOUT :5xxxx` storm). Every fetch in this harness — and
 * in the live block — now retries the NETWORK layer only, with
 * exponential backoff: HTTP statuses (incl. the harness' fail-closed
 * 500s) are returned untouched on the first try, and a POST is retried
 * ONLY on codes that prove the request was never delivered
 * (ETIMEDOUT/ECONNREFUSED/EADDRINUSE) so single-use auth-codes can
 * never be double-spent by a retry.
 */
const RETRYABLE_CONNECT = ['ETIMEDOUT', 'ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'EPIPE'];
const RETRYABLE_PREDELIVERY = ['ETIMEDOUT', 'ECONNREFUSED', 'EADDRINUSE'];

function syscallCodeOf(err: unknown): string {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : '';
}

export async function fetchWithRetry(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'manual' | 'follow' },
  attempts = 4
) {
  const method = (init.method ?? 'GET').toUpperCase();
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...init });
    } catch (err) {
      lastErr = err;
      const code = syscallCodeOf(err);
      const allowed = method === 'POST' ? RETRYABLE_PREDELIVERY : RETRYABLE_CONNECT;
      if (code.length === 0 || !allowed.includes(code) || i === attempts - 1) break;
      await new Promise((res) => setTimeout(res, 150 * 2 ** i)); // 150/300/600ms
    }
  }
  throw lastErr;
}

const fetchImpl: FetchLike = async (url, init) => {
  const r = await fetchWithRetry(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
  });
  return { status: r.status, ok: r.ok, json: async () => (await r.json()) as unknown };
};

let replicaCounter = 0;

/** Build one replica — mirrors buildOidcAdminComponents' redis branch
 *  line-for-line (boot is separately covered by oidc-boot.test.ts; this
 *  mirrors it to expose the FULL store to scenario code). */
export function makeReplica(
  gateway: RedisSessionGateway,
  issuer: string,
  tuning: ReplicaTuning = {}
): Replica {
  const name = 'replica-' + (replicaCounter += 1);
  const client = createOidcClient(
    {
      issuer,
      clientId: SEC00.clientId,
      clientSecret: SEC00.clientSecret,
      redirectUri: SEC00.redirectUri,
      allowedIssuers: [issuer],
    },
    { fetchImpl }
  );
  const store = createSessionStore({
    repo: createRedisSessionRepository(gateway),
    absoluteTtlMs: tuning.absoluteTtlMs ?? 8 * 3_600_000,
    idleTtlMs: tuning.idleTtlMs ?? 30 * 60_000,
  });
  const flow = createOidcFlow({
    client,
    sessions: store,
    challenges: createRedisChallengeStore(gateway),
    publicOrigin: SEC00.publicOrigin,
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: 'shell-secret-' + name + '-0123456789',
    adminToken: 'at-' + name,
    oidcFlow: flow,
    oidcSessions: store,
  };
  return { name, config, store, flow };
}

// ---------------------------------------------------------------------------
// browser-shaped helpers — everything goes through the REAL router/store
// ---------------------------------------------------------------------------

export function req(
  method: 'GET' | 'POST',
  pathname: string,
  extra: Partial<AdminShellRequest> = {}
): AdminShellRequest {
  return { method, pathname, cookies: {}, body: {}, ...extra };
}

export function sidFrom(setCookie: string | undefined): string {
  return /du_session=([A-Za-z0-9_-]{43})/.exec(setCookie ?? '')?.[1] ?? '';
}

/** Step-1 leg at THIS replica: GET /admin/login -> IdP authorize URL. */
export async function loginAt(replica: Replica): Promise<URL> {
  const res = await dispatchShellRequestAsync(req('GET', '/admin/login'), replica.config);
  expect(res.response.status).toBe(302);
  return new URL(res.response.headers['location'] ?? '');
}

/** The browser leg: actually visit the mock IdP (loopback HTTP, same
 *  pattern as every other offline OIDC suite). */
export async function authorizeAtIdp(authUrl: URL): Promise<{ code: string; state: string }> {
  const r = await fetchWithRetry(authUrl.toString(), { redirect: 'manual' });
  expect(r.status).toBe(302);
  const back = new URL(r.headers.get('location') ?? '');
  expect(back.origin + back.pathname).toBe(SEC00.redirectUri);
  return { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '' };
}

/** Callback leg at ANY replica (challenge is shared-storage, not local). */
export async function callbackAt(
  replica: Replica,
  code: string,
  state: string
): Promise<AdminShellResponse> {
  const res = await dispatchShellRequestAsync(
    req('GET', '/admin/oidc/callback', { query: { code, state } }),
    replica.config
  );
  return res.response;
}

/** Authenticated page visit with the minted cookie. */
export async function visit(
  replica: Replica,
  sid: string,
  pathname = '/admin'
): Promise<AdminShellResponse> {
  return (await dispatchShellRequestAsync(
    req('GET', pathname, { cookies: { du_session: sid } }),
    replica.config
  )).response;
}

/** Cookie logout AT this replica (destroys via the shared store). */
export async function logoutAt(replica: Replica, sid: string): Promise<AdminShellResponse> {
  const res = await dispatchShellRequestAsync(
    req('POST', '/admin/logout', { cookies: { du_session: sid } }),
    replica.config
  );
  return res.response;
}
