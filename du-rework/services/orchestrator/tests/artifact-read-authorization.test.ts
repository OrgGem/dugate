import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Readable } from 'node:stream';
import type { Db } from '../src/db/db';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import type { ArtifactStorageFacade } from '../src/modules/artifacts/storage-facade';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP_PARENT_CHILD = '11111111-1111-4111-8111-111111111111';
const OP_REFERENCE = '22222222-2222-4222-8222-222222222222';
const OP_FOREIGN_TENANT = '33333333-3333-4333-8333-333333333333';
const PARENT_TASK = '44444444-4444-4444-8444-444444444444';
const CHILD_TASK = '55555555-5555-4555-8555-555555555555';
const OTHER_TASK = '66666666-6666-4666-8666-666666666666';
const DECLARED_INPUT = '77777777-7777-4777-8777-777777777777';
const UNDECLARED_OUTPUT = '88888888-8888-4888-8888-888888888888';
const FOREIGN_TENANT_INPUT = '99999999-9999-4999-8999-999999999999';
const FOREIGN_CHECKPOINT = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAGING_OUTPUT = 'aaaaaaaa-0000-4000-8000-000000000002';
const SAME_OPERATION_CHECKPOINT = 'aaaaaaaa-0000-4000-8000-000000000003';
const CHILD_OUTPUT = 'aaaaaaaa-0000-4000-8000-000000000004';

interface TaskRow {
  leaseEpoch: number;
  state: string;
  operationId: string;
  tenantId: string;
  submitArtifacts: unknown;
  leaseActive: boolean;
}

interface ArtifactRow {
  tenantId: string;
  operationId: string | null;
  storageKey: string;
  state: string;
  taskId: string | null;
  purpose: string;
}

class OfflineArtifactAccessDb {
  readonly tasks = new Map<string, TaskRow>([
    [CHILD_TASK, {
      leaseEpoch: 5,
      state: 'RUNNING',
      operationId: OP_PARENT_CHILD,
      tenantId: TENANT_A,
      submitArtifacts: [
        { artifactId: DECLARED_INPUT, role: 'source' },
        { artifactId: FOREIGN_TENANT_INPUT, role: 'source' },
        { artifactId: FOREIGN_CHECKPOINT, role: 'checkpoint' },
      ],
      leaseActive: true,
    }],
    [PARENT_TASK, {
      leaseEpoch: 3,
      state: 'RUNNING',
      operationId: OP_PARENT_CHILD,
      tenantId: TENANT_A,
      submitArtifacts: [],
      leaseActive: true,
    }],
    [OTHER_TASK, {
      leaseEpoch: 1,
      state: 'RUNNING',
      operationId: OP_REFERENCE,
      tenantId: TENANT_A,
      submitArtifacts: [],
      leaseActive: true,
    }],
  ]);

  readonly artifacts = new Map<string, ArtifactRow>([
    [UNDECLARED_OUTPUT, {
      tenantId: TENANT_A,
      operationId: OP_REFERENCE,
      storageKey: 'private-output-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'output',
    }],
    [DECLARED_INPUT, {
      tenantId: TENANT_A,
      operationId: OP_REFERENCE,
      storageKey: 'referenced-input-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'input',
    }],
    [FOREIGN_TENANT_INPUT, {
      tenantId: TENANT_B,
      operationId: OP_FOREIGN_TENANT,
      storageKey: 'foreign-tenant-input-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'input',
    }],
    [FOREIGN_CHECKPOINT, {
      tenantId: TENANT_A,
      operationId: OP_REFERENCE,
      storageKey: 'foreign-checkpoint-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'intermediate',
    }],
    [SAME_OPERATION_CHECKPOINT, {
      tenantId: TENANT_A,
      operationId: OP_PARENT_CHILD,
      storageKey: 'same-operation-checkpoint-key',
      state: 'READY',
      taskId: PARENT_TASK,
      purpose: 'intermediate',
    }],
    [CHILD_OUTPUT, {
      tenantId: TENANT_A,
      operationId: OP_PARENT_CHILD,
      storageKey: 'child-output-key',
      state: 'READY',
      taskId: CHILD_TASK,
      purpose: 'output',
    }],
    [STAGING_OUTPUT, {
      tenantId: TENANT_A,
      operationId: OP_PARENT_CHILD,
      storageKey: 'staging-output-key',
      state: 'STAGING',
      taskId: PARENT_TASK,
      purpose: 'output',
    }],
  ]);

  grantUpdates = 0;

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return (await this.execute(text, params ?? [])) as unknown as QueryResult<T>;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = {
      query: async (text: string, params: unknown[] = []) => this.execute(text, params),
    };
    return fn(client as unknown as PoolClient);
  }

  private result<T extends QueryResultRow>(rows: T[], command = 'SELECT'): QueryResult<T> {
    return { command, rowCount: rows.length, oid: 0, fields: [], rows };
  }

  private async execute(text: string, params: unknown[]): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
      const task = this.tasks.get(String(params[0]));
      if (!sql.includes('T.STATE')) {
        return this.result(task ? [{
          lease_epoch: task.leaseEpoch,
          operation_id: task.operationId,
          tenant_id: task.tenantId,
        }] : []);
      }
      return this.result(task ? [{
        lease_epoch: task.leaseEpoch,
        state: task.state,
        operationId: task.operationId,
        tenantId: task.tenantId,
        submitArtifacts: task.submitArtifacts,
        lease_active: task.leaseActive,
      }] : []);
    }
    if (sql.includes('FROM ARTIFACTS WHERE ID=$1')) {
      const artifact = this.artifacts.get(String(params[0]));
      return this.result(artifact ? [{
        tenantId: artifact.tenantId,
        operationId: artifact.operationId,
        storageKey: artifact.storageKey,
        state: artifact.state,
        taskId: artifact.taskId,
        purpose: artifact.purpose,
      }] : []);
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET TOKEN=')) {
      this.grantUpdates += 1;
      return this.result([], 'UPDATE');
    }
    if (sql.startsWith('INSERT INTO ARTIFACTS')) return this.result([], 'INSERT');
    throw new Error(`Unhandled offline artifact-access SQL: ${sql}`);
  }
}

function makeService(db: OfflineArtifactAccessDb) {
  return createArtifactService(db as unknown as Db);
}

function makeS3Storage(): ArtifactStorageFacade {
  return {
    createUploadGrant: jest.fn(async (input) => ({ url: 'https://s3.test/upload', expiresAt: input.expiresAt })),
    verifyAndPin: jest.fn(async (input) => ({
      objectKey: input.objectKey,
      versionId: 'version-1',
      sizeBytes: 0,
      sha256: '0'.repeat(64),
    })),
    openRead: jest.fn(async () => Readable.from([])),
    delete: jest.fn(async () => undefined),
  };
}

function readRequest(taskId = CHILD_TASK) {
  return { taskId, leaseEpoch: taskId === PARENT_TASK ? 3 : 5, mode: 'read' };
}

function writeRequest(taskId = PARENT_TASK) {
  return { taskId, leaseEpoch: taskId === PARENT_TASK ? 3 : 5, mode: 'write' };
}

describe('R1-A artifact read authorization and storage-facade boundary', () => {
  it('allows parent/child reads within one operation, including internal checkpoints', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    const grant = await service.requestAccess(SAME_OPERATION_CHECKPOINT, readRequest());

    expect(grant.downloadUrl).toContain('/same-operation-checkpoint-key?grant=');
    expect(db.grantUpdates).toBe(1);
  });

  it('allows the parent task to read a child artifact within that same operation', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    const grant = await service.requestAccess(CHILD_OUTPUT, readRequest(PARENT_TASK));

    expect(grant.downloadUrl).toContain('/child-output-key?grant=');
    expect(db.grantUpdates).toBe(1);
  });

  it('keeps S3-backed parent/child reads authorized and foreign tenant reads denied', async () => {
    const db = new OfflineArtifactAccessDb();
    const storage = makeS3Storage();
    const service = createArtifactService(db as unknown as Db, {
      storageBackend: 's3',
      storageFacade: storage,
    });

    const parentRead = await service.requestAccess(SAME_OPERATION_CHECKPOINT, readRequest());
    const childRead = await service.requestAccess(CHILD_OUTPUT, readRequest(PARENT_TASK));
    expect(parentRead.downloadUrl).toContain('/same-operation-checkpoint-key?grant=');
    expect(childRead.downloadUrl).toContain('/child-output-key?grant=');
    expect(storage.openRead).not.toHaveBeenCalled();

    await expect(service.requestAccess(FOREIGN_TENANT_INPUT, readRequest())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(db.grantUpdates).toBe(2);
    expect(storage.openRead).not.toHaveBeenCalled();
  });

  it('allows a cross-operation public input only when the requester operation declares that exact reference', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    const grant = await service.requestAccess(DECLARED_INPUT, readRequest());

    expect(grant.downloadUrl).toContain('/referenced-input-key?grant=');
    expect(db.grantUpdates).toBe(1);
  });

  it('blocks undeclared cross-operation artifacts and does not mint a grant', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    await expect(service.requestAccess(UNDECLARED_OUTPUT, readRequest())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(db.grantUpdates).toBe(0);
  });

  it('does not let a declared reference cross tenant boundaries', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    await expect(service.requestAccess(FOREIGN_TENANT_INPUT, readRequest())).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(db.grantUpdates).toBe(0);
  });

  it.each(['intermediate', 'session'])(
    'keeps declared cross-operation %s artifacts private',
    async (purpose) => {
      const db = new OfflineArtifactAccessDb();
      db.artifacts.set(FOREIGN_CHECKPOINT, {
        ...db.artifacts.get(FOREIGN_CHECKPOINT)!,
        purpose,
      });
      const service = makeService(db);

      await expect(service.requestAccess(FOREIGN_CHECKPOINT, readRequest())).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
      });
      expect(db.grantUpdates).toBe(0);
    }
  );

  it('does not grant reads for STAGING artifacts, even in the same operation', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    await expect(service.requestAccess(STAGING_OUTPUT, readRequest())).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(db.grantUpdates).toBe(0);
  });

  it('rejects expired and fenced requesters before minting a read grant', async () => {
    const expiredDb = new OfflineArtifactAccessDb();
    expiredDb.tasks.get(CHILD_TASK)!.leaseActive = false;
    await expect(
      makeService(expiredDb).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(expiredDb.grantUpdates).toBe(0);

    const staleDb = new OfflineArtifactAccessDb();
    staleDb.tasks.get(CHILD_TASK)!.leaseEpoch += 1;
    await expect(
      makeService(staleDb).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(staleDb.grantUpdates).toBe(0);
  });

  it('keeps access-grant writes producer-scoped within a shared operation', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    await expect(service.requestAccess(STAGING_OUTPUT, writeRequest(CHILD_TASK))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(db.grantUpdates).toBe(0);

    const ownerGrant = await service.requestAccess(STAGING_OUTPUT, writeRequest(PARENT_TASK));
    expect(ownerGrant.uploadUrl).toContain('/staging-output-key?grant=');
    expect(db.grantUpdates).toBe(1);
  });

  it('keeps writes producer-scoped and hides storage keys from the public upload grant', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    const grant = await service.requestUpload(CHILD_TASK, 5, {
      leaseEpoch: 5,
      purpose: 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: 4,
    });

    expect(grant).not.toHaveProperty('storageKey');
    expect(grant.uploadUrl).toContain('/api/runtime/v1/artifacts/blob/');
  });
});
