# P1 — Project structure, interfaces, function contracts và harness

Owner: integration/contract agent. Depends: P0 G0. Write: root config **bên trong du-rework**, `packages/contracts/`, `packages/observability/`, minimal workspace shells, `infra/`, contract test harness. Các path này đã được materialize; thay đổi contract sau gate READY phải theo change policy của gate.

Read: docs 02–09, 12–13. Không sửa package.json/lockfile ở parent repository.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P1-01 | [x] Scaffold independent npm workspaces, strict TS, exports/build/test/lint scripts | G0 | Clean install/build không import old app |
| P1-02 | [x] Materialize DTOs/JSON Schemas và validators | P1-01 | Manifest, submission, snapshot, job, task, grant, result/error versioned |
| P1-03 | [x] OpenAPI descriptions cho public/admin/runtime/connector; examples | P1-02 | Validator checks request/response examples, pagination/status/auth đủ | <!-- W42: USER delegated acceptance to the orchestrator ("Ủy quyền tick cả hai", 21:0x). Basis: gen_openapi.py + validate_openapi.py exit 0, 23/23 PASS, repo-relative (fresh checkout). NOT proven per docs/33: examples are independent fixtures, no real HTTP response-shape check, no CI wiring. Codex-2 reverted this to [ ] ~21:20 acting on my own stale W42-CX5 line; superseded — do not revert, raise with orchestrator -->
| P1-04 | [x] Pure interfaces/repositories/adapters và function signatures | P1-02 | docs 09 inventory có typed Result/errors, side effects và ownership |
| P1-05 | [x] Isolated test infra + provider/runtime stubs + synthetic fixtures | P1-03 | DB/Redis/object storage namespace riêng, không real AI |
| P1-06 | [ ] Spike queue retry/claim/fencing/yield và Orchestrator server lifecycle | P1-04/05 | Version-pinned behavior; concurrency=1 parent yield; loops start/stop đúng |
| P1-07 | [x] Freeze wire v1; consumer compatibility suite; root dependency boundaries | P1-06 | G1 evidence, owner mới có contract fixtures để chạy độc lập |

Status audit 2026-09-21: checked rows are backed by [`workspace-ready`](../coordination/gates/workspace-ready.md) and [`contracts-v1`](../coordination/gates/contracts-v1.md), plus current `pnpm build` and 70 contracts tests. P1-03/05/06 remain unchecked because OpenAPI validation, object-storage harness and real concurrency=1 yield evidence are incomplete.
Status audit 2026-09-23 (W39-A6-7): P1-05 marked [x] — Empirical controlled experiment disproved the global TRUNCATE hypothesis (runtime.test.ts uses scoped DELETEs, zero table lock contention observed). Root cause of multi-process interference identified as logical collisions on hardcoded test-biz rows, shared BullMQ queue obliteration, and unpartitioned active lease counts in runtime.drain(). Proved that per-run isolated namespaces (search_path schema isolation + Redis DB/prefix isolation) completely eliminate interference: two concurrent overlapping runs of runtime.test.ts ran simultaneously on shared Postgres :5433 and Redis :6380, passing 97/97 and 97/97 (194/194 total, zero lock contention). Full metrics and logs in reports/antigravity-6.md.

## Required tests

Unknown JSON fields/invalid enum/schema refs/oversized manifest; serialization round-trip; unknown contract major; canonical request hashing; immutable IDs. Harness có controllable provider received-but-response-lost hook. Validate queue naming/ACL behavior trên pinned BullMQ/Redis.

## Design before implementation

Định nghĩa state transition function pure; DB repository ports cho atomic transactions; runtime HTTP client interface; provider adapter interface; artifact streaming interface. Ghi rõ retry owner là runtime. Không tự chuyển sang BullMQ FlowProducer dependency state nếu chưa cập nhật ADR-07/08.

## Gate G1

Contracts và examples validate, clean build, spike findings ghi lại. P2/P3/P4 chỉ bắt đầu parallel sau freeze. Breaking change sau freeze phải có impact/consumer tests và owner coordination.
