import { randomUUID } from 'node:crypto';
import {
  hashInvocationInput,
  InvocationRequestSchema,
  type ConnectorWorkflowOverrides,
} from '@du/contracts';
import {
  createConnectorInvoker,
  DefaultTaskContext,
  RuntimeClient,
} from '../src';
import type { ConnectorInvocationPayload } from '../src';

const TENANT_ID = '8a1d356a-f629-43fb-a064-6fbefcc49710';
const CONNECTOR_ID = 'tenant-workflow-connector';
const REVISION = 7;
const BINDING_SLOT = 'legacy-connector-00';
const WORKFLOW_OVERRIDES: ConnectorWorkflowOverrides = {
  connectorId: CONNECTOR_ID,
  connectorRevision: REVISION,
  recipeDigest: 'b'.repeat(64),
  staticFormFields: [{ name: 'workflow_mode', value: 'unit-mode' }],
  extraHeaders: [{ name: 'x-wfa-workflow', value: 'unit-header' }],
};

const ROOT_STEP_KEY = `legacy-workflow:node:sha256:${'a'.repeat(64)}:root:root:recipe_request`;
const BRANCH_STEP_KEY = `legacy-workflow:node:sha256:${'c'.repeat(64)}:branch:recipe_parallel-0:recipe_branch_left`;

interface CapturedRequest {
  url: string;
  method: string;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runtimeReply(
  request: CapturedRequest,
  taskId: string,
  invocations: CapturedRequest[],
  runtimeCalls: CapturedRequest[],
): Response {
  const url = new URL(request.url);
  runtimeCalls.push(request);
  if (url.origin === 'http://storage' && request.method === 'PUT') {
    return new Response(null, { status: 200 });
  }
  if (url.origin !== 'http://runtime') throw new Error('unexpected mock runtime origin');

  if (request.method === 'POST' && url.pathname === `/tasks/${taskId}/invocation-grants`) {
    const body = request.body as { stepKey: string; bindingSlot: string };
    const invocationId = randomUUID();
    invocations.push(request);
    return jsonResponse({
      grant: `signed-${invocationId}`,
      invocationId,
      connectorId: CONNECTOR_ID,
      connectorRevision: REVISION,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOptions: {},
    });
  }
  if (request.method === 'POST' && url.pathname === `/tasks/${taskId}/artifacts`) {
    const artifactId = randomUUID();
    return jsonResponse({
      artifactId,
      uploadUrl: `http://storage/${artifactId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  if (request.method === 'POST' && /^\/artifacts\/[0-9a-f-]+\/finalize$/.test(url.pathname)) {
    return jsonResponse({});
  }
  if (request.method === 'PUT' && /^\/tasks\/[0-9a-f-]+\/steps\//.test(url.pathname)) {
    const stepKey = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/steps/') + '/steps/'.length));
    return jsonResponse({ stepKey, generation: 1, replayed: false }, 201);
  }
  if (request.method === 'POST' && url.pathname === '/invocations') {
    throw new Error('Connector requests must use the separate connector transport mock');
  }
  throw new Error(`unexpected mocked runtime request ${request.method} ${url.pathname}`);
}

function makeWorkflowContext(stepKey: string, kind: 'root' | 'legacy-workflow-branch') {
  const taskId = randomUUID();
  const operationId = randomUUID();
  const grantRequests: CapturedRequest[] = [];
  const runtimeCalls: CapturedRequest[] = [];
  const connectorRequests: CapturedRequest[] = [];
  const runtimeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    return runtimeReply(request, taskId, grantRequests, runtimeCalls);
  }) as typeof fetch;
  const connectorFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    const url = new URL(request.url);
    if (url.origin !== 'http://connector' || request.method !== 'POST' || url.pathname !== '/invocations') {
      throw new Error('unexpected mocked Connector request');
    }
    const parsed = InvocationRequestSchema.parse(request.body);
    connectorRequests.push({ ...request, body: parsed });
    return jsonResponse({
      invocationId: parsed.invocationId,
      state: 'SUCCEEDED',
      result: { content: 'unit provider result' },
    });
  }) as typeof fetch;
  const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'offline-unit-token', fetchImpl: runtimeFetch });
  const invokeConnector = createConnectorInvoker({
    baseUrl: 'http://connector',
    serviceToken: 'offline-unit-service-token',
    fetchImpl: connectorFetch,
  });
  const context = new DefaultTaskContext(
    {
      taskId,
      operationId,
      tenantId: TENANT_ID,
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'schema-workflow',
      kind,
      taskKey: kind === 'root' ? 'root' : 'legacy-workflow:recipe_parallel:branch:00',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: null,
      input: {},
      connectorBindings: { [BINDING_SLOT]: `${CONNECTOR_ID}@${REVISION}` },
      checkpointRefs: [],
      cancelRequested: false,
    },
    {
      runtime,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector,
      fetchImpl: runtimeFetch,
    },
  );

  return { context, taskId, operationId, grantRequests, runtimeCalls, connectorRequests };
}

describe('ORV15 workflow override grant-to-Connector wire', () => {
  it.each([
    ['root', 'root', ROOT_STEP_KEY],
    ['parallel branch', 'legacy-workflow-branch', BRANCH_STEP_KEY],
  ] as const)('preserves the exact %s checkpoint key and pinned override payload', async (_label, kind, stepKey) => {
    const h = makeWorkflowContext(stepKey, kind);
    const input = { prompt: `workflow ${kind}`, parameters: { source: 'admitted-pin' } };
    const options = { responseFormat: 'text' };

    await h.context.step.run(stepKey, 'sha256:workflow-step-input', () =>
      h.context.connector.invoke(BINDING_SLOT, input, options, undefined, WORKFLOW_OVERRIDES),
    );

    expect(h.grantRequests).toHaveLength(1);
    expect(h.connectorRequests).toHaveLength(1);
    const grantRequest = h.grantRequests[0]!.body as Record<string, unknown>;
    const connectorRequest = h.connectorRequests[0]!.body as ConnectorInvocationPayload;
    expect(grantRequest).toMatchObject({
      stepKey,
      bindingSlot: BINDING_SLOT,
      workflowOverrides: WORKFLOW_OVERRIDES,
    });
    expect(connectorRequest).toMatchObject({
      stepKey,
      bindingSlot: BINDING_SLOT,
      workflowOverrides: WORKFLOW_OVERRIDES,
      input,
      options,
      operationId: h.operationId,
      taskId: h.taskId,
    });
    expect(connectorRequest.invocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(grantRequest['inputHash']).toEqual(hashInvocationInput({
      contractVersion: '1',
      tenantId: TENANT_ID,
      operationId: h.operationId,
      taskId: h.taskId,
      stepKey,
      bindingSlot: BINDING_SLOT,
      input,
      options,
      workflowOverrides: WORKFLOW_OVERRIDES,
      sessionRef: null,
      deadlineAt: '9999-12-31T23:59:59.000Z',
    }));
    expect(h.runtimeCalls.some((call) => call.method === 'PUT' && call.url.includes('/steps/'))).toBe(true);
  });
});
