import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createArtifactService, type MaintenanceRetentionFence } from '../src/modules/artifacts/artifacts';
import type { ArtifactStorageFacade } from '../src/modules/artifacts/storage-facade';

const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const STORAGE_GENERATION_ID = '66666666-6666-4666-8666-666666666666';
const EIGHT_DAYS_OLD = '2026-10-05T00:00:00.000Z';
const SEVEN_DAY_CUTOFF = '2026-10-06T00:00:00.000Z';

interface RetentionFixtureOptions {
  activeRevision: number;
  policyRevision: number | null;
  cutoffAllowed: boolean;
  completedAt?: string | null;
}

function queryResult<T extends QueryResultRow>(rows: T[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, fields: [], rows };
}

function retentionFixture(options: RetentionFixtureOptions) {
  const events: string[] = [];
  let inTransaction = false;
  let artifactState = 'READY';
  const artifactRow = () => ({
    id: ARTIFACT_ID,
    tenantId: TENANT_ID,
    state: artifactState,
    purpose: 'output',
    operationId: OPERATION_ID,
    taskId: null,
    storageKey: 'objects/result.bin',
    storageBackend: 's3',
    storageGenerationId: STORAGE_GENERATION_ID,
    storageVersionId: 'immutable-v7',
    manifestVersionId: null,
    multipartUploadId: null,
    sha256: 'a'.repeat(64),
    sizeBytes: 32,
  });
  const clientQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
    events.push(`sql:${sql.replace(/\s+/g, ' ').trim()}`);
    if (sql.includes('FROM global_settings_retention_head h')) {
      return queryResult([{
        active_revision: options.activeRevision,
        policy_revision: options.policyRevision,
        cutoff_allowed: options.cutoffAllowed,
      }]);
    }
    if (sql.includes('FROM operations o') && sql.includes('FOR SHARE OF o')) {
      const completedAt = options.completedAt === undefined ? EIGHT_DAYS_OLD : options.completedAt;
      const withinCutoff = completedAt !== null && Date.parse(completedAt) <= Date.parse(String(params[1]));
      return queryResult([{ withinCutoff }]);
    }
    if (sql.includes('FROM artifacts WHERE id=$1 FOR UPDATE')) return queryResult([artifactRow()]);
    if (sql.startsWith('SELECT 1 FROM operations o')) return queryResult([]);
    if (sql.includes("UPDATE artifacts SET state='EXPIRED'")) {
      artifactState = 'EXPIRED';
      return queryResult([{ id: ARTIFACT_ID }], 'UPDATE');
    }
    if (sql.includes("UPDATE artifacts SET state='DELETED'")) {
      artifactState = 'DELETED';
      return queryResult([{ id: ARTIFACT_ID }], 'UPDATE');
    }
    if (sql.includes('FROM artifacts WHERE id=$1')) return queryResult([artifactRow()]);
    throw new Error(`Unhandled retention-fence SQL: ${sql}`);
  });
  const db = {
    query: jest.fn(async (sql: string) => {
      events.push(`outside:${sql.replace(/\s+/g, ' ').trim()}`);
      if (sql.includes('FROM artifacts WHERE id=$1')) return queryResult([artifactRow()]);
      throw new Error(`Unhandled outside retention-fence SQL: ${sql}`);
    }),
    tx: jest.fn(async <T>(work: (client: PoolClient) => Promise<T>) => {
      events.push('tx:start');
      inTransaction = true;
      try {
        return await work({ query: clientQuery } as unknown as PoolClient);
      } finally {
        inTransaction = false;
        events.push('tx:end');
      }
    }),
  };
  const gate = {
    assertWriteAllowed: jest.fn(async () => { events.push('backup-write-gate'); }),
  };
  const effects = {
    begin: jest.fn(async () => {
      events.push('effect:begin');
      return { effectId: 'effect-1', state: 'PREPARED' as const, replayed: false };
    }),
    activate: jest.fn(async () => { events.push('effect:activate'); return true; }),
    cancelPrepared: jest.fn(async (_effectId: string, reason: string) => { events.push(`effect:cancel:${reason}`); return true; }),
    settle: jest.fn(async () => { events.push('effect:settle'); return true; }),
    markUnknown: jest.fn(async () => undefined),
    observe: jest.fn(),
    lookup: jest.fn(),
    snapshotOpenCapabilities: jest.fn(),
  };
  const storage = {
    delete: jest.fn(async () => {
      events.push('storage:delete');
      if (inTransaction) throw new Error('storage I/O must not run while a database transaction is open');
    }),
  } as unknown as ArtifactStorageFacade;
  const service = createArtifactService(db as unknown as Db, {
    storageBackend: 's3',
    storageGenerations: { forGeneration: () => storage } as never,
    backupSnapshotWriteGate: gate as never,
    backupArtifactEffects: effects as never,
  });
  return { service, db, clientQuery, events, effects, storage };
}

const sevenDayFence: MaintenanceRetentionFence = { expectedRevision: 4, cutoff: SEVEN_DAY_CUTOFF };

describe('maintenance artifact retention revision and completion cutoff fence', () => {
  test('does not expire an eight-day artifact using a seven-day preview after a thirty-day policy publishes', async () => {
    const fixture = retentionFixture({ activeRevision: 5, policyRevision: 5, cutoffAllowed: true });

    await expect(fixture.service.expireForMaintenance(ARTIFACT_ID, 'retention', sevenDayFence)).resolves.toEqual({
      status: 'SKIPPED', code: 'RETENTION_POLICY_CHANGED',
    });

    const policyLock = fixture.events.findIndex((event) => event.startsWith('sql:SELECT h.active_revision'));
    const artifactLock = fixture.events.findIndex((event) => event.includes('FROM artifacts WHERE id=$1 FOR UPDATE'));
    expect(fixture.events.indexOf('backup-write-gate')).toBeLessThan(policyLock);
    expect(fixture.events[policyLock]).toContain('FOR SHARE OF h');
    expect(artifactLock).toBe(-1);
    expect(fixture.storage.delete).not.toHaveBeenCalled();
    expect(fixture.effects.cancelPrepared).toHaveBeenCalledWith('effect-1', 'RETENTION_POLICY_CHANGED');
  });

  test('rejects a seven-day cutoff even when its supplied revision matches the current thirty-day policy', async () => {
    const fixture = retentionFixture({ activeRevision: 5, policyRevision: 5, cutoffAllowed: false });

    await expect(fixture.service.expireForMaintenance(ARTIFACT_ID, 'retention', {
      expectedRevision: 5,
      cutoff: SEVEN_DAY_CUTOFF,
    })).resolves.toEqual({ status: 'SKIPPED', code: 'RETENTION_WINDOW_OPEN' });

    expect(fixture.clientQuery.mock.calls.some(([sql]) => sql.includes('FROM artifacts WHERE id=$1 FOR UPDATE'))).toBe(false);
    expect(fixture.storage.delete).not.toHaveBeenCalled();
    expect(fixture.effects.cancelPrepared).toHaveBeenCalledWith('effect-1', 'RETENTION_WINDOW_OPEN');
  });

  test('rejects a completion newer than the pinned cutoff before locking the artifact', async () => {
    const fixture = retentionFixture({
      activeRevision: 5,
      policyRevision: 5,
      cutoffAllowed: true,
      completedAt: '2026-10-06T00:00:00.001Z',
    });

    await expect(fixture.service.expireForMaintenance(ARTIFACT_ID, 'retention', {
      expectedRevision: 5,
      cutoff: SEVEN_DAY_CUTOFF,
    })).resolves.toEqual({ status: 'SKIPPED', code: 'RETENTION_WINDOW_OPEN' });

    const ownerCheck = fixture.events.findIndex((event) => event.includes('FOR SHARE OF o'));
    const artifactLock = fixture.events.findIndex((event) => event.includes('FROM artifacts WHERE id=$1 FOR UPDATE'));
    expect(ownerCheck).toBeGreaterThan(fixture.events.findIndex((event) => event.startsWith('sql:SELECT h.active_revision')));
    expect(artifactLock).toBe(-1);
    expect(fixture.storage.delete).not.toHaveBeenCalled();
  });

  test('locks and validates the current policy and completion cutoff before marking EXPIRED, then deletes outside the transaction', async () => {
    const fixture = retentionFixture({ activeRevision: 5, policyRevision: 5, cutoffAllowed: true });

    await expect(fixture.service.expireForMaintenance(ARTIFACT_ID, 'retention', {
      expectedRevision: 5,
      cutoff: SEVEN_DAY_CUTOFF,
    })).resolves.toEqual({ status: 'DELETED', code: null });

    const gateIndex = fixture.events.indexOf('backup-write-gate');
    const policyIndex = fixture.events.findIndex((event) => event.startsWith('sql:SELECT h.active_revision'));
    const ownerIndex = fixture.events.findIndex((event) => event.includes('FOR SHARE OF o'));
    const artifactIndex = fixture.events.findIndex((event) => event.includes('FROM artifacts WHERE id=$1 FOR UPDATE'));
    const firstTransactionEnd = fixture.events.indexOf('tx:end');
    const storageDelete = fixture.events.indexOf('storage:delete');
    expect(gateIndex).toBeLessThan(policyIndex);
    expect(policyIndex).toBeLessThan(ownerIndex);
    expect(ownerIndex).toBeLessThan(artifactIndex);
    expect(artifactIndex).toBeLessThan(firstTransactionEnd);
    expect(firstTransactionEnd).toBeLessThan(storageDelete);
    expect(fixture.storage.delete).toHaveBeenCalledWith({ objectKey: 'objects/result.bin', versionId: 'immutable-v7' });
    expect(fixture.effects.settle).toHaveBeenCalledTimes(1);
  });
});
