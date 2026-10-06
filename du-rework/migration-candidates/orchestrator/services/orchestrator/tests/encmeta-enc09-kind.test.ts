import {
  ENC09_PAYLOAD_KINDS,
  backfillLegacyPayloads,
  createBoundedDualReadWindow,
  inventoryPlaintextPayloads,
  isResultRefPayloadKind,
  restoreLegacyPayload,
  ResultRefPayloadCodec,
  ResultRefPgMigrationStore,
  RESULT_REF_PAYLOAD_KINDS,
  type ResultRefSealContext,
  type ResultRefSealer,
} from '../src/modules/encryption/legacy-payload-migration';

/**
 * ENCMETA-ENC09-KIND — register `result_ref` in the ENC-09 inventory and drive
 * the new PG-backed store through the existing inventory -> lock/CAS -> seal ->
 * verify-readback -> commit flow, offline against a fake pg.
 *
 * The fake sealer is a reversible transform with an AAD binding, so it
 * reproduces the property that matters: an envelope sealed under one
 * `(tenant, slot, refId)` cannot be opened under another.
 */

const SENTINEL = 'ENC-ENC09-KIND-9f2c';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OP_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const TS = '2026-01-01T00:00:00.000Z';

interface FakeEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyRef: string;
  dek: Record<string, unknown>;
  nonce: string;
  tag: string;
  aad: string;
  ciphertext: string;
}

function aadFor(context: ResultRefSealContext): string {
  return Buffer.from(`${context.tenantId}|${context.slot}|${context.refId}`, 'utf8').toString('base64');
}

class FakeSealer implements ResultRefSealer {
  sealCount = 0;
  async seal(value: unknown, context: ResultRefSealContext): Promise<Record<string, unknown>> {
    this.sealCount += 1;
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      keyRef: 'test-key',
      dek: { version: 1 },
      nonce: 'n',
      tag: 't',
      aad: aadFor(context),
      ciphertext: Buffer.from(JSON.stringify(value ?? null), 'utf8').toString('base64'),
    };
  }
  async open(sealed: unknown, context: ResultRefSealContext): Promise<unknown> {
    const env = sealed as FakeEnvelope;
    if (env.aad !== aadFor(context)) throw new Error('CONTEXT_MISMATCH');
    return JSON.parse(Buffer.from(env.ciphertext, 'base64').toString('utf8'));
  }
  isSealed(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const env = value as Partial<FakeEnvelope>;
    return env.version === 1 && env.algorithm === 'aes-256-gcm' && typeof env.ciphertext === 'string';
  }
}

interface OpRow { id: string; tenantId: string; ref: string | null; updatedAt: string }
interface TaskRow { id: string; operationId: string; ref: string | null; updatedAt: string }

class FakePg {
  ops = new Map<string, OpRow>();
  tasks = new Map<string, TaskRow>();
  writes: { sql: string; params: unknown[] }[] = [];
  failNextUpdate = false;

  private opRow(r: OpRow) { return { id: r.id, tenant_id: r.tenantId, result_ref: r.ref, updated_at: r.updatedAt }; }
  private taskRow(r: TaskRow, op: OpRow) { return { id: r.id, tenant_id: op.tenantId, result_ref: r.ref, updated_at: r.updatedAt }; }

  query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    const t = String(sql).replace(/\s+/g, ' ').trim();
    const out = (rows: Record<string, unknown>[]) => Promise.resolve({ rows, rowCount: rows.length });
    // Every UPDATE is recorded; the fake applies it only when the CAS below
    // matches, so a refused commit leaves the row byte-identical.
    if (t.startsWith('UPDATE ')) this.writes.push({ sql: t, params });

    if (/^UPDATE operations SET result_ref = \$2, updated_at = now\(\) WHERE id = \$1 AND updated_at = \$3$/.test(t)) {
      const [id, stored, updatedAt] = params as [string, string, string];
      const row = this.ops.get(id);
      if (this.failNextUpdate || !row || row.updatedAt !== updatedAt) {
        this.failNextUpdate = false;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      row.ref = stored;
      row.updatedAt = new Date().toISOString();
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/^UPDATE tasks SET result_ref = \$2, updated_at = now\(\) WHERE id = \$1 AND updated_at = \$3$/.test(t)) {
      const [id, stored, updatedAt] = params as [string, string, string];
      const row = this.tasks.get(id);
      if (this.failNextUpdate || !row || row.updatedAt !== updatedAt) {
        this.failNextUpdate = false;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      row.ref = stored;
      row.updatedAt = new Date().toISOString();
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/^UPDATE operations SET result_ref = \$2, updated_at = now\(\) WHERE id = \$1 AND result_ref = \$3$/.test(t)) {
      const [id, original, current] = params as [string, string, string];
      const row = this.ops.get(id);
      if (!row || row.ref !== current) return Promise.resolve({ rows: [], rowCount: 0 });
      row.ref = original;
      row.updatedAt = new Date().toISOString();
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/^UPDATE tasks SET result_ref = \$2, updated_at = now\(\) WHERE id = \$1 AND result_ref = \$3$/.test(t)) {
      const [id, original, current] = params as [string, string, string];
      const row = this.tasks.get(id);
      if (!row || row.ref !== current) return Promise.resolve({ rows: [], rowCount: 0 });
      row.ref = original;
      row.updatedAt = new Date().toISOString();
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/^SELECT o\.id, o\.tenant_id AS tenant_id, o\.result_ref AS result_ref, o\.updated_at AS updated_at FROM operations o\s+WHERE o\.result_ref IS NOT NULL AND o\.id = \$1 FOR UPDATE$/.test(t)) {
      const row = this.ops.get(params[0] as string);
      return out(row && row.ref !== null ? [this.opRow(row)] : []);
    }
    if (/^SELECT t\.id, o\.tenant_id AS tenant_id, t\.result_ref AS result_ref, t\.updated_at AS updated_at FROM tasks t JOIN operations o ON o\.id = t\.operation_id WHERE t\.result_ref IS NOT NULL AND t\.id = \$1 FOR UPDATE OF t$/.test(t)) {
      const row = this.tasks.get(params[0] as string);
      const op = row ? this.ops.get(row.operationId) : undefined;
      return out(row && op && row.ref !== null ? [this.taskRow(row, op)] : []);
    }
    if (/^SELECT o\.id AS id, o\.tenant_id AS tenant_id, o\.result_ref AS result_ref, o\.updated_at AS updated_at FROM operations o\s+WHERE o\.result_ref IS NOT NULL$/.test(t)) {
      return out([...this.ops.values()].filter((r) => r.ref !== null).map((r) => this.opRow(r)));
    }
    if (/^SELECT t\.id AS id, o\.tenant_id AS tenant_id, t\.result_ref AS result_ref, t\.updated_at AS updated_at FROM tasks t JOIN operations o ON o\.id = t\.operation_id WHERE t\.result_ref IS NOT NULL$/.test(t)) {
      return out(
        [...this.tasks.values()]
          .filter((r) => r.ref !== null)
          .map((r) => this.taskRow(r, this.ops.get(r.operationId)!))
          .filter((r) => r.tenant_id !== undefined),
      );
    }
    throw new Error('unexpected SQL: ' + t);
  }

  tx<T>(fn: (client: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }) => Promise<T>): Promise<T> {
    return fn({ query: (s, p) => this.query(s, p) });
  }
}

function seed(pg: FakePg): void {
  pg.ops.set(OP_ID, { id: OP_ID, tenantId: TENANT_A, ref: `artifact://${SENTINEL}`, updatedAt: TS });
  pg.tasks.set(TASK_ID, { id: TASK_ID, operationId: OP_ID, ref: `artifact://${SENTINEL}`, updatedAt: TS });
}

function store(pg: FakePg, sealer: ResultRefSealer, window?: ReturnType<typeof createBoundedDualReadWindow>) {
  return new ResultRefPgMigrationStore({ db: pg as never, sealer, window });
}

describe('ENCMETA-ENC09-KIND: result_ref registered in the ENC-09 inventory', () => {
  test('both result_ref columns are payload kinds, and the kind equals the slot', () => {
    expect(ENC09_PAYLOAD_KINDS).toContain('operations.result_ref');
    expect(ENC09_PAYLOAD_KINDS).toContain('tasks.result_ref');
    expect(RESULT_REF_PAYLOAD_KINDS).toEqual(['operations.result_ref', 'tasks.result_ref']);
    for (const kind of RESULT_REF_PAYLOAD_KINDS) {
      expect(isResultRefPayloadKind(kind)).toBe(true);
      // kind === slot is what keeps the reader's AAD and the store's kind aligned.
      expect(kind).toContain('.result_ref');
    }
    expect(isResultRefPayloadKind('artifact')).toBe(false);
    expect(isResultRefPayloadKind('result_ref')).toBe(false);
  });

  test('a scanner covering both kinds reports no uncovered scope', async () => {
    const report = await inventoryPlaintextPayloads([{
      name: 'postgres-result-ref',
      covers: [...RESULT_REF_PAYLOAD_KINDS],
      async scan() {
        return [{
          payloadId: 'operations.result_ref:' + OP_ID,
          tenantId: TENANT_A,
          payloadKind: 'operations.result_ref',
          storage: 'postgres',
          objectVersion: 'v1',
          classification: 'plaintext',
          sizeBytes: 10,
          sha256: 'a'.repeat(64),
          referenceCount: 1,
        }];
      },
    }]);
    // The two result_ref kinds are covered; the OTHER eight are not, because
    // this scanner only enumerates the result_ref family.
    expect(report.coveredKinds).toEqual(RESULT_REF_PAYLOAD_KINDS);
    expect(report.uncoveredKinds).not.toContain('operations.result_ref');
    expect(report.uncoveredKinds).not.toContain('tasks.result_ref');
    expect(report.uncoveredKinds).toContain('artifact');
    expect(report.plaintextPayloads).toBe(1);
  });
});

describe('ENCMETA-ENC09-KIND: PG-backed store through the migration flow', () => {
  test('inventory classifies plaintext rows and counts unresolved references', async () => {
    const pg = new FakePg();
    seed(pg);
    // A null ref must not be counted as a payload at all.
    pg.ops.set('55555555-5555-4555-8555-555555555555', {
      id: '55555555-5555-4555-8555-555555555555',
      tenantId: TENANT_A,
      ref: null,
      updatedAt: TS,
    });
    const counts = await store(pg, new FakeSealer()).inventory();
    expect(counts).toEqual({ plaintextPayloads: 2, encryptedPayloads: 0, unresolvedPayloads: 0, unresolvedReferences: 2 });
  });

  test('backfill seals BOTH columns under the exact reader context and round-trips', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const result = await backfillLegacyPayloads(store(pg, sealer), new ResultRefPayloadCodec(sealer));

    expect(result.state).toBe('complete');
    expect(result.migratedPayloads).toBe(2);
    expect(result.failedPayloads).toBe(0);
    expect(result.unresolvedReferences).toBe(0);

    const opEnvelope = JSON.parse(pg.ops.get(OP_ID)!.ref!) as FakeEnvelope;
    expect(opEnvelope.algorithm).toBe('aes-256-gcm');
    expect(await sealer.open(opEnvelope, { tenantId: TENANT_A, slot: 'operations.result_ref', refId: OP_ID }))
      .toBe(`artifact://${SENTINEL}`);
    const taskEnvelope = JSON.parse(pg.tasks.get(TASK_ID)!.ref!) as FakeEnvelope;
    expect(await sealer.open(taskEnvelope, { tenantId: TENANT_A, slot: 'tasks.result_ref', refId: TASK_ID }))
      .toBe(`artifact://${SENTINEL}`);
  });

  test('an envelope sealed under the WRONG context cannot be opened by the reader', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    await backfillLegacyPayloads(store(pg, sealer), new ResultRefPayloadCodec(sealer));
    const env = JSON.parse(pg.ops.get(OP_ID)!.ref!) as FakeEnvelope;
    await expect(
      sealer.open(env, { tenantId: TENANT_A, slot: 'operations.result_ref', refId: TASK_ID }),
    ).rejects.toThrow('CONTEXT_MISMATCH');
    await expect(
      sealer.open(env, { tenantId: TENANT_A, slot: 'tasks.result_ref', refId: OP_ID }),
    ).rejects.toThrow('CONTEXT_MISMATCH');
    await expect(
      sealer.open(env, { tenantId: TENANT_B, slot: 'operations.result_ref', refId: OP_ID }),
    ).rejects.toThrow('CONTEXT_MISMATCH');
  });

  test('idempotent: a second run verifies instead of re-sealing', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const codec = new ResultRefPayloadCodec(sealer);
    await backfillLegacyPayloads(store(pg, sealer), codec);
    const firstWrites = pg.writes.length;
    const second = await backfillLegacyPayloads(store(pg, sealer), codec);
    expect(second.migratedPayloads).toBe(0);
    expect(second.verifiedPayloads).toBe(2);
    expect(second.state).toBe('complete');
    expect(pg.writes.length).toBe(firstWrites);
  });

  test('FAIL PATH: a CAS conflict leaves the row untouched (zero partial writes)', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    pg.failNextUpdate = true;
    const result = await backfillLegacyPayloads(store(pg, sealer), new ResultRefPayloadCodec(sealer));
    expect(result.issues.some((i) => i.code === 'MIGRATION_COMMIT_CONFLICT')).toBe(true);
    // The row whose CAS was refused is byte-identical to before: no partial write.
    expect(pg.ops.get(OP_ID)!.ref).toBe(`artifact://${SENTINEL}`);
    // The other row was not the one refused, so it migrated normally.
    expect(JSON.parse(pg.tasks.get(TASK_ID)!.ref!).algorithm).toBe('aes-256-gcm');
  });

  test('FAIL PATH: an envelope that cannot open is unresolved and blocks retirement', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const wrong = await sealer.seal(`artifact://${SENTINEL}`, {
      tenantId: TENANT_B,
      slot: 'operations.result_ref',
      refId: OP_ID,
    });
    pg.ops.get(OP_ID)!.ref = JSON.stringify(wrong);

    const result = await backfillLegacyPayloads(store(pg, sealer), new ResultRefPayloadCodec(sealer));
    expect(result.state).toBe('incomplete');
    expect(result.unresolvedReferences).toBeGreaterThan(0);
    const after = await store(pg, sealer).inventory();
    expect(after.unresolvedPayloads).toBe(1);
  });

  test('restore returns a sealed row to its exact original plaintext', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const codec = new ResultRefPayloadCodec(sealer);
    await backfillLegacyPayloads(store(pg, sealer), codec);
    const restored = await restoreLegacyPayload(store(pg, sealer), codec, 'operations.result_ref:' + OP_ID);
    expect(restored.state).toBe('restored');
    expect(pg.ops.get(OP_ID)!.ref).toBe(`artifact://${SENTINEL}`);
    expect(JSON.parse(pg.tasks.get(TASK_ID)!.ref!).algorithm).toBe('aes-256-gcm');
  });

  test('restore on an already-legacy row is a no-op', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const result = await restoreLegacyPayload(
      store(pg, sealer), new ResultRefPayloadCodec(sealer), 'operations.result_ref:' + OP_ID,
    );
    expect(result.state).toBe('already_legacy');
  });
});

describe('ENCMETA-ENC09-KIND: the 14-day bounded window', () => {
  test('a window longer than 14 days is refused', () => {
    expect(() => createBoundedDualReadWindow(0, 14 * 24 * 60 * 60 * 1000 + 1)).toThrow(/14 days/i);
  });

  test('the store refuses to run once its window has closed', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const closed = createBoundedDualReadWindow(0, 1_000);
    const result = await backfillLegacyPayloads(store(pg, sealer, closed), new ResultRefPayloadCodec(sealer));
    expect(result.state).toBe('incomplete');
    expect(result.issues[0]?.code).toBe('MIGRATION_STORE_UNAVAILABLE');
    expect(pg.writes.length).toBe(0);
  });

  test('the store runs normally inside an open window', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const now = Date.now();
    const open = createBoundedDualReadWindow(now, now + 60_000);
    const result = await backfillLegacyPayloads(store(pg, sealer, open), new ResultRefPayloadCodec(sealer));
    expect(result.state).toBe('complete');
    expect(pg.writes.length).toBeGreaterThan(0);
  });
});

describe('ENCMETA-ENC09-KIND: count-only safety', () => {
  test('the migration report and the store writes carry no ref value', async () => {
    const pg = new FakePg();
    seed(pg);
    const sealer = new FakeSealer();
    const result = await backfillLegacyPayloads(store(pg, sealer), new ResultRefPayloadCodec(sealer));
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain('artifact://');
    for (const write of pg.writes) {
      expect(JSON.stringify(write.params)).not.toContain(SENTINEL);
    }
  });
});