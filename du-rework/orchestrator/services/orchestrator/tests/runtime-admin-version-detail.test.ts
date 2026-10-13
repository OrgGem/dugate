import type { Db } from '../src/db/db';
import type { RouteContext } from '../src/http/route-context';
import { handleAdminRoutes } from '../src/http/routes/admin';

describe('admin business version work visibility', () => {
  it('returns task-based parked and draining counts per version without counting outbox retries', async () => {
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        const sql = text.replace(/\s+/g, ' ').trim();
        queries.push(sql);
        if (sql.startsWith('SELECT business_id, version, status')) {
          return {
            rows: [{ business_id: 'biz', version: '1.0.0', status: 'ENABLED', is_active: false,
              digest: 'sha256:test', queue: 'queue-v1', created_at: new Date('2026-10-01T00:00:00Z'),
              updated_at: new Date('2026-10-02T00:00:00Z'), created_at_cursor: '2026-10-01T00:00:00.000000Z',
              updated_at_cursor: '2026-10-02T00:00:00.000000Z', admission_eligible: false,
              admission_reason: 'VERSION_NOT_ACTIVE' }],
            rowCount: 1,
          };
        }
        if (sql.startsWith('SELECT count(*)::int AS total')) return { rows: [{ total: 1, active_version: '2.0.0' }], rowCount: 1 };
        if (sql.startsWith('SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog')) {
          return { rows: [{ enabled: true, activation_revision: 7, submissions_paused: false,
            pre_drain_version: null }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT version,status,is_active FROM business_versions')) {
          return { rows: [{ version: '2.0.0', status: 'ENABLED', is_active: true }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT lifecycle_revision FROM business_catalog')) return { rows: [{ lifecycle_revision: 4 }], rowCount: 1 };
        if (sql.startsWith('WITH task_counts AS')) {
          return { rows: [{ business_version: '1.0.0', parked_task_count: 3, draining_task_count: 2,
            parked_reasons: { VERSION_NOT_ACTIVE: 2, BUSINESS_DISABLED: 1 } }], rowCount: 1 };
        }
        throw new Error(`Unexpected admin version detail SQL: ${sql}`);
      },
    };
    const db = {
      query: client.query,
      tx: async <T>(fn: (activeClient: typeof client) => Promise<T>) => fn(client),
    } as unknown as Db;
    const routeContext = {
      ingressAudience: 'admin',
      method: 'GET',
      pathname: '/api/v1/admin/businesses/biz/versions',
      searchParams: new URLSearchParams(),
      headers: { authorization: 'Bearer admin-token' },
      body: null,
      rawBody: Buffer.alloc(0),
      correlationId: 'corr-admin-versions',
      host: 'localhost',
      db,
      config: { adminToken: 'admin-token' },
    } as unknown as RouteContext;

    const response = await handleAdminRoutes(routeContext);
    const body = response?.body as { rows: Array<Record<string, unknown>>; items: Array<Record<string, unknown>> };

    expect(body.rows[0]).toMatchObject({
      version: '1.0.0',
      parkedTaskCount: 3,
      drainingTaskCount: 2,
      parkedReasons: { VERSION_NOT_ACTIVE: 2, BUSINESS_DISABLED: 1 },
    });
    expect(body.items[0]).toMatchObject(body.rows[0]!);
    expect(queries.find((sql) => sql.startsWith('WITH task_counts AS'))).toContain('FROM tasks t JOIN operations o');
    expect(queries.find((sql) => sql.startsWith('WITH task_counts AS'))).not.toContain('JOIN outbox');
  });
});
