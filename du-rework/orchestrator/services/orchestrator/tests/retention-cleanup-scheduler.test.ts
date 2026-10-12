import { createRetentionCleanupScheduler } from '../src/modules/maintenance/retention-cleanup-scheduler';

const YEAR_MS = 31_536_000_000;
const MAX_TIMER_MS = 2_147_000_000;

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function policy(cleanupIntervalSeconds: number, revision = 1) {
  return { revision, cacheTtlHours: 168, outputRetentionDays: 30, cleanupIntervalSeconds };
}

describe('retention cleanup scheduler', () => {
  afterEach(() => jest.useRealTimers());

  test('zero disables scheduling and a refreshed disabled policy cancels the old slot', async () => {
    jest.useFakeTimers({ now: 0 });
    let current = policy(60);
    const connect = jest.fn(async () => ({
      query: jest.fn(async () => ({ rows: [{ locked: true }], rowCount: 1 })),
      release: jest.fn(),
    }));
    const dbQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const maintenance = {
      createMaintenancePreview: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => ({ previewId: 'preview', expectedVersion: 'v1', eligibleCount: 1 })),
      startMaintenanceJob: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => ({ jobId: 'job' })),
    };
    const scheduler = createRetentionCleanupScheduler({
      db: { pool: { connect }, query: dbQuery } as never,
      maintenance,
      getEffectiveRetentionPolicy: async () => current,
      now: () => Date.now(),
    });

    scheduler.start();
    await flushMicrotasks();
    current = policy(0, 2);
    scheduler.refresh();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(maintenance.createMaintenancePreview).not.toHaveBeenCalled();
    expect(maintenance.startMaintenanceJob).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  test('year-long intervals are chunked below Node timer overflow and enqueue one durable job when due', async () => {
    jest.useFakeTimers({ now: 0 });
    let clock = 0;
    const connect = jest.fn(async () => ({
      query: jest.fn(async () => ({ rows: [{ locked: true }], rowCount: 1 })),
      release: jest.fn(),
    }));
    const dbQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const maintenance = {
      createMaintenancePreview: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => ({ previewId: 'preview', expectedVersion: 'version', eligibleCount: 1 })),
      startMaintenanceJob: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => ({ jobId: 'job' })),
    };
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const scheduler = createRetentionCleanupScheduler({
      db: { pool: { connect }, query: dbQuery } as never,
      maintenance,
      getEffectiveRetentionPolicy: async () => policy(31_536_000),
      now: () => clock,
    });

    scheduler.start();
    await flushMicrotasks();
    expect(timerSpy.mock.calls.some(([delay]) => typeof delay === 'number' && delay > MAX_TIMER_MS)).toBe(false);
    expect(jest.getTimerCount()).toBe(1);
    clock = YEAR_MS;
    scheduler.refresh();
    await flushMicrotasks();
    expect(maintenance.createMaintenancePreview).toHaveBeenCalledTimes(1);
    expect(maintenance.startMaintenanceJob).toHaveBeenCalledTimes(1);
    const [, request] = maintenance.startMaintenanceJob.mock.calls[0]!;
    expect(request).toEqual(expect.objectContaining({ previewId: 'preview', expectedVersion: 'version' }));
    expect(String((request as { idempotencyKey: string }).idempotencyKey)).toContain('retention-cleanup:1:');
    await scheduler.stop();
    timerSpy.mockRestore();
  });

  test('replicas discover another publisher’s cadence change, and policy read failures retry without rejection', async () => {
    jest.useFakeTimers({ now: 0 });
    let current = policy(0, 1);
    let held = false;
    let jobCreated = false;
    const connect = jest.fn(async () => ({
      query: jest.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (held) return { rows: [{ locked: false }], rowCount: 1 };
          held = true;
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (sql.includes('pg_advisory_unlock')) {
          held = false;
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    }));
    const db = {
      pool: { connect },
      query: jest.fn(async () => jobCreated ? { rows: [{ exists: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }),
    } as never;
    const maintenance = {
      createMaintenancePreview: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => ({ previewId: 'preview', expectedVersion: 'v1', eligibleCount: 1 })),
      startMaintenanceJob: jest.fn(async (_actor: { actor: string; actorRole: string }, _request: unknown) => { jobCreated = true; return { jobId: 'job' }; }),
    };
    const first = createRetentionCleanupScheduler({ db, maintenance, getEffectiveRetentionPolicy: async () => current });
    const second = createRetentionCleanupScheduler({ db, maintenance, getEffectiveRetentionPolicy: async () => current });
    first.start();
    second.start();
    await flushMicrotasks();

    current = policy(60, 2);
    first.refresh(); // simulate the publisher process receiving its post-commit callback
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(30_000); // second process discovers the published revision by polling
    expect(maintenance.startMaintenanceJob).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(maintenance.createMaintenancePreview).toHaveBeenCalledTimes(1);
    expect(maintenance.startMaintenanceJob).toHaveBeenCalledTimes(1);
    await first.stop();
    await second.stop();

    let reads = 0;
    const errors = jest.fn();
    const retrying = createRetentionCleanupScheduler({
      db,
      maintenance,
      getEffectiveRetentionPolicy: async () => {
        reads += 1;
        if (reads === 1) throw new Error('temporary settings read failure');
        return policy(0, 3);
      },
      onError: errors,
    });
    retrying.start();
    await flushMicrotasks();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(2);
    await retrying.stop();
  });
});
