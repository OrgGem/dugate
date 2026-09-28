Model: gpt-6-luna max; cwd: D:\Git\dugate.

This is the newly added ChatGPT Codex agent for W42-CX2. I am NOT the previous “Rà soát và chỉnh plan” session.

# Coordination Report — W42-CX2 (onboarding + packet 1)

- Date: 2026-09-23
- Scope: Static correction of the P8-01 traceability audit only.
- Report location: coordination/reports/codex2.md
- Matrix location: du-rework/docs/19-traceability-audit-matrix.md
- Status: Traceability matrix updated; P8-01 remains PARTIAL and unchecked because the isolated E2E harness acceptance clause remains open.

## Completed

- Replaced noncanonical BR-13..BR-30 references with only canonical BR-01..BR-12 from du-rework/docs/01-product-scope.md.
- Rebuilt the BR × exact test case × six action endpoint matrix. Every cited source and test file has a Test-Path result in the matrix; exact case names are copied from the named test files.
- Added the explicit X-absent endpoint cells for every BR row. X records static endpoint incidence only; it is not a PASS result.
- Checked and recorded the ten review-listed false historical citations. They are not used as existing sources in the BR matrix. Added checked action implementation paths where applicable.
- Kept prior test totals as historical only. No test, build, PostgreSQL, or Redis command was run in this lane.
- Did not edit source or test files, P4-05/P4-08 materials, or P9 materials. Did not tick P8-01.

## Repository path note

The requested docs/ paths are not at the repository root. Test-Path from D:\Git\dugate returned False for docs/01-product-scope.md and docs/19-traceability-audit-matrix.md; the actual checked files are du-rework/docs/01-product-scope.md and du-rework/docs/19-traceability-audit-matrix.md. The coordination report path requested by the user is at the repository root.

## RUN REQUEST — Antigravity testing lane (term_47a1d44b)

These commands are requests for the dedicated testing lane; Codex did not execute them.

- RUN REQUEST: pnpm --dir du-rework/businesses/document-core run test:integration:full
- RUN REQUEST: pnpm --dir du-rework/businesses/document-core exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/all-variants-e2e.test.ts tests/traceability.test.ts tests/profile-binding-fixture.test.ts tests/checkpoint.test.ts tests/checkpoint-replay.test.ts tests/cancellation-fencing.test.ts tests/package-boundary.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/orchestrator exec jest --runInBand --runTestsByPath tests/runtime.test.ts tests/admin-view-model.test.ts
- RUN REQUEST: pnpm --dir du-rework/businesses/example-review exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/example-review-continuation.integration.test.ts tests/fanout-and-join.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/connector exec jest --runInBand --runTestsByPath tests/connector.test.ts tests/reliability-security.test.ts
- RUN REQUEST: pnpm --dir du-rework/packages/observability exec jest --runInBand --runTestsByPath tests/observability.test.ts

## Current acceptance boundary

The matrix repairs the static traceability clause for BR-01..BR-12. It does not close the isolated multi-service E2E harness clause or establish passing test results. P8-01 therefore stays PARTIAL / [ ] until the testing lane returns its run evidence and the harness acceptance is satisfied.
+

## W42-CX2 receipt — commands and results

The on-disk audit path is coordination/reports/codex2.md; current Test-Path result is True. The path-ledger result was rechecked by parsing each result row and executing Test-Path -LiteralPath against its exact path.

- Command: Test-Path -LiteralPath $path, once for every path row in du-rework/docs/19-traceability-audit-matrix.md §2.2. Result: 54 path entries; 42 True; 12 False; 0 mismatches between the pasted result and current filesystem.
- Command: Select-String -Path $f -Pattern '^\| BR-(0[1-9]|1[0-2]) —' -Encoding utf8, with $f=du-rework/docs/19-traceability-audit-matrix.md. Result: 12 canonical BR rows.
- Command: Select-String -Path $f -Pattern '^\| BR-(0[1-9]|1[0-2]) \|' -Encoding utf8. Result: 12 explicit X-absent rows.
- Command: Test-Path -LiteralPath coordination/reports/codex2.md. Result: True.

No Jest, PostgreSQL, Redis, build, or integration command was run by this Codex lane.

### RUN REQUESTs previously recorded for Antigravity

Re-listed from the W42-CX2 report. These remain requests, not runs performed by Codex.

- RUN REQUEST: pnpm --dir du-rework/businesses/document-core run test:integration:full
- RUN REQUEST: pnpm --dir du-rework/businesses/document-core exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/all-variants-e2e.test.ts tests/traceability.test.ts tests/profile-binding-fixture.test.ts tests/checkpoint.test.ts tests/checkpoint-replay.test.ts tests/cancellation-fencing.test.ts tests/package-boundary.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/orchestrator exec jest --runInBand --runTestsByPath tests/runtime.test.ts tests/admin-view-model.test.ts
- RUN REQUEST: pnpm --dir du-rework/businesses/example-review exec jest --runInBand --runTestsByPath tests/manifest.test.ts tests/example-review-continuation.integration.test.ts tests/fanout-and-join.test.ts
- RUN REQUEST: pnpm --dir du-rework/services/connector exec jest --runInBand --runTestsByPath tests/connector.test.ts tests/reliability-security.test.ts
- RUN REQUEST: pnpm --dir du-rework/packages/observability exec jest --runInBand --runTestsByPath tests/observability.test.ts

## W42-CX3 packet — P4-05 / P4-08 evidence adoption decision

Decision: do not adopt P4-05 or P4-08 from the orchestrator-reported 82 offline suites and 8 live suites run at 19:05–19:07. The orchestrator states that the two exact orphan integration suites were not included. Their existence and unrelated suite counts do not prove their named live assertions. P4-05 and P4-08 remain unchecked.

Basis: accepted W41-CC evidence in du-rework/coordination/reports/codex.md:142-160. This packet uses that accepted audit; it does not repeat the orphan test audit.

### P4-05 — keep unchecked

The accepted W41-CC record identifies du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts as a seven-test live suite covering staged upload grant→PUT→finalize READY, read-grant download, scoped file lifetime, oversized rejection, stale lease-epoch fencing, hash verification, and resultRef/disposal. It requires real PostgreSQL on port 5433 and Redis on port 6380. W41-CC explicitly says it was not executed and was not adopted.

The P4-05 task criterion is ART-01..03 plus bounded memory/file lifetime. The accepted offline SDK slice covers the SDK-side bounds and temp-workspace lifecycle, but does not establish real P2 grant/access behavior for ART-01/03 or platform ART-02 staging-orphan safety. The missing evidence is the exact live run against real P2 artifact endpoints, with command, exit code, result, environment, and revision recorded. Separately, ART-02 staging-orphan cleanup must protect artifacts referenced by active checkpoints. The SDK temp-workspace sweeper only cleans du-worker-* directories; it does not establish platform artifact sweep safety. The accepted W41-CC record assigns that gap to the platform lane and says the P4-05 row remains unchecked until it is implemented or explicitly deferred.

### P4-08 — keep unchecked

The accepted W41-CC record identifies du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts as one live cross-service test: submit→dispatch→SDK worker→pending yield→retry→stable invocation→SUCCEEDED, using real P2 and P3 with a mock provider and a worker that has no DB credential. It was not executed. The offline grant-service mock is not evidence that the real P2/P3 path satisfies this acceptance.

The missing acceptance evidence is this exact test run through real P2/P3, with command, exit code, result, service revisions/environment, and the worker credential boundary recorded. Until then, the prior offline and unrelated live suites cannot be adopted for P4-08.

### Decision requests

- REQUEST — Claude Code/platform owner: resolve the P4-05 ART-02 platform gap by implementing staging-orphan cleanup in services/orchestrator with active-checkpoint protection, or record an explicit scope deferral and its acceptance impact. Keep P4-05 [ ] until the live P2 artifact suite and this platform acceptance are satisfied.
- REQUEST — Worker SDK owner: no packages/worker-sdk source change is requested before the live run. The accepted W41-CC receipt already records the SDK temp-workspace cleanup wiring and offline slice; the remaining adoption gap is live P2/P3 evidence plus platform staging-orphan safety. Route any future failure to the owning package based on the failing assertion.
- RUN REQUEST — Antigravity testing lane (term_47a1d44b), cwd du-rework/tests/integration: npx jest tests/integration/p4-05-artifact-streams.integration.test.ts --runInBand. Required evidence: exact named staged artifact cases, exit code/result, real PostgreSQL :5433 and Redis :6380, service revision, and environment.
- RUN REQUEST — Antigravity testing lane (term_47a1d44b), cwd du-rework/tests/integration: npx jest tests/integration/p4-08-sdk-consumer.integration.test.ts --runInBand. Required evidence: full live P2/P3 submit-to-SUCCEEDED path, exit code/result, service revisions/environment, mock-provider boundary, and proof that the worker has no DB credential.

These RUN REQUESTs are not execution results. No command was sent to or run by another lane in this turn; P4-05 and P4-08 remain [ ] pending their owner-run evidence.

## W48-C2X3 — Coder 3: connector / connector-client (2026-09-24)

- Scope: `du-rework/services/connector` and `du-rework/packages/connector-client`; this report is at the requested root path.
- Status: MM-07/MM-08 verification cases prepared. No test suite or live PostgreSQL/Redis command was run; no DB window was opened.

### Changes in this turn

- `PostgresInvocationLedger.claim` now uses `INSERT ... ON CONFLICT (invocation_id) DO NOTHING RETURNING *`; a raced insert is reread under `FOR UPDATE` and returned as same-hash replay or different-hash conflict. This closes the unique-key exception path for concurrent first claims.
- Connector HTTP maps a replay of a `CANCELLED` invocation to 409.
- Added connector tests for insert-conflict mapping and cancelled replay with zero provider sends; added HTTP status coverage for `CANCELLED`.
- Expanded the gated durable connector suite with: concurrent durable first claims followed by restart/replay; cancelled ledger replay after restart; a persisted quota lease expiring after connector restart while another tenant is blocked before expiry and admitted after expiry; and shared cap across two tenants using different revisions of the same credential, including connector restart.
- Added a connector-client test proving `wait()` reuses a fresh invocation grant for each poll from a recreated client. Existing transport tests also cover explicit/resolved grants for poll and cancel.

### Acceptance status

- **MM-07:** source and cases are prepared, but durable acceptance is unverified until the gated Postgres + Redis suite runs. The new lease-expiry case expects the original invocation to time out without another provider dispatch after its persisted lease expires.
- **MM-08 shared-account cap:** the current runtime keys quota by `credentialRef`; the new durable case shares that reference across tenants and revisions and expects tenant B to remain at 429 with zero provider calls while tenant A is pending, including across connector restart. It then expects B to complete after A releases the lease.
- **Remaining MM-08 scope:** this turn does not establish the full plan item for model/quota-domain-specific budgets or explicit renewal of long synchronous-call leases. Current leases are bounded by the invocation deadline and retained across pending provider jobs; there is no `QuotaStore.renew` operation. Do not mark the full MM-08 row complete from the cross-tenant cap case alone.

### Check record

- `git diff --check` on the edited connector/client files: clean (Git emitted only existing LF-to-CRLF advisories).
- No Jest, build, DB, or Redis checks were run. The durable cases in `tests/black-box-durable.test.ts` are gated by `CONNECTOR_INTEGRATION=1` and require the connector test PostgreSQL/Redis environment; leave their execution to the designated DB testing window.
