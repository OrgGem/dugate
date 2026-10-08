import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { loadMigrationFiles, migrate } from '../../orchestrator/services/orchestrator/src/db/migrations';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import {
  LegacyWorkflowSchemaCatalogError,
  provisionLegacyWorkflowSchema,
  resolveLegacyWorkflowSchema,
  retireLegacyWorkflowSchema,
} from '../../orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

const isolation = createWorkflowApiIsolation();
const metadataCrypto = createMetadataCrypto(
  adaptKeyProviderForMetadata(syntheticMetadataKeyProvider()),
  'du-orch-metadata-v1',
);
const migrationDirectory = `${__dirname}/../../orchestrator/services/orchestrator/migrations`;

function schema(slug: string, prompt: string) {
  return {
    slug,
    name: 'Synthetic schema catalog workflow',
    nodes: [{ id: 'request_input', type: 'input', key: 'reference' }],
    flow: ['request_input'],
    output: { from: 'request_input' },
    connector_prompt: prompt,
  };
}

describe('WFA fresh PostgreSQL workflow schema catalog', () => {
  const migrationFiles = loadMigrationFiles(migrationDirectory);
  const baseDb = createDb(isolation.baseDatabaseUrl);
  const scopedDb = createDb(isolation.databaseUrl);
  let tenantA = '';
  let tenantB = '';
  let schemaCreated = false;

  beforeAll(async () => {
    await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
    schemaCreated = true;
    const result = await migrate(scopedDb);
    expect(result.applied).toContain('0037_legacy_workflow_schema_catalog.sql');
    const tenantRows = await scopedDb.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id', ['WFA synthetic tenant A'],
    );
    tenantA = String(tenantRows.rows[0]?.id ?? '');
    const otherTenant = await scopedDb.query<{ id: string }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id', ['WFA synthetic tenant B'],
    );
    tenantB = String(otherTenant.rows[0]?.id ?? '');
  }, 120_000);

  afterAll(async () => {
    await scopedDb.close();
    if (schemaCreated) {
      await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
    }
    await baseDb.close();
    isolation.context.cleanupArtifactDir();
  }, 30_000);

  test('discovers WFA-03 migration and keeps revisions sealed, pinned, and tenant-fenced', async () => {
    expect(migrationFiles.some((file) => file.filename === '0037_legacy_workflow_schema_catalog.sql')).toBe(true);
    expect(tenantA).toMatch(/^[0-9a-f-]{36}$/i);
    expect(tenantB).toMatch(/^[0-9a-f-]{36}$/i);

    const first = await provisionLegacyWorkflowSchema(
      scopedDb,
      { tenantId: tenantA, schema: schema('wfa-review', 'synthetic-inline-auth-secret-v1') },
      metadataCrypto,
    );
    const second = await provisionLegacyWorkflowSchema(
      scopedDb,
      { tenantId: tenantA, schema: schema('wfa-review', 'synthetic-inline-auth-secret-v2'), expectedRevision: 1 },
      metadataCrypto,
    );
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(first.schema.connector_prompt).toBe('synthetic-inline-auth-secret-v1');
    expect(second.schema.connector_prompt).toBe('synthetic-inline-auth-secret-v2');

    const stored = await scopedDb.query<{ schema_ref: unknown; status: string }>(
      'SELECT schema_ref, status FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 ORDER BY revision',
      [tenantA, 'wfa-review'],
    );
    expect(stored.rows.map((row) => row.status)).toEqual(['retired', 'active']);
    expect(JSON.stringify(stored.rows.map((row) => row.schema_ref))).not.toContain('synthetic-inline-auth-secret');

    await expect(resolveLegacyWorkflowSchema(scopedDb, { tenantId: tenantA, slug: 'wfa-review' }, metadataCrypto))
      .resolves.toMatchObject({ revision: 2, digest: second.digest, schema: second.schema });
    await expect(resolveLegacyWorkflowSchema(scopedDb, { tenantId: tenantB, slug: 'wfa-review' }, metadataCrypto))
      .resolves.toBeNull();
    await expect(resolveLegacyWorkflowSchema(scopedDb, { tenantId: tenantA, slug: 'missing' }, metadataCrypto))
      .resolves.toBeNull();
    await expect(provisionLegacyWorkflowSchema(
      scopedDb,
      { tenantId: tenantA, schema: schema('wfa-review', 'cas-conflict'), expectedRevision: 1 },
      metadataCrypto,
    )).rejects.toMatchObject({ code: 'SCHEMA_REVISION_CONFLICT' });
    expect(first.revision).toBe(1);
    expect(first.digest).not.toBe(second.digest);

    await expect(retireLegacyWorkflowSchema(
      scopedDb,
      { tenantId: tenantA, slug: 'wfa-review', expectedRevision: 2 },
    )).resolves.toBe(true);
    await expect(resolveLegacyWorkflowSchema(scopedDb, { tenantId: tenantA, slug: 'wfa-review' }, metadataCrypto))
      .rejects.toBeInstanceOf(LegacyWorkflowSchemaCatalogError);
    await expect(resolveLegacyWorkflowSchema(scopedDb, { tenantId: tenantA, slug: 'wfa-review' }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_NOT_ACTIVE' });
  }, 120_000);
});
