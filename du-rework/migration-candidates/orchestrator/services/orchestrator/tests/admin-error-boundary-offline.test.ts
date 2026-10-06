import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  errorClassOf,
  safeInternalErrorProblem,
  safeTransportErrorText,
} from '../src/http/errors';
import {
  createAdminShellServer as createAdminShellServerOnPort,
  type AdminShellHandle,
  type CreateAdminShellServerOptions,
} from '../src/app/admin/shell-server';
import {
  createOidcFlow,
  type OidcFlow,
  type OidcFlowRequest,
  type OidcFlowResponse,
} from '../src/app/admin/oidc-flow';
import type { OidcClient } from '../src/modules/auth/oidc-client';
import { signCookie } from '../src/app/admin/shell-auth';

/**
 * Windows draws outbound source ports from 49152-65535, so a port-0
 * listener competes with the host's own requests. Measured this cycle:
 * connect EADDRINUSE 127.0.0.1:57754 on a run that was green the two
 * runs before it - a flake, not a product failure. Band 44000-44504,
 * disjoint from 42000-42504 (the two audit suites) and 43000-43504
 * (admin-shell-platform-mount), so all four can run concurrently without
 * ever meeting. Disjointness is hygiene, NOT the guarantee - the bounded
 * retry is the guarantee. Only EADDRINUSE is swallowed; every other error
 * propagates unchanged.
 */
const PORT_BAND_BASE = 44_000 + (process.pid % 64) * 8;
const PORT_BAND_SLOTS = 16;
const claimedPorts = new Set<number>();
let portCursor = 0;

/** Hand out a port no other mount site in this file has taken. */
function claimPort(): number {
  for (let i = 0; i < PORT_BAND_SLOTS; i += 1) {
    const candidate = PORT_BAND_BASE + ((portCursor + i) % PORT_BAND_SLOTS) * 8;
    if (!claimedPorts.has(candidate)) {
      claimedPorts.add(candidate);
      portCursor += 1;
      return candidate;
    }
  }
  // Band exhausted: fall back to an OS ephemeral port rather than failing.
  return 0;
}

function createAdminShellServer(options: CreateAdminShellServerOptions): AdminShellHandle {
  if (options.port !== undefined && options.port !== 0) {
    return createAdminShellServerOnPort(options);
  }
  let current = createAdminShellServerOnPort({ ...options, port: claimPort() });
  return {
    listen: async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await current.listen();
        } catch (err) {
          if ((err as { code?: string }).code !== 'EADDRINUSE' || attempt >= PORT_BAND_SLOTS) {
            throw err;
          }
          await current.close().catch(() => undefined);
          current = createAdminShellServerOnPort({ ...options, port: claimPort() });
        }
      }
    },
    close: () => current.close(),
    get url() {
      return current.url;
    },
    get port() {
      return current.port;
    },
    lastRouteId: () => current.lastRouteId(),
  };
}

/**
 * W-ADMBASE03-ERR-1 — ADM-BASE-03 error boundary + sentinel-leak defense,
 * OFFLINE (no DB, no Redis, no S3; only the loopback shell sub-server).
 *
 * Scope of this file (no overlap with tests/adm-base-03-safe-error-offline.functional.test.ts,
 * which owns the errors.ts helpers, the ingress stream and the 'businesses'
 * deferred pane): the BROWSER-TIER unhandled boundary that nothing covered —
 *  - an IdP/Vault-leg failure that escapes the OIDC flow (stub flow throws an
 *    error carrying a token + key path + DSN) → the 500 HTML page;
 *  - the IdP-leg denial shape (exchange failure, ?error_description echo) and
 *    the fail-closed handleLogin contract, inline;
 *  - the degraded-200 connectors (Vault-adjacent) pane correlationId;
 *  - structural pins so raw echo cannot return to the fixed surfaces, now
 *    extended with oidc-flow/oidc-client and template-literal forms.
 *
 * ADM-BASE-03 acceptance pinned here: unexpected error → ZERO sentinel on the
 * wire, in HTML and in EVERY console sink, while the response still carries a
 * stable code + a correlationId that joins wire ↔ class-only log line.
 */

const SENTINEL_SECRET = 'SENTINEL-SECRET-9999';
const SENTINEL_PATH = 'C:/du/vault/master.key';
const SENTINEL_DSN = 'postgres://du:S3cr3t@db.internal:5432/prod';
const SENTINELS = [SENTINEL_SECRET, SENTINEL_PATH, SENTINEL_DSN];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sentinelMessage(prefix: string): string {
  return `${prefix}: Authorization=Bearer ${SENTINEL_SECRET} file=${SENTINEL_PATH} dsn=${SENTINEL_DSN}`;
}

/** Repo-style sentinel scanner: returns every [sentinel, where] hit. */
function scanForSentinels(haystacks: Array<unknown>, where: string): string[] {
  const text = haystacks
    .map((h) => (typeof h === 'string' ? h : JSON.stringify(h) ?? ''))
    .join('\n');
  const hits: string[] = [];
  for (const s of SENTINELS) if (text.includes(s)) hits.push(`${where}: ${s}`);
  return hits;
}

interface LogCapture {
  restore(): void;
  all(): string;
  sink(name: 'error' | 'warn' | 'info' | 'log'): string;
  records(): Array<Record<string, unknown>>;
}

/** Capture EVERY console sink, not just console.error: a leak through
 *  warn/info would be just as fatal for the sentinel scan. */
function captureLogs(): LogCapture {
  const sinks: Record<'error' | 'warn' | 'info' | 'log', string[]> = {
    error: [],
    warn: [],
    info: [],
    log: [],
  };
  const stdout: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  const orig = {
    error: console.error,
    warn: console.warn,
    info: console.info,
    log: console.log,
  };
  const record = (name: 'error' | 'warn' | 'info' | 'log') =>
    (...args: unknown[]): void => {
      sinks[name].push(
        args
          .map((a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? '')))
          .join(' '),
      );
    };
  console.error = record('error');
  console.warn = record('warn');
  console.info = record('info');
  console.log = record('log');
  return {
    restore(): void {
      process.stdout.write = originalStdoutWrite;
      console.error = orig.error;
      console.warn = orig.warn;
      console.info = orig.info;
      console.log = orig.log;
    },
    all: () => [...stdout, ...sinks.error, ...sinks.warn, ...sinks.info, ...sinks.log].join('\n'),
    sink: (name) => [...sinks[name], ...(name === 'error' ? stdout : [])].join('\n'),
    records: () => stdout
      .flatMap((chunk) => chunk.split(/\r?\n/).filter(Boolean))
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A flow whose BOTH IdP legs throw an upstream-style error (token + path +
 *  DSN in the message) — the shape a Vault/IdP client failure has. Login and
 *  callback are separate requests, so one exploding flow drives both
 *  browser-tier 500 cases. */
function explodingFlow(): OidcFlow {
  const boom = (): never => {
    const err = new Error(sentinelMessage('vault/idp upstream failure'));
    err.name = 'VaultError';
    throw err;
  };
  const benign: (req: OidcFlowRequest) => Promise<OidcFlowResponse> = async () => ({
    status: 302,
    headers: { location: '/admin' },
    body: '',
  });
  return {
    handleLogin: boom,
    handleCallback: boom,
    handleLogout: benign,
    sanitizeReturnTo: () => '/admin',
  };
}

/** A flow whose login leg SUCCEEDS. Measured: the shell hands the WHOLE
 *  response to handleLogin (the page is whatever the flow returns), so the
 *  200-leg tests need a flow that does not throw. explodingFlow() cannot
 *  serve them: /admin/login calls handleLogin, so a throwing flow turns
 *  that 200 into the 500 boundary (already pinned by the baseline). */
function benignLoginFlow(): OidcFlow {
  const redirect = async (): Promise<OidcFlowResponse> => ({
    status: 302,
    headers: { location: '/admin' },
    body: '',
  });
  return {
    handleLogin: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<p>login</p>',
    }),
    handleCallback: redirect,
    handleLogout: redirect,
    sanitizeReturnTo: () => '/admin',
  };
}

const SECRET = 'adm-err1-cookie-secret';
const TOKEN = 'adm-err1-admin-token';

function adminCookie(): string {
  return (
    'du_admin=' +
    signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    })
  );
}

describe('W-ADMBASE03-ERR-1 policy helpers carry no sentinel by construction', () => {
  it('errorClassOf/error helpers with a sentinel-bearing error: class + fixed text only', () => {
    const err = new Error(sentinelMessage('pg driver failure'));
    err.name = 'QueryFailedError';
    expect(errorClassOf(err)).toBe('QueryFailedError');
    expect(scanForSentinels([errorClassOf(err)], 'errorClassOf')).toEqual([]);
    expect(safeTransportErrorText('Internal error')).toBe(
      'Internal error. Details redacted (see server log).',
    );
    const problem = safeInternalErrorProblem('corr-adm03-1');
    expect(Object.keys(problem).sort()).toEqual([
      'code',
      'correlationId',
      'detail',
      'status',
      'title',
      'type',
    ]);
    expect(problem.code).toBe('TEMPORARY_UNAVAILABLE');
    expect(problem.correlationId).toBe('corr-adm03-1');
    expect(scanForSentinels([problem, JSON.stringify(problem)], 'problem')).toEqual([]);
  });
});

describe('W-ADMBASE03-ERR-1 browser-tier unhandled boundary (real loopback HTTP)', () => {
  let handle: AdminShellHandle;
  let baseUrl: string;
  let fetcherCalls = 0;

  beforeAll(async () => {
    handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      oidcFlow: explodingFlow(),
      sectionFetchers: {
        connectors: async (): Promise<never> => {
          fetcherCalls += 1;
          throw new Error(sentinelMessage('vault read failed for tenant connector'));
        },
      },
    });
    const r = await handle.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('IdP callback leg escaping upstream: 500 HTML = code + correlationId, zero sentinel on wire and in ALL log sinks', async () => {
    const logs = captureLogs();
    let res: Response;
    try {
      res = await fetch(baseUrl + '/admin/oidc/callback?code=abc&state=xyz', {
        redirect: 'manual',
      });
    } finally {
      logs.restore();
    }
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/html');
    // (1) the wire: no sentinel, but a STABLE code + a correlationId
    expect(scanForSentinels([body], 'response body')).toEqual([]);
    expect(body).toContain('Internal error. Details redacted (see server log).');
    expect(body).toContain('TEMPORARY_UNAVAILABLE');
    const headerId = res.headers.get('x-correlation-id');
    expect(headerId).toMatch(UUID_RE);
    expect(body).toContain(headerId);
    // (2) the logs: class-only + the SAME id (joinable), zero sentinel in
    // every sink (error/warn/info/log) — not just console.error.
    const logText = logs.all();
    expect(scanForSentinels([logText], 'logs')).toEqual([]);
    expect(logs.sink('error')).toContain('[admin-shell] unhandled request error');
    expect(logs.sink('error')).toContain('"errorClass":"VaultError"');
    expect(logs.sink('error')).toContain(headerId);
    expect(logs.sink('warn') + logs.sink('info') + logs.sink('log')).not.toContain(SENTINEL_SECRET);

    const [record] = logs.records();
    expect(record).toMatchObject({
      level: 'error',
      service: 'orchestrator',
      environment: 'test',
      correlationId: headerId,
      operationId: null,
      taskId: null,
      invocationId: null,
      subsystem: 'admin-shell',
      errorClass: 'VaultError',
    });
    expect(record?.timestamp).toEqual(expect.any(String));
    expect(new Date(record?.timestamp as string).toISOString()).toBe(record?.timestamp);
    expect(record?.message).toBe('[admin-shell] unhandled request error');
  });

  it('IdP login leg escaping upstream: same boundary contract (second surface)', async () => {
    const logs = captureLogs();
    let res: Response;
    try {
      res = await fetch(baseUrl + '/admin/login', { redirect: 'manual' });
    } finally {
      logs.restore();
    }
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(scanForSentinels([body, logs.all()], 'login leg')).toEqual([]);
    expect(body).toContain('TEMPORARY_UNAVAILABLE');
    expect(res.headers.get('x-correlation-id')).toMatch(UUID_RE);
    expect(logs.sink('error')).toContain('"errorClass":"VaultError"');
  });

  it('degraded 200 on the Vault-adjacent connectors pane: zero sentinel + joinable correlationId header/log', async () => {
    const before = fetcherCalls;
    const logs = captureLogs();
    let res: Response;
    try {
      res = await fetch(
        baseUrl + '/admin/connectors?connectorId=openai&revision=1',
        { headers: { cookie: adminCookie() } },
      );
    } finally {
      logs.restore();
    }
    const body = await res.text();
    expect(fetcherCalls).toBe(before + 1);
    expect(res.status).toBe(200); // degrade, never crash the page
    expect(scanForSentinels([body, logs.all()], 'connectors pane')).toEqual([]);
    const headerId = res.headers.get('x-correlation-id');
    expect(headerId).toMatch(UUID_RE);
    expect(logs.sink('error')).toContain('[admin-shell] deferred section render error');
    expect(logs.sink('error')).toContain(headerId);
    expect(logs.sink('error')).toContain('"errorClass":"Error"');
  });
});

describe('W-ADMBASE03-ERR-1 OIDC flow denial shape (inline, pure)', () => {
  function flowWith(client: Partial<OidcClient>, sessionCreate?: () => void) {
    let consumed = 0;
    let created = 0;
    const flow = createOidcFlow({
      client: client as OidcClient,
      sessions: {
        create: async () => {
          created += 1;
          sessionCreate?.();
          throw new Error('must not be reached in a denial test');
        },
        get: async () => null,
        destroy: async () => true,
      },
      challenges: {
        put: async () => undefined,
        consume: async () => {
          consumed += 1;
          return { verifier: 'v'.repeat(43), nonce: 'n'.repeat(43), returnTo: '/admin', expiresAt: Date.now() + 60_000 };
        },
      },
      publicOrigin: 'http://localhost:2023',
    });
    return {
      flow,
      stats: () => ({ consumed, created }),
    };
  }

  it('token-exchange failure carrying a token: ONE 403 denial, zero sentinel, NO session minted', async () => {
    const { flow, stats } = flowWith({
      exchangeAuthorizationCode: async () => {
        throw new Error(sentinelMessage('idp token exchange failed'));
      },
    });
    const res = await flow.handleCallback({
      method: 'GET',
      path: '/admin/oidc/callback',
      query: { code: 'c', state: 's' },
      cookies: {},
    });
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(scanForSentinels([res.body, JSON.stringify(res)], 'denial body')).toEqual([]);
    expect(stats().consumed).toBe(1); // the challenge was consumed (one-shot, no replay oracle)
    expect(stats().created).toBe(0);
  });

  it('IdP error_description echo: the denial shape never reflects upstream text', async () => {
    const { flow, stats } = flowWith({
      exchangeAuthorizationCode: async () => {
        throw new Error('unreachable');
      },
    });
    const res = await flow.handleCallback({
      method: 'GET',
      path: '/admin/oidc/callback',
      query: { error: 'access_denied', error_description: sentinelMessage('idp error_description') },
      cookies: {},
    });
    expect(res.status).toBe(403);
    expect(scanForSentinels([res.body], 'error_description echo')).toEqual([]);
    expect(stats().consumed).toBe(0); // IdP-reported error never burns a challenge slot
    expect(stats().created).toBe(0);
  });

  it('handleLogin fails closed by REJECTION — the flow itself never renders upstream text', async () => {
    const { flow } = flowWith({
      authorizationUrl: async () => {
        throw new Error(sentinelMessage('idp discovery failed'));
      },
    });
    const err = await flow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    if (!err) throw new Error('expected handleLogin to reject');
    expect(err).toBeInstanceOf(Error);
    // The error propagates to the boundary (which renders fixed text); the
    // flow must not swallow it into a page carrying upstream detail, so the
    // REJECTION is the whole contract — the flow never builds a body.
    expect(err.name).toBe('Error');
    expect(scanForSentinels([err.name], 'login rejection name')).toEqual([]);
  });
});

describe('W-ADMBASE03-ERR-1 structural pins (raw echo cannot return to the fixed surfaces)', () => {
  const SRC = join(__dirname, '..', 'src');
  const targetFiles: string[] = [
    join(SRC, 'http', 'errors.ts'),
    join(SRC, 'http', 'ingress.ts'),
    join(SRC, 'server.ts'),
    // CONV-02: the route families moved out of server.ts — keep the pin over
    // the code that now owns the request boundary.
    ...['runtime.ts', 'public.ts', 'admin.ts'].map((f) => join(SRC, 'http', 'routes', f)),
    // CONV-03: the HTTP listener + createApp moved to the bootstrap layer.
    join(SRC, 'app', 'bootstrap', 'create-app.ts'),
    join(SRC, 'app', 'bootstrap', 'crypto-wiring.ts'),
    join(SRC, 'app', 'admin', 'shell-server.ts'),
    join(SRC, 'app', 'admin', 'oidc-flow.ts'),
    join(SRC, 'modules', 'auth', 'oidc-client.ts'),
    ...readdirSync(join(SRC, 'app', 'admin'))
      .filter((f) => f.endsWith('-section-data.ts'))
      .map((f) => join(SRC, 'app', 'admin', f)),
  ];

  const BANNED: Array<[RegExp, string]> = [
    [/String\((err|e|error|ex)\)/, 'String(err)'],
    [/\b(err|e|error|ex)\.(message|stack)\b/, 'err.message / err.stack'],
    [/\$\{\s*(err|e|error|ex)\b[^}]*\}/, 'template interpolation of the error object'],
  ];

  it.each(targetFiles.map((f) => [f] as [string]))(
    '%s has no executable raw-error echo (comments may name the idiom)',
    (file) => {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      for (const [re, label] of BANNED) {
        expect({ file: file.replace(SRC, ''), label, match: code.match(re)?.[0] ?? null }).toEqual({
          file: file.replace(SRC, ''),
          label,
          match: null,
        });
      }
    },
  );

  it('create-app.ts unhandled catch routes through the shared sanitizers (no inline problem body)', () => {
    // CONV-03: the HTTP listener (and its 'unhandled request error' catch)
    // moved from server.ts to the bootstrap composition root.
    const source = readFileSync(join(SRC, 'app', 'bootstrap', 'create-app.ts'), 'utf8');
    const idx = source.indexOf('unhandled request error');
    expect(idx).toBeGreaterThan(-1);
    const region = source.slice(Math.max(0, idx - 1200), idx + 1200);
    expect(region).toContain('sanitizedInternalError(');
    expect(region).toContain('errorNameOf(');
  });

  it('shell-server.ts unhandled catch carries the code + correlationId contract', () => {
    const source = readFileSync(join(SRC, 'app', 'admin', 'shell-server.ts'), 'utf8');
    const idx = source.indexOf('unhandled request error');
    expect(idx).toBeGreaterThan(-1);
    const region = source.slice(Math.max(0, idx - 1200), idx + 1600);
    expect(region).toContain('correlationId');
    expect(region).toContain("res.setHeader('x-correlation-id'");
    expect(region).toContain('TEMPORARY_UNAVAILABLE');
    expect(region).toContain('errorClassOf(err)');
  });
});

describe('W-ADM-UX-06 error boundary: masking and correlationId', () => {
  let h: AdminShellHandle;
  let base: string;
  beforeAll(async () => {
    h = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      oidcFlow: explodingFlow(),
    });
    const r = await h.listen();
    base = r.url;
  });
  afterAll(async () => { await h.close(); });

  it('an unhandled error masks message, stack and SQL detail, keeps class+id', async () => {
    const logs = captureLogs();
    let res: Response;
    try {
      const boom: AdminShellHandle = h;
      void boom;
      res = await fetch(base + '/admin/oidc/callback?code=abc', { redirect: 'manual' });
    } finally {
      logs.restore();
    }
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(scanForSentinels([body, logs.all()], 'unhandled')).toEqual([]);
    expect(body).toContain('Internal error. Details redacted');
    expect(body).not.toContain('at Object.');      // no stack frames
    expect(body).not.toContain('SELECT');          // no SQL text
    expect(body).not.toMatch(/\brelation\b/i);      // no DB internals; the \b keeps
                                                // the legitimate Correlation ID a non-hit
    const cid = res.headers.get('x-correlation-id');
    expect(cid).toMatch(UUID_RE);
    expect(body).toContain(cid as string);
  });

  it('correlationId header is present and a valid UUID on EVERY error leg', async () => {
    for (const path of ['/', '/admin/businesses', '/admin/nope', '/admin/login']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const cid = res.headers.get('x-correlation-id');
      expect(cid).toMatch(UUID_RE);
    }
  });

  it('correlationId is unique per request, never a constant', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(base + '/', { redirect: 'manual' });
      const cid = res.headers.get('x-correlation-id');
      expect(cid).toMatch(UUID_RE);
      seen.add(cid as string);
    }
    expect(seen.size).toBe(5);
  });

  it('a VALID client-echoed correlationId is PRESERVED (trace joining depends on it)', async () => {
    // Measured contract, and the opposite of my first guess: normalizeCorrelationId
    // passes a well-formed client token straight through so a gateway can join
    // its own trace to this hop. Server-generated ids are UUIDs; client-echoed
    // ids are any [A-Za-z0-9._-]{8,128} token.
    const res = await fetch(base + '/', {
      redirect: 'manual',
      headers: { 'x-correlation-id': 'client-trace-0123456789' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('client-trace-0123456789');
  });

  it('a MALFORMED client correlationId is replaced by a server UUID, never echoed', async () => {
    for (const bad of ['has space', 'short', 'x'.repeat(200), 'semi;colon']) {
      const res = await fetch(base + '/', {
        redirect: 'manual',
        headers: { 'x-correlation-id': bad },
      });
      const cid = res.headers.get('x-correlation-id');
      expect(cid).toMatch(UUID_RE);
      expect(cid).not.toBe(bad);
    }
  });
});


describe('W-ADM-UX-06 error boundary: XSS reflection and status contract', () => {
  let h: AdminShellHandle;
  let base: string;
  beforeAll(async () => {
    h = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      oidcFlow: benignLoginFlow(),
    });
    const r = await h.listen();
    base = r.url;
  });
  afterAll(async () => { await h.close(); });

  it('a script tag in the path is never reflected into the error page', async () => {
    const payload = encodeURIComponent('<script>alert(1)</script>');
    const res = await fetch(base + '/admin/' + payload, { redirect: 'manual' });
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body.toLowerCase()).not.toContain('<script>');
    expect(body.toLowerCase()).not.toContain('</script>');
  });

  it('an onerror payload in the query is never reflected', async () => {
    const payload = encodeURIComponent('<img src=x onerror=alert(1)>');
    const res = await fetch(base + '/admin/login?redirect=' + payload, { redirect: 'manual' });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body.toLowerCase()).not.toContain('onerror=alert');
  });

  it('the 404 page does not reflect the path back AT ALL (stronger than escaping)', async () => {
    // Measured: the boundary page carries no echo of the requested path, so a
    // payload is not merely escaped - it is absent. Absent is safer than escaped.
    const payload = encodeURIComponent('<b>x</b>');
    const res = await fetch(base + '/admin/' + payload, { redirect: 'manual' });
    const body = await res.text();
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('x</b>');
  });

  it('401 unauth, 404 unknown, 200 login: the status contract is intact', async () => {
    const unauth = await fetch(base + '/admin/businesses', { redirect: 'manual' });
    expect(unauth.status).toBe(401);
    const unknown = await fetch(base + '/admin/nope', { redirect: 'manual' });
    expect(unknown.status).toBe(404);
    const login = await fetch(base + '/admin/login', { redirect: 'manual' });
    expect(login.status).toBe(200);
  });

  it('route match runs BEFORE auth: an unknown path is 404 even unauthenticated', async () => {
    // Probed behaviour: 404 is decided by the router before any cookie check,
    // so an unauthenticated probe cannot use 404 vs 401 to map the routes.
    const res = await fetch(base + '/admin/does-not-exist', { redirect: 'manual' });
    expect(res.status).toBe(404);
  });

  it('every error leg answers text/html, never a raw stack or JSON dump', async () => {
    for (const path of ['/', '/admin/nope', '/admin/businesses']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).not.toContain('at Object.');
      expect(body).not.toContain(String.fromCharCode(10) + '    at ');
    }
  });
});


describe('W-ADM-UX-06 IdP exchange: fail-closed edges', () => {
  function flowWith(client: Partial<OidcClient>) {
    let created = 0;
    const flow = createOidcFlow({
      client: client as OidcClient,
      sessions: {
        create: async () => { created += 1; throw new Error('must not be reached'); },
        get: async () => null,
        destroy: async () => true,
      },
      challenges: {
        put: async () => undefined,
        consume: async () => ({ verifier: 'v'.repeat(43), nonce: 'n'.repeat(43), returnTo: '/admin', expiresAt: Date.now() + 60_000 }),
      },
      publicOrigin: 'http://localhost:2023',
    });
    return { flow, created: () => created };
  }

  it('an upstream throw of a NON-Error value is still a clean denial', async () => {
    const { flow, created } = flowWith({
      exchangeAuthorizationCode: async () => {
        throw sentinelMessage('a bare string, not an Error');
      },
    });
    const res = await flow.handleCallback({
      method: 'GET',
      path: '/admin/oidc/callback',
      query: { code: 'c', state: 's' },
      cookies: {},
    });
    expect(res.status).toBe(403);
    expect(scanForSentinels([res.body], 'bare string throw')).toEqual([]);
    expect(created()).toBe(0);
  });

  it('a rejection whose message is an empty string still denies, never 500s', async () => {
    const { flow, created } = flowWith({
      exchangeAuthorizationCode: async () => {
        throw new Error('');
      },
    });
    const res = await flow.handleCallback({ method: 'GET', path: '/admin/oidc/callback', query: { code: 'c', state: 's' }, cookies: {} });
    expect(res.status).toBe(403);
    expect(created()).toBe(0);
  });

  it('a missing authorization code denies without touching the upstream', async () => {
    let called = 0;
    const { flow, created } = flowWith({
      exchangeAuthorizationCode: async () => {
        called += 1;
        return { accessToken: 'a', idToken: 'i' } as never;
      },
    });
    const res = await flow.handleCallback({ method: 'GET', path: '/admin/oidc/callback', query: { state: 's' }, cookies: {} });
    expect(res.status).toBe(403);
    expect(called).toBe(0);
    expect(created()).toBe(0);
  });

  it('no denial leg ever mints a session cookie', async () => {
    for (const bad of [
      () => { throw new Error(sentinelMessage('boom-a')); },
      () => { throw new Error(''); },
      () => { throw sentinelMessage('boom-c'); },
    ]) {
      const { flow, created } = flowWith({ exchangeAuthorizationCode: bad });
      const res = await flow.handleCallback({ method: 'GET', path: '/admin/oidc/callback', query: { code: 'c', state: 's' }, cookies: {} });
      expect(res.status).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(created()).toBe(0);
    }
  });
});

