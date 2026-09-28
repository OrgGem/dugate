import { defaultParserFactory } from '@du/document-kit';
import { documentCoreHandlers } from '../src/worker';
import { BusinessExecutionError } from '../src/types/results';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import { MockTaskContext } from './fixtures/mock-context';

type ActionName = 'ingest' | 'extract' | 'analyze' | 'transform' | 'generate' | 'compare';

interface ArchiveFailureFixture {
  name: string;
  bytes: Buffer;
  expectedMessage: RegExp;
}

interface ActionFailureCase extends ArchiveFailureFixture {
  action: ActionName;
}

const ACTIONS: ActionName[] = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'];
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function createLocalZipHeader(options: {
  name?: string;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}): Buffer {
  const fileName = Buffer.from(options.name ?? 'word/document.xml', 'utf8');
  const header = Buffer.alloc(30 + fileName.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(options.flags ?? 0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(options.compressedSize ?? 0, 18);
  header.writeUInt32LE(options.uncompressedSize ?? 0, 22);
  header.writeUInt16LE(fileName.length, 26);
  header.writeUInt16LE(0, 28);
  fileName.copy(header, 30);
  return header;
}

const ARCHIVE_FAILURES: ArchiveFailureFixture[] = [
  {
    name: 'ZIP64 local size sentinels',
    bytes: createLocalZipHeader({ compressedSize: 0xffffffff, uncompressedSize: 0xffffffff }),
    expectedMessage: /ZIP64 local entry sizes are unsupported/,
  },
  {
    name: 'unsupported data descriptor flag',
    bytes: createLocalZipHeader({ flags: 0x0008 }),
    expectedMessage: /ZIP data descriptors are unsupported/,
  },
];

const ACTION_FAILURES: ActionFailureCase[] = ACTIONS.flatMap((action) =>
  ARCHIVE_FAILURES.map((archive) => ({ ...archive, action }))
);

function createPayload(action: ActionName, artifactId: string): Record<string, unknown> {
  switch (action) {
    case 'ingest':
      return { mode: 'parse', artifactIds: [artifactId] };
    case 'extract':
      return { type: 'invoice', artifactIds: [artifactId] };
    case 'analyze':
      return { task: 'classify', categories: ['finance'], artifactIds: [artifactId] };
    case 'transform':
      return { variant: 'rewrite', artifactIds: [artifactId] };
    case 'generate':
      return { task: 'summary', artifactIds: [artifactId] };
    case 'compare':
      return {
        mode: 'diff',
        source: { artifactId },
        target: { text: 'A readable target document.' },
      };
  }
}

describe('R1-E Layer 6: archive preflight and CPU isolation across all actions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(ACTION_FAILURES)(
    '$action fails closed on $name before connector invocation or output write',
    async (testCase) => {
      const handler = documentCoreHandlers[testCase.action];
      if (!handler) {
        throw new Error(`No document-core handler registered for ${testCase.action}`);
      }

      const artifactId = `${testCase.action}-layer6-${testCase.name.replace(/\W+/g, '-')}`;
      const ctx = new MockTaskContext();
      ctx.storeArtifact(artifactId, testCase.bytes, 'source.docx', DOCX_MIME);

      const readSpy = jest.spyOn(ctx.artifacts, 'readWithMetadata');
      const parseSpy = jest.spyOn(defaultParserFactory, 'parseBuffer');
      let outputWriteCount = 0;
      const originalWrite = ctx.artifacts.write;
      ctx.artifacts.write = async (content, fileName, mimeType) => {
        outputWriteCount += 1;
        return originalWrite(content, fileName, mimeType);
      };

      let failure: unknown;
      try {
        await handler(ctx, createPayload(testCase.action, artifactId));
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(BusinessExecutionError);
      expect((failure as BusinessExecutionError).code).toBe('DOC_PARSING_FAILED');
      expect((failure as Error).message).toMatch(testCase.expectedMessage);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(parseSpy.mock.calls[0]?.[3]?.timeoutMs).toBe(
        ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS
      );
      expect(ctx.connectorInvocations).toHaveLength(0);
      expect(outputWriteCount).toBe(0);
      expect(ctx.artifactsStore.size).toBe(1);
    }
  );
});
