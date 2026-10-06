# REGRESSION-ATTRIBUTION-894 — 2026-10-05

Independent, read-only attribution of the 12 red tests in FULL-REGRESSION-889. No source/test files, commits, or plan checkboxes were changed in this task. The package results are from the existing 889 receipt plus a fresh offline orchestrator JSON rerun; its totals match 889 exactly: 194 suites passed, 5 failed, 26 skipped; 4,805 tests passed, 10 failed, 231 skipped; exit 1. Contracts remain 525/527 passing, with 2 failures and exit 1. Worker-sdk remains 692 passed, 1 TODO, exit 0.

## The 12 failing cases, with locations

| # | File:line | Exact failing test | Attribution |
|---:|---|---|---|
| 1 | `services/orchestrator/tests/admin-shell-session-lifecycle.test.ts:821:26` | W-SEC-AUDIT-TAXONOMY-1 default console sink through the REAL shell listener › mount default: a bad token over the socket logs exactly one parseable, sentinel-free security line | **Pre-existing.** Same failure/test hash as 825B. |
| 2 | `services/orchestrator/tests/artifact-read-authorization.test.ts:370:80` | R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation | **Pre-existing.** Same failure/test hash as 825B. |
| 3 | `services/orchestrator/tests/artifact-read-authorization.test.ts:381:15` | R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant | **Pre-existing.** Same failure/test hash as 825B. |
| 4 | `services/orchestrator/tests/artifact-read-authorization.test.ts:410:19` | R1-A artifact read authorization and storage-facade boundary › keeps writes producer-scoped and hides storage keys from the public upload grant | **Pre-existing.** Same failure/test hash as 825B. |
| 5 | `services/orchestrator/tests/artifact-read-authorization.test.ts:592:17` | CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact | **Pre-existing.** Same failure/test hash as 825B. |
| 6 | `services/orchestrator/tests/artifact-read-authorization.test.ts:727:15` | CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong | **Pre-existing.** Same failure/test hash as 825B. |
| 7 | `services/orchestrator/tests/artifact-read-authorization.test.ts:737:15` | CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one | **Pre-existing.** Same failure/test hash as 825B. |
| 8 | `services/orchestrator/tests/legacy-payload-migration.test.ts:176:27` | ENC-09 plaintext inventory and migration › inventories source metadata without returning payload contents and blocks retirement | **Existing source-order/current test-contract mismatch, surfaced after the earlier count assertion was updated.** `unresolvedReferences: 10` now matches. The remaining assertion expects six `UNCOVERED_SCOPE` entries before `INVALID_METADATA`, while unchanged `legacy-payload-migration.ts:179` pushes `INVALID_METADATA` during source scanning and `:190` appends uncovered kinds afterward. The implementation source hash matches 825B; the test hash changed to update the old 4-versus-10 expectation. This red is not attributable to A3, MIG-02, or the usage-summary fixture. Because the test hash changed and the old run stopped at the count assertion, I cannot prove this exact order assertion itself failed in 825B. Resolve the intended issue ordering before calling the suite green. |
| 9 | `services/orchestrator/tests/migration-verify-trap-fix.test.ts:77:86` | verifyMigrations: mismatch reports with real evidence › the table has MORE rows than the read registered -> throws with both numbers | **Pre-existing.** Same 34-row/33-sequence assertion and test hash as 825B. |
| 10 | `services/orchestrator/tests/migration-0032-rollback.test.ts:113:27` | MIGRATION-0032: idempotent re-run on a fresh instance › two migrate() runs apply the DDL exactly once and leave one ledger row | **Pre-existing.** Same extra-0033 result and test hash as 825B. |
| 11 | `packages/contracts/tests/vault-policies.test.ts:104:38` | dev fixture — end-to-end policy enforcement › worker/browser can never even log in | **Pre-existing test-harness failure.** `expect(...).toThrowError is not a function`; this test never reaches its policy assertion. Source and test hashes match 825B. |
| 12 | `packages/contracts/tests/vault-policies.test.ts:179:40` | dev fixture — end-to-end policy enforcement › renewal extends the session; expired tokens die and cannot be revived | **Pre-existing test-harness failure.** The same unsupported matcher TypeError occurs before the assertion can verify renewal behavior. Source and test hashes match 825B. |

Hash anchors for the three previously unattributed cases and the named fixes:

- Legacy inventory source: `f41ea3d80581cec8477413a859737e12d6ee2f9881cc89893e3b2547d9194544` both at 825B and current; test changed from `70a4d9750599651ca49989fea2e6c7f9409e30350658a929f726199694ecd434` to `6a0e3f9a409f2e3429ef51cf89c632e9e9394132141fe1ebfd49ee5746403f23` as the expected inventory count moved from 4 to 10.
- Contracts implementation `packages/contracts/src/vault-policies.ts`: `3f3e7219ebcffb79aafab17eeb02a0f08c67609e15ecdf20e52d40ce2868f7af`; test `packages/contracts/tests/vault-policies.test.ts`: `7c4526e684f24789edb551a228dd6784b92977129ab71615e6486495d4bbbc4e`. Both values match 825B.
- A3 policy source/test remain `84e737ed408e627495c690e5b9969f95960d22c1919d4c2f94482848fc11ad2a` / `2ea9932c9fb4cfd1aec034c649ee596d7e966697c6503dcf5085bdd1ffc599a9`, matching VERIFY-POLICY-FIX-824.
- MIG-02 helper/public route current hashes: `cde6c9f1ab43cea5efdf266bddc719bc8c06a61e3d7270db2604b9fbae7fc332` / `ef1f74714aa2f4b972ad6db0bb4aab62f6e0401fe9cff2c943043989a7eea97f`. Current route test hash is `5ddf7d6f53ec0021ad05ac294adf6b925127a2d7656e5f9295fd1b2634bcadf0`; all three target hashes matched across the temporary runtime mutation.
- Usage-summary test moved from `f44c916c9a8584bca1e360f8f817162d4a9e61fe1ab118e24e8b2e1ce2df672c` to `8b4af23057e4bdc1c703983d0ffba583105de6bb31266585892579d26ee4c925`; its 10 cases are all skipped in offline runs.
The nine exact pre-existing orchestrator reds are cases 1–7, 9, and 10. Case 8 is not attributable to the named wave: its implementation source was byte-identical to 825B, and the current test expectation was updated to count 10. The old run stopped before the issue-order assertion, so this receipt distinguishes existing source ordering from the current test contract without claiming that this exact assertion was previously red. Contracts cases 11–12 are also pre-existing by both source and test hashes and by the prior P745 A/B record. No failure is attributable to the A3 policy or the MIG-02 fence. The usage-summary change is not a pass because its entire suite was skipped.

## Duplicate `--runInBand` check

The original package script already invokes Jest with `--runInBand`; FULL-REGRESSION-889 forwarded it a second time. I ran the same five failing orchestrator files directly once with `--runInBand` and once with `--runInBand --runInBand`, recording JSON for both. Both runs reported 5/5 failed suites, 10 failed tests, exit 1, and the exact failed-test case sets were identical (**0 case-set differences**). Duplicate forwarding did not mask or change the observed failures.

## Mutation sensitivity and hash restoration

| Fix/control | Mutation evidence | Current state and boundary |
|---|---|---|
| A3 metadata-read policy | Independent VERIFY-POLICY-FIX-824 removed each `allowPlaintext()` check separately: each mutant made 2 tests red and left 22/24 green; source hash restored exactly to `84e737ed…fc11ad2a`. | Current policy source and test hashes exactly match that receipt and 825B. No new mutation was applied to leased source/test files in this attribution task. This establishes offline mutation sensitivity for both no-seam branches. |
| MIG-02 SQL predicate | Independent RERUN-PLAT-MIG-02-888 on disposable PG16 removed `p.tenant_id = $2`, `p.enabled = true`, and `k.status = 'ACTIVE'` in temporary SQL harness copies; each mutant failed with expected 0 / actual 1, exit 3. The current helper and public-route hashes match that receipt; the route-test hash was measured before and after the temporary route mutation probe. | I also injected a temporary Jest-only no-op at the route authorization seam (setup file under raw evidence, not product/test source): **7/18 tests failed**, exit 1. The five route-deny/no-probe cases and two loopback-deny cases turned red; the direct helper cases and authorized route remained green. Removing the shim returned the unchanged suite to **18/18, exit 0**. Route/helper/test hashes were identical before/after the probe. |
| Usage-summary fixture | The changed fixture test file has SHA-256 `8b4af230…ee4c925`; its 10 tests are all pending behind `DU_LIVE_INFRA=1`. | **Mutation evidence unavailable offline.** A mutant would remain unobserved while the suite is skipped; no skip was removed. Requires the authorized real test PostgreSQL + Redis window. |
| Contracts `vault-policies` | No current-wave code fix is present in this file. Both failing test cases terminate on the unsupported matcher before exercising the expected behavior. | Treat as a known baseline test harness defect, not evidence of a production policy regression. Update matcher compatibility and rerun before using these two cases as behavioral evidence. |

The 889 source/test inventory has **969 entries**; I rehashed every listed path after the JSON rerun, both `--runInBand` comparisons, and the route mutation/clean rerun. **0 of 969 entries drifted.** Full current values for helper, route and policy paths are recorded in the raw manifests and previous independent receipts. The mutation setup and JSON are report artifacts only. No source/test files were edited, no checkbox was changed, and no commit was made.

## Skipped suites: exact files and reasons

The JSON rerun records 26 wholly skipped suites (208 skipped cases); none count as passes. The run set `DU_LIVE_INFRA=0` and removed `DATABASE_URL` and `REDIS_URL`. The specialized PG and migration gates below were also absent. Skip guards were left unchanged.

| Skipped suite | Cases skipped | Required evidence / gate |
|---|---:|---|
| `services/orchestrator/tests/admin-action-rbac-live.test.ts` | 12 | `DU_LIVE_INFRA=1`; boots real app with PostgreSQL and Redis. |
| `services/orchestrator/tests/admin-audit.test.ts` | 11 | `DU_LIVE_INFRA=1`; real app, PostgreSQL and Redis. |
| `services/orchestrator/tests/admin-base-routes.test.ts` | 7 | `DU_LIVE_INFRA=1`; real app, PostgreSQL and Redis for route/list behavior. |
| `services/orchestrator/tests/admin-error-boundary.test.ts` | 1 | `DU_LIVE_INFRA=1`; real app boot on PostgreSQL and Redis before the injected DB error. |
| `services/orchestrator/tests/admin-local-users-migration.test.ts` | 1 | `DU_LOCAL01_LIVE_MIGRATION=1`; caller-owned private-schema PostgreSQL migration smoke. |
| `services/orchestrator/tests/admin-shell-live-pane.test.ts` | 1 | `DU_LIVE_INFRA=1`; mounted admin shell with real PostgreSQL and Redis. |
| `services/orchestrator/tests/artifact-grant-fencing.test.ts` | 18 | `DU_LIVE_INFRA=1`; real HTTP artifact flow on PostgreSQL and Redis. |
| `services/orchestrator/tests/artifacts-fencing-pg.test.ts` | 4 | `DU_LIVE_INFRA=1`; PostgreSQL-backed artifact fencing. |
| `services/orchestrator/tests/blob-wire-binary.test.ts` | 8 | `DU_LIVE_INFRA=1`; real HTTP and PostgreSQL/Redis app for binary round-trips. |
| `services/orchestrator/tests/data-02-04-live-s3.test.ts` | 5 | Exclusive Tester DB window, `DU_LIVE_INFRA=1`, and the approved private S3/MinIO bucket. |
| `services/orchestrator/tests/gate-authenticate-808-pg16.test.ts` | 2 | `GATE_AUTH_PG_URL` unset; requires disposable PostgreSQL 16. The test uses a deterministic provider and does not prove Vault. |
| `services/orchestrator/tests/ingress-bounded.test.ts` | 8 | `DU_LIVE_INFRA=1`; real app, PostgreSQL and Redis. |
| `services/orchestrator/tests/migrations.test.ts` | 10 | `DU_LIVE_INFRA=1`; live migration boot/verification on PostgreSQL and Redis. |
| `services/orchestrator/tests/operation-tenant-fence.test.ts` | 4 | `DU_LIVE_INFRA=1`; real HTTP tenant ownership checks against PostgreSQL/Redis. |
| `services/orchestrator/tests/runtime.test.ts` | 40 | `DU_LIVE_INFRA=1`; isolated real PostgreSQL/Redis runtime vertical slice. |
| `services/orchestrator/tests/runtime-admin-auth.test.ts` | 7 | `DU_LIVE_INFRA=1`; runtime/admin auth over the real app and PostgreSQL/Redis. |
| `services/orchestrator/tests/runtime-facade.test.ts` | 14 | `DU_LIVE_INFRA=1`; real app runtime facade. |
| `services/orchestrator/tests/runtime-health.test.ts` | 4 | `DU_LIVE_INFRA=1`; health/degraded/shutdown checks with real DB and Redis. |
| `services/orchestrator/tests/runtime-hitl.test.ts` | 7 | `DU_LIVE_INFRA=1`; real runtime HITL state transitions on PostgreSQL/Redis. |
| `services/orchestrator/tests/runtime-recovery.test.ts` | 9 | `DU_LIVE_INFRA=1`; live recovery runtime with PostgreSQL/Redis. |
| `services/orchestrator/tests/runtime-version-lifecycle.test.ts` | 7 | `DU_LIVE_INFRA=1`; real runtime version lifecycle. |
| `services/orchestrator/tests/runtime-webhook.test.ts` | 9 | `DU_LIVE_INFRA=1`; real runtime/webhook app against PostgreSQL/Redis. |
| `services/orchestrator/tests/usage-summary.test.ts` | 10 | `DU_LIVE_INFRA=1`; real app, PostgreSQL and Redis; this includes the changed fixture and no `createApp` runs offline. |
| `services/orchestrator/tests/vault-live.test.ts` | 3 | `DU_LIVE_INFRA=1` and running Vault dev server for Transit and KV v2. |
| `services/orchestrator/tests/webhook-reclaim-fence.live.test.ts` | 2 | `DU_LIVE_INFRA=1`, open Tester DB window, real PG/Redis and loopback mesh; file explicitly forbids self-running outside that window. |
| `services/orchestrator/tests/workspace-reference.test.ts` | 4 | `DU_LIVE_INFRA=1`; real HTTP workspace-reference checks against PostgreSQL/Redis. |

There are also **23 individually skipped tests inside suites that otherwise ran**: 7 in `oidc02-process-replicas-offline.test.ts` and 3 in `oidc02-multi-replica-offline.test.ts` (real multi-process Redis), plus 13 in `admin-keyset-explain.test.ts` (real PostgreSQL EXPLAIN/index and paging evidence). These also remain skipped and are not passes. The JSON raw file carries the exact pending test names.

## Disposition

- **Acceptable as pre-existing only with an explicit baseline waiver:** cases 1–7, 9–10, and 11–12. The first nine orchestrator reds and both contracts reds reproduce unchanged baseline failures; they still make their package commands exit 1.
- **Must resolve before calling the regression green:** case 8 issue-order contract; the two `toThrowError` assertions need compatible matchers before those behaviors can be evaluated. Cases 1–7 and 9–10 must also be fixed or covered by explicit baseline waivers if the acceptance bar requires a green full suite.
- **Evidence still missing:** live `usage-summary` fixture run; the 26 skipped suite results and 23 individual skipped test results; real Vault/provider behavior. These need their respective approved test windows. Do not count skips as pass.

Raw evidence: [FULL-REGRESSION-889 logs and hash inventory](raw/full-regression-889-2026-10-05/), [JSON rerun, exact failure/skip set, and duplicate-flag comparison](raw/regression-attribution-894-2026-10-05/), [VERIFY-POLICY-FIX-824 mutation receipt](verify-policy-fix-824-2026-10-05.md), [RERUN-PLAT-MIG-02-888 PG16 mutation receipt](rerun-plat-mig-02-888-2026-10-05.md).



