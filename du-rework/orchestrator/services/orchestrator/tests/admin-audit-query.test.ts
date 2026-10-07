/**
 * W-ADM-UX-03-AUDIT-QUERY (Delta 143): what the audit pane does with a full
 * query string, and whether the operator can act on what the route says.
 *
 * Mounted for real over loopback with no custom sectionFetchers, so the
 * DEFAULT fetcher is what is under test. A stub JSON API records every
 * request and lets each test choose the reply: a forwarding bug and an
 * error-handling bug look identical from the browser, so both are pinned
 * against the URL the platform actually received.
 *
 * Offline: loopback HTTP only, no DB, no Redis.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachAdminShell } from '../src/app/admin';
import type { AdminShellAttachResult } from '../src/app/admin';

const TOKEN = 'audit-query-token';
const SECRET = 'audit-query-secret';
const RAW_KEY = 'deadbeef'.repeat(5);

interface Res {
  status: number;
  body: string;
  setCookie: string[];
}

async function req(
  url: string,
  opts: { method?: string; body?: string; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += String(c); });
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [],
          });
        });
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const ENVELOPE = {
  items: [{
    id: 'evt-1',
    kind: 'auth.login_failed',
    severity: 'warning',
    occurredAt: '2026-09-28T10:00:00.000Z',
    tenantId: 'tenant-a',
    resourceId: 'doc-1',
    actor: 'svc-deploy',
    message: 'auth.login_failed doc-1',
  }],
  nextCursor: null,
  prevCursor: null,
  total: 1,
  limit: 50,
};

let api: http.Server;
let shell: AdminShellAttachResult;
let hits: URL[] = [];
let reply: (u: URL) => { status: number; body: unknown } = () => ({
  status: 200,
  body: ENVELOPE,
});

beforeAll(async () => {
  api = http.createServer((rq, rs) => {
    const u = new URL(rq.url ?? '/', 'http://127.0.0.1');
    hits.push(u);
    const r = reply(u);
    rs.writeHead(r.status, { 'content-type': 'application/json' });
    rs.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiUrl = 'http://127.0.0.1:' + String((api.address() as AddressInfo).port);
  // W-ADM-UX-05-PORT-ISOLATION: a below-ephemeral band plus a bounded
  // retry. Two DISTINCT traps were measured here, not guessed:
  //  1. adminShellPort 0 puts the listener INSIDE 49152-65535 - the same
  //     range Windows draws outbound source ports from - so the shell can
  //     be handed a port a live connection already holds. Observed verbatim:
  //     connect EADDRINUSE 127.0.0.1:59673.
  //  2. One fixed constant collides with a concurrent jest run or a port
  //     still in TIME_WAIT.
  // Below-ephemeral removes trap 1; the retry removes trap 2.
  const base = 42000 + (process.pid % 64) * 8;
  let mounted: AdminShellAttachResult | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 16 && mounted === null; attempt += 1) {
    try {
      mounted = await attachAdminShell({
        config: {
          adminShellCookieSecret: SECRET,
          adminToken: TOKEN,
          adminShellHost: '127.0.0.1',
          adminShellPort: base + attempt * 8,
          jsonBaseUrl: apiUrl,
        },
      });
      if (mounted === null) break;
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code !== 'EADDRINUSE') throw err;
    }
  }
  if (mounted === null) {
    throw lastErr ?? new Error('admin shell could not bind any candidate port');
  }
  shell = mounted;
});

afterAll(async () => {
  // Close whatever actually got created. If beforeAll died part way, an
  // unguarded teardown throws a SECOND error on top of the real one and
  // hides why the mount failed.
  if (shell) await shell.handle.close();
  if (api) await new Promise<void>((r) => api.close(() => r()));
});

beforeEach(() => {
  hits = [];
  reply = () => ({ status: 200, body: ENVELOPE });
});

async function open(qs: string): Promise<Res> {
  const res = await req(shell.url + '/admin/login', {
    method: 'POST',
    body: new URLSearchParams({ token: TOKEN, redirect: '/admin/audit' }).toString(),
  });
  const cookie = (res.setCookie[0] ?? '').split(';')[0] ?? '';
  return req(shell.url + '/admin/audit' + qs, { cookie });
}

function auditHit(): URL | undefined {
  return hits.find((u) => u.pathname === '/api/v1/admin/audit');
}

describe('W-ADM-UX-03 audit query: forwarding and error clarity', () => {
  it('forwards a FULL query string to the route unchanged', async () => {

    // cursor included on purpose: this test is about forwarding the WHOLE query.
    await open('?severity=warning&actor=ops&resource=doc-1&from=2026-09-01T00:00:00Z&to=2026-09-28T23:59:59Z&limit=25&cursor=abc');
    const u = auditHit();
    expect(u).toBeDefined();
    expect(u?.searchParams.get('severity')).toBe('warning');
    expect(u?.searchParams.get('actor')).toBe('ops');
    expect(u?.searchParams.get('resource')).toBe('doc-1');
    expect(u?.searchParams.get('from')).toBe('2026-09-01T00:00:00Z');
    expect(u?.searchParams.get('to')).toBe('2026-09-28T23:59:59Z');
    expect(u?.searchParams.get('limit')).toBe('25');
    expect(u?.searchParams.get('cursor')).toBe('abc');
  });

  it('omits filters the operator did not set', async () => {
    await open('?severity=info');
    const u = auditHit();
    expect(u?.searchParams.get('severity')).toBe('info');
    expect(u?.searchParams.has('actor')).toBe(false);
    expect(u?.searchParams.has('from')).toBe(false);
    expect(u?.searchParams.has('cursor')).toBe(false);
  });

  it('surfaces the ROUTE remedy text on 422, not a bare status code', async () => {
    reply = () => ({
      status: 422,
      body: {
        status: 422,
        code: 'INVALID_SCHEMA',
        title: 'Unprocessable',
        message: 'cursor was issued for a different sort; drop cursor to restart the list',
      },
    });
    const res = await open('?cursor=abc&sort=createdAt:asc');
    expect(res.status).toBe(200);
    expect(res.body).toContain('drop cursor to restart the list');
  });

  it('maps a 401 from the route to the unauthorized pane', async () => {
    reply = () => ({ status: 401, body: { status: 401, code: 'UNAUTHORIZED', message: 'no' } });
    const res = await open('');
    expect(res.body).toContain('data-unauthorized-message');
  });

  it('maps a 500 from the route to the error pane', async () => {
    reply = () => ({ status: 500, body: { status: 500, code: 'INTERNAL', message: 'boom' } });
    const res = await open('');
    expect(res.body).toContain('data-error-message');
  });

  it('never projects a non-JSON error body into the page', async () => {
    reply = () => ({ status: 502, body: '<html>upstream secret</html>' });
    const res = await open('');
    expect(res.body).not.toContain('upstream secret');
  });

  it('drops a pasted raw API key from the URL and names the field', async () => {
    const res = await open('?actor=' + RAW_KEY);
    expect(res.status).toBe(200);
    expect(auditHit()?.searchParams.has('actor')).toBe(false);
    expect(res.body).toContain('data-filter-rejected');
    expect(res.body).not.toContain(RAW_KEY);
  });

  it('drops a severity outside the enum and names the field', async () => {
    const res = await open('?severity=critical');
    expect(auditHit()?.searchParams.has('severity')).toBe(false);
    expect(res.body).toContain('data-filter-rejected');
  });

  it('drops a local-time bound instead of reinterpreting it as UTC', async () => {
    const res = await open('?from=2026-09-01T00:00:00%2B07:00');
    expect(auditHit()?.searchParams.has('from')).toBe(false);
    expect(res.body).toContain('data-filter-rejected');
  });

  it('fails CLOSED on an inverted window and asks the route NOTHING', async () => {
    const res = await open('?from=2026-09-28T10:00:00Z&to=2026-09-28T09:00:00Z');
    expect(res.status).toBe(200);
    expect(auditHit()).toBeUndefined();
    expect(res.body).toContain('data-error-message');
    expect(res.body).toContain('from must not be after to');
  });

  it('clamps a nonsense limit instead of forwarding it', async () => {
    await open('?limit=999999');
    expect(auditHit()?.searchParams.get('limit')).toBe('200');
  });
});


describe('W-ADM-UX-10 audit pane: empty state and error boundary', () => {
  it('an empty UNFILTERED ledger shows a banner, not a blank page', async () => {
    reply = () => ({
      status: 200,
      body: { items: [], nextCursor: null, prevCursor: null, total: 0, limit: 50 },
    });
    const res = await open('');
    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-empty-banner='true'`);
    expect(res.body).toContain('No audit events recorded');
    expect(res.body).toContain('total: 0');
  });

  it('an empty FILTERED ledger says so and offers a way out', async () => {
    reply = () => ({
      status: 200,
      body: { items: [], nextCursor: null, prevCursor: null, total: 0, limit: 50 },
    });
    const res = await open('?severity=warning');
    expect(res.body).toContain(`data-empty-banner='filtered'`);
    expect(res.body).toContain('No events match the active filters');
    expect(res.body).toContain('data-clear-filters');
  });

  it('a non-empty ledger renders the table, never the banner', async () => {
    const res = await open('');
    expect(res.body).not.toContain('audit-section__empty-banner');
    expect(res.body).toContain('data-audit-event');
  });

  it('a 5xx shows the error pane WITH a Try again control', async () => {
    reply = () => ({ status: 503, body: { status: 503, code: 'UNAVAILABLE', message: 'down' } });
    const res = await open('?severity=warning');
    expect(res.status).toBe(200);
    expect(res.body).toContain(`data-status-pane='error'`);
    expect(res.body).toContain(`data-retry='error'`);
    expect(res.body).toContain('Try again');
  });

  it('the retry link reloads THIS url, keeping the operator filters', async () => {
    reply = () => ({ status: 500, body: { status: 500, code: 'INTERNAL', message: 'boom' } });
    const res = await open('?severity=warning&actor=ops');
    const m = /audit-section__retry' href='([^']*)'/.exec(res.body);
    expect(m).not.toBeNull();
    // Empty href resolves against the current document, so the retry repeats
    // the exact failed request. A hard-coded pane path would silently drop
    // severity and actor.
    expect(m === null ? 'x' : m[1]).toBe('');
  });

  it('unauthorized offers a fresh sign-in, NOT a doomed retry', async () => {
    reply = () => ({ status: 401, body: { status: 401, code: 'UNAUTHORIZED', message: 'no' } });
    const res = await open('');
    expect(res.body).toContain(`data-status-pane='unauthorized'`);
    expect(res.body).toContain('Sign in again');
    expect(res.body).toContain('/admin/login');
    expect(res.body).not.toContain('Try again');
  });
});


describe('W-ADM-UX-10 audit query: hostile input is rejected by name, never reflected', () => {
  const Q = String.fromCharCode(39);
  const XSS = '<script>alert(1)</script>';
  const IMG = '<img src=x onerror=alert(1)>';
  const BREAKOUT = Q + ' onmouseover=' + Q + 'alert(1)';

  it('drops a script payload from actor and names the field', async () => {
    const res = await open('?actor=' + encodeURIComponent(XSS));
    expect(res.status).toBe(200);
    expect(auditHit()?.searchParams.has('actor')).toBe(false);
    expect(res.body).toContain('data-filter-rejected');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('alert(1)');
  });

  it('drops a script payload from action and resource', async () => {
    const res = await open(
      '?action=' + encodeURIComponent(XSS) + '&resource=' + encodeURIComponent(XSS),
    );
    expect(auditHit()?.searchParams.has('action')).toBe(false);
    expect(auditHit()?.searchParams.has('resource')).toBe(false);
    expect(res.body).not.toContain('<script>');
  });

  it('drops a script payload from severity and from', async () => {
    const res = await open(
      '?severity=' + encodeURIComponent(XSS) + '&from=' + encodeURIComponent(XSS),
    );
    expect(auditHit()?.searchParams.has('severity')).toBe(false);
    expect(auditHit()?.searchParams.has('from')).toBe(false);
    expect(res.body).not.toContain('<script>');
  });

  it('drops a script payload from sort and keeps the default order', async () => {
    await open('?sort=' + encodeURIComponent(XSS));
    const u = auditHit();
    expect(u).toBeDefined();
    expect(u?.searchParams.has('sort')).toBe(false);
  });

  it('rejects a quote-breakout payload in a filter', async () => {
    const res = await open('?actor=' + encodeURIComponent(BREAKOUT));
    expect(auditHit()?.searchParams.has('actor')).toBe(false);
    expect(res.body).not.toContain('onmouseover');
  });

  it('rejects an img/onerror payload in a filter', async () => {
    const res = await open('?actor=' + encodeURIComponent(IMG));
    expect(auditHit()?.searchParams.has('actor')).toBe(false);
    expect(res.body).not.toContain('onerror');
  });

  it('bounds an over-long cursor to the contract length', async () => {
    await open('?cursor=' + 'a'.repeat(400));
    const c = auditHit()?.searchParams.get('cursor') ?? '';
    expect(c.length).toBe(128);
  });

  it('forwards a malformed cursor verbatim so the route can reject it', async () => {
    reply = () => ({
      status: 422,
      body: {
        status: 422,
        code: 'INVALID_SCHEMA',
        message: 'cursor is not a valid sortable list cursor',
      },
    });
    const res = await open('?cursor=' + encodeURIComponent('not-a-cursor'));
    expect(res.status).toBe(200);
    expect(auditHit()?.searchParams.get('cursor')).toBe('not-a-cursor');
    expect(res.body).toContain('cursor is not a valid sortable list cursor');
  });

  it('escapes a hostile cursor the route echoed back', async () => {
    reply = () => ({
      status: 200,
      body: { items: [], nextCursor: IMG, prevCursor: null, total: 0, limit: 50 },
    });
    const res = await open('');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).not.toContain('onerror=alert(1)');
  });
});
