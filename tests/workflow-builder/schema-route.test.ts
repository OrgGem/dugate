// tests/workflow-builder/schema-route.test.ts
// Route contract tests for POST /api/v1/docs/workflows/schema (Fix 3).
// Verifies:
//   1. Slug lookup — non-existent slug returns 404
//   2. Schema validation — invalid schema returns 400
//   3. Missing schemaSlug field — returns 400
//   4. Malformed `input` JSON — returns 400
//   5. Accepted enqueue — returns 202 + Operation-Location header + name/metadata
//   6. Route delegates to existing pipeline submission (does not enqueue invalid requests)
// No real DB, Redis, AI, or external network — DB and queue boundaries are mocked.

const mockLoadSchema = jest.fn();
const mockValidateSchema = jest.fn();
const mockSubmit = jest.fn();
const mockNormalizeFiles = jest.fn();
const mockDbSelect = jest.fn();

jest.mock('@/lib/workflow-builder/loader', () => ({
  loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
}));
jest.mock('@/lib/workflow-builder/interpreter', () => ({
  validateSchema: (...args: unknown[]) => mockValidateSchema(...args),
  // runSchemaDag not used in route — provide a stub so the module resolves.
  runSchemaDag: jest.fn(),
  toNodeResults: jest.fn(),
}));
jest.mock('@/lib/pipelines/submit', () => ({
  submitPipelineJob: (...args: unknown[]) => mockSubmit(...args),
}));
jest.mock('@/lib/endpoints/runner', () => ({
  // Re-import the real apiError so status code/body structure matches production.
  apiError: jest.requireActual('@/lib/endpoints/runner').apiError,
  normalizeFiles: (...args: unknown[]) => mockNormalizeFiles(...args),
}));
jest.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => mockDbSelect() }) }) }) }),
  },
}));

import { POST } from '../../app/api/v1/docs/workflows/schema/route';
import type { NextRequest } from 'next/server';
import type { SubmitPipelineParams } from '../../lib/pipelines/submit';
import type { WorkflowSchema } from '../../lib/workflow-builder/types';

interface FakedForm {
  get(name: string): string | null;
}

interface FakedHeaders {
  get(name: string): string | null;
}

/**
 * Minimal test fixture for the route. The route handler only reads
 * `formData()` and `headers.get()`, so we model that subset precisely.
 */
interface SchemaRouteFixture {
  formData(): Promise<FakedForm>;
  headers: FakedHeaders;
}

function makeFormRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): SchemaRouteFixture {
  const form: FakedForm = {
    get: (key: string) => (key in fields ? fields[key] : null),
  };
  const fakeHeaders: FakedHeaders = {
    get: (k: string) => headers[k.toLowerCase()] ?? null,
  };
  return {
    formData: async () => form,
    headers: fakeHeaders,
  };
}

/**
 * Boundary cast: the route parameter is a concrete `NextRequest` class
 * instance, but at this seam the test injects an explicit fixture that
 * satisfies its consumed surface (`formData()` + `headers.get`). The cast
 * through `unknown` keeps the call sites fully typed (no `any`).
 */
function asRouteRequest(fixture: SchemaRouteFixture): NextRequest {
  return fixture as unknown as NextRequest;
}

const VALID_SCHEMA: WorkflowSchema = {
  slug: 'disbursement',
  name: 'Disbursement',
  flow: ['a', 'b'],
  nodes: [
    { id: 'a', type: 'connector', connector: 'ext-classifier' },
    { id: 'b', type: 'connector', connector: 'ext-content-gen' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNormalizeFiles.mockReturnValue([]);
  mockValidateSchema.mockReturnValue([]);
  // Default DB select: returns a synthetic admin key so apiKeyId is resolved.
  mockDbSelect.mockResolvedValue([{ id: 'admin-key-id', keyHash: 'x', role: 'ADMIN' }]);
  mockSubmit.mockResolvedValue({
    ok: true,
    operation: { id: 'op-uuid-123' },
  });
});

describe('POST /api/v1/docs/workflows/schema — Fix 3 contract', () => {
  it('returns 400 when schemaSlug is missing', async () => {
    const req = makeFormRequest({});
    const res = await POST(asRouteRequest(req));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/schemaSlug/);
    expect(mockLoadSchema).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('returns 404 when slug is not in DB', async () => {
    mockLoadSchema.mockResolvedValue(null);
    const req = makeFormRequest({ schemaSlug: 'nope' });
    const res = await POST(asRouteRequest(req));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toMatch(/nope/);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('returns 400 when schema validation fails', async () => {
    mockLoadSchema.mockResolvedValue(VALID_SCHEMA);
    mockValidateSchema.mockReturnValue(['Flow references missing node']);
    const req = makeFormRequest({ schemaSlug: 'disbursement' });
    const res = await POST(asRouteRequest(req));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/invalid/i);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('returns 400 when input field is malformed JSON', async () => {
    mockLoadSchema.mockResolvedValue(VALID_SCHEMA);
    mockValidateSchema.mockReturnValue([]);
    const req = makeFormRequest({ schemaSlug: 'disbursement', input: '{not-json' });
    const res = await POST(asRouteRequest(req));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toMatch(/input/i);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('returns 202 + Operation-Location + name/metadata on accepted enqueue', async () => {
    mockLoadSchema.mockResolvedValue(VALID_SCHEMA);
    mockValidateSchema.mockReturnValue([]);
    mockSubmit.mockResolvedValue({
      ok: true,
      operation: { id: 'op-uuid-123' },
    });

    const req = makeFormRequest(
      { schemaSlug: 'disbursement', input: JSON.stringify({ limit_amount: 5000000 }) },
      { 'x-correlation-id': 'corr-test-1' },
    );
    const res = await POST(asRouteRequest(req));

    expect(res.status).toBe(202);
    expect(res.headers.get('Operation-Location')).toBe('/api/v1/operations/op-uuid-123');
    const body = await res.json();
    expect(body.name).toBe('operations/op-uuid-123');
    expect(body.done).toBe(false);
    expect(body.metadata.state).toBe('RUNNING');
    expect(body.metadata.workflow).toBe('disbursement');

    // Route delegates to existing pipeline submission with the workflow endpoint slug.
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const submitArgs = mockSubmit.mock.calls[0][0] as SubmitPipelineParams;
    expect(submitArgs.endpointSlug).toMatch(/^workflows:.*disbursement/);
    expect(submitArgs.pipeline?.[0]?.variables?.schemaSlug).toBe('disbursement');
    expect(submitArgs.correlationId).toBe('corr-test-1');
    expect(submitArgs.disableHistory).toBe(false);
  });

  it('does not enqueue when validation/lookup fails', async () => {
    // Same scenario as "slug not found" — guarantees no DB enqueue leak.
    mockLoadSchema.mockResolvedValue(null);
    const req = makeFormRequest({ schemaSlug: 'ghost' });
    await POST(asRouteRequest(req));
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});