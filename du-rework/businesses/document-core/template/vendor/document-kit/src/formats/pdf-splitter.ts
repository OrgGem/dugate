// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/document-kit/src/formats/pdf-splitter.ts (lines=280) sha256=1944DB98BD0829445AFD83E01C3BDF94F6C8E012903E66CDA8C25A8726D52E1C
// why: PdfSplitter for src/actions/ingest/index.ts (imports ../types; external dep pdf-lib)

import { SplitPageRange } from '../types';

/**
 * PDF Splitter handles parsing page specifications and slicing PDF page buffers.
 */
export class PdfSplitter {
  /**
   * Parse a page expression string like "1-3,5,7-9" into an ordered, deduplicated list of 1-indexed page numbers.
   */
  public static parsePageExpression(expression: string, totalPages?: number): number[] {
    const trimmed = expression.trim();
    if (!trimmed) {
      throw new Error('Page expression cannot be empty');
    }

    const pages = new Set<number>();
    const segments = trimmed.split(',').map((s) => s.trim());

    for (const segment of segments) {
      if (!segment) continue;

      if (segment.startsWith('-')) {
        throw new Error(`Page numbers must be positive: "${segment}"`);
      }

      if (segment.includes('-')) {
        const parts = segment.split('-').map((p) => p.trim());
        if (parts.length !== 2) {
          throw new Error(`Invalid page range format: "${segment}"`);
        }

        const part0 = parts[0];
        const part1 = parts[1];
        if (!part0 || !part1) {
          throw new Error(`Invalid page range format: "${segment}"`);
        }

        const start = parseInt(part0, 10);
        const end = parseInt(part1, 10);

        if (isNaN(start) || isNaN(end)) {
          throw new Error(`Invalid non-numeric page range: "${segment}"`);
        }
        if (start <= 0 || end <= 0) {
          throw new Error(`Page numbers must be positive: "${segment}"`);
        }
        if (start > end) {
          throw new Error(`Range start cannot be greater than end: "${segment}"`);
        }

        for (let p = start; p <= end; p++) {
          if (totalPages !== undefined && p > totalPages) {
            throw new Error(`Page number ${p} exceeds total document pages (${totalPages})`);
          }
          pages.add(p);
        }
      } else {
        const page = parseInt(segment, 10);
        if (isNaN(page)) {
          throw new Error(`Invalid non-numeric page number: "${segment}"`);
        }
        if (page <= 0) {
          throw new Error(`Page numbers must be positive: "${segment}"`);
        }
        if (totalPages !== undefined && page > totalPages) {
          throw new Error(`Page number ${page} exceeds total document pages (${totalPages})`);
        }
        pages.add(page);
      }
    }

    if (pages.size === 0) {
      throw new Error(`No valid pages resolved from expression: "${expression}"`);
    }

    return Array.from(pages).sort((a, b) => a - b);
  }

  /**
   * Convert list of page numbers to continuous range objects.
   */
  public static toRanges(pageNumbers: number[]): SplitPageRange[] {
    const first = pageNumbers[0];
    if (first === undefined) return [];
    const ranges: SplitPageRange[] = [];
    let start = first;
    let end = first;

    for (let i = 1; i < pageNumbers.length; i++) {
      const current = pageNumbers[i];
      if (current === undefined) continue;

      if (current === end + 1) {
        end = current;
      } else {
        ranges.push({ startPage: start, endPage: end });
        start = current;
        end = current;
      }
    }
    ranges.push({ startPage: start, endPage: end });
    return ranges;
  }

  /**
   * Determine total page count of a PDF, using pdf-lib if available or structural fallback.
   */
  public static async getPageCount(pdfBuffer: Buffer): Promise<number> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PDFDocument } = require('pdf-lib');
      if (PDFDocument && typeof PDFDocument.load === 'function') {
        const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        return doc.getPageCount();
      }
    } catch {
      // ignore
    }
    return this.getTotalPages(pdfBuffer);
  }

  /**
   * Inspect PDF buffer to determine total page count synchronously.
   */
  public static getTotalPages(pdfBuffer: Buffer): number {
    // Fast regex inspection on PDF structure
    const content = pdfBuffer.toString('binary');
    const pageMatches = content.match(/\/Type\s*\/Page\b/g);
    if (pageMatches && pageMatches.length > 0) {
      return pageMatches.length;
    }

    const countMatch = content.match(/\/Count\s+(\d+)/);
    if (countMatch && countMatch[1]) {
      const cnt = parseInt(countMatch[1], 10);
      if (!isNaN(cnt) && cnt > 0) return cnt;
    }

    return 1;
  }

  /**
   * Slice a PDF buffer down to only the requested pages, returning a valid PDF artifact.
   */
  public static async splitPdf(pdfBuffer: Buffer, pageExpression: string): Promise<Buffer> {
    // Attempt pdf-lib if available
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PDFDocument } = require('pdf-lib');
      if (PDFDocument && typeof PDFDocument.load === 'function') {
        const sourceDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        const totalPages = sourceDoc.getPageCount();
        const targetPages = this.parsePageExpression(pageExpression, totalPages);

        const newDoc = await PDFDocument.create();
        // pdf-lib uses 0-indexed page numbers
        const zeroIndexed = targetPages.map((p) => p - 1);
        const copiedPages = await newDoc.copyPages(sourceDoc, zeroIndexed);
        for (const page of copiedPages) {
          newDoc.addPage(page);
        }
        const savedBytes = await newDoc.save();
        return Buffer.from(savedBytes);
      }
    } catch {
      // pdf-lib not installed or errored, proceed to pure PDF generator
    }

    const totalPages = this.getTotalPages(pdfBuffer);
    const targetPages = this.parsePageExpression(pageExpression, totalPages);

    // Pure fallback: Extract text from original pages and construct a valid multi-page PDF
    const content = pdfBuffer.toString('binary');
    const pageTextMap = this.extractPageTexts(content);

    const pagesToRender: string[] = targetPages.map((pageNum) => {
      return pageTextMap[pageNum] || `Page ${pageNum}`;
    });

    return this.createValidPdf(pagesToRender);
  }

  /**
   * Generates a completely valid standard PDF-1.4 binary buffer with N pages,
   * correct xref byte offsets, page tree, font resource, and trailer.
   */
  public static createValidPdf(pagesText: string[]): Buffer {
    const pageCount = pagesText.length;
    const bodyChunks: string[] = [];
    const offsets: number[] = [];

    // Header
    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    let currentOffset = Buffer.byteLength(header, 'utf8');

    // Obj 1: Catalog
    const catalogObj = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    offsets.push(currentOffset);
    bodyChunks.push(catalogObj);
    currentOffset += Buffer.byteLength(catalogObj, 'utf8');

    // Obj 2: Pages Root
    // Object numbering:
    // Obj 1: Catalog
    // Obj 2: Pages root
    // Obj 3: Font resource
    // For each page i (0 to pageCount-1):
    //   Page obj: 4 + i * 2
    //   Content stream obj: 5 + i * 2
    const fontObjNum = 3;
    const kidsRefs = pagesText.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
    const pagesObj = `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs}] /Count ${pageCount} >>\nendobj\n`;
    offsets.push(currentOffset);
    bodyChunks.push(pagesObj);
    currentOffset += Buffer.byteLength(pagesObj, 'utf8');

    // Obj 3: Font (Helvetica)
    const fontObj = `${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;
    offsets.push(currentOffset);
    bodyChunks.push(fontObj);
    currentOffset += Buffer.byteLength(fontObj, 'utf8');

    // Individual Pages and Content Streams
    for (let i = 0; i < pageCount; i++) {
      const pageObjNum = 4 + i * 2;
      const contentObjNum = 5 + i * 2;
      const pageText = pagesText[i] ?? '';
      const rawText = pageText.replace(/[()\\]/g, '\\$&');

      const streamText = `BT\n/F1 12 Tf\n50 750 Td\n(${rawText}) Tj\nET\n`;
      const streamLen = Buffer.byteLength(streamText, 'utf8');

      // Page Object
      const pageObj = `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>\nendobj\n`;
      offsets.push(currentOffset);
      bodyChunks.push(pageObj);
      currentOffset += Buffer.byteLength(pageObj, 'utf8');

      // Content Stream Object
      const streamObj = `${contentObjNum} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamText}endstream\nendobj\n`;
      offsets.push(currentOffset);
      bodyChunks.push(streamObj);
      currentOffset += Buffer.byteLength(streamObj, 'utf8');
    }

    // Cross-Reference Table (xref)
    const xrefOffset = currentOffset;
    const totalObjects = 4 + pageCount * 2;
    let xref = `xref\n0 ${totalObjects}\n0000000000 65535 f \n`;

    for (const offset of offsets) {
      const padded = String(offset).padStart(10, '0');
      xref += `${padded} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const fullPdfString = header + bodyChunks.join('') + xref + trailer;
    return Buffer.from(fullPdfString, 'utf8');
  }

  private static extractPageTexts(pdfString: string): Record<number, string> {
    const map: Record<number, string> = {};
    const tjRegex = /\(([^)]+)\)\s*Tj/g;
    let pageNum = 1;
    let match: RegExpExecArray | null;

    while ((match = tjRegex.exec(pdfString)) !== null) {
      const matchVal = match[1];
      if (matchVal) {
        const text = matchVal.replace(/\\([()\\])/g, '$1');
        if (text.trim().length > 0) {
          map[pageNum] = text;
          pageNum++;
        }
      }
    }
    return map;
  }
}
