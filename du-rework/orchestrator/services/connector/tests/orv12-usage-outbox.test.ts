import { randomUUID } from 'node:crypto';
import { PostgresUsageOutbox } from '../src/db/usage-outbox';
import type { SqlClient } from '../src/db/sql';
import type { UsageEvent } from '../src/usage';

test('persistent outbox keeps settlement identity across retries and rejects divergent totals', async () => {
  const rows = new Map<string, UsageEvent>();
  const db = { query: async (sql: string, params: unknown[]) => {
    if (sql.startsWith('INSERT')) {
      if (rows.has(String(params[0]))) return { rows: [], rowCount: 0 };
      rows.set(String(params[0]), JSON.parse(String(params[2])));
      return { rows: [{ event_id: params[0] }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT')) return { rows: [{ payload: rows.get(String(params[0])) }], rowCount: 1 };
    throw new Error('unexpected query');
  } } as unknown as SqlClient;
  const outbox = new PostgresUsageOutbox(db);
  const event: UsageEvent = { eventId: 'invocation:1', invocationId: 'invocation', operationId: randomUUID(), taskId: randomUUID(), createdAt: '2026-10-11T00:00:00Z', usage: { inputTokens: 3, costMicrousd: 2, measurement: 'measured' } };
  await outbox.append({ ...event, usage: { ...event.usage, secretProviderField: 'must-not-persist' } as UsageEvent['usage'] });
  await outbox.append({ ...event, createdAt: '2026-10-11T01:00:00Z' });
  expect(rows.size).toBe(1);
  expect(JSON.stringify([...rows.values()])).not.toContain('must-not-persist');
  await expect(outbox.append({ ...event, usage: { ...event.usage, costMicrousd: 3, measurement: 'measured' } })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
});
