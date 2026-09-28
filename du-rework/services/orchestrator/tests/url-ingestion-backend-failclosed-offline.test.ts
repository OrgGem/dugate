import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createSubmissionService } from '../src/modules/operations/submission';
import type { ProfileService } from '../src/modules/profiles/profiles';
import type { RegistryService } from '../src/modules/registry/registry';

/**
 * W-INGEST-PG-FAILCLOSED-1 (Reviewer T180-D3): admission-time fail-
 * closed for URL submissions when the deployment has no s3-capable
 * private store behind the ingestion gate. The alternative this replaces
 * is the forever-undispatched PENDING_INGESTION row: the dispatcher
 * excludes gate-ingestion by design (cycle 9) and the consumer exists
 * only on the s3 backend (cycle 9 Δ13). Zero database statements may run
 * before the rejection - proof, not prose.
 */

const TENANT = '77000000-0000-4000-8000-000000000001';
const KEY = '78000000-0000-4000-8000-000000000001';
const OP = '79000000-0000-4000-8000-000000000001';
const SOURCE_URL = 'https://example.com/document.pdf';

function result<T extends QueryResultRow>(rows: QueryResultRow[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function makeDb(viewState: string) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(statement: string, params: unknown[] = []) => {
      calls.push({ sql: statement, params });
      if (/business_versions/i.test(statement)) {
        return result<T>([{ version: '1.0.0', manifest: { actions: [{ name: 'ingest', inputSchema: { type: 'object' } }], runtime: { handlerKinds: ['root'] } }, digest: 'sha256:test', queue: 'q' }]);
      }
      if (/FROM operations/i.test(statement)) {
        return result<T>([{ id: OP, tenant_id: TENANT, business_id: 'demo', business_version: '1.0.0', action: 'ingest', state: viewState, state_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deadline_at: null }]);
      }
      return result<T>([]);
    },
    tx: async <T>(fn: (client: unknown) => Promise<T>) => fn({
      query: async (statement: string, params: unknown[] = []) => {
        calls.push({ sql: statement, params });
        return result([]);
      },
    }),
    close: async () => undefined,
  } as unknown as Db;
  return { db, calls };
}

const profiles = { resolveBinding: async () => ({ mode: 'legacy' as const }) } as unknown as ProfileService;

function service(db: Db, storageBackend?: 'postgres' | 's3') {
  return createSubmissionService(db, {} as RegistryService, profiles,
    storageBackend === undefined ? {} : { storageBackend });
}

function submitArgs(sourceUrl?: string) {
  return {
    tenantId: TENANT,
    apiKeyId: KEY,
    businessId: 'demo',
    action: 'ingest',
    submission: sourceUrl === undefined
      ? { input: { text: 'inline only' } }
      : { input: { text: 'inline only' }, sourceUrl },
  };
}

function findCall(calls: Array<{ sql: string; params: unknown[] }>, pattern: RegExp) {
  return calls.find((call) => pattern.test(call.sql));
}

describe('W-INGEST-PG-FAILCLOSED-1 backend admission', () => {
  it('postgres backend + sourceUrl: 422 UNSUPPORTED_STORAGE_BACKEND with ZERO database calls', async () => {
    const { db, calls } = makeDb('PENDING_INGESTION');
    await expect(service(db, 'postgres').submit(submitArgs(SOURCE_URL)))
      .rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_STORAGE_BACKEND', message: 'URL ingestion requires an S3-compatible storage backend' });
    expect(calls).toHaveLength(0);
  });

  it('unwired backend (absent option): fails CLOSED the same way - no silent accept', async () => {
    const { db, calls } = makeDb('PENDING_INGESTION');
    await expect(service(db).submit(submitArgs(SOURCE_URL)))
      .rejects.toMatchObject({ status: 422, code: 'UNSUPPORTED_STORAGE_BACKEND' });
    expect(calls).toHaveLength(0);
  });

  it('s3 backend + sourceUrl: unchanged 202-path - PENDING_INGESTION rows + gate-ingestion outbox dispatch', async () => {
    const { db, calls } = makeDb('PENDING_INGESTION');
    const submitted = await service(db, 's3').submit(submitArgs(SOURCE_URL));
    expect(submitted.operation.state).toBe('PENDING_INGESTION');
    const opInsert = mustCall(findCall(calls, /INSERT INTO operations/i));
    expect(opInsert.params[6]).toBe('PENDING_INGESTION');
    const taskInsert = mustCall(findCall(calls, /INSERT INTO tasks/i));
    expect(taskInsert.params[4]).toBe('PENDING_INGESTION');
    const outboxInsert = mustCall(findCall(calls, /INSERT INTO outbox/i));
    const payload = JSON.parse(String(outboxInsert.params[2])) as Record<string, unknown>;
    expect(payload.gate).toBe('ingestion');
    expect(payload.sourceUrl).toBe(SOURCE_URL);
  });

  it('postgres backend + inline payload: fully unaffected - ACCEPTED/READY, no gate key', async () => {
    const { db, calls } = makeDb('ACCEPTED');
    const submitted = await service(db, 'postgres').submit(submitArgs(undefined));
    expect(submitted.operation.state).toBe('ACCEPTED');
    const opInsert = mustCall(findCall(calls, /INSERT INTO operations/i));
    expect(opInsert.params[6]).toBe('ACCEPTED');
    const taskInsert = mustCall(findCall(calls, /INSERT INTO tasks/i));
    expect(taskInsert.params[4]).toBe('READY');
    const outboxInsert = mustCall(findCall(calls, /INSERT INTO outbox/i));
    const payload = JSON.parse(String(outboxInsert.params[2])) as Record<string, unknown>;
    expect('gate' in payload).toBe(false);
    expect('sourceUrl' in payload).toBe(false);
  });
});

function mustCall<T>(value: T | undefined): NonNullable<T> {
  if (!value) throw new Error('required statement never ran');
  return value as NonNullable<T>;
}
