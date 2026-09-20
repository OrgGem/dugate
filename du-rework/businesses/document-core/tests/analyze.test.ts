import { AnalyzeAction } from '../src/actions/analyze';
import { MockTaskContext } from './fixtures/mock-context';

describe('Action: Analyze (DOC-03) — 5 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: classify
  it('DOC-03-v1: classifies document into target taxonomy category', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-1',
      status: 'SUCCESS',
      data: {
        category: 'invoice',
        confidence: 0.96,
        reasoning: 'Document contains tax invoice headers and VAT calculation',
      },
    };

    const input = AnalyzeAction.validateInput({
      task: 'classify',
      text: 'Invoice No: 123 Total: $500',
      categories: ['contract', 'invoice', 'resume'],
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = (await AnalyzeAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = AnalyzeAction.validateResult(result);
    const envelope = AnalyzeAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.category).toBe('invoice');
    expect(result.confidence).toBe(0.96);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 2: sentiment
  it('DOC-03-v2: evaluates sentiment polarity and explanation', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-2',
      status: 'SUCCESS',
      data: {
        sentiment: 'positive',
        score: 0.85,
        explanation: 'Customer praised the customer service and prompt delivery.',
      },
    };

    const input = AnalyzeAction.validateInput({
      task: 'sentiment',
      text: 'I love this service! Extremely fast delivery and polite staff.',
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = (await AnalyzeAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = AnalyzeAction.validateResult(result);
    const envelope = AnalyzeAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.sentiment).toBe('positive');
    expect(result.score).toBe(0.85);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 3: compliance
  it('DOC-03-v3: evaluates compliance against criteria rules', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-3',
      status: 'SUCCESS',
      data: {
        status: 'FAIL',
        score: 40,
        violations: [
          {
            rule: 'Must include two signatures',
            excerpt: 'Only Party A signed',
            severity: 'HIGH',
          },
        ],
      },
    };

    const input = AnalyzeAction.validateInput({
      task: 'compliance',
      text: 'Agreement signed only by Party A.',
      criteria: 'Must include signatures from both parties.',
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = (await AnalyzeAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = AnalyzeAction.validateResult(result);
    const envelope = AnalyzeAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.status).toBe('FAIL');
    expect((result.violations as Array<unknown>).length).toBe(1);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 4: quality
  it('DOC-03-v4: evaluates document writing quality and clarity', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-4',
      status: 'SUCCESS',
      data: {
        overallScore: 88,
        clarityScore: 90,
        grammarScore: 85,
        logicScore: 89,
        suggestions: ['Avoid run-on sentences in paragraph 2'],
      },
    };

    const input = AnalyzeAction.validateInput({
      task: 'quality',
      text: 'Sample essay or proposal text...',
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = (await AnalyzeAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = AnalyzeAction.validateResult(result);
    const envelope = AnalyzeAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.overallScore).toBe(88);
    expect(result.clarityScore).toBe(90);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 5: risk
  it('DOC-03-v5: identifies contractual risks and severity levels', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-5',
      status: 'SUCCESS',
      data: {
        riskLevel: 'CRITICAL',
        riskScore: 92,
        risks: [
          {
            type: 'Uncapped Liability',
            description: 'Clause 9 contains unlimited liability for consequential damages',
            severity: 'CRITICAL',
          },
        ],
      },
    };

    const input = AnalyzeAction.validateInput({
      task: 'risk',
      text: 'Clause 9: Supplier agrees to uncapped liability for any indirect losses.',
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = (await AnalyzeAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = AnalyzeAction.validateResult(result);
    const envelope = AnalyzeAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.riskLevel).toBe('CRITICAL');
    expect(result.riskScore).toBe(92);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Error cases
  it('rejects classify if categories parameter is missing', () => {
    expect(() => {
      AnalyzeAction.validateInput({
        task: 'classify',
        text: 'some text',
      });
    }).toThrow(/requires non-empty "categories" parameter/);
  });

  it('rejects compliance if criteria parameter is missing', () => {
    expect(() => {
      AnalyzeAction.validateInput({
        task: 'compliance',
        text: 'some text',
      });
    }).toThrow(/requires non-empty "criteria" parameter/);
  });

  it('rejects invalid sentiment findings missing allowed enum value', () => {
    expect(() => {
      AnalyzeAction.validateAnalysisFindings('sentiment', { sentiment: 'indifferent', score: 0 });
    }).toThrow(/Sentiment result must have valid "sentiment" enum value/);
  });

  // Tail preservation test
  it('preserves complete text beyond 4,000 chars ensuring tail content is not silently truncated', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ana-tail',
      status: 'SUCCESS',
      data: {
        category: 'contract',
        confidence: 0.99,
      },
    };

    const prefix = 'Document preface... '.padEnd(4500, '.');
    const tail = 'TAIL_IMPORTANT_ANALYZE_MARKER_789';
    const longText = `${prefix}\n${tail}`;

    const input = AnalyzeAction.validateInput({
      task: 'classify',
      text: longText,
      categories: ['contract', 'memo'],
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    await AnalyzeAction.executeRecipe(ctx, recipe, input, sources);

    expect(ctx.connectorInvocations.length).toBe(1);
    const payload = ctx.connectorInvocations[0]!.payload as { payload: { documentSnippet: string } };
    expect(payload.payload.documentSnippet).toContain(tail);
  });

  // Explicit size rejection test
  it('explicitly rejects oversized documents exceeding 50,000 characters', async () => {
    const hugeText = 'A'.repeat(50001);
    const input = AnalyzeAction.validateInput({
      task: 'classify',
      text: hugeText,
      categories: ['contract', 'invoice'],
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);

    await expect(
      AnalyzeAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/exceeds maximum supported size for analysis/);
  });
});
