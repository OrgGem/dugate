import {
  restoredArtifactManifestObjectKey,
  restoredArtifactWriteMetadata,
} from '../src/modules/maintenance/trusted-backup-adapter';

describe('ORV14 restored artifact sidecar key', () => {
  it('uses the canonical artifact reader/gateway manifest key', () => {
    expect(restoredArtifactManifestObjectKey('tenant/artifact/ciphertext'))
      .toBe('tenant/artifact/ciphertext.crypto-manifest.json');
  });

  it('restores ciphertext and sidecar with canonical authenticated object metadata', () => {
    expect(restoredArtifactWriteMetadata({
      storageKey: 'tenant/artifact/ciphertext',
      artifactId: 'artifact-1',
      tenantId: 'tenant-1',
      sealed: true,
    })).toEqual({
      ciphertext: {
        artifactid: 'artifact-1',
        tenantid: 'tenant-1',
        'du-encrypted': 'aes-256-gcm-v1',
        'du-manifest-key': 'tenant/artifact/ciphertext.crypto-manifest.json',
      },
      manifest: {
        artifactid: 'artifact-1',
        tenantid: 'tenant-1',
        'du-encrypted': 'manifest-v1',
      },
    });
  });

  it('does not label a historical plaintext object as encrypted', () => {
    expect(restoredArtifactWriteMetadata({
      storageKey: 'tenant/artifact/plaintext',
      artifactId: 'artifact-2',
      tenantId: 'tenant-1',
      sealed: false,
    })).toEqual({});
  });
});
