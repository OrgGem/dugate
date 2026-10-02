import { AnalyzeAction } from '../src/actions/analyze';
import { ExtractAction } from '../src/actions/extract';
import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { VARIANT_TRACEABILITY_MATRIX, verifyTraceabilityMatrix } from '../src/manifest/traceability';
import { RecipeRegistry } from '../src/recipes/recipe-definitions';
import { MockTaskContext } from './fixtures/mock-context';

describe('COMP-04b document-core missing variants', () => {
  it('registers all 31 variants, including the three additions, without changing action count', () => {
    expect(documentCoreManifest.actions).toHaveLength(7);
    expect(RecipeRegistry.getAllRecipes()).toHaveLength(31);
    expect(VARIANT_TRACEABILITY_MATRIX).toHaveLength(31);
    expect(verifyTraceabilityMatrix()).toEqual({ valid: true, errors: [] });

    const variantCounts = VARIANT_TRACEABILITY_MATRIX.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.action] = (counts[entry.action] ?? 0) + 1;
      return counts;
    }, {});
    expect(variantCounts).toEqual({ ingest: 4, extract: 6, analyze: 7, transform: 5, generate: 6, compare: 3 });

    const extractSchema = documentCoreManifest.actions.find((action) => action.name === 'extract')!.inputSchema;
    const analyzeSchema = documentCoreManifest.actions.find((action) => action.name === 'analyze')!.inputSchema;
    const extractProperties = extractSchema.properties as Record<string, unknown>;
    const analyzeProperties = analyzeSchema.properties as Record<string, unknown>;
    expect((extractProperties.type as { enum: string[] }).enum).toContain('id-card');
    expect((analyzeProperties.task as { enum: string[] }).enum).toEqual(
      expect.arrayContaining(['fact-check', 'summarize-eval'])
    );

    expect(RecipeRegistry.getRecipe('extract', 'id-card').steps.some((step) => step.requiredSlot === 'reasoning')).toBe(
      true
    );
    expect(RecipeRegistry.getRecipe('analyze', 'fact-check').steps.filter((step) => !step.isLocalOnly)).toHaveLength(2);
    expect(RecipeRegistry.getRecipe('analyze', 'summarize-eval').steps.some((step) => !step.isLocalOnly)).toBe(true);
  });

  it('extracts and validates identity document fields through the reasoning connector', async () => {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = {
      invocationId: 'id-card-extraction',
      status: 'SUCCESS',
      data: {
        identityNumber: '079203001234',
        fullName: 'Nguyen Thi An',
        dateOfBirth: '2003-02-01',
        documentType: 'national-id',
      },
    };

    const input = ExtractAction.validateInput({ type: 'id-card', text: 'Identity document text' });
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(ctx, input);
    const result = await ExtractAction.executeRecipe(ctx, recipe, input, sources);
    const validated = ExtractAction.validateResult(result, 'id-card') as Record<string, unknown>;

    expect(validated.identityNumber).toBe('079203001234');
    expect(ctx.connectorInvocations).toHaveLength(1);
    expect(ctx.connectorInvocations[0]!.slot).toBe('reasoning');
    expect((ctx.connectorInvocations[0]!.payload as { payload: { promptText: string } }).payload.promptText).toContain(
      'identity document fields'
    );
    expect(() => ExtractAction.validateResult({ unrelated: true }, 'id-card')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  it('fact-checks extracted document claims against required reference data in two checkpointed calls', async () => {
    const ctx = new MockTaskContext();
    const invoke = jest
      .spyOn(ctx.connector, 'invoke')
      .mockResolvedValueOnce({
        invocationId: 'fact-check-extract',
        status: 'SUCCESS',
        data: { contractTerm: '24 months', interestRate: '5%' },
      })
      .mockResolvedValueOnce({
        invocationId: 'fact-check-verify',
        status: 'SUCCESS',
        data: {
          verdict: 'PASS',
          score: 100,
          summary: 'The extracted values match the supplied reference.',
          checks: [{ rule: 'term', status: 'PASS', document_value: '24 months', reference_value: '24 months' }],
          discrepancies: [],
        },
      });

    expect(() => AnalyzeAction.validateInput({ task: 'fact-check', text: 'A contract.' })).toThrow(
      expect.objectContaining({ code: 'MISSING_REQUIRED_PARAMETER' })
    );

    const input = AnalyzeAction.validateInput({
      task: 'fact-check',
      text: 'The contract term is 24 months and the interest rate is 5%.',
      reference_data: { contractTerm: '24 months', interestRate: '5%' },
      extract_fields: ['contractTerm', 'interestRate'],
    });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = await AnalyzeAction.executeRecipe(ctx, recipe, input, sources);
    const validated = AnalyzeAction.validateResult(result, 'fact-check') as Record<string, unknown>;

    expect(validated.verdict).toBe('PASS');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![1]).toMatchObject({
      task: 'analyze_fact_check_extract_claims',
      payload: { extractFields: ['contractTerm', 'interestRate'] },
    });
    expect(invoke.mock.calls[0]![1]).not.toMatchObject({ payload: { referenceData: expect.anything() } });
    expect(invoke.mock.calls[1]![1]).toMatchObject({
      task: 'analyze_fact_check_verify_claims',
      payload: {
        extractedClaims: { contractTerm: '24 months', interestRate: '5%' },
        referenceData: { contractTerm: '24 months', interestRate: '5%' },
      },
    });
    expect(ctx.checkpointsStore.has('analyze:fact-check-extract-claims')).toBe(true);
    expect(ctx.checkpointsStore.has('analyze:fact-check-verify-claims')).toBe(true);
    expect(() => AnalyzeAction.validateResult({ verdict: 'UNKNOWN', summary: 'bad', checks: [] }, 'fact-check')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  it('returns a combined summary and author-perspective evaluation for summarize-eval', async () => {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = {
      invocationId: 'summary-evaluation',
      status: 'SUCCESS',
      data: {
        summary: 'The essay argues for public transit investment and describes its expected benefits.',
        evaluation: {
          overallAssessment: 'The argument is coherent but would benefit from cost evidence.',
          authorPerspective: 'The author favors expanding public transit.',
          strengths: ['Clear thesis'],
          concerns: ['No budget estimate'],
        },
      },
    };

    const input = AnalyzeAction.validateInput({ task: 'summarize-eval', text: 'An essay about public transit.' });
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(ctx, input);
    const result = await AnalyzeAction.executeRecipe(ctx, recipe, input, sources);
    const validated = AnalyzeAction.validateResult(result, 'summarize-eval') as Record<string, unknown>;

    expect(validated.summary).toContain('public transit');
    expect(validated.evaluation).toMatchObject({ authorPerspective: 'The author favors expanding public transit.' });
    expect(ctx.connectorInvocations).toHaveLength(1);
    expect(ctx.connectorInvocations[0]!.payload).toMatchObject({
      task: 'analyze_summarize-eval',
      payload: { summaryRequirements: expect.any(String), evaluationRequirements: expect.any(String) },
    });
    expect(() => AnalyzeAction.validateResult({ summary: 'Only a summary.' }, 'summarize-eval')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });
});
