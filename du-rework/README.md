# DU Rework — kế hoạch và đặc tả triển khai

Trạng thái: **PLANNING ONLY — chưa có implementation**. Ngày: 2026-09-20.

Xây dựng mới trong `du-rework/`. Repository DUGate bên ngoài thư mục này chỉ là tài liệu tham khảo hành vi; không import source, dùng database, chạy migration hoặc sửa cấu hình của hệ thống cũ.

## Mục tiêu đã thống nhất

- Ba loại service: **Orchestrator**, **Business Worker**, **Connector**.
- Orchestrator gồm public API, Admin, Business Registry, profile và điều phối operation nền; không có Coordinator service độc lập.
- `document-core` là business đầu tiên, sở hữu cả 6 action ingest/extract/analyze/transform/generate/compare.
- Xử lý document nội bộ là thư viện `document-kit`, được chạy trong Business Worker.
- Mỗi business mới có worker deployment/queue/version riêng; đăng ký manifest để xuất hiện trong Admin và được gán vào profile.
- Thêm business theo contract hiện hữu không yêu cầu build lại Orchestrator/Connector. Provider protocol mới hoặc loại UI mới có thể cần mở rộng platform.
- Bước hiện tại chỉ tạo Markdown, structure dự kiến và task; chưa tạo package manifests, source, migrations, containers hay test executable.

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
12. [Vận hành, bảo mật và capacity](docs/12-operations.md)
13. [Test catalog và acceptance gates](docs/13-test-strategy.md)
14. [Reference mapping và compatibility](docs/14-reference-compatibility.md)

## Kế hoạch thực hiện sau này

- [Roadmap, task dependencies và cách giao việc](tasks/README.md)
- [Task packet dùng giao agent](tasks/AGENT-TASK-TEMPLATE.md)
- [Decision log và giả định cần xác nhận](docs/15-decisions.md)

Mọi task đang ở trạng thái TODO. Nội dung trong code fences là **spec**, không phải source đã chạy. Các README dưới `services/`, `businesses/`, `packages/`, `infra/`, `tests/` là bản mô tả subproject dự kiến.

## Definition of done tổng thể của implementation tương lai

1. Sáu action của document-core chạy qua connector mock, có profile/operation/artifact đầy đủ.
2. Deploy một business mẫu mới, đăng ký, gán profile và gọi được mà image digest Orchestrator/Connector không đổi.
3. Các thử nghiệm mất kết nối, duplicate delivery, restart giữa bước, cancel/resume và billing dedup đạt yêu cầu.
4. Có số liệu benchmark trên cấu hình ghi rõ; không tuyên bố khả năng chịu tải từ số replica đơn thuần.
5. Các thay đổi code/deploy chỉ diễn ra khi người dùng yêu cầu bước triển khai tiếp theo.
