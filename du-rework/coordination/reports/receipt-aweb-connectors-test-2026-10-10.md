# Receipt: Connectors state honesty offline tests

Date: 2026-10-10  
Task: AWEB-CONNECTORS-SUITE-COVERAGE-CHECK-2026-10-10  
Scope: `du-rework`  
Plan reference: `coordination/reports/docs-connectors-screen-honest-audit-2026-10-10.md`, section 0

## Delivered

- Added `orchestrator/apps/admin-web/tests/connectors-state-honesty.test.mjs` within the exact test lease.
- Tests cover capability parsing and fail-closed action gating when the deployment advertisement is absent or unreadable, plus independent management, test, and credential-workflow capability flags.
- Tests confirm connector config summaries expose sorted top-level keys and header names without configuration values.
- Tests parse a representative curl command, verify secret masking in the preview, and verify the upsert configuration contains no secret values or local file path. The bearer credential remains only in the in-memory draft for the separate credential flow.
- Offline screen-wiring assertions check that the tested gates and safe summary/upsert helpers are used by Connectors controls.

## Verification

- Command: `node --test tests/connectors-state-honesty.test.mjs`
- Working directory: `du-rework/orchestrator/apps/admin-web`
- Result: PASS, 6 tests, 1 suite, 0 failures, exit code 0.
- Receipt ASCII double quote check: PASS, zero occurrences.
- No git add, commit, or push was performed.
