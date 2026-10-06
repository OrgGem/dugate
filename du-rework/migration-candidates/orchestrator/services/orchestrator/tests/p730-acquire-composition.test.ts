/**
 * W1C-COMPOSITION — the createApp composition of the acquisition resolver.
 *
 * W1c proved the resolver itself (unit) and the consumer seam (with a hand-
 * wired resolver). What was NOT proven is the composition: `createApp` must
 * actually hand `resolveSourceAuth` to the ingestion consumer, bound to the
 * app's OWN db, so a deployed gate authenticates its fetches for real.
 *
 * This suite boots the REAL `createApp` (scripted `pg` twin, closed-port
 * Redis, no PG/Redis/S3/Vault) with an S3 artifact backend — the only wiring
 * that materializes the consumer — and captures the options the consumer
 * factory receives. It then DRIVES the captured `resolveSourceAuth`:
 *
 *   - legacy/unpinned operations resolve `{kind:'none'}` (feature dark →
 *     historical unauthenticated fetch, no regression);
 *   - a pinned bearer revision resolves through the REAL resolver + REAL
 *     app pool (the scripted queries are observed);
 *   - Δ2 holds at composition: a query-type credential is denied;
 *   - the typed denials survive the wiring (missing cipher, foreign tenant,
 *     absent operation).
 *
 * On a postgres-only boot the consumer stays undefined and the factory is
 * never called — the composition is a no-op there.
 */
import { join } from 'node:path';
import { createApp, type App } from '../src/server';
import { loadMigrationFiles } from '../src/db/migrations';
import { encryptFileUrlAuthConfig } from '../src/modules/profiles/file-url-auth';

const TENANT = '60000000-0000-4000-8000-000000000001';
const FOREIGN_TENANT = '60000000-0000-4000-8000-0000000000ff';
const OP = '61000000-0000-4000-8000-000000000001';
const OP_LEGACY = '61000000-0000-4000-8000-000000000002';
const PROFILE = '63000000-0000-4000-8000-000000000001';
const REVISION = 7;
const ENV_KEY = 'w1c-composition-key-00000000000000';

interface PgState {
  queries: string[];
  writes: { sql: string; params: unknown[] }[];
  schemaLedger: { sequence: number; filename: string }[];
  snapshots: Map<string, { tenantId: string; snapshot: unknown }>;
  bindings: Map<string, { tenantId: string; cipher: unknown }>;
}

jest.mock('pg', () => {
  const state = {
    queries: [] as string[],
    writes: [] as { sql: string; params: unknown[] }[],
    schemaLedger: [] as { sequence: number; filename: string }[],
    snapshots: new Map<string, { tenantId: string; snapshot: unknown }>(),
    bindings: new Map<string, { tenantId: string; cipher: unknown }>(),
  };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    const write = (): PgResult => {
      state.writes.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    };
    // Boot scaffolding (migrations verify + dev-fallback probes).
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    if (text.includes('INSERT INTO tenants')) return write();
    // Resolver routes — checked BEFORE the generic operations route below.
    if (text.includes('FROM operations WHERE id=$1 AND tenant_id=$2')) {
      const hit = state.snapshots.get(String(params[0]));
      if (!hit || hit.tenantId !== String(params[1])) return { rows: [], rowCount: 0 };
      return { rows: [{ snapshot: hit.snapshot }], rowCount: 1 };
    }
    if (text.includes('FROM profile_bindings WHERE profile_id=$1 AND revision=$2')) {
      const hit = state.bindings.get(`${String(params[0])}::${String(params[1])}`);
      return hit ? { rows: [hit], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Boot/route scaffolding mirrored from the crx01 twin.
    if (text.includes('INSERT INTO operations')) return write();
    if (text.includes('INSERT INTO tasks')) return write();
    if (text.includes('INSERT INTO submission_keys')) return write();
    if (text.includes('INSERT INTO outbox')) return write();
    if (/FROM business_versions/i.test(text)) {
      return {
        rows: [{
          version: '1.0.0',
          manifest: {
            actions: [{ name: 'extract', inputSchema: { type: 'object', additionalProperties: true } }],
            runtime: { handlerKinds: ['root'] },
          },
          digest: 'sha256:test',
          queue: 'du-q',
        }],
        rowCount: 1,
      };
    }
    if (/FROM submission_keys/i.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM operations WHERE id=\$1/i.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string, params: unknown[] = []): Promise<PgResult> {
      return answer(sql, params);
    }
    async connect(): Promise<{
      query: (sql: string, params?: unknown[]) => Promise<PgResult>;
      release: () => void;
    }> {
      return { query: (sql, params = []) => Promise.resolve(answer(sql, params)), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

jest.mock('../src/modules/operations/ingestion-consumer', () => ({
  createIngestionConsumer: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    runOnce: jest.fn(async () => ({ claimed: 0, opened: 0, retried: 0, escalated: 0, skipped: 0 })),
  })),
}));

import { createIngestionConsumer } from '../src/modules/operations/ingestion-consumer';

function scripted(): PgState {
  return (jest.requireMock('pg') as { __duState: PgState }).__duState;
}

const mockCreate = createIngestionConsumer as unknown as jest.Mock;

function bootPg(): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_w1c_comp',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'w1c-admin-token',
    autoDispatch: false,
    autoMigrate: false,
  });
}

function bootS3(): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_w1c_comp',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'w1c-admin-token',
    autoDispatch: false,
    autoMigrate: false,
    artifactStorage: {
      backend: 's3',
      bucket: 'du-offline-w1c',
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9003',
      forcePathStyle: true,
    },
  });
}

type ResolverFn = (coords: { operationId: string; tenantId: string }) => Promise<unknown>;

function capturedResolver(): ResolverFn {
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const options = mockCreate.mock.calls[0]![0] as { resolveSourceAuth?: ResolverFn };
  expect(typeof options.resolveSourceAuth).toBe('function');
  return options.resolveSourceAuth!;
}

function seedPinned(operationId: string, cipher: unknown, ref: Record<string, unknown> = {}): void {
  scripted().snapshots.set(operationId, {
    tenantId: TENANT,
    snapshot: {
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT, profileId: PROFILE, profileRevision: REVISION, ...ref },
      enabled: true,
    },
  });
  scripted().bindings.set(`${PROFILE}::${REVISION}`, { tenantId: TENANT, cipher });
}

describe('W1C-COMPOSITION — createApp wires the acquisition resolver', () => {
  const apps: App[] = [];
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = ENV_KEY;
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  beforeEach(() => {
    mockCreate.mockClear();
    scripted().queries.length = 0;
    scripted().writes.length = 0;
    scripted().snapshots.clear();
    scripted().bindings.clear();
  });

  it('postgres-only boot: consumer stays undefined and the factory is never called', async () => {
    const app = await bootPg();
    apps.push(app);
    expect(app.ingestionConsumer).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('s3 boot: the consumer receives resolveSourceAuth bound to the app db', async () => {
    const app = await bootS3();
    apps.push(app);
    expect(app.ingestionConsumer).toBeDefined();
    const options = mockCreate.mock.calls[0]![0] as { db: unknown };
    expect(options.db).toBe(app.db);

    scripted().snapshots.set(OP_LEGACY, { tenantId: TENANT, snapshot: null });
    const resolve = capturedResolver();
    await expect(resolve({ operationId: OP_LEGACY, tenantId: TENANT })).resolves.toEqual({ kind: 'none' });

    // The resolver really queried the app's own pool (scripted, not a stub).
    const sqls = scripted().queries.join('\n');
    expect(sqls).toContain('FROM operations WHERE id=$1 AND tenant_id=$2');
    // Feature dark for legacy rows: the pinned-revision table is never read.
    expect(sqls).not.toContain('FROM profile_bindings WHERE profile_id=$1 AND revision=$2');
  });

  it('pinned bearer: the composed resolver decrypts with the deployment key (process.env)', async () => {
    const app = await bootS3();
    apps.push(app);
    const cipher = encryptFileUrlAuthConfig({ type: 'bearer', token: 'w1c-composed-token' }, { ENCRYPTION_KEY: ENV_KEY });
    seedPinned(OP, cipher);

    const resolve = capturedResolver();
    await expect(resolve({ operationId: OP, tenantId: TENANT })).resolves.toEqual({
      kind: 'bearer',
      token: 'w1c-composed-token',
    });
    const sqls = scripted().queries.join('\n');
    expect(sqls).toContain('FROM profile_bindings WHERE profile_id=$1 AND revision=$2');
  });

  it('Δ2 at composition: a query-type credential is denied before any network', async () => {
    const app = await bootS3();
    apps.push(app);
    const cipher = encryptFileUrlAuthConfig(
      { type: 'query', query_key: 'api_key', query_value: 'q-secret' },
      { ENCRYPTION_KEY: ENV_KEY },
    );
    seedPinned(OP, cipher);

    const resolve = capturedResolver();
    await expect(resolve({ operationId: OP, tenantId: TENANT })).rejects.toMatchObject({
      name: 'SourceAuthDeniedError',
      code: 'QUERY_AUTH_FORBIDDEN',
    });
  });

  it('typed denials survive the wiring: missing cipher / foreign tenant / absent op', async () => {
    const app = await bootS3();
    apps.push(app);

    seedPinned(OP, null);
    await expect(capturedResolver()({ operationId: OP, tenantId: TENANT })).rejects.toMatchObject({
      code: 'AUTH_CONFIG_MISSING',
    });

    seedPinned(OP, encryptFileUrlAuthConfig({ type: 'bearer', token: 't' }, { ENCRYPTION_KEY: ENV_KEY }), {
      tenantId: FOREIGN_TENANT,
    });
    await expect(capturedResolver()({ operationId: OP, tenantId: TENANT })).rejects.toMatchObject({
      code: 'REF_TENANT_MISMATCH',
    });

    await expect(capturedResolver()({ operationId: 'no-such-op', tenantId: TENANT })).rejects.toMatchObject({
      code: 'REF_NOT_FOUND',
    });
  });
});
