# Đánh giá độc lập frontend Orchestrator Portal (admin-web) — góc nhìn nhân viên hỗ trợ/vận hành

**Người đánh giá:** Qwen-C, vai trò: nhân viên hỗ trợ & quản trị hệ thống du-rework.
**Phạm vi:** `orchestrator/apps/admin-web` (đọc mã nguồn, đếm marker, đối chiếu BFF).
**Quy tắc đã tuân thủ:** KHÔNG `git add`, KHÔNG commit, KHÔNG push, KHÔNG sửa mã sản phẩm; chỉ ghi báo cáo này.
**Phương pháp:** khảo sát tĩnh trên mã nguồn + đối chiếu với BFF `services/orchestrator/src/app/admin/bff`. KHÔNG chạy browser/Playwright trong lượt này. Các con số là số file/dòng/match, không phải hành vi runtime đo được.

---

## 1. Hiện trạng — số liệu khảo sát

**13 màn hình** dưới `src/features/**/*-screen.tsx`:

| Màn hình | Dòng | Vai trò |
|---|---:|---|
| profiles | 1223 | cấu hình profile + bindings + bulk save |
| overview | 1075 | tổng quan: session, usage, audit, operations monitor |
| workflows | 1056 | catalog + provision/retire + preset samples |
| connectors | 997 | revision/credential/invoke + curl import |
| operations | 843 | danh sách + chi tiết + cancel/retry + artifacts |
| api-docs | 751 | OpenAPI reference (build-time spec) |
| secrets | 681 | catalog + rotate/disable/test |
| identity | 435 | OIDC metadata + local user CRUD |
| businesses | 292 | registry + version activate/deactivate |
| docs | 250 | endpoint catalog + Test Workbench |
| usage | 219 | window + raw JSON summary |
| security | 216 | crypto-config read/write |
| settings | 156 | catalog (mọi nút write đều disabled) |

Routing mỏng: `src/routes/*.tsx` mỗi file 5-7 dòng, `router.tsx` 58 dòng, `app-shell.tsx` 171 dòng.

**Dấu hiệu năng lực vận hành (đếm marker):**

| Marker | Số match | Ý nghĩa |
|---|---:|---|
| `AbortController` / `AbortSignal` | **0** | không huỷ request khi đổi filter/rời màn |
| `Skeleton` (component) | **1** (định nghĩa, **0** dùng) | không có loading skeleton |
| `useToast` | **2** (định nghĩa, **0** consumer) | hệ thống toast là dead code |
| `useSearchParams` | **0** | filter không shareable/bookmarkable |
| `aria-live` | **3** | thông báo trạng thái kém cho screen-reader |
| `toLocaleString` / `toLocaleTimeString` | **7** | hiển thị thời gian không đồng nhất |
| `window.confirm` | **2** (1 comment + 1 dùng thật) | confirm native, không phải ConfirmDialog |
| `ConfirmDialog` | **6** (chỉ connectors dùng) | component confirm tồn tại nhưng không dùng rộng |
| `correlationId` | **9** match / **5** file | mã tương quan chỉ hiện ở một phần màn (operations detail + bootstrap error) |
| `csv` / `CSV` / `export` | **0** | không có xuất dữ liệu |

---

## 2. Điểm yếu hiện tại (khách quan, theo mức độ ảnh hưởng tới vận hành)

### 2.1. Link chết `/api-keys` trên Overview — ưu tiên cao

`overview-screen.tsx:417` render `<Link to="/api-keys">API keys</Link>`, nhưng `router.tsx` **không có** route `api-keys` (route bị xoá khỏi working tree, `git status` cho thấy ` D routes/api-keys.tsx` + ` M router.tsx`). Kết quả: bấm vào đó rơi vào `NotFound`. Đây là lỗi thật, tái hiện được, không cần runtime.

### 2.2. Bảng "Workers" là dữ liệu **bị bịa** — ưu tiên cao

`overview-metrics.ts` `computeWorkerTelemetry()` map **businesses** thành "workers", tự tạo tên queue `du-business-${id}-${version}`, và `successRate` trả về `'100%'` khi **0 operation**. Dashboard render một chấm xanh nhấp nháy **luôn luôn xanh** bất kể health thế nào. Trong khi phần còn lại của app từ chối synthesize dữ liệe, đây là chỗ duy nhất làm ngược lại → người vận hành tin có worker đang chạy khi thực tế không.

### 2.3. Không huỷ request đang bay (0 `AbortController`)

`operations-screen.tsx` có sequence guard (`listRequest`/`detailRequest`) nhưng `overview-screen.tsx` và `usage-screen.tsx` **không có**. Đổi filter nhanh hoặc bấm Refresh liên tiếp → response cũ có thể về sau và ghi đè response mới. Nguy cơ kết luận sai trạng thái hệ thống.

### 2.4. Overview tạo client mới mỗi lần load

`overview-screen.tsx:247` gọi `createAdminApiClient()` **bên trong** `load()` → mỗi poll 10s lại tạo client mới, mất cache `csrfToken`, và gọi lại `getSession()`. 6 request tuần tự mỗi chu kỳ (session → usage → audit → operations → businesses → health).

### 2.5. Audit: chỉ 50 dòng, lọc client-side, không phân trang

`overview-screen.tsx:297` gửi `{ limit: '50' }` và **không bao giờ** gửi `cursor`. `parseAuditPage()` (`state.ts`) **bỏ qua** `nextCursor`/`prevCursor` hoàn toàn. Trong khi BFF `AUDIT_PARAM_ALLOWLIST` hỗ trợ `severity`, `action`, `actor`, `resource`, `from`, `to`, `sort` — tất cả đều **không được dùng**. Hỗ trợ khách hỏi "tìm audit event của tenant X hôm qua" → không làm được.

### 2.6. Không có màn Audit riêng

Audit chỉ là một card nhỏ trong Overview. Không có route `/audit`, không có server-side filter, không có phân trang. Đây là bề mặt hỗ trợ sự cố số 1 của nhân viên vận hành mà lại yếu nhất.

### 2.7. Usage: dump JSON thô

`usage-screen.tsx` render `<pre>{JSON.stringify(pane.data, null, 2)}</pre>` — không bảng, không tổng hợp, không so sánh. Trong khi Overview có `UsageRollupTile` đẹp với provider distribution. Màn Usage riêng lẻ kém hơn cả widget trong Overview.

### 2.8. Không xuất CSV / không shareable filter

`useSearchParams` = 0 → mọi filter đều `useState` cục bộ, mất khi refresh, không gửi link cho đồng nghiệp. Không có xuất CSV ở đâu cả.

### 2.9. Thao tác phá huỷ không có xác nhận

- `businesses-screen.tsx` `toggleActive()`: activate/deactivate version **không confirm**.
- `operations-screen.tsx` `cancelSelected()`: bulk cancel **không confirm** (cancel đơn lẻ thì có `window.confirm`).
- `secrets-screen.tsx` `submitRotate()`/`submitDisable()): chỉ mở modal, **không confirm** khi submit.
- `profiles-screen.tsx` save/publish/rollback: **không confirm**.

Trong khi `ConfirmDialog` (`dialog.tsx:156`) đã tồn tại và chỉ được dùng ở connectors.

### 2.10. Bulk cancel dừng khi lỗi đầu tiên, không báo cáo một phần

`operations-screen.tsx` `cancelSelected()` chạy tuần tự, `break` khi gặp lỗi đầu tiên, và **không** thông báo bao nhiêu operation đã cancel thành công. Người vận hành không biết phạm vi đã áp dụng.

### 2.11. Secrets: không hiển thị rotation interval

`types.ts:459` có `intervalDays` và `rotatedAt`, nhưng `secrets-screen.tsx` **không render** chúng → không có chỉ báo "sắp đến hạn rotate". Phải nhớ bằng não.

### 2.12. Timezone không đồng nhất

- `operations-screen.tsx:22` `toLocaleString()` → theo local timezone của browser.
- `overview-screen.tsx` audit → relative time + title ISO.
- `app-shell.tsx` header → hiển thị tên timezone.
- `usage-screen.tsx` → input `datetime-local` label "(UTC)" nhưng giá trị là UTC slice.
- `workflows-screen.tsx:743` → `toLocaleString()`.

Đối chiếu log máy chủ (UTC) với UI (local) dễ lệch giờ.

### 2.13. Tenant selection persist vào localStorage

`tenant-context.tsx` lưu `du_global_tenant_id` vào localStorage. Trên máy hỗ trợ dùng chung, tenant của người trước **tự động áp dụng** cho người sau. Không có cảnh báo rõ ràng ở các màn ghi (businesses, secrets, profiles).

### 2.14. GlobalErrorBoundary không có nút khôi phục

`toast.tsx` `GlobalErrorBoundary.render()` trả về một `<main>` tĩnh với **không nút retry/reset**. Một screen throw là cả portal chết, chỉ còn F5.

### 2.15. Bảo trì: file lớn, thiếu tách nhỏ

profiles 1223, workflows 1056, connectors 997, operations 843 dòng. Sửa nhỏ phải nạp cả file. Không có component test cho từng screen (chỉ có E2E Playwright ở `tests/browser`).

---

## 3. Đề xuất tính năng mới (ưu tiên cho hỗ trợ/vận hành)

### Đề xuất 1 — Màn **Audit** riêng với server-side filter + phân trang — ưu tiên cao nhất

Route `/audit` với: severity/actor/action/resource/from/to/sort (đã có sẵn trong `AUDIT_PARAM_ALLOWLIST`), phân trang cursor, và lưu filter vào URL. Hiện `audit-section-data.ts` (legacy shell) đã có sẵn toàn bộ logic sanitize + build query — chỉ cần port sang React.
*Vì sao:* audit là bề mặt sự cố số 1, hiện bị giới hạn 50 dòng client-side.

### Đề xuất 2 — **Trace Lookup**: dán correlationId/operationId → xem toàn bộ vòng đời

Một ô tìm kiếm nhận `correlationId` / `operationId` / `taskId`, trả về timeline hợp nhất: state transitions, task lease, outbox/webhook delivery, usage events, audit event tương ứng. Kèm link sang từng màn chi tiết.
*Vì sao:* biến việc lần vết từ 5-6 lần mở màn thành 1 lần.

### Đề xuất 3 — Sửa bảng "Workers" bịa dữ liệu → thành **System Health** thật

Thay `computeWorkerTelemetry()` (bịa queue name + 100% khi 0 data) bằng dữ liệu thật từ `/admin/api/health`: DB, Redis, queue integrity, active leases, outbox backlog, orphans, stalled. Mỗi ô bấm được để drill-down.
*Vì sao:* hiện dashboard đang **đánh lừa** người vận hành về trạng thái hạ tầng.

### Đề xuất 4 — **Request lifecycle dùng chung**: abort + skeleton + mốc cập nhật

Một hook `useAbortableLoad()`: mỗi lần đổi filter thì abort request cũ, hiển thị skeleton theo khối, in "cập nhật HH:MM:SS (UTC)" ở góc mỗi panel. Áp dụng cho overview, usage, operations, businesses, secrets.
*Vì sao:* xử lý 3 điểm yếu 2.3, 2.4, 2.14 cùng lúc.

### Đề xuất 5 — **Saved views + bulk actions + xuất CSV** cho Operations/Audit/Usage

Lưu bộ lọc đặt tên (ví dụ: `FAILED 1h`, `tenant X / cancel pending`), chọn nhiều dòng để cancel/retry (có confirm), xuất đúng trang đang xem ra CSV kèm cột thời gian ISO-8601.
*Vì sao:* công việc hằng ngày của hỗ trợ; hiện phải làm từng dòng và không có bản xuất để đính kèm ticket.

### Đề xuất 6 — **Confirm toàn diện cho thao tác phá huỷ**

Dùng `ConfirmDialog` (đã có) cho: business activate/deactivate, secret rotate/disable, profile save/publish/rollback, bulk cancel. Kèm hiển thị tên tenant + số bản ghi bị ảnh hưởng.
*Vì sao:* giảm thao tác nhầm khi đang căng thẳng.

---

## 4. Ghi chú trung thực

- Toàn bộ nhận xét dựa trên **đọc mã**, không phải trải nghiệm runtime. Muốn chốt mức độ nghiêm trọng cần chạy thử trên build hiện tại.
- Tôi **không** đánh giá tính đúng đắn của API phía sau, không kết luận về bảo mật, không đề xuất thay đổi contract.
- Đã có report feedback cùng ngày từ lane khác (`feedback-frontend-deepseek-1-2026-10-10.md`); báo cáo này độc lập, tập trung vào lỗi **đo được** (dead link, dữ liệu bịa, 0 AbortController) thay vì nhận xét chung.
- Không có yêu cầu nào ở đây được coi là đã được duyệt; đây là **đầu vào cho coordinator/product owner** quyết định.
