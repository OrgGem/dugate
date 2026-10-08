# Independent verification: F-1 / F-2, leg A

RESUME POINT: VERIFIED-CLEAN — current tree checked; offline verification and code review complete.

Scope: read-only verification inside du-rework. No product source or test files were changed. Tests were offline only; no live database window is claimed.

## Command results

| Command | cwd | Exit code | Result |
|---|---|---:|---|
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json | D:\Git\dugate\du-rework\orchestrator\services\orchestrator | 0 | PASS; no output |
| node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/aweb06-bff-operations.test.ts (controlled capture rerun) | D:\Git\dugate\du-rework\orchestrator\services\orchestrator | 0 | Test Suites: 3 passed, 3 total; literal Tests:       21 passed, 21 total |

Jest capture note: the first invocation of the exact Jest command used a PowerShell pipeline with ErrorActionPreference=Stop. PowerShell surfaced native stderr as NativeCommandError before the script could persist the process exit code or output. That first attempt is recorded in raw/02-tenant-list-jest-capture-attempt.log; its exit code and Tests line are unrecovered, not assumed. After confirming both protected hashes still matched the initial checkpoint, the same Jest command was run with stdout/stderr redirected via Start-Process. The controlled capture completed with exit 0 and the literal summary above. The first attempt is a capture failure, not a claimed test failure or pass.

Node used: C:\nvm4w\nodejs\node.exe, version v22.16.0.

## Hash checkpoints

| File | Initial SHA-256 | After typecheck | After captured Jest run | Final after review | Result |
|---|---|---|---|---|---|
| orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts | F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813 | F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813 | F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813 | F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813 | unchanged |
| orchestrator/services/orchestrator/src/app/admin/overview-section-renderer.ts | 3EAFF2501ECF05110AA8EFE7BD41F2E1598C87EA4D2A8A6C606CDBBAA5FC3AFC | 3EAFF2501ECF05110AA8EFE7BD41F2E1598C87EA4D2A8A6C606CDBBAA5FC3AFC | 3EAFF2501ECF05110AA8EFE7BD41F2E1598C87EA4D2A8A6C606CDBBAA5FC3AFC | 3EAFF2501ECF05110AA8EFE7BD41F2E1598C87EA4D2A8A6C606CDBBAA5FC3AFC | unchanged |

## Independent code review

- 3a — F-1: PASS. tenant-list.ts:123-124 binds operator scope. At :131-133 the boundary subquery includes boundaryScope, which expands to AND id = scopeBind whenever scope is non-null. The cursor-name lookup is therefore fenced to the scope.
- 3b — Regression coverage: PASS. tests/tenant-list-cursor-codec-offline.test.ts:115-151 covers reuse across a changed scope. Lines :139-150 use foreign cursor C (Gamma) while scope B (Beta), assert an empty page and assert the SQL subquery contains AND id = $1; bind values are checked too.
- 3c — F-2: PASS. overview-section-renderer.ts:277-280 describes fail-closed roster behavior, :281 checks current tenant membership, :282-290 builds placeholder and roster entries, and :291-295 renders a select named tenantId. It is roster-backed, not free text.

## RED findings

- First Jest capture attempt: PowerShell capture failed with NativeCommandError; its process exit and test summary could not be recovered. See raw capture-attempt log.
- Captured verification runs: none red. Typecheck exit 0; Jest exit 0 with 21/21 tests.
- No source hash changed; no blocker.

