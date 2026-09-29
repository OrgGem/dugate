import {
  ClaimResultSchema,
  SaveStepRequestSchema,
  SpawnChildrenRequestSchema,
  UsageIngestBatchSchema,
  InvocationRequestSchema,
  InvocationArtifactContentSchema,
  CONNECTOR_ARTIFACT_MAX_BYTES,
  InvocationResponseSchema,
  SubmissionSchema,
  ResultEnvelopeSchema,
  WebhookPayloadSchema,
  OperationViewSchema,
  TaskDispositionSchema,
  LEASE_DEFAULTS,
} from '../src';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('runtime API DTOs (docs 07)', () => {
  const claimResult = {
    taskId: uuid(1),
    operationId: uuid(2),
    leaseEpoch: 3,
    leaseExpiresAt: '2026-09-20T12:01:00Z',
    attempt: 1,
    deadlineAt: '2026-09-20T12:30:00Z',
    executionSnapshot: {
      operationId: uuid(2),
      tenantId: 'tenant-default',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      schemaDigest: 'sha256:' + 'a'.repeat(64),
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      resolvedInputRef: { type: 'invoice' },
      pinned: { profileRevision: 4, promptRevisions: {}, connectorBindings: { reasoning: 'acme-llm@7' } },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: '2026-09-20T12:30:00Z',
      cancelRequested: false,
    },
    checkpointRefs: [],
  };

  it('accepts a well-formed ClaimResult with defaults applied', () => {
    const parsed = ClaimResultSchema.parse(claimResult);
    expect(parsed.checkpointRefs).toEqual([]);
    expect(parsed.executionSnapshot.pinned.promptRevisions).toEqual({});
  });

  it('rejects leaseEpoch < 1 (epochs are monotonic from 1)', () => {
    expect(ClaimResultSchema.safeParse({ ...claimResult, leaseEpoch: 0 }).success).toBe(false);
  });

  it('rejects missing executionSnapshot fields', () => {
    const bad = { ...claimResult, executionSnapshot: { ...claimResult.executionSnapshot, pinned: undefined } };
    expect(ClaimResultSchema.safeParse(bad).success).toBe(false);
  });

  it('SaveStep requires leaseEpoch + inputHash + outputRef (RUN-04 full output ref)', () => {
    const ok = SaveStepRequestSchema.safeParse({
      leaseEpoch: 5,
      inputHash: 'sha256:' + 'c'.repeat(64),
      outputRef: 'artifact://' + uuid(9),
      status: 'SUCCEEDED',
    });
    expect(ok.success).toBe(true);
    expect(SaveStepRequestSchema.safeParse({ leaseEpoch: 5 }).success).toBe(false);
  });

  it('SpawnChildren enforces v1 join policy all-success and non-empty children', () => {
    const ok = SpawnChildrenRequestSchema.safeParse({
      leaseEpoch: 2,
      children: [
        { taskKey: 'item-1', kind: 'review-item', payloadRef: { n: 1 }, payloadHash: 'sha256:' + 'd'.repeat(64) },
      ],
      joinPolicy: 'all-success',
      continuationRef: 'cont-1',
    });
    expect(ok.success).toBe(true);
    expect(
      SpawnChildrenRequestSchema.safeParse({
        leaseEpoch: 2,
        children: [],
        joinPolicy: 'all-success',
        continuationRef: 'c',
      }).success
    ).toBe(false);
    expect(
      SpawnChildrenRequestSchema.safeParse({
        leaseEpoch: 2,
        children: [{ taskKey: 'k', kind: 'x', payloadRef: {}, payloadHash: 'h' }],
        joinPolicy: 'any-success',
        continuationRef: 'c',
      }).success
    ).toBe(false);
  });

  it('lease defaults match docs 07 test values', () => {
    expect(LEASE_DEFAULTS.leaseMs).toBe(60_000);
    expect(LEASE_DEFAULTS.heartbeatIntervalMs).toBe(15_000);
  });
});

describe('usage ingestion (USE-01/02)', () => {
  const event = {
    eventId: 'evt-1',
    invocationId: 'inv-1',
    operationId: uuid(3),
    taskId: uuid(4),
    units: { inputTokens: 100, outputTokens: 50 },
    costMicrousd: 1234,
    measurement: 'measured',
    occurredAt: '2026-09-20T12:00:00Z',
  };

  it('accepts a batch and defaults currency/measurement fields', () => {
    const parsed = UsageIngestBatchSchema.parse({ events: [event] });
    expect(parsed.events[0]!.currency).toBe('USD');
    expect(parsed.events[0]!.costMicrousd).toBe(1234);
  });

  it('rejects empty batches and >500 events', () => {
    expect(UsageIngestBatchSchema.safeParse({ events: [] }).success).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ ...event, eventId: `evt-${i}` }));
    expect(UsageIngestBatchSchema.safeParse({ events: many }).success).toBe(false);
  });

  it('rejects negative token counts and float costs (integer micro-USD only)', () => {
    expect(
      UsageIngestBatchSchema.safeParse({
        events: [{ ...event, units: { inputTokens: -1, outputTokens: 0 } }],
      }).success
    ).toBe(false);
    expect(UsageIngestBatchSchema.safeParse({ events: [{ ...event, costMicrousd: 1.5 }] }).success).toBe(false);
  });
});

describe('connector invocation DTOs (docs 08)', () => {
  const request = {
    contractVersion: '1',
    invocationId: 'inv-runtime-1',
    grant: 'signed.token.value',
    operationId: uuid(5),
    taskId: uuid(6),
    stepKey: 'extract-invoice',
    bindingSlot: 'reasoning',
    input: {
      prompt: 'Extract fields.',
      artifacts: [{
        artifactId: uuid(7),
        fileName: 'scan.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
        storageVersionId: 'sha256:scan-v1',
        contentBase64: 'eA==',
      }],
    },
    options: { temperature: 0 },
    sessionRef: null,
    deadlineAt: '2026-09-20T12:05:00Z',
  };

  it('accepts a well-formed invocation request', () => {
    expect(InvocationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('rejects unknown fields in request and input (no credential smuggling)', () => {
    expect(InvocationRequestSchema.safeParse({ ...request, authorization: 'Bearer x' }).success).toBe(false);
    expect(
      InvocationRequestSchema.safeParse({ ...request, input: { ...request.input, apiKey: 'sk-' } }).success
    ).toBe(false);
  });

  it('accepts 200-style completed and 202-style pending responses', () => {
    const done = InvocationResponseSchema.safeParse({
      invocationId: 'inv-runtime-1',
      state: 'SUCCEEDED',
      result: { content: 'ok', sessionRef: null },
      usage: { inputTokens: 10, outputTokens: 5, costMicrousd: 100, measurement: 'measured' },
    });
    expect(done.success).toBe(true);
    const pending = InvocationResponseSchema.safeParse({
      invocationId: 'inv-runtime-1',
      state: 'PENDING',
      nextPollAt: '2026-09-20T12:01:00Z',
    });
    expect(pending.success).toBe(true);
  });

  it('rejects unknown invocation state', () => {
    expect(
      InvocationResponseSchema.safeParse({ invocationId: 'x', state: 'MAYBE' }).success
    ).toBe(false);
  });

  it('requires content identity, pinned version, bounded size and correctly sized base64 bytes', () => {
    const artifact = request.input.artifacts[0]!;
    expect(InvocationArtifactContentSchema.safeParse(artifact).success).toBe(true);
    expect(InvocationArtifactContentSchema.safeParse({ artifactId: uuid(7) }).success).toBe(false);
    expect(InvocationArtifactContentSchema.safeParse({ ...artifact, sizeBytes: 2 }).success).toBe(false);
    expect(InvocationArtifactContentSchema.safeParse({ ...artifact, sizeBytes: CONNECTOR_ARTIFACT_MAX_BYTES + 1 }).success).toBe(false);
  });
});

describe('public API DTOs (docs 06)', () => {
  it('Submission is strict: unknown top-level fields rejected', () => {
    const ok = SubmissionSchema.safeParse({
      input: { type: 'invoice' },
      artifacts: [{ artifactId: uuid(1), role: 'source' }],
      clientReference: 'invoice-123',
    });
    expect(ok.success).toBe(true);
    expect(SubmissionSchema.safeParse({ input: {}, queue: 'du-business-x' }).success).toBe(false);
  });

  it('ResultEnvelope requires schemaVersion 1 and usage', () => {
    const ok = ResultEnvelopeSchema.safeParse({
      schemaVersion: '1',
      data: { total: 42 },
      usage: { inputTokens: 1, outputTokens: 2, costMicrousd: 3, measurement: 'measured' },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.artifacts).toEqual([]);
      expect(ok.data.warnings).toEqual([]);
    }
    expect(ResultEnvelopeSchema.safeParse({ schemaVersion: '2', data: {}, usage: {} }).success).toBe(false);
  });

  it('OperationView round-trips', () => {
    const view = {
      id: uuid(8),
      tenantId: 'tenant-default',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      state: 'ACCEPTED',
      stateVersion: 1,
      createdAt: '2026-09-20T12:00:00Z',
      updatedAt: '2026-09-20T12:00:00Z',
      deadlineAt: null,
      progress: { percent: 0, message: 'Accepted' },
      links: { self: `/api/v1/operations/${uuid(8)}`, result: `/api/v1/operations/${uuid(8)}/result` },
    };
    const parsed = OperationViewSchema.parse(view);
    expect(OperationViewSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('webhook payload is strict with known event types only', () => {
    const ok = WebhookPayloadSchema.safeParse({
      deliveryId: 'dlv-1',
      eventType: 'operation.succeeded',
      operationId: uuid(9),
      state: 'SUCCEEDED',
      stateVersion: 7,
      occurredAt: '2026-09-20T12:10:00Z',
    });
    expect(ok.success).toBe(true);
    expect(
      WebhookPayloadSchema.safeParse({
        deliveryId: 'dlv-1',
        eventType: 'operation.weird',
        operationId: uuid(9),
        state: 'SUCCEEDED',
        stateVersion: 7,
        occurredAt: '2026-09-20T12:10:00Z',
      }).success
    ).toBe(false);
  });
});

describe('SDK task dispositions (docs 09)', () => {
  it('accepts all four disposition kinds', () => {
    expect(TaskDispositionSchema.safeParse({ kind: 'completed', resultRef: 'artifact://x' }).success).toBe(true);
    expect(TaskDispositionSchema.safeParse({ kind: 'waiting-children' }).success).toBe(true);
    expect(TaskDispositionSchema.safeParse({ kind: 'waiting-input', waitId: 'w-1' }).success).toBe(true);
    expect(TaskDispositionSchema.safeParse({ kind: 'retry-scheduled' }).success).toBe(true);
  });

  it('rejects unknown disposition kind', () => {
    expect(TaskDispositionSchema.safeParse({ kind: 'partially-done' }).success).toBe(false);
  });

  it('completed requires resultRef; waiting-input requires waitId', () => {
    expect(TaskDispositionSchema.safeParse({ kind: 'completed' }).success).toBe(false);
    expect(TaskDispositionSchema.safeParse({ kind: 'waiting-input' }).success).toBe(false);
  });
});
