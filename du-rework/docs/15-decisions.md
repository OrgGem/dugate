# Decision log và assumptions

Trạng thái: baseline cho kế hoạch, chưa phải deployment đã kiểm chứng. Thay đổi quyết định phải cập nhật docs, contract và task impacted cùng lúc.

| ID | Quyết định | Lý do | Revisit trigger |
|---|---|---|---|
| ADR-01 | Ba service roles; coordinator gộp Orchestrator | Đúng phạm vi và giảm deployment | API/runtime cần lifecycle riêng |
| ADR-02 | document-kit là package trong workers | Ít hop, business tự chủ | Parser resource cost cần pool riêng |
| ADR-03 | document-core là một business sáu actions | Scale/deploy theo business | Một action SLA/resource độc lập rõ |
| ADR-04 | Registry manifest immutable, queue exact version | Plugin business và draining an toàn | Contract major rollout |
| ADR-05 | BullMQ commands + Runtime HTTP reports | Không thêm reply/event bus phức tạp | Runtime HTTP write throughput đo được là bottleneck |
| ADR-06 | Worker không có platform DB credential | Không coupling schema và giảm quyền | Business DB riêng, không platform write |
| ADR-07 | Runtime owns generic checkpoints/dependencies | Worker code quyết định steps, state durable | Business workflows vượt generic runtime contract |
| ADR-08 | DB outbox + runtime retry + fencing | Tránh lost job và duplicate side effects | Không thay vì đơn giản hóa thiếu reliability |
| ADR-09 | Connector owns credentials/config/usage ledger | Business-independent adapter boundary | Provider adapter mới |
| ADR-10 | S3-compatible primary storage | Multi-container/host correctness | Local mode chỉ test utility |
| ADR-11 | Same repo, independent workspaces/images | Chia agent dễ, không distributed repo overhead | Team/release governance yêu cầu tách |
| ADR-12 | No automatic production migration | Hệ thống hiện tại chỉ tham khảo | User yêu cầu migration/cutover |
| ADR-13 | pnpm workspace (not npm) for `du-rework/` | npm từ chối protocol `workspace:*` trong manifest của các lane peer (EUNSUPPORTEDPROTOCOL); pnpm resolve native qua `pnpm-workspace.yaml`. Một `pnpm-lock.yaml` duy nhất tại root; chỉ platform lane chạy root install. Root scripts: `pnpm build|test|lint|clean` (recursive). | Toolchain hợp nhất về npm (khi npm hỗ trợ `workspace:*`) hoặc yêu cầu monorepo tool khác |

## Assumptions có default để tiến hành

| Topic | Default kế hoạch | Cần xác nhận trước |
|---|---|---|
| Auth | Local admin + API keys + service identities | P0; OIDC enterprise có thể phase riêng |
| Tenant | Default tenant, scope fields từ đầu | P0 nếu multi-tenant UI là bắt buộc |
| Provider | Generic multipart/json + mock | P0 connector protocol inventory |
| Workflow mới | example-review proof trước workflow ngành | P7/P9 chọn business production tiếp theo |
| Legacy API | Paths giữ, exact payload compatibility chưa cam kết | P0 characterization matrix |
| SLO/load | Chưa có production SLA; benchmark target ghi riêng | P0 workload budget |
| Runtime versions | Pin phiên bản supported tại implementation | P1 compatibility spike |
| Retention | Configurable; cửa sổ dedup ≥ retry/replay | P0 vận hành/dữ liệu policy |

## Evidence sources

Repository mapping nằm [reference-compatibility](14-reference-compatibility.md). BullMQ semantics tham khảo tài liệu chính thức đã đối chiếu ngày 2026-09-20: [idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs), [process-step jobs](https://docs.bullmq.io/patterns/process-step-jobs), [production](https://docs.bullmq.io/guide/going-to-production). Documentation mới có thể khác phiên bản dependency sẽ pin; P1 phải xác minh API thực dùng.
