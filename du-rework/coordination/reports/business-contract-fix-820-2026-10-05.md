# BUSINESS-CONTRACT-FIX-820 — 2026-10-05

## Kết quả

Đã sửa trong phạm vi `business-list.ts`, admin connector route và một test offline mới. Không tạo migration, không thay đổi test hiện có để làm xanh, không commit hoặc tick.

## Contract business/version

- `services/orchestrator/migrations/0001_platform_v1.sql:23-34` tạo quan hệ vật lý `business_versions` với khóa `(business_id, version)`; không có bảng vật lý `businesses`.
- `services/orchestrator/migrations/0006_active_version.sql:6-25` thêm `is_active` và chỉ mục duy nhất cho business đang active.
- Query tại `services/orchestrator/src/modules/admin-read/business-list.ts` đã đọc dữ liệu từ `business_versions`; `businesses` chỉ là alias của derived table, không phải tên quan hệ vật lý. Đổi alias thành `business_page` và đổi các tham chiếu đi kèm để SQL thể hiện rõ contract, giảm khả năng hiểu alias là bảng.
- Khi trang và count query không có hàng, helper trả `rows: []`, `total: 0`; route trả HTTP 200 với `items: []`. Không thêm migration vì schema có quan hệ cần dùng.

## Connector route

- Thiếu `connectorManagement` tiếp tục fail-closed bằng `503 TEMPORARY_UNAVAILABLE` và thông báo `connector management store not configured`.
- GET `/api/v1/admin/connectors` giờ bắt lỗi transport `503` từ store và chuyển thành thông báo route-level cố định `connector management service is unavailable`; URL, ECONNREFUSED và chi tiết upstream không đi ra response. Lỗi HTTP khác đã được định kiểu (ví dụ lỗi hợp đồng `502`) giữ nguyên code/status.
- Chọn lỗi rõ ràng thay vì danh sách rỗng: connector service không truy cập được không chứng minh registry rỗng.

## Test và verification

Môi trường offline; connector `127.0.0.1:8099` được mô phỏng bằng `fetchImpl` ném ECONNREFUSED, không gọi service thật. Business empty-state test dùng Db query stub trả 0 hàng và kiểm tra cả page/count SQL đọc `business_versions`, không tham chiếu `FROM businesses`.

- `pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/business-contract-fix-820.test.ts tests/p745-connector-management-proxy.test.ts` — exit 0; 2 suites, 14 tests passed.
- `pnpm --filter @du/orchestrator typecheck` — exit 0 (`tsc --noEmit -p tsconfig.json`).
- `pnpm --filter @du/orchestrator test:unit` — exit 1; 191 suites passed, 4 failed, 11 skipped (206 total); 4,748 tests passed, 9 failed, 91 skipped (4,848 total). Failing suites ngoài phạm vi thay đổi: `migration-0032-rollback.test.ts`, `migration-verify-trap-fix.test.ts`, `admin-shell-session-lifecycle.test.ts`, `artifact-read-authorization.test.ts`. Không thay đổi hoặc điều tra các suite này trong packet này.

Không chạy PostgreSQL thật. Vì vậy test empty-state xác nhận contract truy vấn/route với executor offline và đối chiếu DDL trong migration; chưa phải bằng chứng tích hợp trên database vật lý đã migrate.
