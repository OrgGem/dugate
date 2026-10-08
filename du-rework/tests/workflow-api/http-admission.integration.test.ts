import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import { provisionLegacyWorkflowSchema } from '../../orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

const isolation = createWorkflowApiIsolation();
const syntheticKeyProvider = syntheticMetadataKeyProvider();
const metadataCrypto = createMetadataCrypto(
  adaptKeyProviderForMetadata(syntheticKeyProvider),
  'du-orch-metadata-v1',
);
const baseDb = createDb(isolation.baseDatabaseUrl);
const runApiKey = `wfa-http-${randomUUID()}`;
const runApiKeyHash = createHash('sha256').update(runApiKey).digest('hex');
const inactiveApiKey = `wfa-http-inactive-${randomUUID()}`;
const inactiveApiKeyHash = createHash('sha256').update(inactiveApiKey).digest('hex');
const tenantId = randomUUID();
let app: App | undefined;
let baseUrl = '';
let isolatedSchemaCreated = false;

interface AdmissionCounts {
  operations: string;
  tasks: string;
  outbox: string;
  artifacts: string;
  submission_keys: string;
}

async function admissionCounts(): Promise<AdmissionCounts> {
  if (!app) throw new Error('HTTP application fixture is not running');
  const result = await app.db.query<AdmissionCounts>(
    `SELECT
       (SELECT count(*)::text FROM operations WHERE tenant_id=$1) AS operations,
       (SELECT count(*)::text FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS tasks,
       (SELECT count(*)::text FROM outbox b JOIN tasks t ON t.id=b.aggregate_id JOIN operations o ON o.id=t.operation_id WHERE o.tenant_id=$1) AS outbox,
       (SELECT count(*)::text FROM artifacts WHERE tenant_id=$1) AS artifacts,
       (SELECT count(*)::text FROM submission_keys WHERE tenant_id=$1) AS submission_keys`,
    [tenantId],
  );
  return result.rows[0]!;
}

function form(
  fields: Record<string, string>,
  files: readonly { field: string; name: string; content: string }[] = [],
): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  for (const file of files) {
    body.append(file.field, new File([file.content], file.name, { type: 'text/plain' }));
  }
  return body;
}

async function expectHttpStatus(response: Response, expectedStatus: number, label: string): Promise<void> {
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, received ${response.status}; response body: ${body}`);
  }
}

describe('WFA public HTTP admission boundaries', () => {
  beforeAll(async () => {
    await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
    isolatedSchemaCreated = true;
    const savedSeedFlag = process.env.DU_SEED_DEV_FALLBACK;
    process.env.DU_SEED_DEV_FALLBACK = 'false';
    try {
      app = await createApp({
        host: '127.0.0.1',
        port: 0,
        internalHost: '127.0.0.1',
        internalPort: 0,
        databaseUrl: isolation.databaseUrl,
        redisUrl: isolation.redisUrl,
        autoMigrate: true,
        autoDispatch: false,
        leaseRecoveryIntervalMs: 0,
        metadataEncryption: {
          keyProvider: syntheticKeyProvider,
          keyRef: 'du-orch-metadata-v1',
        },
      });
    } finally {
      if (savedSeedFlag === undefined) delete process.env.DU_SEED_DEV_FALLBACK;
      else process.env.DU_SEED_DEV_FALLBACK = savedSeedFlag;
    }
    const server = await app.listen();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Orchestrator did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    await app.db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'WFA synthetic HTTP tenant']);
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status) VALUES ($1, $2, 'wfa-http', 'ACTIVE')`,
      [tenantId, runApiKeyHash],
    );
    await app.db.query(
      `INSERT INTO api_keys (tenant_id, hash, prefix, status) VALUES ($1, $2, 'wfa-http-inactive', 'INACTIVE')`,
      [tenantId, inactiveApiKeyHash],
    );
    await provisionLegacyWorkflowSchema(
      app.db,
      {
        tenantId,
        schema: {
          slug: 'wfa-selector-sentinel',
          name: 'Synthetic selector sentinel',
          nodes: [{ id: 'reference', type: 'input', key: 'reference' }],
          flow: ['reference'],
          output: { from: 'reference' },
        },
      },
      metadataCrypto,
    );
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (isolatedSchemaCreated) {
      await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    }
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
  }, 30_000);

  test('rejects missing credentials before parsing and does not use an admin-key fallback', async () => {
    const before = await admissionCounts();
    const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      body: form({ schemaSlug: 'wfa-selector-sentinel', input: '[]' }),
    });
    await expectHttpStatus(response, 401, 'missing API key');
    expect(await admissionCounts()).toEqual(before);
  });

  test('rejects malformed and inactive API keys without falling back to another principal', async () => {
    const before = await admissionCounts();
    for (const key of ['not-a-real-key', inactiveApiKey]) {
      const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
        method: 'POST',
        headers: { 'x-api-key': key },
        body: form({ schemaSlug: 'wfa-selector-sentinel', input: '{}' }),
      });
      await expectHttpStatus(response, 401, key === inactiveApiKey ? 'inactive API key' : 'unknown API key');
    }
    expect(await admissionCounts()).toEqual(before);
  });

  test('rejects invalid schema JSON and mismatched apiKeyId without operation, artifact, outbox, or queue writes', async () => {
    const before = await admissionCounts();
    const invalidInput = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { 'x-api-key': runApiKey },
      body: form({ schemaSlug: 'wfa-selector-sentinel', input: '[]' }),
    });
    await expectHttpStatus(invalidInput, 400, 'non-object schema input');

    const mismatchedKey = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { 'x-api-key': runApiKey },
      body: form({ schemaSlug: 'wfa-selector-sentinel', input: '{}', apiKeyId: 'another-principal' }),
    });
    await expectHttpStatus(mismatchedKey, 403, 'mismatched body apiKeyId');
    expect(await admissionCounts()).toEqual(before);
  });

  test('keeps the multipart schemaSlug pinned over input and rejects unknown selectors before admission', async () => {
    const before = await admissionCounts();
    for (const fields of [
      { schemaSlug: 'not-imported', input: '{}' },
      { schemaSlug: 'not-imported', input: '{"schemaSlug":"wfa-selector-sentinel"}' },
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
        method: 'POST',
        headers: { 'x-api-key': runApiKey },
        body: form(fields),
      });
      await expectHttpStatus(response, 404, 'unknown schema selector');
    }
    expect(await admissionCounts()).toEqual(before);
  });

  test('rejects named selector and required-file errors before artifact or operation admission', async () => {
    const before = await admissionCounts();
    const cases = [
      { fields: {}, files: [] as const, status: 400, label: 'missing process' },
      { fields: { process: '   ' }, files: [] as const, status: 400, label: 'blank process' },
      { fields: { process: 'simple-extraction' }, files: [{ field: 'files[]', name: 'unknown.txt', content: 'bytes' }], status: 404, label: 'unknown pseudo process' },
      { fields: { process: 'disbursement' }, files: [] as const, status: 400, label: 'missing named file' },
      { fields: { process: 'lc-checker' }, files: [{ field: 'files[]', name: 'empty.txt', content: '' }], status: 400, label: 'zero-byte named file' },
    ];

    for (const item of cases) {
      const response = await fetch(`${baseUrl}/api/v1/docs/workflows`, {
        method: 'POST',
        headers: { 'x-api-key': runApiKey },
        body: form(item.fields, item.files),
      });
      await expectHttpStatus(response, item.status, item.label);
    }

    const missingSchemaSelector = await fetch(`${baseUrl}/api/v1/docs/workflows/schema`, {
      method: 'POST',
      headers: { 'x-api-key': runApiKey },
      body: form({ input: '{}' }),
    });
    await expectHttpStatus(missingSchemaSelector, 400, 'missing schemaSlug');
    expect(await admissionCounts()).toEqual(before);
  });
});
