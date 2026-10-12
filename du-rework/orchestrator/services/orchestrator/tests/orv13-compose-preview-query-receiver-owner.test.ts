import type { AuditService } from '../src/modules/audit/audit';
import type { Db } from '../src/db/db';
import { createComposeOperationsService } from '../src/modules/compose-operations/service';

interface QueryClientFixture {
  calls: Array<{ sql: string; params: unknown[] }>;
  query(this: QueryClientFixture, sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

describe('UI13 Compose PoolClient query receiver', () => {
  test('creates a preview through a receiver-dependent transaction query method', async () => {
    const fixedNow = new Date('2026-10-11T18:00:00.000Z');
    const manifestDigest = 'a'.repeat(64);
    const project: Record<string, unknown> = {
      host_id: 'host-one',
      project_id: 'project-one',
      display_name: 'Project One',
      catalog_revision: 'b'.repeat(64),
      manifest_digest: manifestDigest,
      sampled_at: fixedNow.toISOString(),
      received_at: fixedNow.toISOString(),
      observed_digest: 'c'.repeat(64),
      services: [{ serviceId: 'api', displayName: 'API', restartAllowed: true }],
      releases: [],
      observed_services: [],
      target_revision: 0,
      desired_release_id: null,
      active_job_id: null,
      active_job_state: null,
    };
    let client!: QueryClientFixture;
    client = {
      calls: [],
      async query(sql, params = []) {
        if (this !== client) throw new Error('transaction query method lost its receiver');
        this.calls.push({ sql, params });
        if (sql.includes('FROM compose_project_snapshots p')) return { rows: [project], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      tx: async (fn: (poolClient: unknown) => Promise<unknown>) => fn(client),
      close: async () => undefined,
      pool: {},
    } as unknown as Db;
    const audit = { record: async () => undefined } as unknown as AuditService;
    const service = createComposeOperationsService(db, audit, {
      hostId: 'host-one',
      runnerToken: 'r'.repeat(32),
      manifestDigest,
      maxSampleAgeMs: 60_000,
      previewTtlMs: 120_000,
      claimTtlMs: 60_000,
    }, () => fixedNow);

    const preview = await service.createPreview({ actorLabel: 'admin-session' }, {
      hostId: 'host-one',
      projectId: 'project-one',
      action: 'restart_service',
      serviceId: 'api',
      reason: 'Create a receiver regression preview',
    });

    expect(preview).toMatchObject({ hostId: 'host-one', projectId: 'project-one', action: 'restart_service', serviceId: 'api' });
    expect(client.calls.some(({ sql }) => sql.includes('FROM compose_project_snapshots p'))).toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes('INSERT INTO compose_previews'))).toBe(true);
  });
});
