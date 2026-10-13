/**
 * SEC-ENC-04 (SD-03): artifact storage-policy surface shared by the worker
 * artifact transport.
 *
 * Persistence encryption is enforced by the Orchestrator at admission and
 * finalize — not by a worker flag — so the SDK's job here is narrow: recognize
 * the server's policy refusals and surface them as stable, NON-retryable
 * failures. A policy refusal that looks like a transient 5xx would otherwise
 * be retried by a part-upload loop against a server that will keep refusing.
 */

export const ARTIFACT_STORAGE_POLICY_CODES = {
  /**
   * The server refuses client-driven worker multipart uploads while artifact
   * encryption is required (presigned parts would bypass server-side sealing).
   */
  encryptedMultipartUnavailable: 'ENCRYPTED_MULTIPART_UNAVAILABLE',
  /** The server refused a write because the sealing seam/policy was absent. */
  encryptionRequired: 'ENCRYPTION_REQUIRED',
  /** The server refused to read an artifact that is not correctly sealed. */
  envelopeInvalid: 'ENVELOPE_INVALID',
} as const;

export type ArtifactStoragePolicyCode =
  (typeof ARTIFACT_STORAGE_POLICY_CODES)[keyof typeof ARTIFACT_STORAGE_POLICY_CODES];

const POLICY_CODES: ReadonlySet<string> = new Set(Object.values(ARTIFACT_STORAGE_POLICY_CODES));

/** True when a server machine code is a storage-policy refusal. */
export function isArtifactStoragePolicyCode(value: unknown): value is ArtifactStoragePolicyCode {
  return typeof value === 'string' && POLICY_CODES.has(value);
}
