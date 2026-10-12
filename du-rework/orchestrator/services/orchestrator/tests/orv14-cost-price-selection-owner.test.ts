import { pricingTierFromUsd } from '@du/contracts';
import { resolvePricingTierForActualProvider } from '../src/modules/cost-control/reservation-groups';

const now = '2026-10-11T22:00:00.000Z';

function tier(provider?: string) {
  return pricingTierFromUsd({
    ...(provider ? { provider } : {}),
    modelId: 'gpt-4o-mini',
    priceVersion: 1,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    inputCostPerMillionTokensUsd: '1',
    outputCostPerMillionTokensUsd: '2',
  });
}

describe('actual-provider price selection for cost preflight', () => {
  it('records the proof provider on a provider-agnostic tier', () => {
    const selected = resolvePricingTierForActualProvider([tier()], {
      modelId: 'gpt-4o-mini',
      provider: 'custom-provider',
      at: now,
    });

    expect(selected?.provider).toBe('custom-provider');
    expect(selected?.priceVersion).toBe(1);
  });

  it('prefers an exact provider tier over a generic tier', () => {
    const selected = resolvePricingTierForActualProvider([tier(), tier('openai')], {
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      at: now,
    });

    expect(selected?.provider).toBe('openai');
    expect(selected?.inputMicrousdPerMillion).toBe(1_000_000);
  });

  it('returns no price when neither an exact nor generic tier is effective', () => {
    const selected = resolvePricingTierForActualProvider([tier('anthropic')], {
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      at: now,
    });

    expect(selected).toBeUndefined();
  });
});
