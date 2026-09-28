  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /**
   * W-ENC-04-GRANT-SCHEMA (delta 57 item 1): present only when the object at
   * `downloadUrl` is CIPHERTEXT. Absent means the bytes are plaintext and must
   * be used as-is.
   *
   * This is what makes the seam reversible. Without it a sealed object is
   * write-only: the worker receives the nonce/tag/AAD/DEK nowhere, so the
   * stored bytes cannot be opened by anyone (see the round-trip proof in
   * worker-sdk `enc-read-roundtrip-proof.test.ts`).
   *
   * `sizeBytes` above stays what STORAGE committed (ciphertext). The plaintext
   * length and digest live here, so a reader can verify after decrypting rather
   * than trusting the ciphertext digest as if it described the document.
   */
  encryption: StorageEnvelopeRefSchema.optional(),
});