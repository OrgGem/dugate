import { DocumentParser, FormatDetectionResult } from '../types';
import { DocumentFormatDetector } from '../formats/detector';
import { TextParser } from './text-parser';
import { WordParser } from './word-parser';
import { ExcelParser } from './excel-parser';
import { PdfParser } from './pdf-parser';

export class DocumentParserFactory {
  private parsers: DocumentParser[] = [];

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.parsers.push(new TextParser());
    this.parsers.push(new WordParser());
    this.parsers.push(new ExcelParser());
    this.parsers.push(new PdfParser());
  }

  public registerParser(parser: DocumentParser): void {
    this.parsers.unshift(parser); // New parsers take precedence
  }

  public getParser(formatInfo: FormatDetectionResult): DocumentParser | null {
    for (const parser of this.parsers) {
      if (parser.canHandle(formatInfo)) {
        return parser;
      }
    }
    return null;
  }

  public async parseBuffer(
    buffer: Buffer,
    fileName?: string,
    mimeHint?: string
  ) {
    const formatInfo = DocumentFormatDetector.detect(buffer, fileName, mimeHint);
    const parser = this.getParser(formatInfo);

    if (!parser) {
      throw new Error(
        `No suitable native parser found for format "${formatInfo.format}" (${formatInfo.mimeType})`
      );
    }

    return parser.parse(buffer, fileName);
  }
}

// Global default factory instance
export const defaultParserFactory = new DocumentParserFactory();
