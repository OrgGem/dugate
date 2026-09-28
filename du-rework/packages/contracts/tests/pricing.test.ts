import { ZodError } from 'zod';
import {
  ModelPricingTableSchema,
  ModelPricingTierSchema,
  ModelPricingTierUsdInputSchema,
  PricingRateSchema,
  PricingRateTableSchema,
  PricingUnpricedUnitError,
  TOKENS_PER_MILLION,
  calculateOperationCost,
  findRateOverlaps,
  findPricingOverlaps,
  parseUsdPerMillionToMicrousd,
  pricingRateFromUsd,
  pricingTierFromUsd,
  resolveRate,
  resolvePricingTier,
} from '../src/pricing';
import { OperationUsageMetricsSchema, toOperationUsageMetricsView } from '../src/usage-metrics';
import {
  PricingRateSchema as ViaIndexPricingRateSchema,
  calculateOperationCost as ViaIndex,
  resolveRate as ViaIndexResolveRate,
} from '../src/index';

/**
 * COST-02 pricing contract tests (W-COST02-PRICING-MODEL-1) — offline, zero
 * DB/Redis. Positive: canonical tier + USD authoring adapter + resolver +
 * engine produce documented integers. Negative (win = fail closed): unknown/
 * prompt keys rejected by .strict(); non-safe-integer rates rejected; empty/
 * inverted effective windows rejected; duplicate versions and overlapping
 * windows detected; sub-micro float artifacts rejected by the parser; pages
 * without a rate refuse to bill; overflow refuses to truncate.
 */

const OP_ID = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';

const BASE_TIER = {
  modelId: 'gpt-4o',
  priceVersion: 1,
  effectiveFrom: '2026-01-01T00:00:00Z',
  inputMicrousdPerMillion: 2_500_000,
  outputMicrousdPerMillion: 10_000_000,
};

const BASE_RATE = {
  provider: 'openai',
  model: 'gpt-4o',
  unitType: 'input_tokens_per_million',
  priceMicrousdPerUnit: 2_500_000,
  effectiveFrom: '2026-01-01T00:00:00Z',
  priceVersion: 1,
  status: 'published',
} as const;

const BASE_RATE_USD = {
  provider: 'openai',
  model: 'gpt-4o',
  unitType: 'input_tokens_per_million',
  effectiveFrom: '2026-01-01T00:00:00Z',
  priceVersion: 1,
  status: 'published',
} as const;

const makeTier = (over: Record<string, unknown> = {}) =>
  ModelPricingTierSchema.parse({ ...BASE_TIER, ...over });

const makeRate = (over: Record<string, unknown> = {}) =>
  PricingRateSchema.parse({ ...BASE_RATE, ...over });

const makeUsage = (over: Record<string, unknown> = {}) =>
  OperationUsageMetricsSchema.parse({
    operationId: OP_ID,
    totalTokens: 0,
    costStatus: 'estimated',
    durationMs: 1,
    ...over,
  });

describe('ModelPricingTierSchema', () => {
  test('1. happy path: canonical tier parses, currency defaults USD, open-ended ok', () => {
    const tier = makeTier();
    expect(tier.currency).toBe('USD');
    expect(tier.effectiveTo).toBeUndefined();
    expect(tier.cachedInputMicrousdPerMillion).toBeUndefined();
    const closed = makeTier({ effectiveTo: '2026-02-01T00:00:00Z' });
    expect(ModelPricingTierSchema.parse(closed)).toStrictEqual(closed);
  });

  test('2. .strict(): prompt/secret/free-text keys can never enter a price record', () => {
    for (const extra of ['prompt', 'providerResponseBody', 'apiKey', 'signedUrl', 'pricingNotes']) {
      expect(() => ModelPricingTierSchema.parse({ ...BASE_TIER, [extra]: 'x' })).toThrow(ZodError);
    }
  });

  test('3. rates: non-integer/negative/overflow rejected; 0 is a measured free price', () => {
    expect(() => makeTier({ inputMicrousdPerMillion: 2.5 })).toThrow(ZodError);
    expect(() => makeTier({ outputMicrousdPerMillion: -1 })).toThrow(ZodError);
    expect(() => makeTier({ inputMicrousdPerMillion: 1e20 })).toThrow(ZodError);
    expect(makeTier({ inputMicrousdPerMillion: 0 }).inputMicrousdPerMillion).toBe(0);
  });

  test('4. priceVersion is a positive integer (immutable published version)', () => {
    expect(() => makeTier({ priceVersion: 0 })).toThrow(ZodError);
    expect(() => makeTier({ priceVersion: 1.5 })).toThrow(ZodError);
    expect(makeTier({ priceVersion: 7 }).priceVersion).toBe(7);
  });

  test('5. effective window [from,to): equal or inverted bounds rejected; offsets accepted', () => {
    expect(() =>
      makeTier({ effectiveTo: '2026-01-01T00:00:00Z' }),
    ).toThrow(/EFFECTIVE_WINDOW_ORDER|[Rr]ule|effectiveTo/);
    expect(() =>
      makeTier({ effectiveTo: '2025-12-31T23:59:59Z' }),
    ).toThrow(ZodError);
    const offset = makeTier({
      effectiveFrom: '2026-01-01T07:00:00+07:00',
      effectiveTo: '2026-02-01T00:00:00+07:00',
    });
    expect(offset.effectiveFrom).toBe('2026-01-01T07:00:00+07:00');
  });

  test('6. modelId shape allowlist: real slugs ok, spaces/empty/leading dash rejected', () => {
    for (const ok of ['gpt-4o', 'claude-3-5-sonnet', 'qwen-max', 'du.model:latest']) {
      expect(makeTier({ modelId: ok }).modelId).toBe(ok);
    }
    for (const bad of ['gpt 4o', '', '-lead', '.dot-first']) {
      expect(() => makeTier({ modelId: bad })).toThrow(ZodError);
    }
  });
});

describe('versioned table: duplicates + overlaps', () => {
  test('7. same modelId+priceVersion twice -> table rejected; distinct versions ok', () => {
    const a = makeTier({ priceVersion: 1, effectiveTo: '2026-02-01T00:00:00Z' });
    const b = makeTier({ priceVersion: 1 });
    expect(() => ModelPricingTableSchema.parse([a, b])).toThrow(ZodError);
    expect(() =>
      ModelPricingTableSchema.parse([a, makeTier({ priceVersion: 2, effectiveFrom: '2026-02-01T00:00:00Z' })]),
    ).not.toThrow();
  });

  test('8. findPricingOverlaps names intersecting windows, spares adjacent/different keys', () => {
    const jan = makeTier({ effectiveTo: '2026-02-01T00:00:00Z' });
    const feb = makeTier({ priceVersion: 2, effectiveFrom: '2026-02-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z' });
    expect(findPricingOverlaps([jan, feb])).toEqual([]); // half-open adjacency is not overlap
    const janish = makeTier({ priceVersion: 3, effectiveFrom: '2026-01-15T00:00:00Z', effectiveTo: '2026-02-15T00:00:00Z' });
    expect(findPricingOverlaps([jan, janish])).toEqual([{ i: 0, j: 1 }]);
    expect(() => ModelPricingTableSchema.parse([jan, janish])).toThrow(ZodError);
    expect(findPricingOverlaps([jan, makeTier({ priceVersion: 4 })])).toEqual([{ i: 0, j: 1 }]); // open-ended duplicate window
    expect(findPricingOverlaps([jan, makeTier({ modelId: 'qwen-max', priceVersion: 4 })])).toEqual([]);
    expect(
      findPricingOverlaps([
        makeTier({ provider: 'openai', priceVersion: 5 }),
        makeTier({ provider: 'azure', priceVersion: 6 }),
      ]),
    ).toEqual([]); // different providers never collide
    const providerScoped = findPricingOverlaps([
      makeTier({ provider: 'openai', priceVersion: 5 }),
      makeTier({ priceVersion: 7 }),
    ]);
    expect(providerScoped).toEqual([]); // provider+modelId is the key: 'openai' vs unscoped are DIFFERENT keys (strict equality), resolver fail-closes on ambiguity instead
  });
});

describe('COST-02 per-unit pricing rate table', () => {
  test('parses USD/micro-USD rates with required status and half-open dates', () => {
    expect(makeRate().currency).toBe('USD');
    expect(makeRate({ priceMicrousdPerUnit: 0 }).priceMicrousdPerUnit).toBe(0);
    expect(() => makeRate({ priceMicrousdPerUnit: 1.5 })).toThrow(ZodError);
    expect(() => {
      const { status: _status, ...missingStatus } = BASE_RATE;
      PricingRateSchema.parse(missingStatus);
    }).toThrow(ZodError);
    expect(() => makeRate({ unitType: 'tokens' })).toThrow(ZodError);
    expect(() => makeRate({ effectiveTo: '2026-01-01T00:00:00Z' })).toThrow(ZodError);
  });

  test('rejects overlapping effective windows for the same provider/model/unit', () => {
    const jan = makeRate({ effectiveTo: '2026-02-01T00:00:00Z' });
    const feb = makeRate({
      priceVersion: 2,
      effectiveFrom: '2026-02-01T00:00:00Z',
      effectiveTo: '2026-03-01T00:00:00Z',
    });
    const overlapping = makeRate({
      priceVersion: 3,
      effectiveFrom: '2026-01-15T00:00:00Z',
      effectiveTo: '2026-02-15T00:00:00Z',
    });
    expect(PricingRateTableSchema.parse([jan, feb])).toHaveLength(2);
    expect(findRateOverlaps([jan, overlapping])).toEqual([{ i: 0, j: 1 }]);
    expect(() => PricingRateTableSchema.parse([jan, overlapping])).toThrow(ZodError);
    expect(() => PricingRateTableSchema.parse([jan, makeRate()])).toThrow(ZodError);
    expect(
      PricingRateTableSchema.parse([
        jan,
        makeRate({ priceVersion: 3, unitType: 'output_tokens_per_million' }),
      ]),
    ).toHaveLength(2);
  });

  test('resolves only the published provider/model/unit rate in [from,to)', () => {
    const jan = makeRate({ effectiveTo: '2026-02-01T00:00:00Z' });
    const feb = makeRate({
      priceVersion: 2,
      effectiveFrom: '2026-02-01T00:00:00Z',
      priceMicrousdPerUnit: 3_000_000,
    });
    const table = [jan, feb];
    const find = (at: string) =>
      resolveRate(table, {
        provider: 'openai',
        model: 'gpt-4o',
        unitType: 'input_tokens_per_million',
        at,
      });
    expect(find('2026-01-01T00:00:00Z')?.priceVersion).toBe(1);
    expect(find('2026-02-01T00:00:00Z')?.priceVersion).toBe(2);
    expect(find('2025-12-31T23:59:59Z')).toBeUndefined();
    expect(
      resolveRate([makeRate({ status: 'draft' })], {
        provider: 'openai',
        model: 'gpt-4o',
        unitType: 'input_tokens_per_million',
        at: '2026-01-15T00:00:00Z',
      }),
    ).toBeUndefined();
    expect(() => resolveRate(table, { provider: 'openai', model: 'gpt-4o', unitType: 'page', at: 'bad' })).toThrow(ZodError);
  });

  test('converts exact USD authoring input to integer micro-USD per unit', () => {
    const rate = pricingRateFromUsd({
      ...BASE_RATE_USD,
      priceUsdPerUnit: '2.50',
    });
    expect(rate.priceMicrousdPerUnit).toBe(2_500_000);
    expect(rate.currency).toBe('USD');
    expect(() => pricingRateFromUsd({ ...BASE_RATE_USD, priceUsdPerUnit: '0.0000001' })).toThrow(RangeError);
  });
});

describe('resolvePricingTier (price in force at call time)', () => {
  const jan = makeTier({ effectiveTo: '2026-02-01T00:00:00Z' });
  const feb = makeTier({ priceVersion: 2, effectiveFrom: '2026-02-01T00:00:00Z' });
  const table = [jan, feb];

  test('9. [from,to) boundaries and timezone instants: from inclusive, to exclusive', () => {
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2026-01-01T00:00:00Z' })?.priceVersion).toBe(1);
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2026-01-31T23:59:59Z' })?.priceVersion).toBe(1);
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2026-02-01T00:00:00Z' })?.priceVersion).toBe(2);
    // instants, not strings: same wall-clock boundary expressed in +07:00
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2026-02-01T06:59:59+07:00' })?.priceVersion).toBe(1);
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2026-02-01T07:00:00+07:00' })?.priceVersion).toBe(2);
  });

  test('10. unpriced model / outside all windows -> undefined; garbage at -> RangeError; ambiguous provider key -> fail closed', () => {
    expect(resolvePricingTier(table, { modelId: 'qwen-max', at: '2026-02-01T00:00:00Z' })).toBeUndefined();
    expect(resolvePricingTier(table, { modelId: 'gpt-4o', at: '2025-12-31T00:00:00Z' })).toBeUndefined();
    expect(() => resolvePricingTier(table, { modelId: 'gpt-4o', at: 'not-a-date' })).toThrow(RangeError);
    const twoProviders = [
      makeTier({ provider: 'dashscope', priceVersion: 3 }),
      makeTier({ provider: 'openrouter', priceVersion: 4 }),
    ];
    expect(() => resolvePricingTier(twoProviders, { modelId: 'gpt-4o', at: '2026-05-05T00:00:00Z' })).toThrow(/PRICING_OVERLAP/);
    expect(resolvePricingTier(twoProviders, { modelId: 'gpt-4o', at: '2026-05-05T00:00:00Z', provider: 'dashscope' })?.priceVersion).toBe(3);
  });
});

describe('parseUsdPerMillionToMicrousd (authored USD -> int micro-USD)', () => {
  test('11. exact decimal conversions with pure integer math', () => {
    expect(TOKENS_PER_MILLION).toBe(1_000_000);
    expect(parseUsdPerMillionToMicrousd('2.50')).toBe(2_500_000);
    expect(parseUsdPerMillionToMicrousd('0.1')).toBe(100_000);
    expect(parseUsdPerMillionToMicrousd('0.000001')).toBe(1);
    expect(parseUsdPerMillionToMicrousd('0')).toBe(0);
    expect(parseUsdPerMillionToMicrousd('1234567.891234')).toBe(1_234_567_891_234);
    expect(parseUsdPerMillionToMicrousd('9007199254')).toBe(9_007_199_254_000_000);
  });

  test('12. rejects everything that is not a plain <=6-decimal money literal', () => {
    for (const bad of ['-1', '0.0000001', '1e3', '1E-7', '.5', '2.5abc', '', 'abc', '01.5']) {
      expect(() => parseUsdPerMillionToMicrousd(bad)).toThrow(RangeError);
    }
    expect(() => parseUsdPerMillionToMicrousd('9007199255')).toThrow(RangeError); // > MAX_SAFE
    expect(() => parseUsdPerMillionToMicrousd(Number.NaN)).toThrow(RangeError);
    expect(() => parseUsdPerMillionToMicrousd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test('13. float drift cannot cross the boundary', () => {
    expect(parseUsdPerMillionToMicrousd(2.5)).toBe(2_500_000); // number with clean decimal form ok
    expect(() => parseUsdPerMillionToMicrousd(0.1 + 0.2)).toThrow(RangeError); // 0.30000000000000004
    expect(() => parseUsdPerMillionToMicrousd(1e-7)).toThrow(RangeError); // String() -> '1e-7'
    expect(parseUsdPerMillionToMicrousd('0.1') * 3).toBe(300_000); // int micro-rates compose exactly (never 0.30000000000000004)
  });
});

describe('pricingTierFromUsd (packet-named authoring adapter)', () => {
  test('14. USD-per-million field names -> canonical integer micro-USD tier', () => {
    const tier = pricingTierFromUsd({
      modelId: 'claude-3-5-sonnet',
      priceVersion: 3,
      effectiveFrom: '2026-01-01T00:00:00Z',
      inputCostPerMillionTokensUsd: '3.00',
      outputCostPerMillionTokensUsd: '15.00',
      cachedInputCostPerMillionTokensUsd: '0.30',
    });
    expect(tier.inputMicrousdPerMillion).toBe(3_000_000);
    expect(tier.outputMicrousdPerMillion).toBe(15_000_000);
    expect(tier.cachedInputMicrousdPerMillion).toBe(300_000);
    expect(tier.currency).toBe('USD');
    expect(ModelPricingTierSchema.safeParse(tier).success).toBe(true);
  });

  test('15. adapter is strict too: extra keys and float artifacts rejected', () => {
    const baseOk = {
      modelId: 'gpt-4o',
      priceVersion: 1,
      effectiveFrom: '2026-01-01T00:00:00Z',
      inputCostPerMillionTokensUsd: '2.50',
      outputCostPerMillionTokensUsd: '10',
    };
    expect(ModelPricingTierUsdInputSchema.safeParse({ ...baseOk, rawProviderBody: {} }).success).toBe(false);
    expect(() => pricingTierFromUsd({ ...baseOk, inputCostPerMillionTokensUsd: 0.1 + 0.2 })).toThrow(RangeError);
    expect(() => pricingTierFromUsd({ ...baseOk, inputCostPerMillionTokensUsd: '-2.50' })).toThrow(RangeError);
    expect(pricingTierFromUsd(baseOk).cachedInputMicrousdPerMillion).toBeUndefined();
  });
});

describe('calculateOperationCost (exact int micro-USD engine)', () => {
  test('16. exact math: 1000 in @2.50/M + 500 out @10/M = 7500 micro-USD; provider money on the record is ignored', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costMicrousd: 999_999, costStatus: 'measured' });
    expect(calculateOperationCost(usage, makeTier())).toBe(7500);
  });

  test('17. cached tokens billed at cached rate, carved out of input: 600*2.5 + 400*0.3 + 500*10 = 6.62 cUSD', () => {
    const usage = makeUsage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500, totalTokens: 1500 });
    const tier = makeTier({ cachedInputMicrousdPerMillion: 300_000 });
    expect(calculateOperationCost(usage, tier)).toBe(1500 + 120 + 5000);
  });

  test('18. missing cached rate -> cached billed at FULL input rate (never a silent discount)', () => {
    const usage = makeUsage({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500, totalTokens: 1500 });
    expect(calculateOperationCost(usage, makeTier())).toBe(7500);
  });

  test('19. per-line-item round-half-up is pinned: two 0.5 halves each round up (6, not pooled 5); 0.4 floors; exact .5 up', () => {
    const oneInOneOut = makeUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    const halfRates = makeTier({ inputMicrousdPerMillion: 2_500_000, outputMicrousdPerMillion: 2_500_000 });
    expect(calculateOperationCost(oneInOneOut, halfRates)).toBe(3 + 3);
    const underHalf = makeUsage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 });
    expect(calculateOperationCost(underHalf, makeTier({ inputMicrousdPerMillion: 400_000 }))).toBe(0);
    expect(calculateOperationCost(underHalf, makeTier({ inputMicrousdPerMillion: 500_000 }))).toBe(1);
  });

  test('20. measured zeros stay zeros: no tokens -> 0; free tier -> 0', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(calculateOperationCost(usage, makeTier())).toBe(0);
    expect(calculateOperationCost(makeUsage({ inputTokens: 7, outputTokens: 9, totalTokens: 16 }), makeTier({ inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 }))).toBe(0);
  });

  test('21. pages extension: 3 pages @5000 -> 15000; pages>0 without rate fails closed; pages=0 needs no rate', () => {
    const withPages = makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, pages: 3 });
    expect(calculateOperationCost(withPages, makeTier({ pageMicrousdPerPage: 5000 }))).toBe(15_000);
    expect(() => calculateOperationCost(withPages, makeTier())).toThrow(PricingUnpricedUnitError);
    expect(calculateOperationCost(makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0, pages: 0 }), makeTier())).toBe(0);
    expect(calculateOperationCost(makeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), makeTier({ pageMicrousdPerPage: 5000 }))).toBe(0);
  });

  test('22. hostile inputs re-parse before arithmetic: extra keys / broken token math / bad rates all ZodError', () => {
    const usage = makeUsage({ inputTokens: 10, outputTokens: 0, totalTokens: 10 });
    expect(() => calculateOperationCost({ ...usage, prompt: 'leak' } as typeof usage, makeTier())).toThrow(ZodError);
    expect(() =>
      calculateOperationCost({ ...usage, totalTokens: 999 } as typeof usage, makeTier()),
    ).toThrow(ZodError);
    expect(() =>
      calculateOperationCost(usage, { ...makeTier(), raw_body: {} } as ReturnType<typeof makeTier>),
    ).toThrow(ZodError);
    expect(() =>
      calculateOperationCost(usage, { ...makeTier(), inputMicrousdPerMillion: 1.5 } as ReturnType<typeof makeTier>),
    ).toThrow(ZodError);
  });

  test('23. overflow guards: MAX_SAFE boundary returns exactly; beyond it RangeError, never silent double truncation', () => {
    const maxSafe = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
    const usage1m = makeUsage({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
    expect(calculateOperationCost(usage1m, makeTier({ inputMicrousdPerMillion: maxSafe }))).toBe(maxSafe);
    const huge = makeUsage({ inputTokens: 5_000_000_000, outputTokens: 0, totalTokens: 5_000_000_000 });
    expect(() => calculateOperationCost(huge, makeTier({ inputMicrousdPerMillion: maxSafe }))).toThrow(RangeError);
  });

  test('24. re-export smoke: index exposes pricing; usage-metrics view model still round-trips', () => {
    expect(typeof ViaIndex).toBe('function');
    expect(typeof ViaIndexResolveRate).toBe('function');
    expect(ViaIndexPricingRateSchema.safeParse(makeRate()).success).toBe(true);
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, costMicrousd: 7500 });
    const view = toOperationUsageMetricsView(usage);
    expect(view.costEstimateUsd).toBe('0.007500');
    expect(view.costSettled).toBe(false);
    expect(() => ModelPricingTierSchema.parse({ prompt: 'x' })).toThrow(ZodError);
  });
});
