import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';
import { parseWorkerInstanceList } from '../src/features/overview/worker-instance-state.ts';
import { computeWorkerTelemetry } from '../src/features/overview/overview-metrics.ts';

const row = {
  businessId: 'document-core',
  instanceId: 'worker-01',
  businessVersion: '3.2.1',
  state: 'ONLINE',
  health: 'HEALTHY',
  capacity: 8,
  activeLeases: 2,
  lastSeenAt: '2026-10-10T11:59:50.000Z',
  observedAt: '2026-10-10T11:59:51.000Z',
};

describe('parseWorkerInstanceList', () => {
  it('accepts a valid actual worker inventory and keeps instance identity distinct from business identity', () => {
    const parsed = parseWorkerInstanceList({
      items: [row],
      sampledAt: '2026-10-10T12:00:00.000Z',
      truncated: false,
    });
    assert.deepEqual(parsed, {
      items: [row],
      sampledAt: '2026-10-10T12:00:00.000Z',
      truncated: false,
    });
  });

  it('accepts a real empty inventory without manufacturing per-business rows', () => {
    assert.deepEqual(parseWorkerInstanceList({
      items: [],
      sampledAt: '2026-10-10T12:00:00.000Z',
      truncated: false,
    }), { items: [], sampledAt: '2026-10-10T12:00:00.000Z', truncated: false });
  });

  it('rejects invalid health, timestamps, counters, duplicate instances, and oversized responses', () => {
    const base = { items: [row], sampledAt: '2026-10-10T12:00:00.000Z', truncated: false };
    assert.equal(parseWorkerInstanceList({ ...base, items: [{ ...row, health: 'GREEN' }] }), null);
    assert.equal(parseWorkerInstanceList({ ...base, items: [{ ...row, lastSeenAt: 'not-a-time' }] }), null);
    assert.equal(parseWorkerInstanceList({ ...base, items: [{ ...row, activeLeases: -1 }] }), null);
    assert.equal(parseWorkerInstanceList({ ...base, items: [{ ...row, instanceId: 'bad\u0000id' }] }), null);
    assert.equal(parseWorkerInstanceList({ ...base, items: [row, row] }), null);
    assert.equal(parseWorkerInstanceList({ ...base, items: Array.from({ length: 501 }, (_, i) => ({ ...row, instanceId: `worker-${i}` })) }), null);
  });
});

describe('worker inventory API client', () => {
  it('requests the platform BFF endpoint with only the supported query values', async () => {
    const calls = [];
    const payload = { items: [row], sampledAt: '2026-10-10T12:00:00.000Z', truncated: false };
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init.method });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const result = await client.listWorkerInstances({ businessId: 'document-core', limit: '25' });

    assert.deepEqual(calls, [{
      url: '/admin/api/worker-instances?businessId=document-core&limit=25',
      method: 'GET',
    }]);
    assert.deepEqual(result, { ok: true, status: 200, data: payload });
  });
});

describe('computeWorkerTelemetry', () => {
  it('does not synthesize worker rows when the API inventory is empty', () => {
    assert.deepEqual(computeWorkerTelemetry([]), []);
  });

  it('renders each persisted instance independently, including multiple instances for one business', () => {
    const instances = [
      row,
      { ...row, instanceId: 'worker-02', health: 'DEGRADED', capacity: 4, activeLeases: 1 },
    ];
    assert.deepEqual(computeWorkerTelemetry(instances), [
      {
        businessId: 'document-core',
        instanceId: 'worker-01',
        version: '3.2.1',
        state: 'ONLINE',
        status: 'HEALTHY',
        capacity: 8,
        activeLeases: 2,
        lastHeartbeatAt: '2026-10-10T11:59:50.000Z',
      },
      {
        businessId: 'document-core',
        instanceId: 'worker-02',
        version: '3.2.1',
        state: 'ONLINE',
        status: 'DEGRADED',
        capacity: 4,
        activeLeases: 1,
        lastHeartbeatAt: '2026-10-10T11:59:50.000Z',
      },
    ]);
  });
});
