#!/usr/bin/env node
/**
 * PR-Q3-11: the packaged orchestrator process entrypoint. Until now the gate
 * doc (coordination/gates/runtime-ready.md) recorded "no standalone bin — boot
 * in-process via createApp()"; this is the managed process compose/container
 * recipes can start, and the place SIGTERM/SIGINT ownership legally lives
 * (src/index.ts is a BARREL imported by every test process — handlers must NOT
 * be installed there; side effects belong to the entry, period).
 *
 * Production boot order (docs + migrate-cli header):
 *   1. npm run migrate        (explicit operator step)
 *   2. npm start              (this file; autoMigrate=false → verify-only boot)
 *
 * Shutdown chain (cycle 98 + this cycle): signal → installGracefulShutdown →
 * app.close() [webhook drain → lease drain → queues/redis/pg] → exit(0);
 * second signal exits(1) immediately; SHUTDOWN_TIMEOUT_MS caps the whole chain.
 */
import { createApp, multipartLimitsFromEnv } from './server';
import { s3SourceRulesFromEnv } from './modules/operations/s3-source';
import { createLogger, safeErrorForLog } from '@du/observability';
import { installGracefulShutdown } from './shutdown';
import { buildOidcAdminComponents } from './app/admin/oidc-boot';
import { buildEncryptionBootOptions, buildMetadataReadPolicy, type EncryptionBootOptions } from './modules/encryption/boot-options';
import {
  connectorManagementAuthorizationProviderFromEnv,
  type ConnectorManagementAuthorizationProvider,
} from './modules/connectors/management-service-identity';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'main' } });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(name + ' must be a positive integer, got ' + raw);
  return parsed;
}

function booleanOption(name: string): boolean | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(name + ' must be true or false');
}

/** Optional JSON object mapping business IDs to their worker bearer tokens. */
function workerIdentityTokensByBusiness(): Record<string, string> | undefined {
  const raw = optional('WORKER_IDENTITY_TOKENS_BY_BUSINESS');
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS must be a JSON object mapping business IDs to tokens');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS must be a JSON object mapping business IDs to tokens');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, token]) => typeof token !== 'string')) {
    throw new Error('WORKER_IDENTITY_TOKENS_BY_BUSINESS values must be strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Optional JSON object mapping TENANT IDs to their admin bearer tokens (env
 * mirrors WORKER_IDENTITY_TOKENS_BY_BUSINESS: key = non-secret id, value =
 * secret). ServerConfig.tenantAdminTokens is the REVERSE map (token ->
 * tenantId) and is what the admin shell/BFF fence consumes; the flip happens
 * here, once. Fail-fast on shape errors and on a token assigned to two
 * tenants — the reverse map could not represent that without silently picking
 * one, and a silent tenant mix-up is exactly what the fence exists to stop.
 * Error messages never echo the token value.
 */
export function tenantAdminTokensFromEnv(): Record<string, string> | undefined {
  const raw = optional('TENANT_ADMIN_TOKENS_BY_TENANT');
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT must be a JSON object mapping tenant IDs to admin bearer tokens');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT must be a JSON object mapping tenant IDs to admin bearer tokens');
  }

  const byToken = new Map<string, string>();
  for (const [tenantId, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (tenantId.length === 0) {
      throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT tenant IDs must be non-empty');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`TENANT_ADMIN_TOKENS_BY_TENANT token for tenant '${tenantId}' must be a non-empty string`);
    }
    if (byToken.has(token)) {
      throw new Error('TENANT_ADMIN_TOKENS_BY_TENANT assigns the same token to multiple tenants');
    }
    byToken.set(token, tenantId);
  }
  return Object.fromEntries(byToken);
}

/**
 * PLAT-MIG-01: connector management base URLs, from the DEPLOYMENT-ADAPTER
 * DESIGN-803 boot URL source (static -> env; the DB source stays unwired).
 *
 * The base URL is platform configuration, not a secret, but a HALF-set surface
 * is refused: an empty map, an empty id, a non-URL value or non-JSON all fail
 * the boot instead of degrading to the empty-map fallback that made the
 * management surface silently absent on every deployment.
 */
export function runtimeGrantBaseUrlFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env.ORCHESTRATOR_INTERNAL_BASE_URL?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production' && (env.ARTIFACT_STORAGE_BACKEND ?? 'postgres') === 'postgres') {
      throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL is required for production PostgreSQL Runtime artifact grants');
    }
    return undefined;
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') {
    throw new Error('ORCHESTRATOR_INTERNAL_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  return url.origin;
}

export function connectorBaseUrlsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> | undefined {
  const raw = env['DU_CONNECTOR_BASE_URLS'];
  if (raw === undefined || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DU_CONNECTOR_BASE_URLS must be a JSON object mapping connector ids to base URLs');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DU_CONNECTOR_BASE_URLS must be a JSON object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('DU_CONNECTOR_BASE_URLS must not be empty when set; unset the variable to disable the surface');
  }
  const out: Record<string, string> = {};
  for (const [connectorId, baseUrl] of entries) {
    if (connectorId.length === 0) throw new Error('DU_CONNECTOR_BASE_URLS keys must be non-empty connector ids');
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error('DU_CONNECTOR_BASE_URLS[' + connectorId + '] must be a non-empty base URL string');
    }
    out[connectorId] = baseUrl;
  }
  return out;
}

/**
 * PLAT-MIG-01: resolve the connector management composition and REFUSE a
 * half-set surface. Exported so the boot rules are testable without a
 * database (see tests/plat-mig-01-boot.test.ts).
 */
export function assertConnectorComposition(
  env: Readonly<Record<string, string | undefined>> = process.env,
): {
  readonly connectorBaseUrls?: Record<string, string>;
  readonly connectorManagementAuthorizationForRequest?: ConnectorManagementAuthorizationProvider;
} {
  const connectorBaseUrls = connectorBaseUrlsFromEnv(env);
  if (env['DU_CONNECTOR_MANAGEMENT_HEADERS']) {
    throw new Error(
      'DU_CONNECTOR_MANAGEMENT_HEADERS is no longer supported; configure SERVICE_IDENTITY_SECRET to issue signed management tokens'
    );
  }
  if (env['DU_CONNECTOR_IDENTITY_EXPIRES_AT']) {
    throw new Error(
      'DU_CONNECTOR_IDENTITY_EXPIRES_AT is obsolete; expiry is issued per request in the signed JWT'
    );
  }
  const connectorManagementAuthorizationForRequest = connectorManagementAuthorizationProviderFromEnv(env);
  if (connectorBaseUrls && !connectorManagementAuthorizationForRequest) {
    throw new Error(
      'SERVICE_IDENTITY_SECRET is required with DU_CONNECTOR_BASE_URLS for signed Connector management requests'
    );
  }
  return {
    ...(connectorBaseUrls ? { connectorBaseUrls } : {}),
    ...(connectorManagementAuthorizationForRequest ? { connectorManagementAuthorizationForRequest } : {}),
  };
}

function artifactStorageConfig(): NonNullable<Parameters<typeof createApp>[0]['artifactStorage']> {
  const backend = optional('ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
  const migrationWindow = booleanOption('ARTIFACT_STORAGE_MIGRATION_WINDOW');
  if (backend === 'postgres') {
    if (migrationWindow) throw new Error('ARTIFACT_STORAGE_MIGRATION_WINDOW=true requires ARTIFACT_STORAGE_BACKEND=s3');
    return { backend: 'postgres' };
  }
  if (backend !== 's3') throw new Error('ARTIFACT_STORAGE_BACKEND must be postgres or s3');
  return {
    backend: 's3',
    bucket: required('ARTIFACT_S3_BUCKET'),
    region: optional('ARTIFACT_S3_REGION'),
    endpoint: optional('ARTIFACT_S3_ENDPOINT'),
    forcePathStyle: booleanOption('ARTIFACT_S3_FORCE_PATH_STYLE'),
    migrationWindow,
  };
}

export async function main(): Promise<void> {
  // CYCLE-108/113: OIDC-04 plane when configured. Absent env -> null
  // (bearer + legacy surfaces unchanged); partial env -> refuse to boot.
  const oidcAdmin = buildOidcAdminComponents(process.env);
  // ROOT-CAUSE FIX (Tester-1, cycle 139): await the Redis identity plane
  // BEFORE anything can serve a request. enableOfflineQueue:false means
  // the first login's challenge write to a COLD connection is an
  // instant-reject 500, not a queued wait. Never ready within the
  // adapter's budget -> this rejects -> startup fails loudly below
  // (exit 1) instead of serving a half-warm identity plane.
  if (oidcAdmin?.ready) {
    await oidcAdmin.ready();
  }
  // RV01-02 (#8): resolved before createApp so a bad surface fails the boot
  // instead of leaving the app running with plaintext control-plane columns.
  const encryptionBoot: Partial<EncryptionBootOptions> = buildEncryptionBootOptions(process.env) ?? {};
  // CONTROL-PLANE-IMPL-818: a metadata seam with no explicit plaintext-read
  // mode is the uncontrolled `allowPlaintext: true` this packet exists to
  // remove. Fail the boot HERE, in the production entrypoint, before
  // createApp can assemble readers over an undeclared policy.
  if (encryptionBoot.metadataEncryption) buildMetadataReadPolicy(process.env);
  if (encryptionBoot.metadataEncryption || encryptionBoot.publicUploadEncryption) {
    logger.info('artifact encryption enabled', {
      metadata: Boolean(encryptionBoot.metadataEncryption),
      publicUpload: Boolean(encryptionBoot.publicUploadEncryption),
    });
  }
  // PLAT-MIG-01: connector management composition. A HALF-set surface is a
  // boot refusal, never the old empty-map fallback that silently made the
  // management surface absent on every deployment (DESIGN-803, Muc 1).
  const { connectorBaseUrls, connectorManagementAuthorizationForRequest } = assertConnectorComposition(process.env);
  if (!process.env.ENCRYPTION_KEY && !process.env.NEXTAUTH_SECRET) {
    logger.warn(
      'profile cipher key absent — configured-cipher acquisition will deny with AUTH_DECRYPT_FAILED; ' +
        'set ENCRYPTION_KEY or NEXTAUTH_SECRET'
    );
  }
  const app = await createApp({
    port: positiveInteger('ORCHESTRATOR_PORT', positiveInteger('PORT', 3000)),
    // PM-M02-ROUTE: public bind address plus the INTERNAL JSON listener.
    // Defaults preserve the current public bind shape; the internal listener
    // defaults to 127.0.0.1:3002 for native runs and Compose sets the host
    // explicitly. The default Compose stack never publishes 3002.
    host: optional('ORCHESTRATOR_HOST') ?? '0.0.0.0',
    internalPort: positiveInteger('ORCHESTRATOR_INTERNAL_PORT', 3002),
    runtimeBaseUrl: runtimeGrantBaseUrlFromEnv(),
    internalHost: optional('ORCHESTRATOR_INTERNAL_HOST') ?? '127.0.0.1',
    databaseUrl: required('DATABASE_URL'),
    redisUrl: optional('REDIS_URL') ?? 'redis://127.0.0.1:6379',
    runtimeToken: optional('RUNTIME_TOKEN'),
    workerIdentityTokensByBusiness: workerIdentityTokensByBusiness(),
    adminToken: optional('ADMIN_TOKEN'),
    tenantAdminTokens: tenantAdminTokensFromEnv(),
    usageToken: optional('USAGE_TOKEN'),
    invocationGrantSecret: optional('INVOCATION_GRANT_SECRET'),
    webhookSecret: optional('WEBHOOK_SECRET'),
    webhookDispatchIntervalMs: optional('WEBHOOK_DISPATCH_INTERVAL_MS')
      ? positiveInteger('WEBHOOK_DISPATCH_INTERVAL_MS', 5000)
      : undefined,
    webhookDrainTimeoutMs: optional('WEBHOOK_DRAIN_TIMEOUT_MS')
      ? positiveInteger('WEBHOOK_DRAIN_TIMEOUT_MS', 5000)
      : undefined,
    shutdownTimeoutMs: positiveInteger('SHUTDOWN_TIMEOUT_MS', 30_000),
    autoMigrate: process.env.AUTO_MIGRATE === 'true', // default FALSE: schema work is the migrate CLI's
    autoDispatch: process.env.AUTO_DISPATCH !== 'false',
    artifactStorage: artifactStorageConfig(),
    s3SourceRules: s3SourceRulesFromEnv(),
    // RV01-02 (#8): supply the crypto blocks so control-plane columns are
    // sealed. Absent these, createApp leaves metadataCrypto undefined and every
    // control-plane column silently keeps plaintext behaviour. Building them
    // here is fail-closed: a half-specified surface throws instead of degrading.
    ...encryptionBoot,
    // PLAT-MIG-01 / DESIGN-803: management URL source and server-only
    // per-request signed identity provider. Key and tokens are NEVER logged.
    ...(connectorBaseUrls ? { connectorBaseUrls } : {}),
    ...(connectorManagementAuthorizationForRequest ? { connectorManagementAuthorizationForRequest } : {}),
    // DATA-02 §6 signed values stay the wire defaults; env may only narrow.
    multipartLimits: multipartLimitsFromEnv(),
    adminSessionStore: oidcAdmin?.adminSessionStore,
    adminOidcFlow: oidcAdmin?.adminOidcFlow,
    adminShellCookieSecret: optional('ADMIN_SHELL_COOKIE_SECRET'),
    adminShellPort: optional('ADMIN_SHELL_PORT') ? positiveInteger('ADMIN_SHELL_PORT', 3001) : undefined,
    adminShellHost: optional('ADMIN_SHELL_HOST') ?? '127.0.0.1',
  });
  const server = await app.listen();
  const address = server.address();
  logger.info('orchestrator listening', {
    address: typeof address === 'string' ? address : address ? address.port : 'unknown',
  });
  if (app.adminShell) {
    logger.info('admin shell listening', { url: app.adminShell.url });
  }

  installGracefulShutdown({
    // Drain the app first; the OIDC session connection (redis backend)
    // closes LAST so in-flight callbacks can still resolve/deny sessions.
    close: async () => {
      await app.close();
      await oidcAdmin?.close?.();
    },
    exit: (code) => process.exit(code),
    timeoutMs: positiveInteger('SHUTDOWN_BUDGET_MS', 45_000),
    note: (event, detail) => logger.info('shutdown ' + event + (detail ? ' ' + detail : '')),
  });
}

// Entry semantics are preserved for `npm start` (`node dist/main.js`); the
// guard only makes this module importable by focused tests (e.g. the
// TENANT_ADMIN_TOKENS_BY_TENANT parser) without booting the orchestrator.
if (require.main === module) {
  void main().catch((error: unknown) => {
    logger.error('orchestrator startup failed', { error: safeErrorForLog(error) });
    process.exit(1);
  });
}
