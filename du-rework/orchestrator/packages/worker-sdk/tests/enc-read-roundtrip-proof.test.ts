/**
 * PROOF (diagnostic, cycle 24): a seam-enabled write leaves the durable object
 * UNDECRYPTABLE, because the envelope metadata a reader needs is discarded.
 *
 * The write path in task-context.ts uploads ONLY sealed.encrypted.ciphertext and
 * reports ciphertext size/digest to finalizeArtifact. The nonce, tag, AAD and
 * wrapped DEK are never persisted anywhere, and the read path calls
 * openArtifactStream with no decryption at all. So a document written with a
 * seam comes back as ciphertext.
 *
 * The provider is a real reversible transform, not an echo: an echo would make
 * a broken binding look authenticated.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DefaultTaskContext, RuntimeClient } from '../src';
import { CryptoStorageFacade, type CryptoKeyProvider, type WrappedDek } from '../src/crypto-storage';
import type { WorkerCryptoSeam } from '../src/crypto-seam';

const KEY_REF = 'du-roundtrip-v1';
const SENTINEL = 'CONFIDENTIAL-ROUNDTRIP-BODY-7f3a21';

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'roundtrip-double').update(seed + String.fromCharCode(58) + block).digest();
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

describe('PROOF: a seam-enabled write leaves the stored object undecryptable', () => {
  it('read() returns ciphertext and no envelope survives the round trip', async () => {
    const TASK_ID = randomUUID();
    const ARTIFACT_ID = randomUUID();
    const bytes = Buffer.from(SENTINEL, 'utf8');
    let stored: Buffer = Buffer.alloc(0);

    const json = (v: unknown) =>
      new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/artifacts') && method === 'POST') {
        return json({
          artifactId: ARTIFACT_ID,
          uploadUrl: `https://blob.test/${ARTIFACT_ID}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      if (url === `https://blob.test/${ARTIFACT_ID}` && method === 'PUT') {
        const body = init?.body as ReadableStream<Uint8Array>;
        const parts: Buffer[] = [];
        const reader = body.getReader();
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(Buffer.from(next.value));
        }
        stored = Buffer.concat(parts);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/finalize`)) return new Response(null, { status: 200 });
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return json({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: 'secret.txt',
          mimeType: 'text/plain',
          sizeBytes: stored.length,
          sha256: createHash('sha256').update(stored).digest('hex'),
        });
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download`) return new Response(stored, { status: 200 });
      return new Response('unexpected', { status: 404 });
    }) as typeof fetch;

    const runtime = new RuntimeClient({ baseUrl: 'http://runtime.test/api/runtime/v1', token: 't', fetchImpl });
    const seam: WorkerCryptoSeam = { facade: new CryptoStorageFacade(makeProvider()), keyRef: KEY_REF };

    const ctx = new DefaultTaskContext(
      {
        taskId: TASK_ID,
        operationId: randomUUID(),
        tenantId: 'tenant-rt',
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        taskKey: 'k',
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        checkpointRefs: [],
        cancelRequested: false,
      } as never,
      {
        runtime,
        fetchImpl,
        crypto: seam,
        logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
        invokeConnector: async () => {
          throw new Error('unused');
        },
      } as never
    );

    await ctx.artifacts.write(bytes, 'secret.txt', 'text/plain', 'output');

    // 1. The durable object is genuinely NOT the plaintext.
    expect(stored.equals(bytes)).toBe(false);
    expect(stored.includes(SENTINEL)).toBe(false);

    // 2. Reading it back yields the ciphertext, not the document.
    const readBack = await ctx.artifacts.read(ARTIFACT_ID);
    expect(readBack.equals(bytes)).toBe(false);
  });
});
