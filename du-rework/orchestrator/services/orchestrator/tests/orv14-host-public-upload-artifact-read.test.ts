import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { createArtifactService } from '../src/modules/artifacts/artifacts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const generationId = '33333333-3333-4333-8333-333333333333';
const uploadToken = '44444444-4444-4444-8444-444444444444';
const storageKey = `${tenantId}/uploads/${artifactId}`;
const storageVersionId = 's3-object-version-a';
const manifestVersionId = 's3-sidecar-version-a';
const plaintext = Buffer.from('provider attachment plaintext from public upload');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function xor(bytes: Uint8Array, key: Uint8Array): Buffer {
  const result = Buffer.alloc(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) result[index] = (bytes[index] ?? 0) ^ (key[index % key.byteLength] ?? 0);
  return result;
}

function keyProvider(): KeyProvider {
  const wrappingKey = Buffer.alloc(32, 0x37);
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 1, ciphertext: xor(input.dek, wrappingKey).toString('base64') };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      return xor(Buffer.from(wrapped.ciphertext, 'base64'), wrappingKey);
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> { return wrapped; },
  };
}

async function fixture(options: { tamperCiphertext?: boolean } = {}) {
  const crypto = new CryptoStorageFacade(keyProvider());
  const sealed = await crypto.encrypt(plaintext, {
    tenantId, artifactId, objectVersion: uploadToken, purpose: 'public-artifact-upload', keyRef: 'artifact-key-a', keyVersion: 1,
  });
  const ciphertext = Buffer.from(sealed.ciphertext);
  const ciphertextSha256 = sha256(ciphertext);
  const wrappedSidecar = Buffer.from(JSON.stringify({
    version: 1,
    kind: 'single',
    artifactId,
    tenantId,
    objectVersion: uploadToken,
    ciphertextSizeBytes: ciphertext.byteLength,
    ciphertextSha256,
    encryption: {
      version: sealed.version,
      algorithm: sealed.algorithm,
      nonce: sealed.nonce,
      tag: sealed.tag,
      aad: sealed.aad,
      plaintextSizeBytes: sealed.plaintextSizeBytes,
      plaintextSha256: sealed.plaintextSha256,
      dek: sealed.dek,
    },
  }));
  const row = {
    id: artifactId,
    tenantId,
    state: 'READY',
    purpose: 'input',
    fileName: 'evidence.txt',
    mimeType: 'text/plain',
    sizeBytes: ciphertext.byteLength,
    sha256: ciphertextSha256,
    storageBackend: 's3',
    storageGenerationId: generationId,
    storageKey,
    storageVersionId,
    manifestVersionId,
    uploadToken,
  };
  const database = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM artifacts')) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const requestedVersions: string[] = [];
  const storage = {
    async openRead(input: { objectKey: string; versionId: string }): Promise<Readable> {
      requestedVersions.push(`${input.objectKey}@${input.versionId}`);
      if (input.objectKey === storageKey && input.versionId === storageVersionId) {
        const body = Buffer.from(ciphertext);
        if (options.tamperCiphertext) body[0] = (body[0] ?? 0) ^ 0x01;
        return Readable.from([body]);
      }
      if (input.objectKey === `${storageKey}.crypto-manifest.json` && input.versionId === manifestVersionId) {
        return Readable.from([wrappedSidecar]);
      }
      throw new Error('unexpected generation or object version');
    },
  };
  const forGeneration = jest.fn((selected: string) => {
    if (selected !== generationId) throw new Error('wrong storage generation');
    return storage;
  });
  const service = createArtifactService(database as never, {
    storageBackend: 's3',
    storageGenerations: { forGeneration } as never,
    encryption: { facade: crypto, keyRef: 'artifact-key-a', keyVersion: 1, required: true },
    maxArtifactBytes: 10 * 1024 * 1024,
  });
  return { service, row, forGeneration, requestedVersions, ciphertextSha256, wrappedSidecar };
}

describe('ORV14 Host public-upload artifact reader', () => {
  it('serves plaintext from getBlob while retaining the physical ciphertext row facts internally', async () => {
    const state = await fixture();
    const stream = await state.service.getBlob(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    expect(state.forGeneration).toHaveBeenCalledWith(generationId);
  });

  it('opens the exact gateway v1 ciphertext and returns logical plaintext pins', async () => {
    const state = await fixture();
    const result = await state.service.readInvocationArtifacts({ tenantId, artifactIds: [artifactId] });

    expect(Buffer.from(result.contents[0]!.contentBase64, 'base64')).toEqual(plaintext);
    expect(result.pins[0]).toMatchObject({
      artifactId,
      sizeBytes: plaintext.byteLength,
      sha256: sha256(plaintext),
      storageVersionId,
      storageGenerationId: generationId,
      integrity: {
        databaseMetadata: { kind: 'gateway-ciphertext', sha256: state.ciphertextSha256, sizeBytes: state.row.sizeBytes },
        content: { sha256: sha256(plaintext), sizeBytes: plaintext.byteLength },
        storedObject: {
          sha256: state.ciphertextSha256,
          sizeBytes: state.row.sizeBytes,
          versionId: storageVersionId,
          storageGenerationId: generationId,
        },
        sidecar: {
          sha256: sha256(state.wrappedSidecar),
          sizeBytes: state.wrappedSidecar.byteLength,
          versionId: manifestVersionId,
        },
        verified: true,
      },
    });
    expect(result.pins[0]!.sha256).not.toBe(state.ciphertextSha256);
    expect(state.forGeneration).toHaveBeenCalledWith(generationId);
    expect(state.requestedVersions).toEqual(expect.arrayContaining([
      `${storageKey}@${storageVersionId}`,
      `${storageKey}.crypto-manifest.json@${manifestVersionId}`,
    ]));
  });

  it('rejects ciphertext tampering before returning any plaintext', async () => {
    const state = await fixture({ tamperCiphertext: true });
    await expect(state.service.readInvocationArtifacts({ tenantId, artifactIds: [artifactId] }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});
