# 14 — Bản đồ tài liệu và nguồn sự thật

Mục tiêu của bộ `architecture/` là cung cấp **một đường đọc thống nhất cho toàn hệ thống**. Repo còn giữ `docs/`, `tasks/` và `coordination/` vì chúng có chức năng khác nhau; không sao chép toàn bộ receipt vào hồ sơ kiến trúc.

## 1. Dùng tài liệu nào?

| Câu hỏi | Điểm bắt đầu | Đối chiếu bắt buộc |
|---|---|---|
| Hệ thống gồm gì, component nào sở hữu gì? | [10](10-current-system.md), [11](11-subprojects.md) | `package.json`, entrypoint, code service/worker. |
| Request đi qua đâu, dữ liệu nằm đâu? | [12](12-flows-and-data.md) | Route, module, SQL migrations, contract schemas. |
| Chạy/deploy/khôi phục ra sao? | [13](13-deployment-and-operations.md), [infra proposal](../infra/deployment-architecture.md) | Env/Compose/Dockerfile hiện tại và drill/receipt của môi trường đích. |
| Hành vi API mong muốn là gì? | [docs/06](../docs/06-public-api.md), [docs/07](../docs/07-internal-api.md), [docs/08](../docs/08-connector-api.md), [docs/39](../docs/39-legacy-parity-contract.md) | `@du/contracts`, router code, contract test; lưu ý ngày snapshot. |
| Dùng API hiện tại thế nào? | [Public examples](17-public-api-examples.md), [internal examples](18-internal-api-examples.md) | Route/schema của build triển khai và credential/profile thực. |
| Business action cụ thể làm gì? | [document-core docs](../businesses/document-core/docs/), README từng business | Manifest, handler, tests. |
| Đã implement/verify/accept đến đâu? | [tasks/README](../tasks/README.md) và task row | Raw test receipt và [independent review](../coordination/reports/review.md) mới nhất. |
| Vì sao có quyết định kiến trúc? | [docs/15 decision log](../docs/15-decisions.md), [01–09](README.md) | Ngày/authority của ADR và source mới nhất. |

## 2. Phân loại nội dung cũ trong `docs/`

| Nhóm | Ví dụ | Cách sử dụng |
|---|---|---|
| Product/architecture/spec | `00–12`, `14–16`, `20–21`, `37–39` | Yêu cầu hoặc contract mục tiêu. Một số file vừa chứa trạng thái code cũ; kiểm ngày và source trước khi trích dẫn như hiện trạng. |
| Hướng dẫn vận hành/kiểm thử | `12b`, `13`, `17`, `22` | Quy trình và tiêu chí; chú ý nhãn draft/accepted của từng file. |
| Audit/evidence/snapshot | `18–19`, `23–36` | Lịch sử quyết định, traceability, test inventory, run queue và acceptance ledger; không coi thống kê cũ là current status. |

Các số file là cách đặt tên lịch sử, không chứng minh thứ tự ưu tiên hay hiệu lực. Ví dụ `docs/06-public-api.md` còn hàng “chưa implement” cho legacy route ở snapshot cũ, trong khi [server hiện tại](../services/orchestrator/src/server.ts) đã gọi `handleLegacyRoute`; kết luận về parity phải dựa route + test + contract hiện hành, không chỉ tiêu đề bảng.

## 3. Quy tắc cập nhật bộ kiến trúc này

1. Thay đổi boundary/component: cập nhật [10](10-current-system.md) và [11](11-subprojects.md) cùng code/manifest liên quan.
2. Thay wire, state hoặc storage: cập nhật contract/spec owner trong `docs/`, [12](12-flows-and-data.md), consumer bị ảnh hưởng và test. Không sửa spec chỉ để hợp thức hóa bug.
3. Thay topology, auth hoặc secret path: cập nhật [13](13-deployment-and-operations.md), infra/runbook và gate test cần thiết.
4. Ghi rõ `mục tiêu`, `source hiện có`, `đã kiểm chứng` khi ba mức này khác nhau. Sơ đồ code không là receipt; receipt offline không là live deployment proof.
5. Task/acceptance status chỉ cập nhật theo quy trình `tasks/` và `coordination/`. Bộ `architecture/` dẫn liên kết, không nhân bản số lượng task/test pass theo thời gian.

## 4. Phạm vi chưa mô tả ở mức từng hàm

Bộ này là tài liệu **toàn hệ thống**. Cây từng file và trách nhiệm chi tiết của hai service nằm trong [Connector architecture](../services/connector/CODE-ARCHITECTURE.md) và [Orchestrator architecture](../services/orchestrator/CODE-ARCHITECTURE.md). Business và package có README/source riêng; khi cần thay đổi một module, đọc tài liệu đó cùng code và tests tương ứng.
