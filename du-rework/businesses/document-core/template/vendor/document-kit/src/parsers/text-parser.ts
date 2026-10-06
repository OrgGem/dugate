// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/document-kit/src/parsers/text-parser.ts (lines=72) sha256=992BC845C05595DC729F04AD2687386B01B74B7605EC238055A4E065A9182701
// why: transitive dep of parsers/factory.ts

import { DocumentParser, FormatDetectionResult, ParseResult, ParserOptions } from '../types';
import { validateParserOptions, withTimeout } from './limits';
import { isMainThread } from 'worker_threads';
import {
  DEFAULT_PARSER_CPU_TIMEOUT_MS,
  parseBuiltInParserInWorker,
} from './worker-isolation';

export class TextParser implements DocumentParser {
  public readonly name = 'TextParser';

  public canHandle(formatInfo: FormatDetectionResult): boolean {
    return ['txt', 'md'].includes(formatInfo.format);
  }

  public async parse(
    fileBuffer: Buffer,
    fileName?: string,
    options?: ParserOptions
  ): Promise<ParseResult> {
    validateParserOptions(options, fileBuffer.length);

    if (isMainThread && this.constructor === TextParser) {
      return parseBuiltInParserInWorker(
        'text-parser',
        'TextParser',
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
    return this.doParse(fileBuffer, fileName);
  }

  private async doParse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult> {
    const rawText = fileBuffer.toString('utf8');
    const wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
    const isMarkdown = fileName?.endsWith('.md') ?? false;

    return {
      text: rawText,
      markdown: isMarkdown ? rawText : this.wrapInMarkdown(rawText),
      metadata: {
        wordCount,
        characterCount: rawText.length,
        detectedFormat: isMarkdown ? 'md' : 'txt',
        parser: this.name,
        provenance: 'native_parse',
      },
      warnings: [],
    };
  }

  private wrapInMarkdown(text: string): string {
    return text;
  }
}
