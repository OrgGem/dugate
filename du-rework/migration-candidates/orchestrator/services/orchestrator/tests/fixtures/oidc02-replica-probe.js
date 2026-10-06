'use strict';
/*
 * CYCLE 138b — LIVE-WINDOW PROBE for the OIDC-02 two-replica acceptance.
 * ONE PROCESS = ONE REPLICA. This is the real child process the gated
 * block in tests/oidc02-process-replicas-offline.test.ts spawns (TWICE
 * for the A/B pair, plus ONE MORE for the audit-150-155 RESTART case)
 * when DU_LIVE_INFRA === '1'. It is never executed offline, and it is
 * never collected by jest (plain .js, not a *.test.* file).
 *
 * It serves the PRODUCTION shell router over its own loopback HTTP port:
 *   dist/app/admin/shell-router.dispatchShellRequestAsync
 * with the component set main.ts builds per process (oidc-boot's redis
 * branch, mirrored through dist factories) over the REAL Redis via
 * createIoredisSessionGateway(REDIS_URL) — namespaced keyPrefix per run
 * (never FLUSHDB, never touching other lanes' keys).
 *
 * Control surface (x-probe-token protected, loopback-only):
 *   GET /__probe/session?sid=   -> { live, role }     (raw store read)
 *   GET /__probe/rotate?sid=    -> { dead } | { sid } (fixation rotation)
 *   GET /__probe/revoke?sub=    -> { count }          (nuclear revoke)
 * Browser surface (production router): /admin*, /admin/login,
 * /admin/oidc/callback, /admin/logout — du_session cookies ride as-is.
 *
 * Contract with the parent suite:
 *   env: PROBE_ISSUER, REDIS_URL, PROBE_REDIRECT_URI, PROBE_CLIENT_ID,
 *        PROBE_CLIENT_SECRET, PROBE_PUBLIC_ORIGIN, PROBE_TOKEN,
 *        PROBE_KEY_PREFIX, PROBE_CHAL_PREFIX,
 *        PROBE_ABS_MS, PROBE_IDLE_MS   (short TTLs for the expiry leg)
 *   stdout: 'LISTENING <port>' once bound; 'PROBE_ERROR <msg>' + exit 1
 *           on boot failure. SIGTERM/SIGINT -> close server + gateway.
 *   Requires a fresh 'pnpm run build' (dist/) in the Tester's window.
 */
const { createServer } = require('node:http');
const path = require('node:path');

function dist(rel) {
  return require(path.join(__dirname, '..', '..', 'dist', rel));
}

/*
 * CYCLE 139 (W49-QW1-LIVE-001 Tester receipt): loopback SYNs on this box
 * intermittently time out (recorded `connect ETIMEDOUT :5xxxx` storm).
 * The child's IdP-facing fetch retries the NETWORK layer only:
 *   GET/HEAD  -> ETIMEDOUT|ECONNREFUSED|EADDRINUSE|ECONNRESET|EPIPE
 *   POST      -> only codes proving the request was never delivered
 *                 (ETIMEDOUT|ECONNREFUSED|EADDRINUSE) so a single-use
 *                 auth code can never be double-spent by a retry.
 * HTTP statuses — including deliberate fail-closed 500s — pass through
 * untouched on the first try.
 */
const RETRYABLE_CONNECT = ['ETIMEDOUT', 'ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'EPIPE'];
const RETRYABLE_PREDELIVERY = ['ETIMEDOUT', 'ECONNREFUSED', 'EADDRINUSE'];

async function retryFetch(url, init, attempts) {
  const max = attempts || 4;
  const method = String((init && init.method) || 'GET').toUpperCase();
  const allowed = method === 'POST' ? RETRYABLE_PREDELIVERY : RETRYABLE_CONNECT;
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      const code = err && err.cause && typeof err.cause.code === 'string' ? err.cause.code : '';
      if (!code || allowed.indexOf(code) < 0 || i === max - 1) break;
      await new Promise((res) => setTimeout(res, 150 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      if (raw.length < 64 * 1024) raw += chunk;
    });
    req.on('end', () => {
      const out = {};
      if (raw.length > 0) {
        for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
      }
      resolve(out);
    });
  });
}

async function main() {
  const env = process.env;
  const issuer = env.PROBE_ISSUER;
  const redisUrl = env.REDIS_URL;
  if (!issuer || !redisUrl) throw new Error('PROBE_ISSUER and REDIS_URL are required');
  const redisRepo = dist('modules/auth/redis-session-repository.js');
  const oidcClient = dist('modules/auth/oidc-client.js');
  const sessionStore = dist('modules/auth/session-store.js');
  const oidcFlow = dist('app/admin/oidc-flow.js');
  const shellRouter = dist('app/admin/shell-router.js');

  const keyPrefix = env.PROBE_KEY_PREFIX || 'du:admin:sess:live-probe:';
  const chalPrefix = env.PROBE_CHAL_PREFIX || 'du:admin:chal:live-probe:';
  const gateway = redisRepo.createIoredisSessionGateway(redisUrl);
  // ROOT-CAUSE FIX (Tester-1, W49-QW1-LIVE-001 mintLive 500): with
  // enableOfflineQueue:false the FIRST command of the FIRST /admin/login
  // (challenges.put) rejected with 'Stream isn't writeable' because the
  // ioredis connect had not completed when the LISTENING port was already
  // live. Await ready() BEFORE binding the socket: if the Redis behind
  // REDIS_URL never becomes ready (adapter 10s budget), this rejects and
  // the probe exits with PROBE_ERROR — the parent's spawn timeout sees a
  // loud infra failure, never a silent 500 storm.
  await gateway.ready();
  const store = sessionStore.createSessionStore({
    repo: redisRepo.createRedisSessionRepository(gateway, { keyPrefix }),
    absoluteTtlMs: Number(env.PROBE_ABS_MS || 600000),
    idleTtlMs: Number(env.PROBE_IDLE_MS || 300000),
  });
  const fetchImpl = async (url, init) => {
    const r = await retryFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
    });
    return { status: r.status, ok: r.ok, json: async () => await r.json() };
  };
  const client = oidcClient.createOidcClient(
    {
      issuer,
      clientId: env.PROBE_CLIENT_ID || 'du-admin-live-probe',
      clientSecret: env.PROBE_CLIENT_SECRET || 'live-probe-secret',
      redirectUri: env.PROBE_REDIRECT_URI || 'http://localhost:2023/admin/oidc/callback',
      allowedIssuers: [issuer],
    },
    { fetchImpl }
  );
  const flow = oidcFlow.createOidcFlow({
    client,
    sessions: store,
    challenges: redisRepo.createRedisChallengeStore(gateway, { keyPrefix: chalPrefix }),
    publicOrigin: env.PROBE_PUBLIC_ORIGIN || 'http://localhost:2023',
  });
  const config = {
    cookieSecret: 'live-probe-shell-secret-0123456789',
    adminToken: 'live-probe-admin-token',
    oidcFlow: flow,
    oidcSessions: store,
  };
  const token = env.PROBE_TOKEN || '';
  const jsend = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/__probe/')) {
        if (!token || req.headers['x-probe-token'] !== token) return jsend(res, 403, { error: 'forbidden' });
        if (url.pathname === '/__probe/session') {
          const rec = await store.get(url.searchParams.get('sid') || '');
          return jsend(res, 200, { live: !!rec, role: rec ? rec.role : null });
        }
        if (url.pathname === '/__probe/rotate') {
          const next = await store.rotate(url.searchParams.get('sid') || '');
          return jsend(res, 200, next ? { sid: next.sessionId } : { dead: true });
        }
        if (url.pathname === '/__probe/revoke') {
          const count = await store.revokePrincipal(issuer, url.searchParams.get('sub') || 'mock-user-1');
          return jsend(res, 200, { count });
        }
        return jsend(res, 404, { error: 'unknown probe route' });
      }
      const method = req.method === 'POST' ? 'POST' : req.method === 'HEAD' ? 'HEAD' : 'GET';
      const out = await shellRouter.dispatchShellRequestAsync(
        {
          method,
          pathname: url.pathname,
          cookies: parseCookies(req.headers.cookie),
          body: method === 'POST' ? await readBody(req) : {},
          query: Object.fromEntries(url.searchParams.entries()),
        },
        config
      );
      res.writeHead(out.response.status, out.response.headers);
      res.end(out.response.body);
    } catch (e) {
      try { jsend(res, 500, { error: String((e && e.message) || e) }); } catch { /* socket gone */ }
    }
  });

  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('LISTENING ' + server.address().port + '\n');
  });
  const shutdown = () => {
    try { server.close(); } catch { /* already */ }
    try { Promise.resolve(gateway.close()).catch(() => undefined); } catch { /* no close */ }
    setTimeout(() => process.exit(0), 50).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  process.stderr.write('PROBE_ERROR ' + String((e && e.message) || e) + '\n');
  process.exit(1);
});
