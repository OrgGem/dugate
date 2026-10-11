# Receipt SEC-OR-20261011-03 — encrypted source storage wiring

- **Recorded:** 2026-10-11
- **Status:** IMPLEMENTED; focused offline tests and orchestrator typecheck pass
- **Repository:** du-rework
- **Scope:** orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts and tests/sec-enc-05-boot-wiring.test.ts

## Change

- The S3 ingestion consumer now uses createS3EncryptedPinnedSourceStorage when publicUploadEncryption and the shared CryptoStorageFacade are configured. It passes the same facade, key reference, and optional key version used by the artifact encryption setup.
- Composition sets requireEncryptedSourceWrites when encryptionPolicy.dataMode is real. The consumer already fails during construction if encryption is required and the storage adapter lacks putEncrypted, so real-data mode cannot silently fall back to plaintext.
- Synthetic mode keeps the requirement off. If synthetic mode has no encryption configuration, composition retains the compatibility adapter; if encryption is configured, it uses the encrypted adapter without requiring it by policy.
- Added boot-wiring tests for real mode, synthetic mode with encryption configured, and synthetic compatibility mode without encryption configuration. Existing SEC-03 tests continue to cover the consumer capability fail-closed guard and encrypted storage behavior.

## Verification

- Command: npm run test:unit -- --runTestsByPath tests/sec-enc-05-boot-wiring.test.ts tests/sec-enc-03-source-s3-encryption.test.ts
- Result: PASS, 2 suites, 16 tests, exit 0
- Command: npm run typecheck
- Result: PASS, exit 0

All verification was offline. No live S3, Vault, or real-data ingestion was exercised. The previously plaintext source objects still require a separate inventory and remediation decision if any deployment has written data through the old adapter.

## Shared-file note

The working tree already contained separate create-app.ts changes for the LDBA03 context provider and credential-origin warning callback. I preserved those unrelated hunks and changed only the SEC-03 storage composition area.

No git add, commit, push, or gate update was performed.

