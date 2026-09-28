import { ConnectorError } from '../errors';
import { assertSafeMapping, writeMapped } from './mapping';
import type {
  AdapterConfig,
  LocalInvocationRequest,
  NormalizedProviderResult,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ConnectorErrorCode,
} from '../types';

function joinUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new ConnectorError('INVALID_INPUT', 'Provider URL scheme is not supported.');
  return url.toString();
}

function responseObject(response: ProviderResponse): Record<string, unknown> {
  if (response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider response must be an object.');
  }
  return response.body as Record<string, unknown>;
}

export const jsonHttpAdapter: ProviderAdapter = {
  id: 'json-http',
  mode: 'json',
  asyncPollingMode: 'idempotency-key-replay',
  buildRequest(request: LocalInvocationRequest, config: AdapterConfig): ProviderRequest {
    assertSafeMapping(config.requestMapping ?? {});
    const source = { input: request.input, options: request.options ?? {}, sessionRef: request.sessionRef ?? null };
    const body = writeMapped({}, config.requestMapping ?? {
      prompt: 'input.prompt',
      text: 'input.text',
      outputSchema: 'input.outputSchema',
      options: 'options',
      sessionRef: 'sessionRef',
    }, source);
    return {
      url: joinUrl(config.baseUrl, config.path),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.headers ?? {}),
        'Idempotency-Key': request.invocationId,
      },
      body: JSON.stringify(body),
    };
  },
  normalizeResponse(response: ProviderResponse, config: AdapterConfig): NormalizedProviderResult {
    const body = responseObject(response);
    const mapped = writeMapped({}, config.responseMapping ?? {
      content: 'content',
      data: 'data',
      artifacts: 'artifacts',
      sessionRef: 'sessionRef',
      usage: 'usage',
      providerRequestId: 'providerRequestId',
    }, body);
    if (typeof mapped.content !== 'undefined' && typeof mapped.content !== 'string') {
      throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider content must be a string.');
    }
    return mapped as NormalizedProviderResult;
  },
  classifyFailure(response: ProviderResponse | Error): ConnectorErrorCode {
    if (response instanceof Error) return 'PROVIDER_UNAVAILABLE';
    if (response.status === 429) return 'PROVIDER_RATE_LIMITED';
    if (response.status >= 500) return 'PROVIDER_UNAVAILABLE';
    return 'INVALID_PROVIDER_RESPONSE';
  },
};

export const multipartHttpAdapter: ProviderAdapter = {
  ...jsonHttpAdapter,
  id: 'multipart-http',
  mode: 'multipart',
  buildRequest(request, config): ProviderRequest {
    const form = new FormData();
    if (request.input.prompt) form.set('prompt', request.input.prompt);
    if (request.input.text) form.set('text', request.input.text);
    form.set('options', JSON.stringify(request.options ?? {}));
    if (request.sessionRef) form.set('sessionRef', request.sessionRef);
    return {
      url: joinUrl(config.baseUrl, config.path),
      method: 'POST',
      headers: { ...(config.headers ?? {}), 'Idempotency-Key': request.invocationId },
      body: form,
    };
  },
};
