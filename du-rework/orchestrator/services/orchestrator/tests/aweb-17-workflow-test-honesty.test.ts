import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

type WorkflowTestSource = 'backend' | 'simulation';
type PostActionResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; problem: { status: number; code?: string; title?: string } };

interface HandlerDependencies {
  client: {
    postAction: (action: string, params: Record<string, unknown>) => Promise<PostActionResult>;
  };
  selectedWorkflow: { slug: string; stages?: string[] };
  tenantId: string;
  testSource: WorkflowTestSource;
  testInputVariables: Record<string, unknown>;
  setTestExecuting: (executing: boolean) => void;
  setTestResult: (result: Record<string, unknown> | null) => void;
}

const workflowsScreenPath = resolve(
  __dirname,
  '../../../apps/admin-web/src/features/workflows/workflows-screen.tsx',
);
const overviewScreenPath = resolve(
  __dirname,
  '../../../apps/admin-web/src/features/overview/overview-screen.tsx',
);

function loadExecuteTestHandler(dependencies: HandlerDependencies): () => Promise<void> {
  const source = readFileSync(workflowsScreenPath, 'utf8');
  const sourceFile = ts.createSourceFile(workflowsScreenPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  const findHandler = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleExecuteTest') {
      initializer = node.initializer;
    }
    ts.forEachChild(node, findHandler);
  };
  findHandler(sourceFile);
  if (!initializer || !ts.isArrowFunction(initializer)) {
    throw new Error('Could not locate the workflow test handler in workflows-screen.tsx');
  }

  const injectedHandler = `
    const { client, selectedWorkflow, tenantId, testSource, testInputVariables, setTestExecuting, setTestResult } = dependencies;
    const handler = ${initializer.getText(sourceFile)};
  `;
  const javascript = ts.transpileModule(injectedHandler, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const factory = new Function('dependencies', `${javascript}\nreturn handler;`) as (
    input: HandlerDependencies,
  ) => () => Promise<void>;
  return factory(dependencies);
}

function createHarness(
  options: {
    source?: WorkflowTestSource;
    postAction?: HandlerDependencies['client']['postAction'];
  } = {},
) {
  let result: Record<string, unknown> | null = null;
  const postAction = options.postAction ?? (async () => ({
    ok: true,
    status: 202,
    data: { action: 'workflow.test' },
  }));
  const dependencies: HandlerDependencies = {
    client: { postAction },
    selectedWorkflow: { slug: 'invoice-flow', stages: ['catalog-stage'] },
    tenantId: 'tenant-a',
    testSource: options.source ?? 'backend',
    testInputVariables: { invoiceId: 'invoice-a' },
    setTestExecuting: () => undefined,
    setTestResult: (next) => { result = next; },
  };

  return {
    execute: loadExecuteTestHandler(dependencies),
    getResult: () => result,
  };
}

describe('AWEB-17 workflow test result honesty', () => {
  test('backend rejection renders FAILED with its code and no fabricated operation ID', async () => {
    const harness = createHarness({
      postAction: async () => ({
        ok: false,
        status: 503,
        problem: { status: 503, code: 'WORKFLOW_TEST_UNAVAILABLE', title: 'Workflow test service unavailable.' },
      }),
    });

    await harness.execute();

    expect(harness.getResult()).toMatchObject({
      status: 'FAILED',
      message: 'Workflow test service unavailable.',
      errorCode: 'WORKFLOW_TEST_UNAVAILABLE',
      httpStatus: 503,
    });
    expect(harness.getResult()).not.toHaveProperty('operationId');
    expect(JSON.stringify(harness.getResult())).not.toContain('sim-op-');
    expect(readFileSync(workflowsScreenPath, 'utf8')).toContain('Error code: <code>{testResult.errorCode}</code>');
  });

  test('request exception renders FAILED with an explicit error code and message', async () => {
    const harness = createHarness({
      postAction: async () => { throw new Error('connection reset'); },
    });

    await harness.execute();

    expect(harness.getResult()).toMatchObject({
      status: 'FAILED',
      message: 'connection reset',
      errorCode: 'REQUEST_EXCEPTION',
    });
    expect(harness.getResult()).not.toHaveProperty('operationId');
    expect(JSON.stringify(harness.getResult())).not.toContain('sim-op-');
  });

  test('simulation is shown only when selected and does not call the backend', async () => {
    let calls = 0;
    const harness = createHarness({
      source: 'simulation',
      postAction: async () => {
        calls += 1;
        return { ok: true, status: 202, data: { action: 'workflow.test' } };
      },
    });

    await harness.execute();

    expect(calls).toBe(0);
    expect(harness.getResult()).toMatchObject({
      status: 'SIMULATED_SUCCESS',
      dataSource: 'simulation',
      simulatedStages: ['catalog-stage'],
    });
  });

  test('the modal exposes an explicit local simulation source choice', () => {
    const workflowsScreen = readFileSync(workflowsScreenPath, 'utf8');

    expect(workflowsScreen).toContain('<option value="simulation">Local simulation (no backend request)</option>');
  });

  test('accepted result uses only operation ID and stages returned by the backend', async () => {
    const harness = createHarness({
      postAction: async () => ({
        ok: true,
        status: 202,
        data: { action: 'workflow.test', operationId: 'op-server-123', stagesCompleted: ['ingest', 'extract'] },
      }),
    });

    await harness.execute();

    expect(harness.getResult()).toMatchObject({
      status: 'ACCEPTED',
      operationId: 'op-server-123',
      stagesCompleted: ['ingest', 'extract'],
    });
    expect(harness.getResult()).not.toHaveProperty('simulatedStages');
  });

  test('overview API keys link points at Profiles, where key management lives', () => {
    const overview = readFileSync(overviewScreenPath, 'utf8');

    expect(overview).toContain('to="/profiles">\n            API keys');
    expect(overview).not.toContain('to="/api-keys"');
  });
});
