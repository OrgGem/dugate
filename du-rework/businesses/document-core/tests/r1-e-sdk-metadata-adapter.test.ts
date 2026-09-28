import { randomUUID } from 'node:crypto';
import { ArtifactRef } from '@du/contracts';
import { defaultParserFactory, DocumentFormatDetector } from '@du/document-kit';
import { TaskContext as SdkTaskContext } from '@du/worker-sdk';
import { documentCoreHandlers } from '../src/worker';
import { TestFixtures } from '../../../packages/document-kit/tests/fixtures/test-fixtures';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('document-core SDK artifact metadata adapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('converts read-grant metadata to byte-derived canonical identity before parsing', async () => {
    const artifactId = randomUUID();
    const outputId = randomUUID();
    const filename = 'Original Upload Name.docx';
    const bytes = TestFixtures.createSyntheticDocx('SDK metadata reaches the parser');
    const metadata = DocumentFormatDetector.detect(bytes, filename, DOCX_MIME);
    const readWithMetadata = jest.fn().mockResolvedValue({
      buffer: bytes,
      filename,
      mimeType: DOCX_MIME,
      sizeBytes: bytes.length,
      sha256: 'a'.repeat(64),
    });
    const write = jest.fn(async (): Promise<ArtifactRef> => ({
      artifactId: outputId,
      role: 'output',
      fileName: 'ingest_result.json',
      mimeType: 'application/json',
      sizeBytes: 0,
      hashSha256: 'b'.repeat(64),
    }));
    const parserSpy = jest.spyOn(defaultParserFactory, 'parseBuffer');
    const sdkContext = {
      taskId: randomUUID(),
      operationId: randomUUID(),
      tenantId: randomUUID(),
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'ingest',
      kind: 'ingest',
      taskKey: 'root',
      attempt: 1,
      leaseEpoch: 1,
      deadlineAt: null,
      cancelRequested: false,
      input: { mode: 'parse', artifactIds: [artifactId] },
      connectorBindings: {},
      signal: new AbortController().signal,
      artifacts: {
        read: async () => bytes,
        readWithMetadata,
        write,
      },
      step: {
        run: async (_key: string, _inputHash: string, fn: () => Promise<unknown>) => fn(),
        peek: async () => null,
      },
      connector: { invoke: async () => { throw new Error('unused for ingest parse'); } },
      spawn: {},
      wait: {},
      progress: {},
      checkpoints: () => [],
      grantFor: async () => { throw new Error('unused'); },
    } as unknown as SdkTaskContext;

    const result = await documentCoreHandlers.ingest!(sdkContext);

    expect(result.kind).toBe('completed');
    expect(readWithMetadata).toHaveBeenCalledWith(artifactId);
    expect(parserSpy).toHaveBeenCalledWith(bytes, filename, metadata.mimeType, expect.objectContaining({
      timeoutMs: expect.any(Number),
    }));
    const parsed = await parserSpy.mock.results[0]?.value;
    expect(parsed.metadata.detectedFormat).toBe('docx');
    expect(parsed.text).toContain('SDK metadata reaches the parser');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
