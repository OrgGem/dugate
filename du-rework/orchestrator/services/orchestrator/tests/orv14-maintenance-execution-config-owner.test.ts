import { maintenanceBackupManifestConfigFromEnv, maintenanceExecutionConfigFromEnv, maintenanceManifestConfigFromEnv } from '../src/main';
import { createApp } from '../src/server';

const HASH = 'a'.repeat(64);

describe('maintenance execution role boot configuration', () => {
  it('defaults to the web role and does not invent a host identity', () => {
    expect(maintenanceExecutionConfigFromEnv({})).toEqual({ maintenanceExecutionRole: 'web' });
  });

  it('keeps rollout and backup manifest pins distinct and requires the backup pin for host execution', () => {
    expect(() => maintenanceExecutionConfigFromEnv({
      DU_MAINTENANCE_EXECUTION_ROLE: 'host',
      DU_MAINTENANCE_HOST_IDENTITY: 'maint-host-blue',
    })).toThrow(/requires DU_MAINTENANCE_HOST_IDENTITY and the pinned backup manifest/);
    expect(() => maintenanceExecutionConfigFromEnv({
      DU_MAINTENANCE_EXECUTION_ROLE: 'host',
      DU_MAINTENANCE_HOST_IDENTITY: 'maint-host-blue',
      DU_MAINTENANCE_MANIFEST_PATH: '/etc/du/rollout.json',
      DU_MAINTENANCE_MANIFEST_SHA256: HASH,
    })).toThrow(/pinned backup manifest/);
    expect(maintenanceExecutionConfigFromEnv({
      DU_MAINTENANCE_EXECUTION_ROLE: 'host',
      DU_MAINTENANCE_HOST_IDENTITY: 'maint-host-blue',
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/etc/du/backup.json',
      DU_MAINTENANCE_BACKUP_MANIFEST_SHA256: HASH,
    })).toEqual({ maintenanceExecutionRole: 'host', maintenanceHostIdentity: 'maint-host-blue',
      maintenanceBackupManifest: { manifestPath: '/etc/du/backup.json', expectedManifestSha256: HASH } });
    expect(maintenanceManifestConfigFromEnv({
      DU_MAINTENANCE_MANIFEST_PATH: '/etc/du/rollout.json',
      DU_MAINTENANCE_MANIFEST_SHA256: HASH,
    })).toEqual({ manifestPath: '/etc/du/rollout.json', expectedManifestSha256: HASH });
    expect(maintenanceBackupManifestConfigFromEnv({
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/etc/du/backup.json',
      DU_MAINTENANCE_BACKUP_MANIFEST_SHA256: HASH,
    })).toEqual({ manifestPath: '/etc/du/backup.json', expectedManifestSha256: HASH });
  });

  it('rejects unknown roles, host identity on a web process, partial pins, and restore rehearsal', () => {
    expect(() => maintenanceExecutionConfigFromEnv({ DU_MAINTENANCE_EXECUTION_ROLE: 'worker' })).toThrow(/must be web or host/);
    expect(() => maintenanceExecutionConfigFromEnv({ DU_MAINTENANCE_HOST_IDENTITY: 'host-a' })).toThrow(/only valid with/);
    expect(() => maintenanceExecutionConfigFromEnv({
      DU_MAINTENANCE_EXECUTION_ROLE: 'host',
      DU_MAINTENANCE_HOST_IDENTITY: 'host-a',
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/etc/du/backup.json',
    })).toThrow(/configured together/);
    expect(() => maintenanceExecutionConfigFromEnv({
      DU_MAINTENANCE_EXECUTION_ROLE: 'host',
      DU_MAINTENANCE_HOST_IDENTITY: 'host-a',
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/etc/du/backup.json',
      DU_MAINTENANCE_BACKUP_MANIFEST_SHA256: HASH,
      DU_ISOLATED_RUNTIME_MODE: 'restore-rehearsal',
    })).toThrow(/must not start the maintenance host executor/);
    expect(() => maintenanceBackupManifestConfigFromEnv({
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/etc/du/backup.json',
    })).toThrow(/configured together/);
  });

  it('refuses to serve the ordinary HTTP app under the privileged host role', async () => {
    await expect(createApp({
      port: 0,
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      maintenanceExecutionRole: 'host',
      maintenanceHostIdentity: 'maint-host-blue',
    })).rejects.toThrow(/cannot create an HTTP app/);
  });
});
