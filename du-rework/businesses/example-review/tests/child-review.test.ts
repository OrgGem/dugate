import { LeaseLostError } from '@du/worker-sdk';
import { itemReviewHandler } from '../src/review';
import { createMockTaskContext } from './test-helper';

describe('Child Task Review & Provider Failure / Fencing (P7-01 / P7-02 / A07-03)', () => {
  it('executes item review successfully for passing checks and non-empty content without reasoning (unbound)', async () => {
    const { ctx, writtenArtifacts, connectorCalls } = createMockTaskContext({
      kind: 'review-item',
      input: {
        reviewId: 'rev-item-01',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'contract.pdf' },
        checks: {
          'has-owner': true,
          'has-retention-policy': true,
        },
      },
    });

    const disposition = await itemReviewHandler(ctx);

    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(disposition.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);
    }

    expect(connectorCalls).toHaveLength(0); // Unbound reasoning makes zero calls
    expect(writtenArtifacts).toHaveLength(1);
    const written = writtenArtifacts[0]!;
    expect(written.fileName).toBe('rev-item-01-item-0.review.json');
    expect(written.role).toBe('intermediate');

    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(true);
    expect(result.failedChecks).toEqual([]);
    expect(result.reviewId).toBe('rev-item-01');
    expect(result.itemIndex).toBe(0);
    expect(result.artifactId).toBe('art-1');
  });

  it('records failed checks when conditions evaluate to false', async () => {
    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      input: {
        reviewId: 'rev-item-02',
        itemIndex: 1,
        artifact: { artifactId: 'art-1', fileName: 'data.json' },
        checks: {
          'zeta-check': false,
          'alpha-check': false,
          'passed-check': true,
        },
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(false);
    // Deterministic sorted failed checks
    expect(result.failedChecks).toEqual(['alpha-check', 'zeta-check']);
  });

  it('flags non-empty-content failure when document artifact is 0 bytes', async () => {
    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      input: {
        reviewId: 'rev-item-empty',
        itemIndex: 0,
        artifact: { artifactId: 'art-empty', fileName: 'empty.txt' },
        checks: { 'valid-doc': true },
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain('non-empty-content');
  });

  it('invokes reasoning connector slot when bound and succeeds on valid inference', async () => {
    const { ctx, connectorCalls, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-reasoning-01',
        itemIndex: 2,
        artifact: { artifactId: 'art-1', fileName: 'security.pdf' },
        checks: { 'valid-hash': true },
        enableReasoning: true,
      },
      onConnectorInvoke: async () => {
        return {
          invocationId: 'inv-reason-1',
          state: 'SUCCEEDED',
          result: {
            content: 'Automated reasoning analysis: verified compliance with enterprise standard.',
          },
          usage: { inputTokens: 40, outputTokens: 15, costMicrousd: 55, measurement: 'measured' },
        };
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    expect(connectorCalls).toHaveLength(1);
    expect(connectorCalls[0]!.slot).toBe('reasoning');

    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.reasoning).toBe('Reasoning completed.');
    expect(result.passed).toBe(true);
  });

  it('never silently approves when reasoning call fails (A07-03)', async () => {
    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-reasoning-failed',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
        checks: { 'baseline-pass': true },
      },
      onConnectorInvoke: async () => {
        return {
          invocationId: 'inv-fail-1',
          state: 'FAILED',
          error: { code: 'PROVIDER_ERROR', message: 'Inference rate limited by provider', retryable: true },
        };
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain('reasoning-failed');
    expect(result.reasoning).toBe('Reasoning invocation failed; provider details withheld.');
  });

  it('never silently approves when reasoning call is PENDING without settlement (A07-03)', async () => {
    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-reasoning-pending',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
        checks: { 'baseline-pass': true },
      },
      onConnectorInvoke: async () => {
        return {
          invocationId: 'inv-pending-1',
          state: 'PENDING',
        };
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain('reasoning-pending');
  });

  it('never silently approves on INVOCATION_UNKNOWN and prohibits blind retry (A07-03)', async () => {
    let callCount = 0;
    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-reasoning-unknown',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
        checks: { 'baseline-pass': true },
      },
      onConnectorInvoke: async () => {
        callCount++;
        const err = new Error('Gateway socket timeout after invocation dispatch') as Error & { code?: string };
        err.code = 'INVOCATION_UNKNOWN';
        throw err;
      },
    });

    const disposition = await itemReviewHandler(ctx);
    expect(disposition.kind).toBe('completed');

    expect(callCount).toBe(1); // No blind retry
    const written = writtenArtifacts[0]!;
    const result = JSON.parse(written.content.toString('utf8'));
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain('reasoning-invocation-unknown');
  });

  it('rethrows LeaseLostError and cancellation without swallowing (A07-03)', async () => {
    // Lease lost during reasoning
    const { ctx: leaseCtx } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-lease-lost',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
      },
      onConnectorInvoke: async () => {
        throw new LeaseLostError('task-rev-lease-lost');
      },
    });

    await expect(itemReviewHandler(leaseCtx)).rejects.toThrow(LeaseLostError);

    // Cancelled task
    const { ctx: cancelCtx, abortController } = createMockTaskContext({
      kind: 'review-item',
      input: {
        reviewId: 'rev-cancelled',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
      },
    });
    abortController.abort('cancel');

    await expect(itemReviewHandler(cancelCtx)).rejects.toThrow(/cancelled/);
  });

  it('reuses durable step checkpoint to avoid duplicate inference on replay (A07-03)', async () => {
    let invokeCount = 0;
    const { ctx: ctx1, checkpointsStore } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-replay-test',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
      },
      onConnectorInvoke: async () => {
        invokeCount++;
        return {
          invocationId: 'inv-replay-1',
          state: 'SUCCEEDED',
          result: { content: 'Verified step checkpoint' },
        };
      },
    });

    // First execution saves checkpoint
    await itemReviewHandler(ctx1);
    expect(invokeCount).toBe(1);
    expect(checkpointsStore.has('reasoning:rev-replay-test:0')).toBe(true);

    // Fresh execution with existing checkpointsStore
    const { ctx: ctx2 } = createMockTaskContext({
      kind: 'review-item',
      connectorBindings: { reasoning: 'mock-llm@1' },
      input: {
        reviewId: 'rev-replay-test',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc.txt' },
      },
      checkpointsStore,
      onConnectorInvoke: async () => {
        invokeCount++;
        throw new Error('Should not be called during replay');
      },
    });

    const disposition2 = await itemReviewHandler(ctx2);
    expect(disposition2.kind).toBe('completed');
    expect(invokeCount).toBe(1); // Provider NOT invoked again!
  });

  describe('Zero Side-Effects on Invalid Child Input (Wave 19 / W19-A)', () => {
    const invalidInputs: Array<{ description: string; input: Record<string, unknown> }> = [
      { description: 'null itemIndex', input: { reviewId: 'rev-bad-1', itemIndex: null as unknown as number, artifact: { artifactId: 'art-1' } } },
      { description: 'boolean itemIndex', input: { reviewId: 'rev-bad-2', itemIndex: false as unknown as number, artifact: { artifactId: 'art-1' } } },
      { description: 'numeric string itemIndex', input: { reviewId: 'rev-bad-3', itemIndex: '0' as unknown as number, artifact: { artifactId: 'art-1' } } },
      { description: 'fractional itemIndex', input: { reviewId: 'rev-bad-4', itemIndex: 1.5, artifact: { artifactId: 'art-1' } } },
      { description: 'out of bounds itemIndex (10)', input: { reviewId: 'rev-bad-5', itemIndex: 10, artifact: { artifactId: 'art-1' } } },
      { description: 'array artifact', input: { reviewId: 'rev-bad-6', itemIndex: 0, artifact: [] as unknown as { artifactId: string } } },
      { description: 'empty artifactId', input: { reviewId: 'rev-bad-7', itemIndex: 0, artifact: { artifactId: '' } } },
      { description: 'empty string fileName', input: { reviewId: 'rev-bad-8', itemIndex: 0, artifact: { artifactId: 'art-1', fileName: '' } } },
      { description: 'numeric fileName', input: { reviewId: 'rev-bad-9', itemIndex: 0, artifact: { artifactId: 'art-1', fileName: 123 as unknown as string } } },
    ];

    test.each(invalidInputs)(
      'rejects invalid child input ($description) with zero artifact read, zero provider calls, and zero written outputs',
      async ({ input }) => {
        let providerCalled = false;
        const { ctx, readArtifactCalls, writtenArtifacts, connectorCalls, stepCalls } = createMockTaskContext({
          kind: 'review-item',
          connectorBindings: { reasoning: 'mock-llm@1' },
          input,
          onConnectorInvoke: async () => {
            providerCalled = true;
            return { invocationId: 'inv-err', state: 'FAILED' };
          },
        });

        await expect(itemReviewHandler(ctx)).rejects.toThrow();

        // Assert zero side-effects
        expect(readArtifactCalls).toHaveLength(0);
        expect(connectorCalls).toHaveLength(0);
        expect(providerCalled).toBe(false);
        expect(writtenArtifacts).toHaveLength(0);
        expect(stepCalls).toHaveLength(0);
      }
    );
  });
});
