# P2 — Orchestrator API, registry và durable runtime

Owner: platform agent. Depends: P1 G1. Write: `services/orchestrator/` và platform-specific tests. Contracts/root lockfile qua integration owner. Read: docs 04–07, 09, 12–13.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P2-01 | [ ] Module skeleton/repository interfaces/platform DB migrations | G1 | Constraints/stateVersion/outbox indexes, one-shot migration |
| P2-02 | [ ] Auth/key/profile/registry services và handlers | P2-01 | REG/PRF cases; scoped dynamic registration, no hardcoded business |
| P2-03 | [ ] Artifact metadata/upload/finalize/access APIs | P2-01/02 | ART-01/02 ownership+staging lifecycle |
| P2-04 | [ ] Submission/idempotency/admission/outbox dispatch | P2-02/03 | OPS-01..03 DB/queue crash gaps handled |
| P2-05 | [ ] Claim/lease/heartbeat/checkpoint/progress/complete/fail | P2-04 | RUN-01..04; runtime retry budget, fenced reports |
| P2-06 | [ ] Children/dependencies/join continuation, human wait/resume, deadline/cancel | P2-05 | RUN-05..07; concurrency=1 không deadlock |
| P2-07 | [ ] Invocation grants, connector management proxy, usage ingestion/projection | P2-05; P3 contract stub | Grant bound input/refs; USE-01/02 dedup |
| P2-08 | [ ] Poll/result/compat facade/sync wait/webhooks/audit | P2-04..07 | OPS-04..06; webhook separate from business completion |
| P2-09 | [ ] Reconciliation/background lifecycle/health/shutdown | P2-05..08 | OPS-07; restart repairs from DB |
| P2-10 | [ ] Platform vertical slice với stub worker/connector rồi actual components | P2-09; actual P3/P4 khi ready | G2; không coi stub pass là system complete |

## Interface → functions → tests → implementation

Trước mỗi row: ghi typed repository/service contract; viết transaction boundary tests và state-transition cases; sau đó handlers gọi service. Next page/routes không giữ business logic. Runtime module không biết ingest/extract handler code.

Function focus: registerVersion, resolveExecution, submitOperation, claimTask, saveStep, spawnAndWait, waitForInput, resumeOperation, finalizeTask, failTask, dispatchOutbox, reconcileLeases, ingestUsage.

## Critical edge cases

Dispatch ACK race với claim; duplicate completion sau terminal; cancel trong provider call; old lease report; lost heartbeat; outbox publish lại; human input duplicate và stale version; unauthorized worker/task; public identity spoof headers. Revoke permission không làm lộ cached idempotent response.

## Done evidence

API contract tests + real PostgreSQL/Redis integration, migrations từ empty DB, state diagram đối chiếu implementation, logs redacted, scope metrics. G2 handoff cho SDK/business: runtime URLs/config placeholders, schema version, fixture-backed API behavior.
