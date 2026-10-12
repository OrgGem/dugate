import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { buildEncryptionBootOptions, summarizeEncryptionPolicy, buildMetadataReadPolicy, METADATA_READ_MODE_ENV } from './modules/encryption/boot-options';
import { parseSecretCatalogKeyring, parseSecretVersionRef, resolveManagedSecretVersion, verifyManagedSecretVersion } from './modules/secrets/secret-revision-resolver';
import { createDb } from './db/db';
import { verifyMigrations } from './db/migrations';
import { createAuditService } from './modules/audit/audit';
import { createGlobalSettingsService } from './modules/global-settings/service';
import { createMetadataCrypto } from './modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from './modules/encryption/metadata-key-adapter';
import { createCompatibilityMetadataReadPolicy, createMetadataReader } from './modules/encryption/metadata-read-policy';
import { createRuntimeService } from './modules/runtime/runtime';
import { createArtifactService } from './modules/artifacts/artifacts';
import { CryptoStorageFacade } from './modules/encryption/crypto-storage-facade';
import { createPostgresArtifactStorageFacade } from './modules/artifacts/postgres-storage-facade';
import { createS3ArtifactStorageFacade } from './modules/artifacts/s3-storage-facade';
import { createStorageGenerationService, type StorageGenerationConfig, type StorageGenerationService } from './modules/artifacts/storage-generations';
import { createBackupSnapshotWriteGate, PostgresBackupArtifactEffects, PostgresBackupSnapshotFence } from './modules/maintenance/backup-effect-fence';
import { createMaintenanceBackupFence } from './modules/maintenance/backup-fence';
import { createMaintenanceService } from './modules/maintenance/maintenance-service';
import { createMaintenanceRecoveryKeyResolver, backupRecoveryKeyFilePinFromEnv, maintenanceRecoveryKeyRegistryPinFromEnv } from './modules/maintenance/recovery-key-file';
import {
  createTrustedMaintenanceBackupAdapter,
  readTrustedIsolatedRestoreRuntimeManifest,
  readTrustedMaintenanceHostIdentity,
  readTrustedMaintenanceTargetDescriptors,
} from './modules/maintenance/trusted-backup-adapter';
import {
  createTrustedManifestRolloutAdapter,
  readBackupReplicaRuntimePins,
  readFixedIngressProbeUrlMap,
  readReplicaRuntimeControlTargets,
  readWorkerReplicaBusinessMap,
} from './modules/maintenance/trusted-manifest-rollout-adapter';
import { createTrustedIsolatedRestoreProbe } from './modules/maintenance/trusted-isolated-restore-probe';
import { createTrustedIsolatedRestoreRuntimePorts } from './modules/maintenance/trusted-isolated-restore-runtime-ports';
import { createReplicaRuntimeSafetyPort, createWorkerReplicaSafetySource } from './modules/maintenance/replica-runtime-safety';
import { createOrchestratorHttpReplicaSafetySource } from './modules/maintenance/orchestrator-runtime-safety';
import { createConnectorReplicaRuntimeSafetySource, createFixedIngressReplicaProbe } from './modules/maintenance/connector-runtime-safety';
import { createConnectorBackupEffectControl } from './modules/maintenance/connector-backup-effect-control';
import { connectorManagementAuthorizationProviderFromEnv } from './modules/connectors/management-service-identity';
import type { MaintenanceRunnerPort } from './modules/maintenance/job-runner';
import type { ServerConfig } from './server';

type Env = Record<string, string | undefined>;
type HostArtifactStorage = NonNullable<ServerConfig['artifactStorage']>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name.toUpperCase()}_REQUIRED`);
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function strictBoolean(env: Env, name: string): boolean | undefined {
  const value = optional(env, name);
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name.toUpperCase()}_INVALID`);
}

function parseStorageConfig(env: Env): HostArtifactStorage {
  const backend = optional(env, 'ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
  const migrationWindow = strictBoolean(env, 'ARTIFACT_STORAGE_MIGRATION_WINDOW');
  if (backend === 'postgres') {
    if (migrationWindow || optional(env, 'DU_STORAGE_CREDENTIAL_VERSION_REF') || optional(env, 'DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID')) {
      throw new Error('ARTIFACT_STORAGE_CONFIGURATION_INVALID');
    }
    return { backend: 'postgres' };
  }
  if (backend !== 's3') throw new Error('ARTIFACT_STORAGE_BACKEND_INVALID');
  const credentialVersionRef = required(env, 'DU_STORAGE_CREDENTIAL_VERSION_REF');
  const credentialOwnerTenantId = required(env, 'DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID');
  parseSecretVersionRef(credentialVersionRef);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credentialOwnerTenantId)) {
    throw new Error('DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID_INVALID');
  }
  const region = optional(env, 'ARTIFACT_S3_REGION') ?? optional(env, 'AWS_REGION');
  if (!region) throw new Error('ARTIFACT_S3_REGION_REQUIRED');
  return {
    backend: 's3', bucket: required(env, 'ARTIFACT_S3_BUCKET'), region,
    endpoint: optional(env, 'ARTIFACT_S3_ENDPOINT') ?? `https://s3.${region}.amazonaws.com`,
    forcePathStyle: strictBoolean(env, 'ARTIFACT_S3_FORCE_PATH_STYLE'),
    credentialVersionRef, credentialOwnerTenantId, migrationWindow,
  };
}

function parseStorageEndpointAllowlist(env: Env): string[] {
  const raw = optional(env, 'DU_STORAGE_ENDPOINT_ALLOWLIST');
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID'); }
  if (!Array.isArray(parsed) || parsed.length > 64) throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID');
  const origins = parsed.map((value) => {
    if (typeof value !== 'string') throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID');
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID');
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST_INVALID');
  return origins;
}

function parseStorageS3Credentials(raw: string): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error('STORAGE_CREDENTIAL_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('STORAGE_CREDENTIAL_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key))) throw new Error('STORAGE_CREDENTIAL_INVALID');
  const accessKeyId = record['accessKeyId'];
  const secretAccessKey = record['secretAccessKey'];
  const sessionToken = record['sessionToken'];
  if (typeof accessKeyId !== 'string' || accessKeyId.trim() !== accessKeyId || accessKeyId.length < 16 || accessKeyId.length > 128
      || /[\u0000-\u0020\u007f]/.test(accessKeyId)
      || typeof secretAccessKey !== 'string' || secretAccessKey.trim() !== secretAccessKey || secretAccessKey.length < 20 || secretAccessKey.length > 256
      || /[\u0000-\u0020\u007f]/.test(secretAccessKey)
      || (sessionToken !== undefined && (typeof sessionToken !== 'string' || sessionToken.trim() !== sessionToken || sessionToken.length < 1 || sessionToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionToken)))) {
    throw new Error('STORAGE_CREDENTIAL_INVALID');
  }
  return { accessKeyId, secretAccessKey, ...(typeof sessionToken === 'string' ? { sessionToken } : {}) };
}

function storageEndpointAllowed(endpoint: string, allowlist: readonly string[]): boolean {
  try {
    const url = new URL(endpoint);
    if (allowlist.includes(url.origin)) return true;
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^s3(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname);
  } catch { return false; }
}

function controlToken(env: Env): string {
  const token = required(env, 'DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN');
  if (token.length < 32 || token.length > 512) throw new Error('ORCHESTRATOR_RUNTIME_CONTROL_TOKEN_INVALID');
  return token;
}

function safeHostIdentity(env: Env): string {
  const identity = required(env, 'DU_MAINTENANCE_HOST_IDENTITY');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(identity)) throw new Error('MAINTENANCE_HOST_IDENTITY_INVALID');
  return identity;
}

/**
 * Dedicated host-only maintenance composition. It deliberately creates no
 * HTTP servers, ServiceRuntime registration, API/worker dispatchers, or web
 * timers. It owns only the DB/Redis, exact storage and artifact readers,
 * durable maintenance service, and the pinned host adapters used by the
 * existing maintenance queue.
 */
export async function createMaintenanceHostExecutionContext(): Promise<{
  maintenance: Pick<MaintenanceRunnerPort, 'runQueuedMaintenanceJobs' | 'runQueuedRollouts'>;
  runtimeIdentity: string;
  bootId: string;
  close(): Promise<void>;
}> {
  const env = process.env as Env;
  if (env['DU_MAINTENANCE_EXECUTION_ROLE']?.trim() !== 'host') throw new Error('MAINTENANCE_HOST_ROLE_REQUIRED');
  const identity = safeHostIdentity(env);
  const manifestPath = required(env, 'DU_MAINTENANCE_BACKUP_MANIFEST_PATH');
  const expectedManifestSha256 = required(env, 'DU_MAINTENANCE_BACKUP_MANIFEST_SHA256');
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256)) throw new Error('MAINTENANCE_BACKUP_MANIFEST_PIN_INVALID');
  const manifestPin = { manifestPath, expectedManifestSha256 };
  const hostId = await readTrustedMaintenanceHostIdentity(manifestPin);
  if (hostId !== identity) throw new Error('MAINTENANCE_HOST_IDENTITY_MISMATCH');
  const trustedManifest = await readTrustedIsolatedRestoreRuntimeManifest(manifestPin);
  if (trustedManifest.isolatedHost.hostRunnerIdentity !== identity) throw new Error('MAINTENANCE_HOST_IDENTITY_MISMATCH');
  const bootId = randomUUID();
  const runtimeToken = controlToken(env);
  const managementAuthorization = connectorManagementAuthorizationProviderFromEnv(env);
  if (!managementAuthorization) throw new Error('SERVICE_IDENTITY_SECRET_REQUIRED');

  const databaseUrl = required(env, 'DATABASE_URL');
  const redisUrl = required(env, 'REDIS_URL');
  const storageConfig = parseStorageConfig(env);
  const keyring = parseSecretCatalogKeyring();
  const encryptionBoot = buildEncryptionBootOptions(env);
  const encryptionPolicy = summarizeEncryptionPolicy(env);
  const backupSnapshotWriteGate = createBackupSnapshotWriteGate();
  const db = createDb(databaseUrl);
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queues = new Map<string, Queue>();
  const s3Clients = new Map<string, S3Client>();
  let closed = false;
  const getQueue = (name: string): Queue => {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: redis as never });
      queues.set(name, queue);
    }
    return queue;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
    redis.disconnect();
    for (const client of s3Clients.values()) client.destroy();
    await db.close();
  };

  try {
    await verifyMigrations(db);
    await redis.ping();
    const audit = createAuditService(db);
    const metadataCrypto = encryptionBoot?.metadataEncryption
      ? createMetadataCrypto(adaptKeyProviderForMetadata(encryptionBoot.metadataEncryption.keyProvider), encryptionBoot.metadataEncryption.keyRef)
      : undefined;
    const mode = env[METADATA_READ_MODE_ENV];
    const metadataReadPolicy = mode ? buildMetadataReadPolicy(env) : createCompatibilityMetadataReadPolicy();
    const metadataReader = createMetadataReader(metadataCrypto, metadataReadPolicy);
    const runtime = createRuntimeService(db, { getQueue: (name) => getQueue(name) }, metadataCrypto, metadataReader, backupSnapshotWriteGate);

    const backupArtifactEffects = new PostgresBackupArtifactEffects(db, { runtimeIdentity: identity, bootId });
    const secretKeyring = keyring;
    const verifyCredential = (reference: string, ownerTenantId: string) => verifyManagedSecretVersion(db, secretKeyring, reference, {
      tenantId: ownerTenantId, purpose: 'storage.credential', service: 'orchestrator',
    });
    const resolveCredential = (reference: string, ownerTenantId: string) => resolveManagedSecretVersion(db, secretKeyring, reference, {
      tenantId: ownerTenantId, purpose: 'storage.credential', service: 'orchestrator',
    });
    const generationClients = new Map<string, S3Client>();
    const postgresFacade = createPostgresArtifactStorageFacade({
      async read(storageKey) {
        const result = await db.query<{ bytes: Buffer }>('SELECT bytes FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
        return result.rowCount ? Buffer.from(result.rows[0]!.bytes) : null;
      },
      async delete(storageKey) { await db.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]); },
      async write(storageKey, tenantId, bytes) {
        await db.query(`INSERT INTO artifact_blobs(storage_key,tenant_id,bytes) VALUES($1,$2,$3)
          ON CONFLICT(storage_key) DO UPDATE SET bytes=EXCLUDED.bytes,created_at=now()`, [storageKey, tenantId, bytes]);
      },
    });
    const allowlist = parseStorageEndpointAllowlist(env);
    let storageGenerations: StorageGenerationService;
    storageGenerations = createStorageGenerationService({
      db,
      audit,
      backupSnapshotWriteGate,
      backupArtifactEffects,
      verifyCredentialVersion: verifyCredential,
      validateEndpoint: (endpoint) => storageEndpointAllowed(endpoint.toString(), allowlist),
      resolveFacade: async (generation: StorageGenerationConfig) => {
        if (generation.backend === 'postgres') return postgresFacade;
        if (!generation.credentialVersionRef || !generation.credentialOwnerTenantId) throw new Error('STORAGE_GENERATION_CREDENTIAL_PIN_MISSING');
        const value = await resolveCredential(generation.credentialVersionRef, generation.credentialOwnerTenantId);
        const client = generationClients.get(generation.generationId) ?? (() => {
          const created = new S3Client({
            region: generation.region, endpoint: generation.endpoint, forcePathStyle: generation.forcePathStyle,
            credentials: parseStorageS3Credentials(value),
          });
          generationClients.set(generation.generationId, created);
          s3Clients.set(generation.generationId, created);
          return created;
        })();
        return createS3ArtifactStorageFacade({ bucket: generation.bucket, client });
      },
    });
    // A host may inspect and operate only a pre-existing, migrated generation
    // set. It never seeds or mutates the serving storage pointer during boot.
    await storageGenerations.current();
    const retained = await db.query<{ credential_version_ref: string; credential_owner_tenant_id: string }>(
      `SELECT credential_version_ref,credential_owner_tenant_id FROM storage_generations
        WHERE backend='s3' AND state IN ('ACTIVE','RETIRED') ORDER BY revision`,
    );
    for (const row of retained.rows) await verifyCredential(row.credential_version_ref, row.credential_owner_tenant_id);

    const artifactCrypto = encryptionBoot?.publicUploadEncryption
      ? new CryptoStorageFacade(encryptionBoot.publicUploadEncryption.keyProvider)
      : null;
    const migrationWindow = storageConfig.backend === 's3' && storageConfig.migrationWindow === true;
    const workerArtifactEncryption = encryptionBoot?.publicUploadEncryption && artifactCrypto
      ? {
          facade: artifactCrypto,
          keyRef: encryptionBoot.publicUploadEncryption.keyRef,
          ...(encryptionBoot.publicUploadEncryption.keyVersion === undefined ? {} : { keyVersion: encryptionBoot.publicUploadEncryption.keyVersion }),
          required: encryptionPolicy.dataMode === 'real' && !migrationWindow,
        }
      : undefined;
    const artifacts = createArtifactService(db, {
      storageBackend: storageConfig.backend,
      migrationWindow,
      backupSnapshotWriteGate,
      backupArtifactEffects,
      storageGenerations,
      ...(workerArtifactEncryption ? { encryption: workerArtifactEncryption } : {}),
    });
    const settings = createGlobalSettingsService(db, audit, { metadataCrypto, backupSnapshotWriteGate });

    const rolloutManifest = trustedManifest.rolloutManifest;
    const rolloutInput = { manifestPath: rolloutManifest.path, expectedManifestSha256: rolloutManifest.sha256 };
    const [controlTargets, ingressTargets, workerBusinessByIdentity, replicaPins] = await Promise.all([
      readReplicaRuntimeControlTargets(rolloutInput),
      readFixedIngressProbeUrlMap(rolloutInput),
      readWorkerReplicaBusinessMap(rolloutInput),
      readBackupReplicaRuntimePins({ ...rolloutInput, expectedHostId: identity }),
    ]);
    const orchestratorTargets = controlTargets.orchestrator;
    const connectorTargets = controlTargets.connector;
    if (!orchestratorTargets || !connectorTargets || !controlTargets.worker
        || (['blue', 'green'] as const).some((slot) => !orchestratorTargets[slot] || !connectorTargets[slot] || !controlTargets.worker?.[slot])) {
      throw new Error('MAINTENANCE_REPLICA_TARGETS_INCOMPLETE');
    }
    const runtimeSafety = createReplicaRuntimeSafetyPort({
      worker: createWorkerReplicaSafetySource(db, workerBusinessByIdentity),
      orchestrator: createOrchestratorHttpReplicaSafetySource({ targets: orchestratorTargets, controlToken: runtimeToken }),
      connector: createConnectorReplicaRuntimeSafetySource({ targets: connectorTargets, authorizationForRequest: managementAuthorization }),
      probeFixedIngress: createFixedIngressReplicaProbe({
        controlTargets, ingressTargets, orchestratorControlToken: runtimeToken,
        connectorAuthorizationForRequest: managementAuthorization,
      }),
    });
    const rolloutAdapter = createTrustedManifestRolloutAdapter({ ...rolloutInput, runtimeSafety });
    const connectorControl = createConnectorBackupEffectControl({ authorizationForRequest: managementAuthorization });
    const backupFence = createMaintenanceBackupFence({
      db,
      snapshotFence: new PostgresBackupSnapshotFence(db),
      artifactEffects: backupArtifactEffects,
      runtimeSafety,
      replicaPins,
      connectorControl,
    });
    const recoveryKeyFile = backupRecoveryKeyFilePinFromEnv(env);
    const recoveryKeyRegistry = maintenanceRecoveryKeyRegistryPinFromEnv(env);
    const resolveRecoveryKey = createMaintenanceRecoveryKeyResolver({
      ...(recoveryKeyFile ? { backupBundle: recoveryKeyFile } : {}),
      ...(recoveryKeyRegistry ? { secretCatalogRegistry: recoveryKeyRegistry } : {}),
    });
    const isolatedRuntimePorts = createTrustedIsolatedRestoreRuntimePorts(manifestPin);
    const isolatedRuntimeProbe = createTrustedIsolatedRestoreProbe(isolatedRuntimePorts);
    const backupAdapter = createTrustedMaintenanceBackupAdapter({
      ...manifestPin,
      db,
      storageGenerations,
      artifacts,
      backupArtifactEffects,
      resolveRecoveryKey,
      verifySecretVersion: (reference, ownerTenantId, purpose) => verifyManagedSecretVersion(db, secretKeyring, reference, {
        tenantId: ownerTenantId, purpose, service: 'orchestrator',
      }),
      backupFence,
      isolatedRuntimeProbe,
    });
    const descriptors = await readTrustedMaintenanceTargetDescriptors(manifestPin);
    const maintenance = createMaintenanceService({
      db,
      audit,
      artifacts,
      storageGenerations,
      getEffectiveRetentionPolicy: () => settings.getEffectiveRetentionPolicy(),
      getQueue: (name) => getQueue(name),
      recoverExpiredLease: runtime.recoverExpiredLease,
      backupAdapter,
      rolloutObservationAdapter: rolloutAdapter,
      rolloutExecutionAdapter: rolloutAdapter,
      listBackupTargetDescriptors: async () => descriptors.backupTargets,
      runnerRuntimeIdentity: identity,
      trustedHostControllerIdentity: identity,
      ownerBootId: bootId,
      backupSnapshotWriteGate,
    });
    return {
      maintenance,
      runtimeIdentity: identity,
      bootId,
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
