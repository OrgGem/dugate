import { createHmac, randomUUID } from 'node:crypto';
import { InvocationResponseSchema, type CheckpointRef, type InvocationResponse } from '@du/contracts';
import {
  DEFAULT_PENDING_RETRY_MS,
  DefaultTaskContext,
  MAX_PENDING_RETRY_MS,
  MIN_PENDING_RETRY_MS,
  OPEN_DEADLINE_SENTINEL,
  PendingInvocationError,
  ReconcileRequiredError,
  ConnectorInvocationFailedError,
  InvocationCancelledError,
  RuntimeClient,
  assertInvocationResult,
  classifyFailure,
  classifyInvocation,
  defineBusiness,
  deriveStableDeadline,
  pendingRetryDelayMs,
  runConnectorStep,
  startWorker,
} from '../src';
import type { ConnectorInvocationPayload, QueueConsumer } from '../src';

/**
 * P4-07 — invocation grant facade / connector client wiring / session refs.
 *
 * Acceptance proven here at the mocked seam (no DB, no Redis, no network):
 *
 * 1. SAME LOGICAL STEP → STABLE INVOCATION. The grant-service mock
 *    replicates the orchestrator's semantics verbatim (invocationId is a
 *    deterministic HMAC of (taskId, stepKey, bindingSlot); a differing
 *    inputHash for the same logical key is 409 INPUT_HASH_MISMATCH, never
 *    a new identity). Two simulated deliveries of the same step produce
 *    identical canonical hashes and reuse one invocationId.
 *
 * 2. PENDING YIELDS INSTEAD OF SPINNING. A PENDING response throws
 *    PendingInvocationError (retryable, retryAfterMs from nextPollAt);
 *    classifyFailure maps it to the runtime retry path (RETRY_PENDING →
 *    fresh delivery), and the step checkpoint is NOT written — the resume
 *    re-enters the step and the connector ledger dedupes via the stable
 *    invocationId.
 *
 * 3. SESSION REFS travel on the wire (hashed), persist on the checkpoint
 *    row, and return from the result.
 */

const TASK_ID = randomUUID();
const OP_ID = randomUUID();
const SLOT = 'reasoning';
const STEP_KEY = 'summarize';

/* -------------------------------------------------------------------- */
/* Orchestrator-faithful grant-service mock (mirrors grants.ts)          */
/* -------------------------------------------------------------------- */

function frame(value: string): string {
  return `${value.length}:${value}`;
}

/** Byte-for-byte the orchestrator's stableInvocationId derivation. */
function stableInvocationId(taskId: string, stepKey: string, bindingSlot: string): string {
  const ns = '1b671a64-40d5-491e-99b0-190777e0c4e3';
  const digest = createHmac('sha256', ns)
    .update(frame(taskId) + '|' + frame(stepKey) + '|' + frame(bindingSlot))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface GrantLedger {
  /** invocationId → stored inputHash (the orchestrator's invocation_grants row). */
  hashes: Map<string, string>;
  issued: { invocationId: string; inputHash: string }[];
}

/* -------------------------------------------------------------------- */
/* Runtime route mocking                                                 */
/* -------------------------------------------------------------------- */

interface Route {
  method: string;
  pattern: RegExp;
  handler: (m: RegExpMatchArray, body: unknown) => { status: number; json: unknown };
}

interface CapturedCall {
  path: string;
  method: string;
  body?: unknown;
}

function stubFetch(routes: Route[], calls: CapturedCall[]) {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    for (const r of routes) {
      if (r.method === method) {
        const m = r.pattern.exec(path);
        if (m) {
          const { status, json } = r.handler(m, body);
          return new Response(JSON.stringify(json), {
            status,
            headers: { 'content-type': 'application/json' },
          }) as unknown as globalThis.Response;
        }
      }
    }
    return new Response(
      JSON.stringify({ type: 'urn:du:error:not_found', status: 404, code: 'NOT_FOUND', title: `no route ${method} ${path}` }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    ) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
}

function grantRoutes(ledger: GrantLedger): Route {
  return {
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/invocation-grants$/,
    handler: (m, body) => {
      const req = body as { stepKey: string; bindingSlot: string; inputHash: string };
      const invocationId = stableInvocationId(m[1]!, req.stepKey, req.bindingSlot);
      ledger.issued.push({ invocationId, inputHash: req.inputHash });
      const stored = ledger.hashes.get(invocationId);
      if (stored !== undefined && stored !== req.inputHash) {
        return {
          status: 409,
          json: {
            type: 'urn:du:error:input_hash_mismatch',
            status: 409,
            code: 'INPUT_HASH_MISMATCH',
            title: 'input hash mismatch',
            detail: `invocation ${invocationId} already issued for a different input`,
          },
        };
      }
      ledger.hashes.set(invocationId, req.inputHash);
      return {
        status: 200,
        json: {
          grant: `signed-${invocationId}`,
          invocationId,
          connectorId: 'conn-1',
          connectorRevision: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          allowedOptions: {},
        },
      };
    },
  };
}

function artifactRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/tasks\/[^/]+\/artifacts$/,
      handler: () => {
        const artifactId = randomUUID();
        return {
          status: 200,
          json: {
            artifactId,
            storageKey: `sk-${artifactId}`,
            uploadUrl: `http://storage/${artifactId}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/artifacts\/([^/]+)\/finalize$/,
      handler: () => ({ status: 200, json: {} }),
    },
    {
      method: 'POST',
      pattern: /^\/artifacts\/([^/]+)\/access$/,
      handler: (m) => ({
        status: 200,
        json: {
          artifactId: m[1],
          downloadUrl: `http://storage/${m[1]}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    },
  ];
}

function saveStepCaptureRoute(): Route {
  return {
    method: 'PUT',
    pattern: /^\/tasks\/[^/]+\/steps\/([^/]+)$/,
    handler: (m) => ({
      status: 201,
      json: { stepKey: m[1], generation: 1, replayed: false },
    }),
  };
}

async function collectFetchBody(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body && typeof body === 'object' && 'getReader' in body) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body ?? ''), 'utf8');
}

/** In-memory storage for the raw-fetch artifact PUT/GET path. */
function installStorageFetch(): { storage: Map<string, string>; restore: () => void } {
  const storage = new Map<string, string>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
    const key = String(url);
    if (init?.method === 'PUT') {
      const text = (await collectFetchBody(init.body)).toString('utf8');
      storage.set(key, text);
      return new Response(null, { status: 200 }) as unknown as globalThis.Response;
    }
    const hit = storage.get(key);
    if (hit === undefined) {
      return new Response('not found', { status: 404 }) as unknown as globalThis.Response;
    }
    return new Response(hit, { status: 200 }) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
  return { storage, restore: () => { globalThis.fetch = real; } };
}

/* -------------------------------------------------------------------- */
/* Context harness                                                       */
/* -------------------------------------------------------------------- */

interface HarnessOptions {
  attempt?: number;
  leaseEpoch?: number;
  deadlineAt?: string | null;
  checkpointRefs?: CheckpointRef[];
  responses?: InvocationResponse[]; // queued connector responses (FIFO)
  ledger?: GrantLedger;
}

interface Harness {
  ctx: DefaultTaskContext;
  calls: CapturedCall[];
  payloads: ConnectorInvocationPayload[];
  ledger: GrantLedger;
  invokeCount: () => number;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const ledger = opts.ledger ?? { hashes: new Map<string, string>(), issued: [] };
  const calls: CapturedCall[] = [];
  const routes: Route[] = [
    grantRoutes(ledger),
    ...artifactRoutes(),
    saveStepCaptureRoute(),
  ];
  const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: stubFetch(routes, calls) });
  const responses = opts.responses ?? [];
  const payloads: ConnectorInvocationPayload[] = [];
  const invokeConnector = async (_grant: unknown, payload: ConnectorInvocationPayload): Promise<InvocationResponse> => {
    payloads.push(payload);
    const next = responses.shift();
    if (!next) throw new Error('no queued connector response');
    return next;
  };
  const ctx = new DefaultTaskContext(
    {
      taskId: TASK_ID,
      operationId: OP_ID,
      tenantId: 'tenant-1',
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'root',
      taskKey: 'root',
      attempt: opts.attempt ?? 1,
      leaseEpoch: opts.leaseEpoch ?? 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: opts.deadlineAt === undefined ? null : opts.deadlineAt,
      input: {},
      connectorBindings: { [SLOT]: 'mock-llm@1' },
      checkpointRefs: opts.checkpointRefs ?? [],
      cancelRequested: false,
    },
    {
      runtime,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: invokeConnector as never,
    }
  );
  return {
    ctx,
    calls,
    payloads,
    ledger,
    invokeCount: () => payloads.length,
  };
}

function succeeded(id = `inv-${randomUUID()}`, sessionRef: string | null = 'sess-next'): InvocationResponse {
  return {
    invocationId: id,
    state: 'SUCCEEDED',
    result: { content: 'provider output', sessionRef },
    usage: { inputTokens: 10, outputTokens: 5, costMicrousd: 7, measurement: 'measured' },
  } as InvocationResponse;
}

function pending(id = `inv-${randomUUID()}`, nextPollAt?: string | null): InvocationResponse {
  return {
    invocationId: id,
    state: 'PENDING',
    nextPollAt: nextPollAt === undefined ? new Date(Date.now() + 30_000).toISOString() : nextPollAt,
  } as InvocationResponse;
}

/* -------------------------------------------------------------------- */
/* classifyInvocation (pure)                                             */
/* -------------------------------------------------------------------- */

describe('classifyInvocation', () => {
  it('maps SUCCEEDED to a result outcome carrying result/usage/sessionRef', () => {
    const out = classifyInvocation(succeeded('inv-1', 'sess-9'));
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.invocationId).toBe('inv-1');
    expect(out.result).toMatchObject({ content: 'provider output' });
    expect(out.sessionRef).toBe('sess-9');
    expect(out.usage).toMatchObject({ inputTokens: 10 });
  });

  it('maps SUCCEEDED without result envelope to an empty result, null session', () => {
    const out = classifyInvocation({ invocationId: 'inv-2', state: 'SUCCEEDED' } as InvocationResponse);
    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.result).toEqual({});
    expect(out.sessionRef).toBeNull();
    expect(out.usage).toBeNull();
  });

  it('normalizes a missing sessionRef on a result to null', () => {
    const response = InvocationResponseSchema.parse({
      invocationId: 'inv-no-session',
      state: 'SUCCEEDED',
      result: { content: 'complete' },
    });
    const out = classifyInvocation(response);

    expect(out.kind).toBe('result');
    if (out.kind !== 'result') return;
    expect(out.sessionRef).toBeNull();
  });

  it.each([42, false, {}, []])('rejects a malformed non-string sessionRef (%p)', (sessionRef) => {
    const parsed = InvocationResponseSchema.safeParse({
      invocationId: 'inv-malformed-session',
      state: 'SUCCEEDED',
      result: { content: 'complete', sessionRef },
    });

    expect(parsed.success).toBe(false);
  });

  it.each(['NEW', 'IN_FLIGHT', 'PENDING'] as const)('maps %s to pending-yield', (state) => {
    const out = classifyInvocation({ invocationId: 'inv-3', state, nextPollAt: null } as InvocationResponse);
    expect(out.kind).toBe('pending-yield');
    if (out.kind !== 'pending-yield') return;
    expect(out.retryAfterMs).toBe(DEFAULT_PENDING_RETRY_MS);
  });

  it('maps FAILED with the error envelope passthrough', () => {
    const out = classifyInvocation({
      invocationId: 'inv-4',
      state: 'FAILED',
      error: { code: 'PROVIDER_RATE_LIMITED', message: 'busy', retryable: true, retryAfterMs: 2500 },
    } as InvocationResponse);
    expect(out).toMatchObject({
      kind: 'failed',
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 2500,
    });
  });

  it('maps FAILED without error to a non-retryable default', () => {
    const out = classifyInvocation({ invocationId: 'inv-5', state: 'FAILED' } as InvocationResponse);
    expect(out).toMatchObject({ kind: 'failed', code: 'PROVIDER_UNAVAILABLE', retryable: false });
  });

  it('maps UNKNOWN to reconcile and CANCELLED to cancelled', () => {
    expect(classifyInvocation({ invocationId: 'inv-6', state: 'UNKNOWN' } as InvocationResponse).kind).toBe('reconcile');
    expect(classifyInvocation({ invocationId: 'inv-7', state: 'CANCELLED' } as InvocationResponse).kind).toBe('cancelled');
  });
});

describe('pendingRetryDelayMs', () => {
  const now = Date.parse('2026-09-23T00:00:00.000Z');
  it('derives the delay from a future nextPollAt', () => {
    const at = new Date(now + 30_000).toISOString();
    expect(pendingRetryDelayMs(at, now)).toBe(30_000);
  });
  it('clamps a far-future hint to MAX', () => {
    const at = new Date(now + 10 * 24 * 3600_000).toISOString();
    expect(pendingRetryDelayMs(at, now)).toBe(MAX_PENDING_RETRY_MS);
  });
  it('returns MIN for a past hint (never a hot loop, never negative)', () => {
    expect(pendingRetryDelayMs(new Date(now - 5_000).toISOString(), now)).toBe(MIN_PENDING_RETRY_MS);
  });
  it('falls back to DEFAULT for null or unparsable hints', () => {
    expect(pendingRetryDelayMs(null, now)).toBe(DEFAULT_PENDING_RETRY_MS);
    expect(pendingRetryDelayMs('not-a-date', now)).toBe(DEFAULT_PENDING_RETRY_MS);
  });

  it.each(['', '2026-99-99T25:61:61Z', 'Infinity'])('uses DEFAULT for a corrupt nextPollAt timestamp (%s)', (nextPollAt) => {
    const response = InvocationResponseSchema.parse({
      invocationId: 'inv-corrupt-poll-time',
      state: 'PENDING',
      nextPollAt,
    });
    const out = classifyInvocation(response);

    expect(out.kind).toBe('pending-yield');
    if (out.kind !== 'pending-yield') return;
    expect(out.retryAfterMs).toBe(DEFAULT_PENDING_RETRY_MS);
  });

  it.each([0, -1, -MAX_PENDING_RETRY_MS * 10])(
    'clamps non-positive derived retry delays to MIN (%s ms from now)',
    (deltaMs) => {
      const at = new Date(now + deltaMs).toISOString();

      expect(pendingRetryDelayMs(at, now)).toBe(MIN_PENDING_RETRY_MS);
    },
  );
});

describe('assertInvocationResult', () => {
  it('returns the payload for result outcomes', () => {
    const payload = assertInvocationResult(classifyInvocation(succeeded('inv-1')));
    expect(payload.invocationId).toBe('inv-1');
    expect(payload.sessionRef).toBe('sess-next');
  });
  it('throws PendingInvocationError for pending-yield', () => {
    const out = classifyInvocation(pending('inv-2'));
    try {
      assertInvocationResult(out);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PendingInvocationError);
      const e = err as PendingInvocationError;
      expect(e.code).toBe('PROVIDER_PENDING');
      expect(e.retryable).toBe(true);
      expect(e.retryAfterMs).toBeGreaterThan(0);
    }
  });
  it('throws the typed error for failed / reconcile / cancelled', () => {
    expect(() =>
      assertInvocationResult(classifyInvocation({ invocationId: 'i', state: 'FAILED', error: { code: 'X', message: 'm', retryable: false } } as InvocationResponse))
    ).toThrow(ConnectorInvocationFailedError);
    expect(() => assertInvocationResult(classifyInvocation({ invocationId: 'i', state: 'UNKNOWN' } as InvocationResponse))).toThrow(ReconcileRequiredError);
    expect(() => assertInvocationResult(classifyInvocation({ invocationId: 'i', state: 'CANCELLED' } as InvocationResponse))).toThrow(InvocationCancelledError);
  });
});

describe('yield-path classification (pending → RETRY_PENDING, not spin)', () => {
  it('PendingInvocationError maps onto the retryable runtime fail path', () => {
    const c = classifyFailure(new PendingInvocationError('inv-1', 30_000, null));
    expect(c).toMatchObject({ errorCode: 'PROVIDER_PENDING', retryable: true, retryAfterMs: 30_000 });
  });
  it('ReconcileRequiredError is permanent (no blind retry of an unknown outcome)', () => {
    expect(classifyFailure(new ReconcileRequiredError('inv-1'))).toMatchObject({
      errorCode: 'INVOCATION_UNKNOWN',
      retryable: false,
    });
  });
  it.each([2048, 2049])('bounds ReconcileRequiredError detail to 2048 characters (%s input characters)', (messageLength) => {
    const error = new ReconcileRequiredError('inv-boundary', 'x'.repeat(messageLength));
    const classification = classifyFailure(error);

    expect(error.name).toBe('ReconcileRequiredError');
    expect(error.invocationId).toBe('inv-boundary');
    expect(error.code).toBe('INVOCATION_UNKNOWN');
    expect(classification.errorCode).toBe('INVOCATION_UNKNOWN');
    expect(classification.retryable).toBe(false);
    expect(classification.retryAfterMs).toBeUndefined();
    expect(classification.detail).toHaveLength(2048);
  });
  it('ConnectorInvocationFailedError keeps the connector retryable flag', () => {
    const c = classifyFailure(new ConnectorInvocationFailedError('inv-1', 'PROVIDER_RATE_LIMITED', true, 'busy', 2500));
    expect(c).toMatchObject({ errorCode: 'PROVIDER_RATE_LIMITED', retryable: true, retryAfterMs: 2500 });
  });
});

describe('deriveStableDeadline', () => {
  it('prefers the explicit override, then ctx deadline, then the sentinel', () => {
    expect(deriveStableDeadline({ deadlineAt: '2026-01-01T00:00:00.000Z' }, '2027-01-01T00:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(deriveStableDeadline({ deadlineAt: '2026-01-01T00:00:00.000Z' })).toBe('2026-01-01T00:00:00.000Z');
    expect(deriveStableDeadline({ deadlineAt: null })).toBe(OPEN_DEADLINE_SENTINEL);
  });
  it('is deterministic across calls (no wall-clock component)', () => {
    const a = deriveStableDeadline({ deadlineAt: null });
    const b = deriveStableDeadline({ deadlineAt: null });
    expect(a).toBe(b);
  });
});

/* -------------------------------------------------------------------- */
/* runConnectorStep over the real DefaultTaskContext seam                */
/* -------------------------------------------------------------------- */

describe('runConnectorStep — stable invocation + pending yield (acceptance)', () => {
  let storageHandle: { storage: Map<string, string>; restore: () => void };

  beforeEach(() => {
    storageHandle = installStorageFetch();
  });
  afterEach(() => {
    storageHandle.restore();
  });

  it('redelivery of the same logical step reuses one inputHash, one invocationId, and yields on pending without a checkpoint', async () => {
    const ledger: GrantLedger = { hashes: new Map(), issued: [] };
    const input = { prompt: 'summarize this' };

    // Delivery 1: connector says PENDING → handler must yield.
    const h1 = makeHarness({
      attempt: 1,
      leaseEpoch: 1,
      deadlineAt: null,
      ledger,
      responses: [pending(undefined, new Date(Date.now() + 30_000).toISOString())],
    });
    await expect(
      runConnectorStep(h1.ctx, { stepKey: STEP_KEY, slot: SLOT, input })
    ).rejects.toBeInstanceOf(PendingInvocationError);

    // No checkpoint was written for the pending step → resume re-enters it.
    const stepSaves1 = h1.calls.filter((c) => c.method === 'PUT' && c.path.includes('/steps/'));
    expect(stepSaves1).toHaveLength(0);

    // Delivery 2 (fresh context, new lease): the provider finished.
    const h2 = makeHarness({
      attempt: 2,
      leaseEpoch: 2,
      deadlineAt: null,
      ledger,
      responses: [succeeded(ledger.issued[0]!.invocationId, 'sess-final')],
    });
    const out = await runConnectorStep(h2.ctx, { stepKey: STEP_KEY, slot: SLOT, input });

    // ACCEPTANCE 1 — stable invocation across the yield:
    const grants = ledger.issued;
    expect(grants).toHaveLength(2);
    expect(grants[0]!.invocationId).toBe(grants[1]!.invocationId);
    expect(grants[0]!.inputHash).toBe(grants[1]!.inputHash); // identical canonical hash
    expect(out.invocationId).toBe(grants[0]!.invocationId);
    // Wire deadline was the fixed sentinel on both deliveries (hash stability source).
    expect(h1.payloads[0]!.deadlineAt).toBe(OPEN_DEADLINE_SENTINEL);
    expect(h2.payloads[0]!.deadlineAt).toBe(OPEN_DEADLINE_SENTINEL);
    expect(h1.payloads[0]!.invocationId).toBe(h2.payloads[0]!.invocationId);

    // ACCEPTANCE 2 — the resume completed and checkpointed exactly once.
    expect(out.result).toMatchObject({ content: 'provider output' });
    expect(out.sessionRef).toBe('sess-final');
    const stepSaves2 = h2.calls.filter((c) => c.method === 'PUT' && c.path.includes('/steps/'));
    expect(stepSaves2).toHaveLength(1);
    expect(stepSaves1.length + stepSaves2.length).toBe(1);
  });

  it('a drifted input for the same logical step surfaces 409 INPUT_HASH_MISMATCH — never a blind provider retry', async () => {
    const ledger: GrantLedger = { hashes: new Map(), issued: [] };
    const h1 = makeHarness({ ledger, responses: [succeeded(stableInvocationId(TASK_ID, STEP_KEY, SLOT))] });
    await runConnectorStep(h1.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'first' } });
    const invokesAfterFirst = h1.invokeCount();

    const h2 = makeHarness({ attempt: 2, leaseEpoch: 2, ledger, responses: [] });
    await expect(
      runConnectorStep(h2.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'DIFFERENT' } })
    ).rejects.toMatchObject({ status: 409, code: 'INPUT_HASH_MISMATCH' });
    // The connector was never reached for the drifted hash.
    expect(h2.invokeCount()).toBe(0);
    expect(invokesAfterFirst).toBe(1);
  });

  it('an operation deadline is used verbatim in hash + wire payload', async () => {
    const deadline = '2026-09-23T12:00:00.000Z';
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({ deadlineAt: deadline, responses: [succeeded(invId)] });
    const out = await runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'x' } });
    expect(out.invocationId).toBe(invId);
    expect(h.payloads[0]!.deadlineAt).toBe(deadline);
  });
});

describe('runConnectorStep — session refs', () => {
  let storageHandle: { storage: Map<string, string>; restore: () => void };
  beforeEach(() => { storageHandle = installStorageFetch(); });
  afterEach(() => { storageHandle.restore(); });

  it('sends an explicit sessionRef on the wire, persists it on the checkpoint, and returns the provider continuation', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({ responses: [succeeded(invId, 'sess-2')] });
    const out = await runConnectorStep(h.ctx, {
      stepKey: STEP_KEY,
      slot: SLOT,
      input: { prompt: 'continue our chat' },
      sessionRef: 'sess-1',
    });
    expect(h.payloads[0]!.sessionRef).toBe('sess-1');
    expect(out.sessionRef).toBe('sess-2');
    const save = h.calls.find((c) => c.method === 'PUT' && c.path.includes('/steps/'))!;
    expect(save.body).toMatchObject({ sessionRef: 'sess-1' });
  });

  it('falls back to the sessionRef stored on a prior FAILED checkpoint (multi-turn resume)', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({
      responses: [succeeded(invId, 'sess-3')],
      checkpointRefs: [
        { stepKey: STEP_KEY, generation: 1, inputHash: 'stale-hash', status: 'FAILED', sessionRef: 'sess-prior' },
      ],
    });
    await runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'retry turn' } });
    expect(h.payloads[0]!.sessionRef).toBe('sess-prior');
  });

  it('omits sessionRef from the wire body when none is known (pre-W39 shape preserved)', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({ responses: [succeeded(invId, null)] });
    await runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'x' } });
    expect(h.payloads[0]!.sessionRef).toBeNull();
    const save = h.calls.find((c) => c.method === 'PUT' && c.path.includes('/steps/'))!;
    // JSON serialization drops undefined: the saveStep body must NOT carry sessionRef.
    expect(Object.keys(save.body as Record<string, unknown>)).not.toContain('sessionRef');
  });

  it('rejects a malformed provider sessionRef before writing a step checkpoint', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const malformedResponse = {
      invocationId: invId,
      state: 'SUCCEEDED',
      result: { content: 'provider output', sessionRef: 42 },
    } as unknown as InvocationResponse;
    const h = makeHarness({ responses: [malformedResponse] });

    await expect(
      runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'x' } }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(h.calls.filter((call) => call.method === 'PUT' && call.path.includes('/steps/'))).toHaveLength(0);
  });
});

describe('runConnectorStep — failure classification + replay', () => {
  let storageHandle: { storage: Map<string, string>; restore: () => void };
  beforeEach(() => { storageHandle = installStorageFetch(); });
  afterEach(() => { storageHandle.restore(); });

  it('FAILED retryable surfaces as ConnectorInvocationFailedError mapped by classifyFailure', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({
      responses: [
        {
          invocationId: invId,
          state: 'FAILED',
          error: { code: 'PROVIDER_RATE_LIMITED', message: 'busy', retryable: true, retryAfterMs: 2500 },
        } as InvocationResponse,
      ],
    });
    await expect(
      runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'x' } })
    ).rejects.toMatchObject({ name: 'ConnectorInvocationFailedError', code: 'PROVIDER_RATE_LIMITED', retryable: true });
    // No checkpoint on failure — the retry re-enters the step.
    expect(h.calls.filter((c) => c.method === 'PUT' && c.path.includes('/steps/'))).toHaveLength(0);
  });

  it('UNKNOWN surfaces as non-retryable ReconcileRequiredError', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({ responses: [{ invocationId: invId, state: 'UNKNOWN' } as InvocationResponse] });
    await expect(
      runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'x' } })
    ).rejects.toBeInstanceOf(ReconcileRequiredError);
    expect(classifyFailure(new ReconcileRequiredError(invId)).retryable).toBe(false);
  });

  it('a completed step replays from its checkpoint without re-invoking the connector (RUN-04 no re-inference)', async () => {
    const invId = stableInvocationId(TASK_ID, STEP_KEY, SLOT);
    const h = makeHarness({ responses: [succeeded(invId, 'sess-r')] });
    const first = await runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'cached' } });
    expect(h.invokeCount()).toBe(1);

    // Same context, same logical step: replay from the SUCCEEDED checkpoint.
    const second = await runConnectorStep(h.ctx, { stepKey: STEP_KEY, slot: SLOT, input: { prompt: 'cached' } });
    expect(h.invokeCount()).toBe(1); // connector NOT re-invoked
    expect(second.invocationId).toBe(first.invocationId);
    expect(second.result).toEqual(first.result);
    expect(second.sessionRef).toBe(first.sessionRef);
  });
});

/* -------------------------------------------------------------------- */
/* startWorker wiring — WorkerConfig.invokeConnector injection           */
/* -------------------------------------------------------------------- */

const MANIFEST = {
  contractVersion: '1',
  businessId: 'test-biz',
  displayName: 'Test Business',
  description: 'P4-07 wiring test',
  version: '1.0.0',
  imageDigest: 'sha256:aa',
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'extract',
      displayName: 'Extract',
      description: 'Test action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [{ name: SLOT, acceptedCapabilities: ['chat'], required: false }],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
};

function makeClaim(leaseEpoch = 1) {
  return {
    taskId: TASK_ID,
    operationId: OP_ID,
    leaseEpoch,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    attempt: 1,
    deadlineAt: null,
    executionSnapshot: {
      operationId: OP_ID,
      tenantId: 'tenant-1',
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      schemaDigest: 'sha256:bb',
      manifestDigest: 'sha256:aa',
      resolvedInputRef: { q: 'hello' },
      pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: { [SLOT]: 'mock-llm@1' } },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: null,
      cancelRequested: false,
    },
    checkpointRefs: [],
  };
}

function testConsumer() {
  let handler: ((job: unknown) => Promise<void>) | undefined;
  const deliveries: Promise<void>[] = [];
  const consumer: QueueConsumer = {
    start(h) { handler = h as (job: unknown) => Promise<void>; },
    async stop() { await Promise.allSettled(deliveries); },
  };
  const push = (job: unknown) => {
    if (!handler) throw new Error('consumer not started');
    const p = handler(job);
    deliveries.push(p);
    return p;
  };
  return { consumer, push };
}

describe('startWorker — invokeConnector injection (P4-07 wiring seam)', () => {
  it('routes ctx.connector.invoke through the injected invoker with the grant-issued invocationId', async () => {
    const ledger: GrantLedger = { hashes: new Map(), issued: [] };
    const calls: CapturedCall[] = [];
    const routes: Route[] = [
      { method: 'PUT', pattern: /^\/workers\/[^/]+\/heartbeat$/, handler: () => ({ status: 200, json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), capacity: 1 } }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
      ...artifactRoutes(),
      grantRoutes(ledger),
    ];
    const capturedPayloads: ConnectorInvocationPayload[] = [];
    const runtimeFetch = stubFetch(routes, calls);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('http://storage/')) {
        await collectFetchBody(init?.body);
        return new Response(null, { status: 200 });
      }
      return runtimeFetch(input, init);
    }) as typeof fetch;
    const invId = stableInvocationId(TASK_ID, 'default', SLOT);
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        const res = await ctx.connector.invoke(SLOT, { prompt: 'wire me' });
        const output = await ctx.artifacts.write(
          JSON.stringify(res),
          'invocation-result.json',
          'application/json'
        );
        return { kind: 'completed', resultRef: `artifact://${output.artifactId}` };
      },
    });
    const handle = await startWorker(def, {
      runtimeUrl: 'http://runtime',
      runtimeToken: 'tok',
      consumer,
      fetchImpl,
      // The injected invoker wins; connectorUrl is deliberately absent.
      invokeConnector: async (_grant, payload) => {
        capturedPayloads.push(payload as ConnectorInvocationPayload);
        return succeeded(invId);
      },
      tempSweep: { enabled: false },
    });
    await push({
      contractVersion: '1',
      deliveryId: `d-${randomUUID()}`,
      taskId: TASK_ID,
      operationId: OP_ID,
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'root',
      correlationId: 'corr-p407',
    });
    await handle.stop(1000);

    expect(capturedPayloads).toHaveLength(1);
    const payload = capturedPayloads[0]!;
    expect(payload.invocationId).toBe(invId);
    expect(payload.grant).toBe(`signed-${invId}`);
    expect(payload.bindingSlot).toBe(SLOT);
    expect(payload.deadlineAt).toBe(OPEN_DEADLINE_SENTINEL);
    expect(ledger.issued[0]!.invocationId).toBe(invId);
    const claim = calls.find((c) => c.path.endsWith('/claim'));
    expect(claim?.body).toMatchObject({ businessId: 'test-biz' });
    const complete = calls.find((c) => c.path.endsWith('/complete'));
    expect(complete).toBeDefined();
  });
});
