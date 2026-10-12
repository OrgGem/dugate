import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupRecoveryKeyFilePinFromEnv,
  createBackupRecoveryKeyFileResolver,
  createMaintenanceRecoveryKeyResolver,
  secretCatalogRecoveryKeyRegistryPinFromEnv,
} from '../src/modules/maintenance/recovery-key-file';

const reference = 'recovery:orchestrator:backup-v1';
const version = 'v1';

describe('ORV14 independently pinned backup recovery key', () => {
  test('requires all pins and rejects noncanonical key-file paths', () => {
    expect(() => backupRecoveryKeyFilePinFromEnv({ DU_MAINTENANCE_RECOVERY_KEY_REF: reference })).toThrow(/configured together/);
    expect(() => backupRecoveryKeyFilePinFromEnv({
      DU_MAINTENANCE_RECOVERY_KEY_FILE: 'relative/key',
      DU_MAINTENANCE_RECOVERY_KEY_REF: reference,
      DU_MAINTENANCE_RECOVERY_KEY_VERSION: version,
      DU_MAINTENANCE_RECOVERY_KEY_SHA256: 'a'.repeat(64),
    })).toThrow(/pins are invalid/);
  });

  test('pins a shared recovery registry by one exact root-owned file digest', () => {
    expect(secretCatalogRecoveryKeyRegistryPinFromEnv({
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_FILE: '/run/du/recovery-keys.json',
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_SHA256: 'b'.repeat(64),
    })).toEqual({ filePath: '/run/du/recovery-keys.json', sha256: 'b'.repeat(64) });
    expect(() => secretCatalogRecoveryKeyRegistryPinFromEnv({
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_FILE: '/run/du/recovery-keys.json',
      DU_MAINTENANCE_SECRET_CATALOG_KEYS_FILE: '/run/du/legacy-keys.json',
      DU_MAINTENANCE_RECOVERY_KEY_REGISTRY_SHA256: 'b'.repeat(64),
    })).toThrow(/only one/);
  });

  const exactVersionFileTest = process.getuid?.() === 0 ? test : test.skip;
  exactVersionFileTest('reads only the exact root-owned 32-byte, fingerprint-pinned version', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'du-backup-key-'));
    const filePath = path.join(directory, 'key.bin');
    const bytes = randomBytes(32);
    const fingerprintSha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      await chmod(directory, 0o700);
      await writeFile(filePath, bytes, { mode: 0o640, flag: 'wx' });
      await chmod(filePath, 0o640);
      const resolver = createBackupRecoveryKeyFileResolver({ filePath, escrowRef: reference, keyVersion: version, fingerprintSha256 });
      await expect(resolver({ purpose: 'backup_bundle', escrowRef: 'other:ref', keyVersion: version })).rejects.toThrow('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
      await expect(resolver({ purpose: 'backup_bundle', escrowRef: reference, keyVersion: version })).resolves.toEqual(bytes);

      await chmod(filePath, 0o644);
      await expect(resolver({ purpose: 'backup_bundle', escrowRef: reference, keyVersion: version })).rejects.toThrow('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
      const aliasPath = path.join(directory, 'key-alias.bin');
      await symlink(filePath, aliasPath);
      const aliasResolver = createBackupRecoveryKeyFileResolver({ filePath: aliasPath, escrowRef: reference, keyVersion: version, fingerprintSha256 });
      await expect(aliasResolver({ purpose: 'backup_bundle', escrowRef: reference, keyVersion: version })).rejects.toThrow('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
    } finally {
      bytes.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });

  exactVersionFileTest('resolves Connector invocation keys and legacy credential config under distinct purposes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'du-runtime-key-registry-'));
    const invocationPath = path.join(directory, 'connector-invocation-v3.bin');
    const credentialPath = path.join(directory, 'connector-credential-legacy-v1.txt');
    const registryPath = path.join(directory, 'registry.json');
    const invocationKey = randomBytes(32);
    const legacyCredentialConfig = Buffer.from(randomBytes(32).toString('base64'), 'utf8');
    const registry = {
      version: 2,
      keys: [
        {
          purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '3',
          fingerprintSha256: createHash('sha256').update(invocationKey).digest('hex'), filePath: invocationPath,
        },
        {
          purpose: 'connector_credential', escrowRef: 'connector-credential-legacy-v1', keyVersion: 'legacy-v1',
          fingerprintSha256: createHash('sha256').update(legacyCredentialConfig).digest('hex'),
          filePath: credentialPath, materialFormat: 'base64-config',
        },
      ],
    };
    const registryBytes = Buffer.from(JSON.stringify(registry));
    try {
      await chmod(directory, 0o700);
      await writeFile(invocationPath, invocationKey, { mode: 0o640, flag: 'wx' });
      await writeFile(credentialPath, legacyCredentialConfig, { mode: 0o640, flag: 'wx' });
      await writeFile(registryPath, registryBytes, { mode: 0o640, flag: 'wx' });
      const pin = { filePath: registryPath, sha256: createHash('sha256').update(registryBytes).digest('hex') };
      const resolver = createMaintenanceRecoveryKeyResolver({ secretCatalogRegistry: pin });

      await expect(resolver({ purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '3' }))
        .resolves.toEqual(invocationKey);
      const recoveredConfig = await resolver({
        purpose: 'connector_credential', escrowRef: 'connector-credential-legacy-v1', keyVersion: 'legacy-v1',
      });
      expect(recoveredConfig).toEqual(legacyCredentialConfig);
      expect(Buffer.from(recoveredConfig.toString('utf8'), 'base64')).toHaveLength(32);
      await expect(resolver({ purpose: 'connector_invocation', escrowRef: 'connector-invocation-v1', keyVersion: '2' }))
        .rejects.toThrow('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
      await expect(resolver({ purpose: 'secret_catalog', escrowRef: 'connector-invocation-v1', keyVersion: '3' }))
        .rejects.toThrow('MAINTENANCE_RECOVERY_KEY_UNAVAILABLE');
    } finally {
      invocationKey.fill(0);
      legacyCredentialConfig.fill(0);
      registryBytes.fill(0);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
