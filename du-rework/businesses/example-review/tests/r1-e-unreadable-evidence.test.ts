import { createHash } from 'node:crypto';
import { itemReviewHandler, mainReviewHandler } from '../src/review';
import {
  createMockTaskContext,
  type MockTaskContextOptions,
  type StoredCheckpoint,
} from './test-helper';

const secretSentinel = [
  'SENTINEL_API_KEY=credential-sentinel',
  'https://files.example.test/private/customer-contract.pdf?X-Amz-Signature=signature-sentinel',
  '/srv/private/customer-contract.pdf',
].join(' ');
const secretSentinelFragments = [
  'SENTINEL_API_KEY=credential-sentinel',
  'X-Amz-Signature=signature-sentinel',
  '/srv/private/customer-contract.pdf',
];

function writtenArtifactText(artifacts: Array<{ content: Buffer | string }>): string {
  return artifacts
    .map(({ content }) => typeof content === 'string' ? content : content.toString('utf8'))
    .join('\n');
}

function unreadableArtifactError(status: 403 | 404): Error {
  return Object.assign(new Error(`artifact service returned ${status}`), { status });
}

function failArtifactReads(
  ctx: ReturnType<typeof createMockTaskContext>['ctx'],
  status: 403 | 404
): string[] {
  const readIds: string[] = [];
  ctx.artifacts.read = async (artifactId: string): Promise<Buffer> => {
    readIds.push(artifactId);
    throw unreadableArtifactError(status);
  };
  return readIds;
}

describe('R1-E / FR24-14 unreadable review evidence fails closed', () => {
  it.each([403, 404] as const)(
    'does not create a passing child review when source artifact read returns %i',
    async (status) => {
      const { ctx, writtenArtifacts, connectorCalls } = createMockTaskContext({
        kind: 'review-item',
        input: {
          reviewId: `rev-child-source-${status}`,
          itemIndex: 0,
          artifact: { artifactId: 'source-unavailable', fileName: 'source.pdf' },
        },
      });
      const readIds = failArtifactReads(ctx, status);

      await expect(itemReviewHandler(ctx)).rejects.toThrow(/Unable to read source artifact/);
      expect(readIds).toEqual(['source-unavailable']);
      expect(writtenArtifacts).toHaveLength(0);
      expect(connectorCalls).toHaveLength(0);
    }
  );

  it('does not create a single-item approval or wait when source evidence is unreadable', async () => {
    const { ctx, writtenArtifacts, waitCalls, connectorCalls } = createMockTaskContext({
      input: {
        reviewId: 'rev-root-source-404',
        artifacts: [{ artifactId: 'missing-source', fileName: 'source.pdf' }],
        requireApproval: true,
      },
    });
    const readIds = failArtifactReads(ctx, 404);

    await expect(mainReviewHandler(ctx)).rejects.toThrow(/Unable to read source artifact/);
    expect(readIds).toEqual(['missing-source']);
    expect(writtenArtifacts).toHaveLength(0);
    expect(waitCalls).toHaveLength(0);
    expect(connectorCalls).toHaveLength(0);
  });

  it('keeps provider errors, reasoning output, and raw exceptions out of review artifacts', async () => {
    const runReview = async (
      handler: typeof itemReviewHandler,
      kind: string,
      input: Record<string, unknown>,
      onConnectorInvoke: NonNullable<MockTaskContextOptions['onConnectorInvoke']>
    ): Promise<{ artifacts: string; logs: string }> => {
      const { ctx, writtenArtifacts } = createMockTaskContext({ kind, input, onConnectorInvoke });
      const errorSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await handler(ctx);
        return {
          artifacts: writtenArtifactText(writtenArtifacts),
          logs: JSON.stringify(errorSpy.mock.calls) ?? '',
        };
      } finally {
        errorSpy.mockRestore();
      }
    };

    const childInput = {
      reviewId: 'rev-sentinel-child',
      itemIndex: 0,
      artifact: { artifactId: 'art-1', fileName: 'source.pdf' },
      enableReasoning: true,
    };
    const singleItemInput = {
      reviewId: 'rev-sentinel-root',
      artifacts: [{ artifactId: 'art-1', fileName: 'source.pdf' }],
      enableReasoning: true,
    };
    const providerFailure = async () => ({
      invocationId: 'inv-sentinel-failed',
      state: 'FAILED' as const,
      error: { code: 'PROVIDER_ERROR', message: secretSentinel, retryable: false },
    });
    const providerSuccessWithSensitiveText = async () => ({
      invocationId: 'inv-sentinel-success',
      state: 'SUCCEEDED' as const,
      result: { content: `COMPLIANCE_FAILED ${secretSentinel}` },
      usage: { inputTokens: 1, outputTokens: 1, costMicrousd: 1, measurement: 'measured' as const },
    });
    const providerException = async () => {
      throw new Error(secretSentinel);
    };

    const reviewOutputs = [
      await runReview(itemReviewHandler, 'review-item', childInput, providerFailure),
      await runReview(itemReviewHandler, 'review-item', childInput, providerException),
      await runReview(mainReviewHandler, 'review', singleItemInput, providerFailure),
      await runReview(mainReviewHandler, 'review', singleItemInput, providerSuccessWithSensitiveText),
      await runReview(mainReviewHandler, 'review', singleItemInput, providerException),
    ];
    for (const output of reviewOutputs) {
      for (const fragment of [secretSentinel, ...secretSentinelFragments]) {
        expect(output.artifacts).not.toContain(fragment);
        expect(output.logs).not.toContain(fragment);
      }
    }
    expect(reviewOutputs[1]!.logs).toContain('REASONING_INVOCATION_FAILED');
    expect(reviewOutputs[1]!.logs).not.toContain('details');
    expect(reviewOutputs[0]!.logs).toContain('REASONING_PROVIDER_FAILED');
    expect(reviewOutputs[2]!.logs).toContain('REASONING_PROVIDER_FAILED');
    expect(reviewOutputs[4]!.logs).toContain('REASONING_INVOCATION_FAILED');

    const legacyChildResult = Buffer.from(JSON.stringify({
      reviewId: 'rev-sentinel-legacy-child',
      itemIndex: 0,
      artifactId: 'art-1',
      passed: true,
      failedChecks: [],
      reasoning: secretSentinel,
      reviewedAt: '2026-09-25T00:00:00.000Z',
    })).toString('base64');
    const joined = createMockTaskContext({
      input: {
        continuationRef: 'join:rev-sentinel-legacy-child',
        joinSummary: { 'item-0': `data:application/json;base64,${legacyChildResult}` },
      },
    });
    await mainReviewHandler(joined.ctx);
    const joinedArtifactText = writtenArtifactText(joined.writtenArtifacts);
    for (const fragment of [secretSentinel, ...secretSentinelFragments]) {
      expect(joinedArtifactText).not.toContain(fragment);
    }

    const legacyReviewId = 'rev-sentinel-legacy-checkpoint';
    const artifacts = [{ artifactId: 'art-1', fileName: 'source.pdf' }];
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ reviewId: legacyReviewId, artifacts, checks: undefined, enableReasoning: false }))
      .digest('hex');
    const legacyCheckpoint = createMockTaskContext({
      input: { reviewId: legacyReviewId, artifacts },
      checkpointsStore: new Map<string, StoredCheckpoint>([[
        `evaluate-items:${legacyReviewId}`,
        {
          stepKey: `evaluate-items:${legacyReviewId}`,
          inputHash,
          output: {
            items: [{
              reviewId: legacyReviewId,
              itemIndex: 0,
              artifactId: 'art-1',
              fileName: 'source.pdf',
              passed: true,
              failedChecks: [],
              reasoning: secretSentinel,
              reviewedAt: '2026-09-25T00:00:00.000Z',
            }],
            reviewsRef: 'artifact://legacy-review-items',
            evidenceVersion: 1,
          },
          status: 'SUCCEEDED',
        },
      ]]),
    });
    await expect(mainReviewHandler(legacyCheckpoint.ctx)).rejects.toThrow(/outdated evidence policy/);
    const legacyArtifactText = writtenArtifactText(legacyCheckpoint.writtenArtifacts);
    for (const fragment of [secretSentinel, ...secretSentinelFragments]) {
      expect(legacyArtifactText).not.toContain(fragment);
    }
  });

  it('does not log raw resume exceptions', async () => {
    const { ctx, writtenArtifacts } = createMockTaskContext({
      input: { resumeInput: { approved: true } },
    });
    ctx.checkpoints = () => {
      throw new Error(secretSentinel);
    };
    const errorSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await expect(mainReviewHandler(ctx)).rejects.toThrow(secretSentinel);
      expect(errorSpy).toHaveBeenCalled();
      const record = JSON.parse(String(errorSpy.mock.calls[0]![0])) as Record<string, unknown>;
      expect(record).toMatchObject({ message: '[example-review] review operation failed', errorCode: 'REVIEW_RESUME_FAILED' });
      expect(record).not.toHaveProperty('details');
      const logs = JSON.stringify(errorSpy.mock.calls);
      for (const fragment of [secretSentinel, ...secretSentinelFragments]) {
        expect(logs).not.toContain(fragment);
      }
      expect(writtenArtifacts).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([403, 404] as const)(
    'does not synthesize a passing child result when its result artifact read returns %i',
    async (status) => {
      const { ctx, writtenArtifacts, waitCalls } = createMockTaskContext({
        input: {
          continuationRef: `join:rev-child-result-${status}:requireApproval`,
          joinSummary: { 'item-0': 'artifact://unreadable-child-result' },
        },
      });
      const readIds = failArtifactReads(ctx, status);

      await expect(mainReviewHandler(ctx)).rejects.toThrow(/Unable to read child review result/);
      expect(readIds).toEqual(['unreadable-child-result']);
      expect(writtenArtifacts).toHaveLength(0);
      expect(waitCalls).toHaveLength(0);
    }
  );

  it('fails closed on a missing child result instead of approving the readable subset', async () => {
    const validChildResult = Buffer.from(JSON.stringify({
      reviewId: 'rev-partial-join',
      itemIndex: 0,
      artifactId: 'source-0',
      passed: true,
      failedChecks: [],
      reviewedAt: '2026-09-25T00:00:00.000Z',
    })).toString('base64');
    const { ctx, writtenArtifacts, waitCalls } = createMockTaskContext({
      input: {
        continuationRef: 'join:rev-partial-join:requireApproval',
        joinSummary: {
          'item-0': `data:application/json;base64,${validChildResult}`,
          'item-1': null,
        },
      },
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(/item-1 is missing/);
    expect(writtenArtifacts).toHaveLength(0);
    expect(waitCalls).toHaveLength(0);
  });

  it('fails closed when a readable child result artifact contains invalid JSON', async () => {
    const { ctx, writtenArtifacts, waitCalls } = createMockTaskContext({
      input: {
        continuationRef: 'join:rev-corrupt-result:requireApproval',
        joinSummary: { 'item-0': 'artifact://corrupt-child-result' },
      },
      artifactsMap: { 'corrupt-child-result': Buffer.from('{"passed": true', 'utf8') },
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(/is not valid JSON/);
    expect(writtenArtifacts).toHaveLength(0);
    expect(waitCalls).toHaveLength(0);
  });

  it('does not approve a legacy checkpoint that lacks evidence verification metadata', async () => {
    const reviewId = 'rev-legacy-checkpoint';
    const checkpointsStore = new Map<string, StoredCheckpoint>([[
      `evaluate-items:${reviewId}`,
      {
        stepKey: `evaluate-items:${reviewId}`,
        inputHash: 'legacy-input-hash',
        output: {
          items: [{
            reviewId,
            itemIndex: 0,
            artifactId: 'unreadable-source',
            passed: true,
            failedChecks: [],
            reviewedAt: '2026-09-25T00:00:00.000Z',
          }],
          reviewsRef: 'artifact://legacy-review-items',
        },
        status: 'SUCCEEDED',
      },
    ]]);
    const { ctx, writtenArtifacts } = createMockTaskContext({
      input: { resumeInput: { approved: true } },
      checkpointsStore,
    });
    const errorSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await expect(mainReviewHandler(ctx)).rejects.toThrow(/outdated evidence policy/);
      expect(writtenArtifacts).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not replay a legacy passing checkpoint into an automatic approval', async () => {
    const reviewId = 'rev-legacy-replay';
    const artifacts = [{ artifactId: 'source-unavailable' }];
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ reviewId, artifacts, checks: undefined, enableReasoning: false }))
      .digest('hex');
    const checkpointsStore = new Map<string, StoredCheckpoint>([[
      `evaluate-items:${reviewId}`,
      {
        stepKey: `evaluate-items:${reviewId}`,
        inputHash,
        output: {
          items: [{
            reviewId,
            itemIndex: 0,
            artifactId: 'source-unavailable',
            passed: true,
            failedChecks: [],
            reviewedAt: '2026-09-25T00:00:00.000Z',
          }],
          reviewsRef: 'artifact://legacy-review-items',
          evidenceVersion: 1,
        },
        status: 'SUCCEEDED',
      },
    ]]);
    const { ctx, writtenArtifacts } = createMockTaskContext({
      input: { reviewId, artifacts },
      checkpointsStore,
    });

    await expect(mainReviewHandler(ctx)).rejects.toThrow(/outdated evidence policy/);
    expect(writtenArtifacts).toHaveLength(0);
  });
});
