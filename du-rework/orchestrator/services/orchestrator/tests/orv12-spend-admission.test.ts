import { assertKeySpendAvailable, readKeySpend, usdMicros } from '../src/modules/usage/spend-admission';
import type { Db } from '../src/db/db';

function reader(limit: string, baseline: string, current: string) {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const payload = {
    eventId: 'spend-event', invocationId: 'spend-invocation', operationId, taskId,
    units: { inputTokens: 0, outputTokens: 0 }, costMicrousd: Number(current),
    costStatus: 'measured', measurement: 'measured', occurredAt: '2026-10-01T00:00:00.000Z',
  };
  const query = jest.fn(async (sql: string, _params: unknown[]) => {
    if (sql.includes('FROM api_keys')) {
      return { rowCount: 1, rows: [{ name: 'legacy', spending_limit: limit, total_used: baseline, tenant_id: tenantId }] };
    }
    if (sql.includes('FROM usage_events')) {
      return { rowCount: 1, rows: [{ event_id: 'spend-event', operation_id: operationId, task_id: taskId, tenant_id: tenantId, payload }] };
    }
    if (sql.includes('FROM usage_financial_adjustments')) return { rowCount: 0, rows: [] };
    throw new Error(`unexpected spend reader SQL: ${sql}`);
  });
  return { db: { query } as unknown as Db, query };
}
describe('ORV12 spend admission uses exact shared billing amounts', () => {
  it('rejects at the exact microdollar limit and fences key plus tenant', async () => {
    const { db, query } = reader('0.000003', '0.000001', '2');
    await expect(assertKeySpendAvailable(db, 'key-a', 'tenant-a')).rejects.toMatchObject({ status: 402, code: 'SPENDING_LIMIT_EXCEEDED' });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining('k.tenant_id=$2::uuid'), ['key-a', 'tenant-a']]);
    expect(query.mock.calls[1]?.[0]).toContain('o.api_key_id=$1 AND o.tenant_id=$2::uuid');
    expect(query.mock.calls[1]?.[0]).toContain('o.legacy_history IS NULL');
  });
  it('allows below-limit known spend and zero means unlimited', async () => {
    await expect(assertKeySpendAvailable(reader('0.000003','0.000001','1').db, 'key', 'tenant')).resolves.toBeUndefined();
    await expect(assertKeySpendAvailable(reader('0','99999999999999.999999','100').db, 'key', 'tenant')).resolves.toBeUndefined();
  });
  it('does not lose a microdollar beyond the JS safe integer range', async () => {
    const { db } = reader('99999999999999.999999','99999999999999.999998','1');
    expect((await readKeySpend(db,'key','tenant')).used).toBe(usdMicros('99999999999999.999999'));
    await expect(assertKeySpendAvailable(db,'key','tenant')).rejects.toMatchObject({ status: 402 });
  });
  it('fails closed on unknown key scope and invalid money', async () => {
    await expect(readKeySpend({ query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Db,'key','foreign')).rejects.toMatchObject({ status: 401 });
    expect(() => usdMicros('NaN')).toThrow();
    expect(() => usdMicros('0.0000001')).toThrow();
  });
});
