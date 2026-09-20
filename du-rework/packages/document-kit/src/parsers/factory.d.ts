import { DocumentParser, FormatDetectionResult } from '../types';
export declare class DocumentParserFactory {
    private parsers;
    constructor();
    private registerDefaults;
    registerParser(parser: DocumentParser): void;
    getParser(formatInfo: FormatDetectionResult): DocumentParser | null;
    parseBuffer(buffer: Buffer, fileName?: string, mimeHint?: string): Promise<import("../types").ParseResult>;
}
export declare const defaultParserFactory: DocumentParserFactory;
//# sourceMappingURL=factory.d.ts.map