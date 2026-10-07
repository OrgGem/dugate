import { DocumentFormatDetector, defaultParserFactory } from '@du/document-kit';
import type { ParseResult } from '@du/document-kit';
import { documentCoreHandlers } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';
import { TestFixtures } from '../../../orchestrator/packages/document-kit/tests/fixtures/test-fixtures';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type ActionName = 'ingest' | 'extract' | 'analyze' | 'transform' | 'generate' | 'compare';
type OfficeFormat = 'docx' | 'xlsx';

interface OfficeArtifactFixture {
  artifactId: string;
  bytes: Buffer;
  declaredFileName: string;
  declaredMimeType: string;
  canonicalFormat: OfficeFormat;
  canonicalMimeType: string;
}

interface ActionCase {
  action: ActionName;
  payload: Record<string, unknown>;
  artifacts: OfficeArtifactFixture[];
  expectedConnectorCalls: number;
}

const docxBytes = TestFixtures.createZipArchive([
  {
    name: 'word/document.xml',
    content: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Trusted DOCX source content</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Widget A</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>250</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
      'utf8'
    ),
  },
  { name: '[Content_Types].xml', content: Buffer.from('<Types/>', 'utf8') },
]);
const xlsxBytes = TestFixtures.createSyntheticXlsx([
  ['Account', 'Amount'],
  ['A-100', '250'],
]);

function officeArtifact(
  artifactId: string,
  format: OfficeFormat,
  declaredFileName: string,
  declaredMimeType: string = format === 'docx' ? DOCX_MIME : XLSX_MIME
): OfficeArtifactFixture {
  const bytes = format === 'docx' ? docxBytes : xlsxBytes;
  const detected = DocumentFormatDetector.detect(bytes, declaredFileName, declaredMimeType);
  if (detected.format !== format) {
    throw new Error(`Invalid ${format} fixture; document-kit detected ${detected.format}`);
  }

  return {
    artifactId,
    bytes,
    declaredFileName,
    declaredMimeType,
    canonicalFormat: format,
    canonicalMimeType: detected.mimeType,
  };
}

const ACTION_CASES: ActionCase[] = [
  {
    action: 'ingest',
    payload: { mode: 'parse', artifactIds: ['ingest-docx'] },
    artifacts: [officeArtifact('ingest-docx', 'docx', 'ingest-source.docx')],
    expectedConnectorCalls: 0,
  },
  {
    action: 'extract',
    payload: { type: 'invoice', artifactIds: ['extract-xlsx'] },
    artifacts: [officeArtifact('extract-xlsx', 'xlsx', 'invoice-ledger.xlsx')],
    expectedConnectorCalls: 1,
  },
  {
    action: 'analyze',
    payload: { task: 'classify', categories: ['finance'], artifactIds: ['analyze-docx'] },
    artifacts: [officeArtifact('analyze-docx', 'docx', 'analysis-source.xlsx', XLSX_MIME)],
    expectedConnectorCalls: 1,
  },
  {
    action: 'transform',
    payload: { variant: 'rewrite', artifactIds: ['transform-xlsx'] },
    artifacts: [officeArtifact('transform-xlsx', 'xlsx', 'transform-source.docx', DOCX_MIME)],
    expectedConnectorCalls: 1,
  },
  {
    action: 'generate',
    payload: { task: 'summary', artifactIds: ['generate-docx'] },
    artifacts: [officeArtifact('generate-docx', 'docx', 'generate-source.docx')],
    expectedConnectorCalls: 1,
  },
  {
    action: 'compare',
    payload: {
      mode: 'diff',
      source: { artifactId: 'compare-source-docx' },
      target: { artifactId: 'compare-target-xlsx' },
    },
    artifacts: [
      officeArtifact('compare-source-docx', 'docx', 'compare-source.docx'),
      officeArtifact('compare-target-xlsx', 'xlsx', 'compare-target.xlsx'),
    ],
    expectedConnectorCalls: 0,
  },
];

function configureProviderResponse(ctx: MockTaskContext, action: ActionName): void {
  const responses: Partial<Record<ActionName, MockTaskContext['defaultConnectorResponse']>> = {
    extract: {
      invocationId: 'inv-extract-office',
      status: 'SUCCESS',
      data: { invoiceNumber: 'INV-2048', supplier: 'Northwind' },
    },
    analyze: {
      invocationId: 'inv-analyze-office',
      status: 'SUCCESS',
      data: { category: 'finance', confidence: 0.97 },
    },
    transform: {
      invocationId: 'inv-transform-office',
      status: 'SUCCESS',
      rawText: 'Rewritten Office source.',
    },
    generate: {
      invocationId: 'inv-generate-office',
      status: 'SUCCESS',
      rawText: 'Generated Office summary.',
    },
  };
  const response = responses[action];
  if (response) {
    ctx.mockConnectorResponses.set('reasoning', response);
  }
}

describe('R1-E Layer 7: isolated Office parsing through all six document-core actions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(ACTION_CASES)('$action preserves source metadata and extracts Office text/tables', async (testCase) => {
    const handler = documentCoreHandlers[testCase.action];
    if (!handler) {
      throw new Error(`No document-core handler registered for action "${testCase.action}"`);
    }

    const ctx = new MockTaskContext();
    for (const artifact of testCase.artifacts) {
      ctx.storeArtifact(
        artifact.artifactId,
        artifact.bytes,
        artifact.declaredFileName,
        artifact.declaredMimeType
      );
    }
    configureProviderResponse(ctx, testCase.action);

    const metadataReadSpy = jest.spyOn(ctx.artifacts, 'readWithMetadata');
    const parserSpy = jest.spyOn(defaultParserFactory, 'parseBuffer');

    const disposition = await handler(ctx, testCase.payload);

    expect(disposition.kind).toBe('completed');
    expect(metadataReadSpy).toHaveBeenCalledTimes(testCase.artifacts.length);
    expect(parserSpy).toHaveBeenCalledTimes(testCase.artifacts.length);
    expect(ctx.connectorInvocations).toHaveLength(testCase.expectedConnectorCalls);
    expect(ctx.artifactsStore.size).toBe(testCase.artifacts.length + 1);

    for (let index = 0; index < testCase.artifacts.length; index += 1) {
      const artifact = testCase.artifacts[index];
      if (!artifact) {
        throw new Error(`Artifact fixture ${index} was not defined`);
      }
      const readResultPromise = metadataReadSpy.mock.results[index]?.value as Promise<{
        buffer: Buffer;
        formatMetadata: {
          canonicalFormat: string;
          canonicalMimeType: string;
          declaredFileName?: string;
          declaredMimeType?: string;
        };
      }>;
      const readResult = await readResultPromise;
      expect(readResult.buffer).toEqual(artifact.bytes);
      expect(readResult.formatMetadata).toEqual({
        canonicalFormat: artifact.canonicalFormat,
        canonicalMimeType: artifact.canonicalMimeType,
        declaredFileName: artifact.declaredFileName,
        declaredMimeType: artifact.declaredMimeType,
      });

      const parserCall = parserSpy.mock.calls[index];
      if (!parserCall) {
        throw new Error(`Parser call ${index} was not recorded`);
      }
      expect(parserCall[0]).toEqual(artifact.bytes);
      expect(parserCall[1]).toBe(artifact.declaredFileName);
      expect(parserCall[2]).toBe(artifact.canonicalMimeType);
      expect(parserCall[3]).toEqual(
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
      expect(parserCall[3]?.timeoutMs).toBeGreaterThan(0);

      const parseResultPromise = parserSpy.mock.results[index]?.value as Promise<ParseResult>;
      const parseResult = await parseResultPromise;
      expect(parseResult.metadata.detectedFormat).toBe(artifact.canonicalFormat);

      if (artifact.canonicalFormat === 'docx') {
        expect(parseResult.text).toBe(
          'Trusted DOCX source content\n\nItem\tAmount\nWidget A\t250'
        );
        expect(parseResult.markdown).toBe(
          'Trusted DOCX source content\n\n| Item | Amount |\n| --- | --- |\n| Widget A | 250 |'
        );
      } else {
        expect(parseResult.text).toContain('Account\tAmount');
        expect(parseResult.text).toContain('A-100\t250');
        expect(parseResult.markdown).toContain('| Account | Amount |');
        expect(parseResult.markdown).toContain('| A-100 | 250 |');
      }
    }
  });
});
