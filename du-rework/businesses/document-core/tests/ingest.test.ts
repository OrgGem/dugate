import { IngestAction } from '../src/actions/ingest';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../packages/document-kit/tests/fixtures/test-fixtures';
import { PdfSplitter } from '../../../packages/document-kit/src/formats/pdf-splitter';

describe('Action: Ingest (DOC-01) — 4 Variants', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  // Variant 1: parse
  it('DOC-01-v1: executes native parse on document artifact', async () => {
    const csvBuf = TestFixtures.createSampleCsv();
    const artRef = await ctx.artifacts.write(csvBuf, 'accounts.csv', 'text/csv');

    const input = IngestAction.validateInput({
      mode: 'parse',
      artifactIds: [artRef.artifactId],
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);
    const result = await IngestAction.executeRecipe(ctx, recipe, input, sources);
    const validated = IngestAction.validateResult(result);
    const envelope = IngestAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(envelope.provenance.parserUsed).toMatch(/sheetjs|native-csv/);
    expect(result.markdown).toContain('| Item | Quantity | Price |');
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM provider calls
  });

  // Variant 2: ocr
  it('DOC-01-v2: dispatches to OCR connector slot with language hint', async () => {
    ctx.mockConnectorResponses.set('ocr', {
      invocationId: 'inv-ocr-1',
      status: 'SUCCESS',
      data: { text: 'Scanned receipt text', markdown: '# Scanned receipt' },
    });

    const input = IngestAction.validateInput({
      mode: 'ocr',
      text: 'image-placeholder',
      language: 'vie',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);
    const result = await IngestAction.executeRecipe(ctx, recipe, input, sources);
    const validated = IngestAction.validateResult(result);
    const envelope = IngestAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('ocr');
    expect(envelope.provenance.modelSlot).toBe('ocr');
    expect(result.text).toBe('Scanned receipt text');
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'ocr')).toBe(true);
  });

  // Variant 3: digitize
  it('DOC-01-v3: dispatches handwritten digitize to vision connector slot', async () => {
    ctx.mockConnectorResponses.set('vision', {
      invocationId: 'inv-vis-1',
      status: 'SUCCESS',
      data: {
        text: 'Patient Form',
        formFields: { patientName: 'John Doe', smoker: false },
      },
    });

    const input = IngestAction.validateInput({
      mode: 'digitize',
      text: 'form-placeholder',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);
    const result = await IngestAction.executeRecipe(ctx, recipe, input, sources);
    const validated = IngestAction.validateResult(result);
    const envelope = IngestAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('ocr');
    expect(envelope.provenance.modelSlot).toBe('vision');
    expect(result.formFields).toEqual({ patientName: 'John Doe', smoker: false });
    expect(ctx.connectorInvocations.some((inv) => inv.slot === 'vision')).toBe(true);
  });

  // Variant 4: split (single page)
  it('DOC-01-v4: splits PDF page and verifies valid generated PDF artifact buffer', async () => {
    const pdfBuf = TestFixtures.createSamplePdf('Page 1 content');
    const artRef = await ctx.artifacts.write(pdfBuf, 'doc.pdf', 'application/pdf');

    const input = IngestAction.validateInput({
      mode: 'split',
      artifactIds: [artRef.artifactId],
      pages: '1',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);
    const result = await IngestAction.executeRecipe(ctx, recipe, input, sources);
    const validated = IngestAction.validateResult(result);
    const envelope = IngestAction.formatResult(ctx, validated);

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(envelope.provenance.parserUsed).toBe('document-kit:pdf-splitter');
    expect(result.splitArtifacts?.length).toBe(1);

    const splitArtId = result.splitArtifacts![0]!.artifactId;
    const splitPdfBuffer = await ctx.artifacts.read(splitArtId);

    // Deep inspection of generated PDF artifact
    expect(splitPdfBuffer).toBeInstanceOf(Buffer);
    const pdfString = splitPdfBuffer.toString('utf8');
    expect(pdfString.startsWith('%PDF-')).toBe(true);
    expect(pdfString).toContain('%%EOF');
    expect(await PdfSplitter.getPageCount(splitPdfBuffer)).toBe(1);
    expect(ctx.connectorInvocations.length).toBe(0); // 0 LLM provider calls
  });

  // Variant 4: split (multi-page slicing)
  it('DOC-01-v4 (multi-page): slices multi-page PDF into valid 2-page artifact', async () => {
    const multiPdf = TestFixtures.createMultiPagePdf([
      'Section 1: Executive Summary',
      'Section 2: Omitted Appendix',
      'Section 3: Financial Disclosures',
    ]);
    const artRef = await ctx.artifacts.write(multiPdf, 'multi.pdf', 'application/pdf');

    const input = IngestAction.validateInput({
      mode: 'split',
      artifactIds: [artRef.artifactId],
      pages: '1,3',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);
    const result = await IngestAction.executeRecipe(ctx, recipe, input, sources);

    expect(result.splitArtifacts?.length).toBe(1);
    expect(result.splitArtifacts![0]!.pageCount).toBe(2);

    const splitArtId = result.splitArtifacts![0]!.artifactId;
    const splitPdfBuffer = await ctx.artifacts.read(splitArtId);
    const pdfString = splitPdfBuffer.toString('utf8');

    expect(pdfString.startsWith('%PDF-')).toBe(true);
    expect(pdfString).toContain('%%EOF');
    expect(await PdfSplitter.getPageCount(splitPdfBuffer)).toBe(2);
    expect(ctx.connectorInvocations.length).toBe(0);
  });

  // Error cases
  it('rejects input with missing mode discriminator', () => {
    expect(() => {
      IngestAction.validateInput({ artifactIds: ['art-1'] });
    }).toThrow(/Missing required discriminator: "mode"/);
  });

  it('rejects split on non-PDF file', async () => {
    const csvBuf = TestFixtures.createSampleCsv();
    const artRef = await ctx.artifacts.write(csvBuf, 'doc.csv', 'text/csv');

    const input = IngestAction.validateInput({
      mode: 'split',
      artifactIds: [artRef.artifactId],
      pages: '1',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);

    await expect(
      IngestAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/Split only supports PDF documents/);
  });

  it('rejects split with invalid page range expression (start > end)', async () => {
    const pdfBuf = TestFixtures.createSamplePdf('Page content');
    const artRef = await ctx.artifacts.write(pdfBuf, 'doc.pdf', 'application/pdf');

    const input = IngestAction.validateInput({
      mode: 'split',
      artifactIds: [artRef.artifactId],
      pages: '5-2',
    });
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(ctx, input);

    await expect(
      IngestAction.executeRecipe(ctx, recipe, input, sources)
    ).rejects.toThrow(/Range start cannot be greater than end/);
  });
});
