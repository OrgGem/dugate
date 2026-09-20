import { DocumentParser, FormatDetectionResult, ParseResult } from '../types';
export declare class WordParser implements DocumentParser {
    readonly name = "WordParser";
    canHandle(formatInfo: FormatDetectionResult): boolean;
    parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult>;
    private extractContentFromWordXml;
}
//# sourceMappingURL=word-parser.d.ts.map