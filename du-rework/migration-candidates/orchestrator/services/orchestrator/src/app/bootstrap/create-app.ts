/**
 * CONV-03: the orchestrator composition root, moved verbatim out of
 * server.ts — one startup/shutdown owner. The route table is an injected
 * dependency (`AppDeps.route`), so this module never imports server.ts at
 * value level and the boot path stays cycle-free.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
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
import { validateWorkerIdentityConfig } from '../../modules/runtime/worker-identity';
import { createUsageService } from '../../modules/usage/usage';
import { createArtifactService, type ArtifactService } from '../../modules/artifacts/artifacts';
import {
  createMultipartService,
  type MultipartService,
  type MultipartSweepSummary,
} from '../../modules/artifacts/multipart-service';
import { createS3ArtifactStorageFacade } from '../../modules/artifacts/s3-storage-facade';
import { CryptoStorageFacade } from '../../modules/encryption/crypto-storage-facade';
import { adaptKeyProviderForMetadata } from '../../modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from '../../modules/runtime/metadata-crypto';
import { buildMetadataReadPolicy, METADATA_READ_MODE_ENV } from '../../modules/encryption/boot-options';
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
import { createConnectorRevisionHttpAdapter } from '../../modules/connector-credentials/connector-http-store';
import {
  composeCredentialWorkflow,
  credentialWorkflowEnvRequested,
  CredentialWorkflowBootError,
} from '../../modules/connector-credentials/compose';
import { createProfileService, type ProfileService } from '../../modules/profiles/profiles';
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
import { createS3PinnedSourceStorage } from '../../modules/operations/ingestion-storage-s3';
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
 * unknown-id rejection is unit-testable without a boot. Present id -> its
 * configured URL; absent/unknown id -> 404 NOT_FOUND, NEVER a silent empty.
 */
export function connectorBaseUrlResolver(
  baseUrls: Record<string, string>,
): (connectorId?: string) => string {
  return (connectorId?: string) => {
    if (connectorId === undefined) {
      const first = Object.values(baseUrls)[0];
      if (first === undefined) {
        throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'no connector base URL configured');
      }
      return first;
    }
    const base = baseUrls[connectorId];
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
    async head(storageKey: string): Promise<StoredObjectMetadata | null> {
      try {
        const head = (await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }))) as {
          Metadata?: Record<string, string>;
        };
        return head.Metadata ?? {};
      } catch (error) {
        if (isNotFoundStorageError(error)) return null;
        throw error;
      }
    },
    async read(storageKey: string): Promise<Buffer> {
      const output = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }))) as {
        Body?: unknown;
      };
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
      };
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

export async function assembleApp(config: ServerConfig, deps: AppDeps) {
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
  const db = createDb(config.databaseUrl);
  const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'api' } });
  const storageConfig = config.artifactStorage ?? { backend: 'postgres' as const };

  try {
    // Schema readiness (R08-06 / P2-01). applyMigrations boots with an
    // explicit one-shot migration; otherwise we verify the schema is already
    // migrated and fail closed (read-only) when it is not. Production
    // deployment runs `npm run migrate` before `npm start`; dev/test fixtures
    // may pass autoMigrate:true to keep boot zero-config.
    if (config.autoMigrate === true) {
      await migrate(db);
    } else {
      await verifyMigrations(db);
    }

    // RFX-10: dev-only fallback rows. A production boot (autoMigrate=false,
    // no DU_SEED_DEV_FALLBACK) writes NEITHER row — see shouldSeedDevFallback.
    // Nothing in src/ reads these rows; they only preserved an FK target for
    // legacy/dev fixtures, so a production DB without them makes a stray
    // legacy insert fail with an FK error instead of silently succeeding.
    // Auth stays fail-closed either way: the placeholder hash matches no raw
    // key (resolveApiKey only finds real ACTIVE keys, R08-01).
    if (shouldSeedDevFallback(process.env, { zeroConfigBoot: config.autoMigrate === true })) {
      // Ensure default tenant for the slice (idempotent).
      await db.query(
        `INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default')
         ON CONFLICT (id) DO NOTHING`
      );
      // Dev fallback key row so operations.api_key_id FK always resolves.
      await db.query(
        `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
         VALUES ('00000000-0000-0000-0000-000000000099',
                 '00000000-0000-0000-0000-000000000001',
                 'dev-fallback-placeholder', 'dev-fallback', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`
      );
    }
  } catch (error) {
    // Do not leave the PostgreSQL pool alive if startup fails before createApp
    // can return an App handle to its caller.
    await db.close().catch(() => undefined);
    throw error;
  }

  // Start Redis only after DB readiness. If a DB connection/migration fails,
  // there is no Redis reconnect timer/socket left behind in a failed boot.
  const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const s3Client = storageConfig.backend === 's3'
    ? new S3Client({
        region: storageConfig.region,
        endpoint: storageConfig.endpoint,
        forcePathStyle: storageConfig.forcePathStyle ?? Boolean(storageConfig.endpoint),
      })
    : undefined;

  const registry = createRegistryService(db);
  const profiles: ProfileService = createProfileService(db);
  // W48-C1: admin audit ledger — every admin mutation below appends one
  // immutable row via ctx.audit; GET /api/v1/admin/audit reads via
  // audit.listForTenant (ledger table: migration 0010 admin_audit_events).
  const audit: AuditService = createAuditService(db);
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
  // consumer). Sealing stays opt-in per deployment — with no
  // `metadataEncryption` config this is undefined and every column keeps its
  // historical plaintext shape — but when it IS configured, one seam (not one
  // per module) is what makes the three writers agree on key policy and AAD
  // binding.
  const metadataCrypto = config.metadataEncryption
    ? createMetadataCrypto(
        adaptKeyProviderForMetadata(config.metadataEncryption.keyProvider),
        config.metadataEncryption.keyRef,
      )
    : undefined;
  const submission = createSubmissionService(db, registry, profiles, {
    maxBlobBytes: config.maxBlobBytes,
    // W-INGEST-PG-FAILCLOSED-1: one source of truth for the backend the
    // ingestion gate can actually materialize into; a postgres deployment
    // rejects URL submissions at admission (T180-D3).
    storageBackend: storageConfig.backend,
    s3SourceRules: config.s3SourceRules,
    // P745-PRODUCER (step 1): pin non-secret prompt-revision markers at
    // admission so the claim never re-reads the live overrides table.
    promptOverrides: createPromptOverrideService(db),
    // CRX-01: seal operations.input_ref / tasks.payload_ref before the submit
    // transaction opens, with the same seam the runtime and the gate use.
    ...(metadataCrypto ? { metadataCrypto } : {}),
  });
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
  );
  const usage = createUsageService(db);
  // One facade instance serves both upload branches: the single-PUT grants
  // and the multipart lifecycle must pin and verify the same generations.
  const s3StorageFacade = s3Client && storageConfig.backend === 's3'
    ? createS3ArtifactStorageFacade({ bucket: storageConfig.bucket, client: s3Client })
    : undefined;
  const artifacts: ArtifactService = createArtifactService(db, {
    storageBackend: storageConfig.backend,
    migrationWindow: storageConfig.backend === 's3' && storageConfig.migrationWindow,
    maxArtifactBytes: config.maxBlobBytes,
    ...(s3StorageFacade ? { storageFacade: s3StorageFacade } : {}),
  });
  const multipart: MultipartService = createMultipartService(db, {
    storage: s3StorageFacade,
    ...config.multipartLimits,
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
  // `migrationWindow` exists only on the s3 variant of the storage config, so
  // narrow on the same discriminant the deps construction below uses.
  const artifactMigrationWindowOpen =
    storageConfig.backend === 's3' && storageConfig.migrationWindow === true;
  const artifactEncryptionRequired = encryptedWritesRequired && !artifactMigrationWindowOpen;
  // Absent when the deployment is not on S3 or has no public-upload encryption
  // configured, in which case every stored object is plaintext.
  const s3CryptoStorageFacade: CryptoStorageFacade | null =
    s3Client && storageConfig.backend === 's3' && config.publicUploadEncryption
      ? new CryptoStorageFacade(config.publicUploadEncryption.keyProvider)
      : null;
  const artifactDecryptDeps: ArtifactDecryptDeps | null =
    s3Client && storageConfig.backend === 's3' && s3CryptoStorageFacade
      ? {
          reader: s3StoredObjectReader(s3Client, storageConfig.bucket),
          facade: s3CryptoStorageFacade,
          encryptionRequired: artifactEncryptionRequired,
        }
      : null;

  const publicUploadGateway: PublicUploadGateway | null =
    s3Client && storageConfig.backend === 's3' && config.publicUploadEncryption
      ? createPublicUploadGateway({
          db,
          client: s3Client,
          bucket: storageConfig.bucket,
          cryptoStorage: new CryptoStorageFacade(config.publicUploadEncryption.keyProvider),
          keyRef: config.publicUploadEncryption.keyRef,
          keyVersion: config.publicUploadEncryption.keyVersion,
          maxBytes: config.publicUploadEncryption.maxBytes,
        })
      : null;
  // W-DATA02-PUB-1: the multipart TTL sweep rides the recovery timer, exactly
  // like the MM-05 queue-integrity sweep. A PostgreSQL-only deployment has no
  // multipart sessions at all (the lifecycle answers 409 and creates no
  // rows), so the hook is disabled there rather than querying every tick.
  const runMultipartSweep = createMultipartSweepHook(multipart, Boolean(s3StorageFacade));
  const connectorId = config.connectorId ?? 'default-connector';
  const connectorRevision = config.connectorRevision ?? 1;
  const grants: GrantService | null = config.invocationGrantSecret
    ? createGrantService(db, registry, {
        connectorId,
        connectorRevision,
        secret: Buffer.from(config.invocationGrantSecret, 'utf8'),
      })
    : null;
  const lifecycle = createLifecycleService(db, metadataCrypto, metadataReader);
  // P2-07/CON-03: Connector management proxy registry (platform config only).
  const connectorBaseUrls = config.connectorBaseUrls ?? {};
  // PLAT-MIG-01: ONE resolver for every connector-scoped lookup. An
  // unconfigured id fails CLOSED (404), it never falls through to a default
  // or an empty result list (DESIGN-803, Muc 1: the base URL is platform
  // config, never caller input — no open proxy, no silent empty).
  const connectorBaseUrl = connectorBaseUrlResolver(connectorBaseUrls);
  const connectors: ConnectorProxy = createConnectorProxy({ baseUrlFor: connectorBaseUrl });
  // CONNECTOR-WIRE-A: compose the management proxy from platform config. Only
  // configured deployments get the surface — every other deployment reports
  // management:false and fails closed (503) rather than half-proxying. The
  // service-level (list) base is the first configured URL; a named connector
  // still resolves strictly by its own entry (unknown id → 404, no open proxy).
  const connectorManagementBaseUrls = Object.values(connectorBaseUrls);
  const connectorManagement =
    connectorManagementBaseUrls.length > 0 && config.connectorManagementAuthorizationForRequest
      ? createConnectorManagementStore({
          baseUrlFor: (connectorId?: string) => {
            if (connectorId === undefined) return connectorManagementBaseUrls[0]!;
            const base = connectorBaseUrls[connectorId];
            if (!base) throw new HttpError(404, 'NOT_FOUND', `connector ${connectorId} not configured`);
            return base;
          },
          authorizationForRequest: config.connectorManagementAuthorizationForRequest,
        })
      : undefined;
  // CREDWORKFLOW-IMPL (D3): compose the production credential workflow when
  // the operator requested it via env; an explicit `config.credentialWorkflow`
  // injection still wins. Partial env refuses boot (typed) inside compose —
  // a half-configured deployment must not boot into silent 503s.
  let credentialWorkflow = config.credentialWorkflow;
  if (!credentialWorkflow && credentialWorkflowEnvRequested(process.env)) {
    if (connectorManagementBaseUrls.length === 0) {
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
        baseUrl: connectorManagementBaseUrls[0]!,
        authorizationForRequest: config.connectorManagementAuthorizationForRequest,
      }),
    });
  }

  const queues = new Map<string, Queue>();
  function getQueue(name: string): Queue {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: redis as never });
      queues.set(name, q);
    }
    return q;
  }

  const dispatcher = createDispatcher({ db, getQueue });  // P2-09 background expired-lease recovery sweep. Default ON with auto-dispatch

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
  const acquireS3FileForTenant = createS3SourceAcquisition(config.s3SourceRules ?? [], rule => {
    let client = sourceClients.get(rule.region);
    if (!client) { client = new S3Client({ region: rule.region }); sourceClients.set(rule.region, client); }
    return client;
  });
  const ingestionConsumer =
    s3Client && storageConfig.backend === 's3'
      ? createIngestionConsumer({
          db,
          storage: createS3PinnedSourceStorage({
            bucket: storageConfig.bucket,
            send: (command) =>
              s3Client.send(command as never) as Promise<{ VersionId?: string; ChecksumSHA256?: string }>,
            db,
          }),
          storageBackend: 's3',
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
  const defaultRecoveryInterval = config.autoDispatch !== false ? 5_000 : 0;
  const recoveryIntervalMs = config.leaseRecoveryIntervalMs ?? defaultRecoveryInterval;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  // P2-08: webhook dispatcher runs at production cadence only when a signing
  // secret is configured; scheduling (durable rows) happens regardless.
  const defaultWebhookInterval =
    config.autoDispatch !== false && config.webhookSecret ? 5_000 : 0;
  const webhookIntervalMs = config.webhookDispatchIntervalMs ?? defaultWebhookInterval;
  let webhookTimer: ReturnType<typeof setInterval> | undefined;
  // PR-Q3-10 (P8-04): graceful-shutdown plumbing for the webhook loop. The abort
  // controller feeds deliverWebhooks' shutdown gate (no NEW claims, bounded drain of
  // in-flight deliveries, over-grace claims released back to PENDING by cycle 97).
  const webhookShutdown = new AbortController();
  const webhookDrainTimeoutMs = config.webhookDrainTimeoutMs ?? 5_000;
  let activeWebhookSweep: Promise<number | undefined> | undefined;

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
  const adminShell = await attachAdminShell({ config });

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
    // FIX-CR-11: bounded ingress. The blob PUT is the only binary route —
    // every other route takes JSON. Body read errors (abort, oversize,
    // truncated stream) resolve INSIDE this try so the route error handler
    // converts them to a controlled problem response (never an unhandled
    // rejection in the listener).
    const isBlobPut =
      method === 'PUT' && /^\/api\/runtime\/v1\/artifacts\/blob\/[^/]+$/.test(url.pathname);
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
      ingress = isPublicUploadStream || isLegacyCompat
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
        ...(isPublicUploadStream || isLegacyCompat ? { bodyStream: req } : {}),
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
      if ((isPublicUploadStream || isLegacyCompat) && !req.destroyed && !req.complete) {
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
    dispatcher,
    // W-DATA03-CONSUMER-JOIN-1 test seam: undefined unless the s3 backend
    // is wired; runOnce() then drives the whole claim->pin->gate leg.
    ingestionConsumer,
    // CONNECTOR-WIRE-A test seam: the composed management proxy (undefined
    // on deployments without connectorBaseUrls).
    connectorManagement,
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
        throw startupError;
      }
      if (config.autoDispatch !== false) dispatcher.start();
      // W-DATA03-CONSUMER-JOIN-1: same cadence rule as the dispatcher; the
      // handle exists (for manual runOnce driving) even when no timer is set.
      if (ingestionConsumer && config.autoDispatch !== false && config.ingestionConsumer?.intervalMs !== 0) {
        ingestionConsumer.start();
      }
      // P2-09: background expired-lease sweep runs at production cadence so
      // crashed workers are recovered without relying on inbound deliveries.
      // Tests that drive sweepExpiredLeases() directly set this to 0.
      if (recoveryIntervalMs > 0) {
        recoveryTimer = setInterval(() => {
          runtime.sweepExpiredLeases().catch(() => undefined);
          // MM-05 (docs/38 §4): the queue-integrity sweep rides the same
          // production-cadence hook; autoDispatch off => neither runs.
          runQueueIntegritySweep().catch(() => undefined);
          // DATA-02: expired multipart sessions (both branches) are swept to
          // ABORTED with their storage cleanup, single-flight per tick.
          runMultipartSweep().catch(() => undefined);
        }, recoveryIntervalMs);
        recoveryTimer.unref?.();
      }
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
          }).catch(() => undefined);
          activeWebhookSweep = sweep;
          void sweep.finally(() => {
            if (activeWebhookSweep === sweep) activeWebhookSweep = undefined;
          });
        }, webhookIntervalMs);
        webhookTimer.unref?.();
      }
      return server;
    },
    async close(options?: { timeoutMs?: number; pollIntervalMs?: number }) {
      if (recoveryTimer) clearInterval(recoveryTimer);
      if (webhookTimer) clearInterval(webhookTimer);
      dispatcher.stop();
      ingestionConsumer?.stop();
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
      for (const q of queues.values()) await q.close().catch(() => undefined);
      redis.disconnect();
      s3Client?.destroy();
      for (const sourceClient of sourceClients.values()) sourceClient.destroy();
      await db.close();
    },
  };
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
