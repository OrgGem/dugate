import { decryptStoredArtifact, type StoredObjectReader } from '../src/modules/encryption/artifact-read-decrypt';

function reader(payload: Buffer, onRead?: () => void): StoredObjectReader {
  return {
    async head() { return {}; },
    async read() { onRead?.(); return payload; },
    async readManifest() { throw new Error('not used'); },
  };
}

describe('ORV14 artifact generation reader', () => {
  it('resolves the exact row-pinned generation for reads', async () => {
    const bytes = Buffer.from('generation A payload');
    const fallbackRead = jest.fn();
    const generationRead = jest.fn();
    const result = await decryptStoredArtifact({
      reader: reader(Buffer.from('wrong current generation'), fallbackRead),
      readerForArtifact: async ({ storageGenerationId }) => {
        expect(storageGenerationId).toBe('11111111-1111-4111-8111-111111111111');
        return reader(bytes, generationRead);
      },
    }, {
      artifactId: 'artifact-1', tenantId: 'tenant-1', storageKey: 'object/1', uploadToken: 'version-A',
      storageGenerationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(result.bytes).toEqual(bytes);
    expect(generationRead).toHaveBeenCalledTimes(1);
    expect(fallbackRead).not.toHaveBeenCalled();
  });

  it('fails closed if a generation-pinned artifact has no generation resolver', async () => {
    await expect(decryptStoredArtifact({ reader: reader(Buffer.from('wrong generation')) }, {
      artifactId: 'artifact-1', tenantId: 'tenant-1', storageKey: 'object/1', uploadToken: 'version-A',
      storageGenerationId: '11111111-1111-4111-8111-111111111111',
    })).rejects.toMatchObject({ status: 503, code: 'STORAGE_FAILURE' });
  });
});
