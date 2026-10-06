# RFX-14 — integrity scanner deadline cancellation

- **Task:** RFX-14, `tasks/ORCH-REVIEW-FIXES-2026-10-02.md`.
- **Thời điểm:** 2026-10-02T23:47:06+07:00.
- **Phạm vi sửa:** `services/orchestrator/src/modules/artifacts/integrity-scanner.ts` và `services/orchestrator/tests/artifact-integrity-scanner.test.ts`. Receipt này là đường dẫn được dispatch chỉ định. Không sửa file khác, không commit, không tick gate.

## Thay đổi

- `withDeadline` tạo `AbortController` cho từng thao tác, chuyển signal xuống nguồn scan và chỉ trả kết quả timeout/abort sau khi thao tác đã dừng. S3 stream đang mở vẫn được `destroy()`.
- Adapter PostgreSQL dùng pooled client riêng cho từng query, `SET LOCAL statement_timeout` theo `timeoutMs`, đóng kết nối khi signal abort để dừng query/đọc `bytea`, sau đó loại client khỏi pool. `timeoutMs` đã là cấu hình của `ArtifactIntegrityScanOptions`; giá trị này nay được truyền tới từng query và được kiểm tra trước khi đưa vào SQL.
- Single-flight theo source; các adapter tạo từ cùng một pool dùng chung gate. Tick chồng trả summary `SCAN_ABORTED`, gọi `onSkippedTick` nếu có và ghi một warning không chứa dữ liệu artifact. Gate được giữ cho tới khi thao tác nền đã settle.

## Kiểm chứng

Môi trường: Jest offline với fake PostgreSQL client và in-memory S3 facade; không dùng PostgreSQL/Redis/S3 thật, không có namespace live. Focused tests kiểm tra bộ đếm query/legacy blob read đang mở về 0 trước khi nhận timeout summary, đóng và release client khi hủy, `statement_timeout` ở count/page/blob query, stream S3 bị destroy, và tick chồng không khởi chạy query mới (kể cả hai adapter cùng pool).

| CWD | Lệnh literal | Exit code | Kết quả |
| --- | --- | ---: | --- |
| `D:\Git\dugate\du-rework\services\orchestrator` | `pnpm exec jest --runInBand tests/artifact-integrity-scanner.test.ts` | 0 | 1 suite passed; 11/11 tests passed. |
| `D:\Git\dugate\du-rework\services\orchestrator` | `pnpm exec tsc --noEmit -p tsconfig.json` | 0 | Không có lỗi TypeScript. |
| `D:\Git\dugate` | `git diff --check -- du-rework/services/orchestrator/src/modules/artifacts/integrity-scanner.ts du-rework/services/orchestrator/tests/artifact-integrity-scanner.test.ts` | 0 | Không có lỗi whitespace; Git chỉ cảnh báo LF/CRLF của working copy. |

**Raw output của lần chạy cuối:**

```text
Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
Snapshots:   0 total
Time:        5.581 s
Ran all test suites matching tests/artifact-integrity-scanner.test.ts.
```

`tsc --noEmit` không in stdout/stderr, exit code 0. Raw output được lưu ngay trong receipt này, không có file log riêng.

## Giới hạn còn lại

- Chưa chạy live `pg_stat_activity`; bằng chứng query đang mở là bộ đếm của fake client trong focused test.
- `ArtifactStorageFacade.openRead` không nhận `AbortSignal`. Nếu chính lời gọi lấy stream không bao giờ resolve, scanner sẽ giữ scan hiện tại ở trạng thái in-flight và tick sau bị bỏ qua; sửa interface/implementation đó nằm ngoài file lease. Với stream đã mở, timeout vẫn `destroy()` và focused test xác nhận.

Trạng thái: **IMPLEMENTED, offline focused verification passed; chưa có live PostgreSQL verification hoặc review acceptance độc lập.**
