import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, createDb, type App } from '@du/orchestrator';
import { contentHash } from '@du/contracts';
import { exampleReviewManifest } from '../src/manifest';
import {
  FROZEN_PLATFORM_DIGESTS,
  freezePlatformDigests,
  provisionWorkerIdentity,
  registerExtensionWorker,
  buildRegistrationDryRun,
} from '../src/registry-tool';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../../../tests/isolation/namespace';
import { assertTestDatabase, assertTestRedis } from './helpers/test-target-guard';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx && process.env.REDIS_DB_INDEX
    ? `redis://127.0.0.1:6380/${process.env.REDIS_DB_INDEX}`
    : BASE_REDIS_URL
);

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

describe('P7-03 / EXT-01: Live Manifest Registration, Digest Freeze & Negative ACL Boundaries', () => {
  let app: App | undefined;
  let orchestratorUrl: string;

  const adminToken = `adm-${randomUUID()}`;
  const runtimeToken = `rt-${randomUUID()}`;
  const usageToken = `usg-${randomUUID()}`;
  const grantSecret = `grant-${randomUUID()}`;

  const tenantA = '00000000-0000-0000-0000-000000000001';
  const apiKeyA = `du_test_${randomUUID().replace(/-/g, '')}`;

  const tenantB = '00000000-0000-0000-0000-000000000002';
  const apiKeyB = `du_test_${randomUUID().replace(/-/g, '')}`;

  const tenantC = '00000000-0000-0000-0000-000000000003';
  const apiKeyRestricted = `du_test_${randomUUID().replace(/-/g, '')}`;
  const restrictedKeyId = randomUUID();

  beforeAll(async () => {
    assertTestDatabase(BASE_DATABASE_URL);
    assertTestRedis(BASE_REDIS_URL);

    if (isolationCtx) {
      const adminDb = createDb(BASE_DATABASE_URL);
      await adminDb.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await adminDb.close();
    }

    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken,
      runtimeToken,
      usageToken,
      invocationGrantSecret: grantSecret,
      connectorId: 'test-connector',
      connectorRevision: 1,
      autoDispatch: false,
      autoMigrate: true,
    });

    const server = await app.listen();
    const addr = server.address() as AddressInfo;
    orchestratorUrl = `http://127.0.0.1:${addr.port}`;

    // Seed Tenant A active API key
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-a', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [tenantA]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), tenantA, hashKey(apiKeyA)]
    );

    // Seed Tenant B active API key for cross-tenant negative testing
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-b', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [tenantB]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), tenantB, hashKey(apiKeyB)]
    );

    // Seed Tenant C with a restricted profile binding (for PRF-01 403 test)
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-c', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [tenantC]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [restrictedKeyId, tenantC, hashKey(apiKeyRestricted)]
    );
    await app.db.query(
      `INSERT INTO profile_bindings (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings)
       VALUES ($1, 1, $2, $3, 'other-biz', '1.0.0', 'other-action', '{}')`,
      [randomUUID(), tenantC, restrictedKeyId]
    );
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (isolationCtx) {
      const adminDb = createDb(BASE_DATABASE_URL);
      await adminDb.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await adminDb.close();
    }
  }, 15_000);

  // ---------------------------------------------------------------------------
  // 1. Frozen Platform Digests & Identity Provisioning
  // ---------------------------------------------------------------------------
  describe('1. Immutable Platform Digests & Identity Boundaries', () => {
    test('freezes platform image digests without modifying platform source', () => {
      const digests = freezePlatformDigests();

      expect(digests.postgres).toBe(
        'postgres:16-alpine@sha256:d8b2d131f41e57c8d9e7ec7884d50c1f52d9b62f55c2cb1a2d69f063b48227be'
      );
      expect(digests.redis).toBe(
        'redis:7-alpine@sha256:c2210816a3a41e97664ff025b6a7157cc7a6ec0b37e8c3b400f074d2091461ff'
      );
      expect(digests.orchestrator).toBe(
        'du-orchestrator:latest@sha256:4b912ec91d293f9c6d370e28d9c2876527ba3e84a270dbb88e0c46b96e625a66'
      );
      expect(digests.connector).toBe(
        'du-connector:latest@sha256:3a762df1b9909c2a688b17161b2e6a394ec562c5b3648a38ecae1d5ec5bb5083'
      );
      expect(digests.worker).toBe(exampleReviewManifest.imageDigest);

      // Verify dry-run plan produces valid JSON payload
      const dryRun = buildRegistrationDryRun(exampleReviewManifest);
      expect(dryRun.businessId).toBe('example-review');
      expect(dryRun.version).toBe('1.0.0');
      expect(dryRun.manifestDigest).toBe(contentHash(exampleReviewManifest));
    });

    test('provisions worker identity with fail-closed operational ACL boundaries', () => {
      const identity = provisionWorkerIdentity({
        tenantId: tenantA,
        runtimeToken,
        adminToken,
      });

      expect(identity.tenantId).toBe(tenantA);
      expect(identity.allowedRoles).toEqual(['worker']);
      expect(identity.aclMatrix.canClaim).toBe(true);
      expect(identity.aclMatrix.canSubmit).toBe(false);
      expect(identity.aclMatrix.canAdmin).toBe(false);
      expect(identity.aclMatrix.directDbAccess).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. In-Tree Registry Tool Run Against Live Orchestrator
  // ---------------------------------------------------------------------------
  describe('2. In-Tree Registry Tool Live Execution (EXT-01)', () => {
    test('registers manifest, enables version, and activates for new submissions via live HTTP', async () => {
      const regResult = await registerExtensionWorker({
        orchestratorUrl,
        runtimeToken,
        adminToken,
        manifest: exampleReviewManifest,
        activate: true,
      });

      expect(regResult.businessId).toBe('example-review');
      expect(regResult.version).toBe('1.0.0');
      expect(regResult.manifestDigest).toBe(contentHash(exampleReviewManifest));
      expect(regResult.registered).toBe(true);
      expect(regResult.enabled).toBe(true);
      expect(regResult.activated).toBe(true);
      expect(regResult.queue).toBe('du-business-example-review-1.0.0');

      // Verify row state in PostgreSQL business_versions table
      const res = await app!.db.query<{
        status: string;
        is_active: boolean;
        digest: string;
        queue: string;
      }>(
        'SELECT status, is_active, digest, queue FROM business_versions WHERE business_id = $1 AND version = $2',
        ['example-review', '1.0.0']
      );

      expect(res.rowCount).toBe(1);
      const row = res.rows[0]!;
      expect(row.status).toBe('ENABLED');
      expect(row.is_active).toBe(true);
      expect(row.digest).toBe(contentHash(exampleReviewManifest));
      expect(row.queue).toBe('du-business-example-review-1.0.0');
    });

    test('replay registration is idempotent and preserves active state', async () => {
      const replayResult = await registerExtensionWorker({
        orchestratorUrl,
        runtimeToken,
        adminToken,
        manifest: exampleReviewManifest,
        activate: true,
      });

      expect(replayResult.registered).toBe(true);
      expect(replayResult.enabled).toBe(true);
      expect(replayResult.activated).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Assert Manifest Presence Through GET & Operations
  // ---------------------------------------------------------------------------
  describe('3. Assert Manifest Presence Through GET & Operation Querying', () => {
    let createdOpId: string;

    test('registry service returns enabled version matching manifest and digest', async () => {
      const enabled = await app!.registry.getEnabledVersion('example-review', '1.0.0');

      expect(enabled.manifest.businessId).toBe('example-review');
      expect(enabled.manifest.version).toBe('1.0.0');
      expect(enabled.digest).toBe(contentHash(exampleReviewManifest));
      expect(enabled.queue).toBe('du-business-example-review-1.0.0');
    });

    test('public submission routes to registered example-review manifest', async () => {
      const subResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKeyA,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            input: {
              reviewId: 'rev-p703-live-1',
              artifacts: [
                {
                  artifactId: 'art-sample-1',
                  fileName: 'contract.pdf',
                },
              ],
            },
          }),
        }
      );

      expect(subResp.status).toBe(202);
      const body = (await subResp.json()) as { operationId: string; state: string };
      createdOpId = body.operationId;
      expect(body.operationId).toBeDefined();
      expect(['ACCEPTED', 'PENDING']).toContain(body.state);
    });

    test('HTTP GET /api/v1/operations/:id returns manifest coordinates', async () => {
      expect(createdOpId).toBeDefined();
      const getResp = await fetch(`${orchestratorUrl}/api/v1/operations/${createdOpId}`, {
        headers: {
          'x-api-key': apiKeyA,
        },
      });

      expect(getResp.status).toBe(200);
      const op = (await getResp.json()) as Record<string, unknown>;
      expect(op.id).toBe(createdOpId);
      if (op.tenantId) {
        expect(op.tenantId).toBe(tenantA);
      }
      expect(op.businessId).toBe('example-review');
      expect(op.businessVersion).toBe('1.0.0');
      expect(op.action).toBe('review');
      expect(['ACCEPTED', 'PENDING', 'RUNNING']).toContain(op.state);
    });

    test('HTTP GET /api/v1/operations returns collection including example-review operation', async () => {
      const listResp = await fetch(`${orchestratorUrl}/api/v1/operations?limit=10`, {
        headers: {
          'x-api-key': apiKeyA,
        },
      });

      expect(listResp.status).toBe(200);
      const body = (await listResp.json()) as { items: Array<Record<string, unknown>> };
      expect(body.items.length).toBeGreaterThan(0);
      const found = body.items.find((it) => it.id === createdOpId);
      expect(found).toBeDefined();
      expect(found!.businessId).toBe('example-review');
      expect(found!.businessVersion).toBe('1.0.0');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Negative ACL Cross-Tenant & Role Security Checks (Expecting 403 / 401 / 404)
  // ---------------------------------------------------------------------------
  describe('4. Negative ACL Cross-Tenant & Role Security Boundaries', () => {
    test('cross-tenant query fails closed: Tenant B cannot access Tenant A operation (404)', async () => {
      // Find the operation submitted by Tenant A
      const ops = await app!.db.query<{ id: string }>(
        'SELECT id FROM operations WHERE tenant_id = $1 LIMIT 1',
        [tenantA]
      );
      expect(ops.rowCount).toBeGreaterThan(0);
      const opId = ops.rows[0]!.id;

      // Tenant B queries Tenant A's operation
      const resp = await fetch(`${orchestratorUrl}/api/v1/operations/${opId}`, {
        headers: {
          'x-api-key': apiKeyB,
        },
      });

      expect(resp.status).toBe(404);
      const err = (await resp.json()) as { code: string };
      expect(err.code).toBe('NOT_FOUND');
    });

    test('cross-tenant result query fails closed: Tenant B cannot access Tenant A result (404)', async () => {
      const ops = await app!.db.query<{ id: string }>(
        'SELECT id FROM operations WHERE tenant_id = $1 LIMIT 1',
        [tenantA]
      );
      const opId = ops.rows[0]!.id;

      const resp = await fetch(`${orchestratorUrl}/api/v1/operations/${opId}/result`, {
        headers: {
          'x-api-key': apiKeyB,
        },
      });

      expect(resp.status).toBe(404);
      const err = (await resp.json()) as { code: string };
      expect(err.code).toBe('NOT_FOUND');
    });

    test('profile-bound authorization denial (PRF-01): key in profile mode without action binding gets 403', async () => {
      // apiKeyRestricted has bindings only for other-biz/other-action, not example-review/review
      const resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'x-api-key': apiKeyRestricted,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            input: {
              reviewId: 'rev-forbidden-1',
              artifacts: [
                {
                  artifactId: 'art-forbidden-1',
                  fileName: 'contract.pdf',
                },
              ],
            },
          }),
        }
      );

      expect(resp.status).toBe(403);
      const err = (await resp.json()) as { code: string; title?: string };
      expect(err.code).toBe('PERMISSION_DENIED');
      expect(err.title).toContain('not authorized for action review on example-review@1.0.0');
    });

    test('artifact blob access with invalid or cross-tenant grant is denied with 403', async () => {
      // Seed a test artifact for Tenant A
      const storageKey = `art-key-${randomUUID()}`;
      const validToken = `grant-token-${randomUUID()}`;
      await app!.db.query(
        `INSERT INTO artifacts (id, tenant_id, storage_key, token, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, 'application/pdf', 1024)`,
        [randomUUID(), tenantA, storageKey, validToken]
      );

      // Access with invalid / forged grant
      const resp = await fetch(
        `${orchestratorUrl}/api/runtime/v1/artifacts/blob/${storageKey}?grant=forged-or-tenant-b-token`
      );

      expect(resp.status).toBe(403);
      const err = (await resp.json()) as { code: string; title?: string };
      expect(err.code).toBe('PERMISSION_DENIED');
      expect(err.title).toBe('invalid artifact blob grant');
    });

    test('worker role substitution denied: runtime token cannot access admin routes (401)', async () => {
      const resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/example-review/versions/1.0.0/enable`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${runtimeToken}`,
            'content-type': 'application/json',
          },
        }
      );

      expect(resp.status).toBe(401);
      const err = (await resp.json()) as { code: string; title?: string };
      expect(err.code).toBe('UNAUTHENTICATED');
      expect(err.title).toBe('invalid admin bearer token');
    });

    test('worker role substitution denied: runtime token cannot access connector usage ingestion (403)', async () => {
      const resp = await fetch(
        `${orchestratorUrl}/api/runtime/v1/usage-events`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${runtimeToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            eventId: `evt-${randomUUID()}`,
            units: { inputTokens: 100, outputTokens: 50 },
            costMicrousd: 1500,
          }),
        }
      );

      expect(resp.status).toBe(403);
      const err = (await resp.json()) as { code: string; title?: string };
      expect(err.code).toBe('PERMISSION_DENIED');
      expect(err.title).toBe('usage ingestion requires connector identity');
    });

    test('missing api key fails closed on public action routes (401)', async () => {
      const resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            reviewId: 'rev-no-key',
          }),
        }
      );

      expect(resp.status).toBe(401);
      const err = (await resp.json()) as { code: string };
      expect(err.code).toBe('UNAUTHENTICATED');
    });
  });
});
