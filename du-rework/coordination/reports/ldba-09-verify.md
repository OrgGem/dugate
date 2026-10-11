# LDBA-09B rehearsal verification

Independent verification run from `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` on Node `v24.21.0`.

| Command | Result |
|---|---|
| `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs tests/ldba-03-production-adapter.test.cjs` | Exit `0`; summary: 42 tests, 42 pass, 0 fail, 0 skipped. |
| `node scripts/ldba-09-harness.cjs` | Exit `0`; `IN_CONTAINER_EXIT=0`; `HARNESS_PASS disposable_pg16=1 network=none tmpfs=1 published_ports=0`; container cleanup reported `CONTAINER_REMOVED du-ldba09-pg16-1791511995002-15920`. |

All five rehearsal rounds passed their assertions:

| Round | Literal result | Check |
|---|---|---|
| 1 | `FIXTURE_PREFLIGHT_READY` | Synthetic fixture preflight returned `PREFLIGHT_READY`. |
| 2 | `FIXTURE_APPLIED_FIRST` | First execution returned `APPLIED`. |
| 3 | `FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL` | Replay returned `APPLIED` and every planned write was identical. |
| 4 | `FIXTURE_FAIL_POLICY_BLOCKED` | Fail policy correctly returned `BLOCKED_SKIPPED_ROWS` for controlled skips. |
| 5 | `LDBA08_REGRESSION_EXPECTED_CONTEXT_FAILURES` | Production adapter control returned the asserted `BLOCKED_TRANSFORM` context failures. |

The harness also reported `OFFLINE_TEST_EXIT=0`; its nested runner-skip test summary was 16 tests, 16 pass, 0 fail, 0 skipped. The `BLOCKED_SKIPPED_ROWS` and `BLOCKED_TRANSFORM` results above are expected outcomes asserted by rounds 4 and 5, not harness failures.

The harness used an isolated disposable PostgreSQL 16 container with synthetic fixture data, `--network none`, a tmpfs data directory, and no published ports. It applied the rehearsal migrations inside that container; no real or shared database was used. The container was removed at completion.

No test or product files were changed. No git add, commit, or push was performed.
