import { UsageLedgerEventSchema, type UsageLedgerEvent } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createUsageService } from '../src/modules/usage/usage';

const OP_A = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const OP_B = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TASK_A = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';

const makeEvent = (eventId: string, over: Record<string, unknown> = {}): UsageLedgerEvent =>
  UsageLedgerEventSchema.parse({
    eventId,
    idempotencyKey: `idem-${eventId}`,
    kind: 'initial',
    tenantId: 'tenant-a',
    apiKeyId: 'key-01',
    operationId: OP_A,
    taskId: TASK_A,
    invocationId: 'inv-01',
    attempt: 1,
    stepKey: 'convert',
    businessId: 'biz-reports',
    businessVersion: 'v1',
    action: 'transform',
    profileRevision: 2,
    connectorId: 'conn-openai',
    connectorRevision: 1,
    provider: 'openai',
    model: 'gpt-4o',
    unitType: 'tokens',
    units: { inputTokens: 100, outputTokens: 50 },
    costMicrousd: 300,
    currency: 'USD',
    costStatus: 'measured',
    durationMs: 20,
    occurredAt: '2026-03-01T10:00:00Z',
    receivedAt: '2026-03-01T10:00:05Z',
    ...over,
  });

function fakeDb(events: readonly UsageLedgerEvent[]): {
  db: Db;
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const db = {
    pool: {},
    query: async (text: string, params: unknown[] = []): Promise<unknown> => {
      calls.push({ text, params });
      const rows = events.map((payload) => ({ payload }));
      return { rows, rowCount: rows.length };
    },
    tx: async (): Promise<never> => { throw new Error('query-only test'); },
    close: async (): Promise<void> => undefined,
  } as unknown as Db;
  return { db, calls };
}

describe('COST-03 grouped UsageService reconciliation', () => {
  test('projects tenant-scoped ledger rows into deduped dimension and status totals', async () => {
    const measured = makeEvent('evt-measured');
    const measuredStep = makeEvent('evt-measured-step', {
      stepKey: 'summarize',
      units: { inputTokens: 20, outputTokens: 10 },
      costMicrousd: 100,
    });
    const estimated = makeEvent('evt-estimated', {
      invocationId: 'inv-02',
      apiKeyId: 'key-02',
      profileRevision: 3,
      provider: 'anthropic',
      model: 'claude-sonnet',
      units: { inputTokens: 5, outputTokens: 5 },
      costMicrousd: 50,
      costStatus: 'estimated',
    });
    const pending = makeEvent('evt-pending', {
      operationId: OP_B,
      invocationId: 'inv-03',
      businessId: 'biz-archive',
      action: 'extract',
      units: { inputTokens: 0, outputTokens: 0 },
      costMicrousd: 0,
      costStatus: 'pending',
    });
    const unpriced = makeEvent('evt-unpriced', {
      operationId: OP_B,
      invocationId: 'inv-04',
      apiKeyId: 'key-02',
      provider: 'anthropic',
      model: 'claude-haiku',
      units: { inputTokens: 10, outputTokens: 5 },
      costMicrousd: 0,
      costStatus: 'unpriced',
    });
    const { db, calls } = fakeDb([measured, measuredStep, estimated, pending, unpriced, measured]);

    const view = await createUsageService(db).getReconciliationSummary(
      'tenant-a',
      {
        from: '2026-03-01T17:00:00+07:00',
        to: '2026-03-01T10:01:00Z',
        timeField: 'receivedAt',
      },
      undefined,
      ['tenant', 'apiKey', 'businessAction', 'profile', 'providerModel'],
    );

    expect(calls[0]!.text).toContain('o.tenant_id = $1');
    expect(calls[0]!.params).toEqual(['tenant-a']);
    expect(view.summary.eventCount).toBe(5);
    expect(view.aggregation?.timeSemantics).toStrictEqual({
      field: 'receivedAt', interval: '[from,to)', timezone: 'UTC',
    });
    expect(view.aggregation?.totals).toMatchObject({
      eventCount: 5,
      uniqueOperations: 2,
      invocations: 4,
      attempts: 4,
      inputTokens: 135,
      outputTokens: 70,
      totalTokens: 205,
      costMicrousd: 450,
      breakdown: {
        measured: { eventCount: 2, uniqueOperations: 1, invocations: 1, attempts: 1, costMicrousd: 400 },
        estimated: { eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1, costMicrousd: 50 },
        pending: { eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1, costMicrousd: 0 },
        unpriced: { eventCount: 1, uniqueOperations: 1, invocations: 1, attempts: 1, costMicrousd: 0 },
      },
    });
    expect(view.aggregation?.groups).toHaveLength(4);
    expect(view.aggregation?.groups.reduce((sum, group) => sum + group.metrics.eventCount, 0)).toBe(5);
  });

  test('rejects divergent event-id contents rather than reconciling an arbitrary copy', async () => {
    const first = makeEvent('evt-conflict');
    const conflict = makeEvent('evt-conflict', { costMicrousd: 301 });
    const { db } = fakeDb([first, conflict]);

    await expect(createUsageService(db).getReconciliationSummary('tenant-a', undefined, undefined, ['tenant']))
      .rejects.toMatchObject({ status: 500, code: 'USAGE_LEDGER_CONFLICT' });
  });
});
