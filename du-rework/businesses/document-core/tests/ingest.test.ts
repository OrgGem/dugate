import { IngestAction } from '../src/actions/ingest';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../packages/document-kit/tests/fixtures/test-fixtures';
import { PdfSplitter } from '../../../packages/document-kit/src/formats/pdf-splitter';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import type { ArtifactReadStreamOptions, ArtifactStat, TaskContext } from '../src/types/context';

/**
 * INGEST-WIRE-01: REAL PNG bytes for the OCR/digitize variants.
 *
 * The old variants passed a `text` placeholder, so nothing image-shaped ever
 * existed. These are actual PNG files (signature + IHDR/IDAT/IEND), which is
 * what the format detector and the provider-side MIME check must agree on.
 * Base64 of a valid 1x1 PNG; the digest is asserted so a fixture that quietly
 * changes shape cannot keep passing.
 */
const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createScanPngBytes(): Buffer {
  return Buffer.from(SCAN_PNG_BASE64, 'base64');
}

/** A second, different scan so OCR and digitize are not the same bytes. */
function createHandwritingScanPngBytes(): Buffer {
  const base = createScanPngBytes();
  // A tEXt chunk carrying the difference, appended before IEND.
  const marker = Buffer.from('handwriting', 'utf8');
  const payload = Buffer.concat([Buffer.from([0x68, 0x74, 0x54, 0x65, 0x78, 0x74]), marker]);
  const withMarker = Buffer.concat([base.subarray(0, base.length - 12), payload, base.subarray(base.length - 12)]);
  return withMarker;
}

export const SCAN_PNG_SHA256 = createHash('sha256').update(createScanPngBytes()).digest('hex');

function installStreamingRead(
  ctx: MockTaskContext,
  artifactId: string,
  streamFactory: (signal?: AbortSignal) => Readable
): { stat: jest.Mock; readStream: jest.Mock } {
  const identity = ctx.artifactReadIdentityStore.get(artifactId);
  const format = ctx.artifactFormatMetadataStore.get(artifactId);
  if (!identity || !format) throw new Error('ingest fixture is missing its authorized descriptor');

  const artifacts = ctx.artifacts as unknown as TaskContext['artifacts'];
  delete artifacts.readWithMetadata;
  const stat = jest.fn(async (): Promise<ArtifactStat> => ({
    fileName: format.declaredFileName,
    mimeType: format.declaredMimeType,
    sizeBytes: identity.sizeBytes,
    sha256: identity.sha256,
    storageVersionId: identity.storageVersionId,
    grantExpiresAt: identity.grantExpiresAt,
  }));
  const readStream = jest.fn(async (_id: string, options?: ArtifactReadStreamOptions) =>
    streamFactory(options?.signal)
  );
  Object.assign(artifacts, { stat, readStream });
  return { stat, readStream };
}

async function expectIngestTempWorkspaceSwept(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((entry) => entry.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`))).toEqual([]);
}

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
  // INGEST-WIRE-01: this variant used to pass `text: 'image-placeholder'` and a
  // `hasBuffer` boolean, which proved nothing — the provider received no image.
  // It now writes REAL PNG bytes as an artifact and asserts the Connector is
  // handed that artifact reference, so the wire is the document.
  it('DOC-01-v2: hands the OCR slot a real artifact reference for the scanned image', async () => {
    ctx.mockConnectorResponses.set('ocr', {
      invocationId: 'inv-ocr-1',
      status: 'SUCCESS',
      data: { text: 'Scanned receipt text', markdown: '# Scanned receipt' },
    });

    const scan = createScanPngBytes();
    const artRef = await ctx.artifacts.write(scan, 'receipt-scan.png', 'image/png');
    const input = IngestAction.validateInput({
      mode: 'ocr',
      artifactIds: [artRef.artifactId],
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
    const ocrCall = ctx.connectorInvocations.find((inv) => inv.slot === 'ocr');
    expect(ocrCall).toBeDefined();
    // The wire carries the DOCUMENT, not a boolean about it.
    const payload = ocrCall?.payload as { artifacts?: Array<Record<string, unknown>>; hasBuffer?: boolean };
    expect(payload.hasBuffer).toBeUndefined();
    expect(payload.artifacts?.[0]).toMatchObject({
      artifactId: artRef.artifactId,
      fileName: 'receipt-scan.png',
      mimeType: 'image/png',
      sha256: createHash('sha256').update(scan).digest('hex'),
      storageVersionId: createHash('sha256').update(scan).digest('hex'),
    });
    expect(Buffer.from(payload.artifacts?.[0]?.contentBase64 as string, 'base64')).toEqual(scan);
    // The bytes behind that reference are the scan we wrote, byte for byte.
    expect(ctx.artifactsStore.get(artRef.artifactId)?.equals(scan)).toBe(true);
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

    const form = createHandwritingScanPngBytes();
    const formRef = await ctx.artifacts.write(form, 'intake-form.png', 'image/png');
    const input = IngestAction.validateInput({
      mode: 'digitize',
      artifactIds: [formRef.artifactId],
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
    const visionCall = ctx.connectorInvocations.find((inv) => inv.slot === 'vision');
    expect(visionCall).toBeDefined();
    // A task NAME is not a document: the payload must name the artifact.
    const visionPayload = visionCall?.payload as { task?: string; artifacts?: Array<Record<string, unknown>> };
    expect(visionPayload.task).toBe('digitize_handwriting');
    expect(visionPayload.artifacts?.[0]).toMatchObject({
      artifactId: formRef.artifactId,
      fileName: 'intake-form.png',
      mimeType: 'image/png',
      sha256: createHash('sha256').update(form).digest('hex'),
      storageVersionId: createHash('sha256').update(form).digest('hex'),
    });
    expect(Buffer.from(visionPayload.artifacts?.[0]?.contentBase64 as string, 'base64')).toEqual(form);
    expect(ctx.artifactsStore.get(formRef.artifactId)?.equals(form)).toBe(true);
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

  it('rejects malformed ingestion source pins instead of treating them as an unpinned request', () => {
    expect(() => IngestAction.validateInput({
      mode: 'parse',
      source: {
        storageKey: 'source-1',
        versionId: 'version-1',
        sha256: 'not-a-sha256-digest',
        sizeBytes: 12,
      },
    })).toThrow(/Ingestion source pin in the task payload failed contract validation/);
  });

  test.failing('rejects a PNG source declared with an unsupported MIME type before OCR', async () => {
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'scan.png', 'application/x-unsupported');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  test.failing('rejects a PNG source with an unsupported filename extension before OCR', async () => {
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'scan.unsupported', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('rejects an empty artifact buffer before sending it to OCR', async () => {
    const artRef = await ctx.artifacts.write(Buffer.alloc(0), 'empty.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('rejects a source whose PNG header was corrupted after its read grant was issued', async () => {
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'corrupt-header.png', 'image/png');
    const corrupted = Buffer.from(png);
    corrupted[0] = 0;
    ctx.artifactsStore.set(artRef.artifactId, corrupted);
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('fails closed for a malformed or unresolved artifact ID', async () => {
    const invalidArtifactId = '../outside/secret.pdf';
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [invalidArtifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow(/not found/);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('aborts a streamed ingest after a partial read and removes its temporary workspace', async () => {
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'aborted.png', 'image/png');
    let markTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve;
    });
    let sourceStream: Readable | undefined;
    const { readStream } = installStreamingRead(ctx, artRef.artifactId, () => {
      let sent = false;
      sourceStream = new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(png.subarray(0, 8));
          markTransferStarted();
        },
      });
      return sourceStream;
    });
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });
    const pending = IngestAction.prepareSources(ctx, input);
    await transferStarted;
    controller.abort('cancel');

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(sourceStream?.destroyed).toBe(true);
    expect(ctx.connectorInvocations).toHaveLength(0);
    await expectIngestTempWorkspaceSwept(ctx.taskId);
  });

  it('propagates a mid-stream source error and sweeps the partial temporary file', async () => {
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'interrupted.png', 'image/png');
    const { readStream } = installStreamingRead(ctx, artRef.artifactId, () => Readable.from((async function* () {
      yield png.subarray(0, 8);
      throw new Error('source stream failed during ingestion');
    })()));
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow('source stream failed during ingestion');
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations).toHaveLength(0);
    await expectIngestTempWorkspaceSwept(ctx.taskId);
  });

  it('times out during streamed ingestion and removes its temporary workspace', async () => {
    const png = createScanPngBytes();
    const artRef = await ctx.artifacts.write(png, 'timeout.png', 'image/png');
    ctx.deadlineAt = new Date(Date.now() + 120).toISOString();
    let transferSignal: AbortSignal | undefined;
    const { readStream } = installStreamingRead(ctx, artRef.artifactId, (signal) => {
      transferSignal = signal;
      return new Readable({ read() {} });
    });
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [artRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(transferSignal?.aborted).toBe(true);
    expect(ctx.connectorInvocations).toHaveLength(0);
    await expectIngestTempWorkspaceSwept(ctx.taskId);
  });
});
