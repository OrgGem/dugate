# Yêu cầu Admin board cho người trực vận hành: Operations và LLM Usage/Cost

Trạng thái: **đặc tả bổ sung, chưa phải tính năng đã nghiệm thu** (2026-09-25). Phạm vi là `du-rework/`. Các mục `ADM-UX-*` trong [kế hoạch Admin vận hành](../tasks/ADMIN-OPS-UX-2026-09-24.md) tiếp tục sở hữu list/query, search, triage và operation cockpit. Tài liệu này bổ sung dữ liệu usage/cost, cấu hình giá/ngân sách và tình huống nghiệm thu; không tự đổi các tick P6/ADM-UX hiện có.

## Góc nhìn của người trực vận hành

Trong một ca trực, tôi cần trả lời nhanh:

1. Request nào đang chờ, lỗi, quá hạn hoặc có kết quả provider `UNKNOWN`? Nó thuộc tenant, API key, business/action, profile và worker nào; đang kẹt ở bước nào, bao lâu, ai xử lý?
2. Một request đã tiêu thụ bao nhiêu input/output token và tiền, kể cả các lần thử lại; phần nào đã đo được, ước tính, chưa về hoặc chưa có giá?
3. Hôm nay/tháng này tenant, API key, business/action, profile, connector, provider và model nào dùng nhiều nhất; số operation, invocation, token, chi phí và lỗi thay đổi ra sao?
4. Giá và ngân sách nào có hiệu lực tại thời điểm gọi? Khi vượt ngưỡng, ai được cảnh báo và hệ thống chặn request mới hay chỉ cảnh báo?
5. Sau khi xử lý sự cố hoặc sửa giá, tôi đối soát được từ tổng tiền xuống từng usage event/invocation và thấy được lịch sử điều chỉnh mà không làm mất bản ghi gốc không?

## Đánh giá hiện trạng

| Có trên code/spec | Giới hạn hiện tại |
|---|---|
| Usage event có `operationId`, `taskId`, `invocationId`, input/output tokens, `costMicrousd`, USD và `measured/estimated`; Orchestrator ingest idempotent theo `eventId`, có project theo operation và summary theo tenant. | Contract không có provider/model, API key, connector revision, giá áp dụng hoặc trạng thái điều chỉnh. Summary hiện gom provider/model thiếu thành `(unattributed)`; không đủ để phân loại chi phí đáng tin cậy. |
| Admin Overview render usage rollup và operation detail có usage; API `/api/v1/usage` trả aggregate theo tenant và thời gian; **`GET /api/v1/usage/events`** đã hiện thực drill-down/export có phân trang (keyset cursor + filter allow-list), và hợp đồng **durable reservation** cho hard cap đã có ở tầng service. | **Màn hình** Usage & Cost chuyên dụng, bảng giá và ngân sách vẫn chưa có; drill-down mới chỉ có **API**, chưa có màn hình và chưa có luồng export CSV trong browser. `pending/estimated` chưa giải thích được số tiền còn chưa chốt. Chi tiết ở mục *Phần đã hiện thực ở tầng contract/service* bên dưới. |
| Admin Operations có list/detail và trạng thái. | Route list đã có **cursor keyset + filter + sort chạy ở server**: token cursor 4-slot `base64url("<ISO>\|<uuid>\|<field>:<direction>[\|p]")` mang cả hướng đi lẫn thứ tự, nên gửi cursor lệch sort trả **422 `INVALID_SCHEMA`** thay vì đọc sai lát cắt — đây là hành vi đã đọc thẳng từ source, chưa phải nghiệm thu. `sort` có đúng 6 giá trị (`created_at`/`updated_at`/`deadline_at` × `asc`/`desc`), `limit` clamp 1–100 và không 422, `total` là `COUNT(*)` của tập đã lọc chứ không phải số dòng trả về. Tuy vậy Admin **shell** chưa có sort control, chưa có receipt live six-sort/cross-sort, và các chức năng tìm kiếm cùng operator journey vẫn là acceptance mở ở ADM-UX-02..05. |
| Spec `docs/11-admin-ux.md` nêu Usage, filter/export; `docs/12-operations.md` nêu usage lag metric/alert. | Đây là yêu cầu, chưa chứng minh một luồng quản trị cost và giám sát hoàn chỉnh trên build thật. |

Các nhận định trên dựa vào `packages/contracts/src/runtime.ts`, `services/connector/src/usage.ts`, `services/orchestrator/src/modules/usage/usage.ts`, `services/orchestrator/src/server.ts` và `services/orchestrator/src/app/admin/`. Tình trạng auth tenant/role của Admin phải theo `OIDC-03`; không dùng admin bearer toàn cục hiện tại làm bằng chứng phân quyền operator.

## Điều hướng Admin board đề xuất

| Menu | Tab | Việc người trực làm |
|---|---|---|
| **Tổng quan** | Ca trực | KPI 24 giờ/hôm nay: accepted, running, waiting, failed, timed out, UNKNOWN; queue age, usage delivery lag, token/cost measured/estimated/pending, budget sắp chạm, thời điểm dữ liệu cập nhật. Mỗi ô dẫn tới danh sách đã lọc. |
| **Operations** | Tất cả; Cần xử lý; Chờ người dùng; Hoàn tất | Danh sách có bộ lọc nhiều điều kiện, saved views, trang kế tiếp/trước, sắp xếp ổn định. Chi tiết một operation có timeline, task/attempt/invocation, lỗi an toàn, artifact, usage và hành động được phép. |
| **Usage & Cost** | Xu hướng; Phân tích; Sổ usage; Đối soát | Biểu đồ theo ngày/giờ; group-by theo chiều được cấp quyền; lọc đo được/ước tính/chưa về/chưa định giá; mở từ tổng xuống operation rồi event; xuất CSV có giới hạn. |
| **Cấu hình** | Bảng giá; Ngân sách & cảnh báo | Xem, tạo bản nháp, duyệt/publish version giá; đặt ngưỡng token/tiền và chính sách vượt ngưỡng; xem lịch sử thay đổi và quyền của từng người. |

Không cần thêm một menu riêng cho mỗi trạng thái hay provider. Các tab và saved views giải quyết việc phân loại nhiều loại request mà vẫn giữ điều hướng ngắn.

## Yêu cầu chức năng

| ID | Ưu tiên | Yêu cầu và điều kiện nghiệm thu |
|---|---|---|
| MON-01 | P0 | **Tìm request đa chiều.** Lọc kết hợp theo khoảng thời gian, tenant được phép, operation/correlation ID, API key ID hoặc prefix an toàn, business/action/version, profile revision, state, error code, provider/model/connector, cost/token band, `UNKNOWN`, waiting reason và tag nghiệp vụ đã allowlist. Bộ lọc, sort, cursor chạy ở server; URL chỉ chứa ID/filter không nhạy cảm. Tổng count phản ánh query thật; next/previous không mất/trùng dòng khi có request mới. |
| MON-02 | P0 | **Triage rõ ràng.** Danh sách hiển thị state, tuổi, deadline, lần cập nhật cuối, business/action, tenant, token/cost hiện biết, cờ `usage pending`, owner/incident nếu cần can thiệp. `UNKNOWN` provider khác `FAILED` operation; không gộp vào một màu lỗi. Có saved views mặc định: quá hạn, chờ người, retry nhiều, cost cao, usage chậm, UNKNOWN. |
| MON-03 | P0 | **Chi tiết theo dòng thời gian.** Từ accepted → queue → claim → task/step → invocation → kết quả/terminal, hiển thị attempt, thời gian chờ/chạy, provider request ID an toàn, retry/cancel/resume và usage event. Cho phép drill-down qua các ID; action cancel/resume/replay dùng quyền, xác nhận và audit hiện có. Không tự động replay `UNKNOWN` vì nguy cơ gọi provider và tính tiền hai lần. |
| COST-01 | P0 | **Sổ usage có đủ chiều phân bổ.** Mỗi event gắn tenant, API key ID, operation/task/invocation/attempt, business/action/version, profile revision, connector revision, provider/model thực dùng, thời điểm phát sinh/nhận và loại đơn vị. Chụp metadata bất biến lúc invocation; không suy ngược từ profile/connector hiện tại sau khi đổi cấu hình. Event trùng chỉ tính một lần; correction/refund là event mới liên kết event gốc. |
| COST-02 | P0 | **Bảng giá có version và ngày hiệu lực.** Admin tài chính cấu hình đơn giá theo provider + model + loại đơn vị (ít nhất input/output token, có chỗ mở rộng cached token/page/image), đơn vị giá, USD và hiệu lực `[from,to)`. Server kiểm tra overlap, model chưa có giá, ngày hiệu lực và quyền publish. Lưu `priceVersion`/rate đã áp dụng trên bản ghi tính phí; đổi giá không âm thầm viết lại lịch sử. Giá provider báo về và giá tự tính hiển thị riêng, có trạng thái chênh lệch. |
| COST-03 | P0 | **Tổng hợp và đối soát.** Chọn thời gian và group-by tenant → API key → business/action → profile → connector/provider/model; hiển thị số operation duy nhất, invocation/attempt, input/output tokens, measured/estimated/pending/unpriced, cost USD và xu hướng. Tổng ở mọi cấp bằng tổng ledger theo cùng bộ lọc; quy tắc thời gian `occurredAt` so với `receivedAt` và timezone được công bố. Có drill-down đến event và export phân trang, không load toàn bộ trong browser. |
| COST-04 | P0 | **Ngân sách và cảnh báo.** Cấu hình theo tenant và tùy chọn API key/profile/business: chu kỳ ngày/tháng, ngưỡng token và USD, mức cảnh báo, owner, kênh nhận, policy `alert-only` hoặc `block-new-invocations`. Nếu chặn, reservation trước provider call và reconcile sau actual usage phải dùng chung quota scope; đang chạy/`UNKNOWN` được tính vào phần giữ chỗ. Chỉ bật hard cap khi cơ chế reservation và dữ liệu usage đủ tin cậy; nếu không, UI chỉ cho `alert-only` và nêu rõ giới hạn. |
| MON-04 | P1 | **Saved views và ca trực.** Người dùng lưu bộ lọc/sort/cột theo scope cá nhân hoặc nhóm; có link chia sẻ đã kiểm quyền, ghi chú xử lý/owner/escalation cho incident, không ghi prompt/secret vào ghi chú. |

Các yêu cầu MON-01..03 được nghiệm thu cùng `ADM-UX-02..05/07`; MON-04 là cải tiến sau gate. Bốn phần tăng thêm có trạng thái riêng:

| Task bổ sung | Trạng thái | Phụ thuộc | Gate |
|---|---|---|---|
| COST-01 — usage attribution/ledger | [ ] | Usage hiện có; contract owner | G-ADMIN-OPS |
| COST-02 — bảng giá version | [ ] | COST-01 | G-ADMIN-OPS |
| COST-03 — đối soát, query/export, UI | [ ] | COST-01/02; ADM-UX-02/03 | G-ADMIN-OPS |
| COST-04 — ngân sách, cảnh báo và reservation | [ ] | COST-03; Connector quota contract | G-ADMIN-OPS |

## Phần đã hiện thực ở tầng contract/service (chưa nghiệm thu)

Mục này **không** đổi trạng thái `[ ]` của COST-01..04 trong bảng trên và **không** đóng `G-ADMIN-OPS`. Nó chỉ ghi lại hai bề mặt đã có trong source, kèm mức bằng chứng đo được, để người đọc không phải suy từ phần yêu cầu.

### 1. `GET /api/v1/usage/events` — drill-down/export có phân trang (COST-03)

| Quy tắc | Hành vi đọc từ source |
|---|---|
| Allow-list tham số | Đúng **13** tên, đóng bằng `Set` ngay trong route **trước** khi parse. Tham số lạ **hoặc lặp** là `422 INVALID_SCHEMA`. |
| Số nguyên | `limit` 1–100 (mặc định 50), `profileRevision` không âm; route ép `/^\d+$/` trước, schema ép khoảng sau. |
| Cửa sổ thời gian | `[from,to)` nửa mở, `to` phải **sau nghiêm** `from`; span rỗng bị từ chối thay vì âm thầm trả về tất cả. |
| Cặp filter | `businessId`+`action` và `provider`+`model` phải đi **cặp**; thiếu một nửa là 422, không phải kết quả rộng hơn. |
| Cursor | base64url của `{version, tenantId, queryHash, after, eventId}`, strict khi decode; base64url không canonical bị từ chối, nên một cursor chỉ có một cách viết. |
| Ràng buộc cursor | `queryHash = sha256(JSON.stringify({tenantId, binding}))`, `binding` gồm 7 filter chiều + `from` + `to` + `timeField` + `limit`. Dùng lại cursor với tenant, filter, cửa sổ, đồng hồ sort hoặc kích thước trang khác là **422 `INVALID_ARGUMENT`**, chặn **trước** khi dựng SQL; predicate tenant vẫn bắt buộc trong SQL. |
| Đọc có giới hạn | Tối đa `limit + 1` dòng; dòng thừa chính là tín hiệu `hasMore`, và cursor mới lấy từ dòng **đã quét** cuối cùng, không phải từ dòng thừa. |
| Thứ tự | `(timeField, event_id)` tăng dần, với `timeField` là `payload->>'occurredAt'` hoặc cột `received_at`; lựa chọn được trả lại trong `timeSemantics`. |
| Phân quyền | Tenant lấy từ principal chứ không từ query: admin bearer đi qua `authorizeAuditTenantRead` rồi **bắt buộc** có `tenantId`; `x-api-key` ghim tenant của key, `tenantId` lệch là 403. |
| Audit | Mỗi trang thành công ghi `usage.export` trên `usage-events:page`, severity `info`, **không** có giá trị filter, cursor hay credential trong log. |
| Dòng hỏng | Payload không khớp ledger bị đếm vào `skippedInvalidEvents` rồi bỏ; dòng mà `eventId`/`operationId`/`tenantId` trái với key đã lưu là `500 USAGE_LEDGER_CONFLICT`, không bỏ âm thầm. |

**Bằng chứng:** receipt `COST-03-DRILLDOWN` (Tester, 2026-09-28T08:48:45+07:00) — contracts build 0; contracts `usage-event-export` + `grant-encryption-envelope` **2 suite / 18 test** 0; orchestrator `usage-drilldown` + `usage-aggregation` **2 suite / 12 test** 0; lint 0; typecheck 0. Chính receipt ghi rõ **không** có PostgreSQL live, **không** có luồng export trên trình duyệt, **không** có review độc lập, và `COST-03` cùng `G-ADMIN-OPS` vẫn mở.

### 2. Hợp đồng durable reservation cho hard cap (COST-04)

Đây là **service**, không phải route: `BudgetReservationService` trong `services/orchestrator/src/modules/usage/budget-reservations.ts` được gọi nội bộ, nên không sinh dòng nào trong bảng route nào của tài liệu này.

| Quy tắc | Hành vi đọc từ source |
|---|---|
| Vòng đời | `RESERVED`, `RUNNING`, `UNKNOWN`, `RECONCILED`, `RELEASED`, `BLOCKED`. Giữ chỗ tính cả lúc `RESERVED`/`RUNNING`/`UNKNOWN` — lần gọi provider đang chạy hoặc chưa biết vẫn nằm trong reservation. |
| Nhả chỗ phải có bằng chứng | `RELEASED` chỉ hợp lệ kèm `confirmedNotSent: true`; cắm cờ đó vào trạng thái khác là 422. Chỉ hold `RESERVED` mới nhả được, và phải trước lúc gọi. |
| Reconcile phải trỏ event | Reservation ở `RECONCILED` bắt buộc có `usageEventId`. Reconcile ghi usage thực và đóng hold **nguyên tử**; replay trả lại đúng dòng cũ kèm `duplicate: true`. |
| Hard cap cần upper bound | `confidence` là `upper-bound` hoặc `best-effort`; hard cap chỉ dùng `upper-bound`, vì ước tính best-effort không bảo vệ được quota. |
| Cổng tin cậy | `isBudgetReservationTrusted` cần đủ **bốn** cờ: `durableAtomicStore`, `sharedQuotaScope`, `validatedUsageLedger`, `boundedReservation`. Thiếu một là không bật hard cap. |
| Fail closed | Lỗi lưu trữ hoặc lỗi quyết toán trả `503 BUDGET_RESERVATION_UNAVAILABLE` **trước** khi admit; ngân sách alert-only vẫn ghi được hold best-effort. |
| Scope và cửa sổ | `quotaScope` phải khớp **chính xác** scope của budget; cửa sổ ngày/tháng tính trong UTC để mọi replica và event đến muộn rơi vào cùng khoảng nửa mở. |
| Bền vững | Migration `0022_budget_reservations.sql` tạo bảng cộng **hai** unique index (`usage_events.budget_reservation_id`, `budget_reservations.usage_event_id`) và một FK, nên một reservation chỉ được reconcile bởi tối đa một usage event và chiều ngược lại cũng vậy. Giao dịch admit khoá advisory theo scope và cửa sổ chuẩn trên PostgreSQL. |

**Bằng chứng:** receipt `COST-04-RESERVATION` (Tester, 2026-09-28T09:12:26+07:00) — contracts build/tsc 0, contracts test **23 suite / 463 test** 0, orchestrator typecheck 0, orchestrator **4 suite / 50 test** 0 (cùng scope đồng thời, admit và reconcile idempotent, rollover UTC, giữ RUNNING/UNKNOWN, chặn scope, tin cậy upper-bound, lỗi DB fail-closed, release có bằng chứng). Receipt thứ hai, `T-CODEX-OFFLINE-COST-04-RESERVATION-INDEPENDENT`, tự nói là read-only độc lập: **3 suite / 33 test** 0 và orchestrator `tsc --noEmit` 0 — lần đó không chạy `migrations-ledger-guard.test.ts`, nên con số là 33 chứ không phải 50.

**Còn thiếu, không được coi là đã xong:** chưa chạy migration trên PostgreSQL live và chưa có race reservation live (suite migration live bị bỏ qua khi không có DB window), và **chưa** có call-site connector nào được chạy. Tức là **đã hiện thực + verified offline**, chưa live-verified. Màn hình Ngân sách & cảnh báo trong mục *Điều hướng* vẫn chưa có, nên `hard cap` hiện chưa có đường tới người trực.

> **Cần coordinator xác minh:** cột "Gate" trong bảng trên ghi `G-ADMIN-OPS`, nhưng trong `coordination/gates/` hiện **không có** file mang tên đó (chỉ có `contracts-v1`, `integration-e2e-ready`, `integration-usage-ready`, `runtime-ready`, `sdk-ready`, `workspace-ready`). Tên gate ở đây là điều receipt và tài liệu này dùng, không phải điều tôi kiểm chứng được từ một file gate.

## Quy tắc số liệu và bảo mật

- `0 token` là số đo bằng không; `pending` là chưa nhận usage; `unpriced` là có đơn vị nhưng chưa tìm được giá; `estimated` khác `measured`. Không đổi thiếu dữ liệu thành cost 0 để tạo cảm giác chi phí đã chốt.
- Mọi cost dùng số nguyên micro-USD ở ledger; UI mới định dạng USD. Không dùng số thực để cộng tiền. Nếu có ngoại tệ/thuế/markup về sau, cần contract và version quy đổi riêng.
- Một operation có thể có nhiều invocation, retry và child task. Số operation là distinct operation ID; token/cost cộng theo event billable sau dedup/correction. Hiển thị cả cost của operation lỗi/cancel nếu provider đã tính phí.
- Projection nêu `asOf`, `receivedThrough`, độ trễ và trạng thái nguồn. Dữ liệu chưa về/Connector outbox kẹt phải tạo cảnh báo, không hiển thị dashboard xanh giả.
- API list/detail/export phải lọc tenant/role ở server trước khi query/aggregate; tài khoản viewer chỉ đọc, operator chỉ làm action được cấp quyền, người cấu hình giá/ngân sách có quyền riêng. Ghi audit cho publish giá, thay ngân sách, export và hành động operation. Không xuất raw API key, provider key, prompt, tài liệu, signed URL hoặc upstream error.
- Cấu hình giá và ngân sách có draft → review → publish với expected revision/CAS. Phiên bản đã publish là bất biến; sửa bằng version mới. Mọi thay đổi có actor, thời điểm, lý do và diff an toàn.

## Luồng nghiệm thu của người trực

1. **Tìm request đang kẹt:** từ ô `Waiting/UNKNOWN` trên Tổng quan, mở Operations đã lọc, xác định tenant/action/tuổi/bước kẹt trong ≤3 thao tác; thấy owner, runbook và thời điểm cập nhật. Kiểm tra không lẫn `UNKNOWN` với failed hoặc tự gọi lại provider.
2. **Giải thích một hóa đơn cao:** chọn kỳ và tenant, group-by API key → business/action → model, mở operation và usage event. Tổng micro-USD khớp ledger; input/output token và version giá rõ; retry đã trả phí không bị mất, event duplicate không cộng hai lần.
3. **Cấu hình giá:** publish version giá mới có ngày hiệu lực; hai invocation trước/sau mốc dùng đúng version, báo `unpriced` cho model chưa khai giá; sửa giá bằng version/correction có audit, bản ghi cũ không đổi âm thầm.
4. **Kiểm soát ngân sách:** đặt cảnh báo 80% và hard cap 100% trên fixture có reservation; nhiều Connector replica gọi đồng thời không vượt chính sách chặn request mới; actual usage đến muộn giải phóng/điều chỉnh reservation đúng một lần. Nếu chưa có reservation, UI không cho chọn hard cap.
5. **Phân quyền và quy mô:** hai tenant có dữ liệu giống ID/filter vẫn không đọc lẫn qua list, count, detail, export hoặc saved view; 1.000+ operation và nhiều usage event phân trang ổn định; browser 320px/desktop vẫn tới được cột/hành động cuối bằng bàn phím.

## Bổ sung vào backlog hiện có

- `ADM-UX-02/03/04/05/07` nhận các điều kiện MON-01..03 về query, deep link, overview, cockpit và browser gate; không tạo implementation list/filter song song.
- `COST-01` mở rộng usage contract, connector event và metadata/ledger; cần migration + backfill policy, consumer compatibility và test dedup/correction.
- `COST-02` là service/API + Admin cấu hình giá; `COST-03` là projection/query/export + UI Usage & Cost; `COST-04` là policy/alert/reservation + UI ngân sách. Thứ tự: COST-01 → COST-02 → COST-03; COST-04 alert-only có thể triển khai sau COST-03, hard cap chỉ sau reservation/concurrency proof.
- `G-ADMIN-OPS` bổ sung các luồng nghiệm thu MON-01..03 và COST-01..04 trước khi dùng Admin board làm công cụ vận hành; MON-04 là cải tiến sau gate. `P8-07` nhận dashboard/alert/runbook và `G-SEC` nhận quyền tenant/role cùng audit. Không suy từ P6-07 `[x]` rằng cost control đã hoàn tất.
