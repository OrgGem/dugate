import { PdfSplitter } from '../src/formats/pdf-splitter';

describe('PdfSplitter (DOC-01-v4)', () => {
  it('parses single page expression', () => {
    const pages = PdfSplitter.parsePageExpression('5');
    expect(pages).toEqual([5]);
  });

  it('parses contiguous page range', () => {
    const pages = PdfSplitter.parsePageExpression('1-5');
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses composite page list and ranges with whitespace', () => {
    const pages = PdfSplitter.parsePageExpression('1-3, 5, 8-10');
    expect(pages).toEqual([1, 2, 3, 5, 8, 9, 10]);
  });

  it('deduplicates and sorts page numbers', () => {
    const pages = PdfSplitter.parsePageExpression('5, 1-3, 2, 4');
    expect(pages).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects page numbers exceeding total page count', () => {
    expect(() => {
      PdfSplitter.parsePageExpression('1-10', 5);
    }).toThrow(/exceeds total document pages \(5\)/);
  });

  it('rejects inverted page range start > end', () => {
    expect(() => {
      PdfSplitter.parsePageExpression('5-2');
    }).toThrow(/Range start cannot be greater than end/);
  });

  it('rejects non-positive page numbers (0 or negative)', () => {
    expect(() => {
      PdfSplitter.parsePageExpression('0');
    }).toThrow(/Page numbers must be positive/);

    expect(() => {
      PdfSplitter.parsePageExpression('-3');
    }).toThrow(/Page numbers must be positive/);
  });

  it('converts page list to contiguous ranges', () => {
    const ranges = PdfSplitter.toRanges([1, 2, 3, 5, 7, 8]);
    expect(ranges).toEqual([
      { startPage: 1, endPage: 3 },
      { startPage: 5, endPage: 5 },
      { startPage: 7, endPage: 8 },
    ]);
  });

  describe('splitPdf (Real PDF Artifact Creation)', () => {
    it('creates a valid PDF binary containing exactly the requested pages', async () => {
      // Create a 3-page original PDF
      const originalPdf = PdfSplitter.createValidPdf([
        'Invoice 101 - Executive Summary',
        'Invoice 101 - Line Items and Totals',
        'Invoice 101 - Terms and Disclosures',
      ]);

      expect(PdfSplitter.getTotalPages(originalPdf)).toBe(3);

      // Slice page 2 only
      const slicedPdf = await PdfSplitter.splitPdf(originalPdf, '2');

      // Assertions on the sliced PDF artifact
      expect(slicedPdf).toBeInstanceOf(Buffer);
      const pdfStr = slicedPdf.toString('utf8');

      // Valid PDF magic header and trailer
      expect(pdfStr.startsWith('%PDF-')).toBe(true);
      expect(pdfStr).toContain('%%EOF');
      expect(pdfStr).toContain('Invoice 101 - Line Items and Totals');
      expect(pdfStr).not.toContain('Executive Summary');
      expect(pdfStr).not.toContain('Terms and Disclosures');

      // Sliced PDF page count verification
      expect(await PdfSplitter.getPageCount(slicedPdf)).toBe(1);
    });

    it('slices multi-page range "1,3" into valid 2-page PDF', async () => {
      const originalPdf = PdfSplitter.createValidPdf([
        'Section 1: Alpha',
        'Section 2: Beta',
        'Section 3: Gamma',
      ]);

      const slicedPdf = await PdfSplitter.splitPdf(originalPdf, '1,3');
      const pdfStr = slicedPdf.toString('utf8');

      expect(pdfStr.startsWith('%PDF-')).toBe(true);
      expect(pdfStr).toContain('Section 1: Alpha');
      expect(pdfStr).toContain('Section 3: Gamma');
      expect(pdfStr).not.toContain('Section 2: Beta');
      expect(await PdfSplitter.getPageCount(slicedPdf)).toBe(2);
    });
  });
});
