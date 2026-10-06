import type { IncomingMessage } from 'node:http';
import { errorClassOf, HttpError } from './errors';

/**
 * Bounded ingress (FIX-CR-11). All platform request bodies flow through here:
 * declared AND streamed bytes are capped, stream errors resolve to a
 * controlled 400-class outcome inside the handler (never an unhandled
 * rejection in the HTTP listener), and binary payloads are never
 * utf8-decoded or JSON-parsed.
 *
 * Two caps: `maxJsonBytes` for JSON routes (default 1 MiB — covers the
 * largest manifest/submission fixtures with headroom) and `maxBlobBytes`
 * for the artifact blob PUT route (default 64 MiB — the largest artifact
 * the platform slice admits without object storage, per ADR-10's
 * deferred-S3 note). Blob bodies are returned raw. Oversize in either
 * class fails closed with 413 PAYLOAD_TOO_LARGE; stream errors with 400
 * MALFORMED_BODY; a missing/invalid Content-Length that contradicts the
 * stream is treated as MALFORMED_BODY only when the stream itself breaks
 * (a forged length within caps still parses — we never trust it for
 * allocation, only cap the stream).
 */

export interface IngressLimits {
  maxJsonBytes?: number;
  maxBlobBytes?: number;
}

export const DEFAULT_MAX_JSON_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024; // 64 MiB

export interface IngressBody {
  body: unknown;
  rawBody: Buffer;
}

function failTooLarge(limit: number): HttpError {
  return new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`);
}

function failMalformed(detail: string): HttpError {
  // Never echo chunk bytes — only the stream failure class.
  return new HttpError(400, 'MALFORMED_BODY', `request body stream failed: ${detail}`);
}

/**
 * Read and bound one request body. `binary=true` returns raw bytes (blob
 * route); otherwise the body is parsed as JSON (falling back to the raw
 * string, preserving the legacy contract for non-JSON payloads).
 *
 * Stream errors (abort, socket error, premature close) resolve to a 400
 * HttpError — the caller handles it through the normal problem path.
 * Overflow stops consuming the socket early: the listener destroys the
 * request so a slow oversized sender cannot pin the connection.
 */
export function readBoundedBody(
  req: IncomingMessage,
  opts: { binary: boolean; limits?: IngressLimits }
): Promise<IngressBody> {
  const limit = opts.binary
    ? (opts.limits?.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES)
    : (opts.limits?.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: HttpError): void => {
      if (settled) return;
      settled = true;
      // Do NOT destroy the socket here: the listener still owes the client
      // the problem response on res, and destroying req would take res down
      // with it (ECONNRESET instead of 413/400). We simply stop accumulating
      // — further chunks are discarded — and Node closes the connection after
      // the response since the request was never fully consumed.
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // overflow already reported: discard, do not accumulate
      total += chunk.length;
      if (total > limit) {
        fail(failTooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const rawBuffer = Buffer.concat(chunks, total);
      if (opts.binary) {
        resolve({ body: undefined, rawBody: rawBuffer });
        return;
      }
      const raw = rawBuffer.toString('utf8');
      if (!raw) {
        resolve({ body: undefined, rawBody: rawBuffer });
        return;
      }
      try {
        resolve({ body: JSON.parse(raw), rawBody: rawBuffer });
      } catch {
        resolve({ body: raw, rawBody: rawBuffer });
      }
    });
    // Aborted/erroring streams resolve INSIDE the handler (CR-11): the
    // route catch converts these to a controlled 400 problem response.
    // ADM-BASE-03: the stream-layer message may echo parser internals —
    // carry the error CLASS only, never err.message.
    req.on('error', (err: Error) => fail(failMalformed(errorClassOf(err))));
    req.on('aborted', () => fail(failMalformed('aborted by client')));
    req.on('close', () => {
      if (!settled && !req.complete) fail(failMalformed('connection closed mid-body'));
    });
  });
}
