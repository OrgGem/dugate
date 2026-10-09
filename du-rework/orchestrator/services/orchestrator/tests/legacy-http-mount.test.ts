import { handleLegacyRoute, legacyError, type LegacyCompatHost, type LegacyRouteRequest } from '../src/compat/legacy-http-mount';
import { toLegacyRow } from '../src/compat/legacy-host-adapter';

const T = '2026-10-02T03:00:00.000Z';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'op-1', tenant_id: 't-1', state: 'SUCCEEDED', deleted_at: null,
    pipeline_json: '[{"processor":"ext-invoice"}]',
    steps_result_json: '[{"step":1}]',
    current_step: 2, progress_percent: 100, progress_message: null,
    created_at: T, updated_at: T, output_format: 'md', output_content: '# hi',
    total_input_tokens: '10', total_output_tokens: '20', pages_processed: '3',
    model_used: 'gpt-x', total_cost_usd: '0.5', usage_breakdown: '[]',
    error_code: null, error_message: null, failed_at_step: null, endpoint_slug: 'extract:invoice',
    ...overrides,
  };
}

function host(overrides: Partial<LegacyCompatHost> = {}): LegacyCompatHost {
  return {
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    loadOperation: async (id) => toLegacyRow(row({ id })),
    loadOutputContent: async () => Buffer.from('# hi', 'utf8'),
    ...overrides,
  };
}

function req(overrides: Partial<LegacyRouteRequest> = {}): LegacyRouteRequest {
  return {
    method: 'GET',
    pathname: '/api/v1/operations/op-1',
    searchParams: new URLSearchParams(),
    headers: {},
    resolvePrincipal: async () => ({ tenantId: 't-1', apiKeyId: 'k-1' }),
    ...overrides,
  };
}

function multipart(action: string, fields: [string, string][], files: [string, string][] = []): {
  headers: Record<string, string>;
  bodyStream: AsyncIterable<Buffer>;
} {
  const B = 'Lg9';
  const parts: string[] = [];
  for (const [k, v] of fields) {
    parts.push(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  }
  for (const [k, v] of files) {
    parts.push(`--${B}\r\nContent-Disposition: form-data; name="${k}"; filename="${k}.pdf"\r\n\r\n${v}`);
  }
  const raw = parts.map((p) => `${p}\r\n`).join('') + `--${B}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${B}` },
    bodyStream: (async function* () { yield Buffer.from(raw, 'latin1'); })(),
  };
}

describe('legacy mount — path ownership', () => {
  it('returns null for a canonical path so the route table still owns it', async () => {
    expect(await handleLegacyRoute(req({ pathname: '/api/v1/businesses/x/actions/y' }), host())).toBeNull();
    expect(await handleLegacyRoute(req({ pathname: '/api/v1/admin/audit' }), host())).toBeNull();
    expect(await handleLegacyRoute(req({ pathname: '/api/runtime/v1/tasks/claim', method: 'POST' }), host())).toBeNull();
  });

  it('returns null for an unknown docs slug rather than a compat 404', async () => {
    expect(await handleLegacyRoute(req({ pathname: '/api/v1/docs/nope' }), host())).toBeNull();
  });

  it('claims all six core action paths', async () => {
    for (const action of ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare']) {
      const r = await handleLegacyRoute(
        req({ method: 'POST', pathname: `/api/v1/docs/${action}` }),
        host(),
      );
      expect(r).not.toBeNull();
    }
  });
});

describe('legacy mount — submit wire', () => {
  it('answers 202 with Operation-Location for an async submit', async () => {
    const mp = multipart('extract', [['type', 'invoice']], [['file', 'PDF']]);
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/extract',
        headers: mp.headers,
        bodyStream: mp.bodyStream,
      }),
      host({
        submitLegacy: async () => ({ operationId: 'op-1', replayed: false }),
      }),
    );
    expect(r?.status).toBe(202);
    expect(r?.headers['Operation-Location']).toBe('/api/v1/operations/op-1');
    expect((r?.body as { name: string }).name).toBe('operations/op-1');
  });

  it('answers 200 with no header when sync=true, even mid-flight', async () => {
    const mp = multipart('extract', [['type', 'invoice']], [['file', 'PDF']]);
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/extract',
        headers: mp.headers,
        bodyStream: mp.bodyStream,
        searchParams: new URLSearchParams('sync=true'),
      }),
      host({
        submitLegacy: async () => ({ operationId: 'op-1', replayed: false }),
        loadOperation: async (id) => toLegacyRow(row({ id, state: 'RUNNING' })),
      }),
    );
    expect(r?.status).toBe(200);
    expect(r?.headers['Operation-Location']).toBeUndefined();
    expect((r?.body as { done: boolean }).done).toBe(false);
  });

  it('answers 200 on an idempotent replay', async () => {
    const mp = multipart('extract', [['type', 'invoice']], [['file', 'PDF']]);
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/extract', headers: mp.headers, bodyStream: mp.bodyStream }),
      host({ submitLegacy: async () => ({ operationId: 'op-1', replayed: true }) }),
    );
    expect(r?.status).toBe(200);
  });

  it('rejects an unknown discriminator with a legacy 400 body', async () => {
    const mp = multipart('extract', [['type', 'not-real']], [['file', 'PDF']]);
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/extract', headers: mp.headers, bodyStream: mp.bodyStream }),
      host({ submitLegacy: async () => ({ operationId: 'op-1', replayed: false }) }),
    );
    expect(r?.status).toBe(400);
    expect(r?.body).toMatchObject({ title: 'Invalid Parameter', status: 400 });
    expect((r?.body as { type: string }).type).toBe('https://dugate.vn/errors/invalid-parameter');
  });

  it('submits named workflows with the old 202 envelope and ignores sync/idempotency options', async () => {
    const mp = multipart('', [['process', ' disbursement '], ['resolution_data', '{"account":"A"}']], [['files[]', 'PDF']]);
    let received: unknown;
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/workflows',
        headers: { ...mp.headers, 'idempotency-key': 'ignored' },
        bodyStream: mp.bodyStream,
        searchParams: new URLSearchParams('sync=true'),
      }),
      host({ submitLegacyWorkflow: async (_principal, decoded) => {
        received = decoded;
        return { operationId: 'workflow-op' };
      } }),
    );
    expect(r).toMatchObject({
      status: 202,
      headers: { 'Operation-Location': '/api/v1/operations/workflow-op' },
      body: {
        name: 'operations/workflow-op',
        done: false,
        metadata: {
          state: 'RUNNING',
          workflow: 'disbursement',
          progress_percent: 0,
          progress_message: 'Initializing workflow...',
        },
      },
    });
    expect(received).toMatchObject({
      kind: 'named',
      process: 'disbursement',
      variables: { resolution_data: '{"account":"A"}' },
    });
  });

  it('resolves and pins a tenant schema before admitting input-only schemas', async () => {
    const mp = multipart('', [['schemaSlug', ' invoice-v2 '], ['input', '{"account":"A"}']]);
    const pin = {
      tenantId: 't-1', slug: 'invoice-v2', revision: 3, digest: `sha256:${'a'.repeat(64)}`,
      schema: { nodes: [], flow: [], output: null },
    } as never;
    let resolvedTenant = '';
    let receivedPin: unknown;
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/workflows/schema',
        headers: mp.headers,
        bodyStream: mp.bodyStream,
      }),
      host({
        resolveLegacyWorkflowSchema: async (tenantId, slug) => {
          resolvedTenant = `${tenantId}:${slug}`;
          return pin;
        },
        submitLegacyWorkflow: async (_principal, decoded, admittedPin) => {
          receivedPin = admittedPin;
          expect(decoded).toMatchObject({ kind: 'schema', schemaSlug: 'invoice-v2', input: { account: 'A' }, files: [] });
          return { operationId: 'schema-op' };
        },
      }),
    );
    expect(resolvedTenant).toBe('t-1:invoice-v2');
    expect(receivedPin).toBe(pin);
    expect(r).toMatchObject({
      status: 202,
      headers: { 'Operation-Location': '/api/v1/operations/schema-op' },
      body: { name: 'operations/schema-op', done: false, metadata: { workflow: 'invoice-v2', progress_message: 'Initializing schema workflow...' } },
    });
  });

  it('rejects non-object schema input before submission even when the slug resolves', async () => {
    const mp = multipart('', [['schemaSlug', 'invoice-v2'], ['input', '[]']]);
    let submitted = false;
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/workflows/schema',
        headers: mp.headers,
        bodyStream: mp.bodyStream,
      }),
      host({
        resolveLegacyWorkflowSchema: async () => ({
          tenantId: 't-1', slug: 'invoice-v2', revision: 1, digest: `sha256:${'a'.repeat(64)}`,
          schema: { slug: 'invoice-v2', name: 'Invoice', nodes: [{ id: 'n', type: 'input', key: 'x' }], flow: ['n'] },
        } as never),
        submitLegacyWorkflow: async () => { submitted = true; return { operationId: 'never' }; },
      }),
    );
    expect(r?.status).toBe(400);
    expect(submitted).toBe(false);
  });

  it('rejects a body apiKeyId that differs from the authenticated key', async () => {
    const mp = multipart('', [['process', 'doc-compare'], ['apiKeyId', 'another-principal']], [['file', 'PDF']]);
    let submitted = false;
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/workflows', headers: { ...mp.headers, 'x-api-key': 'presented-key' }, bodyStream: mp.bodyStream }),
      host({ submitLegacyWorkflow: async () => { submitted = true; return { operationId: 'never' }; } }),
    );
    expect(r?.status).toBe(403);
    expect(submitted).toBe(false);
  });

  it('keeps legacy one-file doc-compare admission asynchronous', async () => {
    const mp = multipart('', [['process', 'doc-compare']], [['file', 'only one document']]);
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/workflows', headers: mp.headers, bodyStream: mp.bodyStream }),
      host({ submitLegacyWorkflow: async () => ({ operationId: 'compare-op' }) }),
    );
    expect(r?.status).toBe(202);
    expect(r?.headers['Operation-Location']).toBe('/api/v1/operations/compare-op');
  });

  it('returns a legacy 503 when workflow submission is not configured and echoes the correlation id', async () => {
    const correlationId = 'legacy-workflow-submit-unavailable';
    const mp = multipart('', [['process', 'disbursement'], ['resolution_data', '{"account":"A"}']], [['files[]', 'PDF']]);
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/workflows',
        headers: { ...mp.headers, 'x-correlation-id': correlationId },
        bodyStream: mp.bodyStream,
      }),
      host({}),
    );
    expect(r).toMatchObject({
      status: 503,
      body: {
        type: 'https://dugate.vn/errors/service-not-available',
        title: 'Service Not Available',
        status: 503,
        detail: 'The legacy workflow submission service is not available on this deployment.',
        correlationId,
      },
    });
  });

  it('returns a legacy 503 when workflow schema resolution is not configured', async () => {
    const mp = multipart('', [['schemaSlug', 'invoice-v2'], ['input', '{"account":"A"}']]);
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/workflows/schema', headers: mp.headers, bodyStream: mp.bodyStream }),
      host({}),
    );
    expect(r).toMatchObject({
      status: 503,
      body: {
        type: 'https://dugate.vn/errors/service-not-available',
        title: 'Service Not Available',
        status: 503,
        detail: 'Workflow schema storage is not available on this deployment.',
      },
    });
  });

  it('maps unavailable schema crypto to a legacy 503', async () => {
    const mp = multipart('', [['schemaSlug', 'invoice-v2'], ['input', '{"account":"A"}']]);
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/docs/workflows/schema', headers: mp.headers, bodyStream: mp.bodyStream }),
      host({
        resolveLegacyWorkflowSchema: async () => {
          throw Object.assign(new Error('schema crypto unavailable'), { code: 'SCHEMA_CRYPTO_UNAVAILABLE' });
        },
      }),
    );
    expect(r).toMatchObject({
      status: 503,
      body: {
        type: 'https://dugate.vn/errors/service-not-available',
        title: 'Service Not Available',
        status: 503,
        detail: 'Workflow schema storage is temporarily unavailable.',
      },
    });
  });
});

describe('legacy mount — operations', () => {
  it('returns the legacy envelope on by-id read', async () => {
    const r = await handleLegacyRoute(req(), host());
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({ name: 'operations/op-1', done: true });
  });

  it('404s a missing operation with requested_id, like the legacy route', async () => {
    const r = await handleLegacyRoute(
      req(),
      host({ loadOperation: async () => null }),
    );
    expect(r?.status).toBe(404);
    expect(r?.body).toMatchObject({ title: 'Operation Not Found', requested_id: 'op-1' });
  });

  it('deletes with 204 and an empty body', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'DELETE' }),
      host({ softDeleteOperation: async () => true }),
    );
    expect(r?.status).toBe(204);
    expect(r?.body).toEqual({});
  });

  it('404s a delete of an absent row', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'DELETE' }),
      host({ softDeleteOperation: async () => false }),
    );
    expect(r?.status).toBe(404);
  });

  it('lists with {operations, next_page_token} and a plain id token', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/operations' }),
      host({
        listLegacyOperations: async () => ({
          rows: [toLegacyRow(row({ id: 'a' })), toLegacyRow(row({ id: 'b' }))],
          hasMore: true,
        }),
      }),
    );
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({ next_page_token: 'b' });
    expect((r?.body as { operations: unknown[] }).operations).toHaveLength(2);
  });

  it('answers a bad state filter with {error}, not problem+json', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/operations', searchParams: new URLSearchParams('filter=state=NOPE') }),
      host({ listLegacyOperations: async () => ({ rows: [], hasMore: false }) }),
    );
    expect(r?.status).toBe(400);
    expect(r?.body).toEqual({ error: 'Invalid state filter. Must be one of: RUNNING, SUCCEEDED, FAILED, PENDING' });
    expect(r?.body).not.toHaveProperty('type');
  });

  it('cancels with 200 and the envelope', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/operations/op-1/cancel' }),
      host({ cancelLegacy: async () => ({ ok: true, row: toLegacyRow(row({ state: 'CANCEL_REQUESTED' })) }) }),
    );
    expect(r?.status).toBe(200);
    expect((r?.body as { metadata: { state: string } }).metadata.state).toBe('CANCEL_REQUESTED');
  });

  it('answers 409 already-done when cancelling a finished operation', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/operations/op-1/cancel' }),
      host({ cancelLegacy: async () => ({ ok: false, status: 409 }) }),
    );
    expect(r?.status).toBe(409);
    expect(r?.body).toMatchObject({ title: 'Already Completed' });
    expect((r?.body as { type: string }).type).toBe('https://dugate.vn/errors/already-completed');
  });

  it('resumes with {success,message}', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/operations/op-1/resume' }),
      host({ resumeLegacy: async () => ({ ok: true }) }),
    );
    expect(r?.status).toBe(200);
    expect(r?.body).toEqual({ success: true, message: 'Resumed successfully' });
  });

  it('answers a bad resume with {error}, not problem+json', async () => {
    const r = await handleLegacyRoute(
      req({ method: 'POST', pathname: '/api/v1/operations/op-1/resume' }),
      host({ resumeLegacy: async () => ({ ok: false, status: 400, state: 'RUNNING' }) }),
    );
    expect(r?.status).toBe(400);
    expect(r?.body).toEqual({
      error: 'Operation is in state RUNNING, cannot resume. Must be WAITING_USER_INPUT.',
    });
  });

  it('409s a download of an unfinished operation', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/operations/op-1/download' }),
      host({ loadOperation: async (id) => toLegacyRow(row({ id, state: 'RUNNING' })) }),
    );
    expect(r?.status).toBe(409);
    expect((r?.body as { type: string }).type).toBe('https://dugate.vn/errors/not-ready');
  });

  it('RCR-06: a successful download returns the RAW bytes, not a JSON body', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/operations/op-1/download' }),
      host({
        loadOperation: async (id) =>
          toLegacyRow(row({ id, state: 'SUCCEEDED', output_format: 'markdown' })),
      }),
    );
    expect(r?.status).toBe(200);
    // host() default loadOutputContent returns Buffer.from('# hi') (utf8).
    expect(r?.raw).toEqual(Buffer.from('# hi', 'utf8'));
    expect(r?.body).toBeUndefined();
    expect(r?.headers['content-length']).toBe('4');
    expect(r?.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });
});

describe('legacy mount — billing and discoverability', () => {
  it('computes balance from the key limit, not tenant usage', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/billing/balance' }),
      host({ billingFor: async () => ({ name: 'k', spendingLimit: 100, totalUsed: 12.5, byModel: [], operationCount: 0 }) }),
    );
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({
      object: 'billing_balance',
      currency: 'USD',
      details: { spending_limit: 100, total_used: 12.5, balance: 87.5 },
    });
  });

  it('returns a null balance when no limit is set', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/billing/balance' }),
      host({ billingFor: async () => ({ name: 'k', spendingLimit: 0, totalUsed: 12.5, byModel: [], operationCount: 0 }) }),
    );
    expect((r?.body as { details: Record<string, unknown> }).details).toEqual({
      spending_limit: null, total_used: 12.5, balance: null,
    });
  });

  it('defaults the usage window to 30 days and echoes YYYY-MM-DD', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/billing/usage', searchParams: new URLSearchParams('start_date=2026-09-01&end_date=2026-09-30') }),
      host({
        billingFor: async () => ({
          name: 'k', spendingLimit: 0, totalUsed: 3,
          byModel: [{ model: 'gpt-x', promptTokens: 10, completionTokens: 20, pagesProcessed: 2, costUsd: 3 }],
          operationCount: 7,
        }),
      }),
    );
    expect(r?.body).toMatchObject({
      object: 'billing_usage', start_date: '2026-09-01', end_date: '2026-09-30',
      total_cost_usd: 3, total_input_tokens: 10, total_output_tokens: 20,
      total_operations: 7,
    });
  });

  it('rejects an unparseable date with {error}', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/billing/usage', searchParams: new URLSearchParams('start_date=nonsense') }),
      host({ billingFor: async () => null }),
    );
    expect(r?.status).toBe(400);
    expect(r?.body).toEqual({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  });

  it('serves the service catalogue with the legacy Vietnamese message', async () => {
    const r = await handleLegacyRoute(
      req({ pathname: '/api/v1/services' }),
      host({ serviceCatalogue: () => [{ serviceId: 'extract' }] }),
    );
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({ status: 200, services: [{ serviceId: 'extract' }] });
    expect((r?.body as { message: string }).message).toBe('Lấy danh sách các dịch vụ AI khả dụng thành công.');
  });

  // WFA 6b (fail-first): an unwired catalogue is an empty list with the legacy
  // 200 shape, not a 500. Discovery must not depend on a host capability that
  // this slice has no source for.
  it('answers 200 with an empty service list when the catalogue is not wired', async () => {
    const r = await handleLegacyRoute(req({ pathname: '/api/v1/services' }), host());
    expect(r?.status).toBe(200);
    expect(r?.body).toMatchObject({ status: 200, services: [] });
    expect((r?.body as { message: string }).message).toBe('Lấy danh sách các dịch vụ AI khả dụng thành công.');
  });
});

describe('legacy mount — auth and error hygiene', () => {
  it('answers 401 when the principal cannot be resolved', async () => {
    const r = await handleLegacyRoute(
      req({ resolvePrincipal: async () => { throw new Error('no key'); } }),
      host(),
    );
    expect(r?.status).toBe(500);
  });

  it('never echoes a decoder or host error message into a 500', async () => {
    const r = await handleLegacyRoute(
      req({
        method: 'POST',
        pathname: '/api/v1/docs/extract',
        headers: { 'content-type': 'multipart/form-data; boundary=B' },
        bodyStream: (async function* () { yield Buffer.from('garbage', 'latin1'); })(),
      }),
      host(),
    );
    expect(r?.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r?.body)).not.toMatch(/secret|SQL|password/i);
  });
});
