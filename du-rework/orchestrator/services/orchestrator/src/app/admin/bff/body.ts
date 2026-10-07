/** Bounded request-body reader for the BFF JSON endpoints (AWEB-02). */
import type { IncomingMessage } from 'node:http';

/** Mutations are small JSON documents; 64 KiB is generous and fixed. */
export const BFF_MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads the raw body up to `max` bytes.
 * Resolves `null` when the cap is exceeded (the caller answers 413 and the
 * socket is drained, never destroyed mid-request).
 */
export function readBoundedBody(
  req: IncomingMessage,
  max: number = BFF_MAX_BODY_BYTES,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overflow = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => resolve(overflow ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
