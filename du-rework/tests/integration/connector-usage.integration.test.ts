import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Queue, type Job } from 'bullmq';
import {
  BusinessManifestSchema,
  BusinessJobV1Schema,
  ResultEnvelopeSchema,
  SubmitAckSchema,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
  HttpUsageSink,
  PgSqlClient,
  PostgresConnectorConfigRepository,
  PostgresUsageOutbox,
  UsageOutboxDispatcher,
  createConnectorComposition,
} from '@du/connector';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../isolation/namespace';

const CONNECTOR_MIGRATION_DIRECTORY =
  process.env.CONNECTOR_MIGRATION_DIRECTORY ?? join(__dirname, '..', '..', 'services', 'connector', 'src', 'db', 'migrations');

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx && process.env.REDIS_DB_INDEX
    ? `redis://localhost:6380/${process.env.REDIS_DB_INDEX}`
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = `integration-runtime-${randomUUID()}`;
const USAGE_TOKEN = `integration-usage-${randomUUID()}`;
const API_KEY = `integration-api-${randomUUID()}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
const BUSINESS_ID = `connector-usage-${randomUUID().replaceAll('-', '')}`;
const BUSINESS_VERSION = '1.0.0';
const INVOCATION_GRANT_SECRET = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
const IDENTITY_SECRET = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
const ENCRYPTION_KEY = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');

const manifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'Connector usage cross-service proof',
  description: 'Connector delivers a usage event to the Orchestrator exactly once',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: false, resume: false, parallel: false },
  actions: [
    {
      name: 'run',
      displayName: 'Run against connector',
      description: 'Creates one real operation and root task',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 0 },
      capabilities: { cancel: false, resume: false },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : undefined };
}

async function waitForOperationJob(queue: Queue, operationId: string): Promise<Job> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const match = jobs.find((job) => {
      const parsed = BusinessJobV1Schema.safeParse(job.data);
      return parsed.success && parsed.data.operationId === operationId;
    });
    if (match) return match;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No dispatch job appeared for operation ${operationId}.`);
}

describe('Connector -> Orchestrator settled usage delivery (P3-06)', () => {
  let app: App | undefined;
  let baseUrl: string | undefined;
  let queue: Queue | undefined;
  let connectorDb: PgSqlClient | undefined;
  let connectorComposition: ReturnType<typeof createConnectorComposition> | undefined;

  beforeAll(async () => {
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  afterAll(async () => {
    await queue?.close().catch(() => undefined);
    await connectorComposition?.shutdown().catch(() => undefined);
    await connectorDb?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  test('Connector HttpUsageSink delivers a usage event to the Orchestrator projection exactly once', async () => {
    const runtime = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: INVOCATION_GRANT_SECRET.toString('utf8'),
      connectorId: 'default-connector',
      connectorRevision: 1,
      autoDispatch: true,
      autoMigrate: true,
    });
    app = runtime;
    await runtime.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_ID, hashKey(API_KEY)],
    );
    const server = await runtime.listen();
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Orchestrator did not bind.');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const registration = await request(
      baseUrl,
      `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`,
      { method: 'PUT', headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, body: manifest },
    );
    expect([200, 201]).toContain(registration.status);
    await runtime.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);

    const submission = await request(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/run`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': `submit-${randomUUID()}` },
      body: { input: { text: 'connector usage proof' } },
    });
    expect(submission.status).toBe(202);
    const submitAck = SubmitAckSchema.parse(submission.body);

    // The real task identity comes from the dispatched BullMQ job (usage is fenced to real tasks).
    queue = new Queue(`du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`, {
      connection: { url: REDIS_URL },
    });
    const dispatchJob = await waitForOperationJob(queue, submitAck.operationId);
    const dispatch = BusinessJobV1Schema.parse(dispatchJob.data);

    // Boot the real Connector composition with its usage sink pointed at the live Orchestrator.
    connectorDb = new PgSqlClient({ connectionString: DATABASE_URL, migrationDirectory: CONNECTOR_MIGRATION_DIRECTORY });
    await connectorDb.migrate();
    const outbox = new PostgresUsageOutbox(connectorDb);
    const sink = new HttpUsageSink(`${baseUrl}/api/runtime/v1/usage-events`, USAGE_TOKEN);
    const dispatcher = new UsageOutboxDispatcher(outbox, sink);

    const repository = new PostgresConnectorConfigRepository(connectorDb);
    const credentialRef = `${BUSINESS_ID}:credential`;
    await repository.put(credentialRef, new AesCredentialCipher(ENCRYPTION_KEY).encrypt('provider-secret'));
    await repository.createRevision({
      connectorId: 'default-connector',
      adapter: 'json-http',
      config: { baseUrl: 'http://127.0.0.1:1', path: '/', timeoutMs: 5000 },
      credentialRef,
      state: 'ACTIVE',
    });

    connectorComposition = createConnectorComposition({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      migrationDirectory: CONNECTOR_MIGRATION_DIRECTORY,
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(IDENTITY_SECRET),
      grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(INVOCATION_GRANT_SECRET)),
      credentialCipher: new AesCredentialCipher(ENCRYPTION_KEY),
      usageSink: sink,
    });
    await connectorComposition.start();

    // Register a real invocation claim row first: the Connector's durable outbox
    // references connector_invocations(invocation_id), exactly as the runtime does
    // after completing a provider call.
    const invocationId = `invocation-${randomUUID()}`;
    const localRequest = {
      contractVersion: '1' as const,
      invocationId,
      tenantId: '00000000-0000-0000-0000-000000000001',
      operationId: submitAck.operationId,
      taskId: dispatch.taskId,
      stepKey: 'run',
      bindingSlot: 'reasoning',
      input: { text: 'connector usage proof' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    };
    await connectorDb.query(
      `INSERT INTO connector_invocations
         (invocation_id, tenant_id, operation_id, task_id, step_key, input_hash, request, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'SUCCEEDED')`,
      [
        invocationId,
        localRequest.tenantId,
        submitAck.operationId,
        dispatch.taskId,
        'run',
        'test-hash-usage-proof',
        JSON.stringify(localRequest),
      ],
    );

    // Append one measured event, then dispatch three times (duplicate delivery) to prove dedup.
    const event = {
      eventId: `usage-${randomUUID()}`,
      invocationId,
      operationId: submitAck.operationId,
      taskId: dispatch.taskId,
      usage: { inputTokens: 41, outputTokens: 17, pages: 2, costMicrousd: 725, measurement: 'measured' as const },
      createdAt: new Date().toISOString(),
    };
    await outbox.append(event);
    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();
    await dispatcher.dispatchOnce();

    // Exactly-once: one row, and the summed projection equals the single measured event.
    const projection = await runtime.db.query<{
      count: string; input_tokens: string; output_tokens: string; cost: string;
    }>(
      `SELECT count(*)::text AS count,
              COALESCE(sum((payload->'units'->>'inputTokens')::numeric),0)::text AS input_tokens,
              COALESCE(sum((payload->'units'->>'outputTokens')::numeric),0)::text AS output_tokens,
              COALESCE(sum((payload->>'costMicrousd')::numeric),0)::text AS cost
       FROM usage_events WHERE operation_id=$1`,
      [submitAck.operationId],
    );
    const row = projection.rows[0]!;
    expect(row.count).toBe('1');
    expect({ inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), costMicrousd: Number(row.cost) })
      .toEqual({ inputTokens: 41, outputTokens: 17, costMicrousd: 725 });

    await dispatchJob.remove();
  });
});
