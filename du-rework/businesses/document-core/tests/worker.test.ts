import { documentCoreHandlers, documentCoreBusinessDefinition } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';

describe('Document Core Worker & Handlers (P5-02)', () => {
  let ctx: MockTaskContext;

  beforeEach(() => {
    ctx = new MockTaskContext();
  });

  it('exposes valid business definition with manifest and handlers', () => {
    expect(documentCoreBusinessDefinition.manifest.businessId).toBe('document-core');
    expect(Object.keys(documentCoreBusinessDefinition.handlers).sort()).toEqual([
      'analyze',
      'compare',
      'disbursement',
      'extract',
      'generate',
      'ingest',
      'root',
      'transform',
    ]);
  });

  it('executes root handler delegating to ingest action', async () => {
    const rootHandler = documentCoreHandlers['root']!;
    const disposition = await rootHandler(ctx, {
      action: 'ingest',
      mode: 'parse',
      text: 'Root routed ingestion test',
    });

    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(typeof disposition.resultRef).toBe('string');
      expect(disposition.resultRef).toMatch(/^artifact:\/\//);
      const artifactId = disposition.resultRef.replace('artifact://', '');
      const written = ctx.artifactsStore.get(artifactId);
      expect(written).toBeDefined();
    }
  });

  it('executes ingest handler and writes result artifact', async () => {
    const handler = documentCoreHandlers['ingest']!;
    const disposition = await handler(ctx, {
      mode: 'parse',
      text: 'Simple plain text',
    });

    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(typeof disposition.resultRef).toBe('string');
      expect(disposition.resultRef).toMatch(/^artifact:\/\//);
      const artifactId = disposition.resultRef.replace('artifact://', '');
      const written = ctx.artifactsStore.get(artifactId);
      expect(written).toBeDefined();
    }
  });

  it('executes extract handler and writes result artifact', async () => {
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-ext',
      status: 'SUCCESS',
      data: { invoiceNumber: 'INV-101', total: 500 },
    };

    const handler = documentCoreHandlers['extract']!;
    const disposition = await handler(ctx, {
      type: 'invoice',
      text: 'Invoice INV-101 Total $500',
    });

    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(typeof disposition.resultRef).toBe('string');
      expect(disposition.resultRef).toMatch(/^artifact:\/\//);
      const artifactId = disposition.resultRef.replace('artifact://', '');
      const written = ctx.artifactsStore.get(artifactId);
      expect(written).toBeDefined();
    }
  });

  it('executes compare handler and writes result artifact', async () => {
    const handler = documentCoreHandlers['compare']!;
    const disposition = await handler(ctx, {
      mode: 'diff',
      source: { text: 'Hello World' },
      target: { text: 'Hello New World' },
    });

    expect(disposition.kind).toBe('completed');
    if (disposition.kind === 'completed') {
      expect(typeof disposition.resultRef).toBe('string');
      expect(disposition.resultRef).toMatch(/^artifact:\/\//);
      const artifactId = disposition.resultRef.replace('artifact://', '');
      const written = ctx.artifactsStore.get(artifactId);
      expect(written).toBeDefined();
    }
  });
});
