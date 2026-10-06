import { createHmac } from 'node:crypto';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import {
  countUnsealedWithAuth,
  shapeOnlyCounts,
} from '../src/modules/encryption/metadata-auth-counter';
import type { Db } from '../src/db/db';

/**
 * GATE-AUTHENTICATE-808 (A11) — the shape predicate false-passes a broken
 * envelope. The tester showed: 1 valid envelope + 3 broken ones (all keeping
 * the shape) => shape counter said 4 sealed, the real reader failed on 3, and
 * the SQL still reported GATE PASSES.
 *
 * This suite pins the fix: every shape-passing row is AUTHENTICATED with the
 * real `readStored`, and a shape-pass-but-auth-fail row blocks the gate exactly
 * like plaintext.
 */

const KEY_REF = 'gate-auth-808';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/* Reversible Vault Transit stand-in (same shape as the crx01 seam suites). */
function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'gate-auth-double').update(seed + ':' + block).digest();
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
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + version, input.dek.length)).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + '#' + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}
function openCrypto() {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(makeKeyProvider()) as MetadataKeyProvider,
    KEY_REF,
  );
}

/** Flip one base64 character so the decoded bytes definitely change. */
function flipFirstChar(s: string): string {
  const first = s[0] ?? 'A';
  return (first === 'A' ? 'B' : 'A') + s.slice(1);
}

const TASK_ROW_SQL =
  /SELECT o\.tenant_id AS tenant_id, t\.id AS ref_id, t\.result_ref AS value FROM tasks t JOIN operations o ON o\.id = t\.operation_id/;

function fakeDb(rows: { tenant_id: string; ref_id: string; value: unknown }[]): Db {
  return {
    pool: undefined,
    // The fixture lives in tasks.result_ref only. BA-05 requires the gate to
    // scan all eight slots, so every other slot must answer EMPTY rather than
    // echoing the fixture.
    query: async (text: string) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (TASK_ROW_SQL.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
    tx: async () => { throw new Error('counter must not open a transaction'); },
    close: async () => undefined,
  } as unknown as Db;
}

async function buildFixture(): Promise<{ tenant_id: string; ref_id: string; value: unknown }[]> {
  const crypto = openCrypto();
  const valid = await crypto.seal('artifact://valid', { tenantId: TENANT_A, slot: 'tasks.result_ref', refId: TASK_ID });
  const ctx = { tenantId: TENANT_A, slot: 'tasks.result_ref' as const, refId: TASK_ID };

  const ciphertextFlip = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  ciphertextFlip.ciphertext = flipFirstChar(String(ciphertextFlip.ciphertext));

  const tagFlip = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
  tagFlip.tag = flipFirstChar(String(tagFlip.tag));

  const wrongTenant = await crypto.seal('artifact://wrong-tenant', {
    tenantId: TENANT_B, slot: 'tasks.result_ref', refId: TASK_ID,
  });

  // Sanity: the valid one really opens under ctx before we hand it to the counter.
  await expect(crypto.readStored(valid, ctx, false)).resolves.toBe('artifact://valid');

  return [
    { tenant_id: TENANT_A, ref_id: TASK_ID, value: JSON.stringify(valid) },
    { tenant_id: TENANT_A, ref_id: TASK_ID, value: JSON.stringify(ciphertextFlip) },
    { tenant_id: TENANT_A, ref_id: TASK_ID, value: JSON.stringify(tagFlip) },
    { tenant_id: TENANT_A, ref_id: TASK_ID, value: JSON.stringify(wrongTenant) },
    { tenant_id: TENANT_A, ref_id: TASK_ID, value: 'artifact://plaintext' },
  ];
}

describe('GATE-AUTHENTICATE-808: shape-pass rows are authenticated, not trusted', () => {
  test('1 valid + 3 broken + 1 plaintext => gate FAILS, and names the three breaks', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({
      db: fakeDb(rows),
      crypto: openCrypto(),
      expectedTenantIds: [TENANT_A],
    });

    expect(result.totals.nonNull).toBe(5);
    expect(result.totals.shapePass).toBe(4);      // all four envelopes keep the shape
    expect(result.totals.sealedValid).toBe(1);    // only the untouched one opens
    expect(result.totals.sealedBrokenAuth).toBe(2);    // ciphertext flip + tag flip
    expect(result.totals.sealedBrokenContext).toBe(1); // wrong-tenant AAD
    expect(result.totals.plaintext).toBe(1);
    expect(result.totals.shapePassAuthFail).toBe(3);
    expect(result.blockers).toBe(4);              // 3 broken + 1 plaintext
    expect(result.gate).toBe('FAIL');
  });

  test('the shape-only view would have cleared it — the gap is quantified', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({ db: fakeDb(rows), crypto: openCrypto(), expectedTenantIds: [TENANT_A] });
    const shape = shapeOnlyCounts(result);
    // The old counter saw 4 sealed / 1 leftover and would have said GATE PASSES
    // once the one plaintext row was backfilled, while 3 broken rows remained.
    expect(shape.shapeSealed).toBe(4);
    expect(shape.shapeLeftover).toBe(1);
    // The authenticated view sees the truth.
    expect(shape.authSealed).toBe(1);
    expect(shape.authBlockers).toBe(4);
    expect(shape.authSealed + shape.authBlockers).toBe(5);
  });

  test('a clean database passes', async () => {
    const crypto = openCrypto();
    const valid = await crypto.seal('artifact://only', { tenantId: TENANT_A, slot: 'tasks.result_ref', refId: TASK_ID });
    const result = await countUnsealedWithAuth({
      db: fakeDb([{ tenant_id: TENANT_A, ref_id: TASK_ID, value: JSON.stringify(valid) }]),
      crypto: openCrypto(),
      expectedTenantIds: [TENANT_A],
    });
    expect(result.gate).toBe('PASS');
    expect(result.blockers).toBe(0);
  });

  test('no seam => every non-null value is plaintext, never a pass', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({ db: fakeDb(rows), crypto: undefined, expectedTenantIds: [TENANT_A] });
    expect(result.totals.plaintext).toBe(5);
    expect(result.gate).toBe('FAIL');
  });

  test('shape-fail-but-auth-pass is reported separately (it is 0 for a real envelope)', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({ db: fakeDb(rows), crypto: openCrypto(), expectedTenantIds: [TENANT_A] });
    expect(result.totals.shapeFailAuthPass).toBe(0);
  });

  test('coverage requires an independent expected tenant census and rejects a hidden tenant', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({
      db: fakeDb(rows),
      crypto: openCrypto(),
      expectedTenantIds: [TENANT_A, TENANT_B],
    });

    expect(result.coverage.slotQueriesSucceeded).toBe(8);
    expect(result.coverage.slotsRead).toBe(8);
    expect(result.coverage.slotsScanned).toBe(8);
    expect(result.coverage.tenantsSeen).toBe(1);
    expect(result.coverage.observedTenantIds).toEqual([TENANT_A]);
    expect(result.coverage.missingTenantIds).toEqual([TENANT_B]);
    expect(result.coverage.reasons.join(' ')).toMatch(/RLS\/policy filtering/);
    expect(result.gate).toBe('FAIL');
  });

  test('empty slots are reported, and a missing expected tenant keeps coverage incomplete', async () => {
    const result = await countUnsealedWithAuth({
      db: fakeDb([{ tenant_id: TENANT_A, ref_id: TASK_ID, value: null }]),
      crypto: openCrypto(),
      expectedTenantIds: [TENANT_A, TENANT_B],
    });

    expect(result.coverage.emptySlots).toContainEqual(expect.objectContaining({
      slot: 'tasks.result_ref',
      rowsVisible: 1,
      nonNullValues: 0,
      reason: expect.stringMatching(/every value .* NULL/),
    }));
    expect(result.coverage.missingTenantIds).toEqual([TENANT_B]);
    expect(result.coverage.complete).toBe(false);
    expect(result.gate).toBe('FAIL');
  });

  test('all slot counts and authenticated-value counts are explicit', async () => {
    const rows = await buildFixture();
    const result = await countUnsealedWithAuth({
      db: fakeDb(rows),
      crypto: openCrypto(),
      expectedTenantIds: [TENANT_A],
    });

    expect(result.coverage.slotsExpected).toBe(8);
    expect(result.coverage.slotQueriesAttempted).toBe(8);
    expect(result.coverage.slotQueriesSucceeded).toBe(8);
    expect(result.coverage.slotsScanned).toBe(8);
    expect(result.coverage.valuesAuthenticated).toBe(4);
    expect(result.totals.valuesAuthenticated).toBe(4);
    expect(result.coverage.complete).toBe(true);
  });
});
