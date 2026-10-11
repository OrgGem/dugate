# Đánh giá trực tiếp frontend admin-web mới — 2026-10-10

**Vai trò:** Coordinator. **Phạm vi:** đọc trạng thái sống của `du-rework/orchestrator/apps/admin-web`
và các bề mặt backend nó phụ thuộc. **Căn cứ:** `file:line` đọc trực tiếp từ working tree, không
dựa vào report của agent khác.

**Ràng buộc đã tuân thủ:** không commit, không `git add`, không push, không tick gate, không dùng
ký tự nháy kép trong file này. Chỉ ghi metadata coordination.

**Vì sao report này tồn tại:** `PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md` vừa lập ghi
AWEB-17/18/19 là việc cần làm. Kiểm chứng lại cho thấy cả ba đã có trong code. Report này là nguồn
sự thật; plan cần cập nhật theo §5 dưới đây.

---

## 0. Kết luận một dòng

Frontend đã tiến đáng kể so với lần verify trước của coordinator: **5/7 hạng mục Top 5 đã xong
và làm đúng**, phần còn lại là một khoảng trống hẹp, có thể đóng bằng frontend-only.

---

## 1. Bảng trạng thái tổng hợp

| Hạng mục | Plan ghi | Thực tế đã kiểm chứng | Bằng chứng |
|---|---|---|---|
| AWEB-18 Audit Console | Việc cần làm | **ĐÃ XONG** | `router.tsx:43`, `features/audit/audit-screen.tsx` 337 dòng, `features/audit/state.ts` 145 dòng, `tests/audit-state.test.mjs` 5 test |
| AWEB-19 Trace Workspace | Việc cần làm | **ĐÃ XONG** | `router.tsx:44`, `features/trace/trace-screen.tsx`, `features/trace/state.ts` 374 dòng, `tests/trace-state.test.mjs` 7 test |
| AWEB-17 Workflow test honesty | Việc cần làm | **ĐÃ FIX** | `workflows-screen.tsx:386-396`, `:405-417` |
| AWEB-16 Overview metrics honesty | Việc cần làm | **MỘT PHẦN** | `overview-screen.tsx:327-330` đã truyền tenant nhưng vẫn `limit: 100`; `operations-monitor-dashboard.tsx:84` vẫn label Tổng Operations |
| AWEB-20a Operations from/to | Cần backend + UI | **BACKEND XONG, UI CHƯA** | `list-query.ts:410-411`, `bff/operations.ts:46`, `operations-screen.tsx:80-87` không gửi |
| AWEB-20b Bulk cancel | Việc cần làm | **ĐÃ FIX** | `operations-screen.tsx:142-179` |
| Nav Audit/Trace | Việc cần làm | **ĐÃ XONG** | `app-shell.tsx:16,20` |

Hai việc phát sinh, không nằm trong Top 5:

| Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|
| Link `/api-keys` chết ở Overview | **ĐÃ XONG** | `overview-screen.tsx` không còn chuỗi `api-keys`; `app-shell.tsx:18-19` ghi chú 0039 giải thích API key nay nằm trong Profile |

---

## 2. AWEB-18 Audit Console — đánh giá chi tiết

Đây là phần làm tốt nhất của đợt này.

**Đẩy filter xuống server thật.** `buildAuditQuery` (`features/audit/state.ts:86-100`) luôn gửi
`tenantId` từ active scope, thêm `severity`/`action`/`actor`/`resource`/`from`/`to` chỉ khi khác
rỗng. BFF forward đủ qua `AUDIT_PARAM_ALLOWLIST` (`bff/handle.ts:63`). Backend đọc được
`from`/`to` thật vào SQL: `list-query.ts:410-411` push `created_at >= $n::timestamptz` và
`created_at <= $n::timestamptz`. Đây là bằng chứng đối chiếu được, không phải suy đoán.

**Có guard chống response cũ.** `requestSequence` (`audit-screen.tsx:87`) tăng ở mỗi vòng fetch,
cleanup tăng thêm một lần (`:137`), và mọi nhánh async đều so `sequence !== requestSequence.current`
rồi return (`:123`, `:133`). Đây là fix đúng cho race condition, không phải cờ hiệu trang trí.

**Cursor gắn với scope.** `cursorScopeKey` (`:65-67`) JSON hoá tenant cộng filters; `cursor` chỉ
được dùng khi `cursorState.scope === scopeKey` (`:109`). Đổi filter là mất cursor — đúng, tránh
paging qua dữ liệu đã lọc khác.

**Export CSV là control bảo mật thật, không phải tiện ích.**
`csvCell` (`state.ts:110-113`) escape theo RFC 4180 **và** trung hòa công thức spreadsheet bằng
regex `/^[\u0000- ]*[=+\-@]/`. Đây là đúng lớp phòng thủ CSV injection. Export bị chặn theo
role: `exportAllowed = role === 'admin' || role === 'operator'` (`:168`), và chỉ xuất **trang hiện
tại** với allowlist cột cố ý bỏ `message`/`payload` (`state.ts:119-133`). Tên file được sanitize
(`:177`). Đây là mẫu anti-fabrication tốt nhất trong admin-web.

**Trạng thái rỗng/dead/error đầy đủ.** `scope-required` khi chưa chọn tenant (`:116-119`, render
`:280`), 403 tách riêng khỏi lỗi khác (`:281-286`), empty state có nút Clear filters (`:288`).

**Khoảng trống còn lại của Audit:** màn hình **không đọc URL query params** (không có
`useSearchParams` trong toàn bộ `apps/admin-web/src` — grep xác nhận 0 kết quả). Vì vậy deep-link
`/audit?tenantId=X&resource=operation:Y` mà `buildTraceLinks` sinh ra (`trace/state.ts:366-373`)
sẽ mở Audit Console ở trạng thái filter mặc định, im lặng bỏ qua hai tham số. Người dùng tưởng
đã lọc, thực tế không. Đây là điểm nên sửa.

---

## 3. AWEB-19 Trace Workspace — đánh giá chi tiết

**Lookup theo taskId có giới hạn thật và nói thật.** `findOperationByTaskId`
(`trace/state.ts:166-240`) quét có phân trang, tenant-scoped luôn (`:188` gửi `tenant`), từ chối
khi chưa chọn tenant (`:173-179`), trần `TASK_SCAN_LIMIT = 500` (`:31`) chạy song song 8 (`:33`).
Không tìm thấy thì báo đã quét bao nhiêu và có bị chặn trần hay không — cờ `capped` (`:239`) và
thông điệp ở `trace-screen.tsx:124-130`. Phát hiện cursor lặp thì fail bằng
`INVALID_CURSOR_SEQUENCE` (`:228-235`) thay vì quét vô hạn. Đây là cách xử lý giới hạn đúng:
nói rõ giới hạn thay vì giả vờ toàn diện.

**Masking payload nghiêm.** `maskSensitivePayload` (`:341-355`) giữ hình dạng object nhưng thay
**mọi** scalar bằng `[MASKED]`, đổi tên field thành `field_1..n`, giới hạn depth 6, node budget 120.
Không còn rủi ro lộ giá trị thật.

**Timeline hợp nhất 4 nguồn có thứ tự xác định.** `buildTraceTimeline` (`:273-338`) sort theo
thời gian rồi theo `sourceOrder = { operation: 0, task: 1, usage: 2, audit: 3 }` (`:332`), nên
kết quả ổn định khi hai event trùng mốc thời gian.

**Đã kiểm chứng điểm tôi nghi ngờ:** nhánh audit của timeline lọc theo
`event.resourceId === operation:<id>` (`:318-320`). Tôi đã truy ngược `toAuditWire`
(`modules/audit/audit.ts:96-108`, `resourceId: row.resource`) rồi tìm nơi ghi resource cho
operation — `modules/admin-actions/dispatcher.ts:600`, `:639`, `:677` đều ghi
`resource: operation:<operationId>`. **Định dạng khớp. Nhánh audit hoạt động, không âm thầm rỗng.**
Đây là claim đã kiểm chứng ngược, không phải giả định.

**Còn thiếu:** correlationId. `trace-screen.tsx:135-141` nói thẳng là Admin API chưa expose read
filter này và hướng người dùng sang operation/task ID. Từ chối trung thực, không bịa kết quả.

**Cùng khoảng trống như Audit:** trace cũng không đọc URL param, nên `/operations?id=<opId>` và
`/audit?tenantId=&resource=` là deep-link không có tác dụng. Đây là một task nhỏ, giải quyết được
cả hai màn hình cùng lúc bằng `useSearchParams`.

---

## 4. Các hạng mục còn thiếu — phân tích chi tiết

### 4.1 AWEB-16 Overview — phần còn lại

Đã cải thiện: `overview-screen.tsx:327-330` nay truyền `tenant` vào `listOperations` khi có active
tenant, và `:298-300` truyền `tenantId` vào `listAudit`. Link `/api-keys` chết đã bị gỡ.

Chưa xong: `listOperations` vẫn `limit: '100'` (`:328`). Mảng này chảy vào
`OperationsMonitorDashboard` (`operations-monitor-dashboard.tsx:58-60`), và
`computeOperationsTelemetry` (`overview-metrics.ts:230`) đặt `total = operations.length`.

`operations-monitor-dashboard.tsx` dùng `telemetry.total` ở **mười chỗ**, không chỉ thẻ KPI:
- `:84` — giá trị của thẻ KPI dưới nhãn **Tổng Operations** (nhãn ở `:80`)
- `:175` — dòng mô tả `Tổng quan {telemetry.total} requests được ghi nhận trong phiên làm việc`
- `:204`, `:211`, `:218`, `:225`, `:232` — **mẫu số của thanh phân bố trạng thái** (succeeded /
  running / failed / cancelled / timedOut, mỗi thanh tính `(count / telemetry.total) * 100`)
- `:251`, `:258`, `:265` — phần trăm in cạnh từng trạng thái

Nghĩa là **mọi tỷ lệ phần trăm trên dashboard cũng là tỷ lệ của mẫu 100 dòng**, không chỉ con số
tuyệt đối. Với 5000 operation, thẻ hiện 100 và mọi thanh phân bố vẫn đúng *về tương đối* trong
mẫu — nên lỗi hiện ra là ở thẻ KPI và dòng mô tả, còn các thanh phần trăm không sai theo nghĩa
đen nhưng vẫn mô tả sai phạm vi. Đây là phần còn lại của AWEB-16.

Vấn đề con: `listOperations` max limit là 100 (`OPERATIONS_LIST_LIMIT_MAX = 100`), nên không thể
lấy hết bằng một request. Nhưng envelope trả về đã có `total` là COUNT thật trên toàn bộ tập đã
lọc, không phải số dòng trả về — contract nói rõ tại `public-api.ts:242`. Ba hướng: gắn nhãn rõ là
mẫu 100 dòng gần nhất; hoặc dùng `total` từ envelope cho thẻ Tổng; hoặc thêm endpoint tổng hợp.
Khuyến nghị: dùng `total` từ envelope cho thẻ Tổng và dòng mô tả, giữ sample cho biểu đồ trạng
thái kèm nhãn mẫu 100 dòng. Đây là fix nhỏ, không cần backend mới.

### 4.2 AWEB-20 Operations — phần còn lại

**Bulk cancel đã đúng.** `operations-screen.tsx:142-179` không còn `break` và không còn xóa sạch
selection. Nó thu thập `failures` từng dòng (`:163`, `:169`), chỉ gỡ các id thành công khỏi
selection (`:175`), hiển thị `setBulkCancelFailures` (`:176`) và banner lỗi từng mục (`:399`).
Đây là fix hoàn chỉnh: thất bại một phần không còn làm mất dấu vết việc chưa xong.

**from/to có backend, chưa có UI.** Contracts đã khai báo `from`/`to` trong
`OPERATIONS_LIST_QUERY_PARAMS` (`public-api.ts:65-66`) và validator kiểm tra UTC ISO
(`:218-225`). BFF forward (`bff/operations.ts:46`). Backend lọc SQL thật
(`list-query.ts:410-411`). Nhưng `operations-screen.tsx:80-87` không gửi `from`/`to`; nó lọc client-side
(`:195-204`) trên trang đã tải, và UI nói rõ điều đó (`:285`: Time window applies to the loaded
page). Nói thật là tốt, nhưng nghĩa là người dùng chỉ thấy các operation nằm trong 100 dòng trang
đầu. Fix là gửi thêm `from`/`to` vào query — cần đổi ngày sang UTC ISO, logic chuyển đổi đã có sẵn
trong `audit/state.ts` (`localDateTimeToUtc`) để tái dùng.

### 4.3 Nhỏ, đáng ghi nhưng chưa cần plan riêng

- **Tenant selector chỉ lấy 100 tenant** (`lib/tenant-context.tsx:32`) không có phân trang và không
  có nhãn báo giới hạn. Trên lớp vượt 100 tenant, tenant ngoài trang đầu sẽ không chọn được.
- **Businesses chỉ lấy 50** (`businesses-screen.tsx:47`), không có ô tìm. Cùng loại giới hạn.
- **Hai màn hình mới không đọc URL param** (§2, §3) — deep-link hiện là vô hiệu.
- **Correlation ID lookup chưa có** (`trace-screen.tsx:135-141`) — đã nói thẳng, cần backend mới.

---

## 5. Đề xuất cập nhật plan

`PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md` hiện liệt kê AWEB-17/18/19 là việc chưa làm. Điều đó
không còn đúng. Đề xuất đóng 17/18/19, giữ AWEB-16 và AWEB-20 với phạm vi thu hẹp lại đúng phần còn
thiếu, và bổ sung một task mới cho deep-link URL params.

| Task | Nội dung sau khi cập nhật | Phạm vi |
|---|---|---|
| AWEB-17 | Đóng — đã fix | — |
| AWEB-18 | Đóng — đã xong | — |
| AWEB-19 | Đóng — đã xong | — |
| AWEB-16 | Thu hẹp: dùng `total` từ envelope cho thẻ Tổng Operations và dòng mô tả; gắn nhãn mẫu 100 dòng cho biểu đồ trạng thái | `features/overview/` |
| AWEB-20 | Thu hẹp: gửi `from`/`to` lên server trong `listOperations` thay vì lọc client-side | `features/operations/` |
| **AWEB-21 (mới)** | Cho Audit và Trace đọc URL query params để deep-link có tác dụng | `features/audit/`, `features/trace/` |

Không có task nào trong ba mục trên cần thay đổi backend, migration, hay contract.

---

## 6. Điều KHÔNG đánh giá được

- **Không chạy build, test, lint, hay browser test.** Coordinator không được chạy product build
  theo `COORDINATOR-CONTRACT.md`. Mọi khẳng định trên đây là đọc tĩnh source. Hai file test của
  admin-web (`tests/audit-state.test.mjs`, `tests/trace-state.test.mjs`) đã được đọc và nội dung
  khớp với hành vi trong source, nhưng **chưa được xác nhận là chạy xanh**.
- **Không xác nhận build TypeScript pass** cho các file mới.
- **Không có bằng chứng chạy thật** trên trình duyệt cho `/audit` và `/trace`. Test hiện có là unit
  test cho state helper, không phải browser test.
- **Roster agent:** không xác minh ai đã làm phần này hay đang làm tiếp phần nào. Tôi đánh giá
  trạng thái code, không đánh giá tiến độ agent.

---

## 7. Rủi ro còn lại

1. **Số liệu Overview có thể sai mà nhìn rất thật** — nhãn Tổng Operations và dòng mô tả
   `trong phiên làm việc` chạy trên một mẫu tối đa 100 dòng. Với 5000 operation, người dùng
   đọc 100. Đây là rủi ro cao nhất còn lại vì nó dẫn tới quyết định sai mà không có tín hiệu
   lỗi nào. Các thanh phần trăm bên cạnh vẫn tương đối đúng trong phạm vi mẫu.
2. **Deep-link vô hiệu âm thầm** — thấy URL đúng, tin là đã lọc, thực tế không. Cùng cấp độ với (1).
3. **Trace theo taskId quét tối đa 500 operation** — tenant lớn sẽ có task nằm ngoài cửa sổ. Đã xử
   lý đúng bằng cách nói thật giới hạn, nhưng vẫn là giới hạn thật cần biết.

## 8. Điểm tích cực cần ghi nhận

Audit Console và Trace Workspace được viết đúng chuẩn: scope bắt buộc, guard chống stale
response, cursor gắn với filter, CSV có trung hòa công thức, export có role gate, payload mask
toàn bộ scalar, giới hạn quét được thừa nhận, claim correlation đã được kiểm chứng ngược với
`admin-actions/dispatcher.ts`. Đây là mức chất lượng cao hơn đáng kể so với phần UI cũ, và nên
làm chuẩn tham chiếu cho các màn hình còn lại.
