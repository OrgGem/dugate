import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { handleAdminRoutes } from '../src/http/routes/admin';
import type { RouteContext } from '../src/http/route-context';
import { createRegistryService } from '../src/modules/registry/registry';
import { recordWorkerHeartbeat } from '../src/modules/runtime/worker-instances';
import { createSubmissionService } from '../src/modules/operations/submission';

const BUSINESS_ID = 'business-a';
const ADMIN_TOKEN = 'woc-business-lifecycle-admin-token';

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function manifest(displayName = 'Business A') {
  return {
    contractVersion: '1',
    businessId: BUSINESS_ID,
    version: '1.0.0',
    displayName,
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtime: { wireVersion: '1', handlerKinds: ['root'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: [{
      name: 'extract', displayName: 'Extract', inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      profileSchema: { type: 'object' }, artifactPolicy: { minFiles: 0, maxFiles: 1 },
      capabilities: { cancel: true, resume: true }, defaultLimits: {},
    }],
  };
}

describe('WOC-09/10 business registry lifecycle', () => {
  it('creates the logical root disabled in the same registration transaction and keeps digest replay immutable', async () => {
    const roots = new Map<string, { enabled: boolean; lifecycle_revision: number }>();
    const versions = new Map<string, { digest: string; status: string; manifest: unknown; created_at: Date }>();
    const statements: { sql: string; params: unknown[] }[] = [];
    const client = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/^INSERT INTO business_catalog/i.test(sql)) {
          const businessId = String(params[0]);
          if (!roots.has(businessId)) roots.set(businessId, { enabled: false, lifecycle_revision: 1 });
          return queryResult<T>([], 'INSERT');
        }
        if (/^SELECT business_id FROM business_catalog/i.test(sql)) {
          return queryResult<T>(roots.has(String(params[0])) ? [{ business_id: params[0] }] : []);
        }
        if (/^SELECT digest, status, manifest, created_at FROM business_versions/i.test(sql)) {
          const key = `${String(params[0])}@${String(params[1])}`;
          const row = versions.get(key);
          return queryResult<T>(row ? [row as unknown as QueryResultRow] : []);
        }
        if (/^INSERT INTO business_versions/i.test(sql)) {
          const key = `${String(params[0])}@${String(params[1])}`;
          versions.set(key, {
            digest: String(params[3]), status: 'REGISTERED_DISABLED',
            manifest: JSON.parse(String(params[2])) as unknown, created_at: new Date('2026-10-12T00:00:00.000Z'),
          });
          return queryResult<T>([], 'INSERT');
        }
        throw new Error(`unexpected registry SQL: ${sql}`);
      },
    };
    const db = { tx: async <T>(work: (transaction: never) => Promise<T>) => work(client as never) } as unknown as Db;
    const registry = createRegistryService(db);

    const first = await registry.registerVersion(manifest());
    const replay = await registry.registerVersion(manifest());
    expect(first).toMatchObject({ businessId: BUSINESS_ID, version: '1.0.0', created: true, replayed: false });
    expect(replay).toMatchObject({ created: false, replayed: true, digest: first.digest });
    expect(roots.get(BUSINESS_ID)).toEqual({ enabled: false, lifecycle_revision: 1 });
    expect(statements[0]).toMatchObject({
      sql: expect.stringContaining('INSERT INTO business_catalog (business_id, enabled) VALUES ($1, false)'),
      params: [BUSINESS_ID],
    });
    expect(statements[1]?.sql).toContain('FOR UPDATE');
    await expect(registry.registerVersion(manifest('Changed manifest')))
      .rejects.toMatchObject({ status: 409, code: 'MANIFEST_DIGEST_MISMATCH' });
  });

  it('uses persisted lifecycle revision as a strict enable/disable CAS and marks exact replay', async () => {
    const state = { enabled: false, lifecycle_revision: 4, activation_revision: 1 };
    const client = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
        if (/^SELECT enabled,lifecycle_revision,activation_revision/i.test(sql)) {
          return queryResult<T>(params[0] === BUSINESS_ID ? [{ ...state, submissions_paused: false, pre_drain_version: null }] : []);
        }
        if (/^UPDATE business_catalog/i.test(sql) && sql.includes('SET enabled=$2')) {
          state.enabled = Boolean(params[1]);
          state.lifecycle_revision += 1;
          return queryResult<T>([{ ...state }], 'UPDATE');
        }
        if (/^UPDATE business_catalog/i.test(sql) && sql.includes('SET activation_revision=activation_revision+1')) {
          state.activation_revision += 1;
          return queryResult<T>([{ activation_revision: state.activation_revision }], 'UPDATE');
        }
        if (/^SELECT version FROM business_versions/i.test(sql)) return queryResult<T>([]);
        if (/^INSERT INTO business_version_activation_events/i.test(sql)) return queryResult<T>([], 'INSERT');
        throw new Error(`unexpected lifecycle SQL: ${sql}`);
      },
    };
    const db = { tx: async <T>(work: (transaction: never) => Promise<T>) => work(client as never) } as unknown as Db;
    const registry = createRegistryService(db);

    await expect(registry.setBusinessEnabled(BUSINESS_ID, true, 4)).resolves.toEqual({
      businessId: BUSINESS_ID, enabled: true, lifecycleRevision: 5, replayed: false,
    });
    await expect(registry.setBusinessEnabled(BUSINESS_ID, true, 5)).resolves.toEqual({
      businessId: BUSINESS_ID, enabled: true, lifecycleRevision: 5, replayed: true,
    });
    await expect(registry.setBusinessEnabled(BUSINESS_ID, false, 4))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(registry.setBusinessEnabled('unknown-business', false, 1))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('audits only real business lifecycle changes and requires platform admin auth', async () => {
    const client = { query: jest.fn() };
    const db = { tx: async <T>(work: (transaction: never) => Promise<T>) => work(client as never) };
    const audit = { record: jest.fn(async () => ({ id: 'audit-1' })) };
    const registry = {
      setBusinessEnabled: jest.fn(async (businessId: string, enabled: boolean, revision: number) => ({
        businessId, enabled, lifecycleRevision: revision + (enabled ? 1 : 0), replayed: !enabled,
      })),
    };
    const ctx = {
      method: 'PUT', pathname: `/api/v1/admin/businesses/${BUSINESS_ID}/enabled`,
      searchParams: new URLSearchParams(), headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { enabled: true, expectedLifecycleRevision: 3 }, correlationId: 'woc-enable-audit-01',
      config: { adminToken: ADMIN_TOKEN }, db, audit, registry,
    } as unknown as RouteContext;

    await expect(handleAdminRoutes(ctx)).resolves.toMatchObject({
      status: 200,
      body: { businessId: BUSINESS_ID, enabled: true, lifecycleRevision: 4, replayed: false },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: null, action: 'business.enable', resource: `business:${BUSINESS_ID}`,
    }), client);

    registry.setBusinessEnabled.mockResolvedValueOnce({
      businessId: BUSINESS_ID, enabled: true, lifecycleRevision: 4, replayed: true,
    });
    await handleAdminRoutes(ctx);
    expect(audit.record).toHaveBeenCalledTimes(1);

    const unauthorized = { ...ctx, headers: { authorization: 'Bearer wrong' } } as RouteContext;
    await expect(handleAdminRoutes(unauthorized)).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an explicit heartbeat manifest digest that is not the registered digest', async () => {
    const calls: string[] = [];
    const client = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string) => {
        calls.push(sql);
        if (sql.includes('maintenance_backup_effect_gate')) return queryResult<T>([{ state: 'OPEN', fence_revision: 1 }]);
        if (sql.includes('FROM business_versions')) return queryResult<T>([{ digest: `sha256:${'a'.repeat(64)}` }]);
        return queryResult<T>([]);
      },
    };
    const db = { tx: async <T>(work: (transaction: never) => Promise<T>) => work(client as never) } as unknown as Db;
    await expect(recordWorkerHeartbeat(db, 'worker-1', {
      businessId: BUSINESS_ID, businessVersion: '1.0.0', imageDigest: 'sha256:image', capacity: 1,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
    })).rejects.toMatchObject({ status: 409, code: 'MANIFEST_DIGEST_MISMATCH' });
    expect(calls.some((sql) => sql.includes('FROM business_versions'))).toBe(true);
    const manifestRead = calls.find((sql) => sql.includes('FROM business_versions'))!;
    expect(manifestRead).not.toMatch(/FOR\s+(SHARE|UPDATE)/i);
    expect(calls.some((sql) => sql.includes('runtime_control_scopes'))).toBe(false);
  });

  it('rejects a fresh submission for a disabled business before opening the operation transaction', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const tx = jest.fn(async () => {
      throw new Error('disabled business submission must not enter the write transaction');
    });
    const db = {
      query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/FROM artifacts a/i.test(sql)) return queryResult<T>([]);
        if (/SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog/i.test(sql)) {
          return queryResult<T>([{ enabled: false, activation_revision: 1, submissions_paused: false, pre_drain_version: null }]);
        }
        throw new Error(`unexpected disabled-submit SQL: ${sql}`);
      },
      tx,
    } as unknown as Db;
    const submission = createSubmissionService(db, {} as never, {} as never);

    await expect(submission.submit({
      tenantId: 'tenant-a',
      apiKeyId: 'key-a',
      businessId: BUSINESS_ID,
      action: 'extract',
      correlationId: 'woc-disabled-submit',
      submission: { input: {} },
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    expect(queries.some(({ sql }) => /SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog/i.test(sql))).toBe(true);
    expect(queries.some(({ sql }) => /FROM business_versions/i.test(sql))).toBe(false);
    expect(tx).not.toHaveBeenCalled();
  });
});
