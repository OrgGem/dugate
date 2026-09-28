import { DocumentFormatDetector } from '../src/formats/detector';
import { DocumentParserFactory } from '../src/parsers/factory';
import { TestFixtures } from './fixtures/test-fixtures';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('R1-E declared artifact identity reaches safe Office parsing', () => {
  const factory = new DocumentParserFactory();

  it.each([
    {
      name: 'DOCX',
      bytes: TestFixtures.createSyntheticDocx('Declared Word content'),
      filename: 'Quarterly Source (final).docx',
      declaredMimeType: DOCX_MIME,
      canonicalFormat: 'docx',
      canonicalMimeType: DOCX_MIME,
      text: 'Declared Word content',
    },
    {
      name: 'XLSX',
      bytes: TestFixtures.createSyntheticXlsx([['Title'], ['Declared Spreadsheet content']]),
      filename: 'Finance Source.xlsx',
      declaredMimeType: XLSX_MIME,
      canonicalFormat: 'xlsx',
      canonicalMimeType: XLSX_MIME,
      text: 'Declared Spreadsheet content',
    },
    {
      name: 'DOCX bytes with a conflicting but preserved XLSX declaration',
      bytes: TestFixtures.createSyntheticDocx('Bytes decide Word format'),
      filename: 'source-as-uploaded.xlsx',
      declaredMimeType: XLSX_MIME,
      canonicalFormat: 'docx',
      canonicalMimeType: DOCX_MIME,
      text: 'Bytes decide Word format',
    },
  ])('$name retains declarations and parses by container identity', async (testCase) => {
    const detected = DocumentFormatDetector.detect(
      testCase.bytes,
      testCase.filename,
      testCase.declaredMimeType
    );
    expect(detected).toMatchObject({
      format: testCase.canonicalFormat,
      mimeType: testCase.canonicalMimeType,
      declaredFileName: testCase.filename,
      declaredMimeType: testCase.declaredMimeType,
    });

    const parsed = await factory.parseBuffer(
      testCase.bytes,
      testCase.filename,
      testCase.declaredMimeType,
      { timeoutMs: 5_000 }
    );
    expect(parsed.metadata.detectedFormat).toBe(testCase.canonicalFormat);
    expect(parsed.text).toContain(testCase.text);
  });
});
