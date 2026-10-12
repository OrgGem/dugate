import type { AuditService } from '../src/modules/audit/audit';
import type { Db } from '../src/db/db';
import { createComposeOperationsService } from '../src/modules/compose-operations/service';

describe('UI13 Compose runner claim query', () => {
  test('returns an empty claim and qualifies the job projection across the target-state join', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const executor = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      tx: async (fn: (client: typeof executor) => Promise<unknown>) => fn(executor),
      close: async () => undefined,
      pool: {},
    } as unknown as Db;
    const service = createComposeOperationsService(db, {} as AuditService, {
      hostId: 'host-one',
      runnerToken: 'r'.repeat(32),
      manifestDigest: 'a'.repeat(64),
      maxSampleAgeMs: 60_000,
      previewTtlMs: 120_000,
      claimTtlMs: 60_000,
    });

    await expect(service.claimNextJob()).resolves.toEqual({ claim: null });
    const claimQuery = calls.find(({ sql }) => sql.includes('JOIN compose_target_state t ON t.active_job_id=j.job_id'));
    expect(claimQuery).toBeDefined();
    expect(claimQuery!.sql).toContain('FROM compose_jobs j');
    const projection = claimQuery!.sql.slice('SELECT '.length, claimQuery!.sql.indexOf(' FROM compose_jobs'));
    expect(projection.split(',').every((column) => /^j\.[a-z_]+$/.test(column.trim()))).toBe(true);
    expect(claimQuery!.sql).toMatch(/WHERE j\.host_id=\$1 AND j\.state='QUEUED'/);
  });
});
