# Checkpoint bàn giao DU Rework — 2026-09-21

Checkpoint này là điểm bắt đầu cho coordinator/Orca agent tiếp theo. Nó tổng hợp
trạng thái source, gate, test, giới hạn và lịch sử ownership sau khi ba agent
Claude Code, GitHub Copilot và Antigravity hoàn tất các workload đến
`WORKLOAD-REBALANCE-04`.

## 1. Cách tiếp quản nhanh

1. Checkout branch `codex/fix-workflow-builder` tại repository
   `C:\Users\gem\Documents\GitHub\dugate`.
2. Đọc file này, sau đó đọc bốn gate trong `coordination/gates/` và ba báo cáo
   trong `coordination/reports/`.
3. Xem `docs/02-architecture.md`, `docs/03-project-structure.md`,
   `docs/04-data-state.md`, `docs/09-queue-sdk.md` và task packet của phase sẽ
   tiếp tục.
4. Chạy `docker compose -f infra/docker-compose.yml up -d`, rồi chạy
   `pnpm build` và `pnpm test` từ `du-rework/` trước khi sửa code.
5. Không dùng source, DB, migration hoặc cấu hình runtime của DUGate ở root làm
   dependency. Root project chỉ là tài liệu tham khảo hành vi/API cũ.

## 2. Trạng thái Git và workspace tại checkpoint

- Repository branch: `codex/fix-workflow-builder`, đang theo dõi
  `origin/codex/fix-workflow-builder`.
- HEAD trước khi commit checkpoint: `cae5f48` (`feat: implement XML-based
  workflow builder engine with schema parsing and execution runtime`).
- Toàn bộ `du-rework/` hiện là cây **untracked** trong Git. Vì vậy Git chưa thể
  cung cấp lịch sử tác giả theo từng file. Cần commit nguyên cây source/spec cần
  giữ để agent/workspace khác nhận được.
- `du-rework/.gitignore` đã loại `node_modules/`, `dist/`, coverage, env và log.
  Workspace hiện có local `du-rework/node_modules` lớn nhưng không được commit.
- Ngoài `du-rework/`, repository còn có các thay đổi/untracked không thuộc lane
  này (`package-lock.json`, `AGENTS.md`, `_fix_types.py`, root `coordination/`,
  một số root docs/tsconfig). Không gộp hoặc xóa chúng khi chỉ xử lý DU Rework.
- Node được các agent dùng: Node 24; yêu cầu package là Node >=20, pnpm >=9.

## 3. Trạng thái agent cuối cùng

Orca vẫn có thể hiển thị `status: running` vì tiến trình TUI còn mở. Cả ba
terminal đã in final summary và không còn công việc triển khai đang chạy.

| Agent | Terminal cuối | Lane | Trạng thái chuẩn hóa | Kết quả chính |
|---|---|---|---|---|
| Claude Code | `term_e317c497-4c30-4250-aa13-3c046b0c4493` | Platform/contracts/SDK/Orchestrator/infra | `READY_FOR_INTEGRATION` cho minimal runtime slice | Bốn gate READY; contracts, observability, worker-sdk; Orchestrator submit → outbox → BullMQ → claim/checkpoint/complete/result trên PostgreSQL/Redis thật |
| GitHub Copilot | `term_42907cb4-7672-40d0-aac3-80e1358c5d78` | Connector + connector-client | `READY_FOR_INTEGRATION`, P3-06 còn cross-service | Connector durable runtime/management, PG/Redis adapters, provider transport, quota, ledger, usage outbox dispatcher, SSRF hardening, typed client |
| Antigravity | `term_83bbd1e7-2b4d-4c8c-ba18-3e487b8f6dea` | document-core + document-kit | `LANE_RELIABILITY_CLOSEOUT_COMPLETE` cho local lane | 6 action/28 variant, executable worker, traceability, validation, fencing, checkpoint replay, bounded input, local E2E |

Lịch sử giao việc và request ID nằm trong
`coordination/dispatch-receipts.md`. Các handle cũ có thể stale sau khi Orca
restart; luôn chạy `orca terminal list --json` trước khi gửi prompt mới.

## 4. Gate và bằng chứng hiện tại

| Gate | Trạng thái | Nội dung |
|---|---|---|
| `contracts-v1.md` | READY | `@du/contracts@0.1.0`, DTO/schema/state machine/queue/connector/runtime contracts; 70 tests |
| `workspace-ready.md` | READY | pnpm workspace và lockfile dùng chung, isolated infra |
| `sdk-ready.md` | READY | `@du/worker-sdk@0.1.0`; 23 tests |
| `runtime-ready.md` | READY | Minimal durable Orchestrator slice trên PostgreSQL `5433` và Redis `6380`; 6 tests |

Thay đổi contract sau khi gate READY phải ghi impact vào
`coordination/gates/contracts-v1.md`, cập nhật consumer fixtures và thông báo
lane owner. Queue job ID hiện là `du-{deliveryId}` với ký tự `:` được đổi thành
`-`; không được parse job ID, phải đọc `job.data`.

## 5. Trạng thái implementation theo phase

### P0 — Business/spec baseline: phần lớn đã có, metadata chưa đóng

- Có bộ tài liệu kiến trúc/API/operations trong `docs/01` đến `docs/15`.
- Có BRD cho sáu action, field dictionary, compatibility/variant matrix và 28
  BRD case trong `businesses/document-core/docs/`.
- Một số câu mô tả vẫn nói “planning only” dù source đã tồn tại. Cần audit và
  cập nhật tài liệu trước review/go-live.
- Checkbox trong `tasks/*.md` vẫn là `[ ]`; đây là backlog ban đầu, không phản
  ánh bằng chứng implementation hiện tại.

### P1 — Foundation/contracts: READY cho slice hiện có

- Workspace, contracts, observability, isolated PostgreSQL/Redis, schema
  validators và test harness đã chạy được.
- Chưa có OpenAPI artifact sinh/validate tự động hoàn chỉnh; hiện chủ yếu là
  Markdown spec và executable TypeScript schemas.

### P2 — Orchestrator: minimal durable vertical slice hoàn tất, phase đầy đủ còn thiếu

Đã có:

- Platform migration, DB layer, registry registration tối thiểu.
- Public submit/idempotency, operation GET/list/result.
- Transactional outbox, deterministic BullMQ dispatch và retry `due_at`.
- Runtime claim/lease/heartbeat/checkpoint/progress/complete/fail với fencing.
- Runtime/public auth tối thiểu và RFC 9457 errors.

Chưa có hoặc chỉ là slice tạm:

- Profile/admin/RBAC đầy đủ, API enable version chính thức.
- Artifact upload/finalize/access và object storage.
- Invocation grant, Connector management proxy, usage ingest/projection.
- Fan-out/join, human wait/resume, cancel, deadline, reconciliation.
- Webhook delivery/audit hoàn chỉnh, cursor emission thật.
- Standalone production entrypoint cho Orchestrator; hiện boot qua
  `createApp(...)`. Dev API-key fallback không phù hợp production.

### P3 — Connector: local/durable lane gần hoàn tất

- PG-owned migration/repositories, Redis quota, signed grants, input binding,
  invocation ledger/replay/UNKNOWN, management/runtime HTTP service, provider
  adapter/transport, lifecycle và Docker entrypoint đã có.
- Usage-outbox dispatcher có bounded batches, persisted retry/backoff/jitter,
  poison parking, idempotent ack và graceful drain.
- Provider egress có SSRF controls, redirect rejection, response size bounds và
  secret-safe errors.
- `@du/connector-client` đã có typed invoke/poll/wait/cancel behavior.
- P3-06 vẫn **PARTIAL** vì Orchestrator chưa có endpoint usage ingest/projection
  và artifact/session integration thật.

### P4 — Worker SDK/document-kit: local implementation READY, cross-service còn thiếu

- SDK có `defineBusiness`, runtime client, task context, BullMQ consumer,
  heartbeat/fencing/checkpoint/artifact/connector facades và graceful shutdown.
- Document kit có detector, parsers, converters, PDF split, ZIP safety utilities.
- API SDK cho fan-out/HITL/artifacts/grants đã có contract/client surface, nhưng
  các endpoint Orchestrator tương ứng chưa được triển khai và chưa có E2E thật.

### P5 — document-core: local lane hoàn tất

- 6 action: ingest, extract, analyze, transform, generate, compare.
- 28 variant được map máy kiểm tra từ BRD ID → manifest/schema → recipe → slot
  → output validator.
- Có strict provider-output validation, cancellation/lease-loss fencing,
  checkpoint replay, bounded inputs và local deterministic E2E.
- Worker executable có config validation, secret redaction và graceful signals.
- Chưa có multi-container E2E thực với Orchestrator + Connector. Image digest
  trong config/manifest còn là `sha256:placeholder-document-core-v1`.

### P6–P9

- P6 Admin UI: chưa triển khai.
- P7 extension proof/example-review: `businesses/example-review` mới là
  placeholder; chưa chứng minh add-business without platform code change.
- P8 release readiness/load/security/backup/runbooks: chưa triển khai như một
  phase end-to-end, dù từng lane đã có một số security/fault tests.
- P9 business backlog: chưa thuộc release đầu, chưa triển khai.

## 6. Kiểm chứng độc lập tại thời điểm bàn giao

Chạy ngày 2026-09-21 từ `du-rework/`, với hai container
`du-rework-postgres` và `du-rework-redis` healthy:

```text
pnpm build
PASS — 8/8 implementation workspaces compile

pnpm test
PASS — 38 suites, 380 tests passed
       Connector có 2 opt-in suites/2 test bị skip trong default run

pnpm lint
PASS — contracts, observability, worker-sdk strict noEmit
LIMIT — năm workspace còn lại chưa khai báo script lint
```

Chi tiết default test:

| Workspace | Kết quả |
|---|---:|
| contracts | 70 |
| observability | 16 |
| document-kit | 46 |
| worker-sdk | 23 |
| connector-client | 2 |
| connector | 29 pass, 2 opt-in skip |
| document-core | 188 |
| orchestrator | 6 |

Connector durable verification chạy riêng từ repository root:

```powershell
$env:CONNECTOR_INTEGRATION='1'
& '.\node_modules\.bin\jest.cmd' `
  --config '.\du-rework\services\connector\jest.config.cjs' `
  --runInBand --detectOpenHandles `
  durable-integration.test.ts black-box-durable.test.ts
```

Kết quả: 2 suites, 3 tests pass với PostgreSQL `5433`, Redis `6380` và local
mock provider. Default Connector suite với `--detectOpenHandles`: 6 suites,
29 tests pass; 2 opt-in suites skip.

## 7. Inconsistency/stale metadata cần biết

Không dùng các dòng sau làm source of truth mà không kiểm tra gate/code:

- `coordination/reports/antigravity.md` vẫn ghi `runtime-ready` PENDING vì báo
  cáo được viết trước khi Claude publish gate. Trạng thái đúng tại checkpoint là
  READY, nhưng Antigravity chưa chạy real runtime E2E sau gate.
- `coordination/reports/copilot.md` còn ghi root lockfile `pg`/`ioredis` pending.
  Claude xác nhận lockfile hiện đã resolve `pg@8.23.0`, `ioredis@5.11.1` và
  `@types/pg@8.23.1`.
- `coordination/reports/claude.md` có heading đầu file `IN_PROGRESS`, nhưng phần
  cập nhật cuối đã publish runtime gate và ghi `READY_FOR_INTEGRATION` cho slice.
- Nhiều package README và root `du-rework/README.md` vẫn nói planning
  placeholder/TODO dù implementation đã tồn tại.
- Tất cả checkbox task trung tâm vẫn chưa tick. Dùng evidence matrix trong ba
  lane report và phần trạng thái phase của checkpoint này cho tới khi thực hiện
  một audit cập nhật task có kiểm chứng.
- `packages/document-kit/src/` và `packages/worker-sdk/src/` hiện có một số file
  `.js`, `.d.ts`, `.map` cạnh `.ts`. Cần quyết định đó là artifact build cần xóa
  hay output có chủ ý trước khi commit; `du-rework/.gitignore` chỉ ignore
  `dist/`, không ignore generated files nằm trong `src/`.

## 8. Ownership để tiếp tục mà không conflict

Nếu tái sử dụng ba agent cũ, giữ ranh giới sau cho tới khi coordinator chủ động
đổi ownership:

| Owner | Paths |
|---|---|
| Claude/platform | root config/lock trong `du-rework`, `packages/contracts`, `packages/observability`, `packages/worker-sdk`, `services/orchestrator`, `infra`, shared `tests`, central `tasks`, gates và Claude report |
| Copilot/connector | `services/connector`, `packages/connector-client`, Copilot report/request |
| Antigravity/document | `businesses/document-core`, `packages/document-kit`, Antigravity report/request |
| Chưa gán | `businesses/example-review` |

Các agent dùng chung một checkout; không reset/clean/stash/rebase và không sửa
file ngoài lane khi agent khác đang làm. Root lockfile và frozen contracts chỉ
có một integration owner tại một thời điểm.

## 9. Thứ tự công việc đề xuất cho phiên tiếp theo

1. **Commit-safe audit**: loại/quyết định generated files trong `src`, cập nhật
   README/report/task status stale, bảo đảm chỉ source/spec/lockfile cần thiết
   được commit.
2. **P2 integration boundary**: triển khai artifact APIs/storage, invocation
   grants và usage ingest/projection trong Orchestrator. Đây là blocker trực
   tiếp cho Connector và Worker SDK E2E.
3. **Cross-service E2E tối thiểu**: boot Orchestrator + Connector +
   document-core worker, register/enable manifest, submit một action dùng
   provider, chờ result, xác minh checkpoint/artifact/usage/idempotency và
   restart recovery.
4. **Hoàn thiện P2 runtime**: cancel/deadline/reconciliation trước fan-out/HITL;
   sau đó thêm join/wait/resume với test concurrency=1.
5. **P7 extension proof**: implement `example-review` chỉ bằng public contracts
   và SDK; chứng minh đăng ký business mới không sửa Orchestrator/Connector.
6. **P6 Admin và P8 production readiness**: chỉ bắt đầu sau khi runtime và
   cross-service boundary ổn định; bổ sung AWS deployment/runbooks/load/backup,
   bỏ dev fallback và placeholder digest.

Điểm acceptance gần nhất nên là: một compose/test harness chạy được luồng
public submit → Orchestrator outbox → document-core BullMQ worker → Connector
provider invocation → artifact/result + usage projection, có restart và
idempotency evidence. Khi đạt mốc đó, cập nhật gate mới và central task status
dựa trên lệnh test thực tế.

## 10. Tài liệu nguồn để truy vết

- Kiến trúc/spec: `docs/01-product-scope.md` đến `docs/15-decisions.md`.
- Phase plan: `tasks/README.md`, `tasks/P0-business-specs.md` đến
  `tasks/P9-business-backlog.md`.
- Gate: `coordination/gates/*.md`.
- Agent reports: `coordination/reports/{claude,copilot,antigravity}.md`.
- Workload packets: `coordination/WORKLOAD-REBALANCE-01.md` đến `-04.md`.
- Dispatch history: `coordination/dispatch-receipts.md`.
- Monitoring history: `coordination/MONITORING-LOG.md`.

