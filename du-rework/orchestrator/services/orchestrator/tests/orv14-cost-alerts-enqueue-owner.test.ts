import type { PoolClient } from 'pg';
import { budgetQuotaScopeKey, quotaScopeForBudget, type BudgetConfig, type CostBudgetAlertEnqueueFacts } from '@du/contracts';
import { enqueueCostBudgetAlerts } from '../src/modules/cost-alerts/enqueue';

const tenantId = '11111111-1111-4111-8111-111111111111';
const budgetId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const taskId = '55555555-5555-4555-8555-555555555555';
const ownerId = '66666666-6666-4666-8666-666666666666';
const channelId = 'tenant-admin-inbox-v1';

const config: BudgetConfig = {
  tenantId,
  period: 'monthly',
  tokenThreshold: 1000,
  usdThresholdMicroUsd: 10_000,
  alertThresholdPercent: 80,
  policy: 'alert-only',
  status: 'active',
  notificationChannels: [channelId],
};

function facts(overrides: Partial<CostBudgetAlertEnqueueFacts> = {}): CostBudgetAlertEnqueueFacts {
  const base: CostBudgetAlertEnqueueFacts = {
    tenantId,
    budgetId,
    budgetRevision: 1,
    quotaScopeKey: budgetQuotaScopeKey(quotaScopeForBudget(config)),
    windowStart: '2026-10-01T00:00:00.000Z',
    windowEnd: '2026-11-01T00:00:00.000Z',
    source: 'preflight',
    sourceEventKey: `preflight:${groupId}:${budgetId}:1`,
    reservationGroupId: groupId,
    operationId,
    taskId,
    invocationId: 'invocation-1',
    attempt: 1,
    evaluation: {
      action: 'WARN',
      hardCapEnabled: false,
      warnThresholdExceeded: true,
      usagePercent: 81,
      limitExceeded: false,
      remainingTokens: 190,
      remainingCostMicrousd: 1900,
    },
    trust: { confidence: 'upper-bound', reasonCode: null },
  };
  return { ...base, ...overrides };
}

function poolClient(options: { ownerRole?: string; channelKind?: string; duplicate?: boolean; published?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = jest.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes('FROM cost_budget_revisions')) return {
      rows: [{ tenant_id: tenantId, config, published_at: options.published === false ? null : '2026-10-01T00:00:00.000Z' }],
    };
    if (sql.includes('FROM cost_budget_alert_bindings')) return {
      rows: [{ binding_revision: 3, owner_recipient_kind: 'local', owner_user_id: ownerId,
        owner_oidc_principal_id: null, owner_authorization_version: null,
        owner_display_name: 'billing-admin', channel_refs: [{ channelId, channelRevision: 1 }] }],
    };
    if (sql.includes('FROM admin_local_users')) return { rows: [{ role: options.ownerRole ?? 'admin', is_enabled: true, is_locked: false }] };
    if (sql.includes('FROM cost_alert_channels')) return {
      rows: [{ channel_id: channelId, channel_revision: 1, kind: options.channelKind ?? 'in-app', display_name: 'Tenant Admin inbox', enabled: true }],
    };
    if (sql.includes('INSERT INTO cost_budget_alerts')) return {
      rows: options.duplicate ? [] : [{ alert_id: '77777777-7777-4777-8777-777777777777' }],
    };
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query, calls };
}

describe('ORV14 COST-04 transactional alert enqueue', () => {
  test('accepts canonical array quota keys and freezes one owner-scoped in-app delivery in the caller transaction', async () => {
    const scopeKey = budgetQuotaScopeKey(quotaScopeForBudget(config));
    expect(scopeKey).toBe(JSON.stringify([tenantId, null, null, null]));
    const fake = poolClient();

    await expect(enqueueCostBudgetAlerts(fake.client, facts())).resolves.toBeUndefined();

    const alert = fake.calls.find((call) => call.sql.includes('INSERT INTO cost_budget_alerts'));
    expect(alert?.values?.[7]).toBe(JSON.stringify({ tenantId }));
    expect(alert?.values?.[8]).toBe(scopeKey);
    expect(alert?.values?.[19]).toBe('ROUTED');
    expect(alert?.values?.[20]).toBe(3);
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_alert_deliveries'))).toBe(true);
    expect(fake.calls.some((call) => /\b(BEGIN|COMMIT|ROLLBACK)\b/i.test(call.sql))).toBe(false);
  });

  test('rejects a scope key that disagrees with the locked immutable budget revision before inserting alerts', async () => {
    const fake = poolClient();
    await expect(enqueueCostBudgetAlerts(fake.client, facts({ quotaScopeKey: JSON.stringify([tenantId, 'other', null, null]) })))
      .rejects.toMatchObject({ code: 'COST_ALERT_SOURCE_INVALID' });
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_budget_alerts'))).toBe(false);
  });

  test('refuses draft revisions as alert sources', async () => {
    const fake = poolClient({ published: false });
    await expect(enqueueCostBudgetAlerts(fake.client, facts())).rejects.toMatchObject({ code: 'COST_ALERT_SOURCE_INVALID' });
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_budget_alerts'))).toBe(false);
  });

  test('persists an immutable unrouted alert when the current owner is no longer an enabled tenant Admin', async () => {
    const fake = poolClient({ ownerRole: 'operator' });
    await enqueueCostBudgetAlerts(fake.client, facts());
    const alert = fake.calls.find((call) => call.sql.includes('INSERT INTO cost_budget_alerts'));
    expect(alert?.values?.[19]).toBe('UNROUTED');
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_alert_deliveries'))).toBe(false);
  });

  test('deduplicates delivery work when the alert row is already present', async () => {
    const fake = poolClient({ duplicate: true });
    await enqueueCostBudgetAlerts(fake.client, facts());
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_budget_alerts'))).toBe(true);
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_alert_deliveries'))).toBe(false);
  });
});
