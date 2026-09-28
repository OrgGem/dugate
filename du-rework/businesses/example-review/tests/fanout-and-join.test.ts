import { mainReviewHandler } from '../src/review';
import { createMockTaskContext } from './test-helper';

describe('Bounded Child Review Plan & Join (P7-01 / P7-02 / A07-01 / R08-05)', () => {
  it('plans and spawns bounded child tasks for multi-artifact review and yields with waiting-children', async () => {
    const { ctx, spawnCalls } = createMockTaskContext({
      kind: 'review',
      input: {
        reviewId: 'rev-multi-01',
        artifacts: [
          { artifactId: 'art-1', fileName: 'doc1.pdf' },
          { artifactId: 'art-2', fileName: 'doc2.pdf' },
          { artifactId: 'art-3', fileName: 'doc3.pdf' },
        ],
        checks: { 'security-baseline': true },
        enableReasoning: true,
      },
    });

    const disposition = await mainReviewHandler(ctx);

    // Expect parent to yield with waiting-children (RUN-05)
    expect(disposition.kind).toBe('waiting-children');

    expect(spawnCalls).toHaveLength(1);
    const spawn = spawnCalls[0]!;
    expect(spawn.joinPolicy).toBe('all-success');
    expect(spawn.continuationRef).toBe('join:rev-multi-01');
    expect(spawn.children).toHaveLength(3);

    expect(spawn.children[0]).toEqual({
      taskKey: 'item-0',
      kind: 'review-item',
      payload: {
        reviewId: 'rev-multi-01',
        itemIndex: 0,
        artifact: { artifactId: 'art-1', fileName: 'doc1.pdf' },
        checks: { 'security-baseline': true },
        enableReasoning: true,
      },
    });

    expect(spawn.children[1]!.taskKey).toBe('item-1');
    expect(spawn.children[2]!.taskKey).toBe('item-2');
  });

  it('rejects client-supplied childReviews to prevent bypassing review (A07-01)', async () => {
    const { ctx } = createMockTaskContext({
      kind: 'review',
      input: {
        reviewId: 'rev-multi-bypass',
        artifacts: [
          { artifactId: 'art-1', fileName: 'doc1.pdf' },
          { artifactId: 'art-2', fileName: 'doc2.pdf' },
        ],
        childReviews: [
          { artifactId: 'art-1', passed: true },
        ],
      },
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(
      /childReviews cannot be supplied by client; document review cannot be bypassed/
    );
  });

  it('processes single-document review inline and produces valid reviewsRef (A07-02)', async () => {
    const { ctx, writtenArtifacts, spawnCalls } = createMockTaskContext({
      kind: 'review',
      input: {
        reviewId: 'rev-single-inline',
        artifacts: [{ artifactId: 'art-1', fileName: 'single.pdf' }],
        checks: { 'doc-valid': true },
      },
    });

    const disposition = await mainReviewHandler(ctx);

    // Single artifact runs inline: no child spawn
    expect(spawnCalls).toHaveLength(0);
    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(disposition.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);
    }

    // Both items review artifact and output review artifact are written
    expect(writtenArtifacts).toHaveLength(2);
    const itemsArt = writtenArtifacts.find((a) => a.fileName === 'rev-single-inline-items.review.json');
    const outputArt = writtenArtifacts.find((a) => a.fileName === 'rev-single-inline.review.json');
    expect(itemsArt).toBeDefined();
    expect(outputArt).toBeDefined();

    const output = JSON.parse(outputArt!.content.toString('utf8'));
    expect(output.reviewId).toBe('rev-single-inline');
    expect(output.itemCount).toBe(1);
    expect(output.approved).toBe(true);
    // Non-circular valid reviewsRef
    expect(output.reviewsRef).toBe(`artifact://${itemsArt!.artifactId}`);
  });

  it('blocks multi-document child join resumption until platform lane publishes typed continuation contract (R08-05)', async () => {
    // In @du/worker-sdk, TaskContext does not yet expose a public typed continuation interface
    // for reading authoritative child task results upon join resumption.
    const { ctx } = createMockTaskContext({
      kind: 'review',
      input: {
        reviewId: 'rev-multi-join-blocked',
        artifacts: [
          { artifactId: 'art-1', fileName: 'doc1.pdf' },
          { artifactId: 'art-2', fileName: 'doc2.pdf' },
        ],
      },
    });

    const raw = ctx as unknown as Record<string, unknown>;
    expect(raw['joinedChildren']).toBeUndefined();
    expect(raw['childrenResults']).toBeUndefined();
    expect(raw['continuation']).toBeUndefined();

    // The handler does not attempt to fake join or bypass child review;
    // it correctly spawns child tasks and yields waiting-children.
    const disposition = await mainReviewHandler(ctx);
    expect(disposition.kind).toBe('waiting-children');
  });
});
