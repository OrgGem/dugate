import type { MultipartBody, MultipartFile } from './legacy-multipart';

/**
 * Bridge between the byte-level multipart reader and the existing legacy
 * wire decoder.
 *
 * `legacy-wire-decoders.ts` was written against a Fetch `FormData`, and it
 * accepts any object exposing `get`/`getAll` plus a plain field map. Rather
 * than teach the decoder about Buffers — it is unit-tested and deliberately
 * free of transport concerns — this module adapts the parsed body into the
 * small File-like shape `isFileLike` already accepts (`name` + `size`), which
 * is what `collectFiles` filters on.
 *
 * Field order is preserved because the legacy contract depends on it:
 * `normalizeFiles` in the old runner reads `files[]`, then `source_file`,
 * then `target_file`, then `file`, and the resulting index is what
 * `compare` uses to tell the source document from the target one.
 */

/** Multipart field names the legacy contract recognises as documents. */
export const LEGACY_FILE_FIELDS = ['files[]', 'file', 'source_file', 'target_file'] as const;

/** The File-like surface `isFileLike` in the decoder requires. */
export interface LegacyFileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  /** Retained so a caller can persist the bytes without re-parsing. */
  readonly bytes: Buffer;
}

/**
 * A minimal `FormData` stand-in: `get` returns the first value, `getAll`
 * returns every value, and both mirror the browser semantics the decoder
 * already relies on.
 */
export class LegacyFormData {
  private readonly map = new Map<string, unknown[]>();

  private add(key: string, value: unknown): void {
    const existing = this.map.get(key);
    if (existing === undefined) this.map.set(key, [value]);
    else existing.push(value);
  }

  get(key: string): unknown {
    const values = this.map.get(key);
    return values === undefined || values.length === 0 ? null : values[0];
  }

  getAll(key: string): unknown[] {
    return [...(this.map.get(key) ?? [])];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  /** Build from a parsed multipart body, preserving arrival order. */
  static fromMultipart(body: MultipartBody): LegacyFormData {
    const form = new LegacyFormData();
    for (const [key, values] of body.fields) {
      for (const value of values) form.add(key, value);
    }
    for (const file of body.files) {
      form.add(file.fieldName, toFileLike(file));
    }
    return form;
  }
}

function toFileLike(file: MultipartFile): LegacyFileLike {
  return {
    name: file.fileName,
    size: file.content.length,
    type: file.contentType,
    bytes: file.content,
  };
}

/**
 * Every part as a plain record, for the decoder's `rawFields` path.
 *
 * Files MUST be included here, not just scalars: `collectFiles` in
 * `legacy-wire-decoders.ts` reads `files[]` through the form's `getAll` but
 * reads `source_file` / `target_file` / `file` through `rawFields.get(...)`.
 * Omitting them would silently drop every single-file and compare submission.
 *
 * Repeats collapse to an array so `expandArray` in the decoder still sees the
 * same values it would get from a real `FormData`.
 */
export function legacyFieldsToRecord(body: MultipartBody): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, values] of body.fields) {
    if (values.length === 0) continue;
    record[key] = values.length === 1 ? values[0] : values;
  }
  const filesByName = new Map<string, LegacyFileLike[]>();
  for (const file of body.files) {
    const like = toFileLike(file);
    const existing = filesByName.get(file.fieldName);
    if (existing === undefined) filesByName.set(file.fieldName, [like]);
    else existing.push(like);
  }
  for (const [key, likes] of filesByName) {
    record[key] = likes.length === 1 ? likes[0] : likes;
  }
  return record;
}
