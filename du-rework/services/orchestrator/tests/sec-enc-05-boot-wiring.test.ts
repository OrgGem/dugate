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
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import { createMultipartService } from '../src/modules/artifacts/multipart-service';
import type { KeyProvider } from '../src/modules/encryption/vault-transit-provider';
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

interface MinimalState {
  schemaLedger: { sequence: number; filename: string }[];
}

jest.mock('pg', () => {
  const state = { schemaLedger: [] as { sequence: number; filename: string }[] };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: state.schemaLedger.length };
    if (/FROM schema_migrations/i.test(text)) return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string): Promise<PgResult> {
      return answer(sql);
    }
    async connect(): Promise<{ query: (sql: string) => Promise<PgResult>; release: () => void }> {
      return { query: (sql) => Promise.resolve(answer(sql)), release: () => undefined };
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
});

afterAll(async () => {
  for (const app of apps) {
    await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
  }
});

describe('SEC-ENC-05 boot wiring', () => {
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

  it('keeps compatibility reads in synthetic mode while still blocking plaintext multipart when encryption is configured', async () => {
    await boot({
      publicUploadEncryption: PUBLIC_UPLOAD,
      encryptionPolicy: { ...REAL_POLICY, dataMode: 'synthetic' },
    });

    const artifactOptions = artifactFactory.mock.calls[0]![1] as { encryption?: { required?: boolean } };
    expect(artifactOptions.encryption?.required).toBe(false);
    const multipartOptions = multipartFactory.mock.calls[0]![1] as { encryptionRequired?: boolean };
    expect(multipartOptions.encryptionRequired).toBe(true);
    // No adapter options injected → no resolver is fabricated.
    expect(resolverFactory).not.toHaveBeenCalled();
  });

  it('a deployment without encryption config gets no artifact seam and no multipart block', async () => {
    await boot({
      encryptionPolicy: {
        dataMode: 'synthetic',
        syntheticReason: 'local fixtures',
        metadataEncryption: false,
        publicUploadEncryption: false,
        metadataPlaintextReadMode: 'none',
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
      secretResolver: true,
    });
    expect(JSON.stringify(body)).not.toContain('resolved-value');
  });
});
