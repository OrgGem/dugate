# DUGate Rework — Hồ sơ kiến trúc và đánh giá trước go-live

## Bắt đầu với tài liệu toàn hệ thống

Bộ **kiến trúc hiện hành** dưới đây tổng hợp toàn bộ workspace từ source và package manifests ngày 2026-10-02. Đọc theo thứ tự; mỗi trang liên kết về code/spec gốc. Sơ đồ mô tả implementation và topology mục tiêu có nhãn riêng, không tự xác nhận release.

| Trang | Nội dung |
|---|---|
| [10 — Kiến trúc hệ thống hiện hành](10-current-system.md) | Vai trò Orchestrator, Business Worker, Connector; hạ tầng và ranh giới sở hữu. |
| [11 — Cấu trúc subproject](11-subprojects.md) | Hai service, ba business, sáu shared package; cây workspace và dependency graph. |
| [12 — Luồng, dữ liệu và contract](12-flows-and-data.md) | API/auth, submit→queue→worker→result, Connector/usage, artifact và data ownership. |
| [13 — Triển khai và vận hành](13-deployment-and-operations.md) | Local/test so với production mục tiêu, startup, bảo mật, quan sát và giới hạn kiểm chứng. |
| [14 — Bản đồ tài liệu](14-document-governance.md) | Vai trò của `docs/`, `tasks/`, `coordination/`; cách nhận biết spec, source và evidence. |
| [15 — Năng lực nghiệp vụ](15-business-capabilities.md) | Sáu action/31 variant của document-core, example-review, lc-checker và cách thêm business. |
| [16 — Catalog giao tiếp](16-interface-catalog.md) | Public, runtime, admin và Connector API theo nhóm; identity và version boundary. |
| [17 — Public API và ví dụ](17-public-api-examples.md) | Request/response có thể dùng làm mẫu cho submit, poll, result và lỗi. |
| [18 — API nội bộ và Connector](18-internal-api-examples.md) | Auth, runtime lease, usage, admin và invocation qua Connector. |

Sơ đồ code riêng của [Orchestrator](../orchestrator/services/orchestrator/CODE-ARCHITECTURE.md) và [Connector](../orchestrator/services/connector/CODE-ARCHITECTURE.md) đi sâu đến thư mục/module từng service.

Hai hình minh họa có ở [kiến trúc thành phần](diagrams/system-components.svg) và [topology deployment](diagrams/deployment-topology.svg); bản [draw.io của kiến trúc](diagrams/system-components.drawio) và [draw.io của deployment](diagrams/deployment-topology.drawio) có thể mở/chỉnh sửa bằng diagrams.net.

## Hồ sơ thiết kế và go-live ban đầu (01–09)

Các trang 01–09 bên dưới là hồ sơ thiết kế/đánh giá lập ngày 20/09/2026. Chúng vẫn hữu ích để hiểu mục tiêu và quyết định lịch sử, nhưng có thể khác source hiện tại. Khi cần mô tả code đang tồn tại, bắt đầu từ bộ 10–18 ở trên.

Phiên bản tài liệu: 0.1 · Ngày đối chiếu: 20/09/2026 · Trạng thái: **đề xuất kiến trúc, chưa chứng nhận production-ready**.

Bộ hồ sơ này phục vụ hội đồng kỹ thuật, chủ sản phẩm, đội tích hợp và vận hành. Phạm vi là ứng dụng mới trong `du-rework`: một cổng API xử lý tài liệu bằng parser/OCR/LLM, có quản trị tập trung, các business worker độc lập và Connector nội bộ. Không lấy mô tả kiến trúc của project gốc làm kiến trúc của hệ thống mới.

## Đường dẫn đọc

| Tài liệu | Nội dung | Người đọc chính |
|---|---|---|
| [01 — Tổng quan chức năng](01-product.md) | Bài toán, sáu core API, workflow, profile, phạm vi | Hội đồng, BA, sản phẩm |
| [02 — Kiến trúc ứng dụng](02-application.md) | Ranh giới ba tầng, luồng xử lý, dữ liệu, tính đúng đắn, mở rộng business | Kiến trúc sư, developers |
| [03 — Public API và hướng dẫn tích hợp](03-public-api.md) | Auth, upload, submit, polling, kết quả, cancel/resume, lỗi | Đội tích hợp |
| [04 — Sáu core API](04-core-api.md) | Input/output, 31 biến thể, ví dụ cho từng đầu API | BA, đội tích hợp, QA |
| [05 — Admin và giao tiếp nội bộ](05-internal-api.md) | Registry, profile, runtime, Connector, request/response | Developers, vận hành |
| [06 — Deploy AWS trên EC2](06-aws-deployment.md) | Một account, VPC, EC2 riêng, network, IAM, HA, triển khai | Cloud, DevOps, security |
| [07 — Scale và năng lực tải](07-capacity.md) | Công thức sizing, autoscaling, backpressure, benchmark, chi phí | Kiến trúc sư, vận hành |
| [08 — Bảo mật và vận hành](08-operations.md) | Trust boundaries, observability, backup, phục hồi, runbook | Security, SRE |
| [09 — Hồ sơ bảo vệ và go-live](09-readiness.md) | Quyết định, hạn chế hiện tại, tiêu chí nghiệm thu, câu hỏi bảo vệ | Hội đồng, release owner |

Đọc 01 → 02 → 06 → 07 → 09 khi trình bày kiến trúc; dùng 03 → 04 cho tích hợp. Các sơ đồ Mermaid nằm ngay trong Markdown, không phụ thuộc dịch vụ vẽ bên ngoài.

## Quy ước về độ tin cậy

- **Mục tiêu**: thiết kế cần đạt; chưa đồng nghĩa endpoint đã chạy được.
- **Quan sát source**: đã thấy file/code tại thời điểm đối chiếu; không chứng minh chạy thành công trong môi trường thật.
- **Đã kiểm chứng**: phải có command, môi trường, kết quả và artifact bằng chứng. Hồ sơ này không tự nâng báo cáo unit test của agent thành kiểm chứng E2E.
- Các ví dụ API là **contract mục tiêu để review**, dùng dữ liệu giả; chưa phải cam kết tương thích wire với bản đang phát triển. Các điểm chưa thống nhất được ghi trong [bảng chênh lệch](09-readiness.md).

## Nguồn và quản lý thay đổi

Nguồn thiết kế mới: [docs 01–15](../docs/01-product-scope.md), [public spec](../docs/06-public-api.md), [runtime spec](../docs/07-internal-api.md), [Connector spec](../docs/08-connector-api.md), [business spec](../docs/10-document-core.md). Nguồn đối chiếu implementation: [contracts](../orchestrator/packages/contracts/src/operations.ts), [business input/output](../businesses/document-core/src/types/actions.ts), [Connector HTTP](../orchestrator/services/connector/src/http/server.ts).

Project gốc chỉ được tham khảo về chức năng/API: [registry](../../lib/endpoints/registry.ts), [hướng dẫn tích hợp](../../docs/DU_INTEGRATION_GUIDE.md). Ví dụ cũ như `name/done/result`, đường dẫn `/extract`, hay biến thể `id-card`, `fact-check` không tự động trở thành contract mới.

Khi chốt release: ghi commit SHA/image digest, freeze OpenAPI và manifest schemas, đồng bộ ví dụ trong hồ sơ với contract tests, cập nhật trạng thái từng gate. Bộ hồ sơ này bổ sung góc nhìn review/go-live; không thay thế các task implementation và không tự cho phép cutover production.
