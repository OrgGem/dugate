import { FormatDetectionResult, SupportedFormat } from '../types';

/**
 * Format Detector detects document types using magic bytes, extensions, and MIME hints.
 */
export class DocumentFormatDetector {
  /**
   * Detect format from buffer and optional file name or mime hint.
   */
  public static detect(
    buffer: Buffer,
    fileName?: string,
    mimeHint?: string
  ): FormatDetectionResult {
    const ext = fileName ? this.extractExtension(fileName) : '';
    const magic = this.checkMagicBytes(buffer);

    let format: SupportedFormat = 'unknown';
    let mimeType = mimeHint || 'application/octet-stream';

    // 1. Magic bytes check
    if (magic === 'pdf') {
      format = 'pdf';
      mimeType = 'application/pdf';
    } else if (magic === 'png') {
      format = 'png';
      mimeType = 'image/png';
    } else if (magic === 'jpeg') {
      format = 'jpeg';
      mimeType = 'image/jpeg';
    } else if (magic === 'zip') {
      // Could be DOCX, XLSX, or pure ZIP
      if (ext === '.docx') {
        format = 'docx';
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (ext === '.xlsx') {
        format = 'xlsx';
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else {
        format = 'zip';
        mimeType = 'application/zip';
      }
    } else if (magic === 'tiff') {
      format = 'tiff';
      mimeType = 'image/tiff';
    }

    // 2. Extension check if still unknown or generic
    if (format === 'unknown' || format === 'zip') {
      if (ext === '.docx' || mimeHint?.includes('wordprocessingml')) {
        format = 'docx';
        mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      } else if (ext === '.xlsx' || mimeHint?.includes('spreadsheetml')) {
        format = 'xlsx';
        mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else if (ext === '.doc' || mimeHint === 'application/msword') {
        format = 'doc';
        mimeType = 'application/msword';
      } else if (ext === '.xls' || mimeHint === 'application/vnd.ms-excel') {
        format = 'xls';
        mimeType = 'application/vnd.ms-excel';
      } else if (ext === '.csv' || mimeHint === 'text/csv') {
        format = 'csv';
        mimeType = 'text/csv';
      } else if (ext === '.md' || ext === '.markdown' || mimeHint === 'text/markdown') {
        format = 'md';
        mimeType = 'text/markdown';
      } else if (ext === '.txt' || mimeHint === 'text/plain') {
        format = 'txt';
        mimeType = 'text/plain';
      } else if (ext === '.webp' || mimeHint === 'image/webp') {
        format = 'webp';
        mimeType = 'image/webp';
      }
    }

    // 3. Text fallback check
    if (format === 'unknown' && this.isUtf8Text(buffer)) {
      if (this.isCsvText(buffer)) {
        format = 'csv';
        mimeType = 'text/csv';
      } else {
        format = 'txt';
        mimeType = 'text/plain';
      }
    }

    const isBinary = !['txt', 'md', 'csv'].includes(format);
    const isOfficeDocument = ['docx', 'doc', 'xlsx', 'xls'].includes(format);
    const isImage = ['png', 'jpeg', 'tiff', 'webp'].includes(format);
    const isArchive = format === 'zip';

    return {
      format,
      mimeType,
      extension: ext,
      isBinary,
      isOfficeDocument,
      isImage,
      isArchive,
    };
  }

  private static extractExtension(fileName: string): string {
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot === -1) return '';
    return fileName.substring(lastDot).toLowerCase();
  }

  private static checkMagicBytes(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;

    // PDF: %PDF (25 50 44 46)
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return 'pdf';
    }

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'png';
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpeg';
    }

    // ZIP (including DOCX / XLSX): 50 4B 03 04 or 50 4B 05 06
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05)) {
      return 'zip';
    }

    // TIFF: II* (49 49 2A 00) or MM* (4D 4D 00 2A)
    if (
      (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a)
    ) {
      return 'tiff';
    }

    return null;
  }

  private static isUtf8Text(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 512);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) {
        return false; // Null byte indicates binary
      }
    }
    return true;
  }

  private static isCsvText(buffer: Buffer): boolean {
    const text = buffer.subarray(0, 1024).toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const line0 = lines[0];
    const line1 = lines[1];
    if (line0 !== undefined && line1 !== undefined && line0.includes(',') && line1.includes(',')) {
      const colCount0 = line0.split(',').length;
      const colCount1 = line1.split(',').length;
      return colCount0 > 1 && colCount0 === colCount1;
    }
    return false;
  }
}
