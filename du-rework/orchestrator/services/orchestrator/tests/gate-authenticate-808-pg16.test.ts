import { createHmac } from 'node:crypto';
import { createDb } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { countUnsealedWithAuth } from '../src/modules/encryption/metadata-auth-counter';

/**
 * GATE-AUTHENTICATE-808 on a REAL PostgreSQL 16 instance.
 *
 * Skipped unless GATE_AUTH_PG_URL is set, so CI needs no database. Run it
 * against a throwaway instance:
 *
 *   GATE_AUTH_PG_URL=postgresql://du:x@127.0.0.1:54396/du_x \
 *     npx jest --runInBand tests/gate-authenticate-808-pg16.test.ts
 *
 * The key provider here is a deterministic stand-in. The REAL provider is
 * Vault, so this run proves the LOGIC, not the production crypto path.
 */

const PG_URL = process.env.GATE_AUTH_PG_URL;
const describePg = PG_URL ? describe : describe.skip;

const KEY_REF = 'gate-auth-808-pg16';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OP_ID = '55555555-5555-4555-8555-555555555555';
const OP_B_ID = '66666666-6666-4666-8666-666666666666';
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'gate-auth-pg16').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}
function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return { keyRef: input.keyRef, keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + version, input.dek.length)).toString('base64') };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + '#' + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}
function openCrypto() {
  return createMetadataCrypto(adaptKeyProviderForMetadata(makeKeyProvider()) as MetadataKeyProvider, KEY_REF);
}
function flipFirstChar(s: string): string {
  const first = s[0] ?? 'A';
  return (first === 'A' ? 'B' : 'A') + s.slice(1);
}

describePg('GATE-AUTHENTICATE-808 on a real PG16', () => {
  jest.setTimeout(120_000);

  test('3 broken envelopes BLOCK the gate (the shape counter would have cleared it)', async () => {
    const db = createDb(PG_URL!);
    try {
      await migrate(db);

      await db.query("INSERT INTO tenants (id, name, state) VALUES ($1,'pg16','ACTIVE')", [TENANT_A]);
      await db.query("INSERT INTO api_keys (id, tenant_id, hash, prefix, status, created_at, updated_at, spending_limit, total_used) VALUES ($1,$2,'h','du_','ACTIVE',now(),now(),100,0)",
        ['33333333-3333-4333-8333-333333333333', TENANT_A]);
      await db.query("INSERT INTO operations (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version, correlation_id, input_ref, submit_artifacts, created_at, updated_at) VALUES ($1,$2,$3,'demo','1.0.0','extract','SUCCEEDED',1,'c','{}'::jsonb,'[]'::jsonb,now(),now())",
        [OP_ID, TENANT_A, '33333333-3333-4333-8333-333333333333']);
      // Five separate tasks, one fixture value each.
      const taskIds: string[] = [];
      for (let i = 1; i <= 5; i += 1) {
        const id = 'aaaaaaaa-0000-4000-8000-00000000000' + i;
        taskIds.push(id);
        await db.query("INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, created_at, updated_at) VALUES ($1,$2,$3,'step','{}'::jsonb,'SUCCEEDED',1,3,0,now(),now())",
          [id, OP_ID, 'extract-' + i]);
      }

      const crypto = openCrypto();
      // Each fixture is sealed under the refId of the row it will live in — the
      // AAD check runs BEFORE decryption, so a fixture bound to a different row
      // would report CONTEXT_MISMATCH and never reach the GCM check.
      const ctxFor = (i: number) => ({ tenantId: TENANT_A, slot: 'tasks.result_ref' as const, refId: taskIds[i]! });

      const valid = await crypto.seal('artifact://valid', ctxFor(0));

      const cFlip = JSON.parse(JSON.stringify(await crypto.seal('artifact://cflip', ctxFor(1)))) as Record<string, unknown>;
      cFlip.ciphertext = flipFirstChar(String(cFlip.ciphertext));

      const tFlip = JSON.parse(JSON.stringify(await crypto.seal('artifact://tflip', ctxFor(2)))) as Record<string, unknown>;
      tFlip.tag = flipFirstChar(String(tFlip.tag));

      // Wrong tenant, right row: the AAD tenant differs => CONTEXT_MISMATCH.
      const wrongTenant = await crypto.seal('artifact://wrong', { tenantId: TENANT_B, slot: 'tasks.result_ref', refId: taskIds[3]! });

      const values = [valid, cFlip, tFlip, wrongTenant].map((v) => JSON.stringify(v));
      values.push('artifact://plaintext');
      for (let i = 0; i < values.length; i += 1) {
        await db.query('UPDATE tasks SET result_ref=$1 WHERE id=$2', [values[i], taskIds[i]]);
      }

      const result = await countUnsealedWithAuth({ db, crypto, expectedTenantIds: [TENANT_A] });

      // Assert on the slot that carries the fixture, plus the whole gate.
      const slot = result.slots.find((s) => s.slot === 'tasks.result_ref');
      expect(slot).toBeDefined();
      expect(slot!.nonNull).toBe(5);
      expect(slot!.shapePass).toBe(4);          // all four envelopes keep the shape
      expect(slot!.sealedValid).toBe(1);        // only the untouched one opens
      expect(slot!.sealedBrokenAuth).toBe(2);   // ciphertext flip + tag flip
      expect(slot!.sealedBrokenContext).toBe(1);// wrong-tenant AAD
      expect(slot!.plaintext).toBe(1);
      expect(slot!.shapePassAuthFail).toBe(3);

      // Whole-run totals: 5 payload_ref + 1 input_ref are also plaintext, so
      // the gate must be blocked well past the three broken envelopes.
      expect(result.totals.sealedValid).toBe(1);
      expect(result.totals.sealedBrokenAuth).toBe(2);
      expect(result.totals.sealedBrokenContext).toBe(1);
      expect(result.blockers).toBe(10);
      expect(result.gate).toBe('FAIL');
    } finally {
      await db.close();
    }
  });

  test('RLS can hide an expected tenant while all eight slot queries succeed; the gate fails closed', async () => {
    const adminDb = createDb(PG_URL!);
    let readerDb: ReturnType<typeof createDb> | undefined;
    try {
      await migrate(adminDb);
      await adminDb.query("INSERT INTO tenants (id, name, state) VALUES ($1,'rls-hidden','ACTIVE') ON CONFLICT (id) DO NOTHING", [TENANT_B]);
      await adminDb.query(
        "INSERT INTO api_keys (id, tenant_id, hash, prefix, status, created_at, updated_at, spending_limit, total_used) VALUES ($1,$2,'gate-cov-b-hash','gate-b','ACTIVE',now(),now(),100,0) ON CONFLICT (id) DO NOTHING",
        ['44444444-4444-4444-8444-444444444444', TENANT_B],
      );
      await adminDb.query(
        "INSERT INTO operations (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version, correlation_id, input_ref, submit_artifacts, created_at, updated_at) VALUES ($1,$2,$3,'demo','1.0.0','extract','SUCCEEDED',1,'rls-b','{}'::jsonb,'[]'::jsonb,now(),now()) ON CONFLICT (id) DO NOTHING",
        [OP_B_ID, TENANT_B, '44444444-4444-4444-8444-444444444444'],
      );

      // The expected list comes from the unrestricted platform connection;
      // the counter runs through the limited role below.
      const expected = await adminDb.query<{ id: string }>('SELECT id::text AS id FROM tenants ORDER BY id');
      const expectedTenantIds = expected.rows.map((row) => row.id);
      expect(expectedTenantIds).toEqual([TENANT_A, TENANT_B]);

      // Make every non-null value visible to the restricted role valid and
      // decryptable. This leaves tenant coverage as the sole reason the fixed
      // gate must fail; the old auth-only gate would have returned PASS.
      const crypto = openCrypto();
      const visibleOperations = await adminDb.query<{ id: string }>(
        'SELECT id::text AS id FROM operations WHERE tenant_id = $1 ORDER BY id',
        [TENANT_A],
      );
      for (const operation of visibleOperations.rows) {
        const sealedInput = await crypto.seal(
          { source: 'coverage-fixture' },
          { tenantId: TENANT_A, slot: 'operations.input_ref', refId: operation.id },
        );
        await adminDb.query('UPDATE operations SET input_ref = $1::jsonb WHERE id = $2', [JSON.stringify(sealedInput), operation.id]);
      }
      const visibleTasks = await adminDb.query<{ id: string }>(
        'SELECT id::text AS id FROM tasks WHERE operation_id = $1 ORDER BY id',
        [OP_ID],
      );
      for (const task of visibleTasks.rows) {
        const sealedPayload = await crypto.seal(
          { source: 'coverage-fixture', taskId: task.id },
          { tenantId: TENANT_A, slot: 'tasks.payload_ref', refId: task.id },
        );
        const sealedResult = await crypto.seal(
          'artifact://coverage-fixture/' + task.id,
          { tenantId: TENANT_A, slot: 'tasks.result_ref', refId: task.id },
        );
        await adminDb.query(
          'UPDATE tasks SET payload_ref = $1::jsonb, result_ref = $2 WHERE id = $3',
          [JSON.stringify(sealedPayload), JSON.stringify(sealedResult), task.id],
        );
      }

      await adminDb.query("DO $$ BEGIN CREATE ROLE gate_cov_817_reader LOGIN PASSWORD 'gatecov817-local' NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$");
      await adminDb.query('GRANT USAGE ON SCHEMA public TO gate_cov_817_reader');
      await adminDb.query('GRANT SELECT ON operations, tasks, human_waits, step_checkpoints TO gate_cov_817_reader');
      await adminDb.query('ALTER TABLE operations ENABLE ROW LEVEL SECURITY');
      await adminDb.query('ALTER TABLE tasks ENABLE ROW LEVEL SECURITY');
      await adminDb.query('ALTER TABLE human_waits ENABLE ROW LEVEL SECURITY');
      await adminDb.query('ALTER TABLE step_checkpoints ENABLE ROW LEVEL SECURITY');
      await adminDb.query('DROP POLICY IF EXISTS gate_cov_817_operations ON operations');
      await adminDb.query('DROP POLICY IF EXISTS gate_cov_817_tasks ON tasks');
      await adminDb.query('DROP POLICY IF EXISTS gate_cov_817_waits ON human_waits');
      await adminDb.query('DROP POLICY IF EXISTS gate_cov_817_checkpoints ON step_checkpoints');
      await adminDb.query(`CREATE POLICY gate_cov_817_operations ON operations TO gate_cov_817_reader USING (tenant_id = '${TENANT_A}'::uuid)`);
      await adminDb.query('CREATE POLICY gate_cov_817_tasks ON tasks TO gate_cov_817_reader USING (EXISTS (SELECT 1 FROM operations o WHERE o.id = tasks.operation_id))');
      await adminDb.query('CREATE POLICY gate_cov_817_waits ON human_waits TO gate_cov_817_reader USING (EXISTS (SELECT 1 FROM operations o WHERE o.id = human_waits.operation_id))');
      await adminDb.query('CREATE POLICY gate_cov_817_checkpoints ON step_checkpoints TO gate_cov_817_reader USING (EXISTS (SELECT 1 FROM tasks t WHERE t.id = step_checkpoints.task_id))');

      const readerUrl = new URL(PG_URL!);
      readerUrl.username = 'gate_cov_817_reader';
      readerUrl.password = 'gatecov817-local';
      readerDb = createDb(readerUrl.toString());
      const visibleTenantRows = await readerDb.query('SELECT tenant_id::text AS tenant_id FROM operations');
      expect(visibleTenantRows.rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);

      const result = await countUnsealedWithAuth({
        db: readerDb,
        crypto: openCrypto(),
        expectedTenantIds,
      });

      expect(result.coverage.slotsExpected).toBe(8);
      expect(result.coverage.slotQueriesAttempted).toBe(8);
      expect(result.coverage.slotQueriesSucceeded).toBe(8);
      expect(result.coverage.slotsRead).toBe(8);
      expect(result.coverage.slotsScanned).toBe(8);
      expect(result.coverage.tenantsSeen).toBe(1);
      expect(result.coverage.observedTenantIds).toEqual([TENANT_A]);
      expect(result.coverage.missingTenantIds).toEqual([TENANT_B]);
      expect(result.blockers).toBe(0);
      expect(result.coverage.valuesAuthenticated).toBe(11);
      expect(result.coverage.emptySlots.length).toBeGreaterThan(0);
      expect(result.coverage.complete).toBe(false);
      expect(result.coverage.reasons.join(' ')).toMatch(/RLS\/policy filtering/);
      expect(result.gate).toBe('FAIL');
    } finally {
      await readerDb?.close();
      await adminDb.close();
    }
  });
});
