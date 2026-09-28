# 32. P0-01 acceptance spec (tests that must exist; spec only, no tests written)

P0-01 acceptance: every BR-01..12 has owner + scenario + test. Nine of twelve
are evidenced in docs/19 section 2. The three gaps below each name the exact
test, file, assertion, infra, and RUN REQUEST for testing lane term_47a1d44b.

## Gap 1: BR-05 artifact TTL sweep + tenant quotas (owner: platform)

- Test A: `staging sweep deletes EXPIRED unreferenced artifacts, keeps
  checkpoint-referenced ones`. File:
  `du-rework/tests/integration/artifacts-grants.integration.test.ts` (extend)
  or new `artifact-retention.integration.test.ts`. Assertion: seed STAGING
  artifact older than TTL + one referenced by step_checkpoints; run sweeper;
  assert first gone, second present. Infra: DB :5433 (+Redis :6380 if sweeper
  queued). RUN REQUEST: testing lane runs the file --runInBand, expects the
  new test name literal in output.
- Test B: `tenant disk quota denies over-quota upload with 429/409`.
  Assertion: set tiny quota, upload over it, expect denial + no orphan row.
  Infra: DB. RUN REQUEST: same lane, same file or new.

Source today: artifacts.ts has GRANT_TTL_MS (line 23) but no sweep/cron/quota
path (rg sweep/cron/quota empty in that module).

## Gap 2: UC-07 v1/v2 drain (owner: platform)

- Test C: `drain v2 redirects new submissions to v1 while in-flight v2 pins
  to completion`. File: extend example-review version-coexistence or new
  `version-drain.integration.test.ts`. Assertion: submit op1 on v2, drain v2,
  submit op2 routes v1, op1 completes on v2 worker. Infra: DB+Redis.
  RUN REQUEST: testing lane, literal test name in output.

Source today: registry.ts activateVersion/deactivateVersion exist; drain
routing test with both versions live does not.

## Gap 3: operator service routes (owner: platform)

- Test D: `operator read endpoints exist with scoped auth` OR written scope
  decision that operator is view-model-only. Today server.ts has only
  POST /api/v1/admin/operations/sweep-deadlines (:793); no operator GET
  health/queue/errors routes. Assertion if built: 200 with operator scope,
  401/403 otherwise. Infra: DB. RUN REQUEST: testing lane once built; until
  then the gap stays open and P0-01 stays [ ].

NO DB USED by this spec. Nothing ticked.
