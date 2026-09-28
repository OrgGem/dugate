
## 2026-09-25 19:58:00 +07:00 — USER DECISION GATE Cycle A1: DATA-00-M §6 SIGNED

- User ký toàn bộ giá trị draft §6 (packages/contracts runtime.ts): total ceiling **8GiB**, part cap/floor wire **64MiB** / **64MiB+1**, geometry server-fix (partCount = ceil(size/partSize)), inline threshold **1MiB**, TTL sweeper là lưới cleanup chính thức.
- **Auth deviation chấp thuận chính thức**: part/complete/abort authorize qua artifact row (owner/epoch/state/tenant), KHÔNG yêu cầu taskId trong request schema.
- **Cross-process resume: KHÔNG bắt buộc** cho DATA-04. Upload token mới mỗi call + orphan sweep là thiết kế được duyệt; revisit nếu live test lộ lỗ hổng cleanup.
- Hệ quả dispatch (Cycle A2+): (a) Qwen-5/lane public route được phép đặt tên env cho `multipartLimits` theo const đã ký; (b) lane nào giữ '§6 chưa ký' làm hold → bỏ hold đó, chỉ còn hold live evidence; (c) G-ADMIN-OPS xếp SAU live DATA gate, không mở lane Admin từ Cycle A2; roster hiện tại dồn cho DATA/SEC.
- chữ ký này KHÔNG đóng gate: DATA-02/DATA-04 vẫn cần receipt live PG/S3 + RSS đo được. Mức SPECIFIED/policy giờ đã đủ cho IMPLEMENTED tiếp theo.
