import { DocumentParser, FormatDetectionResult, ParseResult, ParserOptions } from '../types';
import { ArchiveSecurityError, SafeArchiveExtractor } from '../archives/zip-extractor';
import { validateParserOptions, withTimeout } from './limits';
import { isMainThread } from 'worker_threads';
import {
  DEFAULT_PARSER_CPU_TIMEOUT_MS,
  parseBuiltInParserInWorker,
} from './worker-isolation';

export class WordParser implements DocumentParser {
  public readonly name = 'WordParser';

  public canHandle(formatInfo: FormatDetectionResult): boolean {
    return ['docx', 'doc'].includes(formatInfo.format);
  }

  public async parse(
    fileBuffer: Buffer,
    fileName?: string,
    options?: ParserOptions
  ): Promise<ParseResult> {
    validateParserOptions(options, fileBuffer.length);

    if (isMainThread && this.constructor === WordParser) {
      return parseBuiltInParserInWorker(
        'word-parser',
        'WordParser',
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
    const claimsDocx = fileName?.toLowerCase().endsWith('.docx') ?? false;
    if (SafeArchiveExtractor.isZipBuffer(sourceBuffer) || claimsDocx) {
      try {
        await SafeArchiveExtractor.preflightBuffer(sourceBuffer, {}, 'docx');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const wrappedMessage =
          `Unable to parse Word document "${fileName || 'document'}": archive preflight failed: ${message}`;
        if (err instanceof ArchiveSecurityError) {
          throw new ArchiveSecurityError(err.code, wrappedMessage);
        }
        throw new Error(wrappedMessage);
      }
    }

    const warnings: string[] = [];

    // 1. Direct OpenXML extraction via SafeArchiveExtractor (supports rich markdown tables).
    // Do not swallow archive failures into Mammoth: preflight errors must fail closed.
    if (SafeArchiveExtractor.isZipBuffer(sourceBuffer) || claimsDocx) {
      const archiveResult = await SafeArchiveExtractor.extractBuffer(sourceBuffer);
      const docXmlEntry = archiveResult.entries.find(
        (e) => e.path === 'word/document.xml' || e.path.endsWith('/document.xml')
      );

      if (docXmlEntry && docXmlEntry.content) {
        const xmlContent = docXmlEntry.content.toString('utf8');
        const extracted = this.extractContentFromWordXml(xmlContent);
        const wordCount = extracted.text.trim().split(/\s+/).filter(Boolean).length;

        return {
          text: extracted.text,
          markdown: extracted.markdown,
          metadata: {
            wordCount,
            characterCount: extracted.text.length,
            detectedFormat: 'docx',
            parser: 'word-xml',
            provenance: 'native_parse',
          },
          warnings,
        };
      }
    }

    // 2. Fallback to mammoth if installed
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mammoth = require('mammoth');
      if (mammoth && typeof mammoth.extractRawText === 'function') {
        const textResult = (await mammoth.extractRawText({
          buffer: sourceBuffer,
        })) as { value: string; messages: Array<{ message: string }> };

        const text = textResult.value || '';
        const wordCount = text.trim().split(/\s+/).filter(Boolean).length;

        return {
          text,
          markdown: text,
          metadata: {
            wordCount,
            characterCount: text.length,
            detectedFormat: 'docx',
            parser: 'mammoth',
            provenance: 'native_parse',
            customMetadata: {
              mammothMessages: textResult.messages,
            },
          },
          warnings: textResult.messages.map((m: { message: string }) => m.message),
        };
      }
    } catch {
      warnings.push('Mammoth library not available or timed out');
    }

    throw new Error(
      `Unable to parse Word document "${fileName || 'document'}": parser error. Warnings: ${warnings.join(
        '; '
      )}`
    );
  }

  private extractContentFromWordXml(xml: string): { text: string; markdown: string } {
    const textBlocks: string[] = [];
    const markdownBlocks: string[] = [];

    // Parse tables (<w:tbl>) and standalone paragraphs (<w:p>)
    const blockRegex = /<w:(tbl|p)(?:\s+[^>]*)?>([\s\S]*?)<\/w:\1>/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(xml)) !== null) {
      const type = match[1];
      const content = match[2];
      if (!type || !content) continue;

      if (type === 'p') {
        const textParts: string[] = [];
        const tRegex = /<w:t(?:\s+[^>]*)?>([^<]*)<\/w:t>/g;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRegex.exec(content)) !== null) {
          if (tMatch[1]) {
            textParts.push(tMatch[1]);
          }
        }
        const paragraph = textParts.join('').trim();
        if (paragraph) {
          textBlocks.push(paragraph);
          markdownBlocks.push(paragraph);
        }
      } else if (type === 'tbl') {
        // Table parsing
        const rows: string[][] = [];
        const trRegex = /<w:tr(?:\s+[^>]*)?>([\s\S]*?)<\/w:tr>/g;
        let trMatch: RegExpExecArray | null;

        while ((trMatch = trRegex.exec(content)) !== null) {
          const rowContent = trMatch[1];
          if (!rowContent) continue;

          const cells: string[] = [];
          const tcRegex = /<w:tc(?:\s+[^>]*)?>([\s\S]*?)<\/w:tc>/g;
          let tcMatch: RegExpExecArray | null;

          while ((tcMatch = tcRegex.exec(rowContent)) !== null) {
            const cellContent = tcMatch[1];
            if (!cellContent) continue;

            const cellTextParts: string[] = [];
            const tRegex = /<w:t(?:\s+[^>]*)?>([^<]*)<\/w:t>/g;
            let tMatch: RegExpExecArray | null;
            while ((tMatch = tRegex.exec(cellContent)) !== null) {
              if (tMatch[1]) {
                cellTextParts.push(tMatch[1]);
              }
            }
            cells.push(cellTextParts.join('').trim());
          }

          if (cells.length > 0) {
            rows.push(cells);
          }
        }

        if (rows.length > 0) {
          const maxCols = Math.max(...rows.map((r) => r.length));
          const tableLines: string[] = [];
          const headers = rows[0] || [];
          const headerStr = Array.from({ length: maxCols }, (_, i) => headers[i] || `Col ${i + 1}`);

          tableLines.push(`| ${headerStr.join(' | ')} |`);
          tableLines.push(`| ${headerStr.map(() => '---').join(' | ')} |`);

          for (let r = 1; r < rows.length; r++) {
            const row = rows[r] || [];
            const rowStr = Array.from({ length: maxCols }, (_, c) => row[c] || '');
            tableLines.push(`| ${rowStr.join(' | ')} |`);
          }

          markdownBlocks.push(tableLines.join('\n'));
          const textTable = rows.map((r) => r.join('\t')).join('\n');
          textBlocks.push(textTable);
        }
      }
    }

    return {
      text: textBlocks.join('\n\n'),
      markdown: markdownBlocks.join('\n\n'),
    };
  }
}
