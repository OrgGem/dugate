import { ConnectorError } from '../errors';
import { assertSafeMapping, writeMapped } from './mapping';
import { decodeVerifiedArtifact } from '../artifact-content';
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
    const artifacts = request.input.artifacts ?? [];
    for (const artifact of artifacts) decodeVerifiedArtifact(artifact);
    const source = { input: request.input, options: request.options ?? {}, sessionRef: request.sessionRef ?? null };
    const body = writeMapped({}, config.requestMapping ?? {
      prompt: 'input.prompt',
      text: 'input.text',
      task: 'input.task',
      language: 'input.language',
      artifacts: 'input.artifacts',
      outputSchema: 'input.outputSchema',
      options: 'options',
      sessionRef: 'sessionRef',
    }, source);
    // A custom mapping can rename ordinary prompt fields, but it cannot omit
    // the authorized document bytes from an OCR/vision request.
    if (artifacts.length > 0) body.artifacts = artifacts;
    if (request.input.task !== undefined) body.task = request.input.task;
    if (request.input.language !== undefined) body.language = request.input.language;
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
    // A 4xx means the provider received the request and refused it — typically an
    // unknown task discriminator, a rejected schema or auth it will never accept.
    // It must not share a code with a 200 whose body does not match the contract:
    // those two failures are opposites, and collapsing them sent operators looking
    // at the provider instead of at the request that was built wrong.
    if (response.status >= 400) return 'PROVIDER_REQUEST_REJECTED';
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
    if (request.input.task !== undefined) form.set('task', request.input.task);
    if (request.input.language !== undefined) form.set('language', request.input.language);
    form.set('options', JSON.stringify(request.options ?? {}));
    if (request.sessionRef) form.set('sessionRef', request.sessionRef);
    const artifacts = request.input.artifacts ?? [];
    if (artifacts.length > 0) {
      const metadata = [] as Array<Omit<(typeof artifacts)[number], 'contentBase64'>>;
      for (const artifact of artifacts) {
        const bytes = decodeVerifiedArtifact(artifact);
        const body = new Blob([new Uint8Array(bytes)], { type: artifact.mimeType });
        form.append('artifacts', body, artifact.fileName);
        const { contentBase64: _contentBase64, ...descriptor } = artifact;
        metadata.push(descriptor);
      }
      form.set('artifactMetadata', JSON.stringify(metadata));
    }
    return {
      url: joinUrl(config.baseUrl, config.path),
      method: 'POST',
      headers: { ...(config.headers ?? {}), 'Idempotency-Key': request.invocationId },
      body: form,
    };
  },
};
