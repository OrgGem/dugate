import { HttpError } from '../src/http/errors';
import type { RouteContext, RouteResult } from '../src/http/route-context';
import { handleInternalOperationsRoutes } from '../src/http/routes/internal-operations';
import { handlePublicRoutes } from '../src/http/routes/public';
import { hashKey } from '../src/http/routes/api-key-auth';

const TENANT_A = 'tenant-med2-a';
const TENANT_B = 'tenant-med2-b';
const OP_MISSING = 'workflow-id-does-not-exist';
const CORRELATION_ID = 'wfa-med2-same-correlation';
const CALLER_SECRET = 'offline-caller-key';
const OTHER_SECRET = 'offline-other-key';
const UNKNOWN_SECRET = 'offline-unknown-key';

type OperationRow = Record<string, unknown>;

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'workflow-id-existing',
    tenant_id: TENANT_A,
    api_key_id: 'caller-key',
    endpoint_slug: 'workflows:invoice:extract',
    state: 'SUCCEEDED',
    result_ref: null,
    ...overrides,
  };
}

function routeContext(options: {
  pathname: string;
  authorization?: string;
  apiKey?: string;
  audience?: 'public' | 'internal';
  operationRows?: Record<string, OperationRow>;
}): { context: RouteContext; query: jest.Mock; getOperation: jest.Mock } {
  const operationRows = options.operationRows ?? {};
  const keys = new Map([
    [hashKey(CALLER_SECRET), { id: 'caller-key', tenant_id: TENANT_A }],
    [hashKey(OTHER_SECRET), { id: 'other-key', tenant_id: TENANT_A }],
  ]);
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM api_keys') && sql.includes('hash=')) {
      const key = keys.get(String(params[0]));
      return key ? { rowCount: 1, rows: [{ ...key, key_mode: 'LEGACY_STANDALONE' }] } : { rowCount: 0, rows: [] };
    }
    if (sql.startsWith('SELECT * FROM operations')) {
      const id = String(params[0] ?? '');
      const tenantId = String(params[1] ?? '');
      const apiKeyId = String(params[2] ?? '');
      const row = operationRows[id];
      if (row && row.tenant_id === tenantId && row.api_key_id === apiKeyId) {
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM operations') && sql.includes('api_key_id=$3')) {
      const id = String(params[0] ?? '');
      const tenantId = String(params[1] ?? '');
      const apiKeyId = String(params[2] ?? '');
      const row = operationRows[id];
      if (row && row.tenant_id === tenantId && row.api_key_id === apiKeyId) {
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('FROM artifacts') || sql.includes('JOIN artifacts')) return { rowCount: 0, rows: [] };
    throw new Error(`unexpected SQL in MED-2 route test: ${sql}`);
  });
  const getOperation = jest.fn(async (id: string): Promise<OperationRow> => {
    const row = operationRows[id];
    if (row) return row;
    // Matches runtime.getOperation's real 404 shape at runtime.ts:1792-1795.
    throw new HttpError(404, 'NOT_FOUND', `operation ${id} not found`);
  });

  return {
    query,
    getOperation,
    context: {
      ingressAudience: options.audience ?? 'internal',
      method: 'GET',
      pathname: options.pathname,
      searchParams: new URLSearchParams(),
      headers: {
        ...(options.apiKey === undefined ? { 'x-api-key': CALLER_SECRET } : { 'x-api-key': options.apiKey }),
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      },
      correlationId: CORRELATION_ID,
      config: { tenantAdminTokens: { 'offline-tenant-operator': TENANT_A } },
      db: { query },
      runtime: { getOperation },
      usage: { project: async () => ({}) },
    } as unknown as RouteContext,
  };
}

async function routeResult(request: Promise<RouteResult | null>): Promise<RouteResult> {
  try {
    const result = await request;
    if (result === null) throw new Error('expected the public route to match');
    return result;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, body: err.toProblem(CORRELATION_ID) as unknown as Record<string, unknown> };
  }
}

async function internalProblem(request: Promise<unknown>): Promise<Record<string, unknown>> {
  let caught: unknown;
  try {
    await request;
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof HttpError)) {
    throw caught ?? new Error('expected the route to reject with HttpError');
  }
  return caught.toProblem(CORRELATION_ID) as unknown as Record<string, unknown>;
}

describe('WFA section 8 MED-2 operation existence oracle', () => {
  it('tenant-operator internal detail returns the same problem for missing and foreign operation IDs', async () => {
    const missingContext = routeContext({
      pathname: `/api/internal/operations/${OP_MISSING}`,
      authorization: 'Bearer offline-tenant-operator',
    });
    const missing = await internalProblem(handleInternalOperationsRoutes(missingContext.context));
    const foreignContext = routeContext({
      pathname: '/api/internal/operations/workflow-id-foreign',
      authorization: 'Bearer offline-tenant-operator',
      operationRows: { 'workflow-id-foreign': operation({ tenant_id: TENANT_B }) },
    });
    const foreign = await internalProblem(handleInternalOperationsRoutes(foreignContext.context));

    expect(missing).toEqual(foreign);
    expect(missingContext.getOperation).toHaveBeenCalledTimes(1);
    expect(foreignContext.getOperation).toHaveBeenCalledTimes(1);
    expect(missingContext.query).not.toHaveBeenCalled();
    expect(foreignContext.query).not.toHaveBeenCalled();
  });

  it('public by-ID polling preserves the owned legacy envelope and hides missing or foreign IDs', async () => {
    const owned = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing',
      operationRows: { 'workflow-id-existing': operation() },
    });
    const ownerResponse = await routeResult(handlePublicRoutes(owned.context));
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body).toMatchObject({ name: 'operations/workflow-id-existing', done: true });
    expect(owned.query.mock.calls.some(([sql]) => String(sql).startsWith('SELECT * FROM operations'))).toBe(true);

    const missing = routeContext({ audience: 'public', pathname: '/api/v1/operations/workflow-id-existing' });
    const otherKey = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing',
      apiKey: OTHER_SECRET,
      operationRows: { 'workflow-id-existing': operation() },
    });
    const otherTenant = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing',
      operationRows: { 'workflow-id-existing': operation({ tenant_id: TENANT_B }) },
    });
    const missingResponse = await routeResult(handlePublicRoutes(missing.context));
    const otherKeyResponse = await routeResult(handlePublicRoutes(otherKey.context));
    const otherTenantResponse = await routeResult(handlePublicRoutes(otherTenant.context));

    expect(missingResponse.status).toBe(404);
    expect(otherKeyResponse).toEqual(missingResponse);
    expect(otherTenantResponse).toEqual(missingResponse);
    for (const context of [missing, otherKey, otherTenant]) {
      expect(context.query.mock.calls.some(([sql]) => String(sql).startsWith('SELECT * FROM operations'))).toBe(true);
    }
  });

  it('public /result returns the historical envelope only for the owning key and fails auth before lookup', async () => {
    const owned = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing/result',
      operationRows: { 'workflow-id-existing': operation() },
    });
    const ownerResponse = await routeResult(handlePublicRoutes(owned.context));
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body).toMatchObject({ schemaVersion: '1', data: {}, artifacts: [], usage: {}, warnings: [] });
    const ownershipRead = owned.query.mock.calls.find(([sql]) => String(sql).includes('SELECT id, tenant_id, api_key_id, state'));
    expect(ownershipRead?.[1]).toEqual(['workflow-id-existing', TENANT_A, 'caller-key']);

    const missing = routeContext({ audience: 'public', pathname: `/api/v1/operations/${OP_MISSING}/result` });
    const otherKey = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing/result',
      apiKey: OTHER_SECRET,
      operationRows: { 'workflow-id-existing': operation() },
    });
    const unknownKey = routeContext({
      audience: 'public',
      pathname: '/api/v1/operations/workflow-id-existing/result',
      apiKey: UNKNOWN_SECRET,
      operationRows: { 'workflow-id-existing': operation() },
    });
    const missingResponse = await routeResult(handlePublicRoutes(missing.context));
    const otherKeyResponse = await routeResult(handlePublicRoutes(otherKey.context));
    const unknownKeyResponse = await routeResult(handlePublicRoutes(unknownKey.context));

    expect(missingResponse.status).toBe(404);
    expect(otherKeyResponse).toEqual(missingResponse);
    expect(unknownKeyResponse.status).toBe(401);
    expect(missing.query.mock.calls.some(([sql]) => String(sql).includes('SELECT id, tenant_id, api_key_id, state'))).toBe(true);
    expect(otherKey.query.mock.calls.some(([sql]) => String(sql).includes('SELECT id, tenant_id, api_key_id, state'))).toBe(true);
    expect(unknownKey.query.mock.calls.some(([sql]) => String(sql).includes('SELECT id, tenant_id, api_key_id, state'))).toBe(false);
  });
});
