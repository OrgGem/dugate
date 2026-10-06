/**
 * RV01-03 (P0, coordinator branch B + hardening): the four defects the packet
 * listed, pinned as behaviour. Each block names the defect it holds down.
 *
 *  1. encryption enabled + NO seam -> typed refusal, nothing uploaded. The
 *     pre-fix code fell through to a PLAINTEXT PUT, so every test here also
 *     asserts that no PUT body was sent, not merely that a throw happened.
 *  1b. multipart + encryption on -> typed refusal too. The chunked manifest
 *     path is deliberately NOT wired (sealStream binds its AAD to an
 *     artifactId the server only assigns at multipartInit), so it fails closed.
 *  2. the single-shot seal returns the FULL envelope - nonce, tag, aad and the
 *     wrapped DEK. The pre-fix helper returned ciphertext only, which made the
 *     object unreadable even though it had been sealed correctly.
 *  4. the 5 MiB ceiling is enforced WHILE the stream is read. The pre-fix code
 *     ran Buffer.concat first and checked the length afterwards, so the whole
 *     stream was resident before the refusal.
 *
 * The key provider is a real reversible transform (keystream XOR), not an echo:
 * an echo provider would make a broken AAD binding look authenticated and the
 * round-trip assertions would pass on a broken seal.
 *
 * LIMITATION, stated so no reader over-reads this file: runtime and storage are
 * doubles. Nothing here touches PostgreSQL, Redis, S3 or Vault, so this suite
 * is NOT integration evidence. The real-infrastructure round trip is the
 * DB-window acceptance work recorded in the RV01-03 receipt.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { DefaultTaskContext, RuntimeClient } from '../src';
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  CryptoStorageFacade,
  type CryptoKeyProvider,
  type WrappedDek,
} from '../src/crypto-storage';
import type { SealedArtifact, WorkerCryptoSeam } from '../src/crypto-seam';
import { ArtifactEncryptionError } from '../src/task-context';

const KEY_REF = 'du-rv0103-meta-v1';
const TENANT = 'tenant-rv01-03';
const SENTINEL = 'CONFIDENTIAL-RV01-03-PLAINTEXT-SENTINEL';
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    createHmac('sha256', 'rv01-03-test-double')
      .update(seed + String.fromCharCode(58) + block)
      .digest()
      .copy(out, offset, 0, Math.min(32, length - offset));
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

function makeProvider(): CryptoKeyProvider {
  return {
    async wrapDek(input): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + String.fromCharCode(35) + String(version), input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + String.fromCharCode(35) + String(wrapped.keyVersion), raw.length));
    },
  };
}

function makeSeam(): WorkerCryptoSeam {
  return { facade: new CryptoStorageFacade(makeProvider()), keyRef: KEY_REF };
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this;
  },
} as never;


interface FinalizeCall {
  artifactId: string;
  sizeBytes: number;
  sha256: string;
}

interface Harness {
  /** Contexts sharing one runtime/storage double. */
  ctx: (overrides?: Record<string, unknown>) => DefaultTaskContext;
  /** Bytes actually handed to storage by the last PUT. */
  stored: () => Buffer;
  /** Every PUT body, so a test can prove the plaintext never left. */
  putBodies: () => Buffer[];
  grantCalls: () => number;
  finalizeCalls: () => FinalizeCall[];
}

function makeHarness(): Harness {
  const artifactId = randomUUID();
  const uploadUrl = 'https://blob.test/' + artifactId + '/upload';
  let stored = Buffer.alloc(0);
  const putBodies: Buffer[] = [];
  let grantCalls = 0;
  const finalizeCalls: FinalizeCall[] = [];

  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/tasks/task-rv01-03/artifacts') && method === 'POST') {
      grantCalls += 1;
      return json({ artifactId, uploadUrl, expiresAt: FAR_FUTURE });
    }
    if (url === uploadUrl && method === 'PUT') {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
      const parts: Buffer[] = [];
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(Buffer.from(next.value));
      }
      stored = Buffer.concat(parts);
      putBodies.push(stored);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/finalize') && method === 'POST') {
      const raw = JSON.parse(String(init?.body ?? '{}')) as { sizeBytes: number; sha256: string };
      finalizeCalls.push({ artifactId, sizeBytes: raw.sizeBytes, sha256: raw.sha256 });
      return new Response(null, { status: 200 });
    }
    return new Response('unexpected ' + method + ' ' + url, { status: 404 });
  }) as unknown as typeof fetch;

  const runtime = new RuntimeClient({
    baseUrl: 'http://runtime.test/api/runtime/v1',
    token: 't',
    fetchImpl,
  });

  const task = {
    taskId: 'task-rv01-03',
    operationId: randomUUID(),
    tenantId: TENANT,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'ingest',
    kind: 'ingest',
    taskKey: 'k',
    attempt: 1,
    leaseEpoch: 1,
    leaseExpiresAt: FAR_FUTURE,
    deadlineAt: null,
    input: {},
    connectorBindings: {},
    checkpointRefs: [],
    cancelRequested: false,
  };

  const ctx = (overrides: Record<string, unknown> = {}): DefaultTaskContext => {
    // __tenant is harness sugar, not an SDK option: the tenant is a server
    // claim field, so a test that needs a second tenant has to claim one.
    const { __tenant, ...deps } = overrides as { __tenant?: string };
    return new DefaultTaskContext({ ...task, tenantId: __tenant ?? task.tenantId } as never, {
      runtime,
      fetchImpl,
      logger: silentLogger,
      invokeConnector: async () => {
        throw new Error('unused');
      },
      ...deps,
    } as never);
  };

  return {
    ctx,
    stored: () => stored,
    putBodies: () => putBodies,
    grantCalls: () => grantCalls,
    finalizeCalls: () => finalizeCalls,
  };
}


describe('RV01-03 defect 1: encryption on without a seam refuses, it never publishes plaintext', () => {
  it('write() rejects with a typed ArtifactEncryptionError', async () => {
    const h = makeHarness();
    await expect(
      h.ctx({ encryptionEnabled: true }).artifacts.write(Buffer.from(SENTINEL), 'a.txt', 'text/plain', 'output'),
    ).rejects.toBeInstanceOf(ArtifactEncryptionError);
  });

  it('the refusal carries ENCRYPTION_REQUIRED_UNAVAILABLE', async () => {
    const h = makeHarness();
    await expect(
      h.ctx({ encryptionEnabled: true }).artifacts.write(Buffer.from(SENTINEL), 'a.txt', 'text/plain', 'output'),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED_UNAVAILABLE' });
  });

  it('nothing was uploaded: the pre-fix path wrote the clear here', async () => {
    const h = makeHarness();
    await expect(
      h.ctx({ encryptionEnabled: true }).artifacts.write(Buffer.from(SENTINEL), 'a.txt', 'text/plain', 'output'),
    ).rejects.toBeInstanceOf(ArtifactEncryptionError);
    expect(h.putBodies()).toHaveLength(0);
    expect(h.stored().includes(SENTINEL)).toBe(false);
  });

  it('multipart refuses before any part is requested', async () => {
    const h = makeHarness();
    const seventyMiB = 70 * 1024 * 1024;
    await expect(
      h
        .ctx({ encryptionEnabled: true })
        .artifacts.writeStream(singleChunk(), 'big.bin', 'application/octet-stream', seventyMiB, 'output'),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED_UNAVAILABLE' });
    // multipartInit is the first call this branch would have made; the refusal
    // lands before it, so the server never minted an upload for plaintext.
    expect(h.grantCalls()).toBe(0);
    expect(h.putBodies()).toHaveLength(0);
  });

  it('CONFIG OFF: a deployment that did not opt in keeps the plaintext upload', async () => {
    // Documented compatibility, not an oversight: encryptionEnabled defaults to
    // false, so an un-migrated deployment behaves exactly as it did before
    // RV01-03. Both halves are asserted - the bytes still leave in the clear,
    // and the call still returns the server-assigned artifact ref.
    const h = makeHarness();
    const body = Buffer.from(SENTINEL, 'utf8');
    const ref = await h.ctx().artifacts.write(body, 'a.txt', 'text/plain', 'output');
    expect(h.stored().equals(body)).toBe(true);
    expect(ref.sizeBytes).toBe(body.byteLength);
  });
});

describe('RV01-03 defect 1b: multipart with a seam still refuses - the chunked path is not wired', () => {
  it('fails closed with SEAL_FAILED instead of streaming plaintext parts', async () => {
    const h = makeHarness();
    const seventyMiB = 70 * 1024 * 1024;
    const promise = h
      .ctx({ encryptionEnabled: true, crypto: makeSeam(), chunkedEncryptionEnabled: true })
      .artifacts.writeStream(singleChunk(), 'big.bin', 'application/octet-stream', seventyMiB, 'output');
    await expect(promise).rejects.toMatchObject({ code: 'SEAL_FAILED' });
    // chunkedEncryptionEnabled must not open a plaintext door either.
    expect(h.grantCalls()).toBe(0);
    expect(h.putBodies()).toHaveLength(0);
  });
});

async function* singleChunk(): AsyncGenerator<Buffer, void, void> {
  yield Buffer.from(SENTINEL);
}


describe('RV01-03 defect 2: the single-shot seal returns the FULL envelope', () => {
  it('carries nonce, tag, aad and the wrapped DEK, and reopens under its binding', async () => {
    const h = makeHarness();
    const ctx = h.ctx({ encryptionEnabled: true, crypto: makeSeam() });
    const artifactId = randomUUID();
    // White-box on the private helper on purpose: the dropped fields are exactly
    // its return shape, so pinning the helper pins the fix rather than a proxy.
    const inner = ctx as unknown as {
      sealArtifactBytes: (
        content: AsyncIterable<Uint8Array>,
        artifactId: string,
        purpose: string,
      ) => Promise<SealedArtifact>;
    };
    const plaintext = Buffer.from(SENTINEL, 'utf8');
    const sealed = await inner.sealArtifactBytes(singleChunk(), artifactId, 'output');
    expect(typeof sealed.encrypted.nonce).toBe('string');
    expect(sealed.encrypted.nonce.length).toBeGreaterThan(0);
    expect(typeof sealed.encrypted.tag).toBe('string');
    expect(sealed.encrypted.tag.length).toBeGreaterThan(0);
    expect(typeof sealed.encrypted.aad).toBe('string');
    expect(sealed.encrypted.dek.keyRef).toBe(KEY_REF);
    expect(sealed.encrypted.dek.keyVersion).toBeGreaterThanOrEqual(1);
    expect(sealed.encrypted.dek.ciphertext.length).toBeGreaterThan(0);
    expect(sealed.ciphertextSizeBytes).toBe(sealed.encrypted.ciphertext.byteLength);
    expect(sealed.ciphertextSha256).toBe(sha256(sealed.encrypted.ciphertext));
    const reopened = await ctx
      .cryptoFor({ artifactId, purpose: 'output' })
      .open(sealed, { artifactId, purpose: 'output' });
    expect(reopened.equals(plaintext)).toBe(true);
  });

  it('storage holds ciphertext, and finalize reports the CIPHERTEXT digest', async () => {
    const h = makeHarness();
    const plaintext = Buffer.from(SENTINEL, 'utf8');
    const ref = await h
      .ctx({ encryptionEnabled: true, crypto: makeSeam() })
      .artifacts.write(plaintext, 'a.txt', 'text/plain', 'output');
    const stored = h.stored();
    expect(stored.equals(plaintext)).toBe(false);
    expect(stored.includes(SENTINEL)).toBe(false);
    expect(stored.byteLength).toBe(ref.sizeBytes);
    expect(sha256(stored)).toBe(ref.hashSha256);
    // finalize is what the storage layer records, so it must describe the bytes
    // that were actually committed rather than the caller's plaintext.
    const finalize = h.finalizeCalls();
    expect(finalize).toHaveLength(1);
    expect(finalize[0]!.sha256).toBe(sha256(stored));
    expect(finalize[0]!.sha256).not.toBe(sha256(plaintext));
    expect(finalize[0]!.sizeBytes).toBe(stored.byteLength);
  });

  it('a tampered ciphertext is refused rather than returned', async () => {
    const h = makeHarness();
    const artifactId = randomUUID();
    const crypto = h.ctx({ encryptionEnabled: true, crypto: makeSeam() }).cryptoFor({
      artifactId,
      purpose: 'output',
    });
    const sealed = await crypto.seal(randomBytes(4096), { artifactId, purpose: 'output' });
    const flipped = Buffer.from(sealed.encrypted.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await expect(
      crypto.open({ ...sealed, encrypted: { ...sealed.encrypted, ciphertext: flipped } }, { artifactId, purpose: 'output' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });
});

describe('RV01-03 defect 4: the 5 MiB ceiling is enforced while the stream is read', () => {
  it('refuses at the chunk that crosses the limit instead of buffering the whole stream', async () => {
    const h = makeHarness();
    const chunkBytes = 1024 * 1024;
    const chunks = 64;
    const total = chunkBytes * chunks;
    let produced = 0;
    async function* source(): AsyncGenerator<Buffer, void, void> {
      for (let i = 0; i < chunks; i += 1) {
        produced += chunkBytes;
        yield Buffer.alloc(chunkBytes, 7);
      }
    }
    await expect(
      h
        .ctx({ encryptionEnabled: true, crypto: makeSeam() })
        .artifacts.writeStream(source(), 'big.bin', 'application/octet-stream', total, 'output'),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    // A post-concat check would have consumed all 64 chunks (64 MiB) before
    // refusing. Measured: 7 MiB produced - the refusal lands on the 6th chunk
    // and Readable.from had already prefetched one more.
    expect(produced).toBeLessThan(total);
    expect(produced).toBeLessThanOrEqual(CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 3 * chunkBytes);
    expect(h.putBodies()).toHaveLength(0);
  });

  it('the refusal names the ceiling so an operator can tell it from a byte limit', async () => {
    const h = makeHarness();
    const body = randomBytes(CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES + 1024);
    await expect(
      h
        .ctx({ encryptionEnabled: true, crypto: makeSeam() })
        .artifacts.write(body, 'big.bin', 'application/octet-stream', 'output'),
    ).rejects.toThrow(/single-shot encryption ceiling/);
  });

  it('a body under the ceiling is sealed and stored', async () => {
    const h = makeHarness();
    const body = randomBytes(64 * 1024);
    const ref = await h
      .ctx({ encryptionEnabled: true, crypto: makeSeam() })
      .artifacts.write(body, 'small.bin', 'application/octet-stream', 'output');
    expect(h.stored().equals(body)).toBe(false);
    expect(ref.sizeBytes).toBe(h.stored().byteLength);
  });

  it('the ceiling is the contract value, not a local constant', () => {
    expect(CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES).toBe(5 * 1024 * 1024);
  });
});


describe('RV01-03 chunked seam round-trip above the ceiling (seam level: not wired to writes)', () => {
  it('seals and reopens 6 MiB as authenticated 4 MiB chunks with a manifest', async () => {
    const h = makeHarness();
    const artifactId = randomUUID();
    const crypto = h.ctx({ crypto: makeSeam() }).cryptoFor({ artifactId, purpose: 'output' });
    const piece = 1024 * 1024;
    const body = randomBytes(6 * piece);
    async function* source(): AsyncGenerator<Buffer, void, void> {
      for (let off = 0; off < body.byteLength; off += piece) {
        yield body.subarray(off, Math.min(off + piece, body.byteLength));
      }
    }
    const sealed = crypto.sealStream(source(), { artifactId, purpose: 'output' });
    const parts: Buffer[] = [];
    for await (const part of sealed.ciphertext) parts.push(Buffer.from(part as Buffer));
    const manifest = await sealed.manifest;
    expect(manifest.totalChunks).toBe(2);
    expect(manifest.chunkSizeBytes).toBe(CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
    expect(manifest.chunkSizeBytes).toBe(4 * 1024 * 1024);
    expect(manifest.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(manifest.dek.keyRef).toBe(KEY_REF);
    expect(manifest.totalSizeBytes).toBe(body.byteLength);
    expect(manifest.fileSha256).toBe(sha256(body));

    async function* ciphertext(): AsyncGenerator<Buffer, void, void> {
      for (const part of parts) yield part;
    }
    const opened: Buffer[] = [];
    for await (const part of crypto.openStream(ciphertext(), manifest, { artifactId, purpose: 'output' })) {
      opened.push(Buffer.from(part as Buffer));
    }
    expect(Buffer.concat(opened).equals(body)).toBe(true);
  });

  it('a single tampered chunk fails the open', async () => {
    const h = makeHarness();
    const artifactId = randomUUID();
    const crypto = h.ctx({ crypto: makeSeam() }).cryptoFor({ artifactId, purpose: 'output' });
    const body = randomBytes(6 * 1024 * 1024);
    async function* source(): AsyncGenerator<Buffer, void, void> {
      for (let off = 0; off < body.byteLength; off += 1024 * 1024) {
        yield body.subarray(off, Math.min(off + 1024 * 1024, body.byteLength));
      }
    }
    const sealed = crypto.sealStream(source(), { artifactId, purpose: 'output' });
    const parts: Buffer[] = [];
    for await (const part of sealed.ciphertext) parts.push(Buffer.from(part as Buffer));
    const manifest = await sealed.manifest;
    // The number of parts a consumer sees is a buffering artefact of Readable,
    // not a contract (a 4 MiB chunk can arrive coalesced with its neighbour),
    // so the tamper targets the last delivered part rather than an index.
    const last = parts[parts.length - 1]!;
    last[4] = (last[4] ?? 0) ^ 0xff;
    async function* corrupted(): AsyncGenerator<Buffer, void, void> {
      for (const part of parts) yield part;
    }
    const consume = async (): Promise<void> => {
      for await (const part of crypto.openStream(corrupted(), manifest, { artifactId, purpose: 'output' })) {
        void part;
      }
    };
    // The manifest itself is still authentic here, so the failure can only
    // surface as the chunk is decrypted - i.e. during consumption, not at the
    // openStream() call.
    await expect(consume).rejects.toThrow();
  });
});

describe('RV01-03 small-buffer round-trip through the seam', () => {
  it('reopens the exact bytes and refuses a tampered ciphertext', async () => {
    const h = makeHarness();
    const artifactId = randomUUID();
    const crypto = h.ctx({ crypto: makeSeam() }).cryptoFor({ artifactId, purpose: 'output' });
    const body = randomBytes(1024);
    const sealed = await crypto.seal(body, { artifactId, purpose: 'output' });
    expect(sha256(await crypto.open(sealed, { artifactId, purpose: 'output' }))).toBe(sha256(body));
    const flipped = Buffer.from(sealed.encrypted.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    await expect(
      crypto.open({ ...sealed, encrypted: { ...sealed.encrypted, ciphertext: flipped } }, { artifactId, purpose: 'output' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('an artifact sealed for one tenant does not open for another', async () => {
    const h = makeHarness();
    const artifactId = randomUUID();
    const seam = makeSeam();
    const owner = h.ctx({ crypto: seam }).cryptoFor({ artifactId, purpose: 'output' });
    const sealed = await owner.seal(Buffer.from(SENTINEL), { artifactId, purpose: 'output' });
    const intruder = h.ctx({ crypto: seam, __tenant: 'tenant-intruder' }).cryptoFor({
      artifactId,
      purpose: 'output',
    });
    expect(owner.tenantId).toBe(TENANT);
    expect(intruder.tenantId).not.toBe(owner.tenantId);
    await expect(intruder.open(sealed, { artifactId, purpose: 'output' })).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });
  });
});
