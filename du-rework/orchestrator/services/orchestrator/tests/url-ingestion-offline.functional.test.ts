import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService, markIngestionReady, validateSourceUrl } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';

const TENANT = '73000000-0000-4000-8000-000000000001';
const KEY = '74000000-0000-4000-8000-000000000001';
const OP = '75000000-0000-4000-8000-000000000001';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

describe('DATA-03 URL ingestion offline slice', () => {
  it.each(['https://example.com/document.pdf', 's3://customer-documents/invoices/document.pdf'])('accepts allowed source %s behind the ingestion gate', async (sourceUrl) => {
    const sql: string[] = [];
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(statement: string) => {
        sql.push(statement);
        if (/business_versions/i.test(statement)) {
          return result<T>([{ version: '1.0.0', manifest: { actions: [{ name: 'ingest', inputSchema: { type: 'object' } }], runtime: { handlerKinds: ['root'] } }, digest: 'sha256:test', queue: 'q' }]);
        }
        if (/FROM operations/i.test(statement)) {
          return result<T>([{ id: OP, tenant_id: TENANT, business_id: 'demo', business_version: '1.0.0', action: 'ingest', state: 'PENDING_INGESTION', state_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deadline_at: null }]);
        }
        return result<T>([]);
      },
      tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({
        query: async (statement: string) => { sql.push(statement); return result([]); },
      }),
      close: async () => undefined,
    } as unknown as Db;
    const profiles = { resolveBinding: async () => ({ mode: "legacy" as const }),
    resolveEffectiveProfile: async () => ({ mode: "legacy" as const }) } as unknown as ProfileService;
    // W-INGEST-PG-FAILCLOSED-1: the ingestion gate needs the s3 backend; this
    // suite documents the ACCEPTED-side behavior, so opt in.
    const service = createSubmissionService(db, {} as RegistryService, profiles, { storageBackend: 's3', s3SourceRules: [{ tenantId: TENANT, bucket: 'customer-documents', prefix: 'invoices/', region: 'ap-southeast-1', expectedBucketOwner: '123456789012' }] });

    const submitted = await service.submit({
      tenantId: TENANT,
      apiKeyId: KEY,
      businessId: 'demo',
      action: 'ingest',
      submission: { input: { url: 'source' }, sourceUrl },
    });

    expect(submitted.operation.state).toBe('PENDING_INGESTION');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.some((statement) => /INSERT INTO tasks/i.test(statement))).toBe(true);
  });

  it('rejects non-HTTPS and private destinations without making database calls', () => {
    expect(() => validateSourceUrl('http://127.0.0.1/private')).toThrow();
    expect(() => validateSourceUrl('https://user:pass@example.com/a')).toThrow();
  });

  it('opens the business task only after a pinned version and hash are supplied', async () => {
    const statements: string[] = [];
    const db = { tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({ query: async (statement: string) => { statements.push(statement); return result([]); } }) } as unknown as Db;
    await markIngestionReady(db, OP, { storageKey: 'du/tenants/t/connectors/c/accounts/a/source', versionId: 'v1', sha256: 'a'.repeat(64), sizeBytes: 10 }, { url: 'source' }, { deliveryId: '76000000-0000-4000-8000-000000000001', kind: 'root', correlationId: 'url-ingest-001' });
    expect(statements.some((statement) => /state='READY'/.test(statement))).toBe(true);
    expect(statements.some((statement) => /state='QUEUED'/.test(statement))).toBe(true);
  });
});
