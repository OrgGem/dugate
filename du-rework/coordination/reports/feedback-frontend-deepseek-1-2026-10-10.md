# Feedback frontend du-rework — góc nhìn nhân viên hỗ trợ & quản trị hệ thống — 2026-10-10

**Người đánh giá:** DeepSeek-1 (term_8bfe6adc), vai trò: nhân viên hỗ trợ/vận hành hệ thống du-rework.
**Phạm vi:** `du-rework/orchestrator/apps/admin-web` (đọc mã nguồn). **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3`.
**Quy tắc đã tuân thủ:** KHÔNG `git add`, KHÔNG commit, KHÔNG push, KHÔNG sửa mã sản phẩm; chỉ ghi báo cáo này.
**Giới hạn phương pháp (nói trước):** đây là **khảo sát tĩnh trên mã nguồn** — tôi **không** chạy browser/Playwright trong lượt này (không có cửa sổ build/browser), không đụng DB/Redis. Các con số dưới đây là **số file/dòng**, không phải hành vi runtime đo được.

## 1. Hiện trạng — số liệu khảo sát

**13 màn hình** dưới `src/features/**/*-screen.tsx`:

| Màn hình | Dòng | Nhận xét nhanh |
|---|---:|---|
| profiles | 1222 | lớn nhất; form cấu hình + bindings |
| overview | 1074 | nhiều tile + auto-refresh |
| workflows | 1056 | schema/workflow builder-facing |
| connectors | 996 | revision/credential/invoke |
| operations | 842 | danh sách + chi tiết + download |
| api-docs | 750 | reference (build-time spec) |
| secrets | 680 | secret slots/rotation |
| identity | 434 | OIDC/local user |
| businesses | 291 | versions/activation |
| docs | 249 | tài liệu |
| usage | 218 | drilldown/aggregate |
| security | 215 | posture |
| settings | 155 | cấu hình |

Routing rất mỏng: `src/routes/*.tsx` mỗi file **5-6 dòng**, `src/router.tsx` 58 dòng, `src/app-shell/app-shell.tsx` 170 dòng ⇒ điều hướng tập trung, dễ lần.

**Dấu hiệu năng lực vận hành (đếm số file chứa marker):**

| Marker | Số file | Ý nghĩa cho vận hành |
|---|---:|---|
| `AbortController` / `AbortSignal` | **0** | không huỷ request khi đổi filter/rời màn ⇒ nguy cơ **race stale-response** |
| `skeleton` / `Skeleton` | **1** | gần như không có loading skeleton ⇒ nhảy nội dung, khó biết đang tải |
| `autoRefresh` | 2 | tự làm mới chỉ ở một vài màn (overview/…) |
| `setInterval` | 4 | polling thủ công rải rác, không có cơ chế chung |
| `Pagination` / `cursor` / `page_token` | 10 | phân trang có, nhưng trải nghiệm cursor chưa đồng nhất |
| `retry` / `Retry` | 12 | nút thử lại xuất hiện không đồng đều |
| `role=alert` (thuộc tính ARIA) | 8 | báo lỗi có, nhưng `aria-live` chỉ **3** ⇒ thông báo trạng thái kém cho screen-reader |
| `correlationId` | 5 | mã tương quan **chỉ hiện ở một phần màn** — hỗ trợ khó lần vết |
| `timeZone` / `toLocaleString` / `UTC` | 7 | hiển thị thời gian chưa thống nhất múi giờ |
| `bulk` / `selectAll` / `checkbox` | 7 | hành động hàng loạt gần như không có trên danh sách lớn |
| Kiểm thử admin-web | 7 harness `.cjs` offline | không có test component/browser trong lượt này |

## 2. Điểm yếu hiện tại (khách quan, theo mức độ ảnh hưởng tới vận hành)

1. **Không huỷ request đang bay (0 file dùng AbortController/AbortSignal).** Khi tôi đổi filter rồi đổi tiếp, hoặc rời màn giữa lúc tải, kết quả cũ có thể về sau và **ghi đè** kết quả mới. Đây là lớp lỗi khó tái hiện và dễ khiến tôi kết luận sai về trạng thái hệ thống.
2. **Thiếu tín hiệu tải (chỉ 1 file có skeleton).** Các màn nặng (profiles 1222 dòng, overview 1074) rất dễ hiện trạng thái trống/dữ liệu cũ trong lúc chờ; tôi không phân biệt được **đang tải**, **rỗng thật**, hay **lỗi im lặng**.
3. **Làm mới dữ liệu không đồng nhất (autoRefresh chỉ 2 file, setInterval 4 file).** Với sự cố đang diễn ra, tôi phải F5 thủ công ở phần lớn màn; không có chỉ báo **cập nhật lúc nào** trên từng khối.
4. **Lần vết sự cố tốn công (correlationId chỉ ở 5 file).** Khi khách báo lỗi, tôi thường chỉ có `correlationId` hoặc `operationId`; hiện không có chỗ nào để dán mã và xem **toàn bộ vòng đời** (runtime → webhook → usage → audit). Phải mở lần lượt nhiều màn.
5. **Danh sách lớn thiếu thao tác hàng loạt (bulk chỉ 7 file).** Operations/Audit khi có hàng trăm dòng: không chọn nhiều để cancel/replay/xuất; phải làm từng dòng.
6. **Không xuất dữ liệu danh sách (CSV) cho điều tra.** Có nhiều chỗ tải artifact/file, nhưng **không thấy xuất bảng** (operations/audit/usage) để đính kèm ticket hoặc đối chiếu ngoài.
7. **Múi giờ chưa thống nhất (7 file có xử lý thời gian).** Log/audit/usage hiển thị theo cách khác nhau ⇒ dễ lệch giờ khi đối chiếu với log máy chủ (UTC).
8. **Bảo trì: nhiều màn là một file rất lớn** (profiles 1222, workflows 1056, connectors 996, operations 842). Sửa nhỏ cũng phải nạp cả file; rủi ro regression và khó review.
9. **Khả năng truy cập chưa đều** (`aria-live` 3 file): trạng thái tải/lỗi/thành công không được thông báo nhất quán.

## 3. Đề xuất tính năng mới (ưu tiên cho hỗ trợ/vận hành)

### Đề xuất 1 — Trang **Trace Lookup** (dán mã, xem cả vòng đời) — ưu tiên cao nhất
Một ô tìm kiếm nhận `correlationId` / `operationId` / `taskId` / `deliveryId`, trả về **timeline hợp nhất**: state transitions của operation, task lease, outbox/webhook delivery (attempt, next_at, last_error), usage events, và audit event tương ứng — kèm liên kết sang từng màn chi tiết.
*Vì sao:* biến việc lần vết từ 5-6 lần mở màn thành 1 lần; tận dụng dữ liệu đã có (audit/usage/webhook) mà hiện không có điểm truy cập chung.

### Đề xuất 2 — Lớp **request lifecycle dùng chung** (huỷ request + skeleton + mốc cập nhật)
Chuẩn hoá một hook dùng chung: mỗi lần đổi filter/route thì **abort** request cũ, hiển thị skeleton theo khối, và in **cập nhật lúc HH:MM:SS (UTC+7/UTC)** ở góc mỗi panel; thêm nút làm mới + tự làm mới tuỳ chọn cho mọi màn danh sách.
*Vì sao:* xử lý trực tiếp 3 điểm yếu 1-3 và 7 ở trên; giảm kết luận sai do dữ liệu cũ.

### Đề xuất 3 — **Saved views + thao tác hàng loạt + xuất CSV** cho Operations/Audit/Usage
Lưu bộ lọc đặt tên (ví dụ: `FAILED 1h`, `tenant X / cancel pending`), chọn nhiều dòng để cancel/retry/replay (có xác nhận), và xuất **đúng trang đang xem** ra CSV kèm cột thời gian ISO-8601.
*Vì sao:* đây là công việc hằng ngày của hỗ trợ; hiện phải làm từng dòng và không có bản xuất để đính kèm ticket.

### Đề xuất 4 — **Bảng sức khoẻ hệ thống** (một màn để trả lời câu hỏi có gì đang hỏng không)
Một màn gộp: health của DB/Redis/queue integrity, số lease đang chạy, **outbox backlog**, webhook failures theo cửa sổ thời gian, tỷ lệ lỗi theo action/tenant, và top tenant theo usage — mỗi ô bấm được để drill-down.
*Vì sao:* hiện thông tin nằm rải ở overview/usage/audit; khi có sự cố tôi cần một điểm nhìn tổng hợp trước khi khoanh vùng.

### Đề xuất 5 — **Chế độ an toàn cho thao tác phá huỷ** (dry-run + xác nhận theo ngữ cảnh + liên kết audit sau khi chạy)
Với các nút nguy hiểm (cancel/resume, rotate/revoke credential, activate/deactivate version, replay webhook): bước **xem trước** (sẽ ảnh hưởng bao nhiêu bản ghi/tenant nào), yêu cầu gõ lại tên tài nguyên với tenant cụ thể, và sau khi chạy hiện **link tới audit event** vừa sinh.
*Vì sao:* giảm thao tác nhầm khi đang căng thẳng; đồng thời tạo dấu vết đối chiếu ngay tại chỗ.

**Nếu chỉ làm được một việc:** chọn **Đề xuất 1 (Trace Lookup)** — nó giảm thời gian xử lý sự cố nhiều nhất và không đòi thay đổi mô hình dữ liệu, chỉ cần API đọc đã có.

## 4. Ghi chú trung thực

- Toàn bộ nhận xét dựa trên **đọc mã**, không phải trải nghiệm runtime; muốn chốt mức độ nghiêm trọng nên có một buổi chạy thật trên build hiện tại và thử các tình huống đổi filter nhanh / mất mạng / dữ liệu lớn.
- Tôi **không** đánh giá tính đúng đắn của API phía sau, không kết luận về bảo mật, và không đề xuất thay đổi contract nào.
- Không có yêu cầu nào ở đây được coi là đã được duyệt; đây là **đầu vào cho coordinator/product owner** quyết định.
