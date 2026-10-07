/**
 * CONV-02: the bounded stream read shared by the S3 stored-object reader
 * (server.ts) and the public encrypted-delivery download (public.ts), moved
 * verbatim out of server.ts. The byte ceiling fails closed with 413.
 */
import { Readable } from 'node:stream';
import { HttpError } from '../errors';

export const MAX_DECRYPT_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export async function readStreamBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > maxBytes) {
        throw new HttpError(413, 'TOO_LARGE', 'artifact exceeds the encrypted delivery size limit');
      }
      chunks.push(buf);
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  return Buffer.concat(chunks);
}
