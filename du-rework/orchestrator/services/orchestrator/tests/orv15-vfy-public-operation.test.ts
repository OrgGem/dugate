import { createHash } from 'node:crypto';
import { handlePublicRoutes } from '../src/http/routes/public';
import type { RouteContext } from '../src/http/route-context';

const API_KEY = 'orv15-vfy-public-read-key';
const KEY_ID = 'key-public-read';
const TENANT_ID = 'tenant-public-read';
const OPERATION_ID = 'operation-public-read';
const OUTPUT = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);

function readyOperation() {
  return {
    id: OPERATION_ID,
    tenant_id: TENANT_ID,
    api_key_id: KEY_ID,
    state: 'SUCCEEDED',
    deleted_at: null,
    business_id: 'legacy-test-business',
    pipeline_json: '[{"processor":"legacy-test"}]',
    steps_result_json: '[]',
    current_step: 1,
    progress_percent: 100,
    progress_message: 'Complete',
    created_at: '2026-10-12T05:00:00.000Z',
    updated_at: '2026-10-12T05:01:00.000Z',
    output_format: 'md',
    output_content: null,
    output_file_path: 'tenant-public-read/result.bin',
    extracted_data: null,
    total_input_tokens: 4,
    total_output_tokens: 7,
    pages_processed: 1,
    model_used: 'test-model',
    total_cost_usd: 0.00001,
    usage_breakdown: '[]',
    error_code: null,
    error_message: null,
    failed_at_step: null,
    endpoint_slug: 'extract:test',
  };
}

function publicContext(pathname: string, overrides: Partial<RouteContext> = {}) {
  const keyHash = createHash('sha256').update(API_KEY).digest('hex');
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FROM api_keys')) {
        if (params[0] === keyHash && params[1] === 'ACTIVE') {
          return { rows: [{ id: KEY_ID, tenant_id: TENANT_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM operations') && sql.includes('deleted_at IS NULL')) {
        if (params[0] !== OPERATION_ID || params[1] !== TENANT_ID || params[2] !== KEY_ID) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [readyOperation()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const blobReads: string[] = [];
  const context = {
    ingressAudience: 'public',
    method: 'GET',
    pathname,
    searchParams: new URLSearchParams(),
    headers: { 'x-api-key': API_KEY },
    body: undefined,
    correlationId: 'orv15-vfy-public-read',
    config: {},
    db,
    artifacts: {
      async getBlob(storageKey: string) {
        blobReads.push(storageKey);
        return (async function* () { yield OUTPUT.subarray(0, 2); yield OUTPUT.subarray(2); })();
      },
    },
    ...overrides,
  } as unknown as RouteContext;
  return { context, queries, blobReads };
}

async function collect(raw: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(raw)) return raw;
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('ORV15 public legacy operation read compatibility', () => {
  test('GET by operation ID resolves an active key and returns its tenant-scoped legacy envelope', async () => {
    const h = publicContext(`/api/v1/operations/${OPERATION_ID}`);

    const response = await handlePublicRoutes(h.context);

    expect(response).toMatchObject({
      status: 200,
      body: {
        name: `operations/${OPERATION_ID}`,
        done: true,
        metadata: {
          state: 'SUCCEEDED',
          pipeline: ['legacy-test'],
          pipeline_steps: [],
          progress_percent: 100,
        },
      },
    });
    expect(h.queries[0]).toEqual({
      sql: 'SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2',
      params: [createHash('sha256').update(API_KEY).digest('hex'), 'ACTIVE'],
    });
    expect(h.queries[1]?.sql).toContain('WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND api_key_id = $3');
    expect(h.queries[1]?.params).toEqual([OPERATION_ID, TENANT_ID, KEY_ID]);
    expect((response?.body as Record<string, unknown>).metadata).not.toHaveProperty('canonical_state');
    expect(h.blobReads).toEqual([]);
  });

  test('GET download streams the exact legacy bytes only after the same tenant/key-scoped operation read', async () => {
    const h = publicContext(`/api/v1/operations/${OPERATION_ID}/download`);

    const response = await handlePublicRoutes(h.context);

    expect(response?.status).toBe(200);
    expect(response?.headers).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': String(OUTPUT.length),
      'content-disposition': `attachment; filename="result.bin"; filename*=UTF-8''result.bin`,
    });
    expect(await collect(response?.raw)).toEqual(OUTPUT);
    expect(h.queries[1]?.params).toEqual([OPERATION_ID, TENANT_ID, KEY_ID]);
    expect(h.blobReads).toEqual(['tenant-public-read/result.bin']);
  });

  test.each([
    ['POST', `/api/v1/operations/${OPERATION_ID}`, 405],
    ['GET', `/api/v1/operations/${OPERATION_ID}/cancel`, 405],
    ['GET', '/api/v1/operations/metrics', 404],
  ] as const)('%s %s preserves its public route status without reading an operation', async (method, pathname, status) => {
    const h = publicContext(pathname, { method } as Partial<RouteContext>);

    if (status === 404) {
      await expect(handlePublicRoutes(h.context)).rejects.toMatchObject({ status });
    } else {
      await expect(handlePublicRoutes(h.context)).resolves.toMatchObject({ status });
    }
    expect(h.queries).toEqual([]);
  });

  test('an inactive or unknown key cannot load an otherwise existing operation', async () => {
    const h = publicContext(`/api/v1/operations/${OPERATION_ID}`, {
      headers: { 'x-api-key': 'revoked-key' },
    } as Partial<RouteContext>);

    const response = await handlePublicRoutes(h.context);
    expect(response).toMatchObject({
      status: 401,
      body: { title: 'Unauthorized', status: 401 },
    });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.params).toEqual([
      createHash('sha256').update('revoked-key').digest('hex'),
      'ACTIVE',
    ]);
  });
});
