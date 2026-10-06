# FULL-REGRESSION-889 — 2026-10-05

Independent read-only regression of the current worktree after the A3 policy, PLAT-MIG-02 fence, and usage-summary fixture changes. This run did not edit product source or tests, create a commit, or update a checklist tick. Results describe the tested worktree snapshot, not a clean checkout of HEAD.

## Exact package results

| Package / command | Suites | Tests | Literal exit |
|---|---|---|---:|
| `pnpm --filter @du/orchestrator test -- --runInBand` | 194 passed, 5 failed, 26 skipped / 225 | 4,805 passed, 10 failed, 231 skipped / 5,046 | **1** |
| `pnpm --filter @du/contracts test` | 26 passed, 1 failed / 27 | 525 passed, 2 failed / 527 | **1** |
| `pnpm --filter @du/worker-sdk test` | 30 passed / 30 | 692 passed, 0 failed, 1 todo / 693 | **0** |
| **Combined** | **250 passed, 6 failed, 26 skipped / 282** | **6,022 passed, 12 failed, 231 skipped, 1 todo / 6,266** | — |

Skipped suites/cases and the one TODO are reported separately and are not counted as passes. No `--passWithNoTests` flag or skip-suppression option was used. The orchestrator command forwarded `--runInBand` to a script that already supplies it; Jest reported the effective command as `jest --runInBand "--runInBand"` and completed with exit 1.

Raw Jest output, exit records, and source/test manifests are in [raw evidence](raw/full-regression-889-2026-10-05/); [SHA256SUMS.txt](raw/full-regression-889-2026-10-05/SHA256SUMS.txt) covers those artifacts.

## Failure-by-failure disposition

The orchestrator had the same five red suites and ten failing test cases as FULL-REGRESSION-825B. Nine individual failures reproduce tests whose current test-file hashes match that prior snapshot; those are pre-existing reds, not failures introduced by this run or the named A3/MIG-02/fixture delta.

| Failure | Observed result | Attribution |
|---|---|---|
| `admin-shell-session-lifecycle.test.ts` — bad-token socket audit line | Expected one `auth.login_failed` event (`POST /admin/login`, `invalid_token`); observed event is `undefined`. | **Pre-existing.** Same test and assertion were red in 825B; test SHA-256 is unchanged (`13e2a19d…44067720`). |
| `artifact-read-authorization.test.ts` — STAGING artifact read | Expected `STATE_CONFLICT`; received a different rejection. | **Pre-existing.** Same failing test in 825B; test SHA-256 unchanged (`c0fb117c…ee4c925`). |
| Same suite — expired/fenced requester before read grant | Expected permission-denial semantics; received a different rejection shape. | **Pre-existing.** Same failing test and unchanged test hash as above. |
| Same suite — producer-scoped writes/public upload grant | Unexpected expired-lease `HttpError` for the fixture task. | **Pre-existing.** Same failing test and unchanged test hash as above. |
| Same suite — declared cross-operation STAGING reference | Expected `STATE_CONFLICT`, not permission denial; assertion still fails. | **Pre-existing.** Same failing test and unchanged test hash as above. |
| Same suite — expiry precedence over wrong task state | Expected permission-denial status/code; actual result differs. | **Pre-existing.** Same failing test and unchanged test hash as above. |
| Same suite — `lease_active` with missing vs past expiry | Expected missing and expired lease cases to remain distinguishable; actual assertion shows the boolean collapses them. | **Pre-existing.** Same failing test and unchanged test hash as above. |
| `legacy-payload-migration.test.ts` — inventory report issues | `unresolvedReferences: 10` now matches the test; the remaining deep-equality mismatch is ordering: actual puts `INVALID_METADATA` first, while expected puts the six `UNCOVERED_SCOPE` issues first and `INVALID_METADATA` last. | **Old 4-vs-10 red is resolved. This remaining ordering mismatch is open and not attributable to the named A3/MIG-02/fixture changes on available evidence.** The migration source hash matches 825B (`f41ea3d8…79194544`), but this test file changed since 825B (`6a0e3f9a…46403f23`); treat as a source/test contract mismatch needing owner triage, not as a pass. |
| `migration-0032-rollback.test.ts` — first migration run | Expected only `0032_checkpoint_session_ref.sql`; received that plus `0033_profile_request_redaction.sql`. | **Pre-existing.** Same failure in 825B; test SHA-256 unchanged (`3ac551be…65626db`). |
| `migration-verify-trap-fix.test.ts` — corrupt ledger row count | Test expects text saying 33 rows; actual guard says 34 rows but 33 distinct sequences. | **Pre-existing.** Same failure in 825B; test SHA-256 unchanged (`1a1edf86…0df8b55`). |
| `packages/contracts/tests/vault-policies.test.ts` — revoked token assertions at lines 104 and 179 | Both throw `TypeError: expect(...).toThrowError is not a function`. | **Pre-existing, 2 failures in 1 suite.** Same file hash as 825B (`7c4526e6…d4bbbc4e`) and previously recorded there with P745 A/B evidence. |

The legacy suite therefore no longer fails on `4` versus `10`: that expected count is `10` and passed before the later issue-order assertion. The suite remains red until the expected issue ordering or implementation contract is resolved; no test was edited here.

## Hash continuity / no drift

The inventory covers every repository file discovered under `src/` or `tests/` (excluding `.git` and `node_modules`): **969 files** before and after the three package runs. The sorted path-plus-SHA-256 manifest is byte-identical before/after; both manifests have SHA-256 `94a55d254b8ee55dfc1bf879478b15aa1a4c11409185967e3d3f19ef7e38f0b2`. A line-by-line comparison found **0 changed or added/removed source/test inventory rows**. See [before](raw/full-regression-889-2026-10-05/source-test-before.sha256) and [after](raw/full-regression-889-2026-10-05/source-test-after.sha256).

The fixture test `services/orchestrator/tests/usage-summary.test.ts` remained at SHA-256 `8b4af23057e4bdc1c703983d0ffba583105de6bb31266585892579d26ee4c925`. Its own guard uses `describe.skip` unless `DU_LIVE_INFRA=1`; it explicitly does not boot the app or connect without that flag.

## Offline evidence and live-only gaps

- **Offline evidence:** all three package commands completed on the local test snapshot. Worker-sdk is green (30/30 suites, 692 passed, one TODO); orchestrator and contracts are not green because of the red assertions above. The offline orchestrator run used `DU_LIVE_INFRA=0` with `DATABASE_URL` and `REDIS_URL` removed.
- **Not established here:** the 26 skipped orchestrator suites / 231 skipped cases are not passes. In particular, `usage-summary.test.ts` requires a live test PostgreSQL and Redis fixture and was skipped; this run does not independently validate that fixture’s live HTTP/database behavior. No live PostgreSQL, Redis, Vault, or provider-side checks were performed.
- The PLAT-MIG-02 authorization unit test was included in the orchestrator package discovery and did not appear among the failing tests, but this aggregate run does not provide a dedicated per-suite count for it. Live probe/network behavior remains outside this offline regression result.

