import { DocumentParser, FormatDetectionResult, ParserOptions } from '../types';
import { DocumentFormatDetector } from '../formats/detector';
import { TextParser } from './text-parser';
import { WordParser } from './word-parser';
import { ExcelParser } from './excel-parser';
import { PdfParser } from './pdf-parser';
import { validateParserOptions, withTimeout } from './limits';
import { SafeArchiveExtractor } from '../archives/zip-extractor';
import { DEFAULT_PARSER_CPU_TIMEOUT_MS, parseDocumentInWorker } from './worker-isolation';

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

  /**
   * Parses a document buffer with format detection, size limit validation, and timeout budget.
   *
   * Built-in parsers run in a terminable worker thread and default to a 30-second CPU budget.
   * Registered custom parsers stay in the caller thread and only receive a wait timeout.
   */
  public async parseBuffer(
    buffer: Buffer,
    fileName?: string,
    mimeHint?: string,
    options?: ParserOptions
  ) {
    validateParserOptions(options, buffer.length);

    if (!this.hasCustomParsers()) {
      return parseDocumentInWorker(
        buffer,
        fileName,
        mimeHint,
        options,
        options?.timeoutMs ?? DEFAULT_PARSER_CPU_TIMEOUT_MS
      );
    }

    return this.parseBufferCoreImpl(buffer, fileName, mimeHint, options);
  }

  /** @internal Shared by the terminable worker entry and deterministic boundary tests. */
  public async parseBufferCore(
    buffer: Buffer,
    fileName?: string,
    mimeHint?: string,
    options?: ParserOptions
  ) {
    validateParserOptions(options, buffer.length);
    return this.parseBufferCoreImpl(buffer, fileName, mimeHint, options);
  }

  private hasCustomParsers(): boolean {
    return this.parsers.some(
      (parser) =>
        parser.constructor !== TextParser &&
        parser.constructor !== WordParser &&
        parser.constructor !== ExcelParser &&
        parser.constructor !== PdfParser
    );
  }

  private async parseBufferCoreImpl(
    buffer: Buffer,
    fileName?: string,
    mimeHint?: string,
    options?: ParserOptions
  ) {

    let parserBuffer = buffer;
    let formatInfo = DocumentFormatDetector.detect(buffer, fileName, mimeHint);
    const lowerFileName = fileName?.toLowerCase() ?? '';
    const claimsOffice =
      lowerFileName.endsWith('.docx') ||
      lowerFileName.endsWith('.xlsx') ||
      mimeHint?.toLowerCase().includes('wordprocessingml') === true ||
      mimeHint?.toLowerCase().includes('spreadsheetml') === true;
    const claimsZip =
      lowerFileName.endsWith('.zip') || mimeHint?.toLowerCase() === 'application/zip';
    if (
      SafeArchiveExtractor.isZipBuffer(buffer) ||
      formatInfo.format === 'docx' ||
      formatInfo.format === 'xlsx' ||
      claimsZip ||
      claimsOffice
    ) {
      parserBuffer = Buffer.from(buffer);
      formatInfo = DocumentFormatDetector.detect(parserBuffer, fileName, mimeHint);
      if (claimsOffice && formatInfo.format === 'zip') {
        SafeArchiveExtractor.inspectEntryNames(parserBuffer);
        throw new Error(
          'Archive security violation: Office declaration does not match DOCX/XLSX container markers'
        );
      }
      const expectedFormat =
        formatInfo.format === 'docx' || formatInfo.format === 'xlsx'
          ? formatInfo.format
          : undefined;
      await SafeArchiveExtractor.preflightBuffer(parserBuffer, {}, expectedFormat);
    }

    const parser = this.getParser(formatInfo);

    if (!parser) {
      throw new Error(
        `No suitable native parser found for format "${formatInfo.format}" (${formatInfo.mimeType})`
      );
    }

    return withTimeout(
      parser.parse(parserBuffer, fileName, options),
      options?.timeoutMs ?? DEFAULT_PARSER_CPU_TIMEOUT_MS,
      'Parser execution'
    );
  }
}

// Global default factory instance
export const defaultParserFactory = new DocumentParserFactory();
