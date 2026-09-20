import { DocumentParser, FormatDetectionResult, ParseResult } from '../types';
export declare class PdfParser implements DocumentParser {
    readonly name = "PdfParser";
    canHandle(formatInfo: FormatDetectionResult): boolean;
    parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult>;
    private extractReadableStringsFromPdf;
}
//# sourceMappingURL=pdf-parser.d.ts.map