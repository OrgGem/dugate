import { randomUUID } from 'node:crypto';
import {
  defineBusiness,
  startWorker,
  QueueConsumer,
} from '@du/worker-sdk';
import {
  BusinessJobV1,
  ClaimResult,
  validateManifest,
  InvocationGrant,
  InvocationResponse,
} from '@du/contracts';
import {
  documentCoreManifest,
  documentCoreHandlers,
  documentCoreBusinessDefinition,
  startDocumentCoreWorker,
} from '../src';

interface Route {
  method: string;
  pattern: RegExp;
  handler: (m: RegExpMatchArray, body: unknown) => { status: number; json: unknown };
}

function stubFetch(routes: Route[], calls: { path: string; method: string; body?: unknown }[]) {
  return async (url: string, init?: { method?: string; body?: unknown }) => {
    const path = url.replace(/^http:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    // Body may be a JSON string (runtime calls) OR a web ReadableStream (the
    // uploadArtifactStream PUT since the ART-02 streaming work). Naive
    // JSON.parse(stream) threw SyntaxError and failed every artifact write.
    const rawBody = init?.body;
    let body: unknown;
    if (typeof rawBody === 'string') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    } else if (rawBody && typeof (rawBody as ReadableStream).getReader === 'function') {
      const reader = (rawBody as ReadableStream<Uint8Array>).getReader();
      let streamedBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) streamedBytes += value.byteLength;
      }
      body = { streamedBytes };
    } else if (rawBody != null) {
      body = { opaque: true };
    }
    calls.push({ path, method, body });
    for (const r of routes) {
      if (r.method === method) {
        const m = r.pattern.exec(path);
        if (m) {
          const res = r.handler(m, body);
          return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            statusText: res.status === 200 ? 'OK' : 'Error',
            json: async () => res.json,
            text: async () => JSON.stringify(res.json),
            arrayBuffer: async () => Buffer.from(JSON.stringify(res.json)),
          } as unknown as Response;
        }
      }
    }
    throw new Error(`stubFetch: unhandled route ${method} ${path}`);
  };
}

function testConsumer() {
  let handler: ((job: BusinessJobV1) => Promise<void>) | undefined;
  const deliveries: Promise<void>[] = [];
  const consumer: QueueConsumer = {
    start(h) {
      handler = h;
    },
    async stop() {
      await Promise.allSettled(deliveries);
    },
  };
  const push = (job: BusinessJobV1) => {
    if (!handler) throw new Error('consumer not started');
    const p = handler(job);
    deliveries.push(p);
    return p;
  };
  return { consumer, push };
}

describe('Worker-SDK Consumer Compatibility (WORKLOAD-REBALANCE-02)', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input?.toString?.() ?? '';
      if (urlStr.includes('/upload/')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({}),
          text: async () => '{}',
          arrayBuffer: async () => Buffer.from('{}'),
        };
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  describe('1. defineBusiness Registration & Validation (REG-04)', () => {
    it('manifest passes contract validation and registers all 9 declared handler kinds', () => {
      const validation = validateManifest(documentCoreManifest);
      expect(validation.ok).toBe(true);

      expect(documentCoreBusinessDefinition.manifest.businessId).toBe('document-core');
      expect(documentCoreBusinessDefinition.manifest.version).toBe('1.0.0');

      const declaredKinds = documentCoreManifest.runtime.handlerKinds;
      expect(declaredKinds).toEqual([
        'root',
        'ingest',
        'extract',
        'analyze',
        'transform',
        'generate',
        'compare',
        'disbursement',
        'doc-compare',
      ]);

      for (const kind of declaredKinds) {
        expect(typeof documentCoreBusinessDefinition.handlers[kind]).toBe('function');
      }
    });

    it('rejects business definition if a declared handler kind is missing (REG-04)', () => {
      const incompleteHandlers = { ...documentCoreHandlers };
      delete incompleteHandlers['root'];

      expect(() => {
        defineBusiness(documentCoreManifest, incompleteHandlers as any);
      }).toThrow(/missing handlers for declared kinds: root/);
    });

    it('rejects business definition if an undeclared handler kind is present (REG-04)', () => {
      const extraHandlers = {
        ...documentCoreHandlers,
        unknownAction: async () => ({ kind: 'completed' as const, resultRef: 'artifact://unknown' }),
      };

      expect(() => {
        defineBusiness(documentCoreManifest, extraHandlers as any);
      }).toThrow(/handlers for undeclared kinds: unknownAction/);
    });
  });

  describe('2. Injected QueueConsumer Delivery for All Six Actions', () => {
    interface ActionTestConfig {
      action: string;
      kind: string;
      input: Record<string, unknown>;
      mockConnectorData?: unknown;
    }

    const runActionDeliveryTest = async (config: ActionTestConfig) => {
      const taskId = randomUUID();
      const operationId = randomUUID();
      const calls: { path: string; method: string; body?: unknown }[] = [];
      let completedBody: any;
      let failedBody: any;

      const routes: Route[] = [
        {
          method: 'PUT',
          pattern: /^\/workers\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/claim$/,
          handler: () => ({
            status: 200,
            json: {
              taskId,
              operationId,
              leaseEpoch: 1,
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              attempt: 1,
              deadlineAt: null,
              executionSnapshot: {
                operationId,
                tenantId: 'tenant-test-sdk',
                businessId: 'document-core',
                businessVersion: '1.0.0',
                action: config.action,
                schemaDigest: 'digest-1',
                manifestDigest: 'digest-2',
                resolvedInputRef: config.input,
                pinned: { profilePolicy: null, profileRevision: 1, promptRevisions: {}, connectorBindings: { reasoning: 'mock-llm@1' } },
                taskKey: `task-${config.action}-1`,
                kind: config.kind,
                payloadRef: {},
                deadlineAt: null,
                cancelRequested: false,
              },
              checkpointRefs: [],
            } as ClaimResult,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/artifacts$/,
          handler: () => {
            const artId = randomUUID();
            return {
              status: 200,
              json: {
                artifactId: artId,
                storageKey: `key-${artId}`,
                uploadUrl: 'http://runtime/upload/blob',
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            };
          },
        },
        {
          method: 'PUT',
          pattern: /^\/upload\/blob$/,
          handler: () => ({ status: 200, json: {} }),
        },
        {
          method: 'POST',
          pattern: /^\/artifacts\/[^/]+\/finalize$/,
          handler: () => ({ status: 200, json: { artifactId: randomUUID(), status: 'FINALIZED' } }),
        },
        {
          method: 'PUT',
          pattern: /^\/tasks\/[^/]+\/steps\/[^/]+$/,
          handler: (m) => ({ status: 200, json: { stepKey: m[0], generation: 1, replayed: false } }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/invocation-grants$/,
          handler: () => ({
            status: 200,
            json: {
              grant: 'signed-grant-token',
              invocationId: 'inv-mock-1',
              connectorId: 'mock-connector',
              connectorRevision: 1,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              allowedOptions: {},
            } as InvocationGrant,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/invocations$/,
          handler: () => ({
            status: 200,
            json: {
              invocationId: 'inv-mock-1',
              state: 'SUCCEEDED',
              result: {
                data: config.mockConnectorData ?? { result: 'mock output' },
                content: typeof config.mockConnectorData === 'string' ? config.mockConnectorData : JSON.stringify(config.mockConnectorData ?? {}),
              },
              usage: { inputTokens: 50, outputTokens: 25, costMicrousd: 75, measurement: 'measured' },
            } as InvocationResponse,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/complete$/,
          handler: (_m, body) => {
            completedBody = body;
            return {
              status: 200,
              json: { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false },
            };
          },
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/fail$/,
          handler: (_m, body) => {
            failedBody = body;
            return {
              status: 200,
              json: { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false },
            };
          },
        },
      ];

      const { consumer, push } = testConsumer();

      const workerHandle = await startDocumentCoreWorker({
        runtimeUrl: 'http://runtime',
        runtimeToken: 'bearer-token-test',
        connectorUrl: 'http://connector',
        connectorServiceToken: 'connector-test-service-token',
        consumer,
        fetchImpl: stubFetch(routes, calls) as any,
      });

      const job: BusinessJobV1 = {
        contractVersion: '1',
        deliveryId: `deliv-${randomUUID()}`,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: config.action,
        kind: config.kind,
        correlationId: `corr-${randomUUID()}`,
      };

      await push(job);
      await workerHandle.stop();

      const uploadedBytes = calls.some((call) => {
        if (call.method !== 'PUT' || !call.path.includes('/upload/blob')) return false;
        if (typeof call.body !== 'object' || call.body === null) return false;
        const byteCount = (call.body as { streamedBytes?: unknown }).streamedBytes;
        return typeof byteCount === 'number' && byteCount > 0;
      });
      expect(uploadedBytes).toBe(true);

      return { completedBody, failedBody, calls };
    };

    // Action 1: Ingest (via root dispatcher)
    it('executes action 1 (ingest) via root handler dispatch with artifact write and complete report', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'ingest',
        kind: 'root',
        input: { mode: 'parse', text: 'Sample document for ingestion parse mode', outputFormat: 'json' },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.leaseEpoch).toBe(1);
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
      expect(typeof completedBody.resultHash).toBe('string');
    });

    // Action 2: Extract (direct kind with connector inference)
    it('executes action 2 (extract) with reasoning slot invocation and artifact write', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'extract',
        kind: 'extract',
        input: { type: 'invoice', text: 'Invoice INV-990 Total $450', outputFormat: 'json' },
        mockConnectorData: { invoiceNumber: 'INV-990', total: 450 },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });

    // Action 3: Analyze (direct kind with reasoning slot invocation)
    it('executes action 3 (analyze) with reasoning slot invocation and artifact write', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'analyze',
        kind: 'analyze',
        input: { task: 'sentiment', text: 'The customer service experience was wonderful.' },
        mockConnectorData: { sentiment: 'positive', score: 0.96 },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });

    // Action 4: Transform (convert mode - local format conversion)
    it('executes action 4 (transform) with format conversion and artifact write', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'transform',
        kind: 'transform',
        input: { variant: 'convert', text: '# Heading\nParagraph text.', outputFormat: 'text' },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });

    // Action 5: Generate (summary with reasoning slot invocation)
    it('executes action 5 (generate) with reasoning slot invocation and artifact write', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'generate',
        kind: 'generate',
        input: { task: 'summary', text: 'Antigravity builds document-core and document-kit lanes.' },
        mockConnectorData: { summary: 'Antigravity builds document-core and document-kit.' },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });

    // Action 6: Compare (diff mode - local lexical comparison)
    it('executes action 6 (compare) with lexical diff and artifact write', async () => {
      const { completedBody, failedBody } = await runActionDeliveryTest({
        action: 'compare',
        kind: 'compare',
        input: {
          mode: 'diff',
          source: { text: 'Version 1 document' },
          target: { text: 'Version 2 document updated' },
          outputFormat: 'json',
        },
      });

      expect(failedBody).toBeUndefined();
      expect(completedBody).toBeDefined();
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });
  });

  describe('3. Durable Step Checkpoint Behavior (RUN-04)', () => {
    it('records step execution under durable checkpoint and saves step output', async () => {
      const taskId = randomUUID();
      const operationId = randomUUID();
      const calls: { path: string; method: string; body?: unknown }[] = [];
      let reportedFailure: unknown;

      const routes: Route[] = [
        {
          method: 'PUT',
          pattern: /^\/workers\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/claim$/,
          handler: () => ({
            status: 200,
            json: {
              taskId,
              operationId,
              leaseEpoch: 1,
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              attempt: 1,
              deadlineAt: null,
              executionSnapshot: {
                operationId,
                tenantId: 'tenant-test-sdk',
                businessId: 'document-core',
                businessVersion: '1.0.0',
                action: 'ingest',
                schemaDigest: 'd1',
                manifestDigest: 'd2',
                resolvedInputRef: { mode: 'parse', text: 'Checkpoint test content' },
                pinned: { profilePolicy: null, profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
                taskKey: 'task-ingest-cp',
                kind: 'ingest',
                payloadRef: {},
                deadlineAt: null,
                cancelRequested: false,
              },
              checkpointRefs: [],
            } as ClaimResult,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/artifacts$/,
          handler: () => {
            const artId = randomUUID();
            return {
              status: 200,
              json: {
                artifactId: artId,
                storageKey: `key-${artId}`,
                uploadUrl: 'http://runtime/upload/blob',
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            };
          },
        },
        {
          method: 'PUT',
          pattern: /^\/upload\/blob$/,
          handler: () => ({ status: 200, json: {} }),
        },
        {
          method: 'POST',
          pattern: /^\/artifacts\/[^/]+\/finalize$/,
          handler: () => ({ status: 200, json: { artifactId: randomUUID(), status: 'FINALIZED' } }),
        },
        {
          method: 'PUT',
          pattern: /^\/tasks\/[^/]+\/steps\/[^/]+$/,
          handler: (m, body: any) => ({
            status: 200,
            json: { stepKey: m[0], generation: 1, replayed: false },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/complete$/,
          handler: () => ({
            status: 200,
            json: { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/fail$/,
          handler: (_m, body) => {
            reportedFailure = body;
            return {
              status: 200,
              json: { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false },
            };
          },
        },
      ];

      const { consumer, push } = testConsumer();

      const workerHandle = await startDocumentCoreWorker({
        runtimeUrl: 'http://runtime',
        runtimeToken: 'bearer-token-test',
        consumer,
        fetchImpl: stubFetch(routes, calls) as any,
      });

      await push({
        contractVersion: '1',
        deliveryId: `deliv-${randomUUID()}`,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        correlationId: `corr-${randomUUID()}`,
      });

      await workerHandle.stop();

      expect(reportedFailure).toBeUndefined();
      const stepCalls = calls.filter((c) => c.method === 'PUT' && c.path.includes('/steps/'));
      expect(stepCalls.length).toBeGreaterThan(0);
      const firstStep = stepCalls[0]!;
      expect(decodeURIComponent(firstStep.path)).toContain('/steps/ingest:prepare-source');
      expect((firstStep.body as any).status).toBe('SUCCEEDED');
      expect(typeof (firstStep.body as any).inputHash).toBe('string');
    });
  });

  describe('4. Failure Disposition Classification', () => {
    it('catches business errors and reports classified failure to runtime', async () => {
      const taskId = randomUUID();
      const operationId = randomUUID();
      const calls: { path: string; method: string; body?: unknown }[] = [];
      let reportedFailure: any;

      const routes: Route[] = [
        {
          method: 'PUT',
          pattern: /^\/workers\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/claim$/,
          handler: () => ({
            status: 200,
            json: {
              taskId,
              operationId,
              leaseEpoch: 1,
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              attempt: 1,
              deadlineAt: null,
              executionSnapshot: {
                operationId,
                tenantId: 'tenant-test-sdk',
                businessId: 'document-core',
                businessVersion: '1.0.0',
                action: 'extract',
                schemaDigest: 'd1',
                manifestDigest: 'd2',
                resolvedInputRef: {
                  type: 'invoice',
                  // Exceeds 50,000 chars -> triggers DOCUMENT_TOO_LARGE BusinessExecutionError
                  text: 'A'.repeat(50_001),
                },
                pinned: { profilePolicy: null, profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
                taskKey: 'task-extract-err',
                kind: 'extract',
                payloadRef: {},
                deadlineAt: null,
                cancelRequested: false,
              },
              checkpointRefs: [],
            } as ClaimResult,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/fail$/,
          handler: (_m, body) => {
            reportedFailure = body;
            return {
              status: 200,
              json: { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false },
            };
          },
        },
      ];

      const { consumer, push } = testConsumer();

      const workerHandle = await startDocumentCoreWorker({
        runtimeUrl: 'http://runtime',
        runtimeToken: 'bearer-token-test',
        consumer,
        fetchImpl: stubFetch(routes, calls) as any,
      });

      await push({
        contractVersion: '1',
        deliveryId: `deliv-${randomUUID()}`,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'extract',
        kind: 'extract',
        correlationId: `corr-${randomUUID()}`,
      });

      await workerHandle.stop();

      expect(reportedFailure).toBeDefined();
      expect(reportedFailure.leaseEpoch).toBe(1);
      expect(reportedFailure.errorCode).toBe('DOCUMENT_TOO_LARGE');
      expect(reportedFailure.retryable).toBe(false);
      expect(reportedFailure.detail).toContain('exceeds maximum supported size');
    });
  });

  describe('5. Lease-loss Cancellation & Fencing', () => {
    it('aborts context on lease loss and releases slot safely without terminal report', async () => {
      const taskId = randomUUID();
      const operationId = randomUUID();
      const calls: { path: string; method: string; body?: unknown }[] = [];
      let terminalFailureReports = 0;

      const routes: Route[] = [
        {
          method: 'PUT',
          pattern: /^\/workers\/[^/]+\/heartbeat$/,
          handler: () => ({
            status: 200,
            json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/claim$/,
          handler: () => ({
            status: 200,
            json: {
              taskId,
              operationId,
              leaseEpoch: 1,
              leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
              attempt: 1,
              deadlineAt: null,
              executionSnapshot: {
                operationId,
                tenantId: 'tenant-test-sdk',
                businessId: 'document-core',
                businessVersion: '1.0.0',
                action: 'ingest',
                schemaDigest: 'd1',
                manifestDigest: 'd2',
                resolvedInputRef: { mode: 'parse', text: 'Lease loss test content' },
                pinned: { profilePolicy: null, profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
                taskKey: 'task-ingest-lease',
                kind: 'ingest',
                payloadRef: {},
                deadlineAt: null,
                cancelRequested: false,
              },
              checkpointRefs: [],
            } as ClaimResult,
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/heartbeat$/,
          // 409 LEASE_LOST simulates another worker claiming the task or epoch expiration
          handler: () => ({
            status: 409,
            json: {
              type: 'urn:du:error:state_conflict',
              status: 409,
              code: 'LEASE_LOST',
              title: 'Lease lost',
              detail: 'Fencing lease expired or stolen by newer attempt',
            },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/artifacts$/,
          handler: () => {
            const artId = randomUUID();
            return {
              status: 200,
              json: {
                artifactId: artId,
                storageKey: `key-${artId}`,
                uploadUrl: 'http://runtime/upload/blob',
                expiresAt: new Date(Date.now() + 60000).toISOString(),
              },
            };
          },
        },
        {
          method: 'PUT',
          pattern: /^\/upload\/blob$/,
          handler: () => ({ status: 200, json: {} }),
        },
        {
          method: 'POST',
          pattern: /^\/artifacts\/[^/]+\/finalize$/,
          handler: () => ({ status: 200, json: { artifactId: randomUUID(), status: 'FINALIZED' } }),
        },
        {
          method: 'PUT',
          pattern: /^\/tasks\/[^/]+\/steps\/[^/]+$/,
          handler: (m) => ({ status: 200, json: { stepKey: m[0], generation: 1, replayed: false } }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/complete$/,
          handler: () => ({
            status: 200,
            json: { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/fail$/,
          handler: () => {
            terminalFailureReports += 1;
            return {
              status: 200,
              json: { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false },
            };
          },
        },
      ];

      const { consumer, push } = testConsumer();

      const workerHandle = await startDocumentCoreWorker({
        runtimeUrl: 'http://runtime',
        runtimeToken: 'bearer-token-test',
        heartbeatIntervalMs: 20, // Fast heartbeat so 409 triggers quickly during delivery
        consumer,
        fetchImpl: stubFetch(routes, calls) as any,
      });

      await push({
        contractVersion: '1',
        deliveryId: `deliv-${randomUUID()}`,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        correlationId: `corr-${randomUUID()}`,
      });

      await workerHandle.stop();

      // Verified: worker handled lease loss without crashing and stopped cleanly
      expect(workerHandle.stopped).toBe(true);
      expect(terminalFailureReports).toBe(0);
    });
  });
});
