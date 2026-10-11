# OR10-01 implementation receipt — source credential origin allowlist

**Task:** OR10-01, architecture-reviewed R1′ design  
**Owner evidence:** implementation and offline verification only  
**Recorded:** 2026-10-10 15:37 UTC  
**Environment:** Windows PowerShell, Node.js v24.21.0, local working tree `D:\Git\dugate\du-rework`  
**Git state:** changes remain unstaged and uncommitted; no push or gate/acceptance change was made.

## Implemented

- Added additive migration `0041_profile_binding_allowed_origins.sql`: `profile_bindings.allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb`, guarded with `ADD COLUMN IF NOT EXISTS`.
- Added strict write/read contract fields. Origin values reuse `CallbackApprovedOriginSchema`, canonicalize through `URL.origin`, sort deterministically, cap at 16, and reject canonical duplicates. Invalid stored values are returned as an empty list with a read-only invalid marker; raw malformed data is not exposed.
- Profile revisions persist the list with the immutable credential binding. An omitted field carries forward from the prior revision; an explicit empty list clears it. Both platform and tenant profile detail reads select the allowlist from the active pinned revision.
- The acquisition resolver reads `allowed_origins` beside the cipher from the exact `(profile_id, revision)` row. No execution snapshot or claim schema changed.
- `openGate` checks the initial source origin before fetch I/O. `DU_SOURCE_CREDENTIAL_ORIGIN_MODE` defaults to `warn`; only `warn` and `enforce` are accepted. Warn mode preserves the existing credential attachment and emits a structured, redacted warning. Enforce mode denies missing policy as `ORIGIN_POLICY_MISSING` and a non-member origin as `ORIGIN_NOT_ALLOWLISTED`; both are permanent ingestion failures.
- The fetch wrapper repeats the check for the original origin. Cross-origin redirect hops still receive no credential, preserving the existing redaction behavior.
- Added the mode to local/Docker environment examples and Compose wiring. Added data, deployment, traceability, test-inventory, and acceptance-evidence notes without changing any gate.

## Offline verification

Commands were run from the listed package directories. Raw output is in [the OR10-01 raw folder](raw/or10-01-allowlist-impl-2026-10-10/).

| Command | Result |
|---|---|
| Contracts package: `npm run build` | exit 0 |
| Contracts package: `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/profile-policy.test.ts` | 1 suite, 31/31 passed, exit 0 |
| Observability package: `npm run build` | exit 0 |
| Observability package: `node node_modules/jest/bin/jest.js --runInBand` | 3 suites, 48/48 passed, exit 0 |
| Orchestrator service: `node node_modules/jest/bin/jest.js --runInBand --testPathPatterns "(p730-acquire|p730-prof03|cb02|wt04-profile-invalid|request-redaction|url-ingestion-consumer-offline|url-ingestion-offline|tapi01-closure|migration-0032|migrations-ledger|migration-verify|med1-migration-ledger|med1-verify-migrations|or10-01|profile-api-keys-membership|admin-api-keys)"` | 23 suites, 286/286 passed, exit 0 |
| Orchestrator service: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0 |
| Orchestrator service: `npm run build` | exit 0 |
| `git diff --check` over touched tracked files | exit 0 with no whitespace errors; CRLF-to-LF warnings for `docs/04-data-state.md`, `docs/19-traceability-audit-matrix.md`, `docs/28-test-inventory.md`, and `docs/35-acceptance-baseline.md` |

The service regression batch uses mocked database/storage/fetch seams and local migration-file inspection. It did not apply a migration to PostgreSQL or make a real network request. The origin warning test confirms the origin/code event survives logging projection while credential material is redacted. No skipped tests were reported in the passing batches.

## Broader checks and limits

- Full Contracts package Jest run: **29 suites passed, 1 failed; 569/570 tests passed; exit 1**. The failing `tests/operations-list-contract.test.ts` expects the older list-query parameter set; current source additionally includes `from` and `to` from the separate AWEB-16b work. OR10-01 did not modify that route or test. Raw: `contracts-full.log`.
- Deployment Docker test `node --test tests/deployment/docker.test.cjs`: **14/20 passed, 6 failed; exit 1**. Failures were the portable deployment lockfile/importer comparison and five Compose assertions expecting `PORT` to be absent while the current Compose model resolves it to `3000`. OR10-01 changed only the source-origin mode mapping in the orchestrator Compose environment, not lockfiles or `PORT`. Raw: `deployment-compose-tests.log`.
- An initial final-check attempt caught a type annotation issue in the new environment parser. It was corrected; the final service typecheck, build, and 286-test regression batch all pass. Initial logs are retained as `orchestrator-typecheck.log` and `orchestrator-regressions.log`; final passing logs have the `-final` suffix.
- Full Orchestrator test suite, live PostgreSQL migration, deployed warn observation window, real HTTPS acquisition, and independent review were not run. This receipt does not claim independent verification or acceptance.
