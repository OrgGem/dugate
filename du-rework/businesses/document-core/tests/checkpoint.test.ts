import { StepCheckpointManager } from '../src/pipelines/step-checkpoint';
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
});
