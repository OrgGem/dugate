import { DeliveryEncryptionError, type DeliveryEncryptionService } from '../src/modules/public-api';
import { HttpError } from '../src/http/errors';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';

const TENANT = 'rcr-tenant-a';
const OTHER_TENANT = 'rcr-tenant-b';
const API_KEY_ID = 'rcr-key-a';
const API_KEY = 'valid-rcr-key';
const OPERATION_ID = 'rcr-operation-1';
const OUTPUT = '# encrypted legacy output — café';
const OUTPUT_BYTES = Buffer.from(OUTPUT, 'utf8');
const ENVELOPE = {
  version: 1,
  suite: 'rsa-oaep-sha256' as const,
  recipientKeyId: 'recipient-key-1',
  recipientKeyVersion: 1,
  enc: 'wrapped-dek',
  nonce: 'nonce',
  tag: 'tag',
  ciphertext: OUTPUT_BYTES.toString('base64'),
};

interface TestOptions {
  policyEnabled?: boolean;
  policyError?: boolean;
  encryptionError?: boolean;
  operationTenant?: string;
  apiKeyActive?: boolean;
  maxBlobBytes?: number;
}

function makeContext(options: TestOptions = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const policyCalls: string[] = [];
  const encryptionCalls: { tenantId: string; payload: Buffer }[] = [];
  const apiKeyActive = options.apiKeyActive ?? true;
  const operationTenant = options.operationTenant ?? TENANT;
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM api_keys/i.test(sql)) {
        return apiKeyActive
          ? { rowCount: 1, rows: [{ id: API_KEY_ID, tenant_id: TENANT }] }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT \* FROM operations/i.test(sql)) {
        const requestedTenant = params[1];
        return requestedTenant === operationTenant
          ? {
              rowCount: 1,
              rows: [{
                id: OPERATION_ID,
                tenant_id: operationTenant,
                state: 'SUCCEEDED',
                deleted_at: null,
                output_format: 'markdown',
                output_content: OUTPUT,
              }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT output_content FROM operations/i.test(sql)) {
        return operationTenant === params[1]
          ? { rowCount: 1, rows: [{ output_content: OUTPUT }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
  };
  const deliveryEncryption = {
    getPolicy: () => undefined,
    resolvePolicy: jest.fn(async (tenantId: string) => {
      policyCalls.push(tenantId);
      if (options.policyError) throw new Error('test policy store is unavailable');
      return { enabled: options.policyEnabled ?? false };
    }),
    encryptForDelivery: jest.fn(async (tenantId: string, payload: Buffer) => {
      encryptionCalls.push({ tenantId, payload });
      if (options.encryptionError) {
        throw new DeliveryEncryptionError('RECIPIENT_KEY_NOT_FOUND', 'test key is unavailable');
      }
      return ENVELOPE;
    }),
  } as unknown as DeliveryEncryptionService;
  const ctx = {
    method: 'GET',
    pathname: `/api/v1/operations/${OPERATION_ID}/download`,
    searchParams: new URLSearchParams(),
    headers: { 'x-api-key': API_KEY },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'rcr-http-correlation',
    host: 'localhost',
    db,
    deliveryEncryption,
    config: { maxBlobBytes: options.maxBlobBytes ?? 1024 },
  } as unknown as RouteContext;
  return { ctx, calls, db, policyCalls, encryptionCalls, deliveryEncryption };
}

describe('RCR-06: legacy raw download follows tenant delivery policy', () => {
  it('returns the encrypted JSON envelope and drops plaintext headers when policy is enabled', async () => {
    const h = makeContext({ policyEnabled: true });
    const result = await handlePublicRoutes(h.ctx);

    expect(result).toMatchObject({
      status: 200,
      body: {
        schemaVersion: '1',
        encrypted: true,
        delivery: ENVELOPE,
        mimeType: 'text/markdown; charset=utf-8',
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(result?.raw).toBeUndefined();
    expect(result?.headers).not.toHaveProperty('content-length');
    expect(result?.headers).not.toHaveProperty('Content-Length');
    expect(h.policyCalls).toEqual([TENANT]);
    expect(h.encryptionCalls).toEqual([{ tenantId: TENANT, payload: OUTPUT_BYTES }]);
    expect(h.calls.filter((call) => /FROM api_keys/i.test(call.sql))).toHaveLength(1);
  });

  it('fails closed with 503 when the recipient key is unavailable', async () => {
    const h = makeContext({ policyEnabled: true, encryptionError: true });

    const failure = await handlePublicRoutes(h.ctx).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 503 });
    expect(h.encryptionCalls).toHaveLength(1);
    expect(h.encryptionCalls.every((call) => call.tenantId === TENANT)).toBe(true);
  });

  it('fails closed with 503 when tenant delivery policy cannot be resolved', async () => {
    const h = makeContext({ policyError: true });
    const failure = await handlePublicRoutes(h.ctx).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 503 });
    expect(h.policyCalls).toEqual([TENANT]);
    expect(h.encryptionCalls).toHaveLength(0);
  });

  it('preserves raw bytes only when the authenticated tenant has no enabled policy', async () => {
    const h = makeContext({ policyEnabled: false });
    const result = await handlePublicRoutes(h.ctx);

    expect(result?.status).toBe(200);
    expect(result?.raw).toEqual(OUTPUT_BYTES);
    expect(result?.headers).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': String(OUTPUT_BYTES.length),
    });
    expect(h.policyCalls).toEqual([TENANT]);
    expect(h.encryptionCalls).toHaveLength(0);
  });

  it('does not read or encrypt a foreign-tenant operation', async () => {
    const h = makeContext({ policyEnabled: true, operationTenant: OTHER_TENANT });
    const result = await handlePublicRoutes(h.ctx);

    expect(result?.status).toBe(404);
    expect(result?.raw).toBeUndefined();
    expect(h.calls.some((call) => /SELECT output_content FROM operations/i.test(call.sql))).toBe(false);
    expect(h.policyCalls).toHaveLength(0);
    expect(h.encryptionCalls).toHaveLength(0);
  });

  it('does not read or encrypt output for a denied API key', async () => {
    const h = makeContext({ policyEnabled: true, apiKeyActive: false });
    const result = await handlePublicRoutes(h.ctx);

    // The legacy facade keeps its pre-existing error envelope for auth failure.
    // The relevant privacy invariant is that no output or delivery policy is read.
    expect(result?.status).toBe(500);
    expect(result?.raw).toBeUndefined();
    expect(h.calls.some((call) => /SELECT \* FROM operations/i.test(call.sql))).toBe(false);
    expect(h.policyCalls).toHaveLength(0);
    expect(h.encryptionCalls).toHaveLength(0);
  });

  it('does not attempt an unbounded encrypted delivery', async () => {
    const h = makeContext({ policyEnabled: true, maxBlobBytes: 4 });

    await expect(handlePublicRoutes(h.ctx)).rejects.toMatchObject({
      status: 413,
      code: 'TOO_LARGE',
    });
    expect(h.encryptionCalls).toHaveLength(0);
  });
});
