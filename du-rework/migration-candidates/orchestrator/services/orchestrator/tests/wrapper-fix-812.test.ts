import { createHmac } from 'node:crypto';
import { createMetadataCrypto, readStoredText, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { openMetadata } from '../src/modules/runtime/runtime';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';

/**
 * WRAPPER-FIX-812 (A15) — BA-02 had to be fixed at the WRAPPER, not only at
 * the reader.
 *
 * The strict reader (`readStoredText(..., false)`) already refused every bad
 * case. But the runtime wrapper `openMetadata` opened with `if (!crypto) return
 * value` BEFORE touching the crypto, so a SEALED envelope read with no seam
 * came back as raw JSON while the reader threw KEY_PROVIDER_FAILED for the very
 * same value. The guard was bypassed one layer up.
 *
 * These tests run the REAL wrapper (`openMetadata`, exported from runtime.ts).
 */

const KEY_REF = 'wrapper-fix-812';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const REF = 'aaaaaaaa-0000-4000-8000-000000000001:extract:1';
const CTX = { tenantId: TENANT, slot: 'step_checkpoints.output_ref' as const, refId: REF };

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const d = createHmac('sha256', 'wrapper-fix').update(seed + ':' + block).digest();
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

describe('WRAPPER-FIX-812: the REAL wrapper on all five cases', () => {
  test('1. a valid TEXT envelope opens under its own binding', async () => {
    const crypto = openCrypto();
    const text = JSON.stringify(await crypto.seal('artifact://out', CTX));
    await expect(openMetadata(crypto, text, CTX)).resolves.toBe('artifact://out');
  });

  test('2. a ciphertext flip throws AUTHENTICATION_FAILED', async () => {
    const crypto = openCrypto();
    const env = JSON.parse(JSON.stringify(await crypto.seal('artifact://out', CTX))) as Record<string, unknown>;
    env.ciphertext = flipFirstChar(String(env.ciphertext));
    expect(await codeOf(() => openMetadata(crypto, JSON.stringify(env), CTX))).toBe('AUTHENTICATION_FAILED');
  });

  test('3. a tag flip throws AUTHENTICATION_FAILED', async () => {
    const crypto = openCrypto();
    const env = JSON.parse(JSON.stringify(await crypto.seal('artifact://out', CTX))) as Record<string, unknown>;
    env.tag = flipFirstChar(String(env.tag));
    expect(await codeOf(() => openMetadata(crypto, JSON.stringify(env), CTX))).toBe('AUTHENTICATION_FAILED');
  });

  test('4. a wrong-tenant AAD throws CONTEXT_MISMATCH', async () => {
    const crypto = openCrypto();
    const text = JSON.stringify(await crypto.seal('artifact://out', { tenantId: TENANT_B, slot: 'step_checkpoints.output_ref', refId: REF }));
    expect(await codeOf(() => openMetadata(crypto, text, CTX))).toBe('CONTEXT_MISMATCH');
  });

  test('5. plaintext passes through — the ENC-09 window is still OPEN (documented, not a bug)', async () => {
    const crypto = openCrypto();
    await expect(openMetadata(crypto, 'artifact://checkpoint-plaintext', CTX))
      .resolves.toBe('artifact://checkpoint-plaintext');
  });

  test('the jsonb path is unchanged', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal({ source: 'jsonb' }, CTX);
    await expect(openMetadata(crypto, env, CTX)).resolves.toEqual({ source: 'jsonb' });
  });
});

describe('WRAPPER-FIX-812: no seam fails closed instead of returning raw', () => {
  test('a SEALED TEXT envelope with no seam throws KEY_PROVIDER_FAILED (was: raw JSON)', async () => {
    const crypto = openCrypto();
    const text = JSON.stringify(await crypto.seal('artifact://out', CTX));
    expect(await codeOf(() => openMetadata(undefined, text, CTX))).toBe('KEY_PROVIDER_FAILED');
  });

  test('a SEALED jsonb envelope with no seam throws KEY_PROVIDER_FAILED', async () => {
    const crypto = openCrypto();
    const env = await crypto.seal({ source: 'jsonb' }, CTX);
    expect(await codeOf(() => openMetadata(undefined, env, CTX))).toBe('KEY_PROVIDER_FAILED');
  });

  test('wrapper and reader share ONE rule and ONE error code', async () => {
    const crypto = openCrypto();
    const text = JSON.stringify(await crypto.seal('artifact://out', CTX));
    const fromWrapper = await codeOf(() => openMetadata(undefined, text, CTX));
    const fromReader = await codeOf(() => readStoredText(undefined, text, CTX, true));
    expect(fromWrapper).toBe('KEY_PROVIDER_FAILED');
    expect(fromReader).toBe(fromWrapper);
  });

  test('the LEGITIMATE no-seam path is preserved: a plaintext value still passes', async () => {
    await expect(openMetadata(undefined, 'artifact://not-sealed-yet', CTX)).resolves.toBe('artifact://not-sealed-yet');
  });

  test('the `?? {}` callers still work with no seam (an empty jsonb default is not an envelope)', async () => {
    await expect(openMetadata(undefined, {}, CTX)).resolves.toEqual({});
  });
});