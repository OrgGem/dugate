import { mainReviewHandler } from '../src/review';
import { createMockTaskContext } from './test-helper';

describe('Approval Wait & Resume Contract (P7-01 / P7-02 / A07-01 / A07-02 / A07-04)', () => {
  const originalInput = {
    reviewId: 'rev-hitl-01',
    artifacts: [{ artifactId: 'art-1', fileName: 'loan-doc.pdf' }],
    requireApproval: true,
  };

  it('durable approval context: initial run -> wait -> fresh context -> approval with unchanged original input (A07-01 / A07-02)', async () => {
    // 1. Initial execution: evaluates items, saves checkpoint, writes items artifact, and requests approval wait
    const { ctx: initCtx, waitCalls, writtenArtifacts: initArtifacts, checkpointsStore, artifactsMap } = createMockTaskContext({
      kind: 'review',
      input: originalInput, // Unchanged original input
    });

    const initDisposition = await mainReviewHandler(initCtx);

    // Yields waiting-input (RUN-06)
    expect(initDisposition.kind).toBe('waiting-input');
    if (initDisposition.kind === 'waiting-input') {
      expect(initDisposition.waitId).toBeDefined();
    }

    // Persisted intermediate items review artifact before wait
    expect(initArtifacts).toHaveLength(1);
    const itemsArtifact = initArtifacts[0]!;
    expect(itemsArtifact.fileName).toBe('rev-hitl-01-items.review.json');
    expect(itemsArtifact.role).toBe('intermediate');

    // Context reference points to the valid items artifact
    expect(waitCalls).toHaveLength(1);
    const waitCall = waitCalls[0]!;
    expect(waitCall.waitKey).toBe('approval-wait');
    expect(waitCall.opts).toEqual({
      contextRef: `artifact://${itemsArtifact.artifactId}`,
    });

    // Checkpoint for evaluate-items was recorded
    expect(checkpointsStore.has('evaluate-items:rev-hitl-01')).toBe(true);

    // 2. Resumption in fresh context / process with unchanged original input and NO injected childReviews (A07-01)
    const { ctx: resumeCtx, writtenArtifacts: resumeArtifacts, stepCalls } = createMockTaskContext({
      kind: 'review',
      input: originalInput, // Exact same original input, NO childReviews injected
      checkpointsStore, // Durable checkpoint from previous execution
      artifactsMap, // Storage with previously written artifacts
      waitResponse: {
        approved: true,
        note: 'Audit team verified compliance standards',
        approver: 'lead-compliance-officer',
      },
    });

    const resumeDisposition = await mainReviewHandler(resumeCtx);

    expect(resumeDisposition.kind).toBe('completed');
    if (resumeDisposition.kind === 'completed') {
      expect(resumeDisposition.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);
    }

    // Checkpoint was replayed (not re-executed from scratch)
    const evaluateStep = stepCalls.find((s) => s.stepKey === 'evaluate-items:rev-hitl-01');
    expect(evaluateStep).toBeDefined();
    expect(evaluateStep!.replayed).toBe(true);

    // 3. Test downloaded persisted bytes, verifying reviewsRef is valid and non-empty (A07-02)
    expect(resumeArtifacts.length).toBeGreaterThanOrEqual(1);
    const outputArtifactRecord = resumeArtifacts.find((a) => a.fileName === 'rev-hitl-01.review.json');
    expect(outputArtifactRecord).toBeDefined();

    // Verify downloaded bytes directly from artifact store
    const downloadedBuffer = await resumeCtx.artifacts.read(outputArtifactRecord!.artifactId);
    const output = JSON.parse(downloadedBuffer.toString('utf8'));

    expect(output.reviewId).toBe('rev-hitl-01');
    expect(output.approved).toBe(true);
    expect(output.itemCount).toBe(1);

    // reviewsRef MUST NOT be empty, must be a valid artifact URI pointing to items artifact
    expect(output.reviewsRef).toBe(`artifact://${itemsArtifact.artifactId}`);
    expect(output.items).toHaveLength(1);
    expect(output.items[0].artifactId).toBe('art-1');
    expect(output.items[0].passed).toBe(true);

    expect(output.approval).toMatchObject({
      approved: true,
      note: 'Audit team verified compliance standards',
      approver: 'lead-compliance-officer',
    });
    expect(output.summary).toContain('Review rev-hitl-01 approved');
  });

  it('resumes with human rejection and marks overall review not approved with valid reviewsRef', async () => {
    // Seed checkpoint and storage
    const { checkpointsStore, artifactsMap } = createMockTaskContext({
      kind: 'review',
      input: { reviewId: 'rev-hitl-rej', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
    });
    // First run to seed
    await mainReviewHandler(
      createMockTaskContext({
        kind: 'review',
        input: { reviewId: 'rev-hitl-rej', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
        checkpointsStore,
        artifactsMap,
      }).ctx
    );

    // Resume with human rejection
    const { ctx: resumeCtx, writtenArtifacts } = createMockTaskContext({
      kind: 'review',
      input: { reviewId: 'rev-hitl-rej', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
      checkpointsStore,
      artifactsMap,
      waitResponse: {
        approved: false,
        note: 'Signature mismatch on page 4',
        approver: 'auditor-jane',
      },
    });

    const disposition = await mainReviewHandler(resumeCtx);
    expect(disposition.kind).toBe('completed');

    const outputRecord = writtenArtifacts.find((a) => a.fileName === 'rev-hitl-rej.review.json');
    expect(outputRecord).toBeDefined();

    const downloaded = JSON.parse((await resumeCtx.artifacts.read(outputRecord!.artifactId)).toString('utf8'));
    expect(downloaded.approved).toBe(false);
    expect(downloaded.reviewsRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);
    expect(downloaded.approval.approved).toBe(false);
    expect(downloaded.approval.note).toBe('Signature mismatch on page 4');
  });

  it('rejects malformed waitResponse on resume (A07-04)', async () => {
    const { checkpointsStore, artifactsMap } = createMockTaskContext({
      kind: 'review',
      input: { reviewId: 'rev-malformed-wait', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
    });
    await mainReviewHandler(
      createMockTaskContext({
        kind: 'review',
        input: { reviewId: 'rev-malformed-wait', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
        checkpointsStore,
        artifactsMap,
      }).ctx
    );

    // Resuming with string 'false' instead of boolean must throw
    const { ctx: badCtx } = createMockTaskContext({
      kind: 'review',
      input: { reviewId: 'rev-malformed-wait', artifacts: [{ artifactId: 'art-1' }], requireApproval: true },
      checkpointsStore,
      artifactsMap,
      waitResponse: {
        approved: 'false', // Non-boolean
      },
    });

    await expect(mainReviewHandler(badCtx)).rejects.toThrow(/approval.approved must be a boolean/);
  });
});
