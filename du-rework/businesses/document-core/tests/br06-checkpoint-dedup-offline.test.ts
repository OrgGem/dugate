import type { ConnectorInvocationResult, StepCheckpointRecord, TaskContext } from '../src/types/context';
import { documentCoreHandlers } from '../src/worker';

describe('BR-06 offline checkpoint usage deduplication', () => {
  it('records usage once after a simulated 429 and does not write it again on checkpoint redelivery', async () => {
    const checkpoints = new Map<string, StepCheckpointRecord>();
    const usageLedgerWrites: Array<{ invocationId: string }> = [];
    let connectorAttempts = 0;
    let artifactWrites = 0;

    const ctx: TaskContext = {
      taskId: 'br06-task-1',
      operationId: 'br06-operation-1',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      tenantId: 'br06-tenant',
      signal: new AbortController().signal,
      artifacts: {
        read: async () => Buffer.alloc(0),
        write: async (content, fileName, mimeType) => {
          artifactWrites += 1;
          const sizeBytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
          return {
            artifactId: `br06-artifact-${artifactWrites}`,
            role: 'output',
            fileName,
            mimeType,
            sizeBytes,
            hashSha256: 'sha256:br06-offline',
          };
        },
      },
      connector: {
        invoke: async (): Promise<ConnectorInvocationResult> => {
          connectorAttempts += 1;
          if (connectorAttempts === 1) {
            throw Object.assign(new Error('simulated provider rate limit'), {
              status: 429,
              code: 'QUOTA_EXHAUSTED',
              retryable: true,
            });
          }

          const success: ConnectorInvocationResult = {
            invocationId: 'br06-invocation-success-1',
            status: 'SUCCESS',
            data: {
              invoiceNumber: 'INV-BR06-001',
              supplier: 'Offline Fixture Co',
              total: '$1500.00',
            },
            usage: { promptTokens: 24, completionTokens: 12, totalTokens: 36 },
          };
          // Model the successful invocation's usage-ledger write at the connector seam.
          usageLedgerWrites.push({ invocationId: success.invocationId });
          return success;
        },
      },
      step: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
        const existing = checkpoints.get(stepKey);
        if (existing?.inputHash === inputHash) return existing.output as T;

        const output = await fn();
        checkpoints.set(stepKey, {
          stepKey,
          inputHash,
          output,
          savedAt: '2026-09-25T00:00:00.000Z',
        });
        return output;
      },
      getCheckpoint: async (stepKey) => checkpoints.get(stepKey) ?? null,
    };

    const handler = documentCoreHandlers.extract;
    if (!handler) throw new Error('document-core extract handler is not registered');
    const input = {
      type: 'invoice',
      text: 'Invoice INV-BR06-001 from Offline Fixture Co, total $1500.00',
    };

    await expect(handler(ctx, input)).rejects.toMatchObject({ status: 429, code: 'QUOTA_EXHAUSTED' });
    expect(usageLedgerWrites).toHaveLength(0);

    await expect(handler(ctx, input)).resolves.toMatchObject({ kind: 'completed' });
    expect(connectorAttempts).toBe(2);
    expect(usageLedgerWrites).toEqual([{ invocationId: 'br06-invocation-success-1' }]);

    // A redelivered task restores the successful inference checkpoint. The
    // final result artifact may be rewritten, but usage must not be charged twice.
    await expect(handler(ctx, input)).resolves.toMatchObject({ kind: 'completed' });
    expect(connectorAttempts).toBe(2);
    expect(usageLedgerWrites).toHaveLength(1);
    expect(new Set(usageLedgerWrites.map((entry) => entry.invocationId)).size).toBe(1);
  });
});
