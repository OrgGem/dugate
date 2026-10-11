# Plan: Frontend Admin Workspace — Top 5 ưu tiên từ synthesis đánh giá frontend

- Ngày: 2026-10-10 (Asia/Bangkok)
- Vai trò: Claude Code coordinator (theo `COORDINATOR-CONTRACT.md`)
- Repo scope: `du-rework` (không đụng legacy root, không đụng DB production/legacy)
- Nguồn yêu cầu: người dùng 2026-10-10 — đánh giá kiến trúc `synthesis-frontend-feedback-2026-10-10.md` và chọn Top 5 tính năng ưu tiên đưa vào plan mới.
- Sổ mở duy nhất: `coordination/PLAN-OPEN-2026-10-09.md` (đăng ký tại §16)
- Trạng thái: **SPECIFIED / chưa dispatch**. Không tick gate, không commit, không push, không `git add`. Không viết dispatch packet (người dùng có agent điều phối riêng — PLAN-OPEN §14).
- **Cập nhật 2026-10-10 (sau đánh giá thực địa):** xem §9. AWEB-17/18/19 đã có trong code — §3 vẫn ghi chúng là việc cần làm là **thông tin cũ**.

---

## 0. Trả lời trực tiếp yêu cầu

Synthesis §4 nhờ: (1) đánh giá 5 nhóm tính năng theo ưu tiên / rủi ro vận hành / kiến trúc; (2) chọn **Top 5 chuẩn xác nhất**; (3) phác thảo roadmap dạng AWEB-16, AWEB-17… vào plan điều phối tiếp theo.

**Kết luận ngắn:** 5 nhóm đều có thật, nhưng **hai giả định nền trong synthesis đã lệch thực tế** sau khi đối chiếu file:line. Hai giả định đó làm đổi rõ ràng chi phí và thứ tự ưu tiên, nên phải sửa trước khi chọn Top 5:

| Giả định của synthesis | Thực tế đã kiểm chứng | Hệ quả |
|---|---|---|
| Audit cần backend lọc server-side | **Sai.** Backend đã xong: `audit-list.ts` có keyset cursor + severity/action/actor/resource/from/to + tenant fence; BFF `AUDIT_PARAM_ALLOWLIST` đã forward đủ. | Audit Console là **chỉ UI** — rẻ nhất, không phải việc backend. |
| Operations lọc ngày là client-only | **Nửa đúng.** `OPERATIONS_LIST_QUERY_PARAMS = [limit, cursor, state, tenant, id, sort]` — **không có `from`/`to`**. state/tenant/id/sort/cursor đã server-side; **thiếu cụ thể khung thời gian**. | Operations date filter **có** phần backend thật, không rẻ như Audit. |

**Top 5 đã chọn (AWEB-16 → AWEB-20):** (1) Overview metrics honesty, (2) Workflow test honesty, (3) Audit Console, (4) Trace / Support Incident Workspace, (5) Operations Recovery Workspace. Worker telemetry **không** lập lại plan — tham chiếu D1/AWEB-11C. Change Center (diff/effective-preview) **hoãn** — xem §5.

---

## 1. Kiến trúc đánh giá (đối chiếu file:line, không dựa vào report)

### 1.1 Hai tầng admin UI khác nhau — không được lẫn

- **React SPA mới:** `orchestrator/apps/admin-web/src` → BFF `/admin/api/*` → upstream JSON API. Đây là mà synthesis và 3 agent đánh giá.
- **Legacy SSR shell:** `orchestrator/services/orchestrator/src/app/admin/*-renderer.ts`. Không phải mục tiêu của plan này.
- **BFF là proxy same-origin mỏng** tại `services/orchestrator/src/app/admin/bff/` — **không** nằm dưới `admin-web`. `handle.ts` dispatch; handler relay upstream kèm platform bearer.

### 1.2 Chuỗi ủy quyền hai tầng cho lệnh đọc admin

`BFF resolve session principal → authorizeAuditTenantRead(rbacPrincipal(principal), queryTenant) → chỉ gắn `tenant` vào upstream URL khi scope khác rỗng → public.ts resolve admin bearer qua resolveAdminPrincipal → truyền scope === '' ? null : scope vào listOperationsPage`. **Platform principal nhận scope rỗng = không lọc tenant.**

Đây là **lỗi phạm vi hiển thị (display-scope)**, không phải authz bypass: đường x-api-key vẫn bị SQL-fence theo tenant. Codex-2 đã kết luận đúng điều này; plan này giữ nguyên kết luận.

### 1.3 Bề mặt backend đã có sẵn (đối chiếu 2026-10-10)

| Bề mặt | Trạng thật | Bằng chứng |
|---|---|---|
| Audit ledger | **Đầy đủ** — keyset cursor, severity/action/actor/resource/from/to, tenant fence, 422 khi from > to | `modules/admin-read/audit-list.ts:37-120` |
| Audit BFF allowlist | **Đầy đủ** — limit, cursor, severity, action, actor, resource, from, to, sort | `app/admin/bff/handle.ts:60-73` |
| Audit client method | **Có sẵn** — `listAudit(query)` | `apps/admin-web/src/lib/api/client.ts:325-327` |
| Operations list | **Một phần** — limit, cursor, state, tenant, id, sort; **thiếu from/to** | `packages/contracts/src/public-api.ts:58-65` |
| Worker instances | **Không tồn tại** trong orchestrator; chỉ là DDL đã duyệt ở D1 | `PLAN-PORTAL-BUSINESS-PROFILE-2026-10-10.md` §4/§7 |

---

## 2. Các điểm yếu đã kiểm chứng (bảng đối chiếu)

| Claim | Verdict | Bằng chứng |
|---|---|---|
| Workflow test báo thành công giả khi lỗi/exception | **Xác nhận** — cả 2 nhánh đều đặt `SIMULATED_SUCCESS` + `sim-op-*`; nhánh success còn tự chế operationId + lấy stages từ catalog | `features/workflows/workflows-screen.tsx:376-418` |
| Trạng thái worker giả từ business registry | **Xác nhận** — 1 dòng/1 business; queue tự chế; không có bảng worker | `features/overview/overview-metrics.ts:270-304` |
| Overview lấy 100 ops nhưng cho chọn 6 tháng | **Xác nhận** | `features/overview/overview-screen.tsx:327` |
| Overview không lọc theo tenant đang chọn | **Xác nhận qua 2 tầng** — BFF chỉ gắn tenant khi scope ≠ rỗng; public.ts truyền null cho platform principal | `bff/operations.ts:170-186`; `http/routes/public.ts:445-452` |
| Không có route `/audit` riêng | **Xác nhận** — 14 route, không route audit; nav cũng không có | `router.tsx:40-53`; `app-shell.tsx:16-21` |
| Audit thiếu lọc server-side | **Bác bỏ ở backend** — đã xong; chỉ thiếu UI | `audit-list.ts`; `bff/handle.ts:60-73` |
| Operations cần lọc ngày server-side | **Xác một phần** — state/tenant/id/sort/cursor đã có; **thiếu from/to** | `public-api.ts:58-65` |
| Bulk cancel xóa selection khi lỗi | **Xác nhận** — `break` rồi `setSelected(new Set())` vô điều kiện | `features/operations/operations-screen.tsx:141-165` |
| 0 file dùng AbortController | **Xác nhận cho `apps/admin-web/src`** (≈70 matches ở nơi khác trong orchestrator — giới hạn claim) | grep |
| Link `/api-keys` ở Overview chết | **Xác nhận** — `:417` trỏ `/api-keys` nhưng router không đăng ký | `overview-screen.tsx:417` vs `router.tsx` |
| Tenant selector ghi đè tenant đã lưu | **Xác nhận** — chỉ đọc 100 tenant, không cursor; tenant không có trang đầu bị coi là invalid | `lib/tenant-context.tsx:29,37-53` |
| Businesses giới hạn 50, không search/phân trang | **Xác nhận** | `features/businesses/businesses-screen.tsx:39` |

---

## 3. Top 5 tính năng ưu tiên (AWEB-16 → AWEB-20)

Xếp theo (rủi ro độ trung thực × giá trị vận hành) / chi phí. Mỗi task khai lease chính, phụ thuộc, acceptance. **Chưa giao owner** — chờ agent điều phối của người dùng.

### AWEB-16 — Overview metrics honesty (tenant scope + server-side aggregation)

**Vì sao #1:** đây là lỗi độ trung thực nghiêm trọng nhất — success rate / total tính trên 100 dòng mẫu, và platform admin bị gộp cross-tenant dù UI tuyên bố scope theo tenant. Người vận hành sẽ ra quyết định trên số sai.

**Hai phần rõ ràng:**
- **AWEB-16a (frontend, rẻ):** gửi `tenantId` đang chọo vào `listOperations` — backend **đã** hỗ trợ `tenant` filter, chỉ cần truyền. Sửa copy `:402` cho khớp hành vi thật.
- **AWEB-16b (backend, vừa):** thêm aggregation server-side theo khung thời gian + tenant, trả total/success/failure/p50/p95 + `sampledAt` + cờ stale. Thay cho mẫu 100 dòng client.

**Lease chính:** `features/overview/**`, `modules/operations/list-query.ts`, `modules/admin-read/`, `http/routes/`, `bff/operations.ts`.
**Phụ thuộc:** — (độc lập). **Acceptance:** metrics khớp cửa sổ đã chọn; platform admin thấy đúng tenant đã chọn; có `sampledAt` + stale flag; không còn mẫu 100 dòng.

### AWEB-17 — Workflow test honesty + sửa link chết

**Vì sao #2:** báo thành công giả khi backend lỗi là lỗi độ trung thực cao, chi phí thấp (thuần frontend).

**Việc:**
- Tách `SIMULATED_SUCCESS` khỏi failure/exception thật; chỉ simulation được chọn rõ ràng mới sinh kết quả mô phỏng.
- Nhánh success **không** tự chế operationId; `stagesCompleted` lấy từ server, không từ catalog.
- Sửa link chết `/api-keys` ở `overview-screen.tsx:417` (hoặc trỏ tới Profiles, hoặc xóa — theo app-shell đã ghi API keys nằm trong Profiles).

**Lease chính:** `features/workflows/**`, `features/overview/overview-screen.tsx`.
**Phụ thuộc:** — (độc lập). **Acceptance:** lỗi backend hiện lỗi thật; chỉ có simulation mới hiện SIMULATED_SUCCESS; không còn `sim-op-*` khi thất bại thật; link `/api-keys` không chết.

### AWEB-18 — Audit Console (route + screen)

**Vì sao #3:** rẻ nhất trong Top 5 vì **backend đã xong** — chỉ cần route + screen. Giá trị triage cao (điều tra sự cố cũ, tra theo actor/resource).

**Việc:**
- Thêm route `/audit` vào `router.tsx` + nav `app-shell.tsx`.
- Màn `features/audit/**` gọi `listAudit(query)` (client đã có) với limit/cursor/severity/action/actor/resource/from/to/sort.
- Hiển thị phạm vi tenant đang chọn cạnh kết quả; phân trang cursor; export CSV theo quyền.

**Lease chính:** `features/audit/**` (mới), `router.tsx`, `app-shell.tsx`, `lib/api/client.ts` (đã có method).
**Phụ thuộc:** — (backend đã xong). **Acceptance:** route `/audit` đọc được; lọc server-side hoạt động qua BFF; tenant fence giữ nguyên; export không lộ secret.

### AWEB-19 — Trace / Support Incident Workspace

**Vì sao #4:** là mốn #1 đồng thuận của cả 3 agent; giảm thời hỗ trợ phải nhảy 5–6 màn.

**Việc:** một ô tìm kiếm nhận operationId / correlationId / taskId / deliveryId; trả timeline hợp nhất: operation state transitions → root/child task attempts → outbox/webhook delivery → usage/quota → audit liên quan. Payload viewer đã mask/redact; deep-link nội bộ.

**Lease chính:** `features/trace/**` (mới), `modules/operations/`, `modules/admin-read/`, `http/routes/`, `bff/`.
**Phụ thuộc:** cần read-only search qua operations/tasks/webhook_deliveries/admin_audit_events — **không** đổi schema. **Acceptance:** một ID vào → timeline đủ 5 nguồn; payload không lộ secret; deep-link mở đúng màn.

### AWEB-20 — Operations Recovery Workspace (from/to + bulk cancel tin cậy)

**Vì sao #5:** gồm **phần backend thật duy nhất** trong Top 5 (from/to) + phần frontend rẻ (bulk cancel).

**Việc:**
- **AWEB-20a (backend, vừa):** thêm `from`/`to` vào `OPERATIONS_LIST_QUERY_PARAMS` + parser + predicate trong `list-query.ts`. Đây là thay đổi contract — phải đi kèm conformance test.
- **AWEB-20b (frontend, rẻ):** bulk cancel/retry trả kết quả per-item; giữ selection cho mục thất bại để retry tiếp; hiện rõ đã xử lý mục nào.

**Lease chính:** `modules/operations/list-query.ts`, `packages/contracts/src/public-api.ts`, `features/operations/**`, `http/routes/`, `bff/operations.ts`.
**Phụ thuộc:** AWEB-20a là contract bump → serialize với mọi thay đổi contract khác. **Acceptance:** lọc theo khoảng thời gian server-side; bulk cancel báo per-item; mục lỗi giữ nguyên để retry; conformance test mới pass.

---

## 4. Worker telemetry — KHÔNG lập lại plan

Synthesis Nhóm 3 (Worker & Queue Telemetry) **đã có chủ và đã được chốt**: D1 (bảng `worker_instances`) + AWEB-11C trong `PLAN-PORTAL-BUSINESS-PROFILE-2026-10-10.md` §4/§7, người dùng đã duyệt 2026-10-10. Plan này **tham chiếu**, không mở lại DDL, không mở lại quyết định. Khi AWEB-11C xong, chấm xanh hard-code (`operations-monitor-dashboard.tsx:506`) và bảng worker một-dòng-mỗi-business sẽ được thay bằng nguồn thật.

---

## 5. Change Center — hoãn (không bỏ)

Synthesis Nhóm 5 (diff revision, effective-config preview, dry-run thật) **hoãn**, lý do: chi phí lớn nhất (đối chiếu 2 revision, merge preview theo tenant, dry-run backend), rủi ro vận hành thấp nhất trong 5 nhóm. Ghi lại để không mất; mở lại ở wave sau khi Top 5 xong. Phần honesty của Nhóm 5 (workflow test) đã được rút về AWEB-17.

---

## 6. Ràng buộc và thứ tự

1. **Không second writer trên cùng lease.** AWEB-16/17/18 đều đụng `features/**` nhưng **khác thư mục** — có thể song song nếu owner khác; cùng owner thì serialize.
2. **AWEB-20a là contract bump** → serialize với mọi thay đổi `public-api.ts`; không gộp với AWEB-14 (cũng chạm contract qua `legacy_workflow_schemas`).
3. **AWEB-16b đụng `list-query.ts`** — cùng file với AWEB-20a; nếu cùng owner, gộm gọn một lần sửa file.
4. **AWEB-18 độc lập hoàn toàn** (chỉ thêm route + screen, backend có sẵn) → chạy được ngay, nên chạy sớm.
5. **AWEB-17 độc lập** → chạy được ngay.
6. Verifier phải độc lập với implementer. Không tự revert hunk lane khác. Không commit, không push, không `git add`.

**Thứ tự đề xuất:** (1) AWEB-18 + AWEB-17 song song (rẻ, độc lập) → (2) AWEB-16a (frontend tenant scope, rẻ) → (3) AWEB-16b + AWEB-20a (backend, cùng `list-query.ts`, gộm) → (4) AWEB-19 → (5) AWEB-20b (frontend bulk cancel).

---

## 7. Bất thường cần người dùng lưu ý

`coordination/reports/` có **năm** file `feedback-frontend-*-2026-10-10.md` (DeepSeek-1, codex-1, codex-2, **qwen-b**, **qwen-c**), trong khi synthesis §1 chỉ trích 3. Hai file qwen **chưa được tổng hợp** và coordinator chưa đọc. Top 5 ở trên dựa trên 3 báo cáo đã tổng hợp + đối chiếu trực tiếp file:line; nếu hai báo cáo qwen có finding ngoài 3 báo cáo đó, cần bổ sung trước khi chốt dispatch. Đây là khoảng trống minh bạch, không phải claim đã bao quát toàn bộ đánh giá.

---

## 8. Ràng buộc từ PLAN-OPEN §7 (giữ nguyên)

Không commit, không `git add`, không push, không tick gate. Không dùng ký tự nháy kép trong prompt/file. Không đọc DB production/legacy để lấy fixture; không tạo migration chốt với DB thật. Coordinator chỉ ghi coordination/plan/report metadata; không sửa source/test/migration/Compose/Dockerfile/manifest. Mọi claim từ review/report phải đối chiếu lại với file:line trước khi ghi làm sự thật.

---

## 9. Đối chiếu thực địa 2026-10-10 — §3 đã lệch so với code

Nguồn: `coordination/reports/assessment-admin-web-current-2026-10-10.md` (đọc trực tiếp `file:line` từ
working tree, không dựa vào report của agent khác). **§3 ở trên là ảnh chụp trước khi kiểm chứng;
mục này là ảnh chụp sau.** Mọi claim trong §3 về trạng thái chưa-làm phải đọc cùng §9 này.

| Task | §3 nói | Thực tế đã kiểm chứng | Bằng chứng |
|---|---|---|---|
| AWEB-16 | cần làm | **MỘT PHẦN** — 16a xong, 16b còn nguyên | `overview-screen.tsx:327-330` đã truyền tenant; `overview-metrics.ts:230` vẫn `total = operations.length` |
| AWEB-17 | cần làm | **ĐÃ XONG** | `workflows-screen.tsx:386-396`, `:405-417` |
| AWEB-18 | cần làm | **ĐÃ XONG** | `router.tsx:43`, `features/audit/` + `tests/audit-state.test.mjs` |
| AWEB-19 | cần làm | **ĐÃ XONG** | `router.tsx:44`, `features/trace/` + `tests/trace-state.test.mjs` |
| AWEB-20a | cần làm (contract bump) | **ĐÃ XONG** | `public-api.ts:65-66,218-225` → `bff/operations.ts:46` → `list-query.ts:410-411` |
| AWEB-20b | cần làm | **ĐÃ XONG** | `operations-screen.tsx:142-179` |

**Hệ quả cho phần còn lại của §3:**

- **AWEB-16b thu hẹp thành fix nhỏ, không cần endpoint tổng hợp mới.** §3 giả định phải thêm
  aggregation server-side. Thực tế envelope `OperationsPage` đã có `total` là COUNT thật trên
  toàn tập đã lọc, không phải số dòng trả về (`public-api.ts:242`). Đủ để sửa thẻ Tổng mà không
  chạm `list-query.ts` — nghĩa là **ràng buộc serialize ở §6.3 giữa AWEB-16b và AWEB-20a không
  còn tồn tại**, vì cả hai đã xong.
- **AWEB-20a đã hoàn tất cả chuỗi.** Việc còn lại là **frontend chưa gửi** `from`/`to`:
  `operations-screen.tsx:80-87` lọc client-side trên trang đã tải, dù UI nói rõ điều đó (`:285`).
  Nói thật là tốt nhưng người dùng chỉ thấy operation trong 100 dòng trang đầu. Logic đổi ngày sang
  UTC ISO đã có sẵn trong `audit/state.ts` (`localDateTimeToUtc`) để tái dùng.
- **AWEB-17/18/19: đóng, không cần dispatch lại.** Người nhận task phải tự đọc §9 trước khi nhận
  việc — nếu không, sẽ làm lại việc đã xong.

**Task mới phát sinh — AWEB-21: deep-link URL params (chưa có trong §3).**
`buildTraceLinks` (`features/trace/state.ts:366-373`) sinh ra `/operations?id=...` và
`/audit?tenantId=...&resource=...`, nhưng **không màn hình nào trong `apps/admin-web/src` đọc URL
query params** — grep `useSearchParams`/`searchParams`/`location.search` trả về 0 kết quả. Deep-link
vì vậy mở màn hình ở trạng thái filter mặc định, im lặng bỏ qua tham số. Người dùng thấy URL đúng
và tin là đã lọc. Đây là lỗi độ trung thực cùng hạng với AWEB-16b, nhỏ và sửa được frontend-only.

| | Nội dung | Phạm vi | Phụ thuộc |
|---|---|---|---|
| **AWEB-21** | Audit và Trace đọc URL query params làm giá trị khởi tạo cho filter/lookup; deep-link sinh ra phải mở đúng màn đã lọc | `features/audit/`, `features/trace/` | — (độc lập, song song AWEB-16b/20-frontend được) |

**Ghi nhận thêm, chưa cần task riêng:** `lib/tenant-context.tsx:32` lấy cứng 100 tenant không phân
trang và không có nhãn báo giới hạn; `features/businesses/businesses-screen.tsx:47` lấy cứng 50
business không có ô tìm. Cùng loại giới hạn với AWEB-16 nhưng mức hậu quả thấp hơn vì đều có
nhãn phạm vi trên màn hình. Nếu số tenant thực tế vượt 100 thì mở thành task.

**Thứ tự đã cũ:** §6.5 đề xuất chạy AWEB-18 + AWEB-17 trước. Cả hai đã xong — thứ tự đó không
còn áp dụng. Phần còn lại: AWEB-16b (thu hẹp) và AWEB-20-frontend độc lập nhau, AWEB-21 độc lập
cả hai. Không còn tranh chấp lease `list-query.ts` giữa các task này.

---

## 10. §9 đã lại lệch — ba task cuối cũng đã xong (đối chiếu 2026-10-11)

Lần đối chiếu thứ hai trong hai ngày, và lần này theo hướng ngược lại: §9 ghi ba việc còn lại,
cả ba đã xong. Đọc trực tiếp `file:line`, không tin receipt.

| Task | §9 nói còn lại | Thực tế 2026-10-11 |
|---|---|---|
| AWEB-16b | dùng `total` từ envelope cho thẻ Tổng | **ĐÃ XONG** — `operations-monitor-dashboard.tsx:66-77` telemetry lấy từ `operationMetrics` server aggregate; `:78` `metricCount` trả `—` khi thiếu aggregate; `:108` nhãn đã đổi thành Total Operations; `:216-217` nhãn ghi rõ cửa sổ UTC + `sampledAt` + cờ stale + số dòng mẫu |
| AWEB-20 frontend | gửi `from`/`to` lên server | **ĐÃ XONG** — `features/operations/state.ts:137-140` chuyển ngày thành UTC ISO; `overview-screen.tsx:257-261` chỉ dùng metrics khi tenant + from + to khớp |
| AWEB-21 | cho Audit/Trace đọc URL params | **ĐÃ XONG** — verify độc lập `verify-aweb-21-url-params-INDEPENDENT-DSH-2026-10-10.md`: `tests/deep-link-query-hydration.test.mjs` 8/8 xanh, ổn định 3/3 lượt |

⇒ **Toàn bộ Top 5 (AWEB-16..20) + AWEB-21 đã xong.** Plan này có thể đóng. Receipt tổng hợp:
`reports/summary-frontend-admin-workspace-delivery-2026-10-10.md` (sweep 80/80, typecheck pass,
Vite build pass; chưa có browser/live acceptance — không claim).

**Về lần lệch thứ hai:** nguyên nhân là agent tiếp tục làm việc trong khi plan chưa cập nhật,
không phải do đọc sai source. Bài học đã lưu vào memory `plan-claims-stale-before-dispatch`.
Hệ quả thực tế: **mọi plan phải verify lại trạng thái ngay trước lúc dispatch**, không tin
cả §3 lẫn §9.
