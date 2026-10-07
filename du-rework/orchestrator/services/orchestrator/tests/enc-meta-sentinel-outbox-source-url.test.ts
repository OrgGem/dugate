/**
 * ENC-META-SENTINEL — G1: `sourceUrl` on the durable dispatch path.
 *
 * The scan (coordination/reports/cc-enc-meta-writer-scan-2026-10-03.md §1.2)
 * found that a URL submission seals the URL inside BOTH control-plane columns
 * (`operations.input_ref` / `tasks.payload_ref`) but ALSO copies it verbatim
 * into the `outbox.payload` column. That column is a durable control-plane
 * store the metadata-crypto module itself names as in-scope, so a tenant
 * URL (which may carry query-string tokens) rests there in plaintext.
 *
 * What this file pins, through the REAL `createApp` composition with a
 * scripted `pg` and a mocked BullMQ (offline; closed-port Redis, no Vault):
 *
 *   1. GREEN - the sealed columns really are sealed on a URL submission, and
 *      the sealed envelope opens back to the input + the exact sourceUrl.
 *   2. GREEN pin - the outbox payload carries the URL as a SEALED envelope
 *      (ENC-META-FIX-G1 landed): no plaintext anywhere in the payload, and an
 *      independent seam over the same provider opens the field back to the
 *      exact URL under (tenant, 'tasks.payload_ref', root task id).
 *   3. GREEN acceptance gate (was RED) - the property the RED detector used
 *      to fail on: the outbox payload must not carry the sentinel. Kept so a
 *      regression back to plaintext fails loudly.
 *   4. Consumer round-trip - the ingestion consumer's own unseal seam
 *      (`openDispatchSourceUrl`) opens the captured field to the exact URL;
 *      a legacy plaintext row passes through; a mis-bound or malformed value
 *      fails closed with no plaintext fallback.
 *   5. GREEN - the dispatcher does NOT publish gate='ingestion' rows (the
 *      URL never reaches BullMQ by that path), and a published row carries
 *      references only, so the queue half of the finding is exact: the gap
 *      is the PG `outbox.payload` column, not Redis job data.
 */
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createApp, type App } from '../src/server';
import {
  createMetadataCrypto,
  type MetadataKeyProvider,
} from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { openDispatchSourceUrl } from '../src/modules/operations/ingestion-consumer';
import { loadMigrationFiles } from '../src/db/migrations';

const KEY_REF = 'enc-meta-sentinel-v1';
const TENANT = 'enc-meta-tenant';
const API_KEY = 'enc-meta-api-key';
const BUSINESS = 'document-core';
const ACTION = 'extract';
const SENTINEL = 'ENC-META-SENTINEL-SRC-9f2c';
const SOURCE_URL = `https://blob.test/document.pdf?token=${SENTINEL}`;
const HASH = String.fromCharCode(35);

interface OutboxRow {
  id: string;
  aggregate_id: string;
  type: string;
  delivery_id: string;
  payload: Record<string, unknown>;
  dispatched_at: string | null;
  attempts: number;
}

interface ScriptedState {
  queries: string[];
  writes: { sql: string; params: unknown[] }[];
  schemaLedger: { sequence: number; filename: string }[];
  operations: Map<string, Record<string, unknown>>;
  outbox: OutboxRow[];
}

jest.mock('pg', () => {
  const state: ScriptedState = {
    queries: [],
    writes: [],
    schemaLedger: [],
    operations: new Map(),
    outbox: [],
  };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    const write = (): PgResult => {
      state.writes.push({ sql: text, params });
      return { rows: [], rowCount: 1 };
    };
    if (text.includes('INSERT INTO operations')) {
      state.operations.set(String(params[0]), {
        id: String(params[0]),
        tenant_id: params[1],
        business_id: params[3],
        business_version: params[4],
        action: params[5],
        state: params[6],
        state_version: 1,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        deadline_at: null,
        result_ref: null,
      });
      return write();
    }
    if (text.includes('INSERT INTO tasks')) return write();
    if (text.includes('INSERT INTO outbox')) {
      state.outbox.push({
        id: `ob-${state.outbox.length + 1}`,
        aggregate_id: String(params[0]),
        type: 'task.dispatch',
        delivery_id: String(params[1]),
        payload: JSON.parse(String(params[2])) as Record<string, unknown>,
        dispatched_at: null,
        attempts: 0,
      });
      return write();
    }
    if (/FROM outbox WHERE dispatched_at IS NULL/.test(text)) {
      // Emulate the dispatcher's own WHERE clause (dispatcher.ts:35-46):
      // gate='ingestion' rows are the consumer's work, never published here.
      const rows = state.outbox.filter(
        (row) => row.dispatched_at === null && row.payload['gate'] !== 'ingestion',
      );
      return { rows, rowCount: rows.length };
    }
    if (text.includes('UPDATE outbox')) return write();
    if (/FROM tasks t JOIN operations o/.test(text)) {
      return { rows: [{ business_id: BUSINESS, business_version: '1.0.0', queue: 'du-q' }], rowCount: 1 };
    }
    if (/FROM business_versions/i.test(text)) {
      return {
        rows: [{
          version: '1.0.0',
          manifest: {
            actions: [{ name: ACTION, inputSchema: { type: 'object', additionalProperties: true } }],
            runtime: { handlerKinds: ['root'] },
          },
          digest: 'sha256:test',
          queue: 'du-q',
        }],
        rowCount: 1,
      };
    }
    if (/FROM operations WHERE id=\$1/i.test(text)) {
      const row = state.operations.get(String(params[0]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    // MIGRATION-VERIFY-TRAP-FIX: answer the count cross-check BEFORE the row
    // branch below, which would otherwise return the whole ledger for it.
    if (/count\(\*\)::int/i.test(text) && /schema_migrations/i.test(text)) {
      return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 };
    }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    if (/FROM profile_bindings/i.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM submission_keys/i.test(text)) return { rows: [], rowCount: 0 };
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

jest.mock('bullmq', () => {
  const state = { adds: [] as { queue: string; name: string; data: unknown; opts: unknown }[] };
  class Queue {
    public readonly queueName: string;
    public constructor(name: string, _opts?: unknown) {
      this.queueName = name;
    }
    public async add(name: string, data: unknown, opts?: unknown): Promise<{ id: string }> {
      state.adds.push({ queue: this.queueName, name, data, opts });
      const jobId = (opts as { jobId?: string } | undefined)?.jobId;
      return { id: jobId ?? 'job-1' };
    }
    public async close(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Queue, __duQueue: state };
});

// The real consumer is not under test here; its construction would otherwise
// be the only s3-backend branch this file needs and neither test drives it.
jest.mock('../src/modules/operations/ingestion-consumer', () => {
  const actual = jest.requireActual('../src/modules/operations/ingestion-consumer');
  return {
    ...actual,
    createIngestionConsumer: jest.fn(() => ({
      runOnce: jest.fn(async () => undefined),
      start: jest.fn(),
      stop: jest.fn(),
    })),
  };
});

function scripted(): ScriptedState {
  return (jest.requireMock('pg') as { __duState: ScriptedState }).__duState;
}
function queueState(): { adds: { queue: string; name: string; data: unknown; opts: unknown }[] } {
  return (jest.requireMock('bullmq') as { __duQueue: { adds: { queue: string; name: string; data: unknown; opts: unknown }[] } }).__duQueue;
}

/* Reversible Vault Transit stand-in (same shape as the crx01 seam suites). */
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
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  }
  return out;
}
function makeKeyProvider(): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + HASH + version, input.dek.length),
        ).toString('base64'),
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

/** The sentinel must not survive anywhere in a bound value (incl. base64). */
function leaksSentinel(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) return true;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length >= 8) {
      try {
        return Buffer.from(value, 'base64').toString('utf8').includes(SENTINEL);
      } catch {
        return false;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => leaksSentinel(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => leaksSentinel(v, depth + 1));
  }
  return false;
}

const SUBMIT_CTX = {
  tenantId: TENANT,
  apiKeyId: API_KEY,
  businessId: BUSINESS,
  action: ACTION,
  correlationId: 'enc-meta-src-001',
};
const SUBMISSION = { input: { document: SENTINEL, pages: 3 }, sourceUrl: SOURCE_URL };

async function boot(): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_enc_meta_src',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'enc-meta-admin-token',
    autoDispatch: false,
    autoMigrate: false,
    artifactStorage: { backend: 's3', bucket: 'enc-meta-sentinel-bucket' },
    metadataEncryption: { keyProvider: makeKeyProvider(), keyRef: KEY_REF },
  });
}

function openCrypto(provider: KeyProvider) {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(provider) as MetadataKeyProvider,
    KEY_REF,
  );
}

describe('ENC-META-SENTINEL G1: URL submission through the real createApp', () => {
  const apps: App[] = [];

  beforeAll(() => {
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  beforeEach(() => {
    const state = scripted();
    state.writes.length = 0;
    state.queries.length = 0;
    state.operations.clear();
    state.outbox.length = 0;
    queueState().adds.length = 0;
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('GREEN: seals both control-plane columns and the envelope opens back to input + sourceUrl', async () => {
    const provider = makeKeyProvider();
    const app = await boot();
    apps.push(app);

    const result = await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    expect(result.replayed).toBe(false);

    const writes = scripted().writes;
    const opWrite = writes.find((w) => w.sql.includes('INSERT INTO operations'));
    const taskWrite = writes.find((w) => w.sql.includes('INSERT INTO tasks'));
    expect(opWrite).toBeDefined();
    expect(taskWrite).toBeDefined();

    expect(leaksSentinel(opWrite!.params[8])).toBe(false);
    expect(leaksSentinel(taskWrite!.params[3])).toBe(false);

    const crypto = openCrypto(provider);
    const openedInput = await crypto.readStored(
      JSON.parse(String(opWrite!.params[8])),
      { tenantId: TENANT, slot: 'operations.input_ref', refId: String(opWrite!.params[0]) },
      false,
    );
    expect(openedInput).toEqual(SUBMISSION.input);
    const openedPayload = await crypto.readStored(
      JSON.parse(String(taskWrite!.params[3])),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: String(taskWrite!.params[0]) },
      false,
    );
    expect(openedPayload).toEqual({ input: SUBMISSION.input, sourceUrl: SOURCE_URL, ingestionState: 'PENDING' });
  });

  it('GREEN pin: the outbox payload carries the sourceUrl as a sealed envelope under the task binding', async () => {
    const app = await boot();
    apps.push(app);
    await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });

    const writes = scripted().writes;
    const outboxWrite = writes.find((w) => w.sql.includes('INSERT INTO outbox'));
    const taskWrite = writes.find((w) => w.sql.includes('INSERT INTO tasks'));
    expect(outboxWrite).toBeDefined();
    expect(taskWrite).toBeDefined();
    const payload = JSON.parse(String(outboxWrite!.params[2])) as Record<string, unknown>;
    expect(payload['gate']).toBe('ingestion');

    // The sealed envelope, not the historical plaintext string.
    const raw = payload['sourceUrl'];
    expect(typeof raw).toBe('object');
    expect(Array.isArray(raw)).toBe(false);
    const envelope = raw as Record<string, unknown>;
    expect(envelope['version']).toBe(1);
    expect(envelope['algorithm']).toBe('aes-256-gcm');
    expect(typeof envelope['ciphertext']).toBe('string');
    // Nothing tenant-visible anywhere in the payload (refs + sealed blob only).
    expect(leaksSentinel(payload)).toBe(false);
    expect(leaksSentinel(payload['taskId'])).toBe(false);
    expect(leaksSentinel(payload['operationId'])).toBe(false);

    // Key policy, not just shape: an independent seam over the same provider
    // opens it under the binding the root task payload uses - and refuses any
    // other row.
    const crypto = openCrypto(makeKeyProvider());
    const rootTaskId = String(taskWrite!.params[0]);
    const opened = await crypto.readStored(
      envelope,
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: rootTaskId },
      false,
    );
    expect(opened).toBe(SOURCE_URL);
    await expect(
      crypto.readStored(envelope, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'some-other-task' }, false),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
  });

  it('GREEN acceptance gate (was RED): the outbox payload must not carry sourceUrl plaintext', async () => {
    const app = await boot();
    apps.push(app);
    await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });

    const outboxWrite = scripted().writes.find((w) => w.sql.includes('INSERT INTO outbox'));
    expect(outboxWrite).toBeDefined();
    // ENC-META-FIX-G1 flipped this from RED to GREEN: the URL is sealed in
    // the payload, so the sentinel must not survive at any depth (incl. base64).
    expect(leaksSentinel(outboxWrite!.params[2])).toBe(false);
  });

  it('G1e: the consumer seam opens the captured dispatch sourceUrl back to the exact URL', async () => {
    const app = await boot();
    apps.push(app);
    await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });

    const writes = scripted().writes;
    const outboxWrite = writes.find((w) => w.sql.includes('INSERT INTO outbox'));
    const taskWrite = writes.find((w) => w.sql.includes('INSERT INTO tasks'));
    const payload = JSON.parse(String(outboxWrite!.params[2])) as Record<string, unknown>;
    const rootTaskId = String(taskWrite!.params[0]);

    const opened = await openDispatchSourceUrl(
      payload['sourceUrl'],
      { tenantId: TENANT, taskId: rootTaskId },
      openCrypto(makeKeyProvider()),
    );
    expect(opened).toBe(SOURCE_URL);
  });

  it('G1e negatives: legacy plaintext passes through; mis-bound, malformed, and seam-less values fail closed', async () => {
    const crypto = openCrypto(makeKeyProvider());
    // Legacy row (pre-fix / seam-off deployment): the plaintext string is accepted.
    await expect(
      openDispatchSourceUrl(SOURCE_URL, { tenantId: TENANT, taskId: 'task-x' }, crypto),
    ).resolves.toBe(SOURCE_URL);
    // Sealed for ANOTHER row: refused under this binding, no plaintext fallback.
    const misBound = await crypto.seal(SOURCE_URL, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'other-task' });
    await expect(
      openDispatchSourceUrl(misBound, { tenantId: TENANT, taskId: 'task-x' }, crypto),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'CONTEXT_MISMATCH' });
    // Malformed shape fails closed.
    await expect(
      openDispatchSourceUrl(42, { tenantId: TENANT, taskId: 'task-x' }, crypto),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError' });
    // Sealed value with no seam configured: fail closed (retryable code), never plaintext.
    const sealedShape = await crypto.seal(SOURCE_URL, { tenantId: TENANT, slot: 'tasks.payload_ref', refId: 'task-x' });
    await expect(
      openDispatchSourceUrl(sealedShape, { tenantId: TENANT, taskId: 'task-x' }, undefined),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });
  });

  it('GREEN: the dispatcher never publishes gate=ingestion rows, and published rows carry references only', async () => {
    const app = await boot();
    apps.push(app);
    await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });

    // (a) The URL row alone: the dispatcher must not pick it up.
    const dispatchedGated = await app.dispatcher.dispatchOnce();
    expect(dispatchedGated).toBe(0);
    expect(queueState().adds).toHaveLength(0);

    // (b) Positive control: a ready-style row with references IS published,
    // and its job data carries no sentinel.
    scripted().outbox.push({
      id: 'ob-ready',
      aggregate_id: 'task-ready-1',
      type: 'task.dispatch',
      delivery_id: 'delivery-ready-1',
      payload: {
        contractVersion: '1',
        deliveryId: 'delivery-ready-1',
        operationId: String(scripted().operations.keys().next().value),
        kind: 'root',
        correlationId: 'enc-meta-src-001',
        gate: 'ready',
      },
      dispatched_at: null,
      attempts: 0,
    });
    const dispatchedReady = await app.dispatcher.dispatchOnce();
    expect(dispatchedReady).toBe(1);
    expect(queueState().adds).toHaveLength(1);
    expect(queueState().adds[0]!.name).toBe('task.dispatch');
    expect(leaksSentinel(queueState().adds[0]!.data)).toBe(false);
    // The gated row was never marked dispatched.
    const outboxUpdates = scripted().writes.filter((w) => w.sql.includes('UPDATE outbox'));
    const touchedIds = outboxUpdates.map((w) => String(w.params[0]));
    expect(touchedIds).toEqual(['ob-ready']);
  });
});
