import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import { VaultTransitProvider } from '../src/modules/encryption/vault-transit-provider';
import { createMetadataCrypto, type MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import {
  resolveLegacyWorkflowSchema,
  type LegacyWorkflowSchemaCatalogError,
} from '../src/modules/workflow-schemas/workflow-schemas';
import {
  runWorkflowSchemaBackfill,
  selectLatestWorkflowSchemaCandidates,
  type LegacyWorkflowSchemaSourceReader,
  type LegacyWorkflowSchemaSettingIndex,
} from '../src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter';

interface TenantRow {
  readonly id: string;
  readonly name: string;
}

interface CatalogRow {
  readonly tenant_id: string;
  readonly slug: string;
  readonly revision: number;
  readonly digest: string;
  schema_ref: unknown;
  status: 'active' | 'retired';
}

interface BackfillDb extends Db {
  readonly tenants: TenantRow[];
  readonly schemaRows: CatalogRow[];
  raceOnSlug: string | null;
}

function transitMetadataCrypto(): { readonly metadataCrypto: MetadataCrypto; readonly requests: () => number } {
  const masterKey = Buffer.alloc(32, 0x4b);
  let requestCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestCount += 1;
    if (typeof init?.body !== 'string') throw new Error('expected a Transit request body');
    const payload = JSON.parse(init.body) as { plaintext?: string; ciphertext?: string };
    const operation = new URL(String(input)).pathname.split('/').filter(Boolean)[2];
    if (operation === 'encrypt' && typeof payload.plaintext === 'string') {
      const dek = Buffer.from(payload.plaintext, 'base64');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      const wrapped = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
      return new Response(JSON.stringify({ data: { ciphertext: 'vault:v1:' + wrapped } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (operation === 'decrypt' && typeof payload.ciphertext === 'string') {
      const encoded = payload.ciphertext.slice('vault:v1:'.length);
      const wrapped = Buffer.from(encoded, 'base64url');
      const nonce = wrapped.subarray(0, 12);
      const tag = wrapped.subarray(12, 28);
      const ciphertext = wrapped.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
      decipher.setAuthTag(tag);
      const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return new Response(JSON.stringify({ data: { plaintext: dek.toString('base64') } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ errors: ['unsupported local Transit operation'] }), { status: 400 });
  };
  const provider = new VaultTransitProvider({
    vaultAddress: 'http://127.0.0.1:8200',
    allowedKeyRefs: { 'workflow-catalog-key': 'metadata-workflow-schema' },
    encryptIdentity: { token: () => 'offline-encrypt-identity' },
    decryptIdentity: { token: () => 'offline-decrypt-identity' },
    fetchImpl,
  });
  return {
    metadataCrypto: createMetadataCrypto(
      adaptKeyProviderForMetadata(provider),
      'workflow-catalog-key',
    ),
    requests: () => requestCount,
  };
}

function fakeDb(): BackfillDb {
  const tenants: TenantRow[] = [];
  const schemaRows: CatalogRow[] = [];
  const database: BackfillDb = {
    tenants,
    schemaRows,
    raceOnSlug: null,
    pool: {} as Db['pool'],
    async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
      return run<T>(sql, params);
    },
    async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return fn({ query: run } as unknown as PoolClient);
    },
    async close() {},
  };

  async function run<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const rows: QueryResultRow[] = [];
    let rowCount = 0;
    let command = 'SELECT';

    if (normalized.startsWith('select pg_advisory_xact_lock')) {
      const slug = String(params[1] ?? '');
      if (database.raceOnSlug === slug) {
        schemaRows.push({
          tenant_id: String(params[0]),
          slug,
          revision: 1,
          digest: 'sha256:' + 'a'.repeat(64),
          schema_ref: { legacy: true },
          status: 'active',
        });
        database.raceOnSlug = null;
      }
      rowCount = 1;
    } else if (normalized.startsWith('select id from tenants where name = $1')) {
      for (const tenant of tenants) {
        if (tenant.name === params[0]) rows.push({ id: tenant.id });
      }
      rowCount = rows.length;
    } else if (normalized.startsWith('insert into tenants (name) values ($1)')) {
      tenants.push({ id: randomUUID(), name: String(params[0]) });
      command = 'INSERT';
      rowCount = 1;
    } else if (normalized.startsWith('select max(revision)::int as revision')) {
      const matching = schemaRows.filter((row) => row.tenant_id === params[0] && row.slug === params[1]);
      rows.push({ revision: matching.length ? Math.max(...matching.map((row) => row.revision)) : null });
      rowCount = 1;
    } else if (normalized.startsWith('select revision from legacy_workflow_schemas where')) {
      const activeOnly = /status\s*=\s*'active'/.test(normalized);
      const matching = schemaRows.find((row) => row.tenant_id === params[0]
        && row.slug === params[1]
        && (!activeOnly || row.status === 'active'));
      if (matching) rows.push({ revision: matching.revision });
      rowCount = rows.length;
    } else if (normalized.startsWith('select tenant_id, slug, revision, digest, schema_ref, status from legacy_workflow_schemas')) {
      const activeOnly = /status\s*=\s*'active'/.test(normalized);
      const matching = schemaRows.find((row) => row.tenant_id === params[0]
        && row.slug === params[1]
        && (!activeOnly || row.status === 'active')
        && (params[2] === undefined || row.revision === Number(params[2])));
      if (matching) rows.push({ ...matching });
      rowCount = rows.length;
    } else if (normalized.startsWith('update legacy_workflow_schemas set status=')) {
      const revision = params[2] === undefined ? undefined : Number(params[2]);
      for (const row of schemaRows) {
        if (row.tenant_id === params[0] && row.slug === params[1] && row.status === 'active'
          && (revision === undefined || row.revision === revision)) {
          row.status = 'retired';
          rowCount += 1;
        }
      }
      command = 'UPDATE';
    } else if (normalized.startsWith('insert into legacy_workflow_schemas')) {
      const [tenantId, slug, revision, digest, sealed] = params;
      if (schemaRows.some((row) => row.tenant_id === tenantId && row.slug === slug
        && (row.status === 'active' || row.revision === Number(revision)))) {
        throw new Error('fake catalog uniqueness constraint failed');
      }
      schemaRows.push({
        tenant_id: String(tenantId),
        slug: String(slug),
        revision: Number(revision),
        digest: String(digest),
        schema_ref: JSON.parse(String(sealed)) as unknown,
        status: 'active',
      });
      command = 'INSERT';
      rowCount = 1;
    } else {
      throw new Error('unhandled fake database query: ' + normalized);
    }

    return { rows: rows as T[], rowCount, command, oid: 0, fields: [] };
  }

  return database;
}

class MemoryWorkflowSource implements LegacyWorkflowSchemaSourceReader {
  private readonly index: readonly LegacyWorkflowSchemaSettingIndex[];
  private readonly values: ReadonlyMap<string, string>;

  public constructor(schemas: readonly unknown[], updatedAt = new Date('2026-10-09T00:00:00.000Z')) {
    const entries = schemas.map((schema) => {
      const slug = (schema as { slug: string }).slug;
      const key = 'wb_schema:' + slug;
      return { key, updatedAt, value: JSON.stringify(schema) };
    });
    this.index = entries.map(({ key, updatedAt: timestamp }) => ({ key, updatedAt: timestamp }));
    this.values = new Map(entries.map(({ key, value }) => [key, value]));
  }

  public async listAppSettings(): Promise<readonly LegacyWorkflowSchemaSettingIndex[]> {
    return this.index;
  }

  public async readAppSettingValue(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
}

function connectorSchema(slug: string): unknown {
  return {
    slug,
    name: 'Offline connector workflow',
    nodes: [{
      id: 'extract',
      type: 'connector',
      connector: 'document.extractor',
      overrideConnector: { prompt: 'offline private prompt' },
    }],
    flow: ['extract'],
    output: { from: 'extract' },
  };
}

function staticEgressSchema(slug: string): unknown {
  return {
    slug,
    name: 'Offline static egress workflow',
    nodes: [{
      id: 'fanout',
      type: 'parallel',
      branches: [
        [{
          id: 'download',
          type: 'file_url_download',
          urls: ['https://files.example.test/document.pdf'],
          auth: { type: 'none' },
        }],
        [{
          id: 'notify',
          type: 'callback',
          url: 'https://hooks.example.test/complete',
          auth: { type: 'none' },
        }],
      ],
    }],
    flow: ['fanout'],
    output: { from: 'fanout' },
  };
}

function callbackSchema(slug: string, url: string): unknown {
  return {
    slug,
    name: 'Offline callback workflow',
    nodes: [{ id: 'notify', type: 'callback', url, auth: { type: 'none' } }],
    flow: ['notify'],
    output: { from: 'notify' },
  };
}

describe('LDBA-06 R4 workflow schema backfill adapter', () => {
  it('round-trips a connector schema through the production writer and reader', async () => {
    const db = fakeDb();
    const transit = transitMetadataCrypto();
    const schema = connectorSchema('legacy-connector-flow');
    const report = await runWorkflowSchemaBackfill({
      source: new MemoryWorkflowSource([schema]),
      sink: db,
      metadataCrypto: transit.metadataCrypto,
      apply: true,
    });

    expect(report.status).toBe('COMPLETED');
    expect(report.tenantStatus).toBe('seeded');
    expect(report.tenantId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(report.written).toHaveLength(1);
    expect(report.written[0]).toMatchObject({
      sourceKey: 'wb_schema:legacy-connector-flow',
      slug: 'legacy-connector-flow',
      revision: 1,
      status: 'active',
      approvedEgressOrigins: [],
    });
    expect(db.tenants).toEqual([{ id: report.tenantId, name: 'legacy-default' }]);
    expect(db.schemaRows).toHaveLength(1);
    expect(db.schemaRows[0]?.schema_ref).toMatchObject({ algorithm: 'aes-256-gcm' });
    expect(JSON.stringify(db.schemaRows[0]?.schema_ref)).not.toContain('offline private prompt');

    const pin = await resolveLegacyWorkflowSchema(db, {
      tenantId: report.tenantId as string,
      slug: 'legacy-connector-flow',
    }, transit.metadataCrypto);
    expect(pin?.connectorSlotMap).toEqual({ 'document.extractor': 'legacy-connector-00' });
    expect(pin?.schema).toEqual(schema);
    expect(transit.requests()).toBeGreaterThan(1);
  });

  it('derives and round-trips static HTTPS origins inside parallel branches', async () => {
    const db = fakeDb();
    const transit = transitMetadataCrypto();
    const report = await runWorkflowSchemaBackfill({
      source: new MemoryWorkflowSource([staticEgressSchema('legacy-static-egress')]),
      sink: db,
      metadataCrypto: transit.metadataCrypto,
      apply: true,
    });

    expect(report.skipped).toEqual([]);
    expect(report.written[0]?.approvedEgressOrigins).toEqual([
      'https://files.example.test',
      'https://hooks.example.test',
    ]);
    const pin = await resolveLegacyWorkflowSchema(db, {
      tenantId: report.tenantId as string,
      slug: 'legacy-static-egress',
    }, transit.metadataCrypto);
    expect(pin?.approvedEgressOrigins).toEqual(report.written[0]?.approvedEgressOrigins);
    expect(pin?.schema.nodes[0]?.type).toBe('parallel');
  });

  it('skips dynamic, non-HTTPS and userinfo egress with a reason and writes no row', async () => {
    const cases = [
      { slug: 'legacy-dynamic-egress', url: '$input.callback_url', reason: 'DYNAMIC_EGRESS_URL' },
      { slug: 'legacy-http-egress', url: 'http://hooks.example.test/complete', reason: 'NON_HTTPS_EGRESS_URL' },
      { slug: 'legacy-userinfo-egress', url: 'https://user:secret@hooks.example.test/complete', reason: 'EGRESS_URL_USERINFO' },
      { slug: 'legacy-fragment-egress', url: 'https://hooks.example.test/complete#fragment', reason: 'INVALID_EGRESS_URL' },
    ] as const;

    for (const item of cases) {
      const db = fakeDb();
      const transit = transitMetadataCrypto();
      const report = await runWorkflowSchemaBackfill({
        source: new MemoryWorkflowSource([callbackSchema(item.slug, item.url)]),
        sink: db,
        metadataCrypto: transit.metadataCrypto,
        apply: true,
      });
      expect(report.written).toEqual([]);
      expect(report.skipped).toMatchObject([{ slug: item.slug, reason: item.reason, nodeId: 'notify' }]);
      expect(db.schemaRows).toEqual([]);
    }
  });

  it('rejects an unsealed catalog row through the production reader', async () => {
    const db = fakeDb();
    const transit = transitMetadataCrypto();
    const tenantId = randomUUID();
    db.schemaRows.push({
      tenant_id: tenantId,
      slug: 'legacy-plaintext-row',
      revision: 1,
      digest: 'sha256:' + 'b'.repeat(64),
      schema_ref: connectorSchema('legacy-plaintext-row'),
      status: 'active',
    });

    await expect(resolveLegacyWorkflowSchema(db, {
      tenantId,
      slug: 'legacy-plaintext-row',
    }, transit.metadataCrypto)).rejects.toMatchObject({
      code: 'SCHEMA_CRYPTO_UNAVAILABLE',
    } satisfies Partial<LegacyWorkflowSchemaCatalogError>);
  });

  it('is idempotent on a second run and reports a writer compare-and-swap race as a skip', async () => {
    const db = fakeDb();
    const transit = transitMetadataCrypto();
    const schema = connectorSchema('legacy-idempotent-flow');
    const source = new MemoryWorkflowSource([schema]);
    const options = { source, sink: db, metadataCrypto: transit.metadataCrypto, apply: true };
    const first = await runWorkflowSchemaBackfill(options);
    const second = await runWorkflowSchemaBackfill(options);

    expect(first.written).toHaveLength(1);
    expect(second.written).toEqual([]);
    expect(second.skipped).toMatchObject([{ slug: 'legacy-idempotent-flow', reason: 'ACTIVE_ROW_EXISTS' }]);
    expect(db.schemaRows).toHaveLength(1);
    expect(db.schemaRows[0]?.revision).toBe(1);

    const raceDb = fakeDb();
    raceDb.tenants.push({ id: randomUUID(), name: 'legacy-default' });
    raceDb.raceOnSlug = 'legacy-race-flow';
    const race = await runWorkflowSchemaBackfill({
      source: new MemoryWorkflowSource([connectorSchema('legacy-race-flow')]),
      sink: raceDb,
      metadataCrypto: transit.metadataCrypto,
      apply: true,
    });
    expect(race.written).toEqual([]);
    expect(race.skipped).toMatchObject([{ slug: 'legacy-race-flow', reason: 'SCHEMA_REVISION_CONFLICT' }]);
  });

  it('matches tenant-name preflight, seed, and duplicate-name semantics', async () => {
    const transit = transitMetadataCrypto();
    const preflightDb = fakeDb();
    const pending = await runWorkflowSchemaBackfill({
      source: new MemoryWorkflowSource([connectorSchema('pending-flow')]),
      sink: preflightDb,
      metadataCrypto: transit.metadataCrypto,
      apply: false,
    });
    expect(pending.status).toBe('PREFLIGHT_TENANT_PENDING');
    expect(preflightDb.tenants).toEqual([]);
    expect(pending.tenantId).toBeNull();

    const duplicateDb = fakeDb();
    duplicateDb.tenants.push(
      { id: randomUUID(), name: 'legacy-default' },
      { id: randomUUID(), name: 'legacy-default' },
    );
    await expect(runWorkflowSchemaBackfill({
      source: new MemoryWorkflowSource([]),
      sink: duplicateDb,
      metadataCrypto: transit.metadataCrypto,
      apply: true,
    })).rejects.toMatchObject({ code: 'DUPLICATE_TENANT_NAME' });
  });

  it('chooses the greatest byte-order key for an updatedAt tie and lists every loser', () => {
    const timestamp = new Date('2026-10-09T00:00:00.000Z');
    const selected = selectLatestWorkflowSchemaCandidates([
      { key: 'wb_schema:legacyZ', slug: 'legacy', updatedAt: timestamp },
      { key: 'wb_schema:legacy_', slug: 'legacy', updatedAt: timestamp },
      { key: 'wb_schema:legacy-old', slug: 'legacy', updatedAt: new Date(timestamp.getTime() - 1) },
    ]);

    expect(selected.winners.map((candidate) => candidate.key)).toEqual(['wb_schema:legacy_']);
    expect(selected.losers).toEqual([
      expect.objectContaining({ key: 'wb_schema:legacyZ', reason: 'TIED_UPDATED_AT_LOWER_KEY' }),
      expect.objectContaining({ key: 'wb_schema:legacy-old', reason: 'OLDER_UPDATED_AT' }),
    ]);
  });
});
