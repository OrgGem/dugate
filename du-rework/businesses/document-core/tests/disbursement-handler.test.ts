import { createHash, randomUUID } from 'node:crypto';
import type { InvocationResponse, TaskDisposition } from '@du/contracts';
import type { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { documentCoreHandlers } from '../src/worker';
import { DISBURSEMENT_INPUT_VERSION, DISBURSEMENT_RESUME_VERSION } from '../src/pipelines/workflows/disbursement';
import { STEP_KEYS } from '../src/recipes/step-keys';

type FakeCheckpoint = { inputHash: string; output: unknown };
type FakeArtifact = { bytes: Buffer; fileName: string; mimeType: string; purpose?: string };
type SpawnCall = { children: { taskKey: string; kind: string; payload: Record<string, unknown> }[]; continuationRef: string };

interface HandlerHarness {
  readonly sourceArtifactId: string;
  readonly sourceBytes: Buffer;
  readonly artifacts: Map<string, FakeArtifact>;
  readonly checkpoints: Map<string, FakeCheckpoint>;
  readonly spawnCalls: SpawnCall[];
  readonly waitCalls: { waitKey: string; schema: Record<string, unknown>; contextRef?: string }[];
  readonly connectorCalls: { slot: string; input: unknown }[];
  readonly missingSlot?: string;
  readonly emptyEvidence?: boolean;
  readonly failConnector?: string;
}

const validInput = (artifactId: string) => ({
  inputVersion: DISBURSEMENT_INPUT_VERSION,
  artifactIds: [artifactId],
  fileNames: ['payment.pdf'],
  referenceData: [{ key: 'amount', expected: 250 }],
  maxConcurrency: 2,
  failurePolicy: 'fail-closed',
  requireEncryptedEvidence: false,
});

function createHarness(options: { emptyEvidence?: boolean; failConnector?: string } = {}): HandlerHarness {
  const sourceArtifactId = randomUUID();
  const sourceBytes = Buffer.from('%PDF-1.4 disbursement evidence');
  const artifacts = new Map<string, FakeArtifact>([
    [sourceArtifactId, { bytes: sourceBytes, fileName: 'payment.pdf', mimeType: 'application/pdf' }],
  ]);
  return {
    sourceArtifactId,
    sourceBytes,
    artifacts,
    checkpoints: new Map(),
    spawnCalls: [],
    waitCalls: [],
    connectorCalls: [],
    emptyEvidence: options.emptyEvidence,
    failConnector: options.failConnector,
  };
}

function createSdkContext(
  harness: HandlerHarness,
  input: Record<string, unknown>,
  taskKey = 'disbursement-root',
  taskId: string = randomUUID(),
  options: {
    missingSlot?: string;
    /** CR06-01: pinned prompt carrier forwarded exactly as the SDK claim would. */
    pin?: { profilePolicy?: unknown; promptOverrides?: readonly unknown[] };
  } = {}
): SdkTaskContext {
  const bindings: Record<string, string> = {
    classify: 'connector-classify@1',
    extract: 'connector-extract@1',
    crosscheck: 'connector-crosscheck@1',
    report: 'connector-report@1',
  };
  if (options.missingSlot) delete bindings[options.missingSlot];

  const context = {
    taskId,
    operationId: randomUUID(),
    tenantId: 'tenant-from-claim',
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'disbursement',
    kind: 'disbursement',
    taskKey,
    attempt: 1,
    leaseEpoch: 1,
    deadlineAt: null,
    signal: new AbortController().signal,
    cancelRequested: false,
    input,
    connectorBindings: bindings,
    ...(options.pin?.profilePolicy !== undefined ? { profilePolicy: options.pin.profilePolicy } : {}),
    ...(options.pin?.promptOverrides !== undefined ? { promptOverrides: options.pin.promptOverrides } : {}),
    checkpoints: () => [...harness.checkpoints.entries()].map(([stepKey, value]) => ({
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
        opts?: { uiSchema?: Record<string, unknown>; contextRef?: string }
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
      readWithMetadata: async (artifactId: string) => {
        const artifact = harness.artifacts.get(artifactId);
        if (!artifact) throw new Error('artifact missing');
        return {
          buffer: artifact.bytes,
          filename: artifact.fileName,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.bytes.byteLength,
          sha256: createHash('sha256').update(artifact.bytes).digest('hex'),
          storageVersionId: `version-${artifactId}`,
          grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
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
      writeStream: async () => { throw new Error('not used by disbursement handler test'); },
      accessGrant: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    },
    connector: {
      invoke: async (slot: string, inputValue: unknown): Promise<InvocationResponse> => {
        harness.connectorCalls.push({ slot, input: inputValue });
        if (harness.failConnector === slot) {
          return {
            invocationId: `failed-${slot}`,
            state: 'FAILED',
            error: { code: 'PROVIDER_FAILED', message: 'provider failed', retryable: false },
          };
        }
        if (slot === 'classify') {
          return {
            invocationId: 'classify-ok',
            state: 'SUCCEEDED',
            result: {
              data: {
                logicalDocuments: harness.emptyEvidence
                  ? []
                  : [{ label: 'payment-record', sourceFile: 'payment.pdf', category: 'payment', confidence: 0.98 }],
              },
            },
          };
        }
        if (slot === 'extract') {
          return {
            invocationId: 'extract-ok',
            state: 'SUCCEEDED',
            result: {
              data: {
                records: harness.emptyEvidence
                  ? []
                  : [{ fileName: 'payment.pdf', logicalDocumentLabels: ['payment-record'], fields: { amount: 250 } }],
              },
            },
          };
        }
        if (slot === 'crosscheck') {
          return {
            invocationId: 'crosscheck-ok',
            state: 'SUCCEEDED',
            result: { data: { findings: [{ key: 'amount', status: 'match', detail: 'Amount matches.' }], matchedCount: 1, mismatchedCount: 0 } },
          };
        }
        return {
          invocationId: 'report-ok',
          state: 'SUCCEEDED',
          result: { data: 'Approved payment report.' },
        };
      },
    },
  };
  return context as unknown as SdkTaskContext;
}

async function runChild(harness: HandlerHarness, child: SpawnCall['children'][number]): Promise<TaskDisposition> {
  return documentCoreHandlers.disbursement!(
    createSdkContext(harness, child.payload, child.taskKey),
  );
}

/** CR06-01 helper: every parent/child turn carries the pinned prompt carrier. */
const PIN_FIXTURE = {
  profilePolicy: { enabled: true },
  promptOverrides: [
    { connectionId: 'connector-classify', stepId: STEP_KEYS.DISBURSEMENT.CLASSIFY, promptOverride: 'PINNED CLASSIFY' },
    { connectionId: 'connector-extract', stepId: STEP_KEYS.DISBURSEMENT.EXTRACT, promptOverride: '   ' },
    { connectionId: 'connector-crosscheck', stepId: '_default', promptOverride: 'PINNED CROSSCHECK DEFAULT' },
    { connectionId: 'connector-report', stepId: STEP_KEYS.DISBURSEMENT.REPORT, promptOverride: 'PINNED REPORT' },
  ],
} as const;

describe('document-core disbursement handler', () => {
  it('maps classify/extract fan-out, approval wait, and successful termination through SDK facades', async () => {
    const harness = createHarness();
    const parentTaskId = randomUUID();
    const input = validInput(harness.sourceArtifactId);

    const first = await documentCoreHandlers.disbursement!(createSdkContext(harness, input, 'disbursement-root', parentTaskId));
    expect(first).toEqual({ kind: 'waiting-children' });
    expect(harness.spawnCalls[0]!.children[0]!.kind).toBe('disbursement');
    expect(harness.spawnCalls[0]!.continuationRef).toMatch(/^disbursement:v1:classify:/);

    const classifyDisposition = await runChild(harness, harness.spawnCalls[0]!.children[0]!);
    expect(classifyDisposition.kind).toBe('completed');
    const classifyResult = classifyDisposition.kind === 'completed' ? classifyDisposition.resultRef : '';
    const afterClassify = await documentCoreHandlers.disbursement!(createSdkContext(
      harness,
      {
        continuationRef: harness.spawnCalls[0]!.continuationRef,
        joinSummary: { 'classify:payment.pdf': classifyResult },
      },
      'disbursement-root',
      parentTaskId,
    ));
    expect(afterClassify).toEqual({ kind: 'waiting-children' });
    expect(harness.spawnCalls[1]!.continuationRef).toMatch(/^disbursement:v1:extract:/);

    const extractDisposition = await runChild(harness, harness.spawnCalls[1]!.children[0]!);
    expect(extractDisposition.kind).toBe('completed');
    const extractResult = extractDisposition.kind === 'completed' ? extractDisposition.resultRef : '';
    const waiting = await documentCoreHandlers.disbursement!(createSdkContext(
      harness,
      {
        continuationRef: harness.spawnCalls[1]!.continuationRef,
        joinSummary: { 'extract:payment.pdf': extractResult },
      },
      'disbursement-root',
      parentTaskId,
    ));
    expect(waiting.kind).toBe('waiting-input');
    expect(harness.waitCalls).toHaveLength(1);
    expect(harness.waitCalls[0]!.contextRef).toMatch(/^artifact:\/\//);
    expect(harness.waitCalls[0]!.schema.required).toEqual(['resumeSchemaVersion', 'approved']);

    const completed = await documentCoreHandlers.disbursement!(createSdkContext(
      harness,
      { waitId: 'wait-disbursement-approval-v1', resumeInput: { resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION, approved: true, corrections: [] } },
      'disbursement-root',
      parentTaskId,
    ));
    expect(completed.kind).toBe('completed');
    expect(harness.connectorCalls.map((call) => call.slot)).toEqual(['classify', 'extract', 'crosscheck', 'report']);
    if (completed.kind === 'completed') {
      const resultArtifactId = /^artifact:\/\/([0-9a-f-]{36})$/i.exec(completed.resultRef)?.[1];
      expect(resultArtifactId).toBeDefined();
      const result = JSON.parse(harness.artifacts.get(resultArtifactId!)!.bytes.toString('utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({ resultVersion: 'disbursement-result-v1', report: 'Approved payment report.' });
    }
  });

  it('fails closed when a required connector binding or provider response is missing', async () => {
    const missingSlotHarness = createHarness();
    await expect(documentCoreHandlers.disbursement!(createSdkContext(
      missingSlotHarness,
      validInput(missingSlotHarness.sourceArtifactId),
      'disbursement-root',
      randomUUID(),
      { missingSlot: 'crosscheck' },
    ))).rejects.toMatchObject({ code: 'DISBURSEMENT_CONNECTOR_SLOT_MISSING' });

    const providerFailureHarness = createHarness({ failConnector: 'classify' });
    await documentCoreHandlers.disbursement!(createSdkContext(
      providerFailureHarness,
      validInput(providerFailureHarness.sourceArtifactId),
    ));
    const child = providerFailureHarness.spawnCalls[0]!.children[0]!;
    await expect(runChild(providerFailureHarness, child)).rejects.toMatchObject({
      code: 'DISBURSEMENT_CONNECTOR_FAILED',
      retryable: false,
    });
  });

  it('does not wait for approval without evidence or return a terminal result after rejected approval', async () => {
    const emptyHarness = createHarness({ emptyEvidence: true });
    const parentTaskId = randomUUID();
    await documentCoreHandlers.disbursement!(createSdkContext(emptyHarness, validInput(emptyHarness.sourceArtifactId), 'disbursement-root', parentTaskId));
    const classify = await runChild(emptyHarness, emptyHarness.spawnCalls[0]!.children[0]!);
    const classifyRef = classify.kind === 'completed' ? classify.resultRef : '';
    await documentCoreHandlers.disbursement!(createSdkContext(emptyHarness, {
      continuationRef: emptyHarness.spawnCalls[0]!.continuationRef,
      joinSummary: { 'classify:payment.pdf': classifyRef },
    }, 'disbursement-root', parentTaskId));
    const extract = await runChild(emptyHarness, emptyHarness.spawnCalls[1]!.children[0]!);
    const extractRef = extract.kind === 'completed' ? extract.resultRef : '';
    await expect(documentCoreHandlers.disbursement!(createSdkContext(emptyHarness, {
      continuationRef: emptyHarness.spawnCalls[1]!.continuationRef,
      joinSummary: { 'extract:payment.pdf': extractRef },
    }, 'disbursement-root', parentTaskId))).rejects.toMatchObject({ code: 'DISBURSEMENT_EVIDENCE_MISSING' });
    expect(emptyHarness.waitCalls).toHaveLength(0);

    const rejectedHarness = createHarness();
    const rejectedTaskId = randomUUID();
    await documentCoreHandlers.disbursement!(createSdkContext(rejectedHarness, validInput(rejectedHarness.sourceArtifactId), 'disbursement-root', rejectedTaskId));
    const state = {
      inputVersion: DISBURSEMENT_INPUT_VERSION,
      completedStages: ['disbursement:classify:v1', 'disbursement:extract:v1'],
      classifications: [{ fileName: 'payment.pdf', logicalDocuments: [{ label: 'payment-record', sourceFile: 'payment.pdf', category: 'payment', confidence: 0.98 }] }],
      records: [{ fileName: 'payment.pdf', logicalDocumentLabels: ['payment-record'], fields: { amount: 250 } }],
      childResults: [],
    };
    const snapshot = { input: validInput(rejectedHarness.sourceArtifactId), state };
    const stateHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    rejectedHarness.checkpoints.set('disbursement:workflow-state:approval', { inputHash: stateHash, output: snapshot });
    await expect(documentCoreHandlers.disbursement!(createSdkContext(rejectedHarness, {
      waitId: 'wait-disbursement-approval-v1',
      resumeInput: { resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION, approved: false, corrections: [] },
    }, 'disbursement-root', rejectedTaskId))).rejects.toMatchObject({
      code: 'APPROVAL_REJECTED',
      retryable: false,
    });
  });

  it('CR06-01: pinned prompt overrides reach every disbursement connector invoke', async () => {
    const harness = createHarness();
    const parentTaskId = randomUUID();
    const input = validInput(harness.sourceArtifactId);
    const contextFor = (taskInput: Record<string, unknown>, taskKey: string, taskId?: string) =>
      createSdkContext(harness, taskInput, taskKey, taskId, { pin: PIN_FIXTURE });

    await documentCoreHandlers.disbursement!(contextFor(input, 'disbursement-root', parentTaskId));
    const classifyChild = harness.spawnCalls[0]!.children[0]!;
    const classify = await documentCoreHandlers.disbursement!(contextFor(classifyChild.payload, classifyChild.taskKey));
    expect(classify.kind).toBe('completed');
    await documentCoreHandlers.disbursement!(contextFor({
      continuationRef: harness.spawnCalls[0]!.continuationRef,
      joinSummary: { 'classify:payment.pdf': classify.kind === 'completed' ? classify.resultRef : '' },
    }, 'disbursement-root', parentTaskId));

    const extractChild = harness.spawnCalls[1]!.children[0]!;
    const extract = await documentCoreHandlers.disbursement!(contextFor(extractChild.payload, extractChild.taskKey));
    expect(extract.kind).toBe('completed');
    await documentCoreHandlers.disbursement!(contextFor({
      continuationRef: harness.spawnCalls[1]!.continuationRef,
      joinSummary: { 'extract:payment.pdf': extract.kind === 'completed' ? extract.resultRef : '' },
    }, 'disbursement-root', parentTaskId));

    const completed = await documentCoreHandlers.disbursement!(contextFor({
      waitId: 'wait-disbursement-approval-v1',
      resumeInput: { resumeSchemaVersion: DISBURSEMENT_RESUME_VERSION, approved: true, corrections: [] },
    }, 'disbursement-root', parentTaskId));
    expect(completed.kind).toBe('completed');

    const prompts = new Map(
      harness.connectorCalls.map((call) => [call.slot, (call.input as { prompt?: string }).prompt ?? '']),
    );
    expect(prompts.get('classify')).toBe('PINNED CLASSIFY');
    expect(prompts.get('crosscheck')).toBe('PINNED CROSSCHECK DEFAULT');
    expect(prompts.get('report')).toBe('PINNED REPORT');
    // A cleared exact row (whitespace) falls through to the workflow's default text.
    expect(prompts.get('extract')).toContain('Extract records only for the classified logical documents.');
    expect(prompts.get('extract')).not.toContain('PINNED');
  });

  it('CR06-01: null profilePolicy keeps connector defaults (no guessed binding)', async () => {
    const harness = createHarness();
    const parentTaskId = randomUUID();
    const pin = { profilePolicy: null, promptOverrides: PIN_FIXTURE.promptOverrides };
    const contextFor = (taskInput: Record<string, unknown>, taskKey: string, taskId?: string) =>
      createSdkContext(harness, taskInput, taskKey, taskId, { pin });

    await documentCoreHandlers.disbursement!(contextFor(validInput(harness.sourceArtifactId), 'disbursement-root', parentTaskId));
    const classifyChild = harness.spawnCalls[0]!.children[0]!;
    const classify = await documentCoreHandlers.disbursement!(contextFor(classifyChild.payload, classifyChild.taskKey));
    expect(classify.kind).toBe('completed');

    const classifyPrompt = (harness.connectorCalls[0]!.input as { prompt?: string }).prompt ?? '';
    expect(classifyPrompt).toContain('Classify the supplied source file.');
    expect(classifyPrompt).not.toContain('PINNED CLASSIFY');
  });
});
