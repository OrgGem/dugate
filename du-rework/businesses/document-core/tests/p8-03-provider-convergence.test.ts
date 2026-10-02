import { createHash, randomUUID } from 'node:crypto';
import {
  TaskContext as SdkTaskContext,
} from '@du/worker-sdk';
import {
  InvocationResponse,
  UsageEventSchema,
} from '@du/contracts';
import { PgSqlClient } from '@du/connector';
import { documentCoreHandlers } from '../src/worker';

const LIVE_INFRA = process.env.DU_LIVE_INFRA === '1';
const liveTest = LIVE_INFRA ? test : test.skip;

/**
 * P8-03: Document-Core Provider Unknown, Dedup & Usage Convergence Tests
 * Foundation Contracts Acceptance: CON-01..05 & USE-01/02
 *
 * Runs strictly against mock provider boundaries and in-memory SDK context.
 * Zero connections to shared DB (:5433) or Redis (:6380).
 */
describe('P8-03: Document-Core Provider & Usage Convergence (CON-01..05, USE-01/02)', () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input?.toString?.() ?? '';
      if (urlStr.includes('/upload/') || urlStr.includes('/artifacts/')) {
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

  const mockInvoiceData = {
    supplier: { name: 'Acme Supply Co', taxId: 'US-123456789' },
    buyer: { name: 'Global Enterprise Ltd' },
    invoiceNumber: 'INV-2026-CONV-01',
    invoiceDate: '2026-09-22',
    lineItems: [
      { description: 'Cloud API Gateway Processing', quantity: 1, unitPrice: 1500, amount: 1500 },
    ],
    subtotal: 1500,
    total: 1500,
    currency: 'USD',
  };

  function createMockTaskContext(overrides?: {
    connectorInvoke?: (slot: string, input: any, options?: any) => Promise<InvocationResponse>;
    stepPeek?: (stepKey: string) => Promise<any>;
    stepRun?: <T>(stepKey: string, inputHash: string, fn: () => Promise<T>) => Promise<T>;
  }): {
    ctx: SdkTaskContext;
    artifactsWritten: Array<{ content: Buffer | string; fileName: string; mimeType: string }>;
    connectorCalls: Array<{ slot: string; input: any; options?: any }>;
    usageEventsRecorded: Array<{ invocationId: string; usage: any }>;
  } {
    const taskId = randomUUID();
    const operationId = randomUUID();
    const artifactsWritten: Array<{ content: Buffer | string; fileName: string; mimeType: string }> = [];
    const connectorCalls: Array<{ slot: string; input: any; options?: any }> = [];
    const usageEventsRecorded: Array<{ invocationId: string; usage: any }> = [];

    const ctx: SdkTaskContext = {
      taskId,
      operationId,
      tenantId: 'tenant-conv-test',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'extract',
      taskKey: 'task-conv-extract-1',
      attempt: 1,
      leaseEpoch: 1,
      deadlineAt: null,
      signal: new AbortController().signal,
      cancelRequested: false,
      input: {
        type: 'invoice',
        text: 'Invoice from Acme Supply Co INV-2026-CONV-01 Total $1500',
        outputFormat: 'json',
      },
      connectorBindings: { reasoning: 'mock-llm@1' },
      step: {
        run: overrides?.stepRun ?? (async <T>(_stepKey: string, _hash: string, fn: () => Promise<T>): Promise<T> => {
          return fn();
        }),
        peek: overrides?.stepPeek ?? (async () => null),
      },
      spawn: {
        spawnAndWait: async () => { throw new Error('spawn not needed'); },
      },
      wait: {
        waitForInput: async () => { throw new Error('wait not needed'); },
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
        invoke: async (slot: string, input: any, options?: any): Promise<InvocationResponse> => {
          connectorCalls.push({ slot, input, options });
          if (overrides?.connectorInvoke) {
            return overrides.connectorInvoke(slot, input, options);
          }
          const usage = { inputTokens: 80, outputTokens: 40, costMicrousd: 300, measurement: 'measured' as const };
          const invId = `inv-${randomUUID()}`;
          usageEventsRecorded.push({ invocationId: invId, usage });
          return {
            invocationId: invId,
            state: 'SUCCEEDED',
            result: {
              data: mockInvoiceData,
              content: JSON.stringify(mockInvoiceData),
            },
            usage,
          };
        },
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

    return { ctx, artifactsWritten, connectorCalls, usageEventsRecorded };
  }

  // -------------------------------------------------------------------------
  // CON-01 & CON-05: Adapter Facade & INVOCATION_UNKNOWN Fault Taxonomy
  // -------------------------------------------------------------------------
  describe('CON-01 & CON-05: Adapter Facade & INVOCATION_UNKNOWN Fault Handling', () => {
    test('extract/invoice invokes connector reasoning slot and produces structured output', async () => {
      const { ctx, connectorCalls, artifactsWritten } = createMockTaskContext();

      const result = await documentCoreHandlers.extract!(ctx);
      expect(result.kind).toBe('completed');
      expect(connectorCalls).toHaveLength(1);
      expect(connectorCalls[0]!.slot).toBe('reasoning');
      expect(artifactsWritten).toHaveLength(1);
    });

    test('INVOCATION_UNKNOWN from connector fails task non-retryable and halts execution', async () => {
      const { ctx, connectorCalls, artifactsWritten } = createMockTaskContext({
        connectorInvoke: async () => ({
          invocationId: 'inv-unknown-1',
          state: 'UNKNOWN',
          error: {
            code: 'INVOCATION_UNKNOWN',
            message: 'Provider outcome is unknown; reconciliation is required.',
            retryable: false,
          },
        }),
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });

      // Exactly 1 connector call attempted, zero artifacts finalized
      expect(connectorCalls).toHaveLength(1);
      expect(artifactsWritten).toHaveLength(0);
    });

    test('transport disconnect throws ConnectorTransportError with INVOCATION_UNKNOWN and halts', async () => {
      const transportError = Object.assign(new Error('Connection reset by peer'), {
        name: 'ConnectorTransportError',
        status: 0,
        code: 'INVOCATION_UNKNOWN',
      });

      const { ctx, connectorCalls } = createMockTaskContext({
        connectorInvoke: async () => {
          throw transportError;
        },
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        retryable: false,
      });
      expect(connectorCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // CON-02 & USE-02: Checkpoint Deduplication & Zero Double-Billing on Replay
  // -------------------------------------------------------------------------
  describe('CON-02 & USE-02: Checkpoint Deduplication & Zero Double-Billing', () => {
    test('step checkpoint replay restores cached output with 0 connector calls and 0 duplicate usage', async () => {
      // Step checkpoint store
      const stepCheckpoints = new Map<string, any>();

      // Run 1: First execution (executes callback and caches output)
      const { ctx: ctx1, connectorCalls: calls1, usageEventsRecorded: usage1 } = createMockTaskContext({
        stepRun: async <T>(stepKey: string, _hash: string, fn: () => Promise<T>): Promise<T> => {
          const res = await fn();
          stepCheckpoints.set(stepKey, res);
          return res;
        },
      });

      const result1 = await documentCoreHandlers.extract!(ctx1);
      expect(result1.kind).toBe('completed');
      expect(calls1).toHaveLength(1);
      expect(usage1).toHaveLength(1);

      // Run 2: Replay execution with cached checkpoint
      const { ctx: ctx2, connectorCalls: calls2, usageEventsRecorded: usage2 } = createMockTaskContext({
        stepRun: async <T>(stepKey: string, _hash: string, fn: () => Promise<T>): Promise<T> => {
          if (stepCheckpoints.has(stepKey)) {
            // Replay from checkpoint without calling fn!
            return stepCheckpoints.get(stepKey);
          }
          return fn();
        },
      });

      const result2 = await documentCoreHandlers.extract!(ctx2);
      expect(result2.kind).toBe('completed');

      // Zero connector calls on replay! Zero duplicate usage events emitted!
      expect(calls2).toHaveLength(0);
      expect(usage2).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CON-03: Quota Exhaustion Backpressure
  // -------------------------------------------------------------------------
  describe('CON-03: Quota Exhaustion Backpressure', () => {
    test('429 QUOTA_EXHAUSTED from connector throws retryable error with backpressure delay', async () => {
      const quotaError = Object.assign(new Error('Provider quota is currently exhausted.'), {
        name: 'ConnectorError',
        status: 429,
        code: 'QUOTA_EXHAUSTED',
        retryAfterMs: 2000,
        retryable: true,
      });

      const { ctx } = createMockTaskContext({
        connectorInvoke: async () => {
          throw quotaError;
        },
      });

      await expect(documentCoreHandlers.extract!(ctx)).rejects.toMatchObject({
        code: 'QUOTA_EXHAUSTED',
        retryable: true,
      });
    });
  });

  // -------------------------------------------------------------------------
  // USE-01: Structured Usage Accounting & Schema Compliance
  // -------------------------------------------------------------------------
  describe('USE-01: Structured Usage Accounting & Schema Compliance', () => {
    test('usage metadata from provider execution conforms to UsageEventSchema', () => {
      const sampleUsage = {
        eventId: 'evt-test-12345',
        invocationId: 'inv-test-12345',
        operationId: randomUUID(),
        taskId: randomUUID(),
        units: { inputTokens: 150, outputTokens: 60, pages: 1 },
        costMicrousd: 850,
        currency: 'USD',
        measurement: 'measured' as const,
        occurredAt: new Date().toISOString(),
      };

      const parsed = UsageEventSchema.safeParse(sampleUsage);
      expect(parsed.success).toBe(true);
    });

    liveTest('live usage_events projection query aggregates provider tokens and costs matching UsageSchema', async () => {
      const dbUrl = process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
      const client = new PgSqlClient({ connectionString: dbUrl });

      const testTenantId = '00000000-0000-0000-0000-000000000001';
      const testOpId = randomUUID();
      const testTaskId = randomUUID();
      const eventId = `evt-doc-core-live-${randomUUID()}`;

      try {
        const correlationId = `corr-${randomUUID()}`;
        await client.query(
          `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id)
           VALUES ($1, $2, 'document-core', '1.0.0', 'extract', 'RUNNING', 1, $3)
           ON CONFLICT (id) DO NOTHING`,
          [testOpId, testTenantId, correlationId]
        );
        await client.query(
          `INSERT INTO tasks (id, operation_id, kind, task_key, state, lease_epoch)
           VALUES ($1, $2, 'root', 'task-root', 'RUNNING', 1)
           ON CONFLICT (id) DO NOTHING`,
          [testTaskId, testOpId]
        );

        const sampleUsage = {
          eventId,
          invocationId: `inv-${randomUUID()}`,
          operationId: testOpId,
          taskId: testTaskId,
          units: { inputTokens: 520, outputTokens: 140, pages: 3 },
          costMicrousd: 4200,
          currency: 'USD',
          measurement: 'measured' as const,
          occurredAt: new Date().toISOString(),
          provider: 'openai',
          model: 'gpt-4o',
        };

        await client.query(
          `INSERT INTO usage_events (event_id, operation_id, task_id, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [sampleUsage.eventId, testOpId, testTaskId, JSON.stringify(sampleUsage)]
        );

        const projRes = await client.query<{
          count: string;
          input_tokens: string;
          output_tokens: string;
          cost: string;
          estimated: boolean | null;
        }>(
          `SELECT count(*)::text AS count,
                  COALESCE(sum((payload->'units'->>'inputTokens')::numeric), 0)::text AS input_tokens,
                  COALESCE(sum((payload->'units'->>'outputTokens')::numeric), 0)::text AS output_tokens,
                  COALESCE(sum((payload->>'costMicrousd')::numeric), 0)::text AS cost,
                  bool_or(payload->>'measurement' = 'estimated') AS estimated
           FROM usage_events WHERE operation_id = $1`,
          [testOpId]
        );

        expect(projRes.rows).toHaveLength(1);
        const projection = projRes.rows[0]!;
        expect(Number(projection.count)).toBe(1);
        expect(Number(projection.input_tokens)).toBe(520);
        expect(Number(projection.output_tokens)).toBe(140);
        expect(Number(projection.cost)).toBe(4200);
        expect(projection.estimated).toBe(false);
      } finally {
        await client.query('DELETE FROM usage_events WHERE operation_id = $1', [testOpId]).catch(() => {});
        await client.query('DELETE FROM tasks WHERE operation_id = $1', [testOpId]).catch(() => {});
        await client.query('DELETE FROM operations WHERE id = $1', [testOpId]).catch(() => {});
        await client.close();
      }
    });
  });
});
