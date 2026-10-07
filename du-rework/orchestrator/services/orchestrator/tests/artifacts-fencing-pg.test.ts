import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { createDb, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { HttpError } from '../src/http/errors';
import { createArtifactService } from '../src/modules/artifacts/artifacts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const TENANT_ID = 'e1000000-0000-4000-8000-000000000001';

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

interface TransactionGate {
  entered: Deferred;
  release: Deferred;
  used: boolean;
}

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing artifact PG test: database "${dbName}" is not a test database`);
  }
}

function instrumentDb(
  base: Db,
  hooks: {
    pauseAfterArtifactLock?: TransactionGate;
    onTaskLockQuerySent?: () => void;
  }
): Db {
  return {
    pool: base.pool,
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
      return base.query<T>(text, params);
    },
    close: () => base.close(),
    tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return base.tx(async (client) => {
        const wrappedClient = {
          async query(text: string, params?: unknown[]) {
            const normalized = text.replace(/\s+/g, ' ').trim().toUpperCase();
            const pending = client.query(text, params as never[]);
            if (normalized.includes('FROM TASKS WHERE ID=$1 FOR UPDATE')) {
              hooks.onTaskLockQuerySent?.();
            }
            const result = await pending;
            const gate = hooks.pauseAfterArtifactLock;
            if (
              gate &&
              !gate.used &&
              normalized.includes('FROM ARTIFACTS WHERE ID=$1 FOR UPDATE')
            ) {
              gate.used = true;
              gate.entered.resolve();
              await gate.release.promise;
            }
            return result;
          },
        } as unknown as PoolClient;
        return fn(wrappedClient);
      });
    },
  };
}

interface Fixture {
  tenantId: string;
  operationId: string;
  taskId: string;
  foreignTaskId: string;
  artifactId: string;
  storageKey: string;
  bytes: Buffer;
}

let db: Db;
let fixture: Fixture | undefined;

function requestBody(input: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    taskId: input.taskId,
    leaseEpoch: 1,
    sizeBytes: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    ...overrides,
  };
}

async function seedFixture(): Promise<Fixture> {
  const ids: Fixture = {
    tenantId: randomUUID(),
    operationId: randomUUID(),
    taskId: randomUUID(),
    foreignTaskId: randomUUID(),
    artifactId: randomUUID(),
    storageKey: `art-${randomUUID()}`,
    bytes: Buffer.from('postgres artifact fencing fixture'),
  };
  fixture = ids;

  await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [ids.tenantId, `afpg-${ids.tenantId}`]);
  await db.query(
    `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, input_ref, correlation_id)
     VALUES ($1,$2,'artifact-fencing-pg','1.0.0','extract','RUNNING','{}'::jsonb,$3)`,
    [ids.operationId, ids.tenantId, `afpg-${ids.operationId}`]
  );
  await db.query(
    `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt,
                        max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
     VALUES ($1,$2,'owner','root','{}'::jsonb,'RUNNING',1,3,1,now()+interval '5 minutes','pg-test',now()),
            ($3,$2,'foreign','root','{}'::jsonb,'RUNNING',1,3,1,now()+interval '5 minutes','pg-test',now())`,
    [ids.taskId, ids.operationId, ids.foreignTaskId]
  );
  await db.query(
    `INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, mime_type,
                            size_bytes, state, token, token_mode, token_expires_at, storage_key)
     VALUES ($1,$2,$3,$4,'output','application/octet-stream',$5,'STAGING',$6,
             'upload',now()+interval '5 minutes',$7)`,
    [ids.artifactId, ids.tenantId, ids.operationId, ids.taskId, ids.bytes.length, randomUUID(), ids.storageKey]
  );
  await db.query(
    'INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)',
    [ids.storageKey, ids.tenantId, ids.bytes]
  );
  return ids;
}

async function cleanupFixture(): Promise<void> {
  if (!fixture) return;
  const current = fixture;
  fixture = undefined;
  await db.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [current.storageKey]);
  await db.query('DELETE FROM artifacts WHERE id=$1', [current.artifactId]);
  await db.query('DELETE FROM tasks WHERE id=ANY($1::uuid[])', [[current.taskId, current.foreignTaskId]]);
  await db.query('DELETE FROM operations WHERE id=$1', [current.operationId]);
  await db.query('DELETE FROM tenants WHERE id=$1', [current.tenantId]);
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('artifacts-fencing-pg.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  assertTestDatabase();
  db = createDb(DATABASE_URL);
  await migrate(db);
  const requiredMigrations = [
    '0003_artifacts_grants.sql',
    '0008_artifact_grant_fencing.sql',
    '0011_artifact_finalize_epoch.sql',
  ];
  const applied = await db.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations WHERE filename=ANY($1::text[])',
    [requiredMigrations]
  );
  expect(new Set(applied.rows.map((row) => row.filename))).toEqual(new Set(requiredMigrations));
}, 120_000);

afterEach(async () => {
  await cleanupFixture();
});

afterAll(async () => {
  await db?.close();
});

describe('R1-A artifact fencing and retry (real PostgreSQL)', () => {
  beforeEach(async () => {
    await seedFixture();
  });

  test('serializes two real transactions; the conflicting finalize receives 409 STATE_CONFLICT', async () => {
    const current = fixture!;
    const gate: TransactionGate = { entered: deferred(), release: deferred(), used: false };
    const loserAtTaskLock = deferred();
    const winnerService = createArtifactService(instrumentDb(db, { pauseAfterArtifactLock: gate }));
    const loserService = createArtifactService(instrumentDb(db, {
      onTaskLockQuerySent: () => loserAtTaskLock.resolve(),
    }));

    const winner = winnerService.finalize(current.artifactId, requestBody(current));
    try {
      await gate.entered.promise;
      const loser = loserService.finalize(
        current.artifactId,
        requestBody(current, { sizeBytes: current.bytes.length + 1 })
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await loserAtTaskLock.promise;
      gate.release.resolve();

      await expect(winner).resolves.toEqual({ artifactId: current.artifactId, state: 'READY' });
      const loserResult = await loser;
      expect(loserResult.ok).toBe(false);
      if (!loserResult.ok) {
        expect(loserResult.error).toBeInstanceOf(HttpError);
        expect(loserResult.error).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
      }
    } finally {
      gate.release.resolve();
    }
  });

  test('blocks expired-lease and foreign-task finalization with 403 PERMISSION_DENIED', async () => {
    const current = fixture!;
    const service = createArtifactService(db);
    await db.query("UPDATE tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [current.taskId]);

    await expect(service.finalize(current.artifactId, requestBody(current))).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    await expect(service.finalize(
      current.artifactId,
      requestBody(current, { taskId: current.foreignTaskId })
    )).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  test('returns the same READY result for exact lost-response retry after commit', async () => {
    const current = fixture!;
    const service = createArtifactService(db);
    const body = requestBody(current);

    const first = await service.finalize(current.artifactId, body);
    expect(first).toEqual({ artifactId: current.artifactId, state: 'READY' });
    const saved = await db.query<{
      finalized_lease_epoch: number;
      sha256: string;
      size_bytes: string;
    }>(
      `SELECT finalized_lease_epoch, sha256, size_bytes::text
       FROM artifacts WHERE id=$1`,
      [current.artifactId]
    );
    expect(saved.rows[0]).toMatchObject({
      finalized_lease_epoch: 1,
      sha256: body.sha256,
      size_bytes: String(current.bytes.length),
    });

    // Model response loss: persist a terminal task before retrying the request.
    await db.query("UPDATE tasks SET state='SUCCEEDED', lease_expires_at=now()-interval '1 second' WHERE id=$1", [current.taskId]);
    await expect(service.finalize(current.artifactId, body)).resolves.toEqual(first);
  });

  test('rejects READY metadata drift and a foreign producer retry with 409 STATE_CONFLICT', async () => {
    const current = fixture!;
    const service = createArtifactService(db);
    const body = requestBody(current);
    await service.finalize(current.artifactId, body);

    await expect(service.finalize(
      current.artifactId,
      requestBody(current, { sha256: 'f'.repeat(64) })
    )).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(service.finalize(
      current.artifactId,
      requestBody(current, { sizeBytes: current.bytes.length + 1 })
    )).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(service.finalize(
      current.artifactId,
      requestBody(current, { taskId: current.foreignTaskId })
    )).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
  });
});
});
