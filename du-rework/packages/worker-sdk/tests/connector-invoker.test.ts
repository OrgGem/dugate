import { classifyFailure, ConnectorTransportError, createConnectorInvoker } from '../src';

const grant = {
  grant: 'signed-grant',
  invocationId: 'invocation-1',
  connectorId: 'connector-1',
  connectorRevision: 1,
  expiresAt: '2026-09-28T12:00:00.000Z',
  allowedOptions: {},
};

const payload = {
  contractVersion: '1' as const,
  invocationId: 'invocation-1',
  grant: 'signed-grant',
  operationId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  stepKey: 'summarize',
  bindingSlot: 'text-generation',
  input: { prompt: 'Summarize this fixture.' },
  deadlineAt: '2026-09-28T12:00:00.000Z',
};

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('createConnectorInvoker error contract', () => {
  it('adds the configured worker service identity to the Connector request', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = jest.fn(async (_input: unknown, init?: RequestInit) => {
      requestInit = init;
      return response(200, JSON.stringify({ invocationId: payload.invocationId, state: 'SUCCEEDED' }));
    }) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({
      baseUrl: 'http://connector',
      serviceToken: () => 'worker-signed-service-token',
      fetchImpl,
    });

    await invoke(grant, payload);

    expect(new Headers(requestInit?.headers).get('authorization')).toBe('Bearer worker-signed-service-token');
  });

  it.each([
    ['empty invocation ID', { ...payload, invocationId: '' }],
    ['malformed task ID', { ...payload, taskId: '../not-a-uuid' }],
    ['unexpected request field', { ...payload, authorization: 'attacker-controlled' }],
  ])('rejects a malformed invocation request (%s) before HTTP dispatch', async (_caseName, malformedPayload) => {
    const fetchImpl = jest.fn(async () => response(200, JSON.stringify({
      invocationId: payload.invocationId,
      state: 'SUCCEEDED',
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    await expect(invoke(grant, malformedPayload as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'GRANT_INVALID'],
    [403, 'BINDING_DENIED'],
  ] as const)('preserves service identity rejection %s %s without retry', async (status, code) => {
    const fetchImpl = jest.fn(async () => response(status, JSON.stringify({
      error: { code, message: 'Service identity denied.' },
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', serviceToken: 'expired-or-invalid', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status, code });
    expect(classifyFailure(error)).toMatchObject({ errorCode: code, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the 401 fallback for a corrupt authorization error payload without retry', async () => {
    const fetchImpl = jest.fn(async () => response(401, '{corrupt-auth-error')) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'GRANT_INVALID', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails before HTTP when the worker service-token provider throws', async () => {
    const fetchImpl = jest.fn(async () => response(200, '{}')) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({
      baseUrl: 'http://connector',
      serviceToken: () => { throw new Error('expired private credential'); },
      fetchImpl,
    });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect((error as Error).message).not.toContain('expired private credential');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('omits a whitespace-only authorization token and fails closed on the 401 response', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = jest.fn(async (_input: unknown, init?: RequestInit) => {
      requestInit = init;
      return response(401, JSON.stringify({ error: { code: 'NOT_AN_AUTH_CODE', message: 'bad token' } }));
    }) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', serviceToken: '   ', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(new Headers(requestInit?.headers).get('authorization')).toBeNull();
    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    'INPUT_HASH_MISMATCH',
    'CANCELLED',
    'CONNECTOR_DISABLED',
    'INVOCATION_UNKNOWN',
  ] as const)('preserves the Connector 409 code %s for runtime classification', async (code) => {
    const fetchImpl = jest.fn(async () => response(409, JSON.stringify({
      error: { code, message: 'Connector invocation conflict.' },
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    let caught: unknown;
    try {
      await invoke(grant, payload);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConnectorTransportError);
    expect(caught).toMatchObject({ status: 409, code });
    expect(classifyFailure(caught)).toMatchObject({ errorCode: code, retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['missing error envelope', JSON.stringify({ code: 'INPUT_HASH_MISMATCH' })],
    ['missing code', JSON.stringify({ error: { message: 'conflict' } })],
    ['missing error message', JSON.stringify({ error: { code: 'INPUT_HASH_MISMATCH' } })],
    ['unallowlisted connector code', JSON.stringify({ error: { code: 'PROVIDER_RATE_LIMITED', message: 'busy' } })],
  ])('fails closed as unknown for a 409 with %s', async (_caseName, body) => {
    const fetchImpl = jest.fn(async () => response(409, body)) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({
      name: 'ConnectorTransportError',
      status: 409,
      code: 'INVOCATION_UNKNOWN',
    });
    expect(classifyFailure(error)).toMatchObject({
      errorCode: 'INVOCATION_UNKNOWN',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a lost response to non-retryable unknown without leaking the transport error', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('socket reset: authorization=secret-token');
    }) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect((error as Error).message).not.toContain('secret-token');
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'INVOCATION_UNKNOWN', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps an unresolvable Connector endpoint to unknown without retrying or exposing DNS details', async () => {
    const fetchImpl = jest.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND private-connector-host'), { code: 'ENOTFOUND' });
    }) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector.invalid', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect((error as Error).message).not.toContain('private-connector-host');
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'INVOCATION_UNKNOWN', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an artifact ingress payload over 64 MiB before sending an HTTP request', async () => {
    // Keep the base64 character count aligned so schema validation rejects on
    // the contract's size bounds without triggering pathological regex backtracking.
    const oversizedBytes = 64 * 1024 * 1024 + 4;
    const oversizedPayload = {
      ...payload,
      input: {
        artifacts: [{
          artifactId: '00000000-0000-4000-8000-000000000003',
          fileName: 'oversized.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: oversizedBytes,
          sha256: 'a'.repeat(64),
          storageVersionId: 'oversized-version',
          contentBase64: 'A'.repeat(oversizedBytes),
        }],
      },
    };
    const fetchImpl = jest.fn(async () => response(200, JSON.stringify({
      invocationId: payload.invocationId,
      state: 'SUCCEEDED',
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    await expect(invoke(grant, oversizedPayload as never)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the timeout AbortController signal to a pending HTTP request and fails closed', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('pending request aborted')), { once: true });
      });
    }) as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl, timeoutMs: 20 });
    const error = await rejectedValue(invoke(grant, payload));

    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'INVOCATION_UNKNOWN', retryable: false });
  });

  it('fails closed for a non-JSON successful Connector response', async () => {
    const fetchImpl = jest.fn(async () => response(200, '<html>proxy error</html>')) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({
      name: 'ConnectorTransportError',
      status: 0,
      code: 'INVOCATION_UNKNOWN',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the Connector response body stream is corrupt', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error('corrupt response body')); },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({
      name: 'ConnectorTransportError',
      status: 0,
      code: 'INVOCATION_UNKNOWN',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a socket hangs up while the response body is being read', async () => {
    const socketReset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw socketReset; },
    } as unknown as Response)) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect((error as Error).message).not.toContain('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when streamed JSON chunks have invalid trailing frame bytes', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = jest.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"invocationId":"invocation-1","state":"SUCCEEDED"}'));
          controller.enqueue(encoder.encode('\u0000corrupt-frame'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [500, false],
    [502, false],
    [503, true],
    [504, false],
  ] as const)('reports the connector code at HTTP %s and applies retry classification %s', async (status, retryable) => {
    const fetchImpl = jest.fn(async () => response(status, JSON.stringify({
      error: { code: 'BINDING_DENIED', message: 'untrusted upstream detail' },
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    // The code is what the connector said happened; the status is the coarse HTTP
    // projection and stays what decides retry. Previously this collapsed to
    // PROVIDER_UNAVAILABLE, losing the real cause. The retry expectation is the part
    // that must NOT move, and it does not.
    expect(error).toMatchObject({ status, code: 'BINDING_DENIED' });
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'BINDING_DENIED', retryable });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves retries to the caller when a retryable response exhausts the adapter attempt budget', async () => {
    const fetchImpl = jest.fn(async () => response(503, JSON.stringify({
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'temporary outage' },
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' });
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores tampered problem headers and fails closed for malformed details with an invalid content type', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      error: { code: 'INPUT_HASH_MISMATCH', message: 12 },
    }), {
      status: 409,
      headers: {
        'content-type': 'text/html',
        'x-connector-error-code': 'INPUT_HASH_MISMATCH',
      },
    })) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 409, code: 'INVOCATION_UNKNOWN' });
    expect(classifyFailure(error)).toMatchObject({ errorCode: 'INVOCATION_UNKNOWN', retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps socket termination triggered at the timeout abort boundary to one unknown outcome', async () => {
    jest.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      let socketCloseEvents = 0;
      const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => {
            socketCloseEvents += 1;
            reject(new Error('socket closed when request timed out'));
          }, { once: true });
        });
      }) as typeof fetch;
      const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl, timeoutMs: 20 });
      const invocation = rejectedValue(invoke(grant, payload));

      await jest.advanceTimersByTimeAsync(20);
      const error = await invocation;

      expect(requestSignal?.aborted).toBe(true);
      expect(socketCloseEvents).toBe(1);
      expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed for an empty 200 response body', async () => {
    const fetchImpl = jest.fn(async () => response(200, '')) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    await expect(invoke(grant, payload)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a JSON response stream is truncated after a partial envelope', async () => {
    const fetchImpl = jest.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"invocationId":"invocation-1",'));
          controller.error(new Error('socket ended before the response completed'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });
    const error = await rejectedValue(invoke(grant, payload));

    expect(error).toMatchObject({ status: 0, code: 'INVOCATION_UNKNOWN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects negative artifact byte counts and oversized artifact header metadata before HTTP', async () => {
    const validArtifact = {
      artifactId: '00000000-0000-4000-8000-000000000004',
      fileName: 'fixture.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      storageVersionId: 'version-1',
      contentBase64: 'AQ==',
    };
    const invalidArtifacts = [
      { ...validArtifact, sizeBytes: -1 },
      { ...validArtifact, fileName: 'f'.repeat(256) },
      { ...validArtifact, mimeType: 'application/' + 'x'.repeat(120) },
      { ...validArtifact, storageVersionId: 'v'.repeat(1025) },
    ];
    const fetchImpl = jest.fn(async () => response(200, JSON.stringify({
      invocationId: payload.invocationId,
      state: 'SUCCEEDED',
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    for (const artifact of invalidArtifacts) {
      await expect(invoke(grant, {
        ...payload,
        input: { artifacts: [artifact] },
      } as never)).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject.');
}
