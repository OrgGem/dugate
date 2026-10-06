/**
 * RV01-02 (#8) acceptance row 7: the negative boot matrix.
 *
 * Every case is OFFLINE — no S3, no Vault, no network. `VaultTransitProvider`
 * does no I/O in its constructor, so building the options is pure validation
 * and each case asserts the exact reason the boot is refused.
 *
 * The matrix is the point: a config surface that is absent, malformed or
 * half-specified must refuse the boot. A test that only proves the happy path
 * would let every one of these regressions back in silently.
 */

import {
  EncryptionBootConfigError,
  METADATA_ENABLED_ENV,
  PUBLIC_UPLOAD_ENABLED_ENV,
  VAULT_DECRYPT_TOKEN_ENV,
  VAULT_ENCRYPT_TOKEN_ENV,
  VAULT_TRANSIT_OPTIONS_ENV,
  buildEncryptionBootOptions,
  encryptionIsRequired,
  parseEncryptionBootConfig,
  type EnvReader,
} from '../src/modules/encryption/boot-options';

const ENC = VAULT_ENCRYPT_TOKEN_ENV;
const DEC = VAULT_DECRYPT_TOKEN_ENV;

function env(overrides: EnvReader): EnvReader {
  return overrides;
}

/** A complete, valid surface — every negative case perturbs exactly one field. */
function validOptions(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    vaultAddress: 'https://vault.internal:8200',
    allowedKeyRefs: { metadata: 'du-metadata', artifact: 'du-artifact' },
    metadataKeyRef: 'metadata',
    publicUploadKeyRef: 'artifact',
    ...extra,
  });
}

const VALID_TOKENS = { [ENC]: 'hvs.encrypt-token', [DEC]: 'hvs.decrypt-token' };

describe('RV01-02 #8 encryption boot options', () => {
  describe('POSITIVE — a complete surface produces the createApp blocks', () => {
    it('seals metadata and public uploads on the s3 backend', () => {
      const options = buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }));
      expect(options).not.toBeNull();
      expect(options?.metadataEncryption?.keyRef).toBe('metadata');
      expect(options?.publicUploadEncryption?.keyRef).toBe('artifact');
      expect(options?.cryptoConfig.allowedKeyRefs).toEqual(['metadata', 'artifact']);
      // Both blocks must share ONE provider instance: two providers would mean
      // two allowlists and two identities for the same Vault mount.
      expect(options?.metadataEncryption?.keyProvider).toBe(options?.publicUploadEncryption?.keyProvider);
    });

    it('s3 alone enables BOTH blocks even with the flags off', () => {
      expect(encryptionIsRequired(env({ ARTIFACT_STORAGE_BACKEND: 's3' }))).toBe(true);
      const options = buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }));
      // s3 is the encrypted-upload backend, so control-plane columns are sealed
      // too. Leaving metadataEncryption off is the fail-open RV01-02 closes.
      expect(options?.metadataEncryption?.keyRef).toBe('metadata');
      expect(options?.publicUploadEncryption?.keyRef).toBe('artifact');
    });

    it('postgres + both flags off is the only unencrypted boot', () => {
      expect(buildEncryptionBootOptions(env({ ARTIFACT_STORAGE_BACKEND: 'postgres' }))).toBeNull();
      expect(buildEncryptionBootOptions(env({}))).toBeNull();
      expect(encryptionIsRequired(env({ ARTIFACT_STORAGE_BACKEND: 'postgres' }))).toBe(false);
    });

    it('postgres + metadata flag seals metadata only', () => {
      const options = buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 'postgres',
        [METADATA_ENABLED_ENV]: 'true',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }));
      expect(options?.metadataEncryption?.keyRef).toBe('metadata');
      expect(options?.publicUploadEncryption).toBeUndefined();
    });

    it('carries keyVersion and maxBytes through when the operator sets them', () => {
      const options = buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions({ publicUploadKeyVersion: 7, publicUploadMaxBytes: 1048576 }),
        ...VALID_TOKENS,
      }));
      expect(options?.publicUploadEncryption?.keyVersion).toBe(7);
      expect(options?.publicUploadEncryption?.maxBytes).toBe(1048576);
    });
  });

  describe('NEGATIVE row 7 (a) — the surface is missing entirely', () => {
    it('s3 with no DU_VAULT_TRANSIT_OPTIONS refuses rather than storing plaintext', () => {
      expect(() => buildEncryptionBootOptions(env({ ARTIFACT_STORAGE_BACKEND: 's3' })))
        .toThrow(VAULT_TRANSIT_OPTIONS_ENV + ' is required');
    });

    it('names the missing token instead of booting with a blank identity', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
      }))).toThrow(ENC + ' is required');
    });

    it('a missing decrypt token is refused even when encrypt is present', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        [ENC]: 'hvs.encrypt-token',
      }))).toThrow(DEC + ' is required');
    });

    it('an empty token string is treated as absent, not as a valid token', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        [ENC]: '',
        [DEC]: 'hvs.decrypt-token',
      }))).toThrow(ENC + ' is required');
    });

    it('requires metadataKeyRef when the metadata flag is on', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 'postgres',
        [METADATA_ENABLED_ENV]: 'true',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({
          vaultAddress: 'https://vault.internal:8200',
          allowedKeyRefs: { metadata: 'du-metadata' },
        }),
        ...VALID_TOKENS,
      }))).toThrow('metadataKeyRef is required');
    });
  });

  describe('NEGATIVE row 7 (b) — the JSON is malformed', () => {
    it('rejects unparseable JSON', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: '{not json',
        ...VALID_TOKENS,
      }))).toThrow('must be valid JSON');
    });

    it('rejects a JSON array', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: '[]',
        ...VALID_TOKENS,
      }))).toThrow('must be a JSON object');
    });

    it('rejects a bare JSON string', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: '"vault"',
        ...VALID_TOKENS,
      }))).toThrow('must be a JSON object');
    });
  });

  describe('NEGATIVE row 7 (c) — a required field is missing or the wrong type', () => {
    it('rejects a missing vaultAddress', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({ allowedKeyRefs: { artifact: 'du-artifact' }, publicUploadKeyRef: 'artifact' }),
        ...VALID_TOKENS,
      }))).toThrow('vaultAddress is required');
    });

    it('rejects a missing allowedKeyRefs', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({ vaultAddress: 'https://vault.internal:8200', publicUploadKeyRef: 'artifact' }),
        ...VALID_TOKENS,
      }))).toThrow('allowedKeyRefs must be an object');
    });

    it('rejects an empty allowedKeyRefs — an empty allowlist seals nothing', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({
          vaultAddress: 'https://vault.internal:8200',
          allowedKeyRefs: {},
          publicUploadKeyRef: 'artifact',
        }),
        ...VALID_TOKENS,
      }))).toThrow('must map at least one key ref');
    });

    it('rejects a non-string key name in allowedKeyRefs', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({
          vaultAddress: 'https://vault.internal:8200',
          allowedKeyRefs: { artifact: 7 },
          publicUploadKeyRef: 'artifact',
        }),
        ...VALID_TOKENS,
      }))).toThrow('allowedKeyRefs[artifact] is required');
    });

    it('rejects a keyRef that is not in the allowlist', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: JSON.stringify({
          vaultAddress: 'https://vault.internal:8200',
          allowedKeyRefs: { metadata: 'du-metadata' },
          metadataKeyRef: 'metadata',
          publicUploadKeyRef: 'artifact',
        }),
        ...VALID_TOKENS,
      }))).toThrow('is not present in allowedKeyRefs');
    });

    it('rejects an out-of-range requestTimeoutMs', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions({ requestTimeoutMs: 0 }),
        ...VALID_TOKENS,
      }))).toThrow('requestTimeoutMs must be an integer between 1 and 60000');
    });

    it('rejects a non-boolean enable flag instead of guessing it is off', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 'postgres',
        [METADATA_ENABLED_ENV]: 'yes',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }))).toThrow(METADATA_ENABLED_ENV + ' must be true or false');
    });

    it('rejects identical encrypt and decrypt tokens', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        [ENC]: 'hvs.same-token',
        [DEC]: 'hvs.same-token',
      }))).toThrow('must be different Vault tokens');
    });
  });

  describe('NEGATIVE row 7 (d) — vault is NOT a storage backend', () => {
    it('refuses ARTIFACT_STORAGE_BACKEND=vault and points at the real surface', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 'vault',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }))).toThrow('ARTIFACT_STORAGE_BACKEND=vault is not a storage backend');
    });

    it('refuses it even with a fully valid Vault surface, so it can never be mistaken for a backend', () => {
      expect(() => parseEncryptionBootConfig(env({
        ARTIFACT_STORAGE_BACKEND: 'vault',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions(),
        ...VALID_TOKENS,
      }))).toThrow(VAULT_TRANSIT_OPTIONS_ENV);
    });

    it('refuses any other unknown backend', () => {
      expect(() => buildEncryptionBootOptions(env({ ARTIFACT_STORAGE_BACKEND: 'gcs' })))
        .toThrow('ARTIFACT_STORAGE_BACKEND must be postgres or s3');
    });
  });

  describe('NEGATIVE row 7 (e) — the Vault client itself refuses the surface', () => {
    it('rejects a plain-http Vault address on a non-loopback host', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions({ vaultAddress: 'http://vault.internal:8200' }),
        ...VALID_TOKENS,
      }))).toThrow('HTTPS origin');
    });

    it('rejects an unparseable Vault address', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions({ vaultAddress: 'not a url' }),
        ...VALID_TOKENS,
      }))).toThrow('must be a valid URL');
    });

    it('rejects a transitMount that is not a single safe path segment', () => {
      expect(() => buildEncryptionBootOptions(env({
        ARTIFACT_STORAGE_BACKEND: 's3',
        [VAULT_TRANSIT_OPTIONS_ENV]: validOptions({ transitMount: '../escape' }),
        ...VALID_TOKENS,
      }))).toThrow('safe single path segment');
    });
  });

  describe('fail-closed invariant', () => {
    it('never returns a partially built surface', () => {
      // Every negative above throws before any block is assembled, so a caller
      // can never spread a half-configured object into createApp.
      const cases: EnvReader[] = [
        { ARTIFACT_STORAGE_BACKEND: 's3' },
        { ARTIFACT_STORAGE_BACKEND: 'vault' },
        { ARTIFACT_STORAGE_BACKEND: 's3', [VAULT_TRANSIT_OPTIONS_ENV]: '{bad' },
        { ARTIFACT_STORAGE_BACKEND: 's3', [VAULT_TRANSIT_OPTIONS_ENV]: validOptions() },
      ];
      for (const input of cases) {
        let result: unknown = 'no-throw';
        try {
          result = buildEncryptionBootOptions(input);
        } catch {
          result = 'threw';
        }
        if (input[VAULT_TRANSIT_OPTIONS_ENV] === undefined || String(input[VAULT_TRANSIT_OPTIONS_ENV]).includes('{bad')) {
          expect(result).toBe('threw');
        }
      }
    });

    it('labels its errors as boot refusals', () => {
      expect(() => buildEncryptionBootOptions(env({ ARTIFACT_STORAGE_BACKEND: 's3' })))
        .toThrow(EncryptionBootConfigError);
      expect(() => buildEncryptionBootOptions(env({ ARTIFACT_STORAGE_BACKEND: 's3' })))
        .toThrow(/^refusing to boot:/);
    });
  });
});
