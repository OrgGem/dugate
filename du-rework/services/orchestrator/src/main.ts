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
import { createLogger, safeErrorForLog } from '@du/observability';
import { installGracefulShutdown } from './shutdown';
import { buildOidcAdminComponents } from './app/admin/oidc-boot';
import { buildEncryptionBootOptions, type EncryptionBootOptions } from './modules/encryption/boot-options';

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

async function main(): Promise<void> {
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
  if (encryptionBoot.metadataEncryption || encryptionBoot.publicUploadEncryption) {
    logger.info('artifact encryption enabled', {
      metadata: Boolean(encryptionBoot.metadataEncryption),
      publicUpload: Boolean(encryptionBoot.publicUploadEncryption),
    });
  }
  const app = await createApp({
    port: positiveInteger('ORCHESTRATOR_PORT', positiveInteger('PORT', 3000)),
    databaseUrl: required('DATABASE_URL'),
    redisUrl: optional('REDIS_URL') ?? 'redis://127.0.0.1:6379',
    runtimeToken: optional('RUNTIME_TOKEN'),
    workerIdentityTokensByBusiness: workerIdentityTokensByBusiness(),
    adminToken: optional('ADMIN_TOKEN'),
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
    // RV01-02 (#8): supply the crypto blocks so control-plane columns are
    // sealed. Absent these, createApp leaves metadataCrypto undefined and every
    // control-plane column silently keeps plaintext behaviour. Building them
    // here is fail-closed: a half-specified surface throws instead of degrading.
    ...encryptionBoot,
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

void main().catch((error: unknown) => {
  logger.error('orchestrator startup failed', { error: safeErrorForLog(error) });
  process.exit(1);
});
