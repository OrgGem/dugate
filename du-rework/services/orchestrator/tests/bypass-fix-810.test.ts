import { createHmac } from 'node:crypto';
import { createMetadataCrypto, readStoredText, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { openMetadata } from '../src/modules/runtime/runtime';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { countUnsealedWithAuth } from '../src/modules/encryption/metadata-auth-counter';
import type { Db } from '../src/db/db';

/**
 * BYPASS-FIX-810 — the BYPASS-AUDIT-809 findings, with tests that make each
 * one a defect rather than a comment.
 *
 * BA-01 (the important one): `step_checkpoints.output_ref` is a TEXT column.
 * The writer stores JSON.stringify(sealedOutputRef); the reader used to pass
 * that TEXT straight to readStored, which treats any string as unsealed and
 * returns it verbatim WITHOUT an AEAD open. So both a valid envelope and a
 * tampered one reached the checkpoint as raw JSON text.
 *
 * BA-02: readStoredText silently String()-coerced non-strings and returned a
 * raw value when no seam existed.
 *
 * BA-05: the auth gate let a caller pass a trimmed spec list and PASS while
 * skipping slots.
 */

const KEY_REF = 'bypass-fix-810';
const TENANT = '11111111-1111-4111-8111-111111111111';
const REF = 'aaaaaaaa-0000-4000-8000-000000000001:extract:1';
const CTX = { tenantId: TENANT, slot: 'step_checkpoints.output_ref' as const, refId: REF };

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const d = createHmac('sha256', 'bypass-fix').update(seed + ':' + block).digest();
    d.copy(out, offset, 0, Math.min(32, length - offset));
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
      const v = input.keyVersion ?? 1;
      return { keyRef: input.keyRef, keyVersion: v,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + '#' + v, input.dek.length)).toString('base64') };
    },
    async unwrapDek(w: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(w.ciphertext, 'base64');
      return xor(raw, keystream(w.keyRef + '#' + w.keyVersion, raw.length));
    },
    async rewrap(w: WrappedDek): Promise<WrappedDek> { return w; },
  };
}
function openCrypto() {
  return createMetadataCrypto(adaptKeyProviderForMetadata(makeKeyProvider()) as MetadataKeyProvider, KEY_REF);
}
function flipFirstChar(s: string): string {
  const first = s[0] ?? 'A';
  return (first === 'A' ? 'B' : 'A') + s.slice(1);
}
function fakeDb(rows: unknown[]): Db {
  return {
    pool: undefined,
    query: async () => ({ rows, rowCount: rows.length }),
    tx: async () => { throw new Error('counter must not open a transaction'); },
    close: async () => undefined,
  } as unknown as Db;
}

describe('BA-01: the TEXT reader AEAD-opens instead of returning raw JSON', () => {
  test('a valid TEXT envelope opens to the original string under its own binding', async () => {
    const crypto = openCrypto();
    const envelope = await crypto.seal('artifact://checkpoint-out', CTX);
    const textColumn = JSON.stringify(envelope);

    // Before the fix this returned textColumn verbatim (a raw JSON string).
    await expect(openMetadata(crypto, textColumn, CTX)).resolves.toBe('artifact://checkpoint-out');
  });

  test('a TAMPERED TEXT envelope throws instead of reaching the caller as raw JSON', async () => {
    const crypto = openCrypto();
    const envelope = JSON.parse(JSON.stringify(await crypto.seal('artifact://out', CTX))) as Record<string, unknown>;
    envelope.ciphertext = flipFirstChar(String(envelope.ciphertext));
    const tampered = JSON.stringify(envelope);

    // Before the fix this would have been returned verbatim, tampered or not.
    await expect(openMetadata(crypto, tampered, CTX)).rejects.toThrow(/authenticated decryption/i);
  });

  test('a ciphertext tampered to a plaintext still throws, never returns the raw text', async () => {
    const crypto = openCrypto();
    const envelope = JSON.parse(JSON.stringify(await crypto.seal('artifact://out', CTX))) as Record<string, unknown>;
    envelope.ciphertext = flipFirstChar(String(envelope.ciphertext));
    const tampered = JSON.stringify(envelope);
    let thrown: unknown;
    try { await openMetadata(crypto, tampered, CTX); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(String(thrown)).not.toContain('ciphertext');
  });

  test('the jsonb path still opens (unchanged by the string dispatch)', async () => {
    const crypto = openCrypto();
    const envelope = await crypto.seal({ source: 'jsonb' }, CTX);
    await expect(openMetadata(crypto, envelope, CTX)).resolves.toEqual({ source: 'jsonb' });
  });

  test('the ENC-09 window still passes a legacy plaintext TEXT ref through', async () => {
    const crypto = openCrypto();
    await expect(openMetadata(crypto, 'artifact://legacy-plaintext', CTX)).resolves.toBe('artifact://legacy-plaintext');
  });

  test('reader and auth counter read the SAME shape: the counter opens what the reader opens', async () => {
    const crypto = openCrypto();
    const textColumn = JSON.stringify(await crypto.seal('artifact://same', CTX));
    const fromReader = await openMetadata(crypto, textColumn, CTX);
    const fromCounter = await readStoredText(crypto, textColumn, CTX, false);
    expect(fromReader).toBe(fromCounter);
    expect(fromReader).toBe('artifact://same');
  });
});

describe('BA-02: readStoredText fails closed on its silent pass-throughs', () => {
  test('a non-string is rejected instead of being String()-coerced', async () => {
    const crypto = openCrypto();
    let thrown: unknown;
    try { await readStoredText(crypto, { object: true }, CTX, true); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('INVALID_INPUT');
    // The old path returned String(value) === '[object Object]'.
    expect(String(thrown)).not.toContain('[object Object]');
  });

  test('a sealed TEXT value read with NO seam throws KEY_PROVIDER_FAILED', async () => {
    const crypto = openCrypto();
    const sealed = JSON.stringify(await crypto.seal('artifact://x', CTX));
    let thrown: unknown;
    try { await readStoredText(undefined, sealed, CTX, true); } catch (e) { thrown = e; }
    expect((thrown as { code?: string }).code).toBe('KEY_PROVIDER_FAILED');
  });

  test('a legacy plaintext TEXT value with NO seam still passes through (window)', async () => {
    await expect(readStoredText(undefined, 'artifact://legacy', CTX, true)).resolves.toBe('artifact://legacy');
  });

  test('a non-string that does not open still never leaks a raw envelope as the value', async () => {
    const crypto = openCrypto();
    let thrown: unknown;
    try { await readStoredText(crypto, 42 as unknown as string, CTX, true); } catch (e) { thrown = e; }
    expect((thrown as { code?: string }).code).toBe('INVALID_INPUT');
  });
});

describe('BA-05: the gate always covers exactly the 8 METADATA_SLOTS', () => {
  test('a TRIMMED spec list is rejected', async () => {
    const full = (await import('../src/modules/encryption/metadata-auth-counter')).METADATA_AUTH_SLOT_SPECS;
    const trimmed = full.slice(0, full.length - 1);
    let thrown: unknown;
    try { await countUnsealedWithAuth({ db: fakeDb([]), crypto: openCrypto(), specs: trimmed }); }
    catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/must be exactly the 8 METADATA_SLOTS/);
    expect(String(thrown)).toMatch(/missing=\[/);
  });

  test('an EMPTY spec list is rejected, not passed', async () => {
    let thrown: unknown;
    try { await countUnsealedWithAuth({ db: fakeDb([]), crypto: openCrypto(), specs: [] }); }
    catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/must be exactly the 8 METADATA_SLOTS/);
  });

  test('the default (full) spec list is scanned but missing tenant census fails closed', async () => {
    const result = await countUnsealedWithAuth({ db: fakeDb([]), crypto: openCrypto() });
    expect(result.slots).toHaveLength(8);
    expect(result.coverage.slotsExpected).toBe(8);
    expect(result.coverage.slotQueriesSucceeded).toBe(8);
    expect(result.coverage.reasons.join(' ')).toMatch(/independent full-visibility census/);
    expect(result.gate).toBe('FAIL');
  });
});
