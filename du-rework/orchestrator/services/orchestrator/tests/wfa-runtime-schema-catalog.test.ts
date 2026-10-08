import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { contentHash } from '@du/contracts';
import type { Db } from '../src/db/db';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { createMetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import {
  LegacyWorkflowSchemaCatalogError,
  provisionLegacyWorkflowSchema,
  resolveLegacyWorkflowSchema,
  retireLegacyWorkflowSchema,
} from '../src/modules/workflow-schemas/workflow-schemas';

const XOR = 0x35;
const xor = (value: Uint8Array): Buffer => Buffer.from(Array.from(value, (byte) => byte ^ XOR));
const keyProvider: KeyProvider = {
  async wrapDek(input) {
    return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 1, ciphertext: xor(input.dek).toString('base64') };
  },
  async unwrapDek(value: WrappedDek) {
    return xor(Buffer.from(value.ciphertext, 'base64'));
  },
  async rewrap(value: WrappedDek, targetKeyVersion) {
    return { ...value, keyVersion: targetKeyVersion ?? value.keyVersion };
  },
};
const metadataCrypto = createMetadataCrypto(adaptKeyProviderForMetadata(keyProvider), 'synthetic-wfa-test-key');

type Row = {
  tenant_id: string;
  slug: string;
  revision: number;
  digest: string;
  schema_ref: unknown;
  status: 'active' | 'retired';
};

function dbHarness(): Db & { rows: Row[] } {
  const rows: Row[] = [];
  const run = async <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const resultRows: QueryResultRow[] = [];
    let rowCount = 0;
    if (normalized.startsWith('select pg_advisory_xact_lock')) {
      rowCount = 1;
    } else if (normalized.startsWith('select max(revision)')) {
      const matching = rows.filter((row) => row.tenant_id === params[0] && row.slug === params[1]);
      resultRows.push({ revision: matching.length ? Math.max(...matching.map((row) => row.revision)) : null });
      rowCount = 1;
    } else if (normalized.startsWith('select revision from legacy_workflow_schemas where tenant_id=$1 and slug=$2 and status=')) {
      const row = rows.find((entry) => entry.tenant_id === params[0] && entry.slug === params[1] && entry.status === 'active');
      if (row) resultRows.push({ revision: row.revision });
      rowCount = resultRows.length;
    } else if (normalized.startsWith('select revision from legacy_workflow_schemas where tenant_id=$1 and slug=$2 limit')) {
      const row = rows.find((entry) => entry.tenant_id === params[0] && entry.slug === params[1]);
      if (row) resultRows.push({ revision: row.revision });
      rowCount = resultRows.length;
    } else if (normalized.startsWith('select tenant_id, slug, revision, digest, schema_ref, status from legacy_workflow_schemas')) {
      const [tenantId, slug, revision] = params;
      const row = rows.find((entry) => entry.tenant_id === tenantId && entry.slug === slug
        && (revision === undefined ? entry.status === 'active' : entry.revision === revision));
      if (row) resultRows.push({ ...row });
      rowCount = resultRows.length;
    } else if (normalized.startsWith('update legacy_workflow_schemas set status=')) {
      const [tenantId, slug, revision] = params;
      for (const row of rows) {
        if (row.tenant_id === tenantId && row.slug === slug && row.status === 'active'
          && (revision === undefined || row.revision === revision)) {
          row.status = 'retired';
          rowCount += 1;
        }
      }
    } else if (normalized.startsWith('insert into legacy_workflow_schemas')) {
      const [tenantId, slug, revision, digest, sealed] = params;
      rows.push({ tenant_id: String(tenantId), slug: String(slug), revision: Number(revision), digest: String(digest),
        schema_ref: JSON.parse(String(sealed)), status: 'active' });
      rowCount = 1;
    } else {
      throw new Error(`unhandled SQL: ${normalized}`);
    }
    return { rows: resultRows as T[], rowCount, command: 'SELECT', oid: 0, fields: [] };
  };
  const client = { query: run } as unknown as PoolClient;
  return {
    rows,
    pool: {} as Db['pool'],
    query: run,
    async tx(fn) { return fn(client); },
    async close() {},
  };
}

function schema(slug: string, prompt: string) {
  return {
    slug,
    name: 'Sensitive workflow',
    input_schema: { type: 'object', properties: { note: { type: 'string', default: 'safe' } } },
    nodes: [{
      id: 'call', type: 'connector', connector: 'extractor',
      overrideConnector: { prompt, extraHeaders: '{"x-api-key":"synthetic-do-not-store"}' },
    }],
    flow: ['call'],
    output: { from: 'call' },
  };
}

describe('WFA-03 tenant workflow schema catalog', () => {
  it('seals immutable revisions and resolves only the selected tenant revision', async () => {
    const db = dbHarness();
    const first = await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: schema('doc-review', 'p1') }, metadataCrypto);
    const second = await provisionLegacyWorkflowSchema(db, {
      tenantId: 'tenant-a', schema: schema('doc-review', 'p2'), expectedRevision: 1,
    }, metadataCrypto);
    const otherTenant = await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-b', schema: schema('doc-review', 'other') }, metadataCrypto);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(otherTenant.revision).toBe(1);
    expect(db.rows.every((row) => typeof row.schema_ref === 'object')).toBe(true);
    expect(JSON.stringify(db.rows)).not.toContain('synthetic-do-not-store');
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'doc-review' }, metadataCrypto))
      .resolves.toMatchObject({ revision: 2, schema: { nodes: [{ overrideConnector: { prompt: 'p2' } }] } });
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'doc-review', revision: 1 }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_NOT_ACTIVE' });
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-b', slug: 'doc-review' }, metadataCrypto))
      .resolves.toMatchObject({ tenantId: 'tenant-b', revision: 1 });
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'missing' }, metadataCrypto)).resolves.toBeNull();
    expect(contentHash(first.schema)).toMatch(/^sha256:/);
  });

  it('rejects ciphertext copied across tenant, slug, or revision AAD identities', async () => {
    const db = dbHarness();
    await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: schema('alpha', 'a') }, metadataCrypto);
    await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: schema('beta', 'b') }, metadataCrypto);
    await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-b', schema: schema('alpha', 'c') }, metadataCrypto);
    const alphaA = db.rows.find((row) => row.tenant_id === 'tenant-a' && row.slug === 'alpha')!;
    const betaA = db.rows.find((row) => row.tenant_id === 'tenant-a' && row.slug === 'beta')!;
    const alphaB = db.rows.find((row) => row.tenant_id === 'tenant-b' && row.slug === 'alpha')!;
    betaA.schema_ref = alphaA.schema_ref;
    alphaB.schema_ref = alphaA.schema_ref;
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'beta' }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_CRYPTO_UNAVAILABLE' });
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-b', slug: 'alpha' }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_CRYPTO_UNAVAILABLE' });

    const revisionDb = dbHarness();
    await provisionLegacyWorkflowSchema(revisionDb, { tenantId: 'tenant-a', schema: schema('rev-test', 'r1') }, metadataCrypto);
    await provisionLegacyWorkflowSchema(revisionDb, { tenantId: 'tenant-a', schema: schema('rev-test', 'r2') }, metadataCrypto);
    const revision1 = revisionDb.rows.find((row) => row.revision === 1)!;
    const revision2 = revisionDb.rows.find((row) => row.revision === 2)!;
    revision2.schema_ref = revision1.schema_ref;
    revision2.status = 'active';
    revision1.status = 'retired';
    await expect(resolveLegacyWorkflowSchema(revisionDb, { tenantId: 'tenant-a', slug: 'rev-test' }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_CRYPTO_UNAVAILABLE' });
  });

  it('fails closed without encryption and does not publish invalid schema revisions', async () => {
    const db = dbHarness();
    await expect(provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: schema('valid', 'secret') }))
      .rejects.toMatchObject({ code: 'SCHEMA_CRYPTO_UNAVAILABLE' });
    await expect(provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: { ...schema('invalid', 'secret'), flow: ['missing'] } }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(db.rows).toHaveLength(0);

    await provisionLegacyWorkflowSchema(db, { tenantId: 'tenant-a', schema: schema('valid', 'secret') }, metadataCrypto);
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'valid' }))
      .rejects.toBeInstanceOf(LegacyWorkflowSchemaCatalogError);
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'valid' }))
      .rejects.toMatchObject({ code: 'SCHEMA_CRYPTO_UNAVAILABLE' });
    await expect(retireLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'valid', expectedRevision: 1 })).resolves.toBe(true);
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'valid' }, metadataCrypto))
      .rejects.toMatchObject({ code: 'SCHEMA_NOT_ACTIVE' });
    await expect(resolveLegacyWorkflowSchema(db, { tenantId: 'tenant-a', slug: 'valid', revision: 99 }, metadataCrypto)).resolves.toBeNull();
    await expect(provisionLegacyWorkflowSchema(db, {
      tenantId: 'tenant-a', schema: schema('valid', 'next'), expectedRevision: 1,
    }, metadataCrypto)).rejects.toMatchObject({ code: 'SCHEMA_REVISION_CONFLICT' });
  });
});
