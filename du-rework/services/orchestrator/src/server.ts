import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  decryptStoredArtifact,
  type ArtifactDecryptDeps,
  type StoredObjectReader,
  type StoredObjectMetadata,
} from './modules/encryption/artifact-read-decrypt';
import { errorClassOf, safeInternalErrorProblem, zodIssuesToProblem } from './http/errors';
import { Db, createDb } from './db/db';
import { migrate, verifyMigrations } from './db/migrations';
import { createRegistryService, enableVersionForTest } from './modules/registry/registry';
import { createSubmissionService, loadOperationView } from './modules/operations/submission';
import {
  createRuntimeService,
  type QueueIntegrityHealth,
} from './modules/runtime/runtime';
import {
  authorizeWorkerBusiness,
  authorizeWorkerClaim,
  isAuthorizedPlatformRuntimeBearer,
  isAuthorizedRuntimeBearer,
  resolveWorkerBusinessIdentity,
  validateWorkerIdentityConfig,
} from './modules/runtime/worker-identity';
import { createUsageService } from './modules/usage/usage';
import { createArtifactService, type ArtifactService } from './modules/artifacts/artifacts';
import {
  createMultipartService,
  publicUploadToken,
  type MultipartService,
  type MultipartSweepSummary,
} from './modules/artifacts/multipart-service';
import { createS3ArtifactStorageFacade } from './modules/artifacts/s3-storage-facade';
import { CryptoStorageFacade } from './modules/encryption/crypto-storage-facade';
import { adaptKeyProviderForMetadata } from './modules/encryption/metadata-key-adapter';
import { createMetadataCrypto } from './modules/runtime/metadata-crypto';
import type { KeyProvider } from './modules/encryption/vault-transit-provider';
import { createGrantService, type GrantService } from './modules/grants/grants';
import { createLifecycleService } from './modules/lifecycle/lifecycle';
import { createConnectorProxy, type ConnectorProxy } from './modules/connectors/connectors';
import { createProfileService, type ProfileService } from './modules/profiles/profiles';
import { auditedMutation, createAuditService, listAuthorizedAuditEvents, type AuditService } from './modules/audit/audit';
import { canonicalPayloadHash, executeIdempotent, readIdempotencyKey } from './modules/idempotency/idempotency';
import type { CredentialWorkflow } from './modules/connector-credentials/workflow';
import {
  adminActionsMethodGuard,
  authorizeAuditTenantRead,
  authorizeBindingTenant,
  requireResourceTenant,
  resolveAdminActionAuth,
  resolveAdminActionAuthAsync,
  resolveAdminAuditPrincipal,
  resolveAdminPrincipal,
  type AdminPrincipal,
  type AdminSessionStore,
} from './modules/admin-actions/rbac';
import { dispatchAdminAction } from './modules/admin-actions/dispatcher';
import { attachAdminShell } from './app/admin';
import { registerCryptoConfigWiring } from './app/admin/shell-router';
import type { CryptoConfigPane } from './app/admin/crypto-config-view-models';
import type { OidcFlow } from './app/admin/oidc-flow';
import { readBoundedBody, type IngressBody } from './http/ingress';
import { handleLegacyRoute } from './compat/legacy-http-mount';
import { legacyCompatHost } from './compat/legacy-host-adapter';
import { createDispatcher } from './modules/queue/dispatcher';
import { createIngestionConsumer } from './modules/operations/ingestion-consumer';
import { createS3PinnedSourceStorage } from './modules/operations/ingestion-storage-s3';
import { deliverWebhooks } from './modules/webhooks/webhooks';
import { HttpError, isHttpError } from './http/errors';
import { createLogger } from '@du/observability';
import {
  ClaimTaskRequestSchema,
  UsageEventDrilldownQuerySchema,
  WorkspaceReferenceQuerySchema,
  // W-CONTRACT-ALIGN-1 (T70-C1): the operations-list contract lives in
  // @du/contracts and the route reads it from there, so the schema and this
  // producer cannot drift apart silently again.
  OPERATIONS_LIST_LIMIT_DEFAULT,
  OPERATIONS_LIST_LIMIT_MAX,
  OPERATIONS_LIST_QUERY_PARAMS,
  OPERATIONS_STATE_FILTER_WIRE_STATES,
  OPERATIONS_STATE_FILTER_VALUES,
  LIST_CURSOR_MAX_LEN,
  MULTIPART_MIN_TOTAL_BYTES,
  isOperationsListFilterToken,
  operationsListPage,
  // W-ADMUX02-SORT-ALLOWLIST-1: the sort allow-list is contract data too, so
  // the route reads it from @du/contracts exactly like the parameter names.
  OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
  OPERATIONS_LIST_SORT_DEFAULT_FIELD,
  OPERATIONS_LIST_SORT_VALUES,
  formatOperationsListSort,
  parseOperationsListSort,
  type OperationsListPage,
  type OperationsListQueryParam,
  type OperationsListSort,
  type OperationsListSortDirection,
  type OperationsListSortField,
  type OperationsStateFilter,
  // W-ADMUX02-EXT-1: audit + api-key list pages share this contract.
  ADMIN_AUDIT_LIST_QUERY_PARAMS,
  ADMIN_AUDIT_LIST_SORT_DEFAULT,
  ADMIN_AUDIT_LIST_SORT_VALUES,
  ADMIN_BUSINESS_LIST_QUERY_PARAMS,
  ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS,
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  ADMIN_RESOURCE_LIST_SORT_DEFAULT,
  ADMIN_RESOURCE_LIST_SORT_VALUES,
  API_KEY_LIST_QUERY_PARAMS,
  API_KEY_STATUS_VALUES,
  AUDIT_SEVERITY_VALUES,
  encodeListCursor,
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
  isAdminListTimeBound,
  listPage,
  type AdminAuditListQueryParam,
  type AdminAuditListSort,
  type AdminBusinessListQueryParam,
  type AdminBusinessVersionListQueryParam,
  type AdminResourceListSort,
  type AdminResourceListSortCursor,
  type ApiKeyListQueryParam,
  type ListCursor,
} from '@du/contracts';
import { toOperationView, waitForTerminal, resultHttpStatus } from './modules/operations/facade';
import {
  createDeliveryEncryptionService,
  DeliveryEncryptionError,
  createPublicUploadGateway,
  type DeliveryEncryptionConfig,
  type DeliveryEncryptionService,
  type PublicUploadGateway,
} from './modules/public-api';
import {
  applyCryptoConfig,
  readCryptoConfig,
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigStore,
} from './app/admin/crypto-config-api';
import { PostgresCryptoConfigStore } from './app/admin/crypto-config-store';
import {
  EMPTY_CRYPTO_CONFIG,
  type CryptoConfigState,
} from './app/admin/crypto-config-view-models';
import { parseCookieHeader, verifyCookie } from './app/admin/shell-auth';
import type { RecipientKeyRegistry } from './modules/encryption/recipient-key-registry';

const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

async function readStreamBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > maxBytes) {
        throw new HttpError(413, 'TOO_LARGE', 'artifact exceeds the encrypted delivery size limit');
      }
      chunks.push(buf);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return Buffer.concat(chunks);
}

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
    async readManifest(manifestKey: string): Promise<unknown> {
      const output = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey }))) as {
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


export interface ServerConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Platform runtime bearer. It authorizes runtime routes but does not by itself identify a business for task claims. */
  runtimeToken?: string;
  /** Business-scoped worker bearer tokens: businessId → token. The token sent
   *  by a worker SDK is the authenticated identity used for task claims. */
  workerIdentityTokensByBusiness?: Record<string, string>;
  /** Dedicated admin bearer token. Missing → admin endpoints closed (fail-closed). */
  adminToken?: string;
  /** OIDC-02/03: opaque admin session store (modules/auth/session-store).
   *  When wired, the dispatcher cookie path prefers a server-side
   *  du_session id over the legacy self-contained cookie; identity comes
   *  from the store, never from browser-asserted headers. */
  adminSessionStore?: AdminSessionStore;
  /** OIDC-04: IdP login/callback/logout flow mounted on the admin shell
   *  (app/admin/oidc-flow). When set, /admin/login redirects to the IdP
   *  and the self-contained password path is intercepted there. */
  adminOidcFlow?: OidcFlow;
  /** R3-02 tenant-scoped admin bearer: token → tenantId it authorizes.
   *  Holders may read ONLY their own tenant's audit ledger
   *  (GET /api/v1/admin/audit); every other admin route stays platform-only
   *  (assertAdminAuth never accepts these tokens). Unset → audit reads
   *  require the platform bearer, exactly as before. */
  tenantAdminTokens?: Record<string, string>;
  /** Dedicated Connector usage identity. Missing token disables ingestion. */
  usageToken?: string;
  /** Secret used to sign Connector invocation grants (HS256). Fail-closed. */
  invocationGrantSecret?: string;
  /** Connector identity the platform is authorized to issue grants for. */
  connectorId?: string;
  connectorRevision?: number;
  /** Connector health-probe registry: connectorId → platform-configured base URL (P2-07/CON-03).
   *  Missing entry → the /connectors/:id/test probe fails closed with 404.
   *  The base URL is platform configuration, never caller input (no open proxy). */
  connectorBaseUrls?: Record<string, string>;
  /** Auto-dispatch outbox on submit + background sweeper. Default true; tests drive dispatchOnce() manually. */
  autoDispatch?: boolean;
  /** Apply pending migrations on boot. Default false — production callers
   *  run `npm run migrate` first, and boot fails closed (verify-only, no
   *  hidden write) if the schema is missing. Development/tests that rely on
   *  zero-config boot pass `autoMigrate: true`. */
  autoMigrate?: boolean;
  /** Background expired-lease recovery sweep interval (P2-09). Default 5000ms
   *  when autoDispatch is on; set to 0 to disable the periodic hook (tests
   *  drive sweepExpiredLeases() explicitly). The MM-05 queue-integrity sweep
   *  rides the same hook (§4). */
  leaseRecoveryIntervalMs?: number;
  /** MM-05 (docs/38 §4): grace ms between outbox.dispatched_at and orphan
   *  eligibility. Must exceed dispatch poll + claim RTT. Default 30_000. */
  queueIntegrityGraceMs?: number;
  /** MM-05: candidate cap per sweep (bounds Redis getJob calls). Default 50. */
  queueIntegrityBatch?: number;
  /** MM-05 decision D1 escalation cap: stop re-arming at outbox.attempts
   *  reached; sweep reports stalled and health becomes SUSPECT. Default 10. */
  queueIntegrityMaxAttempts?: number;
  /** VAULT-03: Admin credential rotate/describe workflow (Vault writer +
   *  revision store ports wired by composition/deploy). Absent → the
   *  /admin/connectors/:id/credentials routes fail CLOSED (503). */
  credentialWorkflow?: CredentialWorkflow;
  /** Tenant/system webhook signing secret (P2-08). Missing → webhook
   *  dispatcher disabled (scheduling still writes durable rows). */
  webhookSecret?: string;
  /** Background webhook dispatcher interval (P2-08). Default 5000ms when
   *  autoDispatch is on AND webhookSecret is set; 0 disables the timer. */
  webhookDispatchIntervalMs?: number;
  /**
   * Local-test-mesh opt-in forwarded to deliverWebhooks (identical narrow semantics to
   * the connector transport flag: loopback/RFC1918/ULA only — metadata/CGNAT/multicast
   * stay denied). NEVER set in production; default false keeps FIX-CR-01 in force.
   */
  webhookAllowPrivateNetworks?: boolean;
  /**
   * PR-Q3-10 (P8-04): how long app.close() waits for IN-FLIGHT webhook deliveries
   * to finish before their claims are released back to PENDING. Bounds the drain;
   * the released rows are re-picked by the next dispatcher instance (at-least-once).
   * Default 5000ms.
   */
  webhookDrainTimeoutMs?: number;
  /** Shutdown grace period for active leases in ms (P2-09 OPS-07). Default 30,000ms. */
  shutdownTimeoutMs?: number;
  /** Polling interval for active lease drain during shutdown in ms (P2-09 OPS-07). Default 500ms. */
  shutdownPollIntervalMs?: number;
  /** Cookie-signing secret for the rendered Admin shell (P6-01). Missing →
   *  the shell is NOT mounted (fail-closed, same policy as the admin bearer
   *  token). Mounted via OpenClaude's attachAdminShell from src/app/admin. */
  adminShellCookieSecret?: string;
  /** Bind address/port for the standalone Admin shell listener (P6-01).
   *  Defaults to 127.0.0.1 and an OS-assigned port. */
  adminShellHost?: string;
  adminShellPort?: number;
  /** JSON API base URL the mounted Admin shell's section fetchers call
   *  (W46-C2: closes the CX3 W43-R13 shell-mount HIGH). `attachAdminShell`
   *  already accepted `jsonBaseUrl`, but `ServerConfig` exposed no such
   *  field, so `createApp` always passed `undefined` and the mounted shell
   *  fell back to offline catalog fetchers. When set (e.g. to the public
   *  base URL from `listen()`), the shell's default fetchers GET the live
   *  Admin JSON routes with the admin bearer. When unset, the shell keeps
   *  the offline/not-found behavior (fail-closed, same policy as before).
   *  The value is platform configuration, never caller input. */
  jsonBaseUrl?: string;
  /** Bounded-ingress caps in bytes (FIX-CR-11). Defaults: 1 MiB JSON,
   *  64 MiB artifact blob PUT. Tests pass small values to prove the
   *  413 path without allocating production-scale buffers. */
  maxJsonBytes?: number;
  maxBlobBytes?: number;
  /** Defaults to PostgreSQL artifact_blobs; S3 uses the SDK credential provider chain. */
  artifactStorage?:
    | { backend: 'postgres' }
      | {
        backend: 's3';
        bucket: string;
        region?: string;
        endpoint?: string;
        forcePathStyle?: boolean;
        /** New writes use S3 while READY reads prefer S3 then the retained PG backup. */
        migrationWindow?: boolean;
      };
  /** DATA-02 multipart upload policy. Every value may only narrow the wire
   *  bounds exported by @du/contracts; a PostgreSQL-only deployment has no
   *  multipart backend at all and the lifecycle answers 409. */
  multipartLimits?: {
    partSizeBytes?: number;
    maxTotalBytes?: number;
    sessionTtlMs?: number;
    partUrlTtlMs?: number;
  };
  /** W-DATA03-CONSUMER-JOIN-1: tuning for the durable ingestion consumer.
   *  Absent = defaults (5s tick, 64 MiB budget via maxBlobBytes, 8 attempts).
   *  The consumer only exists on the s3 backend; intervalMs 0 means "drive
   *  runOnce() from the composition root, no timer". */
  ingestionConsumer?: {
    intervalMs?: number;
    maxBytes?: number;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    maxRedirects?: number;
    maxAttempts?: number;
    batch?: number;
  };
  /**
   * ENC-07: per-tenant delivery-encryption policy for the public
   * result/download API. Platform configuration, never caller input: a
   * client cannot select plaintext, a key id, or a key version. Unset or an
   * absent tenant means plaintext; a tenant with enabled=true and no usable
   * recipient key FAILS CLOSED (503) instead of falling back to plaintext.
   * The recipient key registry is ENC-06 (modules/encryption).
   */
  deliveryEncryption?: DeliveryEncryptionConfig;
  /**
   * ENC-08: the Admin crypto-configuration surface. `allowedKeyRefs` is the
   * platform allowlist of Vault Transit refs the operator may pick from - a
   * submitted ref outside it is refused (422), not merely hidden.
   * `recipientKeyRegistry` defaults to the ENC-06 registry ENC-07 delivery
   * already uses, so there is ONE key source, not two.
   *
   * When createApp has a database, settings persist in admin_crypto_config.
   * The composition helper retains an in-memory fallback for offline callers
   * without a database. Absent = the /api/v1/admin/crypto-config routes answer 503.
   */
  cryptoConfig?: {
    allowedKeyRefs: readonly string[];
    recipientKeyRegistry?: RecipientKeyRegistry;
  };
  /** Vault-backed app encryption for public S3 uploads; absent means fail closed. */
  publicUploadEncryption?: {
    keyProvider: KeyProvider;
    keyRef: string;
    keyVersion?: number;
    maxBytes?: number;
  };
  /**
   * Delta 61: Vault-backed encryption for CONTROL-PLANE metadata (the slots
   * the runtime already seals: operations.input_ref, tasks.payload_ref,
   * human_waits.response_ref, step_checkpoints.output_ref). Absent means those
   * columns keep their plaintext behaviour, which stays supported.
   *
   * Deliberately a separate block from `publicUploadEncryption` even though both
   * wrap a DEK: different key refs, different columns, different blast radius.
   * One shared flag would mean turning on artifact encryption also silently
   * starts rewriting control-plane rows, which is not a decision to get by
   * accident.
   */
  metadataEncryption?: {
    keyProvider: KeyProvider;
    keyRef: string;
  };
}

export async function createApp(config: ServerConfig) {
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

    // Ensure default tenant for the slice (idempotent). API keys are never
    // seeded here: unknown x-api-key values are rejected fail-closed (R08-01);
    // the dev-fallback row below only preserves the FK target for legacy rows.
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
  const submission = createSubmissionService(db, registry, profiles, {
    maxBlobBytes: config.maxBlobBytes,
    // W-INGEST-PG-FAILCLOSED-1: one source of truth for the backend the
    // ingestion gate can actually materialize into; a postgres deployment
    // rejects URL submissions at admission (T180-D3).
    storageBackend: storageConfig.backend,
  });
  // MM-05: the runtime owns sweepQueueIntegrity; getQueue is a hoisted
  // function declaration below, so a lazy accessor keeps creation order free.
  // Delta 61: build the metadata crypto seam. Optional on purpose: with no
  // metadataEncryption config this is undefined and every control-plane column
  // keeps its pre-delta plaintext behaviour.
  const metadataCrypto = config.metadataEncryption
    ? createMetadataCrypto(
        adaptKeyProviderForMetadata(config.metadataEncryption.keyProvider),
        config.metadataEncryption.keyRef,
      )
    : undefined;
  const runtime = createRuntimeService(
    db,
    { getQueue: (name) => getQueue(name) },
    metadataCrypto,
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
  // CR28-01: the read side of the same encryption the public upload gateway
  // writes. One facade instance is shared with the gateway on purpose: the AAD
  // is rebuilt from the context on decrypt, and two facades with two different
  // key providers would make the two halves disagree about what was sealed.
  // Absent when the deployment is not on S3 or has no public-upload encryption
  // configured, in which case every stored object is plaintext.
  const s3CryptoStorageFacade: CryptoStorageFacade | null =
    s3Client && storageConfig.backend === 's3' && config.publicUploadEncryption
      ? new CryptoStorageFacade(config.publicUploadEncryption.keyProvider)
      : null;
  const artifactDecryptDeps: ArtifactDecryptDeps | null =
    s3Client && storageConfig.backend === 's3' && s3CryptoStorageFacade
      ? { reader: s3StoredObjectReader(s3Client, storageConfig.bucket), facade: s3CryptoStorageFacade }
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
  const lifecycle = createLifecycleService(db);
  // P2-07/CON-03: Connector management proxy registry (platform config only).
  const connectorBaseUrls = config.connectorBaseUrls ?? {};
  const connectors: ConnectorProxy = createConnectorProxy({
    baseUrlFor: (connectorId: string) => {
      const base = connectorBaseUrls[connectorId];
      if (!base) throw new HttpError(404, 'NOT_FOUND', `connector ${connectorId} not configured`);
      return base;
    },
  });

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
          transfer: {
            maxBytes: config.ingestionConsumer?.maxBytes ?? config.maxBlobBytes ?? 64 * 1024 * 1024,
            timeoutMs: config.ingestionConsumer?.timeoutMs,
            idleTimeoutMs: config.ingestionConsumer?.idleTimeoutMs,
            maxRedirects: config.ingestionConsumer?.maxRedirects,
          },
          batch: config.ingestionConsumer?.batch,
          maxAttempts: config.ingestionConsumer?.maxAttempts,
          pollIntervalMs: config.ingestionConsumer?.intervalMs,
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

  const server = createServer(async (req, res) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('content-type', 'application/json');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
      const result = await route({
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
        credentialWorkflow: config.credentialWorkflow,
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
  });

  return {
    db,
    redis,
    server,
    registry,
    profiles,
    submission,
    runtime,
    dispatcher,
    // W-DATA03-CONSUMER-JOIN-1 test seam: undefined unless the s3 backend
    // is wired; runOnce() then drives the whole claim->pin->gate leg.
    ingestionConsumer,
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
      await new Promise<void>((resolve) => server.listen(config.port, resolve));
      // W46-C2: resolve the shell's JSON base URL only now that the platform
      // listener has a bound address. `config.jsonBaseUrl`, when set, wins
      // (explicit deployment topology, e.g. behind a reverse proxy); otherwise
      // default to this process's own listener address. The previous code
      // mounted the shell in createApp with no base URL at all, so the
      // mounted shell always fell back to offline catalog fetchers (CX3
      // W43-R13 shell-mount HIGH). The shell handle is already returned on
      // the App object for tests that need the resolved URL.
      if (adminShell && config.adminShellCookieSecret && config.adminToken) {
        const addr = server.address();
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
      for (const q of queues.values()) await q.close().catch(() => undefined);
      redis.disconnect();
      s3Client?.destroy();
      await db.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof createApp>>;

// CR-12: the blob route resolves the artifact's CURRENT token, the method the
// token was issued for (upload|download), and its expiry — the shared token is
// now method-scoped and time-bounded, so a read grant cannot PUT and an expired
// token 404s instead of serving bytes.
async function resolveArtifactByStorageKey(
  ctx: RouteContext,
  storageKey: string
): Promise<{ id: string; token: string; tenantId: string; mode: string | null; expiresAt: string | null; businessId: string | null; uploadToken: string | null }> {
  const res = await ctx.db.query(
    `SELECT a.id, a.upload_token, a.token, a.tenant_id, a.token_mode, a.token_expires_at, o.business_id
     FROM artifacts a LEFT JOIN operations o ON o.id=a.operation_id
     WHERE a.storage_key=$1`,
    [storageKey]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${storageKey} not found`);
  const row = res.rows[0] as {
    id: string; upload_token: string | null; token: string; tenant_id: string; token_mode: string | null;
    token_expires_at: string | null; business_id: string | null;
  };
  return {
    id: row.id,
    uploadToken: row.upload_token,
    token: row.token,
    tenantId: row.tenant_id,
    mode: row.token_mode,
    expiresAt: row.token_expires_at,
    businessId: row.business_id,
  };
}

/**
 * ENC-08: build the crypto-configuration service options from platform config.
 *
 * Called ONCE per app, not per request, because the store holds state: a per-request
 * store would silently forget every change the moment the next request arrived, which
 * looks exactly like "the Admin save did nothing".
 *
 * A database-backed store persists settings across restarts. The in-memory fallback is
 * retained for callers that build the service without a database. The recipient key
 * registry defaults to the ENC-06 instance ENC-07 delivery already uses, so there is one
 * key source rather than two that can drift.
 */
export function buildCryptoConfigOptions(
  config: ServerConfig,
  audit: CryptoConfigAudit,
  db?: Pick<Db, 'query'>,
): CryptoConfigServiceOptions | null {
  if (!config.cryptoConfig) return null;
  let store: CryptoConfigStore;
  if (db) {
    store = new PostgresCryptoConfigStore(db, config.cryptoConfig.allowedKeyRefs);
  } else {
    const rows = new Map<string, CryptoConfigState>();
    store = {
      async get(tenantId) {
        return rows.get(tenantId) ?? EMPTY_CRYPTO_CONFIG;
      },
      async set(tenantId, next) {
        rows.set(tenantId, next);
        return next;
      },
    };
  }
  const registry =
    config.cryptoConfig.recipientKeyRegistry ?? config.deliveryEncryption?.recipientKeyRegistry;
  return {
    allowedKeyRefs: config.cryptoConfig.allowedKeyRefs,
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        if (!registry) return [];
        return recipientKeyOptions(await registry.listKeys(tenantId), tenantId);
      },
    },
    audit,
  };
}

/**
 * W-ENC-08-WIRE-ENC07: the delivery-encryption configuration the app actually
 * runs with. When the crypto-config surface is configured, the policy comes from
 * its store - the Admin toggle and the pinned key version - so an operator's change
 * applies to the next delivery without a restart. Static `policyByTenant` is kept
 * only as the fallback for a platform with no crypto-config surface, and the
 * recipient key registry is the same instance for both consumers.
 */
/**
 * W-ADM-UX-08-SHELL (Delta 106): the Admin shell's crypto-configuration
 * wiring, built from the SAME service the JSON API uses.
 *
 * The shell sub-server builds its `ShellRuntimeConfig` from a fixed field list
 * inside shell-server.ts, which is outside this packet's scope, so the resolver
 * is registered into the shell router instead of threaded through
 * `ServerConfig`. Registering here - once, at composition - is what keeps the
 * pane and the API from ever disagreeing about a tenant's configuration.
 *
 * Both directions take the tenant from the request and pass it to the service,
 * so the allowlist / revocation / pin rules are enforced in ONE place. The
 * router has already gated the route on a signed admin session and, for the
 * POST, on the server-derived CSRF proof; nothing here re-derives a role.
 *
 * Absent configuration (no `cryptoConfig` block) registers `undefined`, which
 * renders the pane's honest error state instead of a fabricated one.
 */
export function registerAdminCryptoConfigWiring(
  config: ServerConfig,
  cryptoConfig: CryptoConfigServiceOptions | null,
): void {
  if (!config.cryptoConfig || !cryptoConfig) {
    registerCryptoConfigWiring({});
    return;
  }
  const service = cryptoConfig;
  // The shell authenticates to itself as the platform operator; the tenant
  // being edited is the one the request names.
  const auth = { principal: { role: 'platform' as const } };
  const paneFor = async (request: { query?: Record<string, string> }): Promise<CryptoConfigPane> => {
    const tenantId = (request.query?.['tenantId'] ?? '').trim();
    if (!tenantId) return { status: 'error', code: 'CRYPTO_CONFIG_TENANT_REQUIRED' };
    try {
      const view = await readCryptoConfig(service, { auth, tenantId });
      return { status: 'ready', view };
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        return { status: 'error', code: 'CRYPTO_CONFIG_FORBIDDEN' };
      }
      return { status: 'error', code: 'CRYPTO_CONFIG_UNAVAILABLE' };
    }
  };
  registerCryptoConfigWiring({
    pane: (request) => paneFor(request),
    apply: async (input) => {
      const result = await applyCryptoConfig(service, {
        auth,
        tenantId: input.tenantId,
        mutation: {
          storageKeyRef: input.storageKeyRef,
          deliveryEncryption: input.deliveryEncryption,
          recipientKeyVersion: input.recipientKeyVersion,
        },
      });
      return { status: 'ready', view: result.view };
    },
  });
}
export function buildDeliveryEncryptionConfig(
  config: ServerConfig,
  cryptoConfig: CryptoConfigServiceOptions | null,
): DeliveryEncryptionConfig | undefined {
  const staticPolicy = config.deliveryEncryption;
  if (!staticPolicy && !cryptoConfig) return undefined;
  const store = cryptoConfig?.store;
  return {
    ...(staticPolicy ?? {}),
    recipientKeyRegistry:
      staticPolicy?.recipientKeyRegistry
      ?? config.cryptoConfig?.recipientKeyRegistry,
    policySource: store
      ? {
          async getDeliveryPolicy(tenantId: string) {
            const state = await store.get(tenantId);
            return {
              enabled: state.deliveryEncryption,
              pinnedRecipientKeyVersion: state.pinnedRecipientKeyVersion,
            };
          },
        }
      : undefined,
  };
}
export interface RouteContext {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Buffer;
  /** Public upload bytes stay an incoming stream all the way to crypto. */
  bodyStream?: AsyncIterable<Uint8Array>;
  correlationId: string;
  host: string;
  db: Db;
  redis: IORedis;
  registry: ReturnType<typeof createRegistryService>;
  profiles: ProfileService;
  audit: AuditService;
  submission: ReturnType<typeof createSubmissionService>;
  runtime: ReturnType<typeof createRuntimeService>;
  usage: ReturnType<typeof createUsageService>;
  artifacts: ArtifactService;
  /** DATA-02 client-driven multipart upload lifecycle. */
  multipart: MultipartService;
  /** Null/unset unless S3 and the Vault-backed app crypto are configured. */
  publicUploadGateway?: PublicUploadGateway | null;
  grants: GrantService | null;
  connectors: ConnectorProxy;
  lifecycle: ReturnType<typeof createLifecycleService>;
  dispatcher: ReturnType<typeof createDispatcher>;
  getQueue: (name: string) => Queue;
  /** MM-05: latest queue-integrity sweep snapshot; undefined before the first. */
  queueIntegrity: () => QueueIntegrityHealth | undefined;
  /** VAULT-03: Admin provider-key credential workflow (config-injected). */
  credentialWorkflow: CredentialWorkflow | undefined;
  /** ENC-07: delivery encryption service; null when no tenant policy exists. */
  deliveryEncryption: DeliveryEncryptionService | null;
  /** CR28-01: authenticated read of a sealed artifact; null when not on S3 crypto. */
  artifactDecryptDeps: ArtifactDecryptDeps | null;
  /** ENC-08: crypto-configuration service options; null when not configured. */
  cryptoConfig: CryptoConfigServiceOptions | null;
  config: ServerConfig;
}

export async function route(ctx: RouteContext): Promise<{
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** FIX-CR-13: raw binary payload — sent byte-for-byte, never JSON-encoded. */
  raw?: Buffer | Readable;
}> {
  const { method, pathname } = ctx;
  const workerBusinessId = resolveWorkerBusinessIdentity(ctx.config, ctx.headers['authorization']);
  if (
    workerBusinessId &&
    (!pathname.startsWith('/api/runtime/v1/') || pathname === '/api/runtime/v1/usage-events')
  ) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker credentials cannot access this API surface');
  }

  // Health (P2-09 OPS-07)
  if (method === 'GET' && (pathname === '/health' || pathname === '/api/v1/health')) {
    let dbOk = false;
    let activeLeases = 0;
    try {
      const dbRes = await ctx.db.query('SELECT 1');
      dbOk = Boolean(dbRes.rowCount && dbRes.rowCount > 0);
      activeLeases = await ctx.runtime.getActiveLeasesCount();
    } catch {
      dbOk = false;
      activeLeases = 0;
    }

    let redisOk = false;
    try {
      const pong = await ctx.redis.ping();
      redisOk = pong === 'PONG';
    } catch {
      redisOk = false;
    }

    const isOk = dbOk && redisOk;
    // MM-05 (docs/38 §6, decision D2): durable health truth. Transport fine
    // but queue integrity SUSPECT → body says 'degraded' while HTTP stays
    // 200; the LB must not drop a node that is actively reconstructing.
    // The field appears only after the first sweep (never a fabricated OK);
    // a transport failure keeps the previous 503 shape byte-for-byte.
    const qi = ctx.queueIntegrity();
    const body: Record<string, unknown> = {
      status: isOk && qi?.state !== 'SUSPECT' ? 'ok' : 'degraded',
      db: dbOk,
      redis: redisOk,
      activeLeases,
    };
    if (qi) body.queueIntegrity = qi;
    return { status: isOk ? 200 : 503, body };
  }

  // Runtime: POST /api/runtime/v1/usage-events (Connector usage ingestion)
  if (method === 'POST' && pathname === '/api/runtime/v1/usage-events') {
    const authorization = ctx.headers.authorization;
    if (!authorization || !ctx.config.usageToken) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'missing connector usage bearer token');
    }
    if (authorization !== `Bearer ${ctx.config.usageToken}`) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'usage ingestion requires connector identity');
    }
    return { status: 200, body: await ctx.usage.ingest(ctx.body) };
  }

  // Public: GET /api/v1/usage/summary?from=<iso>&to=<iso> (P2-07 tenant usage projection).
  // Tenant-scoped via x-api-key; aggregates usage by provider/model over [from,to).
  if (method === 'GET' && pathname === '/api/v1/usage/summary') {
    const apiKey = await resolveApiKey(ctx);
    const from = ctx.searchParams.get('from');
    const to = ctx.searchParams.get('to');
    if (!from || !to) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'usage summary requires from and to query parameters');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    return { status: 200, body: await ctx.usage.getUsageSummary(apiKey.tenantId, fromDate, toDate) };
  }

  // COST-03: GET /api/v1/usage/events is a bounded keyset page shared by
  // aggregate drill-down and export clients. The principal determines tenant
  // scope before the usage service constructs SQL; every successful page is
  // audited without putting filter values, cursors, or credentials in the log.
  if (method === 'GET' && pathname === '/api/v1/usage/events') {
    const allowed = new Set([
      'tenantId', 'apiKeyId', 'businessId', 'action', 'profileRevision', 'provider', 'model',
      'operationId', 'from', 'to', 'timeField', 'limit', 'cursor',
    ]);
    const rawQuery: Record<string, unknown> = {};
    for (const [key, value] of ctx.searchParams.entries()) {
      if (!allowed.has(key) || Object.prototype.hasOwnProperty.call(rawQuery, key)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'usage event query contains an unsupported or repeated parameter');
      }
      if (key === 'limit' || key === 'profileRevision') {
        if (!/^\d+$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'usage event query contains an invalid integer');
        rawQuery[key] = Number(value);
      } else {
        rawQuery[key] = value;
      }
    }
    const parsedQuery = UsageEventDrilldownQuerySchema.safeParse(rawQuery);
    if (!parsedQuery.success) throw zodIssuesToProblem(parsedQuery.error.issues);

    const usagePrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    let tenantId: string;
    let actor: string;
    if (usagePrincipal) {
      tenantId = authorizeAuditTenantRead(usagePrincipal, parsedQuery.data.tenantId ?? '');
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'usage event export requires tenantId');
      actor = 'admin';
    } else {
      const apiKey = await resolveApiKey(ctx);
      if (parsedQuery.data.tenantId && parsedQuery.data.tenantId !== apiKey.tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match api key tenant');
      }
      tenantId = apiKey.tenantId;
      actor = 'api-key';
    }

    const page = await ctx.usage.getUsageEventExportPage(tenantId, parsedQuery.data);
    await ctx.audit.record({
      tenantId,
      actor,
      action: 'usage.export',
      resource: 'usage-events:page',
      severity: 'info',
      correlationId: ctx.correlationId,
    });
    return { status: 200, body: page };
  }

  // Public: GET /api/v1/usage?tenantId=<uuid>&from=<iso>&to=<iso>
  // ADM-BASE-01: the shell's overview fetcher GETs exactly this path with
  // the admin bearer (not /usage/summary, which stays as-is for
  // Connector/x-api-key consumers). Admin bearer → tenantId REQUIRED from
  // the query (cross-tenant: it IS the admin console). x-api-key →
  // tenant from the key; an explicit tenantId param must match the key's
  // tenant or the request fails closed (no cross-tenant read via key).
  if (method === 'GET' && pathname === '/api/v1/usage') {
    const from = ctx.searchParams.get('from');
    const to = ctx.searchParams.get('to');
    if (!from || !to) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'usage summary requires from and to query parameters');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    // ADM-BASE-02: principal-aware admin branch. Platform keeps the exact
    // old contract (tenantId REQUIRED cross-tenant, 422 when missing); a
    // tenant operator may only read its own tenant — foreign tenantId is
    // 403, missing param falls back to the caller's own scope.
    const usagePrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (usagePrincipal) {
      const tenantId = authorizeAuditTenantRead(usagePrincipal, ctx.searchParams.get('tenantId') ?? '');
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'usage requires tenantId query parameter');
      return { status: 200, body: await ctx.usage.getUsageSummary(tenantId, fromDate, toDate) };
    }
    const apiKey = await resolveApiKey(ctx);
    const tenantParam = ctx.searchParams.get('tenantId');
    if (tenantParam && tenantParam !== apiKey.tenantId) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match api key tenant');
    }
    return { status: 200, body: await ctx.usage.getUsageSummary(apiKey.tenantId, fromDate, toDate) };
  }

  // Public: GET /api/v1/connectors/:id/test (P2-07/CON-03 connector test proxy).
  // Tenant-scoped via x-api-key; proves the platform-registered Connector is
  // reachable. No caller headers are forwarded and no upstream error text is
  // echoed — failures surface as sanitized platform ProblemDetails only.
  {
    const m = /^\/api\/v1\/connectors\/([^/]+)\/test$/.exec(pathname);
    if (m && method === 'GET') {
      await resolveApiKey(ctx);
      const outcome = await ctx.connectors.testConnector(decodeURIComponent(m[1]!));
      return { status: 200, body: outcome };
    }
  }

  // Runtime: artifact upload grant  POST /api/runtime/v1/tasks/:id/artifacts
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/artifacts$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const body = ctx.body as { leaseEpoch: number };
      const grant = await ctx.artifacts.requestUpload(m[1]!, body.leaseEpoch, ctx.body);
      return { status: 201, body: { ...grant, uploadUrl: absoluteGrantUrl(ctx.host, grant.uploadUrl) } };
    }
  }

  // Runtime: artifact finalize  POST /api/runtime/v1/artifacts/:id/finalize
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/finalize$/.exec(pathname);
    if (m && method === 'POST') {
      await assertArtifactRuntimeAuth(ctx, m[1]!);
      await assertBodyTaskRuntimeAuth(ctx);
      return { status: 200, body: await ctx.artifacts.finalize(m[1]!, ctx.body) };
    }
  }

  // Runtime: artifact access grant  POST /api/runtime/v1/artifacts/:id/access
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/access$/.exec(pathname);
    if (m && method === 'POST') {
      await assertArtifactRuntimeAuth(ctx, m[1]!);
      await assertBodyTaskRuntimeAuth(ctx);
      const grant = await ctx.artifacts.requestAccess(m[1]!, ctx.body);
      const abs: Record<string, unknown> = { ...grant };
      if (grant.downloadUrl) abs.downloadUrl = absoluteGrantUrl(ctx.host, grant.downloadUrl);
      if (grant.uploadUrl) abs.uploadUrl = absoluteGrantUrl(ctx.host, grant.uploadUrl);
      return { status: 200, body: abs };
    }
  }

  // Runtime: multipart init  POST /api/runtime/v1/tasks/:id/artifacts/multipart
  // DATA-02. The task-scoped fence matches the single-PUT grant route; the
  // uploadToken in the body is the replay key, so a lost response is retried
  // with the same token instead of leaking a second provider upload.
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/artifacts\/multipart$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const ack = await ctx.multipart.init(m[1]!, ctx.body);
      return { status: ack.replayed ? 200 : 201, body: ack };
    }
  }

  // Runtime: multipart part grant / complete / abort
  // POST /api/runtime/v1/artifacts/:id/multipart/{part,complete,abort}
  // The artifact row is the authority for which task owns the upload, so these
  // three are authorized by artifact id: the part/complete/abort wire carries
  // only the lease epoch, never a client-declared task id. A presigned part URL
  // is a grant like any other and is never logged.
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/([^/]+)\/multipart\/(part-grant|part|complete|abort)$/.exec(pathname);
    if (m && method === 'POST') {
      const artifactId = m[1]!;
      await assertArtifactRuntimeAuth(ctx, artifactId);
      if (m[2] === 'part-grant' || m[2] === 'part') {
        const grant = await ctx.multipart.grantPart(artifactId, ctx.body);
        return { status: 200, body: { ...grant, partUrl: absoluteGrantUrl(ctx.host, grant.partUrl) } };
      }
      if (m[2] === 'complete') {
        return { status: 200, body: await ctx.multipart.complete(artifactId, ctx.body) };
      }
      return { status: 200, body: await ctx.multipart.abort(artifactId, ctx.body) };
    }
  }

  // Public uploads are tenant-fenced by x-api-key and use no producer lease.
  // Files below the multipart contract floor get a gateway-owned session;
  // larger sessions retain the existing initializer. The replay key is the
  // body uploadToken or an Idempotency-Key derived per tenant.
  {
    const content = /^\/api\/v1\/uploads\/([^/]+)(?:\/content)?$/.exec(pathname);
    if (method === 'PUT' && content) {
      const apiKey = await resolveApiKey(ctx);
      if (!ctx.publicUploadGateway) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
      }
      if (!ctx.bodyStream) throw new HttpError(400, 'MALFORMED_BODY', 'upload byte stream is required');
      const contentLength = ctx.headers['content-length'];
      const plaintextSha256 = ctx.headers['x-content-sha256'];
      const ack = await ctx.publicUploadGateway.upload({
        artifactId: decodeURIComponent(content[1]!),
        tenantId: apiKey.tenantId,
        source: ctx.bodyStream,
        ...(typeof contentLength === 'string' ? { contentLength } : {}),
        ...(typeof plaintextSha256 === 'string' ? { plaintextSha256 } : {}),
      });
      return { status: ack.replayed ? 200 : 201, body: ack };
    }
    if (method === 'POST' && pathname === '/api/v1/uploads') {
      const apiKey = await resolveApiKey(ctx);
      if (!ctx.publicUploadGateway) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const maxUploadBytes = ctx.config.publicUploadEncryption?.maxBytes ?? 8 * 1024 * 1024 * 1024;
      if (typeof body.sizeBytes === 'number' && body.sizeBytes > maxUploadBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the encrypted upload size limit');
      }
      const headerKey = ctx.headers['idempotency-key'];
      const forwarded =
        typeof body.uploadToken === 'string' || typeof headerKey !== 'string' || headerKey.length === 0
          ? body
          : { ...body, uploadToken: publicUploadToken(apiKey.tenantId, headerKey) };
      const ack = typeof body.sizeBytes === 'number' && body.sizeBytes < MULTIPART_MIN_TOTAL_BYTES
        ? await ctx.publicUploadGateway.initSingle(apiKey.tenantId, forwarded)
        : await ctx.multipart.publicInit(apiKey.tenantId, forwarded);
      return {
        status: ack.replayed ? 200 : 201,
        body: { ...ack, uploadUrl: `/api/v1/uploads/${encodeURIComponent(ack.artifactId)}/content` },
      };
    }
    const m = /^\/api\/v1\/uploads\/([^/]+)\/(part|complete|abort)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const artifactId = decodeURIComponent(m[1]!);
      if (m[2] === 'part') {
        throw new HttpError(409, 'STATE_CONFLICT', 'direct S3 upload grants are disabled for public uploads');
      }
      if (m[2] === 'complete') {
        if (!ctx.publicUploadGateway) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted public uploads are not configured');
        }
        return { status: 200, body: await ctx.publicUploadGateway.completeReplay(artifactId, apiKey.tenantId, ctx.body) };
      }
      return { status: 200, body: await ctx.multipart.publicAbort(artifactId, apiKey.tenantId, ctx.body) };
    }
  }

  // Runtime: invocation grant  POST /api/runtime/v1/tasks/:id/invocation-grants
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/invocation-grants$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      if (!ctx.grants) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'invocation grants are not configured');
      const body = ctx.body as { leaseEpoch: number };
      return { status: 201, body: await ctx.grants.issue(m[1]!, body.leaseEpoch, ctx.body) };
    }
  }

  // Runtime: artifact blob PUT/GET (grant-protected; slice in-process transport)
  // CR-12: method-scoped, expiring grants. The token row carries the method it
  // was issued for (upload|download) and its expiry; a mismatch 403s (a read
  // grant can never PUT) and an expired token 404s (indistinguishable from a
  // missing artifact, no existence leak). Legacy rows with NULL mode/expiry
  // (pre-0008) fail closed — holders must re-request a scoped grant.
  {
    const m = /^\/api\/runtime\/v1\/artifacts\/blob\/([^/]+)$/.exec(pathname);
    if (m) {
      const art = await resolveArtifactByStorageKey(ctx, m[1]!);
      const workerBusinessId = resolveWorkerBusinessIdentity(ctx.config, ctx.headers['authorization']);
      if (workerBusinessId) {
        authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], art.businessId ?? '');
      }
      const grant = ctx.searchParams.get('grant');
      if (!grant || art.token !== grant) throw new HttpError(403, 'PERMISSION_DENIED', 'invalid artifact blob grant');
      const wantMode = method === 'PUT' ? 'upload' : method === 'GET' ? 'download' : null;
      if (!wantMode) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      if (art.mode !== wantMode) throw new HttpError(403, 'PERMISSION_DENIED', 'grant not issued for this method');
      if (!art.expiresAt || new Date(art.expiresAt).getTime() <= Date.now()) {
        throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
      }
      if (method === 'PUT') {
        // FIX-CR-11: blob bytes arrive raw via the binary ingress path —
        // never utf8-decoded or JSON-parsed. GET without a prior PUT has no
        // rawBody; putBlob of an empty buffer is the explicit empty blob.
        await ctx.artifacts.putBlob(m[1]!, art.tenantId, ctx.rawBody ?? Buffer.alloc(0));
        return { status: 204, body: undefined };
      }
      if (method === 'GET') {
        // CR28-01: a sealed artifact must be authenticated and opened BEFORE
        // a worker sees it. Handing the worker ciphertext would make the task
        // fail deep inside a parser with no signal that the storage layer was
        // the cause, so the decrypt happens here, on the serving boundary.
        if (ctx.artifactDecryptDeps) {
          const opened = await decryptStoredArtifact(ctx.artifactDecryptDeps, {
            artifactId: art.id as string,
            tenantId: art.tenantId as string,
            storageKey: m[1]!,
            uploadToken: (art.uploadToken as string | null) ?? null,
          });
          if (opened.decrypted) {
            return {
              status: 200,
              raw: Readable.from([opened.bytes]),
              headers: { 'content-type': 'application/octet-stream' },
            };
          }
        }
        const stream = await ctx.artifacts.getBlob(m[1]!);
        return { status: 200, raw: stream, headers: { 'content-type': 'application/octet-stream' } };
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed');
    }
  }

  {
    const m = /^\/api\/runtime\/v1\/businesses\/([^/]+)\/versions\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      assertPlatformRuntimeAuth(ctx);
      const result = await ctx.registry.registerVersion(ctx.body);
      return { status: result.created ? 201 : 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/workers/:instanceId/heartbeat
  if (method === 'PUT' && /^\/api\/runtime\/v1\/workers\/[^/]+\/heartbeat$/.test(pathname)) {
    const workerBusinessId = assertRuntimeAuth(ctx);
    if (workerBusinessId) {
      const declaredBusinessId = (ctx.body as { businessId?: unknown } | null)?.businessId;
      if (typeof declaredBusinessId !== 'string') {
        throw new HttpError(403, 'PERMISSION_DENIED', 'worker heartbeat requires its authenticated business');
      }
      authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], declaredBusinessId);
    }
    return { status: 200, body: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 } };
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/claim
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/claim$/.exec(pathname);
    if (m && method === 'POST') {
      assertRuntimeAuth(ctx);
      const parsedBody = ClaimTaskRequestSchema.safeParse(ctx.body);
      if (!parsedBody.success) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'task claim requires deliveryId, workerInstanceId, and businessId');
      }
      const body = parsedBody.data;
      const workerBusinessId = authorizeWorkerClaim(
        ctx.config,
        ctx.headers['authorization'],
        body.businessId
      );
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.claimTask(
        m[1]!,
        body.deliveryId,
        body.workerInstanceId,
        workerBusinessId
      );
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/heartbeat
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/heartbeat$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const body = ctx.body as { leaseEpoch: number };
      const result = await ctx.runtime.heartbeatTask(m[1]!, body.leaseEpoch, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: PUT /api/runtime/v1/tasks/:id/steps/:stepKey
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/steps\/([^/]+)$/.exec(pathname);
    if (m && method === 'PUT') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.saveStep(m[1]!, decodeURIComponent(m[2]!), ctx.body as never, workerBusinessId);
      return { status: result.replayed ? 200 : 201, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/progress
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/progress$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      await ctx.runtime.reportProgress(m[1]!, ctx.body as never);
      return { status: 200, body: {} };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/complete
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/complete$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.completeTask(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/fail
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/fail$/.exec(pathname);
    if (m && method === 'POST') {
      const workerBusinessId = await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.failTask(m[1]!, ctx.body as never, workerBusinessId);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/children  (W13-C item 4: fan-out spawn)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/children$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.spawnChildren(m[1]!, ctx.body as never);
      return { status: 202, body: result };
    }
  }

  // Runtime: GET /api/runtime/v1/tasks/:id/children  (W13-C item 4: join visibility)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/children$/.exec(pathname);
    if (m && method === 'GET') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.getChildren(m[1]!);
      return { status: 200, body: result };
    }
  }

  // Runtime: POST /api/runtime/v1/tasks/:id/wait-input  (W13-C item 4: human wait)
  {
    const m = /^\/api\/runtime\/v1\/tasks\/([^/]+)\/wait-input$/.exec(pathname);
    if (m && method === 'POST') {
      await assertTaskRuntimeAuth(ctx, m[1]!);
      const result = await ctx.runtime.waitInput(m[1]!, ctx.body as never);
      return { status: 200, body: result };
    }
  }

  // Runtime: GET /api/runtime/v1/workspace-reference?workspacePath=<dir>&tenantId=<uuid>
  // (W47-C1: read-only ART-02 lookup for the SDK sweeper's hasActiveReference
  // hook — the ONLY writer-side integration the worker needs. Answers whether
  // this temp workspace still holds an ACTIVE reference (non-terminal
  // task/operation or OPEN human wait under `tenantId`). Contract (§contract):
  // 200 `{ workspacePath, tenantId, referenced, activeHolders }`;
  // 401 invalid runtime bearer; 422 missing/invalid query params (INVALID_SCHEMA).
  // No 404 — an unknown/unreferenced workspace is `referenced: false`, not
  // an error (the sweeper treats it as a true orphan candidate).
  if (method === 'GET' && pathname === '/api/runtime/v1/workspace-reference') {
    const workerBusinessId = assertRuntimeAuth(ctx);
    const parsed = WorkspaceReferenceQuerySchema.safeParse({
      workspacePath: ctx.searchParams.get('workspacePath'),
      tenantId: ctx.searchParams.get('tenantId'),
    });
    if (!parsed.success) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        'workspace-reference requires workspacePath and tenantId query parameters'
      );
    }
    const status = await ctx.runtime.workspaceReferenceStatus(parsed.data.tenantId, workerBusinessId);
    return {
      status: 200,
      body: {
        workspacePath: parsed.data.workspacePath,
        tenantId: parsed.data.tenantId,
        referenced: status.referenced,
        activeHolders: status.activeHolders,
      },
    };
  }

  // Legacy compat facade (COMP-03a/05/06/07/08). Mounted BEFORE the canonical
  // routes because the legacy paths are matched by their own table; a request
  // the facade does not own returns null and falls through unchanged. The
  // facade reproduces the old wire verbatim (status, headers, envelope) while
  // taking identity only from the API key — see compat/legacy-http-mount.ts.
  {
    const legacy = await handleLegacyRoute(
      {
        method,
        pathname,
        searchParams: ctx.searchParams,
        headers: ctx.headers,
        body: ctx.body,
        ...(ctx.bodyStream ? { bodyStream: ctx.bodyStream } : {}),
        resolvePrincipal: async () => {
          const key = await resolveApiKey(ctx);
          return { tenantId: key.tenantId, apiKeyId: key.id };
        },
      },
      legacyCompatHost(ctx),
    );
    if (legacy !== null) {
      return { status: legacy.status, body: legacy.body, headers: legacy.headers };
    }
  }

  // Public: POST /api/v1/businesses/:id/actions/:action
  {
    const m = /^\/api\/v1\/businesses\/([^/]+)\/actions\/([^/]+)$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.submission.submit({
        tenantId: apiKey.tenantId,
        apiKeyId: apiKey.id,
        businessId: decodeURIComponent(m[1]!),
        action: decodeURIComponent(m[2]!),
        idempotencyKey: (ctx.headers['idempotency-key'] as string) || undefined,
        correlationId: ctx.correlationId,
        submission: ctx.body,
      });
      // URL submissions are admitted with a PENDING_INGESTION operation and
      // must not dispatch the business task until the ingestion worker pins a
      // version/hash and calls markIngestionReady. Inline submissions retain
      // the existing best-effort dispatch path.
      if (ctx.config.autoDispatch !== false && result.operation.state !== 'PENDING_INGESTION') {
        ctx.dispatcher.dispatchOnce().catch(() => undefined);
      }
      const status = result.replayed ? 200 : 202;
      return {
        status,
        body: {
          operationId: result.operation.id,
          state: result.operation.state,
          stateVersion: result.operation.stateVersion,
          replayed: result.replayed,
          correlationId: result.correlationId,
          links: result.operation.links,
        },
      };
    }
  }

  // Public: GET /api/v1/operations
  // ADM-BASE-01: the admin bearer is accepted as an ALTERNATE auth path
  // (the shell's operation fetcher sends `Authorization: Bearer <adminToken>`
  // with no x-api-key). ADM-UX-02 replaced the two divergent list envelopes
  // with ONE query contract on both paths: allow-listed `state`/`tenant`/
  // `id` filters, a server-enforced `limit` (default 20, max 100), a stable
  // keyset `cursor`, and `{ items, nextCursor, prevCursor, total, limit }`
  // where `total` is a COUNT of the filtered population (the old
  // `total = rows.length` is gone). The x-api-key path stays tenant-fenced
  // (R24-01 untouched) and gains the same read-only filters.
  if (method === 'GET' && pathname === '/api/v1/operations') {
    // ADM-BASE-02: the admin-bearer list is principal-aware. The tenant SCOPE
    // comes from the credential: a platform principal may narrow to any
    // tenant with `?tenant=`, a tenant operator is pinned to its own tenant
    // by SQL predicate (server-side fence, not post-filter) and gets 403 on a
    // foreign `tenant` — identical wording for foreign and unknown ids.
    const listPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (listPrincipal) {
      const query = parseOperationsListQuery(ctx.searchParams);
      const scope = authorizeAuditTenantRead(listPrincipal, query.tenantId ?? '');
      return {
        status: 200,
        body: await listOperationsPage(ctx, query, scope === '' ? null : scope, toOperationDetailWire),
      };
    }
    const apiKey = await resolveApiKey(ctx);
    const query = parseOperationsListQuery(ctx.searchParams);
    // R24-01: on the public path the API KEY is the fence, never a query
    // parameter — `tenant` is not a scope selector here, it is only honoured
    // when it equals the key's own tenant (a foreign value 403s rather than
    // being silently ignored, so no caller believes it widened its view).
    if (query.tenantId !== null && query.tenantId !== apiKey.tenantId) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'admin reads are scoped to the caller tenant');
    }
    return {
      status: 200,
      body: await listOperationsPage(ctx, query, apiKey.tenantId, toOperationView),
    };
  }

  // Public: GET /api/v1/operations/:id  (P2-08 facade, `?wait=<seconds>` long-poll)
  // R24-01: the read is tenant-scoped BEFORE the poll starts and stays
  // tenant-scoped on every 500 ms re-read inside waitForTerminal, so a
  // foreign id 404s promptly (no timing leak, no wasted DB polling) and an
  // operation that changes hands/is cancelled mid-poll re-fences per
  // iteration. No post-poll tenant comparison is needed — or trusted.
  {
    const m = /^\/api\/v1\/operations\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET' && !pathname.endsWith('/result')) {
      // ADM-BASE-01: admin bearer alternate path — the shell's detail
      // fetcher GETs this same URL with the admin token. Admin gets the
      // merged `{ operation, result, artifacts, serverNow }` envelope the
      // fetcher parses (cross-tenant: it IS the admin console). The
      // x-api-key path below is unchanged (tenant-fenced plain view).
      // ADM-BASE-02: by-id admin detail is principal-aware. A tenant
      // operator reaching a foreign operation gets the SAME 404 as a
      // missing row (R24-01 precedent — no existence leak on by-id access);
      // platform behavior unchanged.
      const detailPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (detailPrincipal) {
        if (detailPrincipal.role === 'tenant_operator') {
          const op = await ctx.runtime.getOperation(m[1]!);
          requireResourceTenant(detailPrincipal, String(op.tenant_id));
        }
        return { status: 200, body: await buildAdminOperationDetail(ctx, m[1]!) };
      }
      const apiKey = await resolveApiKey(ctx);
      const waitParam = ctx.searchParams.get('wait');
      const waitSeconds = waitParam ? parseInt(waitParam, 10) : 0;
      const op = await waitForTerminal(
        (id) => ctx.runtime.getTenantOperation(id, apiKey.tenantId),
        m[1]!,
        Number.isFinite(waitSeconds) ? waitSeconds : 0
      );
      return { status: 200, body: toOperationView(op) };
    }
  }

/**
 * ENC-07: map a delivery-encryption failure onto the wire.
 *
 * Two properties matter here. First, the text is FIXED per code: the raw
 * error message never crosses the boundary (ADM-BASE-03 - an upstream or
 * registry error can echo internals). Second, and more important, every
 * failure is UNAVAILABLE, never a plaintext downgrade: a tenant whose
 * delivery encryption is switched on but whose key is missing, revoked,
 * unresolvable or currently erroring gets a 503, because silently
 * downgrading is exactly the leak this feature exists to prevent.
 */
function deliveryEncryptionHttpError(err: DeliveryEncryptionError): HttpError {
  if (err.code === 'RECIPIENT_KEY_NOT_FOUND') {
    return new HttpError(
      503,
      'TEMPORARY_UNAVAILABLE',
      'encrypted delivery is unavailable: no recipient key is registered',
    );
  }
  if (err.code === 'RECIPIENT_KEY_REVOKED') {
    return new HttpError(
      503,
      'TEMPORARY_UNAVAILABLE',
      'encrypted delivery is unavailable: the recipient key is revoked',
    );
  }
  if (err.code === 'DELIVERY_ENCRYPTION_DISABLED') {
    return new HttpError(409, 'STATE_CONFLICT', 'delivery encryption is not enabled for this tenant');
  }
  return new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
}

/**
 * ENC-07: read a stored blob into memory with a hard byte ceiling. Streaming
 * is the default download path, but an encrypted delivery has to hold the
 * whole payload (AES-GCM is single-shot), so the buffer must be bounded
 * rather than trusted. Past the ceiling the stream is destroyed and the
 * request fails closed with 413 - a large artifact is a real limit, not a
 * reason to fall back to plaintext.
 */



const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;


/**
 * ENC-07: wrap a response payload in the delivery envelope when the tenant
 * policy asks for it. Returns null when the policy is absent or disabled, so
 * the caller serves its existing plaintext shape unchanged.
 */
async function encryptedDeliveryBody(
  ctx: RouteContext,
  tenantId: string,
  payload: Buffer,
  extra: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown> } | null> {
  const policy = await ctx.deliveryEncryption?.resolvePolicy(tenantId);
  if (!policy?.enabled) return null;
  const service = ctx.deliveryEncryption;
  if (!service) {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
  }
  try {
    const delivery = await service.encryptForDelivery(tenantId, payload);
    return { body: { schemaVersion: '1', encrypted: true, delivery, ...extra } };
  } catch (err) {
    if (err instanceof DeliveryEncryptionError) throw deliveryEncryptionHttpError(err);
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
  }
}

  // Public: GET /api/v1/operations/:id/result  (P2-08 facade)
  // CR-12/MM-02: the envelope now projects REAL artifact refs (never []):
  // submission-declared inputs (top-level roles from `submit_artifacts`,
  // persisted verbatim at submit) plus task-produced outputs (READY rows
  // verified at completion time, purpose 'output'). `data` carries the worker's
  // opaque resultRef verbatim (no envelope guessing); `download` is a
  // relative public URL per ArtifactRefSchema — the GET below mints a real
  // download for READY rows after a tenant-scoped check.
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/result$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const op = await ctx.runtime.getOperation(m[1]!);
      if ((op.tenant_id as string) !== apiKey.tenantId) throw new HttpError(404, 'NOT_FOUND', 'operation not found');
      const status = resultHttpStatus(op.state as string);
      if (status !== 200) {
        if (status === 410) {
          throw new HttpError(410, 'GONE', `operation ${op.state as string} is expired`);
        }
        throw new HttpError(409, 'STATE_CONFLICT', `operation is ${op.state as string}, not SUCCEEDED`);
      }
      const arts = await ctx.db.query(
        `SELECT a.id, a.purpose, a.mime_type, a.size_bytes, a.sha256, a.state,
                COALESCE(o.submit_artifacts, '[]'::jsonb) AS submit_roles
         FROM operations o
         LEFT JOIN artifacts a
           ON a.state = 'READY'
          AND a.tenant_id = o.tenant_id
          AND a.purpose IN ('input', 'output')
          AND (
            (a.operation_id = o.id AND a.purpose = 'output')
            OR COALESCE(o.submit_artifacts, '[]'::jsonb) @>
               jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
          )
         WHERE o.id = $1`,
        [m[1]!]
      );
      const submitRoles = new Map<string, string>();
      for (const row of arts.rows as { submit_roles: unknown }[]) {
        const declared = (row.submit_roles as { artifactId?: unknown; role?: unknown }[] | null) ?? [];
        if (Array.isArray(declared)) {
          for (const d of declared) {
            if (typeof d?.artifactId === 'string' && typeof d?.role === 'string') {
              submitRoles.set(d.artifactId, d.role);
            }
          }
        }
        break;
      }
      const artifacts = (arts.rows as {
        id: string | null; purpose: string | null; mime_type: string | null;
        size_bytes: number | string | null; sha256: string | null; state: string | null;
      }[])
        .filter((r) => r.id !== null)
        .map((r) => ({
          artifactId: r.id as string,
          role: submitRoles.get(r.id as string) ?? r.purpose ?? 'output',
          mimeType: r.mime_type ?? undefined,
          sizeBytes: r.size_bytes === null ? undefined : Number(r.size_bytes),
          hashSha256: r.sha256 ?? undefined,
          download: `/api/v1/artifacts/${r.id as string}/download`,
        }));
      const plaintextResult = {
        schemaVersion: '1',
        data: op.result_ref ? { resultRef: op.result_ref } : {},
        artifacts,
        usage: await ctx.usage.project(m[1]!),
        warnings: [],
      };
      // ENC-07: the tenant policy, not the caller, decides the wire shape. A
      // client cannot ask for plaintext here, and a failed encryption is a
      // 503 rather than a downgrade, so /result can never quietly serve
      // plaintext under a tenant that switched encryption on.
      const encrypted = await encryptedDeliveryBody(
        ctx,
        apiKey.tenantId,
        Buffer.from(JSON.stringify(plaintextResult), 'utf8'),
      );
      if (encrypted) return { status: 200, body: encrypted.body };
      return {
        status: 200,
        body: plaintextResult,
      };
    }
  }

  // Public: GET /api/v1/artifacts/:id/download  (CR-12/MM-02)
  // Tenant-scoped download for published READY inputs/outputs. Unlike the
  // runtime blob route (grant-bearer, worker lane), this route is tenant-scoped
  // rows 409 (bytes not yet integrity-verified); foreign/missing ids 404
  // (indistinguishable, no existence leak). Bytes stream raw
  // (application/octet-stream, CR-13 wire), not wrapped or re-encoded.
  {
    const m = /^\/api\/v1\/artifacts\/([^/]+)\/download$/.exec(pathname);
    if (m && method === 'GET') {
      const apiKey = await resolveApiKey(ctx);
      const res = await ctx.db.query(
        `SELECT a.state, a.mime_type, a.tenant_id, a.storage_key, a.upload_token
         FROM artifacts a
         WHERE a.id = $1 AND a.tenant_id = $2
           AND a.purpose IN ('input', 'output')
           AND (
             (a.purpose = 'output' AND EXISTS (
               SELECT 1 FROM operations owner_op
               WHERE owner_op.id = a.operation_id
                 AND owner_op.tenant_id = $2 AND owner_op.state = 'SUCCEEDED'
             ))
             OR EXISTS (
               SELECT 1 FROM operations ref_op
               WHERE ref_op.tenant_id = $2 AND ref_op.state = 'SUCCEEDED'
                 AND COALESCE(ref_op.submit_artifacts, '[]'::jsonb) @>
                     jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
             )
           )`,
        [m[1]!, apiKey.tenantId]
      );
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `artifact ${m[1]} not found`);
      const row = res.rows[0] as {
        state: string; mime_type: string; tenant_id: string; storage_key: string;
        upload_token: string | null;
      };
      if (row.state !== 'READY') {
        throw new HttpError(409, 'STATE_CONFLICT', `artifact ${m[1]} is ${row.state}, not READY`);
      }
      // CR28-01: the payload may be sealed at rest. Decrypt BEFORE deciding
      // how to deliver it, so neither branch can hand a caller ciphertext:
      // the plaintext branch would label ciphertext as the document, and the
      // encrypted-delivery branch would double-wrap it for the recipient.
      const stored = ctx.artifactDecryptDeps
        ? await decryptStoredArtifact(ctx.artifactDecryptDeps, {
            artifactId: m[1]!,
            tenantId: apiKey.tenantId,
            storageKey: row.storage_key,
            uploadToken: row.upload_token,
          })
        : null;
      const stream = stored ? Readable.from([stored.bytes]) : await ctx.artifacts.getBlob(row.storage_key);
      // ENC-07: the same server-side policy that governs /result governs the
      // bytes here. Wrapping only the metadata and streaming raw bytes
      // underneath it would leave the payload - the part that matters - in
      // plaintext, so both routes encrypt or neither does.
      const downloadPolicy = await ctx.deliveryEncryption?.resolvePolicy(apiKey.tenantId);
      if (downloadPolicy?.enabled) {
        // Encrypting needs the whole payload in memory (AES-GCM is single
        // shot), which is exactly what the streaming download avoids. The
        // read is therefore bounded by the same cap the ingress enforces, and
        // an artifact past it FAILS CLOSED rather than quietly degrading to
        // an unbounded buffer.
        const bytes = await readStreamBounded(stream, ctx.config.maxBlobBytes ?? 64 * 1024 * 1024);
        const encrypted = await encryptedDeliveryBody(
          ctx,
          apiKey.tenantId,
          bytes,
          { artifactId: m[1]!, mimeType: row.mime_type || 'application/octet-stream' },
        );
        if (!encrypted) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'encrypted delivery is unavailable');
        return {
          status: 200,
          body: encrypted.body,
          headers: { 'content-type': 'application/json' },
        };
      }
      return {
        status: 200,
        raw: stream,
        headers: { 'content-type': row.mime_type || 'application/octet-stream' },
      };
    }
  }

  // Public: POST /api/v1/operations/:id/cancel  (P2-06, idempotent, tenant-scoped)
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/cancel$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.lifecycle.cancelOperation(m[1]!, apiKey.tenantId);
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Public: POST /api/v1/operations/:id/resume  (W13-C item 4: tenant-scoped, CAS)
  {
    const m = /^\/api\/v1\/operations\/([^/]+)\/resume$/.exec(pathname);
    if (m && method === 'POST') {
      const apiKey = await resolveApiKey(ctx);
      const result = await ctx.runtime.resumeOperation(m[1]!, apiKey.tenantId, ctx.body as never);
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/enable  (P2-07 real enable)
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/enable$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const businessId = decodeURIComponent(m[1]!);
      const version = decodeURIComponent(m[2]!);
      // W29-C fix kept: an enable that affects no row (never-registered
      // version) fails closed with 404 — the throw rolls the transaction
      // back, so there is nothing to commit.
      // R3-01: UPDATE + ledger INSERT in ONE transaction (auditedMutation).
      await auditedMutation(
        ctx.db,
        ctx.audit,
        async (client) => {
          const result = await client.query(
            'UPDATE business_versions SET status=$3, updated_at=now() WHERE business_id=$1 AND version=$2',
            [businessId, version, 'ENABLED']
          );
          if (!result.rowCount) {
            throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
          }
        },
        () => ({
          // W48-C1: platform-global audit row (business_versions is not
          // tenant-scoped — there is no honest tenant to attribute this to).
          tenantId: null,
          actor: 'admin',
          action: 'business.enable',
          resource: `business:${businessId}@${version}`,
          severity: 'success',
          correlationId: ctx.correlationId,
        })
      );
      return { status: 200, body: { businessId, version, status: 'ENABLED' } };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/activate  (W28-C)
  // Activate a version as the target for new submissions. Any other version's
  // active pointer is implicitly cleared. In-flight/pinned operations keep
  // routing via their operation.business_version pin, unchanged.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/activate$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      // R3-01: activation + ledger INSERT share one transaction.
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.activateVersion(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), client),
        (r) => ({
          // W48-C1: platform-global audit row (no tenant on business_versions).
          tenantId: null,
          actor: 'admin',
          action: 'business.activate',
          resource: `business:${r.businessId}@${r.version}`,
          severity: 'info',
          correlationId: ctx.correlationId,
        })
      );
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/deactivate  (W28-C)
  // Drain a version: new submissions no longer target it. In-flight work and
  // existing claims/queue routing stay routable via the operation pin.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/deactivate$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      // R3-01: drain + ledger INSERT share one transaction.
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.deactivateVersion(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), client),
        (r) => ({
          // W48-C1: platform-global audit row. `business.drain` is the wire
          // kind the renderer knows (AUDIT_KIND_META); the route keeps the
          // `deactivate` name (W28-C) — no wire/route rename here.
          tenantId: null,
          actor: 'admin',
          action: 'business.drain',
          resource: `business:${r.businessId}@${r.version}`,
          severity: 'warning',
          correlationId: ctx.correlationId,
        })
      );
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Admin: POST /api/v1/admin/profile-bindings  (P2-02/R08-02, W13-C)
  // Append an immutable profile revision for an API key. Body carries the
  // raw `apiKey` (hashed server-side, never stored raw) plus (business,
  // version, action) and the slot → { connectorId, revision } pin map.
  if (method === 'POST' && pathname === '/api/v1/admin/profile-bindings') {
    // ADM-BASE-02 mutation scope: a tenant operator may bind ONLY keys of
    // its own tenant — the target tenant is derived from the credential
    // + resolved key row, never from caller choice. Foreign target: 403
    // PERMISSION_DENIED (explicit mutation, identical message for every
    // foreign tenant). Unknown/inactive key keeps the pre-existing 404.
    const bindingsPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!bindingsPrincipal) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
    }
    const body = ctx.body as Record<string, unknown>;
    if (typeof body?.apiKey !== 'string' || !body.apiKey) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'apiKey is required');
    }
    const rawApiKey = body.apiKey;
    if (bindingsPrincipal.role === 'tenant_operator') {
      // OIDC-03 (cycle 96): api-key credential grants are ADMIN-ONLY even
      // for a tenant-scoped bearer — an operator may not bind keys, not
      // even its own tenant's (supersedes the cycle-82 allowance; the
      // operator's approved admin actions live in the dispatcher table).
      throw new HttpError(403, 'PERMISSION_DENIED', 'apikey credential changes require the platform admin role');
    }
    // The profile-binding event has its own typed identity; this mutation
    // does not create or revoke an API key.
    // Actor is the fixed string 'admin' — the raw bearer / raw apiKey never
    // touches the ledger.
    // R3-01: binding INSERT + ledger INSERT commit in ONE transaction — a
    // failed audit row rolls the granted revision back with it.
    // R2-A priority-5 (review.md cycle 6/6 MEDIUM, retried mutating POST):
    // with an Idempotency-Key/Client-Token header the marker commits in the
    // SAME transaction as revision + audit, so a response-loss retry replays
    // the stored 201 and never writes a second revision or audit row.
    // No header => legacy behavior, byte-for-byte.
    const idemKey = readIdempotencyKey(ctx.headers);
    const outcome = await executeIdempotent(
      ctx.db,
      { key: idemKey, route: 'POST /api/v1/admin/profile-bindings', payloadHash: canonicalPayloadHash(body) },
      async (withMarker) => {
        const result = await auditedMutation(
          ctx.db,
          ctx.audit,
          (client) =>
            ctx.profiles.createRevision(
              {
                profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
                apiKeyHash: hashKey(rawApiKey),
                businessId: body.businessId as string,
                businessVersion: body.businessVersion as string,
                action: body.action as string,
                connectorBindings: body.connectorBindings,
              },
              client
            ),
          (r) => ({
            tenantId: r.tenantId,
            actor: 'admin',
            action: 'profile_binding.bind',
            resource: `apikey:${r.apiKeyId}`,
            severity: 'info',
            correlationId: ctx.correlationId,
          }),
          idemKey ? (client, r) => withMarker(client, { status: 201, body: r }) : undefined
        );
        return { status: 201, body: result };
      }
    );
    return {
      status: outcome.status,
      body: outcome.body,
      headers: outcome.replayed ? { 'idempotent-replay': 'true' } : undefined,
    };
  }

  // Admin: VAULT-03 provider-key credentials — write-only rotate + masked GET.
  // The plaintext value exists ONLY inside the POST body (write-only by
  // contract); responses/audit carry the masked projection. Without an
  // injected workflow (Vault writer + revision store) both routes fail closed.
  {
    const m = /^\/api\/v1\/admin\/connectors\/([^/]+)\/credentials$/.exec(pathname);
    if (m && (method === 'POST' || method === 'GET')) {
      assertAdminAuth(ctx);
      const connectorId = decodeURIComponent(m[1]!);
      if (!ctx.credentialWorkflow) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector credential workflow not configured');
      }
      if (method === 'GET') {
        return { status: 200, body: await ctx.credentialWorkflow.describe(connectorId) };
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const idempotencyKey = readIdempotencyKey(ctx.headers);
      const result = await ctx.credentialWorkflow.rotate({
        connectorId,
        ref: {
          account: String(body.account ?? ''),
          mount: String(body.mount ?? ''),
          path: String(body.path ?? ''),
          key: String(body.key ?? ''),
        },
        value: typeof body.value === 'string' ? body.value : '',
        ...(typeof body.cas === 'number' ? { cas: body.cas } : {}),
        ...(idempotencyKey ? { idempotencyKey, payloadHash: canonicalPayloadHash(body) } : {}),
      });
      return {
        status: result.replayed ? 200 : 201,
        body: result,
        ...(result.replayed ? { headers: { 'idempotent-replay': 'true' } } : {}),
      };
    }
  }

  // Admin: POST /api/v1/admin/operations/sweep-deadlines  (P2-06; test/dev trigger)
  if (method === 'POST' && pathname === '/api/v1/admin/operations/sweep-deadlines') {
    assertAdminAuth(ctx);
    // R3-01: sweep + ledger INSERT share one transaction.
    // R2-A priority-5: same idempotency contract as profile-bindings — a
    // keyed retry replays the stored { timedOut } instead of sweeping twice.
    const idemKey = readIdempotencyKey(ctx.headers);
    const outcome = await executeIdempotent(
      ctx.db,
      { key: idemKey, route: 'POST /api/v1/admin/operations/sweep-deadlines', payloadHash: canonicalPayloadHash(ctx.body) },
      async (withMarker) => {
        const count = await auditedMutation(
          ctx.db,
          ctx.audit,
          (client) => ctx.lifecycle.sweepDeadlines(client),
          () => ({
            // W48-C1: platform-global audit row (sweep spans all tenants —
            // attributing it to one tenant would be dishonest).
            tenantId: null,
            actor: 'admin',
            action: 'operation.deadline',
            resource: 'operations:deadline-sweep',
            severity: 'warning',
            correlationId: ctx.correlationId,
          }),
          idemKey ? (client, c) => withMarker(client, { status: 200, body: { timedOut: c } }) : undefined
        );
        return { status: 200, body: { timedOut: count } };
      }
    );
    return {
      status: outcome.status,
      body: outcome.body,
      headers: outcome.replayed ? { 'idempotent-replay': 'true' } : undefined,
    };
  }

  // Admin: POST /api/v1/admin/actions  (ADM-BASE-02 action dispatcher)
  // Single POST-only entry over the admin mutation surface. Auth:
  // bearer (platform / tenant-operator) first; a shell cookie session
  // only counts when it passes the server CSRF gate. RBAC matrix and
  // zero-side-effect denials live in modules/admin-actions/dispatcher
  // (pure, offline-tested). Non-POST -> 405 (never GET-as-success);
  // unknown action -> 404.
  if (pathname === '/api/v1/admin/actions') {
    adminActionsMethodGuard(method);
    // OIDC-03 order: bearer -> opaque SESSION cookie (when a store is
    // wired) -> legacy self-contained cookie; CSRF state server-computed.
    const actionAuth = await resolveAdminActionAuthAsync(
      ctx.config,
      ctx.headers,
      ctx.config.adminSessionStore
    );
    const body = ctx.body as Record<string, unknown>;
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!action) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'action is required');
    }
    const params =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const result = await dispatchAdminAction(
      {
        db: ctx.db,
        audit: ctx.audit,
        registry: ctx.registry,
        profiles: ctx.profiles,
        lifecycle: ctx.lifecycle,
        runtime: ctx.runtime,
        credentialWorkflow: ctx.credentialWorkflow,
        connectorTest: (connectorId: string) => ctx.connectors.testConnector(connectorId) as unknown as Promise<Record<string, unknown>>,
        hashApiKey: hashKey,
        correlationId: ctx.correlationId,
      },
      actionAuth,
      { action, params, idempotencyKey: readIdempotencyKey(ctx.headers) }
    );
    return { status: result.status, body: { action, ...result.body } };
  }

  // Admin: GET /api/v1/admin/businesses  (ADM-BASE-01)
  // Shell wire-up for the empty-businessId list pane. Bare-array form the
  // business fetcher parses (each item carries its own businessId). One
  // row per business carrying its active version (null when none active).
  if (method === 'GET' && pathname === '/api/v1/admin/businesses') {
    assertAdminAuth(ctx);
    const query = parseAdminResourceListQuery(ctx.searchParams, ADMIN_BUSINESS_LIST_QUERY_PARAMS);
    const page = await listAdminBusinessesPage(ctx.db, query);
    return {
      status: 200,
      body: listPage({
        items: page.rows.map((r) => ({
          businessId: r.business_id,
          version: r.active_version ?? r.version,
          activeVersion: r.active_version,
          status: r.status,
          isActive: r.is_active,
          registeredAt: dateToIso(r.created_at),
          createdAt: dateToIso(r.created_at),
          updatedAt: dateToIso(r.updated_at),
          digest: r.digest,
          queue: r.queue,
        })),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        total: page.total,
        limit: query.limit,
      }),
    };
  }

  // Admin: GET /api/v1/admin/businesses/:id/versions  (ADM-BASE-01)
  // Shell wire-up: `{ businessId, activeVersion, rows: [...] }`. Unknown
  // business → 404 (the fetcher maps it to `not-found`).
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions$/.exec(pathname);
    if (m && method === 'GET') {
      assertAdminAuth(ctx);
      const businessId = decodeURIComponent(m[1]!);
      const query = parseAdminResourceListQuery(ctx.searchParams, ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS);
      const page = await listBusinessVersionPage(ctx.db, businessId, query);
      if (page.total === 0) throw new HttpError(404, 'NOT_FOUND', `business '${businessId}' is not registered`);
      const items = page.rows.map((r) => ({
        businessId: r.business_id,
        version: r.version,
        status: r.status,
        isActive: r.is_active,
        registeredAt: dateToIso(r.created_at),
        createdAt: dateToIso(r.created_at),
        updatedAt: dateToIso(r.updated_at),
        digest: r.digest,
        queue: r.queue,
      }));
      return {
        status: 200,
        body: {
          businessId,
          activeVersion: page.activeVersion,
          ...listPage({
            items,
            nextCursor: page.nextCursor,
            prevCursor: page.prevCursor,
            total: page.total,
            limit: query.limit,
          }),
          rows: items,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName
  // (ADM-BASE-01) Shell wire-up: the fetcher sends `latest`/`new` sentinels.
  // Projected from the registered business manifest (actions + slots);
  // capabilities come from no platform table yet → `[]` (tolerated).
  // Unknown business/version → 404. `/new` returns the same manifest with
  // an empty profileName + revision 0 (blank editor, no stored profile).
  {
    const m = /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      assertAdminAuth(ctx);
      const businessId = decodeURIComponent(m[1]!);
      const versionSeg = decodeURIComponent(m[2]!);
      const nameSeg = decodeURIComponent(m[3]!);
      const manifestRes = versionSeg === 'latest'
        ? await ctx.db.query(
            `SELECT business_id, version, manifest FROM business_versions
             WHERE business_id=$1 AND is_active = true LIMIT 1`,
            [businessId]
          )
        : await ctx.db.query(
            `SELECT business_id, version, manifest FROM business_versions
             WHERE business_id=$1 AND version=$2`,
            [businessId, versionSeg]
          );
      if (!manifestRes.rowCount) {
        throw new HttpError(404, 'NOT_FOUND', `no manifest for '${businessId}@${versionSeg}'`);
      }
      const row = manifestRes.rows[0] as {
        business_id: string; version: string; manifest: { actions?: unknown[] };
      };
      const isNew = nameSeg === 'new';
      return {
        status: 200,
        body: {
          businessId: row.business_id,
          businessVersion: row.version,
          profileName: isNew ? '' : nameSeg,
          revision: 0,
          currentValues: {},
          manifest: { actions: row.manifest?.actions ?? [] },
          capabilities: [],
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/connectors/:id/revisions/:rev  (ADM-BASE-01)
  // Shell wire-up (`latest` sentinel supported). There is NO connector
  // registry table on the platform — Connectors live in the Connector
  // service; the platform only holds configured base URLs
  // (`connectorBaseUrls`) plus the health probe. So: unknown id → 404;
  // known id → honest envelope (adapter 'unknown', empty capabilities,
  // secretSlots [] — secret material NEVER on the wire, state 'disabled'
  // since the platform tracks no revision lifecycle). A real connector
  // revision ledger is a follow-up, not invented data here.
  {
    const m = /^\/api\/v1\/admin\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      assertAdminAuth(ctx);
      const connectorId = decodeURIComponent(m[1]!);
      const revSeg = decodeURIComponent(m[2]!);
      const baseUrls = ctx.config.connectorBaseUrls ?? {};
      const base = baseUrls[connectorId];
      if (!base) throw new HttpError(404, 'NOT_FOUND', `connector '${connectorId}' is not configured`);
      const revision = revSeg === 'latest' ? 1 : parseInt(revSeg, 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new HttpError(404, 'NOT_FOUND', `connector '${connectorId}' revision '${revSeg}' is not on the server`);
      }
      let maskedHost = '';
      try {
        maskedHost = new URL(base).host.replace(/^(.)[^@]*(@)?/, '$1***$2');
      } catch {
        maskedHost = '';
      }
      return {
        status: 200,
        body: {
          connectorId,
          revision,
          adapter: 'unknown',
          endpoint: { kind: 'configured', maskedHost },
          capabilities: [],
          state: 'disabled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          secretSlots: [],
          testResult: null,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/api-keys + /:keyId  (ADM-BASE-01)
  // Shell wire-up: `{ rows, grants, createCopyOnce }`. The raw key is
  // NEVER on the wire — only the stored prefix + id/tenant/status.
  // Grants are projected per key from profile_bindings (display-only;
  // the server remains the authorization authority). createCopyOnce is
  // always null here (copy-once belongs to the POST-create response,
  // which does not exist yet — no create route, no window to report).
  {
    const m = /^\/api\/v1\/admin\/api-keys(?:\/([^/]+))?$/.exec(pathname);
    if (m && method === 'GET') {
      // ADM-BASE-02: accept the tenant-operator bearer as well, but its
      // list is FORCED to its own tenant (foreign ?tenantId= -> 403) and
      // foreign by-id keys are indistinguishable 404. Platform unchanged.
      const keysPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!keysPrincipal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      const keyId = m[1] ? decodeURIComponent(m[1]) : null;

      // W-ADMUX02-EXT-1: the list path now pages in SQL. It used to be
      // `SELECT ... ORDER BY created_at DESC` with NO limit — the whole table
      // read on every request, then filtered in JavaScript — which is exactly
      // what ADM-UX-02 forbids ("không triển khai search bằng cách fetch toàn bộ
      // dữ liệu rồi lọc trong browser"). The tenant scope is a SQL predicate
      // for BOTH principals now, so an operator's foreign ?tenantId= can never
      // reach the wire even as a row that is later dropped.
      if (keyId) {
        const one = await ctx.db.query<Record<string, unknown>>(
          `SELECT id, tenant_id, prefix, status, created_at, updated_at FROM api_keys WHERE id=$1`,
          [keyId]
        );
        if (!one.rowCount) throw new HttpError(404, 'NOT_FOUND', `api key '${keyId}' not found`);
        requireResourceTenant(keysPrincipal, (one.rows[0] as { tenant_id: string }).tenant_id);
        return {
          status: 200,
          body: await buildApiKeyPage(ctx, keysPrincipal, one.rows as unknown as ApiKeyDbRow[], null),
        };
      }

      const query = parseApiKeyListQuery(ctx.searchParams);
      const scope = authorizeAuditTenantRead(keysPrincipal, query.tenantId ?? '');
      if (scope === '') {
        return {
          status: 200,
          body: await buildApiKeyPage(ctx, keysPrincipal, [], query),
        };
      }
      const page = await listApiKeyPage(ctx.db, scope, query);
      return {
        status: 200,
        body: await buildApiKeyPage(ctx, keysPrincipal, page.rows, query, page),
      };
    }
  }

  // Admin: GET/POST /api/v1/admin/crypto-config  (ENC-08-WIRING, Delta 97).
  //
  // GET returns the tenant's crypto configuration as the ENC-08 view model (key REFS,
  // versions and fingerprint PREVIEWS - never key material). POST applies a change
  // through the same handler the unit tests drive, so the wire surface and the tested
  // surface cannot diverge.
  //
  // Authorization: the platform bearer and the tenant-scoped operator bearer both
  // resolve through the shared rbac.ts principal; a COOKIE-authenticated mutation
  // additionally has to present the server-derived CSRF token, because a cross-site
  // page can send the cookie but cannot forge the HMAC.
  //
  // Unconfigured (no `cryptoConfig` block) the route answers 503 rather than pretending
  // a platform has no crypto settings to manage.
  {
    if (pathname === '/api/v1/admin/crypto-config' && (method === 'GET' || method === 'POST')) {
      if (!ctx.cryptoConfig) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'crypto configuration is not enabled');
      }
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      // A cookie session is identified by the SIGNED du_admin cookie, and its role is
      // READ OUT OF THE VERIFIED CLAIMS - never from a request header. A header would
      // be a caller-chosen field, and the whole admin model is that the role comes
      // from the credential (ADM-BASE-02). The handler needs the raw cookie value to
      // re-derive the CSRF token, and the secret to do that.
      const sessionCookie = parseCookieHeader(ctx.headers['cookie'] ?? '')['du_admin'];
      const cookieClaims =
        sessionCookie && ctx.config.adminShellCookieSecret
          ? verifyCookie(ctx.config.adminShellCookieSecret, sessionCookie)
          : null;
      const auth = {
        principal,
        cookieRole: cookieClaims?.role,
        cookieSecret: ctx.config.adminShellCookieSecret,
        sessionCookie,
        csrfToken: ctx.headers['x-csrf-token'],
      };
      if (method === 'GET') {
        const tenant = ctx.searchParams.get('tenantId') ?? '';
        const view = await readCryptoConfig(ctx.cryptoConfig, {
          auth,
          tenantId: tenant === '' ? undefined : tenant,
        });
        return {
          status: 200,
          body: { schemaVersion: '1', tenantId: view.tenantId, crypto: view },
        };
      }
      const body = (ctx.body ?? {}) as {
        tenantId?: unknown;
        storageKeyRef?: unknown;
        deliveryEncryption?: unknown;
        recipientKeyVersion?: unknown;
      };
      if (typeof body.deliveryEncryption !== 'boolean' && body.deliveryEncryption !== undefined) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'deliveryEncryption must be a boolean');
      }
      if (
        body.recipientKeyVersion !== undefined
        && body.recipientKeyVersion !== null
        && typeof body.recipientKeyVersion !== 'number'
      ) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'recipientKeyVersion must be a number or null');
      }
      if (body.storageKeyRef !== undefined && typeof body.storageKeyRef !== 'string' && body.storageKeyRef !== null) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'storageKeyRef must be a string or null');
      }
      // The tenant is the same fact on both verbs, so both read it the same
      // way: the query parameter, with the body as a fallback for form posts.
      const queryTenant = ctx.searchParams.get('tenantId') ?? '';
      const bodyTenant = typeof body.tenantId === 'string' ? body.tenantId : '';
      const targetTenant = bodyTenant !== '' ? bodyTenant : queryTenant;
      const result = await applyCryptoConfig(ctx.cryptoConfig, {
        auth,
        tenantId: targetTenant === '' ? undefined : targetTenant,
        mutation: {
          storageKeyRef: body.storageKeyRef as string | null | undefined,
          deliveryEncryption: body.deliveryEncryption as boolean | undefined,
          recipientKeyVersion: body.recipientKeyVersion as number | null | undefined,
        },
      });
      return {
        status: 200,
        body: {
          schemaVersion: '1',
          tenantId: result.change.tenantId,
          changedFields: result.change.fields,
          crypto: result.view,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/audit  (ADM-BASE-01, ADM-UX-02 extension
  // W-ADMUX02-EXT-1). Reads the REAL ledger (migration 0010 admin_audit_events)
  // with a tenant predicate, an allow-listed `severity`/`action` filter and a
  // keyset cursor, and answers the standard five-field page envelope
  // { items, nextCursor, prevCursor, total, limit } — the { tenantId, events }
  // shape it used to return is gone, so the overview fetcher reads `items`
  // (and still tolerates `events` from an older build mid-rollout). Events whose
  // tenant_id is NULL (platform-global: business enable/activate/drain,
  // deadline sweep) never match a tenant predicate — they belong to a future
  // platform-wide admin view, not to any single tenant's pane.
  if (method === 'GET' && pathname === '/api/v1/admin/audit') {
    // R3-02: the requested tenant is AUTHORIZED, not trusted. The scope
    // comes from the authenticated credential (platform bearer → any
    // tenant, the operator-console view; tenant bearer → exactly its own
    // tenant, 403 on foreign scope), never from the query param alone.
    const principal = resolveAdminAuditPrincipal(ctx.config, ctx.headers['authorization']);
    const query = parseAdminAuditListQuery(ctx.searchParams);
    // ADM-BASE-02 / R3-02 unchanged in force: the SCOPE comes from the
    // credential, never from the parameter. A platform principal may narrow to
    // any tenant; a tenant operator is pinned to its own tenant and 403s on a
    // foreign one, with identical wording for foreign and unknown ids.
    const scope = authorizeAuditTenantRead(principal, query.tenantId ?? '');
    // No tenant selected → no tenant-scoped events: an honest empty page, kept
    // from the pre-ledger behaviour. Platform-global rows carry a NULL tenant
    // and belong to a future platform-wide view, not to any tenant's pane.
    if (scope === '') {
      return {
        status: 200,
        body: listPage({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: query.limit }),
      };
    }
    return {
      status: 200,
      body: await listAuditEventPage(ctx, scope, query),
    };
  }

  return { status: 404, body: { type: 'urn:du:error:not_found', title: 'not found', status: 404, code: 'NOT_FOUND' } };
}

function assertRuntimeAuth(ctx: RouteContext): string | undefined {
  const auth = ctx.headers['authorization'] ?? '';
  if (!isAuthorizedRuntimeBearer(ctx.config, auth)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid runtime bearer token');
  }
  return resolveWorkerBusinessIdentity(ctx.config, auth) ?? undefined;
}

function assertPlatformRuntimeAuth(ctx: RouteContext): void {
  const auth = ctx.headers['authorization'] ?? '';
  if (isAuthorizedPlatformRuntimeBearer(ctx.config, auth)) return;
  if (resolveWorkerBusinessIdentity(ctx.config, auth)) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker credentials cannot register business versions');
  }
  throw new HttpError(401, 'UNAUTHENTICATED', 'invalid platform runtime bearer token');
}

async function assertTaskRuntimeAuth(ctx: RouteContext, taskId: string): Promise<string | undefined> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return undefined; // platform runtime identity
  const res = await ctx.db.query<{ business_id: string }>(
    `SELECT o.business_id FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE t.id=$1`,
    [taskId]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', 'task not found');
  authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], res.rows[0]!.business_id);
  return workerBusinessId;
}

async function assertArtifactRuntimeAuth(ctx: RouteContext, artifactId: string): Promise<void> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return; // platform runtime identity
  const res = await ctx.db.query<{ business_id: string }>(
    `SELECT o.business_id FROM artifacts a JOIN operations o ON o.id=a.operation_id WHERE a.id=$1`,
    [artifactId]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', 'artifact not found');
  authorizeWorkerBusiness(ctx.config, ctx.headers['authorization'], res.rows[0]!.business_id);
}

async function assertBodyTaskRuntimeAuth(ctx: RouteContext): Promise<void> {
  const workerBusinessId = assertRuntimeAuth(ctx);
  if (!workerBusinessId) return; // platform runtime identity
  const taskId = (ctx.body as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker artifact access requires an owned task');
  }
  await assertTaskRuntimeAuth(ctx, taskId);
}

function assertAdminAuth(ctx: RouteContext) {
  // Admin and runtime credentials are distinct (R08-01). The fail-closed
  // default denies every admin request when no admin token is configured;
  // the runtime token never substitutes.
  if (!ctx.config.adminToken) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
  }
  const auth = ctx.headers['authorization'] ?? '';
  if (auth !== `Bearer ${ctx.config.adminToken}`) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid admin bearer token');
  }
}

// ADM-BASE-02 / R3-02 / cycle-84: the admin authorization primitives now
// live in src/modules/admin-actions/rbac.ts (the single source consulted
// by both the HTTP routes below and the action dispatcher). They are
// re-exported here so the server.ts public surface is unchanged.
export {
  ADMIN_SESSION_COOKIE,
  authorizeAuditTenantRead,
  authorizeBindingTenant,
  deriveCsrfToken,
  requireResourceTenant,
  resolveAdminAuditPrincipal,
  resolveAdminPrincipal,
  validateCsrfToken,
  type AdminActionAuth,
  type AdminAuditPrincipal,
  type AdminPrincipal,
} from './modules/admin-actions/rbac';

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

// ADM-BASE-02: the former non-throwing isAdminAuthed() check is replaced
// by resolveAdminPrincipal() on every shared fetcher URL (usage,
// operations list, operations detail) — same fall-through to the
// x-api-key path on null, plus the tenant-operator scope.

// ---------------------------------------------------------------------------
// ADM-UX-02: GET /api/v1/operations query + cursor contract
// ---------------------------------------------------------------------------

/**
 * The operations list is an ALLOWLIST, not a free-form query: the six names
 * in `OPERATIONS_LIST_QUERY_PARAMS`, each with its own validator, every value
 * bound to a `$n` placeholder. No caller-supplied text is ever concatenated
 * into SQL — the only interpolated fragments are the predicate TEMPLATES
 * below, which contain no user data. The sort key is one of the SIX literal
 * fragments the route assembles from the validated field and direction, so
 * offering a sort adds no `ORDER BY`-injection surface either.
 *
 * Bounds, the state enum and its wire expansion all come from @du/contracts
 * (W-CONTRACT-ALIGN-1). The names below are re-exported for the existing
 * call sites and tests; they are aliases, not a second definition.
 */
export const OPERATIONS_LIST_DEFAULT_LIMIT = OPERATIONS_LIST_LIMIT_DEFAULT;
export const OPERATIONS_LIST_MAX_LIMIT = OPERATIONS_LIST_LIMIT_MAX;
/** Opaque cursors stay short enough to ride in a URL and a log line. */
export const OPERATIONS_LIST_CURSOR_MAX_LEN = LIST_CURSOR_MAX_LEN;

export type { OperationsStateFilter } from '@du/contracts';

/** The cursor's id part is compared against the `operations.id uuid` column. */
const OPERATIONS_LIST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UI enum → concrete wire states comes from @du/contracts
 * (`OPERATIONS_STATE_FILTER_WIRE_STATES`), the same map the admin shell reads
 * for its client-side defence-in-depth filter, so the predicate and the
 * filter can no longer accept different row sets.
 */

export interface OperationsListCursor {
  /**
   * Canonical ISO-8601 instant (`Date#toISOString` round-trip checked).
   *
   * The token slot is named for the column it was born with, and it carries
   * that column's value for every request that does not ask for a sort — which
   * is all traffic predating W-ADMUX02-SORT-ALLOWLIST-1, so old links page
   * exactly as before. Under an explicit sort it holds the BOUNDARY ROW'S
   * VALUE OF THAT SORT KEY instead (see operationsListBoundaryKey): the token
   * stays a position in the ordering the next request walks, which is what a
   * keyset cursor means. Since T140-A1 the token also NAMES that key in its
   * own ordering slot, so the field name no longer has to carry the
   * disambiguation — and renaming the slot would churn a wire token the
   * reviewer already accepted live for no behavioural gain.
   */
  createdAt: string;
  /** Lowercase uuid. */
  id: string;
  /** Walk direction; encoded in the token so one `?cursor=` serves both hops. */
  direction: OperationsListDirection;
  /**
   * The ORDERING this position belongs to, carried in the token since
   * T140-A1. A keyset boundary is only meaningful inside one order: the same
   * `(key, id)` pair sits at a different place in every sort, so replaying a
   * `created_at` cursor against `deadline_at` would page from a position the
   * deadline ordering never passes through — silently dropping or repeating
   * rows with a 200 and a plausible-looking page. The route therefore refuses
   * a cursor whose ordering is not the requested one, instead of reading the
   * wrong slice of the keyset.
   *
   * A token minted before the sort parameter existed carries no ordering and
   * decodes as the default one, which is the only order it could ever have
   * named: see decodeOperationsListCursor.
   */
  sort: OperationsListSort;
}

export interface OperationsListQuery {
  limit: number;
  cursor: OperationsListCursor | null;
  stateFilter: OperationsStateFilter;
  /** Exact tenant id, or null for "every tenant this principal may read". */
  tenantId: string | null;
  /** Case-insensitive operation-id substring, or null. */
  idContains: string | null;
  /**
   * The ORDER BY key, already resolved against the contract's allow-list. Never
   * absent: a missing `?sort=` is `created_at:desc`, the order this route had
   * before the parameter existed.
   */
  sort: OperationsListSort;
}

/**
 * Which way a keyset cursor walks the `(<sort key>, id)` sort. Carried
 * INSIDE the token (see decodeOperationsListCursor) because the route exposes
 * a single `?cursor=` parameter.
 */
export type OperationsListDirection = 'next' | 'prev';

/**
 * Opaque, URL-safe keyset cursor over `(<sort key>, id)`.
 *
 * The payload is `<canonical ISO>|<uuid>|<field>:<direction>[|p]`: a position
 * PLUS the ordering it is a position in. Both halves are needed — the same
 * `(key, id)` pair is a different page boundary in every sort, so a bare
 * position replayed under another ordering reads the wrong slice of the
 * keyset (Reviewer T140-A1). `keyValue` is therefore the boundary row's value
 * OF THE SORT KEY, not its created_at, and `sort` names which key that was.
 *
 * Built by concatenation rather than one template so the separator literals
 * stay visible next to the decoder's `split('|')`.
 */
function encodeOperationsListCursor(
  keyValue: string | Date,
  id: string,
  sort: OperationsListSort,
  direction: OperationsListDirection = 'next'
): string {
  const ts = new Date(keyValue).toISOString();
  const dir = direction === 'prev' ? '|p' : '';
  return Buffer.from(`${ts}|${id}|${formatOperationsListSort(sort)}${dir}`, 'utf8').toString('base64url');
}

/**
 * Strict cursor decode: base64url →
 * `<canonical ISO>|<uuid>|<field>:<direction>[|p]`.
 *
 * The third slot is the ordering the position belongs to (Reviewer T140-A1);
 * see the encoder for why a position without one cannot be trusted.
 *
 * Legacy tokens are still decoded, which is what keeps every link written
 * before the sort parameter existed working: `<ISO>|<uuid>` and `<ISO>|<uuid>
 * |p` carry no ordering slot and read as the default `created_at:desc` — the
 * only order they could ever have named, because no other order existed. That
 * is also why the walk marker is read as its own part rather than as a suffix
 * of another slot: `p` is not a legal `field:direction`, so the two shapes
 * cannot be confused.
 *
 * The instant must round-trip through `toISOString()` unchanged, so whatever
 * is bound to `::timestamptz` is always a real ISO instant and never a partial
 * date that Postgres would reinterpret in the server's local zone.
 *
 * The trailing `|p` marks a BACKWARD cursor. The route is one endpoint, and
 * the UI can only send `?cursor=<token>` — it has no second parameter to say
 * which way to walk — so the direction has to travel inside the token. Without
 * it a previous-page link is silently a forward page: the row above the
 * boundary is unreachable by a forward-only keyset query, so the operator
 * would get the same page again instead of the previous one.
 */
function decodeOperationsListCursor(raw: string): OperationsListCursor | null {
  if (raw.length === 0 || raw.length > OPERATIONS_LIST_CURSOR_MAX_LEN) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const parts = text.split('|');
  if (parts.length < 2 || parts.length > 4) return null;
  const createdAt = parts[0] ?? '';
  const id = parts[1] ?? '';
  const tail = parts.slice(2);
  let direction: OperationsListDirection = 'next';
  if (tail.length > 0 && tail[tail.length - 1] === 'p') {
    direction = 'prev';
    tail.pop();
  }
  // What is left after the walk marker is the ordering slot, and there is
  // exactly one legal shape for each case: one slot names a sort, no slot is
  // a token minted before the sort parameter existed (read as the default
  // ordering, the only one it could ever have named), anything else — two
  // slots, an empty slot, an unknown `field:direction` — is not a position
  // this route produced.
  let sort: OperationsListSort;
  if (tail.length === 0) {
    sort = {
      field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
      direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
    };
  } else if (tail.length === 1) {
    const bound = parseOperationsListSort(tail[0] ?? '');
    if (!bound) return null;
    sort = bound;
  } else {
    return null;
  }
  if (!OPERATIONS_LIST_UUID.test(id)) return null;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== createdAt) return null;
  return { createdAt, id: id.toLowerCase(), direction, sort };
}

/**
 * A read view over the query string that CANNOT address a name outside the
 * contract's allow-list: the parameter type is the contract array's element
 * type, so `read('sort')` is a compile error. This seam exists because a
 * runtime test can prove a declared parameter is honoured, but it cannot
 * cheaply prove the route reads nothing else — mutation-testing the second
 * direction showed exactly that gap (an unbound `params.get('sort')` passed
 * every conformance assertion). Making the raw URLSearchParams unavailable to
 * the parser turns "the route grew a parameter the schema does not declare"
 * from an undetected behaviour change into something that will not build.
 */
export interface AllowListedQuery {
  read(name: OperationsListQueryParam): string | null;
}

export function parseOperationsListQuery(params: URLSearchParams): OperationsListQuery {
  // The one place the raw query string is touched; everything below sees only
  // the allow-listed view, so this function cannot gain a parameter quietly.
  return parseAllowListedOperationsListQuery({ read: (name) => params.get(name) });
}

/**
 * Parse + validate the allow-listed query. Throws 422 INVALID_SCHEMA on any
 * value the contract does not define, nor a cursor that belongs to another
 * sort — an unparseable filter is reported, never silently ignored, so a
 * caller can never believe a filter applied when it did not. `limit` is the one exception: it clamps like every other
 * list route in this file.
 */
function parseAllowListedOperationsListQuery(query: AllowListedQuery): OperationsListQuery {
  const want = (name: OperationsListQueryParam): string | null => query.read(name);
  const rawLimit = want('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(OPERATIONS_LIST_MAX_LIMIT, Math.max(1, parsedLimit))
    : OPERATIONS_LIST_DEFAULT_LIMIT;

  const rawState = want('state');
  let stateFilter: OperationsStateFilter = 'ALL';
  if (rawState !== null && rawState.trim().length > 0) {
    const candidate = rawState.trim().toUpperCase();
    if (!(OPERATIONS_STATE_FILTER_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `state must be one of ${OPERATIONS_STATE_FILTER_VALUES.filter((v) => v !== 'ALL').join(', ')}`
      );
    }
    stateFilter = candidate as OperationsStateFilter;
  }

  const tenantId = sanitizeOperationsListToken(want('tenant'), 'tenant');
  const idContains = sanitizeOperationsListToken(want('id'), 'id');
  const sort = parseOperationsListSortParam(want('sort'));

  const rawCursor = want('cursor');
  let cursor: OperationsListCursor | null = null;
  if (rawCursor !== null && rawCursor.length > 0) {
    const decoded = decodeOperationsListCursor(rawCursor);
    if (!decoded) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid operations list cursor');
    }
    // A keyset cursor is a position IN AN ORDERING, so it only means anything
    // against the ordering it was minted for (Reviewer T140-A1): the boundary
    // row sits somewhere else in every other sort, and walking from a position
    // that ordering never passes through skips or repeats rows behind a 200
    // with a plausible-looking page. Rejected, not reinterpreted.
    //
    // Rejected rather than ignored on purpose: a caller that sends a cursor
    // with a new sort asked to continue paging, and quietly answering with
    // page 1 of the new order reads as a loop to the caller and as a normal
    // page to the operator. The error names the remedy instead.
    if (decoded.sort.field !== sort.field || decoded.sort.direction !== sort.direction) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `cursor was issued for sort=${formatOperationsListSort(decoded.sort)} and cannot page sort=${formatOperationsListSort(sort)}; drop the cursor parameter to start this ordering at its first page`
      );
    }
    cursor = decoded;
  }

  return { limit, cursor, stateFilter, tenantId, idContains, sort };
}

/**
 * Resolve `?sort=` against the contract allow-list.
 *
 * Absent or empty is the default (created_at:desc), so every URL written before
 * this parameter existed keeps its exact behaviour. Anything else that is not
 * one of the six advertised values is a 422 — never a silent fallback to the
 * default, because an operator who asked for oldest-first and got newest-first
 * would read the list as if it were oldest-first. That is the same
 * report-don't-ignore rule the state/tenant/id filters already follow, and it
 * reuses the contract's own parser so the published schema and the route
 * cannot disagree about what a legal sort is.
 */
function parseOperationsListSortParam(raw: string | null): OperationsListSort {
  if (raw === null || raw.trim().length === 0) {
    return {
      field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
      direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
    };
  }
  const parsed = parseOperationsListSort(raw);
  if (!parsed) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${OPERATIONS_LIST_SORT_VALUES.join(', ')}`
    );
  }
  return parsed;
}

function sanitizeOperationsListToken(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!isOperationsListFilterToken(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} is not an accepted filter value`);
  }
  return value;
}

/** `WHERE …` for a predicate list, or '' when there is nothing to filter. */
function whereClause(clauses: readonly string[]): string {
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

interface OperationsListPredicates {
  clauses: string[];
  params: unknown[];
}

/**
 * Build the filter predicates. `tenantId` is the CALLER's effective scope
 * (null = cross-tenant for a platform principal) and wins over the query's
 * own `tenant`, so the credential — never a parameter — decides the fence.
 */
function buildOperationsListPredicates(
  query: OperationsListQuery,
  tenantId: string | null
): OperationsListPredicates {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (tenantId !== null) clauses.push(`tenant_id = ${bind(tenantId)}`);
  if (query.stateFilter !== 'ALL') {
    clauses.push(`state = ANY(${bind(OPERATIONS_STATE_FILTER_WIRE_STATES[query.stateFilter])}::text[])`);
  }
  if (query.idContains !== null) {
    // strpos(), not LIKE: the token's character class admits '_', which is a
    // LIKE single-character wildcard. A substring search must not acquire
    // wildcard semantics from an operator's typing.
    clauses.push(`strpos(lower(id::text), lower(${bind(query.idContains)})) > 0`);
  }
  return { clauses, params };
}

/* ------------------------------------------------------------------ */
/* ADM-UX-02 sort (W-ADMUX02-SORT-ALLOWLIST-1): the ORDER BY key        */
/* ------------------------------------------------------------------ */

/**
 * ORDER BY column per allow-listed field. A LOOKUP keyed by the already
 * validated field, so the column name in the SQL text is one of these three
 * literals and the caller's text is never SQL text — same discipline the
 * filters follow (templates interpolate, values bind).
 */
const OPERATIONS_LIST_SORT_COLUMN_SQL: Readonly<Record<OperationsListSortField, string>> = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  deadline_at: 'deadline_at',
};

/**
 * The fields whose column 0001_platform_v1.sql declares NULLABLE. Their key is
 * COALESCEd over a sentinel literal before it is ordered or compared, because a
 * row-value predicate is never TRUE against NULL: without this, ORDER BY
 * deadline_at would answer page 1 correctly and then LOSE every deadline-less
 * operation from page 2 onward — silently, with a 200 and a page that looks
 * plausible. Most operations have no deadline, so that is not an edge case.
 */
const OPERATIONS_LIST_NULLABLE_SORT_FIELDS: ReadonlySet<OperationsListSortField> = new Set<
  OperationsListSortField
>(['deadline_at']);

/**
 * The sentinel a NULL key takes, chosen so the NULL block always lands at the
 * END of the ordering: the earliest representable instant when the key walks
 * down, the latest when it walks up. Both are real ISO instants that survive a
 * toISOString() round-trip, which the strict cursor decoder demands — Postgres'
 * own +/-infinity do not, and no operation of this platform can ever collide
 * with year 1 or year 9999. One map serves both halves of the contract: the
 * literal the ORDER BY embeds (bindOperationsListSortKey, which must match the
 * 0019 index expressions byte for byte) and the value a cursor carries for a
 * NULL key (operationsListBoundaryKey).
 */
const OPERATIONS_LIST_NULL_SORT_BOUND_SQL: Readonly<Record<OperationsListSortDirection, string>> = {
  desc: '0001-01-01T00:00:00.000Z',
  asc: '9999-12-31T23:59:59.999Z',
};

/** The two ORDER BY direction literals. */
const OPERATIONS_LIST_SORT_SQL_DIRECTION: Readonly<
  Record<OperationsListSortDirection, 'ASC' | 'DESC'>
> = {
  asc: 'ASC',
  desc: 'DESC',
};

/**
 * The ORDER BY key expression for a validated sort. A nullable column gets its
 * sentinel written into the SQL as a quoted `::timestamptz` literal rather than
 * bound as a `$n`, because migration 0019 indexes the expression
 * COALESCE(deadline_at, '<sentinel>'::timestamptz) and the planner matches an
 * expression index only against the same Const node: a Param bound to this very
 * instant is a different node, so the parameterised form ordered through a Sort
 * over a Seq Scan and left all four 0019 indexes as dead code (T-35, reconfirmed
 * by the W-INGEST-0019-2 review). This is not the interpolation surface caller
 * text would be — the value comes from a compile-time constant keyed by the
 * already-validated direction. The cursor predicate reuses this one string, so
 * ORDER BY and keyset boundary cannot diverge, and because no param is consumed
 * here the filter placeholders keep the positions the conformance tests pin.
 */
function bindOperationsListSortKey(sort: OperationsListSort): string {
  const column = OPERATIONS_LIST_SORT_COLUMN_SQL[sort.field];
  if (!OPERATIONS_LIST_NULLABLE_SORT_FIELDS.has(sort.field)) return column;
  const sentinel = OPERATIONS_LIST_NULL_SORT_BOUND_SQL[sort.direction];
  return `COALESCE(${column}, '${sentinel}'::timestamptz)`;
}

/**
 * The value the cursor carries for a row: its sort key, with a NULL in a
 * nullable column replaced by the SAME sentinel bindOperationsListSortKey
 * coalesces it to. The two must agree — a cursor holds a position in the
 * ordering the next request walks, and a position the SQL itself never
 * produces would page from nowhere.
 */
function operationsListBoundaryKey(
  row: Record<string, unknown>,
  sort: OperationsListSort
): string | Date {
  const value = row[OPERATIONS_LIST_SORT_COLUMN_SQL[sort.field]];
  if (value === null || value === undefined) {
    return OPERATIONS_LIST_NULL_SORT_BOUND_SQL[sort.direction];
  }
  return value as string | Date;
}

/**
 * The keyset predicate for `cursor`, or null when there is no cursor. Returns a
 * bare predicate and NOT a joined clause on purpose: the caller folds it into
 * `whereClause` together with the filters, because that is the only place that
 * can know whether a `WHERE` keyword is still owed. Appending ` AND …` to a
 * `SELECT … FROM operations` that had no filters produced `FROM operations AND
 * (…)` — a syntax error against Postgres, invisible offline because a fake db
 * never parses SQL (see the T140-A1 receipt).
 *
 * `sortKeySql` is the expression the ORDER BY uses, so the boundary is compared
 * against the SAME expression the rows were ordered by — comparing one
 * expression while ordering by another is how a keyset page skips rows.
 */
function bindOperationsCursor(
  cursor: OperationsListCursor | null,
  params: unknown[],
  sortKeySql: string,
  descending: boolean
): string | null {
  if (!cursor) return null;
  params.push(cursor.createdAt, cursor.id);
  // Forward walks toward the tail of the chosen order: DOWN the key for a desc
  // sort, UP it for an asc one. A backward cursor takes the other side of the
  // boundary row, which is the opposite test in both directions.
  const op = descending === (cursor.direction === 'prev') ? '>' : '<';
  return `(${sortKeySql}, id) ${op} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}

/**
 * Keyset page over `(<sort key>, id)`, the sort key defaulting to
 * `created_at DESC`. OFFSET paging would skip or repeat
 * rows whenever a new operation is created between two page requests; the
 * cursor does not, because inserts land strictly above a forward boundary and
 * are simply outside this page's window.
 *
 * Two bounded statements per request: a `limit + 1` page probe (the extra row
 * is the only evidence of a next page) and a `count(*)` over the FILTERED
 * population. The sort never reaches the count: reordering a population does
 * not change how large it is, and `total` is advertised as its size.
 *
 * Both directions share the one `?cursor=` parameter. A forward cursor walks to
 * the far side of the boundary in the requested order; a backward cursor
 * (marked `|p`) scans the REVERSED order and the rows on the near side, so
 * LIMIT lands on the block adjacent to the boundary rather than the far end of
 * the population, and the slice is reversed to restore the requested order.
 * Both cursors of a page are therefore derived from the SAME two probe rows:
 * nextCursor from the page's last row, prevCursor from its first.
 */
async function listOperationsPage(
  ctx: RouteContext,
  query: OperationsListQuery,
  tenantId: string | null,
  project: (row: Record<string, unknown>) => Record<string, unknown>
): Promise<Record<string, unknown>> {
  const filters = buildOperationsListPredicates(query, tenantId);
  const filtersWhere = whereClause(filters.clauses);
  const sort = query.sort;
  const descending = sort.direction === 'desc';
  const backwards = query.cursor?.direction === 'prev';

  const pageParams = [...filters.params];
  // Resolved BEFORE the predicate so both clauses name the same key expression
  // (and the same inline sentinel): ordering by one expression while comparing
  // against another is exactly how a keyset page skips rows.
  const sortKeySql = bindOperationsListSortKey(sort);
  const cursorPredicate = bindOperationsCursor(query.cursor, pageParams, sortKeySql, descending);
  // The filters and the keyset boundary are ONE where list: only here can the
  // statement tell whether the WHERE keyword is still owed. Concatenating
  // operations + filters + a predicate that opens with AND produced
  // FROM operations AND (...) — an unparseable statement — precisely when an
  // operator paged the cross-tenant admin list with no filter set, which is
  // the ordinary case of pressing Next on an unfiltered page.
  const pageWhere = whereClause(
    cursorPredicate ? [...filters.clauses, cursorPredicate] : filters.clauses
  );
  pageParams.push(query.limit + 1);
  // A backward page scans the REVERSED order so LIMIT selects the rows ADJACENT
  // to the boundary; keeping the primary order would grab the far end of the
  // population and silently skip a page. The slice is reversed afterwards, so
  // every page renders in the order the operator asked for. The id tiebreak
  // always follows the key — without it, rows sharing an instant (or sharing a
  // NULL deadline) have no defined order to page through.
  const scanDirection =
    descending !== backwards
      ? OPERATIONS_LIST_SORT_SQL_DIRECTION.desc
      : OPERATIONS_LIST_SORT_SQL_DIRECTION.asc;
  const page = await ctx.db.query(
    `SELECT * FROM operations${pageWhere} ORDER BY ${sortKeySql} ${scanDirection}, id ${scanDirection} LIMIT $${pageParams.length}`,
    pageParams
  );
  const rows = page.rows as Record<string, unknown>[];
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  if (backwards) pageRows.reverse();

  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeOperationsListCursor(
          operationsListBoundaryKey(lastRow, sort),
          lastRow['id'] as string,
          sort
        )
      : null;

  // Previous page. A keyset cursor is a POSITION, not a page, so the
  // previous page cannot be fetched by looking up "the row above": it is the
  // `limit` rows strictly NEWER than this page's FIRST row, taken in ASC
  // order so LIMIT selects the block ADJACENT to the boundary (DESC here
  // would pick the newest rows above and silently skip a page). The probe row
  // is the anchor for that reverse hop, so its key is the prevCursor.
  let prevCursor: string | null = null;
  const firstRow = pageRows[0];
  // A page above exists iff a row strictly newer than this page's first row
  // exists. A forward arrival always has one (it came from there). A backward
  // arrival only has one when the ASC probe saw a `limit + 1`-th row — that
  // row is newer than everything this page returned, so it is the top of
  // another page. Without this, walking up from page 1 would render a
  // "Previous" link pointing at the page the operator is already on.
  const hasPageAbove = backwards ? hasMore : query.cursor !== null;
  if (firstRow && hasPageAbove) {
    // Marked 'prev' so the follow-up request walks back over the boundary.
    prevCursor = encodeOperationsListCursor(
      operationsListBoundaryKey(firstRow, sort),
      firstRow['id'] as string,
      sort,
      'prev'
    );
  }

  const counted = await ctx.db.query(
    `SELECT count(*)::int AS total FROM operations${filtersWhere}`,
    filters.params
  );
  const total = Number((counted.rows[0] as { total?: number | string } | undefined)?.total ?? 0);

  // Built through the contract helper, so a producer cannot drop a field from
  // the page envelope the way `pageOf` used to advertise a two-field page.
  return operationsListPage({
    items: pageRows.map((row) => project(row)),
    nextCursor,
    prevCursor,
    total,
    limit: query.limit,
  }) satisfies OperationsListPage;
}

/* ------------------------------------------------------------------ */
/* ADM-UX-02 extension (W-ADMUX02-EXT-1): audit + api-keys list pages  */
/* ------------------------------------------------------------------ */

interface AdminAuditListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  tenantId: string | null;
  severity: string | null;
  action: string | null;
  actor: string | null;
  resource: string | null;
  from: string | null;
  to: string | null;
  sort: AdminAuditListSort;
}

/**
 * Allow-list parser for GET /api/v1/admin/audit. Same discipline as the
 * operations list: the parameter NAMES come from the contract array, an
 * unrecognised value is a 422 rather than a silently dropped filter, and a
 * tenant id must be a uuid so it can never be a raw credential or a path.
 */
function parseAdminAuditListQuery(params: URLSearchParams): AdminAuditListQuery {
  const read = (name: AdminAuditListQueryParam): string | null => params.get(name);

  const rawLimit = read('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(ADMIN_LIST_LIMIT_MAX, Math.max(1, parsedLimit))
    : ADMIN_LIST_LIMIT_DEFAULT;

  const tenantRaw = read('tenantId');
  const tenantId = tenantRaw === null || tenantRaw.trim().length === 0 ? null : tenantRaw.trim();
  if (tenantId !== null && !UUID_PARAM_PATTERN.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a uuid');
  }

  const severityRaw = read('severity');
  let severity: string | null = null;
  if (severityRaw !== null && severityRaw.trim().length > 0) {
    const candidate = severityRaw.trim().toLowerCase();
    if (!(AUDIT_SEVERITY_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `severity must be one of ${AUDIT_SEVERITY_VALUES.join(', ')}`
      );
    }
    severity = candidate;
  }

  const action = sanitizeAdminListToken(read('action'), 'action');
  const actor = sanitizeAdminListToken(read('actor'), 'actor');
  const resource = sanitizeAdminListToken(read('resource'), 'resource');

  const from = parseAdminListTimeBound(read('from'), 'from');
  const to = parseAdminListTimeBound(read('to'), 'to');
  // An inverted window is a client mistake, not an empty ledger: silently
  // answering a zero-page would read as "nothing happened in that range".
  if (from !== null && to !== null && from > to) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'from must not be after to');
  }

  const rawSort = read('sort');
  const sortValue = rawSort === null || rawSort.trim() === ''
    ? ADMIN_AUDIT_LIST_SORT_DEFAULT
    : rawSort.trim();
  if (!(ADMIN_AUDIT_LIST_SORT_VALUES as readonly string[]).includes(sortValue)) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${ADMIN_AUDIT_LIST_SORT_VALUES.join(', ')}`
    );
  }
  const sort = sortValue as AdminAuditListSort;

  const cursorRaw = read('cursor');
  let cursor: AdminResourceListSortCursor | null = null;
  if (cursorRaw !== null && cursorRaw.length > 0) {
    cursor = decodeAdminResourceListSortCursor(cursorRaw, LIST_CURSOR_MAX_LEN);
    if (!cursor) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid sortable list cursor');
    }
    if (cursor.sort !== sort) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor was issued for a different sort; drop cursor to restart the list');
    }
  }

  return { limit, cursor, tenantId, severity, action, actor, resource, from, to, sort };
}

/**
 * A time bound is a UTC instant or it is a 422. `isAdminListTimeBound` also
 * rejects a well-shaped but non-existent date, which the pattern alone lets
 * through because Date.parse rolls 2026-02-30 over into March.
 */
function parseAdminListTimeBound(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!isAdminListTimeBound(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} must be a UTC instant such as 2026-09-28T00:00:00Z`);
  }
  return value;
}

function sanitizeAdminListToken(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  // The shared token class already refuses solid 32+ hex, so a pasted API
  // secret cannot become a search term on any admin list.
  if (!isOperationsListFilterToken(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} is not an accepted filter value`);
  }
  return value;
}

const UUID_PARAM_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApiKeyDbRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  prefix: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface AdminResourceListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  sort: AdminResourceListSort;
}

/**
 * Parse the shared page parameters for businesses, versions, and API keys.
 * Sort is closed over contract literals, and its cursor carries the same sort
 * so changing order requires starting from the first page.
 */
function parseAdminResourceListQuery(
  params: URLSearchParams,
  allowedParams: readonly string[],
): AdminResourceListQuery {
  const read = (name: 'limit' | 'cursor' | 'sort'): string | null =>
    allowedParams.includes(name) ? params.get(name) : null;
  const rawLimit = read('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(ADMIN_LIST_LIMIT_MAX, Math.max(1, parsedLimit))
    : ADMIN_LIST_LIMIT_DEFAULT;

  const rawSort = read('sort');
  const sortValue = rawSort === null || rawSort.trim() === ''
    ? ADMIN_RESOURCE_LIST_SORT_DEFAULT
    : rawSort.trim();
  if (!(ADMIN_RESOURCE_LIST_SORT_VALUES as readonly string[]).includes(sortValue)) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${ADMIN_RESOURCE_LIST_SORT_VALUES.join(', ')}`
    );
  }
  const sort = sortValue as AdminResourceListSort;

  const cursorRaw = read('cursor');
  let cursor: AdminResourceListSortCursor | null = null;
  if (cursorRaw !== null && cursorRaw.length > 0) {
    cursor = decodeAdminResourceListSortCursor(cursorRaw, LIST_CURSOR_MAX_LEN);
    if (!cursor) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid sortable list cursor');
    }
    if (cursor.sort !== sort) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor was issued for a different sort; drop cursor to restart the list');
    }
  }
  return { limit, cursor, sort };
}

interface ApiKeyListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  tenantId: string | null;
  status: string | null;
  prefix: string | null;
  sort: AdminResourceListSort;
}

function parseApiKeyListQuery(params: URLSearchParams): ApiKeyListQuery {
  const read = (name: ApiKeyListQueryParam): string | null => params.get(name);
  const page = parseAdminResourceListQuery(params, API_KEY_LIST_QUERY_PARAMS);

  const tenantRaw = read('tenantId');
  const tenantId = tenantRaw === null || tenantRaw.trim().length === 0 ? null : tenantRaw.trim();
  if (tenantId !== null && !UUID_PARAM_PATTERN.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a uuid');
  }

  const statusRaw = read('status');
  let status: string | null = null;
  if (statusRaw !== null && statusRaw.trim().length > 0) {
    const candidate = statusRaw.trim().toUpperCase();
    if (!(API_KEY_STATUS_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `status must be one of ${API_KEY_STATUS_VALUES.join(', ')}`
      );
    }
    status = candidate;
  }

  // `prefix` is the display prefix that is already shown on screen, never the
  // secret; the raw key is only ever hashed at rest (api_keys.hash).
  const prefix = sanitizeAdminListToken(read('prefix'), 'prefix');

  return { ...page, tenantId, status, prefix };
}

interface AdminPageResult<T> {
  rows: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  activeVersion?: string | null;
}

interface AdminSortablePageInput<T> {
  db: Db;
  fromSql: string;
  columns: string;
  clauses: string[];
  params: unknown[];
  cursor: AdminResourceListSortCursor | null;
  limit: number;
  sort: AdminResourceListSort;
  sortColumns: Partial<Record<'createdAt' | 'updatedAt', string>>;
  timestampRowKey: 'created_at_cursor' | 'updated_at_cursor';
  timestampFallbackRowKey: 'created_at' | 'updated_at';
  tieColumn: string;
  tieType: 'text' | 'uuid';
  countSql: string;
}

/**
 * Shared sort-bound keyset executor for business, version, and API-key pages.
 * SQL identifiers are supplied only by the closed route-side maps above; all
 * cursor/filter values remain bound parameters. Backward probes reverse both
 * ordering keys and then reverse the result window back into display order.
 */
async function sortableAdminKeysetPage<T extends Record<string, unknown>>(
  input: AdminSortablePageInput<T>,
): Promise<AdminPageResult<T>> {
  const [sortField, sortDirection] = input.sort.split(':') as ['createdAt' | 'updatedAt', 'asc' | 'desc'];
/**
 * Only the sort field the caller actually mapped may be requested. The audit
 * ledger has no updated_at, so a table that maps created_at alone turns any
 * other field into a 422 rather than an ORDER BY over a missing column.
 */
  const sortKey = input.sortColumns[sortField];
  if (!sortKey) {
    throw new HttpError(422, 'INVALID_SCHEMA', `sort is not available on this list: ${sortField}`);
  }
  const descending = sortDirection === 'desc';
  const backwards = input.cursor?.direction === 'prev';
  const scanDescending = backwards ? !descending : descending;
  const scanOrder = scanDescending ? 'DESC' : 'ASC';
  const forwardOp = descending ? '<' : '>';
  const boundaryOp = backwards ? (forwardOp === '<' ? '>' : '<') : forwardOp;
  const where = input.clauses.length ? ` WHERE ${input.clauses.join(' AND ')}` : '';
  const pageParams = [...input.params];
  let cursorClause = '';
  if (input.cursor) {
    pageParams.push(input.cursor.timestamp, input.cursor.id);
    cursorClause = `${where ? ' AND' : ' WHERE'} (${sortKey}, ${input.tieColumn}) ${boundaryOp} ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::${input.tieType})`;
  }
  pageParams.push(input.limit + 1);
  const page = await input.db.query<T & Record<string, unknown>>(
    `SELECT ${input.columns} FROM ${input.fromSql}${where}${cursorClause} ORDER BY ${sortKey} ${scanOrder}, ${input.tieColumn} ${scanOrder} LIMIT $${pageParams.length}`,
    pageParams,
  );
  const rawRows = page.rows as unknown as T[];
  const hasMore = rawRows.length > input.limit;
  const window = hasMore ? rawRows.slice(0, input.limit) : rawRows;
  const pageRows = (backwards ? window.slice().reverse() : window) as T[];
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const cursorFor = (row: T, direction: 'next' | 'prev'): string =>
    encodeAdminResourceListSortCursor({
      timestamp: typeof row[input.timestampRowKey] === 'string'
        ? String(row[input.timestampRowKey])
        : dateToIso(row[input.timestampFallbackRowKey]),
      id: String(row[input.tieColumn.split('.').pop()!] ?? ''),
      direction,
      sort: input.sort,
    });
  const nextExists = backwards ? input.cursor !== null : hasMore;
  const prevExists = backwards ? hasMore : input.cursor !== null;
  const nextCursor = nextExists && last ? cursorFor(last, 'next') : null;
  const prevCursor = prevExists && first ? cursorFor(first, 'prev') : null;

  const counted = await input.db.query<{ total: number | string; active_version?: string | null }>(
    input.countSql,
    input.params,
  );
  return {
    rows: pageRows,
    nextCursor,
    prevCursor,
    total: Number(counted.rows[0]?.total ?? 0),
    activeVersion: counted.rows[0]?.active_version ?? null,
  };
}

function dateToIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('admin list row contains an invalid timestamp');
  return date.toISOString();
}

interface BusinessListDbRow extends Record<string, unknown> {
  business_id: string;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
  active_version: string | null;
}

async function listAdminBusinessesPage(
  db: Db,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessListDbRow>> {
  const fromSql = `(
    SELECT latest.business_id, latest.version, latest.status, latest.is_active,
           latest.digest, latest.queue, latest.created_at, latest.updated_at,
           active.active_version
    FROM (
      SELECT DISTINCT ON (business_id) business_id, version, status, is_active,
             digest, queue, created_at, updated_at
      FROM business_versions
      ORDER BY business_id, created_at DESC, version DESC
    ) latest
    LEFT JOIN (
      SELECT DISTINCT ON (business_id) business_id, version AS active_version
      FROM business_versions WHERE is_active = true
      ORDER BY business_id, version DESC
    ) active ON active.business_id = latest.business_id
  ) businesses`;
  return sortableAdminKeysetPage<BusinessListDbRow>({
    db,
    fromSql,
    columns: `businesses.business_id, businesses.version, businesses.status, businesses.is_active, businesses.digest, businesses.queue, businesses.created_at, businesses.updated_at, businesses.active_version,
              to_char(businesses.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(businesses.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses: [],
    params: [],
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'businesses.created_at', updatedAt: 'businesses.updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'businesses.business_id',
    tieType: 'text',
    countSql: 'SELECT count(DISTINCT business_id)::int AS total FROM business_versions',
  });
}

interface BusinessVersionDbRow extends Record<string, unknown> {
  business_id: string;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
}

async function listBusinessVersionPage(
  db: Db,
  businessId: string,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessVersionDbRow>> {
  return sortableAdminKeysetPage<BusinessVersionDbRow>({
    db,
    fromSql: 'business_versions',
    columns: `business_id, version, status, is_active, digest, queue, created_at, updated_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses: ['business_id = $1'],
    params: [businessId],
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at', updatedAt: 'updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'version',
    tieType: 'text',
    countSql: `SELECT count(*)::int AS total,
                      (SELECT version FROM business_versions WHERE business_id=$1 AND is_active=true LIMIT 1) AS active_version
               FROM business_versions WHERE business_id=$1`,
  });
}

/**
 * Keyset page over api_keys, mirroring the operations list: DESC for a
 * forward cursor, ASC-then-reverse for a backward one, `limit + 1` as the
 * only evidence of a further page, and a count over the FILTERED population.
 * The tenant predicate is SQL, not a JavaScript filter, so rows outside the
 * caller's scope never leave the database.
 */
async function listApiKeyPage(
  db: Db,
  tenantId: string,
  query: ApiKeyListQuery
): Promise<AdminPageResult<ApiKeyDbRow>> {
  if (query.cursor && !UUID_PARAM_PATTERN.test(query.cursor.id)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'cursor id is not valid for API-key pagination');
  }
  const clauses: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.status !== null) clauses.push(`status = ${bind(query.status)}`);
  if (query.prefix !== null) {
    clauses.push(`strpos(lower(prefix), lower(${bind(query.prefix)})) > 0`);
  }
  return sortableAdminKeysetPage<ApiKeyDbRow>({
    db,
    fromSql: 'api_keys',
    columns: `id, tenant_id, prefix, status, created_at, updated_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses,
    params,
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at', updatedAt: 'updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'id',
    tieType: 'uuid',
    countSql: `SELECT count(*)::int AS total FROM api_keys WHERE ${clauses.join(' AND ')}`,
  });
}

/**
 * The one keyset-page executor shared by the audit and api-key lists (the
 * operations list keeps its own, older routine for now — see the receipt's
 * delta note). Every value is bound; only predicate TEMPLATES and a direction
 * chosen from two literals reach the SQL text.
 */
async function keysetPage<T>(input: {
  db: Db;
  table: string;
  columns: string;
  clauses: string[];
  params: unknown[];
  cursor: ListCursor | null;
  limit: number;
  countLabel: string;
}): Promise<AdminPageResult<T>> {
  const where = input.clauses.length ? ` WHERE ${input.clauses.join(' AND ')}` : '';
  const backwards = input.cursor?.direction === 'prev';

  const pageParams = [...input.params];
  let cursorClause = '';
  if (input.cursor) {
    pageParams.push(input.cursor.createdAt, input.cursor.id);
    const op = backwards ? '>' : '<';
    cursorClause = ` AND (created_at, id) ${op} ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`;
  }
  pageParams.push(input.limit + 1);
  const order = backwards ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';
  const page = await input.db.query<T & Record<string, unknown>>(
    `SELECT ${input.columns} FROM ${input.table}${where}${cursorClause} ORDER BY ${order} LIMIT $${pageParams.length}`,
    pageParams
  );
  const rows = page.rows as unknown as Record<string, unknown>[];
  const hasMore = rows.length > input.limit;
  const window = hasMore ? rows.slice(0, input.limit) : rows;
  const pageRows = (backwards ? window.slice().reverse() : window) as unknown as T[];

  const first = pageRows[0] as Record<string, unknown> | undefined;
  const last = pageRows[pageRows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor =
    hasMore && last
      ? encodeListCursor(last['created_at'] as string, last['id'] as string, 'next')
      : null;
  // Same rule as the operations list above: a forward arrival always has a page
  // above it, a backward arrival only when the ASC probe saw a further row.
  // Without the cursor check, page 1 advertises a Previous link to itself.
  const hasPageAbove = backwards ? hasMore : input.cursor !== null;
  const prevCursor =
    first && hasPageAbove
      ? encodeListCursor(first['created_at'] as string, first['id'] as string, 'prev')
      : null;

  const counted = await input.db.query<{ total: number | string }>(
    `SELECT count(*)::int AS total FROM ${input.table}${where}`,
    input.params
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  return { rows: pageRows, nextCursor, prevCursor, total };
}

interface AuditDbRow extends Record<string, unknown> {
  id: string;
  tenant_id: string | null;
  actor: string;
  action: string;
  resource: string;
  severity: string;
  created_at: Date;
}

/** Mirrors audit.ts toWire — kept local so the route does not reach into the service. */
function toAuditWire(row: AuditDbRow): AuditWireRow {
  return {
    id: row.id,
    kind: row.action,
    severity: row.severity,
    occurredAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    tenantId: row.tenant_id,
    resourceId: row.resource,
    actor: row.actor,
    message: `${row.action} ${row.resource}`,
  };
}

/**
 * Paged, tenant-scoped ledger read. Same sort-bound keyset executor as the
 * business, version and api-key pages, so all four surfaces inherit one
 * cursor dialect and one count rule. The wire projection matches what
 * audit.ts already emits, so the overview pane needs no field remap beyond
 * reading `items`.
 */
async function listAuditEventPage(
  ctx: RouteContext,
  tenantId: string,
  query: AdminAuditListQuery
): Promise<Record<string, unknown>> {
  const clauses: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.severity !== null) clauses.push(`severity = ${bind(query.severity)}`);
  if (query.action !== null) {
    clauses.push(`strpos(lower(action), lower(${bind(query.action)})) > 0`);
  }
  if (query.actor !== null) {
    clauses.push(`strpos(lower(actor), lower(${bind(query.actor)})) > 0`);
  }
  if (query.resource !== null) {
    clauses.push(`strpos(lower(resource), lower(${bind(query.resource)})) > 0`);
  }
  if (query.from !== null) clauses.push(`created_at >= ${bind(query.from)}::timestamptz`);
  if (query.to !== null) clauses.push(`created_at <= ${bind(query.to)}::timestamptz`);
  const page = await sortableAdminKeysetPage<AuditDbRow>({
    db: ctx.db,
    fromSql: 'admin_audit_events',
    columns: `id, tenant_id, actor, action, resource, severity, correlation_id, created_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`,
    clauses,
    params,
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at' },
    timestampRowKey: 'created_at_cursor',
    timestampFallbackRowKey: 'created_at',
    tieColumn: 'id',
    tieType: 'uuid',
    countSql: `SELECT count(*)::int AS total FROM admin_audit_events WHERE ${clauses.join(' AND ')}`,
  });
  return listPage({
    items: page.rows.map(toAuditWire),
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
    total: page.total,
    limit: query.limit,
  });
}


interface AuditWireRow {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
  message: string;
}
/**
 * Assembles the api-keys answer: the shared five page fields plus the grants
 * and copy-once payload the key pane needs. The raw key is never projected —
 * only the stored prefix, which is display-safe and is why `prefix` is a legal
 * search term while a secret never is.
 */
async function buildApiKeyPage(
  ctx: RouteContext,
  principal: AdminPrincipal,
  rows: ApiKeyDbRow[],
  query: ApiKeyListQuery | null,
  page?: AdminPageResult<ApiKeyDbRow>
): Promise<Record<string, unknown>> {
  const ids = rows.map((r) => r.id);
  const grantRows = ids.length
    ? await ctx.db.query(
        `SELECT api_key_id, business_id, business_version, action, created_at
         FROM profile_bindings WHERE api_key_id = ANY($1) ORDER BY created_at DESC`,
        [ids]
      )
    : { rows: [] as unknown[] };
  const grantsByKey = new Map<string, unknown[]>();
  for (const g of grantRows.rows as {
    api_key_id: string; business_id: string; business_version: string;
    action: string; created_at: Date;
  }[]) {
    const list = grantsByKey.get(g.api_key_id) ?? [];
    list.push({
      businessId: g.business_id,
      businessVersion: g.business_version,
      action: g.action,
      grantedAt: (g.created_at as Date).toISOString(),
    });
    grantsByKey.set(g.api_key_id, list);
  }
  const items = rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    prefix: r.prefix,
    maskedHint: r.prefix,
    status: r.status,
    createdAt: dateToIso(r.created_at),
    updatedAt: dateToIso(r.updated_at ?? r.created_at),
  }));
  const base = listPage({
    items,
    nextCursor: page?.nextCursor ?? null,
    prevCursor: page?.prevCursor ?? null,
    total: page?.total ?? items.length,
    limit: query?.limit ?? ADMIN_LIST_LIMIT_DEFAULT,
  });
  return {
    ...base,
    grants: rows.flatMap((r) => grantsByKey.get(r.id) ?? []),
    createCopyOnce: null,
  };
}
/**
 * ADM-BASE-01: camelCase operation row for the shell's detail envelope.
 * The fetcher's `normaliseOperation` requires camelCase `id`,
 * `tenantId`, `businessId`, … — `toOperationView` (docs-06 public
 * shape) uses the same names, so it is reused and extended with the
 * admin-only tenant pin.
 */
function toOperationDetailWire(r: Record<string, unknown>): Record<string, unknown> {
  return { ...toOperationView(r), tenantId: r.tenant_id };
}

/**
 * ADM-BASE-01: merged `{ operation, result, artifacts, serverNow }`
 * envelope the shell's detail fetcher parses. `result` reuses the
 * public result projection (SUCCEEDED only, else null); `artifacts`
 * reuses the CR-12/MM-02 READY-refs projection. Cross-tenant for the
 * platform bearer; behind requireResourceTenant() for tenant operators
 * (ADM-BASE-02, by-id 404 fence).
 */
async function buildAdminOperationDetail(ctx: RouteContext, operationId: string): Promise<Record<string, unknown>> {
  const op = await ctx.runtime.getOperation(operationId);
  const terminal = (op.state as string) === 'SUCCEEDED';
  let result: unknown = null;
  let artifacts: unknown[] = [];
  if (terminal) {
    const arts = await ctx.db.query(
      `SELECT a.id, a.purpose, a.mime_type, a.size_bytes, a.sha256,
              COALESCE(o.submit_artifacts, '[]'::jsonb) AS submit_roles
       FROM operations o
       LEFT JOIN artifacts a
         ON a.state = 'READY'
        AND a.tenant_id = o.tenant_id
        AND a.purpose IN ('input', 'output')
        AND (
          (a.operation_id = o.id AND a.purpose = 'output')
          OR COALESCE(o.submit_artifacts, '[]'::jsonb) @>
             jsonb_build_array(jsonb_build_object('artifactId', a.id::text))
        )
       WHERE o.id = $1`,
      [operationId]
    );
    const submitRoles = new Map<string, string>();
    for (const row of arts.rows as { submit_roles: unknown }[]) {
      const declared = (row.submit_roles as { artifactId?: unknown; role?: unknown }[] | null) ?? [];
      if (Array.isArray(declared)) {
        for (const d of declared) {
          if (typeof d?.artifactId === 'string' && typeof d?.role === 'string') {
            submitRoles.set(d.artifactId, d.role);
          }
        }
      }
      break;
    }
    artifacts = (arts.rows as {
      id: string | null; purpose: string | null; mime_type: string | null;
      size_bytes: number | string | null; sha256: string | null;
    }[])
      .filter((r) => r.id !== null)
      .map((r) => ({
        artifactId: r.id as string,
        role: submitRoles.get(r.id as string) ?? r.purpose ?? 'output',
        mimeType: r.mime_type ?? undefined,
        sizeBytes: r.size_bytes === null ? undefined : Number(r.size_bytes),
        hashSha256: r.sha256 ?? undefined,
        download: `/api/v1/artifacts/${r.id as string}/download`,
      }));
    result = {
      schemaVersion: '1',
      data: op.result_ref ? { resultRef: op.result_ref } : {},
      artifacts,
      usage: await ctx.usage.project(operationId),
      warnings: [],
    };
  }
  return {
    operation: toOperationDetailWire(op),
    result,
    artifacts,
    serverNow: new Date().toISOString(),
  };
}

async function resolveApiKey(ctx: RouteContext): Promise<{ id: string; tenantId: string }> {
  const raw = ctx.headers['x-api-key'] as string | undefined;
  if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'missing x-api-key');
  // Fail-closed hash lookup: only ACTIVE keys resolve. No fallback — unknown,
  // revoked, or cross-tenant keys are denied (R08-01).
  const hash = hashKey(raw);
  const res = await ctx.db.query('SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2', [hash, 'ACTIVE']);
  if (res.rowCount) {
    const row = res.rows[0] as { id: string; tenant_id: string };
    return { id: row.id, tenantId: row.tenant_id };
  }
  throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function absoluteGrantUrl(host: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `http://${host}${url.startsWith('/') ? url : `/${url}`}`;
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

/**
 * DATA-00-M §6 policy is SIGNED (2026-09-25, user decision gate Cycle A1):
 * the environment names for multipartLimits are now settled. Every value
 * may only NARROW the @du/contracts wire bounds (the service clamps via
 * narrow()); absent means the wire value. A non-integer or non-positive env
 * value fails boot loudly instead of serving 409s at request time.
 */
export function multipartLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServerConfig['multipartLimits'] {
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(name + ' must be a positive integer, got ' + raw);
    }
    return parsed;
  };
  const limits = {
    partSizeBytes: read('MULTIPART_PART_SIZE_BYTES'),
    maxTotalBytes: read('MULTIPART_MAX_TOTAL_BYTES'),
    sessionTtlMs: read('MULTIPART_SESSION_TTL_MS'),
    partUrlTtlMs: read('MULTIPART_PART_URL_TTL_MS'),
  };
  return Object.values(limits).every((value) => value === undefined) ? undefined : limits;
}
