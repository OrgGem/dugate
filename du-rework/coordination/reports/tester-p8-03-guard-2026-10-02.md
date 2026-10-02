# P8-03 offline skip guard — 2026-10-02

## Change

- `businesses/document-core/tests/p8-03-provider-convergence.test.ts:12-13` selects `test.skip` unless `DU_LIVE_INFRA === '1'`.
- Only the database-backed projection case uses the alias at `businesses/document-core/tests/p8-03-provider-convergence.test.ts:331`; the surrounding offline contract tests still run.
- This follows the repository's conditional test-registration pattern (`tests/integration/p8-02c-mm05-rearm.integration.test.ts:45`) and the `DU_LIVE_INFRA` convention used by live suites such as `services/orchestrator/tests/admin-keyset-explain.test.ts:62-65`.
- The SQL, setup, assertions, and cleanup callback are unchanged. With `DU_LIVE_INFRA=1`, `liveTest` is exactly Jest's `test`, so the live case is not skipped. That branch was verified from the guard expression, not executed against infrastructure.

## Offline verification

- Commit at test time: `f2be0def52368aca0b7cf2d24af406de718154bc`.
- CWD: `D:\Git\dugate\du-rework`.
- Exact command: `Remove-Item Env:DU_LIVE_INFRA -ErrorAction SilentlyContinue; $env:REDIS_SMOKE='0'; $env:DATABASE_URL='postgresql://du:du-test-only@127.0.0.1:1/du_orchestrator_test'; git diff --check -- businesses/document-core/tests/p8-03-provider-convergence.test.ts; pnpm --filter @du/document-core test`
- Exit code: `0`.
- Jest output: `Test Suites: 58 passed, 58 total`; `Tests: 1 skipped, 920 passed, 921 total`; `Snapshots: 0 total`; `Time: 34.456 s`.
- The skipped case is the live `usage_events` projection query. PostgreSQL was pointed at closed local port `127.0.0.1:1`; `REDIS_SMOKE=0` prevented Redis probing. No live infrastructure was used.

## Scope notes

- The worktree contained other pre-existing, uncommitted document-core lane changes during this package-wide run. This task changed only `businesses/document-core/tests/p8-03-provider-convergence.test.ts` and this receipt; no other lane files were edited.
- `git diff --check` reported no whitespace errors; Git emitted its existing LF-to-CRLF working-copy warning for the edited test file.
- No source files, migrations, gates, or commits were changed. No package install or live DB/Redis run was performed.

## Verdict

Offline document-core is green: 0 failed, 1 live DB test correctly skipped, and exit code `0`. The live branch remains runnable when the caller explicitly sets `DU_LIVE_INFRA=1`; no live acceptance is claimed.
