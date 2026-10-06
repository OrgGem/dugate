# PORTAL-REQUEST-CONTROL-20261006 ? owner implementation receipt

Date: 2026-10-06. Scope: du-rework only. No commit, remote, push or production cutover. Direct user request; this is an implementation receipt, not independent acceptance.

## Delivered

- `/admin/web/operations`: server-side cursor pagination, 20/50/100 page sizes, default `created_at:desc`, Previous/Next/Newest, reset cursor on state/page-size changes, race-safe list/detail responses.
- Detail: redacted request input, complete result JSON, artifact metadata, safe task statuses/attempt limits/error codes, creation/start/completion/deadline, total elapsed and execution elapsed. Execution elapsed includes waits, not CPU time.
- Stop: real BFF POST ? audited `operations.cancel`, available to admin and tenant-scoped operator. Viewer/unscoped sessions denied. Existing lifecycle cancellation semantics retained; external work already issued cannot be undone.
- Retry: real BFF POST ? new platform-admin-only `operations.retry`. FAILED/CANCELLED/TIMED_OUT only. Fresh operation/root task/outbox linked by retryOf, original history frozen, original business/profile/prompt pins and callback retained, no copied checkpoints. Concurrent clicks coalesce to an active child. Metadata is read under the configured policy and resealed with new AAD identities. Expired/deleted input or cached source versions reject before creating a child. Pending URL/S3 sources use the existing ingestion gate.
- Mutations: confirmation, CSRF, role/tenant gates, idempotency; mutation key retained after transport/error response. Creation/task/outbox/audit/marker commit atomically; audit failure rolls back retry.
- Migration 0034 records immutable started_at/completed_at separately from updated_at, freezes created_at and rejects reopening a terminal operation. Cache/file maintenance cannot overwrite these timestamps. Historical terminal completion and historical first start remain unknown; no false updatedAt backfill. Historical active operations can record a future actual terminal time.
- PostgreSQL verification exposed two pre-existing pagination bugs, now corrected: Date-based cursor serialization truncated microseconds; backward pages lost their Next link. Exact SQL timestamp projection retains index-compatible ordering/predicate and old millisecond cursors remain supported.
- Canonical contracts/docs updated; docs/21-openapi.json regenerated using the generator. Candidate exporter refreshed the standalone Orchestrator source inventory (824 files).

## Evidence

Node 24.21.0, pnpm 10.18.3. Owner checks only:

| Check | Result | Raw evidence |
|---|---|---|
| Contracts build | exit 0 | request-controls-contract-build-2026-10-06.log / .exit.txt |
| Backend build | exit 0 | request-controls-backend-build-2026-10-06.log / .exit.txt |
| Portal production build | exit 0 | request-controls-ui-build-2026-10-06.log / .exit.txt |
| Focused Jest | 162 passed, 6 suites, exit 0 | request-controls-unit-2026-10-06.log / .exit.txt |
| Isolated PostgreSQL | 21 passed, 0 failed, exit 0 | request-controls-db-2026-10-06.cjs / .log / .exit.txt |
| Real Portal build + BFF browser | 8 passed, 0 failed, exit 0 | request-controls-browser-2026-10-06.cjs / .log / .exit.txt |
| OpenAPI generator + example validation | exit 0; 54 paths, 23 example checks | generated docs/21-openapi.json and tool transcript |
| Scoped diff whitespace check | exit 0 | tool transcript |

191 distinct owner test cases (162 + 21 + 8); repeated runs are not added. PostgreSQL uses only dedicated container `du-request-controls-20261006`, DB request_controls, loopback 15446; no shared schema is modified. The DB harness asserts current_database before resetting its dedicated public schema. Fixtures have no production secrets. Browser runs the compiled Portal and actual BFF against a synthetic upstream, not a business worker/AI provider. Desktop 1280 and mobile 390 evidence: request-controls-desktop-2026-10-06.png and request-controls-mobile-2026-10-06.png; no page overflow/JavaScript errors.

Commands from services/orchestrator: `pnpm run build`; `pnpm exec jest --runInBand --config jest.unit.config.cjs --runTestsByPath tests/aweb06-bff-operations.test.ts tests/admin-action-dispatcher.test.ts tests/operations-list-cursor-sort-binding.test.ts tests/operations-list-contract-conformance.test.ts tests/fu-encmeta-admin-projection.test.ts tests/request-redaction.test.ts`.
From packages/contracts and apps/admin-web: `pnpm run build`. From repo root under portable Node24: `node du-rework/coordination/reports/request-controls-db-2026-10-06.cjs`; `node du-rework/coordination/reports/request-controls-browser-2026-10-06.cjs`; `python du-rework/tools/openapi/gen_openapi.py`; `python du-rework/tools/openapi/validate_openapi.py`.

## Follow-up filters and gates

User's follow-up asks whether filters cover time, profile, model and business. **They do not yet.** Portal has state filter; backend additionally supports tenant/id/sort. `PORTAL-OPS-FILTERS-20261006` is recorded SPECIFIED/OPEN in the master plan: date range, business/action, profile/revision, tenant/ID UI, and actual model/provider usage. Model configured in a profile must be distinguished from models actually invoked; multi-model requests need deduplication/tenant-fenced usage joins.

Deployment must apply migration 0034 before running this backend version. It has only been applied in the isolated test database. Production workers/queues/providers and independent tester/backend/UI review remain OPEN. No new dependencies were introduced and no vulnerability-free image claim is made for this build.
