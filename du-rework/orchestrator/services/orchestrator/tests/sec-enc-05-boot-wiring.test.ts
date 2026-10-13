/**
 * SEC-ENC-05 wiring lock: boot policy → composition → consumers.
 *
 * Pins that `createApp` actually wires SEC-ENC-04 server-mediated encryption
 * into `createArtifactService` and `createMultipartService`, builds the SC-02
 * runtime secret resolver from the injected adapter options, and surfaces the
 * effective content-free policy in `/health`.
 *
 * Offline: scripted `pg` for the boot's verify-only migration check and a
 * closed-port Redis (no connection is attempted by any assertion here).
 */
import { join } from 'node:path';
import { createApp, route } from '../src/server';
import type { ServerConfig } from '../src/server';
import type { RouteContext } from '../src/http/route-context';
import { loadMigrationFiles } from '../src/db/migrations';
import { mockCreateStorageGenerationFixture, mockOpenBackupEffectGateResult } from './helpers/backup-effect-gate';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import { createMultipartService } from '../src/modules/artifacts/multipart-service';
import type { KeyProvider } from '../src/modules/encryption/vault-transit-provider';
import { createIngestionConsumer } from '../src/modules/operations/ingestion-consumer';
import { createRuntimeSecretResolver } from '../src/modules/secrets/vault-resolver';

jest.mock('../src/modules/artifacts/artifacts', () => {
  const actual = jest.requireActual('../src/modules/artifacts/artifacts');
  return {
    ...actual,
    createArtifactService: jest.fn(() => ({
      list: jest.fn(),
      read: jest.fn(),
      uploadGrant: jest.fn(),
    })),
  };
});

jest.mock('../src/modules/artifacts/multipart-service', () => {
  const actual = jest.requireActual('../src/modules/artifacts/multipart-service');
  return { ...actual, createMultipartService: jest.fn(() => ({})) };
});

jest.mock('../src/modules/secrets/vault-resolver', () => {
  const actual = jest.requireActual('../src/modules/secrets/vault-resolver');
  return { ...actual, createRuntimeSecretResolver: jest.fn(actual.createRuntimeSecretResolver) };
});

jest.mock('../src/modules/operations/ingestion-consumer', () => {
  const actual = jest.requireActual('../src/modules/operations/ingestion-consumer');
  return {
    ...actual,
    createIngestionConsumer: jest.fn(() => ({
      runOnce: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    })),
  };
});

interface MinimalState {
  schemaLedger: { sequence: number; filename: string }[];
}

jest.mock('pg', () => {
  const state = { schemaLedger: [] as { sequence: number; filename: string }[] };
  let mockStorage: ReturnType<typeof mockCreateStorageGenerationFixture> | undefined;
  const getMockStorage = () => (mockStorage ??= mockCreateStorageGenerationFixture());
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const backupGate = mockOpenBackupEffectGateResult(text);
    if (backupGate) return backupGate;
    const storage = getMockStorage().answer(text, params);
    if (storage) return storage;
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: state.schemaLedger.length };
    if (/FROM schema_migrations/i.test(text)) return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string, params?: unknown[]): Promise<PgResult> {
      return answer(sql, params ?? []);
    }
    async connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<PgResult>; release: () => void }> {
      return { query: (sql, params) => Promise.resolve(answer(sql, params ?? [])), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

const artifactFactory = createArtifactService as unknown as jest.Mock;
const multipartFactory = createMultipartService as unknown as jest.Mock;
const resolverFactory = createRuntimeSecretResolver as unknown as jest.Mock;
const ingestionConsumerFactory = createIngestionConsumer as unknown as jest.Mock;

const PROVIDER: KeyProvider = {
  async wrapDek(input) {
    return { keyRef: input.keyRef, keyVersion: input.keyVersion ?? 1, ciphertext: Buffer.from(input.dek).toString('base64') };
  },
  async unwrapDek(wrapped) {
    return Buffer.from(wrapped.ciphertext, 'base64');
  },
  async rewrap(wrapped) {
    return wrapped;
  },
};

const PUBLIC_UPLOAD = { keyProvider: PROVIDER, keyRef: 'artifact-key', keyVersion: 3 };

const REAL_POLICY = {
  dataMode: 'real' as const,
  metadataEncryption: true,
  publicUploadEncryption: true,
  metadataPlaintextReadMode: 'forbid' as const,
  profileCipherKeyPresent: true,
};

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];

async function boot(overrides: Partial<ServerConfig>): Promise<App> {
  const app = await createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/sec_enc_05_wiring',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'sec-enc-05-admin',
    autoDispatch: false,
    autoMigrate: false,
    ...overrides,
  });
  apps.push(app);
  return app;
}

beforeAll(() => {
  const state = (jest.requireMock('pg') as { __duState: MinimalState }).__duState;
  state.schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map((file) => ({
    sequence: file.sequence,
    filename: file.filename,
  }));
});

beforeEach(() => {
  artifactFactory.mockClear();
  multipartFactory.mockClear();
  resolverFactory.mockClear();
  ingestionConsumerFactory.mockClear();
});

afterAll(async () => {
  for (const app of apps) {
    await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
  }
});

describe('SEC-ENC-05 boot wiring', () => {
  it('wires encrypted source storage and requires it in real-data mode', async () => {
    await boot({
      artifactStorage: { backend: 's3', bucket: 'private-source' },
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: REAL_POLICY,
      ingestionConsumer: { intervalMs: 0 },
    });

    expect(ingestionConsumerFactory).toHaveBeenCalledTimes(1);
    const consumerOptions = ingestionConsumerFactory.mock.calls[0]![0] as {
      storage: { putEncrypted?: unknown };
      requireEncryptedSourceWrites?: boolean;
    };
    expect(typeof consumerOptions.storage.putEncrypted).toBe('function');
    expect(consumerOptions.requireEncryptedSourceWrites).toBe(true);
  });

  it('keeps the encrypted-source requirement off in synthetic mode', async () => {
    await boot({
      artifactStorage: { backend: 's3', bucket: 'private-source' },
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: { ...REAL_POLICY, dataMode: 'synthetic' },
      ingestionConsumer: { intervalMs: 0 },
    });

    expect(ingestionConsumerFactory).toHaveBeenCalledTimes(1);
    const consumerOptions = ingestionConsumerFactory.mock.calls[0]![0] as {
      storage: { putEncrypted?: unknown };
      requireEncryptedSourceWrites?: boolean;
    };
    expect(typeof consumerOptions.storage.putEncrypted).toBe('function');
    expect(consumerOptions.requireEncryptedSourceWrites).toBe(false);
  });

  it('keeps the compatibility source adapter when synthetic mode has no encryption config', async () => {
    await boot({
      artifactStorage: { backend: 's3', bucket: 'private-source' },
      encryptionPolicy: {
        ...REAL_POLICY,
        dataMode: 'synthetic',
        publicUploadEncryption: false,
      },
      ingestionConsumer: { intervalMs: 0 },
    });

    expect(ingestionConsumerFactory).toHaveBeenCalledTimes(1);
    const consumerOptions = ingestionConsumerFactory.mock.calls[0]![0] as {
      storage: { putEncrypted?: unknown };
      requireEncryptedSourceWrites?: boolean;
    };
    expect(consumerOptions.storage.putEncrypted).toBeUndefined();
    expect(consumerOptions.requireEncryptedSourceWrites).toBe(false);
  });

  it('wires server-mediated encryption into artifacts + multipart and builds the secret resolver', async () => {
    await boot({
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: REAL_POLICY,
      secrets: {
        decryptManagedValue: { decrypt: async () => 'resolved-value' },
      },
    });

    expect(artifactFactory).toHaveBeenCalledTimes(1);
    const artifactOptions = artifactFactory.mock.calls[0]![1] as {
      encryption?: { keyRef: string; keyVersion?: number; required?: boolean; facade?: unknown };
    };
    expect(artifactOptions.encryption?.keyRef).toBe('artifact-key');
    expect(artifactOptions.encryption?.keyVersion).toBe(3);
    expect(artifactOptions.encryption?.facade).toBeDefined();
    // Real-data mode must not read legacy unsealed worker artifacts.
    expect(artifactOptions.encryption?.required).toBe(true);

    expect(multipartFactory).toHaveBeenCalledTimes(1);
    const multipartOptions = multipartFactory.mock.calls[0]![1] as { encryptionRequired?: boolean };
    expect(multipartOptions.encryptionRequired).toBe(true);

    // SC-02 seam: composition built the runtime resolver from the injected
    // adapter options (no plaintext resolver API is exposed).
    expect(resolverFactory).toHaveBeenCalledTimes(1);
    const resolverOptions = resolverFactory.mock.calls[0]![0] as { decryptManagedValue?: unknown };
    expect(resolverOptions.decryptManagedValue).toBeDefined();
  });

  it('keeps every write path plaintext in synthetic mode, multipart included (SEC-ENC-03 B2/B4)', async () => {
    await boot({
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: { ...REAL_POLICY, dataMode: 'synthetic' },
    });

    const artifactOptions = artifactFactory.mock.calls[0]![1] as { encryption?: { required?: boolean } };
    expect(artifactOptions.encryption?.required).toBe(false);
    // B2/B4: synthetic is all-or-nothing, so multipart must NOT require encryption
    // while the other artifact-side paths are exempt.
    const multipartOptions = multipartFactory.mock.calls[0]![1] as { encryptionRequired?: boolean };
    expect(multipartOptions.encryptionRequired).toBe(false);
    // No adapter options injected → no resolver is fabricated.
    expect(resolverFactory).not.toHaveBeenCalled();
  });

  // SEC-ENC-03 B3: the migration window exempts objects written before
  // encryption existed, but the source-write path decides about data arriving
  // NOW, so it must keep requiring encryption in real mode even while the
  // window is open.
  it('never exempts the source-write path, even while the artifact migration window is open', async () => {
    await boot({
      artifactStorage: { backend: 's3', bucket: 'private-source', migrationWindow: true },
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: REAL_POLICY,
    });

    // Artifact-side paths honor the window...
    const artifactOptions = artifactFactory.mock.calls[0]![1] as { encryption?: { required?: boolean } };
    expect(artifactOptions.encryption?.required).toBe(false);
    const multipartOptions = multipartFactory.mock.calls[0]![1] as { encryptionRequired?: boolean };
    expect(multipartOptions.encryptionRequired).toBe(false);
    // ...but the source-write path does not.
    const consumerOptions = ingestionConsumerFactory.mock.calls[0]![0] as { requireEncryptedSourceWrites?: boolean };
    expect(consumerOptions.requireEncryptedSourceWrites).toBe(true);
  });

  it('a deployment without encryption config gets no artifact seam and no multipart block', async () => {
    await boot({
      encryptionPolicy: {
        dataMode: 'synthetic',
        syntheticReason: 'local fixtures',
        metadataEncryption: false,
        publicUploadEncryption: false,
        metadataPlaintextReadMode: 'none',
        profileCipherKeyPresent: false,
      },
    });

    const artifactOptions = artifactFactory.mock.calls[0]![1] as { encryption?: unknown };
    expect(artifactOptions.encryption).toBeUndefined();
    const multipartOptions = multipartFactory.mock.calls[0]![1] as { encryptionRequired?: boolean };
    expect(multipartOptions.encryptionRequired).toBe(false);
  });

  it('surfaces the effective policy (and resolver availability) in /health, content-free', async () => {
    const context = {
      ingressAudience: 'public',
      method: 'GET',
      pathname: '/health',
      searchParams: new URLSearchParams(),
      headers: {},
      body: null,
      rawBody: Buffer.alloc(0),
      correlationId: 'sec-enc-05-health',
      host: 'localhost',
      db: { query: async () => ({ rows: [{}], rowCount: 1 }) },
      runtime: { getActiveLeasesCount: async () => 3 },
      redis: { ping: async () => 'PONG' },
      queueIntegrity: () => undefined,
      config: {
        workerIdentityTokensByBusiness: {},
        encryptionPolicy: REAL_POLICY,
        secrets: { decryptManagedValue: { decrypt: async () => 'x' } },
      },
    } as unknown as RouteContext;

    const result = await route(context);
    expect(result.status).toBe(200);
    const body = result.body as { encryption?: unknown };
    expect(body.encryption).toEqual({
      dataMode: 'real',
      metadataEncryption: true,
      publicUploadEncryption: true,
      metadataPlaintextReadMode: 'forbid',
      profileCipherKeyPresent: true,
      secretResolver: true,
    });
    expect(JSON.stringify(body)).not.toContain('resolved-value');
  });
});
