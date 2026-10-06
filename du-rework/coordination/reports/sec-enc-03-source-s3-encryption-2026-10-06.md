# SEC-ENC-03 — Encrypted source acquisition and S3 cache (SD-02) — 2026-10-06

- Task: `SEC-ENC-03` (`tasks/SEC-SENSITIVE-PERSISTENCE-2026-10-06.md`), parent SD-02
- Owner: OpenCode (oc_2); role: orchestrator source & artifact backend developer
- Status: **IMPLEMENTED + offline-verified; live S3-compatible roundtrip and independent review remain OPEN. No acceptance claim.**
- Constraints honored: no commit, no push, no production cutover; write lease respected — only the two leased source files plus one new source/ingestion test file were changed. S3 persistent bytes produced by the encrypted path are ciphertext only; no plaintext sentinel.

## 1. Requirement → implementation map

| SD-02 requirement | Implementation |
|---|---|
| HTTP URL **and** IAM-role `s3://` source acquisition stream through the canonical envelope writer before destination S3 persistence | Both legs already converge on `PinnedSourceStorage.putVerified` (the SDK ingestor streams the acquired temp file once for every source scheme). The new `createS3EncryptedPinnedSourceStorage` seals that stream with the canonical `CryptoStorageFacade` (`encrypt` ≤5 MiB / `encryptStream` >5 MiB) and persists ciphertext + manifest sidecar. The consumer wraps the storage per acquisition so the SDK path is identical for both legs (test proves both source strings). |
| Persist ciphertext + manifest/version metadata needed by the strict decrypt reader | Ciphertext object metadata: `artifactid`, `tenantid`, `du-encrypted=aes-256-gcm-v1`, `du-manifest-key=<storageKey>.crypto-manifest.json`. Manifest sidecar at `manifestKeyFor(storageKey)` with the reader-compatible single-shot projection or full authenticated chunk manifest; its immutable `VersionId` is returned as `description.manifestVersionId` and stored on the artifact row in the new `manifest_version_id` column, with `upload_token` = AAD `objectVersion`. |
| Separate plaintext business hash/length from ciphertext transfer hash/length | `putEncrypted` returns the SDK receipt with the **plaintext** hash/size (so the SDK three-measurement pin check and the row `sha256`/`size_bytes` stay business values); the ciphertext hash/size are measured independently, verified against the stored object, and carried only in the write description (not used as business identity). |
| Fail closed on checksum/encryption errors; abort/reconcile orphan object/manifest versions; READY only for a readable encrypted object | Encrypted adapter never falls back to plaintext (`putVerified` throws; wrapper and consumer construction refuse missing capability). Write order: ciphertext put → manifest put + Head + read-back hash verify → ciphertext Head + read-back hash verify; any failure deletes every version this call committed and maps to typed `SourceIngestionError` (`STORAGE_FAILURE`/`PIN_MISMATCH`/`TOO_LARGE`). The plaintext adapter additionally deletes the just-committed version when S3 checksums disagree (previously an orphan). |

## 2. Changed paths (write lease respected)

| File | SHA-256 | Change |
|---|---|---|
| `services/orchestrator/src/modules/operations/ingestion-storage-s3.ts` | `4C4F25E75AA9C0923C8DC60F6E51308B649E077FCA1B5EC71B031DE9502D3144` | New `createS3EncryptedPinnedSourceStorage` + capability/wrapper + deterministic ids; plaintext adapter unchanged except post-put orphan cleanup |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts` | `B50996733C94FAB1E488719886460E56E0D1B220E721F53D76E37F104C3EEDD0` | `requireEncryptedSourceWrites` option (construction-time fail-closed); per-acquisition envelope-context wrapper; artifact row INSERT appends `upload_token`, `manifest_version_id`; encrypted row id = AAD artifactId |
| `services/orchestrator/tests/sec-enc-03-source-s3-encryption.test.ts` (new) | `C50485B88DCB17399D8D9D2C8508627F211EB389A783AB031221C51ACA13FFAA` | 9 focused tests (single-shot, chunked, tamper cleanup, strict-reader negative, ids, plaintext guard, wrapper capture, both source legs, consumer guard) |

No file outside the lease was edited. `create-app.ts` is intentionally untouched (integrator-owned) — required composition is listed in §5.

## 3. Design notes (producer/consumer contract)

- **Canonical primitives only**: AES-256-GCM envelope with per-object random DEK, Vault-wrapped DEK, AAD = `{tenantId, artifactId, objectVersion, purpose}`, authenticated chunk manifest MAC; no custom crypto.
- **Reader parity**: the strict reader (`modules/encryption/artifact-read-decrypt.ts`, used by public download and runtime worker blob GET) pins purpose `public-artifact-upload` today. The encrypted source writer deliberately reuses `PUBLIC_UPLOAD_PURPOSE` and the same marker/manifest-key layout so source envelopes are decryptable by the **existing** reader with the row's `upload_token` + `manifest_version_id`. A per-purpose contract (e.g. `source-acquisition`) belongs to SEC-ENC-01 with migration coverage before any change; changing it silently would break every stored source envelope.
- **Deterministic identities**: `encryptedSourceArtifactId` / `encryptedSourceObjectVersion` are RFC-4122 v5 over a fixed namespace + `(tenant, operation, storageKey)`, so a re-delivery re-derives the same row id and AAD version; the encrypted path replaces the version/sha-based pin id only when encryption is enabled.
- **Bounded memory**: sources ≤ `CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES` buffer once for the single-shot envelope; larger sources keep only the read prefix and stream the remainder through the chunk generator. Caller buffers are never zeroed by the writer (only its own copies).
- **Separation of hashes**: kernel of record — row/receipt = plaintext SHA-256 + plaintext byte count; ciphertext SHA-256/length = transfer integrity, verified at write, surfaced in `EncryptedSourceWriteDescription`, never written to `artifacts.sha256`/`size_bytes`.
- **No silent plaintext**: `createS3EncryptedPinnedSourceStorage.putVerified` throws; `createEncryptedSourceStorageWrapper` throws without `putEncrypted`; `createIngestionConsumer({ requireEncryptedSourceWrites: true })` throws at construction if the adapter cannot seal.

## 4. Verification (offline; literal exits)

Environment: Windows, cwd `D:/Git/dugate/du-rework/services/orchestrator`, Jest/ts-jest, no DB/S3/Vault/network — in-memory versioned S3 store + deterministic reversible DEK provider + the REAL envelope facade and REAL strict reader.

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit **0** (0 diagnostics) |
| `npx jest tests/sec-enc-03-source-s3-encryption.test.ts --silent` | **1 suite / 9 tests passed**, exit **0** |
| `npx jest tests/sec-enc-03-… tests/url-ingestion-consumer-offline.functional.test.ts tests/url-ingestion-offline.functional.test.ts tests/url-ingestion-backend-failclosed-offline.test.ts tests/s3-source-role.test.ts tests/p730-acquire-composition.test.ts tests/p730-acquire-consumer-auth.test.ts tests/p730-acquire-ref-resolver.test.ts tests/crx01-metadata-wiring.test.ts tests/enc-meta-sentinel-outbox-source-url.test.ts tests/ba04-fix-811.test.ts tests/w1-sub03-sourceurl-extension.test.ts tests/conv13-audit-wire-single-source.test.ts --silent` | **13 suites / 137 tests passed**, exit **0** |

What the new suite proves: small and >5 MiB sources stored as ciphertext with no plaintext sentinel; strict-reader roundtrip using only the description the consumer writes to the row; tampered manifest and marker-less ciphertext refused (503 `STORAGE_FAILURE`); tampered ciphertext read-back fails `PIN_MISMATCH` and leaves zero committed versions (both keys deleted); deterministic ids; plaintext adapter unchanged and incapable of encrypted writes; wrapper captures the row description; HTTPS and `s3://` producer legs both seal; consumer refuses required encryption without capability.

Transient observation (not caused by this packet): while the worktree was being edited concurrently by the SEC-ENC-01/04 lanes, two full-project `tsc` errors (`StorageChunkAadSchema` missing from `@du/contracts`, `artifacts.ts` `Readable` type-only import) and one compile-red suite (`p730-acquire-composition`) appeared and then cleared. Final run above is green on the current tree.

## 5. Composition handoff (create-app.ts — integrator-owned, NOT edited)

To activate in production, the integrator composes the encrypted adapter at the existing pinned-source-store construction point:

1. Build `createS3EncryptedPinnedSourceStorage({ bucket, send: (command) => client.send(command as never), db, encryption: { facade: <CryptoStorageFacade over the deployment key provider>, keyRef, keyVersion? } })` when the deployment's SEC-ENC-05 real-data policy requires encryption (or a source-specific key ref is provisioned); otherwise keep `createS3PinnedSourceStorage`.
2. Pass that adapter as `IngestionConsumerOptions.storage` and set `requireEncryptedSourceWrites: true`. The consumer construction fails loudly if the two disagree.
3. No new env name is introduced by this packet; the facade/key ref source stays under the SEC-ENC-01/05 configuration decision.

## 6. Limitations / not verified

- **No live S3-compatible storage** (MinIO/AWS) roundtrip in this packet; offline proof uses an in-memory versioned store. Live capture/inspection (destination body sentinel scan + reader roundtrip) belongs to VFY-SEC-ENC-01.
- **Historical plaintext source artifacts are untouched and unread-migrated**; enabling the encrypted writer does not rewrite old bytes (SEC-ENC-06 disposition).
- **Real-data mandatory default is not enforced here**; with `requireEncryptedSourceWrites` absent the historical plaintext path stays byte-identical until SEC-ENC-05 flips the boot policy.
- Reader purpose reuse (`PUBLIC_UPLOAD_PURPOSE`) is a deliberate compatibility bridge, flagged for SEC-ENC-01 per-purpose freeze; a future purpose split needs an explicit migration contract for stored source envelopes.
- S3 multipart (>5 GiB) is not part of this leg; sources are bounded by the transfer `maxBytes` budget and stream via PutObject.
- No commit/push/cutover, no task/gate tick; independent verification and Claude review decide acceptance.
