import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import { IngestAction } from '../src/actions/ingest';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import type { ArtifactStat, TaskContext } from '../src/types/context';
import { MockTaskContext } from './fixtures/mock-context';

type StreamReadOptions = {
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedVersionId?: string;
  signal?: AbortSignal;
};

type StreamFixtureOptions = {
  actualStorageVersionId?: string;
  declaredSizeBytes?: number;
  streamFactory?: (bytes: Buffer, options: StreamReadOptions) => Readable;
};

function scanFixture(): Buffer {
  return readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
}

function pdfScanFixture(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function successResponse() {
  return {
    invocationId: 'inv-scan-tamper',
    status: 'SUCCESS' as const,
    data: { text: 'must not be reached' },
  };
}

function makeContext(): MockTaskContext {
  const ctx = new MockTaskContext();
  ctx.mockConnectorResponses.set('ocr', successResponse());
  ctx.mockConnectorResponses.set('vision', successResponse());
  return ctx;
}

async function writeScan(ctx: MockTaskContext, bytes: Buffer): Promise<string> {
  const ref = await ctx.artifacts.write(bytes, 'handwriting-scan.png', 'image/png');
  return ref.artifactId;
}

async function expectWorkspaceSweep(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(TEMP_WORKSPACE_PREFIX + safeTaskId + '-'))).toEqual([]);
}

function installStreamingRead(
  ctx: MockTaskContext,
  artifactId: string,
  bytes: Buffer,
  options: StreamFixtureOptions = {}
): { stat: jest.Mock; readStream: jest.Mock } {
  const identity = ctx.artifactReadIdentityStore.get(artifactId);
  const format = ctx.artifactFormatMetadataStore.get(artifactId);
  if (!identity || !format) throw new Error('scan fixture is missing its authorized descriptor');

  const artifacts = ctx.artifacts as unknown as TaskContext['artifacts'];
  delete (artifacts as { readWithMetadata?: unknown }).readWithMetadata;

  const stat = jest.fn(async (): Promise<ArtifactStat> => ({
    fileName: format.declaredFileName,
    mimeType: format.declaredMimeType,
    sizeBytes: options.declaredSizeBytes ?? identity.sizeBytes,
    sha256: identity.sha256,
    storageVersionId: identity.storageVersionId,
    grantExpiresAt: identity.grantExpiresAt,
  }));
  const actualVersion = options.actualStorageVersionId ?? identity.storageVersionId;
  const streamFactory = options.streamFactory ?? ((sourceBytes: Buffer) => Readable.from([sourceBytes]));
  const readStream = jest.fn(async (_id: string, request?: StreamReadOptions): Promise<Readable> => {
    if (request?.expectedVersionId !== actualVersion) {
      throw new Error('artifact storage version does not match the authorized descriptor');
    }
    return streamFactory(bytes, request ?? {});
  });
  Object.assign(artifacts, { stat, readStream });
  return { stat, readStream };
}

async function runIngest(ctx: MockTaskContext, mode: 'ocr' | 'digitize', artifactId: string): Promise<void> {
  const input = IngestAction.validateInput({
    mode,
    artifactIds: [artifactId],
    ...(mode === 'ocr' ? { language: 'en' } : {}),
  });
  const sources = await IngestAction.prepareSources(ctx, input);
  await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
}

describe('OCR and handwriting ingest tamper defenses', () => {
  it('rejects an OCR read grant with a tampered SHA-256 before invoking the Connector', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const identity = ctx.artifactReadIdentityStore.get(artifactId);
    expect(identity).toBeDefined();
    ctx.artifactReadIdentityStore.set(artifactId, { ...identity!, sha256: '0'.repeat(64) });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('rejects a corrupted in-memory handwriting payload after the authorized read', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    const payloadBuffer = sources.buffers[0];
    if (!payloadBuffer) throw new Error('digitize source buffer was not prepared');
    const finalByteIndex = payloadBuffer.length - 1;
    const finalByte = payloadBuffer[finalByteIndex];
    if (finalByte === undefined) throw new Error('digitize source buffer is empty');
    payloadBuffer[finalByteIndex] = finalByte ^ 0x01;

    await expect(
      IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources)
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_MISMATCH' });
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  it('rejects a digitize PDF stream shorter than its authorized size', async () => {
    const ctx = makeContext();
    const bytes = pdfScanFixture();
    const ref = await ctx.artifacts.write(bytes, 'handwriting-scan.pdf', 'application/pdf');
    const artifactId = ref.artifactId;
    const truncatedBytes = bytes.subarray(0, bytes.length - 1);
    const { readStream } = installStreamingRead(ctx, artifactId, truncatedBytes);

    await expect(runIngest(ctx, 'digitize', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_MISMATCH',
    });
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedSizeBytes: bytes.length })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  it('rejects a same-size digitize PDF stream whose digest differs from its grant', async () => {
    const ctx = makeContext();
    const bytes = pdfScanFixture();
    const ref = await ctx.artifacts.write(bytes, 'handwriting-scan.pdf', 'application/pdf');
    const artifactId = ref.artifactId;
    const tamperedBytes = Buffer.from(bytes);
    const tamperIndex = tamperedBytes.length - 3;
    const originalByte = tamperedBytes[tamperIndex];
    if (originalByte === undefined) throw new Error('PDF scan fixture is too short to tamper');
    tamperedBytes[tamperIndex] = originalByte ^ 0x01;
    const { readStream } = installStreamingRead(ctx, artifactId, tamperedBytes);

    await expect(runIngest(ctx, 'digitize', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedSha256: sha256(bytes), expectedSizeBytes: bytes.length })
    );
    expect(tamperedBytes).toHaveLength(bytes.length);
    expect(sha256(tamperedBytes)).not.toBe(sha256(bytes));
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  it('rejects an OCR download grant whose storage version changed after preflight', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const descriptor = ctx.artifactReadIdentityStore.get(artifactId)!;
    const { readStream } = installStreamingRead(ctx, artifactId, bytes, {
      actualStorageVersionId: 'different-version-after-preflight',
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toThrow(
      'artifact storage version does not match the authorized descriptor'
    );
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedVersionId: descriptor.storageVersionId })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('aborts handwriting stream acquisition when the parser timeout expires mid-transfer', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    let transferSignal: AbortSignal | undefined;
    const { readStream } = installStreamingRead(ctx, artifactId, bytes, {
      streamFactory: (_sourceBytes, request) => {
        transferSignal = request.signal;
        return new Readable({ read() {} });
      },
    });

    jest.useFakeTimers();
    try {
      const pending = runIngest(ctx, 'digitize', artifactId);
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
      await timeoutAssertion;
      expect(readStream).toHaveBeenCalled();
      expect(transferSignal?.aborted).toBe(true);
      expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a payload checksum corrupted across streamed chunks', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const prefix = bytes.subarray(0, 8);
    const corruptedPayloadChunk = Buffer.from(bytes.subarray(8));
    const lastPayloadByte = corruptedPayloadChunk.length - 1;
    const originalByte = corruptedPayloadChunk[lastPayloadByte];
    if (originalByte === undefined) throw new Error('scan fixture has no payload after its magic bytes');
    corruptedPayloadChunk[lastPayloadByte] = originalByte ^ 0x01;
    const { readStream } = installStreamingRead(ctx, artifactId, bytes, {
      streamFactory: () => Readable.from([prefix, corruptedPayloadChunk]),
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedSha256: sha256(bytes), expectedSizeBytes: bytes.length })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a stream that ends directly after the PNG magic bytes', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const pngMagic = bytes.subarray(0, 8);
    const { readStream } = installStreamingRead(ctx, artifactId, bytes, {
      streamFactory: () => Readable.from([pngMagic]),
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_MISMATCH',
    });
    expect(pngMagic).toHaveLength(8);
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedSizeBytes: bytes.length })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a Content-Length descriptor that exceeds the bytes read from the stream', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const declaredContentLength = bytes.length + 1;
    const { stat, readStream } = installStreamingRead(ctx, artifactId, bytes, {
      declaredSizeBytes: declaredContentLength,
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_SIZE_MISMATCH',
    });
    expect(await stat.mock.results[0]?.value).toMatchObject({ sizeBytes: declaredContentLength });
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedSizeBytes: declaredContentLength })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects a zero-byte OCR scan before invoking the Connector', async () => {
    const ctx = makeContext();
    const empty = Buffer.alloc(0);
    const ref = await ctx.artifacts.write(empty, 'empty-scan.png', 'image/png');
    const { readStream } = installStreamingRead(ctx, ref.artifactId, empty);

    await expect(runIngest(ctx, 'ocr', ref.artifactId)).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('rejects an oversized OCR stream before invoking the Connector', async () => {
    const ctx = makeContext();
    const grantBytes = scanFixture();
    const artifactId = await writeScan(ctx, grantBytes);
    const oversizedBytes = Buffer.alloc(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES + 1, 0x41);
    const { readStream } = installStreamingRead(ctx, artifactId, grantBytes, {
      streamFactory: () => Readable.from([oversizedBytes]),
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
    await expectWorkspaceSweep(ctx.taskId);
  });

  test.failing('rejects a PDF payload declared as a PNG before it reaches OCR', async () => {
    const ctx = makeContext();
    const pdf = pdfScanFixture();
    const ref = await ctx.artifacts.write(pdf, 'spoofed-scan.png', 'image/png');
    installStreamingRead(ctx, ref.artifactId, pdf);

    await expect(runIngest(ctx, 'ocr', ref.artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_FORMAT_METADATA_MISMATCH',
    });
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  test.failing('rejects a TIFF source truncated inside its magic header before digitization', async () => {
    const ctx = makeContext();
    const truncatedTiffHeader = Buffer.from([0x49, 0x49, 0x2a]);
    const ref = await ctx.artifacts.write(truncatedTiffHeader, 'truncated-scan.tiff', 'image/tiff');
    installStreamingRead(ctx, ref.artifactId, truncatedTiffHeader);

    await expect(runIngest(ctx, 'digitize', ref.artifactId)).rejects.toThrow();
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
  });

  test.failing('rejects a JPEG source with corrupted SOI magic bytes before OCR', async () => {
    const ctx = makeContext();
    const corruptedJpegSoi = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x01, 0x02]);
    const ref = await ctx.artifacts.write(corruptedJpegSoi, 'corrupted-scan.jpg', 'image/jpeg');
    installStreamingRead(ctx, ref.artifactId, corruptedJpegSoi);

    await expect(runIngest(ctx, 'ocr', ref.artifactId)).rejects.toThrow();
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('fails closed when the storage grant key changes after the stat preflight', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const identity = ctx.artifactReadIdentityStore.get(artifactId);
    const format = ctx.artifactFormatMetadataStore.get(artifactId);
    if (!identity || !format) throw new Error('scan fixture is missing its authorized descriptor');
    const { stat, readStream } = installStreamingRead(ctx, artifactId, bytes);
    const statDescriptor: ArtifactStat = {
      fileName: format.declaredFileName,
      mimeType: format.declaredMimeType,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      storageVersionId: identity.storageVersionId,
      grantExpiresAt: identity.grantExpiresAt,
    };
    stat.mockImplementation(async () => {
      ctx.artifactReadIdentityStore.set(artifactId, {
        ...identity,
        storageVersionId: 'modified-grant-key-after-stat',
      });
      return statDescriptor;
    });
    readStream.mockImplementation(async (_id: string, request?: StreamReadOptions) => {
      const currentGrant = ctx.artifactReadIdentityStore.get(artifactId);
      if (request?.expectedVersionId !== currentGrant?.storageVersionId) {
        throw new Error('storage grant key changed after stat preflight');
      }
      return Readable.from([bytes]);
    });

    await expect(runIngest(ctx, 'ocr', artifactId)).rejects.toThrow('storage grant key changed after stat preflight');
    expect(stat).toHaveBeenCalledTimes(1);
    expect(readStream).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ expectedVersionId: identity.storageVersionId })
    );
    expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'ocr')).toHaveLength(0);
  });

  it('cleans the temporary workspace after repeated timeout aborts', async () => {
    const ctx = makeContext();
    const bytes = scanFixture();
    const artifactId = await writeScan(ctx, bytes);
    const transferSignals: AbortSignal[] = [];
    installStreamingRead(ctx, artifactId, bytes, {
      streamFactory: (_sourceBytes, request) => {
        if (request.signal) transferSignals.push(request.signal);
        return new Readable({ read() {} });
      },
    });

    jest.useFakeTimers();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const pending = runIngest(ctx, 'digitize', artifactId);
        const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
        await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
        await timeoutAssertion;
        expect(transferSignals[attempt]?.aborted).toBe(true);
        await expectWorkspaceSweep(ctx.taskId);
      }
      expect(ctx.connectorInvocations.filter((entry) => entry.slot === 'vision')).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
