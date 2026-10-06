# PLAT-MIG-02: public readiness tenant/binding fence

Status: IMPLEMENTED + owner verification; independent VFY/review pending. User request: execute DU Platform migration. Lease: `coordination/coordinator-state.json.lease_approval_plat_mig_02`, approved 2026-10-05 18:06:08 +07 for term_43f85ccc.

## Behavior

GET `/api/v1/connectors/{id}/test` resolves the active API key, then requires an enabled profile binding at its published revision belonging to both the caller tenant and key. No active binding/pointer, foreign tenant/key, disabled profile or different connector fails 403 before outbound probe. Malformed stored binding fails closed with a sanitized 503. Successful readiness response is unchanged; this is service readiness, not a provider inference/test.

No legacy global-registry fallback for an unbound key. This security tightening changes old unbound-probe behavior intentionally per PM-M03. Existing live fixture `tests/usage-summary.test.ts:298-337` needs a published permitted binding for stub/dead connectors; `nope` without a binding now fails 403 instead of exposing global registry membership via 404. That file is outside the granted lease and was not modified. Coordinator must assign fixture/docs update and independent real-app verification; do not report full regression green from this receipt.

## Changed paths / candidate hashes

| Path | SHA-256 |
|---|---|
| src/modules/connectors/probe-authorization.ts | cde6c9f1ab43cea5efdf266bddc719bc8c06a61e3d7270db2604b9fbae7fc332 |
| src/http/routes/public.ts | ef1f74714aa2f4b972ad6db0bb4aab62f6e0401fe9cff2c943043989a7eea97f |
| tests/plat-mig-02-probe-authorization.test.ts | 5ddf7d6f53ec0021ad05ac294adf6b925127a2d7656e5f9295fd1b2634bcadf0 |

Branch update includes one required import; no other public route behavior changed. main/profile/proxy/store/Compose/shared docs unchanged by this owner. Baseline is the working tree, not HEAD; code includes untracked files.

## Verification

Cwd `D:/Git/dugate/du-rework`, Node22.16.0/pnpm10.18.3, 2026-10-05:

- `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/plat-mig-02-probe-authorization.test.ts`: 18 passed, 0 failed, 0 skipped, exit0. Raw `plat-mig-02-owner-tests-2026-10-05.log`. Includes unit/route guards and three actual HTTP loopback API→Connector probe cases; database projection is mocked for those tests.
- `pnpm --filter @du/orchestrator typecheck`: exit0. Raw `plat-mig-02-typecheck-2026-10-05.log`.
- `node coordination/reports/plat-mig-02-pg-probe-2026-10-05.cjs`: exit0, six SQL assertions pass. Raw `plat-mig-02-pg-probe-2026-10-05.log`. Reads SQL from the actual helper and runs against PG in du-live-postgres, database postgres, a single private session with TEMP tables only; BEGIN/ROLLBACK, no permanent data/table/schema changes. Tests own published binding, active revision, disabled/revoked/foreign-tenant join/missing pointer. This is SQL integration proof, not a standalone deployed-app acceptance test.
- `git diff --check` for scoped code/tool paths: exit0.

Separate read-only tooling allowed by coordinator: `tools/repo-migration/verify-inventory.cjs`, six Node tests and README. Consumes PLAT-MIG-00 TSV; `plat-mig-snapshot-audit-2026-10-05.json` captured **before this source edit**: 1030 listed product files, 246 untracked, zero drift, digest e415d76b2cfad1969563cc336271885da7b8fb1a3b3d9154feb881ade345e613. Listed-file hash proof only, not inventory completeness. Env files including .env.example/generated/keys excluded. Source has changed since; refresh inventory/hash for the final candidate.

Boot source authored by MIG-01 owner independently smoke-checked here: `tests/plat-mig-01-boot.test.ts` 12/12 exit0. No claim about real signed service identity/refresh or deployment from mock-header tests.

## Next owners / holds

Coordinator: release this narrow source lease after accepting handoff; bind independent VFY and Claude review, grant live fixture change to appropriate owner, sync PM-M03 docs/traceability/test inventory under shared-doc lease. PLAT-MIG-02 ingress work and MIG-03 prefix remain separate pending slices. Full source/repo extraction still follows RPK-00 until user answers the pending isolated-migration sequencing question. No commit/push/deployment/window flip or repo extraction performed.

## Follow-up: real app readiness fixture, 18:21

The fixture hold above is now implemented under `lease_approval_usage_fixture`, granted at 18:18:26. Coordinator released overlapping task USAGE-FIXTURE-FIX-883 before granting the user-owned lane. Only the connector readiness describe block in `tests/usage-summary.test.ts` changed; usage aggregation tests and product source are unchanged.

Fixture seeds an enabled profile revision for the existing caller key and publishes its active pointer. Own bound stub/dead Connector paths retain their prior 200/502 behavior. Unbound ID now expects 403; missing key remains 401, with zero outbound requests. An additional real-app case removes the active pointer, asserts configured Connector denial with zero outbound HTTP, and restores the pointer in finally. Nested afterAll removes only the generated profile UUID. This seeds actual published database state directly; it does not exercise the admin publish API.

SHA-256 `tests/usage-summary.test.ts`: `8b4af23057e4bdc1c703983d0ffba583105de6bb31266585892579d26ee4c925`.

Verification used NEW private Docker containers, NOT the project/shared test database:

- PostgreSQL16: `du-platmig02-fixture-pg-20261005-1819`, database `du_platmig02_test`, host loopback port59376; Redis7: `du-platmig02-fixture-redis-20261005-1819`, host loopback port59381. Both labeled `du.task=plat-mig-02-user-fixture`.
- With DATABASE_URL/REDIS_URL pointing to those isolated instances and DU_LIVE_INFRA=1: `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/usage-summary.test.ts --testNamePattern 'connector test proxy'`: exit0, 5 passed, 5 usage tests excluded by name filter. Raw `plat-mig-02-live-fixture-2026-10-05.log`.
- Full affected file: `pnpm --filter @du/orchestrator test -- --runTestsByPath tests/usage-summary.test.ts`: exit0, **10 passed, 0 failed, 0 skipped**. Raw `plat-mig-02-live-usage-suite-2026-10-05.log`. REAL createApp listener, auto-migrated PostgreSQL and real readiness HTTP proxy are used.
- `git diff --check -- du-rework/services/orchestrator/tests/usage-summary.test.ts`: exit0.
- Cleanup verified each container's exact task label before `docker rm --force --volumes` on the two explicit names. Both containers and anonymous volumes removed. `docker ps -a --filter label=du.task=plat-mig-02-user-fixture` returns no containers. No project container/data changed.

These are owner verification results, not independent acceptance. Independent VFY task `task_83ea5d26d116` was dispatched by the existing coordinator. Phase A ingress and real signed management authentication still remain open. Release fixture lease and review this final fixture hash alongside the three product/test hashes above.

## Independent findings and SQL coverage follow-up, 18:24

Read independent `verify-plat-mig-02-883-2026-10-05.md`: 18/18 and tsc pass with restored source hashes. It observes zero outbound HTTP on denial, sanitized errors and unchanged successful shape. It also reports that removing only the SQL tenant predicate leaves mocked-query tests green, and that revocation can race with an already-authorized in-flight readiness probe. These limitations remain visible for reviewer adjudication; this receipt does not claim atomic revocation or ACCEPTED.

Added a mismatched-principal-tenant assertion to the separate private-session PostgreSQL harness (no product/test source change). It runs the SQL extracted from the current helper using key-a with tenant-b and requires zero rows. Unmodified source SQL now passes **7 assertions**, exit0 (`plat-mig-02-pg-probe-final-2026-10-05.log`). `--mutate-tenant-predicate` replaces the tenant predicate in the harness's in-memory SQL string only; PostgreSQL rejects the expected-zero assertion with actual1, exit3 (`plat-mig-02-pg-tenant-mutation-2026-10-05.log`). Source is never mutated. Private TEMP tables/transaction disappear on connection close after the intentional error; the positive run explicitly ROLLBACKs.

This closes the owner's SQL predicate sensitivity gap in a real PostgreSQL query. Independent re-execution and reviewer disposition of the authorization/revocation semantics are still owed.
