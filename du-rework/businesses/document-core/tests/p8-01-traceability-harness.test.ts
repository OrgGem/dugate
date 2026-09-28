import { randomUUID } from 'node:crypto';
import type { InvocationGrant } from '@du/contracts';
import {
  DefaultTaskContext,
  RuntimeClient,
  type TaskContextDeps,
  type ConnectorInvocationPayload,
} from '@du/worker-sdk';
import { documentCoreHandlers } from '../src/worker';

interface InvocationGrantRequestBody {
  leaseEpoch: number;
  stepKey: string;
  bindingSlot: string;
  inputHash: string;
}

interface ArtifactGrantRequestBody {
  leaseEpoch: number;
  purpose: string;
  mimeType: string;
  sizeBytes: number;
}

interface ProviderRequestEvidence {
  idempotencyKey: string | undefined;
  invocationId: string | undefined;
  providerRequestId: string;
  input: unknown;
}

interface TraceEvidence {
  /** Entity-shaped fixtures mirror operations.root_task_id and tasks.operation_id. */
  operationEntities: Array<{ id: string; rootTaskId: string }>;
  taskEntities: Array<{ id: string; operationId: string; taskKey: string }>;
  invocationGrants: Array<{ taskId: string; body: InvocationGrantRequestBody }>;
  connectorRequests: ConnectorInvocationPayload[];
  /** In-memory connector_invocations row shape, including provider_request_id. */
  connectorInvocationEntities: Array<{
    operationId: string;
    taskId: string;
    invocationId: string;
    providerRequestId: string;
  }>;
  providerRequests: ProviderRequestEvidence[];
  artifactGrants: Array<{ taskId: string; body: ArtifactGrantRequestBody; artifactId: string }>;
  finalizedArtifacts: Array<{ artifactId: string; sizeBytes: number; sha256: string }>;
  uploadedArtifacts: Map<string, Buffer>;
}

/**
 * Offline P8-01 identity harness. It runs the real document-core extract handler
 * and worker-sdk task context against in-memory synthetic Runtime and provider
 * fetch boundaries. It never starts Orchestrator, Connector, PostgreSQL, Redis,
 * or a network listener, so it is a focused identity-contract check rather than
 * live multi-service proof.
 */
describe('P8-01 offline operation → task → invocation → provider-request trace', () => {
  test('keeps one operation/task/invocation identity across the worker and provider boundary', async () => {
    const operationId = '30000000-0000-4000-8000-000000000001';
    const taskId = '40000000-0000-4000-8000-000000000001';
    const invocationId = 'p8-01-invocation-0001';
    const providerRequestId = 'p8-01-provider-request-0001';
    const evidence: TraceEvidence = {
      operationEntities: [{ id: operationId, rootTaskId: taskId }],
      taskEntities: [{ id: taskId, operationId, taskKey: 'root' }],
      invocationGrants: [],
      connectorRequests: [],
      connectorInvocationEntities: [],
      providerRequests: [],
      artifactGrants: [],
      finalizedArtifacts: [],
      uploadedArtifacts: new Map(),
    };
    const baseUrl = 'http://p8-01.synthetic';
    const syntheticFetch: typeof fetch = async (input, init) => {
      const requestUrl = typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
        ? input
        : new URL(input.url);
      const method = init?.method ?? 'GET';
      const path = requestUrl.pathname;
      const body = typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
      const invocationGrantMatch = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/invocation-grants$/.exec(path);
      const artifactGrantMatch = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/artifacts$/.exec(path);
      const stepMatch = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/steps\/([^/]+)$/.exec(path);
      const finalizeMatch = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/finalize$/.exec(path);
      const blobMatch = /^\/blobs\/([0-9a-f-]+)$/.exec(path);

      if (method === 'POST' && invocationGrantMatch) {
        const grantRequest = body as unknown as InvocationGrantRequestBody;
        evidence.invocationGrants.push({ taskId: decodeURIComponent(invocationGrantMatch[1]!), body: grantRequest });
        const grant: InvocationGrant = {
          grant: 'synthetic-grant-for-offline-test',
          invocationId,
          connectorId: 'synthetic-connector',
          connectorRevision: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          allowedOptions: {},
        };
        return new Response(JSON.stringify(grant), { status: 200 });
      }

      if (method === 'POST' && artifactGrantMatch) {
        const artifactRequest = body as unknown as ArtifactGrantRequestBody;
        const artifactId = randomUUID();
        evidence.artifactGrants.push({
          taskId: decodeURIComponent(artifactGrantMatch[1]!),
          body: artifactRequest,
          artifactId,
        });
        return new Response(JSON.stringify({
          artifactId,
          storageKey: `synthetic/${artifactId}`,
          uploadUrl: new URL(`/blobs/${artifactId}`, baseUrl).toString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 200 });
      }

      if (method === 'PUT' && stepMatch) {
        const stepKey = decodeURIComponent(stepMatch[2]!);
        return new Response(JSON.stringify({ stepKey, generation: 1, replayed: false }), { status: 200 });
      }

      if (method === 'POST' && finalizeMatch) {
        evidence.finalizedArtifacts.push({
          artifactId: decodeURIComponent(finalizeMatch[1]!),
          sizeBytes: Number(body.sizeBytes),
          sha256: String(body.sha256),
        });
        return new Response(null, { status: 204 });
      }

      if (method === 'PUT' && blobMatch) {
        const uploadedBytes = Buffer.from(await new Response(init?.body).arrayBuffer());
        evidence.uploadedArtifacts.set(decodeURIComponent(blobMatch[1]!), uploadedBytes);
        return new Response(null, { status: 200 });
      }

      if (method === 'POST' && path === '/provider/infer') {
        const idempotencyKey = new Headers(init?.headers).get('idempotency-key') ?? undefined;
        evidence.providerRequests.push({
          idempotencyKey,
          invocationId: idempotencyKey,
          providerRequestId,
          input: body.input,
        });
        return new Response(JSON.stringify({
          providerRequestId,
          data: {
            invoiceNumber: 'TRACE-INV-001',
            supplier: { name: 'Synthetic Supplier' },
            total: 125,
            currency: 'USD',
          },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ error: 'UNEXPECTED_HARNESS_ROUTE', path }), { status: 404 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = syntheticFetch;
    try {
      const runtime = new RuntimeClient({
        baseUrl: `${baseUrl}/api/runtime/v1`,
        token: 'synthetic-runtime-token',
        fetchImpl: syntheticFetch,
      });
      const logger = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as TaskContextDeps['logger'];
      const context = new DefaultTaskContext(
        {
          taskId,
          operationId,
          tenantId: 'synthetic-tenant',
          businessId: 'document-core',
          businessVersion: '1.0.0',
          action: 'extract',
          kind: 'root',
          taskKey: 'root',
          attempt: 1,
          leaseEpoch: 7,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          deadlineAt: null,
          input: {},
          connectorBindings: { reasoning: 'synthetic-connector@1' },
          checkpointRefs: [],
          cancelRequested: false,
        },
        {
          runtime,
          logger,
          invokeConnector: async (_grant, payload) => {
            evidence.connectorRequests.push(payload);
            const providerResponse = await syntheticFetch(`${baseUrl}/provider/infer`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'idempotency-key': payload.invocationId,
              },
              body: JSON.stringify({ input: payload.input }),
            });
            if (!providerResponse.ok) {
              throw new Error(`synthetic provider returned ${providerResponse.status}`);
            }
            const providerBody = (await providerResponse.json()) as {
              providerRequestId: string;
              data: Record<string, unknown>;
            };
            evidence.connectorInvocationEntities.push({
              operationId: payload.operationId,
              taskId: payload.taskId,
              invocationId: payload.invocationId,
              providerRequestId: providerBody.providerRequestId,
            });
            return {
              invocationId: payload.invocationId,
              state: 'SUCCEEDED',
              providerRequestId: providerBody.providerRequestId,
              result: { data: providerBody.data },
              usage: { inputTokens: 1, outputTokens: 1, costMicrousd: 0, measurement: 'measured' },
            };
          },
        }
      );

      const extractHandler = documentCoreHandlers.extract;
      if (!extractHandler) throw new Error('document-core extract handler is not registered');
      const disposition = await extractHandler(context, {
        type: 'invoice',
        text: 'Synthetic invoice TRACE-INV-001 for 125 USD',
      });

      expect(disposition.kind).toBe('completed');
      if (disposition.kind !== 'completed') throw new Error('extract handler did not complete');
      expect(disposition.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);

      const operationEntity = evidence.operationEntities[0];
      const taskEntity = evidence.taskEntities[0];
      expect(operationEntity).toBeDefined();
      expect(taskEntity).toBeDefined();
      expect(operationEntity).toMatchObject({ id: operationId, rootTaskId: taskId });
      expect(taskEntity).toMatchObject({ id: taskId, operationId, taskKey: 'root' });
      expect(operationEntity!.rootTaskId).toBe(taskEntity!.id);
      expect(taskEntity!.operationId).toBe(operationEntity!.id);

      expect(evidence.invocationGrants).toHaveLength(1);
      expect(evidence.invocationGrants[0]).toMatchObject({
        taskId,
        body: {
          leaseEpoch: 7,
          stepKey: 'extract:connector-inference',
          bindingSlot: 'reasoning',
        },
      });
      expect(evidence.invocationGrants[0]!.body.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      expect(evidence.connectorRequests).toHaveLength(1);
      const connectorRequest = evidence.connectorRequests[0]!;
      expect(connectorRequest).toMatchObject({
        operationId,
        taskId,
        invocationId,
        stepKey: 'extract:connector-inference',
        bindingSlot: 'reasoning',
      });
      expect(evidence.connectorInvocationEntities).toEqual([{
        operationId,
        taskId,
        invocationId,
        providerRequestId,
      }]);

      expect(evidence.providerRequests).toEqual([
        expect.objectContaining({
          invocationId,
          idempotencyKey: invocationId,
          providerRequestId,
        }),
      ]);
      expect(evidence.providerRequests[0]!.input).toBeDefined();

      const resultArtifactId = disposition.resultRef.slice('artifact://'.length);
      const resultBytes = evidence.uploadedArtifacts.get(resultArtifactId);
      expect(resultBytes).toBeDefined();
      const resultEnvelope = JSON.parse(resultBytes!.toString('utf8')) as Record<string, unknown>;
      expect(resultEnvelope).toMatchObject({
        status: 'COMPLETED',
        provenance: { method: 'llm_extraction', modelSlot: 'reasoning' },
        data: { invoiceNumber: 'TRACE-INV-001', total: 125, currency: 'USD' },
      });

      const outputGrant = evidence.artifactGrants.find((grant) => grant.body.purpose === 'output');
      expect(outputGrant).toBeDefined();
      expect(outputGrant).toMatchObject({ taskId, body: { leaseEpoch: 7 } });
      expect(outputGrant!.artifactId).toBe(resultArtifactId);
      expect(evidence.finalizedArtifacts.some((artifact) => artifact.artifactId === resultArtifactId)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});
