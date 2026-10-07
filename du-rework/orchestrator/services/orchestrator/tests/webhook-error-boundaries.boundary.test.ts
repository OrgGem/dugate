/**
 * R1-C "Network & Secret boundaries" — webhook error-boundary suite (BR-Q3-01 grant).
 *
 * Review rows pinned:
 *   FIX-CR-01 / FR24-09  webhook destination policy must adjudicate BEFORE dispatch and a
 *                        delivery whose budget is exhausted must land in FAILED (never PENDING);
 *   ADM-BASE-03          webhook `last_error` must not echo raw transport/driver error text;
 *   FR24-07              submission `callback.url` schema must reject hostile destinations
 *                        before enqueue (contracts-level, pre-dispatch).
 * Plan §W49-Q3-2.
 *
 * Offline by construction: no PostgreSQL :5433, no Redis :6380, no DNS, no outbound socket, and
 * `globalThis.fetch` is never monkeypatched. The webhook cases never touch pg at all (a scripted
 * in-file Db stands in); the STRETCH twin boots the real app against a scripted `pg` pool
 * (jest.mock) and a closed loopback redis URL. Every outbound attempt is routed
 * through the injectable `WebhookDispatcherOptions.fetchFn` seam
 * (src/modules/webhooks/webhooks.ts:126) using the R1-C recording transport, whose default
 * behavior throws `RecordingNotConnectedError` instead of connecting.
 *
 * Companion (live twin, needs the DB window): services/orchestrator/tests/admin-error-boundary.test.ts
 * Offline-twin naming/format exemplar: tests/r24-01-poll-fence-offline.functional.test.ts
 *
 * Run:
 *   pnpm --dir services/orchestrator exec jest tests/webhook-error-boundaries.boundary.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server';
import {
  deliverWebhooks,
  signWebhookBody,
  verifyWebhookSignature,
  type DbClient,
} from '../src/modules/webhooks/webhooks';
import {
  CallbackConfigSchema,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  problem,
  type WebhookPayload,
} from '@du/contracts';
import { redactString } from '@du/observability';
import {
  mkAdminShapeSentinel,
  mkSentinel,
  sentinelShapeViolations,
} from '../../../../tests/harness/network-boundaries/sentinels';
import { scanForSentinels } from '../../../../tests/harness/network-boundaries/sink-scan';
import { makeWebhookFetchFn } from '../../../../tests/harness/network-boundaries/recording-transport';
import { DENY_VECTORS } from '../../../../tests/harness/network-boundaries/policy-vectors';
import { assertProblemEnvelope } from '../../../../tests/harness/network-boundaries/error-envelope';
import { installRejectionGuard, type RejectionGuard } from '../../../../tests/harness/network-boundaries/unhandled-guard';

const QUIET_BOUNDARY_PORT_BASE = 45_200 + (process.pid % 10) * 16;
let boundaryPortOffset = 0;

function startBoundaryListener(): Promise<BoundaryListener> {
  return BoundaryListener.start(QUIET_BOUNDARY_PORT_BASE + boundaryPortOffset++);
}

const SECRET = 'whsec-' + randomUUID();
/** TEST-NET-1 documentation control: routable-looking, never connected to. */
const ALLOWED_URL = 'http://192.0.2.10:8080/hook';
const FIXED_NOW = (): Date => new Date(Date.UTC(2026, 8, 25, 12, 0, 0));

/* ------------------------------------------------------------------ */
/* Scripted webhook DB (no pg, no socket)                              */
/* ------------------------------------------------------------------ */

interface SeedDelivery {
  delivery_id: string;
  destination_url: string;
  payload: WebhookPayload;
  attempts: number;
  max_attempts: number;
}

interface CapturedRow {
  status: string;
  attempts: number;
  lastError: unknown;
}

function payloadFor(deliveryId: string): WebhookPayload {
  return {
    deliveryId,
    eventType: 'operation.succeeded',
    operationId: randomUUID(),
    state: 'SUCCEEDED',
    stateVersion: 1,
    occurredAt: FIXED_NOW().toISOString(),
  };
}

function seed(over: Partial<SeedDelivery> & { destination_url: string }): SeedDelivery {
  const deliveryId = over.delivery_id ?? randomUUID();
  return {
    delivery_id: deliveryId,
    destination_url: over.destination_url,
    payload: over.payload ?? payloadFor(deliveryId),
    attempts: over.attempts ?? 0,
    max_attempts: over.max_attempts ?? 2,
  };
}

interface ScriptedDb {
  readonly db: {
    query: DbClient['query'];
    tx: <T>(fn: (client: DbClient) => Promise<T>) => Promise<T>;
  };
  readonly captured: Map<string, CapturedRow>;
  /** Every parameter the dispatcher handed to any UPDATE (the ADM-BASE-03 sink). */
  readonly allParams: unknown[];
  row(index: number): CapturedRow;
}

function makeScriptedWebhookDb(seeds: readonly SeedDelivery[]): ScriptedDb & {
  events: string[];
  openTx: { current: number; maxDuringFetch: number };
  meta: { selectSql: string };
  leaseTokens: Map<string, string>;
  forceStatus(deliveryId: string, status: string): void;
} {
  const captured = new Map<string, CapturedRow>();
  const allParams: unknown[] = [];
  const events: string[] = [];
  const openTx = { current: 0, maxDuringFetch: 0 };
  const meta = { selectSql: '' };
  let leaseCounter = 0;
  const leaseTokens = new Map<string, string>();

  const query: DbClient['query'] = async (
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> => {
    for (const p of params) allParams.push(p);

    if (/^\s*SELECT/i.test(sql) && /webhook_deliveries/i.test(sql)) {
      events.push('SELECT');
      meta.selectSql = sql;
      return {
        rows: seeds.map((s) => ({ ...s }) as unknown as Record<string, unknown>),
        rowCount: seeds.length,
      };
    }

    if (/^\s*UPDATE webhook_deliveries/i.test(sql)) {
      const deliveryId = String(params[0]);
      const base = seeds.find((s) => s.delivery_id === deliveryId);
      const prior =
        captured.get(deliveryId) ?? { status: 'PENDING', attempts: base ? base.attempts : 0, lastError: null };

      // phase-1 CLAIM: flips to DISPATCHING and RETURNING next_at yields the claim
      // GENERATION TOKEN (cycle-95 fence). Each claim gets a strictly newer token,
      // mirroring how every real re-claim writes a fresh now()+lease value.
      if (/SET status='DISPATCHING'/.test(sql)) {
        if (!/RETURNING next_at/i.test(sql)) throw new Error('claim UPDATE must RETURNING next_at (ownership fence)');
        events.push('CLAIM:' + deliveryId);
        leaseCounter++;
        const token = 'LEASE-' + leaseCounter;
        leaseTokens.set(deliveryId, token);
        captured.set(deliveryId, { status: 'DISPATCHING', attempts: prior.attempts, lastError: prior.lastError });
        return { rows: [{ next_at: token }], rowCount: 1 };
      }

      // Release statements carry TWO guards: status='DISPATCHING' AND next_at=$2.
      const guarded = /AND status='DISPATCHING'/.test(sql);
      const fenced = /AND next_at=\$2/.test(sql);
      if (guarded && prior.status !== 'DISPATCHING') {
        events.push('STALE-LOST:' + deliveryId);
        return { rows: [], rowCount: 0 };
      }
      if (guarded && fenced) {
        const token = String(params[1]);
        if (leaseTokens.get(deliveryId) !== token) {
          events.push('STALE-FENCE:' + deliveryId);
          return { rows: [], rowCount: 0 };
        }
      }
      if (/status='DELIVERED'/.test(sql)) {
        events.push('RELEASE:DELIVERED:' + deliveryId);
        captured.set(deliveryId, { status: 'DELIVERED', attempts: prior.attempts + 1, lastError: prior.lastError });
      } else if (/status='FAILED'/.test(sql)) {
        events.push('RELEASE:FAILED:' + deliveryId);
        captured.set(deliveryId, { status: 'FAILED', attempts: Number(params[2]), lastError: params[3] });
      } else if (/SET status='PENDING', last_error=\$3/.test(sql)) {
        // P8-04 shutdown release: budget UNTOUCHED, last_error is the fixed code, params [id, token, code].
        events.push('RELEASE:SHUTDOWN:' + deliveryId);
        captured.set(deliveryId, { status: 'PENDING', attempts: prior.attempts, lastError: params[2] });
      } else {
        events.push('RELEASE:RETRY:' + deliveryId);
        captured.set(deliveryId, {
          status: /status='PENDING'/.test(sql) ? 'PENDING' : prior.status,
          attempts: Number(params[2]),
          lastError: params[3],
        });
      }
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  const client: DbClient = { query };
  return {
    events,
    openTx,
    meta,
    leaseTokens,
    forceStatus(deliveryId: string, status: string): void {
      const prior = captured.get(deliveryId) ?? { status: 'PENDING', attempts: 0, lastError: null };
      captured.set(deliveryId, { ...prior, status });
    },
    db: {
      query,
      tx: async <T>(fn: (c: DbClient) => Promise<T>): Promise<T> => {
        openTx.current++;
        try {
          return await fn(client);
        } finally {
          openTx.current--;
        }
      },
    },
    captured,
    allParams,
    row(index: number): CapturedRow {
      const deliveryId = (seeds[index] as SeedDelivery).delivery_id;
      const hit = captured.get(deliveryId);
      if (!hit) throw new Error(`no UPDATE captured for delivery ${deliveryId}`);
      return hit;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Deny vectors (subset of the canonical kit table, expect === DENY)   */
/* ------------------------------------------------------------------ */

const DENY_TARGETS: readonly { readonly host: string; readonly url: string }[] = [
  { host: '127.0.0.1', url: 'http://127.0.0.1:8080/hook' },
  { host: '::1', url: 'http://[::1]:8080/hook' },
  { host: '::ffff:127.0.0.1', url: 'http://[::ffff:127.0.0.1]:8080/hook' },
  { host: '169.254.169.254', url: 'http://169.254.169.254:8080/hook' },
  { host: 'fd12:3456::1', url: 'http://[fd12:3456::1]:8080/hook' },
  { host: '100.64.1.1', url: 'http://100.64.1.1:8080/hook' },
];

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

let guard: RejectionGuard;

beforeAll(() => {
  guard = installRejectionGuard();
});

afterAll(() => {
  guard.assertClean('webhook-error-boundaries');
  guard.restore();
});

describe('R1-C webhook error boundaries (BR-Q3-01, offline)', () => {
  it('[LOCK] webhook sign+deliver happy path via injected fetchFn (192.0.2.10)', async () => {
    const s = seed({ destination_url: ALLOWED_URL, attempts: 0, max_attempts: 2 });
    const scripted = makeScriptedWebhookDb([s]);
    const { fetchFn, calls } = makeWebhookFetchFn((): { status: number } => ({ status: 200 }));

    const attempted = await deliverWebhooks(scripted.db, {
      secret: SECRET,
      fetchFn,
      now: FIXED_NOW,
      baseBackoffMs: 1000,
    });

    expect(attempted).toBe(1);
    expect(calls.length).toBe(1);

    const call = calls[0];
    if (!call) throw new Error('recording transport captured no call');
    expect(call.url).toBe(ALLOWED_URL);
    expect(call.method).toBe('POST');
    const sigHeader = call.headers[WEBHOOK_SIGNATURE_HEADER];
    const tsHeader = call.headers[WEBHOOK_TIMESTAMP_HEADER];
    expect(typeof sigHeader).toBe('string');
    expect(typeof tsHeader).toBe('string');
    if (sigHeader === undefined || tsHeader === undefined) {
      throw new Error('dispatcher omitted the signature/timestamp headers');
    }
    expect(call.headers[WEBHOOK_DELIVERY_HEADER]).toBe(s.delivery_id);
    expect(sigHeader.startsWith('sha256=')).toBe(true);
    expect(signWebhookBody(SECRET, tsHeader, call.body)).toBe(sigHeader);
    // NB: the ORCHESTRATOR verifier (webhooks.ts:107-115) compares against signWebhookBody's
    // output, i.e. the full canonical wire value `sha256=<hex>`; the bare-hex form
    // sigHeader.slice('sha256='.length) returns false here, unlike services/connector's tolerant
    // verifyWebhookSignature (connector/src/webhook.ts:31-41), which strips the prefix. The
    // existing pin agrees: services/orchestrator/tests/runtime.test.ts:2887,2915 pass the header
    // value verbatim. So the header value — not the stripped hex — is the verifier's input.
    expect(verifyWebhookSignature(SECRET, tsHeader, call.body, sigHeader)).toBe(true);
    // Tamper check: the signature is bound to the body, not a constant token.
    expect(verifyWebhookSignature(SECRET, tsHeader, call.body + ' ', sigHeader)).toBe(false);

    const row = scripted.row(0);
    expect(row.status).toBe('DELIVERED');
    expect(row.attempts).toBe(s.attempts + 1);
  });

  // FIX-CR-01: the destination policy must adjudicate BEFORE the dispatcher is reached and must
  // persist a fixed reason code — never the transport error string. Both RED today:
  // deliverWebhooks has no destination policy at all (webhooks.ts:170-196 goes straight to fetchFn
  // and funnels String(err) into last_error at :195).
  for (const target of DENY_TARGETS) {
    it(`[LOCK:FIX-CR-01 webhook-destination-policy] ${target.host} → denied before dispatch`, async () => {
      // Sanity: the vector really is a canonical DENY row of the kit table.
      expect(DENY_VECTORS.find((v) => v.input === target.host)?.expect).toBe('DENY');

      const s = seed({ destination_url: target.url, attempts: 1, max_attempts: 2 });
      const scripted = makeScriptedWebhookDb([s]);
      // Fresh dispatcher per vector; NO behavior ⇒ the default throws RecordingNotConnectedError,
      // so a non-zero call count proves a connect attempt escaped the seam.
      const { fetchFn, calls } = makeWebhookFetchFn();

      await deliverWebhooks(scripted.db, { secret: SECRET, fetchFn, now: FIXED_NOW });

      // Both halves of FIX-CR-01 are collected so one run reports each independently instead of
      // the first mismatch hiding the second.
      const mismatches: string[] = [];
      if (calls.length !== 0) {
        mismatches.push(
          'dispatch reached the transport seam: calls.length=' +
          calls.length +
          ' (expected 0; the destination policy must adjudicate before dispatch)'
        );
      }
      const row = scripted.row(0);
      if (row.status !== 'FAILED') mismatches.push('row status=' + row.status + ', expected FAILED');
      if (row.lastError !== 'DESTINATION_DENIED') {
        // Today last_error carries String(err) of whatever the transport threw (webhooks.ts:195),
        // i.e. the harness's own RecordingNotConnectedError text, not a fixed reason code.
        mismatches.push(
          'last_error=' + JSON.stringify(row.lastError) + ", expected 'DESTINATION_DENIED'"
        );
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('[LOCK] FAILED-status bookkeeping: exhausted budget never leaves the row PENDING', async () => {
    // Two error shapes (non-2xx response and a thrown transport error): whatever the error text
    // ends up being, the row must transition out of PENDING once attempts reach max.
    const httpFail = seed({ destination_url: ALLOWED_URL, attempts: 1, max_attempts: 2 });
    const scriptedA = makeScriptedWebhookDb([httpFail]);
    const a = makeWebhookFetchFn((): { status: number } => ({ status: 500 }));
    await deliverWebhooks(scriptedA.db, { secret: SECRET, fetchFn: a.fetchFn, now: FIXED_NOW });
    const rowA = scriptedA.row(0);
    expect(rowA.status).toBe('FAILED');
    expect(rowA.attempts).toBe(2);

    const throwFail = seed({ destination_url: ALLOWED_URL, attempts: 1, max_attempts: 2 });
    const scriptedB = makeScriptedWebhookDb([throwFail]);
    const b = makeWebhookFetchFn((): { status: number } => {
      throw new Error('socket hang up');
    });
    await deliverWebhooks(scriptedB.db, { secret: SECRET, fetchFn: b.fetchFn, now: FIXED_NOW });
    const rowB = scriptedB.row(0);
    expect(rowB.status).toBe('FAILED');
    expect(rowB.attempts).toBe(2);
  });

  it('[LOCK:ADM-BASE-03 last_error-no-raw-echo] transport error text must not reach last_error', async () => {
    const sentinel = mkSentinel('hookerr');
    const s = seed({ destination_url: ALLOWED_URL, attempts: 1, max_attempts: 2 });
    const scripted = makeScriptedWebhookDb([s]);
    const { fetchFn } = makeWebhookFetchFn((): { status: number } => {
      throw new Error(`undici dispatch failure ${sentinel}`);
    });

    await deliverWebhooks(scripted.db, { secret: SECRET, fetchFn, now: FIXED_NOW });

    // Sink = every parameter of every UPDATE the dispatcher issued (webhooks.ts:195 does
    // `errMsg = String(err)` and writes it into last_error). RED today.
    expect(scanForSentinels(scripted.allParams, [sentinel])).toEqual([]);
  });

  const HOSTILE_CALLBACK_URLS: readonly string[] = [
    'file:///etc/passwd',
    'http://2130706433',
    'http://127.1',
    'http://0177.0.0.1',
    'http://127.0.0.1.',
    'HTTP://127.0.0.1',
    'http://user:pass@169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
  ];

  const HOSTILE_VECTORS: readonly { url: string }[] = HOSTILE_CALLBACK_URLS.map((url) => ({ url }));

  // FR24-07: CallbackConfigSchema is z.object({ url: z.string().url() })
  // (packages/contracts/src/operations.ts:199-202), which accepts every one of these, so a
  // hostile destination is enqueued and later dialed by the webhook dispatcher. The assertion is
  // kept for every vector even where a stricter parse would already reject (measurement).
  it.each(HOSTILE_VECTORS)(
    '[LOCK:FIX-CR-01 callback-schema-accepts-hostile-url $url',
    (vector: { url: string }) => {
      // Object-table form: a 1-column string table would spread the row into positional args
      // and the destructured param would receive a single character, making the assertion vacuous.
      expect(CallbackConfigSchema.safeParse({ url: vector.url }).success).toBe(false);
    }
  );

  it('[LOCK] callback-schema control: https://hooks.example.com/cb parses', () => {
    expect(CallbackConfigSchema.safeParse({ url: 'https://hooks.example.com/cb' }).success).toBe(true);
  });

  it('[LOCK] sentinel redactor-invisibility self-check', () => {
    expect(sentinelShapeViolations(mkSentinel('hook'), redactString)).toEqual([]);
    expect(sentinelShapeViolations(mkAdminShapeSentinel(), redactString)).toEqual([]);
    // Negative control: the redactor IS live, so the non-leak greens are not tautologies
    // produced by an inert sanitizer.
    // Pattern-tagged redaction (observability LOG-01 widening, 08:06) emits
    // '[REDACTED:bearer]' — accept any [REDACTED...] marker, the point is the
    // secret text is REPLACED, proving the sanitizer is live.
    expect(redactString('Authorization: Bearer abc123')).toMatch(/\[REDACTED/);
  });

  it('[LOCK] error-envelope validator agrees with contracts problem()', () => {
    const envelope = problem(500, 'TEMPORARY_UNAVAILABLE', 'Internal error', 'detail', {
      correlationId: 'corr-00000001',
    });
    // problem() always sets the full key set, including `errors: undefined`
    // (packages/contracts/src/errors.ts:106-114). The boundary emits the serialized wire form,
    // where JSON.stringify drops undefined-valued keys, so the validator is applied to that
    // shape. The raw-object divergence is reported as a kit/contracts note.
    const wire = JSON.parse(JSON.stringify(envelope) as string) as unknown;
    assertProblemEnvelope(wire, {
      status: 500,
      code: 'TEMPORARY_UNAVAILABLE',
      requireCorrelationId: true,
    });
    expect(() =>
      assertProblemEnvelope({ stack: 'at SecretLeak(/path:1:1)', ...(envelope as object) }, { status: 500 })
    ).toThrow(/stack/);
  });

  it('[LOCK] C-neg distinguishing legitimate identifiers', () => {
    const sentinel = mkSentinel('hook');
    const operationId = randomUUID();
    const legitProblem = JSON.parse(
      JSON.stringify(
        problem(422, 'INVALID_SCHEMA', 'request validation failed', 'input/fileName must be unicode', {
          correlationId: 'corr-00000007',
          errors: [{ pointer: '/input/fileName', message: 'unsupported extension' }],
        })
      ) as string
    ) as unknown;
    const legitLogLine =
      `{"level":30,"component":"orchestrator","operationId":"${operationId}","fileName":"quarterly-report-${sentinel.length}-2026.xlsx","correlationId":"corr-00000007","webhookDeliveryId":"${randomUUID()}"}`;
    expect(scanForSentinels([legitProblem, legitLogLine], [sentinel])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* STRETCH: DB-free offline twin of tests/admin-error-boundary.test.ts */
/* ------------------------------------------------------------------ */

/**
 * C-lock-1 / C-lock-2 (ADM-BASE-03 error boundary) with NO PostgreSQL :5433 and NO Redis :6380.
 *
 * Why the driver itself has to be scripted: createApp() exposes no db/redis injection seam — it
 * builds its own Db through createDb(config.databaseUrl) (src/server.ts:122, which runs
 * 'new Pool({ connectionString, max: 10 })' at src/db/db.ts:20) and its own client via
 * 'new IORedis(config.redisUrl, { maxRetriesPerRequest: null })' (src/server.ts:123), both
 * eagerly and before verifyMigrations()/migrate() plus the two seed INSERTs (src/server.ts:126-146).
 * The pool below therefore answers the boot shapes src/db/migrations.ts issues (CREATE TABLE IF NOT
 * EXISTS schema_migrations, SELECT sequence FROM schema_migrations, INSERT INTO schema_migrations)
 * and the seed INSERTs, and answers the admin SELECT with the sentinel-bearing rejection that the
 * live twin injects by monkey-patching app.db.query.
 *
 * Redis: server.ts attaches NO 'error' listener to that client (src/http/ingress.ts is the only
 * on('error') in src/), but ioredis surfaces connection errors through silentEmit(), which does
 * not throw when no listener is attached — so redis://127.0.0.1:1 (a closed loopback port; nothing
 * is ever dialed, the URL only has to parse) is survivable.
 *
 * Still loopback-only: the one socket this twin opens is the HTTP request to the app process itself
 * on 127.0.0.1. globalThis.fetch is never patched.
 */
interface MockPgModule {
  readonly __duState: {
    injectMessage: string | null;
    /** PR-Q3-10: every SQL string the scripted pool answered, in order. */
    queries: string[];
    /** When set, SELECT ... FOR UPDATE SKIP LOCKED returns exactly these delivery rows. */
    webhookRows: unknown[] | null;
    leaseSeq: number;
  };
}

jest.mock('pg', () => {
  const state = {
    injectMessage: null as string | null,
    queries: [] as string[],
    webhookRows: null as unknown[] | null,
    leaseSeq: 0,
  };
  class ScriptedPool {
    async query(sql: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
      state.queries.push(sql);
      if (state.injectMessage) throw new Error(state.injectMessage);
      if (/FROM webhook_deliveries/i.test(sql) && /FOR UPDATE SKIP LOCKED/i.test(sql)) {
        const rows = state.webhookRows ? state.webhookRows.map((r) => ({ ...(r as Record<string, unknown>) })) : [];
        return { rows, rowCount: rows.length };
      }
      if (/RETURNING next_at/i.test(sql)) {
        state.leaseSeq++;
        return { rows: [{ next_at: 'TWIN-LEASE-' + state.leaseSeq }], rowCount: 1 };
      }
      if (/^UPDATE webhook_deliveries/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    async connect(): Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }> {
      const pool = this;
      return { query: (sql: string, params?: unknown[]) => pool.query(sql, params), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

const TWIN_ADMIN_TOKEN = 'offline-twin-admin-' + randomUUID();
const TWIN_RUNTIME_TOKEN = 'offline-twin-rt-' + randomUUID();

describe('STRETCH: ADM-BASE-03 error boundary - DB-free offline twin (C-lock-1/2)', () => {
  let app: App;
  let baseUrl = '';
  // PM-M02-ROUTE: runtime/admin fixtures target the internal listener.
  let internalBaseUrl = '';
  const twinSentinel = mkAdminShapeSentinel();

  beforeAll(async () => {
    app = await createApp({
      port: 0,
      internalPort: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_twin',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: TWIN_ADMIN_TOKEN,
      runtimeToken: TWIN_RUNTIME_TOKEN,
      autoDispatch: false,
      autoMigrate: true,
      leaseRecoveryIntervalMs: 0,
      webhookDispatchIntervalMs: 0,
    });
    const srv = await app.listen();
    const addr = srv.address() as AddressInfo;
    baseUrl = 'http://127.0.0.1:' + addr.port;
    // PM-M02-ROUTE: runtime/admin fixtures must target the INTERNAL listener.
    const internalAddr = app.internalServer?.address() as AddressInfo | null;
    internalBaseUrl = internalAddr ? 'http://127.0.0.1:' + internalAddr.port : baseUrl;
  }, 60000);

  afterAll(async () => {
    if (app) await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
  }, 60000);

  it('pg rejection carrying a sentinel -> 500 problem+json, sentinel absent from wire AND log', async () => {
    const logged: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const spy = (chunk: unknown, ...rest: unknown[]): boolean => {
      logged.push(String(chunk));
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stdout.write = spy as typeof process.stdout.write;
    const pgMock = (jest.requireMock('pg') as unknown) as MockPgModule;
    pgMock.__duState.injectMessage = 'pg driver failure: ' + twinSentinel;
    let status = 0;
    let contentType = '';
    let bodyText = '';
    try {
      // node:http with agent:false instead of global fetch: undici keeps a keep-alive socket
      // pool open after the response, which is enough to make jest print "Jest did not exit"
      // for this suite. One-shot socket, closed with the response.
      const got = await new Promise<{ status: number; contentType: string; body: string }>(
        (resolve, reject) => {
          const req = httpRequest(
            internalBaseUrl + '/api/v1/admin/businesses',
            { agent: false, headers: { authorization: 'Bearer ' + TWIN_ADMIN_TOKEN } },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => {
                text += chunk;
              });
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  contentType: String(res.headers['content-type'] ?? ''),
                  body: text,
                })
              );
            }
          );
          req.on('error', reject);
          req.end();
        }
      );
      status = got.status;
      contentType = got.contentType;
      bodyText = got.body;
    } finally {
      pgMock.__duState.injectMessage = null;
      process.stdout.write = origWrite;
    }

    expect(status).toBe(500);
    expect(contentType).toContain('application/problem+json');
    const parsed = JSON.parse(bodyText) as unknown;
    // Sink 1: the wire. Sink 2: the structured log (server.ts:307 logs errorName only).
    expect(scanForSentinels([parsed, bodyText], [twinSentinel])).toEqual([]);
    expect(scanForSentinels(logged.join('\n'), [twinSentinel])).toEqual([]);
    // The boundary envelope really is a contracts-shaped problem(): the kit validator agrees.
    assertProblemEnvelope(parsed, {
      status: 500,
      code: 'TEMPORARY_UNAVAILABLE',
      requireCorrelationId: true,
    });
    expect(bodyText).toContain('TEMPORARY_UNAVAILABLE');
    expect(logged.join('\n')).toContain('unhandled request error');
  });
});

describe('R1-C turn 3 - FIX-CR-02 durable claim before dispatch HTTP', () => {
  test('[LOCK] claim COMMITs before fetch; final release lands in a later tx', async () => {
    const scripted = makeScriptedWebhookDb([seed({ destination_url: 'http://192.0.2.10:8080/hook', max_attempts: 2 })]);
    let fetchSawOpenTx = -1;
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      fetchFn: async () => {
        fetchSawOpenTx = scripted.openTx.current; // must be OUTSIDE the claim transaction
        return { status: 200 };
      },
    });
    expect(fetchSawOpenTx).toBe(0);
    expect(scripted.events[0]).toBe('SELECT');
    expect(String(scripted.events[1]).indexOf('CLAIM:')).toBe(0);
    expect(String(scripted.events[2]).indexOf('RELEASE:DELIVERED:')).toBe(0);
    expect(scripted.events[1]).toBe(String(scripted.events[2]).replace('RELEASE:DELIVERED:', 'CLAIM:'));
    expect(scripted.row(0).status).toBe('DELIVERED');
  });

  test('[LOCK] SELECT re-claims expired DISPATCHING leases (crash recovery)', async () => {
    const scripted = makeScriptedWebhookDb([seed({ destination_url: 'http://192.0.2.11:8080/hook' })]);
    await deliverWebhooks(scripted.db, { secret: SECRET, now: FIXED_NOW, fetchFn: async () => ({ status: 200 }) });
    expect(scripted.meta.selectSql).toContain("status='DISPATCHING' AND next_at <= now()");
    expect(scripted.meta.selectSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  test('[LOCK] stale claimant loses the guarded release and never clobbers the rival', async () => {
    const seedRow = seed({ destination_url: 'http://192.0.2.13:8080/hook', max_attempts: 2 });
    const scripted = makeScriptedWebhookDb([seedRow]);
    await deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      fetchFn: async () => {
        scripted.forceStatus(seedRow.delivery_id, 'DELIVERED'); // rival re-claimed and won mid-flight
        return { status: 500 }; // our FAILED release must lose the guarded write
      },
    });
    expect(scripted.events).toContain('STALE-LOST:' + seedRow.delivery_id);
    expect(scripted.row(0).status).toBe('DELIVERED');
  });

  test('[LOCK] stalled A -> B reclaim -> A stale release rejected by next_at generation fence', async () => {
    const seedRow = seed({ destination_url: 'http://192.0.2.30:8080/hook', max_attempts: 5 });
    const scripted = makeScriptedWebhookDb([seedRow]);
    const waitClaim = async (want: number) => {
      for (let waited = 0; scripted.events.filter((ev) => ev.startsWith('CLAIM:')).length < want && waited < 2000; waited += 20) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(scripted.events.filter((ev) => ev.startsWith('CLAIM:')).length).toBe(want);
    };
    let gateA: (v: { status: number }) => void = () => undefined;
    const fetchA = new Promise<{ status: number }>((resolve) => { gateA = resolve; });
    const sweepA = deliverWebhooks(scripted.db, { secret: SECRET, now: FIXED_NOW, fetchFn: () => fetchA });
    await waitClaim(1);
    expect(scripted.leaseTokens.get(seedRow.delivery_id)).toBe('LEASE-1');

    // Sweep B re-claims (lease modeled expired) AND ALSO stalls — B holds the newer claim.
    let gateB: (v: { status: number }) => void = () => undefined;
    const fetchB = new Promise<{ status: number }>((resolve) => { gateB = resolve; });
    const sweepB = deliverWebhooks(scripted.db, { secret: SECRET, now: FIXED_NOW, fetchFn: () => fetchB });
    await waitClaim(2);
    expect(scripted.leaseTokens.get(seedRow.delivery_id)).toBe('LEASE-2');

    // A wakes up FAILED and releases with its STALE token while B's DISPATCHING stands:
    // status guard ALONE would let this clobber — only the generation fence can stop it.
    gateA({ status: 500 });
    const attemptedA = await sweepA;
    expect(attemptedA).toBe(1);
    expect(scripted.events).toContain('STALE-FENCE:' + seedRow.delivery_id);

    // B releases its own claim normally.
    gateB({ status: 200 });
    const attemptedB = await sweepB;
    expect(attemptedB).toBe(1);
    expect(scripted.events).toContain('RELEASE:DELIVERED:' + seedRow.delivery_id);
    // No clobber anywhere: B's DELIVERED outcome, single attempt, clean last_error.
    expect(scripted.row(0).status).toBe('DELIVERED');
    expect(scripted.row(0).attempts).toBe(1);
    expect(scripted.row(0).lastError).toBeNull();
  });
});
describe('R1-C cycle 88 - webhook egress pinned via @du/egress (PR-Q3-09)', () => {
  test('[LOCK] default dispatcher fetch serves a loopback listener end-to-end (private opt-in), signed', async () => {
    const listener = await startBoundaryListener();
    try {
      listener.setDefault({ kind: 'respond', status: 202, body: '' });
      const scripted = makeScriptedWebhookDb([seed({ destination_url: 'http://127.0.0.1:' + listener.port + '/hook' })]);
      const attempted = await deliverWebhooks(scripted.db, {
        secret: SECRET,
        now: FIXED_NOW,
        allowPrivateNetworks: true,
      });
      expect(attempted).toBe(1);
      expect(listener.requests).toBe(1);
      const rec = listener.recordedRequests[0];
      expect(rec?.method).toBe('POST');
      const headers = (rec?.headers ?? {}) as Record<string, string>;
      const sig = headers['x-du-signature'];
      expect(String(sig)).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(scripted.row(0).status).toBe('DELIVERED');
    } finally {
      await listener.stop();
    }
  });

  test('[LOCK] ONE resolution per host serves the whole sweep (policy and socket share it)', async () => {
    const listener = await startBoundaryListener();
    try {
      listener.setDefault({ kind: 'respond', status: 200, body: '' });
      let lookupCalls = 0;
      const scripted = makeScriptedWebhookDb([
        seed({ destination_url: 'http://two.name.test:' + listener.port + '/cb-a' }),
        seed({ destination_url: 'http://two.name.test:' + listener.port + '/cb-b' }),
      ]);
      const attempted = await deliverWebhooks(scripted.db, {
        secret: SECRET,
        now: FIXED_NOW,
        allowPrivateNetworks: true,
        lookupFn: async () => {
          lookupCalls++;
          return ['127.0.0.1'];
        },
      });
      expect(attempted).toBe(2);
      expect(listener.requests).toBe(2);
      expect(lookupCalls).toBe(1);
    } finally {
      await listener.stop();
    }
  });
});
describe('P8-04 - webhook graceful shutdown & drain (cycle 97)', () => {
  const waitClaim = async (scripted: { events: string[] }, want: number) => {
    for (let w = 0; w < 2000 && scripted.events.filter((ev) => ev.startsWith('CLAIM:')).length < want; w += 20) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(scripted.events.filter((ev) => ev.startsWith('CLAIM:')).length).toBe(want);
  };

  test('[LOCK] shutdown already signaled -> sweep claims NOTHING (no-new-claims)', async () => {
    const controller = new AbortController();
    controller.abort();
    const scripted = makeScriptedWebhookDb([seed({ destination_url: 'http://192.0.2.40:8080/hook' })]);
    const attempted = await deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      signal: controller.signal,
      fetchFn: async () => ({ status: 200 }),
    });
    expect(attempted).toBe(0);
    expect(scripted.events).toEqual([]); // no SELECT, no CLAIM — rows stay PENDING untouched
  });

  test('[LOCK] in-flight delivery completing WITHIN grace lands normally', async () => {
    const seedRow = seed({ destination_url: 'http://192.0.2.41:8080/hook', max_attempts: 5 });
    const scripted = makeScriptedWebhookDb([seedRow]);
    const controller = new AbortController();
    let resolveFetch: (v: { status: number }) => void = () => undefined;
    const sweep = deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      signal: controller.signal,
      shutdownGraceMs: 5_000,
      fetchFn: () => new Promise<{ status: number }>((r) => { resolveFetch = r; }),
    });
    await waitClaim(scripted, 1);
    controller.abort(); // shutdown begins while the delivery is mid-air
    await new Promise((r) => setTimeout(r, 30));
    resolveFetch({ status: 200 }); // it finishes inside the 5s grace
    const attempted = await sweep;
    expect(attempted).toBe(1);
    expect(scripted.row(0).status).toBe('DELIVERED'); // the drain SAVED the delivery
    expect(scripted.row(0).attempts).toBe(1);
    expect(scripted.row(0).lastError).toBeNull();
  });

  test('[LOCK] grace expiry releases claim to PENDING, budget untouched, row recoverable', async () => {
    const seedRow = seed({ destination_url: 'http://192.0.2.42:8080/hook', max_attempts: 5 });
    const scripted = makeScriptedWebhookDb([seedRow]);
    const controller = new AbortController();
    let releaseGate: (v: { status: number }) => void = () => undefined;
    const sweepA = deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      signal: controller.signal,
      shutdownGraceMs: 150,
      fetchFn: () => new Promise<{ status: number }>((r) => { releaseGate = r; }),
    });
    await waitClaim(scripted, 1);
    controller.abort();
    const t0 = Date.now();
    const attemptedA = await sweepA;
    const waited = Date.now() - t0;
    expect(attemptedA).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(140); // bounded WAIT for the grace, not instant abandon
    expect(waited).toBeLessThan(3_000); // and the wait is BOUNDED
    expect(scripted.events).toContain('RELEASE:SHUTDOWN:' + seedRow.delivery_id);
    expect(scripted.row(0).status).toBe('PENDING');
    expect(scripted.row(0).attempts).toBe(0); // retry budget NOT consumed
    expect(scripted.row(0).lastError).toBe('SHUTDOWN_RELEASED');

    // A late in-flight completion must NOT resurrect DELIVERED over the released row.
    releaseGate({ status: 200 });
    await new Promise((r) => setTimeout(r, 30));
    expect(scripted.row(0).status).toBe('PENDING');

    // The next sweep re-claims and delivers — nothing is left stuck in DISPATCHING.
    const attemptedB = await deliverWebhooks(scripted.db, {
      secret: SECRET,
      now: FIXED_NOW,
      fetchFn: async () => ({ status: 200 }),
    });
    expect(attemptedB).toBe(1);
    expect(scripted.row(0).status).toBe('DELIVERED');
    expect(scripted.row(0).attempts).toBe(1);
  });
});
describe('PR-Q3-10 - server graceful webhook drain (createApp wiring)', () => {
  test('[LOCK] close() drains the in-flight sweep, releases it SHUTDOWN-safe, claims never resume', async () => {
    const pgMock = (jest.requireMock('pg') as unknown) as MockPgModule;
    const __duState = pgMock.__duState;
    const listener = await startBoundaryListener();
    listener.setDefault({ kind: 'hangForever' }); // headers never come — the delivery is genuinely in-flight
    const deliveryId = randomUUID();
    __duState.webhookRows = [{
      delivery_id: deliveryId,
      destination_url: 'http://127.0.0.1:' + listener.port + '/hook',
      payload: { deliveryId, eventType: 'operation.succeeded', operationId: randomUUID(), state: 'SUCCEEDED', stateVersion: 1, occurredAt: FIXED_NOW().toISOString() },
      attempts: 0,
      max_attempts: 5,
    }];
    const twinApp = await createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_drain',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'drain-admin-' + randomUUID(),
      runtimeToken: 'drain-rt-' + randomUUID(),
      autoDispatch: false,
      autoMigrate: true,
      leaseRecoveryIntervalMs: 0,
      webhookSecret: 'whsec-drain-' + randomUUID(),
      webhookDispatchIntervalMs: 40,
      webhookDrainTimeoutMs: 300,
      webhookAllowPrivateNetworks: true, // local listener is the test's delivery target
    });
    try {
      await twinApp.listen();
      for (let w = 0; w < 4000 && !__duState.queries.some((q) => /SET status='DISPATCHING'/.test(q)); w += 20) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(__duState.queries.some((q) => /FROM webhook_deliveries/i.test(q) && /FOR UPDATE SKIP LOCKED/i.test(q))).toBe(true);
      expect(__duState.queries.some((q) => /SET status='DISPATCHING'/.test(q))).toBe(true);
      const selectCountBeforeClose = __duState.queries.filter((q) => /FOR UPDATE SKIP LOCKED/i.test(q)).length;
      // The delivery must ACTUALLY be in-flight before we test the drain — wait for the
      // socket to land (the claim alone does not prove the dispatch started).
      for (let w = 0; w < 3000 && listener.requests < 1; w += 20) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(listener.requests).toBeGreaterThanOrEqual(1);

      const t0 = Date.now();
      await twinApp.close({ timeoutMs: 0, pollIntervalMs: 10 });
      const took = Date.now() - t0;
      expect(took).toBeLessThan(4000); // bounded by grace(300ms)+slack, NOT by the stalled listener

      expect(__duState.queries.some((q) => /SET status='PENDING', last_error=\$3/.test(q))).toBe(true);
      expect(__duState.queries.filter((q) => /SET status='PENDING', last_error=\$3/.test(q)).length).toBe(1); // released exactly once

      __duState.webhookRows = null;
      await new Promise((r) => setTimeout(r, 250)); // > 6 intervals, timer dead + gate closed
      expect(__duState.queries.filter((q) => /FOR UPDATE SKIP LOCKED/i.test(q)).length).toBe(selectCountBeforeClose);
    } finally {
      __duState.webhookRows = null;
      // ALWAYS close the second app: its ioredis reconnect timers are what keep the
      // jest process alive if an assertion throws before the in-body close.
      await twinApp.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
      await listener.stop().catch(() => undefined);
    }
  });
});
