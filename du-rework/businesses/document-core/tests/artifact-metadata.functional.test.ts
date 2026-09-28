import { documentCoreHandlers, TaskDisposition } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import type { ResultEnvelope } from '../src/types/results';
import type { ArtifactRef } from '../src/types/context';

/**
 * FT-02 — Artifact metadata / readback contract (functional, offline, zero DB).
 * Anchor: tasks/P2-orchestrator.md row P2-03 [ ] (business-side ART metadata slice:
 * the artifact the document-core business persists, with exact metadata, before any
 * orchestrator storage/access API exists — MM-02/P2-07 related).
 *
 * Why functional-not-unit:
 *  - worker.test.ts / all-variants-e2e assert an artifact is written and the envelope
 *    is well-formed, but never assert the PERSISTED artifact metadata contract:
 *    fileName, mimeType, role, sizeBytes, resultRef scheme, byte-level readback;
 *  - this suite runs the real handlers and reads back the durable artifact exactly as
 *    a storage consumer (the P2-03 / MM-02 consumer path) would.
 */

type Prior = MockTaskContext['artifacts'];

function withArtifactSpy(ctx: MockTaskContext): ArtifactRef[] {
  const written: ArtifactRef[] = [];
  const originalWrite: Prior['write'] = ctx.artifacts.write.bind(ctx.artifacts);
  ctx.artifacts.write = async (content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef> => {
    const ref = await originalWrite(content, fileName, mimeType);
    written.push(ref);
    return ref;
  };
  return written;
}

function assertArtifactMetadataContract(
  ctx: MockTaskContext,
  written: ArtifactRef[],
  disposition: TaskDisposition,
  expectedFileName: string
): { envelope: ResultEnvelope<unknown>; artifactBytes: Buffer } {
  // 0. Terminal disposition must be completed (artifact produced)
  expect(disposition.kind).toBe('completed');
  if (disposition.kind !== 'completed') {
    throw new Error(`Expected completed disposition, got ${disposition.kind}`);
  }

  // 1. resultRef scheme: artifact://<id> pointing at the just-written artifact
  expect(disposition.resultRef).toMatch(/^artifact:\/\//);
  const artifactId = disposition.resultRef.replace('artifact://', '');
  expect(artifactId.length).toBeGreaterThan(0);

  // 2. The handler wrote exactly one artifact (the final result envelope)
  expect(written.length).toBe(1);
  const ref = written[0]!;
  expect(ref.artifactId).toBe(artifactId);
  expect(ref.role).toBe('output');
  expect(ref.fileName).toBe(expectedFileName);
  expect(ref.mimeType).toBe('application/json');

  // 3. Read back the durable artifact exactly as a storage consumer would
  const artifactBytes = ctx.artifactsStore.get(artifactId);
  expect(artifactBytes).toBeDefined();
  if (!artifactBytes) {
    throw new Error(`Artifact "${artifactId}" missing from store`);
  }
  expect(ref.sizeBytes).toBe(artifactBytes.length);

  // 4. Byte-level round-trip fidelity: re-stringify of the parsed envelope equals the
  //    stored bytes (the handler writes JSON.stringify(envelope, null, 2)).
  const parsed = JSON.parse(artifactBytes.toString('utf8')) as ResultEnvelope<unknown>;
  expect(JSON.stringify(parsed, null, 2)).toBe(artifactBytes.toString('utf8'));

  // 5. Envelope invariants
  expect(parsed.status).toBe('COMPLETED');
  expect(Array.isArray(parsed.warnings)).toBe(true);

  return { envelope: parsed, artifactBytes };
}

describe('FT-02 Artifact Metadata & Readback Contract (functional, P2-03 [ ] business slice)', () => {
  it('ingest/parse: writes ingest_result.json with native provenance and exact byte readback', async () => {
    const ctx = new MockTaskContext();
    const written = withArtifactSpy(ctx);
    const disposition = await documentCoreHandlers.ingest!(ctx, { mode: 'parse', text: '# Hello FT-02' });

    const { envelope } = assertArtifactMetadataContract(ctx, written, disposition, 'ingest_result.json');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(envelope.provenance.modelSlot).toBeUndefined();
    expect(envelope.data && (envelope.data as { metadata?: { provenance?: string } }).metadata?.provenance).toBe('native_parse');
    // Local-only recipe: zero provider calls (DOC-01 "parser không tự gọi LLM")
    expect(ctx.connectorInvocations.length).toBe(0);
  });

  it('extract/invoice: writes extract_result.json, exactly one reasoning invocation, llm_extraction provenance', async () => {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext-ft02',
      status: 'SUCCESS',
      data: {
        supplier: { name: 'ABC Tech', taxId: 'TAX-001' },
        buyer: { name: 'XYZ Corp' },
        invoiceNumber: 'INV-2026-001',
        invoiceDate: '2026-01-15',
        lineItems: [{ description: 'Consulting Services', quantity: 1, unitPrice: 1000000, amount: 1000000 }],
        subtotal: 1000000,
        total: 1000000,
        currency: 'USD',
      },
    };
    const written = withArtifactSpy(ctx);
    const disposition = await documentCoreHandlers.extract!(ctx, {
      type: 'invoice',
      text: 'Sample invoice text',
      outputFormat: 'json',
    });

    const { envelope } = assertArtifactMetadataContract(ctx, written, disposition, 'extract_result.json');
    expect(envelope.provenance.method).toBe('llm_extraction');
    expect(envelope.provenance.modelSlot).toBe('reasoning');
    expect(envelope.data && (envelope.data as { invoiceNumber?: string }).invoiceNumber).toBe('INV-2026-001');
    // Exactly one provider call for the whole execution — no duplicates, no re-inference
    expect(ctx.connectorInvocations.length).toBe(1);
    expect(ctx.connectorInvocations[0]!.slot).toBe('reasoning');
  });

  it('transform/redact: writes transform_result.json, zero provider calls, local provenance', async () => {
    const ctx = new MockTaskContext();
    const written = withArtifactSpy(ctx);
    const disposition = await documentCoreHandlers.transform!(ctx, {
      variant: 'redact',
      text: 'Send info to alice@example.com or call 555-123-4567.',
      outputFormat: 'json',
    });

    const { envelope } = assertArtifactMetadataContract(ctx, written, disposition, 'transform_result.json');
    expect(envelope.provenance.method).toBe('native_parse');
    expect(envelope.provenance.modelSlot).toBeUndefined();
    expect((envelope.data as { transformedText?: string }).transformedText).toContain('[REDACTED:EMAIL]');
    expect(ctx.connectorInvocations.length).toBe(0);
  });

  it('compare/diff: writes compare_result.json, zero provider calls, diff provenance', async () => {
    const ctx = new MockTaskContext();
    const written = withArtifactSpy(ctx);
    const disposition = await documentCoreHandlers.compare!(ctx, {
      mode: 'diff',
      source: { text: 'Line 1\nLine 2' },
      target: { text: 'Line 1\nLine 2 modified\nLine 3' },
      outputFormat: 'json',
    });

    const { envelope } = assertArtifactMetadataContract(ctx, written, disposition, 'compare_result.json');
    expect(envelope.provenance.method).toBe('diff');
    expect(envelope.provenance.modelSlot).toBeUndefined();
    expect(ctx.connectorInvocations.length).toBe(0);
  });

  it('fail-closed input writes NO artifact and saves NO checkpoint (zero side-effect invariant for all six actions)', async () => {
    const actionsWithBadInput: Array<[string, Record<string, unknown>]> = [
      ['ingest', { mode: 'scan' }],
      ['extract', { type: 'pdf' }],
      ['analyze', { task: 'chat' }],
      ['transform', { variant: 'excel' }],
      ['generate', { task: 'chat' }],
      ['compare', { mode: 'merge' }],
    ];
    for (const [action, payload] of actionsWithBadInput) {
      const ctx = new MockTaskContext();
      await expect(documentCoreHandlers[action]!(ctx, payload)).rejects.toBeDefined();
      expect(ctx.artifactsStore.size).toBe(0);
      expect(ctx.connectorInvocations.length).toBe(0);
      expect(ctx.checkpointsStore.size).toBe(0);
    }
  });
});