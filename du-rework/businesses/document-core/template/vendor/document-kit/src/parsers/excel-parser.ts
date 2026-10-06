// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/document-kit/src/parsers/excel-parser.ts (lines=393) sha256=6D47CB0445CA97FFCD576E7F4AE0DC3CEF2F696AD7FCCA00811A74CB76218C0F
// why: transitive dep of parsers/factory.ts

import {
  ArchiveExtractResult,
  DocumentParser,
  FormatDetectionResult,
  ParseResult,
  ParserOptions,
} from '../types';
import { ArchiveSecurityError, SafeArchiveExtractor } from '../archives/zip-extractor';
import { validateParserOptions, withTimeout } from './limits';
import { isMainThread } from 'worker_threads';
import {
  DEFAULT_PARSER_CPU_TIMEOUT_MS,
  parseBuiltInParserInWorker,
} from './worker-isolation';

export class ExcelParser implements DocumentParser {
  public readonly name = 'ExcelParser';

  public canHandle(formatInfo: FormatDetectionResult): boolean {
    return ['xlsx', 'xls', 'csv'].includes(formatInfo.format);
  }

  public async parse(
    fileBuffer: Buffer,
    fileName?: string,
    options?: ParserOptions
  ): Promise<ParseResult> {
    validateParserOptions(options, fileBuffer.length);

    if (isMainThread && this.constructor === ExcelParser) {
      return parseBuiltInParserInWorker(
        'excel-parser',
        'ExcelParser',
        fileBuffer,
        fileName,
        options,
        options?.timeoutMs ?? DEFAULT_PARSER_CPU_TIMEOUT_MS
      );
    }

    const parsePromise = this.parseCore(fileBuffer, fileName, options);
    return options?.timeoutMs === undefined
      ? parsePromise
      : withTimeout(parsePromise, options.timeoutMs, this.name);
  }

  /** @internal Executes the parser body inside the isolated worker or a boundary test. */
  public async parseCore(
    fileBuffer: Buffer,
    fileName?: string,
    options?: ParserOptions
  ): Promise<ParseResult> {
    validateParserOptions(options, fileBuffer.length);
    return this.doParse(fileBuffer, fileName, options);
  }

  private async doParse(
    fileBuffer: Buffer,
    fileName?: string,
    options?: ParserOptions
  ): Promise<ParseResult> {
    const sourceBuffer = SafeArchiveExtractor.hasPreflightedBuffer(fileBuffer)
      ? fileBuffer
      : Buffer.from(fileBuffer);
    const claimsXlsx = fileName?.toLowerCase().endsWith('.xlsx') ?? false;
    let verifiedArchive: ArchiveExtractResult | undefined;
    if (SafeArchiveExtractor.isZipBuffer(sourceBuffer) || claimsXlsx) {
      try {
        await SafeArchiveExtractor.preflightBuffer(sourceBuffer, {}, 'xlsx');
        verifiedArchive = await SafeArchiveExtractor.extractBuffer(sourceBuffer);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const wrappedMessage =
          `Unable to parse Excel file "${fileName || 'spreadsheet'}": archive preflight failed: ${message}`;
        if (err instanceof ArchiveSecurityError) {
          throw new ArchiveSecurityError(err.code, wrappedMessage);
        }
        throw new Error(wrappedMessage);
      }
    }

    const isCsv = fileName?.toLowerCase().endsWith('.csv') || false;

    // 1. If CSV or TSV, parse directly without requiring external libraries
    if (isCsv) {
      return this.parseCsv(sourceBuffer.toString('utf8'), fileName);
    }

    const hasZipMagic = verifiedArchive !== undefined;
    const hasOlsMagic =
      sourceBuffer.length >= 8 &&
      sourceBuffer[0] === 0xd0 &&
      sourceBuffer[1] === 0xcf &&
      sourceBuffer[2] === 0x11 &&
      sourceBuffer[3] === 0xe0;
    const containsNullByte = sourceBuffer.includes(0x00);

    // If binary data lacks both XLSX (ZIP PK..) and XLS (OLE2 \xD0\xCF..) magic signatures, reject
    if (containsNullByte && !hasZipMagic && !hasOlsMagic) {
      throw new Error(
        `Unable to parse Excel file "${fileName || 'spreadsheet'}": file is corrupted or unsupported binary format.`
      );
    }

    // 2. Attempt sheetjs/xlsx dynamic require
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const xlsx = require('xlsx');
      if (xlsx && typeof xlsx.read === 'function') {
        const workbook = xlsx.read(sourceBuffer, { type: 'buffer' });
        const markdownParts: string[] = [];
        const textParts: string[] = [];
        let totalCells = 0;

        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const rows = xlsx.utils.sheet_to_json(sheet, {
            header: 1,
            blankrows: false,
          }) as unknown[][];

          if (rows.length === 0) continue;

          markdownParts.push(`### Sheet: ${sheetName}\n\n`);
          textParts.push(`--- Sheet: ${sheetName} ---\n`);

          let numCols = 0;
          for (const row of rows) {
            if (row.length > numCols) numCols = row.length;
          }

          if (numCols > 0) {
            const headerRow = rows[0] || [];
            const headerStrings = Array.from({ length: numCols }, (_, i) => {
              const val = headerRow[i] !== undefined && headerRow[i] !== null ? String(headerRow[i]) : `Col ${i + 1}`;
              return val.replace(/\|/g, '\\|').replace(/\n/g, ' ');
            });

            markdownParts.push(`| ${headerStrings.join(' | ')} |\n`);
            markdownParts.push(`| ${headerStrings.map(() => '---').join(' | ')} |\n`);
            textParts.push(headerStrings.join('\t') + '\n');
            totalCells += numCols;

            for (let i = 1; i < rows.length; i++) {
              const row = rows[i] || [];
              const rowStrings = Array.from({ length: numCols }, (_, j) => {
                const val = row[j] !== undefined && row[j] !== null ? String(row[j]) : '';
                return val.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
              });

              markdownParts.push(`| ${rowStrings.join(' | ')} |\n`);
              textParts.push(rowStrings.join('\t') + '\n');
              totalCells += numCols;
            }
          }

          markdownParts.push('\n');
          textParts.push('\n');
        }

        const fullText = textParts.join('').trim();
        const fullMarkdown = markdownParts.join('').trim();
        const wordCount = fullText.split(/\s+/).filter(Boolean).length;

        return {
          text: fullText,
          markdown: fullMarkdown,
          metadata: {
            sheetNames: workbook.SheetNames,
            wordCount,
            characterCount: fullText.length,
            detectedFormat: 'xlsx',
            parser: 'sheetjs',
            provenance: 'native_parse',
            customMetadata: { totalCells },
          },
          warnings: [],
        };
      }
    } catch {
      // xlsx not installed, fall through to basic text fallback
    }

    // 3. Fallback: Parse XLSX OpenXML structure from the archive already verified above.
    if (verifiedArchive) {
      const sheetEntry = verifiedArchive.entries.find((e) =>
        e.path === 'xl/worksheets/sheet1.xml' || e.path.endsWith('/sheet1.xml')
      );

      if (sheetEntry?.content) {
        const sheetXml = sheetEntry.content.toString('utf8');
        let sharedStrings: string[] = [];
        const sstEntry = verifiedArchive.entries.find((e) =>
          e.path === 'xl/sharedStrings.xml' || e.path.endsWith('/sharedStrings.xml')
        );
        if (sstEntry?.content) {
          sharedStrings = this.extractSharedStrings(sstEntry.content.toString('utf8'));
        }
        return this.parseWorksheetXml(sheetXml, sharedStrings, fileName);
      }
    }

    // 4. Fallback: If buffer can be read as text (e.g. CSV misidentified as xlsx)
    const rawContent = sourceBuffer.toString('utf8');
    if (!verifiedArchive && !rawContent.includes('\0')) {
      return this.parseCsv(rawContent, fileName);
    }

    throw new Error(
      `Unable to parse Excel file "${fileName || 'spreadsheet'}": file is corrupted or unsupported binary format.`
    );
  }

  private extractSharedStrings(xml: string): string[] {
    const strings: string[] = [];
    const siRegex = /<si(?:\s+[^>]*)?>([\s\S]*?)<\/si>/g;
    const tRegex = /<t(?:\s+[^>]*)?>([^<]*)<\/t>/g;
    let match: RegExpExecArray | null;
    while ((match = siRegex.exec(xml)) !== null) {
      const siContent = match[1];
      if (!siContent) continue;
      const textParts: string[] = [];
      let tMatch: RegExpExecArray | null;
      while ((tMatch = tRegex.exec(siContent)) !== null) {
        if (tMatch[1]) {
          textParts.push(tMatch[1]);
        }
      }
      strings.push(textParts.join(''));
    }
    return strings;
  }

  private parseWorksheetXml(
    xml: string,
    sharedStrings: string[],
    fileName?: string
  ): ParseResult {
    const rows: string[][] = [];
    const rowRegex = /<row(?:\s+[^>]*)?>([\s\S]*?)<\/row>/g;
    const cRegex = /<c(?:\s+[^>]*)?>([\s\S]*?)<\/c>/g;
    const isRegex = /<is><t(?:\s+[^>]*)?>([^<]*)<\/t><\/is>/;
    const vRegex = /<v>([^<]*)<\/v>/;

    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
      const rowContent = rowMatch[1];
      if (!rowContent) continue;
      const cells: string[] = [];
      let cMatch: RegExpExecArray | null;

      while ((cMatch = cRegex.exec(rowContent)) !== null) {
        const fullCellTag = cMatch[0];
        const cellBody = cMatch[1];
        if (!cellBody) continue;
        let val = '';

        if (fullCellTag.includes('t="inlineStr"')) {
          const isMatch = isRegex.exec(cellBody);
          if (isMatch && isMatch[1]) val = isMatch[1];
        } else if (fullCellTag.includes('t="s"')) {
          const vMatch = vRegex.exec(cellBody);
          if (vMatch && vMatch[1]) {
            const idx = parseInt(vMatch[1], 10);
            val = sharedStrings[idx] || '';
          }
        } else {
          const vMatch = vRegex.exec(cellBody);
          if (vMatch && vMatch[1]) val = vMatch[1];
        }

        cells.push(val);
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) {
      return {
        text: '',
        markdown: '',
        metadata: {
          sheetNames: ['Sheet1'],
          wordCount: 0,
          characterCount: 0,
          detectedFormat: 'xlsx',
          parser: 'xlsx-xml-fallback',
          provenance: 'native_parse',
        },
        warnings: [],
      };
    }

    const numCols = Math.max(...rows.map((r) => r.length));
    const markdownLines: string[] = [];
    const headerRow = rows[0] || [];
    const headerStrings = Array.from({ length: numCols }, (_, i) => headerRow[i] || `Col ${i + 1}`);

    markdownLines.push(`| ${headerStrings.join(' | ')} |`);
    markdownLines.push(`| ${headerStrings.map(() => '---').join(' | ')} |`);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const rowStrings = Array.from({ length: numCols }, (_, c) => row[c] || '');
      markdownLines.push(`| ${rowStrings.join(' | ')} |`);
    }

    const text = rows.map((r) => r.join('\t')).join('\n');
    const markdown = markdownLines.join('\n');
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return {
      text,
      markdown,
      metadata: {
        sheetNames: ['Sheet1'],
        wordCount,
        characterCount: text.length,
        detectedFormat: 'xlsx',
        parser: 'xlsx-xml-fallback',
        provenance: 'native_parse',
        customMetadata: { totalCells: rows.length * numCols },
      },
      warnings: [],
    };
  }

  private parseCsv(csvText: string, fileName?: string): ParseResult {
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const rows = lines.map((line) => this.parseCsvLine(line));

    const markdownLines: string[] = [];
    if (rows.length > 0) {
      const numCols = Math.max(...rows.map((r) => r.length));
      const headers = rows[0] || [];
      const headerStr = Array.from({ length: numCols }, (_, i) => headers[i] || `Col ${i + 1}`);

      markdownLines.push(`| ${headerStr.join(' | ')} |`);
      markdownLines.push(`| ${headerStr.map(() => '---').join(' | ')} |`);

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const rowStr = Array.from({ length: numCols }, (_, j) => row[j] || '');
        markdownLines.push(`| ${rowStr.join(' | ')} |`);
      }
    }

    const text = rows.map((r) => r.join('\t')).join('\n');
    const markdown = markdownLines.join('\n');
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return {
      text,
      markdown,
      metadata: {
        sheetNames: ['Sheet1'],
        wordCount,
        characterCount: text.length,
        detectedFormat: 'csv',
        parser: 'native-csv',
        provenance: 'native_parse',
      },
      warnings: [],
    };
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }
}
