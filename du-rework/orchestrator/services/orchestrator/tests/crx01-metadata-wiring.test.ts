/**
 * CRX-01 wiring lock: ONE metadata seam, handed to all three durable writers.
 *
 * The behavioral suites prove each writer seals (submit via createApp; the
 * consumer via its offline functional harness). This file pins the composition
 * the addendum actually asked for: `createApp` must build the seam BEFORE the
 * writers and pass the SAME instance to
 *   `createSubmissionService`, `createRuntimeService`, and the ingestion
 *   consumer's `createIngestionConsumer`.
 *
 * The three factories are observed directly (partial module mocks; everything
 * else is the real module), so a refactor that drops one argument — the
 * original defect was exactly a missing argument — fails here even if the
 * behavior suites stay green by luck of module defaults.
 *
 * Offline: scripted `pg` for the boot's verify-only migration check, closed-port
 * Redis; the S3 backend is only needed so `createApp` reaches the consumer
 * construction branch and never touches the network.
 */
import { join } from 'node:path';
import { createApp, type App } from '../src/server';
import { loadMigrationFiles } from '../src/db/migrations';
import { createSubmissionService } from '../src/modules/operations/submission';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { createIngestionConsumer } from '../src/modules/operations/ingestion-consumer';
import type { KeyProvider } from '../src/modules/encryption/vault-transit-provider';

jest.mock('../src/modules/operations/submission', () => {
  const actual = jest.requireActual('../src/modules/operations/submission');
  return { ...actual, createSubmissionService: jest.fn(() => ({ submit: jest.fn() })) };
});

jest.mock('../src/modules/runtime/runtime', () => {
  const actual = jest.requireActual('../src/modules/runtime/runtime');
  return {
    ...actual,
    createRuntimeService: jest.fn(() => ({
      drain: jest.fn(async () => undefined),
      sweepQueueIntegrity: jest.fn(async () => ({ rearmed: 0, stalled: 0 })),
      sweepExpiredLeases: jest.fn(async () => 0),
      getActiveLeasesCount: jest.fn(async () => 0),
    })),
  };
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
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
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

const submissionFactory = createSubmissionService as unknown as jest.Mock;
const runtimeFactory = createRuntimeService as unknown as jest.Mock;
const consumerFactory = createIngestionConsumer as unknown as jest.Mock;

/** Reversible stand-in for the Vault provider; never dialed in this suite. */
const PROVIDER: KeyProvider = {
  async wrapDek(input) {
    return {
      keyRef: input.keyRef,
      keyVersion: input.keyVersion ?? 1,
      ciphertext: Buffer.from(input.dek).toString('base64'),
    };
  },
  async unwrapDek(wrapped) {
    return Buffer.from(wrapped.ciphertext, 'base64');
  },
  async rewrap(wrapped) {
    return wrapped;
  },
};

async function boot(withMetadataEncryption: boolean): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_crx01_wiring',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'crx01-wiring-admin',
    autoDispatch: false,
    autoMigrate: false,
    artifactStorage: { backend: 's3', bucket: 'crx01-wiring-bucket' },
    ...(withMetadataEncryption
      ? { metadataEncryption: { keyProvider: PROVIDER, keyRef: 'crx01-wiring-v1' } }
      : {}),
  });
}

describe('CRX-01: createApp hands ONE metadata seam to submission, runtime and the ingestion consumer', () => {
  const apps: App[] = [];

  beforeAll(() => {
    const state = (jest.requireMock('pg') as { __duState: MinimalState }).__duState;
    state.schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  beforeEach(() => {
    submissionFactory.mockClear();
    runtimeFactory.mockClear();
    consumerFactory.mockClear();
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('passes the SAME metadataCrypto instance to all three writers', async () => {
    const app = await boot(true);
    apps.push(app);

    expect(submissionFactory).toHaveBeenCalledTimes(1);
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(consumerFactory).toHaveBeenCalledTimes(1);

    const submissionOptions = submissionFactory.mock.calls[0]![3] as { metadataCrypto?: unknown };
    const runtimeCrypto = runtimeFactory.mock.calls[0]![2];
    const consumerOptions = consumerFactory.mock.calls[0]![0] as { metadataCrypto?: unknown };

    expect(submissionOptions.metadataCrypto).toBeDefined();
    expect(runtimeCrypto).toBeDefined();
    expect(consumerOptions.metadataCrypto).toBeDefined();
    expect(runtimeCrypto).toBe(submissionOptions.metadataCrypto);
    expect(consumerOptions.metadataCrypto).toBe(submissionOptions.metadataCrypto);
  });

  it('without metadataEncryption the seam stays undefined for all three (opt-in preserved)', async () => {
    const app = await boot(false);
    apps.push(app);

    const submissionOptions = submissionFactory.mock.calls[0]![3] as { metadataCrypto?: unknown };
    const runtimeCrypto = runtimeFactory.mock.calls[0]![2];
    const consumerOptions = consumerFactory.mock.calls[0]![0] as { metadataCrypto?: unknown };

    expect(submissionOptions.metadataCrypto).toBeUndefined();
    expect(runtimeCrypto).toBeUndefined();
    expect(consumerOptions.metadataCrypto).toBeUndefined();
  });
});
