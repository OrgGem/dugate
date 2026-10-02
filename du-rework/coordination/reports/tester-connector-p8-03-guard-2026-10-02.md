# Connector P8-03 offline skip guard

## Change

- Added the repository's `DU_LIVE_INFRA` guard pattern at `services/connector/tests/p8-03-convergence.test.ts:30-31`: `liveTest` resolves to `test` only when the flag equals `1`, otherwise to `test.skip`.
- Applied `liveTest` only to the DB-backed USE-02 projection case at `services/connector/tests/p8-03-convergence.test.ts:638`. Its test body and assertions are unchanged. With `DU_LIVE_INFRA=1`, the same body runs; the live path was not run here.
- This matches `businesses/document-core/tests/p8-03-provider-convergence.test.ts:12-13,331`.

## Offline verification

Working directory: `D:\Git\dugate\du-rework`. Command: `pnpm --filter @du/connector test`.

Environment: `DU_LIVE_INFRA` unset; `CONNECTOR_INTEGRATION`, `CONNECTOR_DATABASE_URL`, and `CONNECTOR_REDIS_URL` unset; `DATABASE_URL=postgresql://du:offline-only@127.0.0.1:1/du_orchestrator_test?connect_timeout=1` (closed loopback port, not shared PostgreSQL).

Result: **24 passed, 2 skipped / 26 suites; 298 passed, 8 skipped, 0 failed / 306 tests; exit code 0.** The USE-02 live database case skipped as intended. Live execution with `DU_LIVE_INFRA=1` remains unverified.

## Worktree note

The target test file already had a separate working-tree assertion change before this guard task: `classifyFailure(400)` expects `PROVIDER_REQUEST_REJECTED` at line 438. It is retained and was not part of this change. No production source, other test file, gate, or commit was changed by this task.
