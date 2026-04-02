const pdfParse = require('pdf-parse');
import { DocumentParser, ParseResult } from './interface';

export class PdfParser implements DocumentParser {
  canHandle(mimeType: string, extension: string): boolean {
    return mimeType === 'application/pdf' || extension.toLowerCase() === '.pdf';
  }

  async parse(fileBuffer: Buffer, fileName: string): Promise<ParseResult> {
    try {
      const data = await pdfParse(fileBuffer, {
        // max 0 means no limit
        max: 0 
      });
      
      const text = data.text || '';
      
      // Fallback Strategy: if the PDF has pages but the extracted text is suspiciously short,
      // it might be a scanned PDF or contains only images.
      // We throw a specific error so the Factory can switch to external OCR API.
      const textLength = text.trim().length;
      if (data.numpages > 0 && textLength < data.numpages * 50) {
        throw new Error("SCANNED_PDF_DETECTED");
      }

      return {
        text: text,
        markdown: text, // Plain text as markdown
        metadata: {
          pageCount: data.numpages,
          info: data.info,
          version: data.version
        }
      };
    } catch (e) {
      console.error("[PdfParser] error parsing pdf file", e);
      throw e;
    }
  }
}
