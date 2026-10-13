/**
 * W-ENC-04-SEAM: the task-facing side of the worker encryption seam.
 *
 * `crypto-storage.ts` is the ported facade (shape identical to the
 * orchestrator ENC-03 build, so both sides read each other ciphertext).
 * This module is the thin, task-shaped wrapper: it binds the facade to the
 * ONE identity a task is allowed to write under - the tenant the server
 * asserted at claim time - so a business handler cannot encrypt an artifact
 * under a tenant it does not own by passing a different id.
 *
 * Why the binding lives here instead of in the handler: the tenant id is a
 * server-asserted claim field. If the handler supplied it, every call site
 * would be one typo away from writing ciphertext under the wrong tenant, and
 * the AAD would faithfully bind the WRONG tenant - authenticated, and
 * unreadable by the real owner. Binding once, at claim, removes that class of
 * bug instead of documenting it.
 */

import {
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  CryptoStorageFacade,
  type CryptoStorageContext,
  type EncryptedStorageManifest,
  type EncryptedStorageObject,
} from './crypto-storage';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * What a deployment injects into a worker: the facade plus the allowlisted
 * key reference its workers are permitted to use. Both are required, so a
 * half-configured deployment cannot encrypt with a guessed key.
 */
export interface WorkerCryptoSeam {
  readonly facade: CryptoStorageFacade;
  /** Must be an allowlisted reference; the provider rejects anything else. */
  readonly keyRef: string;
  /** Pin this worker to a Transit key version; omitted uses the latest. */
  readonly keyVersion?: number;
}

/** The identity a sealed artifact is bound to, plus the caller overrides. */
export interface TaskArtifactBinding {
  /** Server-assigned artifact id; part of the AAD. */
  readonly artifactId: string;
  /**
   * Immutable version this ciphertext belongs to. Defaults to the artifactId:
   * one artifact is one immutable object on the storage side.
   */
  readonly objectVersion?: string;
  /** Storage purpose label carried in the AAD, e.g. output/intermediate. */
  readonly purpose?: string;
}

/** Sealed bytes plus the manifest needed to read them back. */
export interface SealedArtifact {
  readonly encrypted: EncryptedStorageObject;
  /** Present only for chunked (stream) encryption. */
  readonly manifest?: EncryptedStorageManifest;
  /** Size and digest of the CIPHERTEXT, which is what storage records. */
  readonly ciphertextSizeBytes: number;
  readonly ciphertextSha256: string;
}

/**
 * The per-task handle. Every method already carries the claim tenant, so a
 * handler can only choose the artifact and the version.
 */
export interface TaskArtifactCrypto {
  readonly tenantId: string;
  /** Seal bytes for durable storage (single-shot, at most 5 MiB). */
  seal(plaintext: Uint8Array, binding: TaskArtifactBinding): Promise<SealedArtifact>;
  /** Open bytes previously sealed for this artifact. */
  open(sealed: SealedArtifact, binding: TaskArtifactBinding): Promise<Buffer>;
  /** Seal a large async source as authenticated 4 MiB chunks. */
  sealStream(
    source: AsyncIterable<Uint8Array>,
    binding: TaskArtifactBinding,
  ): { ciphertext: Readable; manifest: Promise<EncryptedStorageManifest> };
  /** Open a chunked object, verifying the manifest before any plaintext. */
  openStream(
    ciphertext: AsyncIterable<Uint8Array>,
    manifest: EncryptedStorageManifest,
    binding: TaskArtifactBinding,
  ): Readable;
}

function storageContext(
  tenantId: string,
  binding: TaskArtifactBinding,
): CryptoStorageContext {
  return {
    tenantId,
    artifactId: binding.artifactId,
    objectVersion: binding.objectVersion ?? binding.artifactId,
    ...(binding.purpose === undefined ? {} : { purpose: binding.purpose }),
  };
}

function assertSeam(seam: WorkerCryptoSeam | undefined): WorkerCryptoSeam {
  if (!seam) {
    throw new Error(
      'artifact encryption is not configured for this worker; refusing to write plaintext bytes',
    );
  }
  return seam;
}

/**
 * Bind the seam to one claimed task. The returned handle is the ONLY way a
 * handler reaches the facade, which keeps the tenant binding in one place.
 */
export function bindTaskCrypto(
  seam: WorkerCryptoSeam | undefined,
  task: { tenantId: string },
): TaskArtifactCrypto {
  const assertSeamFn = (): WorkerCryptoSeam => assertSeam(seam);
  return {
    tenantId: task.tenantId,
    async seal(plaintext, binding) {
      const active = assertSeamFn();
      const context = storageContext(task.tenantId, binding);
      const encrypted = await active.facade.encrypt(plaintext, {
        ...context,
        keyRef: active.keyRef,
        ...(active.keyVersion === undefined ? {} : { keyVersion: active.keyVersion }),
      });
      return {
        encrypted,
        ciphertextSizeBytes: encrypted.ciphertext.byteLength,
        ciphertextSha256: createHash(SHA256_ALGO).update(encrypted.ciphertext).digest(HASH_HEX),
      };
    },
    async open(sealed, binding) {
      const active = assertSeamFn();
      return active.facade.decrypt(sealed.encrypted, storageContext(task.tenantId, binding));
    },
    sealStream(source, binding) {
      const active = assertSeamFn();
      const context = storageContext(task.tenantId, binding);
      return active.facade.encryptStream(source, {
        ...context,
        keyRef: active.keyRef,
        ...(active.keyVersion === undefined ? {} : { keyVersion: active.keyVersion }),
      });
    },
    openStream(ciphertext, manifest, binding) {
      const active = assertSeamFn();
      return active.facade.decryptStream(ciphertext, manifest, storageContext(task.tenantId, binding));
    },
  };
}

const SHA256_ALGO = 'sha256';
const HASH_HEX = 'hex';

/** The single-shot ceiling, re-exported so callers size their fixtures. */
export { CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES };