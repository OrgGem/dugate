/**
 * W-ENC-08-WIRE-ENC07 (Delta 99): the Admin crypto-config store and the ENC-07
 * delivery service read the SAME policy, so a toggle or a pinned key version
 * takes effect on the very next public delivery - no restart, no re-wire.
 *
 * In-process and offline. The route, the delivery service, the store and the
 * registry are all real; only the DB and the artifact backend are doubles.
 */

import { route, buildDeliveryEncryptionConfig, type RouteContext } from '../src/server';
import { createDeliveryEncryptionService, type DeliveryEncryptionService } from '../src/modules/public-api';
import {
  recipientKeyOptions,
  type CryptoConfigAudit,
  type CryptoConfigServiceOptions,
  type CryptoConfigState,
  type CryptoConfigStore,
} from '../src/app/admin/crypto-config-api';
import { isHttpError } from '../src/http/errors';
import type { QueryResult, QueryResultRow } from 'pg';
import type { RecipientKeyRegistry, RecipientPublicKeyRecord } from '../src/modules/encryption/recipient-key-registry';
import {
  constants,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
  generateKeyPairSync,
} from 'node:crypto';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const ADMIN_TOKEN = 'wire-enc07-admin-token';
const API_KEY = 'wire-enc07-api-key';
const TENANT = 'wire-enc07-tenant';
const OP_ID = '33333333-1111-4111-8111-333333333333';
const ARTIFACT_ID = '44444444-2222-4222-8222-444444444444';

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_PEM = String(kp.publicKey.export({ type: 'spki', format: 'pem' }));
const PRIV_PEM = String(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));

const ARTIFACT_BYTES = Buffer.from('wire-enc07-artifact', 'utf8');
const RESULT_REF = 'wire-enc07-ref';

function externalDecrypt(envelope: unknown): Buffer {
  const e = envelope as { enc: string; nonce: string; tag: string; ciphertext: string };
  const dek = privateDecrypt(
    { key: createPrivateKey(PRIV_PEM), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(e.enc, 'base64'),
  );
  try {
    const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(e.nonce, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.ciphertext, 'base64')), d.final()]);
  } finally { dek.fill(0); }
}
interface KeyRow {
  version: number;
  revokedAt: string | null;
  fingerprint: string;
}

function makeRegistry(rows: KeyRow[]): RecipientKeyRegistry {
  const build = (r: KeyRow): RecipientPublicKeyRecord => ({
    id: 'key-' + r.version,
    tenantId: TENANT,
    version: r.version,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: PUB_PEM,
    fingerprint: r.fingerprint,
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: r.revokedAt,
  });
  const fail = (code: string, message: string): never => {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    throw err;
  };
  return {
    async getCurrentKey() {
      const current = rows.filter((r) => r.revokedAt === null).sort((a, b) => b.version - a.version)[0];
      if (!current) return fail('KEY_NOT_FOUND', 'no key');
      return build(current);
    },
    async getKeyVersion(_tenantId: string, version: number) {
      const row = rows.find((r) => r.version === version);
      if (!row) return fail('KEY_NOT_FOUND', 'missing version');
      if (row.revokedAt !== null) return fail('KEY_REVOKED', 'revoked version');
      return build(row);
    },
    async listKeys() {
      return rows.map(build);
    },
  } as unknown as RecipientKeyRegistry;
}

class MemoryStore implements CryptoConfigStore {
  public readonly rows = new Map<string, CryptoConfigState>();
  async get(tenantId: string): Promise<CryptoConfigState> {
    const empty: CryptoConfigState = { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null };
    return this.rows.get(tenantId) ?? empty;
  }
  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    this.rows.set(tenantId, next);
    return next;
  }
}

class MemoryAudit implements CryptoConfigAudit {
  public readonly rows: unknown[] = [];
  async record(input: unknown): Promise<unknown> {
    this.rows.push(input);
    return { ok: true };
  }
}

interface Harness {
  ctx: RouteContext;
  store: MemoryStore;
  delivery: DeliveryEncryptionService | null;
  keys: KeyRow[];
}

const KEY_HASH = createHash('sha256').update(API_KEY).digest('hex');

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}
function harness(rows: KeyRow[]): Harness {
  const store = new MemoryStore();
  const keys = rows;
  const registry = makeRegistry(keys);
  const audit = new MemoryAudit();
  const cryptoConfig: CryptoConfigServiceOptions = {
    allowedKeyRefs: ['primary'],
    store,
    keys: {
      async listRecipientKeys(tenantId: string) {
        return recipientKeyOptions(await registry.listKeys(tenantId), tenantId);
      },
    },
    audit,
  };
  const serverConfig = {
    cryptoConfig: { allowedKeyRefs: ['primary'], recipientKeyRegistry: registry },
  };
  const delivery = createDeliveryEncryptionService(
    buildDeliveryEncryptionConfig(serverConfig as never, cryptoConfig),
  );
  const db = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> {
      if (/FROM api_keys WHERE hash/i.test(sql)) {
        if (params[0] !== KEY_HASH) return pgResult([]);
        return pgResult([{ id: 'key-1', tenant_id: TENANT }]);
      }
      if (/FROM operations o\s+LEFT JOIN artifacts/i.test(sql)) return pgResult([]);
      if (/FROM artifacts a/i.test(sql)) {
        const row = { state: 'READY', mime_type: 'application/octet-stream', tenant_id: TENANT, storage_key: 'sk' };
        return pgResult([row]);
      }
      throw new Error('unmodelled SQL: ' + sql.slice(0, 100));
    },
  };
  const ctx = {
    method: 'GET',
    pathname: '/api/v1/operations/' + OP_ID + '/result',
    searchParams: new URLSearchParams(''),
    headers: { 'x-api-key': API_KEY },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'wire-enc07',
    host: 'localhost',
    db,
    runtime: {
      async getOperation(id: string) {
        return { id, tenant_id: TENANT, state: 'SUCCEEDED', result_ref: RESULT_REF };
      },
    },
    usage: { async project() { return { calls: 0 }; } },
    artifacts: {
      async getBlob() {
        return Readable.from([Buffer.from(ARTIFACT_BYTES)]);
      },
    },
    deliveryEncryption: delivery,
    cryptoConfig,
    config: { maxBlobBytes: 1024 },
  } as unknown as RouteContext;
  return { ctx, store, delivery, keys };
}

type Outcome =
  | { kind: 'body'; status: number; body: Record<string, unknown> }
  | { kind: 'problem'; status: number }
async function call(h: Harness, pathname: string): Promise<Outcome> {
  (h.ctx as unknown as { pathname: string }).pathname = pathname;
  try {
    const res = await route(h.ctx);
    return { kind: 'body', status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return { kind: 'problem', status: err.status };
  }
}
const RESULT_PATH = '/api/v1/operations/' + OP_ID + '/result';
const DOWNLOAD_PATH = '/api/v1/artifacts/' + ARTIFACT_ID + '/download';

describe('W-ENC-08-WIRE-ENC07: the Admin toggle drives public delivery', () => {
  it('a tenant with delivery off still gets the plaintext result', async () => {
    const h = harness([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    const out = await call(h, RESULT_PATH);
    expect(out.kind).toBe('body');
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.body['encrypted']).toBeUndefined();
    expect((out.body['data'] as { resultRef?: string }).resultRef).toBe(RESULT_REF);
  });
  it('turning the toggle on encrypts the NEXT result, with no restart', async () => {
    const h = harness([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: null });
    const out = await call(h, RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.body['encrypted']).toBe(true);
    const payload = JSON.parse(externalDecrypt(out.body['delivery']).toString('utf8')) as Record<string, unknown>;
    expect((payload['data'] as { resultRef?: string }).resultRef).toBe(RESULT_REF);
  });

  it('the same toggle encrypts the artifact bytes on /download', async () => {
    const h = harness([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: null });
    const out = await call(h, DOWNLOAD_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.body['encrypted']).toBe(true);
    expect(externalDecrypt(out.body['delivery'])).toEqual(ARTIFACT_BYTES);
  });

  it('a PINNED key version is the one used, even after a rotation', async () => {
    const h = harness([
      { version: 1, revokedAt: null, fingerprint: 'SHA256:one' },
      { version: 2, revokedAt: null, fingerprint: 'SHA256:two' },
    ]);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: 1 });
    const out = await call(h, RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    const envelope = out.body['delivery'] as { recipientKeyVersion: number };
    expect(envelope.recipientKeyVersion).toBe(1);
  });

  it('unpinning falls back to the current active key', async () => {
    const h = harness([
      { version: 1, revokedAt: null, fingerprint: 'SHA256:one' },
      { version: 2, revokedAt: null, fingerprint: 'SHA256:two' },
    ]);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: null });
    const out = await call(h, RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    const envelope = out.body['delivery'] as { recipientKeyVersion: number };
    expect(envelope.recipientKeyVersion).toBe(2);
  });

  it('revoking the PINNED key fails closed, and never falls back to plaintext', async () => {
    const keys = [
      { version: 1, revokedAt: null, fingerprint: 'SHA256:one' },
      { version: 2, revokedAt: null, fingerprint: 'SHA256:two' },
    ];
    const h = harness(keys);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: 1 });
    (keys[0] as { revokedAt: string | null }).revokedAt = '2026-06-01T00:00:00.000Z';
    const out = await call(h, RESULT_PATH);
    expect(out).toMatchObject({ kind: 'problem', status: 503 });
  });

  it('turning the toggle back off restores the plaintext path', async () => {
    const h = harness([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: true, pinnedRecipientKeyVersion: null });
    await h.store.set(TENANT, { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null });
    const out = await call(h, RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.body['encrypted']).toBeUndefined();
  });

  it('getPolicy refuses on a store-backed policy rather than answering stale', async () => {
    const h = harness([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    expect(h.delivery).not.toBeNull();
    expect(() => h.delivery!.getPolicy(TENANT)).toThrow();
    const resolved = await h.delivery!.resolvePolicy(TENANT);
    expect(resolved).toEqual({ enabled: false, pinnedRecipientKeyVersion: null });
  });

  it('a platform with no crypto-config surface still honours static policyByTenant', async () => {
    const registry = makeRegistry([{ version: 1, revokedAt: null, fingerprint: 'SHA256:one' }]);
    const svc = createDeliveryEncryptionService({
      policyByTenant: { [TENANT]: { enabled: true } },
      recipientKeyRegistry: registry,
    });
    expect(svc).not.toBeNull();
    expect(svc!.getPolicy(TENANT)).toEqual({ enabled: true });
    const envelope = await svc!.encryptForDelivery(TENANT, Buffer.from('static', 'utf8'));
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('static', 'utf8'));
  });
});
