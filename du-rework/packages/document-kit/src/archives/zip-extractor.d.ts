import { ArchiveExtractOptions, ArchiveExtractResult } from '../types';
/**
 * SafeArchiveExtractor provides defense-in-depth zip archive parsing with:
 * 1. Zip Slip vulnerability protection (no directory traversal or outside path escaping).
 * 2. Zip Bomb protection (decompression ratio limits and max uncompressed size guard).
 * 3. File count limits (preventing inode/descriptor exhaustion).
 */
export declare class SafeArchiveExtractor {
    private static readonly DEFAULT_MAX_SIZE;
    private static readonly DEFAULT_MAX_FILES;
    private static readonly DEFAULT_MAX_RATIO;
    /**
     * Safely extract entries from a ZIP buffer into memory with strict resource limits.
     */
    static extractBuffer(zipBuffer: Buffer, options?: ArchiveExtractOptions): Promise<ArchiveExtractResult>;
    /**
     * Zip Slip Validator: Ensures the file path contains no upward traversal
     * and does not attempt to resolve to an absolute root directory.
     */
    static validatePathSafety(filePath: string): void;
}
//# sourceMappingURL=zip-extractor.d.ts.map