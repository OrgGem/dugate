import { TextParser } from '../src/parsers/text-parser';
import { WordParser } from '../src/parsers/word-parser';
import { ExcelParser } from '../src/parsers/excel-parser';
import { PdfParser } from '../src/parsers/pdf-parser';
import { defaultParserFactory } from '../src/parsers/factory';
import { TestFixtures } from './fixtures/test-fixtures';

describe('Document Parsers (DOC-01)', () => {
  describe('TextParser', () => {
    const parser = new TextParser();

    it('parses plain text buffer', async () => {
      const buf = Buffer.from('Quarterly revenue grew by 15 percent.', 'utf8');
      const result = await parser.parse(buf, 'report.txt');

      expect(result.text).toBe('Quarterly revenue grew by 15 percent.');
      expect(result.metadata.wordCount).toBe(6);
      expect(result.metadata.detectedFormat).toBe('txt');
      expect(result.metadata.provenance).toBe('native_parse');
    });
  });

  describe('WordParser', () => {
    const parser = new WordParser();

    it('parses synthetic docx XML structure', async () => {
      const docxBuffer = TestFixtures.createSyntheticDocx('Test Contract Clause 1');
      const result = await parser.parse(docxBuffer, 'contract.docx');

      expect(result.text).toContain('Test Contract Clause 1');
      expect(result.metadata.detectedFormat).toBe('docx');
      expect(result.metadata.provenance).toBe('native_parse');
    });

    it('parses synthetic docx XML structure with tables into markdown', async () => {
      const docxWithTable = TestFixtures.createZipArchive([
        {
          name: 'word/document.xml',
          content: Buffer.from(
            `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Project Report</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Phase</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Status</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Phase 1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Done</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
            'utf8'
          ),
        },
      ]);

      const result = await parser.parse(docxWithTable, 'report.docx');
      expect(result.text).toContain('Project Report');
      expect(result.markdown).toContain('| Phase | Status |');
      expect(result.markdown).toContain('| Phase 1 | Done |');
    });

    it('throws informative error on corrupted Word binary (no silent success)', async () => {
      const corruptBuf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xff]);
      await expect(parser.parse(corruptBuf, 'corrupt.docx')).rejects.toThrow(
        /Unable to parse Word document/
      );
    });
  });

  describe('ExcelParser', () => {
    const parser = new ExcelParser();

    it('parses CSV spreadsheet into markdown table and tabbed text', async () => {
      const csvBuffer = TestFixtures.createSampleCsv();
      const result = await parser.parse(csvBuffer, 'data.csv');

      expect(result.markdown).toContain('| Item | Quantity | Price |');
      expect(result.markdown).toContain('| Widget A | 5 | 19.99 |');
      expect(result.text).toContain('Item\tQuantity\tPrice');
      expect(result.metadata.detectedFormat).toBe('csv');
    });

    it('parses synthetic XLSX OpenXML structure extracting actual cell data', async () => {
      const xlsxBuf = TestFixtures.createSyntheticXlsx([
        ['Product', 'Revenue', 'Profit'],
        ['Alpha', '1000', '250'],
        ['Beta', '500', '100'],
      ]);

      const result = await parser.parse(xlsxBuf, 'financials.xlsx');
      expect(result.markdown).toContain('| Product | Revenue | Profit |');
      expect(result.markdown).toContain('| Alpha | 1000 | 250 |');
      expect(result.markdown).toContain('| Beta | 500 | 100 |');
      expect(result.metadata.detectedFormat).toBe('xlsx');
    });

    it('parses synthetic XLSX with shared strings table (xl/sharedStrings.xml)', async () => {
      const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Department</t></si>
  <si><t>Engineering</t></si>
  <si><t>Marketing</t></si>
</sst>`;

      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1"><v>100</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>1</v></c>
      <c r="B2"><v>50</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>2</v></c>
      <c r="B3"><v>25</v></c>
    </row>
  </sheetData>
</worksheet>`;

      const xlsxWithSst = TestFixtures.createZipArchive([
        { name: 'xl/worksheets/sheet1.xml', content: Buffer.from(sheetXml, 'utf8') },
        { name: 'xl/sharedStrings.xml', content: Buffer.from(sstXml, 'utf8') },
        {
          name: 'xl/workbook.xml',
          content: Buffer.from(
            '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
            'utf8'
          ),
        },
        { name: '[Content_Types].xml', content: Buffer.from('<Types/>', 'utf8') },
      ]);

      const result = await parser.parse(xlsxWithSst, 'departments.xlsx');
      expect(result.markdown).toContain('| Department | 100 |');
      expect(result.markdown).toContain('| Engineering | 50 |');
      expect(result.markdown).toContain('| Marketing | 25 |');
    });

    it('throws on corrupted binary Excel file (no silent success)', async () => {
      const corruptBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      await expect(parser.parse(corruptBuf, 'corrupt.xlsx')).rejects.toThrow(
        /Unable to parse Excel file/
      );
    });
  });

  describe('PdfParser', () => {
    const parser = new PdfParser();

    it('extracts text and page metadata from synthetic PDF', async () => {
      const pdfBuffer = TestFixtures.createSamplePdf('Invoice 12345');
      const result = await parser.parse(pdfBuffer, 'invoice.pdf');

      expect(result.text).toContain('Invoice 12345');
      expect(result.metadata.pageCount).toBe(1);
      expect(result.metadata.detectedFormat).toBe('pdf');
    });
  });

  describe('DocumentParserFactory', () => {
    it('automatically dispatches to correct parser', async () => {
      const csvBuffer = TestFixtures.createSampleCsv();
      const result = await defaultParserFactory.parseBuffer(csvBuffer, 'accounts.csv');
      expect(result.metadata.detectedFormat).toBe('csv');
    });
  });
});
