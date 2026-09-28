import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db';
import { createArtifactService } from '../src/modules/artifacts/artifacts';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const FOREIGN_TASK_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const LEASE_EPOCH = 7;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RowLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    this.tails.set(key, current);
    await previous;
    return () => {
      releaseCurrent();
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
  }
}

interface FakeTask {
  leaseEpoch: number;
  state: string;
  leaseActive: boolean;
}

interface FakeArtifact {
  id: string;
  tenantId: string;
  storageKey: string;
  taskId: string;
  state: string;
  sizeBytes: number | null;
  sha256: string | null;
  finalizedLeaseEpoch: number | null;
}

class OfflineArtifactDb {
  readonly tasks = new Map<string, FakeTask>([[TASK_ID, {
    leaseEpoch: LEASE_EPOCH,
    state: 'RUNNING',
    leaseActive: true,
  }]]);
  readonly artifact: FakeArtifact = {
    id: ARTIFACT_ID,
    tenantId: TENANT_ID,
    storageKey: 'artifact-storage-key',
    taskId: TASK_ID,
    state: 'STAGING',
    sizeBytes: null,
    sha256: null,
    finalizedLeaseEpoch: null,
  };
  readonly taskLockAttempted = deferred();
  readonly finalizeArtifactLockAttempted = deferred();

  bytes: Buffer | null = null;
  beforeFinalizeUpdate: (() => void) | undefined;

  private readonly locks = new RowLocks();
  private putPause: { entered: Deferred; release: Deferred } | undefined;

  pauseNextPut(): { entered: Promise<void>; release(): void } {
    const entered = deferred();
    const release = deferred();
    this.putPause = { entered, release };
    return { entered: entered.promise, release: release.resolve };
  }

  async holdTaskLock(taskId = TASK_ID): Promise<() => void> {
    return this.locks.acquire(`task:${taskId}`);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.execute(text, params) as unknown as QueryResult<T>;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const held = new Map<string, () => void>();
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.replace(/\s+/g, ' ').trim().toUpperCase();
        const lockKey = this.lockKey(normalized, params);
        if (lockKey && !held.has(lockKey)) {
          if (lockKey.startsWith('task:')) this.taskLockAttempted.resolve();
          if (normalized.includes('FROM ARTIFACTS WHERE ID=$1')) {
            this.finalizeArtifactLockAttempted.resolve();
          }
          held.set(lockKey, await this.locks.acquire(lockKey));
        }

        const result = await this.execute(text, params);
        if (this.putPause && normalized.includes('FROM ARTIFACTS A') && normalized.includes('STORAGE_KEY')) {
          const pause = this.putPause;
          this.putPause = undefined;
          pause.entered.resolve();
          await pause.release.promise;
        }
        return result;
      },
    };

    try {
      return await fn(client as unknown as PoolClient);
    } finally {
      for (const release of Array.from(held.values()).reverse()) release();
    }
  }

  private lockKey(normalizedSql: string, params?: unknown[]): string | null {
    if (!normalizedSql.includes('FOR UPDATE')) return null;
    if (normalizedSql.includes('FROM TASKS')) return `task:${String(params?.[0])}`;
    if (normalizedSql.includes('FROM ARTIFACTS A') && normalizedSql.includes('STORAGE_KEY')) {
      return `artifact:${this.artifact.id}`;
    }
    if (normalizedSql.includes('FROM ARTIFACTS WHERE ID=$1')) {
      return `artifact:${String(params?.[0])}`;
    }
    return null;
  }

  private result<T extends QueryResultRow>(rows: T[], command = 'SELECT'): QueryResult<T> {
    return { command, rowCount: rows.length, oid: 0, fields: [], rows };
  }

  private async execute(text: string, params: unknown[] = []): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();

    if (sql.startsWith('SELECT') && sql.includes('FROM TASKS')) {
      const task = this.tasks.get(String(params[0]));
      return this.result(task ? [{
        lease_epoch: task.leaseEpoch,
        state: task.state,
        lease_active: task.leaseActive,
      }] : []);
    }

    if (sql.includes('FROM ARTIFACTS A') && sql.includes('STORAGE_KEY')) {
      const belongs = params[0] === this.artifact.storageKey && params[1] === this.artifact.tenantId;
      return this.result(belongs ? [{ state: this.artifact.state }] : []);
    }

    if (sql.includes('FROM ARTIFACTS') && sql.includes('WHERE ID=$1')) {
      const artifact = params[0] === this.artifact.id ? this.artifact : undefined;
      return this.result(artifact ? [{
        tenantId: artifact.tenantId,
        storageKey: artifact.storageKey,
        state: artifact.state,
        taskId: artifact.taskId,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        finalizedLeaseEpoch: artifact.finalizedLeaseEpoch,
      }] : []);
    }

    if (sql.startsWith('SELECT BYTES FROM ARTIFACT_BLOBS')) {
      return this.result(this.bytes ? [{ bytes: Buffer.from(this.bytes) }] : []);
    }

    if (sql.startsWith('INSERT INTO ARTIFACT_BLOBS')) {
      this.bytes = Buffer.from(params[2] as Buffer);
      return this.result([], 'INSERT');
    }

    if (sql.startsWith('UPDATE ARTIFACTS SET STATE=\'READY\'')) {
      this.beforeFinalizeUpdate?.();
      this.beforeFinalizeUpdate = undefined;
      const [artifactId, sizeBytes, sha256, taskId, leaseEpoch] = params;
      const task = this.tasks.get(String(taskId));
      if (
        artifactId !== this.artifact.id ||
        taskId !== this.artifact.taskId ||
        this.artifact.state !== 'STAGING' ||
        !task ||
        task.leaseEpoch !== leaseEpoch ||
        task.state !== 'RUNNING' ||
        !task.leaseActive
      ) {
        return this.result([], 'UPDATE');
      }
      this.artifact.state = 'READY';
      this.artifact.sizeBytes = Number(sizeBytes);
      this.artifact.sha256 = String(sha256);
      this.artifact.finalizedLeaseEpoch = Number(leaseEpoch);
      return this.result([{ id: this.artifact.id, state: this.artifact.state }], 'UPDATE');
    }

    throw new Error(`Unhandled offline artifact SQL: ${sql}`);
  }
}

function makeService(db: OfflineArtifactDb) {
  return createArtifactService(db as unknown as Db);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function finalizeRequest(bytes: Buffer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    leaseEpoch: LEASE_EPOCH,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    ...overrides,
  };
}

describe('R1-A artifact fencing and immutable READY bytes', () => {
  it('requires producer identity and rejects foreign, stale, expired, or cancelled producers', async () => {
    const db = new OfflineArtifactDb();
    const service = makeService(db);
    const bytes = Buffer.from('artifact bytes');
    db.bytes = Buffer.from(bytes);

    await expect(service.finalize(ARTIFACT_ID, {
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });

    db.tasks.set(FOREIGN_TASK_ID, { leaseEpoch: LEASE_EPOCH, state: 'RUNNING', leaseActive: true });
    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { taskId: FOREIGN_TASK_ID })
    )).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { leaseEpoch: LEASE_EPOCH - 1 })
    )).rejects.toMatchObject({ code: 'LEASE_LOST' });

    db.tasks.get(TASK_ID)!.leaseActive = false;
    await expect(service.finalize(ARTIFACT_ID, finalizeRequest(bytes))).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    db.tasks.get(TASK_ID)!.leaseActive = true;

    db.tasks.get(TASK_ID)!.state = 'CANCELLED';
    await expect(service.finalize(ARTIFACT_ID, finalizeRequest(bytes))).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(db.artifact.state).toBe('STAGING');
  });

  it.each([
    ['cancel', (db: OfflineArtifactDb) => { db.tasks.get(TASK_ID)!.state = 'CANCELLED'; }, 'STATE_CONFLICT'],
    ['lease takeover', (db: OfflineArtifactDb) => { db.tasks.get(TASK_ID)!.leaseEpoch += 1; }, 'LEASE_LOST'],
  ] as const)('serializes finalize with a concurrent %s', async (_name, changeTask, errorCode) => {
    const db = new OfflineArtifactDb();
    const service = makeService(db);
    const bytes = Buffer.from('artifact bytes');
    db.bytes = Buffer.from(bytes);

    const releaseTaskLock = await db.holdTaskLock();
    const finalizeResult = service.finalize(ARTIFACT_ID, finalizeRequest(bytes)).then(
      () => null,
      (error: unknown) => error
    );
    await db.taskLockAttempted.promise;
    changeTask(db);
    releaseTaskLock();

    await expect(finalizeResult).resolves.toMatchObject({ code: errorCode });
    expect(db.artifact.state).toBe('STAGING');
  });

  it('rechecks lease expiry at the READY transition', async () => {
    const db = new OfflineArtifactDb();
    const service = makeService(db);
    const bytes = Buffer.from('artifact bytes');
    db.bytes = Buffer.from(bytes);
    db.beforeFinalizeUpdate = () => {
      db.tasks.get(TASK_ID)!.leaseActive = false;
    };

    await expect(service.finalize(ARTIFACT_ID, finalizeRequest(bytes))).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(db.artifact.state).toBe('STAGING');
  });

  it('returns READY for an exact lost-response retry and conflicts on changed producer metadata', async () => {
    const db = new OfflineArtifactDb();
    const service = makeService(db);
    const bytes = Buffer.from('finalized artifact bytes');
    db.bytes = Buffer.from(bytes);
    const request = finalizeRequest(bytes);

    await expect(service.finalize(ARTIFACT_ID, request)).resolves.toEqual({
      artifactId: ARTIFACT_ID,
      state: 'READY',
    });

    // The worker's response was lost; meanwhile the task is no longer active.
    // Replay must match the persisted producer epoch, not require a live lease.
    db.tasks.get(TASK_ID)!.leaseEpoch += 1;
    db.tasks.get(TASK_ID)!.state = 'SUCCEEDED';
    db.tasks.get(TASK_ID)!.leaseActive = false;
    await expect(service.finalize(ARTIFACT_ID, request)).resolves.toEqual({
      artifactId: ARTIFACT_ID,
      state: 'READY',
    });

    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { sha256: 'f'.repeat(64) })
    )).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { sizeBytes: bytes.length + 1 })
    )).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { leaseEpoch: LEASE_EPOCH + 1 })
    )).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    db.tasks.set(FOREIGN_TASK_ID, { leaseEpoch: LEASE_EPOCH, state: 'RUNNING', leaseActive: true });
    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(bytes, { taskId: FOREIGN_TASK_ID })
    )).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(db.artifact.state).toBe('READY');
  });

  it('serializes an in-flight staging PUT with finalize and refuses overwrites after READY', async () => {
    const db = new OfflineArtifactDb();
    const service = makeService(db);
    const committedBytes = Buffer.from('bytes currently staged');
    const delayedPutBytes = Buffer.from('late overwrite bytes');
    db.bytes = Buffer.from(committedBytes);

    const putGate = db.pauseNextPut();
    const delayedPut = service.putBlob(db.artifact.storageKey, TENANT_ID, delayedPutBytes);
    await putGate.entered;

    let finalizeSettled = false;
    const finalizeResult = service.finalize(
      ARTIFACT_ID,
      finalizeRequest(committedBytes)
    ).then(
      () => {
        finalizeSettled = true;
        return null;
      },
      (error: unknown) => {
        finalizeSettled = true;
        return error;
      }
    );
    await db.finalizeArtifactLockAttempted.promise;
    expect(finalizeSettled).toBe(false);

    putGate.release();
    await delayedPut;
    await expect(finalizeResult).resolves.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(db.artifact.state).toBe('STAGING');
    expect(db.bytes?.equals(delayedPutBytes)).toBe(true);

    await expect(service.finalize(
      ARTIFACT_ID,
      finalizeRequest(delayedPutBytes)
    )).resolves.toEqual({ artifactId: ARTIFACT_ID, state: 'READY' });

    const overwrite = Buffer.from('post-finalize overwrite');
    await expect(service.putBlob(db.artifact.storageKey, TENANT_ID, overwrite)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(db.bytes?.equals(delayedPutBytes)).toBe(true);
    expect(db.artifact.state).toBe('READY');
  });
});
