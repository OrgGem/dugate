import { SplitPageRange } from '../types';
/**
 * PDF Splitter handles parsing page specifications and slicing PDF page buffers.
 */
export declare class PdfSplitter {
    /**
     * Parse a page expression string like "1-3,5,7-9" into an ordered, deduplicated list of 1-indexed page numbers.
     */
    static parsePageExpression(expression: string, totalPages?: number): number[];
    /**
     * Convert list of page numbers to continuous range objects.
     */
    static toRanges(pageNumbers: number[]): SplitPageRange[];
    /**
     * Determine total page count of a PDF, using pdf-lib if available or structural fallback.
     */
    static getPageCount(pdfBuffer: Buffer): Promise<number>;
    /**
     * Inspect PDF buffer to determine total page count synchronously.
     */
    static getTotalPages(pdfBuffer: Buffer): number;
    /**
     * Slice a PDF buffer down to only the requested pages, returning a valid PDF artifact.
     */
    static splitPdf(pdfBuffer: Buffer, pageExpression: string): Promise<Buffer>;
    /**
     * Generates a completely valid standard PDF-1.4 binary buffer with N pages,
     * correct xref byte offsets, page tree, font resource, and trailer.
     */
    static createValidPdf(pagesText: string[]): Buffer;
    private static extractPageTexts;
}
//# sourceMappingURL=pdf-splitter.d.ts.map