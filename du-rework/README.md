# DU Rework — đặc tả và implementation đang phát triển

Trạng thái ngày 2026-09-21: **đã có các slice implementation chạy được, chưa hoàn tất end-to-end/release**. Xem [implementation status](coordination/IMPLEMENTATION-STATUS.md) để biết phase/task nào đã có bằng chứng executable, phần nào mới partial và các gap còn mở; [checkpoint bàn giao](coordination/CHECKPOINT-2026-09-21.md) giữ bối cảnh chi tiết tại mốc ban đầu.

Xây dựng mới trong `du-rework/`. Repository DUGate bên ngoài thư mục này chỉ là tài liệu tham khảo hành vi; không import source, dùng database, chạy migration hoặc sửa cấu hình của hệ thống cũ.

## Mục tiêu đã thống nhất

- Ba loại service: **Orchestrator**, **Business Worker**, **Connector**.
- Orchestrator gồm public API, Admin, Business Registry, profile và điều phối operation nền; không có Coordinator service độc lập.
- `document-core` là business đầu tiên, sở hữu cả 6 action ingest/extract/analyze/transform/generate/compare.
- Xử lý document nội bộ là thư viện `document-kit`, được chạy trong Business Worker.
- Mỗi business mới có worker deployment/queue/version riêng; đăng ký manifest để xuất hiện trong Admin và được gán vào profile.
- Thêm business theo contract hiện hữu không yêu cầu build lại Orchestrator/Connector. Provider protocol mới hoặc loại UI mới có thể cần mở rộng platform.
- Workspace hiện có package manifests, TypeScript source, migrations, container test infra và Jest suites cho contracts, SDK, Connector, Orchestrator, document-kit và document-core. Phạm vi đã chạy vẫn là các package/local slice; chưa suy ra multi-service hoặc production readiness.

## Đọc theo thứ tự

1. [Phạm vi sản phẩm và business requirements](docs/01-product-scope.md)
2. [Kiến trúc và quyết định thiết kế](docs/02-architecture.md)
3. [Cấu trúc subproject và dependency](docs/03-project-structure.md)
4. [Data model và state machine](docs/04-data-state.md)
5. [Manifest và đăng ký business](docs/05-business-registry.md)
6. [Public API](docs/06-public-api.md)
7. [Admin và Runtime API](docs/07-internal-api.md)
8. [Connector API](docs/08-connector-api.md)
9. [Queue, SDK và interface functions](docs/09-queue-sdk.md)
10. [Business document-core](docs/10-document-core.md)
11. [Admin UX](docs/11-admin-ux.md)
    - [Yêu cầu giám sát operation, token và chi phí LLM cho người trực](docs/admin-ops-monitoring-cost.md)
12. [Vận hành, bảo mật và capacity](docs/12-operations.md)
13. [Test catalog và acceptance gates](docs/13-test-strategy.md)
14. [Reference mapping và compatibility](docs/14-reference-compatibility.md)

## Roadmap và trạng thái thực hiện

- [Roadmap, task dependencies và cách giao việc](tasks/README.md)
- [Task packet dùng giao agent](tasks/AGENT-TASK-TEMPLATE.md)
- [Decision log và giả định cần xác nhận](docs/15-decisions.md)

Task checkbox chỉ được tick khi toàn bộ acceptance của row có bằng chứng executable hoặc gate. Row unchecked có thể đã có implementation một phần; xem cột gap trong [implementation status](coordination/IMPLEMENTATION-STATUS.md). Nội dung trong code fences của bộ docs vẫn là **spec/example** trừ khi tài liệu dẫn rõ package/test hoặc gate đã chạy.

## Definition of done tổng thể còn lại

1. Sáu action của document-core chạy qua connector mock, có profile/operation/artifact đầy đủ.
2. Deploy một business mẫu mới, đăng ký, gán profile và gọi được mà image digest Orchestrator/Connector không đổi.
3. Các thử nghiệm mất kết nối, duplicate delivery, restart giữa bước, cancel/resume và billing dedup đạt yêu cầu.
4. Có số liệu benchmark trên cấu hình ghi rõ; không tuyên bố khả năng chịu tải từ số replica đơn thuần.
5. Các thay đổi code/deploy chỉ diễn ra khi người dùng yêu cầu bước triển khai tiếp theo.
