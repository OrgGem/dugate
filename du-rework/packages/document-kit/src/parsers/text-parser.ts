import { DocumentParser, FormatDetectionResult, ParseResult } from '../types';

export class TextParser implements DocumentParser {
  public readonly name = 'TextParser';

  public canHandle(formatInfo: FormatDetectionResult): boolean {
    return ['txt', 'md'].includes(formatInfo.format);
  }

  public async parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult> {
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
