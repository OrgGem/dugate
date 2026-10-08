import {
  handleLegacyRoute,
  type LegacyCompatHost,
  type LegacyRouteRequest,
} from '../../orchestrator/services/orchestrator/src/compat/legacy-http-mount';

const boundary = 'wfa-route-projection';
const principal = { tenantId: '00000000-0000-4000-a000-000000000001', apiKeyId: 'wfa-public-key-id' };

function multipartBody(fields: Record<string, string>, file?: { name: string; bytes: string }): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n${file.bytes}\r\n`,
      'utf8',
    ));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function request(pathname: string, body: Buffer, contentLength: string): LegacyRouteRequest {
  return {
    method: 'POST',
    pathname,
    searchParams: new URLSearchParams('sync=true'),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'idempotency-key': 'legacy-workflow-key-is-ignored',
      'x-api-key': 'synthetic-api-key',
      'content-length': contentLength,
    },
    bodyStream: (async function* () { yield body; })(),
    resolvePrincipal: async () => principal,
  };
}

function host(overrides: Partial<LegacyCompatHost> = {}): LegacyCompatHost {
  return {
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    loadOperation: async () => null,
    loadOutputContent: async () => null,
    ...overrides,
  };
}

describe('legacy workflow response projection (route unit; host is deliberately in-memory)', () => {
  test('keeps submit at 202 and ignores sync/idempotency for named workflows', async () => {
    let nextId = 1;
    const submitLegacyWorkflow = jest.fn(async () => ({ operationId: `wfa-op-${nextId++}` }));
    const workflowHost = host({ submitLegacyWorkflow });
    const responses = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = multipartBody(
        { process: 'disbursement', resolution_data: 'synthetic reference' },
        { name: `input-${attempt}.txt`, bytes: 'synthetic file' },
      );
      responses.push(await handleLegacyRoute(
        request('/api/v1/docs/workflows', body, String(body.byteLength)),
        workflowHost,
      ));
    }

    expect(submitLegacyWorkflow).toHaveBeenCalledTimes(2);
    expect(responses[0]).toMatchObject({
      status: 202,
      headers: { 'Operation-Location': '/api/v1/operations/wfa-op-1' },
      body: {
        name: 'operations/wfa-op-1',
        done: false,
        metadata: {
          state: 'RUNNING',
          workflow: 'disbursement',
          progress_percent: 0,
          progress_message: 'Initializing workflow...',
        },
      },
    });
    expect(responses[1]?.headers['Operation-Location']).toBe('/api/v1/operations/wfa-op-2');
  });

  test('keeps schema selection in the multipart selector and returns the schema envelope', async () => {
    const pin = {
      tenantId: principal.tenantId,
      slug: 'approved-schema',
      revision: 3,
      digest: `sha256:${'a'.repeat(64)}`,
      schema: { slug: 'approved-schema' },
    };
    const resolveLegacyWorkflowSchema = jest.fn(async () => pin);
    const submitLegacyWorkflow = jest.fn(async () => ({ operationId: 'wfa-schema-op' }));
    const body = multipartBody({
      schemaSlug: ' approved-schema ',
      input: '{"schemaSlug":"attacker-selected","note":"synthetic"}',
    });
    const response = await handleLegacyRoute(
      request('/api/v1/docs/workflows/schema', body, String(body.byteLength)),
      host({ resolveLegacyWorkflowSchema, submitLegacyWorkflow }),
    );

    expect(resolveLegacyWorkflowSchema).toHaveBeenCalledWith(principal.tenantId, 'approved-schema');
    expect(submitLegacyWorkflow).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ schemaSlug: 'approved-schema', input: { schemaSlug: 'attacker-selected', note: 'synthetic' } }),
      pin,
    );
    expect(response).toMatchObject({
      status: 202,
      headers: { 'Operation-Location': '/api/v1/operations/wfa-schema-op' },
      body: {
        name: 'operations/wfa-schema-op',
        done: false,
        metadata: {
          state: 'RUNNING',
          workflow: 'approved-schema',
          progress_percent: 0,
          progress_message: 'Initializing schema workflow...',
        },
      },
    });
  });
});
