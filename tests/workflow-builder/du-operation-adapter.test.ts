// tests/workflow-builder/du-operation-adapter.test.ts
// Unit tests for the Workflow Builder DU Rework Operation adapter.
// Covers: mapping (workflow → DU submission), payload hashing / idempotency,
// error propagation, and mock polling transitions through the canonical
// DU Rework OperationView state machine.

import {
  DU_OPERATIONS_ENDPOINT,
  DU_TERMINAL_STATES,
  isTerminalState,
  mapWorkflowRunToSubmission,
  computeIdempotencyKey,
  submitDuOperation,
  pollDuOperation,
  pollUntilTerminal,
  type DuFetcher,
  type DuOperationView,
  type WorkflowBuilderRunInput,
} from '../../app/workflow-builder/du-operation-adapter';

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fetcherFor(responses: Response[]): DuFetcher {
  let i = 0;
  return (async () => {
    const r = responses[i++];
    if (!r) throw new Error('mock fetch called too many times');
    return r;
  }) as unknown as DuFetcher;
}

function viewFixture(overrides: Partial<DuOperationView> = {}): DuOperationView {
  return {
    id: 'op-uuid-1',
    tenantId: 'tenant-a',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    state: 'RUNNING',
    stateVersion: 1,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    deadlineAt: null,
    progress: { percent: 25, message: 'working' },
    links: { self: '/api/v1/operations/op-uuid-1', result: '/api/v1/operations/op-uuid-1/result' },
    ...overrides,
  };
}

describe('DU Operation adapter — mapping & idempotency', () => {
  const sampleRun: WorkflowBuilderRunInput = {
    workflowSlug: 'disbursement',
    inputs: { resolution_data: '01', limit_amount: 5000000 },
  };

  it('maps workflowSlug → businessId and defaults action to "run"', () => {
    const sub = mapWorkflowRunToSubmission(sampleRun);
    expect(sub.businessId).toBe('disbursement');
    expect(sub.action).toBe('run');
    expect(sub.input).toEqual({ resolution_data: '01', limit_amount: 5000000 });
    expect(sub.idempotencyKey).toBeDefined();
    expect(typeof sub.idempotencyKey).toBe('string');
  });

  it('honors explicit businessId / action overrides', () => {
    const sub = mapWorkflowRunToSubmission(sampleRun, {
      businessId: 'document-core',
      action: 'analyze',
    });
    expect(sub.businessId).toBe('document-core');
    expect(sub.action).toBe('analyze');
  });

  it('encodes files into input.files when present', () => {
    const sub = mapWorkflowRunToSubmission({
      workflowSlug: 'disbursement',
      inputs: { x: 1 },
      files: [
        { name: 'a.pdf', size: 100, mime: 'application/pdf' },
        { name: 'b.pdf', size: 200, mime: 'application/pdf' },
      ],
    });
    expect(sub.input.files).toEqual([
      { name: 'a.pdf', size: 100, mime: 'application/pdf' },
      { name: 'b.pdf', size: 200, mime: 'application/pdf' },
    ]);
  });

  it('skips idempotencyKey when useDeterministicKey is false', () => {
    const sub = mapWorkflowRunToSubmission(sampleRun, { useDeterministicKey: false });
    expect(sub.idempotencyKey).toBeUndefined();
  });

  it('produces a deterministic idempotencyKey independent of input key order', () => {
    const a = mapWorkflowRunToSubmission({
      workflowSlug: 'disbursement',
      inputs: { a: 1, b: 2, c: 3 },
    });
    const b = mapWorkflowRunToSubmission({
      workflowSlug: 'disbursement',
      inputs: { c: 3, b: 2, a: 1 },
    });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different idempotencyKeys for different inputs', () => {
    const a = mapWorkflowRunToSubmission({
      workflowSlug: 'disbursement',
      inputs: { x: 1 },
    });
    const b = mapWorkflowRunToSubmission({
      workflowSlug: 'disbursement',
      inputs: { x: 2 },
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('computeIdempotencyKey accepts a pre-mapped submission directly', () => {
    const sub = mapWorkflowRunToSubmission(sampleRun, { useDeterministicKey: false });
    expect(sub.idempotencyKey).toBeUndefined();
    const key = computeIdempotencyKey(sub);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(computeIdempotencyKey(sub));
  });
});

describe('DU Operation adapter — submit', () => {
  const submission = mapWorkflowRunToSubmission(
    { workflowSlug: 'document-core', inputs: { file: 'doc.pdf' } },
    { action: 'extract' },
  );

  it('returns DuSubmitCreated on a 202 with parseable operation id', async () => {
    const fetcher = fetcherFor([mockResponse(202, {
      id: 'op-uuid-1',
      state: 'ACCEPTED',
      links: { self: '/api/v1/operations/op-uuid-1', result: '/api/v1/operations/op-uuid-1/result' },
    })]);
    const outcome = await submitDuOperation(submission, fetcher);
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(202);
    expect(outcome.created).toBeDefined();
    expect(outcome.created?.operationId).toBe('op-uuid-1');
    expect(outcome.created?.selfLink).toBe('/api/v1/operations/op-uuid-1');
    expect(outcome.created?.initialState).toBe('ACCEPTED');
  });

  it('accepts body {operationId} as a fallback (legacy wrapper shape)', async () => {
    const fetcher = fetcherFor([mockResponse(202, { operationId: 'op-uuid-2' })]);
    const outcome = await submitDuOperation(submission, fetcher);
    expect(outcome.ok).toBe(true);
    expect(outcome.created?.operationId).toBe('op-uuid-2');
  });

  it('returns rejection with ProblemDetails.detail on a 400/422', async () => {
    const fetcher = fetcherFor([mockResponse(422, {
      type: 'https://dugate.vn/errors/business-validation',
      title: 'Business Validation',
      status: 422,
      detail: "Field 'file' is required for action 'extract'.",
    })]);
    const outcome = await submitDuOperation(submission, fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(422);
    expect(outcome.detail).toBe("Field 'file' is required for action 'extract'.");
    expect(outcome.title).toBe('Business Validation');
  });

  it('returns HTTP <status> fallback when the rejection body is malformed', async () => {
    const fetcher = fetcherFor([{
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    } as unknown as Response]);
    const outcome = await submitDuOperation(submission, fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(500);
    expect(outcome.detail).toBe('HTTP 500');
  });

  it('returns ok=false / status=0 when the fetcher rejects (network error)', async () => {
    const fetcher: DuFetcher = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as DuFetcher;
    const outcome = await submitDuOperation(submission, fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(0);
    expect(outcome.detail).toBe('Lỗi kết nối');
  });

  it('POSTs to the DU operations endpoint with JSON body and the idempotency key', async () => {
    let capturedUrl: string | null = null;
    let capturedInit: RequestInit | null = null;
    const fetcher: DuFetcher = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init ?? null;
      return mockResponse(202, { id: 'op-uuid-x', state: 'ACCEPTED' });
    }) as DuFetcher;

    await submitDuOperation(submission, fetcher);
    expect(capturedUrl).toBe(DU_OPERATIONS_ENDPOINT);
    const init = capturedInit as RequestInit | null;
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body.businessId).toBe(submission.businessId);
    expect(body.action).toBe(submission.action);
    expect(body.input).toEqual(submission.input);
    expect(body.idempotencyKey).toBe(submission.idempotencyKey);
  });
});

describe('DU Operation adapter — poll & state machine', () => {
  it('isTerminalState recognizes the four canonical DU terminal states', () => {
    for (const s of DU_TERMINAL_STATES) {
      expect(isTerminalState(s)).toBe(true);
    }
    for (const s of ['ACCEPTED', 'QUEUED', 'RUNNING', 'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING', 'CANCEL_REQUESTED']) {
      expect(isTerminalState(s)).toBe(false);
    }
  });

  it('pollDuOperation decodes a RUNNING OperationView and reports terminal=false', async () => {
    const fetcher = fetcherFor([mockResponse(200, viewFixture({ state: 'RUNNING', progress: { percent: 50 } }))]);
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.ok).toBe(true);
    expect(outcome.view?.state).toBe('RUNNING');
    expect(outcome.view?.progress.percent).toBe(50);
    expect(outcome.terminal).toBe(false);
  });

  it('pollDuOperation marks SUCCEEDED as terminal', async () => {
    const fetcher = fetcherFor([mockResponse(200, viewFixture({ state: 'SUCCEEDED', progress: { percent: 100 } }))]);
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.ok).toBe(true);
    expect(outcome.view?.state).toBe('SUCCEEDED');
    expect(outcome.terminal).toBe(true);
  });

  it('pollDuOperation marks FAILED as terminal with the error envelope preserved', async () => {
    const fetcher = fetcherFor([mockResponse(200, {
      ...viewFixture({ state: 'FAILED' }),
      error: { code: 'BUSINESS_RUNTIME', title: 'Business Runtime Error', detail: 'connector timeout' },
    })]);
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.terminal).toBe(true);
    expect(outcome.view?.state).toBe('FAILED');
  });

  it('pollDuOperation advances through ACCEPTED → RUNNING → WAITING_INPUT → SUCCEEDED across multiple polls', async () => {
    const fetcher = fetcherFor([
      mockResponse(200, viewFixture({ state: 'ACCEPTED', stateVersion: 0 })),
      mockResponse(200, viewFixture({ state: 'RUNNING', stateVersion: 1, progress: { percent: 30 } })),
      mockResponse(200, viewFixture({ state: 'WAITING_INPUT', stateVersion: 2 })),
      mockResponse(200, viewFixture({ state: 'SUCCEEDED', stateVersion: 3, progress: { percent: 100 } })),
    ]);
    const a = await pollDuOperation('op-uuid-1', fetcher);
    expect(a.view?.state).toBe('ACCEPTED');
    expect(a.terminal).toBe(false);
    const b = await pollDuOperation('op-uuid-1', fetcher);
    expect(b.view?.state).toBe('RUNNING');
    const c = await pollDuOperation('op-uuid-1', fetcher);
    expect(c.view?.state).toBe('WAITING_INPUT');
    const d = await pollDuOperation('op-uuid-1', fetcher);
    expect(d.view?.state).toBe('SUCCEEDED');
    expect(d.terminal).toBe(true);
  });

  it('pollDuOperation returns ProblemDetails on a 404', async () => {
    const fetcher = fetcherFor([mockResponse(404, {
      type: 'https://dugate.vn/errors/not-found',
      title: 'Not Found',
      status: 404,
      detail: "Operation 'op-uuid-1' not found.",
    })]);
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(404);
    expect(outcome.detail).toBe("Operation 'op-uuid-1' not found.");
    expect(outcome.title).toBe('Not Found');
  });

  it('pollDuOperation returns network error on a rejected fetcher', async () => {
    const fetcher: DuFetcher = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as DuFetcher;
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(0);
    expect(outcome.detail).toBe('Lỗi kết nối');
  });

  it('pollDuOperation rejects bodies that are not a valid OperationView', async () => {
    const fetcher = fetcherFor([mockResponse(200, { id: 'op-uuid-1' /* missing required fields */ })]);
    const outcome = await pollDuOperation('op-uuid-1', fetcher);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/OperationView/i);
  });

  it('pollUntilTerminal stops on the first terminal state', async () => {
    const fetcher = fetcherFor([
      mockResponse(200, viewFixture({ state: 'RUNNING', progress: { percent: 25 } })),
      mockResponse(200, viewFixture({ state: 'SUCCEEDED', stateVersion: 2, progress: { percent: 100 } })),
    ]);
    const outcome = await pollUntilTerminal('op-uuid-1', fetcher, { intervalMs: 0 });
    expect(outcome.terminal).toBe(true);
    expect(outcome.view?.state).toBe('SUCCEEDED');
  });

  it('pollUntilTerminal honors AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = fetcherFor([mockResponse(200, viewFixture({ state: 'RUNNING' }))]);
    const outcome = await pollUntilTerminal('op-uuid-1', fetcher, { signal: controller.signal });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/hủy/i);
  });

  it('pollUntilTerminal returns a max-attempts message after exhausting iterations', async () => {
    const fetcher = fetcherFor(Array.from({ length: 3 }, () =>
      mockResponse(200, viewFixture({ state: 'RUNNING', progress: { percent: 10 } })),
    ));
    const outcome = await pollUntilTerminal('op-uuid-1', fetcher, { maxAttempts: 3, intervalMs: 0 });
    expect(outcome.ok).toBe(true);
    expect(outcome.view?.state).toBe('RUNNING');
    expect(outcome.terminal).toBe(false);
  });
});
