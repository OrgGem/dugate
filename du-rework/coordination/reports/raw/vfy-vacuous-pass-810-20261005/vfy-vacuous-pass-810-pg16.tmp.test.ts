import { createHmac } from 'node:crypto';
import { createDb } from '../src/db/db';
import { migrate } from '../src/db/migrations';
import {
  countUnsealedWithAuth,
  METADATA_AUTH_SLOT_SPECS,
} from '../src/modules/encryption/metadata-auth-counter';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import {
  createMetadataCrypto,
  type MetadataCrypto,
  type MetadataKeyProvider,
} from '../src/modules/runtime/metadata-crypto';
import type { Db } from '../src/db/db';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';

const PG_URL = process.env.GATE_AUTH_PG_URL;
if (!PG_URL) throw new Error('GATE_AUTH_PG_URL must point to the task-owned disposable PG16 only.');

const KEY_REF = 'vfy-vacuous-pass-810';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const API_A = '33333333-3333-4333-8333-333333333333';
const API_B = '44444444-4444-4444-8444-444444444444';
const OP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OP_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OP_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function keystream(seed: string, length: number): Buffer {
  const output = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'synthetic-vfy810-key').update(seed + ':' + block).digest();
    digest.copy(output, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return output;
}
function xor(input: Buffer, stream: Buffer): Buffer {
  const output = Buffer.alloc(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = (input[index] ?? 0) ^ (stream[index] ?? 0);
  }
  return output;
}
function makeKeyProvider(failUnwrap = false): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + version, input.dek.length)).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      if (failUnwrap) throw new Error('synthetic key-provider outage');
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + '#' + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}
function openCrypto(failUnwrap = false): MetadataCrypto {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(makeKeyProvider(failUnwrap)) as MetadataKeyProvider,
    KEY_REF,
  );
}

let db: Db;
beforeAll(async () => {
  db = createDb(PG_URL!);
  const version = await db.query("SELECT current_setting('server_version_num') AS value");
  expect(Number(version.rows[0]?.value)).toBeGreaterThanOrEqual(160000);
  await migrate(db);
}, 120_000);
afterAll(async () => { if (db) await db.close(); });
jest.setTimeout(120_000);

async function seedTenantAndApiKey(tenantId: string, apiKeyId: string, suffix: string): Promise<void> {
  await db.query("INSERT INTO tenants (id, name, state) VALUES ($1, $2, 'ACTIVE') ON CONFLICT (id) DO NOTHING", [
    tenantId, 'vfy810-' + suffix,
  ]);
  await db.query(
    "INSERT INTO api_keys (id, tenant_id, hash, prefix, status, created_at, updated_at, spending_limit, total_used) "
      + "VALUES ($1,$2,$3,$4,'ACTIVE',now(),now(),100,0) ON CONFLICT (id) DO NOTHING",
    [apiKeyId, tenantId, 'vfy810-hash-' + suffix, 'du_vfy810_' + suffix],
  );
}
async function seedOperation(input: {
  operationId: string;
  tenantId: string;
  apiKeyId: string;
  inputRef: unknown;
  resultRef: string;
}): Promise<void> {
  await db.query(
    "INSERT INTO operations (id, tenant_id, api_key_id, business_id, business_version, action, state, "
      + "state_version, correlation_id, input_ref, result_ref, submit_artifacts, created_at, updated_at) "
      + "VALUES ($1,$2,$3,'vfy810','1.0.0','extract','SUCCEEDED',1,$4,$5::jsonb,$6,'[]'::jsonb,now(),now())",
    [input.operationId, input.tenantId, input.apiKeyId, 'corr-' + input.operationId, JSON.stringify(input.inputRef), input.resultRef],
  );
}
function observedDb(realDb: Db, queries: string[]): Db {
  return {
    query: async (sql: string) => {
      queries.push(sql);
      return realDb.query(sql);
    },
  } as unknown as Db;
}

describe('VFY-VACUOUS-PASS-810 on task-owned PostgreSQL 16', () => {
  test('empty migrated database, no crypto seam: reports PASS with zero values authenticated', async () => {
    const queries: string[] = [];
    const result = await countUnsealedWithAuth({ db: observedDb(db, queries), crypto: undefined });
    expect(queries).toHaveLength(8);
    expect(result.slots).toHaveLength(8);
    expect(result.slots.every((slot) => slot.nonNull === 0)).toBe(true);
    expect(result.totals.nonNull).toBe(0);
    expect(result.totals.sealedValid).toBe(0);
    expect(result.blockers).toBe(0);
    expect(result.gate).toBe('PASS');
    expect(result).not.toHaveProperty('slotsRead');
    expect(result).not.toHaveProperty('slotsScanned');
    expect(result).not.toHaveProperty('valuesAuthenticated');
    expect(result).not.toHaveProperty('tenantCoverage');
    console.log('VFY810_EMPTY_NO_SEAM ' + JSON.stringify({
      gate: result.gate,
      blockers: result.blockers,
      observedSlotsRead: queries.length,
      observedSlotsScanned: result.slots.length,
      observedValuesAuthenticated: result.totals.sealedValid,
      valuesSeen: result.totals.nonNull,
      returnedFields: Object.keys(result),
    }));
  });

  test('non-metadata tenant and API-key data with all eight slots empty still reports PASS', async () => {
    await seedTenantAndApiKey(TENANT_A, API_A, 'unrelated');
    const census = await db.query(
      'SELECT (SELECT count(*) FROM tenants)::int AS tenant_count, '
        + '(SELECT count(*) FROM api_keys)::int AS api_key_count',
    );
    const queries: string[] = [];
    const result = await countUnsealedWithAuth({ db: observedDb(db, queries), crypto: undefined });
    expect(Number(census.rows[0]?.tenant_count)).toBe(1);
    expect(Number(census.rows[0]?.api_key_count)).toBe(1);
    expect(queries).toHaveLength(8);
    expect(result.slots.every((slot) => slot.nonNull === 0)).toBe(true);
    expect(result.totals.nonNull).toBe(0);
    expect(result.totals.sealedValid).toBe(0);
    expect(result.gate).toBe('PASS');
    console.log('VFY810_UNRELATED_ROWS_ALL_SLOTS_EMPTY ' + JSON.stringify({
      tenantRows: Number(census.rows[0]?.tenant_count),
      apiKeyRows: Number(census.rows[0]?.api_key_count),
      observedSlotsRead: queries.length,
      valuesSeenAcrossSlots: result.totals.nonNull,
      valuesAuthenticated: result.totals.sealedValid,
      blockers: result.blockers,
      gate: result.gate,
    }));
  });

  test('one hidden tenant produces a cross-tenant false PASS under RLS', async () => {
    const crypto = openCrypto();
    await seedTenantAndApiKey(TENANT_A, API_A, 'tenant-a');
    await seedTenantAndApiKey(TENANT_B, API_B, 'tenant-b');
    const inputA = await crypto.seal('synthetic-a-input', { tenantId: TENANT_A, slot: 'operations.input_ref', refId: OP_A });
    const resultA = await crypto.seal('synthetic-a-result', { tenantId: TENANT_A, slot: 'operations.result_ref', refId: OP_A });
    const inputB = await crypto.seal('synthetic-b-input', { tenantId: TENANT_B, slot: 'operations.input_ref', refId: OP_B });
    await seedOperation({
      operationId: OP_A, tenantId: TENANT_A, apiKeyId: API_A,
      inputRef: inputA, resultRef: JSON.stringify(resultA),
    });
    await seedOperation({
      operationId: OP_B, tenantId: TENANT_B, apiKeyId: API_B,
      inputRef: inputB, resultRef: 'artifact://synthetic-plaintext-hidden-in-other-tenant',
    });

    await db.query("CREATE ROLE vfy810_reader LOGIN PASSWORD 'vfy810-reader-synthetic' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    await db.query('GRANT USAGE ON SCHEMA public TO vfy810_reader');
    await db.query('GRANT SELECT ON operations, tasks, human_waits, step_checkpoints TO vfy810_reader');
    await db.query('ALTER TABLE operations ENABLE ROW LEVEL SECURITY');
    await db.query('ALTER TABLE operations FORCE ROW LEVEL SECURITY');
    await db.query(
      "CREATE POLICY vfy810_reader_only_a ON operations FOR SELECT TO vfy810_reader "
        + "USING (tenant_id = '" + TENANT_A + "'::uuid)",
    );

    const adminVisible = await db.query('SELECT count(*)::int AS visible_operations FROM operations');
    expect(Number(adminVisible.rows[0]?.visible_operations)).toBe(2);
    const adminResult = await countUnsealedWithAuth({ db, crypto });
    expect(adminResult.gate).toBe('FAIL');
    expect(adminResult.totals.nonNull).toBe(4);
    expect(adminResult.totals.sealedValid).toBe(3);
    expect(adminResult.totals.plaintext).toBe(1);
    expect(adminResult.blockers).toBe(1);

    const readerUrl = new URL(PG_URL!);
    readerUrl.username = 'vfy810_reader';
    readerUrl.password = 'vfy810-reader-synthetic';
    const readerDb = createDb(readerUrl.toString());
    try {
      const visible = await readerDb.query('SELECT count(*)::int AS visible_operations FROM operations');
      const queries: string[] = [];
      const readerResult = await countUnsealedWithAuth({ db: observedDb(readerDb, queries), crypto });
      expect(Number(visible.rows[0]?.visible_operations)).toBe(1);
      expect(queries).toHaveLength(8);
      expect(readerResult.totals.sealedValid).toBe(2);
      expect(readerResult.totals.plaintext).toBe(0);
      expect(readerResult.blockers).toBe(0);
      expect(readerResult.gate).toBe('PASS');
      console.log('VFY810_RLS_HIDDEN_TENANT ' + JSON.stringify({
        aggregateAdminVisibleOperations: Number(adminVisible.rows[0]?.visible_operations),
        aggregateRestrictedVisibleOperations: Number(visible.rows[0]?.visible_operations),
        adminGate: adminResult.gate,
        adminBlockers: adminResult.blockers,
        restrictedSlotsRead: queries.length,
        restrictedValuesAuthenticated: readerResult.totals.sealedValid,
        restrictedValuesSeen: readerResult.totals.nonNull,
        restrictedGate: readerResult.gate,
      }));
    } finally {
      await readerDb.close();
    }
    await db.query('DELETE FROM operations');
  });

  test('removing one slot is rejected before any query', async () => {
    const queries: string[] = [];
    const fakeDb = {
      query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; },
    } as unknown as Db;
    const incomplete = METADATA_AUTH_SLOT_SPECS.filter((slot) => slot.slot !== 'operations.result_ref');
    await expect(countUnsealedWithAuth({ db: fakeDb, crypto: openCrypto(), specs: incomplete }))
      .rejects.toThrow(/must be exactly the 8 METADATA_SLOTS/);
    expect(queries).toHaveLength(0);
    console.log('VFY810_MISSING_SLOT ' + JSON.stringify({
      expectedSlots: METADATA_AUTH_SLOT_SPECS.length,
      suppliedSlots: incomplete.length,
      queryCallsBeforeError: queries.length,
      gateResult: 'ERROR',
    }));
  });

  test('a reader throw is counted as a blocker and gate FAIL', async () => {
    await seedTenantAndApiKey(TENANT_A, API_A, 'reader-throw');
    const baseCrypto = openCrypto();
    const input = await baseCrypto.seal('synthetic-input', { tenantId: TENANT_A, slot: 'operations.input_ref', refId: OP_C });
    const resultRef = await baseCrypto.seal('synthetic-result', { tenantId: TENANT_A, slot: 'operations.result_ref', refId: OP_C });
    await seedOperation({
      operationId: OP_C, tenantId: TENANT_A, apiKeyId: API_A,
      inputRef: input, resultRef: JSON.stringify(resultRef),
    });
    const throwingCrypto: MetadataCrypto = {
      ...baseCrypto,
      async readStored(value, context, allowPlaintext) {
        if (context.slot === 'operations.result_ref') throw new Error('synthetic reader throw');
        return baseCrypto.readStored(value, context, allowPlaintext);
      },
    };
    const result = await countUnsealedWithAuth({ db, crypto: throwingCrypto });
    expect(result.totals.sealedValid).toBe(1);
    expect(result.totals.sealedBrokenOther).toBe(1);
    expect(result.blockers).toBe(1);
    expect(result.gate).toBe('FAIL');
    console.log('VFY810_READER_THROW ' + JSON.stringify({
      sealedValid: result.totals.sealedValid,
      sealedBrokenOther: result.totals.sealedBrokenOther,
      blockers: result.blockers,
      gate: result.gate,
    }));
    await db.query('DELETE FROM operations');
  });

  test('key-provider failure is typed by the crypto seam and blocks the gate', async () => {
    await seedTenantAndApiKey(TENANT_A, API_A, 'provider-error');
    const goodCrypto = openCrypto();
    const input = await goodCrypto.seal('synthetic-input', { tenantId: TENANT_A, slot: 'operations.input_ref', refId: OP_D });
    const resultRef = await goodCrypto.seal('synthetic-result', { tenantId: TENANT_A, slot: 'operations.result_ref', refId: OP_D });
    await seedOperation({
      operationId: OP_D, tenantId: TENANT_A, apiKeyId: API_A,
      inputRef: input, resultRef: JSON.stringify(resultRef),
    });
    const failingCrypto = openCrypto(true);
    await expect(failingCrypto.readStored(input, {
      tenantId: TENANT_A, slot: 'operations.input_ref', refId: OP_D,
    }, false)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    const result = await countUnsealedWithAuth({ db, crypto: failingCrypto });
    expect(result.totals.sealedBrokenOther).toBe(2);
    expect(result.blockers).toBe(2);
    expect(result.gate).toBe('FAIL');
    console.log('VFY810_KEY_PROVIDER_ERROR ' + JSON.stringify({
      errorCode: 'KEY_PROVIDER_FAILED',
      sealedBrokenOther: result.totals.sealedBrokenOther,
      blockers: result.blockers,
      gate: result.gate,
    }));
    await db.query('DELETE FROM operations');
  });

  test('one slot query throwing rejects without returning a vacuous gate status', async () => {
    let queryCalls = 0;
    const queryFailDb = {
      query: async (sql: string) => {
        queryCalls += 1;
        if (sql.includes('FROM step_checkpoints sc')) throw new Error('synthetic slot query failure');
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Db;
    await expect(countUnsealedWithAuth({ db: queryFailDb, crypto: openCrypto() }))
      .rejects.toThrow('synthetic slot query failure');
    expect(queryCalls).toBe(4);
    console.log('VFY810_SLOT_QUERY_ERROR ' + JSON.stringify({
      successfulQueriesBeforeFailure: queryCalls - 1,
      failingQueryNumber: queryCalls,
      returnedGate: false,
      outcome: 'ERROR',
    }));
  });
});