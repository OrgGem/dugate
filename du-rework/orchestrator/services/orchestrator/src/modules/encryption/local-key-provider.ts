import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { KeyProvider, WrappedDek } from './vault-transit-provider';

export const LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV = 'DU_LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION';
export const LOCAL_ENCRYPTION_KEYRING_ENV = 'DU_LOCAL_ENCRYPTION_KEYRING_JSON';

export const LOCAL_METADATA_KEY_REF = 'local-metadata-v1';
export const LOCAL_PUBLIC_UPLOAD_KEY_REF = 'local-public-upload-v1';

const LOCAL_PROVIDER_KIND = 'local-keyring' as const;
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = NONCE_BYTES + TAG_BYTES + DEK_BYTES;
const MAX_KEY_VERSION = 2_147_483_647;
const KEY_VERSION = /^[1-9][0-9]{0,9}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface LocalEncryptionKeyring {
  readonly activeVersion: number;
  /** Retain every key version still referenced by a stored wrapped DEK. */
  readonly keys: Readonly<Record<string, Buffer>>;
}

export class LocalKeyProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LocalKeyProviderError';
  }
}

function wrapAad(keyRef: string, keyVersion: number): Buffer {
  return Buffer.from(`du-orchestrator-local-dek-wrap-v1\0${keyRef}\0${keyVersion}`, 'utf8');
}

function validateKeyRef(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
      || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new LocalKeyProviderError('local wrapped DEK key reference is invalid');
  }
}

function activeVersionFrom(raw: string): number {
  if (!KEY_VERSION.test(raw)) throw new LocalKeyProviderError(`${LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV} must be a positive integer`);
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version > MAX_KEY_VERSION) {
    throw new LocalKeyProviderError(`${LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV} must be a positive integer`);
  }
  return version;
}

/**
 * Read an explicit retained local keyring, or derive its first version from
 * ENCRYPTION_KEY. The HMAC label separates wrapping keys from profile and
 * Secret Catalog keys while preserving the retained master across restarts.
 */
export function parseLocalEncryptionKeyring(
  env: Readonly<Record<string, string | undefined>>,
): LocalEncryptionKeyring | undefined {
  const activeRaw = env[LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV]?.trim();
  const ringRaw = env[LOCAL_ENCRYPTION_KEYRING_ENV]?.trim();
  if (activeRaw || ringRaw) {
    if (!activeRaw || !ringRaw) {
      throw new LocalKeyProviderError(`${LOCAL_ENCRYPTION_ACTIVE_KEY_VERSION_ENV} and ${LOCAL_ENCRYPTION_KEYRING_ENV} must be configured together`);
    }
    const activeVersion = activeVersionFrom(activeRaw);
    let decoded: unknown;
    try { decoded = JSON.parse(ringRaw); } catch {
      throw new LocalKeyProviderError(`${LOCAL_ENCRYPTION_KEYRING_ENV} must be valid JSON`);
    }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new LocalKeyProviderError(`${LOCAL_ENCRYPTION_KEYRING_ENV} must be a version-to-base64-key object`);
    }
    const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
    for (const [rawVersion, encoded] of Object.entries(decoded)) {
      if (!KEY_VERSION.test(rawVersion) || Number(rawVersion) > MAX_KEY_VERSION || typeof encoded !== 'string') {
        throw new LocalKeyProviderError('local encryption keyring entry is invalid');
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.byteLength !== DEK_BYTES || key.toString('base64') !== encoded) {
        key.fill(0);
        throw new LocalKeyProviderError('local encryption keys must be canonical base64 32-byte values');
      }
      keys[rawVersion] = key;
    }
    if (!Object.hasOwn(keys, String(activeVersion))) {
      throw new LocalKeyProviderError('active local encryption key version is not present in the keyring');
    }
    return { activeVersion, keys };
  }

  const master = env['ENCRYPTION_KEY'];
  if (master === undefined || master.length === 0) return undefined;
  if (Buffer.byteLength(master, 'utf8') < DEK_BYTES) {
    throw new LocalKeyProviderError('ENCRYPTION_KEY must contain at least 32 bytes for local encryption key derivation');
  }
  const derived = createHmac('sha256', Buffer.from(master, 'utf8'))
    .update('du-orchestrator/local-dek-wrap/v1', 'utf8')
    .digest();
  return { activeVersion: 1, keys: { '1': derived } };
}

function keyForVersion(keyring: LocalEncryptionKeyring, version: number): Buffer {
  const key = keyring.keys[String(version)];
  if (!key || !Buffer.isBuffer(key) || key.byteLength !== DEK_BYTES) {
    throw new LocalKeyProviderError(`local encryption key version ${version} is not retained`);
  }
  return key;
}

function versionFromUnknown(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_KEY_VERSION) {
    throw new LocalKeyProviderError('local wrapped DEK key version is invalid');
  }
  return value as number;
}

function wrappedFields(value: WrappedDek): { keyRef: string; keyVersion: number; ciphertext: string } {
  if (value.providerKind !== LOCAL_PROVIDER_KIND) {
    throw new LocalKeyProviderError('wrapped DEK does not use the local keyring provider');
  }
  validateKeyRef(value.keyRef);
  const keyVersion = versionFromUnknown(value.keyVersion);
  if (typeof value.ciphertext !== 'string' || !BASE64.test(value.ciphertext)) {
    throw new LocalKeyProviderError('local wrapped DEK ciphertext is invalid');
  }
  const bytes = Buffer.from(value.ciphertext, 'base64');
  if (bytes.byteLength !== WRAPPED_BYTES || bytes.toString('base64') !== value.ciphertext) {
    bytes.fill(0);
    throw new LocalKeyProviderError('local wrapped DEK ciphertext is invalid');
  }
  return { keyRef: value.keyRef, keyVersion, ciphertext: value.ciphertext };
}

export function createLocalKeyProvider(
  keyring: LocalEncryptionKeyring,
  allowedKeyRefs: readonly string[],
): KeyProvider {
  if (!Number.isSafeInteger(keyring.activeVersion) || keyring.activeVersion < 1
      || keyring.activeVersion > MAX_KEY_VERSION) {
    throw new LocalKeyProviderError('local encryption active key version is invalid');
  }
  const allowed = new Set(allowedKeyRefs);
  if (allowed.size === 0 || allowed.size !== allowedKeyRefs.length) {
    throw new LocalKeyProviderError('local encryption key references must be non-empty and unique');
  }
  for (const ref of allowed) validateKeyRef(ref);
  keyForVersion(keyring, keyring.activeVersion);

  return {
    async wrapDek(input): Promise<WrappedDek> {
      validateKeyRef(input.keyRef);
      if (!allowed.has(input.keyRef)) throw new LocalKeyProviderError('local encryption key reference is not configured');
      const keyVersion = input.keyVersion ?? keyring.activeVersion;
      const wrappingKey = keyForVersion(keyring, keyVersion);
      const dek = Buffer.from(input.dek);
      if (dek.byteLength !== DEK_BYTES) {
        dek.fill(0);
        throw new LocalKeyProviderError('DEK must contain exactly 32 bytes');
      }
      const nonce = randomBytes(NONCE_BYTES);
      try {
        const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(wrapAad(input.keyRef, keyVersion));
        const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
        return {
          providerKind: LOCAL_PROVIDER_KIND,
          keyRef: input.keyRef,
          keyVersion,
          ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64'),
        };
      } finally {
        dek.fill(0);
      }
    },
    async unwrapDek(wrapped): Promise<Buffer> {
      const { keyRef, keyVersion, ciphertext } = wrappedFields(wrapped);
      if (!allowed.has(keyRef)) throw new LocalKeyProviderError('local encryption key reference is not configured');
      const wrappingKey = keyForVersion(keyring, keyVersion);
      const bytes = Buffer.from(ciphertext, 'base64');
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const tag = bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const encryptedDek = bytes.subarray(NONCE_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(wrapAad(keyRef, keyVersion));
        decipher.setAuthTag(tag);
        const dek = Buffer.concat([decipher.update(encryptedDek), decipher.final()]);
        if (dek.byteLength !== DEK_BYTES) {
          dek.fill(0);
          throw new LocalKeyProviderError('local wrapped DEK has an invalid plaintext length');
        }
        return dek;
      } catch (error) {
        if (error instanceof LocalKeyProviderError) throw error;
        throw new LocalKeyProviderError('local wrapped DEK failed authenticated decryption');
      } finally {
        bytes.fill(0);
      }
    },
    async rewrap(wrapped, targetKeyVersion): Promise<WrappedDek> {
      const dek = await this.unwrapDek(wrapped);
      try {
        return await this.wrapDek({ keyRef: wrapped.keyRef, dek, ...(targetKeyVersion === undefined ? {} : { keyVersion: targetKeyVersion }) });
      } finally {
        dek.fill(0);
      }
    },
  };
}

/**
 * Prefer the configured provider for new writes. Reads dispatch only on the
 * private envelope discriminator; an unavailable provider never triggers a
 * retry through the other key store.
 */
export function createHybridKeyProvider(input: {
  readonly vaultProvider?: KeyProvider;
  readonly localProvider?: KeyProvider;
  readonly writeProvider: 'vault-transit' | 'local-keyring';
}): KeyProvider {
  const { vaultProvider, localProvider, writeProvider } = input;
  if (!vaultProvider && !localProvider) throw new LocalKeyProviderError('no encryption key provider is configured');
  if (writeProvider === 'vault-transit' && !vaultProvider) throw new LocalKeyProviderError('Vault Transit write provider is not configured');
  if (writeProvider === 'local-keyring' && !localProvider) throw new LocalKeyProviderError('local keyring write provider is not configured');

  const providerFor = (wrapped: WrappedDek): KeyProvider => {
    if (wrapped.providerKind === LOCAL_PROVIDER_KIND) {
      if (!localProvider) throw new LocalKeyProviderError('local keyring is required to open this wrapped DEK');
      return localProvider;
    }
    if (wrapped.providerKind === undefined || wrapped.providerKind === 'vault-transit') {
      if (!vaultProvider) throw new LocalKeyProviderError('Vault Transit is required to open this wrapped DEK');
      return vaultProvider;
    }
    throw new LocalKeyProviderError('wrapped DEK provider kind is unsupported');
  };

  return {
    wrapDek: (wrapped) => (writeProvider === 'vault-transit' ? vaultProvider! : localProvider!).wrapDek(wrapped),
    unwrapDek: async (wrapped) => providerFor(wrapped).unwrapDek(wrapped),
    rewrap: (wrapped, targetKeyVersion) => providerFor(wrapped).rewrap(wrapped, targetKeyVersion),
  };
}
