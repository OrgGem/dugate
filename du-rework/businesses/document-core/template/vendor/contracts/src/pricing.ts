import { z } from 'zod';
import {
  MICROUSD_PER_USD,
  OperationUsageMetricsSchema,
  USAGE_ATTRIBUTION_ID_PATTERN,
  type OperationUsageMetrics,
} from './usage-metrics';

/**
 * COST-02 versioned pricing table + exact cost engine
 * (docs/admin-ops-monitoring-cost.md, task COST-02).
 *
 * ADDITIVE ONLY. Nothing in usage-metrics.ts / runtime.ts / connector.ts /
 * operations.ts is changed; this module consumes OperationUsageMetrics as-is.
 *
 * Money law honored here (docs "Quy tắc số liệu và bảo mật"): every rate and
 * every computed cost is a non-negative integer micro-USD; float never enters
 * an arithmetic path. USD-per-million rates may be AUTHORED as decimal strings
 * (or finite numbers whose shortest decimal form has <= 6 fractional digits)
 * and are converted once at the boundary by parseUsdPerMillionToMicrousd();
 * the engine itself is pure BigInt.
 *
 * Scope note: draft -> review -> publish CAS and the server-side permission/
 * audit checks of COST-02 belong to the pricing service (next packet). What
 * lives here is the immutable shape of a published tier ([from,to) effective
 * window, applied priceVersion), the pure overlap/version validators, and the
 * deterministic cost calculation with per-line-item round-half-up.
 */

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

const SafeIdSchema = z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN);
const TimestampSchema = z.string().datetime({ offset: true });
/** Rates are micro-USD (int) - bounded to the safe-integer range so any
 * downstream SUM in JS doubles stays exact. */
const MicrousdRateSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/** Billing granularity of token rates: micro-USD per 1,000,000 tokens. */
export const TOKENS_PER_MILLION = 1_000_000;

/* ------------------------------------------------------------------ */
/* ModelPricingTier - one published, immutable price version           */
/* ------------------------------------------------------------------ */

const ModelPricingTierBaseSchema = z
  .object({
    /** Docs COST-02 keys prices by provider + model; provider is optional so
     * single-provider deployments can key on modelId alone (the resolver then
     * treats a modelId shared across providers as ambiguous - fail closed). */
    provider: SafeIdSchema.optional(),
    /** Model slug as reported by the connector, e.g. 'gpt-4o',
     * 'claude-3-5-sonnet', 'qwen-max'. Allowlisted shape, never free text. */
    modelId: SafeIdSchema,
    /** Per-model monotonic version. Persisted on every priced ledger record
     * ("Lưu priceVersion/rate đã áp dụng") so a reprice never rewrites
     * history silently. */
    priceVersion: z.number().int().min(1),
    /** Effective window is half-open [from, to) - no midnight double bill. */
    effectiveFrom: TimestampSchema,
    /** Absent = open-ended (current price). */
    effectiveTo: TimestampSchema.optional(),
    currency: z.literal('USD').default('USD'),
    /** micro-USD per 1M non-cached input tokens. 0 is a MEASURED free price,
     * distinct from "no tier" (that is costStatus 'unpriced', see resolver). */
    inputMicrousdPerMillion: MicrousdRateSchema,
    outputMicrousdPerMillion: MicrousdRateSchema,
    /** Absent = cached input is billed at the FULL input rate (conservative:
     * a missing cache discount can never silently under-bill). */
    cachedInputMicrousdPerMillion: MicrousdRateSchema.optional(),
    /** Extension slot for non-token units (docs: "có chỗ mở rộng ...
     * page/image"). micro-USD per page. */
    pageMicrousdPerPage: MicrousdRateSchema.optional(),
  })
  .strict();

export const ModelPricingTierSchema = ModelPricingTierBaseSchema.superRefine((tier, ctx) => {
  if (
    tier.effectiveTo !== undefined &&
    Date.parse(tier.effectiveTo) <= Date.parse(tier.effectiveFrom)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'EFFECTIVE_WINDOW_ORDER' },
      message: 'effectiveTo must be strictly after effectiveFrom ([from,to) is non-empty)',
      path: ['effectiveTo'],
    });
  }
});
export type ModelPricingTier = z.infer<typeof ModelPricingTierSchema>;

/* ------------------------------------------------------------------ */
/* Versioned table: duplicate-version + overlap validators             */
/* ------------------------------------------------------------------ */

export const ModelPricingTableSchema = z.array(ModelPricingTierSchema).superRefine((tiers, ctx) => {
  const seen = new Map<string, number>();
  tiers.forEach((tier, index) => {
    const key = `${tier.provider ?? ''}\u0000${tier.modelId}\u0000${tier.priceVersion}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'DUP_PRICE_VERSION', firstIndex: first },
      message: `priceVersion ${tier.priceVersion} is already used for model '${tier.modelId}' at index ${first}`,
      path: [index, 'priceVersion'],
    });
  });
  for (const { i, j } of findPricingOverlaps(tiers)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'OVERLAPPING_PRICE_WINDOW', firstIndex: i },
      message: `pricing window overlaps the row at index ${i}`,
      path: [j, 'effectiveFrom'],
    });
  }
});
export type ModelPricingTable = z.infer<typeof ModelPricingTableSchema>;

/**
 * Pure overlap check the COST-02 service must run before publish
 * ("Server kiểm tra overlap"). Two tiers overlap when the same
 * provider+modelId windows intersect in [from,to) semantics. Returns index
 * pairs, not booleans, so the API can name the offending rows.
 */
export function findPricingOverlaps(
  tiers: readonly ModelPricingTier[],
): Array<{ i: number; j: number }> {
  const pairs: Array<{ i: number; j: number }> = [];
  for (let i = 0; i < tiers.length; i += 1) {
    for (let j = i + 1; j < tiers.length; j += 1) {
      const a = tiers[i];
      const b = tiers[j];
      if (a === undefined || b === undefined) continue;
      if (a.modelId !== b.modelId || a.provider !== b.provider) continue;
      const fromA = Date.parse(a.effectiveFrom);
      const toA = a.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.effectiveTo);
      const fromB = Date.parse(b.effectiveFrom);
      const toB = b.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.effectiveTo);
      if (fromA < toB && fromB < toA) pairs.push({ i, j });
    }
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* COST-02 per-unit published rate table                               */
/* ------------------------------------------------------------------ */

/** Token rates are authored per million tokens; non-token rates are per
 * page/image. Keeping that billing granularity in the unit type makes the
 * integer micro-USD rate unambiguous. */
export const PricingUnitTypes = [
  'input_tokens_per_million',
  'output_tokens_per_million',
  'cached_input_tokens_per_million',
  'page',
  'image',
] as const;
export const PricingUnitTypeSchema = z.enum(PricingUnitTypes);
export type PricingUnitType = z.infer<typeof PricingUnitTypeSchema>;

export const PricingRateStatuses = ['draft', 'review', 'published', 'retired'] as const;
export const PricingRateStatusSchema = z.enum(PricingRateStatuses);
export type PricingRateStatus = z.infer<typeof PricingRateStatusSchema>;

export const PricingRateSchema = z
  .object({
    provider: SafeIdSchema,
    model: SafeIdSchema,
    unitType: PricingUnitTypeSchema,
    /** Canonical integer micro-USD for the billing unit named by unitType. */
    priceMicrousdPerUnit: MicrousdRateSchema,
    currency: z.literal('USD').default('USD'),
    /** Half-open effective window [from,to); missing to means open-ended. */
    effectiveFrom: TimestampSchema,
    effectiveTo: TimestampSchema.optional(),
    priceVersion: z.number().int().min(1),
    status: PricingRateStatusSchema,
  })
  .strict()
  .superRefine((rate, ctx) => {
    if (rate.effectiveTo !== undefined && Date.parse(rate.effectiveTo) <= Date.parse(rate.effectiveFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { rule: 'EFFECTIVE_WINDOW_ORDER' },
        message: 'effectiveTo must be strictly after effectiveFrom ([from,to) is non-empty)',
        path: ['effectiveTo'],
      });
    }
  });
export type PricingRate = z.infer<typeof PricingRateSchema>;

/** Exact-decimal authoring form in USD; pricingRateFromUsd produces the
 * integer micro-USD storage form used by resolution and accounting. */
export const PricingRateUsdInputSchema = z
  .object({
    provider: SafeIdSchema,
    model: SafeIdSchema,
    unitType: PricingUnitTypeSchema,
    priceUsdPerUnit: z.union([z.string(), z.number()]),
    currency: z.literal('USD').default('USD'),
    effectiveFrom: TimestampSchema,
    effectiveTo: TimestampSchema.optional(),
    priceVersion: z.number().int().min(1),
    status: PricingRateStatusSchema,
  })
  .strict();
export type PricingRateUsdInput = z.input<typeof PricingRateUsdInputSchema>;

export function pricingRateFromUsd(input: PricingRateUsdInput): PricingRate {
  const draft = PricingRateUsdInputSchema.parse(input);
  return PricingRateSchema.parse({
    provider: draft.provider,
    model: draft.model,
    unitType: draft.unitType,
    priceMicrousdPerUnit: parseUsdPerMillionToMicrousd(draft.priceUsdPerUnit),
    currency: draft.currency,
    effectiveFrom: draft.effectiveFrom,
    effectiveTo: draft.effectiveTo,
    priceVersion: draft.priceVersion,
    status: draft.status,
  });
}

export function findRateOverlaps(rates: readonly PricingRate[]): Array<{ i: number; j: number }> {
  const pairs: Array<{ i: number; j: number }> = [];
  for (let i = 0; i < rates.length; i += 1) {
    for (let j = i + 1; j < rates.length; j += 1) {
      const a = rates[i];
      const b = rates[j];
      if (a === undefined || b === undefined || a.status === 'retired' || b.status === 'retired') continue;
      if (a.provider !== b.provider || a.model !== b.model || a.unitType !== b.unitType) continue;
      const fromA = Date.parse(a.effectiveFrom);
      const toA = a.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(a.effectiveTo);
      const fromB = Date.parse(b.effectiveFrom);
      const toB = b.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(b.effectiveTo);
      if (fromA < toB && fromB < toA) pairs.push({ i, j });
    }
  }
  return pairs;
}

export const PricingRateTableSchema = z.array(PricingRateSchema).superRefine((rates, ctx) => {
  const seen = new Map<string, number>();
  rates.forEach((rate, index) => {
    const key = `${rate.provider}\u0000${rate.model}\u0000${rate.unitType}\u0000${rate.priceVersion}`;
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, index);
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'DUP_PRICE_VERSION', firstIndex: first },
      message: `priceVersion ${rate.priceVersion} is already used for this provider/model/unit at index ${first}`,
      path: [index, 'priceVersion'],
    });
  });
  for (const { i, j } of findRateOverlaps(rates)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { rule: 'OVERLAPPING_PRICE_WINDOW', firstIndex: i },
      message: `pricing window overlaps the row at index ${i}`,
      path: [j, 'effectiveFrom'],
    });
  }
});
export type PricingRateTable = z.infer<typeof PricingRateTableSchema>;

const RateLookupQuerySchema = z
  .object({
    provider: SafeIdSchema,
    model: SafeIdSchema,
    unitType: PricingUnitTypeSchema,
    at: TimestampSchema,
  })
  .strict();
export type RateLookupQuery = z.infer<typeof RateLookupQuerySchema>;

/** Resolve the published rate effective at a specific instant. Draft/review
 * rows are never used for billing, retired rows remain historical records but
 * are not candidates, and the effectiveTo boundary is exclusive. */
export function resolveRate(
  rates: readonly PricingRate[],
  query: RateLookupQuery,
): PricingRate | undefined {
  const table = PricingRateTableSchema.parse([...rates]);
  const lookup = RateLookupQuerySchema.parse(query);
  const atMs = Date.parse(lookup.at);
  const matches = table.filter((rate) => {
    if (
      rate.status !== 'published' ||
      rate.provider !== lookup.provider ||
      rate.model !== lookup.model ||
      rate.unitType !== lookup.unitType
    ) {
      return false;
    }
    const from = Date.parse(rate.effectiveFrom);
    const to = rate.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(rate.effectiveTo);
    return from <= atMs && atMs < to;
  });
  if (matches.length > 1) {
    throw new Error(
      `PRICING_RATE_OVERLAP: ${matches.length} published rates match '${lookup.provider}/${lookup.model}/${lookup.unitType}' at ${lookup.at}`,
    );
  }
  return matches[0];
}

/**
 * Which price applied at the time of the call? (docs view #4: "Giá và ngân
 * sách nào có hiệu lực tại thời điểm gọi"). Boundary semantics: from is
 * inclusive, to is exclusive; timestamps compare as instants, so UTC 'Z' and
 * '+07:00' offsets interleave correctly.
 */
export function resolvePricingTier(
  tiers: readonly ModelPricingTier[],
  query: { modelId: string; at: string; provider?: string },
): ModelPricingTier | undefined {
  const atMs = Date.parse(query.at);
  if (!Number.isFinite(atMs)) {
    throw new RangeError('query.at must be a valid RFC 3339 timestamp');
  }
  const matches = tiers.filter((tier) => {
    if (tier.modelId !== query.modelId) return false;
    if (query.provider !== undefined && tier.provider !== query.provider) return false;
    const from = Date.parse(tier.effectiveFrom);
    const to = tier.effectiveTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(tier.effectiveTo);
    return from <= atMs && atMs < to;
  });
  if (matches.length > 1) {
    throw new Error(
      `PRICING_OVERLAP: ${matches.length} tiers are effective for '${query.modelId}' at ${query.at}; the table failed findPricingOverlaps`,
    );
  }
  return matches[0];
}

/* ------------------------------------------------------------------ */
/* Boundary parser: authored USD -> integer micro-USD (never float)    */
/* ------------------------------------------------------------------ */

const PLAIN_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

function toPlainDecimalText(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('USD rate must be a finite number');
    }
    // String() yields the shortest round-trip decimal, so authoring values
    // like 2.5 pass; float artifacts like 0.1+0.2 -> '0.30000000000000004'
    // exceed 6 fractional digits and fail the pattern below. Exponential
    // forms ('1e+21', '1e-7') also fail it instead of being silently widened.
    return String(value);
  }
  return value;
}

/**
 * Convert an authored USD-per-million rate into integer micro-USD-per-million
 * with exact decimal arithmetic (BigInt). Rejects: non-plain-decimal text,
 * exponents, negatives, > 6 fractional digits (sub-micro precision), and
 * results beyond Number.MAX_SAFE_INTEGER.
 */
export function parseUsdPerMillionToMicrousd(value: string | number): number {
  const text = toPlainDecimalText(value);
  if (!PLAIN_DECIMAL_PATTERN.test(text)) {
    throw new RangeError(
      `USD rate must be a plain non-negative decimal with at most 6 fractional digits, got '${text}'`,
    );
  }
  const dot = text.indexOf('.');
  const wholeText = dot === -1 ? text : text.slice(0, dot);
  const fracText = dot === -1 ? '' : text.slice(dot + 1);
  const micros =
    BigInt(wholeText) * BigInt(MICROUSD_PER_USD) + BigInt(fracText.padEnd(6, '0'));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('USD rate exceeds the safe integer range in micro-USD');
  }
  return Number(micros);
}

/** Packet-shaped authoring input (USD per 1M tokens per rate); converted to
 * the canonical integer micro-USD tier exactly once, here. */
export const ModelPricingTierUsdInputSchema = z
  .object({
    provider: SafeIdSchema.optional(),
    modelId: SafeIdSchema,
    priceVersion: z.number().int().min(1),
    effectiveFrom: TimestampSchema,
    effectiveTo: TimestampSchema.optional(),
    inputCostPerMillionTokensUsd: z.union([z.string(), z.number()]),
    outputCostPerMillionTokensUsd: z.union([z.string(), z.number()]),
    cachedInputCostPerMillionTokensUsd: z.union([z.string(), z.number()]).optional(),
  })
  .strict();
export type ModelPricingTierUsdInput = z.input<typeof ModelPricingTierUsdInputSchema>;

export function pricingTierFromUsd(input: ModelPricingTierUsdInput): ModelPricingTier {
  const draft = ModelPricingTierUsdInputSchema.parse(input);
  return ModelPricingTierSchema.parse({
    provider: draft.provider,
    modelId: draft.modelId,
    priceVersion: draft.priceVersion,
    effectiveFrom: draft.effectiveFrom,
    effectiveTo: draft.effectiveTo,
    currency: 'USD',
    inputMicrousdPerMillion: parseUsdPerMillionToMicrousd(draft.inputCostPerMillionTokensUsd),
    outputMicrousdPerMillion: parseUsdPerMillionToMicrousd(draft.outputCostPerMillionTokensUsd),
    cachedInputMicrousdPerMillion:
      draft.cachedInputCostPerMillionTokensUsd === undefined
        ? undefined
        : parseUsdPerMillionToMicrousd(draft.cachedInputCostPerMillionTokensUsd),
  });
}

/* ------------------------------------------------------------------ */
/* Cost engine - pure integer arithmetic, deterministic rounding       */
/* ------------------------------------------------------------------ */

/** A billable unit is present on the usage but has no rate on the tier.
 * Silence would under-bill, so the engine fails closed instead of returning
 * a partial cost. */
export class PricingUnpricedUnitError extends Error {
  constructor(public readonly unit: 'pages') {
    super(`UNPRICED_BILLABLE_UNIT: usage carries '${unit}' but the price tier defines no rate for it`);
    this.name = 'PricingUnpricedUnitError';
  }
}

const TOKENS_PER_MILLION_BIG = BigInt(TOKENS_PER_MILLION);

/** units * rate / 1e6 with exact BigInt math, rounded HALF-UP on the
 * remainder. Rounding is applied per line item (per billing unit), which is
 * what providers do; the SUM below stays integer-exact. */
function billTokens(units: bigint, microusdPerMillion: number): bigint {
  const numerator = units * BigInt(microusdPerMillion);
  const quotient = numerator / TOKENS_PER_MILLION_BIG;
  const remainder = numerator % TOKENS_PER_MILLION_BIG;
  return remainder * 2n >= TOKENS_PER_MILLION_BIG ? quotient + 1n : quotient;
}

/**
 * calculateOperationCost - self-computed cost of a usage record under a price
 * tier, in integer micro-USD. Inputs are RE-PARSED against their schemas
 * first, so hostile payloads (extra keys, broken token arithmetic, out-of-
 * range rates) fail closed before any number is produced.
 *
 * Semantics:
 * - cachedInputTokens are carved out of inputTokens and billed at
 *   cachedInputMicrousdPerMillion, or at the FULL input rate when the tier
 *   omits a cache rate (conservative default).
 * - pages (when > 0) require pageMicrousdPerPage on the tier, else
 *   PricingUnpricedUnitError.
 * - The result is an ESTIMATE under this tier; it is deliberately independent
 *   of usage.costMicrousd (provider-reported money is kept, displayed, and
 *   reconciled separately per docs COST-02 - "Giá provider báo về và giá tự
 *   tính hiển thị riêng").
 */
export function calculateOperationCost(
  usage: OperationUsageMetrics,
  pricing: ModelPricingTier,
): number {
  const u = OperationUsageMetricsSchema.parse(usage);
  const p = ModelPricingTierSchema.parse(pricing);
  if (u.pages !== undefined && u.pages > 0 && p.pageMicrousdPerPage === undefined) {
    throw new PricingUnpricedUnitError('pages');
  }
  const total =
    billTokens(BigInt(u.inputTokens - u.cachedInputTokens), p.inputMicrousdPerMillion) +
    billTokens(BigInt(u.cachedInputTokens), p.cachedInputMicrousdPerMillion ?? p.inputMicrousdPerMillion) +
    billTokens(BigInt(u.outputTokens), p.outputMicrousdPerMillion) +
    BigInt(u.pages ?? 0) * BigInt(p.pageMicrousdPerPage ?? 0);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('computed cost exceeds the safe integer range in micro-USD');
  }
  return Number(total);
}
