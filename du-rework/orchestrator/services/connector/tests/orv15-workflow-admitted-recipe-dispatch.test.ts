import { randomUUID, createHash } from 'node:crypto';
import {
  canonicalLegacyWorkflowPinBytes,
  canonicalize,
  ConnectorRecipeSchema,
  ConnectorWorkflowOverridesSchema,
  InvocationCostContextSchema,
  InvocationGrantRequestSchema,
  InvocationRequestSchema,
  LegacyWorkflowSchemaPinSchema,
  parseLegacyWorkflowSchema,
  workflowOverridesDigest,
  type ConnectorWorkflowOverrides,
  type InvocationCostContext,
  type InvocationGrantRequest,
  type LegacyWorkflowSchemaPin,
} from '@du/contracts';
import { DefaultTaskContext, runWithStepKey } from '../../../packages/worker-sdk/src/task-context';
import { RuntimeClient } from '../../../packages/worker-sdk/src/runtime-client';
import { createConnectorInvoker } from '../../../packages/worker-sdk/src/connector-invoker';
import type { TaskContext as SdkTaskContext } from '../../../packages/worker-sdk/src/types';
import { handleLegacyWorkflowBranch, handleLegacyWorkflowSchema } from '../../../../businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime';
import { AdapterRegistry } from '../src/adapters/registry';
import { InMemoryUsageOutbox } from '../src/db/usage-outbox';
import { InMemoryInvocationLedger } from '../src/ledger';
import { InMemoryQuotaStore } from '../src/quota';
import { toContractInvocationResponse } from '../src/contracts';
import { DurableConnectorRuntime } from '../src/services';
import type { ConnectorCostControlClient } from '../src/cost-control-client';
import type { GrantClaims, ProviderRequest, ProviderResponse } from '../src/types';
import type { ProviderTransport } from '../src/invoke';

const TENANT = 'c2515fa9-94d4-45ea-8710-53ad4bbe337a';
const CONNECTOR = 'orv14-vfy-workflow-recipe-71b3c28b-825e-4d98-87ef-8789e903e44c';
const SLOT = 'legacy-connector-00';
const RESERVATION_GROUP = '66666666-6666-4666-8666-666666666666';
const SIGNED_GRANT = 'offline-orv15-signed-invocation-grant';
const ROOT_TASK = '3f68740f-01b9-436c-9b41-18f31bb4f2f2';
const ROOT_OPERATION = 'f75a4f2d-6cf3-499a-a6ed-75f138dac2b0';
const BRANCH_TASK = '8d8605be-af61-4ec2-880e-28f7c44f3407';
const BRANCH_OPERATION = '1670d4ef-05a1-4de5-b497-2cb4264e2e73';

type RootOrBranch = 'root' | 'branch';

interface RunEvidence {
  readonly invocationRequests: InvocationGrantRequest[];
  readonly connectorRequests: ReturnType<typeof InvocationRequestSchema.parse>[];
  readonly providerRequests: ProviderRequest[];
  readonly sequence: string[];
  readonly invocationIds: string[];
  readonly ledger: InMemoryInvocationLedger;
  readonly outbox: InMemoryUsageOutbox;
  readonly context: SdkTaskContext;
  readonly pin: LegacyWorkflowSchemaPin;
  readonly overrides: ConnectorWorkflowOverrides;
}

function recipeForTest() {
  return ConnectorRecipeSchema.parse({
    adapter: 'json-http',
    method: 'POST',
    endpointUrl: 'https://provider.example/provider',
    auth: { kind: 'none' },
    headers: [{ name: 'x-wfa-workflow', value: 'recipe-base-v1' }],
    request: {
      promptField: 'prompt',
      fields: [{ name: 'workflow_mode', source: 'static', value: 'recipe-default-v1' }],
    },
    response: {
      contentPath: 'content',
      inputTokensPath: 'usage.inputTokens',
      outputTokensPath: 'usage.outputTokens',
    },
    session: { capture: [], inject: [] },
    timeoutMs: 5_000,
    responseBytes: 32_768,
  });
}

function overridesFor(
  recipe: ReturnType<typeof recipeForTest>,
  headerValue = 'recipe-admitted-header',
  fieldValue = 'recipe-admitted-v1',
): ConnectorWorkflowOverrides {
  return ConnectorWorkflowOverridesSchema.parse({
    connectorId: CONNECTOR,
    connectorRevision: 1,
    recipeDigest: createHash('sha256').update(canonicalize(recipe)).digest('hex'),
    staticFormFields: [{ name: 'workflow_mode', value: fieldValue }],
    extraHeaders: [{ name: 'x-wfa-workflow', value: headerValue }],
  });
}

function workflowPin(overrides: ConnectorWorkflowOverrides): LegacyWorkflowSchemaPin {
  const rootNode = {
    id: 'recipe_request',
    type: 'connector',
    connector: 'wfa-workflow-recipe',
    inputs: { prompt: 'ORV15_ADMITTED_RECIPE_PROMPT' },
    overrideConnector: {
      extraHeaders: JSON.stringify(overrides.extraHeaders),
      staticFormFields: JSON.stringify(overrides.staticFormFields),
    },
  };
  const schema = parseLegacyWorkflowSchema({
    slug: 'orv15-admitted-recipe-dispatch',
    name: 'ORV15 admitted typed recipe dispatch',
    input_schema: { type: 'object', properties: {} },
    nodes: [rootNode],
    flow: [rootNode.id],
    output: { from: rootNode.id },
  });
  const connectorSlotMap = { 'wfa-workflow-recipe': SLOT };
  const connectorRecipePins = { recipe_request: overrides };
  const digest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
    schema, connectorSlotMap, [], connectorRecipePins,
  )).digest('hex')}`;
  return LegacyWorkflowSchemaPinSchema.parse({
    tenantId: TENANT,
    slug: schema.slug,
    revision: 1,
    digest,
    schema,
    connectorSlotMap,
    approvedEgressOrigins: [],
    connectorRecipePins,
  });
}

function parallelWorkflowPin(recipe: ReturnType<typeof recipeForTest>): { pin: LegacyWorkflowSchemaPin; leftOverrides: ConnectorWorkflowOverrides } {
  const leftOverrides = overridesFor(recipe, 'branch-header-left', 'branch-mode-left');
  const rightOverrides = overridesFor(recipe, 'branch-header-right', 'branch-mode-right');
  const connectorNode = (id: string, prompt: string, header: string, mode: string) => ({
    id,
    type: 'connector',
    connector: 'wfa-workflow-recipe',
    inputs: { prompt },
    overrideConnector: {
      extraHeaders: JSON.stringify([{ name: 'x-wfa-workflow', value: header }]),
      staticFormFields: JSON.stringify([{ name: 'workflow_mode', value: mode }]),
    },
  });
  const left = connectorNode('recipe_branch_left', 'ORV14_BRANCH_LEFT', 'branch-header-left', 'branch-mode-left');
  const right = connectorNode('recipe_branch_right', 'ORV14_BRANCH_RIGHT', 'branch-header-right', 'branch-mode-right');
  const parallel = {
    id: 'recipe_parallel',
    type: 'parallel',
    branches: [[left], [right]],
  };
  const join = { id: 'recipe_join', type: 'join', combine: 'concat' };
  const schema = parseLegacyWorkflowSchema({
    slug: 'orv15-admitted-parallel-recipe-dispatch',
    name: 'ORV15 admitted parallel typed recipe dispatch',
    input_schema: { type: 'object', properties: {} },
    nodes: [parallel, join],
    flow: [parallel.id, join.id],
    output: { from: join.id },
  });
  const connectorSlotMap = { 'wfa-workflow-recipe': SLOT };
  const connectorRecipePins = { recipe_branch_left: leftOverrides, recipe_branch_right: rightOverrides };
  const digest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
    schema, connectorSlotMap, [], connectorRecipePins,
  )).digest('hex')}`;
  return {
    pin: LegacyWorkflowSchemaPinSchema.parse({
      tenantId: TENANT,
      slug: schema.slug,
      revision: 1,
      digest,
      schema,
      connectorSlotMap,
      approvedEgressOrigins: [],
      connectorRecipePins,
    }),
    leftOverrides,
  };
}

function signedCostContext(): InvocationCostContext {
  return InvocationCostContextSchema.parse({
    selectionState: 'DEFERRED',
    apiKeyId: null,
    profileId: null,
    profileRevision: null,
    businessId: 'document-core',
    businessVersion: '1.1.0',
    action: 'schema-workflow',
    attempt: 1,
    priceRevision: null,
    budgetReservationGroupId: RESERVATION_GROUP,
    budgetPins: [],
  });
}

function makeFixture(kind: RootOrBranch): RunEvidence {
  const recipe = recipeForTest();
  const rootOverrides = overridesFor(recipe);
  const parallel = kind === 'branch' ? parallelWorkflowPin(recipe) : undefined;
  const overrides = parallel?.leftOverrides ?? rootOverrides;
  const pin = parallel?.pin ?? workflowPin(overrides);
  const taskId = kind === 'root' ? ROOT_TASK : BRANCH_TASK;
  const operationId = kind === 'root' ? ROOT_OPERATION : BRANCH_OPERATION;
  const taskKey = kind === 'root' ? 'root' : 'legacy-workflow:recipe_parallel:branch:00';
  const taskInput = kind === 'root'
    ? { input: { variables: {} }, legacyWorkflowSchema: pin }
    : {
      input: { variables: {} },
      legacyWorkflowSchema: pin,
      __legacyWorkflowBranch: {
        parallelNodeId: 'recipe_parallel',
        branchIndex: 0,
        nodes: [pin.schema.nodes[0]!.type === 'parallel' ? pin.schema.nodes[0]!.branches![0]![0] : undefined],
        baseResults: {},
      },
    };
  const invocationRequests: InvocationGrantRequest[] = [];
  const connectorRequests: ReturnType<typeof InvocationRequestSchema.parse>[] = [];
  const providerRequests: ProviderRequest[] = [];
  const sequence: string[] = [];
  const invocationIds: string[] = [];
  const ledger = new InMemoryInvocationLedger();
  const outbox = new InMemoryUsageOutbox();
  let activeClaims: GrantClaims | undefined;
  let activeToken: string | undefined;

  const runtimeFetch = (async (urlInput: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(urlInput));
    const method = init?.method ?? 'GET';
    if (url.origin !== 'http://runtime') throw new Error('unexpected offline Runtime transport');
    if (method === 'POST' && url.pathname === `/tasks/${taskId}/invocation-grants`) {
      const body = InvocationGrantRequestSchema.parse(JSON.parse(String(init?.body)));
      invocationRequests.push(body);
      const invocationId = kind === 'root'
        ? 'b16390d0-7d84-5f1a-9c50-e3d3eea54d7f'
        : '9407928f-610d-543b-91bd-202832d63aaf';
      invocationIds.push(invocationId);
      const connectorId = body.workflowOverrides?.connectorId;
      const connectorRevision = body.workflowOverrides?.connectorRevision;
      if (!connectorId || connectorRevision === undefined || !body.workflowOverrides) {
        throw new Error('Core31 did not send the admitted typed recipe leaf');
      }
      activeToken = `${SIGNED_GRANT}:${invocationId}`;
      activeClaims = {
        audience: 'connector',
        tenantId: TENANT,
        operationId,
        taskId,
        stepKey: body.stepKey,
        invocationId,
        inputHash: body.inputHash,
        connectorRevision: `${connectorId}:${connectorRevision}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        bindingSlot: body.bindingSlot,
        costContext: signedCostContext(),
        workflowOverridesDigest: workflowOverridesDigest({
          tenantId: TENANT,
          operationId,
          taskId,
          stepKey: body.stepKey,
          invocationId,
          connectorId,
          connectorRevision,
          workflowOverrides: body.workflowOverrides,
        }),
      };
      return jsonResponse({
        grant: activeToken,
        invocationId,
        connectorId,
        connectorRevision,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        allowedOptions: {},
      });
    }
    throw new Error(`unexpected offline Runtime request ${method} ${url.pathname}`);
  }) as typeof fetch;

  const costControl: ConnectorCostControlClient = {
    async preflight(grant, proof) {
      expect(grant).toBe(activeToken);
      expect(proof.connectorId).toBe(CONNECTOR);
      expect(proof.connectorRevision).toBe(1);
      sequence.push('cost-preflight');
      return {
        decision: 'ADMITTED',
        selection: {
          state: 'FROZEN',
          reservationGroupId: RESERVATION_GROUP,
          selectedAt: new Date().toISOString(),
          priceRevision: null,
          pricingTier: null,
          budgetPins: [],
        },
        confidence: 'best-effort',
        hardCapEnabled: false,
        evaluations: [],
      };
    },
    async transition(command) {
      expect(command.reservationGroupId).toBe(RESERVATION_GROUP);
      sequence.push(`cost-${command.target.toLowerCase()}`);
    },
  };
  const transport: ProviderTransport = {
    async send(request) {
      providerRequests.push(request);
      sequence.push('provider-send');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { content: 'admitted typed recipe completed', usage: { inputTokens: 2, outputTokens: 1 } },
      } satisfies ProviderResponse;
    },
  };
  const parityRepository = {
    async hasTypedChain(tenantId: string, connectorId: string) {
      return tenantId === TENANT && connectorId === CONNECTOR;
    },
    async getRevision(tenantId: string, connectorId: string, revision: number) {
      if (tenantId !== TENANT || connectorId !== CONNECTOR || revision !== 1) return undefined;
      return {
        tenantId: TENANT,
        connectorId: CONNECTOR,
        revision: 1,
        state: 'ACTIVE' as const,
        recipe,
        credentialRef: null,
        credentialVersion: null,
        credentialSource: null,
        expectedHeadRevision: 1,
      };
    },
  };
  const connectorRuntime = new DurableConnectorRuntime(
    ledger as never,
    {} as never,
    new InMemoryQuotaStore(),
    outbox as never,
    new AdapterRegistry([]),
    transport,
    {} as never,
    {
      async verify(token: string) {
        if (token !== activeToken || !activeClaims) throw new Error('unknown synthetic grant');
        return activeClaims;
      },
    },
    undefined,
    undefined,
    parityRepository as never,
    costControl,
  );

  const connectorFetch = (async (urlInput: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(urlInput));
    if (url.origin !== 'http://connector' || url.pathname !== '/invocations' || init?.method !== 'POST') {
      throw new Error(`unexpected offline Connector request ${init?.method ?? 'GET'} ${url.pathname}`);
    }
    const request = InvocationRequestSchema.parse(JSON.parse(String(init.body)));
    connectorRequests.push(request);
    try {
      const result = await connectorRuntime.invoke(request);
      return jsonResponse(toContractInvocationResponse(request.invocationId, result));
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'PROVIDER_UNAVAILABLE';
      const status = code === 'GRANT_INVALID' ? 401 : code === 'BINDING_DENIED' ? 403 : 409;
      return jsonResponse({ error: { code, message: error instanceof Error ? error.message : 'connector error' } }, status);
    }
  }) as typeof fetch;

  const runtimeClient = new RuntimeClient({ baseUrl: 'http://runtime', token: 'offline-service-token', fetchImpl: runtimeFetch });
  const invokeConnector = createConnectorInvoker({
    baseUrl: 'http://connector',
    serviceToken: 'offline-connector-service-token',
    fetchImpl: connectorFetch,
  });
  const taskContext = new DefaultTaskContext({
    taskId,
    operationId,
    tenantId: TENANT,
    businessId: 'document-core',
    businessVersion: '1.1.0',
    action: 'schema-workflow',
    kind: kind === 'root' ? 'root' : 'legacy-workflow-branch',
    taskKey,
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    deadlineAt: null,
    input: taskInput,
    connectorBindings: { [SLOT]: `${CONNECTOR}@1` },
    checkpointRefs: [],
    cancelRequested: false,
  }, {
    runtime: runtimeClient,
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
    invokeConnector,
    fetchImpl: runtimeFetch,
  });
  const context = {
    ...taskContext,
    step: {
      async peek() { return null; },
      async run<T>(stepKey: string, _inputHash: string, fn: () => Promise<T>): Promise<T> {
        return runWithStepKey(stepKey, fn);
      },
    },
    progress: { async report() {} },
    artifacts: {
      async write() {
        return { artifactId: randomUUID(), role: 'output', fileName: 'branch-result.json', mimeType: 'application/json', sizeBytes: 0, hashSha256: '0'.repeat(64) };
      },
    },
  } as unknown as SdkTaskContext;

  return { invocationRequests, connectorRequests, providerRequests, sequence, invocationIds, ledger, outbox, context, pin, overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ORV15 admitted workflow typed-recipe dispatch through Connector runtime', () => {
  it('dispatches the admitted root node using the exact checkpoint key and signed override pin', async () => {
    const h = makeFixture('root');
    const expectedStep = `legacy-workflow:node:${h.pin.digest}:root:root:recipe_request`;
    const disposition = await handleLegacyWorkflowSchema(h.context, h.context.input);

    expect(disposition.kind).toBe('completed');
    expect(h.invocationRequests).toHaveLength(1);
    expect(h.connectorRequests).toHaveLength(1);
    expect(h.invocationRequests[0]).toMatchObject({ stepKey: expectedStep, bindingSlot: SLOT, workflowOverrides: h.overrides });
    expect(h.connectorRequests[0]).toMatchObject({
      stepKey: expectedStep,
      bindingSlot: SLOT,
      invocationId: 'b16390d0-7d84-5f1a-9c50-e3d3eea54d7f',
      workflowOverrides: h.overrides,
    });
    expect(h.sequence).toEqual(['cost-preflight', 'cost-running', 'provider-send']);
    expect(h.providerRequests).toHaveLength(1);
    expect(h.providerRequests[0]?.headers['x-wfa-workflow']).toBe('recipe-admitted-header');
    expect(JSON.parse(String(h.providerRequests[0]?.body))).toMatchObject({
      prompt: 'ORV15_ADMITTED_RECIPE_PROMPT',
      workflow_mode: 'recipe-admitted-v1',
    });
    expect((await h.ledger.get('b16390d0-7d84-5f1a-9c50-e3d3eea54d7f'))?.state).toBe('SUCCEEDED');
    expect(h.outbox.size()).toBe(1);
  });

  it('dispatches the admitted parallel left branch with the full branch checkpoint key', async () => {
    const h = makeFixture('branch');
    const expectedStep = `legacy-workflow:node:${h.pin.digest}:branch:recipe_parallel-0:recipe_branch_left`;
    const disposition = await handleLegacyWorkflowBranch(h.context, h.context.input);

    expect(disposition.kind).toBe('completed');
    expect(h.invocationRequests).toHaveLength(1);
    expect(h.connectorRequests).toHaveLength(1);
    expect(h.invocationRequests[0]).toMatchObject({ stepKey: expectedStep, bindingSlot: SLOT, workflowOverrides: h.overrides });
    expect(h.connectorRequests[0]).toMatchObject({
      stepKey: expectedStep,
      bindingSlot: SLOT,
      invocationId: '9407928f-610d-543b-91bd-202832d63aaf',
    });
    expect(h.sequence).toEqual(['cost-preflight', 'cost-running', 'provider-send']);
    expect(h.providerRequests[0]?.headers['x-wfa-workflow']).toBe('branch-header-left');
    expect(JSON.parse(String(h.providerRequests[0]?.body))).toMatchObject({
      prompt: 'ORV14_BRANCH_LEFT',
      workflow_mode: 'branch-mode-left',
    });
    expect((await h.ledger.get('9407928f-610d-543b-91bd-202832d63aaf'))?.state).toBe('SUCCEEDED');
    expect(h.outbox.size()).toBe(1);
  });
});
