# Shell lifecycle `record.event` — already green at handoff

Status: NO-OP per dispatch green branch
Date: 2026-10-08
Scope: `du-rework` only. Offline. No PG/Redis or DB window used/claimed.

## Current verification

The dispatch says to stop without source/test edits if the existing regression test is already green. Ran the specified suite once from `orchestrator/services/orchestrator`:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts
```

Exit code: 0. Literal output:

```text
Test Suites: 1 passed, 1 total
Tests:       51 passed, 51 total
Snapshots:   0 total
Time:        5.89 s
Ran all test suites matching tests/admin-shell-session-lifecycle.test.ts.
```

The RED did not reproduce in this run. Historical evidence in `coordination/reports/triage-pre-existing-red-2026-10-08.md` §1 records the earlier `1 failed, 50 passed, 51 total, EXIT=1`, with `record.event` undefined at line 821.

## State observed before the test

`git status --short` for the target files showed only `orchestrator/packages/observability/src/log-metadata.ts` modified; the test and `src/app/admin/shell-server.ts` had no working-tree diff at that point. The existing `log-metadata.ts` diff already implements a bounded nested event projection: `EVENT_FIELDS` permits `kind`, `reason`, `method`, `pathname`, and `action`; `eventLogRecord` admits only scalar values; `metadataLogRecord` writes the projected object at `event`. This retains the existing test contract without passing arbitrary nested fields.

The test still asserts `record.event` exactly equals the closed `auth.login_failed` event and checks the sentinel is absent. No source or test was edited during this dispatch; the pre-existing source diff was preserved.

## Checks not run

The dispatch explicitly says to report and stop when the test is already green. No additional fix or post-fix TypeScript command was run; no typecheck result is claimed.

No commit, push, git add, gate tick, OpenAPI hand edit, or `.env.live` read was performed.
