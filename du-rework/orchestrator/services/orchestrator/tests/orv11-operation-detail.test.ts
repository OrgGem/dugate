import { buildAdminOperationDetail } from '../src/modules/operations/mappers';
import type { AdminOperationDetailContext } from '../src/modules/operations/mappers';

test('ORV11 admin detail exposes actionable human waits and current CAS version under operation tenant', async () => {
  const waits = [{ waitId: 'wait-1', status: 'OPEN', inputSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } }, uiSchema: null, expiresAt: '2026-12-01T00:00:00Z' }];
  const query = jest.fn(async (sql: string) => ({ rows: sql.includes('human_waits') ? waits : [], rowCount: sql.includes('human_waits') ? 1 : 0 }));
  const ctx = { db: { query }, runtime: { getOperation: async () => ({ id: 'op-1', tenant_id: 'tenant-a', state: 'WAITING_INPUT', state_version: 7, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' }) } } as unknown as AdminOperationDetailContext;
  const result = await buildAdminOperationDetail(ctx, 'op-1');
  expect(result.humanWaits).toEqual(waits);
  expect(result.operation).toMatchObject({ stateVersion: 7, tenantId: 'tenant-a' });
  expect(query).toHaveBeenCalledWith(expect.stringContaining('o.tenant_id=$2'), ['op-1', 'tenant-a']);
});
