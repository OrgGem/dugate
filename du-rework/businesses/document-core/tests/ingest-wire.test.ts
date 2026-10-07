/**
 * INGEST-WIRE-01: the ingest -> Connector wire must carry the DOCUMENT.
 *
 * The defect this file pins: ingest/ocr sent a boolean (hasBuffer) and
 * ingest/digitize sent only a task name. Neither transmitted a document, so a
 * green OCR/vision receipt was not evidence that any file had been read.
 *
 * Asserted here with real PNG bytes:
 *  1. TRANSMISSION - the invocation carries an artifact reference for the
 *     actual scan, never a boolean standing in for it.
 *  2. IDENTITY - the reference resolves to the exact bytes written, with the
 *     digest and MIME a provider-side check would use.
 *  3. NO SILENT SUCCESS - with no source artifact, OCR/digitize fail visibly
 *     instead of invoking a provider with nothing to read.
 *  4. FOREIGN DENIAL - a reference the task did not read is never transmitted,
 *     and native parse/split stay local (docs/10).
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { InvocationArtifactContent } from '@du/contracts';
import { IngestAction } from '../src/actions/ingest';
import type { TaskContext } from '../src/types/context';
import { MockTaskContext } from './fixtures/mock-context';
import { jsonHttpAdapter, multipartHttpAdapter } from '../../../orchestrator/services/connector/src/adapters/http';
import type { LocalInvocationRequest } from '../../../orchestrator/services/connector/src/types';

const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function scanBytes(): Buffer {
  return Buffer.from(SCAN_PNG_BASE64, 'base64');
}

function handwritingScanBytes(): Buffer {
  return readFileSync(join(__dirname, 'fixtures', 'handwriting-scan.png'));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function okConnector(text: string) {
  return {
    invocationId: 'inv-wire',
    status: 'SUCCESS' as const,
    data: { text },
  };
}

function invocationArtifact(bytes: Buffer, fileName = 'scan.png', mimeType = 'image/png'): InvocationArtifactContent {
  return {
    artifactId: randomUUID(),
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    storageVersionId: 'scan-version-1',
    contentBase64: bytes.toString('base64'),
  };
}

function localInvocationRequest(input: LocalInvocationRequest['input']): LocalInvocationRequest {
  return {
    contractVersion: '1',
    invocationId: 'inv-ingest-wire-negative',
    tenantId: 'tenant-wire-test',
    operationId: 'op-ingest-wire-test',
    taskId: 'task-ingest-wire-test',
    stepKey: 'ingest.ocr',
    bindingSlot: 'ocr',
    input,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('INGEST-WIRE-01: OCR transmits the scan, not a claim about it', () => {
  it('hands the Connector a reference whose bytes are the scan we wrote', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('RECEIPT TOTAL 42.00'));
    const scan = scanBytes();
    const ref = await ctx.artifacts.write(scan, 'receipt.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'vie' });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    const call = ctx.connectorInvocations.find((inv) => inv.slot === 'ocr');
    expect(call).toBeDefined();
    const payload = call?.payload as Record<string, unknown>;
    // The forbidden evidence: a boolean is not a document.
    expect(payload.hasBuffer).toBeUndefined();
    const transmitted = (payload.artifacts as Array<Record<string, unknown>>)[0];
    expect(transmitted).toMatchObject({
      artifactId: ref.artifactId,
      fileName: 'receipt.png',
      mimeType: 'image/png',
      sizeBytes: scan.length,
      sha256: sha256(scan),
      storageVersionId: sha256(scan),
    });
    expect(Buffer.from(transmitted?.contentBase64 as string, 'base64')).toEqual(scan);
  });

  it('streams handwriting-scan.png into the OCR wire payload with pinned byte identity', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('Handwritten invoice total: 42.00'));
    const scan = handwritingScanBytes();
    const ref = await ctx.artifacts.write(scan, 'handwriting-scan.png', 'image/png');
    const digest = sha256(scan);
    const identity = ctx.artifactReadIdentityStore.get(ref.artifactId);
    const format = ctx.artifactFormatMetadataStore.get(ref.artifactId);
    expect(identity).toBeDefined();
    expect(format).toBeDefined();

    const stat = jest.fn(async (artifactId: string) => {
      if (artifactId !== ref.artifactId || !identity || !format) {
        throw new Error('unexpected or incomplete artifact read');
      }
      return {
        fileName: format.declaredFileName,
        mimeType: format.declaredMimeType,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sha256,
        storageVersionId: identity.storageVersionId,
        grantExpiresAt: identity.grantExpiresAt,
      };
    });
    const readStream = jest.fn(async (artifactId: string, options?: {
      expectedSha256?: string;
      expectedSizeBytes?: number;
      expectedVersionId?: string;
    }) => {
      const stored = ctx.artifactsStore.get(artifactId);
      if (!stored) throw new Error('artifact is missing from the fixture store');
      expect(options).toMatchObject({
        expectedSha256: digest,
        expectedSizeBytes: scan.length,
        expectedVersionId: digest,
      });
      const splitAt = Math.floor(stored.length / 2);
      return Readable.from([stored.subarray(0, splitAt), stored.subarray(splitAt)]);
    });

    // This fixture exercises the stream-capable facade without the optional
    // inline metadata read, so even the small scan is acquired in two chunks.
    const streamingArtifacts = ctx.artifacts as TaskContext['artifacts'];
    delete streamingArtifacts.readWithMetadata;
    Object.assign(streamingArtifacts, { stat, readStream });

    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'vie' });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    expect(stat).toHaveBeenCalledWith(
      ref.artifactId,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(readStream).toHaveBeenCalledTimes(1);
    const call = ctx.connectorInvocations.find((inv) => inv.slot === 'ocr');
    const payload = call?.payload as { artifacts?: Array<Record<string, unknown>> };
    const transmitted = payload.artifacts?.[0];
    expect(transmitted).toMatchObject({
      artifactId: ref.artifactId,
      fileName: 'handwriting-scan.png',
      mimeType: 'image/png',
      sizeBytes: scan.length,
      sha256: digest,
      storageVersionId: digest,
    });
    expect(Buffer.from(transmitted?.contentBase64 as string, 'base64')).toEqual(scan);
  });

  it('the referenced bytes carry the scan digest and PNG identity', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('x'));
    const scan = scanBytes();
    const ref = await ctx.artifacts.write(scan, 'receipt.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    const first = sources.buffers[0];
    expect(first).toBeDefined();
    // Exactly what a provider-side integrity/MIME gate would recompute.
    expect(first?.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(sha256(first as Buffer)).toBe(sha256(scan));
    expect(sources.fileNames[0]).toBe('receipt.png');
    // prepareSources reports the id that was actually read.
    expect(sources.artifactIds[0]).toBe(ref.artifactId);
  });

  it('fails visibly instead of invoking a provider with no document', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('must not be reached'));
    const input = IngestAction.validateInput({ mode: 'ocr', text: 'no-artifact-here' });
    const sources = await IngestAction.prepareSources(ctx, input);
    expect(sources.artifactIds).toHaveLength(0);
    let caught: unknown;
    try {
      await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('INGESTION_SOURCE_UNRESOLVED');
    // Nothing reached the provider: no silent-success evidence.
    expect(ctx.connectorInvocations.filter((inv) => inv.slot === 'ocr')).toHaveLength(0);
  });
});
describe('INGEST-WIRE-01: digitize transmits the form image', () => {
  it('hands the vision slot the form artifact, not just a task name', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('vision', {
      invocationId: 'inv-dig',
      status: 'SUCCESS',
      data: { text: 'INTAKE FORM', formFields: { patientName: 'Jane Roe' } },
    });
    const form = handwritingScanBytes();
    const ref = await ctx.artifacts.write(form, 'intake.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    const call = ctx.connectorInvocations.find((inv) => inv.slot === 'vision');
    expect(call).toBeDefined();
    const payload = call?.payload as Record<string, unknown>;
    expect(payload.task).toBe('digitize_handwriting');
    const transmitted = (payload.artifacts as Array<Record<string, unknown>>)[0];
    expect(transmitted).toMatchObject({
      artifactId: ref.artifactId,
      fileName: 'intake.png',
      mimeType: 'image/png',
      sizeBytes: form.length,
      sha256: sha256(form),
      storageVersionId: sha256(form),
    });
    expect(Buffer.from(transmitted?.contentBase64 as string, 'base64')).toEqual(form);
  });

  it('fails visibly when digitize has no form to read', async () => {
    const ctx = new MockTaskContext();
    const input = IngestAction.validateInput({ mode: 'digitize', text: 'no-form' });
    const sources = await IngestAction.prepareSources(ctx, input);
    expect(sources.artifactIds).toHaveLength(0);
    let caught: unknown;
    try {
      await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('INGESTION_SOURCE_UNRESOLVED');
    expect(ctx.connectorInvocations.filter((inv) => inv.slot === 'vision')).toHaveLength(0);
  });
});

describe('INGEST-WIRE-01: foreign references and the native boundary', () => {
  it('never hands the Connector a reference the task did not read', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('x'));
    const mine = scanBytes();
    const mineRef = await ctx.artifacts.write(mine, 'mine.png', 'image/png');
    const foreignRef = await ctx.artifacts.write(scanBytes(), 'foreign.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [mineRef.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    const call = ctx.connectorInvocations.find((inv) => inv.slot === 'ocr');
    const payload = call?.payload as { artifacts?: { artifactId: string }[] };
    expect(payload.artifacts?.map((a) => a.artifactId)).toEqual([mineRef.artifactId]);
    expect(payload.artifacts?.some((a) => a.artifactId === foreignRef.artifactId)).toBe(false);
  });

  it('blocks a foreign artifact when its read grant is denied', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('must not run'));
    const foreignRef = await ctx.artifacts.write(scanBytes(), 'foreign.png', 'image/png');
    ctx.deniedArtifactReadIds.add(foreignRef.artifactId);
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [foreignRef.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow('artifact read grant denied');
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('blocks a source whose artifact access grant expired before OCR dispatch', async () => {
    const ctx = new MockTaskContext();
    ctx.mockConnectorResponses.set('ocr', okConnector('must not run'));
    const ref = await ctx.artifacts.write(scanBytes(), 'expired.png', 'image/png');
    const identity = ctx.artifactReadIdentityStore.get(ref.artifactId)!;
    ctx.artifactReadIdentityStore.set(ref.artifactId, {
      ...identity,
      grantExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId] });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_EXPIRED' });
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('keeps native parse local: no Connector call at all', async () => {
    const ctx = new MockTaskContext();
    const csv = Buffer.from('item,total' + String.fromCharCode(10) + 'widget,10', 'utf8');
    const ref = await ctx.artifacts.write(csv, 'invoice.csv', 'text/csv');
    const input = IngestAction.validateInput({ mode: 'parse', artifactIds: [ref.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });

  it('keeps native split local: the Connector is never involved', async () => {
    const ctx = new MockTaskContext();
    const { TestFixtures } = await import('../../../orchestrator/packages/document-kit/tests/fixtures/test-fixtures');
    const ref = await ctx.artifacts.write(TestFixtures.createSamplePdf('p1'), 'doc.pdf', 'application/pdf');
    const input = IngestAction.validateInput({ mode: 'split', artifactIds: [ref.artifactId], pages: '1' });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });
});

describe('INGEST-WIRE-01: malformed HTTP wire and multipart boundaries', () => {
  const adapterConfig = {
    baseUrl: 'https://provider.example/',
    path: '/v1/ocr',
    timeoutMs: 1_000,
  };

  it('rejects malformed artifact bytes before building either JSON or multipart wire payloads', () => {
    const artifact = invocationArtifact(scanBytes());
    const malformedArtifact = { ...artifact, contentBase64: '%%%not-base64%%%' };
    const request = localInvocationRequest({ artifacts: [malformedArtifact] });

    expect(() => jsonHttpAdapter.buildRequest(request, adapterConfig)).toThrow();
    expect(() => multipartHttpAdapter.buildRequest(request, adapterConfig)).toThrow();
  });

  it('rejects malformed header values on a multipart request before transport', () => {
    const artifact = invocationArtifact(scanBytes());
    const request = localInvocationRequest({ artifacts: [artifact] });
    const built = multipartHttpAdapter.buildRequest(request, {
      ...adapterConfig,
      headers: { 'X-Trace': `valid-prefix${String.fromCharCode(13, 10)}X-Injected: yes` },
    });

    expect(() => new Headers(built.headers)).toThrow();
  });

  it('does not dispatch OCR when the source stream is interrupted after a partial read', async () => {
    const ctx = new MockTaskContext();
    const scan = handwritingScanBytes();
    const ref = await ctx.artifacts.write(scan, 'interrupted-scan.png', 'image/png');
    const identity = ctx.artifactReadIdentityStore.get(ref.artifactId)!;
    const format = ctx.artifactFormatMetadataStore.get(ref.artifactId)!;
    const streamingArtifacts = ctx.artifacts as TaskContext['artifacts'];
    delete streamingArtifacts.readWithMetadata;
    const stat = jest.fn(async () => ({
      fileName: format.declaredFileName,
      mimeType: format.declaredMimeType,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      storageVersionId: identity.storageVersionId,
      grantExpiresAt: identity.grantExpiresAt,
    }));
    const readStream = jest.fn(async () => Readable.from((async function* () {
      yield scan.subarray(0, Math.min(scan.length, 16));
      throw new Error('source stream interrupted mid-transfer');
    })()));
    Object.assign(streamingArtifacts, { stat, readStream });

    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow('source stream interrupted mid-transfer');
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((inv) => inv.slot === 'ocr')).toHaveLength(0);
  });

  it('escapes a nonstandard filename in multipart Content-Disposition without adding headers', async () => {
    const scan = scanBytes();
    const fileName = `scan\";${String.fromCharCode(13, 10)}X-Injected: yes.png`;
    const artifact = invocationArtifact(scan, fileName);
    const request = localInvocationRequest({ artifacts: [artifact] });
    const built = multipartHttpAdapter.buildRequest(request, adapterConfig);
    if (!(built.body instanceof FormData)) throw new Error('multipart adapter did not return FormData');
    const serialized = await new Request(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
    }).text();
    const lines = serialized.split(/\r?\n/);
    const disposition = lines.find((line) => line.startsWith('Content-Disposition:') && line.includes('filename='));

    expect(disposition).toContain('filename="scan%22;%0D%0AX-Injected: yes.png"');
    expect(lines.some((line) => line.startsWith('X-Injected:'))).toBe(false);
  });

  test.failing('rejects a multipart boundary marker that disagrees with the encoded body boundary', async () => {
    const artifact = invocationArtifact(scanBytes());
    const request = localInvocationRequest({ artifacts: [artifact] });
    const configuredBoundary = 'fixture-boundary-that-does-not-match';
    const built = multipartHttpAdapter.buildRequest(request, {
      ...adapterConfig,
      headers: { 'content-type': `multipart/form-data; boundary=${configuredBoundary}` },
    });
    if (!(built.body instanceof FormData)) throw new Error('multipart adapter did not return FormData');
    const wireBody = await new Request(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
    }).text();
    const contentType = new Headers(built.headers).get('content-type') ?? '';
    const declaredBoundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
    const bodyBoundary = wireBody.split(/\r?\n/, 1)[0]?.replace(/^--/, '');

    expect(declaredBoundary).toBe(bodyBoundary);
  });

  it('rejects CRLF injection in a multipart Content-Type boundary header', () => {
    const artifact = invocationArtifact(scanBytes());
    const request = localInvocationRequest({ artifacts: [artifact] });
    const built = multipartHttpAdapter.buildRequest(request, {
      ...adapterConfig,
      headers: { 'content-type': `multipart/form-data; boundary=valid${String.fromCharCode(13, 10)}X-Injected: yes` },
    });

    expect(() => new Headers(built.headers)).toThrow();
  });

  it('keeps quoted filename delimiters escaped in Content-Disposition', async () => {
    const artifact = invocationArtifact(scanBytes(), 'scan"broken-quote.png"');
    const request = localInvocationRequest({ artifacts: [artifact] });
    const built = multipartHttpAdapter.buildRequest(request, adapterConfig);
    if (!(built.body instanceof FormData)) throw new Error('multipart adapter did not return FormData');
    const serialized = await new Request(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
    }).text();
    const dispositionLines = serialized
      .split(/\r?\n/)
      .filter((line) => line.startsWith('Content-Disposition:') && line.includes('filename='));

    expect(dispositionLines).toHaveLength(1);
    expect(dispositionLines[0]).toContain('filename="scan%22broken-quote.png%22"');
  });

  it('aborts chunked source acquisition after the first chunk without dispatching OCR', async () => {
    const controller = new AbortController();
    const ctx = new MockTaskContext();
    ctx.signal = controller.signal;
    const scan = handwritingScanBytes();
    const ref = await ctx.artifacts.write(scan, 'aborted-chunked-scan.png', 'image/png');
    const identity = ctx.artifactReadIdentityStore.get(ref.artifactId)!;
    const format = ctx.artifactFormatMetadataStore.get(ref.artifactId)!;
    const streamingArtifacts = ctx.artifacts as TaskContext['artifacts'];
    delete streamingArtifacts.readWithMetadata;
    const stat = jest.fn(async () => ({
      fileName: format.declaredFileName,
      mimeType: format.declaredMimeType,
      sizeBytes: identity.sizeBytes,
      sha256: identity.sha256,
      storageVersionId: identity.storageVersionId,
      grantExpiresAt: identity.grantExpiresAt,
    }));
    const transferSignals: AbortSignal[] = [];
    let signalTransferStarted!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      signalTransferStarted = resolve;
    });
    const readStream = jest.fn(async (_artifactId: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) transferSignals.push(options.signal);
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          this.push(scan.subarray(0, Math.min(scan.length, 16)));
          signalTransferStarted();
        },
      });
    });
    Object.assign(streamingArtifacts, { stat, readStream });

    const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
    const pending = IngestAction.prepareSources(ctx, input);
    await transferStarted;
    controller.abort('cancel');

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(transferSignals[0]?.aborted).toBe(true);
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(ctx.connectorInvocations.filter((inv) => inv.slot === 'ocr')).toHaveLength(0);
  });
});
