# CONN-2CFIX — Independent verification

**Scope:** read-only verification. This run made no source/test edits, used no live infrastructure, and performed no gate ticks or commits.

## Suite and typecheck results

Working directory: `D:\Git\dugate\du-rework`. `DU_LIVE_INFRA`, `CONNECTOR_INTEGRATION`, `CONNECTOR_DATABASE_URL`, and `CONNECTOR_REDIS_URL` were unset. To prevent the unguarded P8-03 test from reaching shared PostgreSQL, the connector suite ran with `DATABASE_URL=postgresql://du:offline-only@127.0.0.1:1/du_orchestrator_test?connect_timeout=1` (closed loopback port; no shared DB or Redis).

| Command | Result | Exit code |
|---|---|---:|
| `pnpm --filter @du/connector test` (isolated `DATABASE_URL` above) | 23 passed, 1 failed, 2 skipped suites; 298 passed, 1 failed, 7 skipped tests (306 total) | 1 |
| `pnpm --filter @du/connector-client test` | 5 passed, 1 skipped suite; 39 passed, 1 skipped test (40 total) | 0 |
| `pnpm --filter @du/connector exec tsc --noEmit -p tsconfig.json` | clean | 0 |
| `pnpm --filter @du/connector-client exec tsc --noEmit -p tsconfig.json` | clean | 0 |

The connector failure is `p8-03-convergence.test.ts` USE-02, `live usage_events projection aggregates provider tokens and costs with zero double-billing on duplicate events`: `ECONNREFUSED 127.0.0.1:1` at the database query. It confirms the P8-03 offline-guard claim is **not reproduced**: the test at `services/connector/tests/p8-03-convergence.test.ts:635-648` constructs `PgSqlClient` and queries without a `DU_LIVE_INFRA`/skip guard. The prior receipt observed the same test attempting default port 5433; this verification deliberately isolated it to port 1 instead of contacting shared PostgreSQL. The other connector suites, including provider-rejection diagnostics and retry-signal passthrough, passed.

At final status check, `services/connector/src/http/server.ts`, `services/connector/src/services.ts`, and `services/connector/tests/p8-03-convergence.test.ts` are marked modified in the worktree; this verification did not edit them. `services.ts` still has an empty content diff as recorded below.

## Independent cross-checks

- **Non-2xx envelope — verified.** `services/connector/src/http/server.ts:81-85` retains `error.code` and `error.message`, adds `error.retryable` from `connectorError.safeToRetry`, and passes `retryAfterMs`; undefined optional `retryAfterMs` is omitted by JSON serialization. The loopback assertions in `services/connector/tests/retry-signal-passthrough.test.ts:133-170` verify refusal 502/false, outage 502/true, and 429/true with the retry hint.
- **Client policy — verified by code and passing tests.** `packages/connector-client/src/transport.ts:130-143` uses boolean wire `error.retryable` first and falls back only when absent; `:215-217` returns false for `PROVIDER_REQUEST_REJECTED`, otherwise true for 429 or 5xx. `packages/connector-client/tests/retry-signal-passthrough.test.ts:75-91` verifies 502 + `PROVIDER_REQUEST_REJECTED` → false, 502 + `PROVIDER_UNAVAILABLE` → true, and 429 → true.
- **`services.ts` content diff — verified empty.** `git status --short -- services/connector/src/services.ts` shows ` M`, while `git diff --exit-code -- services/connector/src/services.ts` prints no diff and exits `0`.
- **Additive behavior — supported for consumers that ignore new JSON members.** The envelope keeps the existing `code` and `message` values and only adds `retryable`/optional `retryAfterMs` at `services/connector/src/http/server.ts:81-85`. A consumer that reads only those unchanged members receives the same values; this is a code-level compatibility argument, not a test against a deployed old peer. Current client parsing keeps the fields optional on non-2xx responses at `packages/connector-client/src/transport.ts:130-143`.

## Verdict

Retry taxonomy claims (envelope propagation, wire-first client classification, and empty `services.ts` content diff) are independently verified. The reported P8-03 offline-safety fix is not present in the current test file: one unguarded DB test still fails without infrastructure, so the full connector suite is not green offline. No changes were made.
