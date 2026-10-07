/**
 * R1-C "Network & Secret boundaries" offline suite - packages/connector-client (BR-Q3-01 grant).
 * Plan: du-rework/coordination/reports/qwen3.md ## W49-Q3-2 (sec.4 B2, sec.5 C2-2/C2-3, sec.6.1
 * rules, sec.6.3 B2-red-a/b + C-red-2, sec.10 delta(5)) and ## W49-Q3-3 sec.0 (grant = NEW test
 * files only; no src/, package.json or jest.config edits).
 *
 * Rows exercised against src/transport.ts (createHttpTransport):
 *  - FIX-CR-08 / WR24-06  the abort scope (timeout timer + chained caller signal) covers ONLY the
 *    headers phase: clearTimeout(timer) and signal?.removeEventListener('abort', onOuterAbort) run
 *    in the finally at :100-101, as soon as fetch resolves headers, while
 *    "const text = await response.text()" (:104) sits outside any abort scope.
 *    => a stalled body defeats timeoutMs ([OPEN]); a caller abort after headers is a no-op ([OPEN]).
 *  - ADM-BASE-03 (plan C2-2)  :95 builds the message as
 *    'connector transport failure: ' + String(err), copying the wrapped driver error into
 *    ConnectorClientError.message (which rises into the task error sink). Target: no driver text.
 *  - C2-3 (measurement)  :126 builds
 *    'connector returned a malformed InvocationResponse: ' + parsed.error.message.slice(0, 256).
 *    This suite MEASURES whether upstream-controlled content really survives that channel instead
 *    of asserting the lane's claim.
 *
 * Run (targeted path per W49-Q3-3 sec.0; no package.json script yet):
 *   pnpm --dir packages/connector-client exec jest tests/network-boundaries.boundary.test.ts --runInBand
 *
 * Offline contract: 127.0.0.1 loopback listener (BoundaryListener) driven by the production default
 * fetch, or the package's own fetchImpl seam. No PostgreSQL :5433, no Redis :6380, no DNS, and
 * globalThis.fetch is NEVER reassigned (kit rule 1 / plan sec.6.1 rule 1). [LOCK:*] cases are red on
 * purpose until the fixes land, so this file must stay out of the default pnpm test path.
 */
import { randomUUID } from 'node:crypto';
import {
  ConnectorClientError,
  createHttpTransport,
  type ClientInvocationResult,
} from '../src';
import {
  BoundaryListener,
  sleep,
  waitFor,
  type ListenerScript,
} from '../../../../tests/harness/network-boundaries/mock-listener';
import { mkSentinel } from '../../../../tests/harness/network-boundaries/sentinels';
import { scanForSentinels } from '../../../../tests/harness/network-boundaries/sink-scan';
import {
  installRejectionGuard,
  type RejectionGuard,
} from '../../../../tests/harness/network-boundaries/unhandled-guard';

const TOKEN = '***';

/** transport.ts:126 = MALFORMED_PREFIX + zodMessage.slice(0, ECHO_CAP). */
// Post-fix contract (R1-C turn 2): the malformed message carries ONLY `path:issue.code`
// pointers (max 8) in parentheses — never the raw zod error text, whose
// invalid_enum_value variant provably echoed upstream-controlled VALUES (measured with
// the 256-char slice still leaking a 26-char sentinel at msgLen 307).
const MALFORMED_PREFIX = 'connector returned a malformed InvocationResponse (';
const ECHO_CAP = 256;

/** Loopback port 1 that nothing dials: every case on this base injects fetchImpl. */
const UNDIALED_BASE = 'http://127.0.0.1:1/internal/v1';

type Outcome =
  | { kind: 'resolved'; value: ClientInvocationResult }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'budget' };

interface Timed {
  outcome: Outcome;
  /** Wall clock from just before the request was built until it settled (or the budget ran out). */
  elapsed: number;
}

interface C23Measurement {
  variant: string;
  /** Did the FULL sentinel reach the typed error (message or stack)? */
  echo: boolean;
  /** How many leading chars of the sentinel leaked (truncation-boundary evidence). */
  prefixLeakChars: number;
  messageLength: number;
  capApplied: boolean;
}

const listeners: BoundaryListener[] = [];
const c23Measurements: C23Measurement[] = [];
let guard: RejectionGuard;

beforeAll(() => {
  guard = installRejectionGuard();
});

afterAll(async () => {
  // stop() destroys every socket, so a deliberately-dangling body read settles before teardown and
  // jest can exit on its own (no --forceExit in this suite's contract).
  for (const listener of listeners) await listener.stop();
  for (const listener of listeners) expect(listener.openSockets).toBe(0);
  guard.assertClean('connector-client/network-boundaries');
  guard.restore();
});

async function startListener(script: ListenerScript): Promise<BoundaryListener> {
  const listener = await BoundaryListener.start();
  listener.setDefault(script);
  listeners.push(listener);
  return listener;
}

/** Race a transport promise against a wall-clock budget without leaving a floating rejection. */
async function raceBudget(
  promise: Promise<ClientInvocationResult>,
  budgetMs: number
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'budget' }), budgetMs);
  });
  const settled = promise.then(
    (value) => ({ kind: 'resolved' as const, value }),
    (error: unknown) => ({ kind: 'rejected' as const, error })
  );
  // Belt-and-braces: the race already attaches a rejection handler, so the losing leg (the stall
  // cases below) can never reach the process unhandledRejection guard.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([settled, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function attempt(
  run: () => Promise<ClientInvocationResult>,
  budgetMs: number
): Promise<Timed> {
  const started = Date.now();
  const outcome = await raceBudget(run(), budgetMs);
  return { outcome, elapsed: Date.now() - started };
}

/**
 * Harness plumbing, not a measurement. Windows hands a just-closed listener port straight back to
 * the next BoundaryListener, and undici's keep-alive pool can then serve a dead socket to the
 * request that "connects" to that port: the fetch rejects in single-digit milliseconds with zero
 * requests reaching the listener. Repeating an attempt that never landed keeps the LOCKs measuring
 * transport behaviour instead of the OS port allocator; an attempt the listener witnessed is
 * returned untouched, so no assertion below ever sees a retried request.
 */
async function timedLoopback(
  listener: BoundaryListener,
  budgetMs: number,
  run: () => Promise<ClientInvocationResult>
): Promise<Timed> {
  let last: Timed | undefined;
  for (let attemptNo = 1; attemptNo <= 4; attemptNo += 1) {
    const timed = await attempt(run, budgetMs);
    last = timed;
    if (listener.requests > 0 || timed.outcome.kind !== 'rejected') return timed;
    await sleep(10 * attemptNo);
  }
  if (last === undefined) throw new Error('harness: loopback attempt loop never ran');
  throw new Error(
    'harness: loopback listener never received a request in 4 attempts (instant connect failure on a ' +
      'recycled port) - the transport behaviour under test was not observable in this run'
  );
}

function asRejected(outcome: Outcome, label: string): ConnectorClientError {
  if (outcome.kind === 'budget') {
    throw new Error(label + ': promise still pending inside the race budget');
  }
  if (outcome.kind === 'resolved') {
    throw new Error(label + ': resolved instead of rejecting (state=' + outcome.value.state + ')');
  }
  if (!(outcome.error instanceof ConnectorClientError)) {
    throw new Error(
      label + ': rejection is not a ConnectorClientError (' + String(outcome.error) + ')'
    );
  }
  return outcome.error;
}

/**
 * The transport's documented failure class (header docstring + :88-97): an unknown outcome surfaces
 * as INVOCATION_UNKNOWN / status 0 / retryable so the SDK reconciles by invocationId instead of
 * blind-retrying the provider. A mid-body timeout/abort belongs to the same family.
 */
function expectUnknownOutcome(err: ConnectorClientError, label: string): void {
  expect({
    label,
    name: err.name,
    code: err.code,
    status: err.status,
    retryable: err.retryable,
  }).toMatchObject({
    label,
    name: 'ConnectorClientError',
    code: 'INVOCATION_UNKNOWN',
    status: 0,
    retryable: true,
  });
}

/**
 * Sentinel-hygiene assertion instead of expect(hits).toEqual([]): the failure text names only the hit
 * PATHS, so this suite never prints the secret it is hunting (jest output is a sink too).
 */
function expectNoSentinel(payload: unknown, sentinels: readonly string[], sink: string): void {
  const hits = scanForSentinels(payload, sentinels);
  if (hits.length > 0) {
    throw new Error(
      hits.length +
        " sentinel hit(s) in sink '" +
        sink +
        "' at: " +
        hits.map((h) => h.path).join(', ')
    );
  }
}

/** Longest leading slice of the sentinel that leaked into text (evidence for the :126 256-ch cap). */
function prefixLeakChars(text: string, sentinel: string): number {
  for (let n = sentinel.length; n > 0; n -= 1) {
    if (text.includes(sentinel.slice(0, n))) return n;
  }
  return 0;
}

function lastRequest(listener: BoundaryListener) {
  return listener.recordedRequests[listener.recordedRequests.length - 1];
}

describe('R1-C createHttpTransport - timeout/abort scope and error-message secret boundaries', () => {
  // ---------- B2 locks (behaviour that is already correct and must stay correct) ----------

  it('[LOCK] timeout bounds the HEADERS phase', async () => {
    const listener = await startListener({ kind: 'hangForever' });
    const transport = createHttpTransport({
      baseUrl: listener.url('/internal/v1'),
      token: TOKEN,
      timeoutMs: 120,
    });
    // No caller signal: only the internal timeout can save this request.
    const timed = await timedLoopback(listener, 500, () =>
      transport.get('inv-' + randomUUID(), undefined)
    );
    const err = asRejected(timed.outcome, 'timeout-bounds-headers');
    expectUnknownOutcome(err, 'timeout-bounds-headers');
    expect(timed.elapsed).toBeLessThan(500);
    // Loopback proof (not a connect/DNS artifact) + client-gone witness, read before any stop():
    // stop() destroys sockets itself and would fake closedWithoutFinish.
    expect(listener.requests).toBeGreaterThanOrEqual(1);
    await waitFor(() => listener.closedWithoutFinish >= 1, 500);
  });

  it('[LOCK] caller abort before headers cancels', async () => {
    const listener = await startListener({ kind: 'hangForever' });
    const transport = createHttpTransport({
      baseUrl: listener.url('/internal/v1'),
      token: TOKEN,
      // Deliberately far above the budget: the caller signal, not the timer, must cancel.
      timeoutMs: 30_000,
    });
    const timed = await timedLoopback(listener, 400, () => {
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 20);
      const dangling = transport.get('inv-' + randomUUID(), controller.signal);
      void dangling.catch(() => undefined);
      return dangling.finally(() => clearTimeout(abortTimer));
    });
    const err = asRejected(timed.outcome, 'caller-abort-before-headers');
    expectUnknownOutcome(err, 'caller-abort-before-headers');
    expect(timed.elapsed).toBeLessThan(400);
    expect(listener.requests).toBeGreaterThanOrEqual(1);
  });

  // ------- B2 opens (FIX-CR-08 / WR24-06: the body phase is outside every abort scope) -------

  it('[LOCK:FIX-CR-08 stall-after-headers-must-reject]', async () => {
    const listener = await startListener({ kind: 'stallAfterHeaders', status: 200 });
    const transport = createHttpTransport({
      baseUrl: listener.url('/internal/v1'),
      token: TOKEN,
      timeoutMs: 120,
    });
    const dangling: Array<Promise<ClientInvocationResult>> = [];
    try {
      const timed = await timedLoopback(listener, 400, () => {
        const pending = transport.get('inv-' + randomUUID(), undefined);
        dangling.push(pending);
        return pending;
      });
      if (timed.outcome.kind === 'budget') {
        throw new Error(
          'transport.get() was still pending 400ms after a 120ms timeoutMs budget: headers flushed, ' +
            'so the finally at transport.ts:100-101 cleared the timeout timer and dropped the chained ' +
            'caller abort, leaving the body read at transport.ts:104 outside every abort scope. ' +
            'Expected once FIX-CR-08 lands: one abort scope covering headers AND body, rejecting as ' +
            'INVOCATION_UNKNOWN (status 0, retryable true).'
        );
      }
      const err = asRejected(timed.outcome, 'stall-after-headers');
      expectUnknownOutcome(err, 'stall-after-headers');
    } finally {
      // Destroys the sockets => the dangling body read settles and jest can exit.
      await listener.stop();
      for (const pending of dangling) void pending.catch(() => undefined);
    }
  });

  it('[LOCK:FIX-CR-08 caller-abort-after-headers-must-cancel-body]', async () => {
    const listener = await startListener({ kind: 'stallAfterHeaders', status: 200 });
    const transport = createHttpTransport({
      baseUrl: listener.url('/internal/v1'),
      token: TOKEN,
      // High enough that only the caller signal could end this request.
      timeoutMs: 30_000,
    });
    const dangling: Array<Promise<ClientInvocationResult>> = [];
    try {
      // Land the request first (so the abort provably fires in the BODY phase, not during connect)
      // and keep re-issuing while a recycled port swallows the connect (see timedLoopback).
      let landed = false;
      for (let attemptNo = 1; attemptNo <= 4 && !landed; attemptNo += 1) {
        const controller = new AbortController();
        const pending = transport.get('inv-' + randomUUID(), controller.signal);
        dangling.push(pending);
        void pending.catch(() => undefined);
        try {
          await waitFor(() => listener.requests >= 1, 300);
          landed = true;
          // Sleep past the headers flush: transport.ts:101 must already have removed onOuterAbort.
          await sleep(50);
          const started = Date.now();
          controller.abort();
          const timed = { outcome: await raceBudget(pending, 400), elapsed: Date.now() - started };
          if (timed.outcome.kind === 'budget') {
            throw new Error(
              'aborting the caller signal after headers resolved was a no-op: transport.ts:101 removed ' +
                'onOuterAbort as soon as fetch resolved, so lease loss / cancel can never stop the body ' +
                'read at transport.ts:104 (still pending 400ms after abort with timeoutMs=30s). Expected ' +
                'once FIX-CR-08 lands: the outer signal stays attached for the whole request.'
            );
          }
          if (timed.outcome.kind === 'resolved') {
            throw new Error(
              'caller abort after headers was ignored and the body drained (state=' +
                timed.outcome.value.state +
                ')'
            );
          }
          const err = asRejected(timed.outcome, 'caller-abort-after-headers');
          expectUnknownOutcome(err, 'caller-abort-after-headers');
          expect(timed.elapsed).toBeLessThan(400);
          // Listener-side witness (plan sec.4 B.2): the socket must be released, not just the promise.
          await waitFor(() => listener.closedWithoutFinish >= 1, 500);
        } catch (err) {
          // Only the harness-level connect flake may be retried; anything else is the real verdict.
          if (landed || !(err instanceof Error) || !/^waitFor timed out/.test(err.message)) throw err;
          await sleep(10 * attemptNo);
        }
      }
      if (!landed) throw new Error('harness: loopback listener never received a request in 4 attempts');
    } finally {
      await listener.stop();
      for (const pending of dangling) void pending.catch(() => undefined);
    }
  });

  // ---------- C2-2 / ADM-BASE-03: driver text inside the typed error message ----------

  it('[LOCK:ADM-BASE-03 transport-error-message-no-sentinel]', async () => {
    const sentinel = mkSentinel('ccerr');
    const fetchImpl = (async () => {
      throw new Error('driver failure ' + sentinel);
    }) as unknown as typeof fetch;
    const transport = createHttpTransport({
      baseUrl: UNDIALED_BASE,
      token: TOKEN,
      timeoutMs: 1000,
      fetchImpl,
    });

    const timed = await attempt(() => transport.get('inv-' + randomUUID(), undefined), 1000);
    const err = asRejected(timed.outcome, 'transport-error-message');
    // The classification half of the row is already correct - only the echo is open.
    expectUnknownOutcome(err, 'transport-error-message');
    // Target behaviour (plan sec.5 C2-2): a fixed, driver-agnostic detail. Today :95 interpolates
    // String(err), so the wrapped error text lands in message AND stack, so this is RED. Kept at
    // target on purpose: the fix must stop echoing, not get a pin for echoing.
    expectNoSentinel([err.message, err.stack ?? ''], [sentinel], 'ConnectorClientError.message+stack');
  });

  // ---------- C2-3: measured echo channel (upstream-controlled content) ----------

  it('[LOCK] C2-3 malformed-response carries path:code only, no upstream values', async () => {
    // Variant A - unparseable body: safeJsonParse yields undefined, so zod reports invalid_type for
    // the top-level object, and zod v3 invalid_type messages name TYPES, not values.
    const sentinelA = mkSentinel('c23', 'invalidjson');
    const listenerA = await startListener({
      kind: 'respond',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '###' + sentinelA + '###',
    });
    // Variant B - valid JSON the schema rejects on a z.enum field: invalid_enum_value messages carry
    // the received VALUE in zod v3, so this is the honest probe of the lane claim that :126 echoes
    // upstream-generated content into the message.
    const sentinelB = mkSentinel('c23', 'enumvalue');
    const listenerB = await startListener({
      kind: 'respond',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invocationId: 'inv-' + randomUUID(),
        state: 'SUCCEEDED',
        usage: { measurement: sentinelB },
      }),
    });

    const transportA = createHttpTransport({
      baseUrl: listenerA.url('/internal/v1'),
      token: TOKEN,
      timeoutMs: 2000,
    });
    const transportB = createHttpTransport({
      baseUrl: listenerB.url('/internal/v1'),
      token: TOKEN,
      timeoutMs: 2000,
    });

    const timedA = await timedLoopback(listenerA, 2000, () =>
      transportA.get('inv-' + randomUUID(), undefined, TOKEN)
    );
    const errA = asRejected(timedA.outcome, 'C2-3 variant A (invalid JSON)');
    expect({ code: errA.code, status: errA.status, retryable: errA.retryable }).toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      status: 200,
      retryable: false,
    });
    expect(errA.message.startsWith(MALFORMED_PREFIX)).toBe(true);
    expect(errA.message.length).toBeLessThanOrEqual(MALFORMED_PREFIX.length + ECHO_CAP);
    // The LOCK: no upstream-shaped content survives this channel for an unparseable body.
    expectNoSentinel([errA.message, errA.stack ?? ''], [sentinelA], 'C2-3 variant A message+stack');
    c23Measurements.push({
      variant: 'A-invalid-json',
      echo: scanForSentinels([errA.message, errA.stack ?? ''], [sentinelA]).length > 0,
      prefixLeakChars: prefixLeakChars(errA.message, sentinelA),
      messageLength: errA.message.length,
      capApplied: errA.message.length >= MALFORMED_PREFIX.length + ECHO_CAP,
    });

    const timedB = await timedLoopback(listenerB, 2000, () =>
      transportB.get('inv-' + randomUUID(), undefined, TOKEN)
    );
    const errB = asRejected(timedB.outcome, 'C2-3 variant B (schema-invalid JSON)');
    expect({ code: errB.code, status: errB.status, retryable: errB.retryable }).toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      status: 200,
      retryable: false,
    });
    expect(errB.message.startsWith(MALFORMED_PREFIX)).toBe(true);
    expect(errB.message.length).toBeLessThanOrEqual(MALFORMED_PREFIX.length + ECHO_CAP);
    const hitsB = scanForSentinels([errB.message, errB.stack ?? ''], [sentinelB]);
    // STRICT post-fix assertion: the enum-value echo channel is CLOSED.
    expect({ hitsB: hitsB.map((h) => h.path) }).toEqual({ hitsB: [] });
    c23Measurements.push({
      variant: 'B-invalid-enum-value',
      echo: hitsB.length > 0,
      prefixLeakChars: prefixLeakChars(errB.message, sentinelB),
      messageLength: errB.message.length,
      capApplied: errB.message.length >= MALFORMED_PREFIX.length + ECHO_CAP,
    });

    // Measurements stay printed: they are the before/after evidence for reports/qwen3.md §4b.
    console.info(
      '[C2-3 measurement] ' +
        c23Measurements
          .map(
            (m) =>
              m.variant +
              ' echo=' + (m.echo ? 'PRESENT' : 'ABSENT') +
              ' prefixLeakChars=' + m.prefixLeakChars +
              ' msgLen=' + m.messageLength +
              ' capApplied=' + m.capApplied
          )
          .join(' | ')
    );
    expect(c23Measurements.map((m) => m.variant)).toEqual([
      'A-invalid-json',
      'B-invalid-enum-value',
    ]);
  });

  // ---------- positive control: the real transport path works end to end ----------

  it('[LOCK] healthy control path', async () => {
    const invocationId = 'inv-' + randomUUID();
    const wire = {
      invocationId,
      state: 'SUCCEEDED',
      result: { content: 'ok', sessionRef: 'sess-9' },
      usage: { inputTokens: 1, outputTokens: 2, costMicrousd: 3, measurement: 'measured' },
      providerRequestId: 'prov-1',
      nextPollAt: null,
    };
    const listener = await startListener({
      kind: 'respond',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    // No fetchImpl here: production default fetch over a real loopback socket.
    const transport = createHttpTransport({
      baseUrl: listener.url('/internal/v1'),
      token: TOKEN,
      timeoutMs: 2000,
    });
    const timed = await timedLoopback(listener, 2000, () =>
      transport.get(invocationId, undefined, 'signed-grant-token')
    );
    if (timed.outcome.kind !== 'resolved') {
      throw new Error('control path did not resolve: ' + timed.outcome.kind);
    }
    expect(timed.outcome.value).toMatchObject({
      invocationId,
      state: 'completed',
      providerRequestId: 'prov-1',
    });
    expect(timed.outcome.value.result?.content).toBe('ok');
    expect(timed.outcome.value.usage?.inputTokens).toBe(1);
    expect(timed.outcome.value.nextPollAt).toBeUndefined();

    // What actually crossed the wire (proves the failure cases above hit the same code path).
    expect(listener.requests).toBeGreaterThanOrEqual(1);
    const recorded = lastRequest(listener);
    expect(recorded?.method).toBe('GET');
    expect(recorded?.url).toBe('/internal/v1/invocations/' + invocationId);
    expect(recorded?.headers['authorization']).toBe('Bearer ' + TOKEN);
    expect(recorded?.headers['x-invocation-grant']).toBe('signed-grant-token');
  });
});
