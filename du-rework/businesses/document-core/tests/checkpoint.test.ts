import { StepCheckpointManager } from '../src/pipelines/step-checkpoint';
import type { TaskArtifactCrypto } from '@du/worker-sdk';
import { MockTaskContext } from './fixtures/mock-context';

describe('Step Checkpoint Durability & Full Output Preservation (RUN-04)', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  it('RUN-04: preserves full step output >500 characters intact without truncation', async () => {
    // Generate long string > 2000 characters
    const longDocumentText = 'Sentence ' + 'A'.repeat(2500);
    expect(longDocumentText.length).toBeGreaterThan(2000);

    let executionCount = 0;

    const output = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'test:step-large-output',
      { inputField: 'original-input' },
      async () => {
        executionCount++;
        return {
          fullText: longDocumentText,
          characterCount: longDocumentText.length,
        };
      }
    );

    expect(executionCount).toBe(1);
    expect(output.fullText.length).toBe(longDocumentText.length);
    expect(output.fullText).toBe(longDocumentText);

    // Verify persisted record in context store
    const checkpoint = await ctx.getCheckpoint('test:step-large-output');
    expect(checkpoint).not.toBeNull();
    const persisted = checkpoint?.output as { fullText: string };
    expect(persisted.fullText.length).toBe(longDocumentText.length);
    expect(persisted.fullText.endsWith('... [truncated]')).toBe(false);
  });

  it('RUN-04: resumes completed step without re-executing callback on duplicate delivery', async () => {
    let executionCount = 0;
    const computeFn = async () => {
      executionCount++;
      return { answer: 42 };
    };

    // First delivery attempt
    const res1 = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'test:step-idempotent',
      { key: 'val' },
      computeFn
    );
    expect(res1).toEqual({ answer: 42 });
    expect(executionCount).toBe(1);

    // Second delivery attempt (replay/duplicate task)
    const res2 = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      'test:step-idempotent',
      { key: 'val' },
      computeFn
    );
    expect(res2).toEqual({ answer: 42 });
    expect(executionCount).toBe(1); // Callback NOT called a second time!
  });

  it('rejects step outputs containing truncation markers', () => {
    expect(() => {
      StepCheckpointManager.validateFullOutputIntegrity('Some text ending with ... [truncated]');
    }).toThrow(/Checkpoint integrity failure: Step output was truncated/);

    expect(() => {
      StepCheckpointManager.validateFullOutputIntegrity({
        field: 'value ... [truncated]',
      });
    }).toThrow(/Checkpoint integrity failure/);
  });

  it('fails closed when a stored encrypted checkpoint payload cannot be authenticated', async () => {
    const stepKey = 'test:corrupt-stored-payload';
    const inputPayload = { request: 'cached request' };
    ctx.checkpointsStore.set(stepKey, {
      stepKey,
      inputHash: StepCheckpointManager.computeInputHash(inputPayload),
      output: {
        __duEncryptedCheckpoint: 1,
        artifactId: `checkpoint:${stepKey}`,
        sealed: { encrypted: { ciphertext: 'corrupted-ciphertext' } },
      },
      savedAt: new Date().toISOString(),
    });
    const crypto = {
      tenantId: ctx.tenantId,
      seal: async () => {
        throw new Error('seal must not be called while replaying');
      },
      open: async () => {
        throw new Error('checkpoint authentication failed');
      },
    } as unknown as TaskArtifactCrypto;
    Object.defineProperty(ctx, 'crypto', { configurable: true, value: crypto });
    let callbackCalled = false;

    await expect(
      StepCheckpointManager.executeWithCheckpoint(ctx, stepKey, inputPayload, async () => {
        callbackCalled = true;
        return { unsafe: true };
      })
    ).rejects.toThrow('checkpoint authentication failed');

    expect(callbackCalled).toBe(false);
  });

  it('does not alias an empty step name and negative sequence index to a valid checkpoint', async () => {
    const validInput = { stepName: 'parse', sequenceIndex: 0 };
    await StepCheckpointManager.executeWithCheckpoint(ctx, 'parse-step', validInput, async () => ({ value: 'valid' }));
    let callbackCalled = false;

    const result = await StepCheckpointManager.executeWithCheckpoint(
      ctx,
      '',
      { stepName: '', sequenceIndex: -1 },
      async () => {
        callbackCalled = true;
        return { value: 'fresh malformed-boundary result' };
      }
    );

    expect(callbackCalled).toBe(true);
    expect(result).toEqual({ value: 'fresh malformed-boundary result' });
    expect(ctx.checkpointsStore.has('')).toBe(true);
  });

  it('does not replay a checkpoint from a context with different operation and task IDs', async () => {
    const source = new MockTaskContext({ taskId: 'task-source', operationId: 'operation-source' });
    const target = new MockTaskContext({ taskId: 'task-target', operationId: 'operation-target' });
    const stepKey = 'shared-step-name';
    const inputPayload = { document: 'same input' };
    await StepCheckpointManager.executeWithCheckpoint(source, stepKey, inputPayload, async () => ({ value: 'source result' }));
    let targetCallbackCalled = false;

    const result = await StepCheckpointManager.executeWithCheckpoint(target, stepKey, inputPayload, async () => {
      targetCallbackCalled = true;
      return { value: 'target result' };
    });

    expect(targetCallbackCalled).toBe(true);
    expect(result).toEqual({ value: 'target result' });
    expect(source.checkpointsStore.get(stepKey)?.output).toEqual({ value: 'source result' });
  });

  it('preserves a step output at the exact 500-character boundary', async () => {
    const exactBoundary = 'x'.repeat(500);
    const output = await StepCheckpointManager.executeWithCheckpoint(ctx, 'test:exact-500', {}, async () => exactBoundary);
    const stored = await ctx.getCheckpoint('test:exact-500');

    expect(output).toHaveLength(500);
    expect(stored?.output).toBe(exactBoundary);
  });

  it('preserves and replays oversized outputs without truncation', async () => {
    const oversized = 'z'.repeat(1_000_001);
    const first = await StepCheckpointManager.executeWithCheckpoint(ctx, 'test:oversized-output', {}, async () => oversized);
    const second = await StepCheckpointManager.executeWithCheckpoint(ctx, 'test:oversized-output', {}, async () => {
      throw new Error('oversized checkpoint replay must not re-execute');
    });
    const stored = await ctx.getCheckpoint('test:oversized-output');

    expect(first).toHaveLength(1_000_001);
    expect(second).toBe(oversized);
    expect(stored?.output).toBe(oversized);
    expect(String(stored?.output).endsWith('... [truncated]')).toBe(false);
  });
});
