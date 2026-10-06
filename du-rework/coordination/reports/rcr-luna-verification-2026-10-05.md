# RCR Luna independent verification — 2026-10-05

Status: **Offline candidate regression packet passed. This is an independent test result, not an ACCEPTED or release verdict.**

## Candidate run

- CWD: D:\Git\dugate\du-rework\services\orchestrator
- HEAD: b088eececcb5f3df0b4edbe073a29401dafda624; checkout was already dirty.
- Jest command: pnpm exec jest --runInBand --runTestsByPath tests/rcr-http-offline.functional.test.ts tests/rcr-luna-http-encryption.test.ts tests/rcr-luna-verification.test.ts tests/rv01-loopback-http-offline.test.ts tests/runtime-lease-fencing-offline.test.ts tests/runtime-encryption-metadata.test.ts tests/migrations-ledger-guard.test.ts
- Jest result: exit 0; 7 suites passed, 229 tests passed, 0 skipped, 0 snapshots; 6.366 seconds.
- Raw output: [rcr-luna-verification-candidate-2026-10-05.raw.txt](rcr-luna-verification-candidate-2026-10-05.raw.txt), SHA-256 337dabaa478cd51f049c3da80afec496b2411f2eb8d126fbdfa3670e2b1851f3.
- TypeScript command: pnpm exec tsc --noEmit -p tsconfig.json
- TypeScript result: exit 0, no output. Empty capture: [rcr-luna-verification-candidate-tsc-2026-10-05.raw.txt](rcr-luna-verification-candidate-tsc-2026-10-05.raw.txt), SHA-256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
- Jest printed its open-handle warning after completion; the process exited normally with code 0. The run did not use forceExit.
- Tests use loopback HTTP and scripted/offline database, storage, and encryption fakes. No PostgreSQL, Redis, S3, Vault, AI provider, credentials, or production service was used.

## Coverage observed

- RCR-01: malformed Host receives a controlled response and a later healthy loopback request remains serviceable.
- RCR-02: expired-at-entry spawn/wait and stale-epoch or wrong-business-identity writes are rejected without writes; expiry at the final transaction fence rolls back tentative writes; a durable identical spawn replay still succeeds after expiry.
- RCR-03: a matching idempotency replay returns before current admission reads; changed request conflicts, with authenticated and scoped lookup behavior covered by the HTTP regression suite.
- RCR-04: omitted checkpoint status persists as SUCCEEDED; invalid status and malformed required fields return validation errors before SQL writes.
- RCR-05: save-to-claim preserves sessionRef using the dedicated encrypted metadata slot and full task/step/generation AAD. Multi-generation claims return newest generation first; the fake database sorts only when production SQL requests descending generation. Null/omitted compatibility is covered.
- RCR-06: the legacy mount and public adapter preserve raw binary/non-ASCII bytes, byte length, and hash; delivery-encryption success and fail-closed behavior are covered by the HTTP encryption regression.

The focused run also included lease-fencing, metadata inventory/crypto, loopback raw-wire, and migration-ledger guard suites. The stale metadata inventory assertions in runtime-encryption-metadata.test.ts were refreshed to reflect the declared current slots, including session_ref; crypto negative assertions were left intact.

## Candidate fingerprints

These post-run SHA-256 values match the frozen candidate fingerprints confirmed by the coordinator for runtime.ts, runtime routes, metadata crypto, migration 0032, and public routes. Source files were not edited by this verifier.

- src/app/bootstrap/create-app.ts: ca24177afff0b3207c9361f189617d352faf53a88247eeef3e93db758a6ad83a
- src/modules/runtime/runtime.ts: acb476fd3079e6f3fdbf4b81bb54f5fe0b5b2f07679bb72ab47c73664bc09138
- src/http/routes/runtime.ts: 8a4209f370b4bedca8c24c52ac5d1b08f7d5d59ee9ac72184f7c53d3a9ca5602
- src/modules/runtime/metadata-crypto.ts: c614ecdcfda50eac79a29eac2098b92cb3bba77280d90ddec6f3a815a4a602a1
- src/modules/operations/submission.ts: 8f7da67223b02fc87c00ee75bd7464ace089dee95a6b1922880203435725725
- src/http/routes/public.ts: 422db30e924db063c30405b26be73ccc867ce4e4deede8e344b411a169cbb057c
- src/compat/legacy-http-mount.ts: 4aeff966cc382d982dbfcceac4bc6dffe77ee9c4f7964dc4b2f36937c93940fd
- migrations/0032_checkpoint_session_ref.sql: 69a9cc6bea5df9a999546abb98a43ee1a1a0c3835be5d7e8c6aee72788e55e
- packages/contracts/src/runtime.ts: 66656bd6cadfc79fa45bc2f91f089cbc94c4df6f29b6429045abe038a4fca53c
- tests/rcr-http-offline.functional.test.ts: 0a3c435f94706b9e973d27989d306bf68c72a8a48c937d65a1c1934d2ad2943f
- tests/rcr-luna-http-encryption.test.ts: 1ad7eecd222368209f2d667a8bcbb3caf0c1ad48128023fb525d822bc33eff758
- tests/rcr-luna-verification.test.ts: c7b62aaeb4ff2fe1d131cf22c8858950ce35ed379aa3d278d4983c481daa8b28
- tests/rv01-loopback-http-offline.test.ts: dfa64008a9d96686163224d8000e2e4f78239b7c168be923770b492f7053ebc4
- tests/runtime-encryption-metadata.test.ts: 2a17e534c0ac8cc7e97fde93fc64ef5e4f3b7f864569019c3fabf4c468a5d578
- tests/runtime-lease-fencing-offline.test.ts: 5cd40ad6a3a994a6558a90e2d32e8907d407b28b93ea8c3dc8b354ad1b66a3d
- tests/migrations-ledger-guard.test.ts: a5f3b7bfb61be7916a36391dcf988e66559e0e13f2d5e51e9bf24756a9d3af21

## Historical baseline reproduction

The earlier baseline run used HEAD b088eececcb5f3df0b4edbe073a29401dafda624 and the then-current runtime source hash 01ffff43cfd528e029c5d5107c63d92f686e5191175de3c22852f3fdd0d7d377. Command: pnpm exec jest --runInBand --runTestsByPath tests/rcr-http-offline.functional.test.ts tests/rcr-luna-verification.test.ts. It exited 1 with 1 suite passed and 1 failed; 8 tests passed and 8 failed. Runtime failures reproduced expired-lease writes, missing business-identity fencing and transaction rollback, omitted-status persistence, and missing sessionRef save/claim behavior. The HTTP suite passed. Historical raw: [rcr-luna-verification-baseline-2026-10-05.raw.txt](rcr-luna-verification-baseline-2026-10-05.raw.txt), SHA-256 83eb59178b3394684c60e4a90d7d5534bedb0bf18410cdee5d69bb3e54346679.

This receipt records offline regression evidence only. It does not certify live PostgreSQL migration execution, external-service integration, production readiness, or release acceptance.
