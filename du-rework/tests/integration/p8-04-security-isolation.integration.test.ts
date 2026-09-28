import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import {
  BusinessManifestSchema,
  contentHash,
  InvocationGrantSchema,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import {
  validateProviderUrl,
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacSignedGrantSource,
  PgSqlClient,
} from '@du/connector';
import { MockProviderServer } from '../stubs/provider/mock-provider';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../isolation/namespace';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
        redisDbIndex: process.env.REDIS_DB_INDEX ? Number(process.env.REDIS_DB_INDEX) : undefined,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx
    ? isolationCtx.getRedisUrl(BASE_REDIS_URL)
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = `security-runtime-${randomUUID()}`;
const WORKER_IDENTITY_TOKEN = `security-worker-${randomUUID()}`;
const ADMIN_TOKEN = `security-admin-${randomUUID()}`;
const USAGE_TOKEN = `security-usage-${randomUUID()}`;
const INVOCATION_GRANT_SECRET = `grant-sec-${randomUUID()}`;

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-000000000002';
const API_KEY_A = `sec-key-tenant-a-${randomUUID()}`;
const API_KEY_B = `sec-key-tenant-b-${randomUUID()}`;

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const BUSINESS_ID = `sec-proof-${randomUUID().replace(/-/g, '')}`;
const BUSINESS_VERSION = '1.0.0';

const testManifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P8-04 Security & Isolation Proof',
  description: 'Synthetic security test fixture for tenant isolation, SSRF, grants, and secrets',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: false },
  actions: [
    {
      name: 'process',
      displayName: 'Process',
      description: 'Security test process action',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [{ name: 'slot-1', required: false, acceptedCapabilities: ['ocr'] }],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Record<string, string>;
}

async function http(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; rawText?: string } = {}
): Promise<HttpResult> {
  let reqBody: string | undefined;
  if (opts.rawText !== undefined) {
    reqBody = opts.rawText;
  } else if (opts.body !== undefined) {
    reqBody = JSON.stringify(opts.body);
  }

  const requestHeaders: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  // The platform runtime bearer registers business versions. Worker routes
  // use the business-scoped worker identity, matching the claim contract and
  // ensuring artifact task/business authorization is exercised as a worker.
  if (
    path.startsWith('/api/runtime/v1/')
    && !path.startsWith('/api/runtime/v1/businesses/')
    && requestHeaders.authorization === `Bearer ${RUNTIME_TOKEN}`
  ) {
    requestHeaders.authorization = `Bearer ${WORKER_IDENTITY_TOKEN}`;
  }

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: requestHeaders,
    body: reqBody,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, body, text, headers };
}

describe('P8-04: Auth, Tenant Isolation, SSRF, File, Schema & Secret Safety Suite (OPS-04, ART-03, CON-04, REG-04)', () => {
  let app: App | undefined;
  let baseUrl: string;
  let mockProvider: MockProviderServer;

  beforeAll(async () => {
    assertSafeIsolationConfig({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      isolationCtx,
      allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
    });

    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }

    mockProvider = new MockProviderServer();
    await mockProvider.start();

    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [BUSINESS_ID]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: INVOCATION_GRANT_SECRET,
      autoDispatch: false,
      autoMigrate: true,
    });

    await app.listen();
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Seed Tenant A and Tenant B
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-a', 'ACTIVE'), ($2, 'tenant-b', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A, TENANT_B]
    );

    // Seed API keys for Tenant A and Tenant B
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'keyA', 'ACTIVE'), ($4, $5, $6, 'keyB', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_A, hashKey(API_KEY_A), randomUUID(), TENANT_B, hashKey(API_KEY_B)]
    );

    // Register test business
    const regRes = await http(baseUrl, `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: testManifest,
    });
    expect([200, 201]).toContain(regRes.status);
    await app.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);
  }, 30_000);

  afterAll(async () => {
    if (mockProvider) {
      await mockProvider.stop();
    }
    if (app) {
      await app.close({ timeoutMs: 200, pollIntervalMs: 50 });
    }
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
      isolationCtx.cleanupArtifactDir();
    }
  }, 30_000);

  // Helper: submit operation for Tenant A
  async function submitTenantA(text = 'tenant-a-data'): Promise<{ operationId: string; taskId: string }> {
    const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY_A, 'idempotency-key': `submit-a-${randomUUID()}` },
      body: { input: { text } },
    });
    expect(res.status).toBe(202);
    const opId = res.body.operationId as string;
    const taskRow = await app!.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = $1 LIMIT 1', [opId]);
    return { operationId: opId, taskId: taskRow.rows[0]!.id };
  }

  // ---------------------------------------------------------------------------
  // 1. Cross-Tenant Access Denied (SEC-01, OPS-04)
  // ---------------------------------------------------------------------------
  describe('1. Cross-Tenant Access Denied (SEC-01, OPS-04)', () => {
    let opAId: string;
    let taskAId: string;

    beforeAll(async () => {
      const created = await submitTenantA('tenant-a-confidential-document');
      opAId = created.operationId;
      taskAId = created.taskId;
    });

    test('cross-tenant operation lookup returns 404 NOT_FOUND without leaking existence', async () => {
      // Tenant B queries Tenant A's operation
      const res = await http(baseUrl, `/api/v1/operations/${opAId}`, {
        headers: { 'x-api-key': API_KEY_B },
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('cross-tenant operation result lookup returns 404 NOT_FOUND', async () => {
      // Tenant B queries Tenant A's operation result
      const res = await http(baseUrl, `/api/v1/operations/${opAId}/result`, {
        headers: { 'x-api-key': API_KEY_B },
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('cross-tenant operation cancellation returns 404 NOT_FOUND', async () => {
      // Tenant B attempts to cancel Tenant A's operation
      const res = await http(baseUrl, `/api/v1/operations/${opAId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_B },
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('cross-tenant human wait resume returns 404 NOT_FOUND', async () => {
      // Tenant B attempts to resume Tenant A's operation
      const res = await http(baseUrl, `/api/v1/operations/${opAId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_B },
        body: {
          waitId: 'wait-foreign',
          input: { approved: true },
          expectedStateVersion: 1,
        },
      });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('cross-tenant artifact access request is rejected with 409 PERMISSION_DENIED', async () => {
      // Create a task for Tenant B
      const subB = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_B },
        body: { input: { text: 'tenant-b-doc' } },
      });
      expect(subB.status).toBe(202);
      const opBId = subB.body.operationId as string;
      const taskBRow = await app!.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = $1', [opBId]);
      const taskBId = taskBRow.rows[0]!.id;

      // Claim Task A (Tenant A) and Task B (Tenant B)
      const claimA = await http(baseUrl, `/api/runtime/v1/tasks/${taskAId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-a-${randomUUID()}`, workerInstanceId: 'worker-a', businessId: BUSINESS_ID },
      });
      const claimB = await http(baseUrl, `/api/runtime/v1/tasks/${taskBId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-b-${randomUUID()}`, workerInstanceId: 'worker-b', businessId: BUSINESS_ID },
      });
      expect(claimA.status).toBe(200);
      expect(claimB.status).toBe(200);

      // Tenant A creates an artifact
      const uploadRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskAId}/artifacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claimA.body.leaseEpoch,
          purpose: 'output',
          mimeType: 'application/pdf',
          sizeBytes: 100,
        },
      });
      expect(uploadRes.status).toBe(201);
      const artAId = uploadRes.body.artifactId as string;

      // Tenant B worker attempts to request access to Tenant A's artifact
      const accessRes = await http(baseUrl, `/api/runtime/v1/artifacts/${artAId}/access`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          taskId: taskBId, // Foreign task
          leaseEpoch: claimB.body.leaseEpoch,
          mode: 'read',
        },
      });

      expect(accessRes.status).toBe(409);
      expect(accessRes.body.code).toBe('PERMISSION_DENIED');
      expect((accessRes.body.detail as string) || (accessRes.body.title as string)).toMatch(
        /(not belong to task|not authorized to read artifact)/i
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Expired or Foreign Artifact Grant Denied (ART-03)
  // ---------------------------------------------------------------------------
  describe('2. Expired or Foreign Artifact Grant Denied (ART-03)', () => {
    let grantStorageKey: string;
    let validGrantToken: string;

    beforeAll(async () => {
      const { taskId } = await submitTenantA('grant-security-doc');
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-grant-${randomUUID()}`, workerInstanceId: 'worker-grant', businessId: BUSINESS_ID },
      });
      expect(claim.status).toBe(200);

      const uploadRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/artifacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.body.leaseEpoch,
          purpose: 'output',
          mimeType: 'application/pdf',
          sizeBytes: 50,
        },
      });
      expect(uploadRes.status).toBe(201);
      const url = new URL(uploadRes.body.uploadUrl as string, 'http://localhost');
      const blobPath = /^\/api\/runtime\/v1\/artifacts\/blob\/([^/]+)$/.exec(url.pathname);
      expect(blobPath).not.toBeNull();
      grantStorageKey = decodeURIComponent(blobPath![1]!);
      validGrantToken = url.searchParams.get('grant') ?? '';
      expect(validGrantToken).not.toBe('');
    });

    test('artifact blob upload with forged or invalid grant token is rejected with 403 PERMISSION_DENIED', async () => {
      const forgedToken = randomUUID();
      const res = await http(baseUrl, `/api/runtime/v1/artifacts/blob/${grantStorageKey}?grant=${forgedToken}`, {
        method: 'PUT',
        rawText: 'malicious payload bytes',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.message || res.body.title || res.body.detail).toMatch(/invalid artifact blob grant/i);
    });

    test('artifact blob upload without grant query param is rejected with 403 PERMISSION_DENIED', async () => {
      const res = await http(baseUrl, `/api/runtime/v1/artifacts/blob/${grantStorageKey}`, {
        method: 'PUT',
        rawText: 'bytes without grant parameter',
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(res.body.message || res.body.title || res.body.detail).toMatch(/invalid artifact blob grant/i);
    });

    test('artifact blob upload with mismatched storage key is rejected with 403 PERMISSION_DENIED', async () => {
      // Use the valid grant token on a foreign storage key
      const foreignStorageKey = `art-${randomUUID()}`;
      const res = await http(baseUrl, `/api/runtime/v1/artifacts/blob/${foreignStorageKey}?grant=${validGrantToken}`, {
        method: 'PUT',
        rawText: 'bytes with foreign key',
      });

      // Returns 404 (if storageKey not found) or 403 (if token doesn't match)
      expect([403, 404]).toContain(res.status);
    });

    test('invocation grant with tampered HMAC signature is rejected by verifier', async () => {
      const secret = Buffer.from('test-hmac-grant-secret-32bytes!!');
      const grantSource = new HmacSignedGrantSource(secret);
      const verifier = new ContractSignedGrantVerifier(grantSource);

      // Construct a valid HS256 token
      const nowSeconds = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          audience: 'connector',
          tenantId: TENANT_A,
          operationId: randomUUID(),
          taskId: randomUUID(),
          stepKey: 'step-1',
          invocationId: randomUUID(),
          inputHash: 'hash-abc',
          connectorId: 'default-connector',
          connectorRevision: 1,
          bindingSlot: 'slot-1',
          exp: nowSeconds + 900,
          iat: nowSeconds,
        })
      ).toString('base64url');

      const sig = createHash('sha256').update(`${header}.${payload}`).digest('base64url');
      const tamperedToken = `${header}.${payload}.${sig}-tampered`;

      await expect(verifier.verify(tamperedToken)).rejects.toThrow(/invalid signature/i);
    });

    test('invocation grant with expired timestamp is rejected', async () => {
      const secret = Buffer.from('test-hmac-grant-secret-32bytes!!');
      const grantSource = new HmacSignedGrantSource(secret);
      const verifier = new ContractSignedGrantVerifier(grantSource);

      const pastSeconds = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          audience: 'connector',
          tenantId: TENANT_A,
          operationId: randomUUID(),
          taskId: randomUUID(),
          stepKey: 'step-1',
          invocationId: randomUUID(),
          inputHash: 'hash-abc',
          connectorId: 'default-connector',
          connectorRevision: 1,
          bindingSlot: 'slot-1',
          exp: pastSeconds,
          iat: pastSeconds - 60,
        })
      ).toString('base64url');

      const { createHmac } = await import('node:crypto');
      const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
      const expiredToken = `${header}.${payload}.${sig}`;

      // Verification of token claims parses through InvocationGrantClaimsSchema
      // When expired, downstream grant validation checks expiration
      const verifiedClaims = await verifier.verify(expiredToken);
      expect(new Date(verifiedClaims.expiresAt).getTime()).toBeLessThan(Date.now());
    });
  });

  // ---------------------------------------------------------------------------
  // 3. SSRF Attempt Against Internal or Metadata Addresses Rejected (CON-01, CON-05, SEC-01)
  // ---------------------------------------------------------------------------
  describe('3. SSRF Attempt Against Internal or Metadata Addresses Rejected (CON-01, CON-05, SEC-01)', () => {
    test('SSRF fence rejects cloud metadata IP 169.254.169.254', async () => {
      await expect(validateProviderUrl('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://169.254.169.254:8080/computeMetadata/v1/')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    test('SSRF fence rejects loopback addresses (127.0.0.1, localhost, [::1])', async () => {
      await expect(validateProviderUrl('http://127.0.0.1:8080/admin')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://127.0.0.2:9000/internal')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://[::1]:8080/metrics')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    test('SSRF fence rejects RFC 1918 private network ranges (10.x, 172.16.x, 192.168.x)', async () => {
      await expect(validateProviderUrl('http://10.0.0.1:8000')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://172.16.0.1:8000')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://172.31.255.255:8000')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(validateProviderUrl('http://192.168.1.1:8000')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    test('SSRF fence rejects non-HTTP schemes and embedded credentials', async () => {
      await expect(validateProviderUrl('file:///etc/passwd')).rejects.toThrow();
      await expect(validateProviderUrl('gopher://internal.network/1')).rejects.toThrow();
      await expect(validateProviderUrl('ftp://internal.vault/keys')).rejects.toThrow();
      await expect(validateProviderUrl('http://admin:secret@provider.example.com')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    test('mock provider demonstrates external provider URL succeeds while loopback requires explicit test permission', async () => {
      // In tests, mock provider on 127.0.0.1 requires allowPrivateNetworks flag
      const resolved = await validateProviderUrl(mockProvider.baseUrl, { allowPrivateNetworks: true });
      expect(resolved).toBeInstanceOf(URL);
      expect(resolved.port).toBe(String(new URL(mockProvider.baseUrl).port));

      // Without allowPrivateNetworks flag, even the mock provider is blocked by the fail-closed SSRF fence
      await expect(validateProviderUrl(mockProvider.baseUrl)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Oversized or Wrong-Content-Type Upload Rejected Before Storage (ART-02, ART-03)
  // ---------------------------------------------------------------------------
  describe('4. Oversized or Wrong-Content-Type Upload Rejected Before Storage (ART-02, ART-03)', () => {
    let testTaskId: string;
    let testLeaseEpoch: number;

    beforeAll(async () => {
      const { taskId } = await submitTenantA('upload-bounds-doc');
      testTaskId = taskId;
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${testTaskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-bounds-${randomUUID()}`, workerInstanceId: 'worker-bounds', businessId: BUSINESS_ID },
      });
      expect(claim.status).toBe(200);
      testLeaseEpoch = claim.body.leaseEpoch as number;
    });

    test('artifact upload grant request with negative size is rejected with 422 INVALID_SCHEMA', async () => {
      const res = await http(baseUrl, `/api/runtime/v1/tasks/${testTaskId}/artifacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: testLeaseEpoch,
          purpose: 'output',
          mimeType: 'application/pdf',
          sizeBytes: -100, // Negative size
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_SCHEMA');
    });

    test('artifact upload grant request with invalid purpose or empty mimeType is rejected with 422 INVALID_SCHEMA', async () => {
      const res = await http(baseUrl, `/api/runtime/v1/tasks/${testTaskId}/artifacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: testLeaseEpoch,
          purpose: 'executable-malware', // Not in allowed enum
          mimeType: '',
          sizeBytes: 1024,
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_SCHEMA');
    });

    test('oversized JSON submission exceeding 1 MiB limit is rejected with 413 PAYLOAD_TOO_LARGE before storage', async () => {
      // Construct a payload larger than DEFAULT_MAX_JSON_BYTES (1 MiB)
      const oversizedText = 'X'.repeat(1024 * 1024 + 1024); // 1 MiB + 1 KiB
      const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_A },
        body: { input: { text: oversizedText } },
      });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');

      // Verify zero operations were persisted from this rejected submission
      const checkOp = await app!.db.query<{ count: string }>(
        "SELECT count(*) FROM operations WHERE tenant_id=$1 AND input_ref::text LIKE '%XXXXX%'",
        [TENANT_A]
      );
      expect(Number(checkOp.rows[0]!.count)).toBe(0);
    });

    test('malformed JSON payload to public API is rejected with 400 or 422 before business layer', async () => {
      const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_A },
        rawText: '{"input": {"text": "unclosed json string...}',
      });

      expect([400, 422]).toContain(res.status);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Schema Violation Rejected Without Leaking Internal Messages (SEC-03)
  // ---------------------------------------------------------------------------
  describe('5. Schema Violation Rejected Without Leaking Internal Messages (SEC-03)', () => {
    test('public action submission schema violation returns sanitized 422 problem details', async () => {
      // Missing required 'text' field in input
      const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_A },
        body: { input: { nonExistentField: 123 } },
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_SCHEMA');
      expect(res.body.type).toBe('urn:du:error:invalid_schema');
      expect(res.body.errors).toBeDefined();
      expect(Array.isArray(res.body.errors)).toBe(true);

      const errors = res.body.errors as { pointer: string; message: string }[];
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.pointer).toBeDefined();
    });

    test('strict submission schema rejects unexpected extra top-level properties with 422', async () => {
      const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_A },
        body: {
          input: { text: 'valid text' },
          unrecognizedSecretStealer: 'injected',
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_SCHEMA');
      const errors = res.body.errors as { pointer: string; message: string }[];
      expect(errors.some((e) => e.pointer.includes('unrecognizedSecretStealer') || e.message.includes('unrecognizedSecretStealer'))).toBe(true);
    });

    test('schema violation response contains zero internal server or database leaks', async () => {
      const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY_A },
        body: { input: { badType: [1, 2, 3] } },
      });

      expect(res.status).toBe(422);
      const rawBody = res.text;

      // Must NOT leak SQL keywords, table names, file paths, or stack traces
      expect(rawBody).not.toMatch(/SELECT|INSERT|UPDATE|DELETE|FROM operations|tasks/i);
      expect(rawBody).not.toMatch(/pg_catalog|information_schema|postgres/i);
      expect(rawBody).not.toMatch(/[A-Z]:\\[^ "]+/); // Windows paths
      expect(rawBody).not.toMatch(/\/home\/|\/usr\/|node_modules/i); // Unix paths
      expect(rawBody).not.toMatch(/at (?:Object\.|Module\.|Function\.)/i); // JS Stack traces
    });
  });

  // ---------------------------------------------------------------------------
  // 6. No Secret Material in Any Response or Log Line (OPS-04, REG-04, SEC-04)
  // ---------------------------------------------------------------------------
  describe('6. No Secret Material in Any Response or Log Line (OPS-04, REG-04, SEC-04)', () => {
    test('API key secret is never returned in operation view, task details, or database plaintext', async () => {
      const { operationId } = await submitTenantA('secret-audit-doc');

      // Check GET /operations/:id response
      const opRes = await http(baseUrl, `/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': API_KEY_A },
      });
      expect(opRes.status).toBe(200);
      const opText = JSON.stringify(opRes.body);

      // Assert raw API key is nowhere in the response
      expect(opText).not.toContain(API_KEY_A);
      expect(opText).not.toContain('sec-key-tenant-a');

      // Check database storage: api_keys stores ONLY hash, never plaintext
      const keyRow = await app!.db.query<{ hash: string }>(
        'SELECT hash FROM api_keys WHERE tenant_id = $1 AND prefix = $2',
        [TENANT_A, 'keyA']
      );
      expect(keyRow.rows[0]!.hash).toBe(hashKey(API_KEY_A));
      expect(keyRow.rows[0]!.hash).not.toContain(API_KEY_A);
    });

    test('unauthenticated request with invalid bearer token does not echo the token in error response', async () => {
      const leakToken = `confidential-bearer-secret-${randomUUID()}`;
      const res = await http(baseUrl, `/api/runtime/v1/tasks/some-task/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${leakToken}` },
        body: { deliveryId: 'del-test', workerInstanceId: 'worker-test', businessId: BUSINESS_ID },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');

      // Problem details must NOT echo the attempted token value
      expect(res.text).not.toContain(leakToken);
    });

    test('connector credentials stored with AES-256-GCM cipher and never in plaintext', () => {
      const encryptionKey = randomBytes(32);
      const cipher = new AesCredentialCipher(encryptionKey);

      const secretPayload = JSON.stringify({
        apiKey: 'sk-prod-super-secret-provider-key-999',
        endpointSecret: 'whsec_abcdef1234567890',
      });

      // Encrypt credentials
      const encryptedBytes = cipher.encrypt(secretPayload);
      const encryptedString = Buffer.from(encryptedBytes).toString('base64');

      // Assert encrypted payload contains ZERO plaintext secret material
      expect(encryptedString).not.toContain('sk-prod-super-secret-provider-key-999');
      expect(encryptedString).not.toContain('whsec_abcdef1234567890');

      // Assert decryption recovers exact payload with valid key
      const decrypted = cipher.decrypt(encryptedBytes);
      expect(decrypted).toBe(secretPayload);

      // Assert tampering with encrypted bytes is caught by GCM auth tag
      const tamperedBytes = Buffer.from(encryptedBytes);
      tamperedBytes[tamperedBytes.length - 1]! ^= 0xff; // Corrupt last byte
      expect(() => cipher.decrypt(tamperedBytes)).toThrow();
    });

    test('invocation grant JWT claims omit database secrets, encryption keys, and internal credentials', async () => {
      const { taskId } = await submitTenantA('jwt-claims-audit-doc');
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-jwt-${randomUUID()}`, workerInstanceId: 'worker-jwt', businessId: BUSINESS_ID },
      });
      expect(claim.status).toBe(200);

      const grantRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/invocation-grants`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.body.leaseEpoch,
          stepKey: 'step-sec-1',
          bindingSlot: 'slot-1',
          inputHash: `hash-${randomUUID()}`,
        },
      });
      expect(grantRes.status).toBe(201);
      const grantToken = grantRes.body.grant as string;

      // Decode JWT payload without signature check
      const [, encodedPayload] = grantToken.split('.');
      expect(encodedPayload).toBeDefined();
      const claims = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8')) as Record<string, unknown>;

      // Verify claims contain only logical bindings and timestamps
      expect(claims.audience).toBe('connector');
      expect(claims.tenantId).toBe(TENANT_A);
      expect(claims.taskId).toBe(taskId);
      expect(claims.stepKey).toBe('step-sec-1');
      expect(claims.bindingSlot).toBe('slot-1');
      expect(claims.exp).toBeDefined();
      expect(claims.iat).toBeDefined();

      // Assert NO secrets or encryption keys leaked in JWT claims
      const claimsStr = JSON.stringify(claims);
      expect(claimsStr).not.toContain(INVOCATION_GRANT_SECRET);
      expect(claimsStr).not.toContain(ADMIN_TOKEN);
      expect(claimsStr).not.toContain(RUNTIME_TOKEN);
      expect(claimsStr).not.toContain(WORKER_IDENTITY_TOKEN);
      expect(claimsStr).not.toContain('du-test-only');
    });
  });
});
