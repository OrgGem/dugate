import {
  MICROUSD_PER_USD,
  OperationUsageMetricsSchema,
  OperationUsageMetricsViewSchema,
  ProviderUsageWireSchema,
  UsageLedgerEventSchema,
  formatMicrousdAsUsd,
  metricsFromProviderUsage,
  toOperationUsageMetricsView,
  usageMetricsLogFields,
} from '../src/usage-metrics';
import {
  OperationUsageMetricsSchema as ViaIndexSchema,
  UsageEventSchema,
  UsageLedgerEventSchema as ViaIndexLedgerEventSchema,
} from '../src/index';

/**
 * COST-01 usage-metrics contract tests (W-COST-SCHEMA-LEDGER-1) — offline,
 * zero DB/Redis.
 * Positive: canonical metrics, full-attribution ledger events, provider-wire
 * mapping and display-only USD all parse with documented defaults.
 * Negative (win = fail closed): unknown/prompt keys rejected by .strict();
 * total/cached arithmetic invariants rejected; pending/unpriced carrying cost
 * rejected; corrections without a parent (and initial with one) rejected;
 * free-text IDs rejected; provider extras never cross the boundary.
 * Regression: the pre-existing UsageEventSchema still parses unchanged.
 */

const OP_ID = '3f0c6f1e-9a2b-4c8d-8f1a-2b3c4d5e6f70';
const TASK_ID = '4a1d7e2f-8b3c-4d9e-9f2b-3c4d5e6f7081';

const VALID_METRICS = {
  operationId: OP_ID,
  inputTokens: 1200,
  outputTokens: 300,
  cachedInputTokens: 400,
  totalTokens: 1500,
  costMicrousd: 4200,
  costStatus: 'measured' as const,
  durationMs: 8750,
};

const VALID_LEDGER_EVENT = {
  eventId: 'e'.repeat(64),
  idempotencyKey: 'usage-evt-2026-09-26-0001',
  kind: 'initial' as const,
  tenantId: 'tenant-7',
  apiKeyId: 'ak_9f2b3c4d',
  operationId: OP_ID,
  taskId: TASK_ID,
  invocationId: 'inv-2026-09-26-0001',
  attempt: 2,
  stepKey: 'reason.summarize',
  businessId: 'document-core',
  businessVersion: 'v3',
  action: 'extract',
  profileRevision: 14,
  connectorId: 'connector-openai',
  connectorRevision: 6,
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  unitType: 'tokens' as const,
  units: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 400 },
  costMicrousd: 4200,
  costStatus: 'measured' as const,
  durationMs: 8750,
  occurredAt: '2026-09-26T01:59:00Z',
  receivedAt: '2026-09-26T02:00:30+07:00',
};

describe('OperationUsageMetricsSchema', () => {
  it('is re-exported unchanged from the package entrypoint', () => {
    expect(ViaIndexSchema).toBeDefined();
    expect(ViaIndexSchema.safeParse(VALID_METRICS).success).toBe(true);
  });

  it('parses valid metrics and applies documented zero defaults', () => {
    const parsed = OperationUsageMetricsSchema.parse({
      operationId: OP_ID,
      totalTokens: 0,
      costStatus: 'pending',
      durationMs: 0,
    });
    expect(parsed).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costMicrousd: 0,
      costStatus: 'pending',
    });
  });

  it('rejects unknown keys — prompt/text/secret fields cannot enter the ledger', () => {
    for (const extra of [
      { prompt: 'PROMPT_SENTINEL_secret' },
      { promptContent: 'PROMPT_SENTINEL_secret' },
      { completion: 'COMPLETION_SENTINEL_secret' },
      { messages: [{ role: 'user', content: 'x' }] },
      { signedUrl: 'https://s3.example/o?X-Amz-Signature=abc' },
      { apiKey: 'sk-live-secret' },
    ]) {
      const result = OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, ...extra });
      expect(result.success).toBe(false);
    }
  });

  it('enforces total = input + output and cached <= input', () => {
    expect(
      OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, totalTokens: 1501 }).success,
    ).toBe(false);
    expect(
      OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, cachedInputTokens: 1201 }).success,
    ).toBe(false);
  });

  it('rejects non-integer or negative token/cost/duration values (0 is the floor)', () => {
    expect(
      OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, inputTokens: -1, totalTokens: 299 }).success,
    ).toBe(false);
    expect(
      OperationUsageMetricsSchema.safeParse({
        ...VALID_METRICS,
        inputTokens: 1200.5,
        outputTokens: 299.5,
        totalTokens: 1500,
      }).success,
    ).toBe(false);
    expect(
      OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, durationMs: 12.5 }).success,
    ).toBe(false);
  });

  it('locks pending/unpriced to zero cost so missing data never reads as settled', () => {
    for (const costStatus of ['pending', 'unpriced'] as const) {
      expect(
        OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, costStatus }).success,
      ).toBe(false); // inherited costMicrousd=4200
      expect(
        OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, costStatus, costMicrousd: 0 }).success,
      ).toBe(true);
    }
    expect(
      OperationUsageMetricsSchema.safeParse({ ...VALID_METRICS, costStatus: 'estimated' }).success,
    ).toBe(true);
  });
});

describe('formatMicrousdAsUsd + view model', () => {
  it('formats via integer arithmetic without float artifacts', () => {
    expect(MICROUSD_PER_USD).toBe(1_000_000);
    expect(formatMicrousdAsUsd(0)).toBe('0.000000');
    expect(formatMicrousdAsUsd(1)).toBe('0.000001');
    expect(formatMicrousdAsUsd(4200)).toBe('0.004200');
    expect(formatMicrousdAsUsd(1_234_567)).toBe('1.234567');
    expect(formatMicrousdAsUsd(99 * MICROUSD_PER_USD)).toBe('99.000000');
  });

  it('refuses to format non-integer or negative micro-USD', () => {
    expect(() => formatMicrousdAsUsd(-1)).toThrow(RangeError);
    expect(() => formatMicrousdAsUsd(0.5)).toThrow(RangeError);
    expect(() => formatMicrousdAsUsd(Number.NaN)).toThrow(RangeError);
  });

  it('derives display-only costEstimateUsd and settles only measured cost', () => {
    const view = toOperationUsageMetricsView(
      OperationUsageMetricsSchema.parse(VALID_METRICS),
    );
    expect(view.costEstimateUsd).toBe('0.004200');
    expect(view.costSettled).toBe(true);
    const pendingView = toOperationUsageMetricsView(
      OperationUsageMetricsSchema.parse({ ...VALID_METRICS, costStatus: 'pending', costMicrousd: 0 }),
    );
    expect(pendingView.costEstimateUsd).toBe('0.000000');
    expect(pendingView.costSettled).toBe(false);
  });

  it('rejects tampered views (display string or settled flag inconsistent with the ledger int)', () => {
    const view = toOperationUsageMetricsView(OperationUsageMetricsSchema.parse(VALID_METRICS));
    expect(
      OperationUsageMetricsViewSchema.safeParse({ ...view, costEstimateUsd: '9.999999' }).success,
    ).toBe(false);
    expect(
      OperationUsageMetricsViewSchema.safeParse({ ...view, costSettled: false }).success,
    ).toBe(false);
    expect(
      OperationUsageMetricsViewSchema.safeParse({ ...view, prompt: 'PROMPT_SENTINEL' }).success,
    ).toBe(false);
  });
});

describe('metricsFromProviderUsage (provider wire boundary)', () => {
  it('maps OpenAI-style snake_case usage to canonical camelCase metrics', () => {
    const metrics = metricsFromProviderUsage({
      operationId: OP_ID,
      providerUsage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 400, audio_tokens: 7 },
      },
      durationMs: 8750,
      costMicrousd: 4200,
      costStatus: 'measured',
    });
    expect(metrics).toMatchObject({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 400,
      totalTokens: 1500,
    });
    expect(metrics).not.toHaveProperty('audio_tokens');
  });

  it('computes total when the provider omits it and zeroes absent fields', () => {
    const metrics = metricsFromProviderUsage({
      operationId: OP_ID,
      providerUsage: { prompt_tokens: 10, completion_tokens: 5 },
      durationMs: 1,
      costStatus: 'estimated',
    });
    expect(metrics.totalTokens).toBe(15);
    expect(metrics.cachedInputTokens).toBe(0);
    expect(metrics.costMicrousd).toBe(0);
  });

  it('drops every non-allowlisted provider field — sentinels cannot cross the boundary', () => {
    const hostile = {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: {
        cached_tokens: 400,
        echoed_prompt: 'PROMPT_ECHO_SENTINEL_sensitive-text',
        api_key: 'sk-live-WIRE_SENTINEL_123456',
      },
      system_fingerprint: 'FINGERPRINT_SENTINEL_abc',
      completion_echo: 'COMPLETION_ECHO_SENTINEL_sensitive-text',
      raw_body: 'RAW_BODY_SENTINEL',
      url: 'https://s3.example/o?X-Amz-Signature=SIG_SENTINEL',
    };
    const wire = ProviderUsageWireSchema.parse(hostile);
    expect(wire).toHaveProperty('system_fingerprint'); // tolerated on the wire…
    const metrics = metricsFromProviderUsage({
      operationId: OP_ID,
      providerUsage: hostile,
      durationMs: 8750,
      costMicrousd: 4200,
      costStatus: 'measured',
    });
    const serialized = JSON.stringify(metrics); // …but never in the ledger record.
    for (const sentinel of [
      'PROMPT_ECHO_SENTINEL',
      'WIRE_SENTINEL',
      'FINGERPRINT_SENTINEL',
      'COMPLETION_ECHO_SENTINEL',
      'RAW_BODY_SENTINEL',
      'SIG_SENTINEL',
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(Object.keys(metrics).sort()).toEqual(
      ['cachedInputTokens', 'costMicrousd', 'costStatus', 'durationMs', 'inputTokens', 'operationId', 'outputTokens', 'totalTokens'].sort(),
    );
  });

  it('fails closed on provider drift or malformed usage', () => {
    expect(() =>
      metricsFromProviderUsage({
        operationId: OP_ID,
        providerUsage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 },
        durationMs: 1,
        costStatus: 'estimated',
      }),
    ).toThrow(); // total conflict is surfaced, not silently fixed
    expect(() =>
      metricsFromProviderUsage({
        operationId: OP_ID,
        providerUsage: { prompt_tokens: 'many' },
        durationMs: 1,
        costStatus: 'estimated',
      }),
    ).toThrow();
    expect(() =>
      metricsFromProviderUsage({
        operationId: OP_ID,
        providerUsage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 'lots' } },
        durationMs: 1,
        costStatus: 'estimated',
      }),
    ).toThrow(); // a non-number in a nested numeric slot fails closed; it never defaults to 0
  });
});

describe('UsageLedgerEventSchema (COST-01 attribution)', () => {
  it('parses the full-attribution happy path and defaults currency', () => {
    const parsed = UsageLedgerEventSchema.parse(VALID_LEDGER_EVENT);
    expect(ViaIndexLedgerEventSchema.safeParse(VALID_LEDGER_EVENT).success).toBe(true);
    expect(parsed.currency).toBe('USD');
    expect(parsed.kind).toBe('initial');
    expect(parsed.units.cachedInputTokens).toBe(400);
    expect(parsed.idempotencyKey).toBe('usage-evt-2026-09-26-0001');
    expect(parsed.unitType).toBe('tokens');
  });

  it('requires every attribution and event identity dimension', () => {
    for (const missing of [
      'idempotencyKey',
      'tenantId',
      'apiKeyId',
      'operationId',
      'taskId',
      'invocationId',
      'attempt',
      'businessId',
      'action',
      'businessVersion',
      'profileRevision',
      'connectorId',
      'connectorRevision',
      'provider',
      'model',
      'unitType',
      'occurredAt',
      'receivedAt',
    ] as const) {
      const { [missing]: _omitted, ...rest } = VALID_LEDGER_EVENT;
      expect(UsageLedgerEventSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('keeps the request idempotency key opaque and validates the unit family', () => {
    expect(
      UsageLedgerEventSchema.safeParse({
        ...VALID_LEDGER_EVENT,
        idempotencyKey: 'same-key-on-retry',
      }).success,
    ).toBe(true);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, idempotencyKey: 'key with spaces' }).success,
    ).toBe(false);
    expect(UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, unitType: 'tokens' }).success).toBe(true);
    expect(
      UsageLedgerEventSchema.safeParse({
        ...VALID_LEDGER_EVENT,
        unitType: 'pages',
        units: { inputTokens: 0, outputTokens: 0, pages: 2 },
      }).success,
    ).toBe(true);
    expect(
      UsageLedgerEventSchema.safeParse({
        ...VALID_LEDGER_EVENT,
        unitType: 'mixed',
        units: { inputTokens: 1200, outputTokens: 300, pages: 2 },
      }).success,
    ).toBe(true);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, unitType: 'pages' }).success,
    ).toBe(false);
    expect(UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, unitType: 'requests' }).success).toBe(false);
  });

  it('rejects free-text or oversized IDs (sanitized identifiers only)', () => {
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, apiKeyId: 'sk-live-actual-key-material' }).success,
    ).toBe(true); // pattern-safe opaque id shape; key material never validated by content
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, apiKeyId: 'has spaces in it' }).success,
    ).toBe(false);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, model: 'x'.repeat(200) }).success,
    ).toBe(false);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, tenantId: '-leading-dash' }).success,
    ).toBe(false);
  });

  it('rejects prompt/secret keys anywhere in the event (strict, fail closed)', () => {
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, prompt: 'PROMPT_SENTINEL' }).success,
    ).toBe(false);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, units: { ...VALID_LEDGER_EVENT.units, content: 'CONTENT_SENTINEL' } }).success,
    ).toBe(false);
  });

  it('enforces correction linkage: initial forbids a parent, correction/refund require one, no self-links', () => {
    expect(
      UsageLedgerEventSchema.safeParse({
        ...VALID_LEDGER_EVENT,
        correctsEventId: 'a'.repeat(64),
      }).success,
    ).toBe(false); // kind defaults to initial
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, kind: 'correction' }).success,
    ).toBe(false);
    const linked = UsageLedgerEventSchema.safeParse({
      ...VALID_LEDGER_EVENT,
      eventId: 'correction-1',
      idempotencyKey: 'correction-request-1',
      kind: 'refund',
      correctsEventId: 'a'.repeat(64),
    });
    expect(linked.success).toBe(true);
    expect(
      UsageLedgerEventSchema.safeParse({
        ...VALID_LEDGER_EVENT,
        eventId: 'correction-2',
        idempotencyKey: 'correction-request-2',
        kind: 'correction',
        correctsEventId: 'correction-2',
      }).success,
    ).toBe(false);
  });

  it('pins correction/refund rows to a different id and rejects negative attempt or bad timestamps', () => {
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, attempt: 0 }).success,
    ).toBe(false);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, occurredAt: 'yesterday' }).success,
    ).toBe(false);
    expect(
      UsageLedgerEventSchema.safeParse({ ...VALID_LEDGER_EVENT, costStatus: 'pending', costMicrousd: 4200 }).success,
    ).toBe(false);
  });
});

describe('usageMetricsLogFields (logger redaction compatibility)', () => {
  const UNSAFE_KEY_SUBSTRINGS =
    /(token|key|secret|password|credential|authorization|grant|signature|cookie|webhook|payload|content|prompt|completion|messages|file|artifact|name|path|url|body|raw|bytes|base64|stack|cause|dsn|filename)/i;

  it('uses only scalar logger-safe field names so counters survive @du/observability redaction', () => {
    const fields = usageMetricsLogFields(OperationUsageMetricsSchema.parse(VALID_METRICS));
    for (const key of Object.keys(fields)) {
      expect(UNSAFE_KEY_SUBSTRINGS.test(key)).toBe(false);
    }
    expect(fields).toMatchObject({ unitsIn: 1200, unitsOut: 300, unitsTotal: 1500, microUsd: 4200, durationMs: 8750 });
    expect(JSON.stringify(fields)).not.toMatch(/PROMPT|sk-|Bearer/);
  });

  it('includes pages only when present and keeps every value scalar', () => {
    const bare = usageMetricsLogFields(
      OperationUsageMetricsSchema.parse({ ...VALID_METRICS, pages: undefined }),
    );
    expect(bare).not.toHaveProperty('pages');
    const withPages = usageMetricsLogFields(
      OperationUsageMetricsSchema.parse({ ...VALID_METRICS, pages: 12 }),
    );
    expect(withPages.pages).toBe(12);
    for (const value of Object.values(withPages)) {
      expect(['string', 'number']).toContain(typeof value);
    }
  });
});

describe('regression: existing usage wire contracts unchanged', () => {
  it('still parses the pre-existing UsageEventSchema shape', () => {
    expect(
      UsageEventSchema.safeParse({
        eventId: 'evt-1',
        invocationId: 'inv-1',
        operationId: OP_ID,
        taskId: TASK_ID,
        units: { inputTokens: 10, outputTokens: 5 },
        costMicrousd: 100,
        measurement: 'measured',
        occurredAt: '2026-09-26T01:00:00Z',
      }).success,
    ).toBe(true);
  });
});
