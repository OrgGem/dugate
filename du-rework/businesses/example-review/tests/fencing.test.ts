import { LeaseLostError } from '@du/worker-sdk';
import { mainReviewHandler, itemReviewHandler } from '../src/review';
import { createMockTaskContext } from './test-helper';

describe('Lease-Loss & Cancellation Fencing (P7-01/P7-02)', () => {
  it('fences main review handler when cancellation is requested', async () => {
    const abortController = new AbortController();
    abortController.abort('cancel');

    const { ctx, writtenArtifacts, spawnCalls, waitCalls } = createMockTaskContext({
      kind: 'review',
      signal: abortController.signal,
      cancelRequested: true,
      input: {
        reviewId: 'rev-cancel-01',
        artifacts: [{ artifactId: 'art-1' }],
      },
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(/cancelled/);
    expect(writtenArtifacts).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
    expect(waitCalls).toHaveLength(0);
  });

  it('fences main review handler and throws LeaseLostError when lease is lost', async () => {
    const abortController = new AbortController();
    abortController.abort('lease-lost');

    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review',
      signal: abortController.signal,
      cancelRequested: false,
      input: {
        reviewId: 'rev-lease-01',
        artifacts: [{ artifactId: 'art-1' }],
      },
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(LeaseLostError);
    expect(writtenArtifacts).toHaveLength(0);
  });

  it('fences item review handler when lease is lost before execution', async () => {
    const abortController = new AbortController();
    abortController.abort('lease-lost');

    const { ctx, writtenArtifacts } = createMockTaskContext({
      kind: 'review-item',
      signal: abortController.signal,
      cancelRequested: false,
      input: {
        reviewId: 'rev-lease-item',
        itemIndex: 0,
        artifact: { artifactId: 'art-1' },
      },
    });

    await expect(itemReviewHandler(ctx)).rejects.toThrow(LeaseLostError);
    expect(writtenArtifacts).toHaveLength(0);
  });
});
