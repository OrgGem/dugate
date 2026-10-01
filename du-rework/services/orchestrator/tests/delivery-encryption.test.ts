/**
 * ENC-07 (tasks/APP-ENCRYPTION-2026-09-27.md): delivery encryption for the
 * public result/download API, in two halves.
 *
 * HALF 1 - the service. Offline, no PG/Redis/Vault/network. Proves the
 * cryptography and the fail-closed decision: a fresh delivery DEK per
 * response, AES-256-GCM with a unique nonce, the DEK wrapped under the
 * recipient public key from the ENC-06 registry, an envelope that
 * satisfies the ENC-01 contract, and no plaintext anywhere on the wire.
 *
 * HALF 2 - the two public routes through the real route() handler with a
 * recording fake db and an in-memory artifact stream. Proves what only a
 * route can get wrong: the policy is server-side (no query parameter or
 * header can move a tenant between plaintext and encrypted), BOTH surfaces
 * obey the SAME policy - wrapping {resultRef} while streaming artifact
 * bytes raw would protect the metadata and leak the payload - and every
 * key failure answers 503 on the wire with the payload nowhere in it.
 *
 * The keypair below is a FIXTURE generated once for this suite. Its private
 * half appears only because the test must act as the external recipient
 * that decrypts; in production the private key never enters the app.
 */
import { createHash } from 'node:crypto';
import {
  constants,
  createDecipheriv,
  createPrivateKey,
  privateDecrypt,
} from 'node:crypto';
import { Readable } from 'node:stream';
import type { QueryResult, QueryResultRow } from 'pg';
import {
  ENCRYPTED_DELIVERY_CONTENT_TYPE,
  EncryptedArtifactDownloadSchema,
  EncryptedResultEnvelopeSchema,
  PlainArtifactDownloadBodySchema,
  RecipientDeliveryEnvelopeSchema,
  ResultEnvelopeSchema,
  ResultResponseSchema,
} from '@du/contracts';
import { route, type RouteContext } from '../src/server';
import { isHttpError } from '../src/http/errors';
import {
  createDeliveryEncryptionService,
  DeliveryEncryptionError,
  type TenantDeliveryPolicy,
} from '../src/modules/public-api';
import {
  RecipientKeyRegistryError,
  type RecipientPublicKeyRecord,
} from '../src/modules/encryption/recipient-key-registry';

const TENANT_ENC = 'tenant-encrypted';
const TENANT_PLAIN = 'tenant-plaintext';
const FOREIGN_TENANT = 'tenant-foreign';
const API_KEY = 'enc07-api-key';
const KEY_HASH = createHash('sha256').update(API_KEY).digest('hex');
const OP_ID = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_BYTES = Buffer.from('artifact-payload-bytes-7c1f', 'utf8');
const RESULT_REF = 'result-ref-should-not-leak-plaintext';

const RECIPIENT_PUBLIC_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn0k0PZTMI3Ev3NLE2XeD",
  "4LYhExEMeTd5eQEQu5ntUOgEQvZeJnCOsLB4pX2HDMA1GbpUtMKNtSwZkHPtaFHZ",
  "OeKQR2hIxJ/DXWm0lyk2M84uPof22s/zRj89t5QOqxk2ujtpWOzawqdbCgrAzYZx",
  "coRs+b+MNAh2lK/RLauZANFhpwFfNbvHCVCyA8q7lr2t9nFeP/WBhP/M9Qrk8fVe",
  "1qFJvYEE4T8JORxKMQxVfh3hWDOjUeiAr4PmIVsqLxw7cmdOeq8n42FR4DkdwHO7",
  "Mc4d9LCvDBE2gQN7RUqrNYSKzPWOyvHJyHXj0ELmM+xY21g9LxrJAD60C6hrl5gA",
  "wQIDAQAB",
  "-----END PUBLIC KEY-----",
].join('\n');
const RECIPIENT_PRIVATE_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCfSTQ9lMwjcS/c",
  "0sTZd4PgtiETEQx5N3l5ARC7me1Q6ARC9l4mcI6wsHilfYcMwDUZulS0wo21LBmQ",
  "c+1oUdk54pBHaEjEn8NdabSXKTYzzi4+h/baz/NGPz23lA6rGTa6O2lY7NrCp1sK",
  "CsDNhnFyhGz5v4w0CHaUr9Etq5kA0WGnAV81u8cJULIDyruWva32cV4/9YGE/8z1",
  "CuTx9V7WoUm9gQThPwk5HEoxDFV+HeFYM6NR6ICvg+YhWyovHDtyZ056ryfjYVHg",
  "OR3Ac7sxzh30sK8METaBA3tFSqs1hIrM9Y7K8cnIdePQQuYz7FjbWD0vGskAPrQL",
  "qGuXmADBAgMBAAECggEAASomrFJYo4Pz6dM98pnczE1inKZD00VSQV3uUJPXnA9F",
  "PDTbU4BAT9cLe8jJHnEPllWCIev3/6iP04pAdLJAAowHOmlvGkZxhg7kPdR0n7B4",
  "zrbdaYRKmuNynONzj8FUgMw3SQnaz+Brwk0Zs6sBbHkex5z0nksHTG8kajdCbDLI",
  "xOGcVwxKDgDJBycAQAxl0tgZ1ASqT+4fmm9LHMd632xt9KCLOJVLx0dFRVBEVUOC",
  "PdcAvdv7wYgoQ9tsahG4XfRfT723sqN2/n4smcq8KOy1hFWWmzt353dicthalHZi",
  "AH5FXbcUltyxCDfjPqagtLb6tvFd8ztUokHdqmo2EQKBgQDWUu1izdRyMq4J604k",
  "g6WID7PMW1vH8XSEIWkGLazH2qlX/IvWmCEvgY6BMo/QMwIub3hMDb1ptEalaz3q",
  "FOsyGnA1mecJyhxUsPARd6KmpaHhdB5gov3qzqUP0ZPPTUY+TSiy0gv/GODTrSxZ",
  "wxRXazKVAxADyXlsjX+K6N8AEQKBgQC+QnqkRaSyeW37+Izvu0zWvQKYRgkalvNo",
  "2ZBqXUKIJNfawFLaivPJUPQ7efEjz+JMhDs2wFvHASmHFukvJOeUWjVCsDejkWti",
  "HIfN5ZphStUFFdWvb+FfKh4W63SnUPDA1DKSuOr4scUAKHkrJ9JOQIjLtP89w+0v",
  "Z7jLsn6lsQKBgQCAm1ZzOYvH0v14WkiTxKNp1/JOKGwUuKDwQJQi7vmFG4MOly7a",
  "YINZXGbExDBkAJfIgX8wM/Z7HYBe9tE6S78uW4sFvwpSZ4NElsAX2zAwy6cuAF3S",
  "Izw20DVgHqSReo8yB17qnvwv4R/YJUw9uL/WDS9XF3VesGE6cFYeZsqZ4QKBgQCz",
  "QQsvjnYXuRSIm6qdi4hfoYC6WvHk3WfD14eazvcKMjw025K0WMpLWDxjdQZeyVPa",
  "55KqiR1vJ4cqwck9I7YULdGUXVZug2n67Ap/UN3c4JZGzkWfnvdlo9bpnTkxEq9h",
  "3gsv9Y1cdpC3D2rp4ADivSalVohMdzYWvdB8ClYMYQKBgB2mMBFlxQXSGUNxm2Hj",
  "DBytX7M3SSx0vOPuq5MFc4rUrzi2vOciN/rpSyasObUocQ235BQ23fCH6tV+8lfH",
  "94qsiopVyKqoReo0DvFPaZyA8X7cDGEYvOqpIq08CWC/RJ/w7D0MRia9wZBGpFix",
  "WGpqYil2QtL2LEwtF9mbBOPR",
  "-----END PRIVATE KEY-----",
].join('\n');

/** Stand in for the external app holding only the private key. */
function externalDecrypt(envelope: unknown): Buffer {
  const parsed = RecipientDeliveryEnvelopeSchema.parse(envelope);
  const dek = privateDecrypt(
    {
      key: createPrivateKey(RECIPIENT_PRIVATE_PEM),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(parsed.enc, 'base64'),
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(parsed.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } finally {
    dek.fill(0);
  }
}

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}

function keyRecord(over: Partial<RecipientPublicKeyRecord> = {}): RecipientPublicKeyRecord {
  return {
    id: 'key-enc07',
    tenantId: TENANT_ENC,
    version: 1,
    algorithm: 'rsa-oaep-sha256',
    publicKeyPem: RECIPIENT_PUBLIC_PEM,
    fingerprint: 'SHA256:fixture',
    effectiveAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    ...over,
  };
}

/** Registry stub carrying the three failure modes the service must survive. */
function registryStub(current: RecipientPublicKeyRecord | null, failWith?: Error) {
  return {
    async getCurrentKey(tenantId: string): Promise<RecipientPublicKeyRecord> {
      if (failWith) throw failWith;
      if (!current || current.tenantId !== tenantId) {
        throw new RecipientKeyRegistryError('KEY_NOT_FOUND', 'no key registered for tenant');
      }
      if (current.revokedAt !== null) {
        throw new RecipientKeyRegistryError('KEY_REVOKED', 'key revoked');
      }
      return current;
    },
  } as never;
}

function service(policyByTenant: Record<string, TenantDeliveryPolicy>, registry?: unknown) {
  return createDeliveryEncryptionService({
    policyByTenant,
    recipientKeyRegistry: registry as never,
  });
}

describe('ENC-07: delivery encryption service', () => {
  it('encrypts a payload the external recipient decrypts back to the exact bytes', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const payload = Buffer.from(JSON.stringify({ resultRef: 'res_abc' }), 'utf8');

    const envelope = await svc.encryptForDelivery(TENANT_ENC, payload);

    expect(RecipientDeliveryEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.suite).toBe('rsa-oaep-sha256');
    expect(envelope.recipientKeyId).toBe('key-enc07');
    expect(envelope.recipientKeyVersion).toBe(1);
    expect(externalDecrypt(envelope)).toEqual(payload);
  });

  it('never puts the plaintext payload in the envelope', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const marker = 'PLAINTEXT-CANARY-9f2a';
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from(marker, 'utf8'));
    expect(JSON.stringify(envelope)).not.toContain(marker);
  });

  it('uses a fresh DEK and nonce for every response', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const payload = Buffer.from('same bytes every time', 'utf8');

    const first = await svc.encryptForDelivery(TENANT_ENC, payload);
    const second = await svc.encryptForDelivery(TENANT_ENC, payload);

    // Identical plaintext must never produce identical wire bytes.
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.enc).not.toBe(second.enc);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(externalDecrypt(first)).toEqual(payload);
    expect(externalDecrypt(second)).toEqual(payload);
  });

  it('fails closed when the tenant has no registered recipient key', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(null))!;
    await expect(
      svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8')),
    ).rejects.toMatchObject({ code: 'RECIPIENT_KEY_NOT_FOUND' });
  });

  it('fails closed when the recipient key was revoked', async () => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ revokedAt: '2026-02-01T00:00:00.000Z' })),
    )!;
    await expect(
      svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8')),
    ).rejects.toMatchObject({ code: 'RECIPIENT_KEY_REVOKED' });
  });

  it('fails closed when the registry is unavailable', async () => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(null, new RecipientKeyRegistryError('REGISTRY_UNAVAILABLE', 'db down')),
    )!;
    await expect(
      svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8')),
    ).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
  });

  it('fails closed when the policy is enabled but no registry is wired', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } })!;
    await expect(
      svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8')),
    ).rejects.toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
  });

  it('refuses a tenant whose policy is absent or disabled', async () => {
    const svc = service({ [TENANT_PLAIN]: { enabled: false } }, registryStub(keyRecord()))!;
    expect(svc.getPolicy(TENANT_PLAIN)).toEqual({ enabled: false });
    expect(svc.getPolicy('tenant-never-configured')).toBeUndefined();
    await expect(
      svc.encryptForDelivery(TENANT_PLAIN, Buffer.from('x', 'utf8')),
    ).rejects.toBeInstanceOf(DeliveryEncryptionError);
  });

  it('is absent entirely on a platform with no tenant policy (plaintext default)', () => {
    expect(createDeliveryEncryptionService(undefined)).toBeNull();
    expect(createDeliveryEncryptionService({})).toBeNull();
    expect(createDeliveryEncryptionService({ policyByTenant: {} })).toBeNull();
  });

  it('refuses an HPKE key rather than downgrading to RSA', async () => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ algorithm: 'hpke-x25519' })),
    )!;
    await expect(
      svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8')),
    ).rejects.toMatchObject({ code: 'DELIVERY_CRYPTO_FAILURE' });
  });
});
interface HarnessOptions {
  /** Tenant the presented x-api-key authenticates as. */
  tenant?: string;
  /** Tenant that owns the operation/artifact. Defaults to `tenant`. */
  ownerTenant?: string;
  policyByTenant?: Record<string, TenantDeliveryPolicy>;
  /** null = no key registered; a record = that key; a throw = outage. */
  key?: RecipientPublicKeyRecord | null;
  registryError?: Error;
  maxBlobBytes?: number;
  blobBytes?: Buffer;
}

/**
 * A route context whose fake db answers exactly the statements the two
 * delivery routes issue. An unmodelled statement THROWS, so a query the
 * harness forgot cannot quietly look like an empty result set.
 */
function harness(options: HarnessOptions = {}): RouteContext {
  const tenant = options.tenant ?? TENANT_ENC;
  const owner = options.ownerTenant ?? tenant;
  const policyByTenant = options.policyByTenant ?? { [TENANT_ENC]: { enabled: true } };
  const blob = options.blobBytes ?? ARTIFACT_BYTES;

  const db = {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> {
      if (/FROM api_keys WHERE hash/i.test(sql)) {
        // Only the hash this suite actually presents resolves, and it
        // resolves to the tenant the harness authenticated as.
        if (params[0] !== KEY_HASH) return pgResult([]);
        return pgResult([{ id: 'api-key-1', tenant_id: tenant }]);
      }
      if (/FROM operations o/i.test(sql) && /LEFT JOIN artifacts/i.test(sql)) {
        return pgResult([{
          id: ARTIFACT_ID,
          purpose: 'output',
          mime_type: 'application/octet-stream',
          size_bytes: blob.byteLength,
          sha256: createHash('sha256').update(blob).digest('hex'),
          state: 'READY',
          submit_roles: [],
        }]);
      }
      if (/FROM artifacts a/i.test(sql) && /a\.storage_key/i.test(sql)) {
        if (tenant !== owner) return pgResult([]);
        return pgResult([{
          state: 'READY',
          mime_type: 'application/octet-stream',
          tenant_id: owner,
          storage_key: 'storage/' + ARTIFACT_ID,
        }]);
      }
      throw new Error('unmodelled SQL in the ENC-07 harness: ' + sql.slice(0, 120));
    },
  };

  return {
    method: 'GET',
    pathname: '/',
    searchParams: new URLSearchParams(''),
    headers: { 'x-api-key': API_KEY },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'enc07-test',
    host: 'localhost',
    db,
    runtime: {
      async getOperation(id: string) {
        return { id, tenant_id: owner, state: 'SUCCEEDED', result_ref: RESULT_REF };
      },
    },
    usage: {
      async project() {
        return { inputTokens: 0, outputTokens: 0, costMicrousd: 0, measurement: 'pending' };
      },
    },
    artifacts: {
      async getBlob() {
        return Readable.from([Buffer.from(blob)]);
      },
    },
    deliveryEncryption: createDeliveryEncryptionService({
      policyByTenant,
      recipientKeyRegistry: registryStub(
        options.key === undefined ? keyRecord() : options.key,
        options.registryError,
      ),
    }),
    config: { maxBlobBytes: options.maxBlobBytes },
  } as unknown as RouteContext;
}

type Outcome =
  | { kind: 'body'; status: number; body: Record<string, unknown>; raw?: Buffer | Readable; headers?: Record<string, string> }
  | { kind: 'problem'; status: number; problem: Record<string, unknown> }

/** Drive one public request and classify the outcome. */
async function call(
  ctx: RouteContext,
  pathname: string,
  search = '',
  headers: Record<string, string> = {},
): Promise<Outcome> {
  (ctx as unknown as { pathname: string }).pathname = pathname;
  (ctx as unknown as { searchParams: URLSearchParams }).searchParams = new URLSearchParams(search);
  (ctx as unknown as { headers: Record<string, string> }).headers = { 'x-api-key': API_KEY, ...headers };
  try {
    const res = await route(ctx);
    return {
      kind: 'body',
      status: res.status,
      body: (res.body ?? {}) as Record<string, unknown>,
      ...(res.raw === undefined ? {} : { raw: res.raw }),
      ...(res.headers === undefined ? {} : { headers: res.headers }),
    };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return {
      kind: 'problem',
      status: err.status,
      problem: err.toProblem('enc07-test') as unknown as Record<string, unknown>,
    };
  }
}

const RESULT_PATH = `/api/v1/operations/${OP_ID}/result`;
const DOWNLOAD_PATH = `/api/v1/artifacts/${ARTIFACT_ID}/download`;

describe('ENC-07: public delivery surfaces follow the server-side policy', () => {
  it('/result wraps the result in an envelope the external recipient decrypts', async () => {
    const out = await call(harness(), RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.status).toBe(200);
    const encrypted = EncryptedResultEnvelopeSchema.parse(ResultResponseSchema.parse(out.body));
    const plaintext = ResultEnvelopeSchema.parse(JSON.parse(externalDecrypt(encrypted.delivery).toString('utf8')));
    expect(plaintext.data).toEqual({ resultRef: RESULT_REF });
    expect(plaintext.schemaVersion).toBe('1');
    expect(plaintext.artifacts).toHaveLength(1);
    const artifactDownload = await call(harness(), plaintext.artifacts[0]!.download!);
    if (artifactDownload.kind !== 'body') throw new Error('unreachable');
    const encryptedArtifact = EncryptedArtifactDownloadSchema.parse(artifactDownload.body);
    expect(externalDecrypt(encryptedArtifact.delivery)).toEqual(ARTIFACT_BYTES);
  });

  it('/result leaves no plaintext resultRef on the wire when encrypted', async () => {
    const out = await call(harness(), RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(JSON.stringify(out.body)).not.toContain(RESULT_REF);
  });

  it('/download wraps the artifact bytes, and the recipient gets them back exactly', async () => {
    const out = await call(harness(), DOWNLOAD_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(out.status).toBe(200);
    const encrypted = EncryptedArtifactDownloadSchema.parse(out.body);
    expect(out.headers?.['content-type']).toBe(ENCRYPTED_DELIVERY_CONTENT_TYPE);
    expect(encrypted.mimeType).toBe('application/octet-stream');
    expect(encrypted.artifactId).toBe(ARTIFACT_ID);
    expect(externalDecrypt(encrypted.delivery)).toEqual(ARTIFACT_BYTES);
  });

  it('an encrypted tenant never receives artifact bytes in the clear', async () => {
    const out = await call(harness(), DOWNLOAD_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    expect(JSON.stringify(out.body)).not.toContain(ARTIFACT_BYTES.toString('utf8'));
  });

  it('a tenant with no policy keeps BOTH existing plaintext shapes', async () => {
    const ctx = harness({
      tenant: TENANT_PLAIN,
      policyByTenant: { [TENANT_PLAIN]: { enabled: false } },
    });

    const result = await call(ctx, RESULT_PATH);
    if (result.kind !== 'body') throw new Error('unreachable');
    expect(result.status).toBe(200);
    const plainResult = ResultEnvelopeSchema.parse(ResultResponseSchema.parse(result.body));
    expect(result.body['encrypted']).toBeUndefined();
    expect(plainResult.data).toEqual({ resultRef: RESULT_REF });

    const download = await call(ctx, DOWNLOAD_PATH);
    if (download.kind !== 'body') throw new Error('unreachable');
    expect(download.body['encrypted']).toBeUndefined();
    expect(download.status).toBe(200);
    expect(download.headers?.['content-type']).toBe('application/octet-stream');
    expect(PlainArtifactDownloadBodySchema.parse(download.raw)).toBe(download.raw);
  });

  it('no client input can move an encrypted tenant back to plaintext', async () => {
    const attempts: Array<[string, string, Record<string, string>]> = [
      [RESULT_PATH, 'encrypted=0', {}],
      [RESULT_PATH, 'plaintext=1&encrypted=false', {}],
      [RESULT_PATH, '', { 'x-delivery-mode': 'plaintext' }],
      [RESULT_PATH, '', { accept: 'text/plain' }],
      [DOWNLOAD_PATH, 'encrypted=0', {}],
      [DOWNLOAD_PATH, 'plaintext=true', { 'x-delivery-encryption': 'off' }],
      [DOWNLOAD_PATH, '', { accept: 'application/octet-stream' }],
    ];
    for (const [path, search, headers] of attempts) {
      const out = await call(harness(), path, search, headers);
      if (out.kind !== 'body') throw new Error('unreachable: ' + path + ' ' + search);
      expect(out.body['encrypted']).toBe(true);
    }
  });

  it('fails closed with 503 when no recipient key is registered', async () => {
    for (const path of [RESULT_PATH, DOWNLOAD_PATH]) {
      const out = await call(harness({ key: null }), path);
      expect(out.kind).toBe('problem');
      if (out.kind !== 'problem') throw new Error('unreachable');
      expect(out.status).toBe(503);
      expect(JSON.stringify(out.problem)).not.toContain(RESULT_REF);
      expect(JSON.stringify(out.problem)).not.toContain(ARTIFACT_BYTES.toString('utf8'));
    }
  });

  it('fails closed with 503 when the recipient key is revoked', async () => {
    for (const path of [RESULT_PATH, DOWNLOAD_PATH]) {
      const out = await call(harness({ key: keyRecord({ revokedAt: '2026-02-01T00:00:00.000Z' }) }), path);
      expect(out.kind).toBe('problem');
      if (out.kind !== 'problem') throw new Error('unreachable');
      expect(out.status).toBe(503);
    }
  });

  it('fails closed with 503 when the registry itself is down', async () => {
    const out = await call(
      harness({ registryError: new RecipientKeyRegistryError('REGISTRY_UNAVAILABLE', 'db down') }),
      RESULT_PATH,
    );
    expect(out.kind).toBe('problem');
    if (out.kind !== 'problem') throw new Error('unreachable');
    expect(out.status).toBe(503);
  });

  it('pins the registered key id AND version into the envelope', async () => {
    const out = await call(harness({ key: keyRecord({ id: 'key-rotated-9', version: 7 }) }), RESULT_PATH);
    if (out.kind !== 'body') throw new Error('unreachable');
    const envelope = RecipientDeliveryEnvelopeSchema.parse(out.body['delivery']);
    expect(envelope.recipientKeyId).toBe('key-rotated-9');
    expect(envelope.recipientKeyVersion).toBe(7);
  });

  it('another tenant gets 404 on both surfaces, before any key is consulted', async () => {
    const ctx = harness({ ownerTenant: FOREIGN_TENANT });
    for (const path of [RESULT_PATH, DOWNLOAD_PATH]) {
      const out = await call(ctx, path);
      expect(out.kind).toBe('problem');
      if (out.kind !== 'problem') throw new Error('unreachable');
      expect(out.status).toBe(404);
    }
  });

  it('an artifact past the encrypted-delivery ceiling fails closed instead of buffering', async () => {
    const out = await call(harness({ maxBlobBytes: 4 }), DOWNLOAD_PATH);
    expect(out.kind).toBe('problem');
    if (out.kind !== 'problem') throw new Error('unreachable');
    expect(out.status).toBe(413);
    expect(JSON.stringify(out.problem)).not.toContain(ARTIFACT_BYTES.toString('utf8'));
  });
});

// CR28-10: delivery encryption negatives and boundaries.
//
// The baseline suite pins the cryptography and the fail-closed 503s. The gaps
// filled here are the ones that decide WHO can read a delivery, which the
// baseline never exercised:
//
//   - the PINNED recipient key version path (getKeyVersion), including the
//     guarantee that a dead pin refuses rather than falling back to the
//     current key;
//   - a malformed recipient PEM and an algorithm string the suite does not gate;
//   - the missing / wrong x-api-key on both public surfaces;
//   - a registry record that belongs to another tenant;
//   - corrupt envelopes on the receiving side.
describe('CR28-10 delivery: pinned recipient key version', () => {
  /**
   * getCurrentKey throws on purpose: if the service ever fell back to the
   * current key when a pin was unusable, the test would fail loudly instead of
   * quietly passing on a working key.
   */
  function pinnedRegistry(
    keys: Record<number, RecipientPublicKeyRecord>,
    failVersion?: RecipientKeyRegistryError,
  ) {
    const consulted: string[] = [];
    const registry = {
      async getKeyVersion(tenantId: string, version: number): Promise<RecipientPublicKeyRecord> {
        consulted.push('getKeyVersion:' + version);
        if (failVersion) throw failVersion;
        const record = keys[version];
        if (!record || record.tenantId !== tenantId) {
          throw new RecipientKeyRegistryError('KEY_NOT_FOUND', 'no such version for tenant');
        }
        if (record.revokedAt !== null) {
          throw new RecipientKeyRegistryError('KEY_REVOKED', 'key revoked');
        }
        return record;
      },
      async getCurrentKey(): Promise<RecipientPublicKeyRecord> {
        consulted.push('getCurrentKey');
        throw new Error('getCurrentKey must not be consulted when a version is pinned');
      },
    } as never;
    return { registry, consulted };
  }

  it('uses the PINNED version, not the current one', async () => {
    const pinned = keyRecord({ id: 'key-pinned', version: 4 });
    const current = keyRecord({ id: 'key-current', version: 9 });
    const { registry, consulted } = pinnedRegistry({ 4: pinned, 9: current });
    const svc = service(
      { [TENANT_ENC]: { enabled: true, pinnedRecipientKeyVersion: 4 } },
      registry,
    )!;

    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('pinned', 'utf8'));
    expect(envelope.recipientKeyId).toBe('key-pinned');
    expect(envelope.recipientKeyVersion).toBe(4);
    expect(consulted).toEqual(['getKeyVersion:4']);
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('pinned', 'utf8'));
  });

  it('a pin that names nothing REFUSES; it never falls back to the current key', async () => {
    const current = keyRecord({ id: 'key-current', version: 9 });
    const { registry } = pinnedRegistry({ 9: current });
    const svc = service(
      { [TENANT_ENC]: { enabled: true, pinnedRecipientKeyVersion: 7 } },
      registry,
    )!;

    // The exact reason a pin exists: a rotation must not silently change WHO can
    // decrypt. Falling back here would hand every delivery to the new key.
    await expect(svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'))).rejects.toMatchObject({
      code: 'RECIPIENT_KEY_NOT_FOUND',
    });
  });

  it('a pin onto a REVOKED version refuses rather than falling back', async () => {
    const revoked = keyRecord({ id: 'key-old', version: 2, revokedAt: '2026-02-01T00:00:00.000Z' });
    const current = keyRecord({ id: 'key-current', version: 9 });
    const { registry } = pinnedRegistry({ 2: revoked, 9: current });
    const svc = service(
      { [TENANT_ENC]: { enabled: true, pinnedRecipientKeyVersion: 2 } },
      registry,
    )!;

    await expect(svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'))).rejects.toMatchObject({
      code: 'RECIPIENT_KEY_REVOKED',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['null', null],
    ['undefined', undefined],
  ])('treats a pin of %s as NO pin and follows the current key', async (_label, pinned) => {
    // registryStub implements getCurrentKey, which is the correct path here:
    // a pin that is not a positive safe integer is treated as ABSENT. The
    // pinnedRegistry helper above is for the opposite assertion - it throws on
    // getCurrentKey precisely to prove a real pin never falls back.
    const svc = service(
      { [TENANT_ENC]: { enabled: true, pinnedRecipientKeyVersion: pinned as number | null } },
      registryStub(keyRecord({ id: 'key-current', version: 9 })),
    )!;

    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'));
    expect(envelope.recipientKeyId).toBe('key-current');
    expect(envelope.recipientKeyVersion).toBe(9);
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('x', 'utf8'));
  });

  it('the registry is never consulted at all when the tenant policy is disabled', async () => {
    let consulted = 0;
    const registry = {
      async getCurrentKey(): Promise<RecipientPublicKeyRecord> {
        consulted += 1;
        return keyRecord();
      },
      async getKeyVersion(): Promise<RecipientPublicKeyRecord> {
        consulted += 1;
        return keyRecord();
      },
    } as never;
    const svc = service({ [TENANT_PLAIN]: { enabled: false } }, registry)!;

    await expect(svc.encryptForDelivery(TENANT_PLAIN, Buffer.from('x', 'utf8'))).rejects.toMatchObject({
      code: 'DELIVERY_ENCRYPTION_DISABLED',
    });
    expect(consulted).toBe(0);
  });
});

describe('CR28-10 delivery: malformed key material and algorithm', () => {
  it.each([
    ['an empty PEM', ''],
    ['prose that is not a key', 'this is not a public key'],
    ['a PEM with a corrupted body', RECIPIENT_PUBLIC_PEM.replace('MIIBIjAN', 'MIIBIjAX')],
    ['a truncated PEM header', RECIPIENT_PUBLIC_PEM.slice(0, 40)],
  ])('fails closed with DELIVERY_CRYPTO_FAILURE when the recipient PEM is %s', async (_label, pem) => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ publicKeyPem: pem })),
    )!;

    // createPublicKey throws inside the encrypt try-block, so the failure is
    // reported as a crypto failure and never as a plaintext fallback.
    await expect(svc.encryptForDelivery(TENANT_ENC, Buffer.from('secret', 'utf8'))).rejects.toMatchObject({
      code: 'DELIVERY_CRYPTO_FAILURE',
    });
  });

  it('FINDING: a PRIVATE key pasted into publicKeyPem is accepted, not refused', async () => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ publicKeyPem: RECIPIENT_PRIVATE_PEM })),
    )!;

    // createPublicKey() accepts a private-key PEM and derives the public half,
    // so encryption SUCCEEDS against a field that is supposed to hold public key
    // material only. Nothing leaks on the wire - `enc` is the wrapped DEK - but the
    // registry does not enforce the PUBLIC-ness of the field, so a private key
    // misfiled at registration would sit undetected and keep working.
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('secret', 'utf8'));
    expect(RecipientDeliveryEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('secret', 'utf8'));
    expect(JSON.stringify(envelope)).not.toContain('PRIVATE KEY');
  });

  it('FINDING: an algorithm the suite does not recognise is still wrapped as RSA-OAEP', async () => {
    // The declared union has no PSS member, so this is a cast: the POINT is
    // that the registry row is only shape-validated at registration and
    // resolveSuite() re-reads it at delivery time without checking the union.
    const odd = 'rsa-pss-sha512' as unknown as RecipientPublicKeyRecord['algorithm'];
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ algorithm: odd })),
    )!;

    // resolveSuite() gates ONLY on hpke-x25519; every other value, including a
    // declared PSS suite or a typo, resolves to rsa-oaep-sha256 and the PEM is
    // used as an RSA key. The envelope reports what was DONE (rsa-oaep-sha256),
    // so it is not mislabelled - but the registry's algorithm field is never
    // checked against the material, and an operator reading the record would be
    // misled about how the DEK was wrapped.
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'));
    expect(envelope.suite).toBe('rsa-oaep-sha256');
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('x', 'utf8'));
  });

  it.each([
    ['an empty algorithm string', ''],
    ['a completely unknown suite name', 'quantum-otp'],
  ])('still wraps as RSA-OAEP when the algorithm is %s', async (_label, raw) => {
    const algorithm = raw as unknown as RecipientPublicKeyRecord['algorithm'];
    const svc = service(
      { [TENANT_ENC]: { enabled: true } },
      registryStub(keyRecord({ algorithm })),
    )!;

    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'));
    expect(envelope.suite).toBe('rsa-oaep-sha256');
  });

  it('a policy suite preference is ignored when the key disagrees', async () => {
    const svc = service(
      { [TENANT_ENC]: { enabled: true, suite: 'hpke-rfc9180' } },
      registryStub(keyRecord({ algorithm: 'rsa-oaep-sha256' })),
    )!;

    // The policy asked for HPKE but the registered key is RSA. The key wins,
    // so the delivery still succeeds rather than failing on a mismatch.
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'));
    expect(envelope.suite).toBe('rsa-oaep-sha256');
    expect(externalDecrypt(envelope)).toEqual(Buffer.from('x', 'utf8'));
  });
});

describe('CR28-10 delivery: missing and wrong credentials on the wire', () => {
  /** Drive the route with a hand-set header map, so a header can be ABSENT. */
  async function callWithHeaders(
    ctx: RouteContext,
    pathname: string,
    headers: Record<string, string>,
  ): Promise<Outcome> {
    (ctx as unknown as { pathname: string }).pathname = pathname;
    (ctx as unknown as { searchParams: URLSearchParams }).searchParams = new URLSearchParams('');
    (ctx as unknown as { headers: Record<string, string> }).headers = headers;
    try {
      const res = await route(ctx);
      return { kind: 'body', status: res.status, body: (res.body ?? {}) as Record<string, unknown> };
    } catch (err) {
      if (!isHttpError(err)) throw err;
      return {
        kind: 'problem',
        status: err.status,
        problem: err.toProblem('enc07-test') as unknown as Record<string, unknown>,
      };
    }
  }

  it('a request with NO api key header is 401 on both surfaces, with no payload', async () => {
    for (const path of [RESULT_PATH, DOWNLOAD_PATH]) {
      const out = await callWithHeaders(harness(), path, {});
      expect(out.kind).toBe('problem');
      if (out.kind !== 'problem') throw new Error('unreachable');
      expect(out.status).toBe(401);
      expect(JSON.stringify(out.problem)).not.toContain(RESULT_REF);
    }
  });

  it.each([
    ['an empty value', ''],
    ['a wrong value', 'wrong-key'],
    ['the key with a trailing space', API_KEY + ' '],
  ])('an api key that is %s is 401', async (_label, value) => {
    const out = await callWithHeaders(harness(), RESULT_PATH, { 'x-api-key': value });
    expect(out.kind).toBe('problem');
    if (out.kind !== 'problem') throw new Error('unreachable');
    expect(out.status).toBe(401);
  });

  it('a cross-tenant fetch is 404 and never returns key material', async () => {
    const ctx = harness({ ownerTenant: FOREIGN_TENANT });
    for (const path of [RESULT_PATH, DOWNLOAD_PATH]) {
      const out = await call(ctx, path);
      if (out.kind !== 'problem') throw new Error('unreachable');
      expect(out.status).toBe(404);
      const wire = JSON.stringify(out.problem);
      expect(wire).not.toContain(RECIPIENT_PUBLIC_PEM);
      expect(wire).not.toContain(RESULT_REF);
    }
  });

  it('an envelope with a corrupt ciphertext is rejected by the ENC-01 contract', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('payload', 'utf8'));

    // Only NON-base64 text is refused here. 'AAAA' IS valid base64, and the
    // schema deliberately checks ENCODING SHAPE, not decryptability - the GCM tag
    // is what rejects a wrong ciphertext, which the tamper test below proves.
    for (const field of ['enc', 'nonce', 'tag', 'ciphertext'] as const) {
      for (const bad of ['not base64 !!', '', 'has spaces', 'a===']) {
        const corrupted = { ...envelope, [field]: bad };
        expect(RecipientDeliveryEnvelopeSchema.safeParse(corrupted).success).toBe(false);
      }
    }
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...envelope, ciphertext: 'AAAA' }).success).toBe(true);
  });

  it('an envelope with an unknown field is rejected (the schema is strict)', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('payload', 'utf8'));

    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...envelope, extra: 'x' }).success).toBe(false);
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...envelope, recipientKeyVersion: 0 }).success).toBe(false);
  });

  it('a tampered ciphertext fails authentication at the recipient, never silently', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('payload', 'utf8'));
    const raw = Buffer.from(envelope.ciphertext, 'base64');
    raw[0] = raw[0]! ^ 0xff;

    // The recipient side: the GCM tag must reject a flipped byte rather than
    // returning corrupted plaintext to the caller.
    const tampered = { ...envelope, ciphertext: raw.toString('base64') };
    expect(() => externalDecrypt(tampered)).toThrow();
  });

  it('a nonce replayed against a different envelope does not decrypt it', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;
    const first = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('one', 'utf8'));
    const second = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('two', 'utf8'));

    const mixed = { ...second, nonce: first.nonce };
    expect(() => externalDecrypt(mixed)).toThrow();
  });

  it('FINDING: a ZERO-LENGTH payload cannot be delivered at all', async () => {
    const svc = service({ [TENANT_ENC]: { enabled: true } }, registryStub(keyRecord()))!;

    // BASE64_RE is /^[A-Za-z0-9+/]+={0,2}$/ - at least ONE character. An empty
    // payload encrypts to a zero-length ciphertext, whose base64 is the empty
    // string, so the ENC-01 self-check inside encryptForDelivery FAILS and the
    // service throws DELIVERY_CRYPTO_FAILURE rather than returning an envelope.
    // On the wire that is a 503. An operation whose result is legitimately empty
    // therefore cannot be delivered to an encrypted tenant - fail-closed, and no
    // plaintext leaks, but an availability edge worth a decision.
    await expect(svc.encryptForDelivery(TENANT_ENC, Buffer.alloc(0))).rejects.toMatchObject({
      code: 'DELIVERY_CRYPTO_FAILURE',
    });
    // One byte is enough to cross the boundary.
    const envelope = await svc.encryptForDelivery(TENANT_ENC, Buffer.from('x', 'utf8'));
    expect(RecipientDeliveryEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});
