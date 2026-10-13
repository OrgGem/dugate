import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import {
  acceptAttempt,
  createImmutableAttempt,
  FileArtifactCache,
  markAttemptDispatched,
  retainAfterFailure,
} from '../../../apps/admin-web/src/features/submissions/immutable-attempt';

type WorkflowTestSource = 'backend' | 'simulation';
type PostActionResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; problem: { status: number; code?: string; title?: string } };

interface HandlerDependencies {
  client: {
    postAction: (action: string, params: Record<string, unknown>) => Promise<PostActionResult>;
  };
  selectedWorkflow: { slug: string; revision: number; stages?: string[] };
  tenantId: string;
  testSource: WorkflowTestSource;
  testInputVariables: Record<string, unknown>;
  setTestExecuting: (executing: boolean) => void;
  setTestResult: (result: Record<string, unknown> | null) => void;
  /** Remaining values model the component's local state and imported helpers. */
  canManageCatalog: boolean;
  activeTenant: { current: string | null };
  testAttempts: { current: Map<string, unknown> };
  inFlightTestTenants: { current: Set<string> };
  testRequest: { current: number };
  testFiles: object[];
  testVariablesJson: string;
  testArtifacts: string;
  testApiKeyId: string;
  uploadedTestFiles: { current: FileArtifactCache<object> };
  setTestAttempt: (attempt: unknown) => void;
  acceptAttempt: typeof acceptAttempt;
  createImmutableAttempt: typeof createImmutableAttempt;
  markAttemptDispatched: typeof markAttemptDispatched;
  retainAfterFailure: typeof retainAfterFailure;
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
  let storeAttempt: ts.FunctionDeclaration | undefined;
  let dispatchAttempt: ts.FunctionDeclaration | undefined;
  const findHandler = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleExecuteTest') {
      initializer = node.initializer;
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'storeWorkflowTestAttempt') storeAttempt = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchWorkflowTestAttempt') dispatchAttempt = node;
    ts.forEachChild(node, findHandler);
  };
  findHandler(sourceFile);
  if (!initializer || !ts.isArrowFunction(initializer) || !storeAttempt || !dispatchAttempt) {
    throw new Error('Could not locate the workflow test handler and dispatch helpers in workflows-screen.tsx');
  }

  const injectedHandler = `
    const {
      client, selectedWorkflow, tenantId, testSource, testInputVariables, setTestExecuting, setTestResult,
      canManageCatalog, activeTenant, testAttempts, inFlightTestTenants, testRequest,
      testFiles, testVariablesJson, testArtifacts, testApiKeyId, uploadedTestFiles, setTestAttempt,
      acceptAttempt, createImmutableAttempt, markAttemptDispatched, retainAfterFailure,
    } = dependencies;
    ${storeAttempt.getText(sourceFile)}
    ${dispatchAttempt.getText(sourceFile)}
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
  const activeTenant = { current: 'tenant-a' as string | null };
  const testAttempts = { current: new Map<string, unknown>() };
  const inFlightTestTenants = { current: new Set<string>() };
  const testRequest = { current: 0 };
  const testInputVariables = { invoiceId: 'invoice-a' };
  const postAction = options.postAction ?? (async () => ({
    ok: true,
    status: 202,
    data: { action: 'workflow.test' },
  }));
  const dependencies: HandlerDependencies = {
    client: { postAction },
    selectedWorkflow: { slug: 'invoice-flow', revision: 3, stages: ['catalog-stage'] },
    tenantId: 'tenant-a',
    testSource: options.source ?? 'backend',
    testInputVariables,
    setTestExecuting: () => undefined,
    setTestResult: (next) => { result = next; },
    canManageCatalog: true,
    activeTenant,
    testAttempts,
    inFlightTestTenants,
    testRequest,
    testFiles: [],
    testVariablesJson: JSON.stringify(testInputVariables),
    testArtifacts: '[]',
    testApiKeyId: 'test-key-1',
    uploadedTestFiles: { current: new FileArtifactCache<object>() },
    setTestAttempt: () => undefined,
    acceptAttempt,
    createImmutableAttempt,
    markAttemptDispatched,
    retainAfterFailure,
  };

  return {
    execute: loadExecuteTestHandler(dependencies),
    getResult: () => result,
  };
}

describe('AWEB-17 workflow test result honesty', () => {
  test('backend unavailability remains UNKNOWN with its code and no fabricated operation ID', async () => {
    const harness = createHarness({
      postAction: async () => ({
        ok: false,
        status: 503,
        problem: { status: 503, code: 'WORKFLOW_TEST_UNAVAILABLE', title: 'Workflow test service unavailable.' },
      }),
    });

    await harness.execute();

    expect(harness.getResult()).toMatchObject({
      status: 'UNKNOWN',
      message: 'Workflow test service unavailable.',
      errorCode: 'WORKFLOW_TEST_UNAVAILABLE',
      httpStatus: 503,
    });
    expect(harness.getResult()).not.toHaveProperty('operationId');
    expect(JSON.stringify(harness.getResult())).not.toContain('sim-op-');
    expect(readFileSync(workflowsScreenPath, 'utf8')).toContain('Error code: <code>{testResult.errorCode}</code>');
  });

  test('request exception remains UNKNOWN with an explicit error code and message', async () => {
    const harness = createHarness({
      postAction: async () => { throw new Error('connection reset'); },
    });

    await harness.execute();

    expect(harness.getResult()).toMatchObject({
      status: 'UNKNOWN',
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

  test('overview links expose profile assignments and API key administration', () => {
    const overview = readFileSync(overviewScreenPath, 'utf8');

    expect(overview).toMatch(/to="\/profiles">\s*Profile access assignments/);
    expect(overview).toMatch(/to="\/api-keys">API Keys administration/);
  });
});
