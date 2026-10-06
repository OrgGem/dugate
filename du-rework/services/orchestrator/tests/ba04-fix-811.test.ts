import { createHmac } from 'node:crypto';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { openDispatchSourceUrl } from '../src/modules/operations/ingestion-consumer';

/**
 * BA04-FIX-811 — `openDispatchSourceUrl` used to `if (typeof raw === 'string')
 * return raw;` BEFORE touching the crypto, so a TEXT string carrying a sealed
 * envelope rode that path unopened — tampered or not.
 *
 * The split under test:
 *   PLAINTEXT lane — a string that is not envelope-shaped. Unchanged.
 *   PROTECTED lane — a parsed object, OR a string carrying an envelope.
 *                    AEAD-opened on (tenant, 'tasks.payload_ref', taskId).
 */

const KEY_REF = 'ba04-fix-811';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const URL_OK = 'https://example.test/doc.pdf';
const BINDING = { tenantId: TENANT, taskId: TASK_ID };
const CTX = { tenantId: TENANT, slot: 'tasks.payload_ref' as const, refId: TASK_ID };

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const d = createHmac('sha256', 'ba04-fix').update(seed + ':' + block).digest();
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
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'RESOLVED'; } catch (e) { return (e as { code?: string }).code ?? 'NO_CODE'; }
}

describe('BA04-FIX-811: the PLAINTEXT lane is unchanged', () => {
  test('a plain URL string passes through verbatim', async () => {
    await expect(openDispatchSourceUrl(URL_OK, BINDING, openCrypto())).resolves.toBe(URL_OK);
  });

  test('a non-envelope JSON string passes through verbatim', async () => {
    const plainJson = JSON.stringify({ url: URL_OK });
    await expect(openDispatchSourceUrl(plainJson, BINDING, openCrypto())).resolves.toBe(plainJson);
  });

  test('a malformed JSON-looking string is treated as plaintext, never an envelope', async () => {
    const broken = '{"version":1,"algorithm":"aes-256-gcm"';
    await expect(openDispatchSourceUrl(broken, BINDING, openCrypto())).resolves.toBe(broken);
  });

  test('a plaintext value with NO seam still passes (the historical behaviour)', async () => {
    await expect(openDispatchSourceUrl(URL_OK, BINDING, undefined)).resolves.toBe(URL_OK);
  });
});

describe('BA04-FIX-811: the PROTECTED lane AEAD-opens, both shapes', () => {
  test('a sealed envelope OBJECT opens to the URL', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal(URL_OK, CTX);
    await expect(openDispatchSourceUrl(env, BINDING, crypto)).resolves.toBe(URL_OK);
  });

  test('a sealed envelope as a JSON STRING now opens to the URL (the fix)', async () => {
    const crypto = openCrypto();
    const envText = JSON.stringify(await crypto.seal(URL_OK, CTX));
    // Before the fix this returned envText — the raw envelope JSON — unopened.
    await expect(openDispatchSourceUrl(envText, BINDING, crypto)).resolves.toBe(URL_OK);
  });

  test('a TAMPERED envelope as a JSON STRING is rejected (was: returned raw)', async () => {
    const crypto = openCrypto();
    const env = JSON.parse(JSON.stringify(await crypto.seal(URL_OK, CTX))) as Record<string, unknown>;
    env.ciphertext = flipFirstChar(String(env.ciphertext));
    expect(await codeOf(() => openDispatchSourceUrl(JSON.stringify(env), BINDING, crypto)))
      .toBe('AUTHENTICATION_FAILED');
  });

  test('a TAMPERED envelope as an OBJECT is rejected', async () => {
    const crypto = openCrypto();
    const env = JSON.parse(JSON.stringify(await crypto.seal(URL_OK, CTX))) as Record<string, unknown>;
    env.tag = flipFirstChar(String(env.tag));
    expect(await codeOf(() => openDispatchSourceUrl(env, BINDING, crypto))).toBe('AUTHENTICATION_FAILED');
  });

  test('a wrong-tenant envelope is rejected with CONTEXT_MISMATCH', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal(URL_OK, { tenantId: TENANT_B, slot: 'tasks.payload_ref', refId: TASK_ID });
    expect(await codeOf(() => openDispatchSourceUrl(env, BINDING, crypto))).toBe('CONTEXT_MISMATCH');
  });

  test('a sealed value with NO seam fails closed (KEY_PROVIDER_FAILED)', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal(URL_OK, CTX);
    expect(await codeOf(() => openDispatchSourceUrl(env, BINDING, undefined))).toBe('KEY_PROVIDER_FAILED');
  });

  test('a sealed value as a STRING with NO seam also fails closed', async () => {
    const crypto = openCrypto();
    const envText = JSON.stringify(await crypto.seal(URL_OK, CTX));
    expect(await codeOf(() => openDispatchSourceUrl(envText, BINDING, undefined))).toBe('KEY_PROVIDER_FAILED');
  });

  test('a non-string, non-object value is refused', async () => {
    expect(await codeOf(() => openDispatchSourceUrl(42, BINDING, openCrypto()))).toBe('NOT_SEALED');
    expect(await codeOf(() => openDispatchSourceUrl(null, BINDING, openCrypto()))).toBe('NOT_SEALED');
  });

  test('an envelope that opens to an empty string is refused', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal('', CTX);
    expect(await codeOf(() => openDispatchSourceUrl(env, BINDING, crypto))).toBe('NOT_SEALED');
  });
});