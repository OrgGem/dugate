# Docs — Operations screen: audit trung thực + sửa lỗ hổng (2026-10-10)

| Mục | Giá trị |
|---|---|
| Ngày | 2026-10-10 |
| Scope | `apps/admin-web/src/features/operations/` (`operations-screen.tsx` 959 dòng, `state.ts` 214 dòng tại thời điểm đọc) |
| Bốn luồng được audit | bulk cancel · retry · pagination · xử lý offline/transport |
| Kết quả | 3 lỗ hổng trung thực tìm được và đã sửa; phần còn lại đã trung thực |
| Ràng buộc | theo COORDINATOR-CONTRACT: KHÔNG git add/commit/push, tài liệu không chứa dấu nháy kép |

## 0. Nguyên tắc

Mọi khẳng định dưới đây được **đọc lại từ source hôm nay**, không kế thừa khảo sát hay receipt cũ. Cây đang được nhiều lane sửa song song (numstat của chính 2 file này đã lớn hơn delta của tôi rất nhiều), nên mỗi mục kèm **mô tả hành vi** bên cạnh số dòng.

## 1. Bản đồ bốn luồng

| Luồng | Vị trí | Ghi chú |
|---|---|---|
| Bulk cancel | `cancelSelected` (`:214`), nút `:344`, chọn hàng `:396-420`, bảng lỗi từng id `:483` | tuần tự, mỗi id một idempotency key |
| Retry | `control(op, retry)` (`:181`), nút Retry `:466` | chỉ admin, chỉ khi state FAILED/CANCELLED/TIMED_OUT |
| Pagination | nút Previous/Next/Newest `:474-476`, nhãn đếm `:477-481`, cursor staleness `:100/:160` | keyset + fingerprint tập dữ liệu |
| Offline/transport | `load()` (`:112`), `pane` (`:264`), `ErrorState` `:377` | lỗi → `kind: failed`, không giữ dữ liệu cũ |

## 2. Những gì đã trung thực sẵn (không sửa)

| # | Hành vi đúng | Bằng chứng |
|---|---|---|
| 1 | Bulk cancel chỉ nhắm id **chưa kết thúc** | `terminalStates` trong bộ lọc targets (`:215-220`) |
| 2 | Không có id nào bị bịa: thành công chỉ khi server trả `ok`, xong danh sách được **nạp lại từ server** | `:238-240` |
| 3 | Lỗi từng id được hiện kèm mã và HTTP status, không gộp thành một dòng chung | `:483-491` |
| 4 | Lỗi transport trong bulk cancel không bị nuốt: ghi thành problem `REQUEST_FAILED` | `:246-250` |
| 5 | Id đã thành công bị gỡ khỏi selection, id lỗi **được giữ lại** để thử lại | `:254` |
| 6 | Cancel không hứa dừng nếu server chưa đổi state: nếu state trả về khác CANCELLED thì in state thật | `:205-206` |
| 7 | Retry phân biệt *đã có retry đang chạy* với *tạo retry mới* qua cờ `replayed` | `:207-208` |
| 8 | Phân trang không bấm được khi không có cursor; Newest chỉ bật khi đang ở trang sau | `:474-476` |
| 9 | Cursor thuộc tập dữ liệu cũ bị **bỏ** chứ không phát lại | `operationsCursorIsStale` từ state.ts (AWEB-20) |
| 10 | Offline/transport: load thất bại thì trang sang trạng thái lỗi, **không** giữ bảng cũ như dữ liệu tươi | `:128-129`, `:264-268` |

## 3. Ba lỗ hổng tìm được — và cách sửa

### G1 — Bulk cancel bỏ sót id đã chọn mà không báo (`:221-225`, `:256-259`)

- **Trước:** bộ lọc targets chỉ giữ id **có trên trang hiện tại** và chưa kết thúc. Id đã chọn ở trang khác, hoặc đã kết thúc, bị **bỏ im lặng**. Thông điệp chỉ đếm cái đã thử: *Bulk cancel finished: 2 succeeded, 0 failed* trong khi 4 dòng vẫn còn được chọn và trông như bị bỏ qua — người vận hành dễ tưởng hệ thống nuốt lệnh.
- **Sau:** tính `skippedCount` (`:225`) và thêm vào thông điệp *N skipped (already finished or not listed on this page)* khi > 0 (`:257-259`). Id bị bỏ vẫn **được giữ trong selection** như trước, nên không mất trạng thái.

### G2 — Thông báo retry có dấu hai chấm treo và mở nhầm operation cũ (`:197-212`)

- **Trước:** `Retry created: ${String(result.data.operationId ?? '*')}` — khi backend không trả `operationId`, thông báo kết thúc bằng dấu hai chấm rỗng, rồi `openDetail(op.id)` **mở operation gốc** trong khi thông báo nói một retry đã được tạo ⇒ người vận hành tưởng đang xem retry mới.
- **Sau:** tách `retryOperationId` (rỗng khi thiếu hoặc rỗng) (`:200-204`); khi thiếu thì nói thẳng *Retry created, but the backend returned no operation id for it.* (`:209`) và có ghi chú rõ phần detail bên dưới vẫn là operation gốc (`:197-199`).

### G3 — Tổng số bị bịa khi server không trả total (state.ts `:36-57`, màn `:477-481`)

- **Trước:** parser điền `total: items.length` khi payload không có `total` (do kiểu wire bắt buộc `number`), và màn hiện `N shown · T total` ⇒ **khẳng định một tổng số mà server chưa từng gửi**, sai ngay khi còn trang sau (`nextCursor` khác null).
- **Sau:** thêm `ParsedOperationsPage` với cờ `totalFromServer` (state.ts `:41-43`, `:53`) và màn chỉ in tổng khi cờ đó đúng, ngược lại in *total not reported by the server* (`:480`). Kiểu wire trong `lib/api` **không** bị sửa; nhãn đếm cũng không còn là phép tính bịa.

## 4. Verification

```
node <tsc 5.9.3> --noEmit -p tsconfig.json
REAL_EXIT: 0        (output rỗng)

node --test tests/audit-state.test.mjs tests/operations-state.test.mjs tests/profiles-row-key.test.mjs tests/profiles-state.test.mjs tests/trace-state.test.mjs
ℹ tests 50   ℹ suites 10   ℹ pass 50   ℹ fail 0
REAL_EXIT: 0
```

**Fail-first đã xảy ra và được ghi lại (không che):** vòng đầu tsc **exit 2** với `TS1005` tại `:260` — tôi làm mất dấu `);` đóng lời gọi `setNotice` trong sửa G1; vòng hai tsc **exit 2** với `TS2322` vì TS không suy luận kiểu qua alias boolean, sửa bằng biến `number | null`. Chỉ khi đó mới xanh.

**Giới hạn ý nghĩa của con số 50:** suite admin-web là test lớp state; **không test nào render màn Operations**. 50/50 chứng minh không hỏng gì, **không** chứng minh ba câu thông báo mới hiện đúng. Cần kiểm bằng trình duyệt (bulk cancel có id bị bỏ sót; retry không trả id; một payload list thiếu total) — tôi không chạy Playwright.

## 5. Ngoài phạm vi (không sửa, ghi để không ai hiểu nhầm đã xong)

- **Không có auto-refresh / polling:** operation đang chạy không tự cập nhật; người vận hành phải tải lại.
- **Không có nút tải artifact** dù dữ liệu có URL tải.
- **Không có lọc theo mã lỗi hay khoảng thời gian tự do** (đã có from/to và id/tenant/state).
- **Không có ghi nhận kết quả hàng loạt ra file** để đối soát sau sự cố.

## 6. Ranh giới

- Sửa **chỉ trong `features/operations/`** (2 file); không đụng backend, contracts, `lib/api`, docs kỹ thuật khác.
- Không git add / commit / push. Không tick gate, không viết VERIFIED/ACCEPTED.
- Tài liệu này không chứa dấu nháy kép (đo bằng đếm ký tự, xem receipt).
- Cần đối chiếu lại `file:line` nếu đọc sau, vì hai file này đang được lane khác sửa song song.