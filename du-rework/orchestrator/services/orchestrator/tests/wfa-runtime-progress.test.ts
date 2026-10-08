import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

function fixture(overrides: Record<string, unknown> = {}) {
  const row = {
    lease_epoch: 3, lease_active: true, state: 'RUNNING',
    operation_id: 'operation', task_key: 'root', business_id: 'document-core',
    op_state: 'RUNNING', cancel_requested: false, endpoint_slug: 'workflows:schema:example',
    ...overrides,
  };
  const query = jest.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters;
    return { rows: sql.trimStart().startsWith('SELECT') ? [row] : [], rowCount: 1 };
  });
  const client = { query } as unknown as PoolClient;
  const db = { tx: async <T>(fn: (connection: PoolClient) => Promise<T>) => fn(client) } as unknown as Db;
  return { runtime: createRuntimeService(db), query };
}

describe('WFA runtime progress projection', () => {
  it('projects bounded percent with a fixed label and preserves execution timestamps', async () => {
    const { runtime, query } = fixture();
    await runtime.reportProgress('task', { leaseEpoch: 3, percent: 42.8, message: 'secret-document-content' }, 'document-core');
    const update = query.mock.calls.find(([sql]) => sql.trimStart().startsWith('UPDATE'));
    expect(update).toBeDefined();
    expect(update![1]).toEqual(['operation', 42, 'Processing workflow...', 'task', 3]);
    expect(update![0]).not.toMatch(/execution_finished_at|updated_at|secret-document-content/);
    expect(update![0]).toContain("t.task_key='root'");
    expect(update![0]).toContain("o.state='RUNNING'");
    expect(update![0]).toContain('t.lease_expires_at > clock_timestamp()');
    expect(update![0]).toContain('NOT o.cancel_requested');
  });

  it.each([
    [{ lease_epoch: 2 }, 409],
    [{ lease_active: false }, 409],
    [{ business_id: 'other-business' }, 403],
    [{ state: 'SUCCEEDED' }, 410],
    [{ op_state: 'FAILED' }, 410],
  ])('refuses an unauthorized, stale or terminal report without a write: %j', async (overrides, status) => {
    const { runtime, query } = fixture(overrides);
    await expect(runtime.reportProgress('task', { leaseEpoch: 3, percent: 50 }, 'document-core')).rejects.toMatchObject({ status });
    expect(query.mock.calls.every(([sql]) => !sql.trimStart().startsWith('UPDATE'))).toBe(true);
  });

  it.each([{ task_key: 'branch:one' }, { cancel_requested: true }, { op_state: 'CANCEL_REQUESTED' }])(
    'does not let child or cancelled work overwrite root progress: %j', async (overrides) => {
      const { runtime, query } = fixture(overrides);
      await runtime.reportProgress('task', { leaseEpoch: 3, percent: 99 }, 'document-core');
      expect(query.mock.calls.every(([sql]) => !sql.trimStart().startsWith('UPDATE'))).toBe(true);
    },
  );

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid percent %s before database access', async (percent) => {
    const { runtime, query } = fixture();
    await expect(runtime.reportProgress('task', { leaseEpoch: 3, percent }, 'document-core')).rejects.toMatchObject({ status: 422 });
    expect(query).not.toHaveBeenCalled();
  });
});
