import { defaultParserFactory } from '@du/document-kit';
import type { ParseResult } from '@du/document-kit';
import type { TaskHandler } from '@du/worker-sdk';
import { itemReviewHandler, mainReviewHandler } from '../src/review';
import { createMockTaskContext } from './test-helper';
import { TestFixtures } from '../../../orchestrator/packages/document-kit/tests/fixtures/test-fixtures';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PARSER_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 30_000;

const docxBytes = TestFixtures.createZipArchive([
  {
    name: 'word/document.xml',
    content: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly review evidence</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Retention policy</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Active</w:t></w:r></w:p></w:tc>
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
  ['Control', 'Status'],
  ['Retention policy', 'Active'],
]);

interface OfficeFixture {
  artifactId: string;
  bytes: Buffer;
  canonicalFormat: 'docx' | 'xlsx';
  canonicalMimeType: string;
  fileName: string;
  expectedText: string[];
  expectedMarkdown: string[];
}

const OFFICE_FIXTURES: OfficeFixture[] = [
  {
    artifactId: 'source-docx',
    bytes: docxBytes,
    canonicalFormat: 'docx',
    canonicalMimeType: DOCX_MIME,
    fileName: 'quarterly-evidence.docx',
    expectedText: [
      'Quarterly review evidence',
      'Control\tStatus',
      'Retention policy\tActive',
    ],
    expectedMarkdown: [
      '| Control | Status |',
      '| Retention policy | Active |',
    ],
  },
  {
    artifactId: 'source-xlsx',
    bytes: xlsxBytes,
    canonicalFormat: 'xlsx',
    canonicalMimeType: XLSX_MIME,
    fileName: 'quarterly-controls.xlsx',
    expectedText: ['Control\tStatus', 'Retention policy\tActive'],
    expectedMarkdown: ['| Control | Status |', '| Retention policy | Active |'],
  },
];

interface ReviewPath {
  label: string;
  kind: string;
  handler: TaskHandler;
  inputFor: (fixture: OfficeFixture) => Record<string, unknown>;
}

const REVIEW_PATHS: ReviewPath[] = [
  {
    label: 'single-item root',
    kind: 'review',
    handler: mainReviewHandler,
    inputFor: (fixture) => ({
      reviewId: `review-${fixture.canonicalFormat}`,
      artifacts: [{ artifactId: fixture.artifactId, fileName: fixture.fileName }],
      enableReasoning: true,
    }),
  },
  {
    label: 'fan-out child',
    kind: 'review-item',
    handler: itemReviewHandler,
    inputFor: (fixture) => ({
      reviewId: `review-${fixture.canonicalFormat}`,
      itemIndex: 0,
      artifact: { artifactId: fixture.artifactId, fileName: fixture.fileName },
      enableReasoning: true,
    }),
  },
];

const OFFICE_REVIEW_CASES = OFFICE_FIXTURES.flatMap((fixture) => {
  const misleadingFileName = fixture.canonicalFormat === 'docx'
    ? 'declared-as-xlsx.xlsx'
    : 'declared-as-docx.docx';
  return REVIEW_PATHS.flatMap((reviewPath) => [
    { fixture, reviewPath, declaredFileName: fixture.fileName },
    { fixture, reviewPath, declaredFileName: misleadingFileName },
  ]);
});

describe('R1-E Layer 7: example-review uses isolated safe parsers for Office evidence', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(OFFICE_REVIEW_CASES)(
    '$reviewPath.label parses $fixture.canonicalFormat from declared filename $declaredFileName',
    async ({ fixture, reviewPath, declaredFileName }) => {
      const declaredFixture = { ...fixture, fileName: declaredFileName };
      const { ctx, connectorCalls, writtenArtifacts } = createMockTaskContext({
        kind: reviewPath.kind,
        input: reviewPath.inputFor(declaredFixture),
        connectorBindings: { reasoning: 'reasoning-connector@1' },
        artifactsMap: { [fixture.artifactId]: fixture.bytes },
      });
      const parserSpy = jest.spyOn(defaultParserFactory, 'parseBuffer');

      const disposition = await reviewPath.handler(ctx);

      expect(disposition.kind).toBe('completed');
      expect(parserSpy).toHaveBeenCalledTimes(1);
      expect(parserSpy).toHaveBeenCalledWith(
        fixture.bytes,
        declaredFileName,
        fixture.canonicalMimeType,
        {
          maxBufferSizeBytes: PARSER_MAX_BUFFER_BYTES,
          timeoutMs: PARSER_TIMEOUT_MS,
        }
      );

      const parseResultPromise = parserSpy.mock.results[0]?.value as Promise<ParseResult>;
      const parseResult = await parseResultPromise;
      expect(parseResult.metadata.detectedFormat).toBe(fixture.canonicalFormat);
      for (const expected of fixture.expectedText) {
        expect(parseResult.text).toContain(expected);
      }
      for (const expected of fixture.expectedMarkdown) {
        expect(parseResult.markdown).toContain(expected);
      }

      expect(connectorCalls).toHaveLength(1);
      expect(connectorCalls[0]?.input).toMatchObject({
        text: parseResult.text.slice(0, 4000),
      });
      expect(writtenArtifacts.length).toBeGreaterThan(0);
      expect(writtenArtifacts.map((artifact) => artifact.content.toString()).join('\n'))
        .toContain('"passed": true');
    }
  );

  it('fails closed on unsafe Office archives without exposing filenames or parser exceptions', async () => {
    const unsafeDocxBytes = TestFixtures.createZipArchive([
      {
        name: '../word/document.xml',
        content: Buffer.from('<w:document/>', 'utf8'),
      },
      { name: '[Content_Types].xml', content: Buffer.from('<Types/>', 'utf8') },
    ]);
    const sensitiveFileName =
      'SENTINEL_API_KEY=credential-sentinel/private/customer.docx?X-Amz-Signature=signature-sentinel';
    const { ctx, connectorCalls, writtenArtifacts, waitCalls } = createMockTaskContext({
      kind: 'review',
      input: {
        reviewId: 'review-unsafe-office',
        artifacts: [{ artifactId: 'unsafe-docx', fileName: sensitiveFileName }],
        enableReasoning: true,
      },
      connectorBindings: { reasoning: 'reasoning-connector@1' },
      artifactsMap: { 'unsafe-docx': unsafeDocxBytes },
    });
    const parserSpy = jest.spyOn(defaultParserFactory, 'parseBuffer');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    let thrown: unknown;
    try {
      await mainReviewHandler(ctx);
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Unable to parse Office source artifact; review cannot continue without valid document evidence.'
    );
    expect(parserSpy).toHaveBeenCalledTimes(1);
    expect(connectorCalls).toHaveLength(0);
    expect(writtenArtifacts).toHaveLength(0);
    expect(waitCalls).toHaveLength(0);

    const logs = JSON.stringify(errorSpy.mock.calls);
    expect(logs).toContain('DOCUMENT_PARSE_FAILED');
    expect(logs).toContain('[REDACTED]');
    expect(logs).not.toContain('credential-sentinel');
    expect(logs).not.toContain('signature-sentinel');
    expect(logs).not.toContain(sensitiveFileName);
    expect(logs).not.toContain('path traversal');
    expect((thrown as Error).message).not.toContain('credential-sentinel');
    expect((thrown as Error).message).not.toContain('signature-sentinel');
    expect((thrown as Error).message).not.toContain(sensitiveFileName);

  });
});
