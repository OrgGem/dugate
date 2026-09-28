// tests/workflow-builder/hitl-persistence.test.ts
// Round-trip regression for Fix 4: proves that after pauseWorkflow persists
// `_nodeResults` into `stepsResultJson`, a fresh createWorkflowContext call
// (i.e. a worker restart picking the operation back up from BullMQ) restores
// the same nodeResults, AND that the binding `$a.content` resolves correctly
// after restart. Also asserts backwards compatibility with the legacy plain
// array format (non-schema workflows that store stepsResultJson as `[]`).
//
// All DB calls are mocked — no real Postgres / Redis / queue. This proves the
// serialization seam is correct, NOT a live E2E.

const mockDbSelect = jest.fn();
const mockDbUpdate = jest.fn();

const mockEnqueue = jest.fn();
const mockPause = jest.fn();
const mockComplete = jest.fn();
const mockFail = jest.fn();
const mockUpdateProgress = jest.fn();

jest.mock('@/lib/pipelines/workflow-engine', () => {
  const real = jest.requireActual('@/lib/pipelines/workflow-engine');
  return {
    ...real,
    // The first three tests bypass runWorkflowFromSchema and call the real
    // pauseWorkflow / createWorkflowContext to drive the persistence seam.
    // We only need to mock the leaf helpers used by run-schema's executor.
    enqueueSubStep: (...args: unknown[]) => mockEnqueue(...args),
    updateProgress: (...args: unknown[]) => mockUpdateProgress(...args),
    // completeWorkflow / failWorkflow / pauseWorkflow remain real; the
    // existing run-schema.test.ts mocks them at the call-site, but for the
    // persistence seam tests we want the real implementations to exercise
    // db.update.
  };
});

jest.mock('@/lib/db', () => {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockDbSelect() }) }) }),
    update: () => ({ set: (values: unknown) => ({ where: () => mockDbUpdate(values) }) }),
  };
  return { db };
});

jest.mock('@/lib/queue/pipeline-queue', () => ({
  getPipelineQueue: jest.fn(),
  getWorkflowStepsQueue: jest.fn(),
  getWorkflowStepsQueueEvents: jest.fn(),
}));

import {
  pauseWorkflow,
  createWorkflowContext,
} from '@/lib/pipelines/workflow-engine';
import type { WorkflowContext } from '@/lib/pipelines/workflow-engine';
import { runWorkflowFromSchema } from '@/lib/workflow-builder/run-schema';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

interface OperationRow {
  id: string;
  endpointSlug: string;
  apiKeyId: string | null;
  createdByUserId: string | null;
  pipelineJson: string;
  filesJson: string | null;
  webhookUrl: string | null;
  state: string;
  done: boolean;
  currentStep: number;
  stepsResultJson: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

function makeOperationRow(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'op-hitl',
    endpointSlug: 'workflows:schema:cross-block',
    apiKeyId: null,
    createdByUserId: null,
    pipelineJson: JSON.stringify([{
      processor: 'ext-classifier',
      variables: { schemaSlug: 'cross-block' },
    }]),
    filesJson: JSON.stringify([{ name: 'doc.pdf', path: '/tmp/doc.pdf', mime: 'application/pdf', size: 100 }]),
    webhookUrl: null,
    state: 'RUNNING',
    done: false,
    currentStep: 0,
    stepsResultJson: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

interface PauseWrite {
  stepsResultJson: string | null;
  currentStep: number | null;
  state: string | null;
}

let pauseWrites: PauseWrite[] = [];

/**
 * Tracks every `pauseWorkflow` db.update() write so the second half of the
 * round-trip test (createWorkflowContext) can replay the most recent write
 * as the freshly-loaded row state — emulating a worker restart that reads the
 * persisted row from the DB.
 */
beforeEach(() => {
  jest.clearAllMocks();
  pauseWrites = [];

  mockDbUpdate.mockImplementation((values: Record<string, unknown>) => {
    pauseWrites.push({
      stepsResultJson: typeof values.stepsResultJson === 'string' ? values.stepsResultJson : null,
      currentStep: typeof values.currentStep === 'number' ? values.currentStep : null,
      state: typeof values.state === 'string' ? values.state : null,
    });
    return Promise.resolve();
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeResumeCtx(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    operationId: 'op-hitl',
    correlationId: 'corr-1',
    job: undefined,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as WorkflowContext['logger'],
    filesJson: null,
    filesData: [{ name: 'doc.pdf', path: '/tmp/doc.pdf', mime: 'application/pdf', size: 100 }],
    pipelineVars: { schemaSlug: 'cross-block' },
    stepsResult: [],
    _nodeResults: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    webhookUrl: null,
    apiKeyId: null,
    createdByUserId: null,
    promptOverrides: {},
    currentStep: 0,
    ...overrides,
  };
}

const crossBlockSchema: WorkflowSchema = {
  slug: 'cross-block',
  name: 'Cross Block',
  flow: ['a', 'human_step', 'b'],
  nodes: [
    { id: 'a', type: 'connector', connector: 'ext-classifier', inputs: { file: '$files' } },
    { id: 'human_step', type: 'human', message: 'Approve?' },
    { id: 'b', type: 'connector', connector: 'ext-content-gen', inputs: { text: '$a.content' } },
  ],
  output: { from: 'b' },
};

describe('Fix 4 — HITL pause/restart nodeResults persistence seam', () => {
  it('embeds _nodeResults into stepsResultJson on pause and restores them on createWorkflowContext', async () => {
    // ── Part 1: pause with _nodeResults present ────────────────────────────
    const ctx = makeResumeCtx({
      currentStep: 1,
      _nodeResults: {
        a: { nodeId: 'a', type: 'connector', content: 'EXTRACTED_TEXT', output: 'EXTRACTED_TEXT', data: { processor: 'ext-classifier' } },
      },
      stepsResult: [{ step: 0, stepName: 'a', processor: 'ext-classifier' }],
    });

    await pauseWorkflow(ctx, 'Approve?', 2);

    // The most recent write must be the WAITING_USER_INPUT row.
    const pauseWrite = pauseWrites[pauseWrites.length - 1];
    expect(pauseWrite.state).toBe('WAITING_USER_INPUT');
    expect(pauseWrite.currentStep).toBe(2);
    expect(pauseWrite.stepsResultJson).not.toBeNull();

    const persisted = JSON.parse(pauseWrite.stepsResultJson!);
    expect(persisted).toHaveProperty('stepsResult');
    expect(Array.isArray(persisted.stepsResult)).toBe(true);
    expect(persisted.stepsResult[0].stepName).toBe('a');
    expect(persisted).toHaveProperty('_nodeResults');
    expect(persisted._nodeResults.a.content).toBe('EXTRACTED_TEXT');

    // ── Part 2: simulate worker restart; createWorkflowContext reads it back ─
    const restartedRow = makeOperationRow({
      state: 'WAITING_USER_INPUT',
      currentStep: pauseWrite.currentStep!,
      stepsResultJson: pauseWrite.stepsResultJson,
    });
    mockDbSelect.mockResolvedValueOnce([restartedRow]);

    const restoredCtx = await createWorkflowContext('op-hitl', 'corr-2');
    expect(restoredCtx).not.toBeNull();
    expect(restoredCtx!._nodeResults).not.toBeNull();
    const restoredNodeA = restoredCtx!._nodeResults!.a as Record<string, unknown>;
    expect(restoredNodeA.content).toBe('EXTRACTED_TEXT');
    expect(restoredNodeA.output).toBe('EXTRACTED_TEXT');
    expect(restoredCtx!.stepsResult).toHaveLength(1);
    expect(restoredCtx!.stepsResult[0].stepName).toBe('a');
    expect(restoredCtx!.currentStep).toBe(2);
  });

  it('falls back to plain-array stepsResultJson (legacy non-schema workflows)', async () => {
    // An operation persisted before Fix 4 stored `stepsResultJson` as a plain
    // array. createWorkflowContext must still hydrate stepsResult correctly.
    const legacySteps = [
      { step: 0, name: 'extract', status: 'success', content: 'OLD_OUTPUT' },
      { step: 1, name: 'transform', status: 'success', content: 'OK' },
    ];
    const legacyRow = makeOperationRow({
      state: 'WAITING_USER_INPUT',
      currentStep: 1,
      stepsResultJson: JSON.stringify(legacySteps),
    });
    mockDbSelect.mockResolvedValueOnce([legacyRow]);

    const ctx = await createWorkflowContext('op-hitl', 'corr-legacy');
    expect(ctx).not.toBeNull();
    expect(ctx!.stepsResult).toHaveLength(2);
    // The legacy fixture stores arbitrary fields; we verify the array length
    // and that _nodeResults stays null (legacy format has no wrapper).
    expect(ctx!._nodeResults).toBeNull();
  });

  it('end-to-end cross-block binding $a.content resolves after restart with persisted _nodeResults', async () => {
    // First pass: connector A runs, then runWorkflowFromSchema writes
    // `_nodeResults` (typed WorkflowContext field — no `as any`) and calls
    // pauseWorkflow. We assert that pauseWorkflow persisted A's content into
    // the wrapper format. Then we simulate restart by replaying the persisted
    // row through createWorkflowContext and re-running the integration runner
    // from the restored context. B must execute with $a.content resolved
    // from the persisted _nodeResults; A must not re-execute.

    mockEnqueue.mockImplementation(async (_ctx: WorkflowContext, connector: string) => {
      if (connector === 'ext-classifier') {
        return { content: 'EXTRACTED_TEXT', operation: { id: 'sub-a' }, extractedData: null };
      }
      return { content: 'B_RESULT', operation: { id: 'sub-b' }, extractedData: null };
    });

    // First run starts at currentStep=0.
    const firstCtx = makeResumeCtx({
      currentStep: 0,
      _nodeResults: null,
      stepsResult: [],
    });
    await runWorkflowFromSchema(firstCtx, crossBlockSchema);

    // pauseWorkflow must have written at least one row containing the wrapper
    // format with _nodeResults. The most recent write is the WAITING_USER_INPUT row.
    const pauseWrite = pauseWrites[pauseWrites.length - 1];
    expect(pauseWrite).toBeDefined();
    expect(pauseWrite.state).toBe('WAITING_USER_INPUT');
    expect(pauseWrite.currentStep).toBe(2);
    expect(pauseWrite.stepsResultJson).not.toBeNull();
    const persistedAfterFirst = JSON.parse(pauseWrite.stepsResultJson!);
    expect(persistedAfterFirst._nodeResults.a.content).toBe('EXTRACTED_TEXT');

    // ── Simulate worker restart: replay persisted row through createWorkflowContext ─
    const restartedRow = makeOperationRow({
      state: 'WAITING_USER_INPUT',
      currentStep: pauseWrite.currentStep!,
      stepsResultJson: pauseWrite.stepsResultJson,
    });
    mockDbSelect.mockResolvedValueOnce([restartedRow]);
    const restoredCtx = await createWorkflowContext('op-hitl', 'corr-restart');
    expect(restoredCtx).not.toBeNull();
    expect(restoredCtx!._nodeResults).not.toBeNull();
    const restoredA = restoredCtx!._nodeResults!.a as Record<string, unknown>;
    expect(restoredA.content).toBe('EXTRACTED_TEXT');
    expect(restoredCtx!.currentStep).toBe(2); // index of node 'b'

    // ── Second pass: B must run with $a.content resolved from restored ctx; A must not re-execute.
    jest.clearAllMocks();
    pauseWrites = [];
    // Re-arm db.update tracker after clearAllMocks (clears calls but not impl;
    // we keep the same implementation pattern).
    mockDbUpdate.mockImplementation((values: Record<string, unknown>) => {
      pauseWrites.push({
        stepsResultJson: typeof values.stepsResultJson === 'string' ? values.stepsResultJson : null,
        currentStep: typeof values.currentStep === 'number' ? values.currentStep : null,
        state: typeof values.state === 'string' ? values.state : null,
      });
      return Promise.resolve();
    });
    mockEnqueue.mockImplementation(async (_ctx: WorkflowContext, connector: string) => {
      if (connector === 'ext-classifier') {
        throw new Error('NODE A RE-EXECUTED AFTER RESTART');
      }
      return { content: 'B_RESULT', operation: { id: 'sub-b' }, extractedData: null };
    });

    await runWorkflowFromSchema(restoredCtx!, crossBlockSchema);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const resumeCall: unknown[] = mockEnqueue.mock.calls[0];
    const calledConnector: unknown = resumeCall[1];
    const calledVars: Record<string, unknown> = resumeCall[2] as Record<string, unknown>;
    expect(calledConnector).toBe('ext-content-gen');
    expect(calledVars.text).toBe('EXTRACTED_TEXT');

    // The completion path must have written a SUCCEEDED state to db.update.
    const completionWrite = pauseWrites.find((w) => w.state === 'SUCCEEDED');
    expect(completionWrite).toBeDefined();
  });
});