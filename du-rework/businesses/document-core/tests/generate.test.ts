import { GenerateAction } from '../src/actions/generate';
import { MockTaskContext } from './fixtures/mock-context';

describe('Action: Generate (DOC-05) — 6 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: summary
  it('DOC-05-v1: generates concise executive summary', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-1',
      status: 'SUCCESS',
      rawText: 'Key finding: Overall profit rose by 22% in 2026.',
    };

    const input = GenerateAction.validateInput({
      task: 'summary',
      text: 'Long quarterly financial overview with 50 pages of disclosures...',
      maxWords: 50,
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.content).toBe('Key finding: Overall profit rose by 22% in 2026.');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 2: outline
  it('DOC-05-v2: generates hierarchical document outline', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-2',
      status: 'SUCCESS',
      rawText: '# 1. Introduction\n## 1.1 Scope\n# 2. Financials',
    };

    const input = GenerateAction.validateInput({
      task: 'outline',
      text: 'Long document text...',
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.content).toContain('# 1. Introduction');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 3: report
  it('DOC-05-v3: synthesizes professional analytical report', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-3',
      status: 'SUCCESS',
      rawText: '## Executive Briefing\nSales performance highlights across sectors...',
    };

    const input = GenerateAction.validateInput({
      task: 'report',
      text: 'Sales raw tables and performance notes...',
      audience: 'Board of Directors',
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.content).toContain('Executive Briefing');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 4: email
  it('DOC-05-v4: drafts professional email response', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-4',
      status: 'SUCCESS',
      rawText: 'Dear Valued Customer,\nThank you for reaching out regarding your order...',
    };

    const input = GenerateAction.validateInput({
      task: 'email',
      text: 'Customer inquiry: Where is my order #1234?',
      tone: 'formal',
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.content).toContain('Dear Valued Customer');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 5: minutes
  it('DOC-05-v5: synthesizes meeting minutes with action items', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-5',
      status: 'SUCCESS',
      data: {
        meetingTopic: 'Sprint Planning',
        decisions: ['Approved scope for release 1.0'],
        actionItems: [{ assignee: 'John', task: 'Deploy staging' }],
      },
    };

    const input = GenerateAction.validateInput({
      task: 'minutes',
      text: 'Transcript: John said we should release v1.0. Mary agreed.',
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(result.meetingTopic).toBe('Sprint Planning');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 6: qa
  it('DOC-05-v6: answers questions with evidence from document', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-6',
      status: 'SUCCESS',
      data: {
        answers: [
          {
            question: 'What is the rent?',
            answer: '$3,500/month',
            evidenceQuote: 'rent is $3,500/month',
            confidence: 0.99,
          },
        ],
      },
    };

    const input = GenerateAction.validateInput({
      task: 'qa',
      text: 'Lease agreement: monthly rent is $3,500/month.',
      questions: ['What is the rent?'],
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = (await GenerateAction.executeRecipe(ctx, recipe, input, sources)) as Record<string, unknown>;
    const validated = GenerateAction.validateResult(result);
    const envelope = GenerateAction.formatResult(ctx, validated, 'json', input.task);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('grounded_qa');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect((result.answers as Array<unknown>).length).toBe(1);
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Error cases
  it('rejects qa without questions parameter', () => {
    expect(() => {
      GenerateAction.validateInput({
        task: 'qa',
        text: 'some text',
      });
    }).toThrow(/requires non-empty "questions" parameter/);
  });

  it('rejects qa when questions count exceeds 20 items', () => {
    const questions = Array.from({ length: 25 }, (_, i) => `Question ${i + 1}`);
    expect(() => {
      GenerateAction.validateInput({
        task: 'qa',
        text: 'some text',
        questions,
      });
    }).toThrow(/exceeds maximum allowed cap/);
  });

  it('rejects negative or zero maxWords', () => {
    expect(() => {
      GenerateAction.validateInput({
        task: 'summary',
        text: 'some text',
        maxWords: -10,
      });
    }).toThrow(/"maxWords" must be a positive integer/);
  });

  it('rejects malformed QA JSON payloads before returning a valid answer envelope', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-malformed-qa',
      status: 'SUCCESS',
      rawText: '{"answers":[',
    };
    const input = GenerateAction.validateInput({
      task: 'qa',
      text: 'A source for the malformed QA response.',
      questions: ['What is stated?'],
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    const result = await GenerateAction.executeRecipe(ctx, recipe, input, sources);

    expect(() => GenerateAction.validateResult(result, input.task)).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
    expect(ctx.connectorInvocations).toHaveLength(1);
  });

  test.failing('rejects malformed JSON for minutes instead of accepting the raw text fallback', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-malformed-minutes',
      status: 'SUCCESS',
      rawText: '{"meetingTopic":',
    };
    const input = GenerateAction.validateInput({ task: 'minutes', text: 'Meeting transcript.' });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);

    await expect((async () => {
      const result = await GenerateAction.executeRecipe(ctx, recipe, input, sources);
      return GenerateAction.validateResult(result, input.task);
    })()).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects generated output missing required content or QA answers', () => {
    expect(() => GenerateAction.validateResult({ extra: 'no content' }, 'summary')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
    expect(() => GenerateAction.validateResult({ answers: [] }, 'qa')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  test.failing('rejects an unsupported generation format before placing it in the prompt', async () => {
    const input = GenerateAction.validateInput({ task: 'outline', text: 'Outline source.', format: 'xml' });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);

    await expect(GenerateAction.executeRecipe(ctx, recipe, input, sources)).rejects.toMatchObject({
      code: 'INVALID_FORMAT',
    });
  });

  test.failing('rejects a fractional maxWords value at the prompt budget boundary', () => {
    expect(() => GenerateAction.validateInput({
      task: 'summary',
      text: 'Prompt budget boundary.',
      maxWords: 1.5,
    })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('preserves a prompt at the exact 50,000 character generation boundary', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-exact-prompt-boundary',
      status: 'SUCCESS',
      rawText: 'Boundary summary.',
    };
    const text = 'B'.repeat(50_000);
    const input = GenerateAction.validateInput({ task: 'summary', text });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    await GenerateAction.executeRecipe(ctx, recipe, input, sources);

    const payload = ctx.connectorInvocations[0]?.payload as { payload?: { documentSnippet?: string } };
    expect(payload.payload?.documentSnippet).toHaveLength(50_000);
  });

  it('propagates provider timeouts without retrying or synthesizing a fallback result', async () => {
    const timeout = Object.assign(new Error('generation provider timed out'), { code: 'PROVIDER_TIMEOUT' });
    const invoke = jest.spyOn(ctx.connector, 'invoke').mockRejectedValue(timeout);
    const input = GenerateAction.validateInput({ task: 'summary', text: 'Timeout boundary source.' });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);

    await expect(GenerateAction.executeRecipe(ctx, recipe, input, sources)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ctx.checkpointsStore.size).toBe(1);
  });

  // Tail preservation test
  it('preserves complete text beyond 4,000 chars ensuring tail content is not silently truncated', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-gen-tail',
      status: 'SUCCESS',
      rawText: 'Executive summary generated.',
    };

    const prefix = 'Document preface... '.padEnd(4500, '.');
    const tail = 'TAIL_IMPORTANT_GENERATE_MARKER_999';
    const longText = `${prefix}\n${tail}`;

    const input = GenerateAction.validateInput({
      task: 'summary',
      text: longText,
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);
    await GenerateAction.executeRecipe(ctx, recipe, input, sources);

    expect(ctx.connectorInvocations.length).toBe(1);
    const payload = ctx.connectorInvocations[0]!.payload as { payload: { documentSnippet: string } };
    expect(payload.payload.documentSnippet).toContain(tail);
  });

  // Explicit size rejection test
  it('explicitly rejects oversized documents exceeding 50,000 characters', async () => {
    const hugeText = 'G'.repeat(50001);
    const input = GenerateAction.validateInput({
      task: 'summary',
      text: hugeText,
    });
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(ctx, input);

    await expect(
      GenerateAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/exceeds maximum supported size for generation/);
  });
});
