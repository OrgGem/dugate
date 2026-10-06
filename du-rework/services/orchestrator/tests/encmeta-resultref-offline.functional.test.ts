import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { contentHash } from '@du/contracts';
import { createApp, type App } from '../src/server';
import { createMetadataCrypto, type MetadataKeyProvider } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { loadMigrationFiles } from '../src/db/migrations';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';

/**
 * ENCMETA-RESULTREF-IMPL — Option A coverage (prep §5 groups 2–7).
 *
 * Groups 1 (detector flip) lives in `enc-meta-sentinel-runtime-refs.test.ts`.
 * Here: seal/open round trip through the REAL completeTask; cross-slot and
 * cross-tenant AAD refusal; NOT_SEALED fail-closed vs the plaintext window;
 * the join-summary nesting regression (R3); reader coverage (R2 getChildren,
 * R1 public /result route); and the absent/null negative control.
 */

const KEY_REF = 'encmeta-resultref-v1';
const TENANT = 'encmeta-rr-tenant';
const BUSINESS = 'document-core';
const HASH = String.fromCharCode(35);
const RESULT_REF = 'memory://result/encmeta-rr';
const RESULT_HASH = contentHash(RESULT_REF);

interface ScriptedState {
  queries: string[];
  writes: { sql: string; params: unknown[] }[];
  schemaLedger: { sequence: number; filename: string }[];
  joinParent: Record<string, unknown> | null;
  sibs: Record<string, unknown>[] | null;
  children: Record<string, unknown>[] | null;
}

jest.mock('pg', () => {
  const state: ScriptedState = {
    queries: [],
    writes: [],
    schemaLedger: [],
    joinParent: null,
    sibs: null,
    children: null,
  };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    const write = (): PgResult => {
      state.writes.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    };
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    // MIGRATION-VERIFY-TRAP-FIX: verifyMigrations cross-checks the ledger read
    // against an independent count. Must be answered BEFORE the row branch below,
    // which would otherwise hand back the whole ledger for a count query.
    if (/count\(\*\)::int/i.test(text) && /schema_migrations/i.test(text)) {
      return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 };
    }
    if (/FROM schema_migrations/i.test(text)) return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    // completeTask lease/identity row.
    if (/SELECT t\.lease_epoch, t\.state, t\.operation_id, o\.tenant_id, o\.business_id/.test(text)) {
      return {
        rows: [{ lease_epoch: 5, state: 'RUNNING', operation_id: 'op-1', tenant_id: TENANT, business_id: BUSINESS, lease_active: true }],
        rowCount: 1,
      };
    }
    // getChildren parent existence.
    if (/SELECT id FROM tasks WHERE id=\$1/.test(text)) return { rows: [{ id: String(params[0]) }], rowCount: 1 };
    // getChildren row set.
    if (/c\.kind, c\.state, c\.result_ref, c\.tenant_id/.test(text)) {
      return { rows: state.children ?? [], rowCount: (state.children ?? []).length };
    }
    // reconcileParentJoin: dependency lookup.
    if (/SELECT parent_id, join_policy FROM task_dependencies WHERE child_id/.test(text)) {
      return state.joinParent
        ? { rows: [{ parent_id: 'parent-1', join_policy: 'all-success' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // reconcileParentJoin: parent row.
    if (/SELECT t\.id, t\.state, t\.payload_ref, o\.tenant_id/.test(text)) {
      return state.joinParent ? { rows: [state.joinParent], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // reconcileParentJoin: sibling set.
    if (/SELECT c\.id, c\.task_key, c\.state, c\.result_ref, c\.error_code/.test(text)) {
      return { rows: state.sibs ?? [], rowCount: (state.sibs ?? []).length };
    }
    if (/SELECT 1 FROM task_dependencies/.test(text)) return { rows: [], rowCount: 0 };
    if (/UPDATE tasks t SET state='SUCCEEDED'/.test(text)) return write();
    if (/UPDATE tasks SET state='QUEUED', payload_ref=\$2/.test(text)) return write();
    if (/UPDATE operations SET state='SUCCEEDED'/.test(text)) return write();
    if (/INSERT INTO outbox/.test(text)) return write();
    if (/callback_url/.test(text)) {
      return { rows: [{ id: 'op-1', tenant_id: TENANT, state: 'SUCCEEDED', state_version: 1, callback_url: null, updated_at: new Date(0).toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string, params: unknown[] = []): Promise<PgResult> {
      return answer(sql, params);
    }
    async connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<PgResult>; release: () => void }> {
      return { query: (sql, params = []) => Promise.resolve(answer(sql, params)), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function scripted(): ScriptedState {
  return (jest.requireMock('pg') as { __duState: ScriptedState }).__duState;
}

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'enc-meta-double').update(seed + ':' + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}
function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(Buffer.from(input.dek), keystream(input.keyRef + HASH + version, input.dek.length)).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}
function openCrypto(provider: KeyProvider) {
  return createMetadataCrypto(adaptKeyProviderForMetadata(provider) as MetadataKeyProvider, KEY_REF);
}

const provider = makeKeyProvider();
const crypto = openCrypto(provider);

function boot(): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_encmeta_rr',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'encmeta-rr-admin',
    autoDispatch: false,
    autoMigrate: false,
    metadataEncryption: { keyProvider: provider, keyRef: KEY_REF },
  });
}

async function completeOnce(app: App, taskId = 'task-1') {
  await app.runtime.completeTask(taskId, { leaseEpoch: 5, resultRef: RESULT_REF, resultHash: RESULT_HASH }, BUSINESS);
}

describe('ENCMETA-RESULTREF-IMPL — result_ref under the metadata seam', () => {
  const apps: App[] = [];

  beforeAll(() => {
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map((file) => ({
      sequence: file.sequence,
      filename: file.filename,
    }));
  });

  beforeEach(() => {
    scripted().writes.length = 0;
    scripted().queries.length = 0;
    scripted().joinParent = null;
    scripted().sibs = null;
    scripted().children = null;
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('G2 round trip: both stored copies are envelopes that open to the ref under their own slot', async () => {
    const app = await boot();
    apps.push(app);
    await completeOnce(app);

    const taskWrite = scripted().writes.find((w) => w.sql.includes("UPDATE tasks t SET state='SUCCEEDED'"));
    const opWrite = scripted().writes.find((w) => w.sql.includes("UPDATE operations SET state='SUCCEEDED'"));
    const taskEnvelope = JSON.parse(String(taskWrite!.params[1])) as Record<string, unknown>;
    const opEnvelope = JSON.parse(String(opWrite!.params[1])) as Record<string, unknown>;

    await expect(
      crypto.readStored(taskEnvelope, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).resolves.toBe(RESULT_REF);
    await expect(
      crypto.readStored(opEnvelope, { tenantId: TENANT, slot: 'operations.result_ref', refId: 'op-1' }, false),
    ).resolves.toBe(RESULT_REF);
  });

  it('G3 cross-slot / cross-tenant replay is refused with CONTEXT_MISMATCH', async () => {
    const app = await boot();
    apps.push(app);
    await completeOnce(app);

    const taskWrite = scripted().writes.find((w) => w.sql.includes("UPDATE tasks t SET state='SUCCEEDED'"));
    const opWrite = scripted().writes.find((w) => w.sql.includes("UPDATE operations SET state='SUCCEEDED'"));
    const taskEnvelope = JSON.parse(String(taskWrite!.params[1]));
    const opEnvelope = JSON.parse(String(opWrite!.params[1]));

    // The same value under the OTHER row's slot, and under a foreign tenant.
    await expect(
      crypto.readStored(taskEnvelope, { tenantId: TENANT, slot: 'operations.result_ref', refId: 'op-1' }, false),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    await expect(
      crypto.readStored(opEnvelope, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    await expect(
      crypto.readStored(taskEnvelope, { tenantId: 'other-tenant', slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    // And a payload_ref envelope cannot masquerade as a result_ref.
    const payloadEnvelope = await crypto.seal('x', { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'task-1' });
    await expect(
      crypto.readStored(payloadEnvelope, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('G4 fail-closed vs window: plaintext raises NOT_SEALED when required; the window still reads it', async () => {
    const plaintext = 'memory://legacy-plain-ref';
    await expect(
      crypto.readStored(plaintext, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, false),
    ).rejects.toMatchObject({ code: 'NOT_SEALED' });
    await expect(
      crypto.readStored(plaintext, { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'task-1' }, true),
    ).resolves.toBe(plaintext);
  });

  it('G5 join summary: the parent payload carries OPENED child refs — no nested envelope', async () => {
    const sealedA = await crypto.seal('ref-a', { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'child-a' });
    const sealedB = await crypto.seal('ref-b', { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'child-b' });
    const sealedParent = await crypto.seal(
      { input: 'parent-input' },
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'parent-1' },
    );
    scripted().joinParent = {
      id: 'parent-1',
      state: 'WAITING_CHILDREN',
      payload_ref: sealedParent,
      tenant_id: TENANT,
      business_id: BUSINESS,
      business_version: '1.0.0',
      action: 'extract',
      correlation_id: 'corr-1',
    };
    scripted().sibs = [
      { id: 'child-a', task_key: 'a', state: 'SUCCEEDED', result_ref: JSON.stringify(sealedA), error_code: null },
      { id: 'child-b', task_key: 'b', state: 'SUCCEEDED', result_ref: JSON.stringify(sealedB), error_code: null },
    ];

    const app = await boot();
    apps.push(app);
    await completeOnce(app, 'child-b');

    const queued = scripted().writes.find(
      (w) => w.sql.includes("UPDATE tasks SET state='QUEUED'") && w.sql.includes('payload_ref=$2'),
    );
    expect(queued).toBeDefined();
    const outer = JSON.parse(String(queued!.params[1])) as Record<string, unknown>;
    expect(outer).toMatchObject({ version: 1, algorithm: 'aes-256-gcm' });
    const opened = (await crypto.readStored(outer, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'parent-1' }, false)) as {
      input: string;
      joinSummary: Record<string, string | null>;
    };
    expect(opened.joinSummary).toEqual({ a: 'ref-a', b: 'ref-b' });
    // The nesting regression cannot come back silently: no value in the
    // summary is itself an envelope.
    expect(JSON.stringify(opened.joinSummary)).not.toContain('aes-256-gcm');
  });

  it('G6/R2 getChildren: sealed refs open; legacy plaintext passes; null stays null', async () => {
    const sealedX = await crypto.seal('ref-x', { tenantId: TENANT, slot: 'tasks.result_ref', refId: 'child-x' });
    scripted().children = [
      { id: 'child-x', task_key: 'x', kind: 'root', state: 'SUCCEEDED', result_ref: JSON.stringify(sealedX), tenant_id: TENANT, error_code: null },
      { id: 'child-legacy', task_key: 'l', kind: 'root', state: 'SUCCEEDED', result_ref: 'memory://legacy', tenant_id: TENANT, error_code: null },
      { id: 'child-null', task_key: 'n', kind: 'root', state: 'RUNNING', result_ref: null, tenant_id: TENANT, error_code: null },
    ];
    const app = await boot();
    apps.push(app);
    const res = await app.runtime.getChildren('parent-1');
    expect(res.children.map((c) => c.resultRef)).toEqual(['ref-x', 'memory://legacy', null]);
  });

  it('G6/R1 public /result: a sealed row projects the SAME opaque ref; null and no-seam paths unchanged', async () => {
    const sealedOp = await crypto.seal(RESULT_REF, { tenantId: TENANT, slot: 'operations.result_ref', refId: 'op-1' });
    const baseCtx = (resultRef: unknown, withSeam: boolean) =>
      ({
        method: 'GET',
        pathname: '/api/v1/operations/op-1/result',
        searchParams: new URLSearchParams(),
        headers: { 'x-api-key': 'raw-key' },
        body: undefined,
        rawBody: Buffer.alloc(0),
        correlationId: 'rr-1',
        db: {
          query: async (sql: string) => {
            if (/FROM api_keys/.test(sql)) return { rows: [{ id: 'key-1', tenant_id: TENANT }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
        },
        runtime: {
          getOperation: async () => ({ id: 'op-1', tenant_id: TENANT, state: 'SUCCEEDED', result_ref: resultRef }),
        },
        usage: { project: async () => ({}) },
        ...(withSeam ? { metadataCrypto: crypto } : {}),
      }) as unknown as RouteContext;

    const sealed = await handlePublicRoutes(baseCtx(JSON.stringify(sealedOp), true));
    expect((sealed!.body as { data: { resultRef: string } }).data.resultRef).toBe(RESULT_REF);

    const nullRef = await handlePublicRoutes(baseCtx(null, true));
    expect((nullRef!.body as { data: Record<string, unknown> }).data).toEqual({});

    const legacyNoSeam = await handlePublicRoutes(baseCtx('memory://plain-op-ref', false));
    expect((legacyNoSeam!.body as { data: { resultRef: string } }).data.resultRef).toBe('memory://plain-op-ref');
  });
});
