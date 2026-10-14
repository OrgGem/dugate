import type { KeyProvider, WrappedDek, WrapDekInput } from '../src/modules/encryption/vault-transit-provider';
import {
  createHybridKeyProvider,
  createLocalKeyProvider,
  LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV,
  LOCAL_ENCRYPTION_KEYRING_ENV,
  LOCAL_METADATA_KEY_REF,
  LOCAL_PUBLIC_UPLOAD_KEY_REF,
  parseLocalEncryptionKeyring,
} from '../src/modules/encryption/local-key-provider';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../src/modules/runtime/metadata-crypto';

const keyring = {
  activeVersion: 2,
  keys: {
    '1': Buffer.alloc(32, 0x11),
    '2': Buffer.alloc(32, 0x22),
  },
};

function makeVaultProvider(overrides: {
  wrapDek?: KeyProvider['wrapDek'];
  unwrapDek?: KeyProvider['unwrapDek'];
} = {}): { provider: KeyProvider; calls: { wraps: number; unwraps: number } } {
  const calls = { wraps: 0, unwraps: 0 };
  const provider: KeyProvider = {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      calls.wraps += 1;
      if (overrides.wrapDek) return overrides.wrapDek(input);
      return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 3, ciphertext: 'vault:v3:wrapped-dek' };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      calls.unwraps += 1;
      if (overrides.unwrapDek) return overrides.unwrapDek(wrapped);
      return Buffer.alloc(32, 0x33);
    },
    async rewrap(wrapped: WrappedDek, targetKeyVersion?: number): Promise<WrappedDek> {
      return { ...wrapped, keyVersion: targetKeyVersion ?? wrapped.keyVersion };
    },
  };
  return { provider, calls };
}

describe('local encryption key provider', () => {
  test('derives a stable domain-separated key from a retained master and accepts explicit versioned rings', () => {
    const derived = parseLocalEncryptionKeyring({ ENCRYPTION_KEY: 'retained-master-key-value-0123456789' });
    expect(derived?.activeVersion).toBe(1);
    expect(derived?.keys['1']).toHaveLength(32);

    const key1 = Buffer.alloc(32, 0x41).toString('base64');
    const key7 = Buffer.alloc(32, 0x47).toString('base64');
    const explicit = parseLocalEncryptionKeyring({
      [LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV]: '7',
      [LOCAL_ENCRYPTION_KEYRING_ENV]: JSON.stringify({ 1: key1, 7: key7 }),
      ENCRYPTION_KEY: 'ignored-because-explicit-keyring-is-set',
    });
    expect(explicit?.activeVersion).toBe(7);
    expect(explicit?.keys['1']).toEqual(Buffer.alloc(32, 0x41));
    expect(explicit?.keys['7']).toEqual(Buffer.alloc(32, 0x47));
    expect(() => parseLocalEncryptionKeyring({ ENCRYPTION_KEY: 'too-short' }))
      .toThrow(/at least 32 bytes/);
  });

  test('wraps DEKs with AES-GCM and binds the local wrapper to key ref and retained version', async () => {
    const provider = createLocalKeyProvider(keyring, [LOCAL_METADATA_KEY_REF, LOCAL_PUBLIC_UPLOAD_KEY_REF]);
    const dek = Buffer.alloc(32, 0x65);
    const wrapped = await provider.wrapDek({ keyRef: LOCAL_METADATA_KEY_REF, dek });
    expect(wrapped.providerKind).toBe('local-keyring');
    expect(wrapped.keyVersion).toBe(2);
    expect(wrapped.ciphertext).not.toContain(dek.toString('base64'));
    await expect(provider.unwrapDek(wrapped)).resolves.toEqual(dek);
    await expect(provider.unwrapDek({ ...wrapped, keyRef: LOCAL_PUBLIC_UPLOAD_KEY_REF }))
      .rejects.toThrow(/authenticated decryption/);
    await expect(provider.unwrapDek({ ...wrapped, keyRef: 'unknown-key-ref' }))
      .rejects.toThrow(/not configured/);
    await expect(provider.unwrapDek({ ...wrapped, keyVersion: 1 }))
      .rejects.toThrow(/authenticated decryption/);
    await expect(provider.unwrapDek({ ...wrapped, keyVersion: 9 }))
      .rejects.toThrow(/not retained/);
  });

  test('opens both private envelope kinds but never downgrades a Vault unwrap failure', async () => {
    const local = createLocalKeyProvider(keyring, [LOCAL_METADATA_KEY_REF]);
    const vault = makeVaultProvider();
    const hybrid = createHybridKeyProvider({
      vaultProvider: vault.provider,
      localProvider: local,
      writeProvider: 'vault-transit',
    });
    const localDek = Buffer.alloc(32, 0x12);
    const localWrapped = await local.wrapDek({ keyRef: LOCAL_METADATA_KEY_REF, dek: localDek });
    await expect(hybrid.unwrapDek(localWrapped)).resolves.toEqual(localDek);
    expect(vault.calls.unwraps).toBe(0);

    const legacyVaultEnvelope: WrappedDek = {
      keyRef: 'old-vault-key',
      keyVersion: 3,
      ciphertext: 'vault:v3:legacy',
    };
    await expect(hybrid.unwrapDek(legacyVaultEnvelope)).resolves.toEqual(Buffer.alloc(32, 0x33));
    expect(vault.calls.unwraps).toBe(1);

    const outage = makeVaultProvider({ unwrapDek: async () => { throw new Error('Vault unavailable'); } });
    const failingHybrid = createHybridKeyProvider({
      vaultProvider: outage.provider,
      localProvider: local,
      writeProvider: 'vault-transit',
    });
    await expect(failingHybrid.unwrapDek(legacyVaultEnvelope)).rejects.toThrow('Vault unavailable');
    expect(outage.calls.unwraps).toBe(1);
  });

  test('keeps retained old versions readable and rewraps them to the active local version', async () => {
    const provider = createLocalKeyProvider(keyring, [LOCAL_METADATA_KEY_REF]);
    const oldDek = Buffer.alloc(32, 0x19);
    const oldWrapped = await provider.wrapDek({ keyRef: LOCAL_METADATA_KEY_REF, dek: oldDek, keyVersion: 1 });
    const rewrapped = await provider.rewrap(oldWrapped, 2);
    expect(rewrapped).toMatchObject({ providerKind: 'local-keyring', keyVersion: 2 });
    await expect(provider.unwrapDek(rewrapped)).resolves.toEqual(oldDek);
  });

  test('writes with Vault when selected and refuses legacy Vault envelopes in local-only mode', async () => {
    const local = createLocalKeyProvider(keyring, [LOCAL_METADATA_KEY_REF]);
    const vault = makeVaultProvider();
    const vaultPreferred = createHybridKeyProvider({
      vaultProvider: vault.provider,
      localProvider: local,
      writeProvider: 'vault-transit',
    });
    await expect(vaultPreferred.wrapDek({ keyRef: 'vault-key', dek: Buffer.alloc(32, 1) }))
      .resolves.toMatchObject({ ciphertext: 'vault:v3:wrapped-dek' });
    expect(vault.calls.wraps).toBe(1);

    const localWrap = jest.spyOn(local, 'wrapDek');
    const failedVault = makeVaultProvider({ wrapDek: async () => { throw new Error('Vault unavailable'); } });
    const failedWrite = createHybridKeyProvider({
      vaultProvider: failedVault.provider,
      localProvider: local,
      writeProvider: 'vault-transit',
    });
    await expect(failedWrite.wrapDek({ keyRef: 'vault-key', dek: Buffer.alloc(32, 2) }))
      .rejects.toThrow('Vault unavailable');
    expect(localWrap).not.toHaveBeenCalled();

    const localOnly = createHybridKeyProvider({ localProvider: local, writeProvider: 'local-keyring' });
    await expect(localOnly.unwrapDek({ keyRef: 'old-vault-key', keyVersion: 3, ciphertext: 'vault:v3:legacy' }))
      .rejects.toThrow('Vault Transit is required to open this wrapped DEK');
  });

  test('metadata and PostgreSQL upload payloads round-trip through the retained local keyring', async () => {
    const provider = createLocalKeyProvider(keyring, [LOCAL_METADATA_KEY_REF, LOCAL_PUBLIC_UPLOAD_KEY_REF]);
    const metadata = createMetadataCrypto(adaptKeyProviderForMetadata(provider), LOCAL_METADATA_KEY_REF);
    const context = { tenantId: 'tenant-local', slot: 'tasks.payload_ref' as const, refId: 'task-local' };
    const sealed = await metadata.seal({ token: 'private-metadata-sentinel' }, context);
    expect(JSON.stringify(sealed)).not.toContain('private-metadata-sentinel');
    expect(sealed.dek.providerKind).toBe('local-keyring');
    await expect(metadata.open(sealed, context)).resolves.toEqual({ token: 'private-metadata-sentinel' });

    const storage = new CryptoStorageFacade(provider);
    const plaintext = Buffer.from('private-upload-sentinel');
    const encrypted = await storage.encrypt(plaintext, {
      tenantId: 'tenant-local',
      artifactId: 'artifact-local',
      objectVersion: 'v1',
      keyRef: LOCAL_PUBLIC_UPLOAD_KEY_REF,
    });
    expect(encrypted.dek.providerKind).toBe('local-keyring');
    expect(encrypted.ciphertext.includes(plaintext)).toBe(false);
    await expect(storage.decrypt(encrypted, {
      tenantId: 'tenant-local', artifactId: 'artifact-local', objectVersion: 'v1',
    })).resolves.toEqual(plaintext);

    const vault = makeVaultProvider();
    const hybrid = createHybridKeyProvider({
      vaultProvider: vault.provider,
      localProvider: provider,
      writeProvider: 'vault-transit',
    });
    const transitMetadata = createMetadataCrypto(adaptKeyProviderForMetadata(hybrid), 'transit-metadata');
    await expect(transitMetadata.open(sealed, context)).resolves.toEqual({ token: 'private-metadata-sentinel' });
    const transitStorage = new CryptoStorageFacade(hybrid);
    await expect(transitStorage.decrypt(encrypted, {
      tenantId: 'tenant-local', artifactId: 'artifact-local', objectVersion: 'v1',
    })).resolves.toEqual(plaintext);
  });
});
