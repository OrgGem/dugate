import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ArtifactPurpose,
  MultipartAbortRequest,
  MultipartCompleteRequest,
  MultipartInitAck,
  MultipartInitRequest,
  MultipartPartGrantRequest,
  MultipartPartReceipt,
} from '@du/contracts';
import {
  ARTIFACT_UPLOAD_WIRE_MAX_BYTES,
  ArtifactStreamError,
  assertHttpUrl,
  createRequestScope,
  readErrorDetail,
  streamTransportError,
  toNodeReadable,
} from './artifact-streams';
import type { SdkFetcher } from './fan-out';

/**
 * DATA-04 Step C: client-driven multipart upload engine (W49-Q4-2 §7.3).
 *
 * Consumes the DATA-00-M wire contract (@du/contracts runtime.ts) exactly as
 * the Orchestrator serves it (services/orchestrator/src/server.ts multipart
 * routes, lane Qwen-5/W49-Q5-1). Lifecycle transport is injected so this
 * module stays pure: no RuntimeClient, no DB, no storage SDK — tests drive
 * it with a fake transport + fake fetcher, fully offline.
 *
 * Memory invariant: bytes flow source -> one part buffer at a time -> PUT.
 * Peak buffering is ONE server-granted part (bounded by maxPartBytes, which
 * refuses a hostile geometry before any part is read). Whole-object and
 * per-part sha256 are computed in the same pass; nothing is re-read.
 *
 * Size band: this lifecycle serves the `multipart` band only (> 64 MiB, the
 * DATA-00-M contract floor). The 1 MiB - 64 MiB band is a single binary
 * request, not a multipart session - see `resolveArtifactUploadBand` in
 * artifact-streams.ts (DATA-04, Reviewer finding T20-D1).
 *
 * Failure discipline:
 * - part PUTs retry up to partPutAttempts (re-grant + re-PUT; grant rows
   are idempotent per partNumber on the server). Retryable: transport
   errors, missing etag, and 403/404/408/429/5xx responses.
 * - any failure before complete aborts the session best-effort (a failed
   abort never masks the original error; the TTL sweeper owns leftovers).
 * - errors AFTER complete never abort: the bytes are already committed
   server-side, only the ack is suspect.
 * - lifecycle (grant/complete/abort) errors propagate untouched — lease
   fencing stays RuntimeError/LeaseLostError shaped for the facade.
 * - presigned part URLs never enter error messages (ADM-BASE-03: only the
   sanitized readErrorDetail output travels).
 * - v1 has no cross-process resume (§11.3 decision): a killed upload starts
   over with a fresh uploadToken; the abandoned session expires to the
   sweeper.
 */

/** SDK-side ceiling for ONE buffered part; refuses init geometry above it. */
export const MULTIPART_SDK_MAX_PART_BYTES = 64 * 1024 * 1024;

export type MultipartInitBody = Omit<MultipartInitRequest, 'leaseEpoch'>;
export type MultipartPartGrantBody = Omit<MultipartPartGrantRequest, 'leaseEpoch'>;
export type MultipartCompleteBody = Omit<MultipartCompleteRequest, 'leaseEpoch'>;
export type MultipartAbortBody = Omit<MultipartAbortRequest, 'leaseEpoch'>;

/** The four lifecycle calls of the DATA-00-M contract. leaseEpoch is owned
 * by the transport adapter (the facade fences it), not by this engine. */
export interface MultipartUploadTransport {
  init(body: MultipartInitBody): Promise<MultipartInitAck>;
  partGrant(artifactId: string, body: MultipartPartGrantBody): Promise<import('@du/contracts').MultipartPartGrant>;
  complete(artifactId: string, body: MultipartCompleteBody): Promise<import('@du/contracts').MultipartCompleteAck>;
  abort(artifactId: string, body: MultipartAbortBody): Promise<import('@du/contracts').MultipartAbortAck>;
}

export interface MultipartUploadOptions {
  transport: MultipartUploadTransport;
  fileName: string;
  mimeType: string;
  /** Declared total byte count; the stream MUST produce exactly this many. */
  sizeBytes: number;
  purpose?: ArtifactPurpose;
  /** When set, checked against the streamed whole-object digest. */
  expectedSha256?: string;
  signal?: AbortSignal;
  fetcher?: SdkFetcher;
  /** Attempts per part including the first (re-grant + re-PUT). Default 3. */
  partPutAttempts?: number;
  /** Backoff base; attempt n sleeps n * base ms. Default 50. */
  retryBaseDelayMs?: number;
  /** Per-part PUT request timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Memory cap for one buffered part. Default 64 MiB. */
  maxPartBytes?: number;
}

export interface MultipartUploadResult {
  artifactId: string;
  sizeBytes: number;
  sha256: string;
  partCount: number;
}

function retryablePutStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

function abortError(): ArtifactStreamError {
  return new ArtifactStreamError(0, 'TRANSPORT_FAILURE', 'multipart upload aborted');
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The server fixes the geometry at init; refuse anything the SDK cannot
 * buffer safely or that disagrees with the declared size. */
function assertInitGeometry(ack: MultipartInitAck, sizeBytes: number, maxPartBytes: number): void {
  if (!Number.isSafeInteger(ack.partSizeBytes) || ack.partSizeBytes < 1) {
    throw new ArtifactStreamError(
      409,
      'SIZE_MISMATCH',
      'multipart init ack carries an unusable partSizeBytes'
    );
  }
  if (ack.partSizeBytes > maxPartBytes) {
    throw new ArtifactStreamError(
      413,
      'TOO_LARGE',
      'server part size ' + ack.partSizeBytes + ' exceeds the SDK single-part memory cap ' + maxPartBytes
    );
  }
  const expectedParts = Math.ceil(sizeBytes / ack.partSizeBytes);
  if (!Number.isSafeInteger(ack.partCount) || ack.partCount < 1 || ack.partCount !== expectedParts) {
    throw new ArtifactStreamError(
      409,
      'SIZE_MISMATCH',
      'init ack partCount ' + ack.partCount + ' disagrees with the upload geometry (' + expectedParts + ')'
    );
  }
}

export async function uploadArtifactMultipart(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
  options: MultipartUploadOptions
): Promise<MultipartUploadResult> {
  const { transport } = options;
  const sizeBytes = options.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new ArtifactStreamError(422, 'SIZE_MISMATCH', 'multipart upload requires a positive declared size');
  }
  if (sizeBytes > ARTIFACT_UPLOAD_WIRE_MAX_BYTES) {
    throw new ArtifactStreamError(413, 'TOO_LARGE', 'declared artifact size exceeds the upload wire ceiling');
  }
  // The contract FLOOR is deliberately not enforced here: this engine is a
  // geometry engine (its unit suite drives sub-MiB geometries) and the floor
  // is owned by the DATA-00-M server schema plus the facade routing layer.
  if (options.signal?.aborted) throw abortError();
  const maxPartBytes = options.maxPartBytes ?? MULTIPART_SDK_MAX_PART_BYTES;
  const attempts = Math.max(1, Math.trunc(options.partPutAttempts ?? 3));
  const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 50);
  const partTimeoutMs = options.timeoutMs ?? 60_000;
  const fetcher = options.fetcher ?? globalThis.fetch;

  const ack = await transport.init({
    uploadToken: randomUUID(),
    purpose: options.purpose ?? 'output',
    mimeType: options.mimeType,
    fileName: options.fileName,
    sizeBytes,
  });
  const artifactId = ack.artifactId;
  let sessionClosed = false;
  const abortSession = async (): Promise<void> => {
    if (sessionClosed) return;
    sessionClosed = true;
    try {
      await transport.abort(artifactId, { reason: options.signal?.aborted ? 'cancelled' : 'failed' });
    } catch {
      // Best-effort: the server fences a stale lease and the TTL sweeper owns
      // leftovers. An abort failure must never mask the original error.
    }
  };

  const wholeHash = createHash('sha256');
  const receipts: MultipartPartReceipt[] = [];
  let streamedSha256 = '';

  try {
    assertInitGeometry(ack, sizeBytes, maxPartBytes);
    const partSizeBytes = ack.partSizeBytes;
    const partCount = ack.partCount;

    const putPart = async (chunks: Buffer[], expectedSize: number, partSha256: string): Promise<void> => {
      const partNumber = receipts.length + 1;
      if (partNumber > partCount) {
        throw new ArtifactStreamError(
          422,
          'SIZE_MISMATCH',
          'source produced more than the ' + partCount + ' parts fixed by the upload geometry'
        );
      }
      let lastError: ArtifactStreamError | null = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (attempt > 1) await sleepMs(retryBaseDelayMs * attempt, options.signal);
        try {
          const grant = await transport.partGrant(artifactId, { partNumber, sha256: partSha256 });
          if (grant.sizeBytes !== expectedSize) {
            throw new ArtifactStreamError(
              409,
              'SIZE_MISMATCH',
              'part ' + partNumber + ' grant size ' + grant.sizeBytes + ' disagrees with the upload geometry (' + expectedSize + ')'
            );
          }
          assertHttpUrl(grant.partUrl);
          const body = Buffer.concat(chunks, expectedSize);
          const scope = createRequestScope(options.signal, partTimeoutMs);
          let response: Response;
          try {
            response = await fetcher(grant.partUrl, {
              method: 'PUT',
              headers: { ...grant.requiredHeaders },
              body,
              signal: scope.signal,
            });
          } catch (err) {
            lastError = streamTransportError(scope, err, 'multipart part ' + partNumber + ' upload');
            continue;
          } finally {
            scope.dispose();
          }
          if (!response.ok) {
            const detail = await readErrorDetail(response);
            throw new ArtifactStreamError(
              response.status,
              'DOWNLOAD_REJECTED',
              'part ' + partNumber + ' PUT rejected (HTTP ' + response.status + '): ' + detail
            );
          }
          const etag = response.headers.get('etag');
          if (!etag) {
            lastError = new ArtifactStreamError(502, 'EMPTY_BODY', 'part ' + partNumber + ' upload response carried no etag');
            continue;
          }
          receipts.push({ partNumber, etag, sizeBytes: expectedSize, sha256: partSha256 });
          return;
        } catch (err) {
          if (err instanceof ArtifactStreamError) {
            if (!retryablePutStatus(err.status) || attempt === attempts) throw err;
            lastError = err;
            continue;
          }
          throw err; // lifecycle/lease transport errors are final for this upload
        }
      }
      throw lastError ?? new ArtifactStreamError(0, 'TRANSPORT_FAILURE', 'part ' + partNumber + ' upload failed');
    };

    const source = toNodeReadable(input);
    const onAbort = () => {
      source.destroy(new ArtifactStreamError(0, 'TRANSPORT_FAILURE', 'multipart upload aborted by caller'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let partChunks: Buffer[] = [];
      let partBytes = 0;
      let partHash = createHash('sha256');
      let totalBytes = 0;
      for await (const raw of source) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        if (chunk.length === 0) continue;
        if (totalBytes + chunk.length > sizeBytes) {
          throw new ArtifactStreamError(
            422,
            'SIZE_MISMATCH',
            'source produced more than the declared ' + sizeBytes + ' bytes'
          );
        }
        totalBytes += chunk.length;
        wholeHash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(partSizeBytes - partBytes, chunk.length - offset);
          const slice = chunk.subarray(offset, offset + take);
          partChunks.push(slice);
          partBytes += take;
          partHash.update(slice);
          offset += take;
          if (partBytes === partSizeBytes) {
            await putPart(partChunks, partBytes, partHash.digest('hex'));
            partChunks = [];
            partBytes = 0;
            partHash = createHash('sha256');
          }
        }
      }
      if (partBytes > 0) {
        await putPart(partChunks, partBytes, partHash.digest('hex'));
      }
      if (totalBytes !== sizeBytes) {
        throw new ArtifactStreamError(
          422,
          'SIZE_MISMATCH',
          'source produced ' + totalBytes + ' bytes, declared ' + sizeBytes
        );
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (!source.destroyed) source.destroy();
    }

    streamedSha256 = wholeHash.digest('hex');
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== streamedSha256) {
      throw new ArtifactStreamError(
        422,
        'HASH_MISMATCH',
        'streamed sha256 ' + streamedSha256 + ' != expected ' + options.expectedSha256
      );
    }
  } catch (err) {
    await abortSession();
    throw err;
  }

  const completeAck = await transport.complete(artifactId, { parts: receipts, sha256: streamedSha256 });
  // The whole object was committed server-side under these exact bytes; an
  // ack that disagrees is a server/transport fault — never abort here, the
  // row stays reconcile-able (finalize gate) and cleanup is the sweeper's.
  if (completeAck.sha256 !== streamedSha256) {
    throw new ArtifactStreamError(409, 'HASH_MISMATCH', 'multipart complete ack hash disagrees with the uploaded bytes');
  }
  if (completeAck.sizeBytes !== sizeBytes) {
    throw new ArtifactStreamError(409, 'SIZE_MISMATCH', 'multipart complete ack size disagrees with the uploaded bytes');
  }
  return { artifactId, sizeBytes, sha256: streamedSha256, partCount: receipts.length };
}
