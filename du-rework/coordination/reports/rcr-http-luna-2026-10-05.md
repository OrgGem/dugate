# RCR HTTP implementation review — Luna — 2026-10-05

Scope: read-only review of the RCR-01/03/06 implementation shared by the HTTP owner, plus Luna's leased RCR-06 delivery-policy handoff in `services/orchestrator/src/http/routes/public.ts` and the isolated `rcr-luna-http-encryption.test.ts` suite. No live database, Redis, object store, Vault, or provider was used.

## Before and after

At the initial review, all three findings were present: the async listener could reject outside a catch; submission did admission/configuration reads before idempotency lookup; and the legacy download discarded bytes as `{}`. The HTTP owner subsequently landed fixes for those defects.

The listener now attaches a rejection handler to the full async callback and parses the URL against configured `publicBaseUrl` or localhost. Submission now performs its scoped, unexpired idempotency lookup after structural schema parsing and request hashing, before artifact readiness, active-version, profile, and action-schema admission. The legacy mount now returns raw bytes and the public adapter forwards them.

Luna's scoped follow-up applies the authenticated tenant's delivery policy before forwarding those bytes. It captures the tenant from the legacy route's existing principal resolution, resolves policy once, reuses the existing encrypted-delivery helper with that snapshot, strips binary headers from the encrypted JSON response, caps encrypted output at `maxBlobBytes`, and maps policy lookup/encryption failures to 503. Plain raw output remains byte-for-byte when policy is disabled. The route does not perform another API-key lookup.

## Review caveats outside the six reported blockers

- **RCR-01:** The reported process-crash path is closed. The listener uses a configured URL base and catches the entire callback. `Host` is no longer part of URL parsing, so a syntactically odd Host can reach the ordinary route result; the raw Host test accepts a controlled 4xx and verifies the next request still runs. The malformed request-target case separately asserts 400. No Host-validation expansion is required for this finding.
- **RCR-03:** `findSubmissionKey` filters tenant, API key, route action, key, and unexpired window, and HTTP submission authenticates before service lookup. The later `loadOperationView(db, operation_id)` query uses only `WHERE id=$1`; adding tenant verification there is defense-in-depth if inconsistent key rows are a concern, not evidence that the scoped replay lookup currently bypasses tenant scope.
- **RCR-06:** Raw bytes and tenant delivery policy are covered. `docs/39-legacy-parity-contract.md:191-207` also specifies `Content-Disposition` for inline downloads; the current mount still omits it. This is an adjacent documented parity detail outside RCR-06's reported byte/MIME/length defect.

These caveats are not blockers to the six review findings addressed by the HTTP owner.

## Luna-owned change and regression cases

`public.ts` uses the tenant captured by the legacy download's successful `resolvePrincipal`, then returns an encrypted JSON envelope when policy is enabled. The envelope response does not inherit plaintext `Content-Type` or `Content-Length`. Missing authorization or a foreign-tenant operation cannot reach output delivery; an unavailable policy or recipient key fails closed. Oversized encrypted output returns 413 without falling back to plaintext. With policy disabled, the original bytes and headers are preserved.

The isolated test file covers enabled policy and header removal, recipient-key failure, policy-resolution failure, disabled-policy raw output, foreign-tenant denial, denied API key privacy, and the encrypted-size limit. The denied-key test preserves the legacy facade's existing error status and asserts that output bytes and policy are never read.

## Verification

Cwd: `D:\Git\dugate\du-rework\services\orchestrator`

Command: `pnpm exec jest --runInBand --runTestsByPath tests/rcr-luna-http-encryption.test.ts tests/rcr-http-offline.functional.test.ts tests/rv01-loopback-http-offline.test.ts`

Result: exit 0; 3 suites passed, 57 tests passed. Jest printed its existing open-handle warning after completion; it did not change the exit code.

Command: `pnpm exec tsc --noEmit -p tsconfig.json`

Result: exit 0; no output.

Candidate SHA-256:

- `services/orchestrator/src/http/routes/public.ts`: `422DB30E924DB063C30405B26BE73CCC867CE4E4DEDE8E344B411A169CBB057C`
- `services/orchestrator/tests/rcr-luna-http-encryption.test.ts`: `1AD7EECD222368209F2D667A8BCB3CAF0C1AD48128023FB525D822BC33EFF758`

The working tree is uncommitted. This receipt records focused offline verification only; it does not claim release acceptance or live delivery-encryption acceptance.
