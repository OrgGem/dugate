// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/document-kit/src/types.ts (lines=123) sha256=D1B18CBA1AC80F9E24F1B57B89A990DAC2C24465F2AA1146722E2436647479ED
// why: SupportedFormat + FormatDetectionResult/DiffHunk/DiffResult/SplitPageRange/Archive* types shared by all 4 downstream vendored files

/**
 * Core type definitions for @du/document-kit
 */

export type SupportedFormat =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'txt'
  | 'md'
  | 'png'
  | 'jpeg'
  | 'tiff'
  | 'webp'
  | 'zip'
  | 'unknown';

export interface FormatDetectionResult {
  /** Canonical format established from the input bytes and container markers. */
  format: SupportedFormat;
  /** Canonical MIME for `format`; caller MIME hints do not override it. */
  mimeType: string;
  /** Declared filename extension, normalized only for matching. */
  extension: string;
  /** Original caller-declared filename and MIME, retained unchanged for traceability. */
  declaredFileName?: string;
  declaredMimeType?: string;
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

export interface ParserOptions {
  /**
   * Maximum allowed buffer size in bytes before rejecting (deterministic oversize budget).
   * If specified, must be a finite non-negative integer (>= 0).
   */
  maxBufferSizeBytes?: number;

  /**
   * Maximum allowed caller wait duration in milliseconds before rejecting with a timeout error.
   * If specified, must be a finite positive number (> 0).
   *
   * The factory and built-in parser classes run in a terminable worker thread, using 30 seconds
   * when this value is omitted. A supplied value replaces that default. Registered custom parsers
   * use a caller-wait timeout and cannot preempt synchronous work.
   */
  timeoutMs?: number;
}

export interface DocumentParser {
  readonly name: string;
  canHandle(formatInfo: FormatDetectionResult): boolean;
  parse(fileBuffer: Buffer, fileName?: string, options?: ParserOptions): Promise<ParseResult>;
}

export interface ArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
  content?: Buffer;
}

export interface ArchiveExtractOptions {
  maxTotalSize?: number;       // Max decompressed size (default: 50MB)
  maxFileCount?: number;       // Max entries count (default: 1000)
  maxDecompressionRatio?: number; // Max compression ratio to prevent zip bomb (default: 100)
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
