import { HttpError } from '../src/http/errors';
import type { RouteContext } from '../src/http/route-context';
import { handlePublicRoutes } from '../src/http/routes/public';

const TENANT_A = 'tenant-med2-a';
const TENANT_B = 'tenant-med2-b';
const OP_MISSING = 'workflow-id-does-not-exist';
const CORRELATION_ID = 'wfa-med2-same-correlation';

type OperationRow = Record<string, unknown>;

function operation(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'workflow-id-existing',
    tenant_id: TENANT_A,
    api_key_id: 'caller-key',
    endpoint_slug: 'workflows:invoice:extract',
    state: 'SUCCEEDED',
    result_ref: 'opaque-result-ref',
    ...overrides,
  };
}

function routeContext(options: {
  pathname: string;
  authorization?: string;
  operationRows?: Record<string, OperationRow>;
}): RouteContext {
  const operationRows = options.operationRows ?? {};
  const query = async (sql: string) => {
    if (sql.startsWith('SELECT id, tenant_id FROM api_keys')) {
      return { rowCount: 1, rows: [{ id: 'caller-key', tenant_id: TENANT_A }] };
    }
    throw new Error(`unexpected SQL in MED-2 route test: ${sql}`);
  };
  const getOperation = async (id: string): Promise<OperationRow> => {
    const row = operationRows[id];
    if (row) return row;
    // Matches runtime.getOperation's real 404 shape at runtime.ts:1792-1795.
    throw new HttpError(404, 'NOT_FOUND', `operation ${id} not found`);
  };

  return {
    method: 'GET',
    pathname: options.pathname,
    searchParams: new URLSearchParams(),
    headers: {
      ...(options.authorization === undefined ? { 'x-api-key': 'offline-caller-key' } : {}),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
    },
    correlationId: CORRELATION_ID,
    config: { tenantAdminTokens: { 'offline-tenant-operator': TENANT_A } },
    db: { query },
    runtime: { getOperation },
  } as unknown as RouteContext;
}

async function problemFor(request: Promise<unknown>): Promise<Record<string, unknown>> {
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
  it('tenant-operator detail returns the same problem for missing and foreign operation IDs', async () => {
    const missing = await problemFor(
      handlePublicRoutes(
        routeContext({
          pathname: `/api/v1/operations/${OP_MISSING}`,
          authorization: 'Bearer offline-tenant-operator',
        }),
      ),
    );
    const foreign = await problemFor(
      handlePublicRoutes(
        routeContext({
          pathname: '/api/v1/operations/workflow-id-foreign',
          authorization: 'Bearer offline-tenant-operator',
          operationRows: { 'workflow-id-foreign': operation({ tenant_id: TENANT_B }) },
        }),
      ),
    );

    expect(missing).toEqual(foreign);
  });

  it('API-key result returns the same problem for missing, foreign-tenant, and foreign-profile workflow IDs', async () => {
    const missing = await problemFor(
      handlePublicRoutes(routeContext({ pathname: `/api/v1/operations/${OP_MISSING}/result` })),
    );
    const foreignTenant = await problemFor(
      handlePublicRoutes(
        routeContext({
          pathname: '/api/v1/operations/workflow-id-foreign-tenant/result',
          operationRows: { 'workflow-id-foreign-tenant': operation({ tenant_id: TENANT_B }) },
        }),
      ),
    );
    const foreignProfile = await problemFor(
      handlePublicRoutes(
        routeContext({
          pathname: '/api/v1/operations/workflow-id-foreign-profile/result',
          operationRows: { 'workflow-id-foreign-profile': operation({ api_key_id: 'another-key' }) },
        }),
      ),
    );

    expect(missing).toEqual(foreignTenant);
    expect(missing).toEqual(foreignProfile);
  });
});
