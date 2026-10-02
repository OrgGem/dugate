import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../lib/db';
import { apiKeys, appSettings, externalApiConnections, operations, profileEndpoints } from '../../lib/db/schema';
import { getPipelineQueue, getWorkflowStepsQueue } from '../../lib/queue/pipeline-queue';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';
import { createDummyPdfBlob, API_BASE_URL } from './utils';

interface OperationResponse {
  name: string;
  done: boolean;
  metadata: { state: string; pipeline?: string[] };
  result?: { content: string; usage: { input_tokens: number; output_tokens: number } };
  error?: { message: string };
}

interface MockCall { query: string; files: string[]; model: string }

const runId = crypto.randomUUID();
const apiKey = `dg_e2e_openai_${runId}`;
const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
const connectorSlug = `e2e-openai-${runId}`;
const schemaSlug = `e2e-openai-${runId}`;
const schemaKey = `wb_schema:${schemaSlug}`;
const mockWorkerUrl = process.env.E2E_MOCK_WORKER_URL || 'http://localhost:3099';
const mockControlUrl = process.env.E2E_MOCK_CONTROL_URL || 'http://localhost:3099';
const profileName = `E2E OpenAI ${runId}`;
const createdOperations: string[] = [];

async function mockCalls(): Promise<MockCall[]> {
  const response = await fetch(`${mockControlUrl}/__test/openai-e2e/${runId}`);
  if (!response.ok) throw new Error(`Mock control endpoint returned ${response.status}`);
  return (await response.json() as { calls: MockCall[] }).calls;
}

async function submit(path: string, form: FormData): Promise<string> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
  });
  const body = await response.json() as OperationResponse & { detail?: string };
  expect({ status: response.status, body }).toMatchObject({ status: 202 });
  expect(body.name).toMatch(/^operations\//);
  const operationId = body.name.slice('operations/'.length);
  createdOperations.push(operationId);
  expect(response.headers.get('Operation-Location')).toBe(`/api/v1/operations/${operationId}`);
  return operationId;
}

async function waitForResult(operationId: string): Promise<OperationResponse> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${API_BASE_URL}/operations/${operationId}`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as OperationResponse;
    if (body.done) {
      expect(body.metadata.state).toBe('SUCCEEDED');
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker did not complete operation ${operationId} within 45s`);
}

async function assertQueueJob(operationId: string, queue: ReturnType<typeof getPipelineQueue>, type: 'pipeline' | 'workflow') {
  const jobs = await queue.getJobs(['completed', 'failed', 'active', 'waiting', 'delayed'], 0, -1);
  const job = jobs.find((candidate) => candidate.data.operationId === operationId);
  expect(job).toBeDefined();
  expect(job?.data.type).toBe(type);
  expect(await job?.getState()).toBe('completed');
  return job;
}

describe('profile → BullMQ → worker → OpenAI-shaped connector', () => {
  let profileId: string;

  beforeAll(async () => {
    const health = await fetch(`${mockControlUrl}/health`);
    expect(health.ok).toBe(true);

    const [key] = await db.insert(apiKeys).values({
      name: profileName,
      keyHash,
      prefix: 'dg_e2e_',
      role: 'STANDARD',
      status: 'active',
      spendingLimit: 1000,
    }).returning();
    profileId = key.id;

    await db.insert(externalApiConnections).values({
      slug: connectorSlug,
      name: 'E2E OpenAI mock',
      endpointUrl: `${mockWorkerUrl}/ext/openai-e2e/${runId}`,
      httpMethod: 'POST',
      authType: 'API_KEY_HEADER',
      authKeyHeader: 'x-api-key',
      authSecret: process.env.E2E_MOCK_API_KEY || 'DUMMY_SECRET_KEY',
      promptFieldName: 'query',
      fileFieldName: 'files',
      defaultPrompt: 'Profile marker: {{e2e_marker}}',
      staticFormFields: JSON.stringify([{ key: 'model', value: 'mock-openai-e2e' }]),
      responseContentPath: 'choices.0.message.content',
      timeoutSec: 15,
      state: 'ENABLED',
    });

    for (const slug of ['ingest:parse', 'extract:invoice', 'analyze:classify', 'transform:rewrite', 'generate:summary', 'compare:diff']) {
      await db.insert(profileEndpoints).values({
        apiKeyId: profileId,
        endpointSlug: slug,
        enabled: true,
        connectionsOverride: JSON.stringify([{ slug: connectorSlug }]),
        parameters: JSON.stringify({ e2e_marker: { value: `${runId}:${slug}`, isLocked: true } }),
      });
    }

    await db.insert(profileEndpoints).values({
      apiKeyId: profileId,
      endpointSlug: `workflows:schema:${schemaSlug}`,
      enabled: true,
      parameters: JSON.stringify({ _workflowPrompts: { value: { e2e: `workflow:${runId}` }, isLocked: true } }),
    });

    const schema: WorkflowSchema = {
      slug: schemaSlug,
      name: 'E2E OpenAI connector workflow',
      nodes: [{ id: 'call_openai', type: 'connector', connector: connectorSlug, promptOverrideKey: 'e2e', inputs: { file: '$files' } }],
      flow: ['call_openai'],
      output: { from: 'call_openai' },
    };
    await db.insert(appSettings).values({ key: schemaKey, value: JSON.stringify(schema) });
  });

  afterAll(async () => {
    const pipelineQueue = getPipelineQueue();
    const stepsQueue = getWorkflowStepsQueue();
    for (const queue of [pipelineQueue, stepsQueue]) {
      const jobs = await queue.getJobs(['completed', 'failed'], 0, -1);
      for (const job of jobs.filter((candidate) => createdOperations.includes(candidate.data.operationId))) {
        await job.remove();
      }
    }
    if (profileId) {
      await db.delete(operations).where(eq(operations.apiKeyId, profileId));
      await db.delete(profileEndpoints).where(eq(profileEndpoints.apiKeyId, profileId));
      await db.delete(apiKeys).where(eq(apiKeys.id, profileId));
    }
    await db.delete(appSettings).where(eq(appSettings.key, schemaKey));
    await db.delete(externalApiConnections).where(eq(externalApiConnections.slug, connectorSlug));
    await fetch(`${mockControlUrl}/__test/openai-e2e/${runId}`, { method: 'DELETE' }).catch(() => undefined);
    await Promise.all([pipelineQueue.close(), stepsQueue.close()]);
    await db.$client.end();
  });

  const cases = [
    { path: '/docs/ingest', field: 'mode', value: 'parse', slug: 'ingest:parse' },
    { path: '/docs/extract', field: 'type', value: 'invoice', slug: 'extract:invoice' },
    { path: '/docs/analyze', field: 'task', value: 'classify', slug: 'analyze:classify' },
    { path: '/docs/transform', field: 'action', value: 'rewrite', slug: 'transform:rewrite' },
    { path: '/docs/generate', field: 'task', value: 'summary', slug: 'generate:summary' },
    { path: '/docs/compare', field: 'mode', value: 'diff', slug: 'compare:diff' },
  ];

  it.each(cases)('$slug uses its registered profile and real pipeline worker', async ({ path, field, value, slug }) => {
    const form = new FormData();
    form.set(field, value);
    form.append('file', createDummyPdfBlob(), 'source.pdf');
    if (slug.startsWith('compare:')) form.append('target_file', createDummyPdfBlob(), 'target.pdf');
    const operationId = await submit(path, form);
    const [stored] = await db.select().from(operations).where(eq(operations.id, operationId));
    expect(stored.apiKeyId).toBe(profileId);
    expect(stored.endpointSlug).toBe(slug);
    expect(JSON.parse(stored.pipelineJson)).toMatchObject([{ processor: connectorSlug, variables: { e2e_marker: `${runId}:${slug}` } }]);

    const result = await waitForResult(operationId);
    expect(result.result?.content).toContain(`${runId}:${slug}`);
    expect(result.result?.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    const job = await assertQueueJob(operationId, getPipelineQueue(), 'pipeline');
    expect(job?.data.profileName).toBe(profileName);
    expect((await mockCalls()).some((call) => call.query.includes(`${runId}:${slug}`) && call.files.includes('source.pdf') && call.model === 'mock-openai-e2e')).toBe(true);
  }, 55_000);

  it('routes a schema workflow through the parent and sub-step workers', async () => {
    const form = new FormData();
    form.set('schemaSlug', schemaSlug);
    form.set('apiKeyId', apiKey);
    form.append('file', createDummyPdfBlob(), 'workflow.pdf');
    const operationId = await submit('/docs/workflows/schema', form);
    const result = await waitForResult(operationId);
    expect(result.result?.content).toContain(`workflow:${runId}`);
    await assertQueueJob(operationId, getPipelineQueue(), 'workflow');

    const [parent] = await db.select().from(operations).where(eq(operations.id, operationId));
    expect(parent.apiKeyId).toBe(profileId);
    expect(parent.endpointSlug).toBe(`workflows:schema:${schemaSlug}`);
    const children = await db.select().from(operations).where(and(eq(operations.apiKeyId, profileId), eq(operations.endpointSlug, connectorSlug)));
    expect(children).toHaveLength(1);
    const child = children[0];
    createdOperations.push(child.id);
    expect(child.state).toBe('SUCCEEDED');
    await assertQueueJob(child.id, getWorkflowStepsQueue(), 'pipeline');
    expect((await mockCalls()).some((call) => call.query.includes(`workflow:${runId}`) && call.files.includes('workflow.pdf'))).toBe(true);
  }, 55_000);
});
