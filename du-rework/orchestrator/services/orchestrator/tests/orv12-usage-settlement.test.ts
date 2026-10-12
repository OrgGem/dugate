import { randomUUID } from 'node:crypto';
import { createUsageService } from '../src/modules/usage/usage';
import type { Db } from '../src/db/db';
import { HttpUsageSink } from '../../connector/src/usage-dispatcher';
import { toContractUsageEvent, type UsageEvent } from '../../connector/src/usage';
import { legacyCompatHost } from '../src/compat/legacy-host-adapter';
import type { RouteContext } from '../src/server';

const operationId = randomUUID(), taskId = randomUUID();
const tenantId = randomUUID();
function memoryLedger() {
  const stored = new Map<string, Record<string, any>>();
  const query = async (sql: string, params: any[] = []) => {
    if (sql.includes('SELECT o.tenant_id::text AS tenant_id FROM operations')) {
      const matches = params[0] === operationId && params[1] === taskId;
      return { rowCount: Number(matches), rows: matches ? [{ tenant_id: tenantId }] : [] };
    }
    if (sql.includes('INSERT INTO usage_events')) {
      const fresh = !stored.has(params[0]);
      if (fresh) stored.set(params[0], JSON.parse(params[3]));
      return { rowCount: Number(fresh), rows: fresh ? [{ event_id: params[0] }] : [] };
    }
    if (sql.startsWith('SELECT payload')) return { rowCount: 1, rows: [{ payload: stored.get(params[0]) }] };
    throw new Error(`Unexpected SQL ${sql}`);
  };
  const service = createUsageService({ query, tx: async (run: any) => run({ query }) } as unknown as Db, {
    // This in-memory ledger test covers usage idempotency; gate denial and
    // writer ordering are exercised by the ORV14 service owner test.
    backupSnapshotWriteGate: { assertWriteAllowed: async () => undefined },
  });
  return { stored, service };
}
function event(usage: UsageEvent['usage']): UsageEvent {
  return { eventId: randomUUID(), invocationId: 'provider-call-1', operationId, taskId, usage, createdAt: new Date().toISOString() };
}

describe('ORV12 provider usage boundary and legacy projection', () => {
  it('keeps provider dimensions and measured money through actual sink and ingest, deduplicating retries', async () => {
    const { stored, service } = memoryLedger();
    const source = event({ inputTokens: 41, outputTokens: 17, pages: 2, costMicrousd: 725, measurement: 'measured', provider: 'loopback', model: 'fixture-v1' });
    const sink = new HttpUsageSink('http://orchestrator.test/usage', 'token', async (_url, request) => {
      await service.ingest(JSON.parse(String(request?.body)));
      return new Response('{}', { status: 200 });
    });
    await sink.send(source); await sink.send(source);
    expect(stored.size).toBe(1);
    expect([...stored.values()][0]).toMatchObject({ costMicrousd: 725, costStatus: 'measured', provider: 'loopback', model: 'fixture-v1', units: { inputTokens: 41, outputTokens: 17, pages: 2 } });
    await expect(service.ingest({ ...toContractUsageEvent(source), costMicrousd: 726 })).rejects.toMatchObject({ status: 409 });
    await expect(service.ingest({ ...toContractUsageEvent(source), eventId: randomUUID(), taskId: randomUUID() })).rejects.toMatchObject({ status: 422 });
  });
  it('distinguishes missing cost from measured zero and rejects unsafe provider amounts', () => {
    expect(toContractUsageEvent(event({ inputTokens: 10, measurement: 'measured' }))).toMatchObject({ costStatus: 'unpriced', costMicrousd: 0, measurement: 'measured' });
    expect(toContractUsageEvent(event({ inputTokens: 0, costMicrousd: 0, measurement: 'measured' }))).toMatchObject({ costStatus: 'measured', costMicrousd: 0 });
    expect(() => toContractUsageEvent(event({ inputTokens: Number.MAX_SAFE_INTEGER + 1, measurement: 'measured' }))).toThrow();
  });
  it.each(['pending', 'unpriced', 'measured'] as const)('projects %s money honestly in legacy polling', async (costStatus) => {
    const host = legacyCompatHost({
      db: { query: async () => ({ rowCount: 1, rows: [{ id: operationId, state: 'SUCCEEDED', tenant_id: 'tenant', api_key_id: 'key', total_cost_usd: null }] }) },
      usage: { project: async () => ({ inputTokens: 10, outputTokens: 3, costMicrousd: 0, measurement: costStatus === 'pending' ? 'pending' : 'measured', costStatus, pages: 2, model: 'fixture-v1' }) },
    } as unknown as RouteContext);
    const row = await host.loadOperation(operationId, 'tenant', 'key');
    expect(row?.totalCostUsd).toBe(costStatus === 'measured' ? 0 : null);
    if (costStatus !== 'pending') expect(row).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 3, pagesProcessed: 2, modelUsed: 'fixture-v1' });
  });
});
