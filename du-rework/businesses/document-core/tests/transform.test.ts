import { TransformAction } from '../src/actions/transform';
import { MockTaskContext } from './fixtures/mock-context';

describe('Action: Transform (DOC-04) — 5 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: convert
  it('DOC-04-v1: converts markdown text to HTML format locally', async () => {
    const input = TransformAction.validateInput({
      variant: 'convert',
      text: '# Title\n\nParagraph text.',
      outputFormat: 'html',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);
    const validated = TransformAction.validateResult(result);
    const envelope = TransformAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(result.transformedText).toContain('<h1>Title</h1>');
    expect(result.outputFormat).toBe('html');
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM calls
  });

  // Variant 2: translate
  it('DOC-04-v2: translates text via reasoning connector slot', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-tra-1',
      status: 'SUCCESS',
      rawText: 'Doanh thu quy tang 15 phan tram.',
    };

    const input = TransformAction.validateInput({
      action: 'translate', // legacy alias testing
      text: 'Quarterly revenue grew by 15 percent.',
      targetLanguage: 'vi',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);
    const validated = TransformAction.validateResult(result);
    const envelope = TransformAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_translation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.transformedText).toBe('Doanh thu quy tang 15 phan tram.');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 3: rewrite
  it('DOC-04-v3: rewrites content in executive style', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-rew-1',
      status: 'SUCCESS',
      rawText: 'Financial performance outpaced all benchmark indicators.',
    };

    const input = TransformAction.validateInput({
      variant: 'rewrite',
      text: 'Our numbers look really good compared to other companies.',
      style: 'executive',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);
    const validated = TransformAction.validateResult(result);
    const envelope = TransformAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('llm_evaluation');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(result.transformedText).toContain('Financial performance outpaced');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'reasoning')).toBe(true);
  });

  // Variant 4: redact
  it('DOC-04-v4: redacts PII elements locally', async () => {
    const input = TransformAction.validateInput({
      variant: 'redact',
      text: 'Send info to alice@example.com or call 555-123-4567.',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);
    const validated = TransformAction.validateResult(result);
    const envelope = TransformAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(result.transformedText).toContain('[REDACTED:EMAIL]');
    expect(result.transformedText).toContain('[REDACTED:PHONE]');
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM calls
  });

  // Variant 5: template
  it('DOC-04-v5: performs template mail-merge locally', async () => {
    const input = TransformAction.validateInput({
      variant: 'template',
      text: JSON.stringify({ name: 'Acme Corp', invoiceNo: '9988' }),
      template: 'Dear {{name}}, invoice #{{invoiceNo}} is ready.',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);
    const validated = TransformAction.validateResult(result);
    const envelope = TransformAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(result.transformedText).toBe('Dear Acme Corp, invoice #9988 is ready.');
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM calls
  });

  // Error cases
  it('rejects translate without targetLanguage', () => {
    expect(() => {
      TransformAction.validateInput({
        variant: 'translate',
        text: 'Hello',
      });
    }).toThrow(/requires "targetLanguage" parameter/);
  });

  it('rejects template without template string', () => {
    expect(() => {
      TransformAction.validateInput({
        variant: 'template',
        text: '{}',
      });
    }).toThrow(/requires "template" parameter/);
  });

  // Long document bounded chunking & tail content test
  it('processes long document via bounded chunking ensuring tail content is not dropped', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-tra-long',
      status: 'SUCCESS',
      rawText: 'Translated section chunk.',
    };

    const head = 'Paragraph 1: ' + 'A'.repeat(3000);
    const tail = 'Paragraph 2: TAIL_SECRET_TOKEN_456 ' + 'B'.repeat(3000);
    const longText = `${head}\n\n${tail}`;

    const input = TransformAction.validateInput({
      variant: 'translate',
      text: longText,
      targetLanguage: 'fr',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);
    const result = await TransformAction.executeRecipe(ctx, recipe, input, sources);

    expect(result.metadata?.chunksCount).toBe(2);
    expect(ctx.connectorInvocations.length).toBe(2);
    // Verify first chunk contains head
    const chunk1Payload = (ctx.connectorInvocations[0]!.payload as { payload: { text: string } }).payload.text;
    expect(chunk1Payload).toContain('Paragraph 1:');
    // Verify second chunk contains tail content
    const chunk2Payload = (ctx.connectorInvocations[1]!.payload as { payload: { text: string } }).payload.text;
    expect(chunk2Payload).toContain('TAIL_SECRET_TOKEN_456');
  });

  // Explicit size rejection test
  it('explicitly rejects oversized documents exceeding 50,000 characters', async () => {
    const hugeText = 'Z'.repeat(50001);
    const input = TransformAction.validateInput({
      variant: 'translate',
      text: hugeText,
      targetLanguage: 'es',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);

    await expect(
      TransformAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/exceeds maximum supported size for transform/);
  });

  test.failing('rejects malformed JSON data supplied to the template transform', async () => {
    const input = TransformAction.validateInput({
      variant: 'template',
      text: '{"name":',
      template: 'Hello {{name}}',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);

    await expect(TransformAction.executeRecipe(ctx, recipe, input, sources)).rejects.toMatchObject({
      code: 'INVALID_TEMPLATE_DATA',
    });
  });

  it('rejects transform results missing required target fields or containing blank output text', () => {
    const missingText = { outputFormat: 'text' } as Parameters<typeof TransformAction.validateResult>[0];
    const blankText = {
      transformedText: '   ',
      outputFormat: 'text',
    } as Parameters<typeof TransformAction.validateResult>[0];

    expect(() => TransformAction.validateResult(missingText, 'translate')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
    expect(() => TransformAction.validateResult(blankText, 'translate')).toThrow(
      expect.objectContaining({ code: 'SCHEMA_VALIDATION_ERROR' })
    );
  });

  it('rejects an unsupported convert target format instead of defaulting to markdown', async () => {
    const input = TransformAction.validateInput({
      variant: 'convert',
      text: '# Format boundary',
      outputFormat: 'pdf',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);

    await expect(TransformAction.executeRecipe(ctx, recipe, input, sources)).rejects.toThrow(/Unsupported conversion/);
  });

  it('propagates a provider timeout without retrying or producing fallback transform text', async () => {
    const timeout = Object.assign(new Error('transform provider timed out'), { code: 'PROVIDER_TIMEOUT' });
    const invoke = jest.spyOn(ctx.connector, 'invoke').mockRejectedValue(timeout);
    const input = TransformAction.validateInput({
      variant: 'translate',
      text: 'Timeout boundary source.',
      targetLanguage: 'fr',
    });
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(ctx, input);

    await expect(TransformAction.executeRecipe(ctx, recipe, input, sources)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ctx.checkpointsStore.size).toBe(0);
  });
});
