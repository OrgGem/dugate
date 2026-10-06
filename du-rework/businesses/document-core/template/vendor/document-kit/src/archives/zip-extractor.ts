// VENDORED from @du/document-kit @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/document-kit/src/archives/zip-extractor.ts (lines=691) sha256=EBECDD01F37673137951C189E01B2C955BEDD494ED9F4480A497553C691E8E4A
// why: transitive dep of formats/detector.ts (SafeArchiveExtractor); imports ../types + node path/zlib/crypto

import * as path from 'path';
import * as zlib from 'zlib';
import { createHash } from 'crypto';
import {
  ArchiveEntry,
  ArchiveExtractOptions,
  ArchiveExtractResult,
} from '../types';

type OfficeArchiveFormat = 'docx' | 'xlsx';

export type ArchiveSecurityErrorCode =
  | 'ARCHIVE_ZIP64_UNSUPPORTED'
  | 'ARCHIVE_DATA_DESCRIPTOR_UNSUPPORTED'
  | 'ARCHIVE_DECOMPRESSION_RATIO_EXCEEDED'
  | 'ARCHIVE_TOTAL_UNCOMPRESSED_BYTES_EXCEEDED'
  | 'ARCHIVE_FILE_ENTRY_COUNT_EXCEEDED'
  | 'ARCHIVE_DECOMPRESSION_OUTPUT_LIMIT_EXCEEDED';

export class ArchiveSecurityError extends Error {
  public readonly code: ArchiveSecurityErrorCode;

  constructor(code: ArchiveSecurityErrorCode, message: string) {
    super(message);
    this.name = 'ArchiveSecurityError';
    this.code = code;
  }
}

interface PlannedEntry {
  path: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  headerOffset: number;
  dataOffset: number;
  isDirectory: boolean;
}

interface ArchivePlan {
  entries: PlannedEntry[];
  totalUncompressedSize: number;
}

interface NormalizedOptions {
  maxTotalSize: number;
  maxFileCount: number;
  maxDecompressionRatio: number;
}

interface CachedPreflight {
  optionsKey: string;
  inputHash: string;
  result: ArchiveExtractResult;
}

/**
 * Preflights ZIP metadata before any document parser is dispatched, then verifies
 * every entry with bounded decompression. The verified result is reused by the
 * parser so Office archives are not inflated a second time.
 */
export class SafeArchiveExtractor {
  private static readonly DEFAULT_MAX_SIZE = 50 * 1024 * 1024;
  private static readonly DEFAULT_MAX_FILES = 1000;
  private static readonly DEFAULT_MAX_RATIO = 100;
  private static readonly FORMAT_INSPECTION_OPTIONS: NormalizedOptions = {
    maxTotalSize: Number.MAX_SAFE_INTEGER,
    maxFileCount: Number.MAX_SAFE_INTEGER,
    maxDecompressionRatio: Number.MAX_SAFE_INTEGER,
  };
  private static readonly PREFLIGHT_CACHE = new WeakMap<Buffer, CachedPreflight>();
  private static readonly CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
    return table;
  })();

  /** True when the buffer starts with a standard ZIP local, central, or EOCD signature. */
  public static isZipBuffer(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;
    const signature = buffer.readUInt32LE(0);
    return signature === 0x04034b50 || signature === 0x02014b50 || signature === 0x06054b50;
  }

  /** Inspects validated archive paths without inflating entry contents. */
  public static inspectEntryNames(
    zipBuffer: Buffer,
    options: ArchiveExtractOptions = {}
  ): string[] {
    const plan = this.createPlan(zipBuffer, this.normalizeOptions(options));
    return plan.entries.map((entry) => entry.path);
  }

  /**
   * Reads entry names for format detection without applying decompression resource caps.
   * It never inflates data; the parser factory must still run full preflight before dispatch.
   */
  public static inspectEntryNamesForFormatDetection(zipBuffer: Buffer): string[] {
    const plan = this.createPlan(zipBuffer, this.FORMAT_INSPECTION_OPTIONS);
    return plan.entries.map((entry) => entry.path);
  }

  /** Indicates that this exact buffer and the default resource limits already passed preflight. */
  public static hasPreflightedBuffer(buffer: Buffer): boolean {
    const cached = this.PREFLIGHT_CACHE.get(buffer);
    return Boolean(
      cached &&
        cached.optionsKey === this.optionsKey(this.normalizeOptions({})) &&
        cached.inputHash === this.bufferHash(buffer)
    );
  }

  /**
   * Validates structure, traversal, declared resource limits, compression integrity,
   * decompressed size, and CRC before the parser dispatch boundary is crossed.
   */
  public static async preflightBuffer(
    zipBuffer: Buffer,
    options: ArchiveExtractOptions = {},
    expectedFormat?: OfficeArchiveFormat
  ): Promise<void> {
    const normalizedOptions = this.normalizeOptions(options);
    const optionsKey = this.optionsKey(normalizedOptions);
    const inputHash = this.bufferHash(zipBuffer);
    const cached = this.PREFLIGHT_CACHE.get(zipBuffer);
    if (cached && cached.optionsKey === optionsKey && cached.inputHash === inputHash) {
      this.validateOfficeMarker(cached.result.entries, expectedFormat);
      return;
    }

    this.PREFLIGHT_CACHE.delete(zipBuffer);
    const plan = this.createPlan(zipBuffer, normalizedOptions);
    this.validateOfficeMarker(
      plan.entries.map((entry) => ({ path: entry.path } as ArchiveEntry)),
      expectedFormat
    );
    const result = this.extractPlannedEntries(zipBuffer, plan, normalizedOptions);
    if (this.bufferHash(zipBuffer) !== inputHash) {
      throw new Error('Archive security violation: ZIP input changed during preflight');
    }
    this.PREFLIGHT_CACHE.set(zipBuffer, { optionsKey, inputHash, result });
  }

  /** Safely returns entries only after the same fail-closed preflight has passed. */
  public static async extractBuffer(
    zipBuffer: Buffer,
    options: ArchiveExtractOptions = {}
  ): Promise<ArchiveExtractResult> {
    const normalizedOptions = this.normalizeOptions(options);
    const optionsKey = this.optionsKey(normalizedOptions);
    const inputHash = this.bufferHash(zipBuffer);
    let cached = this.PREFLIGHT_CACHE.get(zipBuffer);

    if (!cached || cached.optionsKey !== optionsKey || cached.inputHash !== inputHash) {
      await this.preflightBuffer(zipBuffer, normalizedOptions);
      cached = this.PREFLIGHT_CACHE.get(zipBuffer);
    }

    if (!cached || cached.optionsKey !== optionsKey || cached.inputHash !== this.bufferHash(zipBuffer)) {
      throw new Error('Archive security violation: ZIP preflight result was not retained');
    }

    this.PREFLIGHT_CACHE.delete(zipBuffer);
    return cached.result;
  }

  /** Decompression seam kept explicit so tests can assert guard ordering and output bounds. */
  public static decompressRaw(compressedData: Buffer, maxOutputLength: number): Buffer {
    return zlib.inflateRawSync(compressedData, { maxOutputLength });
  }

  private static normalizeOptions(options: ArchiveExtractOptions): NormalizedOptions {
    const normalized: NormalizedOptions = {
      maxTotalSize: options.maxTotalSize ?? this.DEFAULT_MAX_SIZE,
      maxFileCount: options.maxFileCount ?? this.DEFAULT_MAX_FILES,
      maxDecompressionRatio: options.maxDecompressionRatio ?? this.DEFAULT_MAX_RATIO,
    };

    for (const [name, value] of [
      ['maxTotalSize', normalized.maxTotalSize],
      ['maxFileCount', normalized.maxFileCount],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Archive security violation: ${name} must be a non-negative safe integer`);
      }
    }
    if (!Number.isFinite(normalized.maxDecompressionRatio) || normalized.maxDecompressionRatio < 0) {
      throw new Error(
        'Archive security violation: maxDecompressionRatio must be a finite non-negative number'
      );
    }

    return normalized;
  }

  private static optionsKey(options: NormalizedOptions): string {
    return `${options.maxTotalSize}:${options.maxFileCount}:${options.maxDecompressionRatio}`;
  }

  private static bufferHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private static createPlan(zipBuffer: Buffer, options: NormalizedOptions): ArchivePlan {
    const entries: PlannedEntry[] = [];
    const entryPaths = new Set<string>();
    let totalUncompressedSize = 0;
    let offset = 0;

    if (zipBuffer.length < 4) {
      throw this.malformed('ZIP signature is missing or truncated');
    }

    while (offset < zipBuffer.length) {
      if (offset + 4 > zipBuffer.length) {
        throw this.malformed('trailing ZIP signature is truncated');
      }

      const signature = zipBuffer.readUInt32LE(offset);
      if (signature === 0x04034b50) {
        const entry = this.readLocalEntry(zipBuffer, offset, options, totalUncompressedSize);
        if (entries.length >= options.maxFileCount) {
          throw new ArchiveSecurityError(
            'ARCHIVE_FILE_ENTRY_COUNT_EXCEEDED',
            `Archive security violation: Exceeded maximum allowed entry count (${options.maxFileCount})`
          );
        }
        const normalizedPath = entry.path.replace(/\\/g, '/').toLowerCase();
        if (entryPaths.has(normalizedPath)) {
          throw new Error(
            `Archive security violation: Duplicate archive entry path "${entry.path}" is ambiguous`
          );
        }
        entryPaths.add(normalizedPath);
        entries.push(entry);
        totalUncompressedSize += entry.uncompressedSize;
        offset = entry.dataOffset + entry.compressedSize;
        continue;
      }

      if (signature === 0x02014b50) {
        this.validateCentralDirectory(zipBuffer, offset, entries);
        return { entries, totalUncompressedSize };
      }

      if (signature === 0x06054b50) {
        this.validateEmptyEndRecord(zipBuffer, offset, entries);
        return { entries, totalUncompressedSize };
      }

      if (signature === 0x06064b50 || signature === 0x07064b50) {
        throw this.zip64Unsupported('ZIP64 end records are unsupported');
      }
      if (signature === 0x08074b50) {
        throw this.dataDescriptorUnsupported('Unexpected ZIP data descriptor record');
      }

      throw this.malformed(`unexpected ZIP record signature at byte ${offset}`);
    }

    // Local-header-only archives are accepted for compatibility with streaming ZIP writers.
    return { entries, totalUncompressedSize };
  }

  private static readLocalEntry(
    zipBuffer: Buffer,
    offset: number,
    options: NormalizedOptions,
    totalUncompressedSize: number
  ): PlannedEntry {
    if (offset + 30 > zipBuffer.length) {
      throw this.malformed('local file header is truncated');
    }

    const flags = zipBuffer.readUInt16LE(offset + 6);
    if ((flags & 0x0001) !== 0) {
      throw new Error('Archive security violation: Encrypted ZIP entries are unsupported');
    }
    if ((flags & 0x0008) !== 0) {
      throw this.dataDescriptorUnsupported(
        'ZIP data descriptors are unsupported because entry sizes are not preflightable'
      );
    }

    const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(
        `Archive security violation: Unsupported compression method (${compressionMethod})`
      );
    }

    const crc32 = zipBuffer.readUInt32LE(offset + 14);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw this.zip64Unsupported('ZIP64 local entry sizes are unsupported');
    }

    const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(offset + 28);
    const headerSize = 30 + fileNameLength + extraFieldLength;
    if (fileNameLength === 0 || offset + headerSize > zipBuffer.length) {
      throw this.malformed('local file name or extra field is truncated');
    }
    this.validateExtraFields(zipBuffer, offset + 30 + fileNameLength, extraFieldLength);

    const fileName = zipBuffer.subarray(offset + 30, offset + 30 + fileNameLength).toString('utf8');
    this.validatePathSafety(fileName);
    const isDirectory = fileName.endsWith('/') || fileName.endsWith('\\');
    if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new Error(
        `Archive security violation: Directory entry "${fileName}" must not contain file data`
      );
    }

    if (uncompressedSize > options.maxTotalSize - totalUncompressedSize) {
      throw new ArchiveSecurityError(
        'ARCHIVE_TOTAL_UNCOMPRESSED_BYTES_EXCEEDED',
        `Archive security violation: Decompressed size exceeds maximum allowed limit (${options.maxTotalSize} bytes)`
      );
    }

    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new ArchiveSecurityError(
        'ARCHIVE_DECOMPRESSION_RATIO_EXCEEDED',
        `Archive security violation: Suspicious compression ratio (infinite:1 exceeds limit of ${options.maxDecompressionRatio}:1) for entry "${fileName}"`
      );
    }
    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > options.maxDecompressionRatio) {
        throw new ArchiveSecurityError(
          'ARCHIVE_DECOMPRESSION_RATIO_EXCEEDED',
          `Archive security violation: Suspicious compression ratio (${ratio.toFixed(
            1
          )}:1 exceeds limit of ${options.maxDecompressionRatio}:1) for entry "${fileName}"`
        );
      }
    }
    if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
      throw new Error(
        `Archive security violation: Stored entry "${fileName}" has inconsistent size metadata`
      );
    }

    const dataOffset = offset + headerSize;
    if (dataOffset + compressedSize > zipBuffer.length) {
      throw this.malformed(`compressed data for entry "${fileName}" is truncated`);
    }

    return {
      path: fileName,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      headerOffset: offset,
      dataOffset,
      isDirectory,
    };
  }

  private static validateCentralDirectory(
    zipBuffer: Buffer,
    centralOffset: number,
    localEntries: PlannedEntry[]
  ): void {
    const matchedOffsets = new Set<number>();
    const localEntriesByOffset = new Map(localEntries.map((entry) => [entry.headerOffset, entry]));
    let offset = centralOffset;
    let centralEntryCount = 0;

    while (offset < zipBuffer.length) {
      if (offset + 4 > zipBuffer.length) {
        throw this.malformed('central directory signature is truncated');
      }
      const signature = zipBuffer.readUInt32LE(offset);

      if (signature === 0x02014b50) {
        if (offset + 46 > zipBuffer.length) {
          throw this.malformed('central directory entry is truncated');
        }

        const flags = zipBuffer.readUInt16LE(offset + 8);
        const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
        const crc32 = zipBuffer.readUInt32LE(offset + 16);
        const compressedSize = zipBuffer.readUInt32LE(offset + 20);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
        const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
        const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
        const commentLength = zipBuffer.readUInt16LE(offset + 32);
        const diskStart = zipBuffer.readUInt16LE(offset + 34);
        const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
        const recordEnd = offset + 46 + fileNameLength + extraFieldLength + commentLength;

        if (recordEnd > zipBuffer.length || fileNameLength === 0) {
          throw this.malformed('central directory name, extra field, or comment is truncated');
        }
        if (
          compressedSize === 0xffffffff ||
          uncompressedSize === 0xffffffff ||
          localHeaderOffset === 0xffffffff
        ) {
          throw this.zip64Unsupported('ZIP64 central directory fields are unsupported');
        }
        if (diskStart !== 0) {
          throw new Error('Archive security violation: Multi-disk ZIP archives are unsupported');
        }
        this.validateExtraFields(zipBuffer, offset + 46 + fileNameLength, extraFieldLength);

        const fileName = zipBuffer
          .subarray(offset + 46, offset + 46 + fileNameLength)
          .toString('utf8');
        const localEntry = localEntriesByOffset.get(localHeaderOffset);
        if (!localEntry || matchedOffsets.has(localHeaderOffset)) {
          throw this.malformed(`central directory entry "${fileName}" has an invalid local offset`);
        }
        if (
          localEntry.path !== fileName ||
          localEntry.flags !== flags ||
          localEntry.compressionMethod !== compressionMethod ||
          localEntry.crc32 !== crc32 ||
          localEntry.compressedSize !== compressedSize ||
          localEntry.uncompressedSize !== uncompressedSize
        ) {
          throw this.malformed(`central directory metadata does not match local entry "${fileName}"`);
        }

        matchedOffsets.add(localHeaderOffset);
        centralEntryCount++;
        offset = recordEnd;
        continue;
      }

      if (signature === 0x06054b50) {
        this.validateEndRecord(zipBuffer, offset, centralOffset, localEntries.length, centralEntryCount);
        if (matchedOffsets.size !== localEntries.length) {
          throw this.malformed('central directory is missing one or more local entries');
        }
        return;
      }

      if (signature === 0x06064b50 || signature === 0x07064b50) {
        throw this.zip64Unsupported('ZIP64 end records are unsupported');
      }
      if (signature === 0x08074b50) {
        throw this.dataDescriptorUnsupported('Unexpected ZIP data descriptor in central directory');
      }

      throw this.malformed(`unexpected central directory record at byte ${offset}`);
    }

    throw this.malformed('end of central directory record is missing');
  }

  private static validateEndRecord(
    zipBuffer: Buffer,
    offset: number,
    centralOffset: number,
    localEntryCount: number,
    centralEntryCount: number
  ): void {
    if (offset + 22 > zipBuffer.length) {
      throw this.malformed('end of central directory record is truncated');
    }

    const diskNumber = zipBuffer.readUInt16LE(offset + 4);
    const centralDisk = zipBuffer.readUInt16LE(offset + 6);
    const diskEntryCount = zipBuffer.readUInt16LE(offset + 8);
    const totalEntryCount = zipBuffer.readUInt16LE(offset + 10);
    const centralSize = zipBuffer.readUInt32LE(offset + 12);
    const declaredCentralOffset = zipBuffer.readUInt32LE(offset + 16);
    const commentLength = zipBuffer.readUInt16LE(offset + 20);

    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      diskEntryCount === 0xffff ||
      totalEntryCount === 0xffff ||
      centralSize === 0xffffffff ||
      declaredCentralOffset === 0xffffffff
    ) {
      if (
        diskEntryCount === 0xffff ||
        totalEntryCount === 0xffff ||
        centralSize === 0xffffffff ||
        declaredCentralOffset === 0xffffffff
      ) {
        throw this.zip64Unsupported('ZIP64 end record fields are unsupported');
      }
      throw new Error('Archive security violation: Multi-disk ZIP archives are unsupported');
    }
    if (diskEntryCount !== centralEntryCount || totalEntryCount !== centralEntryCount) {
      throw this.malformed('end record entry counts do not match the central directory');
    }
    if (centralEntryCount !== localEntryCount) {
      throw this.malformed('central and local entry counts do not match');
    }
    if (centralSize !== offset - centralOffset || declaredCentralOffset !== centralOffset) {
      throw this.malformed('end record central directory range does not match the parsed directory');
    }
    if (offset + 22 + commentLength !== zipBuffer.length) {
      throw this.malformed('end record comment length does not match archive length');
    }
  }

  private static validateEmptyEndRecord(
    zipBuffer: Buffer,
    offset: number,
    localEntries: PlannedEntry[]
  ): void {
    if (localEntries.length > 0) {
      throw this.malformed('end record appears before the central directory');
    }
    this.validateEndRecord(zipBuffer, offset, offset, 0, 0);
  }

  private static extractPlannedEntries(
    zipBuffer: Buffer,
    plan: ArchivePlan,
    options: NormalizedOptions
  ): ArchiveExtractResult {
    const entries: ArchiveEntry[] = [];
    let totalExtractedSize = 0;

    for (const entry of plan.entries) {
      let content: Buffer | undefined;
      if (!entry.isDirectory) {
        const compressedData = zipBuffer.subarray(
          entry.dataOffset,
          entry.dataOffset + entry.compressedSize
        );
        if (entry.compressionMethod === 0) {
          content = Buffer.from(compressedData);
        } else {
          const remainingSize = options.maxTotalSize - totalExtractedSize;
          const ratioBound = Math.floor(entry.compressedSize * options.maxDecompressionRatio);
          const outputLimit = Math.max(
            1,
            Math.min(remainingSize, ratioBound, entry.uncompressedSize)
          );
          try {
            content = this.decompressRaw(compressedData, outputLimit);
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ERR_BUFFER_TOO_LARGE' || error.message.includes('ERR_BUFFER_TOO_LARGE')) {
              throw new ArchiveSecurityError(
                'ARCHIVE_DECOMPRESSION_OUTPUT_LIMIT_EXCEEDED',
                `Archive security violation: Entry "${entry.path}" exceeded bounded decompression memory limit (${outputLimit} bytes)`
              );
            }
            throw new Error(
              `Archive security violation: Failed to decompress entry "${entry.path}": ${error.message}`
            );
          }

          if (content.length > outputLimit) {
            throw new Error(
              `Archive security violation: Entry "${entry.path}" exceeded bounded decompression memory limit (${outputLimit} bytes)`
            );
          }
        }

        if (content.length !== entry.uncompressedSize) {
          throw new Error(
            `Archive security violation: Entry "${entry.path}" decompressed size does not match its header`
          );
        }
        if (this.computeCrc32(content) !== entry.crc32) {
          throw new Error(
            `Archive security violation: Entry "${entry.path}" failed CRC integrity validation`
          );
        }

        totalExtractedSize += content.length;
      }

      entries.push({
        path: entry.path,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        isDirectory: entry.isDirectory,
        content,
      });
    }

    if (totalExtractedSize > plan.totalUncompressedSize) {
      throw new Error('Archive security violation: Extracted data exceeded validated size totals');
    }

    return {
      entries,
      totalExtractedSize,
      fileCount: entries.length,
      warnings: [],
    };
  }

  private static validateOfficeMarker(
    entries: ArchiveEntry[],
    expectedFormat?: OfficeArchiveFormat
  ): void {
    if (!expectedFormat) return;
    const requiredPath = expectedFormat === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
    if (!entries.some((entry) => entry.path === requiredPath)) {
      throw new Error(
        `Archive security violation: ZIP content does not contain the required ${expectedFormat.toUpperCase()} entry "${requiredPath}"`
      );
    }
  }

  private static computeCrc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc = (this.CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  private static malformed(reason: string): Error {
    return new Error(`Archive security violation: Malformed ZIP archive: ${reason}`);
  }

  private static validateExtraFields(zipBuffer: Buffer, offset: number, length: number): void {
    const end = offset + length;
    while (offset < end) {
      if (offset + 4 > end) {
        throw this.malformed('ZIP extra field header is truncated');
      }
      const fieldId = zipBuffer.readUInt16LE(offset);
      const fieldLength = zipBuffer.readUInt16LE(offset + 2);
      offset += 4;
      if (offset + fieldLength > end) {
        throw this.malformed('ZIP extra field payload is truncated');
      }
      if (fieldId === 0x0001) {
        throw this.zip64Unsupported('ZIP64 extra fields are unsupported');
      }
      offset += fieldLength;
    }
  }

  private static zip64Unsupported(reason: string): ArchiveSecurityError {
    return new ArchiveSecurityError(
      'ARCHIVE_ZIP64_UNSUPPORTED',
      `Archive security violation: ${reason}`
    );
  }

  private static dataDescriptorUnsupported(reason: string): ArchiveSecurityError {
    return new ArchiveSecurityError(
      'ARCHIVE_DATA_DESCRIPTOR_UNSUPPORTED',
      `Archive security violation: ${reason}`
    );
  }

  /** Rejects absolute paths and traversal segments before any decompression. */
  public static validatePathSafety(filePath: string): void {
    const normalized = filePath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(
        `Archive security violation: Absolute path traversal detected in archive entry "${filePath}"`
      );
    }

    for (const segment of normalized.split('/')) {
      if (segment === '..') {
        throw new Error(
          `Archive security violation: Directory traversal (..) detected in archive entry "${filePath}"`
        );
      }
    }

    const resolved = path.normalize(normalized);
    if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
      throw new Error(
        `Archive security violation: Resolved path escapes sandbox for entry "${filePath}"`
      );
    }
  }
}
