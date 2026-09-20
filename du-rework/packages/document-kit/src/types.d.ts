/**
 * Core type definitions for @du/document-kit
 */
export type SupportedFormat = 'pdf' | 'docx' | 'doc' | 'xlsx' | 'xls' | 'csv' | 'txt' | 'md' | 'png' | 'jpeg' | 'tiff' | 'webp' | 'zip' | 'unknown';
export interface FormatDetectionResult {
    format: SupportedFormat;
    mimeType: string;
    extension: string;
    isBinary: boolean;
    isOfficeDocument: boolean;
    isImage: boolean;
    isArchive: boolean;
}
export interface ParseResult {
    text: string;
    markdown: string;
    metadata: {
        pageCount?: number;
        sheetNames?: string[];
        wordCount: number;
        characterCount: number;
        detectedFormat: SupportedFormat;
        parser: string;
        provenance: 'native_parse' | 'ocr' | 'hybrid';
        customMetadata?: Record<string, unknown>;
    };
    warnings: string[];
}
export interface DocumentParser {
    readonly name: string;
    canHandle(formatInfo: FormatDetectionResult): boolean;
    parse(fileBuffer: Buffer, fileName?: string): Promise<ParseResult>;
}
export interface ArchiveEntry {
    path: string;
    size: number;
    compressedSize: number;
    isDirectory: boolean;
    content?: Buffer;
}
export interface ArchiveExtractOptions {
    maxTotalSize?: number;
    maxFileCount?: number;
    maxDecompressionRatio?: number;
    targetDirectory?: string;
}
export interface ArchiveExtractResult {
    entries: ArchiveEntry[];
    totalExtractedSize: number;
    fileCount: number;
    warnings: string[];
}
export interface SplitPageRange {
    startPage: number;
    endPage: number;
}
export interface DiffHunk {
    type: 'ADD' | 'DELETE' | 'EQUAL';
    content: string;
    sourceLineNumber?: number;
    targetLineNumber?: number;
}
export interface DiffResult {
    additionsCount: number;
    deletionsCount: number;
    unmodifiedCount: number;
    hunks: DiffHunk[];
    unifiedDiff: string;
}
export interface RedactionResult {
    redactedText: string;
    redactionsCount: number;
    countsByPattern: Record<string, number>;
}
//# sourceMappingURL=types.d.ts.map