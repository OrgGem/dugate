import { DocumentFormatDetector } from '../src/formats/detector';
import { TestFixtures } from './fixtures/test-fixtures';

describe('DocumentFormatDetector', () => {
  it('detects PDF from magic bytes %PDF', () => {
    const pdfBuffer = TestFixtures.createSamplePdf();
    const result = DocumentFormatDetector.detect(pdfBuffer, 'document.dat');
    expect(result.format).toBe('pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.isBinary).toBe(true);
  });

  it('detects PNG from magic bytes', () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = DocumentFormatDetector.detect(pngHeader, 'image.bin');
    expect(result.format).toBe('png');
    expect(result.isImage).toBe(true);
  });

  it('detects DOCX from ZIP magic bytes and .docx extension', () => {
    const docxBuffer = TestFixtures.createSyntheticDocx();
    const result = DocumentFormatDetector.detect(docxBuffer, 'report.docx');
    expect(result.format).toBe('docx');
    expect(result.isOfficeDocument).toBe(true);
  });

  it('detects CSV from text and extension', () => {
    const csvBuffer = TestFixtures.createSampleCsv();
    const result = DocumentFormatDetector.detect(csvBuffer, 'data.csv');
    expect(result.format).toBe('csv');
    expect(result.isBinary).toBe(false);
  });

  it('detects Markdown from .md extension', () => {
    const mdBuffer = Buffer.from('# Title\n\nSome **bold** text.');
    const result = DocumentFormatDetector.detect(mdBuffer, 'readme.md');
    expect(result.format).toBe('md');
    expect(result.isBinary).toBe(false);
  });
});
