import { createHash, randomUUID } from 'node:crypto';
import {
  TaskContext as SdkTaskContext,
  LeaseLostError,
  startWorker,
  QueueConsumer,
} from '@du/worker-sdk';
import {
  InvocationResponse,
  BusinessJobV1,
  ClaimResult,
} from '@du/contracts';
import { documentCoreHandlers, startDocumentCoreWorker } from '../src/worker';
import { ExtractAction } from '../src/actions/extract';
import { BusinessExecutionError } from '../src/types/results';

describe('Provider-Backed Variant (DOC-02-01 extract/invoice) — SDK Facade & Reliability', () => {
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

  const defaultInvoiceData = {
    supplier: { name: 'Acme Corp', taxId: 'US-987654321' },
    buyer: { name: 'Global Logistics Inc' },
    invoiceNumber: 'INV-2026-9001',
    invoiceDate: '2026-09-21',
    lineItems: [
      { description: 'Cloud Infrastructure Gateway Service', quantity: 1, unitPrice: 2500, amount: 2500 },
    ],
    subtotal: 2500,
    total: 2500,
    currency: 'USD',
  };

  function createMockSdkTaskContext(overrides?: {
    connectorInvoke?: (slot: string, input: any, options?: any) => Promise<InvocationResponse>;
    signal?: AbortSignal;
    cancelRequested?: boolean;
  }): {
    ctx: SdkTaskContext;
    artifactsWritten: Array<{ content: Buffer | string; fileName: string; mimeType: string }>;
    connectorCalls: Array<{ slot: string; input: any; options?: any }>;
    stepCalls: Array<{ stepKey: string; inputHash: string }>;
  } {
    const taskId = randomUUID();
    const operationId = randomUUID();
    const artifactsWritten: Array<{ content: Buffer | string; fileName: string; mimeType: string }> = [];
    const connectorCalls: Array<{ slot: string; input: any; options?: any }> = [];
    const stepCalls: Array<{ stepKey: string; inputHash: string }> = [];
    const abortController = new AbortController();

    const ctx: SdkTaskContext = {
      taskId,
      operationId,
      tenantId: 'tenant-doc-core',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'extract',
      taskKey: 'task-extract-invoice-1',
      attempt: 1,
      leaseEpoch: 1,
      deadlineAt: null,
      signal: overrides?.signal ?? abortController.signal,
      cancelRequested: overrides?.cancelRequested ?? false,
      input: {
        type: 'invoice',
        text: 'Invoice from Acme Corp INV-2026-9001 Total $2500',
        outputFormat: 'json',
      },
      connectorBindings: { reasoning: 'mock-llm@1' },
      step: {
        run: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
          stepCalls.push({ stepKey, inputHash });
          return fn();
        },
        peek: async () => null,
      },
      spawn: {
        spawnAndWait: async () => {
          throw new Error('spawn outside this scope');
        },
      },
      wait: {
        waitForInput: async () => {
          throw new Error('human wait outside this scope');
        },
      },
      progress: {
        report: async () => undefined,
      },
      artifacts: {
        read: async () => Buffer.alloc(0),
        readWithMetadata: async () => ({
          buffer: Buffer.alloc(0),
          sizeBytes: 0,
          sha256: '0'.repeat(64),
        }),
        readStream: async () => { throw new Error('stream reads are not used by this fixture'); },
        write: async (content, fileName, mimeType) => {
          const artId = randomUUID();
          artifactsWritten.push({ content, fileName, mimeType });
          return {
            artifactId: artId,
            role: 'output',
            fileName,
            mimeType,
            sizeBytes: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
          };
        },
        writeStream: async (content, fileName, mimeType, sizeBytes, _purpose, expectedSha256) => {
          const artId = randomUUID();
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          for await (const chunk of content as AsyncIterable<Uint8Array>) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += bytes.length;
            chunks.push(bytes);
          }
          if (totalBytes !== sizeBytes) {
            throw new Error(`stream write size mismatch: ${totalBytes} != ${sizeBytes}`);
          }
          const buf = Buffer.concat(chunks, totalBytes);
          if (expectedSha256 !== undefined && createHash('sha256').update(buf).digest('hex') !== expectedSha256) {
            throw new Error('stream write digest mismatch');
          }
          artifactsWritten.push({ content: buf, fileName, mimeType });
          return { artifactId: artId, role: 'output', fileName, mimeType, sizeBytes: totalBytes };
        },
        accessGrant: async () => ({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      },
      connector: {
        invoke: overrides?.connectorInvoke ?? (async (slot: string, input: any, options?: any): Promise<InvocationResponse> => {
          connectorCalls.push({ slot, input, options });
          return {
            invocationId: `inv-${randomUUID()}`,
            state: 'SUCCEEDED',
            result: {
              data: defaultInvoiceData,
              content: JSON.stringify(defaultInvoiceData),
            },
            usage: {
              inputTokens: 120,
              outputTokens: 65,
              costMicrousd: 185,
              measurement: 'measured',
            },
          };
        }),
      },
      checkpoints: () => [],
      grantFor: async () => ({
        grant: 'mock-grant-token',
        invocationId: 'inv-grant-1',
        connectorId: 'mock-connector',
        connectorRevision: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOptions: {},
      }),
    };

    return { ctx, artifactsWritten, connectorCalls, stepCalls };
  }

  describe('1. Real SDK ctx.connector.invoke facade wiring for extract/invoice', () => {
    it('executes extract/invoice through real SDK facade with reasoning slot and valid envelope', async () => {
      const { ctx, connectorCalls, artifactsWritten } = createMockSdkTaskContext();

      const disposition = await documentCoreHandlers.extract!(ctx);

      expect(disposition.kind).toBe('completed');
      if (disposition.kind === 'completed') {
        expect(disposition.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
      }

      // Proves connector was invoked through the real SDK facade signature
      expect(connectorCalls.length).toBe(1);
      const call = connectorCalls[0]!;
      expect(call.slot).toBe('reasoning');
      expect(typeof call.input.prompt).toBe('string');
      expect(call.input.prompt).toContain('extract_invoice');

      // Proves result artifact was written and contains valid completed envelope
      expect(artifactsWritten.length).toBe(1);
      const written = artifactsWritten[0]!;
      expect(written.fileName).toBe('extract_result.json');
      const envelope = JSON.parse(written.content.toString('utf8'));
      expect(envelope.status).toBe('COMPLETED');
      expect(envelope.provenance.method).toBe('llm_extraction');
      expect(envelope.provenance.modelSlot).toBe('reasoning');
      expect(envelope.data.invoiceNumber).toBe('INV-2026-9001');
      expect(envelope.data.total).toBe(2500);
      expect(envelope.data.supplier.name).toBe('Acme Corp');
    });

    it('converts raw markdown code-wrapped JSON from provider into structured invoice data', async () => {
      const { ctx, artifactsWritten } = createMockSdkTaskContext({
        connectorInvoke: async () => ({
          invocationId: 'inv-md-json',
          state: 'SUCCEEDED',
          result: {
            content: '```json\n' + JSON.stringify(defaultInvoiceData) + '\n```',
          },
          usage: { inputTokens: 100, outputTokens: 50, costMicrousd: 150, measurement: 'measured' },
        }),
      });

      const disposition = await documentCoreHandlers.extract!(ctx);
      expect(disposition.kind).toBe('completed');
      const envelope = JSON.parse(artifactsWritten[0]!.content.toString('utf8'));
      expect(envelope.data.invoiceNumber).toBe('INV-2026-9001');
      expect(envelope.data.total).toBe(2500);
    });
  });

  describe('2. Honoring INVOCATION_UNKNOWN (No Blind Retry)', () => {
    it('rejects with non-retryable INVOCATION_UNKNOWN when connector state is UNKNOWN', async () => {
      const { ctx } = createMockSdkTaskContext({
        connectorInvoke: async () => ({
          invocationId: 'inv-unk-1',
          state: 'UNKNOWN',
          result: null,
          error: {
            code: 'INVOCATION_UNKNOWN',
            message: 'Provider timed out waiting for upstream confirmation; outcome uncertain',
            retryable: false,
          },
        }),
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });
    });

    it('rejects with non-retryable INVOCATION_UNKNOWN when error code is INVOCATION_UNKNOWN', async () => {
      const { ctx } = createMockSdkTaskContext({
        connectorInvoke: async () => ({
          invocationId: 'inv-unk-2',
          state: 'FAILED',
          result: null,
          error: {
            code: 'INVOCATION_UNKNOWN',
            message: 'Ambiguous connector response',
            retryable: false,
          },
        }),
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });
    });

    it('rejects with non-retryable INVOCATION_UNKNOWN when transport throws ConnectorTransportError', async () => {
      const transportError = Object.assign(new Error('transport failure: connection reset'), {
        name: 'ConnectorTransportError',
        status: 0,
        code: 'INVOCATION_UNKNOWN',
      });

      const { ctx } = createMockSdkTaskContext({
        connectorInvoke: async () => {
          throw transportError;
        },
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });
    });

    it('rejects with non-retryable INVOCATION_UNKNOWN on 409 conflict from connector', async () => {
      const conflictError = Object.assign(new Error('connector error 409 INVOCATION_UNKNOWN'), {
        name: 'ConnectorTransportError',
        status: 409,
        code: 'INVOCATION_UNKNOWN',
      });

      const { ctx } = createMockSdkTaskContext({
        connectorInvoke: async () => {
          throw conflictError;
        },
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });
    });
  });

  describe('3. Lease-Loss Fencing at Side-Effect Boundaries', () => {
    it('throws LeaseLostError and aborts without connector invocation when pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-abort simulates lease expired prior to delivery

      const { ctx, connectorCalls, artifactsWritten } = createMockSdkTaskContext({
        signal: controller.signal,
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toThrow(LeaseLostError);
      expect(connectorCalls.length).toBe(0);
      expect(artifactsWritten.length).toBe(0);
    });

    it('throws LeaseLostError and fences artifact finalization when lease is lost during invocation', async () => {
      const controller = new AbortController();

      const { ctx, artifactsWritten } = createMockSdkTaskContext({
        signal: controller.signal,
        connectorInvoke: async () => {
          // Abort during connector inference simulates heartbeat detecting lease stolen
          controller.abort();
          return {
            invocationId: 'inv-late-1',
            state: 'SUCCEEDED',
            result: { data: defaultInvoiceData },
          };
        },
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toThrow(LeaseLostError);
      expect(artifactsWritten.length).toBe(0);
    });
  });

  describe('4. Worker Delivery Loop with Real SDK Facade Simulation', () => {
    function stubFetch(routes: Array<{ method: string; pattern: RegExp; handler: (m: RegExpMatchArray, body: unknown) => { status: number; json: unknown } }>) {
      return async (url: string, init?: { method?: string; body?: string }) => {
        const path = url.replace(/^http:\/\/[^/]+/, '');
        const method = init?.method ?? 'GET';
        let body: unknown;
        if (init?.body) {
          try {
            body = JSON.parse(init.body) as unknown;
          } catch {
            // Artifact blob uploads are binary; only JSON routes carry parsed bodies.
            body = init.body;
          }
        }
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

    it('delivers extract/invoice end-to-end through startDocumentCoreWorker', async () => {
      const taskId = randomUUID();
      const operationId = randomUUID();
      let completedBody: any;
      let failedBody: unknown;
      let connectorInvocations = 0;

      const routes = [
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
                  text: 'Invoice from Supplier XYZ INV-8899 Total $3500.00',
                  outputFormat: 'json',
                },
                pinned: { profilePolicy: null, profileRevision: 1, promptRevisions: {}, connectorBindings: { reasoning: 'mock-llm@1' } },
                taskKey: 'task-extract-worker-loop',
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
          handler: (m: RegExpMatchArray) => ({ status: 200, json: { stepKey: m[0], generation: 1, replayed: false } }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/invocation-grants$/,
          handler: () => ({
            status: 200,
            json: {
              grant: 'signed-grant-token',
              invocationId: 'inv-worker-ext-1',
              connectorId: 'mock-connector',
              connectorRevision: 1,
              expiresAt: new Date(Date.now() + 60000).toISOString(),
              allowedOptions: {},
            },
          }),
        },
        {
          method: 'POST',
          pattern: /^\/invocations$/,
          handler: () => {
            connectorInvocations++;
            return {
              status: 200,
              json: {
                invocationId: 'inv-worker-ext-1',
                state: 'SUCCEEDED',
                result: {
                  data: {
                    invoiceNumber: 'INV-8899',
                    supplier: { name: 'Supplier XYZ' },
                    total: 3500.0,
                  },
                },
                usage: { inputTokens: 60, outputTokens: 30, costMicrousd: 90, measurement: 'measured' },
              },
            };
          },
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/complete$/,
          handler: (_m: RegExpMatchArray, body: any) => {
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
          handler: (_m: RegExpMatchArray, body: unknown) => {
            failedBody = body;
            return {
              status: 200,
              json: { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false },
            };
          },
        },
      ];

      let deliveryHandler: ((job: BusinessJobV1) => Promise<void>) | undefined;
      const consumer: QueueConsumer = {
        start(h) {
          deliveryHandler = h;
        },
        async stop() {},
      };

      const workerHandle = await startDocumentCoreWorker({
        runtimeUrl: 'http://runtime',
        runtimeToken: 'bearer-test',
        connectorUrl: 'http://connector',
        connectorServiceToken: 'connector-test-service-token',
        consumer,
        fetchImpl: stubFetch(routes) as any,
      });

      const job: BusinessJobV1 = {
        contractVersion: '1',
        deliveryId: `deliv-${randomUUID()}`,
        taskId,
        operationId,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'extract',
        kind: 'extract',
        correlationId: `corr-${randomUUID()}`,
      };

      await deliveryHandler!(job);
      await workerHandle.stop();

      expect(failedBody).toBeUndefined();
      expect(connectorInvocations).toBe(1);
      expect(completedBody).toBeDefined();
      expect(completedBody.leaseEpoch).toBe(1);
      expect(completedBody.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
    });
  });
});
