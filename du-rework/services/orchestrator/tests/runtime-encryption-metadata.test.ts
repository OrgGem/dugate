/**
 * ENC-META-01 - control-plane metadata must not rest as plaintext.
 *
 * Production seam under test: src/modules/runtime/metadata-crypto.ts plus the
 * runtime call sites that persist or read a control-plane JSON column
 * (operations.input_ref, tasks.payload_ref, human_waits.response_ref,
 * step_checkpoints.output_ref).
 *
 * Pinned here, in the order the packet asks for:
 *  1. INVENTORY - a sealed column holds no plaintext (byte scan for a
 *     sentinel that is present in the original value).
 *  2. BINDING - an envelope is bound to (tenant, slot, row); opening it
 *     under any other context fails instead of returning the plaintext.
 *  3. FENCE - Vault outage and wrong key both fail closed, never plaintext.
 *  4. SEMANTICS - content hashing stays stable, so idempotency keys and the
 *     replay fence keep working once the column is sealed.
 *
 * The key provider is a REAL transform, not an echo: wrapDek applies a keyed
 * keystream and unwrapDek removes it. An echo provider would make a broken
 * AAD binding look authenticated, which is exactly the negative this file
 * exists to pin. It is a test double for Vault Transit, so its own security
 * is irrelevant - only reversibility and wrong-key behaviour matter.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { contentHash } from '@du/contracts';
import {
  createMetadataCrypto,
  canonicalizeMetadataJson,
  metadataPlaintextHash,
  MetadataCryptoError,
  METADATA_SLOTS,
  type MetadataKeyProvider,
  type MetadataContext,
  type MetadataWrappedDek,
} from '../src/modules/runtime/metadata-crypto';

const KEY_REF = 'du-orch-metadata-v1';
const SENTINEL = 'CONFIDENTIAL-TENANT-DOC-BODY-7f3a91';

/** Deterministic keystream stand-in for the Transit key material. */
const HASH = String.fromCharCode(35);

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'offline-transit-double').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  }
  return out;
}

interface ProviderOptions {
  failWrap?: boolean;
  failUnwrap?: boolean;
  wrongKey?: boolean;
}

interface TestProvider {
  readonly provider: MetadataKeyProvider;
  readonly stats: { wraps: number; unwraps: number };
}

function makeProvider(options: ProviderOptions = {}): TestProvider {
  const stats = { wraps: 0, unwraps: 0 };
  const provider: MetadataKeyProvider = {
    async wrapDek(dek: Buffer, keyRef: string, keyVersion?: number): Promise<MetadataWrappedDek> {
      stats.wraps += 1;
      if (options.failWrap) throw new Error('vault transit unavailable');
      const version = keyVersion ?? 1;
      const stream = keystream(keyRef + HASH + version, dek.length);
      return {
        version: 1,
        keyName: keyRef,
        keyVersion: version,
        wrappedKey: xor(dek, stream).toString('base64'),
      };
    },
    async unwrapDek(wrapped: MetadataWrappedDek): Promise<Buffer> {
      stats.unwraps += 1;
      if (options.failUnwrap) throw new Error('vault transit 403');
      const raw = Buffer.from(wrapped.wrappedKey, 'base64');
      if (options.wrongKey) return randomBytes(32);
      return xor(raw, keystream(wrapped.keyName + HASH + wrapped.keyVersion, raw.length));
    },
  };
  return { provider, stats };
}

const CTX: MetadataContext = { tenantId: 'tenant-a', slot: 'tasks.payload_ref', refId: 'task-1' };
const SENSITIVE = { document: SENTINEL, pages: 12, nested: { secret: SENTINEL } };

/** Build the seam and hand back the provider call counters. */
function makeCrypto(options: ProviderOptions = {}): {
  crypto: ReturnType<typeof createMetadataCrypto>;
  stats: { wraps: number; unwraps: number };
} {
  const { provider, stats } = makeProvider(options);
  return { crypto: createMetadataCrypto(provider, KEY_REF), stats };
}

function expectCryptoError(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  return expect(fn()).rejects.toMatchObject({ name: 'MetadataCryptoError', code });
}

describe('ENC-META-01 inventory: a sealed control-plane column holds no plaintext', () => {
  it('the serialized envelope contains neither the sentinel nor a plaintext key', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain('CONFIDENTIAL');
    expect(wire).not.toContain('pages');
  });

  it('no plaintext DEK is persisted beside the ciphertext', async () => {
    const { crypto, stats } = makeCrypto();
    const dek = randomBytes(32);
    const sealed = await crypto.seal({ body: dek }, CTX);
    const wire = JSON.stringify(sealed);
    expect(wire).not.toContain(dek.toString('hex'));
    expect(sealed.dek.wrappedKey).not.toEqual(dek.toString('base64'));
    expect(stats.wraps).toBe(1);
  });

  it('sealing is non-deterministic while the content hash stays stable', async () => {
    const crypto = makeCrypto().crypto;
    const a = await crypto.seal(SENSITIVE, CTX);
    const b = await crypto.seal(SENSITIVE, CTX);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.plaintextSha256).toEqual(b.plaintextSha256);
  });
});

describe('ENC-META-01 binding: an envelope opens only under its own context', () => {
  it('round-trips the original value under the bound context', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    expect(await crypto.open(sealed, CTX)).toEqual(SENSITIVE);
  });

  it('refuses a different TENANT (cross-tenant negative)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, { ...CTX, tenantId: 'tenant-b' }), 'CONTEXT_MISMATCH');
  });

  it('refuses a different SLOT (payload_ref cannot move to input_ref)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(
      () => crypto.open(sealed, { ...CTX, slot: 'operations.input_ref' }),
      'CONTEXT_MISMATCH',
    );
  });

  it('refuses a different ROW (same tenant and slot, other task)', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, { ...CTX, refId: 'task-2' }), 'CONTEXT_MISMATCH');
  });

  it('a tampered ciphertext fails authentication instead of returning junk', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    const raw = Buffer.from(sealed.ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    await expectCryptoError(
      () => crypto.open({ ...sealed, ciphertext: raw.toString('base64') }, CTX),
      'AUTHENTICATION_FAILED',
    );
  });

  it('a wrong DEK from the provider fails authentication, no plaintext fallback', async () => {
    const crypto = makeCrypto({ wrongKey: true }).crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open(sealed, CTX), 'AUTHENTICATION_FAILED');
  });

  it('Vault outage on write fails closed: nothing is stored unsealed', async () => {
    const crypto = makeCrypto({ failWrap: true }).crypto;
    await expectCryptoError(() => crypto.seal(SENSITIVE, CTX), 'KEY_PROVIDER_FAILED');
  });

  it('Vault outage on read fails closed: no plaintext is served', async () => {
    const good = makeCrypto().crypto;
    const sealed = await good.seal(SENSITIVE, CTX);
    const broken = makeCrypto({ failUnwrap: true }).crypto;
    await expectCryptoError(() => broken.open(sealed, CTX), 'KEY_PROVIDER_FAILED');
  });

  it('rejects an unknown envelope version instead of guessing', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(() => crypto.open({ ...sealed, version: 99 } as never, CTX), 'NOT_SEALED');
  });

  it('rejects an empty tenant binding rather than sealing under an empty AAD', async () => {
    const crypto = makeCrypto().crypto;
    await expectCryptoError(() => crypto.seal(SENSITIVE, { ...CTX, tenantId: '' }), 'INVALID_INPUT');
  });
});

describe('ENC-META-01 legacy rows: readable only behind the backfill flag', () => {
  it('isSealed does not mistake a legacy plaintext object for an envelope', () => {
    const crypto = makeCrypto().crypto;
    expect(crypto.isSealed(SENSITIVE)).toBe(false);
    expect(crypto.isSealed({ version: 1, algorithm: 'aes-256-gcm' })).toBe(false);
  });

  it('readStored fails closed on a plaintext row when the flag is off', async () => {
    const crypto = makeCrypto().crypto;
    await expectCryptoError(() => crypto.readStored(SENSITIVE, CTX, false), 'NOT_SEALED');
  });

  it('readStored passes a legacy row through during the backfill window', async () => {
    const crypto = makeCrypto().crypto;
    expect(await crypto.readStored(SENSITIVE, CTX, true)).toBe(SENSITIVE);
  });

  it('readStored still enforces the binding on a sealed row even with the flag on', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    await expectCryptoError(
      () => crypto.readStored(sealed, { ...CTX, tenantId: 'tenant-b' }, true),
      'CONTEXT_MISMATCH',
    );
  });
});

describe('ENC-META-01 semantics: hashing stays stable so idempotency survives sealing', () => {
  it('key order does not change the hash; array order does', () => {
    expect(metadataPlaintextHash({ b: 1, a: 2 })).toBe(metadataPlaintextHash({ a: 2, b: 1 }));
    expect(metadataPlaintextHash([1, 2])).not.toBe(metadataPlaintextHash([2, 1]));
  });

  it('the sealed plaintextSha256 matches the hash of the original value', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal({ z: 1, a: [1, 2] }, CTX);
    expect(sealed.plaintextSha256).toBe(metadataPlaintextHash({ z: 1, a: [1, 2] }));
  });

  it('canonicalize emits sorted keys so equal documents are byte-equal', () => {
    expect(canonicalizeMetadataJson({ b: 1, a: 2 }).toString('utf8')).toBe('{"a":2,"b":1}');
  });

  it('hashing the raw column would mismatch, which is why the runtime opens first', async () => {
    const crypto = makeCrypto().crypto;
    const sealed = await crypto.seal(SENSITIVE, CTX);
    expect(contentHash(sealed)).not.toBe(contentHash(SENSITIVE));
    expect(contentHash(await crypto.open(sealed, CTX))).toBe(contentHash(SENSITIVE));
  });
});

describe('ENC-META-01 slot inventory', () => {
  it('covers exactly the four control-plane columns the packet names', () => {
    expect([...METADATA_SLOTS].sort()).toEqual([
      'human_waits.response_ref',
      'operations.input_ref',
      'step_checkpoints.output_ref',
      'tasks.payload_ref',
    ]);
  });

  it('refuses to build a crypto seam without a keyRef', () => {
    expect(() => createMetadataCrypto(makeProvider().provider, '')).toThrow(MetadataCryptoError);
  });
});