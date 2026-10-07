import { hashInvocationInput as contractsHash } from '@du/contracts';
import {
  hashInvocationInput,
  jsonHttpAdapter,
  multipartHttpAdapter,
  parseContractInvocationRequest,
} from '../src';
import type { LocalInvocationRequest } from '../src';

/**
 * P745-CONNECTOR-PASSTHROUGH (T5): positive pin for the two living
 * passthrough keys along the chain — schema allowlist -> provider body
 * (json + multipart adapters) -> canonical invocation hash — and the
 * third-key contract (reject at the wire parse, so the provider body and the
 * hash can never carry an unknown key).
 */
const options = { responseFormat: 'json', jsonSchema: { type: 'object', required: ['total'] } } as const;

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'inv-p745-options',
  tenantId: 'tenant-1',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract-document',
  bindingSlot: 'reasoning',
  input: { prompt: 'extract', task: 'extract_custom' },
  options: { ...options },
  sessionRef: null,
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

function wireEnvelope(withOptions: unknown): unknown {
  return {
    contractVersion: '1',
    invocationId: 'inv-p745-options',
    grant: 'signed.token.value',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract-document',
    bindingSlot: 'reasoning',
    input: { prompt: 'extract' },
    options: withOptions,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };
}

describe('P745 connector options passthrough to provider body + canonical hash', () => {
  test('json adapter forwards responseFormat/jsonSchema into the provider body verbatim', () => {
    const built = jsonHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/infer',
      timeoutMs: 1000,
    });

    const body = JSON.parse(built.body as string) as { options?: unknown };
    expect(body.options).toStrictEqual({
      responseFormat: 'json',
      jsonSchema: { type: 'object', required: ['total'] },
    });
  });

  test('multipart adapter forwards responseFormat/jsonSchema in the options form field', () => {
    const built = multipartHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/ocr',
      timeoutMs: 1000,
    });

    const form = built.body as FormData;
    expect(JSON.parse(form.get('options') as string)).toStrictEqual({
      responseFormat: 'json',
      jsonSchema: { type: 'object', required: ['total'] },
    });
  });

  test('responseFormat/jsonSchema participate in the canonical invocation hash', () => {
    const withoutOptions: LocalInvocationRequest = { ...request };
    delete withoutOptions.options;
    const otherSchema: LocalInvocationRequest = {
      ...request,
      options: { responseFormat: 'json', jsonSchema: { type: 'array' } },
    };

    expect(hashInvocationInput(request)).not.toBe(hashInvocationInput(withoutOptions));
    expect(hashInvocationInput(request)).not.toBe(hashInvocationInput(otherSchema));
    expect(hashInvocationInput(request)).toBe(contractsHash({
      contractVersion: request.contractVersion,
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      bindingSlot: request.bindingSlot,
      input: request.input,
      options: request.options,
      sessionRef: request.sessionRef,
      deadlineAt: request.deadlineAt,
    }));
  });

  test('inbound wire parse keeps exactly the allowlisted keys', () => {
    const parsed = parseContractInvocationRequest(wireEnvelope({ ...options }));

    expect(parsed.options).toStrictEqual({
      responseFormat: 'json',
      jsonSchema: { type: 'object', required: ['total'] },
    });
  });

  test('inbound wire parse rejects an unknown third option key', () => {
    expect(() => parseContractInvocationRequest(
      wireEnvelope({ responseFormat: 'json', unexpectedOption: true }),
    )).toThrow();
  });
});
