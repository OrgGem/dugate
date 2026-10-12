import { AmbiguousReportError, RuntimeClient, RuntimeError } from '../src/runtime-client';

const ARTIFACT_ID = '00000000-0000-4000-8000-000000000001';

function client(fetchImpl: typeof fetch, timeoutMs = 1_000): RuntimeClient {
  return new RuntimeClient({
    baseUrl: 'http://runtime.test/api/runtime/v1',
    token: 'test-token',
    fetchImpl,
    timeoutMs,
  });
}

function abortArtifact(clientInstance: RuntimeClient): Promise<unknown> {
  return clientInstance.multipartAbort(ARTIFACT_ID, {
    leaseEpoch: 3,
    reason: 'failed',
  });
}

function pendingBodyResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => new Promise<string>(() => undefined),
  } as unknown as Response;
}

describe('RuntimeClient response deadlines and ambiguous writes (WOC-05)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps the deadline active through a slow body and settles before the full timeout', async () => {
    jest.useFakeTimers();
    let bodyRead = false;
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => {
        bodyRead = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return JSON.stringify({ artifactId: ARTIFACT_ID, state: 'ABORTED', replayed: false });
      },
    } as unknown as Response);

    const pending = abortArtifact(client(fetchImpl, 100));
    await jest.advanceTimersByTimeAsync(20);

    await expect(pending).resolves.toMatchObject({ artifactId: ARTIFACT_ID, state: 'ABORTED' });
    expect(bodyRead).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds a hanging body after headers and marks a write ACK as ambiguous', async () => {
    jest.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal;
      return pendingBodyResponse();
    };

    const pending = abortArtifact(client(fetchImpl, 25));
    const rejection = expect(pending).rejects.toBeInstanceOf(AmbiguousReportError);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchSignal).toBeDefined();
    await jest.advanceTimersByTimeAsync(26);

    await rejection;
    expect(fetchSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('consumes a late body rejection after timeout without an unhandled rejection', async () => {
    let rejectBody!: (reason: unknown) => void;
    const body = new Promise<string>((_resolve, reject) => {
      rejectBody = reject;
    });
    const fetchImpl: typeof fetch = async () => ({
      ok: true,
      status: 200,
      text: () => body,
    } as unknown as Response);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const pending = abortArtifact(client(fetchImpl, 20));
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await Promise.resolve();
      const outcome = await settled;
      expect('error' in outcome && outcome.error).toBeInstanceOf(AmbiguousReportError);

      rejectBody(new Error('late body stream failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
    }
  });

  it('treats a failed body read after a committed write as ambiguous without retrying it', async () => {
    let applications = 0;
    const fetchImpl: typeof fetch = async () => {
      applications += 1;
      return {
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('connection closed after server commit');
        },
      } as unknown as Response;
    };

    await expect(abortArtifact(client(fetchImpl))).rejects.toBeInstanceOf(AmbiguousReportError);
    expect(applications).toBe(1);
  });

  it('treats malformed JSON and schema-invalid successful write ACKs as ambiguous', async () => {
    for (const body of ['not-json', '{}']) {
      const fetchImpl: typeof fetch = async () => new Response(body, { status: 200 });
      await expect(abortArtifact(client(fetchImpl))).rejects.toBeInstanceOf(AmbiguousReportError);
    }
  });

  it('classifies HTML 5xx write responses as ambiguous before parsing the body', async () => {
    let bodyRead = false;
    const fetchImpl: typeof fetch = async () => ({
      ok: false,
      status: 502,
      text: async () => {
        bodyRead = true;
        return '<html>gateway failure</html>';
      },
    } as unknown as Response);

    await expect(abortArtifact(client(fetchImpl))).rejects.toBeInstanceOf(AmbiguousReportError);
    expect(bodyRead).toBe(false);
  });

  it.each([401, 403, 409, 410, 429])(
    'preserves authoritative HTTP %i denial when its body is invalid',
    async (status) => {
      const fetchImpl: typeof fetch = async () => new Response('<html>denied</html>', { status });

      const error = await abortArtifact(client(fetchImpl)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeError);
      expect(error).not.toBeInstanceOf(AmbiguousReportError);
      expect(error).toMatchObject({ status });
      expect((error as RuntimeError).isRetryable).toBe(status === 429);
      expect((error as RuntimeError).message).not.toContain('test-token');
    }
  );

  it('keeps a replay-safe malformed claim ACK typed and retryable with its HTTP status', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{', { status: 200 });
    const error = await client(fetchImpl)
      .claimTask('task-1', {
        deliveryId: 'delivery-1',
        workerInstanceId: 'worker-1',
        businessId: 'business-1',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).not.toBeInstanceOf(AmbiguousReportError);
    expect(error).toMatchObject({ status: 200, code: 'TEMPORARY_UNAVAILABLE' });
    expect((error as RuntimeError).isRetryable).toBe(true);
  });

  it('returns GET failures as typed retryable errors with the received HTTP status', async () => {
    const fetchImpl: typeof fetch = async () => new Response('not-json', { status: 503 });
    const runtime = client(fetchImpl);
    const request = runtime['request'] as (
      method: 'GET',
      path: string,
      body: unknown,
      parser: (raw: unknown) => unknown,
    ) => Promise<unknown>;

    const error = await request.call(runtime, 'GET', '/read', undefined, (raw) => raw).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect((error as RuntimeError).isRetryable).toBe(true);
  });

  it('aborts transport on caller cancellation and removes the caller abort listener', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const addListener = jest.spyOn(controller.signal, 'addEventListener');
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    let fetchSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal;
      return pendingBodyResponse();
    };
    const runtime = client(fetchImpl, 60_000);
    const pending = runtime.requestAccessGrant(
      ARTIFACT_ID,
      { mode: 'read', taskId: 'task-1', leaseEpoch: 3 },
      { signal: controller.signal }
    );
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await Promise.resolve();
    await Promise.resolve();

    const reason = new Error('caller cancelled request');
    controller.abort(reason);
    const outcome = await settled;
    const error = 'error' in outcome ? outcome.error : undefined;

    expect(error).toBeInstanceOf(AmbiguousReportError);
    expect((error as AmbiguousReportError).cause).toBe(reason);
    expect(fetchSignal?.aborted).toBe(true);
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });
});
