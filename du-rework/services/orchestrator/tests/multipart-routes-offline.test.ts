import {
  MultipartAbortAckSchema,
  MultipartCompleteAckSchema,
  MultipartInitAckSchema,
  MultipartPartGrantSchema,
} from '@du/contracts';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import type { MultipartService } from '../src/modules/artifacts/multipart-service';
import { publicUploadToken } from '../src/modules/artifacts/multipart-service';
import { createMultipartSweepHook, multipartLimitsFromEnv, route, type RouteContext } from '../src/server';

/**
 * DATA-02 multipart routes (Qwen-5) — offline wire tests, zero DB/Redis.
 * The real router and the real runtime authorization helpers run; only the
 * multipart service behind them is faked, so what is proven here is the HTTP
 * contract: paths, methods, status codes, grant-URL absolutization and that a
 * service failure reaches the boundary unchanged.
 */

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ARTIFACT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const PLATFORM_AUTH = 'Bearer platform-runtime-token';
const WORKER_A_AUTH = 'Bearer worker-a-registration-token';
const WORKER_B_AUTH = 'Bearer worker-b-registration-token';

const CONFIG = {
  runtimeToken: 'platform-runtime-token',
  adminToken: 'platform-admin-token',
  usageToken: 'connector-usage-token',
  workerIdentityTokensByBusiness: {
    'business-a': 'worker-a-registration-token',
    'business-b': 'worker-b-registration-token',
  },
};

const INIT_ACK = MultipartInitAckSchema.parse({
  artifactId: ARTIFACT_ID,
  uploadHandle: 'mh_deadbeefcafe0001',
  partSizeBytes: 8 * 1024 * 1024,
  partCount: 9,
  expiresAt: '2026-09-26T00:00:00.000Z',
});

function multipartService() {
  return {
    init: jest.fn(async () => INIT_ACK),
    grantPart: jest.fn(async () => MultipartPartGrantSchema.parse({
      artifactId: ARTIFACT_ID,
      partNumber: 1,
      partUrl: 'https://storage.test/signed-part?sig=opaque',
      sizeBytes: 8 * 1024 * 1024,
      requiredHeaders: { 'content-length': '8388608' },
      expiresAt: '2026-09-25T00:15:00.000Z',
    })),
    complete: jest.fn(async () => MultipartCompleteAckSchema.parse({
      artifactId: ARTIFACT_ID,
      sizeBytes: 70 * 1024 * 1024,
      sha256: 'c'.repeat(64),
      committed: true,
    })),
    abort: jest.fn(async () => MultipartAbortAckSchema.parse({ artifactId: ARTIFACT_ID, state: 'ABORTED' })),
    sweepExpiredSessions: jest.fn(async () => ({ scanned: 0, aborted: 0, purged: 0, failed: 0 })),
    publicInit: jest.fn(async (_tenantId: string, _body: unknown) => INIT_ACK),
    publicGrantPart: jest.fn(async (_artifactId: string, _tenantId: string, _body: unknown) => MultipartPartGrantSchema.parse({
      artifactId: ARTIFACT_ID,
      partNumber: 1,
      partUrl: 'https://storage.test/signed-part?sig=opaque',
      sizeBytes: 8 * 1024 * 1024,
      requiredHeaders: { 'content-length': '8388608' },
      expiresAt: '2026-09-25T00:15:00.000Z',
    })),
    publicComplete: jest.fn(async (_artifactId: string, _tenantId: string, _body: unknown) => MultipartCompleteAckSchema.parse({
      artifactId: ARTIFACT_ID,
      sizeBytes: 70 * 1024 * 1024,
      sha256: 'c'.repeat(64),
      committed: true,
    })),
    publicAbort: jest.fn(async (_artifactId: string, _tenantId: string, _body: unknown) => MultipartAbortAckSchema.parse({ artifactId: ARTIFACT_ID, state: 'ABORTED' })),
  };
}

function context(options: {
  method?: string;
  pathname?: string;
  authorization?: string;
  noAuthorization?: boolean;
  body?: unknown;
  service?: ReturnType<typeof multipartService>;
  taskBusinessId?: string;
  host?: string;
} = {}): RouteContext {
  const db = {
    query: jest.fn(async () => ({
      rowCount: 1,
      rows: [{ business_id: options.taskBusinessId ?? 'business-a' }],
      // assertTaskRuntimeAuth and assertArtifactRuntimeAuth share this shape.
    })),
  } as unknown as Db;
  return {
    method: options.method ?? 'POST',
    pathname: options.pathname ?? '/api/runtime/v1/tasks/' + TASK_ID + '/artifacts/multipart',
    searchParams: new URLSearchParams(),
    headers: options.noAuthorization ? {} : { authorization: options.authorization ?? PLATFORM_AUTH },
    body: options.body ?? { leaseEpoch: 3, uploadToken: 'dddddddd-0000-4000-8000-000000000004' },
    rawBody: Buffer.alloc(0),
    correlationId: 'data02-multipart-routes-offline',
    host: options.host ?? 'orchestrator.test',
    db,
    artifacts: {
      requestUpload: jest.fn(async () => ({ artifactId: ARTIFACT_ID, uploadUrl: '/api/runtime/v1/artifacts/blob/x?grant=y', expiresAt: 'later' })),
      finalize: jest.fn(async () => ({ artifactId: ARTIFACT_ID, state: 'READY' })),
      requestAccess: jest.fn(async () => ({ artifactId: ARTIFACT_ID, expiresAt: 'later' })),
      putBlob: jest.fn(async () => undefined),
      getBlob: jest.fn(async () => Buffer.alloc(0)),
    } as never,
    multipart: (options.service ?? multipartService()) as unknown as MultipartService,
    config: CONFIG,
  } as unknown as RouteContext;
}

function artifactContext(options: {
  pathname: string;
  method?: string;
  body?: unknown;
  service?: ReturnType<typeof multipartService>;
  authorization?: string;
  artifactDb?: Db;
}): RouteContext {
  const ctx = context({
    pathname: options.pathname,
    method: options.method,
    body: options.body,
    service: options.service,
    authorization: options.authorization,
  });
  return { ...ctx, db: options.artifactDb ?? ctx.db };
}

function artifactLookup(businessId: string): Db {
  return {
    query: jest.fn(async () => ({
      rowCount: 1,
      rows: [{ business_id: businessId }],
    })),
  } as unknown as Db;
}

const PART_BODY = { leaseEpoch: 3, partNumber: 1, sha256: 'a'.repeat(64) };
const COMPLETE_BODY = { leaseEpoch: 3, parts: [{ partNumber: 1, etag: '"1"', sizeBytes: 8 * 1024 * 1024, sha256: 'a'.repeat(64) }], sha256: 'c'.repeat(64) };
const ABORT_BODY = { leaseEpoch: 3, reason: 'cancelled' };

describe('POST /api/runtime/v1/tasks/:id/artifacts/multipart', () => {
  test('answers 201 with the init ack and forwards the path task', async () => {
    const service = multipartService();
    const ctx = context({ service });
    const result = await route(ctx);
    expect(result.status).toBe(201);
    expect(MultipartInitAckSchema.parse(result.body)).toEqual(INIT_ACK);
    expect(service.init).toHaveBeenCalledWith(TASK_ID, ctx.body);
  });

  test('answers 200 when the token replayed an existing upload', async () => {
    const service = multipartService();
    service.init.mockResolvedValue({ ...INIT_ACK, replayed: true });
    const result = await route({ ...context({ service }) });
    expect(result.status).toBe(200);
    expect((result.body as { replayed: boolean }).replayed).toBe(true);
  });

  test('requires a runtime bearer', async () => {
    await expect(route(context({ noAuthorization: true }))).rejects.toMatchObject({
      status: 401, code: 'UNAUTHENTICATED',
    });
    await expect(route(context({ authorization: 'Bearer not-a-runtime-token' }))).rejects.toMatchObject({
      status: 401, code: 'UNAUTHENTICATED',
    });
  });

  test('refuses a worker whose business does not own the task', async () => {
    const service = multipartService();
    const ctx = context({ service, authorization: WORKER_B_AUTH, taskBusinessId: 'business-a' });
    await expect(route(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(service.init).not.toHaveBeenCalled();
  });

  test('accepts the owning worker identity', async () => {
    const service = multipartService();
    const ctx = context({ service, authorization: WORKER_A_AUTH, taskBusinessId: 'business-a' });
    await expect(route(ctx)).resolves.toMatchObject({ status: 201 });
    expect(service.init).toHaveBeenCalled();
  });

  test('leaves a service conflict untouched for the problem envelope', async () => {
    const service = multipartService();
    service.init.mockRejectedValue(new HttpError(409, 'LEASE_LOST', 'producer lease epoch is stale'));
    await expect(route(context({ service }))).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
  });
});

describe('POST /api/runtime/v1/artifacts/:id/multipart/{part,complete,abort}', () => {
  test('grants one part and absolutizes a relative storage URL', async () => {
    const service = multipartService();
    service.grantPart.mockResolvedValue({
      artifactId: ARTIFACT_ID, partNumber: 1, partUrl: '/api/storage/part?grant=opaque',
      sizeBytes: 8 * 1024 * 1024, requiredHeaders: {}, expiresAt: '2026-09-25T00:15:00.000Z',
    });
    const result = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/part-grant',
      body: PART_BODY, service, artifactDb: artifactLookup('business-a'),
    }));
    expect(result.status).toBe(200);
    expect(MultipartPartGrantSchema.parse(result.body).partUrl)
      .toBe('http://orchestrator.test/api/storage/part?grant=opaque');
    expect(service.grantPart).toHaveBeenCalledWith(ARTIFACT_ID, PART_BODY);
  });

  test('passes a presigned provider URL through unchanged', async () => {
    const service = multipartService();
    const result = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/part',
      body: PART_BODY, service, artifactDb: artifactLookup('business-a'),
    }));
    expect(MultipartPartGrantSchema.parse(result.body).partUrl).toBe('https://storage.test/signed-part?sig=opaque');
  });

  test('completes and aborts answer 200 with the contract ack', async () => {
    const service = multipartService();
    const completed = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/complete',
      body: COMPLETE_BODY, service, artifactDb: artifactLookup('business-a'),
    }));
    expect(completed.status).toBe(200);
    expect(MultipartCompleteAckSchema.parse(completed.body).committed).toBe(true);

    const aborted = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/abort',
      body: ABORT_BODY, service, artifactDb: artifactLookup('business-a'),
    }));
    expect(aborted.status).toBe(200);
    expect(MultipartAbortAckSchema.parse(aborted.body).state).toBe('ABORTED');
    expect(service.abort).toHaveBeenCalledWith(ARTIFACT_ID, ABORT_BODY);
  });

  test('authorizes the artifact owner before reaching the service', async () => {
    const service = multipartService();
    const ctx = artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/complete',
      body: COMPLETE_BODY, service, authorization: WORKER_B_AUTH, artifactDb: artifactLookup('business-a'),
    });
    await expect(route(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(service.complete).not.toHaveBeenCalled();
  });

  test('answers 404 for an artifact the runtime does not know', async () => {
    const service = multipartService();
    const missing = {
      query: jest.fn(async () => ({ rowCount: 0, rows: [] })),
    } as unknown as Db;
    await expect(route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/abort',
      body: ABORT_BODY, service, authorization: WORKER_A_AUTH, artifactDb: missing,
    }))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(service.abort).not.toHaveBeenCalled();
  });

  test('does not match other methods or unknown lifecycle segments', async () => {
    const service = multipartService();
    const get = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/part',
      method: 'GET', service, artifactDb: artifactLookup('business-a'),
    }));
    expect(get.status).toBe(404);
    const unknown = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/multipart/parts',
      service, artifactDb: artifactLookup('business-a'),
    }));
    expect(unknown.status).toBe(404);
    expect(service.grantPart).not.toHaveBeenCalled();
  });

  test('keeps the single-PUT grant and finalize routes unchanged', async () => {
    const service = multipartService();
    const finalize = await route(artifactContext({
      pathname: '/api/runtime/v1/artifacts/' + ARTIFACT_ID + '/finalize',
      body: { taskId: TASK_ID, leaseEpoch: 3, sizeBytes: 10, sha256: 'd'.repeat(64) },
      service,
      artifactDb: artifactLookup('business-a'),
    }));
    expect(finalize.status).toBe(200);
    expect(service.complete).not.toHaveBeenCalled();
  });
});
/* ------------------------------------------------------------------ */
/* DATA-02 public branch routes (W-DATA02-PUB-1)                       */
/* ------------------------------------------------------------------ */

const PUBLIC_TENANT = '73000000-0000-4000-8000-0000000000a1';
const API_KEY_ID = '74000000-0000-4000-8000-0000000000a2';
const PUBLIC_INIT_BODY = {
  uploadToken: 'dddddddd-0000-4000-8000-00000000000d',
  mimeType: 'application/pdf',
  sizeBytes: 70 * 1024 * 1024,
};
const PUBLIC_PART_BODY = { partNumber: 1, sha256: 'a'.repeat(64) };
const PUBLIC_COMPLETE_BODY = {
  parts: [{ partNumber: 1, etag: '"1"', sizeBytes: 8 * 1024 * 1024, sha256: 'a'.repeat(64) }],
  sha256: 'c'.repeat(64),
};
const ENCRYPTED_UPLOAD_ACK = {
  artifactId: ARTIFACT_ID,
  state: 'READY' as const,
  sizeBytes: 70 * 1024 * 1024,
  sha256: 'e'.repeat(64),
  ciphertextSizeBytes: 70 * 1024 * 1024,
  ciphertextSha256: 'e'.repeat(64),
  plaintextSha256: 'f'.repeat(64),
  storageVersionId: 's3-version-1',
  manifestKey: 'art-' + ARTIFACT_ID + '.crypto-manifest.json',
  replayed: false,
};

function publicUploadGateway() {
  return {
    initSingle: jest.fn(async () => ({
      artifactId: ARTIFACT_ID,
      uploadHandle: 'gateway-test-handle',
      partSizeBytes: 8 * 1024 * 1024,
      partCount: 1 as const,
      expiresAt: '2026-09-26T00:00:00.000Z',
      replayed: false,
    })),
    upload: jest.fn(async () => ENCRYPTED_UPLOAD_ACK),
    completeReplay: jest.fn(async () => ({ ...ENCRYPTED_UPLOAD_ACK, replayed: true })),
  };
}

function publicContext(options: {
  pathname?: string;
  method?: string;
  body?: unknown;
  apiKey?: string | null;
  idempotencyKey?: string;
  authorization?: string;
  validKey?: boolean;
  service?: ReturnType<typeof multipartService>;
  gateway?: ReturnType<typeof publicUploadGateway> | null;
  bodyStream?: AsyncIterable<Uint8Array>;
} = {}): {
  ctx: RouteContext;
  service: ReturnType<typeof multipartService>;
  gateway: ReturnType<typeof publicUploadGateway> | null;
} {
  const service = options.service ?? multipartService();
  const gateway = options.gateway === undefined ? publicUploadGateway() : options.gateway;
  const headers: Record<string, string> = {};
  if (options.apiKey !== null) headers['x-api-key'] = options.apiKey ?? 'tenant-secret-key';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.authorization) headers.authorization = options.authorization;
  const db = {
    query: jest.fn(async (sql: string) => (
      String(sql).includes('FROM api_keys') && options.validKey !== false
        ? { rowCount: 1, rows: [{ id: API_KEY_ID, tenant_id: PUBLIC_TENANT }] }
        : { rowCount: 0, rows: [] }
    )),
  } as unknown as Db;
  const ctx = {
    method: options.method ?? 'POST',
    pathname: options.pathname ?? '/api/v1/uploads',
    searchParams: new URLSearchParams(),
    headers,
    body: options.body ?? PUBLIC_INIT_BODY,
    rawBody: Buffer.alloc(0),
    ...(options.bodyStream ? { bodyStream: options.bodyStream } : {}),
    correlationId: 'data02-public-routes-offline',
    host: 'orchestrator.test',
    db,
    multipart: service as unknown as MultipartService,
    publicUploadGateway: gateway,
    config: CONFIG,
  } as unknown as RouteContext;
  return { ctx, service, gateway };
}

describe('POST /api/v1/uploads (public init)', () => {
  test('answers 201 and forwards the api key tenant', async () => {
    const { ctx, service } = publicContext();
    const result = await route(ctx);
    expect(result.status).toBe(201);
    expect(MultipartInitAckSchema.parse(result.body)).toEqual(INIT_ACK);
    expect(service.publicInit).toHaveBeenCalledWith(PUBLIC_TENANT, PUBLIC_INIT_BODY);
  });

  test('derives the replay key from Idempotency-Key when the body omits uploadToken', async () => {
    const { ctx, service } = publicContext({
      body: { mimeType: 'application/pdf', sizeBytes: 70 * 1024 * 1024 },
      idempotencyKey: 'loss-retry-1',
    });
    await route(ctx);
    const forwarded = service.publicInit.mock.calls[0]![1] as { uploadToken: string };
    expect(forwarded.uploadToken).toBe(publicUploadToken(PUBLIC_TENANT, 'loss-retry-1'));
  });

  test('a body uploadToken wins over the Idempotency-Key header', async () => {
    const { ctx, service } = publicContext({ idempotencyKey: 'ignored', body: PUBLIC_INIT_BODY });
    await route(ctx);
    expect(service.publicInit).toHaveBeenCalledWith(PUBLIC_TENANT, PUBLIC_INIT_BODY);
  });

  test('answers 200 on a replayed init', async () => {
    const { ctx, service } = publicContext();
    service.publicInit.mockResolvedValue({ ...INIT_ACK, replayed: true });
    const result = await route(ctx);
    expect(result.status).toBe(200);
    expect((result.body as { replayed: boolean }).replayed).toBe(true);
  });

  test('initializes a small single-PUT session in the gateway and returns only the app upload URL', async () => {
    const body = { uploadToken: PUBLIC_INIT_BODY.uploadToken, mimeType: 'text/plain', sizeBytes: 1024 };
    const { ctx, service, gateway } = publicContext({ body });
    const result = await route(ctx);
    expect(result.status).toBe(201);
    expect((result.body as { uploadUrl: string }).uploadUrl)
      .toBe('/api/v1/uploads/' + ARTIFACT_ID + '/content');
    expect(gateway?.initSingle).toHaveBeenCalledWith(PUBLIC_TENANT, body);
    expect(service.publicInit).not.toHaveBeenCalled();
  });

  test('fails closed before creating a staging session when encryption is not configured', async () => {
    const { ctx, service } = publicContext({ gateway: null });
    await expect(route(ctx)).rejects.toMatchObject({ status: 503, code: 'TEMPORARY_UNAVAILABLE' });
    expect(service.publicInit).not.toHaveBeenCalled();
  });

  test('requires an active tenant api key', async () => {
    await expect(route(publicContext({ apiKey: null }).ctx)).rejects.toMatchObject({
      status: 401, code: 'UNAUTHENTICATED',
    });
    const { ctx, service } = publicContext({ validKey: false });
    await expect(route(ctx)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(service.publicInit).not.toHaveBeenCalled();
  });

  test('worker credentials cannot reach the public surface', async () => {
    const { ctx, service } = publicContext({ authorization: WORKER_A_AUTH });
    await expect(route(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(service.publicInit).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/uploads/:id/{part,complete,abort}', () => {
  test('fails closed instead of granting direct S3 upload parts', async () => {
    const { ctx, service } = publicContext({
      pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/part',
      body: PUBLIC_PART_BODY,
    });
    await expect(route(ctx)).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(service.publicGrantPart).not.toHaveBeenCalled();
  });

  test('complete and abort answer 200 with the contract ack', async () => {
    const done = publicContext({ pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/complete', body: PUBLIC_COMPLETE_BODY });
    const completed = await route(done.ctx);
    expect(completed.status).toBe(200);
    expect((completed.body as { replayed: boolean }).replayed).toBe(true);
    expect(done.gateway?.completeReplay).toHaveBeenCalledWith(ARTIFACT_ID, PUBLIC_TENANT, PUBLIC_COMPLETE_BODY);
    expect(done.service.publicComplete).not.toHaveBeenCalled();

    const aborted = await route(publicContext({ pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/abort', body: {} }).ctx);
    expect(aborted.status).toBe(200);
    expect(MultipartAbortAckSchema.parse(aborted.body).state).toBe('ABORTED');
  });

  test('service conflicts reach the problem envelope untouched', async () => {
    const { ctx, gateway } = publicContext({ pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/complete', body: PUBLIC_COMPLETE_BODY });
    gateway!.completeReplay.mockRejectedValue(new HttpError(409, 'STATE_CONFLICT', 'encrypted upload checksum differs'));
    await expect(route(ctx)).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
  });

  test('PUT streams bytes through the gateway with tenant and integrity headers', async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('secret');
    }
    const bodyStream = source();
    const { ctx, gateway } = publicContext({
      method: 'PUT',
      pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/content',
      body: undefined,
      bodyStream,
    });
    ctx.headers['content-length'] = '6';
    ctx.headers['x-content-sha256'] = 'f'.repeat(64);
    const result = await route(ctx);
    expect(result.status).toBe(201);
    expect(gateway?.upload).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      tenantId: PUBLIC_TENANT,
      source: bodyStream,
      contentLength: '6',
      plaintextSha256: 'f'.repeat(64),
    });
  });

  test('no public finalize route exists - the verified complete IS the READY edge', async () => {
    const { ctx, service } = publicContext({ pathname: '/api/v1/uploads/' + ARTIFACT_ID + '/finalize', body: {} });
    const result = await route(ctx);
    expect(result.status).toBe(404);
    expect(service.publicComplete).not.toHaveBeenCalled();
  });
});

describe('createMultipartSweepHook (recovery-timer wiring)', () => {
  test('a deployment without a multipart backend never calls the lifecycle', async () => {
    const service = multipartService();
    const hook = createMultipartSweepHook(service as unknown as MultipartService, false);
    await expect(hook()).resolves.toBeUndefined();
    expect(service.sweepExpiredSessions).not.toHaveBeenCalled();
  });

  test('enabled: runs the sweep and returns its summary', async () => {
    const service = multipartService();
    const hook = createMultipartSweepHook(service as unknown as MultipartService, true);
    await expect(hook()).resolves.toEqual({ scanned: 0, aborted: 0, purged: 0, failed: 0 });
    expect(service.sweepExpiredSessions).toHaveBeenCalledTimes(1);
  });

  test('single-flight: a running sweep is shared, not stacked, and re-arms after settle', async () => {
    let calls = 0;
    let release: (value: { scanned: number; aborted: number; purged: number; failed: number }) => void = () => undefined;
    const service = multipartService();
    const slowSweep = () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ scanned: 0, aborted: 0, purged: 0, failed: 0 });
    };
    Object.assign(service, { sweepExpiredSessions: jest.fn(slowSweep) });
    const hook = createMultipartSweepHook(service as unknown as MultipartService, true);
    const first = hook();
    const second = hook();
    expect(calls).toBe(1); // the second tick joined the running sweep
    release({ scanned: 2, aborted: 1, purged: 1, failed: 0 });
    await expect(first).resolves.toEqual({ scanned: 2, aborted: 1, purged: 1, failed: 0 });
    await expect(second).resolves.toEqual({ scanned: 2, aborted: 1, purged: 1, failed: 0 });
    await hook();
    expect(calls).toBe(2); // slot cleared after settle: the next tick sweeps again
  });

  test('storage failures are swallowed and the next tick retries', async () => {
    const service = multipartService();
    service.sweepExpiredSessions.mockRejectedValueOnce(new Error('provider unreachable'));
    const hook = createMultipartSweepHook(service as unknown as MultipartService, true);
    await expect(hook()).resolves.toBeUndefined();
    await expect(hook()).resolves.toMatchObject({ scanned: 0 });
  });
});

describe('multipartLimitsFromEnv (signed §6 env naming)', () => {
  test('absent env keeps the wire defaults', () => {
    expect(multipartLimitsFromEnv({})).toBeUndefined();
    expect(multipartLimitsFromEnv({ MULTIPART_PART_URL_TTL_MS: '' })).toBeUndefined();
  });

  test('set env is passed through for the service to narrow', () => {
    expect(multipartLimitsFromEnv({ MULTIPART_MAX_TOTAL_BYTES: '7000000000', MULTIPART_SESSION_TTL_MS: '3600000' }))
      .toEqual({
        partSizeBytes: undefined,
        maxTotalBytes: 7_000_000_000,
        sessionTtlMs: 3_600_000,
        partUrlTtlMs: undefined,
      });
  });

  test('a non-positive or unparseable value fails boot loudly', () => {
    expect(() => multipartLimitsFromEnv({ MULTIPART_PART_SIZE_BYTES: '0' })).toThrow(/positive integer/);
    expect(() => multipartLimitsFromEnv({ MULTIPART_PART_SIZE_BYTES: 'eight-mebibytes' })).toThrow(/positive integer/);
  });
});
