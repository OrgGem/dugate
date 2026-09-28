
// ---------------------------------------------------------------------------
// StorageEnvelopeRef - ciphertext-at-rest envelope carried by a storage grant
// ---------------------------------------------------------------------------

/**
 * W-ENC-04-GRANT-SCHEMA (delta 57 item 1): the DEK shape the ENC-03 storage
 * facade actually produces and stores.
 *
 * This is deliberately NOT `WrappedDekEnvelopeSchema` above, and that is a
 * load-bearing difference rather than a duplicate. Two DEK shapes exist:
 *   - `WrappedDekEnvelopeSchema` = { keyId, wrappedKey, nonce, tag }  (ADR-18
 *     delivery/wrap envelope, recipient-facing).
 *   - this one                      = { keyRef, keyVersion, ciphertext }
 *     (what `EncryptedStorageObject.dek` holds on the storage path).
 * The runtime source of truth is `vault-transit-provider.WrappedDek`
 * (`keyRef`/`keyVersion`/`ciphertext`). Reusing the ADR-18 shape here would
 * produce a contract the storage facade cannot satisfy, and every real
 * object would fail for the wrong reason.
 */
export const StorageWrappedDekSchema = z.object({
  /** Vault Transit key name, e.g. "du-artifact-v1". */
  keyRef: z.string().min(1).max(256),
  /** Transit key version the DEK was wrapped under. Required, not optional: a
   *  reader that guessed "latest" could unwrap under a rotated key and then
   *  fail authentication for the wrong reason. */
  keyVersion: z.number().int().min(1),
  /** base64 Vault Transit ciphertext of the 32-byte DEK. */
  ciphertext: z.string().regex(BASE64_RE, "DEK ciphertext must be valid base64"),
}).strict();
export type StorageWrappedDek = z.infer<typeof StorageWrappedDekSchema>;

/**
 * Everything a worker needs to decrypt one stored object, MINUS the ciphertext
 * itself: the bytes arrive through the grant's `downloadUrl`, so this is a
 * REFERENCE to a ciphertext, not a copy. That is why `ciphertext` is absent
 * here while the in-process `EncryptedStorageObject` carries it as a Buffer.
 *
 * Field-for-field this mirrors `EncryptedStorageObject` in
 * `crypto-storage-facade.ts` and worker-sdk `crypto-storage.ts`.
 */
export const StorageEnvelopeRefSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  /** base64, exactly 12 bytes decoded (GCM nonce). */
  nonce: z.string().regex(BASE64_RE, "nonce must be valid base64"),
  /** base64, exactly 16 bytes decoded (GCM auth tag). */
  tag: z.string().regex(BASE64_RE, "tag must be valid base64"),
  /** base64 of the AAD JSON the facade authenticated. */
  aad: z.string().regex(BASE64_RE, "aad must be valid base64"),
  /** PLAINTEXT size. Distinct from the grant `sizeBytes`, which is what storage committed. */
  plaintextSizeBytes: z.number().int().min(0),
  /** SHA-256 hex over the plaintext, so a reader can verify after decryption. */
  plaintextSha256: z.string().regex(SHA256_HEX_RE, "plaintextSha256 must be 64-char lowercase hex"),
  dek: StorageWrappedDekSchema,
}).strict()
  // Byte lengths are enforced here rather than trusted from the regex: a
  // 13-byte nonce parses as base64 but cannot be an AES-GCM nonce, and would
  // otherwise fail deep inside the cipher with a misleading error.
  .refine((e) => Buffer.from(e.nonce, "base64").byteLength === GCM_NONCE_BYTES, {
    message: `nonce must decode to exactly ${GCM_NONCE_BYTES} bytes`,
    path: ["nonce"],
  })
  .refine((e) => Buffer.from(e.tag, "base64").byteLength === GCM_TAG_BYTES, {
    message: `tag must decode to exactly ${GCM_TAG_BYTES} bytes`,
    path: ["tag"],
  });
export type StorageEnvelopeRef = z.infer<typeof StorageEnvelopeRefSchema>;
