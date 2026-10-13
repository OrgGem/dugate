import { buildAdminOperationDetail, toOperationDetailWire } from '../src/modules/operations/mappers';
import { toOperationView } from '../src/modules/operations/facade';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('ORV15 operation progress and task graph visibility', () => {
  test('projects stored progress and clamps invalid database percentages safely', () => {
    const base = {
      id: OPERATION_ID,
      state: 'RUNNING',
      tenant_id: TENANT_ID,
      created_at: new Date('2026-10-13T00:00:00.000Z'),
      updated_at: new Date('2026-10-13T00:01:00.000Z'),
      progress_percent: '48',
      progress_message: 'Parsing pages',
    };
    expect(toOperationView(base).progress).toEqual({ percent: 48, message: 'Parsing pages' });
    expect(toOperationDetailWire({ ...base, progress_percent: 132, progress_message: null }).progress).toEqual({ percent: 100, message: 'RUNNING' });
  });

  test('projects task ancestry separately from parent child-join edges', async () => {
    const rows = [
      { id: 'task-parent', taskKey: 'split', kind: 'workflow', state: 'WAITING_CHILDREN', spawnedBy: null,
        leasedBy: 'worker-a', leaseExpiresAt: new Date('2026-10-13T00:02:00.000Z'), dueAt: null,
        attempt: 1, maxAttempts: 3, errorCode: null },
      { id: 'task-child', taskKey: 'validate', kind: 'validate', state: 'READY', spawnedBy: 'task-parent',
        leasedBy: null, leaseExpiresAt: null, dueAt: new Date('2026-10-13T00:03:00.000Z'),
        admissionParkedReason: 'VERSION_NOT_ACTIVE', admissionParkedAt: new Date('2026-10-13T00:02:30.000Z'),
        attempt: 2, maxAttempts: 5, errorCode: 'RETRYABLE_VALIDATION' },
    ];
    const db = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM tasks WHERE operation_id')) return { rows, rowCount: rows.length };
        if (sql.includes('FROM task_dependencies d')) return { rows: [{ parentId: 'task-parent', childId: 'task-child', joinPolicy: 'all-success' }], rowCount: 1 };
        if (sql.includes('FROM human_waits')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }),
    };
    const operation = {
      id: OPERATION_ID, tenant_id: TENANT_ID, business_id: 'document-core', business_version: '3.2.1',
      action: 'extract', state: 'RUNNING', state_version: 4,
      created_at: new Date('2026-10-13T00:00:00.000Z'), updated_at: new Date('2026-10-13T00:01:00.000Z'),
      progress_percent: 32, progress_message: 'Waiting for child tasks',
    };
    const context = {
      db,
      runtime: { getOperation: jest.fn(async () => operation) },
      usage: { project: jest.fn(async () => ({ totals: {} })) },
    } as never;

    const detail = await buildAdminOperationDetail(context, OPERATION_ID);
    expect(detail.operation).toMatchObject({
      id: OPERATION_ID,
      progress: { percent: 32, message: 'Waiting for child tasks' },
    });
    expect(detail.tasks).toEqual([
      expect.objectContaining({
        id: 'task-parent', spawnedBy: null, leasedBy: 'worker-a', attempt: 1, maxAttempts: 3,
        awaitedChildren: [{ taskId: 'task-child', joinPolicy: 'all-success' }],
      }),
      expect.objectContaining({
        id: 'task-child', spawnedBy: 'task-parent', dueAt: new Date('2026-10-13T00:03:00.000Z'),
        admissionParkedReason: 'VERSION_NOT_ACTIVE', admissionParkedAt: new Date('2026-10-13T00:02:30.000Z'),
        attempt: 2, maxAttempts: 5, errorCode: 'RETRYABLE_VALIDATION',
        awaitedChildren: [],
      }),
    ]);
    expect((detail.tasks as Array<Record<string, unknown>>)[1]).not.toHaveProperty('dependsOn');
    const taskSql = db.query.mock.calls.find(([sql]) => sql.includes('FROM tasks WHERE operation_id'))?.[0] ?? '';
    expect(taskSql).toContain('admission_parked_reason AS "admissionParkedReason"');
    expect(taskSql).toContain('admission_parked_at AS "admissionParkedAt"');
    const dependencySql = db.query.mock.calls.find(([sql]) => sql.includes('FROM task_dependencies d'))?.[0] ?? '';
    expect(dependencySql).toContain('p.operation_id=$1');
    expect(dependencySql).toContain('c.operation_id=$1');
  });
});
