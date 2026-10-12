import { projectEffectiveCharge, type EffectiveChargeAdjustmentRow } from '../src/modules/usage/effective-charges';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const reservationGroupId = '44444444-4444-4444-8444-444444444444';
const rootEventId = 'event-root-1';
const occurredAt = '2026-10-01T00:00:00.000Z';

const root = {
  event_id: rootEventId,
  tenant_id: tenantId,
  payload: {
    eventId: rootEventId,
    invocationId: 'invocation-1',
    operationId,
    taskId,
    units: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 10, pages: 2 },
    costMicrousd: 100,
    providerReportedCost: { costMicrousd: 9999, currency: 'USD', source: 'provider-response', status: 'unverified' },
    measurement: 'measured',
    costStatus: 'measured',
    provider: 'openai',
    model: 'gpt-4o-2024-08-06',
    occurredAt,
    costProvenance: {
      version: 1,
      tenantId,
      apiKeyId: null,
      profileId: null,
      profileRevision: null,
      businessId: 'business',
      businessVersion: '1',
      action: 'generate',
      attempt: 1,
      stepKey: 'generate',
      connectorId: 'connector',
      connectorRevision: 1,
      durationMs: 40,
      reservationGroupId,
      selectedAt: occurredAt,
      confidence: 'upper-bound',
      priceRevision: 1,
      priceSnapshot: {
        provider: 'openai',
        modelId: 'gpt-4o-2024-08-06',
        priceVersion: 1,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        currency: 'USD',
        inputMicrousdPerMillion: 100,
        outputMicrousdPerMillion: 200,
      },
      budgetPins: [],
      costBoundCapabilityId: 'openai-gpt4o-text-v1',
      inputUpperBoundTokens: 128000,
      outputLimitTokens: 16384,
    },
  },
};

function adjustment(input: Partial<EffectiveChargeAdjustmentRow> & Pick<EffectiveChargeAdjustmentRow, 'adjustment_event_id' | 'adjustment_revision' | 'kind'>): EffectiveChargeAdjustmentRow {
  const revision = Number(input.adjustment_revision);
  const { adjustment_event_id, adjustment_revision, kind, ...overrides } = input;
  const gross = revision === 1 ? 80 : 80;
  const refunded = revision === 1 ? 0 : 30;
  return {
    adjustment_event_id,
    root_event_id: rootEventId,
    tenant_id: tenantId,
    adjustment_revision: Number(adjustment_revision),
    previous_adjustment_event_id: revision === 1 ? null : '55555555-5555-4555-8555-555555555555',
    kind,
    target_charge_microusd: kind === 'correction' ? 80 : null,
    refund_microusd: kind === 'refund' ? 30 : null,
    initial_charge_microusd: 100,
    gross_charge_microusd: gross,
    refunded_microusd: refunded,
    net_charge_microusd: gross - refunded,
    effective_at: occurredAt,
    quota_window_pins: [],
    recorded_at: revision === 1 ? '2026-10-02T00:00:00.000Z' : '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('ORV14 effective financial charge projection', () => {
  it('applies correction then refund once, keeps original units, and ignores reported provider money', () => {
    const correction = adjustment({
      adjustment_event_id: '55555555-5555-4555-8555-555555555555',
      adjustment_revision: 1,
      kind: 'correction',
    });
    const refund = adjustment({
      adjustment_event_id: '66666666-6666-4666-8666-666666666666',
      adjustment_revision: 2,
      previous_adjustment_event_id: correction.adjustment_event_id,
      kind: 'refund',
    });

    const current = projectEffectiveCharge(root, [refund, correction]);
    expect(current).toMatchObject({
      initialChargeMicrousd: 100,
      grossChargeMicrousd: 80,
      refundedMicrousd: 30,
      netChargeMicrousd: 50,
      adjustmentRevision: 2,
      costStatus: 'measured',
    });
    expect(current.event?.units).toEqual({ inputTokens: 100, outputTokens: 25, cachedInputTokens: 10, pages: 2 });
    expect(current.event?.providerReportedCost?.costMicrousd).toBe(9999);
    expect(current.netChargeMicrousd).not.toBe(current.event?.providerReportedCost?.costMicrousd);

    const atCorrection = projectEffectiveCharge(root, [correction, refund], {
      recordedAsOf: new Date('2026-10-02T12:00:00.000Z'),
    });
    expect(atCorrection).toMatchObject({ grossChargeMicrousd: 80, refundedMicrousd: 0, netChargeMicrousd: 80, adjustmentRevision: 1 });
    expect(atCorrection.effectiveAt).toBe(occurredAt);
    expect(atCorrection.recordedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('fails closed when an append-only row breaks the direct-root chain or stored arithmetic', () => {
    const correction = adjustment({
      adjustment_event_id: '55555555-5555-4555-8555-555555555555',
      adjustment_revision: 1,
      kind: 'correction',
    });
    const refund = adjustment({
      adjustment_event_id: '66666666-6666-4666-8666-666666666666',
      adjustment_revision: 2,
      previous_adjustment_event_id: '77777777-7777-4777-8777-777777777777',
      kind: 'refund',
    });
    expect(() => projectEffectiveCharge(root, [correction, refund])).toThrow(/previous-head chain/);
    expect(() => projectEffectiveCharge(root, [{ ...correction, net_charge_microusd: 79 }])).toThrow(/stored totals/);
  });
});
