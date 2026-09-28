/**
 * W46-C2 (2): error-boundary sentinel test (closes the CX3 W43-R13 High
 * security carry-forward as a live assertion). Injects a DB rejection whose
 * message carries a sentinel secret, calls an authenticated Admin GET, and
 * asserts: status 500, `application/problem+json` media type, NO sentinel on
 * the wire, and NO sentinel in the structured log (the boundary logs the
 * error CLASS only via `errorNameOf`).
 *
 * Needs real PG :5433 + Redis :6380 for boot, but the rejection is injected
 * by monkey-patching `app.db.query` AFTER boot — no schema damage, restored
 * in `finally`. Same window discipline as the other live suites (RUN REQUEST
 * to the testing lane; this lane never self-runs).
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { redactString } from '@du/observability';
import { createApp, type App } from '../src/server';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const ADMIN_TOKEN = 'err-boundary-token-' + randomUUID();
const RUNTIME_TOKEN = 'err-boundary-rt-' + randomUUID();
// Sentinel shaped like a secret-bearing driver string (internal host:port + SQL
// fragment). Must NEVER appear on the wire or in the log.
// CYCLE-100 REDACTOR-SYNC: the original shape (SENTINEL-SECRET-sk-live-…://…) is now
// ITSELF redacted by @du/observability's widened provider-key patterns (sk-[A-Za-z0-9_-]{8,},
// added 2026-09-25 08:06 with LOG-01) — not.toContain(SENTINEL) would have passed even for a
// real leak (vacuous green). This replacement keeps the same semantic density while staying
// invisible to every pattern (no sk-/sk_ prefix, no whitelisted :// scheme, no key=value);
// the self-check below makes any future re-collision fail LOUD instead of silently.
const SENTINEL = 'SENTINEL-DBURL-9f8e7d6c5b4a@db.internal:5432/prod SELECT * FROM tenants';

// WINDOW GUARD (cycle 103, mirrors qwen3's webhook-reclaim-fence pattern):
// this suite boots the REAL app against PG :5433 / Redis :6380 and must
// NEVER do so outside a claimed DB window. beforeAll/afterAll live INSIDE
// the gated describe on purpose — a top-level hook runs even when every
// test skips, which is exactly how this file leaked onto the live database
// under a plain `pnpm test` (self-reported slip, qwen2.md §43; now sealed).
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;

let app: App;
let baseUrl: string;

liveDescribe('W46-C2: admin error boundary (sentinel non-leak)', () => {
  beforeAll(async () => {
    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken: ADMIN_TOKEN,
      runtimeToken: RUNTIME_TOKEN,
      autoDispatch: false,
      autoMigrate: true,
    });
    const srv = await app.listen();
    const addr = srv.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 60000);

  afterAll(async () => {
    if (app) await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
  }, 60000);

  it('DB rejection with sentinel secret → 500 problem+json, no sentinel on wire or log', async () => {
    // Anti-vacuous-green preflight (cycle 100): the sentinel must survive the redactor
    // verbatim, and the redactor must demonstrably be LIVE — otherwise the not.toContain
    // asserts below measure nothing.
    expect(redactString(SENTINEL)).toBe(SENTINEL);
    expect(redactString('Authorization: Bearer abc123')).toMatch(/\[REDACTED/);
    const logged: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const spy = (chunk: unknown, ...rest: unknown[]): boolean => {
      logged.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stdout.write = spy as typeof process.stdout.write;

    const origQuery = app.db.query.bind(app.db);
    app.db.query = (() => Promise.reject(new Error(`pg driver failure: ${SENTINEL}`))) as typeof app.db.query;
    try {
      const res = await fetch(`${baseUrl}/api/v1/admin/businesses`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const text = await res.text();
      expect(text).not.toContain(SENTINEL);
      expect(text).toContain('TEMPORARY_UNAVAILABLE');
      // correlationId present so the operator can join wire → redacted log.
      expect(text).toContain('correlationId');
    } finally {
      app.db.query = origQuery;
      process.stdout.write = origWrite;
    }
    const logText = logged.join('\n');
    expect(logText).not.toContain(SENTINEL);
  });
});
