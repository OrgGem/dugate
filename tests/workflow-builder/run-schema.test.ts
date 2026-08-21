// tests/workflow-builder/run-schema.test.ts
// Tests for the schema workflow runner integration (wires runSchemaDag with
// buildExecFunc and completes/pauses the parent operation).
import { runWorkflowFromSchema } from '../../lib/workflow-builder/run-schema';
import { validateSchema } from '../../lib/workflow-builder/interpreter';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

// Mock workflow-engine lifecycle fns + real-exec enqueue
jest.mock('../../lib/pipelines/workflow-engine', () => ({
  enqueueSubStep: jest.fn(),
  updateProgress: jest.fn(),
  pauseWorkflow: jest.fn(),
  completeWorkflow: jest.fn(),
  failWorkflow: jest.fn(),
  parseDeep: (v: any) => v,
}));
import { updateProgress, pauseWorkflow, completeWorkflow, failWorkflow, enqueueSubStep } from '../../lib/pipelines/workflow-engine';
const mockUpdate = updateProgress as jest.Mock;
const mockPause = pauseWorkflow as jest.Mock;
const mockComplete = completeWorkflow as jest.Mock;
const mockFail = failWorkflow as jest.Mock;
const mockEnqueue = enqueueSubStep as jest.Mock;

function makeCtx(extra: any = {}) {
  return {
    operationId: 'op-schema-1',
    filesData: [{ name: 'doc.pdf', path: '/tmp/doc.pdf', mime: 'application/pdf', size: 100 }],
    promptOverrides: {},
    pipelineVars: { resolution_data: '{"so_nq":"01"}' },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    stepsResult: [],
    currentStep: 0,
    ...extra,
  };
}

const schema: WorkflowSchema = {
  slug: 'disb-test',
  name: 'Disb Test',
  flow: ['a', 'b'],
  nodes: [
    { id: 'a', type: 'connector', connector: 'ext-classifier', inputs: { file: '$files' } },
    { id: 'b', type: 'human', message: 'Approve?' },
  ],
  output: { from: 'a' },
};

describe('runWorkflowFromSchema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnqueue.mockResolvedValue({ content: 'C', operation: { id: 'sub1' }, extractedData: null });
  });

  it('marks invalid schema as failed (does not throw)', async () => {
    const bad = { ...schema, slug: '' } as WorkflowSchema;
    await runWorkflowFromSchema(makeCtx(), bad);
    expect(mockFail).toHaveBeenCalled();
    // absorbed into failWorkflow
  });

  it('runs nodes and calls completeWorkflow with output from schema', async () => {
    const linearSchema: WorkflowSchema = {
      slug: 'lin', name: 'Lin', flow: ['a','c'],
      nodes: [
        { id: 'a', type: 'connector', connector: 'ext-classifier', inputs: { file: '$files' } },
        { id: 'c', type: 'connector', connector: 'ext-content-gen', inputs: { text: '$a.content' } },
      ],
      output: { from: 'c' },
    };

    await runWorkflowFromSchema(makeCtx(), linearSchema);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockComplete).toHaveBeenCalled();
  });

  it('pauses on a human node', async () => {
    mockPause.mockResolvedValue(undefined);
    await runWorkflowFromSchema(makeCtx(), schema);
    expect(mockPause).toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('calls failWorkflow on runtime error', async () => {
    mockEnqueue.mockRejectedValue(new Error('connector down'));
    await runWorkflowFromSchema(makeCtx(), schema);
    expect(mockFail).toHaveBeenCalled();
  });
});



