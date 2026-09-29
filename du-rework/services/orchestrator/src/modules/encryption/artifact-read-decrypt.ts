/**
 * CR28-01: authenticated decryption on the artifact READ path.
 *
 * The public upload gateway seals every public upload (see
 * `modules/public-api/upload-encryption-gateway.ts`), so the store can hold
 * ciphertext. Until this module existed, BOTH read paths streamed the raw
 * stored bytes: the public download route served ciphertext labelled with the
 * artifact's MIME, and the worker blob route handed a worker ciphertext with
 * no error at all. This module is the missing half — it turns a sealed object
 * back into the bytes the caller was always promised.
 *
 * Fail-closed is the whole design. A missing manifest, a manifest for another
 * object, a ciphertext whose AAD does not rebuild, a wrong key, or a plaintext
 * whose digest does not match are ALL errors. None of them may degrade into
 * "serve the ciphertext anyway", because that is the exact failure this finding
 * is about: it looks like a successful read and hands the caller garbage.
 *
 * The AAD is rebuilt by the facade from the context, so the context MUST be
 * identical to the one used at encrypt time. The single source of truth for
 * that is `encryptContext` in the upload gateway:
 *   { tenantId, artifactId, objectVersion: uploadToken, purpose: 'public-artifact-upload' }
 * `PURPOSE` below is pinned to that literal; changing it silently makes every
 * existing object undecryptable, so it is asserted against the gateway rather
 * than duplicated by hand where it can drift.
 */
import { HttpError } from '../../http/errors';
import { CryptoStorageError } from './crypto-storage-facade';
import type {
  CryptoStorageContext,
  CryptoStorageFacade,
  EncryptedStorageManifest,
  EncryptedStorageObject,
} from './crypto-storage-facade';

/** Must equal the `purpose` the upload gateway encrypts with. */
export const PUBLIC_UPLOAD_PURPOSE = 'public-artifact-upload' as const;

/** Metadata the upload gateway stamps on the ciphertext object. */
export const ENCRYPTED_OBJECT_MARKER = 'du-encrypted' as const;
export const ENCRYPTED_OBJECT_MARKER_VALUE = 'aes-256-gcm-v1' as const;
export const MANIFEST_KEY_METADATA = 'du-manifest-key' as const;
const MANIFEST_KEY_SUFFIX = '.crypto-manifest.json';

/** Suffix the gateway uses for the sidecar. Mirrors `manifestKeyFor`. */
export function manifestKeyFor(storageKey: string): string {
  return storageKey + MANIFEST_KEY_SUFFIX;
}

/** Object metadata subset this module reads. */
export interface StoredObjectMetadata {
  readonly [key: string]: string | undefined;
}

/** One stored object plus the way to fetch its sidecar. */
export interface StoredObjectReader {
  /** Head of the ciphertext object; `null` when the object does not exist. */
  head(storageKey: string): Promise<StoredObjectMetadata | null>;
  /** Raw stored bytes. Only called after the caller decided to read. */
  read(storageKey: string): Promise<Buffer>;
  /** Sidecar JSON. Throwing is treated as fail-closed, not as "not encrypted". */
  readManifest(manifestKey: string): Promise<unknown>;
}

/** The row facts an envelope is bound to. */
export interface SealedArtifactRef {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly storageKey: string;
  /** `artifacts.upload_token` — the objectVersion the envelope is pinned to. */
  readonly uploadToken: string | null;
}

/** A reader that has no crypto configured at all. */
export interface ArtifactDecryptDeps {
  readonly reader: StoredObjectReader;
  /** Absent means the deployment stores plaintext; reads pass through. */
  readonly facade?: Pick<CryptoStorageFacade, 'decrypt' | 'decryptStream'>;
}

export interface DecryptOutcome {
  readonly bytes: Buffer;
  /** False when the object was not sealed and the stored bytes are the payload. */
  readonly decrypted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

/**
 * Fail closed on a crypto error. Never re-thrown as a successful read: an
 * object that cannot be authenticated is not readable, full stop.
 */
function mapCryptoError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof CryptoStorageError) {
    // AUTHENTICATION_FAILED covers a wrong key, a tampered body, and a context
    // (tenant/artifact/version) that does not match. They are deliberately
    // indistinguishable to the caller: telling them apart turns the endpoint
    // into an oracle for probing which part of the binding was wrong.
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact could not be authenticated');
  }
  fail(503, 'STORAGE_FAILURE', 'encrypted artifact could not be read');
}

function asStringArray(metadata: StoredObjectMetadata, key: string): string[] {
  const raw = metadata[key];
  if (raw === undefined) return [];
  return raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Build the decrypt context. The upload token IS the objectVersion, so a row
 * whose token is gone cannot be decrypted even with the right key — that is the
 * pinned-version fence, and it fails closed rather than guessing.
 */
function decryptContext(ref: SealedArtifactRef): CryptoStorageContext {
  if (!ref.uploadToken) {
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact has no pinned object version');
  }
  return {
    tenantId: ref.tenantId,
    artifactId: ref.artifactId,
    objectVersion: ref.uploadToken,
    purpose: PUBLIC_UPLOAD_PURPOSE,
  };
}

function parseManifest(manifest: unknown): EncryptedStorageObject | EncryptedStorageManifest {
  if (!isRecord(manifest)) {
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact manifest is not an object');
  }
  // The gateway stores the full manifest for chunked objects and a projected
  // EncryptedStorageObject for single-shot. Discriminate on the field the
  // gateway itself uses, so a new shape is a fail-closed error, not a guess.
  if ('chunks' in manifest) {
    const chunked = manifest as unknown as EncryptedStorageManifest;
    if (!Array.isArray(chunked.chunks) || chunked.chunks.length < 1) {
      fail(503, 'STORAGE_FAILURE', 'encrypted artifact chunk manifest is empty');
    }
    if (typeof chunked.manifestMac !== 'string' || chunked.manifestMac.length < 1) {
      fail(503, 'STORAGE_FAILURE', 'encrypted artifact manifest is not authenticated');
    }
    return chunked;
  }
  const single = manifest as unknown as EncryptedStorageObject;
  for (const field of ['version', 'algorithm', 'nonce', 'tag', 'aad', 'dek'] as const) {
    if (single[field] === undefined) {
      fail(503, 'STORAGE_FAILURE', `encrypted artifact manifest is missing ${field}`);
    }
  }
  return single;
}

/**
 * Decrypt one stored artifact, or return the stored bytes untouched when the
 * object is not sealed.
 *
 * `ciphertext` may be omitted to let the module read the object itself; callers
 * that already hold the bytes (the streaming routes) pass them in so the bytes
 * are fetched once.
 */
export async function decryptStoredArtifact(
  deps: ArtifactDecryptDeps,
  ref: SealedArtifactRef,
  ciphertext?: Buffer,
): Promise<DecryptOutcome> {
  const metadata = await deps.reader.head(ref.storageKey);
  if (!metadata) fail(404, 'NOT_FOUND', 'artifact object is missing from storage');

  const marker = metadata[ENCRYPTED_OBJECT_MARKER];
  if (marker !== ENCRYPTED_OBJECT_MARKER_VALUE) {
    // Not sealed. The stored bytes ARE the payload, so pass them through. This
    // is the only branch that may return ciphertext-looking bytes, and it is
    // safe because the marker says they are not ciphertext.
    const bytes = ciphertext ?? await deps.reader.read(ref.storageKey);
    return { bytes, decrypted: false };
  }

  if (!deps.facade) {
    // A sealed object with no facade would otherwise be served raw. Refuse.
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact cannot be read without a configured key');
  }

  // The object must still be the object the row claims it is. A swapped body
  // would otherwise decrypt into someone else's plaintext if the AAD matched.
  const artifactIds = asStringArray(metadata, 'artifactid');
  if (artifactIds.length > 0 && !artifactIds.includes(ref.artifactId)) {
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact identity does not match the stored object');
  }
  const tenantIds = asStringArray(metadata, 'tenantid');
  if (tenantIds.length > 0 && !tenantIds.includes(ref.tenantId)) {
    fail(403, 'PERMISSION_DENIED', 'encrypted artifact tenant does not match the stored object');
  }

  const expectedManifestKey = manifestKeyFor(ref.storageKey);
  const declared = metadata[MANIFEST_KEY_METADATA];
  if (declared !== expectedManifestKey) {
    // A manifest pointer we did not expect is either corruption or a pointer at
    // a sidecar for a different object. Either way: refuse rather than fetch.
    fail(503, 'STORAGE_FAILURE', 'encrypted artifact manifest pointer does not match the stored object');
  }

  const manifest = parseManifest(await deps.reader.readManifest(expectedManifestKey));
  const context = decryptContext(ref);
  const body = ciphertext ?? await deps.reader.read(ref.storageKey);

  try {
    if ('chunks' in manifest) {
      // Chunked objects ride the streaming decrypt; the single-shot path is the
      // one the public upload gateway uses today.
      const plaintext = await collectStream(
        deps.facade.decryptStream(toAsyncIterable(body), manifest, context),
      );
      return { bytes: plaintext, decrypted: true };
    }
    const bytes = await deps.facade.decrypt({ ...manifest, ciphertext: body }, context);
    return { bytes, decrypted: true };
  } catch (error) {
    return mapCryptoError(error);
  }
}

function toAsyncIterable(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* single() {
    yield new Uint8Array(buffer);
  })();
}

async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
