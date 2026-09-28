# Turn 201 appendix — do not commit standalone; appended into review.md by reviewer

## Turn 201 — Module Review ORCH-OPS-0019 (W-INGEST-0019-2 + W-DOCS-SYNC-1 + W-ADMIN-0019-DELTA29) — 2026-09-27

**Reviewer:** Claude Code (Reviewer) — Orca dispatch task_184579a5acc7 / ctx_28ef0650335c. Read-only audit; no product source, task row, or other-lane report edit except this section. No DB/Redis/S3 window, no commit/push.

### 1. Overview

| Field | Value |
|---|---|
| **Module / Feature ID** | ORCH-OPS-0019 |
| **Packets / Tasks** | W-INGEST-0019-2 (inline literal sentinel), W-DOCS-SYNC-1 (UNSUPPORTED_STORAGE_BACKEND 422), W-ADMIN-0019-DELTA29 (fake-DB harness alignment) |
| **Owner Implement (Qwen)** | Qwen-Platform (server.ts 29c79b1a/3257), Qwen-Docs (docs/06, docs/20/21), Qwen-Admin (harness DELTA29) |
| **Owner Tester (Codex)** | Codex Offline — T-CODEX-OFFLINE-INGEST-0019-2 (2026-09-27T12:29:51+07:00, 14 failed before) + T-CODEX-OFFLINE-ADMIN-0019-DELTA29 (2026-09-27T15:07:50+07:00, 4/4 pass 144/13 after) |
| **Target paths** | services/orchestrator/src/server.ts:2514-2607,2629-2665; services/orchestrator/tests/admin-operations-list-pagination.test.ts; services/orchestrator/tests/admin-operations-sort-http-offline.test.ts; services/orchestrator/tests/operations-list-contract-conformance.test.ts:220-332; docs/06-public-api.md:74,126,164; docs/20-openapi-descriptions.md:39-40; docs/21-openapi.json:161-180; services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql:66-79 |
| **Spec / ADR** | docs/06 section GET /operations Sort + Keyset cursor; docs/20 section 1 Operations-list contract; migration 0019 header (T-35 follow-on, Delta 24); packages/contracts/src/errors.ts:41 PublicErrorCodes; services/orchestrator/src/modules/operations/submission.ts:113-122 |
| **Evidence receipts** | qwen-platform.md#Muc-13 (tsc 0 x2, byte-identity 4/4, 14-fail deterministic); qwen-docs.md#Muc-22 (S0 927/571 BROKEN 0, 10 backticks fixed, 1.33->1.34); qwen-admin.md#Muc-20 (offline harness 32+22 tests); tester.md T-CODEX-OFFLINE deltas above; T190-A1 live EXPLAIN 4/4 Index Scan (separate Tester window, not this offline gate) |

### 2. Review Checklist

1. **Contract conformance:** SubmissionSchema.sourceUrl optional max2048 + 422 UNSUPPORTED_STORAGE_BACKEND before any DB write (zero rows, no PENDING_INGESTION) matches docs/06:126 and docs/28:705 / docs/35:866 product decision (capability-gating rejected). Operations list 6-value sort allow-list, direction-bearing cursor, 5-field envelope, and deadline_at sentinel pagination all conform to contracts/public-api.ts allow-list and server.ts symbols. Inline literal vs bound Param distinction is contract load-bearing (T-35).
2. **Code quality and architecture:** bindOperationsListSortKey emits COALESCE(deadline_at, '<sentinel>'::timestamptz) inline literal from compile-time constant keyed by validated direction (no caller text interpolation, no params.push), bindOperationsCursor reuses same sortKeySql for ORDER BY and predicate (cannot diverge), operationsListBoundaryKey mirrors sentinel for NULL rows, listOperationsPage builds single sortKeySql and folds cursor predicate via whereClause (correct WHERE/AND handling, T140-A1 fix). Transaction/outbox/lease unchanged. Fail-closed on postgres default is structural.
3. **Security and multi-tenancy:** x-api-key tenant fence via buildOperationsListPredicates (server-enforced predicate, no post-filter), admin bearer alternate path with requireResourceTenant/authorizeAuditTenantRead, 403 on foreign tenant, 401/422 taxonomy preserved. No secret echo in error detail/correlationId, allow-listed query seam prevents injection (AllowListedQuery compile error on read sort). Sentinel values are compile-time constants, not caller-supplied.
4. **Test validity:** Conformance suite pins ORDER_BY_BY_SORT to inline literals and asserts params not toContain sentinel (true negative guard, not false-green). Admin fake-DB harnesses now parse inline form via regex COALESCE with quoted literal (previously only $n::timestamptz), covering both shapes without loosening to accept arbitrary text. Before fix 5+7 ORDER BY parse failures (14 failed/130 passed), after fix 144/13 pass x3 — deterministic and reproducible. Mutation guards present (M-A self-comparison 7 red on replay set).
5. **Traceability and documentation:** docs/06:126 and :164, docs/28:705, docs/35:866, packages/contracts errors.ts:41 now aligned on UNSUPPORTED_STORAGE_BACKEND (D-EVID-A29). Migration 0019 header correctly documents why 0019 not edit of 0018, why expression indexes, why no CONCURRENTLY (transactional runner). Stale prose remains on sentinel wording (finding below).

### 3. Findings

- **[REV-ORCH-0019-01] Stale sentinel prose: bound sentinel wording contradicts inline literal implementation**
  - **Severity:** MEDIUM
  - **Location:** docs/06-public-api.md:74, docs/20-openapi-descriptions.md:39 (and docs/21-openapi.json missing sentinel note, but machine companion defers to docs/20 per D-EVID-A22)
  - **Expected:** Prose must describe COALESCE(deadline_at, '<sentinel>'::timestamptz) as inline quoted literal (Const node) matching migration 0019 expressions 4/4, with no placeholder. This is T-35 load-bearing: Param $n::timestamptz is a different plan node, leads to Seq Scan + Sort, dead indexes.
  - **Actual:** docs/06:74 reads COALESCE ve mot sentinel da bind (0001... khi desc, 9999... khi asc) and docs/20:39 reads its key is COALESCEd over a bound sentinel (0001... for desc, 9999... for asc). Both still claim bound, while server.ts:2560 emits COALESCE(deadline_at, '0001-...::timestamptz) / '9999-...' with zero params.push and qwen-platform.md#Muc-13 records Delta30 already flagging this drift (0019 header line 2556, neo dong 2547 stale).
  - **Evidence:** server.ts:2556-2561 literal map desc->0001, asc->9999 + operations-list-contract-conformance.test.ts:230-231 inline literal expectations + migrations/0019:66-79 four literal indexes + docs grep above vs implementation grep.

- **[REV-ORCH-0019-02] Migration 0019 header line anchor stale**
  - **Severity:** LOW
  - **Location:** services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql:11 (server.ts:2547) and docs traceability line neo 2547->2556 noted in qwen-platform Delta30
  - **Expected:** Header cites bindOperationsListSortKey symbol, not numeric line, per docs/06 convention (mo ta theo symbol, khong neo vao so dong).
  - **Actual:** Numeric anchor 2547 predates inline-literal edit that shifted block to 2556. Content of index definitions is correct (4/4 byte-match verified by Tester PowerShell comparison, Exit 0).
  - **Evidence:** File header line 11 vs server.ts:2556 function start; qwen-platform Muc-13 explicitly lists line neo 2547->2556 stale.

- **[REV-ORCH-0019-03] docs/21-openapi.json sentinel detail not carried (informational, deferred)**
  - **Severity:** SUGGESTION
  - **Location:** docs/21-openapi.json:161-173 sort param description
  - **Expected:** Companion file defers nuance to docs/20 (recorded in D-EVID-A22), but sentinel-nil handling is user-visible pagination contract (deadline-less ops on page 2+).
  - **Actual:** docs/21 describes allow-list and 422 but does not carry the COALESCE sentinel / NULL-ends-last paragraph that docs/06:74 and docs/20:39 do. Not a defect per lane convention where prose is correct and JSON is parameter list; noted for next docs sync pass.
  - **Evidence:** docs/21:161-180 vs docs/06:74 table row; no sentinel string in docs/21 grep.

No HIGH findings. Security/tenant, idempotency, and transaction boundaries are intact. Test harnesses are valid and not over-mocked; offline green is genuine but live EXPLAIN replay for 0019 under tenant-skewed multi-tenant seed (T190-A1/Delta21) remains the separate live acceptance gate per Turn 200 — out of scope for this offline module review and not a finding here.

### 4. Verdict

**CHANGES_REQUESTED** — one MEDIUM documentation traceability finding [REV-ORCH-0019-01] blocks ACCEPTED per template (any HIGH or MEDIUM blocks gate). Fix is single prose edit: change sentinel da bind / bound sentinel to sentinel literal inline '<ISO>'::timestamptz (Const, khong phai $n) at docs/06:74 and docs/20:39 (and optionally add one line to docs/21 sort description or keep deferral note). After that edit + docs lint BROKEN 0 re-check, coordinator may mark ORCH-OPS-0019 ACCEPTED ([x]) without code or test change. Live deadline_at Index Scan gate (T-35/Delta21/T190-A1) is tracked separately and does not block this module offline acceptance.
