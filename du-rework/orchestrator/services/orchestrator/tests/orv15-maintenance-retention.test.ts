import { createMaintenanceService } from '../src/modules/maintenance/maintenance-service';

const NOW = new Date('2026-10-13T00:00:00.000Z');
const POLICY = { revision: 4, cacheTtlHours: 24, outputRetentionDays: 30, cleanupIntervalSeconds: 3600 };

function maintenanceFixture(rows: Array<Record<string, unknown>> = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    return { rows: sql.includes('FROM artifacts a') ? rows : [], rowCount: sql.includes('FROM artifacts a') ? rows.length : 0 };
  });
  const tx = jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never));
  const service = createMaintenanceService({
    db: { query, tx } as never,
    audit: { record: jest.fn(async () => undefined) } as never,
    artifacts: { expireForMaintenance: jest.fn() },
    getEffectiveRetentionPolicy: async () => POLICY,
    backupSnapshotWriteGate: {} as never,
    now: () => new Date(NOW),
  });
  return { service, statements, query };
}

describe('ORV15 terminal artifact retention eligibility', () => {
  test('orders eligible rows before LIMIT and retains a newer caller cutoff only when it extends policy retention', async () => {
    const { service, statements } = maintenanceFixture([
      { id: 'artifact-safe', state: 'READY', safe_to_delete: true, reason_code: null, size_bytes: 20, storage_generation_id: 'g1' },
      { id: 'artifact-live', state: 'READY', safe_to_delete: false, reason_code: 'LIVE_TASKS_REMAIN', size_bytes: 30, storage_generation_id: 'g1' },
    ]);

    const preview = await service.createMaintenancePreview({ actor: 'admin' }, {
      kind: 'retention_cleanup',
      scope: { kind: 'platform' },
      filters: { maxItems: 2, olderThan: '2026-10-12T00:00:00.000Z' },
      reason: 'retain terminal artifacts after policy window',
    });

    const candidateQuery = statements.find(({ sql }) => sql.includes('FROM artifacts a'))!;
    expect(candidateQuery.sql).toMatch(/ORDER BY safe_to_delete DESC, a\.created_at ASC, a\.id ASC LIMIT \$2/);
    expect(candidateQuery.sql.indexOf('ORDER BY safe_to_delete')).toBeLessThan(candidateQuery.sql.indexOf('LIMIT $2'));
    expect(candidateQuery.params).toEqual(['2026-09-13T00:00:00.000Z', 2, null]);
    expect(preview.targets).toEqual([
      expect.objectContaining({ itemId: 'artifact-safe', eligibility: 'ELIGIBLE' }),
      expect.objectContaining({ itemId: 'artifact-live', eligibility: 'SKIPPED', reasonCode: 'LIVE_TASKS_REMAIN' }),
    ]);
    const persisted = statements.find(({ sql }) => sql.includes('INSERT INTO maintenance_previews'))!;
    const candidates = JSON.parse(String(persisted.params[8])) as Array<{ data: Record<string, unknown> }>;
    expect(candidates.map(({ data }) => data.retentionCutoff)).toEqual(['2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z']);
  });

  test('exposes terminal and reference retention blocks instead of silently removing lineage', async () => {
    const { service, statements } = maintenanceFixture([
      { id: 'artifact-reference', state: 'READY', safe_to_delete: false, reason_code: 'RESULT_REFERENCE_RETAINED', size_bytes: 20, storage_generation_id: 'g1' },
      { id: 'artifact-young', state: 'READY', safe_to_delete: false, reason_code: 'RETENTION_WINDOW_OPEN', size_bytes: 30, storage_generation_id: 'g1' },
    ]);

    const preview = await service.createMaintenancePreview({ actor: 'admin' }, {
      kind: 'retention_cleanup', scope: { kind: 'platform' }, filters: { maxItems: 10 },
      reason: 'review retained operation artifacts',
    });

    const sql = statements.find(({ sql: statement }) => statement.includes('FROM artifacts a'))!.sql;
    expect(sql).toContain("o.completed_at IS NULL THEN false");
    expect(sql).toContain("o.completed_at > $1::timestamptz THEN false");
    expect(sql).toContain("o.result_ref IS NOT NULL THEN false");
    expect(sql).toContain("THEN 'RESULT_REFERENCE_RETAINED'");
    expect(sql).toContain("THEN 'LIVE_TASKS_REMAIN'");
    expect(preview.targets).toEqual([
      expect.objectContaining({ eligibility: 'SKIPPED', reasonCode: 'RESULT_REFERENCE_RETAINED' }),
      expect.objectContaining({ eligibility: 'SKIPPED', reasonCode: 'RETENTION_WINDOW_OPEN' }),
    ]);
  });
});

describe('ORV15 retention expiry fence forwarding', () => {
  test('passes the preview policy revision and exact cutoff to the atomic artifact expiry owner', async () => {
    const cutoff = '2026-09-13T00:00:00.000Z';
    const item = {
      job_id: 'job-1', item_id: 'artifact-1', item_type: 'artifact', ordinal: 0,
      status: 'PENDING', code: null,
      evidence: JSON.stringify({ mode: 'retention', retentionCutoff: cutoff, storageGenerationId: 'generation-1' }),
      execution_fence: 0,
    };
    const claimed = { ...item, status: 'RUNNING', execution_fence: 1 };
    const job = {
      job_id: 'job-1', actor: 'admin', kind: 'retention_cleanup',
      config: JSON.stringify({
        request: { kind: 'retention_cleanup', scope: { kind: 'platform' }, filters: { maxItems: 1 } },
        retention: POLICY,
      }),
      state: 'QUEUED', scope_kind: 'platform', scope_id: 'all',
      created_at: NOW, updated_at: NOW, total_items: 1, completed_items: 0,
      applied_items: 0, skipped_items: 0, failed_items: 0, unknown_items: 0, last_error_code: null,
    };
    const calls: string[] = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (sql.includes('FROM artifacts a')) return { rows: [{
        id: 'artifact-1', state: 'READY', safe_to_delete: true, reason_code: null,
        size_bytes: 20, storage_generation_id: 'generation-1',
      }], rowCount: 1 };
      if (sql.includes('FROM maintenance_jobs WHERE job_id=$1')) return { rows: [job], rowCount: 1 };
      throw new Error(`Unhandled maintenance-runner SQL: ${sql}`);
    });
    let pending = true;
    const clientQuery = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT * FROM maintenance_jobs WHERE job_id=$1')) return { rows: [job], rowCount: 1 };
      if (sql.includes("UPDATE maintenance_job_items SET status='UNKNOWN'")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT * FROM maintenance_job_items WHERE job_id=$1 AND status='PENDING'")) {
        if (!pending) return { rows: [], rowCount: 0 };
        return { rows: [item], rowCount: 1 };
      }
      if (sql.includes("UPDATE maintenance_job_items SET status='RUNNING'")) {
        pending = false;
        return { rows: [claimed], rowCount: 1 };
      }
      if (sql.includes('SELECT count(*) FILTER(WHERE status=\'PENDING\')')) return { rows: [{
        pending: 0, running: 0, applied: 0, skipped: 1, failed: 0, unknown: 0, total: 1,
      }], rowCount: 1 };
      if (sql.includes('SELECT * FROM maintenance_job_items WHERE job_id=$1 ORDER BY ordinal')) {
        return { rows: [{ ...item, status: 'SKIPPED', code: 'RETENTION_POLICY_CHANGED' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const tx = jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query: clientQuery } as never));
    const expireForMaintenance = jest.fn(async () => ({ status: 'SKIPPED' as const, code: 'RETENTION_POLICY_CHANGED' }));
    const service = createMaintenanceService({
      db: { query, tx } as never,
      audit: { record: jest.fn(async () => undefined) } as never,
      artifacts: { expireForMaintenance },
      getEffectiveRetentionPolicy: async () => POLICY,
      backupSnapshotWriteGate: { assertWriteAllowed: jest.fn(async () => undefined) } as never,
      runnerRuntimeIdentity: 'maintenance-runner',
      now: () => new Date(NOW),
    });

    await service.runMaintenanceJob('job-1', { actor: 'admin' }, 'maintenance-runner', 1);

    expect(expireForMaintenance).toHaveBeenCalledWith('artifact-1', 'retention', {
      expectedRevision: POLICY.revision,
      cutoff,
    });
  });
});
