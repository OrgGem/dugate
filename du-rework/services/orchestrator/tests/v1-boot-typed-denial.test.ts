import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { PinnedSourceStorage, SdkFetcher } from '@du/worker-sdk';
import type { Db } from '../src/db/db';
import {
  createAcquisitionRefResolver,
  SourceAuthDeniedError,
} from '../src/modules/operations/acquisition-ref-resolver';
import { createIngestionConsumer } from '../src/modules/operations/ingestion-consumer';
import { encryptFileUrlAuthConfig } from '../src/modules/profiles/file-url-auth';

const TENANT = '60000000-0000-4000-8000-000000000001';
const OPERATION = '61000000-0000-4000-8000-000000000001';
const TASK = '62000000-0000-4000-8000-000000000001';
const OUTBOX = '64000000-0000-4000-8000-000000000001';
const PROFILE = '63000000-0000-4000-8000-000000000001';
const PROFILE_REVISION = 7;
const SOURCE_URL = 'https://files.example/report.pdf';
const CONFIGURED_ENV = { ENCRYPTION_KEY: 'profile-key-for-v1-denial-tests' };

interface ResolverDbOptions {
  cipher: unknown;
}

function makeResolverDb(options: ResolverDbOptions): Db {
  const query = async <T extends QueryResultRow>(sqlText: string): Promise<QueryResult<T>> => {
    const sql = sqlText.replace(/\s+/g, ' ').trim();
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM operations WHERE id=$1 AND tenant_id=$2')) {
      rows = [{
        snapshot: {
          fileUrlAuthConfigured: true,
          credentialRef: { tenantId: TENANT, profileId: PROFILE, profileRevision: PROFILE_REVISION },
        },
      }];
    } else if (sql.includes('FROM profile_bindings WHERE profile_id=$1 AND revision=$2')) {
      rows = [{ tenantId: TENANT, cipher: options.cipher }];
    } else {
      throw new Error('unrouted resolver SQL: ' + sql);
    }
    return { rowCount: rows.length, rows } as unknown as QueryResult<T>;
  };
  return {
    pool: {} as Pool,
    query,
    tx: async <T>(work: (client: PoolClient) => Promise<T>) => work({ query } as unknown as PoolClient),
    close: async () => undefined,
  } as Db;
}

function resolverFor(cipher: unknown, env: Record<string, string | undefined>) {
  return createAcquisitionRefResolver({ db: makeResolverDb({ cipher }), env });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected resolver denial');
}

interface ConsumerState {
  failTaskParams: unknown[][];
  failOperationParams: unknown[][];
  retryParams: unknown[][];
}

function makeConsumerDb(): { db: Db; state: ConsumerState } {
  const state: ConsumerState = { failTaskParams: [], failOperationParams: [], retryParams: [] };
  const query = async <T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    let rows: Record<string, unknown>[] = [];
    let rowCount = 0;
    if (sql.includes("payload->>'gate' = 'ingestion'")) {
      rows = [{
        id: OUTBOX,
        aggregate_id: OPERATION,
        delivery_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        attempts: 0,
        payload: {
          gate: 'ingestion',
          operationId: OPERATION,
          taskId: TASK,
          sourceUrl: SOURCE_URL,
          kind: 'root',
          correlationId: 'corr-v1-denial',
        },
      }];
      rowCount = 1;
    } else if (sql.startsWith('UPDATE outbox SET claim_until = now()')) {
      rowCount = 1;
    } else if (sql === 'SELECT id FROM outbox WHERE id = $1 FOR UPDATE') {
      rows = [{ id: OUTBOX }];
      rowCount = 1;
    } else if (sql.includes('FROM tasks t JOIN operations o')) {
      rows = [{
        taskId: TASK,
        taskState: 'PENDING_INGESTION',
        payloadRef: { input: { text: 'offline' }, sourceUrl: SOURCE_URL },
        tenantId: TENANT,
        opState: 'PENDING_INGESTION',
        cancelRequested: false,
      }];
      rowCount = 1;
    } else if (sql.startsWith("UPDATE tasks SET state='FAILED'")) {
      state.failTaskParams.push(params);
      rowCount = 1;
    } else if (sql.startsWith("UPDATE operations SET state='FAILED'")) {
      state.failOperationParams.push(params);
      rowCount = 1;
    } else if (sql.startsWith('UPDATE outbox SET claim_until = NULL')) {
      state.retryParams.push(params);
      rowCount = 1;
    } else if (sql.startsWith('UPDATE outbox SET dispatched_at = now()')) {
      rowCount = 1;
    } else if (sql.startsWith('SELECT id, tenant_id, state, state_version, callback_url,')) {
      rows = [{
        id: OPERATION,
        tenant_id: TENANT,
        state: 'FAILED',
        state_version: 2,
        callback_url: null,
        updated_at: new Date().toISOString(),
      }];
      rowCount = 1;
    } else {
      throw new Error('unrouted consumer SQL: ' + sql.slice(0, 120));
    }
    return { rowCount, rows } as unknown as QueryResult<T>;
  };
  const client = { query } as unknown as PoolClient;
  const db = {
    pool: {} as Pool,
    query,
    tx: async <T>(work: (txClient: PoolClient) => Promise<T>) => work(client),
    close: async () => undefined,
  } as Db;
  return { db, state };
}

function noNetworkStorage(): PinnedSourceStorage {
  return {
    resolvePinned: async () => null,
    putVerified: async () => {
      throw new Error('storage must not be reached after auth denial');
    },
  };
}

interface BootApp {
  listen(): Promise<{ address(): { port: number } }>;
  close(): Promise<void>;
}

const mockBootLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mockListen = jest.fn<Promise<{ address: () => { port: number } }>, []>();
const mockClose = jest.fn<Promise<void>, []>();
const mockCreateApp = jest.fn<Promise<BootApp>, [unknown]>();

const BOOT_ENV_NAMES = [
  'DATABASE_URL', 'REDIS_URL', 'ORCHESTRATOR_PORT', 'PORT', 'RUNTIME_TOKEN',
  'WORKER_IDENTITY_TOKENS_BY_BUSINESS', 'ADMIN_TOKEN', 'TENANT_ADMIN_TOKENS_BY_TENANT',
  'USAGE_TOKEN', 'INVOCATION_GRANT_SECRET', 'WEBHOOK_SECRET', 'WEBHOOK_DISPATCH_INTERVAL_MS',
  'WEBHOOK_DRAIN_TIMEOUT_MS', 'SHUTDOWN_TIMEOUT_MS', 'AUTO_MIGRATE', 'AUTO_DISPATCH',
  'ARTIFACT_STORAGE_BACKEND', 'ARTIFACT_STORAGE_MIGRATION_WINDOW', 'ARTIFACT_S3_BUCKET',
  'ARTIFACT_S3_REGION', 'ARTIFACT_S3_ENDPOINT', 'ARTIFACT_S3_FORCE_PATH_STYLE',
  'SHUTDOWN_BUDGET_MS', 'ADMIN_SHELL_COOKIE_SECRET', 'ADMIN_SHELL_PORT', 'ADMIN_SHELL_HOST',
  'ENCRYPTION_KEY', 'NEXTAUTH_SECRET',
] as const;

async function withBootEnv<T>(overrides: Partial<Record<(typeof BOOT_ENV_NAMES)[number], string>>, work: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const name of BOOT_ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, overrides, {
    DATABASE_URL: 'postgres://offline.invalid/orchestrator',
    PORT: '3000',
  });
  try {
    return await work();
  } finally {
    for (const name of BOOT_ENV_NAMES) {
      const previous = saved[name];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
}

let runMain: typeof import('../src/main').main;

/** F-VFY6-01: mutable effective policy the real boot predicate is driven with. */
const DEFAULT_BOOT_POLICY: Record<string, unknown> = {
  dataMode: 'real',
  metadataEncryption: false,
  publicUploadEncryption: false,
  metadataPlaintextReadMode: 'none',
  profileCipherKeyPresent: false,
};
let mockPolicy: Record<string, unknown> = { ...DEFAULT_BOOT_POLICY };

beforeAll(async () => {
  jest.doMock('@du/observability', () => ({
    createLogger: jest.fn(() => mockBootLogger),
    safeErrorForLog: jest.fn((error: unknown) => String(error)),
  }));
  jest.doMock('../src/server', () => ({
    createApp: mockCreateApp,
    multipartLimitsFromEnv: jest.fn(() => ({})),
  }));
  jest.doMock('../src/shutdown', () => ({ installGracefulShutdown: jest.fn() }));
  jest.doMock('../src/app/admin/oidc-boot', () => ({ buildOidcAdminComponents: jest.fn(() => null) }));
  jest.doMock('../src/modules/encryption/boot-options', () => {
    const actual = jest.requireActual('../src/modules/encryption/boot-options');
    return {
      ...actual,
      buildEncryptionBootOptions: jest.fn(() => undefined),
      // SEC-ENC-05 / F-VFY6-01: main always resolves the effective policy;
      // tests steer the seam/mode through this mutable summary while the REAL
      // `assertProfileCipherBootPolicy` runs, so the hybrid boot refusal is
      // exercised end-to-end through main().
      summarizeEncryptionPolicy: jest.fn(() => mockPolicy),
      assertProfileCipherBootPolicy: actual.assertProfileCipherBootPolicy,
    };
  });
  runMain = (await import('../src/main')).main;
});

beforeEach(() => {
  mockPolicy = { ...DEFAULT_BOOT_POLICY };
  mockBootLogger.info.mockClear();
  mockBootLogger.warn.mockClear();
  mockBootLogger.error.mockClear();
  mockListen.mockReset();
  mockClose.mockReset();
  mockCreateApp.mockReset();
  mockListen.mockResolvedValue({ address: () => ({ port: 3000 }) });
  mockClose.mockResolvedValue(undefined);
  mockCreateApp.mockResolvedValue({ listen: mockListen, close: mockClose });
});

describe('V1 boot missing profile cipher key policy', () => {
  it('continues boot without either key and emits one warning naming the denied operation', async () => {
    await withBootEnv({}, runMain);

    expect(mockCreateApp).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockBootLogger.warn).toHaveBeenCalledTimes(1);
    expect(String(mockBootLogger.warn.mock.calls[0]?.[0])).toContain(
      'configured-cipher acquisition will deny with AUTH_DECRYPT_FAILED'
    );
    expect(mockBootLogger.info).toHaveBeenCalledWith('orchestrator listening', { address: 3000 });
  });

  it('does not warn when either supported profile key is present', async () => {
    await withBootEnv({ NEXTAUTH_SECRET: 'fallback-profile-key' }, runMain);
    expect(mockCreateApp).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockBootLogger.warn).not.toHaveBeenCalled();
  });

  it('refuses a keyless real-data boot with the artifact seam enabled outside dev/test', async () => {
    mockPolicy = { ...DEFAULT_BOOT_POLICY, metadataEncryption: true, publicUploadEncryption: true };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await withBootEnv({}, async () => {
        await expect(runMain()).rejects.toThrow(
          /refusing to boot: ENCRYPTION_KEY \(or NEXTAUTH_SECRET\) is required/,
        );
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    expect(mockCreateApp).not.toHaveBeenCalled();
    expect(mockBootLogger.warn).not.toHaveBeenCalled();
  });

  it('staging refuses too (no carve-out)', async () => {
    mockPolicy = { ...DEFAULT_BOOT_POLICY, metadataEncryption: true };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    try {
      await withBootEnv({}, async () => {
        await expect(runMain()).rejects.toThrow(/real-data mode/);
      });
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    expect(mockCreateApp).not.toHaveBeenCalled();
  });

  it('keeps warn-only in development with the seam enabled', async () => {
    mockPolicy = { ...DEFAULT_BOOT_POLICY, metadataEncryption: true, publicUploadEncryption: true };
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await withBootEnv({}, runMain);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    expect(mockCreateApp).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockBootLogger.warn).toHaveBeenCalledTimes(1);
    expect(String(mockBootLogger.warn.mock.calls[0]?.[0])).toContain('AUTH_DECRYPT_FAILED');
  });

  it('keeps warn-only for an explicit synthetic deployment outside dev/test', async () => {
    mockPolicy = {
      ...DEFAULT_BOOT_POLICY,
      dataMode: 'synthetic',
      metadataEncryption: true,
      publicUploadEncryption: true,
    };
    const previousNodeEnv = process.env.NODE_ENV;
    // staging (not production) avoids the unrelated production-only
    // ORCHESTRATOR_INTERNAL_BASE_URL guard while still proving the bypass for
    // every NODE_ENV outside {development, test}.
    process.env.NODE_ENV = 'staging';
    try {
      await withBootEnv({}, runMain);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
    expect(mockCreateApp).toHaveBeenCalledTimes(1);
    // one synthetic-mode warning + one profile-cipher warning
    expect(mockBootLogger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('V1 profile cipher denial', () => {
  it('turns missing-key consumption of a configured cipher into the typed denial', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token' }, CONFIGURED_ENV);
    const resolver = resolverFor(cipher, {});
    const error = await captureError(resolver.resolveSourceAuth({ operationId: OPERATION, tenantId: TENANT }));
    const typedSourceAuthDenial = error instanceof SourceAuthDeniedError;

    expect(typedSourceAuthDenial).toBe(true);
    if (typedSourceAuthDenial) {
      expect(error).toMatchObject({
        status: 500,
        code: 'AUTH_DECRYPT_FAILED',
        message: 'stored auth cipher could not be decrypted with this deployment key',
      });
      expect(error.message).not.toContain('source-token');
    }
  });

  it('classifies the missing-key typed denial as permanent in the ingestion consumer', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token' }, CONFIGURED_ENV);
    const resolver = resolverFor(cipher, {});
    const { db, state } = makeConsumerDb();
    const fetcher = jest.fn(async () => new Response('must not fetch', { status: 200 })) as unknown as SdkFetcher;
    const consumer = createIngestionConsumer({
      db,
      storage: noNetworkStorage(),
      transfer: { maxBytes: 1024, timeoutMs: 1_000, maxRedirects: 0, fetcher },
      storageBackend: 's3',
      resolveSourceAuth: (coords) => resolver.resolveSourceAuth(coords),
    });

    const result = await consumer.runOnce();

    expect(result).toMatchObject({ retried: 0, escalated: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.failTaskParams[0]?.[1]).toBe('AUTH_DECRYPT_FAILED');
    expect(state.failOperationParams[0]?.[1]).toBe('AUTH_DECRYPT_FAILED');
    expect(state.retryParams).toEqual([]);
  });

  it('decrypts a configured cipher normally when a supported key is available', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token' }, CONFIGURED_ENV);
    const resolver = resolverFor(cipher, CONFIGURED_ENV);

    await expect(resolver.resolveSourceAuth({ operationId: OPERATION, tenantId: TENANT })).resolves.toEqual({
      kind: 'bearer',
      token: 'source-token',
    });
  });

  it('denies tampered ciphertext with a valid key instead of returning unauthenticated', async () => {
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'source-token' }, CONFIGURED_ENV);
    const tampered = cipher.slice(0, -1) + (cipher.endsWith('0') ? '1' : '0');
    const resolver = resolverFor(tampered, CONFIGURED_ENV);
    const error = await captureError(resolver.resolveSourceAuth({ operationId: OPERATION, tenantId: TENANT }));

    expect(error).toBeInstanceOf(SourceAuthDeniedError);
    expect(error).toMatchObject({ status: 500, code: 'AUTH_DECRYPT_FAILED' });
  });
});
