# Shipping checklist verification — 2026-10-05

**Task:** `task_022a8b04c963` / **Dispatch:** `ctx_c2b0f2bec769`  
**Verdict:** 6 checks passed; check 6 failed on API-key authentication.

Read-only verification: no product source or test files were changed, and no commit or plan tick was made. I ran the repository fixtures against an isolated PostgreSQL 16 database and Redis 8 bound to loopback, with the real local DUGate app, BullMQ workers, deterministic mock connector, and a temporary loopback webhook receiver. The fixture database and Redis were stopped and removed after the checks; all task-owned listeners were confirmed closed. No production database, Redis, external AI provider, or live identity provider was used.

| # | Check | Result | Executed evidence |
|---|---|---|---|
| 1 | Six public endpoints return the expected operation response and map to the correct use case | **PASS with valid API key** | `tests/e2e/profile-openai-flow.e2e.test.ts` sent live HTTP requests for `ingest:parse`, `extract:invoice`, `analyze:classify`, `transform:rewrite`, `generate:summary`, and `compare:diff`. All six returned 202 with `operations/<id>` and `Operation-Location`; the stored endpoint slug, locked profile marker, mock call, result, and completed queue job matched each case. |
| 2 | Disbursement workflow runs its DAG without losing steps | **PASS** | Posted `process=disbursement` to `/api/v1/docs/workflows` through the real app and worker. It reached `WAITING_USER_INPUT` with steps `[0,1]`; POST resume continued to `SUCCEEDED` with steps `[0,1,2,3]`. The checked operation was `9dd3a8e4-4eca-4bcf-9944-ae184c4b5f03`. |
| 3 | BullMQ worker polls and processes jobs | **PASS** | The E2E fixture checked the actual BullMQ jobs reached `completed` for all six pipeline submissions and the schema workflow parent/child queues. The disbursement workflow also completed its post-resume work through the worker. |
| 4 | Idempotency does not create a duplicate operation or job | **PASS** | Repeated the same real `/api/v1/docs/ingest` request with one `idempotency-key`: first response 202, repeat 200, same operation ID, database count 1, matching BullMQ job count 1. |
| 5 | Webhook delivery and operation polling report the right state | **PASS** | Polled a real ingest operation to `SUCCEEDED`; the loopback receiver captured `POST {"operation_id":"2e4da0f1-fa63-49c9-ae95-261aa56fc0b2","state":"SUCCEEDED","done":true}`, and its `Operation.webhookSentAt` was non-null. The disbursement polling path also observed the waiting checkpoint and final success. |
| 6 | API-key middleware and NextAuth protect every endpoint | **FAIL — release blocker** | The valid-key E2E calls succeeded, and an actual NextAuth Credentials login/session worked. However, valid-shaped, unauthenticated requests carrying an invalid `x-api-key` returned **202 on all six public endpoints** (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) and were accepted for operation submission. No session cookie was sent. The internal API without a session returned 401 and `/dashboard` redirected to `/login`. The runtime evidence matches `middleware.ts` pass-through for `/api/v1/` and `lib/endpoints/runner.ts` resolving an unknown raw key with a warning but not rejecting the request. |
| 7 | RBAC ADMIN / USER / VIEWER decisions | **PASS** | Actual Credentials sessions on the disposable app: ADMIN — analytics 200, admin guard reached handler (400 for intentionally empty body); USER — analytics 200, admin guard 403; VIEWER — analytics 403, admin guard 403. Anonymous internal API returned 401. |

## Commands and literal outcomes

- `pnpm run test:e2e:connector` — **exit 0**, 1 suite passed, 7 tests passed. This exercised the real app, PostgreSQL, Redis, connector fixture, and worker; the six endpoint cases and workflow parent/child case all passed.
- Focused Jest suites (`schema-disbursement`, `schema-route`, `ui-integration`, `du-operation-adapter`, `hitl-persistence`) — **exit 0**, 5 suites passed, 75 tests passed.
- `pnpm exec tsc -- --noEmit` — **exit 0**.
- Unscoped `pnpm test -- --runInBand` — **exit 1; stopped early, no complete suite totals**. Root Jest's recursive pattern also collected `du-rework` tests; the root E2E setup attempted the default PostgreSQL identity (`Gem`) and received password authentication failures, nested integration tests lacked their expected PostgreSQL service/modules, and `tests/pipelines/external-api.test.ts` hit a `mammoth` import `TypeError`. This broad command is not evidence for the focused shipping checks above.

## Offline versus live-only

All seven checklist behaviors were exercised offline against the isolated disposable stack; none used production state or a live external provider. Real production ingress/proxy behavior, production database and Redis permissions, OIDC against the deployed identity provider, and actual external connector/provider availability remain live-environment checks. The invalid-key acceptance is already a reproducible offline failure and should block shipping until the owner fixes it and reruns the six endpoint rejection check.
