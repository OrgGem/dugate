import * as path from 'path';
import * as zlib from 'zlib';
import {
  ArchiveEntry,
  ArchiveExtractOptions,
  ArchiveExtractResult,
} from '../types';

/**
 * SafeArchiveExtractor provides defense-in-depth zip archive parsing with:
 * 1. Zip Slip vulnerability protection (no directory traversal or outside path escaping).
 * 2. Zip Bomb protection (decompression ratio limits and max uncompressed size guard).
 * 3. File count limits (preventing inode/descriptor exhaustion).
 */
export class SafeArchiveExtractor {
  private static readonly DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50 MB
  private static readonly DEFAULT_MAX_FILES = 1000;
  private static readonly DEFAULT_MAX_RATIO = 100; // 100:1 ratio

  /**
   * Safely extract entries from a ZIP buffer into memory with strict resource limits.
   */
  public static async extractBuffer(
    zipBuffer: Buffer,
    options: ArchiveExtractOptions = {}
  ): Promise<ArchiveExtractResult> {
    const maxSize = options.maxTotalSize ?? this.DEFAULT_MAX_SIZE;
    const maxFiles = options.maxFileCount ?? this.DEFAULT_MAX_FILES;
    const maxRatio = options.maxDecompressionRatio ?? this.DEFAULT_MAX_RATIO;

    const entries: ArchiveEntry[] = [];
    const warnings: string[] = [];
    let totalExtractedSize = 0;

    // Parse Central Directory or Local File Headers
    let offset = 0;
    const len = zipBuffer.length;

    while (offset < len - 4) {
      const signature = zipBuffer.readUInt32LE(offset);

      // Local file header signature: 0x04034b50 ("PK\x03\x04")
      if (signature === 0x04034b50) {
        if (offset + 30 > len) break;

        const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
        const compressedSize = zipBuffer.readUInt32LE(offset + 18);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
        const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
        const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);

        const headerSize = 30 + fileNameLength + extraFieldLength;
        if (offset + headerSize > len) break;

        const fileNameBytes = zipBuffer.subarray(offset + 30, offset + 30 + fileNameLength);
        const rawFileName = fileNameBytes.toString('utf8');

        // Check path traversal (Zip Slip protection)
        this.validatePathSafety(rawFileName);

        const isDirectory = rawFileName.endsWith('/') || rawFileName.endsWith('\\');

        // Check entry count limit
        if (entries.length >= maxFiles) {
          throw new Error(
            `Archive security violation: Exceeded maximum allowed entry count (${maxFiles})`
          );
        }

        // Check compression ratio (Zip Bomb guard)
        if (compressedSize > 0) {
          const ratio = uncompressedSize / compressedSize;
          if (ratio > maxRatio) {
            throw new Error(
              `Archive security violation: Suspicious compression ratio (${ratio.toFixed(
                1
              )}:1 exceeds limit of ${maxRatio}:1) for entry "${rawFileName}"`
            );
          }
        }

        // Check total uncompressed size limit
        if (totalExtractedSize + uncompressedSize > maxSize) {
          throw new Error(
            `Archive security violation: Decompressed size exceeds maximum allowed limit (${maxSize} bytes)`
          );
        }

        const dataOffset = offset + headerSize;
        const compressedData = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

        let decompressedContent: Buffer | undefined;

        if (!isDirectory && uncompressedSize > 0) {
          if (compressionMethod === 0) {
            // Stored (no compression)
            if (compressedSize > maxSize - totalExtractedSize) {
              throw new Error(
                `Archive security violation: Stored entry exceeds remaining allowed size (${maxSize} bytes)`
              );
            }
            decompressedContent = Buffer.from(compressedData);
          } else if (compressionMethod === 8) {
            // Deflate with bounded decompression guard
            const entryMaxOutput = Math.min(
              maxSize - totalExtractedSize,
              Math.max(compressedSize * maxRatio, uncompressedSize > 0 ? uncompressedSize + 1024 : 0)
            );

            try {
              decompressedContent = zlib.inflateRawSync(compressedData, {
                maxOutputLength: entryMaxOutput,
              });

              // Post-decompression verification of actual bytes emitted
              if (decompressedContent.length > maxSize - totalExtractedSize) {
                throw new Error(
                  `Archive security violation: Actual decompressed size (${decompressedContent.length}) exceeds remaining quota`
                );
              }

              if (compressedSize > 0 && decompressedContent.length / compressedSize > maxRatio) {
                throw new Error(
                  `Archive security violation: Actual decompression ratio (${(
                    decompressedContent.length / compressedSize
                  ).toFixed(1)}:1) exceeds limit (${maxRatio}:1)`
                );
              }
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              if (message.includes('ERR_BUFFER_TOO_LARGE')) {
                throw new Error(
                  `Archive security violation: Entry "${rawFileName}" exceeded bounded decompression memory limit (${entryMaxOutput} bytes)`
                );
              }
              warnings.push(`Failed to decompress "${rawFileName}": ${message}`);
            }
          } else {
            warnings.push(
              `Unsupported compression method (${compressionMethod}) for entry "${rawFileName}"`
            );
          }
        }

        const actualSize = decompressedContent ? decompressedContent.length : uncompressedSize;
        totalExtractedSize += actualSize;

        entries.push({
          path: rawFileName,
          size: uncompressedSize,
          compressedSize,
          isDirectory,
          content: decompressedContent,
        });

        // Advance to next entry (Local header + payload)
        offset = dataOffset + compressedSize;
      } else if (signature === 0x02014b50 || signature === 0x06054b50) {
        // Central directory structure or end of central directory — done processing local headers
        break;
      } else {
        // Advance 1 byte to search for next signature
        offset++;
      }
    }

    return {
      entries,
      totalExtractedSize,
      fileCount: entries.length,
      warnings,
    };
  }

  /**
   * Zip Slip Validator: Ensures the file path contains no upward traversal
   * and does not attempt to resolve to an absolute root directory.
   */
  public static validatePathSafety(filePath: string): void {
    // Normalize path separators to POSIX style
    const normalized = filePath.replace(/\\/g, '/');

    // Reject absolute paths
    if (path.isAbsolute(normalized) || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(
        `Archive security violation: Absolute path traversal detected in archive entry "${filePath}"`
      );
    }

    // Check for directory traversal sequences
    const segments = normalized.split('/');
    for (const seg of segments) {
      if (seg === '..') {
        throw new Error(
          `Archive security violation: Directory traversal (..) detected in archive entry "${filePath}"`
        );
      }
    }

    // Check normalized path does not escape
    const resolved = path.normalize(normalized);
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
      throw new Error(
        `Archive security violation: Resolved path escapes sandbox for entry "${filePath}"`
      );
    }
  }
}
