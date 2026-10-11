import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import type { RouteContext } from '../src/http/route-context';
import { handleAdminRoutes } from '../src/http/routes/admin';

const PLATFORM_TOKEN = 'biz-11-platform-token';
const TENANT_A_TOKEN = 'biz-11-tenant-a-token';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const BUSINESS_ID = 'document-core';
const VERSION = '3.2.1';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Handler = (sql: string, params: unknown[]) => QueryResultRow[];

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function database(handler: Handler, calls: QueryCall[] = [], txCalls: string[] = []): Pick<Db, 'tx'> {
  const query = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ sql: normalized, params });
    return result(handler(normalized, params) as T[]);
  };
  return {
    tx: async <T>(fn: (client: PoolClient) => Promise<T>) => {
      txCalls.push('started');
      return fn({ query } as unknown as PoolClient);
    },
  };
}

function context(input: {
  search?: string;
  token?: string;
  businessId?: string;
  version?: string;
  handler: Handler;
  calls?: QueryCall[];
  txCalls?: string[];
}): RouteContext {
  const businessId = input.businessId ?? BUSINESS_ID;
  const version = input.version ?? VERSION;
  return {
    method: 'GET',
    pathname: `/api/v1/admin/businesses/${encodeURIComponent(businessId)}/versions/${encodeURIComponent(version)}/impact-preview`,
    searchParams: new URLSearchParams(input.search ?? `tenantId=${TENANT_A}&action=deactivate`),
    headers: { authorization: `Bearer ${input.token ?? PLATFORM_TOKEN}` },
    config: {
      adminToken: PLATFORM_TOKEN,
      tenantAdminTokens: { [TENANT_A_TOKEN]: TENANT_A },
    },
    db: database(input.handler, input.calls, input.txCalls) as Db,
  } as unknown as RouteContext;
}

function versionRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    status: 'ENABLED',
    is_active: true,
    active_version: VERSION,
    lifecycle_revision: '7',
    ...overrides,
  };
}

describe('BIZ-11 business version impact preview route', () => {
  test('returns tenant-owned workflow, worker, and profile impacts without secret fields', async () => {
    const calls: QueryCall[] = [];
    const txCalls: string[] = [];
    const response = await handleAdminRoutes(context({
      calls,
      txCalls,
      handler: (sql) => {
        if (sql.startsWith('set transaction')) return [];
        if (sql.startsWith('select bv.status')) return [versionRow()];
        if (sql.startsWith('select p.profile_id, p.revision')) {
          return [{
            profile_id: 'profile-a', revision: 2, action: 'extract', active_revision: true,
            created_at: new Date('2026-10-11T08:00:00.000Z'), total_count: 1,
            api_key_id: 'key-secret-sentinel', connector_bindings: { credential: 'secret-sentinel' },
          }];
        }
        if (sql.startsWith('select p.profile_id, pw.workflow_slug')) {
          return [{
            profile_id: 'profile-a', workflow_slug: 'review-flow', workflow_revision: 3,
            enabled: true, workflow_status: 'active', total_count: 1,
          }];
        }
        if (sql.startsWith('select wi.instance_id')) {
          return [{
            instance_id: 'worker-a', state: 'ONLINE', capacity: 8, active_leases: 2,
            last_seen_at: new Date('2026-10-11T08:01:00.000Z'),
            observed_at: new Date('2026-10-11T08:01:01.000Z'), total_count: 1,
          }];
        }
        throw new Error('unexpected SQL: ' + sql);
      },
    }));

    expect(response?.status).toBe(200);
    expect(response?.body).toMatchObject({
      tenantId: TENANT_A,
      businessId: BUSINESS_ID,
      version: VERSION,
      action: 'deactivate',
      status: 'ENABLED',
      isActive: true,
      activeVersion: VERSION,
      lifecycleRevision: '7',
      eligible: true,
      wouldChange: true,
      blockers: [],
      complete: true,
      profileBindings: {
        total: 1,
        truncated: false,
        items: [{ profileId: 'profile-a', revision: 2, action: 'extract', activeRevision: true }],
      },
      workflowBindings: {
        total: 1,
        truncated: false,
        items: [{
          profileId: 'profile-a', workflowSlug: 'review-flow', workflowRevision: 3,
          enabled: true, workflowStatus: 'active',
        }],
      },
      workerInstances: {
        total: 1,
        truncated: false,
        items: [{ instanceId: 'worker-a', state: 'ONLINE', capacity: 8, activeLeases: 2 }],
      },
    });
    expect(JSON.stringify(response?.body)).not.toContain('secret-sentinel');
    expect(txCalls).toEqual(['started']);
    expect(calls[0]!.sql).toBe('set transaction isolation level repeatable read read only');
    expect(calls[1]!.sql).toContain('bc.owner_tenant_id=$1 and bc.business_id=$2 and bv.version=$3');
    expect(calls[2]!.sql).toContain('p.tenant_id=$1 and p.business_version=$3');
    expect(calls[3]!.sql).toContain('p.tenant_id=$1 and p.business_version=$3');
    expect(calls[4]!.sql).toContain('bc.owner_tenant_id=$1 and bc.business_id=$2');
    expect(calls.slice(1).map((call) => call.params)).toEqual([
      [TENANT_A, BUSINESS_ID, VERSION],
      [TENANT_A, BUSINESS_ID, VERSION, 101],
      [TENANT_A, BUSINESS_ID, VERSION, 101],
      [TENANT_A, BUSINESS_ID, VERSION, 101],
    ]);
  });

  test('derives tenant operator scope from credentials and rejects a foreign tenant before SQL', async () => {
    const calls: QueryCall[] = [];
    const ownResponse = await handleAdminRoutes(context({
      token: TENANT_A_TOKEN,
      search: 'action=activate',
      calls,
      handler: (sql) => sql.startsWith('select bv.status') ? [versionRow({ is_active: false, active_version: null })] : [],
    }));
    expect(ownResponse?.status).toBe(200);
    expect(ownResponse?.body).toMatchObject({ tenantId: TENANT_A, action: 'activate', wouldChange: true });

    const foreignCalls: QueryCall[] = [];
    const foreignTx: string[] = [];
    await expect(handleAdminRoutes(context({
      token: TENANT_A_TOKEN,
      search: `tenantId=${TENANT_B}&action=activate`,
      calls: foreignCalls,
      txCalls: foreignTx,
      handler: () => [],
    }))).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(foreignCalls).toHaveLength(0);
    expect(foreignTx).toHaveLength(0);
  });

  test('hides unassigned, foreign-owned, and missing versions behind the same not-found response', async () => {
    const calls: QueryCall[] = [];
    const txCalls: string[] = [];
    await expect(handleAdminRoutes(context({
      calls,
      txCalls,
      handler: (sql) => sql.startsWith('select bv.status') ? [] : [],
    }))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain('from business_catalog bc');
    expect(calls[1]!.params).toEqual([TENANT_A, BUSINESS_ID, VERSION]);
  });

  test('requires an explicit tenant for platform requests and a closed action query', async () => {
    const noTenantCalls: QueryCall[] = [];
    await expect(handleAdminRoutes(context({
      search: 'action=activate',
      calls: noTenantCalls,
      handler: () => [],
    }))).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(noTenantCalls).toHaveLength(0);

    for (const search of [
      `tenantId=${TENANT_A}`,
      `tenantId=${TENANT_A}&action=enable`,
      `tenantId=${TENANT_A}&action=activate&action=deactivate`,
      `tenantId=${TENANT_A}&action=activate&unexpected=1`,
    ]) {
      await expect(handleAdminRoutes(context({ search, handler: () => [] })))
        .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    }
  });

  test('marks bounded dependency lists incomplete when a category exceeds the preview cap', async () => {
    const profileRows = Array.from({ length: 101 }, (_, index) => ({
      profile_id: `profile-${index}`,
      revision: 1,
      action: 'extract',
      active_revision: true,
      created_at: new Date('2026-10-11T08:00:00.000Z'),
      total_count: 101,
    }));
    const response = await handleAdminRoutes(context({
      handler: (sql) => {
        if (sql.startsWith('set transaction')) return [];
        if (sql.startsWith('select bv.status')) return [versionRow()];
        if (sql.startsWith('select p.profile_id, p.revision')) return profileRows;
        return [];
      },
    }));

    expect(response?.body).toMatchObject({
      complete: false,
      profileBindings: { total: 101, truncated: true },
      workflowBindings: { total: 0, truncated: false },
      workerInstances: { total: 0, truncated: false },
    });
    expect((response?.body as { profileBindings: { items: unknown[] } }).profileBindings.items).toHaveLength(100);
  });

  test('reports disabled versions as blocked and already completed actions as no-ops', async () => {
    const disabledResponse = await handleAdminRoutes(context({
      handler: (sql) => sql.startsWith('select bv.status') ? [versionRow({ status: 'REGISTERED_DISABLED', is_active: false, active_version: null })] : [],
    }));
    expect(disabledResponse?.body).toMatchObject({
      eligible: false,
      wouldChange: false,
      blockers: ['VERSION_NOT_ENABLED'],
    });

    const noOpResponse = await handleAdminRoutes(context({
      search: `tenantId=${TENANT_A}&action=activate`,
      handler: (sql) => sql.startsWith('select bv.status') ? [versionRow()] : [],
    }));
    expect(noOpResponse?.body).toMatchObject({ eligible: true, wouldChange: false, blockers: [] });
  });
});
