import type { PoolClient } from 'pg';
import { retryOperation } from '../src/modules/operations/retry';

const tenantId = 'tenant-retry';
const operationId = 'op-retry-source';
const taskId = 'task-retry-source';

function makeRetryClient(input: {
  submissionsPaused?: boolean;
  activeVersion?: string | null;
  existingRetry?: boolean;
} = {}) {
  const op: Record<string, unknown> = {
    id: operationId,
    tenant_id: tenantId,
    api_key_id: 'key-retry',
    business_id: 'business-retry',
    business_version: '1.0.0',
    action: 'extract',
    state: 'FAILED',
    root_task_id: taskId,
    input_ref: { request: { q: 'pinned' } },
    submit_artifacts: [],
    prompt_overrides_ref: null,
  };
  const payload = { input: { q: 'pinned' } };
  const task = { id: taskId, payload_ref: payload, kind: 'root', max_attempts: 4 };
  const calls: string[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push(sql);
    if (sql.startsWith('SELECT * FROM operations WHERE id=$1')) return { rows: [op], rowCount: 1 };
    if (sql.includes('WHERE retry_of=$1')) {
      return input.existingRetry
        ? { rows: [{ id: 'op-retry-existing', state: 'RUNNING' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id, state, error_code FROM tasks WHERE operation_id=$1')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT * FROM tasks WHERE id=$1')) return { rows: [task], rowCount: 1 };
    if (sql.startsWith('SELECT k.name,k.spending_limit')) {
      return { rows: [{ name: 'key', spending_limit: '0', total_used: '0', tenant_id: tenantId }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT ue.event_id')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT payload FROM outbox')) return { rows: [{ payload: { priority: 5 } }], rowCount: 1 };
    if (sql.startsWith('SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog')) {
      return { rows: [{ enabled: true, activation_revision: 7, submissions_paused: input.submissionsPaused ?? false,
        pre_drain_version: input.submissionsPaused ? '1.0.0' : null }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT version,status,is_active FROM business_versions')) {
      const active = input.activeVersion === undefined ? '1.0.0' : input.activeVersion;
      const versions = active === null
        ? [{ version: '1.0.0', status: 'ENABLED', is_active: false }]
        : [{ version: active, status: 'ENABLED', is_active: true },
          ...(active === '1.0.0' ? [] : [{ version: '1.0.0', status: 'ENABLED', is_active: false }])];
      return { rows: versions, rowCount: versions.length };
    }
    if (sql.startsWith('INSERT INTO operations') || sql.startsWith('INSERT INTO tasks') || sql.startsWith('INSERT INTO outbox')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected retry SQL: ${sql}`);
  };
  return { client: { query } as unknown as PoolClient, calls };
}

describe('fresh operation retry admission', () => {
  it('allows an idempotent retry replay during pre-drain without creating another execution', async () => {
    const world = makeRetryClient({ submissionsPaused: true, existingRetry: true });

    await expect(retryOperation(world.client, operationId, tenantId)).resolves.toMatchObject({
      operationId: 'op-retry-existing', replayed: true,
    });
    expect(world.calls.some((sql) => sql.startsWith('SELECT enabled,activation_revision,submissions_paused'))).toBe(false);
    expect(world.calls.some((sql) => sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('rejects a fresh retry during pre-drain before operation or task locks and writes', async () => {
    const world = makeRetryClient({ submissionsPaused: true });

    await expect(retryOperation(world.client, operationId, tenantId)).rejects.toMatchObject({
      code: 'BUSINESS_SUBMISSIONS_PAUSED',
    });
    const rootLock = world.calls.findIndex((sql) => sql.startsWith('SELECT enabled,activation_revision,submissions_paused'));
    expect(rootLock).toBeGreaterThanOrEqual(0);
    expect(world.calls.slice(rootLock + 1).some((sql) => /FROM operations WHERE id=\$1 FOR UPDATE|FROM tasks WHERE id=\$1 FOR UPDATE|INSERT INTO/.test(sql))).toBe(false);
  });

  it('rejects a new retry pinned to an inactive version instead of silently migrating it', async () => {
    const world = makeRetryClient({ activeVersion: '2.0.0' });

    await expect(retryOperation(world.client, operationId, tenantId)).rejects.toMatchObject({
      code: 'VERSION_NOT_ACTIVE',
    });
    expect(world.calls.some((sql) => sql.startsWith('INSERT INTO operations'))).toBe(false);
  });

  it('locks the business root before operation/task locks and preserves the admitted version pin', async () => {
    const world = makeRetryClient();

    const result = await retryOperation(world.client, operationId, tenantId);

    expect(result).toMatchObject({ retryOf: operationId, replayed: false });
    const rootLock = world.calls.findIndex((sql) => sql.startsWith('SELECT enabled,activation_revision,submissions_paused'));
    const operationLock = world.calls.findIndex((sql) => sql.startsWith('SELECT * FROM operations WHERE id=$1 FOR UPDATE'));
    const taskLock = world.calls.findIndex((sql) => sql.startsWith('SELECT * FROM tasks WHERE id=$1 FOR UPDATE'));
    expect(rootLock).toBeGreaterThanOrEqual(0);
    expect(operationLock).toBeGreaterThan(rootLock);
    expect(taskLock).toBeGreaterThan(operationLock);
    const outboxInsert = world.calls.find((sql) => sql.startsWith('INSERT INTO outbox'));
    expect(outboxInsert).toBeDefined();
  });
});
