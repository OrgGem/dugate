# Receipt: V1 boot typed denial test alignment

- **Completed:** 2026-10-10 15:53 UTC
- **Scope:** `du-rework/orchestrator/services/orchestrator/tests/v1-boot-typed-denial.test.ts`
- **Node:** `v24.21.0`

## Changes

- Added a deterministic `ORCHESTRATOR_INTERNAL_BASE_URL` fixture and included it in the boot environment cleanup. Production boot now reaches the profile cipher policy instead of failing first on the unrelated Runtime artifact grant origin guard.
- Added a `withNodeEnv` helper that restores an unset `NODE_ENV` by deleting it, avoiding the string value `"undefined"` leaking across cases.
- Updated the resolver DB mock and successful decrypt expectation for the current `allowedOrigins: []` result shape.
- Preserved the strict checks for missing-key typed denial, permanent consumer failure without fetch/retry, successful decrypt with a supported key, and tampered-cipher denial.

## Verification

- `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/v1-boot-typed-denial.test.ts` with `NODE_ENV=production`: **PASS**, exit 0; 1 suite / 10 tests.
- Same Jest command with `NODE_ENV` unset for `tests/v1-boot-typed-denial.test.ts`, `tests/p730-acquire-ref-resolver.test.ts`, `tests/p730-acquire-consumer-auth.test.ts`, and `tests/aweb02b-tenant-token-env.test.ts`: **PASS**, exit 0; 4 suites / 54 tests.
- `git diff --check -- tests/v1-boot-typed-denial.test.ts`: **PASS**.
- Both runs were offline, using the test's scripted DB and mocked boot dependencies; no external services were used.

Raw output:

- [`raw/v1-boot-typed-denial-alignment-2026-10-10/jest-production.log`](raw/v1-boot-typed-denial-alignment-2026-10-10/jest-production.log)
- [`raw/v1-boot-typed-denial-alignment-2026-10-10/jest-related-unset.log`](raw/v1-boot-typed-denial-alignment-2026-10-10/jest-related-unset.log)

No files were staged, committed, or pushed.
