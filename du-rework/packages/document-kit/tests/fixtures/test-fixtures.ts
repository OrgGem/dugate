import * as zlib from 'zlib';

/**
 * Generates synthetic, deterministic file buffers for tests without external assets.
 */
export class TestFixtures {
  /**
   * Minimal valid PDF buffer containing a text stream.
   */
  public static createSamplePdf(text: string = 'Hello World PDF'): Buffer {
    const pdfContent = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${text.length + 20} >>
stream
BT
/F1 12 Tf
72 712 Td
(${text}) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000206 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
290
%%EOF`;
    return Buffer.from(pdfContent, 'binary');
  }

  /**
   * Creates a synthetic minimal DOCX buffer (ZIP structure containing word/document.xml).
   */
  public static createSyntheticDocx(textContent: string = 'Synthetic Word Document Content'): Buffer {
    const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${textContent}</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    return this.createZipArchive([
      { name: 'word/document.xml', content: Buffer.from(xmlContent, 'utf8') },
      { name: '[Content_Types].xml', content: Buffer.from('<Types/>', 'utf8') },
    ]);
  }

  /**
   * Creates a multi-page PDF buffer with explicit text on each page.
   */
  public static createMultiPagePdf(pageTexts: string[]): Buffer {
    const { PdfSplitter } = require('../../src/formats/pdf-splitter');
    return PdfSplitter.createValidPdf(pageTexts);
  }

  /**
   * Creates a synthetic minimal XLSX buffer containing real spreadsheet XML.
   */
  public static createSyntheticXlsx(rows: string[][]): Buffer {
    let sheetDataXml = '';
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const rowNum = r + 1;
      let rowCellsXml = '';
      for (let c = 0; c < row.length; c++) {
        const colLetter = String.fromCharCode(65 + c);
        const cellRef = `${colLetter}${rowNum}`;
        const val = row[c] ?? '';
        rowCellsXml += `<c r="${cellRef}" t="inlineStr"><is><t>${val}</t></is></c>`;
      }
      sheetDataXml += `<row r="${rowNum}">${rowCellsXml}</row>`;
    }

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetDataXml}</sheetData>
</worksheet>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
  </sheets>
</workbook>`;

    return this.createZipArchive([
      { name: 'xl/worksheets/sheet1.xml', content: Buffer.from(sheetXml, 'utf8') },
      { name: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8') },
      { name: '[Content_Types].xml', content: Buffer.from('<Types/>', 'utf8') },
    ]);
  }

  /**
   * Creates a sample CSV text buffer.
   */
  public static createSampleCsv(): Buffer {
    const csv = `Item,Quantity,Price\nWidget A,5,19.99\nWidget B,10,4.50\nWidget C,2,100.00`;
    return Buffer.from(csv, 'utf8');
  }

  /**
   * Creates a simple in-memory ZIP buffer with given entries.
   */
  public static createZipArchive(entries: Array<{ name: string; content: Buffer }>): Buffer {
    const localHeaders: Buffer[] = [];
    const centralHeaders: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
      const fileNameBuffer = Buffer.from(entry.name, 'utf8');
      const compressed = zlib.deflateRawSync(entry.content);
      const crc = this.computeCrc32(entry.content);

      // Local File Header (30 bytes + name)
      const localHeader = Buffer.alloc(30 + fileNameBuffer.length);
      localHeader.writeUInt32LE(0x04034b50, 0); // Signature
      localHeader.writeUInt16LE(20, 4); // Version needed
      localHeader.writeUInt16LE(0, 6); // Flags
      localHeader.writeUInt16LE(8, 8); // Deflate compression
      localHeader.writeUInt16LE(0, 10); // Mod time
      localHeader.writeUInt16LE(0, 12); // Mod date
      localHeader.writeUInt32LE(crc, 14); // CRC32
      localHeader.writeUInt32LE(compressed.length, 18); // Compressed size
      localHeader.writeUInt32LE(entry.content.length, 22); // Uncompressed size
      localHeader.writeUInt16LE(fileNameBuffer.length, 26); // Name length
      localHeader.writeUInt16LE(0, 28); // Extra length
      fileNameBuffer.copy(localHeader, 30);

      localHeaders.push(localHeader);
      localHeaders.push(compressed);

      // Central Directory Header (46 bytes + name)
      const cdHeader = Buffer.alloc(46 + fileNameBuffer.length);
      cdHeader.writeUInt32LE(0x02014b50, 0);
      cdHeader.writeUInt16LE(20, 4);
      cdHeader.writeUInt16LE(20, 6);
      cdHeader.writeUInt16LE(0, 8);
      cdHeader.writeUInt16LE(8, 10);
      cdHeader.writeUInt16LE(0, 12);
      cdHeader.writeUInt16LE(0, 14);
      cdHeader.writeUInt32LE(crc, 16);
      cdHeader.writeUInt32LE(compressed.length, 20);
      cdHeader.writeUInt32LE(entry.content.length, 24);
      cdHeader.writeUInt16LE(fileNameBuffer.length, 28);
      cdHeader.writeUInt16LE(0, 30);
      cdHeader.writeUInt16LE(0, 32);
      cdHeader.writeUInt16LE(0, 34);
      cdHeader.writeUInt16LE(0, 36);
      cdHeader.writeUInt32LE(0, 38);
      cdHeader.writeUInt32LE(offset, 42); // Relative offset of local header
      fileNameBuffer.copy(cdHeader, 46);

      centralHeaders.push(cdHeader);
      offset += localHeader.length + compressed.length;
    }

    const cdOffset = offset;
    const cdSize = centralHeaders.reduce((acc, h) => acc + h.length, 0);

    // End of Central Directory Record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  }

  private static computeCrc32(buf: Buffer): number {
    // Simple fast CRC32
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i] ?? 0;
      const idx = (crc ^ b) & 0xff;
      crc = (crc >>> 8) ^ (this.crcTable[idx] ?? 0);
    }
    return (crc ^ -1) >>> 0;
  }

  private static crcTable: Uint32Array = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c;
    }
    return table;
  })();
}
