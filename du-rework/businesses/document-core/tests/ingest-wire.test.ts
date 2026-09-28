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

import { createHash } from 'node:crypto';
import { IngestAction } from '../src/actions/ingest';
import { MockTaskContext } from './fixtures/mock-context';

const SCAN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function scanBytes(): Buffer {
  return Buffer.from(SCAN_PNG_BASE64, 'base64');
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
    expect(payload.artifacts).toEqual([{ artifactId: ref.artifactId }]);
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
    const form = scanBytes();
    const ref = await ctx.artifacts.write(form, 'intake.png', 'image/png');
    const input = IngestAction.validateInput({ mode: 'digitize', artifactIds: [ref.artifactId] });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);

    const call = ctx.connectorInvocations.find((inv) => inv.slot === 'vision');
    expect(call).toBeDefined();
    const payload = call?.payload as Record<string, unknown>;
    expect(payload.task).toBe('digitize_handwriting');
    expect(payload.artifacts).toEqual([{ artifactId: ref.artifactId }]);
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
    const { TestFixtures } = await import('../../../packages/document-kit/tests/fixtures/test-fixtures');
    const ref = await ctx.artifacts.write(TestFixtures.createSamplePdf('p1'), 'doc.pdf', 'application/pdf');
    const input = IngestAction.validateInput({ mode: 'split', artifactIds: [ref.artifactId], pages: '1' });
    const sources = await IngestAction.prepareSources(ctx, input);
    await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    expect(ctx.connectorInvocations).toHaveLength(0);
  });
});