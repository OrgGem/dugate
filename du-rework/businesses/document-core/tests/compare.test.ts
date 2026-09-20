import { CompareAction } from '../src/actions/compare';
import { MockTaskContext } from './fixtures/mock-context';

describe('Action: Compare (DOC-06) — 3 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: diff
  it('DOC-06-v1: performs pure local text diff comparison', async () => {
    const input = CompareAction.validateInput({
      mode: 'diff',
      source: { text: 'Line 1\nLine 2' },
      target: { text: 'Line 1\nLine 2 modified\nLine 3' },
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);
    const result = (await CompareAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = CompareAction.validateResult(result);
    const envelope = CompareAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('diff');
    expect(result.method).toBe('native_diff');
    expect((result.diffStats as { additions: number }).additions).toBe(2);
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM calls
  });

  // Variant 2: semantic
  it('DOC-06-v2: performs semantic clause variance analysis via reasoning slot', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-cmp-2',
      status: 'SUCCESS',
      data: {
        overallSummary: 'Notice period increased from 30 to 60 days.',
        changes: [
          {
            clause: 'Termination',
            legalSignificance: 'HIGH',
            commentary: 'Notice requirement doubled',
          },
        ],
      },
    };

    const input = CompareAction.validateInput({
      mode: 'semantic',
      source: { text: 'Termination with 30 days notice.' },
      target: { text: 'Termination with 60 days notice.' },
      focus: 'termination notice',
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);
    const result = (await CompareAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = CompareAction.validateResult(result);
    const envelope = CompareAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.overallSummary).toContain('Notice period increased');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 3: version
  it('DOC-06-v3: synthesizes version changelog notes', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-cmp-3',
      status: 'SUCCESS',
      data: {
        versionSummary: 'Version 2.0 adds remote work policy and updates travel expense limits.',
        additions: ['Section 4: Remote Work'],
      },
    };

    const input = CompareAction.validateInput({
      mode: 'version',
      source: { text: 'Policy v1 text' },
      target: { text: 'Policy v2 text with remote work' },
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);
    const result = (await CompareAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = CompareAction.validateResult(result);
    const envelope = CompareAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.versionSummary).toContain('Version 2.0');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Error cases
  it('rejects compare when source side is missing', () => {
    expect(() => {
      CompareAction.validateInput({
        mode: 'diff',
        target: { text: 'some text' },
      });
    }).toThrow(/Missing required comparison side: "source"/);
  });

  it('rejects compare when target side is missing', () => {
    expect(() => {
      CompareAction.validateInput({
        mode: 'diff',
        source: { text: 'some text' },
      });
    }).toThrow(/Missing required comparison side: "target"/);
  });

  it('rejects compare when mode is missing', () => {
    expect(() => {
      CompareAction.validateInput({
        source: { text: 'a' },
        target: { text: 'b' },
      });
    }).toThrow(/Missing required discriminator: "mode"/);
  });

  // Tail preservation test
  it('preserves complete text beyond 3,000 chars ensuring tail content is not silently truncated', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-cmp-tail',
      status: 'SUCCESS',
      data: {
        summary: 'Both documents identical with tail clauses matching.',
      },
    };

    const prefixSource = 'Original clause section... '.padEnd(3500, '.');
    const tailSource = 'TAIL_SOURCE_ARBITRATION_CLAUSE';
    const sourceText = `${prefixSource}\n${tailSource}`;

    const prefixTarget = 'Modified clause section... '.padEnd(3500, '.');
    const tailTarget = 'TAIL_TARGET_LITIGATION_CLAUSE';
    const targetText = `${prefixTarget}\n${tailTarget}`;

    const input = CompareAction.validateInput({
      mode: 'semantic',
      source: { text: sourceText },
      target: { text: targetText },
      focus: 'arbitration vs litigation',
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);
    await CompareAction.executeRecipe(ctx, recipe, input, sources);

    expect(ctx.connectorInvocations.length).toBe(1);
    const payload = ctx.connectorInvocations[0]!.payload as {
      payload: { sourceSnippet: string; targetSnippet: string };
    };
    expect(payload.payload.sourceSnippet).toContain(tailSource);
    expect(payload.payload.targetSnippet).toContain(tailTarget);
  });

  // Explicit size rejection test
  it('explicitly rejects oversized documents exceeding 50,000 characters', async () => {
    const hugeText = 'C'.repeat(50001);
    const input = CompareAction.validateInput({
      mode: 'semantic',
      source: { text: hugeText },
      target: { text: 'Short target' },
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);

    await expect(
      CompareAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/exceeds maximum supported size for comparison/);
  });
});
