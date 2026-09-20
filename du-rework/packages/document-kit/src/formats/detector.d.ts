import { FormatDetectionResult } from '../types';
/**
 * Format Detector detects document types using magic bytes, extensions, and MIME hints.
 */
export declare class DocumentFormatDetector {
    /**
     * Detect format from buffer and optional file name or mime hint.
     */
    static detect(buffer: Buffer, fileName?: string, mimeHint?: string): FormatDetectionResult;
    private static extractExtension;
    private static checkMagicBytes;
    private static isUtf8Text;
    private static isCsvText;
}
//# sourceMappingURL=detector.d.ts.map