import { DocumentParser } from './interface';
import { ExcelParser } from './excel-parser';
import { WordParser } from './word-parser';
import { PdfParser } from './pdf-parser';

export class ParserFactory {
  private static parsers: DocumentParser[] = [
    new ExcelParser(),
    new WordParser(),
    new PdfParser()
  ];

  /**
   * Retrieves a suitable internal parser for the file
   */
  static getParserForFile(mimeType: string, fileName: string): DocumentParser | null {
    // extract extension
    const parts = fileName.split('.');
    const ext = parts.length > 1 ? `.${parts[parts.length - 1]}`.toLowerCase() : '';
    
    // find a parser that can handle this file
    for (const parser of this.parsers) {
      if (parser.canHandle(mimeType, ext)) {
        return parser;
      }
    }
    
    // No internal parser found, must use external API
    return null;
  }
}
