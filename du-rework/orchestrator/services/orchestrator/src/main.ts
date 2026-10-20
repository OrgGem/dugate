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
 *   1. image entrypoint runs packaged migrate CLI (unless explicitly disabled)
 *   2. npm start              (this file; autoMigrate=false → verify-only boot)
 *
 * Shutdown chain (cycle 98 + this cycle): signal → installGracefulShutdown →
 * app.close() [webhook drain → lease drain → queues/redis/pg] → exit(0);
 * second signal exits(1) immediately; SHUTDOWN_TIMEOUT_MS caps the whole chain.
 */
import { createApp, multipartLimitsFromEnv } from './server';
import { registerLdb03ContextProvider } from './app/bootstrap/create-app';
import { s3SourceRulesFromEnv } from './modules/operations/s3-source';
import { createLogger, safeErrorForLog } from '@du/observability';
import { installGracefulShutdown } from './shutdown';
import { buildOidcAdminComponents } from './app/admin/oidc-boot';
import { assertProfileCipherBootPolicy, buildEncryptionBootOptions, buildMetadataReadPolicy, summarizeEncryptionPolicy, type EncryptionBootOptions } from './modules/encryption/boot-options';
import {
  connectorManagementAuthorizationProviderFromEnv,
  type ConnectorManagementAuthorizationProvider,
} from './modules/connectors/management-service-identity';
import { ComposeRunnerConfigSchema } from './modules/compose-operations/contracts';
import type { ComposeRunnerConfig } from './modules/compose-operations/contracts';
import { parseServiceRuntimeConfig, type ServiceRuntimeConfig } from './modules/service-runtime/service-runtime';
import { assertProductionRuntimeControlConfigured } from './modules/service-runtime/runtime-control-boot-policy';
import { parseSecretCatalogKeyring, parseSecretVersionRef } from './modules/secrets/secret-revision-resolver';
import {
  backupRecoveryKeyFilePinFromEnv,
  maintenanceRecoveryKeyRegistryPinFromEnv,
} from './modules/maintenance/recovery-key-file';
import type { ServerConfig } from './server';
import { IdentityAuthSchema } from '@du/contracts';

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

function adminIdentityAuthFromEnv(): import('@du/contracts').IdentityAuth {
  const modeRaw = optional('DU_ADMIN_AUTH_MODE');
  const oidcIssuer = optional('DU_ADMIN_OIDC_ISSUER');
  const oidcClientId = optional('DU_ADMIN_OIDC_CLIENT_ID');
  const oidcCallbackUrl = optional('DU_ADMIN_OIDC_REDIRECT_URI');
  const localEnabled = modeRaw === 'local' || modeRaw === 'both';
  const oidcConfigured = Boolean(oidcIssuer && oidcClientId && oidcCallbackUrl);
  const mode = localEnabled && oidcConfigured ? 'both'
    : localEnabled ? 'local'
      : oidcConfigured ? 'oidc' : 'unmanaged';
  return IdentityAuthSchema.parse({
    mode,
    localEnabled,
    oidc: oidcConfigured ? {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      callbackUrl: oidcCallbackUrl,
      scopes: (optional('DU_ADMIN_OIDC_SCOPES') ?? 'openid profile email').split(/\s+/).filter(Boolean),
    } : null,
  });
}

/** All-or-none boot configuration for the dedicated host-side Compose runner. */
export function composeRunnerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ComposeRunnerConfig | undefined {
  const names = ['COMPOSE_OPERATIONS_HOST_ID', 'COMPOSE_OPERATIONS_RUNNER_TOKEN', 'COMPOSE_OPERATIONS_MANIFEST_DIGEST'] as const;
  const values = names.map((name) => env[name] && env[name]!.length > 0 ? env[name] : undefined);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error('COMPOSE_OPERATIONS_HOST_ID, COMPOSE_OPERATIONS_RUNNER_TOKEN, and COMPOSE_OPERATIONS_MANIFEST_DIGEST must be configured together');
  }
  const parsed = ComposeRunnerConfigSchema.safeParse({ hostId: values[0], runnerToken: values[1], manifestDigest: values[2] });
  if (!parsed.success) throw new Error('COMPOSE_OPERATIONS host runner configuration is invalid');
  const reusedTokens = [env['ADMIN_TOKEN'], env['RUNTIME_TOKEN'], env['USAGE_TOKEN']].filter((item): item is string => !!item);
  for (const name of ['TENANT_ADMIN_TOKENS_BY_TENANT', 'WORKER_IDENTITY_TOKENS_BY_BUSINESS']) {
    const raw = env[name];
    if (!raw) continue;
    let record: unknown;
    try { record = JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON object`); }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${name} must be a JSON object`);
    for (const token of Object.values(record as Record<string, unknown>)) {
      if (typeof token !== 'string') throw new Error(`${name} values must be strings`);
      reusedTokens.push(token);
    }
  }
  if (reusedTokens.some((token) => token === parsed.data.runnerToken)) {
    throw new Error('COMPOSE_OPERATIONS_RUNNER_TOKEN must be distinct from all other service credentials');
  }
  return parsed.data;
}

/** Per-slot Orchestrator runtime identity is all-or-none and dedicated to
 * service control; it is not the public runtime/admin/worker credential. */
export function serviceRuntimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServiceRuntimeConfig | undefined {
  const names = [
    'DU_ORCHESTRATOR_RUNTIME_IDENTITY',
    'DU_ORCHESTRATOR_RUNTIME_SLOT',
    'DU_ORCHESTRATOR_RUNTIME_REVISION',
    'DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST',
    'DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN',
  ] as const;
  const values = names.map((name) => env[name] && env[name]!.length > 0 ? env[name] : undefined);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(`${names.join(', ')} must be configured together`);
  }
  const runtimeIdentity = values[0]!;
  const result = parseServiceRuntimeConfig({
    serviceRuntimeId: runtimeIdentity,
    runtimeIdentity,
    replicaId: runtimeIdentity,
    slot: values[1],
    revision: values[2],
    imageDigest: values[3],
    controlToken: values[4],
  });
  const reused = [
    env['ADMIN_TOKEN'], env['RUNTIME_TOKEN'], env['USAGE_TOKEN'], env['COST_CONTROL_CONNECTOR_TOKEN'],
    env['COMPOSE_OPERATIONS_RUNNER_TOKEN'], env['DU_ADMIN_LOCAL_SERVICE_SECRET'],
  ].filter((value): value is string => Boolean(value));
  for (const name of ['TENANT_ADMIN_TOKENS_BY_TENANT', 'WORKER_IDENTITY_TOKENS_BY_BUSINESS']) {
    const raw = env[name];
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; }
    catch { throw new Error(`${name} must be a JSON object`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
    for (const candidate of Object.values(parsed as Record<string, unknown>)) {
      if (typeof candidate !== 'string') throw new Error(`${name} values must be strings`);
      reused.push(candidate);
    }
  }
  if (reused.some((value) => value === result.controlToken)) {
    throw new Error('DU_ORCHESTRATOR_SERVICE_RUNTIME_CONTROL_TOKEN must be distinct from every other service credential');
  }
  return result;
}

/** Host manifest pin is optional but all-or-none. The manifest itself is
 * validated by its owner factory before any capability is enabled. */
export function maintenanceManifestConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): NonNullable<ServerConfig['maintenanceManifest']> | undefined {
  const path = env['DU_MAINTENANCE_MANIFEST_PATH']?.trim() || undefined;
  const digest = env['DU_MAINTENANCE_MANIFEST_SHA256']?.trim() || undefined;
  if (!path && !digest) return undefined;
  if (!path || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('DU_MAINTENANCE_MANIFEST_PATH and DU_MAINTENANCE_MANIFEST_SHA256 must be configured together with a lowercase SHA-256 digest');
  }
  return { manifestPath: path, expectedManifestSha256: digest };
}

/** Backup/restore uses a distinct strict manifest from replica rollout. */
export function maintenanceBackupManifestConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): NonNullable<ServerConfig['maintenanceBackupManifest']> | undefined {
  const path = env['DU_MAINTENANCE_BACKUP_MANIFEST_PATH']?.trim() || undefined;
  const digest = env['DU_MAINTENANCE_BACKUP_MANIFEST_SHA256']?.trim() || undefined;
  if (!path && !digest) return undefined;
  if (!path || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('DU_MAINTENANCE_BACKUP_MANIFEST_PATH and DU_MAINTENANCE_BACKUP_MANIFEST_SHA256 must be configured together with a lowercase SHA-256 digest');
  }
  return { manifestPath: path, expectedManifestSha256: digest };
}

/** Connector ordinary invocations carry signed cost context, so the
 * production Orchestrator must have the matching private service credential.
 * Isolated restore has every outbound effect disabled and reads from its
 * pre-provisioned database, so it does not need this endpoint credential. */
export function costControlConnectorTokenFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const token = env['COST_CONTROL_CONNECTOR_TOKEN']?.trim() || undefined;
  if (!token) {
    if (env['NODE_ENV'] === 'production' && env['DU_ISOLATED_RUNTIME_MODE'] !== 'restore-rehearsal') {
      throw new Error('COST_CONTROL_CONNECTOR_TOKEN is required for production cost-control authorization');
    }
    return undefined;
  }
  if (token.length < 32 || token.length > 512) {
    throw new Error('COST_CONTROL_CONNECTOR_TOKEN must contain 32–512 characters');
  }
  const otherCredentials = [
    env['ADMIN_TOKEN'], env['RUNTIME_TOKEN'], env['USAGE_TOKEN'], env['SERVICE_IDENTITY_SECRET'],
    env['INVOCATION_GRANT_SECRET'], env['CONNECTOR_INVOCATION_GRANT_SECRET'], env['USAGE_SINK_TOKEN'],
  ].filter((value): value is string => Boolean(value));
  if (otherCredentials.includes(token)) {
    throw new Error('COST_CONTROL_CONNECTOR_TOKEN must be distinct from every other service credential');
  }
  return token;
}

/** Dedicated maintenance execution role. The ordinary process defaults to
 * web; privileged host execution requires a separately launched binary and
 * an explicit manifest-pinned identity. */
export function maintenanceExecutionConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pick<ServerConfig, 'maintenanceExecutionRole' | 'maintenanceHostIdentity' | 'maintenanceBackupManifest'> {
  const rawRole = env['DU_MAINTENANCE_EXECUTION_ROLE']?.trim() || 'web';
  if (rawRole !== 'web' && rawRole !== 'host') {
    throw new Error('DU_MAINTENANCE_EXECUTION_ROLE must be web or host');
  }
  const rawIdentity = env['DU_MAINTENANCE_HOST_IDENTITY']?.trim() || undefined;
  if (rawIdentity && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(rawIdentity)) {
    throw new Error('DU_MAINTENANCE_HOST_IDENTITY is invalid');
  }
  const backupManifest = maintenanceBackupManifestConfigFromEnv(env);
  if (rawRole === 'host') {
    if (!rawIdentity || !backupManifest) {
      throw new Error('host maintenance execution requires DU_MAINTENANCE_HOST_IDENTITY and the pinned backup manifest');
    }
  } else if (rawIdentity) {
    throw new Error('DU_MAINTENANCE_HOST_IDENTITY is only valid with DU_MAINTENANCE_EXECUTION_ROLE=host');
  }
  if (rawRole === 'host' && env['DU_ISOLATED_RUNTIME_MODE']?.trim() === 'restore-rehearsal') {
    throw new Error('isolated restore rehearsal must not start the maintenance host executor');
  }
  return {
    maintenanceExecutionRole: rawRole,
    ...(rawIdentity ? { maintenanceHostIdentity: rawIdentity } : {}),
    ...(backupManifest ? { maintenanceBackupManifest: backupManifest } : {}),
  };
}

/** This is a server deployment mode, never an HTTP or browser option. Setting
 * it is deliberately fail-safe: a process in this mode refuses every
 * non-read-only operation except local Admin authentication and the staged
 * legacy-password activation used by the isolated rehearsal. */
export function isolatedRuntimeModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServerConfig['isolatedRuntimeMode'] {
  const raw = env['DU_ISOLATED_RUNTIME_MODE']?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'restore-rehearsal') throw new Error('DU_ISOLATED_RUNTIME_MODE must be restore-rehearsal when set');
  return raw;
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
  const out = Object.create(null) as Record<string, string>;
  for (const [connectorId, baseUrl] of entries) {
    if (connectorId.length === 0) throw new Error('DU_CONNECTOR_BASE_URLS keys must be non-empty connector ids');
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error('DU_CONNECTOR_BASE_URLS[' + connectorId + '] must be a non-empty base URL string');
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error('DU_CONNECTOR_BASE_URLS values must be absolute HTTP(S) URLs without credentials, query, or fragment');
    }
    if (
      !/^https?:\/\//i.test(baseUrl)
      || !['http:', 'https:'].includes(parsedUrl.protocol)
      || parsedUrl.username !== ''
      || parsedUrl.password !== ''
      || baseUrl.includes('?')
      || baseUrl.includes('#')
      || baseUrl.trim() !== baseUrl
    ) {
      throw new Error('DU_CONNECTOR_BASE_URLS values must be absolute HTTP(S) URLs without credentials, query, or fragment');
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
    if (optional('DU_STORAGE_CREDENTIAL_VERSION_REF') || optional('DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID')) {
      throw new Error('DU_STORAGE_CREDENTIAL_VERSION_REF and DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID require ARTIFACT_STORAGE_BACKEND=s3');
    }
    return { backend: 'postgres' };
  }
  if (backend !== 's3') throw new Error('ARTIFACT_STORAGE_BACKEND must be postgres or s3');
  const credentialVersionRef = optional('DU_STORAGE_CREDENTIAL_VERSION_REF');
  const credentialOwnerTenantId = optional('DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID');
  if (!credentialVersionRef || !credentialOwnerTenantId) {
    throw new Error('DU_STORAGE_CREDENTIAL_VERSION_REF and DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID are required together for S3 storage');
  }
  parseSecretVersionRef(credentialVersionRef);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credentialOwnerTenantId)) {
    throw new Error('DU_STORAGE_CREDENTIAL_OWNER_TENANT_ID must be a tenant UUID');
  }
  const region = optional('ARTIFACT_S3_REGION') ?? optional('AWS_REGION');
  if (!region) throw new Error('ARTIFACT_S3_REGION or AWS_REGION is required for S3 storage');
  return {
    backend: 's3',
    bucket: required('ARTIFACT_S3_BUCKET'),
    region,
    endpoint: optional('ARTIFACT_S3_ENDPOINT') ?? `https://s3.${region}.amazonaws.com`,
    forcePathStyle: booleanOption('ARTIFACT_S3_FORCE_PATH_STYLE'),
    credentialVersionRef,
    credentialOwnerTenantId,
    migrationWindow,
  };
}

function storageEndpointAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['DU_STORAGE_ENDPOINT_ALLOWLIST']?.trim();
  if (!raw) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST must be a JSON array of URL origins'); }
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string')) {
    throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST must be a JSON array of at most 64 URL origins');
  }
  const origins = value.map((item) => {
    let url: URL;
    try { url = new URL(item as string); } catch { throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST contains an invalid URL origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST entries must be HTTP(S) origins without paths or credentials');
    }
    return url.origin;
  });
  if (new Set(origins).size !== origins.length) throw new Error('DU_STORAGE_ENDPOINT_ALLOWLIST contains duplicates');
  return origins;
}

export async function main(): Promise<void> {
  if (process.env.DU_MIGRATION_ENABLED !== undefined && !['true', 'false'].includes(process.env.DU_MIGRATION_ENABLED)) {
    throw new Error('DU_MIGRATION_ENABLED must be true or false.');
  }
  if (maintenanceExecutionConfigFromEnv().maintenanceExecutionRole === 'host') {
    throw new Error('DU_MAINTENANCE_EXECUTION_ROLE=host must use the dedicated maintenance host runner; HTTP serving is disabled');
  }
  // MDB-01: validate the LDBA03 context policy module at the process entrypoint
  // and set its absolute path for adapter invocations inheriting this environment.
  registerLdb03ContextProvider(process.env);
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
  // SEC-ENC-05: resolve the effective policy once and hand it to createApp so
  // /health reports what actually runs. Synthetic mode is explicit and loud.
  const encryptionPolicy = summarizeEncryptionPolicy(process.env);
  if (encryptionPolicy.dataMode === 'synthetic') {
    logger.warn('synthetic-data mode: persistence encryption is explicitly exempt', {
      syntheticReason: encryptionPolicy.syntheticReason,
      metadataEncryption: encryptionPolicy.metadataEncryption,
      publicUploadEncryption: encryptionPolicy.publicUploadEncryption,
    });
  }
  // PLAT-MIG-01: connector management composition. A HALF-set surface is a
  // boot refusal, never the old empty-map fallback that silently made the
  // management surface absent on every deployment (DESIGN-803, Muc 1).
  const { connectorBaseUrls, connectorManagementAuthorizationForRequest } = assertConnectorComposition(process.env);
  const serviceRuntime = serviceRuntimeConfigFromEnv();
  const isolatedRuntimeMode = isolatedRuntimeModeFromEnv();
  assertProductionRuntimeControlConfigured({
    nodeEnv: process.env.NODE_ENV,
    isolatedRuntimeMode,
    configured: serviceRuntime !== undefined,
  });
  // F-VFY6-01 (D-BOOT-01 hybrid): a real-data boot with the artifact seam
  // enabled refuses a missing profile cipher key; dev/offline/test and the
  // explicit synthetic exemption keep the warn-only path below. Sits at the
  // old warn site by reviewer direction (minimal diff).
  assertProfileCipherBootPolicy(process.env, encryptionPolicy);
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
    costControlToken: costControlConnectorTokenFromEnv(),
    adminIdentityAuth: adminIdentityAuthFromEnv(),
    composeRunner: composeRunnerConfigFromEnv(),
    serviceRuntime,
    maintenanceManifest: maintenanceManifestConfigFromEnv(),
    maintenanceBackupManifest: maintenanceBackupManifestConfigFromEnv(),
    ...maintenanceExecutionConfigFromEnv(),
    maintenanceRecoveryKeyFile: backupRecoveryKeyFilePinFromEnv(),
    maintenanceRecoveryKeyRegistry: maintenanceRecoveryKeyRegistryPinFromEnv(),
    isolatedRuntimeMode,
    secretCatalogKeyring: parseSecretCatalogKeyring(),
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
    storageEndpointAllowlist: storageEndpointAllowlistFromEnv(),
    s3SourceRules: s3SourceRulesFromEnv(),
    // RV01-02 (#8): supply the crypto blocks so control-plane columns are
    // sealed. Absent these, createApp leaves metadataCrypto undefined and every
    // control-plane column silently keeps plaintext behaviour. Building them
    // here is fail-closed: a half-specified surface throws instead of degrading.
    ...encryptionBoot,
    // SEC-ENC-05: effective policy surfaced in /health (content-free).
    encryptionPolicy,
    // PLAT-MIG-01 / DESIGN-803: management URL source and server-only
    // per-request signed identity provider. Key and tokens are NEVER logged.
    ...(connectorBaseUrls ? { connectorBaseUrls } : {}),
    ...(connectorManagementAuthorizationForRequest ? { connectorManagementAuthorizationForRequest } : {}),
    // DATA-02 §6 signed values stay the wire defaults; env may only narrow.
    multipartLimits: multipartLimitsFromEnv(),
    adminLocalAuthEnabled: process.env.DU_ADMIN_AUTH_MODE === 'local',
    adminLocalServiceSecret: optional('DU_ADMIN_LOCAL_SERVICE_SECRET'),
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
