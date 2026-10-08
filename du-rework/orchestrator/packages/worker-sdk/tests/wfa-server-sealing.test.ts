import { createHash, randomUUID } from 'node:crypto';
import { ArtifactUploadGrantSchema } from '@du/contracts';
import { Logger } from '@du/observability';
import { DefaultTaskContext, RuntimeClient } from '../src';
import { CryptoStorageFacade, type CryptoKeyProvider } from '../src/crypto-storage';

function harness(serverSealing: boolean, workerCrypto: boolean) {
  const artifactId = randomUUID();
  let uploaded: Buffer | undefined;
  let finalized: Record<string, unknown> | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/artifacts')) {
      return Response.json({ artifactId, uploadUrl: 'http://runtime.test/upload',
        expiresAt: '2099-01-01T00:00:00.000Z', ...(serverSealing ? { storageEncryption: 'server' } : {}) });
    }
    if (url.endsWith('/upload')) {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Buffer[] = [];
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(Buffer.from(chunk.value));
      }
      uploaded = Buffer.concat(chunks);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith('/finalize')) {
      finalized = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  // Synthetic test provider, never used for production or persisted in fixtures.
  const provider: CryptoKeyProvider = {
    async wrapDek(input) { return { keyRef: input.keyRef, keyVersion: 1, ciphertext: Buffer.from(input.dek).toString('base64') }; },
    async unwrapDek(input) { return Buffer.from(input.ciphertext, 'base64'); },
  };
  const facade = new CryptoStorageFacade(provider);
  const encrypt = jest.spyOn(facade, 'encrypt');
  const context = new DefaultTaskContext({
    taskId: randomUUID(), operationId: randomUUID(), tenantId: 'synthetic-tenant',
    businessId: 'document-core', businessVersion: '1.1.0', action: 'schema-workflow',
    kind: 'root', taskKey: 'root', attempt: 1, leaseEpoch: 1,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', deadlineAt: null,
    input: {}, connectorBindings: {}, checkpointRefs: [], cancelRequested: false,
  }, {
    runtime: new RuntimeClient({ baseUrl: 'http://runtime.test/api/runtime/v1', token: 'synthetic-token', fetchImpl }),
    fetchImpl, encryptionEnabled: true,
    ...(workerCrypto ? { crypto: { facade, keyRef: 'synthetic-worker-key' } } : {}),
    logger: new Logger({ service: 'wfa-sdk-test', environment: 'test', sink: { write() {} } }),
    invokeConnector: async () => { throw new Error('not used'); },
  });
  return { context, encrypt, uploaded: () => uploaded, finalized: () => finalized };
}

describe('WFA authenticated server-sealing negotiation', () => {
  it.each([true, false])('uses plaintext internal transport with server grant, worker crypto=%s', async (workerCrypto) => {
    const test = harness(true, workerCrypto);
    const plaintext = Buffer.from('synthetic-checkpoint');
    await test.context.artifacts.write(plaintext, 'checkpoint.json', 'application/json', 'intermediate');
    expect(test.uploaded()).toEqual(plaintext);
    expect(test.encrypt).not.toHaveBeenCalled();
    expect(test.finalized()).toMatchObject({ sizeBytes: plaintext.length,
      sha256: createHash('sha256').update(plaintext).digest('hex') });
  });

  it('refuses encryption-enabled write without crypto or an explicit server grant', async () => {
    const test = harness(false, false);
    await expect(test.context.artifacts.write('synthetic', 'checkpoint.json', 'application/json')).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED_UNAVAILABLE' });
    expect(test.uploaded()).toBeUndefined();
    expect(test.finalized()).toBeUndefined();
  });

  it('retains existing worker-sealing behavior when the runtime does not negotiate server mode', async () => {
    const test = harness(false, true);
    const plaintext = Buffer.from('synthetic-checkpoint');
    await test.context.artifacts.write(plaintext, 'checkpoint.json', 'application/json');
    expect(test.encrypt).toHaveBeenCalledTimes(1);
    expect(test.uploaded()).not.toEqual(plaintext);
  });

  it('rejects unsupported negotiation values instead of treating them as server sealing', () => {
    expect(ArtifactUploadGrantSchema.safeParse({ artifactId: randomUUID(), uploadUrl: 'http://runtime.test/upload',
      expiresAt: '2099-01-01T00:00:00.000Z', storageEncryption: 'plaintext' }).success).toBe(false);
  });
});
