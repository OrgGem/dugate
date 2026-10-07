import { SafeArchiveExtractor } from '../src/archives/zip-extractor';
import { DocumentFormatDetector } from '../src/formats/detector';
import { DocumentParserFactory } from '../src/parsers/factory';
import { FormatDetectionResult } from '../src/types';
import { TestFixtures } from './fixtures/test-fixtures';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_MIME = 'application/zip';

interface IdentityCase {
  name: string;
  bytes: Buffer;
  fileName?: string;
  mimeHint?: string;
  expectedFormat: 'docx' | 'xlsx';
  expectedMime: string;
  expectedExtension: string;
}

const docxBytes = TestFixtures.createSyntheticDocx('DOCX container identity');
const xlsxBytes = TestFixtures.createSyntheticXlsx([
  ['Header', 'Value'],
  ['Row', '1'],
]);
const genericZip = TestFixtures.createZipArchive([
  { name: 'notes.txt', content: Buffer.from('ordinary ZIP, not an Office package') },
]);

const officeIdentityCases: IdentityCase[] = [
  {
    name: 'DOCX canonical extension and MIME',
    bytes: docxBytes,
    fileName: 'contract.docx',
    mimeHint: DOCX_MIME,
    expectedFormat: 'docx',
    expectedMime: DOCX_MIME,
    expectedExtension: '.docx',
  },
  {
    name: 'DOCX extension only',
    bytes: docxBytes,
    fileName: 'contract.docx',
    expectedFormat: 'docx',
    expectedMime: DOCX_MIME,
    expectedExtension: '.docx',
  },
  {
    name: 'DOCX MIME only',
    bytes: docxBytes,
    mimeHint: DOCX_MIME,
    expectedFormat: 'docx',
    expectedMime: DOCX_MIME,
    expectedExtension: '',
  },
  {
    name: 'XLSX canonical extension and MIME',
    bytes: xlsxBytes,
    fileName: 'ledger.xlsx',
    mimeHint: XLSX_MIME,
    expectedFormat: 'xlsx',
    expectedMime: XLSX_MIME,
    expectedExtension: '.xlsx',
  },
  {
    name: 'XLSX extension only',
    bytes: xlsxBytes,
    fileName: 'ledger.xlsx',
    expectedFormat: 'xlsx',
    expectedMime: XLSX_MIME,
    expectedExtension: '.xlsx',
  },
  {
    name: 'XLSX MIME only',
    bytes: xlsxBytes,
    mimeHint: XLSX_MIME,
    expectedFormat: 'xlsx',
    expectedMime: XLSX_MIME,
    expectedExtension: '',
  },
];

function assertDeclaredIdentity(
  result: FormatDetectionResult,
  fileName?: string,
  mimeHint?: string
): void {
  expect(result.declaredFileName).toBe(fileName);
  expect(result.declaredMimeType).toBe(mimeHint);
}

describe('R1-E canonical format and declared identity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(officeIdentityCases)('$name is detected from Office container markers', (testCase) => {
    const result = DocumentFormatDetector.detect(
      testCase.bytes,
      testCase.fileName,
      testCase.mimeHint
    );

    expect(result.format).toBe(testCase.expectedFormat);
    expect(result.mimeType).toBe(testCase.expectedMime);
    expect(result.extension).toBe(testCase.expectedExtension);
    expect(result.isOfficeDocument).toBe(true);
    expect(result.isArchive).toBe(false);
    assertDeclaredIdentity(result, testCase.fileName, testCase.mimeHint);
  });

  it.each([
    {
      name: 'DOCX bytes with XLSX declarations',
      bytes: docxBytes,
      fileName: 'declared.xlsx',
      mimeHint: XLSX_MIME,
      expectedFormat: 'docx' as const,
      expectedMime: DOCX_MIME,
      expectedExtension: '.xlsx',
    },
    {
      name: 'XLSX bytes with DOCX declarations',
      bytes: xlsxBytes,
      fileName: 'declared.docx',
      mimeHint: DOCX_MIME,
      expectedFormat: 'xlsx' as const,
      expectedMime: XLSX_MIME,
      expectedExtension: '.docx',
    },
    {
      name: 'DOCX bytes with generic ZIP declarations',
      bytes: docxBytes,
      fileName: 'declared.zip',
      mimeHint: ZIP_MIME,
      expectedFormat: 'docx' as const,
      expectedMime: DOCX_MIME,
      expectedExtension: '.zip',
    },
  ])('$name retain source declarations but report canonical identity', (testCase) => {
    const result = DocumentFormatDetector.detect(
      testCase.bytes,
      testCase.fileName,
      testCase.mimeHint
    );

    expect(result.format).toBe(testCase.expectedFormat);
    expect(result.mimeType).toBe(testCase.expectedMime);
    expect(result.extension).toBe(testCase.expectedExtension);
    assertDeclaredIdentity(result, testCase.fileName, testCase.mimeHint);
  });

  it.each([
    { fileName: 'mislabelled.docx', mimeHint: undefined },
    { fileName: 'mislabelled.xlsx', mimeHint: undefined },
    { fileName: undefined, mimeHint: DOCX_MIME },
    { fileName: undefined, mimeHint: XLSX_MIME },
  ])('classifies a plain ZIP as ZIP and rejects Office declaration $fileName $mimeHint', async ({
    fileName,
    mimeHint,
  }) => {
    const detected = DocumentFormatDetector.detect(genericZip, fileName, mimeHint);
    expect(detected.format).toBe('zip');
    expect(detected.mimeType).toBe(ZIP_MIME);
    expect(detected.isArchive).toBe(true);
    expect(detected.isOfficeDocument).toBe(false);
    assertDeclaredIdentity(detected, fileName, mimeHint);

    const factory = new DocumentParserFactory();
    const dispatchSpy = jest.spyOn(factory, 'getParser');
    const decompressSpy = jest.spyOn(SafeArchiveExtractor, 'decompressRaw');
    await expect(factory.parseBufferCore(genericZip, fileName, mimeHint)).rejects.toThrow(
      /Office declaration does not match DOCX\/XLSX container markers/
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(decompressSpy).not.toHaveBeenCalled();
  });

  it('keeps a ZIP with conflicting DOCX and XLSX markers generic and undispatched', async () => {
    const ambiguousZip = TestFixtures.createZipArchive([
      { name: 'word/document.xml', content: Buffer.from('<document/>') },
      { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>') },
    ]);
    const result = DocumentFormatDetector.detect(ambiguousZip, 'ambiguous.docx', DOCX_MIME);
    expect(result.format).toBe('zip');
    expect(result.mimeType).toBe(ZIP_MIME);
    assertDeclaredIdentity(result, 'ambiguous.docx', DOCX_MIME);

    await expect(
      new DocumentParserFactory().parseBuffer(ambiguousZip, 'ambiguous.docx', DOCX_MIME)
    ).rejects.toThrow(/Office declaration does not match/);
  });
});
