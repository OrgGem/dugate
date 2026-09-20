import { DocumentParser, FormatDetectionResult, ParseResult } from '../types';
export declare class TextParser implements DocumentParser {
    readonly name = "TextParser";
    canHandle(formatInfo: FormatDetectionResult): boolean;
    parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult>;
    private wrapInMarkdown;
}
//# sourceMappingURL=text-parser.d.ts.map