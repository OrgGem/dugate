// lib/archive.ts
// Generic archive utilities for workflow-builder plugin nodes.
// - compress: bundle entries (content or file paths) into a zip buffer/stream
// - extract:  safe unzip with Zip-Slip protection + size/entry guards
//
// Reuses `archiver` (already a dependency) for compression and `adm-zip` for extraction.

import archiver from 'archiver';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export interface ArchiveEntryInput {
  /** Name/path of the entry inside the archive (e.g. "a/full.txt") */
  name: string;
  /** Either literal content OR a source file path */
  content?: string;
  /** Path of an existing file to add (takes precedence over content) */
  filePath?: string;
}

export interface CompressOptions {
  format?: 'zip';
  level?: number; // 0-9
}

export interface ExtractOptions {
  dest: string;
  format?: 'zip';
  maxTotalBytes?: number;
  maxEntries?: number;
}

export interface ExtractResult {
  files: string[]; // absolute paths of extracted files
}

const DEFAULT_MAX_TOTAL_BYTES = 300 * 1024 * 1024; // 300MB (matches upload limit)
const DEFAULT_MAX_ENTRIES = 2000;

/** Stream that aggregates the archive into a single Buffer. */
export function archiveToBuffer(
  stream: Readable,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Validate an archive entry name for safe extraction. Returns true if the
 * name is unsafe (path traversal / absolute path / NUL bytes).
 */
export function isUnsafeArchiveEntry(name: string): boolean {
  if (name.includes('\0')) return true;
  if (name.startsWith('/')) return true;
  if (name.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true; // Windows drive-absolute
  const normalized = path.posix.normalize(name);
  // Reject any traversal after normalization (covers ../, a/../b, etc.)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) {
    return true;
  }
  if (normalized === '.' ) return false;
  return false;
}

/**
 * Create a zip stream from the given entries. Each entry is either literal
 * content or sourced from a file on disk.
 */
export function createArchiveFromEntries(
  entries: ArchiveEntryInput[],
  options: CompressOptions = {},
): Readable {
  const format = options.format ?? 'zip';
  const level = options.level ?? 6;

  if (format !== 'zip') {
    throw new Error(`Unsupported archive format '${format}'. Only 'zip' is supported.`);
  }

  const archive = archiver('zip', { zlib: { level } });
  archive.on('error', (err: Error) => { throw err; });

  for (const entry of entries) {
    if (entry.filePath) {
      archive.file(entry.filePath, { name: entry.name });
    } else {
      archive.append(entry.content ?? '', { name: entry.name });
    }
  }

  archive.finalize();
  return archive as unknown as Readable;
}

/**
 * Safely extract a zip buffer to `dest`. Guards against path traversal
 * (Zip-Slip) and enforces total-size + entry-count limits to prevent
 * zip-bomb DoS.
 */
export async function extractArchive(
  input: Buffer,
  options: ExtractOptions,
): Promise<ExtractResult> {
  const dest = options.dest;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  fs.mkdirSync(dest, { recursive: true });
  const destRoot = path.resolve(dest);

  let zip: AdmZip;
  try {
    zip = new AdmZip(input);
  } catch (err) {
    throw new Error(`Invalid zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = zip.getEntries();
  if (entries.length > maxEntries) {
    throw new Error(`Archive has ${entries.length} entries; exceeds max of ${maxEntries}.`);
  }

  let totalBytes = 0;
  const extracted: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryName = entry.entryName;
    if (isUnsafeArchiveEntry(entryName)) {
      throw new Error(`Blocked unsafe archive entry path '${entryName}' (path traversal).`);
    }

    const target = path.resolve(destRoot, entryName);
    if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
      throw new Error(`Blocked archive entry '${entryName}' escaping destination.`);
    }

    const data = entry.getData();
    totalBytes += data.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Archive expands beyond max size limit of ${maxTotalBytes} bytes.`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    extracted.push(target);
  }

  return { files: extracted };
}
