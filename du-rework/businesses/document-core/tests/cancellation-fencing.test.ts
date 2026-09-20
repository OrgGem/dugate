import { LeaseLostError } from '@du/worker-sdk';
import { documentCoreHandlers } from '../src/worker';
import { StepCheckpointManager } from '../src/pipelines/step-checkpoint';
import { BusinessExecutionError } from '../src/types/results';
import { TaskContext } from '../src/types/context';

describe('Cancellation & Lease-Loss Fencing at Side-Effect Boundaries (WORKLOAD-REBALANCE-04, P5-03)', () => {
  function createFencedContext(opts: { aborted?: boolean; cancelReason?: string } = {}) {
    const abortController = new AbortController();
    if (opts.aborted) {
      abortController.abort(opts.cancelReason ?? 'lease-lost');
    }

    const calls = {
      connectorInvocations: 0,
      artifactWrites: 0,
      stepExecutions: 0,
    };

    const writtenArtifacts = new Map<string, Buffer>();

    const ctx: TaskContext = {
      taskId: 'test-fenced-task-1',
      operationId: 'test-fenced-op-1',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      tenantId: 'test-tenant',
      signal: abortController.signal,
      artifacts: {
        read: async () => Buffer.from('test source content'),
        write: async (content, fileName, mimeType) => {
          if (abortController.signal.aborted) {
            throw new LeaseLostError(ctx.taskId);
          }
          calls.artifactWrites++;
          const id = `art-${calls.artifactWrites}`;
          const buf = typeof content === 'string' ? Buffer.from(content) : content;
          writtenArtifacts.set(id, buf);
          return {
            artifactId: id,
            role: 'output',
            fileName,
            mimeType,
            sizeBytes: buf.byteLength,
            hashSha256: 'sha256:fake',
          };
        },
      },
      connector: {
        invoke: async () => {
          if (abortController.signal.aborted) {
            throw new LeaseLostError(ctx.taskId);
          }
          calls.connectorInvocations++;
          return {
            invocationId: `inv-${calls.connectorInvocations}`,
            status: 'SUCCESS',
            data: { result: 'ok' },
          };
        },
      },
      step: async (stepKey, inputHash, fn) => {
        if (abortController.signal.aborted) {
          throw new LeaseLostError(ctx.taskId);
        }
        calls.stepExecutions++;
        return fn();
      },
      getCheckpoint: async () => null,
    };

    return { ctx, abortController, calls, writtenArtifacts };
  }

  describe('Low-level Facade Fencing', () => {
    test('StepCheckpointManager.assertActive throws LeaseLostError when signal aborted due to lease loss', () => {
      const { ctx } = createFencedContext({ aborted: true, cancelReason: 'lease-lost' });
      expect(() => StepCheckpointManager.assertActive(ctx)).toThrow(LeaseLostError);
    });

    test('StepCheckpointManager.assertActive throws OPERATION_CANCELLED when signal aborted due to user cancel', () => {
      const { ctx } = createFencedContext({ aborted: true, cancelReason: 'cancel' });
      expect(() => StepCheckpointManager.assertActive(ctx)).toThrow(
        expect.objectContaining({ code: 'OPERATION_CANCELLED' })
      );
    });

    test('executeWithCheckpoint does not execute fn when pre-aborted', async () => {
      const { ctx, calls } = createFencedContext({ aborted: true });
      let fnCalled = false;

      await expect(
        StepCheckpointManager.executeWithCheckpoint(ctx, 'test:step', {}, async () => {
          fnCalled = true;
          return { ok: true };
        })
      ).rejects.toThrow(LeaseLostError);

      expect(fnCalled).toBe(false);
      expect(calls.stepExecutions).toBe(0);
    });
  });

  describe('Handler-Level Fencing across All Six Actions', () => {
    test('action 1 (ingest) aborts cleanly without writing result artifact when signal is cancelled', async () => {
      const { ctx, calls, writtenArtifacts } = createFencedContext({ aborted: true, cancelReason: 'cancel' });

      await expect(
        documentCoreHandlers['ingest']!(ctx, { mode: 'parse', text: 'Some text to parse' })
      ).rejects.toThrow();

      expect(calls.artifactWrites).toBe(0);
      expect(writtenArtifacts.size).toBe(0);
    });

    test('action 2 (extract) does not invoke connector or write artifacts when lease is lost', async () => {
      const { ctx, calls, writtenArtifacts } = createFencedContext({ aborted: true, cancelReason: 'lease-lost' });

      await expect(
        documentCoreHandlers['extract']!(ctx, { type: 'invoice', text: 'Invoice text' })
      ).rejects.toThrow(LeaseLostError);

      expect(calls.connectorInvocations).toBe(0);
      expect(calls.artifactWrites).toBe(0);
      expect(writtenArtifacts.size).toBe(0);
    });

    test('action 3 (analyze) fences execution before provider inference when aborted', async () => {
      const { ctx, calls } = createFencedContext({ aborted: true });

      await expect(
        documentCoreHandlers['analyze']!(ctx, {
          task: 'classify',
          categories: ['Legal', 'Finance'],
          text: 'Document to classify',
        })
      ).rejects.toThrow();

      expect(calls.connectorInvocations).toBe(0);
      expect(calls.artifactWrites).toBe(0);
    });

    test('action 4 (transform) stops multi-step/chunk processing immediately upon abort', async () => {
      const { ctx, calls } = createFencedContext({ aborted: true });

      await expect(
        documentCoreHandlers['transform']!(ctx, {
          variant: 'translate',
          targetLanguage: 'Spanish',
          text: 'Text to translate',
        })
      ).rejects.toThrow();

      expect(calls.connectorInvocations).toBe(0);
      expect(calls.artifactWrites).toBe(0);
    });

    test('action 5 (generate) fences QA generation against aborted context', async () => {
      const { ctx, calls } = createFencedContext({ aborted: true });

      await expect(
        documentCoreHandlers['generate']!(ctx, {
          task: 'qa',
          questions: ['What is the policy?'],
          text: 'Policy details here',
        })
      ).rejects.toThrow();

      expect(calls.connectorInvocations).toBe(0);
      expect(calls.artifactWrites).toBe(0);
    });

    test('action 6 (compare) fences semantic comparison against aborted context', async () => {
      const { ctx, calls } = createFencedContext({ aborted: true });

      await expect(
        documentCoreHandlers['compare']!(ctx, {
          mode: 'semantic',
          source: { text: 'Source draft' },
          target: { text: 'Target draft' },
        })
      ).rejects.toThrow();

      expect(calls.connectorInvocations).toBe(0);
      expect(calls.artifactWrites).toBe(0);
    });

    test('in-flight abort mid-execution prevents final artifact write and terminal success report', async () => {
      const { ctx, abortController, writtenArtifacts } = createFencedContext({ aborted: false });

      // Simulate abort firing while step is running
      const promise = documentCoreHandlers['extract']!(ctx, {
        type: 'contract',
        text: 'Agreement between Party A and Party B effective Jan 1, 2026',
      });

      // Abort immediately
      abortController.abort('lease-lost');

      await expect(promise).rejects.toThrow();

      // Ensure no final extract_result.json was committed
      for (const [_, buf] of writtenArtifacts) {
        const text = buf.toString('utf8');
        expect(text).not.toContain('"status": "COMPLETED"');
      }
    });
  });
});
