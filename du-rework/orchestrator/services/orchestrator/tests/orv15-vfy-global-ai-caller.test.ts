import type { ProviderTestRequest, ProviderTestResult, TenantAiTestRequest, TenantAiTestResult } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createGlobalSettingsService } from '../src/modules/global-settings/service';
import { metadataPlaintextHash } from '../src/modules/runtime/metadata-crypto';

const TENANT = '11111111-1111-4111-8111-111111111111';
const API_KEY = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const PROVIDER_INVOCATION = '44444444-4444-4444-8444-444444444444';
const CONNECTOR = 'connector-vfy-ai';
const REVISION = 4;
const REQUEST: TenantAiTestRequest = {
  revision: REVISION,
  apiKeyId: API_KEY,
  profileId: PROFILE,
  expectedProfileRevision: 2,
  businessId: 'document-core',
  businessVersion: '1.1.0',
  action: 'extract',
  endpointSlug: 'extract:custom',
  prompt: 'verify retry recovery',
  parameters: {},
  artifactIds: [],
  timeoutMs: 5_000,
  idempotencyKey: 'vfy-ai-test-key-001',
} as const;

const SETTINGS = {
  provider: 'openai-compatible' as const,
  model: 'vfy-model',
  connectorId: CONNECTOR,
  connectorRevision: REVISION,
};

function providerResult(state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN', errorCode: string | null, usageEventId: string | null): ProviderTestResult {
  return {
    invocationId: PROVIDER_INVOCATION,
    state,
    statusCode: state === 'SUCCEEDED' ? 200 : null,
    content: null,
    contentTruncated: false,
    latencyMs: 12,
    inputTokens: null,
    outputTokens: null,
    usageEventId,
    errorCode,
  };
}

function fixture(times: string[]) {
  let saved: { request_hash: string; result: TenantAiTestResult } | null = null;
  let revisionState = 'DRAFT';
  const revisionRow = {
    tenant_id: TENANT,
    stream: 'ai',
    revision: REVISION,
    state: revisionState,
    payload_ref: { ciphertext: 'opaque-fixture-envelope' },
    content_digest: `sha256:${metadataPlaintextHash(SETTINGS)}`,
    actor: 'vfy-test',
    tested_at: null,
    source_revision: null,
    published_at: null,
    created_at: '2026-10-12T05:00:00.000Z',
  };
  const txQuery = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [] };
    if (sql.includes('SELECT state FROM global_settings_tenant_revisions')) {
      return { rowCount: 1, rows: [{ state: revisionState }] };
    }
    if (sql.includes('SELECT request_hash,result FROM global_settings_idempotency')) {
      return saved ? { rowCount: 1, rows: [saved] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO global_settings_idempotency')) {
      saved = { request_hash: String(params[2]), result: JSON.parse(String(params[3])) as TenantAiTestResult };
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE global_settings_idempotency SET result=')) {
      if (!saved) throw new Error('fixture invariant: cannot update a missing idempotency row');
      saved = { ...saved, result: JSON.parse(String(params[2])) as TenantAiTestResult };
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith("UPDATE global_settings_tenant_revisions SET state='TESTED'")) {
      revisionState = 'TESTED';
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected transaction SQL: ${sql}`);
  };
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('SELECT request_hash,result FROM global_settings_idempotency')) {
        return saved ? { rowCount: 1, rows: [saved] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM global_settings_tenant_revisions')) {
        return { rowCount: 1, rows: [{ ...revisionRow, state: revisionState }] };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
    async tx<T>(run: (client: unknown) => Promise<T>): Promise<T> {
      return run({ query: txQuery });
    },
  } as unknown as Db;
  const audit = { record: jest.fn(async () => ({ id: 'audit-vfy' })) } as never;
  const service = createGlobalSettingsService(db, audit, {
    metadataCrypto: {
      async seal() { throw new Error('unused'); },
      async open() { throw new Error('unused'); },
      isSealed() { return true; },
      async readStored() { return SETTINGS; },
    } as never,
    connectorManagement: {
      async getRecipeRevision() { return { state: 'ACTIVE' }; },
    } as never,
    backupSnapshotWriteGate: { async assertWriteAllowed() {} },
    now: () => new Date(times.shift() ?? '2026-10-12T05:10:00.000Z'),
  });
  return { service, getSaved: () => saved, getRevisionState: () => revisionState };
}

describe('VFY-ORV15 global AI caller UNKNOWN recovery', () => {
  it('re-enters provider-test with the same key after UNKNOWN, then seals the recovered result', async () => {
    const f = fixture(['2026-10-12T05:00:00.000Z', '2026-10-12T05:01:00.000Z']);
    const executeProviderTest = jest.fn<Promise<ProviderTestResult>, [ProviderTestRequest]>()
      .mockResolvedValueOnce(providerResult('UNKNOWN', 'INVOCATION_UNKNOWN', null))
      .mockResolvedValueOnce(providerResult('SUCCEEDED', null, 'usage-vfy-1'));

    const unknown = await f.service.testTenantAiRevision(TENANT, REQUEST, { label: 'vfy-admin' }, executeProviderTest);
    const recovered = await f.service.testTenantAiRevision(TENANT, REQUEST, { label: 'vfy-admin' }, executeProviderTest);

    expect(unknown).toMatchObject({ ok: false, errorCode: 'PROVIDER_TEST_UNKNOWN' });
    expect(recovered).toMatchObject({ ok: true, errorCode: null });
    expect(executeProviderTest).toHaveBeenCalledTimes(2);
    expect(executeProviderTest.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      REQUEST.idempotencyKey,
      REQUEST.idempotencyKey,
    ]);
    expect(f.getSaved()?.result).toEqual(recovered);
    expect(f.getRevisionState()).toBe('TESTED');
  });

  it('does not call the provider again for an immutable definitive failure replay', async () => {
    const f = fixture(['2026-10-12T05:00:00.000Z']);
    const executeProviderTest = jest.fn<Promise<ProviderTestResult>, [ProviderTestRequest]>()
      .mockResolvedValue(providerResult('FAILED', 'PROVIDER_TEST_FAILED', null));

    const first = await f.service.testTenantAiRevision(TENANT, REQUEST, { label: 'vfy-admin' }, executeProviderTest);
    const replay = await f.service.testTenantAiRevision(TENANT, REQUEST, { label: 'vfy-admin' }, executeProviderTest);

    expect(first).toMatchObject({ ok: false, errorCode: 'PROVIDER_TEST_FAILED' });
    expect(replay).toEqual(first);
    expect(executeProviderTest).toHaveBeenCalledTimes(1);
  });
});
