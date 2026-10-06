import {
  resolveWorkerBusinessIdentity,
} from './modules/runtime/worker-identity';
import type { KeyProvider } from './modules/encryption/vault-transit-provider';
import type { CredentialWorkflow } from './modules/connector-credentials/workflow';
import type { ConnectorManagementAuthorizationProvider } from './modules/connectors/management-service-identity';
import {
  resolveAdminPrincipal,
  type AdminSessionStore,
} from './modules/admin-actions/rbac';
import type { OidcFlow } from './app/admin/oidc-flow';
import { HttpError } from './http/errors';

// CONV-01: the query/projection groups moved to their owner modules, but the
// public surface stays importable from this module — the operations-list query
// contract (constants, cursor types, parser) is re-exported below.
export {
  OPERATIONS_LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_DEFAULT_LIMIT,
  OPERATIONS_LIST_MAX_LIMIT,
  parseOperationsListQuery,
} from './modules/operations/list-query';
export type {
  AllowListedQuery,
  OperationsListCursor,
  OperationsListDirection,
  OperationsListQuery,
  OperationsStateFilter,
} from './modules/operations/list-query';
import {
  type DeliveryEncryptionConfig,
} from './modules/public-api';
import type { RecipientKeyRegistry } from './modules/encryption/recipient-key-registry';


// CONV-02: the audience families moved to src/http/routes/*, and the route
// context type to src/http/route-context.ts. Public names stay importable here.
import { handleRuntimeRoutes } from './http/routes/runtime';
import { handlePublicRoutes } from './http/routes/public';
import { handleAdminRoutes } from './http/routes/admin';
import type { RouteContext, RouteResult } from './http/route-context';
export { allowHostDerivedGrantUrl, absoluteGrantUrl, type GrantUrlOptions } from './http/routes/runtime';
export type { RouteContext, RouteResult } from './http/route-context';
import { assembleApp } from './app/bootstrap/create-app';
export { createMultipartSweepHook, shouldSeedDevFallback } from './app/bootstrap/create-app';
export {
  buildCryptoConfigOptions,
  buildDeliveryEncryptionConfig,
  registerAdminCryptoConfigWiring,
} from './app/bootstrap/crypto-wiring';

export interface ServerConfig {
  port: number;
  /**
   * PM-M02-ROUTE: bind address for the PUBLIC JSON listener. Default 0.0.0.0
   * (preserves the current unqualified public bind).
   */
  host?: string;
  /**
   * PM-M02-ROUTE: the INTERNAL JSON listener. It keeps public, admin and
   * runtime handlers available, each still enforcing its own authorization.
   * Default 3002 on 127.0.0.1; Compose sets the host explicitly. 0 is allowed
   * for programmatic tests (ephemeral listener).
   */
  internalPort?: number;
  internalHost?: string;
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
  /** Server-only issuer used to create a fresh Connector management JWT per request. */
  connectorManagementAuthorizationForRequest?: ConnectorManagementAuthorizationProvider;
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
  /** RFX-11: public base URL used to return absolute artifact grant URLs
   *  (uploadUrl/downloadUrl/partUrl) to callers. Platform configuration,
   *  never caller input. When set, a grant always carries this host — the
   *  request Host header can no longer decide where a grant token points.
   *  When unset, dev/test keep the legacy Host-derived fallback; production
   *  answers the relative grant path instead (fail-closed: workers that
   *  require an absolute URL surface an explicit error rather than following
   *  a Host-derived, potentially attacker-chosen one). */
  publicBaseUrl?: string;
  /** Trusted worker-reachable origin for Runtime artifact grants (internal listener). */
  runtimeBaseUrl?: string;
  s3SourceRules?: readonly import('./modules/operations/s3-source').S3SourceRule[];
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
        /** New writes use S3 while READY reads prefer S3 then the retained PG backup.
         *  CRX-02: for the encrypted read path this flag is also the
         *  operator-signed migration policy — while it is set, objects written
         *  before encryption was enabled (no sealed marker) still read;
         *  without it the read path requires the marker and fails closed. */
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
  // CONV-03: assembly/lifecycle live in src/app/bootstrap/create-app.ts; this
  // module keeps the single public entry point and injects the route table, so
  // the bootstrap layer never imports server.ts at value level.
  return assembleApp(config, { route });
}

export type App = Awaited<ReturnType<typeof createApp>>;

export async function route(ctx: RouteContext): Promise<RouteResult> {
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

  // CONV-02: audience families, tried in the pre-split match order. Runtime,
  // public and admin paths are disjoint prefixes and each family preserves its
  // internal precedence verbatim; `null` is the same fall-through the single-
  // function route() used.
  const runtimeResult = await handleRuntimeRoutes(ctx);
  if (runtimeResult) return runtimeResult;
  const publicResult = await handlePublicRoutes(ctx);
  if (publicResult) return publicResult;
  const adminResult = await handleAdminRoutes(ctx);
  if (adminResult) return adminResult;

  return { status: 404, body: { type: 'urn:du:error:not_found', title: 'not found', status: 404, code: 'NOT_FOUND' } };
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

// ADM-BASE-02: the former non-throwing isAdminAuthed() check is replaced
// by resolveAdminPrincipal() on every shared fetcher URL (usage,
// operations list, operations detail) — same fall-through to the
// x-api-key path on null, plus the tenant-operator scope.


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
