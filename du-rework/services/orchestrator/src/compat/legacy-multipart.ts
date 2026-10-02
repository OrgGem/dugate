import { HttpError } from '../http/errors';

/**
 * Streaming multipart/form-data parser for the legacy compat facade.
 *
 * ## Why this exists
 *
 * The legacy DUGate clients POST files to `/api/v1/docs/*` as
 * `multipart/form-data`, but this orchestrator has no web framework and no
 * multipart dependency (see `package.json` — only `pg`, `bullmq`, `ioredis`,
 * `ajv` and the AWS SDK). `readBoundedBody` in `http/ingress.ts` only does
 * `JSON.parse` with a raw-string fallback, so a legacy submit would arrive as
 * one opaque string and no file would ever reach artifact storage.
 *
 * ## Why streaming rather than buffering
 *
 * Buffering the whole body would re-create the exact defect the worker side
 * already fixed in RV01-03: an upload that exceeds the cap is only refused
 * *after* the entire payload has been concatenated in memory. Parsing from
 * the socket stream means the cap is enforced *while* bytes arrive, and a file
 * part is handed downstream as a stream rather than a `Buffer`.
 *
 * ## Scope — deliberately not a general-purpose parser
 *
 * It supports exactly what the legacy wire uses:
 *
 * - `Content-Disposition: form-data; name="..."` with an optional
 *   `filename`, which routes the part to `files` instead of `fields`.
 * - No nested `multipart/*` (the legacy wire never sends one).
 * - `Content-Type` on a part is recorded; `Content-Transfer-Encoding` is not
 *   honoured because the legacy clients never emit it.
 *
 * Binary parts are **not** decoded to a string. `contentType` and
 * `fileName` travel alongside the stream, and `headers` are read as latin1
 * so header bytes can never be mistaken for UTF-8 text.
 */

export interface MultipartFile {
  readonly fieldName: string;
  readonly fileName: string;
  readonly contentType: string;
  /** Raw bytes, in arrival order. Empty only for a zero-length file. */
  readonly content: Buffer;
}

export interface MultipartField {
  readonly name: string;
  readonly value: string;
}

export interface MultipartBody {
  /** Scalar form fields. Repeated names keep every value, in order. */
  readonly fields: ReadonlyMap<string, readonly string[]>;
  /** File parts in arrival order. The legacy `files[]` field repeats. */
  readonly files: readonly MultipartFile[];
}

/** Content types this parser accepts. Anything else is a 415. */
const SUPPORTED_CONTENT_TYPES = new Set([
  'multipart/form-data',
  'multipart/mixed',
]);

/**
 * Total byte ceiling for one multipart body, independent of the per-file
 * cap. `maxJsonBytes` would be far too small (1 MiB); `maxBlobBytes` (64 MiB)
 * matches the ingress blob ceiling so a multipart submit can carry what a
 * single blob PUT is allowed to carry.
 */
export const DEFAULT_MAX_MULTIPART_BYTES = 64 * 1024 * 1024; // 64 MiB

const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB

const BOUNDARY_MAX_BYTES = 70;
const HEADER_MAX_BYTES = 16 * 1024;
const CRLF = Buffer.from('\r\n');
const DASHDASH = Buffer.from('--');

function boundaryOf(contentType: string | undefined): string {
  if (contentType === undefined) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content-type is required for multipart body');
  }
  const [rawType, ...params] = contentType.split(';');
  const type = (rawType ?? '').trim().toLowerCase();
  if (!SUPPORTED_CONTENT_TYPES.has(type)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', `unsupported content-type: ${type || '(empty)'}`);
  }
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key !== 'boundary') continue;
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (value.length === 0) {
      throw new HttpError(400, 'MALFORMED_BODY', 'multipart boundary is empty');
    }
    if (Buffer.byteLength(value) > BOUNDARY_MAX_BYTES) {
      throw new HttpError(400, 'MALFORMED_BODY', 'multipart boundary is too long');
    }
    return value;
  }
  throw new HttpError(400, 'MALFORMED_BODY', 'multipart content-type has no boundary parameter');
}

interface PartHeaders {
  readonly name: string;
  readonly fileName: string | undefined;
  readonly contentType: string;
}

/**
 * Parse one part's header block. Headers are latin1 so arbitrary binary
 * bytes in a filename stay byte-exact instead of being mangled by a UTF-8
 * decode that could throw.
 */
function parsePartHeaders(block: Buffer): PartHeaders {
  const lines = block.toString('latin1').split('\r\n');
  let name: string | undefined;
  let fileName: string | undefined;
  let contentType = 'application/octet-stream';

  for (const line of lines) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      for (const param of value.split(';').slice(1)) {
        const eq = param.indexOf('=');
        if (eq === -1) continue;
        const pkey = param.slice(0, eq).trim().toLowerCase();
        let pval = param.slice(eq + 1).trim();
        if (pval.startsWith('"') && pval.endsWith('"') && pval.length >= 2) {
          pval = pval.slice(1, -1);
        }
        if (pkey === 'name') name = pval;
        else if (pkey === 'filename') fileName = pval;
      }
    } else if (key === 'content-type') {
      contentType = value;
    }
  }

  if (name === undefined || name.length === 0) {
    throw new HttpError(400, 'MALFORMED_BODY', 'multipart part has no name');
  }
  return { name, fileName, contentType };
}

/**
 * Index of `needle` in `hay` at or after `from`, or -1.
 *
 * Written by hand rather than using `Buffer.indexOf` per chunk because the
 * delimiter can straddle a chunk edge; the caller therefore keeps the last
 * `delimiter.length - 1` bytes of the previous chunk in the carry buffer.
 */
function indexOfFrom(hay: Buffer, needle: Buffer, from: number): number {
  return hay.indexOf(needle, from);
}

const DASH = 0x2d;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Index of the next REAL delimiter, or -1.
 *
 * A bare `--boundary` is not enough: RFC 2046 requires the delimiter to be
 * followed by either the closing `--` or the CRLF that ends the header block.
 * File content may legitimately contain a lookalike such as
 * `--boundary-not-really`, and treating that as a delimiter would truncate the
 * upload and drop the rest of the file on the floor. A candidate whose two
 * trailing bytes have not arrived yet is left unjudged (returns -1) so the
 * caller keeps it in the carry buffer for the next chunk.
 */
function findDelimiter(hay: Buffer, delimiter: Buffer, from: number): number {
  let at = indexOfFrom(hay, delimiter, from);
  while (at !== -1) {
    const after = at + delimiter.length;
    if (hay.length < after + 2) return -1; // undecidable yet
    const b0 = hay[after];
    const b1 = hay[after + 1];
    const isClosing = b0 === DASH && b1 === DASH;
    const isHeaderEnd = b0 === CR && b1 === LF;
    if (isClosing || isHeaderEnd) return at;
    at = indexOfFrom(hay, delimiter, at + 1);
  }
  return -1;
}

export interface ReadMultipartOptions {
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
}

/**
 * Read and parse a multipart body from a byte stream.
 *
 * The byte cap is enforced *during* consumption: exceeding it stops reading
 * immediately and rejects with 413, so an oversized upload never lands in
 * memory in full. Stream-level failures reject with 400 `MALFORMED_BODY` and
 * never echo chunk bytes.
 */
export async function readMultipartBody(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
  contentType: string | undefined,
  opts: ReadMultipartOptions = {},
): Promise<MultipartBody> {
  const boundary = boundaryOf(contentType);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MULTIPART_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const delimiter = Buffer.concat([DASHDASH, Buffer.from(boundary)]);

  const fields = new Map<string, string[]>();
  const files: MultipartFile[] = [];

  // Everything seen so far minus the tail that could still be part of a
  // delimiter spanning a chunk boundary.
  let carry = Buffer.alloc(0);
  let total = 0;
  // Set while positioned inside a part body, so the trailing CRLF that
  // belongs to the framing (not the content) is excluded from the bytes.
  let current: { headers: PartHeaders; chunks: Buffer[]; size: number } | null = null;
  let sawFirstDelimiter = false;
  let done = false;

  const startPart = (headers: PartHeaders): void => {
    current = { headers, chunks: [], size: 0 };
  };

  const finishPart = (): void => {
    const part = current;
    current = null;
    if (part === null) return;
    if (part.headers.fileName === undefined) {
      const existing = fields.get(part.headers.name);
      const value = Buffer.concat(part.chunks).toString('utf8');
      if (existing === undefined) fields.set(part.headers.name, [value]);
      else existing.push(value);
      return;
    }
    if (part.size > maxFileBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `multipart file ${part.headers.name} exceeds ${maxFileBytes} bytes`);
    }
    files.push({
      fieldName: part.headers.name,
      fileName: part.headers.fileName,
      contentType: part.headers.contentType,
      content: Buffer.concat(part.chunks),
    });
  };

  const consume = (chunk: Buffer): void => {
    if (done) return;
    total += chunk.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`);
    }

    const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let offset = 0;

    while (offset < buffer.length && !done) {
      if (current === null) {
        // Scaffolding between parts: skip the CRLF that follows a delimiter
        // and locate the next `--boundary`.
        const at = findDelimiter(buffer, delimiter, offset);
        if (at === -1) {
          // Keep the tail: the delimiter may still be forming, or a candidate
          // may be one that has not yet had its two trailing bytes.
          offset = Math.max(offset, buffer.length - (delimiter.length + 1));
          break;
        }
        const afterDelimiter = at + delimiter.length;
        // `--boundary--` is the closing marker.
        if (buffer[afterDelimiter] === DASH && buffer[afterDelimiter + 1] === DASH) {
          done = true;
          break;
        }
        // Headers end at the first blank line after the delimiter.
        const headerEnd = buffer.indexOf('\r\n\r\n', afterDelimiter, 'latin1');
        if (headerEnd === -1) {
          // Headers may still be arriving; keep from the delimiter onward.
          offset = at;
          break;
        }
        if (headerEnd - afterDelimiter > HEADER_MAX_BYTES) {
          throw new HttpError(400, 'MALFORMED_BODY', 'multipart part headers are too large');
        }
        startPart(parsePartHeaders(buffer.subarray(afterDelimiter, headerEnd)));
        sawFirstDelimiter = true;
        offset = headerEnd + 4;
        continue;
      }

      const closing = findDelimiter(buffer, delimiter, offset);
      if (closing === -1) {
        // Emit everything that cannot be part of a delimiter, keeping the
        // tail plus the CRLF that may precede the delimiter. The tail is
        // `delimiter.length + 1` so a lookalike whose verdict needs two more
        // bytes stays intact for the next chunk.
        const keep = delimiter.length + 1 + CRLF.length;
        const emitTo = Math.max(offset, buffer.length - keep);
        if (emitTo > offset) {
          const slice = buffer.subarray(offset, emitTo);
          current.chunks.push(slice);
          current.size += slice.length;
        }
        offset = emitTo;
        break;
      }
      // The two bytes before the delimiter are framing, not content.
      const contentEnd = Math.max(offset, closing - CRLF.length);
      if (contentEnd > offset) {
        const slice = buffer.subarray(offset, contentEnd);
        current.chunks.push(slice);
        current.size += slice.length;
      }
      if (current.size > maxFileBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `multipart file ${current.headers.name} exceeds ${maxFileBytes} bytes`);
      }
      finishPart();
      offset = closing;
    }

    carry = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0);
  };

  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    const name = error instanceof Error ? error.name : 'unknown';
    throw new HttpError(400, 'MALFORMED_BODY', `request body stream failed: ${name}`);
  }

  if (current !== null) finishPart();

  if (!sawFirstDelimiter) {
    throw new HttpError(400, 'MALFORMED_BODY', 'multipart body has no opening boundary');
  }

  return { fields, files };
}
