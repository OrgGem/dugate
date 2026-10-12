import { join } from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import IORedis from 'ioredis';
import { createApp, type App } from '../src/server';
import { loadMigrationFiles } from '../src/db/migrations';

/**
 * CONNECTOR-WIRE-A — boot composition.
 *
 * Offline, REAL createApp boot over a scripted pg twin (the CRX-01 pattern):
 * with `connectorBaseUrls` configured the app composes the management store
 * (exposed on the App seam and reachable through a stubbed connector service);
 * without them the seam stays undefined — capability advertisement derives
 * from exactly this, and every connector.* action fails closed on it.
 */

const REVISION = {
  connectorId: 'mock-connector',
  revision: 3,
  adapter: 'mock-openai',
  state: 'ACTIVE',
  config: { headers: { authorization: '[REDACTED]' } },
  credentialRef: 'connectors/mock-connector/credentials',
  tenantId: 't1',
};

jest.mock('pg', () => {
  const state = {
    queries: [] as string[],
    schemaLedger: [] as { sequence: number; filename: string }[],
    backupGateAvailable: true,
    poolEndCount: 0,
    storageInitialized: false,
    activeGenerationId: '',
  };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    if (/FROM maintenance_backup_effect_gate/i.test(text)) {
      return state.backupGateAvailable
        ? { rows: [{ state: 'OPEN', fence_revision: 0 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO storage_generation_state/i.test(text)) {
      state.storageInitialized = true;
      state.activeGenerationId = String(params[0] ?? '');
      return { rows: [], rowCount: 1 };
    }
    if (/FROM storage_generation_state\s+s\s+JOIN storage_generations\s+g/i.test(text)) {
      return state.storageInitialized
        ? { rows: [{
            generation_id: state.activeGenerationId, revision: 0, backend: 'postgres', endpoint: 'postgres',
            bucket: '', region: 'postgres', force_path_style: false, credential_version_ref: null,
            credential_owner_tenant_id: null, url_ttl_seconds: null, state: 'ACTIVE', tested_at: null,
            test_result: null, activated_at: new Date(0), control_revision: 0,
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/SELECT active_generation_id FROM storage_generation_state/i.test(text)) {
      return state.storageInitialized
        ? { rows: [{ active_generation_id: state.activeGenerationId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
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
    async connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<PgResult>; release: () => void }> {
      return { query: (sql, params = []) => Promise.resolve(answer(sql, params)), release: () => undefined };
    }
    async end(): Promise<void> {
      state.poolEndCount += 1;
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function scripted() {
  return (jest.requireMock('pg') as { __duState: {
    queries: string[]; schemaLedger: unknown[]; backupGateAvailable: boolean; poolEndCount: number;
    storageInitialized: boolean; activeGenerationId: string;
  } }).__duState;
}

function boot(connectorBaseUrls?: Record<string, string>): Promise<App> {
  return createApp({
    port: 0,
    internalPort: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_cw_boot',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'cw-boot-admin',
    autoDispatch: false,
    autoMigrate: false,
    // This offline boot twin has no artifact encryption key provider. Keep it
    // in the explicitly synthetic mode rather than exercising the real-data
    // encrypted ingestion path without its required writer.
    encryptionPolicy: {
      dataMode: 'synthetic',
      metadataEncryption: false,
      publicUploadEncryption: false,
      metadataPlaintextReadMode: 'none',
      profileCipherKeyPresent: false,
    },
    ...(connectorBaseUrls
      ? {
          connectorBaseUrls,
          // Signed-management-identity contract: the management seam is composed
          // only when a per-request authorization provider exists.
          connectorManagementAuthorizationForRequest: () => 'Bearer p745-test-identity',
        }
      : {}),
  });
}

describe('CONNECTOR-WIRE-A boot composition', () => {
  const apps: App[] = [];

  beforeAll(() => {
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('without connectorBaseUrls the management seam stays undefined (fail-closed composition)', async () => {
    const app = await boot();
    apps.push(app);
    expect(app.connectorManagement).toBeUndefined();
  });

  it('with connectorBaseUrls the composed store reaches the connector and keeps redaction', async () => {
    const app = await boot({ 'mock-connector': 'http://connector.test:9' });
    apps.push(app);
    expect(app.connectorManagement).toBeDefined();

    const calls: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL) => {
      const href = String(url);
      calls.push(href);
      if (href.endsWith('/connectors')) {
        return new Response(JSON.stringify([REVISION]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.endsWith('/test')) {
        return new Response(JSON.stringify({ ok: true, providerBody: { mustNotLeak: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    }) as unknown as typeof fetch);

    const items = await app.connectorManagement!.list();
    expect(calls[0]).toBe('http://connector.test:9/connectors');
    expect(items).toHaveLength(1);
    expect(items[0]!.config.headers).toEqual({ authorization: '[REDACTED]' });

    // The masked test path narrows probe detail before it can leave the seam.
    await expect(app.connectorManagement!.test('mock-connector')).resolves.toEqual({ ok: true });
  });

  it('closes resources and preserves the startup error when a mandatory later factory fails', async () => {
    const state = scripted();
    const previousGateState = state.backupGateAvailable;
    const previousStorageInitialized = state.storageInitialized;
    const previousGenerationId = state.activeGenerationId;
    const previousPoolEnds = state.poolEndCount;
    const redisClose = jest.spyOn(IORedis.prototype, 'disconnect');
    const previousRedisCloses = redisClose.mock.calls.length;
    state.backupGateAvailable = false;
    state.storageInitialized = false;
    state.activeGenerationId = '';
    try {
      await expect(boot()).rejects.toThrow(/backup snapshot write gate is not initialized/i);
      expect(redisClose.mock.calls.length).toBeGreaterThan(previousRedisCloses);
      expect(state.poolEndCount).toBe(previousPoolEnds + 1);
    } finally {
      state.backupGateAvailable = previousGateState;
      state.storageInitialized = previousStorageInitialized;
      state.activeGenerationId = previousGenerationId;
    }
  });
});
