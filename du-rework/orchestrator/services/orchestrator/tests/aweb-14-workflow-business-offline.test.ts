import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import type { RouteContext } from '../src/http/route-context';
import type { AuditRecordInput } from '../src/modules/audit/audit';
import { handleAdminRoutes } from '../src/http/routes/admin';
import { listProfileWorkflows, setProfileWorkflowBinding } from '../src/modules/admin-read/profile-workflows';
import { listAdminWorkflows } from '../src/modules/admin-read/workflow-list';
import { matchProfilesRoute } from '../src/app/admin/bff/profiles';

type QueryCall = { sql: string; params: unknown[] };
type QueryHandler = (sql: string, params: unknown[]) => QueryResultRow[];

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function fakeDb(handler: QueryHandler, calls: QueryCall[] = []): Db {
  const query = async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> => {
    calls.push({ sql, params });
    return result(handler(sql.replace(/\s+/g, ' ').trim().toLowerCase(), params) as T[]);
  };
  return {
    pool: {} as Db['pool'],
    query,
    async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return fn({ query } as unknown as PoolClient);
    },
    async close() {},
  };
}

const identity = {
  tenantId: 'tenant-1',
  businessId: 'document-core',
  businessVersion: '1.1.0',
  profileName: 'default',
};

describe('AWEB-14 workflow ownership and profile selection', () => {
  it('ships an additive migration with nullable legacy ownership and profile bindings', () => {
    const migrationPath = resolve(__dirname, '../migrations/0040_workflow_business_profile_bindings.sql');
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS business_id text NULL');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS business_version text NULL');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS profile_workflow_bindings');
    expect(migration).toContain('PRIMARY KEY (profile_id, workflow_slug)');
  });

  it('filters the workflow catalog by tenant, business, and version in SQL', async () => {
    const calls: QueryCall[] = [];
    const db = fakeDb(() => [{
      tenant_id: identity.tenantId,
      business_id: identity.businessId,
      business_version: identity.businessVersion,
      slug: 'review-flow',
      revision: 3,
      digest: 'sha256:' + 'a'.repeat(64),
      status: 'active',
      created_at: '2026-10-10T00:00:00.000Z',
      schema_ref: {},
    }], calls);

    const items = await listAdminWorkflows(db, identity.tenantId, undefined, {
      businessId: identity.businessId,
      businessVersion: identity.businessVersion,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('tenant_id = $1 AND business_id = $2 AND business_version = $3');
    expect(calls[0]!.params).toEqual([identity.tenantId, identity.businessId, identity.businessVersion]);
    expect(items[0]).toMatchObject({
      tenantId: identity.tenantId,
      businessId: identity.businessId,
      businessVersion: identity.businessVersion,
      slug: 'review-flow',
      revision: 3,
    });
  });

  it('lists only owned workflow revisions and keeps a selected retired revision visible', async () => {
    const calls: QueryCall[] = [];
    const db = fakeDb((sql) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return [{ profile_id: 'profile-1', tenant_id: identity.tenantId }];
      }
      if (sql.startsWith('select w.slug')) {
        return [
          { slug: 'review-flow', revision: 3, status: 'active', enabled: false, created_at: new Date('2026-10-10T00:00:00Z') },
          { slug: 'review-flow', revision: 2, status: 'retired', enabled: true, created_at: new Date('2026-10-09T00:00:00Z') },
        ];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }, calls);

    const page = await listProfileWorkflows(db, identity);

    expect(page.items).toEqual([
      expect.objectContaining({ slug: 'review-flow', revision: 3, status: 'active', enabled: false }),
      expect.objectContaining({ slug: 'review-flow', revision: 2, status: 'retired', enabled: true }),
    ]);
    expect(calls[0]!.sql).toContain('n.tenant_id=$1 AND n.business_id=$2 AND n.business_version=$3');
    expect(calls[1]!.sql).toContain('w.tenant_id=$1 AND w.business_id=$2 AND w.business_version=$3');
    expect(calls[1]!.sql).toContain("w.status='active' OR EXISTS");
    expect(calls[1]!.params).toEqual([identity.tenantId, identity.businessId, identity.businessVersion, 'profile-1']);
  });

  it('writes an enabled selection only for an active workflow owned by the profile business', async () => {
    const calls: QueryCall[] = [];
    const db = fakeDb((sql) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return [{ profile_id: 'profile-1', tenant_id: identity.tenantId }];
      }
      if (sql.startsWith('select status from legacy_workflow_schemas')) return [{ status: 'active' }];
      return [];
    }, calls);

    await setProfileWorkflowBinding(
      { query: db.query } as unknown as PoolClient,
      identity,
      { workflowSlug: 'review-flow', workflowRevision: 3, enabled: true },
    );

    expect(calls).toHaveLength(3);
    expect(calls[1]!.sql).toContain('tenant_id=$1 AND business_id=$2 AND business_version=$3');
    expect(calls[1]!.params).toEqual([identity.tenantId, identity.businessId, identity.businessVersion, 'review-flow', 3]);
    expect(calls[2]!.sql).toContain('ON CONFLICT (profile_id, workflow_slug) DO UPDATE');
    expect(calls[2]!.params).toEqual(['profile-1', 'review-flow', 3, true]);
  });

  it('refuses to newly enable retired or foreign-business workflow revisions', async () => {
    const retired = fakeDb((sql) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return [{ profile_id: 'profile-1', tenant_id: identity.tenantId }];
      }
      if (sql.startsWith('select status from legacy_workflow_schemas')) return [{ status: 'retired' }];
      return [];
    });

    await expect(setProfileWorkflowBinding(
      { query: retired.query } as unknown as PoolClient,
      identity,
      { workflowSlug: 'review-flow', workflowRevision: 2, enabled: true },
    )).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_NOT_ACTIVE' });

    const foreign = fakeDb((sql) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return [{ profile_id: 'profile-1', tenant_id: identity.tenantId }];
      }
      if (sql.startsWith('select status from legacy_workflow_schemas')) return [];
      return [];
    });
    await expect(setProfileWorkflowBinding(
      { query: foreign.query } as unknown as PoolClient,
      identity,
      { workflowSlug: 'other-business-flow', workflowRevision: 1, enabled: true },
    )).rejects.toBeInstanceOf(HttpError);
  });

  it('does not bind a workflow revision owned by another business when its slug and revision match', async () => {
    const calls: QueryCall[] = [];
    const otherBusinessRows = [{
      tenant_id: identity.tenantId,
      business_id: 'another-business',
      business_version: identity.businessVersion,
      slug: 'review-flow',
      revision: 3,
      status: 'active',
    }];
    const db = fakeDb((sql, params) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return params[1] === identity.businessId && params[2] === identity.businessVersion
          ? [{ profile_id: 'profile-1', tenant_id: identity.tenantId }]
          : [];
      }
      if (sql.startsWith('select status from legacy_workflow_schemas')) {
        return otherBusinessRows
          .filter((row) => row.tenant_id === params[0]
            && row.business_id === params[1]
            && row.business_version === params[2]
            && row.slug === params[3]
            && row.revision === params[4])
          .map((row) => ({ status: row.status }));
      }
      return [];
    }, calls);

    await expect(setProfileWorkflowBinding(
      { query: db.query } as unknown as PoolClient,
      identity,
      { workflowSlug: 'review-flow', workflowRevision: 3, enabled: true },
    )).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.params).toEqual([
      identity.tenantId,
      identity.businessId,
      identity.businessVersion,
      identity.profileName,
    ]);
    expect(calls[1]!.sql).toContain('tenant_id=$1 AND business_id=$2 AND business_version=$3');
    expect(calls[1]!.params).toEqual([
      identity.tenantId,
      identity.businessId,
      identity.businessVersion,
      'review-flow',
      3,
    ]);
  });

  it('routes profile workflow reads and writes through the profile business tuple', () => {
    expect(matchProfilesRoute('/profiles/document-core/1.1.0/default/workflows')).toEqual({
      kind: 'workflows',
      businessId: 'document-core',
      businessVersion: '1.1.0',
      profileName: 'default',
    });
    expect(matchProfilesRoute('/profiles/document-core/1.1.0/default/workflows/attach')).toBeNull();
  });

  it('serves a tenant-fenced workflow list and audits profile workflow changes', async () => {
    const auditRows: AuditRecordInput[] = [];
    const calls: QueryCall[] = [];
    const handler: QueryHandler = (sql) => {
      if (sql.startsWith('select n.profile_id, n.tenant_id')) {
        return [{ profile_id: 'profile-1', tenant_id: identity.tenantId }];
      }
      if (sql.startsWith('select w.slug')) {
        return [{ slug: 'review-flow', revision: 3, status: 'active', enabled: false, created_at: new Date('2026-10-10T00:00:00Z') }];
      }
      if (sql.startsWith('select status from legacy_workflow_schemas')) return [{ status: 'active' }];
      return [];
    };
    const client = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return result(handler(sql.replace(/\s+/g, ' ').trim().toLowerCase(), params) as T[]);
      },
    };
    const db = {
      pool: {} as Db['pool'],
      query: client.query,
      async tx<T>(fn: (transactionClient: PoolClient) => Promise<T>): Promise<T> {
        return fn(client as unknown as PoolClient);
      },
      async close() {},
    };
    const ctx = (method: string, body: unknown): RouteContext => ({
      method,
      pathname: `/api/v1/admin/profiles/${identity.businessId}/${identity.businessVersion}/${identity.profileName}/workflows`,
      searchParams: new URLSearchParams(`tenantId=${identity.tenantId}`),
      headers: { authorization: 'Bearer admin-token' },
      config: { adminToken: 'admin-token' },
      body,
      correlationId: 'aweb14-correlation',
      db,
      audit: {
        record: async (entry: AuditRecordInput) => {
          auditRows.push(entry);
          return { id: `audit-${auditRows.length}` };
        },
      },
    } as unknown as RouteContext);

    const read = await handleAdminRoutes(ctx('GET', null));
    expect(read?.status).toBe(200);
    expect(read?.body).toMatchObject({ businessId: identity.businessId, businessVersion: identity.businessVersion, total: 1 });
    expect(calls[1]!.params).toEqual([identity.tenantId, identity.businessId, identity.businessVersion, 'profile-1']);

    const write = await handleAdminRoutes(ctx('POST', {
      workflowSlug: 'review-flow',
      workflowRevision: 3,
      enabled: true,
    }));
    expect(write?.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      tenantId: identity.tenantId,
      action: 'profile_workflow.set',
      resource: 'profile:profile-1/workflow:review-flow:3',
    });
  });
});
