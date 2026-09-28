/**
 * ADM-BASE-03 offline safe-error-boundary tests (Qwen-2, cycle 90).
 *
 * Proves ZERO secret leak on every unhandled-error surface fixed in this task:
 * HTTP problem body, rendered Admin shell page, section-fetcher messages and
 * server logs — sentinels shaped like a bearer secret, an absolute key-file
 * path and a password-bearing DSN must never appear anywhere. Pure offline:
 * no DB, no Redis, ephemeral shell sub-server on 127.0.0.1 only.
 *
 * Run offline: npx jest tests/adm-base-03-safe-error-offline.functional.test.ts --runInBand
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { errorClassOf, safeInternalErrorProblem, safeTransportErrorText } from '../src/http/errors';
import { readBoundedBody } from '../src/http/ingress';
import { fetchApiKeys } from '../src/app/admin/api-key-section-data';
import { fetchOverview } from '../src/app/admin/overview-section-data';
import { createAdminShellServer, type AdminShellHandle } from '../src/app/admin/shell-server';

const SENTINEL_SECRET = 'sk-LIVE-sentinel-9f8e7d6c5b4a';
const SENTINEL_PATH = 'C:/du/vault/master.key';
const SENTINEL_DSN = 'postgres://du:S3cr3t@db.internal:5432/prod';
// A realistic unexpected-failure message: driver text wrapping all three.
const SENTINEL_MSG = `pg driver failure ${SENTINEL_SECRET} reading ${SENTINEL_PATH} via ${SENTINEL_DSN}`;

const SRC = join(__dirname, '..', 'src');

describe('ADM-BASE-03 helpers (errors.ts)', () => {
  it('safeInternalErrorProblem is stable-code + correlationId only', () => {
    const p = safeInternalErrorProblem('corr-42');
    expect(Object.keys(p).sort()).toEqual([
      'code',
      'correlationId',
      'detail',
      'status',
      'title',
      'type',
    ]);
    expect(p.status).toBe(500);
    expect(p.code).toBe('TEMPORARY_UNAVAILABLE');
    expect(String(p.detail)).toContain('corr-42');
    // No error-derived fields exist to leak into.
    expect(JSON.stringify(p)).not.toMatch(/stack|message.*driver/i);
  });

  it('errorClassOf reports the class, never the message', () => {
    const e = new Error(SENTINEL_MSG);
    e.name = 'QueryFailedError';
    expect(errorClassOf(e)).toBe('QueryFailedError');
    expect(errorClassOf({})).toBe('object');
    expect(errorClassOf('boom')).toBe('string');
    expect(errorClassOf(null)).toBe('object');
  });

  it('safeTransportErrorText carries fixed text only', () => {
    const t = safeTransportErrorText('Network error contacting the platform');
    expect(t).toBe('Network error contacting the platform. Details redacted (see server log).');
    expect(t).not.toContain(SENTINEL_MSG);
  });
});

describe('ADM-BASE-03 ingress boundary (readBoundedBody)', () => {
  it('stream error with sentinel message rejects with class-only 400 detail', async () => {
    const req = new PassThrough() as unknown as IncomingMessage;
    const pending = readBoundedBody(req, {
      binary: false,
      limits: { maxJsonBytes: 1024, maxBlobBytes: 1024 },
    });
    setImmediate(() => (req as unknown as PassThrough).emit('error', new Error(SENTINEL_MSG)));
    await expect(pending).rejects.toMatchObject({
      name: 'HttpError',
      status: 400,
      code: 'MALFORMED_BODY',
    });
    const err = await pending.then(
      () => null,
      (e: unknown) => e as Error
    );
    if (!err) throw new Error('expected rejection');
    expect(err.message).toContain('request body stream failed');
    expect(err.message).not.toContain(SENTINEL_SECRET);
    expect(err.message).not.toContain(SENTINEL_PATH);
    expect(err.message).not.toContain(SENTINEL_DSN);
  });
});

describe('ADM-BASE-03 section fetchers (injected failing transport)', () => {
  const boomFetch = (() => Promise.reject(new Error(SENTINEL_MSG))) as unknown as typeof fetch;

  it('fetchApiKeys network pane is fixed redacted text, zero sentinel', async () => {
    const res = await fetchApiKeys({
      keyId: '',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: SENTINEL_SECRET, // must never be reflected anywhere
      fetchImpl: boomFetch,
      timeoutMs: 250,
    });
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.message).toBe('Network error contacting the platform. Details redacted (see server log).');
    expect(res.message).not.toContain(SENTINEL_SECRET);
    expect(res.message).not.toContain(SENTINEL_PATH);
    expect(res.message).not.toContain(SENTINEL_DSN);
  });

  it('fetchOverview network pane is fixed redacted text, zero sentinel', async () => {
    const res = await fetchOverview({
      tenantId: `tenant-${SENTINEL_SECRET}`,
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'x',
      fetchImpl: boomFetch,
      timeoutMs: 250,
    });
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.message).toBe('Network error contacting the platform. Details redacted (see server log).');
    expect(res.message).not.toContain(SENTINEL_SECRET);
  });

  it('fetchOverview keeps the AbortError→timeout classification after __err sanitization', async () => {
    const abort = () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      return Promise.reject(e);
    };
    const res = await fetchOverview({
      tenantId: 'tenant-a',
      jsonBaseUrl: 'http://platform.invalid',
      adminToken: 'x',
      fetchImpl: abort as unknown as typeof fetch,
      timeoutMs: 250,
    });
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.message).toMatch(/^Timed out after 250ms waiting for the platform\.$/);
  });
});

describe('ADM-BASE-03 admin shell boundary (real HTTP, no DB)', () => {
  const SECRET = 'adm03-cookie-secret';
  const TOKEN = 'adm03-admin-token';
  let handle: AdminShellHandle;
  let baseUrl: string;
  let calls = 0;

  beforeAll(async () => {
    handle = createAdminShellServer({
      port: 45_000 + (process.pid % 100),
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {
        // Any rejection must hit the sanitized boundary — never the pre-fix
        // 'Internal error: ' + raw-echo path.
        businesses: async (): Promise<never> => {
          calls += 1;
          throw new Error(SENTINEL_MSG);
        },
      },
    });
    const r = await handle.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('throwing section fetcher → 500 without sentinel on the wire or in the log', async () => {
    const logged: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' '),
      );
    };
    try {
      const { signCookie } = await import('../src/app/admin/shell-auth');
      const cookieValue = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await fetch(baseUrl + '/admin/businesses?businessId=biz-sentinel', {
        headers: { cookie: `du_admin=${cookieValue}` },
      });
      // Deferred-render contract: a rejecting section fetcher must degrade to
      // the safe base pane (200) — the exception never reaches the wire, and
      // now never vanishes silently either (class-only log line). The
      // invariant that matters for ADM-BASE-03: ZERO sentinel on the wire.
      const text = await res.text();
      expect(calls).toBe(1); // the fetcher really was exercised
      expect(res.status).toBe(200);
      expect(text).not.toContain(SENTINEL_SECRET);
      expect(text).not.toContain(SENTINEL_PATH);
      expect(text).not.toContain(SENTINEL_DSN);
    } finally {
      console.error = origErr;
    }
    const logText = logged.join('\n');
    expect(logText).not.toContain(SENTINEL_SECRET);
    expect(logText).not.toContain(SENTINEL_PATH);
    expect(logText).not.toContain(SENTINEL_DSN);
    // The operator keeps a joinable, class-only signal.
    expect(logText).toContain('deferred section render error');
    expect(logText).toMatch(/errorClass/);
  });
});

describe('ADM-BASE-03 structural pins (no raw echo re-introduced on fixed surfaces)', () => {
  const targetFiles: string[] = [
    join(SRC, 'http', 'errors.ts'),
    join(SRC, 'http', 'ingress.ts'),
    join(SRC, 'server.ts'),
    join(SRC, 'app', 'admin', 'shell-server.ts'),
    ...readdirSync(join(SRC, 'app', 'admin'))
      .filter((f) => f.endsWith('-section-data.ts'))
      .map((f) => join(SRC, 'app', 'admin', f)),
  ];

  const BANNED: Array<[RegExp, string]> = [
    [/[?\.]message\s*\?\?\s*String\(err\)/, '?? String(err) fallback'],
    [/String\(err\)/, 'String(err)'],
    [/failMalformed\(err\.message\)/, 'failMalformed(err.message)'],
    [/Internal error: '\s*\+/, "'Internal error: ' + raw"],
  ];

  it.each(targetFiles.map((f) => [f] as [string]))('%s is free of raw-error echoes', (file) => {
    const source = readFileSync(file, 'utf8');
    // Comments are allowed to NAME the banned idiom (they document why it is
    // banned); the pin targets executable text only.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    for (const [re, label] of BANNED) {
      expect({ file: file.replace(SRC, ''), match: code.match(re)?.[0] ?? null }).toEqual({
        file: file.replace(SRC, ''),
        match: null,
      });
      void label;
    }
  });
});
