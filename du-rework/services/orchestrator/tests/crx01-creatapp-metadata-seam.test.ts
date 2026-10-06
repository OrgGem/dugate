/**
 * CRX-01 focused proof — the createApp composition, end to end at the submit seam.
 *
 * The addendum's finding was an ORDERING hole: `createApp` built the submission
 * service BEFORE `metadataCrypto` existed and never handed the seam over, so a
 * deployment that configured `metadataEncryption` still stored
 * `operations.input_ref` / `tasks.payload_ref` as plaintext. This suite boots
 * the REAL `createApp` with a scripted `pg` (the DB-free twin pattern from
 * webhook-error-boundaries.boundary.test.ts) plus a real `metadataEncryption`
 * block, and drives the app's OWN submission service:
 *
 *   - both bound INSERT parameters are sealed envelopes, and a sentinel planted
 *     in the input survives nowhere in the column value (any depth, incl. base64);
 *   - the envelopes open back to the exact input under the configured key —
 *     with an independently rebuilt crypto instance over the same provider, so
 *     the assertion covers the KEY POLICY, not just the shape;
 *   - an idempotency replay returns the first operation and writes no second row;
 *   - a Vault outage while sealing aborts the submit with ZERO writes and no
 *     outbox dispatch row.
 *
 * Offline: scripted Pool, closed-port Redis, no PG/Redis/Vault.
 */
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { createApp, type App } from '../src/server';
import {
  createMetadataCrypto,
  type MetadataKeyProvider,
} from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { loadMigrationFiles } from '../src/db/migrations';

const KEY_REF = 'crx01-createapp-v1';
const TENANT = 'crx01-tenant';
const API_KEY = 'crx01-api-key';
const BUSINESS = 'document-core';
const ACTION = 'extract';
const SENTINEL = 'CRX01-CREATEAPP-SENTINEL-9b2e';
const HASH = String.fromCharCode(35);

interface ScriptedState {
  queries: string[];
  writes: { sql: string; params: unknown[] }[];
  schemaLedger: { sequence: number; filename: string }[];
  operations: Map<string, Record<string, unknown>>;
  submissionKeys: {
    tenant_id: unknown; api_key_id: unknown; route_action: unknown; key: unknown;
    operation_id: string; request_hash: unknown;
  }[];
}

jest.mock('pg', () => {
  const state = {
    queries: [] as string[],
    writes: [] as { sql: string; params: unknown[] }[],
    schemaLedger: [] as { sequence: number; filename: string }[],
    operations: new Map<string, Record<string, unknown>>(),
    submissionKeys: [] as {
      tenant_id: unknown; api_key_id: unknown; route_action: unknown; key: unknown;
      operation_id: string; request_hash: unknown;
    }[],
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
    if (text.includes('INSERT INTO submission_keys')) {
      state.submissionKeys.push({
        tenant_id: params[0], api_key_id: params[1], route_action: params[2], key: params[3],
        request_hash: params[4], operation_id: String(params[5]),
      });
      return write();
    }
    if (text.includes('INSERT INTO outbox')) return write();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
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
    if (/FROM submission_keys/i.test(text)) {
      const hit = state.submissionKeys.find((row) =>
        row.tenant_id === params[0] && row.api_key_id === params[1] &&
        row.route_action === params[2] && row.key === params[3]);
      return hit
        ? { rows: [{ operation_id: hit.operation_id, request_hash: hit.request_hash }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM profile_bindings/i.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM operations WHERE id=\$1/i.test(text)) {
      const row = state.operations.get(String(params[0]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
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

function scripted(): ScriptedState {
  return (jest.requireMock('pg') as { __duState: ScriptedState }).__duState;
}

/* Reversible Vault Transit stand-in (same shape as the submit-crypto e2e suite). */
function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'crx01-double').update(seed + ':' + block).digest();
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
function makeKeyProvider(opts: { failWrap?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      if (opts.failWrap) throw new Error('vault transit unavailable');
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

/** The sentinel must not survive anywhere in the bound value (incl. base64). */
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

const SUBMISSION = {
  input: { document: SENTINEL, pages: 2, nested: { secret: SENTINEL } },
};
const SUBMIT_CTX = {
  tenantId: TENANT,
  apiKeyId: API_KEY,
  businessId: BUSINESS,
  action: ACTION,
  correlationId: 'crx01-submit-001',
  idempotencyKey: 'crx01-idem-1',
};

async function boot(provider: KeyProvider): Promise<App> {
  return createApp({
    port: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_crx01',
    redisUrl: 'redis://127.0.0.1:1',
    adminToken: 'crx01-admin-token',
    autoDispatch: false,
    autoMigrate: false,
    metadataEncryption: { keyProvider: provider, keyRef: KEY_REF },
  });
}

function openCrypto(provider: KeyProvider) {
  return createMetadataCrypto(
    adaptKeyProviderForMetadata(provider) as MetadataKeyProvider,
    KEY_REF,
  );
}

describe('CRX-01: createApp submit path seals control-plane metadata', () => {
  const apps: App[] = [];

  beforeAll(() => {
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  beforeEach(() => {
    // Each test boots its own app; wipe the modelled rows so an idempotency
    // record from a previous test cannot turn the next submit into a replay.
    scripted().writes.length = 0;
    scripted().operations.clear();
    scripted().submissionKeys.length = 0;
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('submit inline: both columns are bound as sealed envelopes and open under the configured key', async () => {
    const provider = makeKeyProvider();
    const app = await boot(provider);
    apps.push(app);
    const before = scripted().writes.length;

    const result = await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    expect(result.replayed).toBe(false);

    const writes = scripted().writes.slice(before);
    const opWrite = writes.find((w) => w.sql.includes('INSERT INTO operations'));
    const taskWrite = writes.find((w) => w.sql.includes('INSERT INTO tasks'));
    const outboxWrite = writes.find((w) => w.sql.includes('INSERT INTO outbox'));
    expect(opWrite).toBeDefined();
    expect(taskWrite).toBeDefined();
    expect(outboxWrite).toBeDefined();

    const operationId = String(opWrite!.params[0]);
    const taskId = String(taskWrite!.params[0]);
    const inputRef = String(opWrite!.params[8]);
    const payloadRef = String(taskWrite!.params[3]);

    expect(leaksSentinel(opWrite!.params[8])).toBe(false);
    expect(leaksSentinel(taskWrite!.params[3])).toBe(false);
    expect(leaksSentinel(outboxWrite!.params[2])).toBe(false);
    // Bound as sealed envelopes (not the historical plaintext JSON).
    const envelope = JSON.parse(inputRef) as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.algorithm).toBe('aes-256-gcm');
    expect(typeof envelope.ciphertext).toBe('string');

    // Key policy, not just shape: rebuild the seam over the same provider.
    const crypto = openCrypto(provider);
    const openedInput = await crypto.readStored(
      JSON.parse(inputRef),
      { tenantId: TENANT, slot: 'operations.input_ref', refId: operationId },
      false,
    );
    const openedPayload = await crypto.readStored(
      JSON.parse(payloadRef),
      { tenantId: TENANT, slot: 'tasks.payload_ref', refId: taskId },
      false,
    );
    expect(openedInput).toEqual(SUBMISSION.input);
    expect(openedPayload).toEqual(SUBMISSION.input);
  });

  it('replay: the same idempotency key returns the first operation and writes no second row', async () => {
    const provider = makeKeyProvider();
    const app = await boot(provider);
    apps.push(app);
    const first = await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    const before = scripted().writes.length;

    const replay = await app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION });
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    const newWrites = scripted().writes.slice(before);
    expect(newWrites.filter((w) => w.sql.includes('INSERT INTO operations'))).toHaveLength(0);
    expect(newWrites.filter((w) => w.sql.includes('INSERT INTO outbox'))).toHaveLength(0);
  });

  it('a Vault outage while sealing aborts the submit with zero rows and no dispatch', async () => {
    const provider = makeKeyProvider({ failWrap: true });
    const app = await boot(provider);
    apps.push(app);
    const writesBefore = scripted().writes.length;
    const opsBefore = scripted().operations.size;

    await expect(
      app.submission.submit({ ...SUBMIT_CTX, submission: SUBMISSION }),
    ).rejects.toMatchObject({ name: 'MetadataCryptoError', code: 'KEY_PROVIDER_FAILED' });

    // Sealing happens BEFORE the writing transaction: nothing may reach the DB.
    expect(scripted().writes.slice(writesBefore)).toHaveLength(0);
    expect(scripted().operations.size).toBe(opsBefore);
  });
});
