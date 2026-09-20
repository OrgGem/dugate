import { DocumentParser, FormatDetectionResult, ParseResult } from '../types';
export declare class ExcelParser implements DocumentParser {
    readonly name = "ExcelParser";
    canHandle(formatInfo: FormatDetectionResult): boolean;
    parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult>;
    private extractSharedStrings;
    private parseWorksheetXml;
    private parseCsv;
    private parseCsvLine;
}
//# sourceMappingURL=excel-parser.d.ts.map