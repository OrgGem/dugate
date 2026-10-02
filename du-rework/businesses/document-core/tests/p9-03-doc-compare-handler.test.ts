import { createHash, randomUUID } from 'node:crypto';
import type { InvocationResponse, TaskDisposition } from '@du/contracts';
import type { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { documentCoreHandlers } from '../src/worker';
import { DOC_COMPARE_INPUT_VERSION, DOC_COMPARE_RESUME_VERSION } from '../src/pipelines/workflows/doc-compare';

type FakeCheckpoint = { inputHash: string; output: unknown };
type FakeArtifact = { bytes: Buffer; fileName: string; mimeType: string; purpose?: string };
type SpawnCall = {
  children: { taskKey: string; kind: string; payload: Record<string, unknown> }[];
  continuationRef: string;
};

interface HandlerHarness {
  readonly artifacts: Map<string, FakeArtifact>;
  readonly checkpoints: Map<string, FakeCheckpoint>;
  readonly spawnCalls: SpawnCall[];
  readonly waitCalls: { waitKey: string; schema: Record<string, unknown>; contextRef?: string }[];
  readonly connectorTasks: string[];
  /** Provider task that should answer FAILED, so a chunk outcome is a real failure. */
  readonly failTask?: string;
  /** Every task answers FAILED: no stage can produce evidence at all. */
  readonly failAll?: boolean;
}

const LEFT_TEXT = '## Clause A\nThe payer shall settle within thirty days.';
const RIGHT_TEXT = '## Clause A\nThe payer shall settle within ten business days.';

const validInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  inputVersion: DOC_COMPARE_INPUT_VERSION,
  left: { artifactId: 'artifact-left', fileName: 'left.pdf', text: LEFT_TEXT },
  right: { artifactId: 'artifact-right', fileName: 'right.pdf', text: RIGHT_TEXT },
  ...overrides,
});

function createHarness(options: { failTask?: string; failAll?: boolean } = {}): HandlerHarness {
  return {
    artifacts: new Map(),
    checkpoints: new Map(),
    spawnCalls: [],
    waitCalls: [],
    connectorTasks: [],
    failTask: options.failTask,
    failAll: options.failAll,
  };
}

function createSdkContext(
  harness: HandlerHarness,
  input: Record<string, unknown>,
  taskKey = 'doc-compare-root',
  options: { missingSlot?: boolean } = {}
): SdkTaskContext {
  const bindings: Record<string, string> = { reasoning: 'connector-reasoning@1' };
  if (options.missingSlot) delete bindings.reasoning;

  const context = {
    taskId: randomUUID(),
    operationId: randomUUID(),
    tenantId: 'tenant-from-claim',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'doc-compare',
    kind: 'doc-compare',
    taskKey,
    attempt: 1,
    leaseEpoch: 1,
    deadlineAt: null,
    signal: new AbortController().signal,
    cancelRequested: false,
    input,
    connectorBindings: bindings,
    checkpoints: () =>
      [...harness.checkpoints.entries()].map(([stepKey, value]) => ({
        stepKey,
        generation: 0,
        inputHash: value.inputHash,
        status: 'SUCCEEDED' as const,
        outputRef: 'artifact://checkpoint',
      })),
    step: {
      run: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
        const existing = harness.checkpoints.get(stepKey);
        if (existing) {
          if (existing.inputHash !== inputHash) throw new Error('INPUT_HASH_MISMATCH');
          return existing.output as T;
        }
        const output = await fn();
        harness.checkpoints.set(stepKey, { inputHash, output });
        return output;
      },
      peek: async () => null,
    },
    spawn: {
      spawnAndWait: async (
        children: { taskKey: string; kind: string; payload: Record<string, unknown> }[],
        _joinPolicy: 'all-success',
        continuationRef: string
      ): Promise<TaskDisposition> => {
        harness.spawnCalls.push({ children, continuationRef });
        return { kind: 'waiting-children' };
      },
    },
    wait: {
      waitForInput: async (
        waitKey: string,
        schema: Record<string, unknown>,
        opts?: { contextRef?: string }
      ): Promise<TaskDisposition> => {
        harness.waitCalls.push({ waitKey, schema, contextRef: opts?.contextRef });
        return { kind: 'waiting-input', waitId: `wait-${waitKey}` };
      },
    },
    progress: { report: async () => undefined },
    artifacts: {
      read: async (artifactId: string): Promise<Buffer> => {
        const artifact = harness.artifacts.get(artifactId);
        if (!artifact) throw new Error('artifact missing');
        return artifact.bytes;
      },
      write: async (content: Buffer | string, fileName: string, mimeType: string, purpose?: string) => {
        const artifactId = randomUUID();
        harness.artifacts.set(artifactId, {
          bytes: typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content),
          fileName,
          mimeType,
          purpose,
        });
        return { artifactId, role: purpose ?? 'output', fileName, mimeType };
      },
      writeStream: async () => {
        throw new Error('not used by the doc-compare handler test');
      },
      accessGrant: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    },
    connector: {
      invoke: async (slot: string, inputValue: unknown): Promise<InvocationResponse> => {
        const record = (inputValue ?? {}) as Record<string, unknown>;
        const task = typeof record.task === 'string' ? record.task : '';
        const payload = (record.payload ?? {}) as Record<string, unknown>;
        const chunkId = typeof payload.chunkId === 'string' ? payload.chunkId : 'unknown';
        harness.connectorTasks.push(`${slot}:${task}`);
        if (harness.failAll || harness.failTask === task) {
          return {
            invocationId: `failed-${chunkId}`,
            state: 'FAILED',
            error: { code: 'PROVIDER_FAILED', message: 'provider refused the chunk', retryable: false },
          };
        }
        if (task === 'doc_compare_structure') {
          return {
            invocationId: `structure-${chunkId}`,
            state: 'SUCCEEDED',
            result: {
              data: {
                structureClaims: [
                  {
                    claimId: `sc-${chunkId}`,
                    verdict: 'modified',
                    leftSectionId: `${chunkId}-left`,
                    rightSectionId: `${chunkId}-right`,
                    leftTitle: 'Clause A',
                    rightTitle: 'Clause A',
                    detail: 'The settlement window changed.',
                    evidenceChunkIds: [chunkId],
                  },
                ],
              },
            },
          };
        }
        return {
          invocationId: `references-${chunkId}`,
          state: 'SUCCEEDED',
          result: {
            data: {
              referenceClaims: [
                {
                  claimId: `rc-${chunkId}`,
                  verdict: 'resolved',
                  reference: 'Clause A',
                  sectionId: `${chunkId}-left`,
                  side: 'left',
                  target: 'Clause A',
                  detail: 'The reference resolves.',
                  evidenceChunkIds: [chunkId],
                },
              ],
            },
          },
        };
      },
    },
  };
  return context as unknown as SdkTaskContext;
}

function deliver(
  harness: HandlerHarness,
  input: Record<string, unknown>,
  taskKey = 'doc-compare-root',
  options: { missingSlot?: boolean } = {}
): Promise<TaskDisposition> {
  return documentCoreHandlers['doc-compare']!(
    createSdkContext(harness, input, taskKey, options),
    input
  );
}

interface FlowResult { dispositions: TaskDisposition[] }

/** Drive the root delivery until it stops yielding children. */
async function runFlow(harness: HandlerHarness, input: Record<string, unknown>): Promise<FlowResult> {
  const dispositions: TaskDisposition[] = [];
  let payload = input;
  let disposition = await deliver(harness, payload);
  dispositions.push(disposition);

  while (disposition.kind === 'waiting-children') {
    const call = harness.spawnCalls[harness.spawnCalls.length - 1]!;
    const joinSummary: Record<string, string> = {};
    for (const child of call.children) {
      const childDisposition = await deliver(harness, child.payload, child.taskKey);
      if (childDisposition.kind !== 'completed') {
        throw new Error(`chunk ${child.taskKey} ended as ${childDisposition.kind}`);
      }
      joinSummary[child.taskKey] = childDisposition.resultRef;
    }
    payload = { continuationRef: call.continuationRef, joinPolicy: 'all-success', joinSummary };
    disposition = await deliver(harness, payload);
    dispositions.push(disposition);
  }
  return { dispositions };
}

function completedRef(disposition: TaskDisposition | undefined): string {
  if (!disposition || disposition.kind !== 'completed') {
    throw new Error(`expected a completed disposition, got ${disposition?.kind ?? 'none'}`);
  }
  return disposition.resultRef;
}

function readArtifact(harness: HandlerHarness, resultRef: string): Record<string, unknown> {
  const artifactId = /^artifact:\/\/(.+)$/.exec(resultRef)?.[1];
  const artifact = artifactId ? harness.artifacts.get(artifactId) : undefined;
  if (!artifact) throw new Error(`missing artifact for ${resultRef}`);
  return JSON.parse(artifact.bytes.toString('utf8')) as Record<string, unknown>;
}

describe('P9-03 doc-compare handler', () => {
  it('fails closed when the reasoning connector slot is not bound', async () => {
    const harness = createHarness();
    await expect(
      deliver(harness, validInput(), 'doc-compare-root', { missingSlot: true }),
    ).rejects.toMatchObject({ code: 'DOC_COMPARE_CONNECTOR_SLOT_MISSING' });
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.connectorTasks).toHaveLength(0);
  });

  it('rejects unsupported input instead of silently normalising it away', async () => {
    const harness = createHarness();
    const cases: Record<string, unknown>[] = [
      validInput({ tenantId: 'tenant-a' }),
      validInput({ inputVersion: 'doc-compare-input-v0' }),
      validInput({ maxConcurrency: 99 }),
      validInput({ requireHumanReview: 'yes' }),
      validInput({ left: { artifactId: 'artifact-left', fileName: 'left.pdf', text: 'x', sections: [] } }),
      validInput({ left: { artifactId: '', fileName: 'left.pdf', text: 'x' } }),
    ];
    for (const payload of cases) {
      await expect(deliver(harness, payload)).rejects.toMatchObject({ code: 'DOC_COMPARE_INPUT_INVALID' });
    }
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('fans out both stages, joins them and writes a result carrying the evidence', async () => {
    const harness = createHarness();
    const { dispositions } = await runFlow(harness, validInput());

    expect(dispositions.map((d) => d.kind)).toEqual([
      'waiting-children',
      'waiting-children',
      'completed',
    ]);
    expect(harness.spawnCalls.map((call) => call.continuationRef)).toEqual([
      'doc-compare:v1:compare-structure:doc-compare:doc-compare-input-v1:compare-structure',
      'doc-compare:v1:compare-references:doc-compare:doc-compare-input-v1:compare-references',
    ]);
    expect(harness.connectorTasks).toContain('reasoning:doc_compare_structure');
    expect(harness.connectorTasks).toContain('reasoning:doc_compare_references');

    const result = readArtifact(harness, completedRef(dispositions[2]));
    expect(result.resultVersion).toBe('doc-compare-result-v1');
    expect(result.businessId).toBe('document-core');
    const evidence = result.evidence as Record<string, unknown>;
    expect(evidence.evidenceVersion).toBe('doc-compare-evidence-v1');
    expect(evidence.chunkCount).toBe(4);
    expect((evidence.structureClaims as unknown[]).length).toBe(2);
    expect((evidence.referenceClaims as unknown[]).length).toBe(2);
    expect(evidence.verdictCounts).toMatchObject({ modified: 2 });
    expect(evidence.incompleteChunks).toEqual([]);
    expect(result.incompleteChunks).toEqual([]);
  });

  it('records a failed chunk in incompleteChunks instead of reporting a clean total', async () => {
    const harness = createHarness({ failTask: 'doc_compare_references' });
    const { dispositions } = await runFlow(harness, validInput());

    const result = readArtifact(harness, completedRef(dispositions[2]));
    const evidence = result.evidence as Record<string, unknown>;
    expect(evidence.structureClaims).toHaveLength(2);
    expect(evidence.referenceClaims).toHaveLength(0);
    expect(evidence.incompleteChunks).toEqual(['left-c0', 'right-c0']);
    expect(result.incompleteChunks).toEqual(['left-c0', 'right-c0']);
  });

  it('refuses to complete when every chunk failed, even with partial failure allowed', async () => {
    // Both stages fail, so nothing was compared. A result with chunkCount 0 and
    // no claims reads as a clean comparison of two documents never opened, so
    // the handler must fail closed rather than write it.
    const harness = createHarness({ failAll: true });

    await expect(
      runFlow(harness, validInput({ continueOnPartialFailure: true })),
    ).rejects.toMatchObject({ code: 'DOC_COMPARE_RESULT_INVALID' });
    // Both stages were still fanned out and joined before the merge refused.
    expect(harness.spawnCalls).toHaveLength(2);
    expect(harness.connectorTasks).toContain('reasoning:doc_compare_structure');
    expect(harness.connectorTasks).toContain('reasoning:doc_compare_references');
  });

  it('fails the operation instead of writing a partial result when partial failure is refused', async () => {
    const harness = createHarness({ failTask: 'doc_compare_references' });
    await expect(
      runFlow(harness, validInput({ continueOnPartialFailure: false })),
    ).rejects.toMatchObject({ code: 'CHUNK_FAILED' });
  });

  it('waits for a human review and fails closed when the review is rejected', async () => {
    const harness = createHarness();
    const { dispositions } = await runFlow(harness, validInput({ requireHumanReview: true }));

    expect(dispositions.map((d) => d.kind)).toEqual([
      'waiting-children',
      'waiting-children',
      'waiting-input',
    ]);
    expect(harness.waitCalls).toHaveLength(1);
    expect(harness.waitCalls[0]!.waitKey).toBe('doc-compare-review-v1');
    expect((harness.waitCalls[0]!.schema as { required: string[] }).required).toEqual([
      'resumeSchemaVersion',
      'accepted',
    ]);
    expect(harness.waitCalls[0]!.contextRef).toMatch(/^artifact:\/\//);

    const reviewEvidence = readArtifact(harness, harness.waitCalls[0]!.contextRef!);
    expect(reviewEvidence.schemaVersion).toBe('doc-compare-review-evidence-v1');
    expect((reviewEvidence.evidence as Record<string, unknown>).chunkCount).toBe(4);

    await expect(
      deliver(harness, {
        resumeInput: { resumeSchemaVersion: DOC_COMPARE_RESUME_VERSION, accepted: false, acceptedBy: 'reviewer' },
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_REJECTED' });
  });

  it('refuses a join whose chunk set does not match the chunks issued for the stage', async () => {
    const harness = createHarness();
    await expect(deliver(harness, validInput())).resolves.toMatchObject({ kind: 'waiting-children' });
    const call = harness.spawnCalls[0]!;

    const joinSummary: Record<string, string> = {};
    for (const child of call.children) {
      joinSummary[child.taskKey] = completedRef(await deliver(harness, child.payload, child.taskKey));
    }
    joinSummary['left-c99'] = joinSummary[call.children[0]!.taskKey]!;

    await expect(
      deliver(harness, { continuationRef: call.continuationRef, joinPolicy: 'all-success', joinSummary }),
    ).rejects.toMatchObject({ code: 'DOC_COMPARE_CHUNK_RESULT_MISSING' });
  });

  it('rejects a join token that does not match the saved workflow state', async () => {
    const harness = createHarness();
    await deliver(harness, validInput());
    const call = harness.spawnCalls[0]!;

    const forged =
      'doc-compare:v1:compare-structure:doc-compare:doc-compare-input-v1:compare-references';
    await expect(
      deliver(harness, { continuationRef: forged, joinPolicy: 'all-success', joinSummary: {} }),
    ).rejects.toMatchObject({ code: 'DOC_COMPARE_CONTINUATION_INVALID' });
  });
});
