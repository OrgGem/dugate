import { handleInternalOperationsRoutes } from '../src/http/routes/internal-operations';
import { handlePublicRoutes } from '../src/http/routes/public';
import { isPublicIngressAllowed } from '../src/http/ingress-guard';
import type { RouteContext } from '../src/http/route-context';
import { dispatchAdminAction } from '../src/modules/admin-actions/dispatcher';
import { buildAdminOperationDetail } from '../src/modules/operations/mappers';

jest.mock('../src/modules/admin-actions/dispatcher', () => ({ dispatchAdminAction: jest.fn(async () => ({ status: 200, body: { replayed: false } })) }));
jest.mock('../src/modules/operations/mappers', () => ({ buildAdminOperationDetail: jest.fn(async () => ({ operation: { id: 'op' } })), toOperationDetailWire: jest.fn() }));

function context(pathname: string, extra: Partial<RouteContext> = {}): RouteContext {
  return { ingressAudience: 'internal', method: 'GET', pathname, searchParams: new URLSearchParams(),
    headers: { authorization: 'Bearer admin' }, config: { adminToken: 'admin', tenantAdminTokens: { tenant: 'tenant-a' } },
    runtime: { getOperation: jest.fn(async () => ({ id: 'op', tenant_id: 'tenant-a' })) },
    db: { query: jest.fn(), tx: jest.fn() }, ...extra } as unknown as RouteContext;
}

beforeEach(() => jest.clearAllMocks());

describe('operations audience contract', () => {
  test.each([
    '/api/v1/operations',
    '/api/v1/operations/op',
    '/api/v1/operations/op/result',
    '/api/v1/operations/op/download',
    '/api/v1/operations/op/cancel',
    '/api/v1/operations/op/resume',
  ])('the published API-key operation path %s is allowed through public ingress', (path) => {
    expect(isPublicIngressAllowed(path)).toBe(true);
  });
  test.each([
    '/api/v1/operations/metrics',
    '/api/v1/operations/op/retry',
    '/api/v1/operations/op/deliveries',
  ])('admin-only or unsupported public path %s stays closed', async (path) => {
    expect(isPublicIngressAllowed(path)).toBe(false);
    await expect(handlePublicRoutes(context(path, { headers: { 'x-api-key': 'legacy' } }))).rejects.toMatchObject({ status: 404 });
  });
  test('an admin bearer alone cannot claim the public operations list', async () => {
    await expect(handlePublicRoutes(context('/api/v1/operations'))).resolves.toBeNull();
  });
  test.each(['POST', 'PUT'])('public by-id preserves legacy method rejection %s', async (method) => {
    const response = await handlePublicRoutes(context('/api/v1/operations/op', { method, headers: { 'x-api-key': 'legacy' } }));
    expect(response?.status).toBe(405);
  });
  test('legacy by-id DELETE remains available to an API-key caller', async () => {
    const db = { query: jest.fn(async () => ({ rowCount: 1, rows: [] })) };
    const response = await handlePublicRoutes(context('/api/v1/operations/op', {
      method: 'DELETE',
      headers: { 'x-api-key': 'legacy' },
      db: { ...db, query: jest.fn(async (sql: string) => sql.includes('UPDATE operations') ? { rowCount: 1, rows: [] } : { rowCount: 1, rows: [{ id: 'key-id', tenant_id: 'tenant-a' }] }) } as unknown as RouteContext['db'],
    }));
    expect(response?.status).toBe(204);
  });
  test('legacy by-id and result/download retrieval paths remain public', () => {
    expect(isPublicIngressAllowed('/api/v1/operations/op')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1/operations/op/result')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1/operations/op/download')).toBe(true);
  });
  test.each(['', '/metrics', '/op', '/op/cancel', '/op/resume', '/op/retry', '/op/result', '/op/download'])('internal %s never accepts API keys', async (suffix) => {
    await expect(handleInternalOperationsRoutes(context(`/api/internal/operations${suffix}`, { headers: { 'x-api-key': 'legacy' } }))).rejects.toMatchObject({ status: 401 });
  });
  test('internal route rejects even admin on public listener', async () => {
    await expect(handleInternalOperationsRoutes(context('/api/internal/operations/op', { ingressAudience: 'public' }))).rejects.toMatchObject({ status: 404 });
  });
  test('tenant admin gets own detail and indistinguishable foreign/missing 404', async () => {
    await expect(handleInternalOperationsRoutes(context('/api/internal/operations/op', { headers: { authorization: 'Bearer tenant' } }))).resolves.toMatchObject({ status: 200 });
    const ctx = context('/api/internal/operations/op', { headers: { authorization: 'Bearer tenant' } });
    jest.mocked(ctx.runtime.getOperation).mockResolvedValue({ id: 'op', tenant_id: 'foreign' } as never);
    await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({ status: 404, message: 'not found' });
    expect(buildAdminOperationDetail).toHaveBeenCalledTimes(1);
  });
  test('control delegates trusted principal and only URL-selected operation ID', async () => {
    await expect(handleInternalOperationsRoutes(context('/api/internal/operations/op/resume', { method: 'POST', body: { operationId: 'foreign', resumeToken: 'token', payload: {} } }))).resolves.toMatchObject({ status: 200 });
    expect(dispatchAdminAction).toHaveBeenCalledWith(expect.anything(), { kind: 'bearer', principal: { role: 'platform' } }, expect.objectContaining({ action: 'operations.resume', params: { operationId: 'op', body: { operationId: 'foreign', resumeToken: 'token', payload: {} } } }));
  });
  test.each(['cancel', 'resume', 'retry'])('cookie %s requires CSRF before dispatcher', async (action) => {
    const ctx = context(`/api/internal/operations/op/${action}`, { method: 'POST', headers: { cookie: `du_session=${'a'.repeat(43)}` } });
    ctx.config.adminSessionStore = { get: async () => ({ role: 'admin', tenantId: null, csrfToken: 'token' }) };
    await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
    expect(dispatchAdminAction).not.toHaveBeenCalled();
  });
  test('tenant operator cannot retry with platform privilege', async () => {
    await expect(handleInternalOperationsRoutes(context('/api/internal/operations/op/retry', { method: 'POST', headers: { authorization: 'Bearer tenant' } }))).rejects.toMatchObject({ status: 403 });
    expect(dispatchAdminAction).not.toHaveBeenCalled();
  });
  test('viewer with valid CSRF cannot delete', async () => {
    const ctx = context('/api/internal/operations/op', { method: 'DELETE', headers: { cookie: `du_session=${'a'.repeat(43)}`, 'x-csrf-token': 'token' } });
    ctx.config.adminSessionStore = { get: async () => ({ role: 'viewer', tenantId: 'tenant-a', csrfToken: 'token' }) };
    await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({ status: 403 });
    expect(ctx.db.tx).not.toHaveBeenCalled();
  });
  test('cookie viewer without tenant cannot enumerate global operations', async () => {
    const sessionId = 'a'.repeat(43);
    const ctx = context('/api/internal/operations', { headers: { cookie: `du_session=${sessionId}` } });
    ctx.config.adminSessionStore = { get: async () => ({ role: 'viewer', tenantId: null, csrfToken: 'token' }) };
    await expect(handleInternalOperationsRoutes(ctx)).rejects.toMatchObject({ status: 403 });
  });
});
