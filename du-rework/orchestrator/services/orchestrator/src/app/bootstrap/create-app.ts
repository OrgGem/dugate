import { mintLocalTenantCredential } from '../../modules/admin-actions/rbac';
/**
 * CONV-03: the orchestrator composition root, moved verbatim out of
 * server.ts — one startup/shutdown owner. The route table is an injected
 * dependency (`AppDeps.route`), so this module never imports server.ts at
 * value level and the boot path stays cycle-free.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { createLocalAdminAuth } from '../admin/local-auth-boot';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createLogger, InMemoryMetricsRegistry } from '@du/observability';
import {
  errorClassOf,
  isHttpError,
  safeInternalErrorProblem,
  HttpError,
} from '../../http/errors';
import { createDb } from '../../db/db';
import { migrate, verifyMigrations } from '../../db/migrations';
import { createRegistryService, enableVersionForTest } from '../../modules/registry/registry';
import { createSubmissionService } from '../../modules/operations/submission';
import { createPromptOverrideService } from '../../modules/profiles/prompt-overrides';
import {
  createRuntimeService,
  type QueueIntegrityHealth,
} from '../../modules/runtime/runtime';
import { createWorkerInstanceRetentionScheduler } from '../../modules/runtime/worker-instances';
import { validateWorkerIdentityConfig } from '../../modules/runtime/worker-identity';
import { createUsageService } from '../../modules/usage/usage';
import { observeVerifiedLogin } from '../../modules/cost-alerts/oidc-recipients';
import { createComposeOperationsService } from '../../modules/compose-operations/service';
import { createArtifactService, type ArtifactService } from '../../modules/artifacts/artifacts';
import { createPostgresArtifactStorageFacade } from '../../modules/artifacts/postgres-storage-facade';
import { createRuntimeSecretResolver } from '../../modules/secrets/vault-resolver';
import { createStorageGenerationService, type StorageGenerationConfig, type StorageGenerationService } from '../../modules/artifacts/storage-generations';
import { resolveManagedSecretVersion, verifyManagedSecretVersion } from '../../modules/secrets/secret-revision-resolver';
import {
  createMultipartService,
  type MultipartService,
  type MultipartSweepSummary,
} from '../../modules/artifacts/multipart-service';
import { createS3ArtifactStorageFacade } from '../../modules/artifacts/s3-storage-facade';
import type { ArtifactMultipartStorage } from '../../modules/artifacts/multipart-storage';
import type { ArtifactStorageFacade } from '../../modules/artifacts/storage-facade';
import { CryptoStorageFacade } from '../../modules/encryption/crypto-storage-facade';
import { adaptKeyProviderForMetadata } from '../../modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../modules/runtime/metadata-crypto';
import { buildMetadataReadPolicy, type DataMode, METADATA_READ_MODE_ENV } from '../../modules/encryption/boot-options';
import {
  createCompatibilityMetadataReadPolicy,
  createMetadataReader,
  type MetadataReadPolicy,
} from '../../modules/encryption/metadata-read-policy';
import {
  type ArtifactDecryptDeps,
  type StoredObjectMetadata,
  type StoredObjectReader,
} from '../../modules/encryption/artifact-read-decrypt';
import { createGrantService, type GrantService } from '../../modules/grants/grants';
import { createLifecycleService } from '../../modules/lifecycle/lifecycle';
import { createConnectorProxy, type ConnectorProxy } from '../../modules/connectors/connectors';
import { createConnectorManagementStore } from '../../modules/connectors/connector-management-store';
import { createConnectorSecretImportService } from '../../modules/connectors/connector-secret-imports';
import { createConnectorRevisionHttpAdapter } from '../../modules/connector-credentials/connector-http-store';
import {
  composeCredentialWorkflow,
  credentialWorkflowEnvRequested,
  CredentialWorkflowBootError,
} from '../../modules/connector-credentials/compose';
import { createProfileService, type ProfileService } from '../../modules/profiles/profiles';
import { createProfileSelfServiceService } from '../../modules/profiles/self-service';
import { createAdminIdentityService } from '../../modules/identity/service';
import { createGlobalSettingsService } from '../../modules/global-settings/service';
import { createMaintenanceService } from '../../modules/maintenance/maintenance-service';
import { createBackupSnapshotWriteGate, PostgresBackupArtifactEffects } from '../../modules/maintenance/backup-effect-fence';
import { createMaintenanceRecoveryKeyResolver } from '../../modules/maintenance/recovery-key-file';
import { createRetentionCleanupScheduler } from '../../modules/maintenance/retention-cleanup-scheduler';
import {
  readFixedIngressProbeUrlMap,
  readReplicaRuntimeControlTargets,
  readWorkerReplicaBusinessMap,
} from '../../modules/maintenance/trusted-rollout-manifest';
import { createTrustedManifestRolloutPreviewAdapter } from '../../modules/maintenance/trusted-manifest-rollout-observer';
import { readTrustedMaintenanceTargetDescriptors } from '../../modules/maintenance/trusted-backup-adapter';
import { createReplicaRuntimeSafetyPort, createWorkerReplicaSafetySource, type ReplicaRuntimeSafetySource } from '../../modules/maintenance/replica-runtime-safety';
import { createOrchestratorHttpReplicaSafetySource } from '../../modules/maintenance/orchestrator-runtime-safety';
import { createConnectorReplicaRuntimeSafetySource, createFixedIngressReplicaProbe } from '../../modules/maintenance/connector-runtime-safety';
import { createCostControlService } from '../../modules/cost-control/service';
import { createCostAdjustmentService } from '../../modules/cost-control/adjustments';
import { createCostAdjustmentEvidenceResolver } from '../../modules/cost-control/evidence-resolver';
import { runCostAlertDeliveryBatch } from '../../modules/cost-alerts/service';
import { createServiceRuntime } from '../../modules/service-runtime/service-runtime';
import { createAuditService, type AuditService } from '../../modules/audit/audit';
import { resolveAdminActionAuthAsync } from '../../modules/admin-actions/rbac';
import {
  createMetadataWindowControl,
} from '../../modules/encryption/metadata-window-control';
import {
  createMetadataWindowMetrics,
  observeMetadataReader,
} from '../../modules/encryption/metadata-window-metrics';
import type { CredentialWorkflow } from '../../modules/connector-credentials/workflow';
import { attachAdminShell } from '../admin';
import { readBoundedBody, type IngressBody } from '../../http/ingress';
import { createDispatcher } from '../../modules/queue/dispatcher';
import { createIngestionConsumer } from '../../modules/operations/ingestion-consumer';
import { createAcquisitionRefResolver } from '../../modules/operations/acquisition-ref-resolver';
import {
  createGenerationAwareS3EncryptedPinnedSourceStorage,
  createGenerationAwareS3PinnedSourceStorage,
  createS3EncryptedPinnedSourceStorage,
  createS3PinnedSourceStorage,
} from '../../modules/operations/ingestion-storage-s3';
import { createS3SourceAcquisition } from '../../modules/operations/s3-source';
import { deliverWebhooks } from '../../modules/webhooks/webhooks';
import { createDeliveryEncryptionService, createPublicUploadGateway, type PublicUploadGateway } from '../../modules/public-api';
import {
  MAX_DECRYPT_BYTES,
  MAX_MANIFEST_BYTES,
  readStreamBounded,
} from '../../http/routes/public-bounded-body';
import {
  buildCryptoConfigOptions,
  buildDeliveryEncryptionConfig,
  registerAdminCryptoConfigWiring,
} from './crypto-wiring';
import type { RouteContext, RouteResult } from '../../http/route-context';
import { assertIngressAllowed, type IngressAudience } from '../../http/ingress-guard';
import type { ServerConfig } from '../../server';

/**
 * PLAT-MIG-01 / DESIGN-803: connector base URL resolver, exported so the
 * routing is unit-testable without a boot. Exact configured IDs win; `*` is
 * an operator-configured static default for other IDs. Without either, named
 * IDs fail closed rather than deriving a URL from caller input.
 */
export function connectorBaseUrlResolver(
  baseUrls: Record<string, string>,
): (connectorId?: string) => string {
  return (connectorId?: string) => {
    if (connectorId === undefined) {
      const serviceBase = Object.hasOwn(baseUrls, '*')
        ? baseUrls['*']
        : Object.values(baseUrls)[0];
      if (!serviceBase) {
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'no connector base URL configured');
      }
      return serviceBase;
    }
    const exactBase = Object.hasOwn(baseUrls, connectorId) ? baseUrls[connectorId] : undefined;
    const defaultBase = Object.hasOwn(baseUrls, '*') ? baseUrls['*'] : undefined;
    const base = exactBase ?? defaultBase;
    if (!base) {
      throw new HttpError(404, 'NOT_FOUND', `connector ${connectorId} not configured`);
    }
    return base;
  };
}

/** CONV-03: the injected route table (server.ts binds its dispatcher here). */
export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult>;

export interface AppDeps {
  route: RouteHandler;
}

const LDBA03_CONTEXT_MODULE_ENV = 'LDBA03_CONTEXT_MODULE';
const LDBA03_CONTEXT_CALLBACKS = [
  'prepareConnector',
  'resolveProfileName',
  'normalizeConnectionsOverride',
  'prepareWorkflowSchema',
  'readFileCacheBytes',
  'artifactTokenFor',
  'artifactPurposeFor',
] as const;

interface S3ManagedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Parse the one server-side, write-only S3 credential representation. */
export function parseStorageS3Credentials(raw: string): S3ManagedCredentials {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('storage credential value is invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('storage credential value is invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key))) {
    throw new Error('storage credential value is invalid');
  }
  const accessKeyId = record['accessKeyId'];
  const secretAccessKey = record['secretAccessKey'];
  const sessionToken = record['sessionToken'];
  if (typeof accessKeyId !== 'string' || accessKeyId.trim() !== accessKeyId || accessKeyId.length < 16 || accessKeyId.length > 128
      || /[\u0000-\u0020\u007f]/.test(accessKeyId)
      || typeof secretAccessKey !== 'string' || secretAccessKey.trim() !== secretAccessKey || secretAccessKey.length < 20 || secretAccessKey.length > 256
      || /[\u0000-\u0020\u007f]/.test(secretAccessKey)
      || (sessionToken !== undefined && (typeof sessionToken !== 'string' || sessionToken.trim() !== sessionToken || sessionToken.length < 1 || sessionToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionToken)))) {
    throw new Error('storage credential value is invalid');
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(typeof sessionToken === 'string' ? { sessionToken } : {}),
  };
}

function isApprovedStorageEndpoint(url: URL, allowlist: readonly string[]): boolean {
  if (allowlist.includes(url.origin)) return true;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return false;
  return /^s3(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname);
}

function withStorageGenerationUploadTtl(
  facade: ArtifactStorageFacade & Partial<ArtifactMultipartStorage>,
  urlTtlSeconds: number | null,
): ArtifactStorageFacade & Partial<ArtifactMultipartStorage> {
  if (urlTtlSeconds === null) return facade;
  return {
    ...facade,
    async createUploadGrant(input) {
      const requested = Date.parse(input.expiresAt);
      const expiresAt = Number.isFinite(requested)
        ? new Date(Math.min(requested, Date.now() + urlTtlSeconds * 1000)).toISOString()
        : input.expiresAt;
      return facade.createUploadGrant({ ...input, expiresAt });
    },
  };
}

export interface Ldb03ContextProviderRegistration {
  readonly modulePath: string;
  readonly provider: Readonly<Record<string, unknown>>;
}

/**
 * MDB-01: register and validate the same context module used by the standalone
 * LDBA03 adapter. The adapter runs in its own process, so the composition seam
 * communicates the absolute module path through the documented environment key.
 */
export function registerLdb03ContextProvider(
  env: Record<string, string | undefined> = process.env,
): Ldb03ContextProviderRegistration {
  const configuredPath = env[LDBA03_CONTEXT_MODULE_ENV];
  const modulePath = configuredPath && configuredPath.trim().length > 0
    ? resolve(configuredPath)
    : resolve(__dirname, '../../../scripts/ldba-context-provider.cjs');
  let loaded: unknown;
  try {
    loaded = require(modulePath) as unknown;
  } catch {
    throw new Error('refusing to boot: LDBA03 context provider module could not be loaded');
  }
  const defaultExport = loaded && typeof loaded === 'object' && 'default' in loaded
    ? (loaded as { default?: unknown }).default
    : undefined;
  const provider = defaultExport || loaded;
  if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('refusing to boot: LDBA03 context provider must export a policy object');
  }
  const policy = provider as Record<string, unknown>;
  if (LDBA03_CONTEXT_CALLBACKS.some((name) => typeof policy[name] !== 'function')) {
    throw new Error('refusing to boot: LDBA03 context provider is missing a required callback');
  }
  env[LDBA03_CONTEXT_MODULE_ENV] = modulePath;
  return { modulePath, provider: policy };
}

/**
 * ADM-BASE-03 (RFC7807 error boundary; CX3 W43-R13 High security
 * carry-forward): unexpected exceptions (DB driver errors, service bugs)
 * must NEVER reach the wire or the log as raw text — a pg error can carry
 * SQL fragments, tenant ids, or secret-bearing connection strings. The
 * wire gets a generic problem+json with the correlation id (the operator
 * joins it to the redacted server log); the log gets the error CLASS
 * only, never `err.message`/`String(err)`. Expected HttpError keeps its
 * authored message via `toProblem` (all service messages are literals).
 */
// ADM-BASE-03: canonical helpers live in src/http/errors.ts (shared with the
// Admin shell, ingress and the section fetchers — no surface re-invents its own
// String(err) policy).
const errorNameOf = errorClassOf;

const sanitizedInternalError = safeInternalErrorProblem;

/**
 * CR28-01: S3 adapter for the authenticated artifact read path.
 *
 * `StoredObjectReader` is deliberately narrow so the decrypt module is testable
 * without an S3 client; this is the only place that knows about the SDK. It
 * mirrors the manifest layout the public upload gateway writes: the sidecar key
 * comes from the ciphertext object's own `du-manifest-key` metadata and is
 * re-derived and compared by the module, so a swapped pointer is refused
 * rather than followed.
 */
function s3StoredObjectReader(client: S3Client, bucket: string): StoredObjectReader {
  return {
    async head(storageKey: string, versionId?: string): Promise<StoredObjectMetadata | null> {
      try {
        const head = (await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey, ...(versionId ? {VersionId:versionId} : {}) }))) as {
          Metadata?: Record<string, string>;
          VersionId?: string;
        };
        if(versionId && head.VersionId !== versionId) throw new HttpError(503,'STORAGE_FAILURE','encrypted artifact version mismatch');
        return head.Metadata ?? {};
      } catch (error) {
        if (isNotFoundStorageError(error)) return null;
        throw error;
      }
    },
    async read(storageKey: string, versionId?: string): Promise<Buffer> {
      const output = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey, ...(versionId ? {VersionId:versionId} : {}) }))) as {
        Body?: unknown;
        VersionId?: string;
      };
      if(versionId && output.VersionId !== versionId) throw new HttpError(503,'STORAGE_FAILURE','encrypted artifact version mismatch');
      return await readStreamBounded(output.Body as Readable, MAX_DECRYPT_BYTES);
    },
    async readManifest(manifestKey: string, versionId?: string): Promise<unknown> {
      // RFX-05-residual: when the artifact row carries the committed sidecar
      // generation, pin the read to that exact S3 VersionId — a newer manifest
      // written at the same key must not be verified against. `undefined`
      // preserves the legacy key-only read for pre-0025 rows.
      const output = (await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: manifestKey,
        ...(versionId ? { VersionId: versionId } : {}),
      }))) as {
        Body?: unknown;
        VersionId?: string;
      };
      if(versionId && output.VersionId !== versionId) throw new HttpError(503,'STORAGE_FAILURE','encrypted manifest version mismatch');
      const raw = await readStreamBounded(output.Body as Readable, MAX_MANIFEST_BYTES);
      try {
        return JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        throw new HttpError(503, 'STORAGE_FAILURE', 'encrypted artifact manifest is not valid JSON');
      }
    },
  };
}

function isNotFoundStorageError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.name === 'NoSuchKey' || e.Code === 'NoSuchKey'
    || e.$metadata?.httpStatusCode === 404;
}

/**
 * RFX-10: whether the dev fallback rows (default tenant `…0001` + the
 * `dev-fallback` API key) may be written on this boot.
 *
 * Those rows exist so development/test boots keep an FK target for legacy
 * fixtures. A production boot must not write them: an ACTIVE `dev-fallback`
 * api_keys row in a production DB is misleading seed data, and the row's
 * role as a silent FK target hides referential errors that should fail
 * loudly instead. The gate is therefore explicit:
 *   - `DU_SEED_DEV_FALLBACK=true`  → seed (operator opt-in, any NODE_ENV);
 *   - `DU_SEED_DEV_FALLBACK=false` → never seed (vetoes every other signal);
 *   - unset → seed only for a dev/test boot: `NODE_ENV` development/test, or
 *     a zero-config boot (`autoMigrate: true`, the mode this module documents
 *     for development/test fixtures — production composes default it OFF and
 *     run `npm run migrate` as an explicit step instead).
 * A malformed flag fails the boot instead of being ignored.
 */
export function shouldSeedDevFallback(
  env: Record<string, string | undefined> = process.env,
  options: { zeroConfigBoot?: boolean } = {},
): boolean {
  const flag = env['DU_SEED_DEV_FALLBACK'];
  if (flag !== undefined && flag !== 'true' && flag !== 'false' && flag !== '') {
    throw new Error(`DU_SEED_DEV_FALLBACK must be 'true' or 'false', got '${flag}'`);
  }
  if (flag === 'true') return true;
  if (flag === 'false' || flag === '') return false;
  const nodeEnv = env['NODE_ENV'];
  return nodeEnv === 'development' || nodeEnv === 'test' || options.zeroConfigBoot === true;
}

/**
 * The single decision for whether a payload must be encrypted. All four write
 * paths read this instead of answering the same question separately.
 *
 * - synthetic → false everywhere: the historical plaintext path stays
 *   byte-identical (ingestion-consumer.ts:158-160). No path may answer true.
 * - real → true everywhere, except the migration window on the three
 *   artifact-side paths. That window exempts objects written BEFORE
 *   encryption existed, so it is deliberately absent for the source-write
 *   path: that one decides about data arriving NOW, and honouring the window
 *   there would open a standing hole for new writes. Hence its caller passes
 *   migrationWindowOpen=false.
 *
 * An absent policy resolves to real (boot-options resolveDataMode returns
 * real for empty env), so a missing policy can never read as synthetic.
 */
function resolveEncryptionRequirement(
  dataMode: DataMode | undefined,
  migrationWindowOpen: boolean,
): boolean {
  return (dataMode ?? 'real') === 'real' && !migrationWindowOpen;
}

export async function assembleApp(config: ServerConfig, deps: AppDeps) {
  const isolatedRestoreRehearsal = config.isolatedRuntimeMode === 'restore-rehearsal';
  if (isolatedRestoreRehearsal && (!config.serviceRuntime || config.autoMigrate === true)) {
    throw new Error('restore rehearsal requires a pinned service runtime identity and a pre-migrated isolated database');
  }
  if ((config.maintenanceRecoveryKeyFile || config.maintenanceRecoveryKeyRegistry) && !config.maintenanceBackupManifest) {
    throw new Error('maintenance recovery key pins require the trusted backup manifest');
  }
  const autonomousWorkEnabled = !isolatedRestoreRehearsal && config.autoDispatch !== false;
  // These flags are set only when the actual local worker/timer is started.
  // The restore observation reports disabled effects from this live lifecycle
  // state, rather than echoing restore-plan booleans supplied by the caller.
  const restoreEffectRuntimeState = {
    dispatcher: false,
    ingestionConsumer: false,
    maintenanceRunner: false,
    retentionScheduler: false,
    recoverySweep: false,
    webhookDelivery: false,
    alertEmission: false,
  };
  if(config.adminLocalAuthEnabled) {
    if(config.adminOidcFlow) throw new Error('local admin authentication cannot coexist with OIDC');
    config.adminToken ??= randomBytes(32).toString('base64url');
    const serviceSecret=config.adminLocalServiceSecret ?? config.adminShellCookieSecret;
    if(!config.adminShellCookieSecret || !serviceSecret || Buffer.byteLength(serviceSecret,'utf8')<32) throw new Error('local admin authentication requires a shared service or cookie secret of at least32bytes');
    config.adminLocalServiceSecret=serviceSecret;
    config.adminTenantCredentialFor = tenantId => {
      const existing=Object.entries(config.tenantAdminTokens ?? {}).find(([,tenant])=>tenant===tenantId);
      return existing?.[0] ?? mintLocalTenantCredential(serviceSecret,tenantId);
    };
  }
  // W11-C1: reject unsafe credential configuration at boot. Equal
  // admin/runtime tokens would collapse role separation to a single secret
  // while the route table still implies two roles — fail-closed instead.
  if (
    config.adminToken !== undefined &&
    config.runtimeToken !== undefined &&
    config.adminToken === config.runtimeToken
  ) {
    throw new Error('refusing to boot: adminToken and runtimeToken must be distinct');
  }
  // R3-02: a tenant-scoped admin token must not alias an existing platform
  // credential — an alias would silently widen that credential's reach (or
  // make the runtime bearer an audit reader). Fail closed at boot (W11-C1).
  for (const [token, tenantId] of Object.entries(config.tenantAdminTokens ?? {})) {
    if (!tenantId) {
      throw new Error('refusing to boot: tenantAdminTokens entry maps to an empty tenantId');
    }
    if (config.adminToken && token === config.adminToken) {
      throw new Error('refusing to boot: tenantAdminTokens must not alias the platform adminToken');
    }
    if (config.runtimeToken && token === config.runtimeToken) {
      throw new Error('refusing to boot: tenantAdminTokens must not alias the runtimeToken');
    }
  }
  validateWorkerIdentityConfig(config);
  // SC-02 seam wiring: a prebuilt resolver wins; otherwise composition builds
  // one from the injected adapter options. With neither, no catalog resolution
  // is configured and consumers fail closed.
  if (!config.secretResolver && config.secrets) {
    config = { ...config, secretResolver: createRuntimeSecretResolver(config.secrets) };
  }
  const db = createDb(config.databaseUrl);
  const backupSnapshotWriteGate = createBackupSnapshotWriteGate();
  const backupArtifactEffects = config.serviceRuntime
    ? new PostgresBackupArtifactEffects(db, {
        runtimeIdentity: config.serviceRuntime.runtimeIdentity,
        bootId: randomUUID(),
      })
    : undefined;
  const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'api' } });
  const storageConfig = config.artifactStorage ?? { backend: 'postgres' as const };

  try {
    // Schema readiness (R08-06 / P2-01). applyMigrations boots with an
    // The image startup gate applies packaged migrations before HTTP starts.
    // Native callers can migrate explicitly or use autoMigrate for local boot.
    // DU_MIGRATION_ENABLED=false is an explicit schema-check bypass.
    if (process.env.DU_MIGRATION_ENABLED !== 'false' && config.autoMigrate === true) {
      await migrate(db);
    } else if (process.env.DU_MIGRATION_ENABLED !== 'false') {
      await verifyMigrations(db);
    }

    // A verified OIDC login may enroll an external platform Admin in the
    // independent Cost Alerts recipient directory. Enrollment pins only that
    // feature's current authorization version; failure or ineligibility does
    // not alter ordinary app login or authorization.
    config.adminOidcFlow?.setVerifiedLoginObserver(async (input) =>
      observeVerifiedLogin(db, input));

    // RFX-10: dev-only fallback rows. A production boot (autoMigrate=false,
    // no DU_SEED_DEV_FALLBACK) writes NEITHER row — see shouldSeedDevFallback.
    // Nothing in src/ reads these rows; they only preserved an FK target for
    // legacy/dev fixtures, so a production DB without them makes a stray
    // legacy insert fail with an FK error instead of silently succeeding.
    // Auth stays fail-closed either way: the placeholder hash matches no raw
    // key (resolveApiKey only finds real ACTIVE keys, R08-01).
    if (shouldSeedDevFallback(process.env, { zeroConfigBoot: config.autoMigrate === true && process.env.NODE_ENV !== 'production' })) {
      // Ensure default tenant for the slice (idempotent).
      await db.query(
        `INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default')
         ON CONFLICT (id) DO NOTHING`
      );
      // Dev fallback key row so operations.api_key_id FK always resolves.
      // PC-04: 0070 added `api_keys.key_mode` with no DEFAULT, so every writer
      // must declare one. The placeholder hash never authenticates (fail-closed
      // resolver), but leaving the column NULL would violate the "no NULL after
      // 0070" invariant this seed is checked against.
      await db.query(
        `INSERT INTO api_keys (id, tenant_id, hash, prefix, status, key_mode)
         VALUES ('00000000-0000-0000-0000-000000000099',
                 '00000000-0000-0000-0000-000000000001',
                 'dev-fallback-placeholder', 'dev-fallback', 'ACTIVE', 'LEGACY_STANDALONE')
         ON CONFLICT (id) DO NOTHING`
      );
    }
  } catch (error) {
    // Do not leave the PostgreSQL pool alive if startup fails before createApp
    // can return an App handle to its caller.
    await db.close().catch(() => undefined);
    throw error;
  }

  // Keep reverse-order ownership for resources acquired during composition.
  // If a later mandatory factory fails, callers never receive an App handle
  // with which to close these resources. The OIDC store from config remains
  // caller-owned and is intentionally absent from this stack.
  const failedBootCleanups: Array<() => void | Promise<void>> = [];
  const cleanupFailedBoot = async (bootError: unknown): Promise<never> => {
    for (const cleanup of failedBootCleanups.reverse()) {
      try { await cleanup(); } catch { /* preserve the original boot error */ }
    }
    try { await db.close(); } catch { /* preserve the original boot error */ }
    throw bootError;
  };

  try {
  // Start Redis only after DB readiness. If a DB connection/migration fails,
  // there is no Redis reconnect timer/socket left behind in a failed boot.
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  failedBootCleanups.push(() => { redis.disconnect(); });
  const s3Client = storageConfig.backend === 's3'
    ? await (async () => {
        const ref = config.artifactStorage?.backend === 's3' ? config.artifactStorage.credentialVersionRef : undefined;
        const ownerTenantId = config.artifactStorage?.backend === 's3' ? config.artifactStorage.credentialOwnerTenantId : undefined;
        if (Boolean(ref) !== Boolean(ownerTenantId)) throw new Error('S3 storage credential version and owner UUID must be configured together');
        if (ref && ownerTenantId) {
          const credentialValue = await resolveManagedSecretVersion(db, config.secretCatalogKeyring, ref, {
            tenantId: ownerTenantId,
            purpose: 'storage.credential',
            service: 'orchestrator',
          });
          const credentials = parseStorageS3Credentials(credentialValue);
          return new S3Client({
            region: storageConfig.region,
            endpoint: storageConfig.endpoint,
            forcePathStyle: storageConfig.forcePathStyle ?? Boolean(storageConfig.endpoint),
            credentials,
          });
        }
        // In-process legacy fixtures may still compose the old provider chain.
        // The standalone main entrypoint requires an exact managed revision.
        return new S3Client({
          region: storageConfig.region,
          endpoint: storageConfig.endpoint,
          forcePathStyle: storageConfig.forcePathStyle ?? Boolean(storageConfig.endpoint),
        });
      })()
    : undefined;
  if (s3Client) failedBootCleanups.push(() => { s3Client.destroy(); });

  // P2-07/CON-03: Connector management proxy registry (platform config only).
  // Compose it before Profiles so the canonical profile revision writer can
  // validate explicit pins using the validated API key's tenant.
  const connectorBaseUrls = config.connectorBaseUrls ?? {};
  // PLAT-MIG-01: ONE resolver for connector-scoped lookups. Exact IDs always
  // win. A configured `*` entry is an operator-owned static default service;
  // absent both exact and default routes, the lookup fails closed (404). The
  // base URL is never derived from caller input.
  const connectorBaseUrl = connectorBaseUrlResolver(connectorBaseUrls);
  const connectors: ConnectorProxy = createConnectorProxy({ baseUrlFor: connectorBaseUrl });
  // CONNECTOR-WIRE-A: compose the management proxy from platform config. Only
  // configured deployments get the surface — every other deployment reports
  // management:false and fails closed rather than half-proxying. The `*`, when
  // present, owns the service-level list and credential-revision adapter
  // target. Otherwise keep the existing first-configured target.
  const connectorManagementBaseUrl = Object.hasOwn(connectorBaseUrls, '*')
    ? connectorBaseUrls['*']
    : Object.values(connectorBaseUrls)[0];
  const connectorManagement =
    connectorManagementBaseUrl && config.connectorManagementAuthorizationForRequest
      ? createConnectorManagementStore({
          baseUrlFor: connectorBaseUrl,
          authorizationForRequest: config.connectorManagementAuthorizationForRequest,
          capabilityProbeTargets: [
            ...(Object.hasOwn(connectorBaseUrls, '*') ? [undefined] : []),
            ...Object.keys(connectorBaseUrls).filter((id) => id !== '*'),
          ],
        })
      : undefined;

  const registry = createRegistryService(db);
  const profiles: ProfileService = createProfileService(db, {
    ...(config.profileCipherKey ? { cryptoEnv: { ENCRYPTION_KEY: config.profileCipherKey } } : {}),
    ...(connectorManagement ? { connectorManagement } : {}),
  });
  // W48-C1: admin audit ledger — every admin mutation below appends one
  // immutable row via ctx.audit; GET /api/v1/admin/audit reads via
  // audit.listForTenant (ledger table: migration 0010 admin_audit_events).
  const audit: AuditService = createAuditService(db);
  const adminIdentity = createAdminIdentityService({
    db,
    audit,
    auth: config.adminIdentityAuth ?? {
      mode: config.adminLocalAuthEnabled ? 'local' : 'unmanaged',
      localEnabled: config.adminLocalAuthEnabled === true,
      oidc: null,
    },
  });
  const profileSelfService = createProfileSelfServiceService({
    db,
    profiles,
    registry,
    audit,
    identity: adminIdentity,
  });
  // ENC-08: use durable tenant settings for a configured application. The helper keeps
  // an in-memory fallback for offline callers that do not supply a database.
  const cryptoConfig = buildCryptoConfigOptions(config, audit, db);
  // W-ENC-08-WIRE-ENC07: the delivery service reads the SAME store the Admin
  // writes, so a toggle or a pinned key takes effect on the very next public
  // delivery. Config `policyByTenant` still works as a static fallback for
  // deployments with no crypto-config surface at all.
  const deliveryEncryption = createDeliveryEncryptionService(
    buildDeliveryEncryptionConfig(config, cryptoConfig),
  );
  registerAdminCryptoConfigWiring(config, cryptoConfig);
  // MM-05: the runtime owns sweepQueueIntegrity; getQueue is a hoisted
  // function declaration below, so a lazy accessor keeps creation order free.
  // CRX-01: build the metadata crypto seam FIRST and hand the SAME instance to
  // every durable control-plane writer below (submission, runtime, ingestion
  // consumer). `main.ts` composes a retained local key provider for PostgreSQL
  // real-data mode without Transit, or Vault Transit when explicitly configured.
  // Direct in-process callers may omit the seam for isolated fixtures; a real
  // service boot does not use that path.
  const metadataCrypto = config.metadataEncryption
    ? createMetadataCrypto(
        adaptKeyProviderForMetadata(config.metadataEncryption.keyProvider),
        config.metadataEncryption.keyRef,
      )
    : undefined;
  // CONTROL-PLANE-IMPL-818: ONE plaintext-read policy, built once, plus ONE
  // reader every control-plane consumer shares. main.ts has already refused a
  // real boot that set a HALF-specified mode (buildMetadataReadPolicy inside
  // buildEncryptionBootOptions), so reaching here with the mode absent means
  // an in-process embedder/test boot — warn and fall back to the bounded
  // compatibility window, never to an unbounded literal `true`.
  const metadataReadPolicy: MetadataReadPolicy = (() => {
    const modeRaw = process.env[METADATA_READ_MODE_ENV];
    if (modeRaw === undefined || modeRaw.length === 0) {
      if (metadataCrypto) {
        logger.warn(
          'metadata plaintext read mode not declared; applying the bounded compatibility window until '
            + METADATA_READ_MODE_ENV + ' is set',
        );
      }
      return createCompatibilityMetadataReadPolicy();
    }
    // Present but invalid -> throw, exactly like the production boot.
    return buildMetadataReadPolicy(process.env);
  })();
  const metadataMetricRegistry = new InMemoryMetricsRegistry();
  const metadataWindowMetrics = createMetadataWindowMetrics(metadataReadPolicy, metadataMetricRegistry);
  const metadataWindowControl = createMetadataWindowControl({
    policy: metadataReadPolicy,
    metrics: metadataWindowMetrics,
    audit,
    resolveAuth: (headers) => resolveAdminActionAuthAsync(
      {
        adminToken: config.adminToken,
        adminShellCookieSecret: config.adminShellCookieSecret,
      },
      headers,
      config.adminSessionStore,
    ),
  });
  const metadataReader = observeMetadataReader(
    createMetadataReader(metadataCrypto, metadataReadPolicy),
    metadataReadPolicy,
    metadataWindowMetrics,
  );
  const runtime = createRuntimeService(
    db,
    { getQueue: (name) => getQueue(name) },
    metadataCrypto,
    metadataReader,
    backupSnapshotWriteGate,
  );
  const usage = createUsageService(db, { backupSnapshotWriteGate });
  const composeOperations = createComposeOperationsService(db, audit, config.composeRunner);
  // One facade instance serves both upload branches: the single-PUT grants
  // and the multipart lifecycle must pin and verify the same generations.
  const s3StorageFacade = s3Client && storageConfig.backend === 's3'
    ? createS3ArtifactStorageFacade({ bucket: storageConfig.bucket, client: s3Client })
    : undefined;
  // SEC-ENC-05 / SEC-ENC-04 wiring: one crypto facade instance serves the
  // gateway, the worker artifact service and the S3 decrypt deps, so all three
  // agree on the key provider and AAD. `synthetic` (explicit exemption) keeps
  // the historical compatibility behaviour; real-data mode requires a sealed
  // envelope and only an approved migration window may read legacy plaintext.
  const artifactCryptoFacade: CryptoStorageFacade | null = config.publicUploadEncryption
    ? new CryptoStorageFacade(config.publicUploadEncryption.keyProvider)
    : null;
  const artifactMigrationWindowOpen =
    storageConfig.backend === 's3' && storageConfig.migrationWindow === true;
  const workerArtifactEncryption = config.publicUploadEncryption && artifactCryptoFacade
    ? {
        facade: artifactCryptoFacade,
        keyRef: config.publicUploadEncryption.keyRef,
        ...(config.publicUploadEncryption.keyVersion === undefined
          ? {}
          : { keyVersion: config.publicUploadEncryption.keyVersion }),
        required: resolveEncryptionRequirement(config.encryptionPolicy?.dataMode, artifactMigrationWindowOpen),
      }
    : undefined;
  const generationS3Clients = new Map<string, S3Client>();
  failedBootCleanups.push(() => {
    for (const client of generationS3Clients.values()) client.destroy();
  });
  const postgresGenerationFacade = createPostgresArtifactStorageFacade({
    async read(storageKey) {
      const result = await db.query<{ bytes: Buffer }>('SELECT bytes FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
      return result.rowCount ? Buffer.from(result.rows[0]!.bytes) : null;
    },
    async delete(storageKey) { await db.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]); },
    async write(storageKey, tenantId, bytes) {
      await db.query(
        `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
         ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
        [storageKey, tenantId, bytes],
      );
    },
  });
  const s3VersionConfigured = storageConfig.backend === 's3'
    && Boolean(config.artifactStorage?.backend === 's3'
      && config.artifactStorage.credentialVersionRef
      && config.artifactStorage.credentialOwnerTenantId);
  let storageGenerations: StorageGenerationService | undefined;
  if (storageConfig.backend === 'postgres' || s3VersionConfigured) {
    const trustedOrigins = new Set(config.storageEndpointAllowlist ?? []);
    if (storageConfig.backend === 's3' && storageConfig.endpoint) {
      try { trustedOrigins.add(new URL(storageConfig.endpoint).origin); } catch { /* boot env is validated by main */ }
    }
    storageGenerations = createStorageGenerationService({
      db,
      audit,
      encryption: workerArtifactEncryption,
      backupSnapshotWriteGate,
      ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
      verifyCredentialVersion: (reference, ownerTenantId) => verifyManagedSecretVersion(db, config.secretCatalogKeyring, reference, {
        tenantId: ownerTenantId,
        purpose: 'storage.credential',
        service: 'orchestrator',
      }),
      validateEndpoint: (endpoint) => isApprovedStorageEndpoint(endpoint, [...trustedOrigins]),
      resolveFacade: async (generation: StorageGenerationConfig) => {
        if (generation.backend === 'postgres') return postgresGenerationFacade;
        if (!generation.credentialVersionRef || !generation.credentialOwnerTenantId) {
          throw new Error('exact S3 credential version and owner are required');
        }
        // Resolve every time before returning a cached client so disable/revoke
        // and key-version removal take effect without waiting for a cache TTL.
        const credentialValue = await resolveManagedSecretVersion(db, config.secretCatalogKeyring, generation.credentialVersionRef, {
          tenantId: generation.credentialOwnerTenantId,
          purpose: 'storage.credential',
          service: 'orchestrator',
        });
        const client = generationS3Clients.get(generation.generationId) ?? (() => {
          const credentials = parseStorageS3Credentials(credentialValue);
          const created = new S3Client({
            region: generation.region,
            endpoint: generation.endpoint,
            forcePathStyle: generation.forcePathStyle,
            credentials,
          });
          generationS3Clients.set(generation.generationId, created);
          return created;
        })();
        const facade = createS3ArtifactStorageFacade({ bucket: generation.bucket, client });
        return withStorageGenerationUploadTtl(facade, generation.urlTtlSeconds);
      },
    });
    const configuredInitial: Omit<StorageGenerationConfig, 'generationId' | 'revision'> = storageConfig.backend === 's3'
      ? {
          backend: 's3',
          endpoint: storageConfig.endpoint ?? '',
          bucket: storageConfig.bucket,
          region: storageConfig.region ?? '',
          forcePathStyle: storageConfig.forcePathStyle ?? Boolean(storageConfig.endpoint),
          credentialVersionRef: config.artifactStorage?.backend === 's3' ? config.artifactStorage.credentialVersionRef ?? null : null,
          credentialOwnerTenantId: config.artifactStorage?.backend === 's3' ? config.artifactStorage.credentialOwnerTenantId ?? null : null,
          urlTtlSeconds: null,
        }
      : {
          backend: 'postgres', endpoint: 'postgres', bucket: '', region: 'postgres', forcePathStyle: false,
          credentialVersionRef: null, credentialOwnerTenantId: null, urlTtlSeconds: null,
        };
    const generationState = await db.query<{ active_generation_id: string }>(
      'SELECT active_generation_id FROM storage_generation_state WHERE singleton=true',
    );
    if (!generationState.rowCount) {
      const initialized = await storageGenerations.ensureInitial(configuredInitial);
      await db.query(
        `UPDATE artifacts SET storage_generation_id=$1
          WHERE storage_generation_id IS NULL AND storage_backend=$2`,
        [initialized.generationId, initialized.backend],
      );
    } else {
      await storageGenerations.current();
    }
    const retainedGenerationCredentials = await db.query<{
      credential_version_ref: string;
      credential_owner_tenant_id: string;
    }>(
      `SELECT credential_version_ref,credential_owner_tenant_id
         FROM storage_generations
        WHERE backend='s3' AND state IN ('ACTIVE','RETIRED')
        ORDER BY revision`,
    );
    for (const credential of retainedGenerationCredentials.rows) {
      await verifyManagedSecretVersion(db, config.secretCatalogKeyring, credential.credential_version_ref, {
        tenantId: credential.credential_owner_tenant_id,
        purpose: 'storage.credential',
        service: 'orchestrator',
      });
    }
  }
  const artifacts: ArtifactService = createArtifactService(db, {
    storageBackend: storageConfig.backend,
    migrationWindow: storageConfig.backend === 's3' && storageConfig.migrationWindow,
    maxArtifactBytes: config.maxBlobBytes,
    ...(storageGenerations ? { storageGenerations } : {}),
    ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
    backupSnapshotWriteGate,
    ...(s3StorageFacade ? { storageFacade: s3StorageFacade } : {}),
    ...(workerArtifactEncryption ? { encryption: workerArtifactEncryption } : {}),
  });
  const multipart: MultipartService = createMultipartService(db, {
    ...(storageGenerations ? { storageGenerations } : { storage: s3StorageFacade }),
    ...config.multipartLimits,
    // SEC-ENC-04: the worker multipart branch presigns client bytes straight at
    // storage, so while encryption is configured it fails closed per-session
    // until a server-mediated sealed multipart writer exists.
    encryptionRequired: resolveEncryptionRequirement(config.encryptionPolicy?.dataMode, artifactMigrationWindowOpen)
      && Boolean(config.publicUploadEncryption),
  });
  // CR28-01/CRX-02: the read side of the same encryption the public upload
  // gateway writes. One facade instance is shared with the gateway on purpose:
  // the AAD is rebuilt from the context on decrypt, and two facades with two
  // different key providers would make the two halves disagree about what was
  // sealed.
  //
  // RV01-03/CRX-02: the encrypted upload gateway is the ONLY write path this
  // platform has on S3, so a production S3 deployment that configures it
  // encrypts every artifact it writes; an object that arrives without the
  // sealed marker is then a fault, never a plaintext payload. The migration
  // window (`artifactStorage.migrationWindow`) is the operator-signed
  // exemption for objects written before encryption was enabled: while the
  // window is OPEN those legacy objects still read, and the moment it closes
  // every unsealed object fails closed. No boot path defaults to open — the
  // ready-for-production read is always the requiring one.
  const encryptedWritesRequired = Boolean(
    s3Client && storageConfig.backend === 's3' && config.publicUploadEncryption,
  );
  const artifactEncryptionRequired = resolveEncryptionRequirement(config.encryptionPolicy?.dataMode, artifactMigrationWindowOpen)
    && encryptedWritesRequired;
  // The worker artifact encryption seam is absent when the deployment is not
  // configured for encryption, in which case every stored object is plaintext.
  const s3CryptoStorageFacade: CryptoStorageFacade | null =
    s3Client && storageConfig.backend === 's3' ? artifactCryptoFacade : null;
  const artifactDecryptDeps: ArtifactDecryptDeps | null =
    s3Client && storageConfig.backend === 's3' && s3CryptoStorageFacade
      ? {
          reader: s3StoredObjectReader(s3Client, storageConfig.bucket),
          ...(storageGenerations
            ? {
                readerForArtifact: async ({ storageGenerationId }: { storageGenerationId: string }) => {
                  const target = await resolvePinnedGenerationUploadTarget(storageGenerationId);
                  return s3StoredObjectReader(target.client, target.bucket);
                },
              }
            : {}),
          facade: s3CryptoStorageFacade,
          encryptionRequired: artifactEncryptionRequired,
        }
      : null;

  async function resolvePinnedGenerationUploadTarget(generationId: string): Promise<{ client: S3Client; bucket: string }> {
    const selected = await db.query<{
      generation_id: string; backend: string; endpoint: string; bucket: string; region: string;
      force_path_style: boolean; credential_version_ref: string | null; credential_owner_tenant_id: string | null;
    }>(
      `SELECT generation_id,backend,endpoint,bucket,region,force_path_style,
              credential_version_ref,credential_owner_tenant_id
         FROM storage_generations WHERE generation_id=$1`,
      [generationId],
    );
    const generation = selected.rows[0];
    if (!generation || generation.backend !== 's3' || !generation.bucket
        || !generation.credential_version_ref || !generation.credential_owner_tenant_id) {
      throw new Error('PINNED_STORAGE_GENERATION_UNAVAILABLE');
    }
    const credentialValue = await resolveManagedSecretVersion(db, config.secretCatalogKeyring, generation.credential_version_ref, {
      tenantId: generation.credential_owner_tenant_id,
      purpose: 'storage.credential',
      service: 'orchestrator',
    });
    let client = generationS3Clients.get(generation.generation_id);
    if (!client) {
      client = new S3Client({
        region: generation.region,
        endpoint: generation.endpoint,
        forcePathStyle: generation.force_path_style,
        credentials: parseStorageS3Credentials(credentialValue),
      });
      generationS3Clients.set(generation.generation_id, client);
    }
    return { client, bucket: generation.bucket };
  }
  async function resolvePinnedGenerationSourceTarget(generationId: string) {
    const target = await resolvePinnedGenerationUploadTarget(generationId);
    return {
      generationId,
      bucket: target.bucket,
      send: (command: unknown) => target.client.send(command as never) as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
    };
  }

  const publicUploadGateway: PublicUploadGateway | null =
    (storageGenerations || (s3Client && storageConfig.backend === 's3'))
      && config.publicUploadEncryption && artifactCryptoFacade
      ? createPublicUploadGateway({
          db,
          ...(storageGenerations
            ? { storageGeneration: {
                current: async () => {
                  const active = await storageGenerations!.current();
                  return { generationId: active.generationId, backend: active.backend };
                },
                resolveS3Generation: resolvePinnedGenerationUploadTarget,
              } }
            : { client: s3Client!, bucket: storageConfig.backend === 's3' ? storageConfig.bucket : '' }),
          cryptoStorage: artifactCryptoFacade,
          keyRef: config.publicUploadEncryption.keyRef,
          keyVersion: config.publicUploadEncryption.keyVersion,
          maxBytes: config.publicUploadEncryption.maxBytes,
          backupSnapshotWriteGate,
          ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
        })
      : null;
  // W-DATA02-PUB-1: the multipart TTL sweep rides the recovery timer, exactly
  // like the MM-05 queue-integrity sweep. A PostgreSQL-only deployment has no
  // multipart sessions at all (the lifecycle answers 409 and creates no
  // rows), so the hook is disabled there rather than querying every tick.
  const runMultipartSweep = createMultipartSweepHook(multipart, Boolean(s3StorageFacade || storageGenerations));
  const runPublicArtifactCleanup = createPublicArtifactCleanupHook(artifacts);
  const connectorId = config.connectorId ?? 'default-connector';
  const connectorRevision = config.connectorRevision ?? 1;
  const grants: GrantService | null = config.invocationGrantSecret
    ? createGrantService(db, registry, {
        connectorId,
        connectorRevision,
        secret: Buffer.from(config.invocationGrantSecret, 'utf8'),
        ...(metadataCrypto ? { metadataCrypto } : {}),
      })
    : null;
  const lifecycle = createLifecycleService(db, metadataCrypto, metadataReader);
  const connectorSecretImports = connectorManagement && metadataCrypto && config.secretCatalogKeyring
    ? createConnectorSecretImportService({
        db,
        audit,
        metadataCrypto,
        catalogKeyring: config.secretCatalogKeyring,
        backupSnapshotWriteGate,
        connector: {
          claimRecipeDraft: (input) => connectorManagement.claimRecipeDraft(input),
          upsertResolvedRecipeDraft: (input) => connectorManagement.upsertResolvedRecipeDraft(input),
        },
      })
    : undefined;
  let refreshRetentionCleanupSchedule: (() => void) | undefined;
  const globalSettings = createGlobalSettingsService(db, audit, {
    ...(metadataCrypto ? { metadataCrypto } : {}),
    ...(connectorManagement ? { connectorManagement } : {}),
    backupSnapshotWriteGate,
    providerTestAvailable: Boolean(config.invocationGrantSecret && connectorManagement && metadataCrypto),
    onRetentionPolicyChanged: () => refreshRetentionCleanupSchedule?.(),
  });
  const submission = createSubmissionService(db, registry, profiles, {
    maxBlobBytes: config.maxBlobBytes,
    storageBackend: storageConfig.backend,
    backupSnapshotWriteGate,
    s3SourceRules: config.s3SourceRules,
    promptOverrides: createPromptOverrideService(db, metadataCrypto, metadataReader),
    ...(metadataCrypto ? { globalSettings } : {}),
    ...(connectorManagement ? { connectorManagement } : {}),
    ...(metadataCrypto ? { metadataCrypto } : {}),
  });
  // CREDWORKFLOW-IMPL (D3): compose the production credential workflow when
  // the operator requested it via env; an explicit `config.credentialWorkflow`
  // injection still wins. Partial env refuses boot (typed) inside compose —
  // a half-configured deployment must not boot into silent 503s.
  let credentialWorkflow = config.credentialWorkflow;
  if (!credentialWorkflow && credentialWorkflowEnvRequested(process.env)) {
    if (!connectorManagementBaseUrl) {
      throw new CredentialWorkflowBootError(
        'credential workflow requires connectorBaseUrls (the revision store has no base URL)'
      );
    }
    if (!config.connectorManagementAuthorizationForRequest) {
      throw new CredentialWorkflowBootError(
        'credential workflow requires SERVICE_IDENTITY_SECRET for signed Connector management requests'
      );
    }
    credentialWorkflow = composeCredentialWorkflow({
      env: process.env,
      revisions: createConnectorRevisionHttpAdapter({
        baseUrl: connectorManagementBaseUrl,
        authorizationForRequest: config.connectorManagementAuthorizationForRequest,
      }),
    });
  }

  const queues = new Map<string, Queue>();
  failedBootCleanups.push(async () => {
    for (const queue of queues.values()) await queue.close();
  });
  function getQueue(name: string): Queue {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redis as never });
      queues.set(name, q);
    }
    return q;
  }

  const serviceRuntime = config.serviceRuntime
    ? createServiceRuntime({
        db, redis, config: config.serviceRuntime, isolatedReadOnly: isolatedRestoreRehearsal,
        restoreExternalEffects: () => {
          const activeDispatch = restoreEffectRuntimeState.dispatcher || restoreEffectRuntimeState.ingestionConsumer;
          return {
            admission: 'UNKNOWN', // Replaced by the actual DRAINING/ACK/DB proof in ServiceRuntime.
            dispatch: restoreEffectRuntimeState.dispatcher ? 'ENABLED' : 'DISABLED',
            providerInvocation: activeDispatch ? 'ENABLED' : 'DISABLED',
            // These are not Orchestrator-owned workers; their real runtime
            // gates are independently observed from the Connector process.
            connectorPoll: 'DISABLED',
            usageDelivery: 'DISABLED',
            webhookDelivery: restoreEffectRuntimeState.webhookDelivery ? 'ENABLED' : 'DISABLED',
            alertEmission: restoreEffectRuntimeState.alertEmission ? 'ENABLED' : 'DISABLED',
            cleanup: restoreEffectRuntimeState.recoverySweep || restoreEffectRuntimeState.retentionScheduler
              ? 'ENABLED' : 'DISABLED',
            historicalMaintenance: restoreEffectRuntimeState.maintenanceRunner ? 'ENABLED' : 'DISABLED',
            migrations: config.autoMigrate === true ? 'ENABLED' : 'DISABLED',
          };
        },
      })
    : undefined;
  if (serviceRuntime) failedBootCleanups.push(() => serviceRuntime.close());
  let rolloutObservationAdapter: Awaited<ReturnType<typeof createTrustedManifestRolloutPreviewAdapter>> | undefined;
  if (config.maintenanceManifest) {
    if (!serviceRuntime) throw new Error('MAINTENANCE_SERVICE_RUNTIME_REQUIRED');
    const manifest = config.maintenanceManifest;
    const readerInput = { manifestPath: manifest.manifestPath, expectedManifestSha256: manifest.expectedManifestSha256 };
    const [controlTargets, ingressTargets, workerBusinessByIdentity] = await Promise.all([
      readReplicaRuntimeControlTargets(readerInput),
      readFixedIngressProbeUrlMap(readerInput),
      readWorkerReplicaBusinessMap(readerInput),
    ]);
    const orchestratorTargets = controlTargets.orchestrator;
    if (orchestratorTargets) {
      const local = orchestratorTargets[serviceRuntime.identity.slot];
      if (!local || local.runtimeIdentity !== serviceRuntime.identity.runtimeIdentity) {
        throw new Error('MAINTENANCE_RUNTIME_IDENTITY_NOT_IN_MANIFEST');
      }
    }
    const connectorTargets = controlTargets.connector;
    if (connectorTargets && !config.connectorManagementAuthorizationForRequest) {
      throw new Error('MAINTENANCE_CONNECTOR_CONTROL_IDENTITY_REQUIRED');
    }
    const missingSource: ReplicaRuntimeSafetySource = {
      async observe() { return null; },
      async requestDrain() { throw new Error('REPLICA_RUNTIME_CONTROL_UNAVAILABLE'); },
      async requestResume() { throw new Error('REPLICA_RUNTIME_CONTROL_UNAVAILABLE'); },
    };
    const worker = createWorkerReplicaSafetySource(db, workerBusinessByIdentity);
    const orchestrator = orchestratorTargets
      ? createOrchestratorHttpReplicaSafetySource({ targets: orchestratorTargets, controlToken: serviceRuntime.controlToken })
      : missingSource;
    const connector = connectorTargets && config.connectorManagementAuthorizationForRequest
      ? createConnectorReplicaRuntimeSafetySource({ targets: connectorTargets, authorizationForRequest: config.connectorManagementAuthorizationForRequest })
      : missingSource;
    const runtimeSafety = createReplicaRuntimeSafetyPort({
      worker,
      orchestrator,
      connector,
      probeFixedIngress: createFixedIngressReplicaProbe({
        controlTargets,
        ingressTargets,
        orchestratorControlToken: serviceRuntime.controlToken,
        ...(config.connectorManagementAuthorizationForRequest
          ? { connectorAuthorizationForRequest: config.connectorManagementAuthorizationForRequest }
          : {}),
      }),
    });
    rolloutObservationAdapter = await createTrustedManifestRolloutPreviewAdapter({ ...readerInput, runtimeSafety });
  }
  const dispatcher = createDispatcher({
    db,
    getQueue,
    backupSnapshotWriteGate,
    ...(serviceRuntime ? {
      dispatchAdmission: {
        serviceRuntimeId: serviceRuntime.identity.serviceRuntimeId,
        readControl: () => serviceRuntime.readControl(),
        acquireDispatchPermit: (input) => serviceRuntime.acquireDispatchPermit(input),
        releaseDispatchPermit: (permitId) => serviceRuntime.releaseDispatchPermit(permitId),
      },
    } : {}),
  });  // P2-09 background expired-lease recovery sweep. Default ON with auto-dispatch
  const maintenanceService = createMaintenanceService({
    db,
    audit,
    backupSnapshotWriteGate,
    artifacts,
    ...(storageGenerations ? { storageGenerations } : {}),
    getEffectiveRetentionPolicy: () => globalSettings.getEffectiveRetentionPolicy(),
    getQueue: (name) => getQueue(name),
    callbackCapabilities: {
      dispatcherConfigured: autonomousWorkEnabled && Boolean(config.webhookSecret),
      authResolverConfigured: Boolean(config.resolveCallbackSecret),
    },
    recoverExpiredLease: runtime.recoverExpiredLease,
    ...(rolloutObservationAdapter ? { rolloutObservationAdapter } : {}),
    ...(config.maintenanceBackupManifest ? {
      listBackupTargetDescriptors: async () => {
        const manifest = config.maintenanceBackupManifest!;
        const projection = await readTrustedMaintenanceTargetDescriptors({
          manifestPath: manifest.manifestPath,
          expectedManifestSha256: manifest.expectedManifestSha256,
        });
        return projection.backupTargets;
      },
    } : {}),
    // The HTTP composition previews, queues, and reads durable maintenance
    // work. Only the separately composed host runner may claim it.
    runnerRuntimeIdentity: null,
  });
  // Retention polling only creates durable cleanup jobs; the Host runner owns
  // every maintenance claim and effect. Keep this scheduler in the serving
  // process so published cadence changes remain effective, but disable it in
  // isolated restore rehearsal.
  const retentionCleanupScheduler = serviceRuntime && !isolatedRestoreRehearsal
    ? createRetentionCleanupScheduler({
        db,
        maintenance: maintenanceService,
        getEffectiveRetentionPolicy: () => globalSettings.getEffectiveRetentionPolicy(),
        batchSize: 100,
        onError: (error) => logger.error('retention cleanup scheduler failed', { errorName: errorNameOf(error) }),
      })
    : undefined;
  refreshRetentionCleanupSchedule = retentionCleanupScheduler
    ? () => retentionCleanupScheduler.refresh()
    : undefined;
  // The trusted adapter is composed below only when all real replica/fence
  // ports are available. Build the exact-version resolver now so that the
  // central factory never falls back to the mutable secret catalog.
  const resolveRecoveryKey = createMaintenanceRecoveryKeyResolver({
    ...(config.maintenanceRecoveryKeyFile ? { backupBundle: config.maintenanceRecoveryKeyFile } : {}),
    ...(config.maintenanceRecoveryKeyRegistry ? { secretCatalogRegistry: config.maintenanceRecoveryKeyRegistry } : {}),
  });
  const costControl = createCostControlService(db, audit, () => new Date(), {
    invocationGrantSecret: config.invocationGrantSecret,
    backupSnapshotWriteGate,
  });
  const costAdjustmentEvidence = createCostAdjustmentEvidenceResolver({ db, artifacts });
  const costAdjustments = createCostAdjustmentService({
    db,
    audit,
    artifacts: costAdjustmentEvidence,
    backupSnapshotWriteGate,
    assertWriterCurrent: async (actor, client) => {
      if (actor.authKind !== 'cookie' || actor.kind !== 'platform' || actor.role !== 'admin'
          || actor.tenantId !== null || !actor.principalId || !actor.sessionId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'a current platform Admin cookie session is required');
      }
      const current = await config.adminSessionStore?.get(actor.sessionId);
      if (!current || current.role !== 'admin' || current.tenantId !== null) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'the current Admin session is expired or no longer authorized');
      }
      if (current.issuer === 'du-local') {
        if (current.sub !== actor.principalId || actor.issuer !== undefined || actor.sub !== undefined
            || !Number.isSafeInteger(actor.roleVersion) || (actor.roleVersion ?? 0) < 1
            || current.roleVersion !== actor.roleVersion) {
          throw new HttpError(401, 'UNAUTHENTICATED', 'the local Admin session version changed');
        }
        const local = await client.query<{ id: string; version: number }>(
          `SELECT id::text AS id,version FROM admin_local_users
            WHERE id=$1 AND tenant_id IS NULL AND role='admin' AND is_enabled=true AND is_locked=false
              AND legacy_password_reset_required=false AND version=$2`,
          [actor.principalId, actor.roleVersion],
        );
        if (local.rowCount !== 1) throw new HttpError(401, 'UNAUTHENTICATED', 'the local Admin account is disabled or changed');
        return;
      }
      if (typeof actor.issuer !== 'string' || typeof actor.sub !== 'string'
          || current.issuer !== actor.issuer || current.sub !== actor.sub
          || current.costAlertPrincipalId !== actor.principalId) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'the verified Admin identity changed');
      }
      // Cost Alert directory state/version is deliberately not checked here:
      // it controls notification delivery, not the application Admin role.
    },
  });

  // W-DATA03-CONSUMER-JOIN-1: the durable consumer behind gate 'ingestion'.
  // It runs only over the versioned private-S3 backend (the pin port needs
  // immutable version ids to honor the receipt contract); on a postgres-only
  // deployment the gate rows stay UNDISPATCHED instead of leaking to the
  // business queue - fail CLOSED, visibly, per the audit policy.
  // ingestionConsumer.intervalMs=0 keeps the handle for test driving only.
  // W1C-COMPOSITION: the acquisition-time credential resolver, composed HERE
  // so the deployed gate authenticates its fetches for real. It reads the
  // pinned revision's `file_url_auth_cipher` from the SAME db the gate uses
  // and decrypts immediately before the fetch (never a claim/queue/checkpoint
  // copy). A legacy or auth-not-configured operation resolves to
  // `{kind:'none'}` — the historical unauthenticated path stays byte-identical.
  const acquisitionRefResolver = createAcquisitionRefResolver({ db });

  // Source clients use AWS's default credential chain (workload IAM role).
  // No caller endpoint, credentials or role ARN can enter this configuration.
  const sourceClients = new Map<string, S3Client>();
  failedBootCleanups.push(() => {
    for (const client of sourceClients.values()) client.destroy();
  });
  const acquireS3FileForTenant = createS3SourceAcquisition(config.s3SourceRules ?? [], rule => {
    let client = sourceClients.get(rule.region);
    if (!client) { client = new S3Client({ region: rule.region }); sourceClients.set(rule.region, client); }
    return client;
  });
  const requireEncryptedSourceWrites = resolveEncryptionRequirement(config.encryptionPolicy?.dataMode, false);
  const ingestionStorage = storageGenerations && storageConfig.backend === 's3'
    ? config.publicUploadEncryption && artifactCryptoFacade
      ? createGenerationAwareS3EncryptedPinnedSourceStorage({
          db,
          resolveTarget: async () => {
            const active = await storageGenerations!.current();
            if (active.backend !== 's3') throw new Error('INGESTION_STORAGE_GENERATION_NOT_S3');
            return resolvePinnedGenerationSourceTarget(active.generationId);
          },
          encryption: {
            facade: artifactCryptoFacade,
            keyRef: config.publicUploadEncryption.keyRef,
            ...(config.publicUploadEncryption.keyVersion === undefined
              ? {}
              : { keyVersion: config.publicUploadEncryption.keyVersion }),
          },
          ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
        })
      : createGenerationAwareS3PinnedSourceStorage({
          db,
          resolveTarget: async () => {
            const active = await storageGenerations!.current();
            if (active.backend !== 's3') throw new Error('INGESTION_STORAGE_GENERATION_NOT_S3');
            return resolvePinnedGenerationSourceTarget(active.generationId);
          },
        })
    : s3Client && storageConfig.backend === 's3'
      ? config.publicUploadEncryption && artifactCryptoFacade
        ? createS3EncryptedPinnedSourceStorage({
            bucket: storageConfig.bucket,
            send: (command) =>
              s3Client.send(command as never) as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
            db,
            encryption: {
              facade: artifactCryptoFacade,
              keyRef: config.publicUploadEncryption.keyRef,
              ...(config.publicUploadEncryption.keyVersion === undefined
                ? {}
                : { keyVersion: config.publicUploadEncryption.keyVersion }),
            },
          ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
          })
        : createS3PinnedSourceStorage({
            bucket: storageConfig.bucket,
            send: (command) =>
              s3Client.send(command as never) as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
            db,
          })
      : null;
  const ingestionConsumer =
    !isolatedRestoreRehearsal && ingestionStorage
      ? createIngestionConsumer({
          db,
          storage: ingestionStorage,
          ...(backupArtifactEffects ? { backupArtifactEffects } : {}),
          ...(storageGenerations && 'storageGenerationIdFor' in ingestionStorage
            ? { storageGenerationIdFor: ingestionStorage.storageGenerationIdFor }
            : {}),
          storageBackend: storageGenerations ? 's3' : storageConfig.backend,
          requireEncryptedSourceWrites,
          acquireS3FileForTenant,
          transfer: {
            maxBytes: config.ingestionConsumer?.maxBytes ?? config.maxBlobBytes ?? 64 * 1024 * 1024,
            timeoutMs: config.ingestionConsumer?.timeoutMs,
            idleTimeoutMs: config.ingestionConsumer?.idleTimeoutMs,
            maxRedirects: config.ingestionConsumer?.maxRedirects,
          },
          batch: config.ingestionConsumer?.batch,
          maxAttempts: config.ingestionConsumer?.maxAttempts,
          pollIntervalMs: config.ingestionConsumer?.intervalMs,
          // W1C-COMPOSITION: the resolver above, bound to the app's own db —
          // deny-first (typed) before any network, `{kind:'none'}` for
          // unpinned/legacy operations.
          resolveSourceAuth: (coords) => acquisitionRefResolver.resolveSourceAuth(coords),
          onCredentialOriginWarning: (event) => {
            logger.warn('credential origin policy warning', {
              operationId: event.operationId,
              tenantId: event.tenantId,
              origin: event.origin ?? 'invalid',
              code: event.code,
              state: event.mode,
              event: {
                kind: 'credential.origin_denied',
                reason: event.code,
                action: event.mode,
              },
            });
          },
          // CRX-01: the gate re-seals operations.input_ref / tasks.payload_ref
          // (READY envelope) and opens the submit-side sealed payload, both
          // with the ONE submit/runtime seam instance built above.
          ...(metadataCrypto ? { metadataCrypto, metadataReader } : {}),
          onGateOpened: () => {
            void dispatcher.dispatchOnce().catch(() => undefined);
          },
        })
      : undefined;

  // MM-05 queue-integrity health cache (docs/38 §6): one in-memory slot
  // holding the latest sweep result. Absent until the first sweep runs —
  // /health omits the field rather than fabricating an OK.
  let queueIntegrity: QueueIntegrityHealth | undefined;
  let queueIntegrityLostStreak = 0;
  async function runQueueIntegritySweep(): Promise<QueueIntegrityHealth> {
    const r = await runtime.sweepQueueIntegrity({
      graceMs: config.queueIntegrityGraceMs,
      limit: config.queueIntegrityBatch,
      maxAttempts: config.queueIntegrityMaxAttempts,
    });
    const lost = r.rearmed + r.stalled;
    queueIntegrityLostStreak = lost > 0 ? queueIntegrityLostStreak + 1 : 0;
    const state: QueueIntegrityHealth['state'] =
      r.stalled > 0 || queueIntegrityLostStreak >= 2
        ? 'SUSPECT'
        : r.rearmed > 0
          ? 'RECONSTRUCTING'
          : 'OK';
    queueIntegrity = {
      state,
      orphansLast: lost,
      stalled: r.stalled,
      lastSweepAt: new Date().toISOString(),
    };
    if (r.stalled > 0) {
      // D1 ledger warning, platform-global like the deadline-sweep W48-C1
      // precedent; delivery ids stay internal, the count rides the health cache.
      await audit
        .record({
          tenantId: null,
          actor: 'platform',
          action: 'queue.integrity_stalled',
          resource: 'operations:queue-integrity-stalled',
          severity: 'warning',
        })
        .catch(() => undefined);
    }
    return queueIntegrity;
  }
  // (production); tests drive sweepExpiredLeases() directly by passing 0 or leaving
  // autoDispatch=false to disable the timer.
  const defaultRecoveryInterval = autonomousWorkEnabled ? 5_000 : 0;
  const recoveryIntervalMs = isolatedRestoreRehearsal ? 0 : (config.leaseRecoveryIntervalMs ?? defaultRecoveryInterval);
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const workerInstanceRetentionScheduler = createWorkerInstanceRetentionScheduler(db, {
    enabled: autonomousWorkEnabled,
    onSweep: (result) => {
      if (result.deleted > 0) {
        logger.info('expired worker instance inventory removed', {
          scanned: result.scanned,
          deleted: result.deleted,
          protectedByRunningTask: result.protectedByRunningTask,
        });
      }
    },
    onError: (error) => {
      logger.warn('worker instance retention sweep failed', { errorName: errorNameOf(error) });
    },
  });
  // P2-08: webhook dispatcher runs at production cadence only when a signing
  // secret is configured; scheduling (durable rows) happens regardless.
  const defaultWebhookInterval =
    autonomousWorkEnabled && config.webhookSecret ? 5_000 : 0;
  const webhookIntervalMs = isolatedRestoreRehearsal ? 0 : (config.webhookDispatchIntervalMs ?? defaultWebhookInterval);
  let webhookTimer: ReturnType<typeof setInterval> | undefined;
  // PR-Q3-10 (P8-04): graceful-shutdown plumbing for the webhook loop. The abort
  // controller feeds deliverWebhooks' shutdown gate (no NEW claims, bounded drain of
  // in-flight deliveries, over-grace claims released back to PENDING by cycle 97).
  const webhookShutdown = new AbortController();
  const webhookDrainTimeoutMs = config.webhookDrainTimeoutMs ?? 5_000;
  let activeWebhookSweep: Promise<number | undefined> | undefined;
  let costAlertTimer: ReturnType<typeof setInterval> | undefined;
  let activeCostAlertSweep: Promise<unknown> | undefined;
  const costAlertWorkerId = `orchestrator-${randomUUID()}`;
  const runCostAlertBatch = (): Promise<void> => {
    if (activeCostAlertSweep) return activeCostAlertSweep.then(() => undefined);
    const sweep = runCostAlertDeliveryBatch(db, { workerId: costAlertWorkerId, limit: 25 })
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.warn('cost alert delivery batch failed', { errorName: errorNameOf(error) });
      });
    activeCostAlertSweep = sweep;
    void sweep.finally(() => {
      if (activeCostAlertSweep === sweep) activeCostAlertSweep = undefined;
    });
    return sweep;
  };

  // Rendered Admin shell (P6-01): mounted BEFORE boot returns so the
  // platform's createApp path is the integration. Fail-closed: null when no
  // cookie secret is configured. Mounting here (not in listen()) keeps the
  // shell lifecycle owned by this module — app.close() below stops it.
  // W46-C2: the shell's section fetchers need the platform JSON base URL
  // (CX3 W43-R13 shell-mount HIGH). `config.jsonBaseUrl`, when set, is the
  // explicit deployment topology; otherwise the shell is (re)mounted in
  // listen() against this process's own bound address. Mounting here with
  // `jsonBaseUrl: undefined` keeps the pre-listen handle valid for callers
  // that never call listen(); listen() remounts with the resolved base URL.
  const localAdminBoot = config.adminLocalAuthEnabled ? await createLocalAdminAuth({db,redisUrl:config.redisUrl}) : undefined;
  if (localAdminBoot) failedBootCleanups.push(() => localAdminBoot.close());
  if(localAdminBoot) { config.adminLocalAuth=localAdminBoot.localAuth; config.adminSessionStore=localAdminBoot.sessions; }
  const adminShell = await attachAdminShell({
    config,
    profileSelfService,
    ...(serviceRuntime ? { trackHttpRequest: serviceRuntime.trackHttpRequest } : {}),
  });
  if (adminShell) failedBootCleanups.push(() => adminShell.handle.close());

  // RCR-01: the listener used to be an async callback whose rejection escaped
  // (setHeader/URL parsing ran outside every try); `Host: [` threw
  // ERR_INVALID_URL and, under strict unhandled-rejection handling, took the
  // process down. ONE boundary now owns the whole callback: every rejection
  // becomes a controlled problem response and the process never sees an
  // unhandled rejection.
  const handleListenerFailure = (err: unknown, res: ServerResponse): void => {
    const fallbackId = randomUUID();
    try {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        return;
      }
      res.setHeader('x-correlation-id', fallbackId);
      res.setHeader('content-type', 'application/problem+json');
      if (isHttpError(err)) {
        res.statusCode = err.status;
        res.end(JSON.stringify(err.toProblem(fallbackId)));
        return;
      }
      logger.error('unhandled listener error', { errorName: errorNameOf(err), correlationId: fallbackId });
      res.statusCode = 500;
      res.end(JSON.stringify(sanitizedInternalError(fallbackId)));
    } catch {
      // The socket may already be gone; there is nobody left to answer.
      try {
        res.destroy();
      } catch {
        /* noop */
      }
    }
  };

  const handleHttpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    audience: IngressAudience,
  ): Promise<void> => {
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('content-type', 'application/json');

    // RCR-01: parse against a CONFIGURED base — NEVER the request-controlled
    // Host header. A malformed request-target still gets a controlled 400
    // through the boundary instead of throwing out of the listener.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', config.publicBaseUrl ?? 'http://localhost');
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST', 'malformed request URL');
    }
    // PM-M02-ROUTE: the ingress fence runs FIRST — immediately after the
    // controlled URL parse and BEFORE any body consumption, stream/upload/blob
    // setup, context/dependency work or route dispatch. A denied family is
    // answered with the standard generic 404 problem response for every method,
    // even with a valid admin/runtime credential, and the unread body is
    // discarded without buffering.
    assertIngressAllowed(audience, url.pathname);
    const method = req.method ?? 'GET';
    await serviceRuntime?.trackHttpRequest(method, url.pathname, res);
    // FIX-CR-11: bounded ingress. The blob PUT is the only binary route —
    // every other route takes JSON. Body read errors (abort, oversize,
    // truncated stream) resolve INSIDE this try so the route error handler
    // converts them to a controlled problem response (never an unhandled
    // rejection in the listener).
    const isBlobPut =
      method === 'PUT' && /^\/api\/runtime\/v1\/artifacts\/blob\/[^/]+$/.test(url.pathname);
    const isAdminUploadStream = method === 'POST' && url.pathname === '/api/internal/operations/uploads';
    const isPublicUploadStream =
      method === 'PUT' && /^\/api\/v1\/uploads\/[^/]+(?:\/content)?$/.test(url.pathname);
    // The legacy facade receives `multipart/form-data` with file bytes inline,
    // so it must stream too: `readBoundedBody` would JSON.parse a binary body
    // and buffer the whole upload before the route ever sees it. The compat
    // parser bounds its own read (see `readMultipartBody`), and unlike the
    // upload routes it needs the bytes to still be arriving.
    const isLegacyCompat =
      method === 'POST' &&
      /^\/api\/v1\/docs\/[a-z-]+(?:\/schema)?$/.test(url.pathname) &&
      (req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
    let ingress: IngressBody;
    try {
      ingress = isPublicUploadStream || isAdminUploadStream || isLegacyCompat
        ? { body: undefined, rawBody: Buffer.alloc(0) }
        : await readBoundedBody(req, {
            binary: isBlobPut,
            limits: {
              maxJsonBytes: config.maxJsonBytes,
              maxBlobBytes: config.maxBlobBytes,
            },
          });
    } catch (err) {
      // Abort path: when the client is already gone (destroyed/ended
      // socket) there is nobody to answer — return silently so the async
      // listener never throws (unhandled rejection, CR-11). A live socket
      // always gets a controlled problem response, never a rethrow.
      if (res.writableEnded || res.destroyed) return;
      if (isHttpError(err)) {
        res.setHeader('content-type', 'application/problem+json');
        const problem = err.toProblem(correlationId);
        res.statusCode = err.status;
        res.end(JSON.stringify(problem));
        return;
      }
      logger.error('unhandled ingress error', { errorName: errorNameOf(err), correlationId, pathname: url.pathname });
      res.statusCode = 500;
      res.setHeader('content-type', 'application/problem+json');
      res.end(JSON.stringify(sanitizedInternalError(correlationId)));
      return;
    }
    const { body, rawBody } = ingress;

    try {
      const result = await deps.route({
        // PM-M02-ROUTE: server-owned ingress audience. Required, never
        // header/query/body-derived, never defaulted to internal.
        ingressAudience: audience,
        method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: req.headers as Record<string, string>,
        body,
        rawBody,
        ...(isPublicUploadStream || isAdminUploadStream || isLegacyCompat ? { bodyStream: req } : {}),
        correlationId,
        host: (req.headers.host as string) ?? 'localhost',
        db,
        redis,
        registry,
        profiles,
        audit,
        submission,
        runtime,
        usage,
        composeOperations,
        globalSettings,
        maintenanceService,
        costControl,
        costAdjustments,
        backupSnapshotWriteGate,
        serviceRuntime,
        identity: adminIdentity,
        profileSelfService,
        artifacts,
        multipart,
        publicUploadGateway,
        artifactDecryptDeps,
        grants,
        connectors,
        lifecycle,
        dispatcher,
        getQueue,
        queueIntegrity: () => queueIntegrity,
        credentialWorkflow,
        connectorManagement,
        connectorSecretImports,
        metadataCrypto,
        metadataReader,
        deliveryEncryption,
        cryptoConfig: cryptoConfig,
        config,
      });
      res.statusCode = result.status;
      for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
      // FIX-CR-13: binary wire contract. A route returning `raw` sends stored
      // bytes byte-for-byte (no JSON.stringify, no base64) so SDK consumers
      // reading arrayBuffer()/streaming to disk get the exact PUT bytes.
      if (result.raw instanceof Readable) {
        await pipeline(result.raw, res);
      } else if (result.raw) {
        res.setHeader('content-length', String(result.raw.length));
        res.end(result.raw);
      } else {
        res.end(JSON.stringify(result.body ?? {}));
      }
    } catch (err) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      // A rejected body (413 on a cap, a 400 from the multipart parser) means
      // the request was abandoned part-way. Draining an unread socket would
      // leave the client waiting for a response it already gave up on, so close
      // instead of trying to finish reading it.
      if ((isPublicUploadStream || isAdminUploadStream || isLegacyCompat) && !req.destroyed && !req.complete) {
        res.shouldKeepAlive = false;
        res.setHeader('connection', 'close');
        req.resume();
      }
      if (isHttpError(err)) {
        res.setHeader('content-type', 'application/problem+json');
        const problem = err.toProblem(correlationId);
        res.statusCode = err.status;
        res.end(JSON.stringify(problem));
        return;
      }
      logger.error('unhandled request error', { errorName: errorNameOf(err), correlationId, pathname: url.pathname });
      res.statusCode = 500;
      res.setHeader('content-type', 'application/problem+json');
      res.end(JSON.stringify(sanitizedInternalError(correlationId)));
    }
  };

  const server = createServer((req, res) => {
    void handleHttpRequest(req, res, 'public').catch((err) => handleListenerFailure(err, res));
  });
  // PM-M02-ROUTE: the INTERNAL JSON listener over the SAME assembled app — one
  // DB/Redis set, one dispatcher, one set of runtime instances and timers. It
  // keeps public, admin and runtime handlers available (the BFF calls
  // /api/v1/operations and /api/v1/usage), each still enforcing its own auth.
  const internalServer = createServer((req, res) => {
    void handleHttpRequest(req, res, 'internal').catch((err) => handleListenerFailure(err, res));
  });

  return {
    db,
    redis,
    server,
    // PM-M02-ROUTE: the internal JSON listener, for fixtures and lifecycle
    // verification. Runtime/admin HTTP fixtures MUST target this server.
    internalServer,
    registry,
    profiles,
    submission,
    runtime,
    serviceRuntime,
    maintenanceService,
    costControl,
    dispatcher,
    // W-DATA03-CONSUMER-JOIN-1 test seam: undefined unless the s3 backend
    // is wired; runOnce() then drives the whole claim->pin->gate leg.
    ingestionConsumer,
    // CONNECTOR-WIRE-A test seam: the composed management proxy (undefined
    // on deployments without connectorBaseUrls).
    connectorManagement,
    connectorSecretImports,
    // CREDWORKFLOW-IMPL test seam: composed from env (or the config override).
    credentialWorkflow,
    // WINDOW-METRICS-825: shared read counters and an explicit, audited
    // next-boot close authorization. The policy itself remains boot-only.
    metadataWindowControl,
    metadataWindowMetrics,
    // MM-05 test seam: drive the sweep + health cache exactly like the
    // recoveryTimer hook does in production (sweepExpiredLeases parity).
    runQueueIntegritySweep,
    // W-DATA02-PUB-1 test seam: the multipart sweep hook wired into the
    // recovery timer above (no-ops on a postgres-only deployment).
    runMultipartSweep,
    // WFA-02: durable cleanup intents for workflow uploads whose admission
    // failed are retried on the same recovery cadence.
    runPublicArtifactCleanup,
    queueIntegrityHealth: () => queueIntegrity,
    getQueue,
    // Rendered Admin shell (P6-01): lifecycle owned here so app.close()
    // always stops the shell with the platform.
    adminShell,
    enableVersionForTest: (businessId: string, version: string) => enableVersionForTest(db, businessId, version),
    async listen() {
      // IF-06-STARTUP-ROLLBACK-CLEANUP: a startup that fails anywhere in this
      // block must leave NO JSON socket open. The previous code bound the public
      // listener first, so a failing internal bind (or a failing shell remount)
      // escaped with publicListening=true and internalListening=true.
      // Now every failure rolls BOTH listeners back before rethrowing.
      try {
        // PM-M02-ROUTE: bind BOTH JSON listeners before any loop starts or the
        // shell is remounted. The public listener keeps the existing return
        // shape; the internal one is exposed for fixtures and lifecycle checks.
        await serviceRuntime?.start();
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.port, config.host ?? '0.0.0.0', () => resolve());
        });
        await new Promise<void>((resolve, reject) => {
          internalServer.once('error', reject);
          internalServer.listen(config.internalPort ?? 3002, config.internalHost ?? '127.0.0.1', () => resolve());
        });
        // W46-C2: resolve the shell's JSON base URL only now that the platform
        // listener has a bound address. `config.jsonBaseUrl`, when set, wins
        // (explicit deployment topology, e.g. behind a reverse proxy); otherwise
        // default to this process's own listener address. The previous code
        // mounted the shell in createApp with no base URL at all, so the
        // mounted shell always fell back to offline catalog fetchers (CX3
        // W43-R13 shell-mount HIGH). The shell handle is already returned on
        // the App object for tests that need the resolved URL.
        if (adminShell && config.adminShellCookieSecret && config.adminToken) {
          // PM-M02-ROUTE (item 8): the BFF/Portal JSON base must be the
          // INTERNAL listener's actually bound address, never the public socket.
          // Loopback is the local client destination when the bind is a wildcard,
          // and a port-0 fixture resolves to whatever the OS assigned.
          const addr = internalServer.address();
          const base = config.jsonBaseUrl
            ?? (addr && typeof addr === 'object'
              ? `http://127.0.0.1:${addr.port}`
              : undefined);
          if (base) {
            await adminShell.handle.close().catch(() => undefined);
            const remounted = await attachAdminShell({
              config: { ...config, jsonBaseUrl: base },
              profileSelfService,
              ...(serviceRuntime ? { trackHttpRequest: serviceRuntime.trackHttpRequest } : {}),
            });
            (adminShell as { handle: unknown; url: string }).handle = remounted?.handle;
            if (remounted) (adminShell as { url: string }).url = remounted.url;
          }
        }
      } catch (startupError) {
        // Roll back every listener that got open, then rethrow the ORIGINAL
        // error (never a cleanup error). Guards are `listening` so the
        // never-listened and partially-listened cases are covered too.
        for (const candidate of [server, internalServer]) {
          try {
            (candidate as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            if (candidate.listening) {
              await new Promise<void>((resolve) => candidate.close(() => resolve()));
            }
          } catch {
            // Best effort: the initiating error below is what matters.
          }
        }
        await adminShell?.handle.close().catch(() => undefined);
        await serviceRuntime?.close().catch(() => undefined);
        await localAdminBoot?.close().catch(() => undefined);
        throw startupError;
      }
      retentionCleanupScheduler?.start();
      restoreEffectRuntimeState.retentionScheduler = Boolean(retentionCleanupScheduler);
      if (autonomousWorkEnabled) {
        dispatcher.start();
        restoreEffectRuntimeState.dispatcher = true;
      }
      // W-DATA03-CONSUMER-JOIN-1: same cadence rule as the dispatcher; the
      // handle exists (for manual runOnce driving) even when no timer is set.
      if (ingestionConsumer && autonomousWorkEnabled && config.ingestionConsumer?.intervalMs !== 0) {
        ingestionConsumer.start();
        restoreEffectRuntimeState.ingestionConsumer = true;
      }
      // P2-09: background expired-lease sweep runs at production cadence so
      // crashed workers are recovered without relying on inbound deliveries.
      // Tests that drive sweepExpiredLeases() directly set this to 0.
      if (recoveryIntervalMs > 0) {
        recoveryTimer = setInterval(() => {
          // Settle cancelled paused/expired tasks before generic lease recovery
          // can requeue them or report LEASE_EXPIRED instead of cancellation.
          void (async () => {
            await lifecycle.sweepCancellations?.();
            await runtime.sweepExpiredLeases();
          })().catch(() => undefined);
          // MM-05 (docs/38 §4): the queue-integrity sweep rides the same
          // production-cadence hook; autoDispatch off => neither runs.
          runQueueIntegritySweep().catch(() => undefined);
          // DATA-02: expired multipart sessions (both branches) are swept to
          // ABORTED with their storage cleanup, single-flight per tick.
          runMultipartSweep().catch(() => undefined);
          // WFA-02: retry exact-version cleanup for newly uploaded workflow
          // inputs that failed admission before linking to an operation.
          runPublicArtifactCleanup().catch(() => undefined);
        }, recoveryIntervalMs);
        recoveryTimer.unref?.();
        restoreEffectRuntimeState.recoverySweep = true;
      }
      // Offline/crashed or RUNNING-task-protected inventory becomes eligible
      // after 24h, then is pruned in bounded batches. The scheduler follows
      // the same read-only/auto-dispatch boot gate as other autonomous work.
      workerInstanceRetentionScheduler.start();
      // P2-08: background webhook dispatcher. Delivery failures retry with
      // backoff and never affect the (already terminal) operation.
      if (webhookIntervalMs > 0 && config.webhookSecret) {
        const secret = config.webhookSecret;
        webhookTimer = setInterval(() => {
          // Single-flight: a sweep still running when the next tick fires means the
          // previous dispatch is inside its drain/bailout paths — skip, don't stack.
          if (activeWebhookSweep) return;
          const sweep = deliverWebhooks(db, {
            secret,
            signal: webhookShutdown.signal,
            shutdownGraceMs: webhookDrainTimeoutMs,
            allowPrivateNetworks: config.webhookAllowPrivateNetworks === true,
            // W-ENC-08-WEBHOOK (Delta 110): the SAME delivery service the
            // public result/download routes use, so one tenant policy governs
            // all three surfaces. `?? undefined` so a platform with no
            // crypto-config surface leaves every webhook exactly as it was.
            deliveryEncryption: deliveryEncryption ?? undefined,
            // CB-03 (B4): authenticated callback delivery. Absent resolver =
            // credential-bearing pins fail closed (WEBHOOK_AUTH_UNAVAILABLE);
            // legacy rows without a pinned policy keep the P2-08 path.
            ...(config.resolveCallbackSecret ? { resolveCallbackSecret: config.resolveCallbackSecret } : {}),
            ...(config.callbackOAuth2Options ? { oauth2Options: config.callbackOAuth2Options } : {}),
          }).catch(() => undefined);
          activeWebhookSweep = sweep;
          void sweep.finally(() => {
            if (activeWebhookSweep === sweep) activeWebhookSweep = undefined;
          });
        }, webhookIntervalMs);
        webhookTimer.unref?.();
        restoreEffectRuntimeState.webhookDelivery = true;
      }
      // First-party owner inbox delivery is a bounded durable DB worker. It
      // shares the autonomous-work boot gate and is always off in a restored
      // read-only rehearsal.
      if (autonomousWorkEnabled) {
        void runCostAlertBatch();
        costAlertTimer = setInterval(() => { void runCostAlertBatch(); }, 5_000);
        costAlertTimer.unref?.();
        restoreEffectRuntimeState.alertEmission = true;
      }
      return server;
    },
    async close(options?: { timeoutMs?: number; pollIntervalMs?: number }) {
      if (recoveryTimer) clearInterval(recoveryTimer);
      if (webhookTimer) clearInterval(webhookTimer);
      if (costAlertTimer) clearInterval(costAlertTimer);
      restoreEffectRuntimeState.recoverySweep = false;
      restoreEffectRuntimeState.webhookDelivery = false;
      restoreEffectRuntimeState.alertEmission = false;
      await workerInstanceRetentionScheduler.stop().catch(() => undefined);
      await retentionCleanupScheduler?.stop().catch(() => undefined);
      restoreEffectRuntimeState.retentionScheduler = false;
      restoreEffectRuntimeState.maintenanceRunner = false;
      dispatcher.stop();
      ingestionConsumer?.stop();
      restoreEffectRuntimeState.dispatcher = false;
      restoreEffectRuntimeState.ingestionConsumer = false;
      // PR-Q3-10 (P8-04): webhook graceful drain BEFORE anything that owns the pool.
      // Signal first (no new claims), then wait for the in-flight sweep — its own
      // shutdownGraceMs already bounds dispatch waits and releases stragglers to
      // PENDING; the extra second here is only slack for that release's final tx.
      webhookShutdown.abort();
      const inflight = activeWebhookSweep;
      if (inflight) {
        await Promise.race([
          inflight,
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, webhookDrainTimeoutMs + 1_000);
            t.unref?.();
          }),
        ]).catch(() => undefined);
      }
      await activeCostAlertSweep?.catch(() => undefined);
      // P6-01: stop the Admin shell listener (if mounted) alongside the platform.
      await adminShell?.handle.close().catch(() => undefined);

      // P2-09 OPS-07: Graceful shutdown drain — stops accepting new claims and
      // waits up to timeoutMs for RUNNING leases to complete before force-closing.
      const drainTimeout = options?.timeoutMs ?? config.shutdownTimeoutMs ?? 30000;
      const pollInterval = options?.pollIntervalMs ?? config.shutdownPollIntervalMs ?? 500;
      await runtime.drain(drainTimeout, pollInterval).catch(() => undefined);

      // Drop idle keep-alive sockets so close() resolves promptly in tests.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      }
      // PM-M02-ROUTE: close the internal listener exactly once too, including
      // the never-listened and partially-listened cases (listening is false, so
      // no close() call is made and no socket is left open).
      (internalServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      if (internalServer.listening) {
        await new Promise<void>((resolve, reject) => internalServer.close((e) => (e ? reject(e) : resolve())));
      }
      await serviceRuntime?.close().catch(() => undefined);
      for (const q of queues.values()) await q.close().catch(() => undefined);
      redis.disconnect();
      s3Client?.destroy();
      for (const generationClient of generationS3Clients.values()) generationClient.destroy();
      for (const sourceClient of sourceClients.values()) sourceClient.destroy();
      await localAdminBoot?.close().catch(() => undefined);
      await db.close();
    },
  };
  } catch (bootError) {
    return cleanupFailedBoot(bootError);
  }
}

/**
 * Scheduling wrapper for multipart.sweepExpiredSessions (DATA-02 sweeper
 * wiring). Single-flight like the webhook loop: a sweep still running when
 * the recovery tick fires is SKIPPED, not stacked. enabled=false (a
 * deployment without a multipart-capable backend) never calls the service -
 * there can be no sessions to reclaim. Storage failures are swallowed here
 * on purpose: the next tick retries, and a sweep must never poison the
 * lease-recovery it rides.
 */
export function createMultipartSweepHook(
  multipart: Pick<MultipartService, 'sweepExpiredSessions'>,
  enabled: boolean,
): () => Promise<MultipartSweepSummary | undefined> {
  let active: Promise<MultipartSweepSummary | undefined> | undefined;
  return () => {
    if (!enabled) return Promise.resolve(undefined);
    if (active) return active;
    const sweep: Promise<MultipartSweepSummary | undefined> =
      multipart.sweepExpiredSessions().catch(() => undefined);
    active = sweep;
    void sweep.finally(() => {
      if (active === sweep) active = undefined;
    });
    return sweep;
  };
}

/** Single-flight retry hook for durable public-artifact compensation intents. */
export function createPublicArtifactCleanupHook(
  artifacts: Pick<ArtifactService, 'sweepPublicArtifactCleanup'>,
): () => Promise<{ scanned: number; deleted: number; deferred: number } | undefined> {
  let active: Promise<{ scanned: number; deleted: number; deferred: number } | undefined> | undefined;
  return () => {
    if (active) return active;
    const sweep: Promise<{ scanned: number; deleted: number; deferred: number } | undefined> =
      artifacts.sweepPublicArtifactCleanup().catch(() => undefined);
    active = sweep;
    void sweep.finally(() => {
      if (active === sweep) active = undefined;
    });
    return sweep;
  };
}
