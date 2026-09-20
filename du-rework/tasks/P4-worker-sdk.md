# P4 — Worker SDK, document-kit và reusable execution functions

Owner: SDK/document utilities agent. Depends: G1. Write: `packages/worker-sdk/`, `packages/document-kit/`; coordinate connector-client owner. Read: docs 04, 07, 09–10, 13.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P4-01 | [ ] DefineBusiness/TaskContext/handler/Artifact/Parser interfaces | G1 | Public exports không dependency service source |
| P4-02 | [ ] Startup registration, worker health, BullMQ consume + runtime claim | P4-01 | Identity/version validation, graceful shutdown |
| P4-03 | [ ] ctx.step checkpoint, progress, error classification/retry budget, lease heartbeat | P4-02 | RUN-01..04, full output restore, fencing |
| P4-04 | [ ] Spawn-and-yield, join continuation, human wait/resume facade | P4-03 | RUN-05..07 với concurrency=1, no in-memory wait |
| P4-05 | [ ] Artifact streaming/download/temp isolation and cleanup | P4-01 | ART-01..03, bounded memory/file lifetime |
| P4-06 | [ ] document-kit parsers/converters/archive utilities | P4-05; P0 format scope | DOC-01/04, real synthetic DOCX/XLSX fixtures |
| P4-07 | [ ] Invocation grant facade/connector client wiring/session refs | P4-03; P3-07 | Same logical step gets stable invocation, pending yields |
| P4-08 | [ ] SDK consumer integration against real P2/P3; example handler harness | P4-04/06/07 | G3 SDK part, worker has no DB credential |

## Functions to design before implementation

startWorker/stopWorker; withTaskLease; step; spawnAndWait; waitForInput; scheduleRetry; readArtifact/writeArtifact; obtainInvocationGrant; invokeConnector; detectFormat; parseDocument; convertDocument; extractArchiveSafely.

`ctx.step` không hứa external exactly-once: dedup completed checkpoint và stable invocation qua Connector. User callback side effects ngoài SDK phải có idempotency policy riêng. Parse CPU-heavy code phải không làm starvation heartbeat; test event loop và isolation/worker-thread nếu cần trong cùng business service.

## Tests and handoff

Runtime contract consumer tests, retry report ACK loss, lease loss abort, parent no deadlock, human wait restart, object hash/stream/cleanup, parser fallback không bỏ qua inference. Handoff gồm SDK quickstart sử dụng frozen manifest contract và examples trong code docs; không tạo business production ngoài phạm vi.
