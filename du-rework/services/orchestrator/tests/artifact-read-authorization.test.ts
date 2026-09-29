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
const DELETED_FOREIGN_ARTIFACT = 'aaaaaaaa-0000-4000-8000-000000000005';
const FOREIGN_STAGING_OUTPUT = 'aaaaaaaa-0000-4000-8000-000000000006';
// Decimal-only ids have no case, so case-sensitivity probes need hex letters.
const LETTERED_DECLARED_INPUT = 'abcdef01-2345-4678-89ab-cdef01234567';
const LETTERED_FOREIGN_INPUT = 'fedcba98-7654-4321-8765-fedcba987654';

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
    [DELETED_FOREIGN_ARTIFACT, {
      tenantId: TENANT_B,
      operationId: OP_FOREIGN_TENANT,
      storageKey: 'deleted-foreign-key',
      state: 'DELETED',
      taskId: OTHER_TASK,
      purpose: 'output',
    }],
    [FOREIGN_STAGING_OUTPUT, {
      tenantId: TENANT_A,
      operationId: OP_REFERENCE,
      storageKey: 'foreign-staging-output-key',
      state: 'STAGING',
      taskId: OTHER_TASK,
      purpose: 'output',
    }],
    [LETTERED_DECLARED_INPUT, {
      tenantId: TENANT_A,
      operationId: OP_REFERENCE,
      storageKey: 'lettered-referenced-input-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'input',
    }],
    [LETTERED_FOREIGN_INPUT, {
      tenantId: TENANT_B,
      operationId: OP_FOREIGN_TENANT,
      storageKey: 'lettered-foreign-input-key',
      state: 'READY',
      taskId: OTHER_TASK,
      purpose: 'input',
    }],
  ]);

  grantUpdates = 0;
  queryCount = 0;
  readonly artifactIdLookups: string[] = [];
  readonly grantTokenUpdates: Array<{ artifactId: string; token: string; mode: string; expiresAt: string }> = [];

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
    this.queryCount += 1;
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
      const requestedId = String(params[0]);
      this.artifactIdLookups.push(requestedId);
      // `artifacts.id` is a uuid PRIMARY KEY, so PostgreSQL normalizes case
      // before matching. The double must do the same or it would hide the
      // strict `===` comparison used for declared references.
      const artifact = this.artifacts.get(requestedId.toLowerCase());
      return this.result(artifact ? [{
        tenantId: artifact.tenantId,
        operationId: artifact.operationId,
        storageKey: artifact.storageKey,
        storageBackend: 'postgres',
        storageVersionId: null,
        fileName: 'artifact.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 4,
        sha256: '0'.repeat(64),
        state: artifact.state,
        taskId: artifact.taskId,
        purpose: artifact.purpose,
      }] : []);
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET TOKEN=')) {
      this.grantUpdates += 1;
      this.grantTokenUpdates.push({
        artifactId: String(params[0]),
        token: String(params[1]),
        mode: String(params[2]),
        expiresAt: String(params[3]),
      });
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
    expect(grant.storageVersionId).toBe('0'.repeat(64));
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

const MALFORMED_ARTIFACT_IDS: Array<[string, string]> = [
  ['a non-uuid word', 'not-a-uuid'],
  ['a bare number', '12345'],
  ['a uuid missing its last group', '00000000-0000-0000-0000-00000000000'],
  ['a uuid with non-hex characters', '00000000-0000-0000-zzzz-000000000000'],
  ['an id with trailing whitespace', '77777777-7777-4777-8777-777777777777 '],
  ['an id with leading whitespace', ' 77777777-7777-4777-8777-777777777777'],
  ['a path traversal', '../../tenants'],
  ['an over-long id', 'x'.repeat(300)],
  ['the literal string null', 'null'],
  ['a zero uuid', '00000000-0000-4000-8000-000000000000'],
];

const MALFORMED_REFERENCE_ARRAYS: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a bare object', { artifactId: DECLARED_INPUT }],
  ['a json string', JSON.stringify([{ artifactId: DECLARED_INPUT }])],
  ['a number', 42],
  ['a boolean', true],
  ['entries that are all nullish', [null, undefined]],
  ['entries that are bare strings', [DECLARED_INPUT, 'other']],
  ['a nested array entry', [[{ artifactId: DECLARED_INPUT }]]],
  ['entries keyed as artifact', [{ artifact: DECLARED_INPUT }]],
  ['entries keyed as id', [{ id: DECLARED_INPUT }]],
  ['entries keyed as artifact_id', [{ artifact_id: DECLARED_INPUT }]],
  ['a numeric artifactId', [{ artifactId: 77777777 }]],
  ['a null artifactId', [{ artifactId: null }]],
  ['a nested-object artifactId', [{ artifactId: { value: DECLARED_INPUT } }]],
  ['an empty object entry', [{}]],
];

describe('CR28-03 artifact read authorization: negatives and boundaries', () => {
  describe('artifactId shape', () => {
    it.each(MALFORMED_ARTIFACT_IDS)(
      'refuses %s without minting a grant',
      async (_label, artifactId) => {
        const db = new OfflineArtifactAccessDb();

        await expect(
          makeService(db).requestAccess(artifactId, readRequest())
        ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect(db.grantUpdates).toBe(0);
      }
    );

    it('refuses a well-formed but unknown uuid, so the 404 comes from the lookup', async () => {
      const db = new OfflineArtifactAccessDb();

      await expect(
        makeService(db).requestAccess('bbbbbbbb-0000-4000-8000-00000000dead', readRequest())
      ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(db.grantUpdates).toBe(0);
    });

    it('FINDING: hands an unvalidated artifactId straight to the id=$1 lookup', async () => {
      const db = new OfflineArtifactAccessDb();

      await expect(
        makeService(db).requestAccess('not-a-uuid', readRequest())
      ).rejects.toBeDefined();

      // Two statements only: the requester lock, then the artifact lookup.
      // The malformed id reaches SQL verbatim - no uuid parse happens first.
      expect(db.queryCount).toBe(2);
      expect(db.artifactIdLookups).toEqual(['not-a-uuid']);
      expect(db.grantUpdates).toBe(0);
    });
  });

  describe('declared references array', () => {
    it.each(MALFORMED_REFERENCE_ARRAYS)(
      'refuses a cross-operation read when submit_artifacts is %s',
      async (_label, shape) => {
        const db = new OfflineArtifactAccessDb();
        db.tasks.get(CHILD_TASK)!.submitArtifacts = shape;

        await expect(
          makeService(db).requestAccess(DECLARED_INPUT, readRequest())
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(db.grantUpdates).toBe(0);
      }
    );

    it.each([
      ['whitespace padded', ` ${LETTERED_DECLARED_INPUT}`],
      ['tab padded', `${String.fromCharCode(9)}${LETTERED_DECLARED_INPUT}`],
      ['newline padded', `${LETTERED_DECLARED_INPUT}${String.fromCharCode(10)}`],
      ['carriage-return padded', `${LETTERED_DECLARED_INPUT}${String.fromCharCode(13)}`],
      ['stored uppercase', LETTERED_DECLARED_INPUT.toUpperCase()],
    ])('refuses a declared reference that is %s', async (_label, declared) => {
      const db = new OfflineArtifactAccessDb();
      db.tasks.get(CHILD_TASK)!.submitArtifacts = [{ artifactId: declared, role: 'source' }];

      await expect(
        makeService(db).requestAccess(LETTERED_DECLARED_INPUT, readRequest())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(db.grantUpdates).toBe(0);
    });

    it.each([['Input'], ['INPUT'], ['Output'], ['output '], [' output']])(
      'treats purpose %p as private because the public check is exact',
      async (purpose) => {
        const db = new OfflineArtifactAccessDb();
        db.artifacts.set(DECLARED_INPUT, { ...db.artifacts.get(DECLARED_INPUT)!, purpose });

        await expect(
          makeService(db).requestAccess(DECLARED_INPUT, readRequest())
        ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(db.grantUpdates).toBe(0);
      }
    );

    it('FINDING: accepts an inherited artifactId because the guard uses `in`', async () => {
      const db = new OfflineArtifactAccessDb();
      const inherited = Object.create({ artifactId: DECLARED_INPUT }) as Record<string, unknown>;
      db.tasks.get(CHILD_TASK)!.submitArtifacts = [inherited];

      const grant = await makeService(db).requestAccess(DECLARED_INPUT, readRequest());

      // `in` walks the prototype chain, so a non-own property authorizes.
      // Only JSONB provenance of submit_artifacts keeps this unreachable.
      expect(grant.downloadUrl).toContain('/referenced-input-key?grant=');
      expect(db.grantUpdates).toBe(1);
    });

    it('FINDING: an uppercase artifactId is authorized same-operation but denied as a declared reference', async () => {
      const sameOpDb = new OfflineArtifactAccessDb();
      const sameOp = await makeService(sameOpDb).requestAccess(
        SAME_OPERATION_CHECKPOINT.toUpperCase(),
        readRequest()
      );
      expect(sameOp.downloadUrl).toContain('/same-operation-checkpoint-key?grant=');
      expect(sameOpDb.artifactIdLookups).toEqual([SAME_OPERATION_CHECKPOINT.toUpperCase()]);
      expect(sameOpDb.grantUpdates).toBe(1);

      const crossOpDb = new OfflineArtifactAccessDb();
      await expect(
        makeService(crossOpDb).requestAccess(LETTERED_DECLARED_INPUT.toUpperCase(), readRequest())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(crossOpDb.grantUpdates).toBe(0);
    });

    it('refuses a foreign-tenant artifact declared beside valid references', async () => {
      const db = new OfflineArtifactAccessDb();
      db.tasks.get(CHILD_TASK)!.submitArtifacts = [
        { artifactId: LETTERED_DECLARED_INPUT, role: 'source' },
        { artifactId: FOREIGN_TENANT_INPUT, role: 'source' },
        { artifactId: LETTERED_FOREIGN_INPUT, role: 'source' },
        { artifactId: LETTERED_FOREIGN_INPUT.toUpperCase(), role: 'source' },
      ];

      await expect(
        makeService(db).requestAccess(FOREIGN_TENANT_INPUT, readRequest())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(
        makeService(db).requestAccess(LETTERED_FOREIGN_INPUT, readRequest())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(db.grantUpdates).toBe(0);
    });

    it('reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact', async () => {
      const db = new OfflineArtifactAccessDb();
      db.tasks.get(CHILD_TASK)!.submitArtifacts = [
        { artifactId: DECLARED_INPUT, role: 'source' },
        { artifactId: FOREIGN_STAGING_OUTPUT, role: 'source' },
      ];

      await expect(
        makeService(db).requestAccess(FOREIGN_STAGING_OUTPUT, readRequest())
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
      expect(db.grantUpdates).toBe(0);
    });

    it('FINDING: a cross-tenant prober gets three distinguishable answers', async () => {
      const db = new OfflineArtifactAccessDb();
      const service = makeService(db);

      // DELETED is reported before any tenant or reference check.
      await expect(
        service.requestAccess(DELETED_FOREIGN_ARTIFACT, readRequest())
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
      // exists, same tenant, not declared
      await expect(
        service.requestAccess(UNDECLARED_OUTPUT, readRequest())
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      // does not exist at all
      await expect(
        service.requestAccess('bbbbbbbb-0000-4000-8000-00000000dead', readRequest())
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.grantUpdates).toBe(0);
    });
  });
});

describe('CR28-03 grant token', () => {
  it('binds the download grant token to the persisted row and scopes it to download', async () => {
    const db = new OfflineArtifactAccessDb();
    const grant = await makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest());

    expect(db.grantTokenUpdates).toHaveLength(1);
    const update = db.grantTokenUpdates[0]!;
    expect(update.artifactId).toBe(SAME_OPERATION_CHECKPOINT);
    expect(update.mode).toBe('download');
    expect(update.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(grant.downloadUrl).toContain(`?grant=${update.token}`);
    expect(update.expiresAt).toBe(grant.expiresAt);
  });

  it('stores a distinct token per grant so an earlier URL cannot be replayed', async () => {
    const db = new OfflineArtifactAccessDb();
    const service = makeService(db);

    const first = await service.requestAccess(SAME_OPERATION_CHECKPOINT, readRequest());
    const second = await service.requestAccess(SAME_OPERATION_CHECKPOINT, readRequest());

    expect(first.downloadUrl).not.toBe(second.downloadUrl);
    const tokens = db.grantTokenUpdates.map((u) => u.token);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
    expect(db.grantTokenUpdates.every((u) => u.mode === 'download')).toBe(true);
  });

  it('scopes a write grant to upload, never to download', async () => {
    const db = new OfflineArtifactAccessDb();

    await makeService(db).requestAccess(STAGING_OUTPUT, writeRequest(PARENT_TASK));

    expect(db.grantTokenUpdates).toHaveLength(1);
    expect(db.grantTokenUpdates[0]!.mode).toBe('upload');
  });

  it('keeps the advertised expiry inside the 15 minute grant window', async () => {
    const before = Date.now();
    const grant = await makeService(new OfflineArtifactAccessDb()).requestAccess(
      SAME_OPERATION_CHECKPOINT,
      readRequest()
    );
    const expires = Date.parse(grant.expiresAt);

    expect(expires).toBeGreaterThan(before);
    expect(expires - before).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });

  it('FINDING: the service-level read path carries no credential at all', () => {
    const service = makeService(new OfflineArtifactAccessDb());

    // Only the HTTP blob route checks the token. The service hands bytes to
    // any caller holding a storage key, so the fence lives entirely in the
    // route and a future caller would bypass it silently.
    expect(service.getBlob.length).toBe(1);
    expect(service.putBlob.length).toBe(3);
    expect(service.requestAccess.length).toBe(2);
  });
});

describe('CR28-03 worker lease boundaries', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'PENDING', 'CLAIMED', 'BLOCKED'])(
    'refuses a read grant when the requester is %s even on an active lease',
    async (state) => {
      const db = new OfflineArtifactAccessDb();
      db.tasks.get(CHILD_TASK)!.state = state;

      await expect(
        makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
      expect(db.grantUpdates).toBe(0);
    }
  );

  it('refuses a lease epoch from the future as stale', async () => {
    const db = new OfflineArtifactAccessDb();

    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, {
        taskId: CHILD_TASK,
        leaseEpoch: 4,
        mode: 'read',
      })
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(db.grantUpdates).toBe(0);
  });

  it('prefers LEASE_LOST over expiry when the epoch is wrong as well', async () => {
    const db = new OfflineArtifactAccessDb();
    db.tasks.get(CHILD_TASK)!.leaseActive = false;

    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, {
        taskId: CHILD_TASK,
        leaseEpoch: 99,
        mode: 'read',
      })
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(db.grantUpdates).toBe(0);
  });

  it('prefers expiry over task state when both are wrong', async () => {
    const db = new OfflineArtifactAccessDb();
    const task = db.tasks.get(CHILD_TASK)!;
    task.leaseActive = false;
    task.state = 'COMPLETED';

    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(db.grantUpdates).toBe(0);
  });

  it('FINDING: the lease_active boolean collapses a missing expiry and a past one', async () => {
    const db = new OfflineArtifactAccessDb();
    db.tasks.get(CHILD_TASK)!.leaseActive = false;

    await expect(
      makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, readRequest())
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    // The query projects (lease_expires_at IS NOT NULL AND lease_expires_at
    // > now()) AS lease_active, so a task that never received an expiry denies
    // exactly like an expired one and the service cannot tell them apart.
    expect(db.grantUpdates).toBe(0);
  });

  it('keeps a live lease at the exact epoch authorized', async () => {
    const db = new OfflineArtifactAccessDb();

    const grant = await makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, {
      taskId: CHILD_TASK,
      leaseEpoch: 5,
      mode: 'read',
    });

    expect(grant.downloadUrl).toContain('/same-operation-checkpoint-key?grant=');
    expect(db.grantUpdates).toBe(1);
  });
});

const INVALID_ACCESS_BODIES: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a bare string', 'read'],
  ['an array', [{ taskId: CHILD_TASK }]],
  ['an empty object', {}],
  ['a missing taskId', { leaseEpoch: 5, mode: 'read' }],
  ['an empty taskId', { taskId: '', leaseEpoch: 5, mode: 'read' }],
  ['a non-uuid taskId', { taskId: 'not-a-uuid', leaseEpoch: 5, mode: 'read' }],
  ['a numeric taskId', { taskId: 5, leaseEpoch: 5, mode: 'read' }],
  ['a missing mode', { taskId: CHILD_TASK, leaseEpoch: 5 }],
  ['an unknown mode', { taskId: CHILD_TASK, leaseEpoch: 5, mode: 'delete' }],
  ['an uppercase mode', { taskId: CHILD_TASK, leaseEpoch: 5, mode: 'READ' }],
  ['a missing leaseEpoch', { taskId: CHILD_TASK, mode: 'read' }],
  ['a zero leaseEpoch', { taskId: CHILD_TASK, leaseEpoch: 0, mode: 'read' }],
  ['a negative leaseEpoch', { taskId: CHILD_TASK, leaseEpoch: -1, mode: 'read' }],
  ['a fractional leaseEpoch', { taskId: CHILD_TASK, leaseEpoch: 5.5, mode: 'read' }],
  ['a string leaseEpoch', { taskId: CHILD_TASK, leaseEpoch: '5', mode: 'read' }],
  ['a null leaseEpoch', { taskId: CHILD_TASK, leaseEpoch: null, mode: 'read' }],
];

describe('CR28-03 access request body validation', () => {
  it.each(INVALID_ACCESS_BODIES)(
    'rejects %s with 422 before touching the database',
    async (_label, body) => {
      const db = new OfflineArtifactAccessDb();

      await expect(
        makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, body)
      ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
      expect(db.queryCount).toBe(0);
      expect(db.grantUpdates).toBe(0);
    }
  );

  it('FINDING: silently drops unknown body fields, including a caller-supplied tenantId', async () => {
    const db = new OfflineArtifactAccessDb();

    const grant = await makeService(db).requestAccess(SAME_OPERATION_CHECKPOINT, {
      taskId: CHILD_TASK,
      leaseEpoch: 5,
      mode: 'read',
      tenantId: TENANT_B,
      role: 'admin',
    });

    // ArtifactAccessRequestSchema is not .strict(), so tenantId and role are
    // discarded rather than refused. The grant still follows the task's real
    // tenant, so this is a hardening gap, not a live escalation.
    expect(grant.downloadUrl).toContain('/same-operation-checkpoint-key?grant=');
    expect(db.grantUpdates).toBe(1);
    expect(db.artifactIdLookups).toEqual([SAME_OPERATION_CHECKPOINT]);
  });
});
