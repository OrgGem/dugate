# P8 — Reliability, security, performance và vận hành

Owner: QA/infra integration agent. Depends: G5. Write: `tests/`, `infra/`, evidence/runbooks; fixes trong service qua owner tương ứng. Không deploy production/cutover trong phase này.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P8-01 | [ ] Real isolated multi-service E2E harness và traceability audit | G5 | BR/test/endpoint coverage matrix complete |
| P8-02 | [ ] Transaction boundary fault suite, lease/queue/storage recovery | P8-01 | OPS-02/07, RUN-02..07, ART-02 pass |
| P8-03 | [ ] Provider unknown/dedup/quota/usage convergence tests | P8-01 | CON-01..05, USE-01/02 pass |
| P8-04 | [ ] Auth/tenant/SSRF/file/schema/secret security suite | P8-01 | OPS-04, ART-03, CON-04, REG-04 pass |
| P8-05 | [ ] Load/burst/soak/fairness benchmark 1→2→4 replicas | P8-02..04 | Targets P0 đo được, bottlenecks/report rõ |
| P8-06 | [ ] Compose/prod packaging, health/shutdown/migrations/backup restore | P8-02..04 | OPS-08 và clean deployment evidence |
| P8-07 | [ ] Dashboards/alerts/runbooks cho queue, outbox, UNKNOWN, storage, credentials | P8-05/06 | Operator có steps xác định và rollback recovery |
| P8-08 | [ ] Release readiness report, remaining risks và consumer compatibility | P8-07 | G6; chưa cutover hệ thống cũ |

## Benchmark report template

Hardware/OS; pinned versions; images; DB/Redis/storage config; workload inputs/pages; provider mock latency/quota; arrival/concurrency; throughput; p50/p95/p99 submit/queue/end-to-end; errors/retries/UNKNOWN; CPU/RSS/DB pools; recovery observations. Tách API acceptance latency khỏi document completion latency.

## Failure drills

Stop API, stop Connector, kill worker trước/sau provider call, drop HTTP completion ACK, restart Redis có/không queue state, DB unavailable, object store unavailable, delayed usage reports, old worker còn chạy sau lease expiry. Assert accepted operations eventually terminal hoặc explicit waiting/unknown có owner; không silent lost work.

## Gate G6

No unresolved critical correctness/security defect; explicit limits và capacity report; docs/runbooks match actual implementation; root DUGate không thay đổi. Production launch vẫn là yêu cầu riêng, kèm deployment target và approval theo phạm vi user lúc đó.
