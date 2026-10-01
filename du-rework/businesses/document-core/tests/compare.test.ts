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

  it.each(['diff', 'semantic', 'version'])('rejects a missing source or target for %s comparison', (mode) => {
    for (const missingSide of ['source', 'target']) {
      const payload: Record<string, unknown> = {
        mode,
        source: { text: 'source document' },
        target: { text: 'target document' },
      };
      delete payload[missingSide];

      expect(() => CompareAction.validateInput(payload)).toThrow(
        expect.objectContaining({ code: 'MISSING_COMPARISON_SIDE' })
      );
    }
  });

  it.each([
    ['diff', 'source', '  '],
    ['semantic', 'source', ''],
    ['version', 'target', '\t\n'],
  ])('rejects an empty %s document side for %s comparison', (mode, side, emptyText) => {
    const payload: Record<string, unknown> = {
      mode,
      source: { text: 'source document' },
      target: { text: 'target document' },
    };
    payload[side] = { text: emptyText };

    expect(() => CompareAction.validateInput(payload)).toThrow(
      expect.objectContaining({ code: 'INVALID_COMPARISON_SIDE' })
    );
  });

  it('rejects a diff result missing its required diff payload', () => {
    expect(() => CompareAction.validateResult({ diffStats: { additions: 1 } }, 'diff')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  test.failing('rejects malformed diff metadata with negative or non-integer counters', () => {
    expect(() => CompareAction.validateResult({
      unifiedDiff: '--- source\n+++ target',
      diffStats: { additions: -1, deletions: 0.5, unmodified: Number.NaN },
    }, 'diff')).toThrow(expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' }));
  });

  it.each([0, 1])('accepts semantic similarity at the schema boundary %s', (similarity) => {
    expect(() => CompareAction.validateResult({ similarity }, 'semantic')).not.toThrow();
  });

  it.each([-0.01, 1.01])('rejects semantic similarity outside the [0, 1] schema boundary: %s', (similarity) => {
    expect(() => CompareAction.validateResult({ similarity }, 'semantic')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  test.failing('rejects non-finite semantic similarity values', () => {
    expect(() => CompareAction.validateResult({ similarity: Number.NaN }, 'semantic')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  it('propagates a semantic comparison timeout without retrying or synthesizing a result', async () => {
    const timeout = Object.assign(new Error('semantic comparison timed out'), { code: 'PROVIDER_TIMEOUT' });
    const invoke = jest.spyOn(ctx.connector, 'invoke').mockRejectedValue(timeout);
    const input = CompareAction.validateInput({
      mode: 'semantic',
      source: { text: 'Current terms.' },
      target: { text: 'Proposed terms.' },
    });
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(ctx, input);

    await expect(CompareAction.executeRecipe(ctx, recipe, input, sources)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ctx.checkpointsStore.size).toBe(0);
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
