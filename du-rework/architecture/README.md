# DUGate Rework — Hồ sơ kiến trúc và đánh giá trước go-live

Phiên bản tài liệu: 0.1 · Ngày đối chiếu: 20/09/2026 · Trạng thái: **đề xuất kiến trúc, chưa chứng nhận production-ready**.

Bộ hồ sơ này phục vụ hội đồng kỹ thuật, chủ sản phẩm, đội tích hợp và vận hành. Phạm vi là ứng dụng mới trong `du-rework`: một cổng API xử lý tài liệu bằng parser/OCR/LLM, có quản trị tập trung, các business worker độc lập và Connector nội bộ. Không lấy mô tả kiến trúc của project gốc làm kiến trúc của hệ thống mới.

## Đường dẫn đọc

| Tài liệu | Nội dung | Người đọc chính |
|---|---|---|
| [01 — Tổng quan chức năng](01-product.md) | Bài toán, sáu core API, workflow, profile, phạm vi | Hội đồng, BA, sản phẩm |
| [02 — Kiến trúc ứng dụng](02-application.md) | Ranh giới ba tầng, luồng xử lý, dữ liệu, tính đúng đắn, mở rộng business | Kiến trúc sư, developers |
| [03 — Public API và hướng dẫn tích hợp](03-public-api.md) | Auth, upload, submit, polling, kết quả, cancel/resume, lỗi | Đội tích hợp |
| [04 — Sáu core API](04-core-api.md) | Input/output, 28 biến thể, ví dụ cho từng đầu API | BA, đội tích hợp, QA |
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

Nguồn thiết kế mới: [docs 01–15](../docs/01-product-scope.md), [public spec](../docs/06-public-api.md), [runtime spec](../docs/07-internal-api.md), [Connector spec](../docs/08-connector-api.md), [business spec](../docs/10-document-core.md). Nguồn đối chiếu implementation: [contracts](../packages/contracts/src/operations.ts), [business input/output](../businesses/document-core/src/types/actions.ts), [Connector HTTP](../services/connector/src/http/server.ts).

Project gốc chỉ được tham khảo về chức năng/API: [registry](../../lib/endpoints/registry.ts), [hướng dẫn tích hợp](../../docs/DU_INTEGRATION_GUIDE.md). Ví dụ cũ như `name/done/result`, đường dẫn `/extract`, hay biến thể `id-card`, `fact-check` không tự động trở thành contract mới.

Khi chốt release: ghi commit SHA/image digest, freeze OpenAPI và manifest schemas, đồng bộ ví dụ trong hồ sơ với contract tests, cập nhật trạng thái từng gate. Bộ hồ sơ này bổ sung góc nhìn review/go-live; không thay thế các task implementation và không tự cho phép cutover production.
