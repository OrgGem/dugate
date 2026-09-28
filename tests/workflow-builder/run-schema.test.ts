// tests/workflow-builder/run-schema.test.ts
// Tests for the schema workflow runner integration (wires runSchemaDag with
// buildExecFunc and completes/pauses the parent operation).
import { runWorkflowFromSchema } from '../../lib/workflow-builder/run-schema';
import { validateSchema } from '../../lib/workflow-builder/interpreter';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';
import type { WorkflowContext } from '../../lib/pipelines/workflow-engine';

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

  it('resolves $a.content after resume and does not re-execute node A (Fix 2 cross-block)', async () => {
    // connector a -> human_step -> connector b (b.input.text = $a.content)
    const crossBlockSchema: WorkflowSchema = {
      slug: 'cross-block-resume',
      name: 'Cross Block Resume',
      flow: ['a', 'human_step', 'b'],
      nodes: [
        { id: 'a', type: 'connector', connector: 'ext-classifier', inputs: { file: '$files' } },
        { id: 'human_step', type: 'human', message: 'Approve?' },
        { id: 'b', type: 'connector', connector: 'ext-content-gen', inputs: { text: '$a.content' } },
      ],
      output: { from: 'b' },
    };

    // First run: only A executes, pauses at human_step.
    // mockEnqueue returns content keyed by the connector slug via the real-exec
    // buildExecFunc implementation — the binding `$a.content` must resolve to
    // that value on resume.
    mockEnqueue.mockImplementation(async (_ctx: WorkflowContext, connector: string) => {
      if (connector === 'ext-classifier') {
        return { content: 'EXTRACTED_TEXT', operation: { id: 'sub-a' }, extractedData: null };
      }
      return { content: 'B_RESULT', operation: { id: 'sub-b' }, extractedData: null };
    });
    mockPause.mockResolvedValue(undefined);

    await runWorkflowFromSchema(makeCtx(), crossBlockSchema);

    expect(mockPause).toHaveBeenCalledTimes(1);
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // only 'a' ran before pause

    // Resume: ctx.currentStep = index of 'b' (2); _nodeResults contains A's result.
    jest.clearAllMocks();
    mockEnqueue.mockImplementation(async (_ctx: WorkflowContext, connector: string) => {
      // A must NOT be called again.
      if (connector === 'ext-classifier') {
        throw new Error('NODE A RE-EXECUTED ON RESUME');
      }
      return { content: 'B_RESULT', operation: { id: 'sub-b' }, extractedData: null };
    });

    const resumeCtx = makeCtx({
      currentStep: 2,
      _nodeResults: {
        a: {
          nodeId: 'a',
          type: 'connector',
          content: 'EXTRACTED_TEXT',
          data: { processor: 'ext-classifier', variables: { file: ['/tmp/doc.pdf'] } },
          output: 'EXTRACTED_TEXT',
        },
        human_step: { nodeId: 'human_step', type: 'human', data: { message: 'Approve?' }, output: null },
      },
    });

    await runWorkflowFromSchema(resumeCtx, crossBlockSchema);

    // Exactly one connector call (B), and A must not have been invoked again.
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const call: unknown[] = mockEnqueue.mock.calls[0];
    const calledConnector: unknown = call[1];
    const calledVars: Record<string, unknown> = call[2] as Record<string, unknown>;
    expect(calledConnector).toBe('ext-content-gen');
    // The $a.content binding must have been resolved to A's saved output.
    expect(calledVars.text).toBe('EXTRACTED_TEXT');
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});



