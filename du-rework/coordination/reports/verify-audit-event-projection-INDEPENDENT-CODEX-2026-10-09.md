# Verify độc lập — audit event projection và docs data-state

**Kết quả: không có test đỏ.** Chỉ đọc code/config/docs và chạy offline tests trong `du-rework`. Không sửa source, test, config hoặc docs; chỉ tạo receipt và raw logs. Không chạy PostgreSQL/Redis, không claim DB window, không tick gate.

CWD test: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. Git top-level thực tế là `D:/Git/dugate`; để giữ đúng scope, các lệnh diff dùng đường dẫn có tiền tố `du-rework/`.

## Runtime và HEAD

| Lệnh | Exit | Literal |
|---|---:|---|
| `node -v` (trước test đầu tiên) | 0 | `v22.16.0` |
| `git rev-parse HEAD` | 0 | `72e225ae5465e5a648c34bf31fbabbd182763233` |

Preflight được lưu tại `coordination/reports/raw/verify-audit-event-2026-10-09/CODEX/00-preflight.txt`; `node-version-check.log` là lần recheck sau đó với cùng phiên bản.

## Lệnh và kết quả

| Lệnh | Exit | Literal output / kết quả |
|---|---:|---|
| `git diff -- du-rework/orchestrator/packages/observability/src/log-metadata.ts` (cwd repo root) | 0 | Diff thêm `IDENTIFIER_VALUE`, `EVENT_FIELDS`, `eventLogRecord`, và nhánh chiếu `event`; không sửa membership của `IDENTIFIERS`. Raw: `01-log-metadata.diff`. |
| `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/admin-shell-session-lifecycle.test.ts` | 0 | `Tests:       51 passed, 51 total` |
| `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts` | 0 | `Tests:       48 passed, 48 total` |
| `git diff -- du-rework/docs/04-data-state.md` (cwd repo root) | 0 | Hunk duy nhất thay line 93; raw diff có đúng một dòng bỏ và một dòng thêm. Git có in cảnh báo CRLF/LF, không có file nào được ghi bởi lệnh này. Raw: `02-data-state.diff`. |
| `git diff --numstat -- du-rework/docs/04-data-state.md` | 0 | `1\t1\tdu-rework/docs/04-data-state.md` |
| So sánh phần tử `IDENTIFIERS` với `git show HEAD:du-rework/orchestrator/packages/observability/src/log-metadata.ts` | 0 | `IDENTIFIERS_KEYS_EQUAL_HEAD=True`; `IDENTIFIERS_KEY_COUNT_HEAD=31 CURRENT=31` |
| So sánh line 100 hiện tại với line 100 ở HEAD | 0 | `DOC_LINE100_EQUAL_HEAD=True` |
| Tìm `EVENT_FIELDS`/`eventLogRecord` trong dist | 0 | Có trong `dist/log-metadata.js` ở lines 25-30, 60-63. |
| Đọc mtime source và dist | 0 | Source `2026-10-08 10:52:58`; dist `2026-10-08 11:02:47`. |

Hai Jest suite không báo test skip. `tests/migrations.test.ts` không nằm trong kết quả này và không được tính là pass: `jest.unit.config.cjs:18` loại suite đó bằng pattern `migrations\\.test\\.ts$`.

## Nhận định code và dist

Trong `du-rework/orchestrator/packages/observability/src/log-metadata.ts`, `EVENT_FIELDS` ở line 25 chỉ có đúng năm key: `kind`, `reason`, `method`, `pathname`, `action`. `eventLogRecord` ở lines 27-35 chỉ đưa các key đó qua khi value là null, chuỗi hợp lệ theo `IDENTIFIER_VALUE`, hoặc số hữu hạn. Nhánh gọi projection nằm ở lines 51-56.

`IDENTIFIERS` ở lines 4-9 vẫn có đúng 31 key như HEAD; `pathname` không được thêm vào set này. Diff source không có hunk thay đổi block set. Kết luận: projection sự kiện được giới hạn riêng, allowlist định danh cũ không bị mở rộng.

Dist **không stale đối với fix này**: source có mtime sớm hơn dist, và `dist/log-metadata.js` thực sự chứa cả `EVENT_FIELDS` lẫn `eventLogRecord`. Không rebuild dist.

## Docs data-state

Diff `du-rework/docs/04-data-state.md` chỉ thay một dòng tại line 93 (numstat 1/1): nội dung cũ về không lưu plaintext được thay bằng trạng thái backfill window hiện tại có thể còn legacy plaintext-readable cho đến khi window switch và backfill hoàn tất.

Line 100 không bị dời/reflow và bằng chính xác line 100 ở HEAD. Nội dung hiện tại vẫn là danh mục 8 slot `METADATA_SLOTS` cùng các slot ref tương ứng; dòng 102 tiếp tục nêu rõ trạng thái plaintext-readable trong backfill window. Không thấy xung đột giữa nội dung line 100 và cập nhật trạng thái ở line 93.

## RED

**KHÔNG CÓ test đỏ.** Hai suite đã chạy đều pass như literal ở bảng trên. Không sửa gì để lấy xanh.

Một lần thử phụ để trích line bằng PowerShell ban đầu dùng sai cú pháp `Get-Content -split`; phép so sánh được chạy lại đúng cú pháp và cho `DOC_LINE100_EQUAL_HEAD=True`. Đây là lỗi lệnh đọc phụ, không phải test failure; không có repository source/test/config/docs nào bị thay đổi.

Raw logs: `du-rework/coordination/reports/raw/verify-audit-event-2026-10-09/CODEX/`.

