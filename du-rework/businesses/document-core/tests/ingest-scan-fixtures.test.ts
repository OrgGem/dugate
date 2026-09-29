import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { InvocationInputSchema } from '@du/contracts';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import { IngestAction } from '../src/actions/ingest';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import type { ArtifactStat, TaskContext } from '../src/types/context';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../packages/document-kit/tests/fixtures/test-fixtures';

type FixtureReadOptions = {
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedVersionId?: string;
  signal?: AbortSignal;
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function connectorResponse(text: string) {
  return {
    invocationId: 'inv-scan-fixture',
    status: 'SUCCESS' as const,
    data: { text },
  };
}

function installStreamingFixtureRead(
  ctx: MockTaskContext,
  artifactId: string,
  streamFactory: (options: FixtureReadOptions) => Readable
): { stat: jest.Mock; readStream: jest.Mock } {
  const identity = ctx.artifactReadIdentityStore.get(artifactId);
  const format = ctx.artifactFormatMetadataStore.get(artifactId);
  if (!identity || !format) throw new Error('scan fixture is missing its authorized descriptor');

  const artifacts = ctx.artifacts as unknown as TaskContext['artifacts'];
  delete (artifacts as { readWithMetadata?: unknown }).readWithMetadata;
  const stat = jest.fn(async (): Promise<ArtifactStat> => ({
    fileName: format.declaredFileName,
    mimeType: format.declaredMimeType,
    sizeBytes: identity.sizeBytes,
    sha256: identity.sha256,
    storageVersionId: identity.storageVersionId,
    grantExpiresAt: identity.grantExpiresAt,
  }));
  const readStream = jest.fn(async (_id: string, options?: FixtureReadOptions) => streamFactory(options ?? {}));
  Object.assign(artifacts, { stat, readStream });
  return { stat, readStream };
}

async function expectWorkspaceSweep(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`))).toEqual([]);
}

describe('ingest scan fixture payloads', () => {
  it('sends the fixture PNG bytes and image/png MIME to OCR', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', connectorResponse('Scanned receipt text'));
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'receipt-scan.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);

    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    const invocation = ctx.connectorInvocations.find((entry) => entry.slot === 'ocr');
    const payload = invocation?.payload as { artifacts?: Array<Record<string, unknown>> };
    const artifact = payload.artifacts?.[0];
    expect(artifact).toMatchObject({
      artifactId: ref.artifactId,
      fileName: 'receipt-scan.png',
      mimeType: 'image/png',
      sizeBytes: png.length,
      sha256: sha256(png),
      storageVersionId: sha256(png),
    });
    expect(Buffer.from(artifact?.contentBase64 as string, 'base64')).toEqual(png);
  });

  it('sends the PDF fixture bytes and application/pdf MIME for handwriting digitization', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('vision', connectorResponse('Handwritten form fields'));
    const pdf = TestFixtures.createSamplePdf('Handwritten patient intake form');
    const ref = await ctx.artifacts.write(pdf, 'handwriting-form.pdf', 'application/pdf');
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);

    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    const invocation = ctx.connectorInvocations.find((entry) => entry.slot === 'vision');
    const payload = invocation?.payload as { task?: string; artifacts?: Array<Record<string, unknown>> };
    const artifact = payload.artifacts?.[0];
    expect(payload.task).toBe('digitize_handwriting');
    expect(artifact).toMatchObject({
      artifactId: ref.artifactId,
      fileName: 'handwriting-form.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf.length,
      sha256: sha256(pdf),
      storageVersionId: sha256(pdf),
    });
    expect(Buffer.from(artifact?.contentBase64 as string, 'base64')).toEqual(pdf);
  });

  it('fails closed for a reference without an authorized artifact and skips OCR', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', connectorResponse('must not be reached'));
    const missingArtifactId = randomUUID();
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [missingArtifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow(/not found/);

    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('fails closed for an expired reference before handwriting digitization', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('vision', connectorResponse('must not be reached'));
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'expired-handwriting.png', 'image/png');
    const identity = ctx.artifactReadIdentityStore.get(ref.artifactId);
    expect(identity).toBeDefined();
    ctx.artifactReadIdentityStore.set(ref.artifactId, {
      ...identity!,
      grantExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_GRANT_EXPIRED',
    });

    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  it('rejects a zero-length scan before OCR reaches the connector', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', connectorResponse('must not be reached'));
    const ref = await ctx.artifacts.write(Buffer.alloc(0), 'empty-scan.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });

    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a truncated ZIP header when the read grant describes the complete fixture', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', connectorResponse('must not be reached'));
    const completeZip = TestFixtures.createSyntheticDocx('fixture to be truncated');
    const ref = await ctx.artifacts.write(
      completeZip,
      'truncated-scan.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    ctx.artifactsStore.set(ref.artifactId, completeZip.subarray(0, 3));
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });

    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects PDF metadata when the fixture magic bytes identify a ZIP document', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', connectorResponse('must not be reached'));
    const zip = TestFixtures.createSyntheticDocx('not a PDF document');
    const ref = await ctx.artifacts.write(zip, 'mislabeled.pdf', 'application/pdf');
    const metadata = ctx.artifactFormatMetadataStore.get(ref.artifactId);
    expect(metadata?.declaredMimeType).toBe('application/pdf');
    ctx.artifactFormatMetadataStore.set(ref.artifactId, {
      ...metadata!,
      canonicalFormat: 'pdf',
      canonicalMimeType: 'application/pdf',
    });
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });

    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects mock fixture headers that exceed connector contract bounds', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const fileName = `${'x'.repeat(256)}.png`;
    const mimeType = `image/${'x'.repeat(130)}`;
    const ref = await ctx.artifacts.write(png, fileName, mimeType);
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);
    const contractCheckingInvoke = jest.spyOn(ctx.connector, 'invoke').mockImplementation(async (_slot, payload) => {
      InvocationInputSchema.parse(payload);
      return ctx.defaultConnectorResponse;
    });

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toThrow();

    expect(contractCheckingInvoke).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  test.failing('rejects PDF magic bytes declared with image/png MIME before OCR', async () => {
    const ctx = new MockTaskContext();
    const pdf = TestFixtures.createSamplePdf('MIME spoof fixture');
    const ref = await ctx.artifacts.write(pdf, 'spoofed-scan.pdf', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  test.failing('rejects ZIP magic bytes declared with application/pdf MIME before OCR', async () => {
    const ctx = new MockTaskContext();
    const zip = TestFixtures.createSyntheticDocx('MIME spoof fixture');
    const ref = await ctx.artifacts.write(zip, 'spoofed-document.pdf', 'application/pdf');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  test.failing('rejects a TIFF fixture truncated inside the image file directory header', async () => {
    const ctx = new MockTaskContext();
    const truncatedTiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const ref = await ctx.artifacts.write(truncatedTiff, 'truncated-ifd.tiff', 'image/tiff');
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow();
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  test.failing('rejects a PNG fixture with a corrupted terminal chunk CRC', async () => {
    const ctx = new MockTaskContext();
    const corruptedPng = Buffer.from(readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png')));
    const crcIndex = corruptedPng.length - 1;
    const crcByte = corruptedPng[crcIndex];
    if (crcByte === undefined) throw new Error('PNG fixture is empty');
    corruptedPng[crcIndex] = crcByte ^ 0x01;
    const ref = await ctx.artifacts.write(corruptedPng, 'corrupted-crc.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow();
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a reference denied by the artifact read grant', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'denied-scan.png', 'image/png');
    ctx.deniedArtifactReadIds.add(ref.artifactId);
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow(/grant denied/);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a read grant whose storage key no longer exists', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'missing-storage-key.png', 'image/png');
    ctx.artifactsStore.delete(ref.artifactId);
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow(/not found/);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  it('rejects a zero-byte streamed scan before invoking OCR', async () => {
    const ctx = new MockTaskContext();
    const ref = await ctx.artifacts.write(Buffer.alloc(0), 'empty-stream.png', 'image/png');
    const { readStream } = installStreamingFixtureRead(ctx, ref.artifactId, () => Readable.from([]));
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  test.failing('rejects CRLF injection in a fixture file name before connector invocation', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const fileName = 'scan.png\r\nX-Injected: true';
    const ref = await ctx.artifacts.write(png, fileName, 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);
    const contractCheckingInvoke = jest.spyOn(ctx.connector, 'invoke').mockImplementation(async (_slot, payload) => {
      InvocationInputSchema.parse(payload);
      return ctx.defaultConnectorResponse;
    });

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toThrow();
    expect(contractCheckingInvoke).toHaveBeenCalledTimes(1);
  });

  it('rejects CRLF injection in the fixture MIME header at the connector contract boundary', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const mimeType = 'image/png\r\nX-Injected: true';
    const ref = await ctx.artifacts.write(png, 'scan.png', mimeType);
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const sources = await IngestAction.prepareSources(ctx, input);
    const contractCheckingInvoke = jest.spyOn(ctx.connector, 'invoke').mockImplementation(async (_slot, payload) => {
      InvocationInputSchema.parse(payload);
      return ctx.defaultConnectorResponse;
    });

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toThrow();
    expect(contractCheckingInvoke).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('aborts a fixture transfer on parser timeout and sweeps the temporary workspace', async () => {
    const ctx = new MockTaskContext();
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'stalled-scan.png', 'image/png');
    const transferSignals: AbortSignal[] = [];
    const { readStream } = installStreamingFixtureRead(ctx, ref.artifactId, (options) => {
      if (options.signal) transferSignals.push(options.signal);
      return new Readable({ read() {} });
    });
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });

    jest.useFakeTimers();
    try {
      const pending = IngestAction.prepareSources(ctx, input);
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
      await timeoutAssertion;
      expect(readStream).toHaveBeenCalledTimes(1);
      expect(transferSignals[0]?.aborted).toBe(true);
      expect(ctx.connectorInvocations).toHaveLength(0);
      await expectWorkspaceSweep(ctx.taskId);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a fixture transfer after its first chunk without invoking OCR', async () => {
    const controller = new AbortController();
    const ctx = new MockTaskContext();
    ctx.signal = controller.signal;
    const png = readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
    const ref = await ctx.artifacts.write(png, 'cancelled-scan.png', 'image/png');
    let markTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve;
    });
    const { readStream } = installStreamingFixtureRead(ctx, ref.artifactId, () => {
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(Buffer.from('partial scan bytes'));
          markTransferStarted();
        },
      });
    });
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const pending = IngestAction.prepareSources(ctx, input);
    await transferStarted;
    controller.abort('cancel');

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
    await expectWorkspaceSweep(ctx.taskId);
  });
});
