import {
  CONNECTOR_ARTIFACT_MAX_BYTES,
  CONNECTOR_ARTIFACT_MAX_COUNT,
  InvocationArtifactContentSchema,
  InvocationInputSchema,
  InvocationRequestSchema,
  type InvocationInput,
} from '@du/contracts';
import type { ConnectorInvokeInput } from '../src';

const artifact = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  fileName: 'scan.txt',
  mimeType: 'text/plain',
  sizeBytes: 1,
  sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
  storageVersionId: 'sha256:scan-v1',
  contentBase64: 'eA==',
};

const wireInput: InvocationInput = {
  prompt: 'Summarize this document',
  text: 'fixture text',
  artifacts: [artifact],
  outputSchema: { type: 'object' },
};

const request = {
  contractVersion: '1',
  invocationId: 'inv-runtime-1',
  grant: 'signed.token.value',
  operationId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  stepKey: 'extract-document',
  bindingSlot: 'reasoning',
  input: wireInput,
  options: { temperature: 0, maxTokens: 1 },
  sessionRef: null,
  deadlineAt: '2026-09-20T12:05:00Z',
};

function artifactWithId(index: number) {
  return {
    ...artifact,
    artifactId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  };
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function withOwnKey(value: Record<string, unknown>, key: string, entry: unknown): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(value), [key, entry]]);
}

test('worker-sdk connector input aliases the canonical wire input', () => {
  const sdkInput: ConnectorInvokeInput = wireInput;

  expect(sdkInput).toEqual(wireInput);
  expect(InvocationInputSchema.safeParse(sdkInput).success).toBe(true);
});

describe('connector invocation input contract rejection', () => {
  it.each([
    'contractVersion',
    'invocationId',
    'grant',
    'operationId',
    'taskId',
    'stepKey',
    'bindingSlot',
    'input',
    'deadlineAt',
  ])('rejects an invocation request missing required field %s', (field) => {
    expect(InvocationRequestSchema.safeParse(withoutKey(request, field)).success).toBe(false);
  });

  it('rejects an empty binding slot', () => {
    expect(InvocationRequestSchema.safeParse({ ...request, bindingSlot: '' }).success).toBe(false);
  });

  it.each([' \t', '../admin\r\nAuthorization: injected'])(
    'documents that the current schema accepts non-empty whitespace or hostile binding slots (%s)',
    (bindingSlot) => {
      expect(InvocationRequestSchema.safeParse({ ...request, bindingSlot }).success).toBe(true);
    },
  );

  it.each(['not-an-ISO-date', '2020-01-01T00:00:00Z', '2999-01-01T00:00:00Z'])(
    'documents that the current schema accepts deadline string without date or skew validation (%s)',
    (deadlineAt) => {
      expect(InvocationRequestSchema.safeParse({ ...request, deadlineAt }).success).toBe(true);
    },
  );

  it.each([
    ['negative temperature', -0.01],
    ['NaN temperature', Number.NaN],
  ])('rejects %s', (_caseName, temperature) => {
    expect(InvocationRequestSchema.safeParse({ ...request, options: { temperature } }).success).toBe(false);
  });

  it('accepts fractional temperatures within the supported numeric range', () => {
    expect(InvocationRequestSchema.safeParse({ ...request, options: { temperature: 0.25 } }).success).toBe(true);
  });

  it.each([0, -1])('rejects maxTokens at or below zero (%s)', (maxTokens) => {
    expect(InvocationRequestSchema.safeParse({ ...request, options: { maxTokens } }).success).toBe(false);
  });

  it('documents that the current schema has no upper bound for positive integer maxTokens', () => {
    expect(InvocationRequestSchema.safeParse({ ...request, options: { maxTokens: Number.MAX_SAFE_INTEGER } }).success).toBe(true);
  });

  it.each(['x'.repeat(257), 'session\u0000ref'])(
    'documents that the current schema accepts session references without length or control-character checks (%s)',
    (sessionRef) => {
      expect(InvocationRequestSchema.safeParse({ ...request, sessionRef }).success).toBe(true);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects an unexpected own %s key without polluting Object.prototype',
    (key) => {
      const input = withOwnKey(wireInput, key, { polluted: true });
      const envelope = withOwnKey(request, key, { polluted: true });

      expect(InvocationInputSchema.safeParse(input).success).toBe(false);
      expect(InvocationRequestSchema.safeParse({ ...request, input }).success).toBe(false);
      expect(InvocationRequestSchema.safeParse(envelope).success).toBe(false);
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    },
  );

  it('rejects an artifact above the per-artifact byte limit before accepting the input', () => {
    const oversizedInput = {
      ...wireInput,
      artifacts: [{ ...artifact, sizeBytes: CONNECTOR_ARTIFACT_MAX_BYTES + 1 }],
    };
    const parsed = InvocationInputSchema.safeParse(oversizedInput);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'artifacts.0.sizeBytes')).toBe(true);
    }
  });

  it('accepts the artifact-count boundary and rejects one extra artifact', () => {
    const atLimit = {
      ...wireInput,
      artifacts: Array.from({ length: CONNECTOR_ARTIFACT_MAX_COUNT }, (_, index) => artifactWithId(index + 1)),
    };
    const overLimit = {
      ...wireInput,
      artifacts: Array.from({ length: CONNECTOR_ARTIFACT_MAX_COUNT + 1 }, (_, index) => artifactWithId(index + 1)),
    };

    expect(InvocationInputSchema.safeParse(atLimit).success).toBe(true);
    expect(InvocationInputSchema.safeParse(overLimit).success).toBe(false);
  });

  it.each([
    ['missing MIME separator', 'textplain'],
    ['embedded CRLF header injection', 'text/plain\r\nAuthorization: Bearer injected'],
    ['whitespace in MIME token', 'text /plain'],
    ['MIME type longer than its bound', `${'a'.repeat(63)}/${'b'.repeat(64)}`],
  ])('rejects an artifact with %s', (_caseName, mimeType) => {
    expect(InvocationArtifactContentSchema.safeParse({ ...artifact, mimeType }).success).toBe(false);
  });

  it('accepts a syntactically valid MIME type at the 127-character header boundary', () => {
    const boundaryMimeType = `${'a'.repeat(63)}/${'b'.repeat(63)}`;

    expect(boundaryMimeType).toHaveLength(127);
    expect(InvocationArtifactContentSchema.safeParse({ ...artifact, mimeType: boundaryMimeType }).success).toBe(true);
  });

  it('rejects headers injected into the request or connector input payload', () => {
    expect(InvocationRequestSchema.safeParse({
      ...request,
      headers: { authorization: 'Bearer injected' },
    }).success).toBe(false);
    expect(InvocationRequestSchema.safeParse({
      ...request,
      input: { ...wireInput, headers: { authorization: 'Bearer injected' } },
    }).success).toBe(false);
  });

  it.each([
    ['malformed operation UUID', { ...request, operationId: 'not-a-uuid' }],
    ['empty step key', { ...request, stepKey: '' }],
    ['empty connector task parameter', { ...request, input: { ...wireInput, task: '' } }],
    ['temperature above maximum', { ...request, options: { temperature: 2.01 } }],
    ['fractional maxTokens', { ...request, options: { maxTokens: 1.5 } }],
    ['non-string session reference', { ...request, sessionRef: 42 }],
    ['non-string deadline', { ...request, deadlineAt: 123 }],
  ])('rejects %s', (_caseName, malformedRequest) => {
    expect(InvocationRequestSchema.safeParse(malformedRequest).success).toBe(false);
  });

  it.each([
    ['null input', { ...request, input: null }],
    ['array input', { ...request, input: [] }],
    ['non-array artifacts', { ...request, input: { ...wireInput, artifacts: {} } }],
    ['malformed artifact digest', {
      ...request,
      input: { ...wireInput, artifacts: [{ ...artifact, sha256: 'not-a-sha256' }] },
    }],
    ['array output schema', { ...request, input: { ...wireInput, outputSchema: [] } }],
  ])('rejects malformed connector payloads with %s', (_caseName, malformedRequest) => {
    expect(InvocationRequestSchema.safeParse(malformedRequest).success).toBe(false);
  });

  it.each(['run', 'delete-all'])(
    'rejects unsupported action type %s from the strict input contract',
    (action) => {
      expect(InvocationInputSchema.safeParse({ ...wireInput, action }).success).toBe(false);
      expect(InvocationRequestSchema.safeParse({ ...request, action }).success).toBe(false);
    },
  );

  it('accepts an omitted options object because the wire contract makes it optional', () => {
    const requestWithoutOptions = withoutKey(request, 'options');

    expect(InvocationRequestSchema.safeParse(requestWithoutOptions).success).toBe(true);
  });

  it.each([null, 'not-an-options-object', []])('rejects malformed options value %p', (options) => {
    expect(InvocationRequestSchema.safeParse({ ...request, options }).success).toBe(false);
  });

  it.each([
    ['task over its maximum length', { ...request, input: { ...wireInput, task: 't'.repeat(129) } }],
    ['BigInt maxTokens', { ...request, options: { maxTokens: BigInt(Number.MAX_SAFE_INTEGER) } }],
    ['infinite maxTokens', { ...request, options: { maxTokens: Number.POSITIVE_INFINITY } }],
    ['infinite temperature', { ...request, options: { temperature: Number.POSITIVE_INFINITY } }],
  ])('rejects oversized or non-finite parameter: %s', (_caseName, malformedRequest) => {
    expect(InvocationRequestSchema.safeParse(malformedRequest).success).toBe(false);
  });

  it('documents that the current schema accepts integer maxTokens above the safe-integer range', () => {
    expect(InvocationRequestSchema.safeParse({
      ...request,
      options: { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
    }).success).toBe(true);
  });

  it('characterizes JSON serialization failure for a schema-valid BigInt outputSchema value', () => {
    const requestWithBigInt = {
      ...request,
      input: { ...wireInput, outputSchema: { maximum: BigInt(Number.MAX_SAFE_INTEGER) } },
    };

    expect(InvocationRequestSchema.safeParse(requestWithBigInt).success).toBe(true);
    expect(() => JSON.stringify(requestWithBigInt)).toThrow(TypeError);
  });

  it('keeps a valid boundary request JSON serializable and contract-valid after round trip', () => {
    const encoded = JSON.stringify(request);
    const decoded: unknown = JSON.parse(encoded);

    expect(InvocationRequestSchema.safeParse(decoded).success).toBe(true);
  });
});
