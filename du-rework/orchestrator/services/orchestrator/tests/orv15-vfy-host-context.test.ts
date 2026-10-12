import * as http from 'node:http';
import type { Db } from '../src/db/db';
import { runMaintenanceHostRunner } from '../src/maintenance-host-runner';

const envNames = [
  'DU_MAINTENANCE_EXECUTION_ROLE', 'DU_MAINTENANCE_HOST_IDENTITY',
  'DU_MAINTENANCE_BACKUP_MANIFEST_PATH', 'DU_MAINTENANCE_BACKUP_MANIFEST_SHA256',
  'DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN', 'SERVICE_IDENTITY_SECRET', 'DATABASE_URL', 'REDIS_URL',
] as const;

function backupPins() {
  return (['orchestrator', 'connector', 'worker'] as const).flatMap((service) => (['blue', 'green'] as const).map((slot) => {
    const runtimeIdentity = `${service}-${slot}`;
    return { service, slot, serviceId: `${service}-service`, runtimeIdentity, replicaId: runtimeIdentity,
      revision: 'r15', imageDigest: `${service}@sha256:${'a'.repeat(64)}`,
      ...(service === 'connector' ? { controlBaseUrl: `http://127.0.0.1:${slot === 'blue' ? 19201 : 19202}` } : {}),
    };
  }));
}

function loadHostContextMocks() {
  jest.resetModules();
  const calls: Record<string, jest.Mock> = {};
  const mock = (name: string, implementation?: (...args: unknown[]) => unknown) => {
    calls[name] = jest.fn(implementation);
    return calls[name]!;
  };
  const db = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), close: jest.fn(async () => undefined), pool: {} };
  const redis = { ping: jest.fn(async () => 'PONG'), disconnect: jest.fn() };
  const service = { runQueuedMaintenanceJobs: jest.fn(async () => []), runQueuedRollouts: jest.fn(async () => []) };
  const runtimeIdentity = 'host-vfy-runtime';
  const manifestDigest = 'a'.repeat(64);
  const controlTargets = Object.fromEntries(['orchestrator', 'connector', 'worker'].map((name) => [name, {
    blue: { runtimeIdentity: `${name}-blue`, serviceId: `${name}-service` },
    green: { runtimeIdentity: `${name}-green`, serviceId: `${name}-service` },
  }]));
  const dbFactory = mock('createDb', () => db);
  const redisFactory = mock('IORedis', () => redis);
  const queueFactory = mock('Queue', () => ({ close: jest.fn(async () => undefined) }));
  const storageGenerations = { current: jest.fn(async () => ({ generationId: '33333333-3333-4333-8333-333333333333' })),
    forGeneration: jest.fn(() => ({})) };
  const backupGate = { assertWriteAllowed: jest.fn(async () => undefined) };
  const runtimeService = { recoverExpiredLease: jest.fn(async () => undefined) };
  const hostMigrations = mock('verifyMigrations', async () => undefined);
  const maintenanceFactory = mock('createMaintenanceService', () => service);

  jest.doMock('bullmq', () => ({ Queue: queueFactory }));
  jest.doMock('ioredis', () => ({ __esModule: true, default: redisFactory }));
  jest.doMock('@aws-sdk/client-s3', () => ({ S3Client: class { destroy = jest.fn(); } }));
  jest.doMock('../src/modules/encryption/boot-options', () => ({
    buildEncryptionBootOptions: mock('buildEncryptionBootOptions', () => undefined),
    summarizeEncryptionPolicy: mock('summarizeEncryptionPolicy', () => ({ dataMode: 'none' })),
    buildMetadataReadPolicy: mock('buildMetadataReadPolicy', () => ({})),
    METADATA_READ_MODE_ENV: 'DU_METADATA_READ_MODE',
  }));
  jest.doMock('../src/modules/secrets/secret-revision-resolver', () => ({
    parseSecretCatalogKeyring: mock('parseSecretCatalogKeyring', () => ({})),
    parseSecretVersionRef: mock('parseSecretVersionRef', () => undefined),
    resolveManagedSecretVersion: mock('resolveManagedSecretVersion', async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' })),
    verifyManagedSecretVersion: mock('verifyManagedSecretVersion', async () => undefined),
  }));
  jest.doMock('../src/db/db', () => ({ createDb: dbFactory }));
  jest.doMock('../src/db/migrations', () => ({ verifyMigrations: hostMigrations }));
  jest.doMock('../src/modules/audit/audit', () => ({ createAuditService: mock('createAuditService', () => ({})) }));
  jest.doMock('../src/modules/global-settings/service', () => ({ createGlobalSettingsService: mock('createGlobalSettingsService', () => ({
    getEffectiveRetentionPolicy: jest.fn(async () => ({})),
  })) }));
  jest.doMock('../src/modules/runtime/metadata-crypto', () => ({ createMetadataCrypto: mock('createMetadataCrypto', () => ({})) }));
  jest.doMock('../src/modules/encryption/metadata-key-adapter', () => ({ adaptKeyProviderForMetadata: mock('adaptKeyProviderForMetadata', () => ({})) }));
  jest.doMock('../src/modules/encryption/metadata-read-policy', () => ({
    createCompatibilityMetadataReadPolicy: mock('createCompatibilityMetadataReadPolicy', () => ({})),
    createMetadataReader: mock('createMetadataReader', () => ({})),
  }));
  jest.doMock('../src/modules/runtime/runtime', () => ({ createRuntimeService: mock('createRuntimeService', () => runtimeService) }));
  jest.doMock('../src/modules/artifacts/artifacts', () => ({ createArtifactService: mock('createArtifactService', () => ({})) }));
  jest.doMock('../src/modules/encryption/crypto-storage-facade', () => ({ CryptoStorageFacade: class {} }));
  jest.doMock('../src/modules/artifacts/postgres-storage-facade', () => ({ createPostgresArtifactStorageFacade: mock('createPostgresArtifactStorageFacade', () => ({})) }));
  jest.doMock('../src/modules/artifacts/s3-storage-facade', () => ({ createS3ArtifactStorageFacade: mock('createS3ArtifactStorageFacade', () => ({})) }));
  jest.doMock('../src/modules/artifacts/storage-generations', () => ({
    createStorageGenerationService: mock('createStorageGenerationService', () => storageGenerations),
  }));
  jest.doMock('../src/modules/maintenance/backup-effect-fence', () => ({
    createBackupSnapshotWriteGate: mock('createBackupSnapshotWriteGate', () => backupGate),
    PostgresBackupArtifactEffects: class {}, PostgresBackupSnapshotFence: class {},
  }));
  jest.doMock('../src/modules/maintenance/backup-fence', () => ({ createMaintenanceBackupFence: mock('createMaintenanceBackupFence', () => ({})) }));
  jest.doMock('../src/modules/maintenance/maintenance-service', () => ({ createMaintenanceService: maintenanceFactory }));
  jest.doMock('../src/modules/maintenance/recovery-key-file', () => ({
    createMaintenanceRecoveryKeyResolver: mock('createMaintenanceRecoveryKeyResolver', () => jest.fn()),
    backupRecoveryKeyFilePinFromEnv: mock('backupRecoveryKeyFilePinFromEnv', () => undefined),
    maintenanceRecoveryKeyRegistryPinFromEnv: mock('maintenanceRecoveryKeyRegistryPinFromEnv', () => undefined),
  }));
  jest.doMock('../src/modules/maintenance/trusted-backup-adapter', () => ({
    createTrustedMaintenanceBackupAdapter: mock('createTrustedMaintenanceBackupAdapter', () => ({})),
    readTrustedIsolatedRestoreRuntimeManifest: mock('readTrustedIsolatedRestoreRuntimeManifest', async () => ({
      isolatedHost: { hostRunnerIdentity: runtimeIdentity }, rolloutManifest: { path: '/synthetic/rollout.json', sha256: manifestDigest },
    })),
    readTrustedMaintenanceHostIdentity: mock('readTrustedMaintenanceHostIdentity', async () => runtimeIdentity),
    readTrustedMaintenanceTargetDescriptors: mock('readTrustedMaintenanceTargetDescriptors', async () => ({ backupTargets: [] })),
  }));
  jest.doMock('../src/modules/maintenance/trusted-manifest-rollout-adapter', () => ({
    createTrustedManifestRolloutAdapter: mock('createTrustedManifestRolloutAdapter', () => ({})),
    readBackupReplicaRuntimePins: mock('readBackupReplicaRuntimePins', async () => backupPins()),
    readFixedIngressProbeUrlMap: mock('readFixedIngressProbeUrlMap', async () => ({})),
    readReplicaRuntimeControlTargets: mock('readReplicaRuntimeControlTargets', async () => controlTargets),
    readWorkerReplicaBusinessMap: mock('readWorkerReplicaBusinessMap', async () => ({ 'worker-blue': 'business-a', 'worker-green': 'business-a' })),
  }));
  jest.doMock('../src/modules/maintenance/trusted-isolated-restore-probe', () => ({ createTrustedIsolatedRestoreProbe: mock('createTrustedIsolatedRestoreProbe', () => ({})) }));
  jest.doMock('../src/modules/maintenance/trusted-isolated-restore-runtime-ports', () => ({ createTrustedIsolatedRestoreRuntimePorts: mock('createTrustedIsolatedRestoreRuntimePorts', () => ({})) }));
  jest.doMock('../src/modules/maintenance/replica-runtime-safety', () => ({ createReplicaRuntimeSafetyPort: mock('createReplicaRuntimeSafetyPort', () => ({})),
    createWorkerReplicaSafetySource: mock('createWorkerReplicaSafetySource', () => ({})) }));
  jest.doMock('../src/modules/maintenance/orchestrator-runtime-safety', () => ({ createOrchestratorHttpReplicaSafetySource: mock('createOrchestratorHttpReplicaSafetySource', () => ({})) }));
  jest.doMock('../src/modules/maintenance/connector-runtime-safety', () => ({
    createConnectorReplicaRuntimeSafetySource: mock('createConnectorReplicaRuntimeSafetySource', () => ({})),
    createFixedIngressReplicaProbe: mock('createFixedIngressReplicaProbe', () => jest.fn()),
  }));
  jest.doMock('../src/modules/maintenance/connector-backup-effect-control', () => ({ createConnectorBackupEffectControl: mock('createConnectorBackupEffectControl', () => ({})) }));
  jest.doMock('../src/modules/connectors/management-service-identity', () => ({
    connectorManagementAuthorizationProviderFromEnv: mock('connectorManagementAuthorizationProviderFromEnv', () => jest.fn(() => 'Bearer synthetic-service-token')),
  }));

  const loaded = require('../src/maintenance-host-execution-context') as {
    createMaintenanceHostExecutionContext: () => Promise<{ maintenance: typeof service; runtimeIdentity: string; bootId: string; close(): Promise<void> }>;
  };
  return { ...loaded, calls, db, redis, service, storageGenerations, backupGate, runtimeService, runtimeIdentity, manifestDigest };
}

describe('ORV15 independent standalone Host composition boundary', () => {
  const priorEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of envNames) {
      const value = priorEnv.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    jest.restoreAllMocks();
  });

  it('constructs a host-only context with shared durable gates and closes resources without opening an HTTP listener', async () => {
    const serverSpy = jest.spyOn(http.Server.prototype, 'listen');
    const state = loadHostContextMocks();
    process.env.DU_MAINTENANCE_EXECUTION_ROLE = 'host';
    process.env.DU_MAINTENANCE_HOST_IDENTITY = state.runtimeIdentity;
    process.env.DU_MAINTENANCE_BACKUP_MANIFEST_PATH = '/synthetic/maintenance.json';
    process.env.DU_MAINTENANCE_BACKUP_MANIFEST_SHA256 = state.manifestDigest;
    process.env.DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN = 'c'.repeat(40);
    process.env.SERVICE_IDENTITY_SECRET = 'synthetic-management-secret';
    process.env.DATABASE_URL = 'postgres://unit-test-only';
    process.env.REDIS_URL = 'redis://unit-test-only';

    const context = await state.createMaintenanceHostExecutionContext();
    expect(context.maintenance).toBe(state.service);
    expect(context.runtimeIdentity).toBe(state.runtimeIdentity);
    expect(context.bootId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.calls['verifyMigrations']).toHaveBeenCalledTimes(1);
    expect(state.calls['createRuntimeService']).toHaveBeenCalledWith(
      state.db, expect.any(Object), undefined, expect.any(Object), state.backupGate,
    );
    const artifactOptions = state.calls['createArtifactService']!.mock.calls[0]![1] as { backupSnapshotWriteGate: unknown };
    const maintenanceOptions = state.calls['createMaintenanceService']!.mock.calls[0]![0] as {
      backupSnapshotWriteGate: unknown; trustedHostControllerIdentity: string;
    };
    expect(artifactOptions.backupSnapshotWriteGate).toBe(state.backupGate);
    expect(maintenanceOptions.backupSnapshotWriteGate).toBe(state.backupGate);
    expect(maintenanceOptions.trustedHostControllerIdentity).toBe(state.runtimeIdentity);
    expect(serverSpy).not.toHaveBeenCalled();

    await context.close();
    expect(state.redis.disconnect).toHaveBeenCalledTimes(1);
    expect(state.db.close).toHaveBeenCalledTimes(1);
    expect(serverSpy).not.toHaveBeenCalled();
  });

  it('rejects web mode before constructing database, queue, or Redis resources', async () => {
    const state = loadHostContextMocks();
    process.env.DU_MAINTENANCE_EXECUTION_ROLE = 'web';
    await expect(state.createMaintenanceHostExecutionContext()).rejects.toThrow('MAINTENANCE_HOST_ROLE_REQUIRED');
    expect(state.calls['createDb']).not.toHaveBeenCalled();
    expect(state.calls['IORedis']).not.toHaveBeenCalled();
    expect(state.calls['Queue']).not.toHaveBeenCalled();
  });

  it('binds one-shot argv and role to the pinned Host identity before consuming durable queues', async () => {
    const serverListen = jest.spyOn(http.Server.prototype, 'listen');
    const hostEnv = {
      DU_MAINTENANCE_EXECUTION_ROLE: 'host', DU_MAINTENANCE_HOST_IDENTITY: 'host-runner-pinned',
      DU_MAINTENANCE_BACKUP_MANIFEST_PATH: '/synthetic/maintenance.json',
      DU_MAINTENANCE_BACKUP_MANIFEST_SHA256: 'f'.repeat(64),
    };
    const context = {
      maintenance: { runQueuedMaintenanceJobs: jest.fn(async () => []), runQueuedRollouts: jest.fn(async () => []) },
      runtimeIdentity: 'host-runner-pinned', bootId: '66666666-6666-4666-8666-666666666666', close: jest.fn(async () => undefined),
    };
    const createContext = jest.fn(async () => context);

    await expect(runMaintenanceHostRunner({ env: { ...hostEnv, DU_MAINTENANCE_EXECUTION_ROLE: 'web' }, argv: ['--once'], createContext }))
      .rejects.toThrow('MAINTENANCE_HOST_CONFIGURATION_INVALID');
    await expect(runMaintenanceHostRunner({ env: hostEnv, argv: ['--once', '--manifest', '/tmp/replacement.json'], createContext }))
      .rejects.toThrow('MAINTENANCE_HOST_ARGUMENTS_INVALID');
    await expect(runMaintenanceHostRunner({ env: hostEnv, argv: ['--once', '--once'], createContext }))
      .rejects.toThrow('MAINTENANCE_HOST_ARGUMENTS_INVALID');
    expect(createContext).not.toHaveBeenCalled();

    await runMaintenanceHostRunner({ env: hostEnv, argv: ['--once'], createContext });
    expect(context.maintenance.runQueuedMaintenanceJobs).toHaveBeenCalledTimes(1);
    expect(context.maintenance.runQueuedMaintenanceJobs).toHaveBeenCalledWith('host-runner-pinned', 1);
    expect(context.maintenance.runQueuedRollouts).toHaveBeenCalledTimes(1);
    expect(context.maintenance.runQueuedRollouts).toHaveBeenCalledWith('host-runner-pinned', 1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(serverListen).not.toHaveBeenCalled();
  });
});
