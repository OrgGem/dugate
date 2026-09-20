# P1 — Project structure, interfaces, function contracts và harness

Owner: integration/contract agent. Depends: P0 G0. Write: root config **bên trong du-rework**, `packages/contracts/`, `packages/observability/`, minimal workspace shells, `infra/`, contract test harness. Đây là lúc đầu tiên được tạo source/config khi implementation đã được yêu cầu.

Read: docs 02–09, 12–13. Không sửa package.json/lockfile ở parent repository.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P1-01 | [ ] Scaffold independent npm workspaces, strict TS, exports/build/test/lint scripts | G0 | Clean install/build không import old app |
| P1-02 | [ ] Materialize DTOs/JSON Schemas và validators | P1-01 | Manifest, submission, snapshot, job, task, grant, result/error versioned |
| P1-03 | [ ] OpenAPI descriptions cho public/admin/runtime/connector; examples | P1-02 | Validator checks request/response examples, pagination/status/auth đủ |
| P1-04 | [ ] Pure interfaces/repositories/adapters và function signatures | P1-02 | docs 09 inventory có typed Result/errors, side effects và ownership |
| P1-05 | [ ] Isolated test infra + provider/runtime stubs + synthetic fixtures | P1-03 | DB/Redis/object storage namespace riêng, không real AI |
| P1-06 | [ ] Spike queue retry/claim/fencing/yield và Orchestrator server lifecycle | P1-04/05 | Version-pinned behavior; concurrency=1 parent yield; loops start/stop đúng |
| P1-07 | [ ] Freeze wire v1; consumer compatibility suite; root dependency boundaries | P1-06 | G1 evidence, owner mới có contract fixtures để chạy độc lập |

## Required tests

Unknown JSON fields/invalid enum/schema refs/oversized manifest; serialization round-trip; unknown contract major; canonical request hashing; immutable IDs. Harness có controllable provider received-but-response-lost hook. Validate queue naming/ACL behavior trên pinned BullMQ/Redis.

## Design before implementation

Định nghĩa state transition function pure; DB repository ports cho atomic transactions; runtime HTTP client interface; provider adapter interface; artifact streaming interface. Ghi rõ retry owner là runtime. Không tự chuyển sang BullMQ FlowProducer dependency state nếu chưa cập nhật ADR-07/08.

## Gate G1

Contracts và examples validate, clean build, spike findings ghi lại. P2/P3/P4 chỉ bắt đầu parallel sau freeze. Breaking change sau freeze phải có impact/consumer tests và owner coordination.
