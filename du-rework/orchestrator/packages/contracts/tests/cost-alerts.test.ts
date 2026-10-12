import {
  CostAlertChannelSchema,
  CostAlertDeliverySchema,
  CostBudgetAlertBindingWriteSchema,
  CostBudgetAlertEnqueueFactsSchema,
  CostPolicyScopeCatalogQuerySchema,
  CostPolicyScopeCatalogSchema,
  type CostBudgetAlertEnqueueFacts,
} from '../src/cost-alerts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const budgetId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const taskId = '55555555-5555-4555-8555-555555555555';
const ownerId = '66666666-6666-4666-8666-666666666666';

function enqueueFacts(overrides: Partial<CostBudgetAlertEnqueueFacts> = {}): CostBudgetAlertEnqueueFacts {
  return {
    tenantId,
    budgetId,
    budgetRevision: 1,
    quotaScopeKey: JSON.stringify([tenantId, null, null, null]),
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
    ...overrides,
  };
}

describe('cost alert contracts', () => {
  test('allows only the first-party owner inbox channel and rejects browser destinations', () => {
    expect(CostAlertChannelSchema.safeParse({
      channelId: 'tenant-admin-inbox-v1',
      channelRevision: 1,
      kind: 'in-app',
      displayName: 'Tenant Admin inbox',
      enabled: true,
      destinationLabel: 'Owner-scoped Admin inbox',
    }).success).toBe(true);
    expect(CostAlertChannelSchema.safeParse({
      channelId: 'webhook',
      channelRevision: 1,
      kind: 'webhook',
      displayName: 'Webhook',
      enabled: true,
      destinationLabel: 'https://example.invalid',
      url: 'https://example.invalid/notify',
    }).success).toBe(false);
  });

  test('requires unique, revision-pinned channels on an owner mapping', () => {
    const base = {
      tenantId,
      budgetId,
      budgetRevision: 1,
      expectedBindingRevision: 0,
      ownerUserId: ownerId,
      channels: [{ channelId: 'tenant-admin-inbox-v1', channelRevision: 1 }],
    };
    expect(CostBudgetAlertBindingWriteSchema.safeParse(base).success).toBe(true);
    expect(CostBudgetAlertBindingWriteSchema.safeParse({
      ...base,
      channels: [...base.channels, ...base.channels],
    }).success).toBe(false);
    expect(CostBudgetAlertBindingWriteSchema.safeParse({
      tenantId,
      budgetId,
      budgetRevision: 1,
      expectedBindingRevision: 0,
      owner: { kind: 'oidc', principalId: ownerId },
      channels: base.channels,
    }).success).toBe(true);
    expect(CostBudgetAlertBindingWriteSchema.safeParse({
      ...base,
      owner: { kind: 'oidc', principalId: ownerId },
    }).success).toBe(false);
  });

  test('accepts a durable HELD delivery without implying an inbox receipt', () => {
    expect(CostAlertDeliverySchema.safeParse({
      channelId: 'tenant-admin-inbox-v1',
      channelRevision: 1,
      channelName: 'Tenant Admin inbox',
      state: 'HELD',
      attempts: 1,
      maxAttempts: 8,
      nextAttemptAt: null,
      deliveredAt: null,
      history: [],
    }).success).toBe(true);
  });

  test('accepts all concrete best-effort trust reasons while forbidding a hard-cap claim', () => {
    for (const reasonCode of ['BOUND_UNSUPPORTED', 'PRICE_UNAVAILABLE', 'USAGE_BASIS_UNBOUNDED', 'RESERVATION_BASIS_UNBOUNDED'] as const) {
      expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({
        trust: { confidence: 'best-effort', reasonCode },
      })).success).toBe(true);
    }
    expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({
      evaluation: { ...enqueueFacts().evaluation, hardCapEnabled: true },
      trust: { confidence: 'best-effort', reasonCode: 'BOUND_UNSUPPORTED' },
    })).success).toBe(false);
    expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({
      trust: { confidence: 'best-effort', reasonCode: null },
    })).success).toBe(false);
    expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({
      trust: { confidence: 'upper-bound', reasonCode: 'BOUND_UNSUPPORTED' },
    })).success).toBe(false);
  });

  test('requires the final persisted usage event for settlement alerts', () => {
    expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({ source: 'settlement' })).success).toBe(false);
    expect(CostBudgetAlertEnqueueFactsSchema.safeParse(enqueueFacts({
      source: 'settlement',
      sourceEventKey: `settlement:${groupId}:usage-event-1:${budgetId}:1`,
      usageEventId: 'usage-event-1',
    })).success).toBe(true);
  });

  test('defines bounded searchable scope pages and enforces parent filters and cursor state', () => {
    expect(CostPolicyScopeCatalogQuerySchema.parse({
      tenantId, kind: 'profiles', q: '  invoicing  ', limit: 50, apiKeyId: operationId,
    })).toMatchObject({ q: 'invoicing', limit: 50 });
    expect(CostPolicyScopeCatalogQuerySchema.safeParse({
      tenantId, kind: 'businesses', profileId: operationId,
    }).success).toBe(false);
    expect(CostPolicyScopeCatalogSchema.safeParse({
      tenantId, kind: 'api-keys', items: [{ id: operationId, label: 'Key · du_abcd' }],
      limit: 1, hasMore: true, nextCursor: 'eyJ2IjoxfQ',
    }).success).toBe(true);
    expect(CostPolicyScopeCatalogSchema.safeParse({
      tenantId, kind: 'api-keys', items: [], limit: 1, hasMore: true, nextCursor: null,
    }).success).toBe(false);
    expect(CostPolicyScopeCatalogSchema.safeParse({
      tenantId, kind: 'profiles', items: [{
        id: operationId, apiKeyId: taskId, apiKeyLabel: 'Key · du_abcd', businessId: 'billing',
        businessVersion: 'v1', action: 'lookup', profileName: 'Invoice profile',
      }], limit: 50, hasMore: false, nextCursor: null,
    }).success).toBe(true);
  });
});
