# Admin Portal — Review tính năng vận hành theo từng page + Plan bổ sung (2026-10-08)

> **Góc nhìn tác giả:** người vận hành hệ thống / hỗ trợ sự cố (system monitoring + ops support), đọc như ca trực thật. Không sửa source sản phẩm, không dispatch, không tick gate.
> **Đối tượng:** SPA React `orchestrator/apps/admin-web/` (mount `/admin/web/*`) + BFF `/admin/api/*` + legacy shell `/admin/*`.
> **Yêu cầu đã nhận:** mỗi page tối thiểu 3 tính năng bổ sung; mỗi tính năng phải trả lời rõ: **cần nhìn thấy gì · làm được chức năng gì · vì sao cần · để làm gì**.

## 0. Quan hệ với plan đang có (không trùng lặp)

| Plan | Phạm vi | Quan hệ với tài liệu này |
|---|---|---|
| [ADMIN-SYSTEM-OPERATIONS-SUPERSET-2026-10-05](ADMIN-SYSTEM-OPERATIONS-SUPERSET-2026-10-05.md) | Spec màn hình/đối tượng vận hành (AOPS-*) | Giữ nguyên; tài liệu này **đi xuống từng page đã có** và chỉ ra phần còn thiếu |
| [ADMIN-OPS-UX-2026-09-24](ADMIN-OPS-UX-2026-09-24.md) | Checklist nghiệm thu ADM-UX-* (journey, phân trang, responsive, audit) | Giữ nguyên; nhiều mục ở đây mới chỉ khép cho legacy shell, SPA chưa có |
| [ADMIN-CONTROL-PLANE-UI](ADMIN-CONTROL-PLANE-UI-2026-10-02.md) / [ADMIN-WEB-DELIVERY](ADMIN-WEB-DELIVERY-2026-10-04.md) / [ADMIN-LEGACY-CONFIG-PARITY](ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) | Phiên bản hoá config, React/BFF, parity settings | Giữ nguyên; các hạng mục `SET-*`, `SEC-*` nối vào đây |

ID mới dùng tiền tố `OPU-` (ops-ux). Đây là **sub-packet nghiệm thu của parent hiện hữu**, KHÔNG phải release gate mới, không cộng trùng tiến độ của `G-ADMIN-OPS` / `P8-07`. Cột `[mới]` = chưa có trong plan nào; `[AOPS-xx]` / `[ADM-UX-xx]` = đã được spec, việc còn lại là **dispatch + bằng chứng**, không viết lại spec.

## 1. Khung đánh giá — ca trực cần 4 thứ theo thứ tự

1. **Tín hiệu** — hệ thống đang ổn không, chỗ nào đang đỏ, và số đó có cũ không.
2. **Bối cảnh** — ai đụng, cái gì đổi, bao giờ, revision nào đang chạy.
3. **Hành động** — thao tác để giảm thiểu, và thao tác để đổi cấu hình.
4. **Bằng chứng** — sau khi xử lý thì chứng minh bằng gì (audit, log, số liệu trước/sau).

Portal hiện đáp ứng tốt mục 3 ở vài chỗ (Connectors/API keys/Secrets có confirm + CAS) và gần như **không có mục 1**. Đó là khoảng trống chính của tài liệu này.

## 2. Cross-cutting (chrome toàn portal) — nền cho mọi page

**Hiện trạng đã verify:** header chỉ có brand + đồng hồ + account + logout; `client.ts` **không có** bất kỳ lời gọi health/ready/uptime (grep 0 hit); toàn SPA chỉ có **một** `setInterval` là đồng hồ (`app-shell/app-shell.tsx:30`); mọi filter là `useState` cục bộ nên F5 là mất.

1. **`OPU-G1` Dải sức khoẻ toàn cục** [mới] — *Thấy:* PG/Redis/queue-integrity/lease/outbox backlog + thời điểm mẫu cuối, ở mọi trang. *Làm:* bấm để drilldown. *Vì sao:* không có gì trên khung cửa sổ để biết hệ thống có đang phục vụ không. *Để làm gì:* phát hiện sụp đổ trong dưới 1 phút mà không phải mở trang khác.
2. **`OPU-G2` Auto-refresh + "dữ liệu tại thời điểm"** [mới] — *Thấy:* mọi list/detail có nút refresh, auto-refresh bật/tắt, và nhãn tuổi dữ liệu. *Làm:* pause, refresh ngay. *Vì sao:* danh sách chỉ nạp lúc mount; operation đang `RUNNING` không bao giờ tự cập nhật. *Để làm gì:* ca trực không phải F5 thủ công, và không nhầm số cũ là số đang.
3. **`OPU-G3` Deep-link trạng thái lọc (URL là nguồn sự thật)** [ADM-UX-03 mở rộng sang SPA] — *Thấy:* filter/limit/cursor/sort nằm trên URL. *Làm:* copy link, F5, back, mở tab mới — giữ nguyên bộ lọc. *Vì sao:* hiện là state cục bộ. *Để làm gì:* bàn giao ca (dán link cho ca sau) và tái lập lỗi từ link của khách báo.
4. **`OPU-G4` Toast + error boundary toàn cục** [mới] — *Thấy:* kết quả mutation ở mọi nơi, kể cả khi đang cuộn chỗ khác. *Làm:* bỏ, click để nhảy tới ngữ cảnh. *Vì sao:* lỗi 403/502 chỉ hiện trong banner dễ trôi khỏi tầm nhìn. *Để làm gì:* không bỏ sót thao tác thất bại giữa lúc đang xử lý việc khác.

## 3. Review theo từng page

### 3.1 Bootstrap `/` (`routes/bootstrap-home.tsx`)

**Hiện trạng:** loader `mountedAt/mode`, card phiên (principal/role/plane/tenant scope/CSRF), danh sách tĩnh "Coming next (AWEB plan)", link sang Overview. Chưa có call nào ngoài `/admin/api/session`.

1. **`OPU-BST-1` Card build + runtime** [mới] — *Thấy:* version/digest của backend, môi trường, thời điểm boot. *Làm:* copy để dán vào báo cáo sự cố. *Vì sao:* nhiều lane, nhiều build; không biết đang chạy bản nào thì mọi bằng chứng không gắn được. *Để làm gì:* liên kết evidence ↔ đúng build.
2. **`OPU-BST-2` Xem trước quyền theo vai trò** [mới] — *Thấy:* ngay trong phiên là biết mình được làm gì (issue/revoke key, quản lý connector, publish profile). *Làm:* điều hướng tới đúng màn. *Vì sao:* gating fail-closed khiến người dùng chỉ biết mình không có quyền sau khi bấm lỗi. *Để làm gì:* không mất thời gian thử rồi 403.
3. **`OPU-BST-3` Thay khối "Coming next" bằng lối vào theo vai trò + sức khoẻ** [mới] — *Thấy:* nhóm link ngắn dành cho operator, và tóm tắt sức khoẻ. *Làm:* một cú nhảy. *Vì sao:* đây là trang neo và đang mang nội dung scaffold. *Để làm gì:* trang đầu tiên vào có giá trị vận hành ngay.

### 3.2 Overview `/overview` (`features/overview/overview-screen.tsx`)

**Hiện trạng đã verify:** chỉ có card phiên + bảng audit 25 dòng không filter, và 2 ô ghi `requires backend` (`overview-screen.tsx:301`). Không có số liệu vận hành nào. Không hề gọi health.

1. **`OPU-OVR-1` Khối triage vận hành bằng số thật** [AOPS-M02] — *Thấy:* failed / timed-out / pending-active / stalled dispatch (queue quá 120s) + tuổi dữ liệu của từng số. *Làm:* bấm sang Operations với filter đã sẵn. *Vì sao:* hai ô hiện là placeholder, trong khi legacy Overview đã có panel triage. *Để làm gì:* trả lời "đang có vấn đề gì" trong 5 giây đầu vào ca.
2. **`OPU-OVR-2` Thẻ sức khoẻ + phụ thuộc** [AOPS-M05] — *Thấy:* PG/Redis/queue-integrity/lease hoạt động/backlog, mỗi mục có live/stale/unavailable + thời điểm lấy mẫu. *Làm:* drilldown. *Vì sao:* phân biệt "tiến trình còn sống" với "đang sẵn sàng phục vụ" là khác biệt giữa cảnh báo giả và mất dữ liệu thật. *Để làm gì:* không kết luận sai nguyên nhân khi HTTP vẫn 200.
3. **`OPU-OVR-3` Audit đầy đủ ngay tại Overview hoặc trang Audit riêng** [mới] — *Thấy:* lọc severity/actor/action/resource/thời gian, phân trang cursor, đếm dòng bị loại. *Làm:* lọc "15 phút qua có ai đổi gì". *Vì sao:* BFF đã hỗ trợ 9 tham số lọc nhưng SPA chỉ render 25 dòng trần, không có route Audit. *Để làm gì:* khi có sự cố do cấu hình đổi, truy ra người và thời điểm dưới 1 phút.
4. **`OPU-OVR-4` Cảnh báo đang mở + ngân sách còn lại** [AOPS-M01] — *Thấy:* sự cố chưa xác nhận, ngân sách đã dùng %. *Làm:* nhảy thẳng tới nơi xử lý. *Vì sao:* Overview hiện không ưu tiên việc gì đang cháy. *Để làm gì:* ca trực nhìn đúng thứ cần can thiệp, không phải bảng log.

### 3.3 Operations `/operations` (`features/operations/operations-screen.tsx`)

**Hiện trạng:** mạnh nhất portal — lọc state/tenant/limit, phân trang, detail có bảng Task + Artifact + input/result, cancel/retry có idempotency key và confirm. Đã verify: `downloadUrl` **chỉ được parse** (`features/operations/state.ts:57`) mà không render link tải.

1. **`OPU-OPS-1` Sống theo thời gian thật cho operation đang chạy** [mới] — *Thấy:* elapsed đếm ngược tự chạy, state tự đổi khi xong. *Làm:* bật/tắt theo trang. *Vì sao:* không có bất kỳ polling nào. *Để làm gì:* biết ngay khi job HITL/queue hoàn tất mà không phải canh F5.
2. **`OPU-OPS-2` Tải artifact + kết quả** [mới] — *Thấy:* link tải trên từng dòng artifact. *Làm:* tải/xem trước. *Vì sao:* URL đã có trong dữ liệu, chỉ thiếu link. *Để làm gịch:* đối chiếu kết quả với nguồn khi hỗ trợ khách.
3. **`OPU-OPS-3` Timeline vận hành + đường dẫn log** [AOPS-05] — *Thấy:* trình tự task → worker → outbox → lần thử, kèm mã lỗi và correlationId. *Làm:* mở log theo correlationId. *Vì sao:* detail hiện là hai bảng phẳng, không có trục thời gian. *Để làm gì:* chỉ ra khâu vỡ mà không phải dò code.
4. **`OPU-OPS-4` Lọc theo khoảng thời gian + tìm theo id + chọn nhiều để cancel** [ADM-UX-03] — *Thấy:* date-range, `id` substring, chọn nhiều dòng. *Làm:* lọc "failed 24h qua", cancel cả lô. *Vì sao:* route đã cho phép `id` và `tenant` nhưng toolbar không dùng. *Để làm gì:* dựng mốc thời gian điều tra và dọn job lỗi hàng loạt.

### 3.4 Usage `/usage` (`features/usage/usage-screen.tsx`)

**Hiện trạng:** chọn tenant + from/to rồi in **JSON thô** trong thẻ `<pre>` (`usage-screen.tsx:16`). Không bảng, không biểu đồ, không tổng.

1. **`OPU-USG-1` Bảng tổng hợp theo provider/model + dải tổng** [AOPS-02] — *Thấy:* dòng tokens vào/ra, chi phí, số operation, có tổng cộng. *Làm:* sắp xếp theo chi phí. *Vì sao:* blob JSON thô không đọc được khi đang cần quyết định. *Để làm gì:* trả lời "tháng này tốn bao nhiêu, của provider nào".
2. **`OPU-USG-2` Biểu đồ theo thời gian + so sánh kỳ trước** [AOPS-02] — *Thấy:* đường/cột chi phí và token theo giờ/ngày, phần trăm lệch kỳ trước. *Làm:* chọn preset 24h/7d/30d. *Vì sao:* portal hiện không có biểu đồ nào. *Để làm gì:* thấy đột biến chi phí/traffic trước khi khách khiếu nại.
3. **`OPU-USG-3` Ngân sách và ngưỡng cảnh báo** [COST-04] — *Thấy:* đã dùng %, còn lại, cảnh báo khi vượt. *Làm:* mở cảnh báo. *Vì sao:* contract budget-alert đã có nhưng UI chưa thấy. *Để làm gì:* chặn hóa đơn bất ngờ.
4. **`OPU-USG-4` Xuất CSV theo cửa sổ** [mới] — *Thấy:* file theo bộ lọc đang chọn. *Làm:* tải. *Vì sao:* phải chép tay khi đối soát. *Để làm gì:* nộp báo cáo tài chính và đối soát với provider.

### 3.5 API keys `/api-keys` (`features/api-keys/api-keys-screen.tsx`)

**Hiện trạng:** issue/revoke + copy-once + gating tốt. Nút **Rotate** và **Disable** bị vô hiệu hoá vĩnh viễn với lý do "chưa có backend action". Bảng thiếu last-used/expiry; phân trang bị parse rồi bỏ.

1. **`OPU-KEY-1` Bật hoặc gỡ hẳn Rotate/Disable** [CFGADM-05] — *Thấy:* trạng thái trung thực. *Làm:* xoay key nghi bị lộ trong một thao tác. *Vì sao:* nút chết tạo cảm giác chức năng đang hỏng thay vì chưa có. *Để làm gì:* khoanh vùng sự cố lộ credential trong thời gian ngắn nhất.
2. **`OPU-KEY-2` Last-used + hạn dùng + prefix/người tạo** [CFGADM-05] — *Thấy:* key nào đang chạy, key nào sắp hết hạn. *Làm:* thu hồi key chết. *Vì sao:* legacy shell đã hiển thị Last used/Revoked; SPA bỏ. *Để làm gịch:* dọn credential và biết key nào còn dùng thật.
3. **`OPU-KEY-3` Phân trang + lọc theo trạng thái/tenant + deep link** [ADM-UX-03] — *Thấy:* con trỏ và tổng số (đang có trong dữ liệu). *Làm:* lọc ACTIVE/REVOKED. *Vì sao:* giới hạn cứng 25 dòng, không có phân trang. *Để làm gì:* quản lý được hàng trăm key thay vì chỉ trang đầu.

### 3.6 Connectors `/connectors` (`features/connectors/connectors-screen.tsx`)

**Hiện trạng:** gating theo capability (fail-closed) + confirm cho disable/retire + import cURL — tốt nhất về an toàn. Thiếu: lịch sử revision, lịch sử test, số đo latency/lỗi/quota, nút Rotate bị vô hiệu hoá trong khi legacy shell đã có form rotate.

1. **`OPU-CON-1` Lịch sử test + mốc test gần nhất theo revision** [AOPS-06] — *Thấy:* thời điểm, kết quả, mã lỗi. *Làm:* chạy lại test. *Vì sao:* hiện chỉ có badge kết quả tức thời. *Để làm gì:* chứng minh provider đã phục hồi bằng bằng chứng theo thời gian.
2. **`OPU-CON-2` Số đo sức khoẻ provider: lỗi, 429, độ trễ, quota** [AOPS-06] — *Thấy:* tỉ lệ lỗi theo thời gian, hạn mức còn lại, p95. *Làm:* drilldown vào invocation. *Vì sao:* badge trạng thái là tĩnh, không nói provider đang lỗi hay chỉ cấu hình sai. *Để làm gì:* phân biệt "sửa cấu hình" với "chờ provider".
3. **`OPU-CON-3` Lịch sử revision + so sánh + sửa theo bản sao** [AOPS-06] — *Thấy:* toàn bộ revision của một connector + diff. *Làm:* rollback về revision trước. *Vì sao:* upsert chỉ hỗ trợ tạo mới, không có danh sách lịch sử. *Để làm gịch:* quay lui khi revision mới làm hỏng. [mới so với legacy: legacy có revision comparison]
4. **`OPU-CON-4` Nối hoặc gỡ nút Rotate chết** [CFGADM-07] — *Thấy:* trạng thái trung thực. *Làm:* xoay secret. *Vì sao:* có form rotate ở legacy shell nhưng nút SPA chết. *Để làm gịch:* xoay credential connector mà không phải qua hai bề mặt khác nhau.

### 3.7 Profiles `/profiles` (`features/profiles/profiles-screen.tsx`, 976 dòng)

**Hiện trạng:** editor theo dòng rất đầy đủ (khoá slot, redaction, callback policy, fileUrlAuth, prompt override). Nhưng **không có danh sách profile**, không có lịch sử revision/diff, Publish/Rollback bấm là chạy không hỏi, "Effective config preview" là placeholder.

1. **`OPU-PRF-1` Danh sách profile + tìm kiếm** [CFGADM-05] — *Thấy:* profile theo business/version, trạng thái revision. *Làm:* mở thẳng. *Vì sao:* phải tự gõ business + version + tên profile để mở. *Để làm gịch:* người vào mới biết hệ thống có những gì.
2. **`OPU-PRF-2` Lịch sử revision + diff + xác nhận Publish/Rollback** [CFGADM-05/ACUI] — *Thấy:* khác biệt từng revision, ai sửa, lúc nào. *Làm:* xác nhận trước khi rollback. *Vì sao:* Publish/Rollback chạy ngay khi bấm, legacy shell có bảng diff. *Để làm gịch:* không đổi nhầm profile đang phục vụ production.
3. **`OPU-PRF-3` Xem cấu hình hiệu dụng (effective)** [ACUI-09] — *Thấy:* giá trị đang thực sự chạy + nguồn của từng trường (mặc định/ghi đè/khoá). *Làm:* mở từ dòng. *Vì sao:* card này đang ghi `requires backend` trong khi đây là câu hỏi vận hành số một. *Để làm gịch:* trả lời "cấu hình nào đang thực sự chạy".
4. **`OPU-PRF-4` Trình soạn prompt mặc định + preset** [CFGADM-02] — *Thấy:* 5 prompt, preset EN/VI, nơi dùng. *Làm:* sửa → kiểm tra → phát hành. *Vì sao:* hiện chỉ có một ô textarea thô. *Để làm gịch:* chỉnh prompt an toàn thay vì sửa JSON tay.

### 3.8 Businesses `/businesses` (`features/businesses/businesses-screen.tsx`)

**Hiện trạng đã verify:** bảng business + bảng version với Enable/Activate/Deactivate — và **không có** `ConfirmDialog`/`window.confirm` (grep 0 hit), khác hẳn Connectors/API keys. Không phân trang, `total` bị bỏ, không tìm kiếm.

1. **`OPU-BIZ-1` Hộp xác nhận cho Enable/Activate/Deactivate** [mới] — *Thấy:* phạm vi ảnh hưởng trước khi bấm. *Làm:* xác nhận/huỷ. *Vì sao:* Activate đổi luồng traffic thật, mà UI bấm là chạy. *Để làm gịch:* không vô tình chuyển sang version lỗi giữa ca.
2. **`OPU-BIZ-2` Phân trang + tìm kiếm + tổng số** [ADM-UX-03] — *Thấy:* tổng số bị bỏ khỏi dữ liệu. *Làm:* lọc theo trạng thái. *Vì sao:* giới hạn cứng 50. *Để làm gịch:* quản lý được registry lớn.
3. **`OPU-BIZ-3` Chi tiết version: số job đang chạy + diff + trạng thái drain** [CFGADM-10] — *Thấy:* version nào đang phục vụ, có job dở dang không, khác biệt hai version. *Làm:* deactivate có kiểm soát. *Vì sao:* `DRAINING` là trạng thái có thật nhưng không được thể hiện. *Để làm gịch:* thay version mà không làm rơi job đang chạy.

### 3.9 Workflows `/workflows` (`features/workflows/workflows-screen.tsx`)

**Hiện trạng:** chỉ có cảnh báo tĩnh + thẻ rỗng; không có route BFF; và route này **không nằm trong** allow-list `DU_ADMIN_WEB_ROUTES` nên không thể bật qua cờ.

1. **`OPU-WFL-1` Trạng thái thay vì trang rỗng** [mới] — *Thấy:* schema/named process đã đăng ký + mức độ sẵn sàng (admission đã có / runtime còn mở). *Làm:* mở chi tiết schema. *Vì sao:* facade workflow đã chạy thật nhưng portal không thấy gì. *Để làm gịch:* biết tính năng mới đang ở đâu để cập nhật người dùng.
2. **`OPU-WFL-2` Danh sách execution workflow + hàng đợi chờ người** [AOPS-05] — *Thấy:* workflow nào đang chạy, cái nào đang `WAITING_INPUT`. *Làm:* mở để tiếp tục/huỷ. *Vì sao:* việc chờ người là hàng đợi vận hành thật. *Để làm gịch:* xử lý HITL kịp thời thay vì để khách chờ. [WFA plan T25..28]
3. **`OPU-WFL-3` Danh mục schema: revision, digest, tenant pin, kiểm tra admission** [AOPS-02] — *Thấy:* schema nào đang active, đã mã hoá chưa. *Làm:* kiểm tra một schema trước khi tin là nhận. *Vì sao:* catalog workflow đã có migration riêng nhưng UI không có. *Để làm gịch:* chẩn đoán lỗi admission mà không cần đọc DB.

### 3.10 Security / crypto-config `/security` (`features/security/security-screen.tsx`)

**Hiện trạng:** form 3 trường + thẻ hiển thị **JSON thô** của cấu hình; apply không hỏi, không diff, không lịch sử; 503 có thẻ riêng báo cần xử lý triển khai.

1. **`OPU-SEC-1` Bảng kiểm kê khoá thay cho khối JSON** [ACUI-04] — *Thấy:* từng khoá: tham chiếu, phiên bản, tuổi, thuật toán, vân tay. *Làm:* chọn khoá để xoay. *Vì sao:* hiện là `JSON.stringify` trong `<pre>`, không đọc được. *Để làm gịch:* biết khoá nào đã cũ và chưa từng được xoay.
2. **`OPU-SEC-2` Kiểm thử mã hoá vòng đi qua + sức khoẻ Vault** [ACUI-06] — *Thấy:* kết quả thật của một phép mã hoá/giải mã thử. *Làm:* thử trước khi áp dụng. *Vì sao:* không có nút kiểm thử nào trên trang cấu hình mã hoá. *Để làm gịch:* tin được cấu hình mã hoá đang hoạt động trước khi bật cho tenant.
3. **`OPU-SEC-3` Lịch sử thay đổi + diff khi áp dụng** [mới] — *Thấy:* ai đổi gì, lúc nào, khác biệt trước/sau. *Làm:* xác nhận. *Vì sao:* apply không có xác nhận, không diff, không lịch sử. *Để làm gịch:* truy vết khi sự cố phát sinh từ cấu hình mã hoá.

### 3.11 Secrets `/secrets` (`features/secrets/secrets-screen.tsx`)

**Hiện trạng:** mạnh về an toàn (write-only, CAS, test nội tuyến, từ chối cả dòng nếu lộ giá trị). Thiếu: hiển thị lịch xoay dù dữ liệu đã có, không lọc, không phân trang, không drilldown người dùng.

1. **`OPU-SRT-1` Lịch xoay: hiển thị `rotatedAt`/`intervalDays` + danh sách "đến hạn xoay"** [mới] — *Thấy:* secret nào sắp/trễ lịch. *Làm:* xoay ngay từ danh sách. *Vì sao:* dữ liệu lịch đã được parse nhưng không hiển thị. *Để làm gịch:* credential hết hạn chính là một kiểu sự cố dự đoán được — phòng ngừa rẻ hơn chữa.
2. **`OPU-SRT-2` Lọc theo trạng thái/mục đích/dịch vụ + tìm + phân trang** [ADM-UX-03] — *Thấy:* chip lọc. *Làm:* ra danh sách secret chưa dùng. *Vì sao:* giới hạn cứng 100, con trỏ bị bỏ qua. *Để làm gịch:* dọn secret chết, tránh xoay nhầm.
3. **`OPU-SRT-3` Ai đang dùng secret này + xoay theo lô** [mới] — *Thấy:* danh sách consumer. *Làm:* xoay có thứ tự theo lô. *Vì sao:* cột Usage đã có dạng tham chiếu nhưng chưa có đường đi sâu. *Để làm gịch:* xoay mà không biết ai đang dùng thì đứt dịch vụ.

### 3.12 Identity `/identity` (`features/identity/identity-screen.tsx`)

**Hiện trạng:** phiên hiện tại + chế độ xác thực + OIDC metadata + CRUD user (có kiểm lại bằng đọc lại sau khi ghi — rất tốt). Thẻ tên là "Users & sessions" nhưng **chỉ có user**; không khoá, không reset mật khẩu, không xác nhận khi đổi vai trò.

1. **`OPU-IDN-1` Danh sách phiên đăng nhập theo user** [mới] — *Thấy:* phiên nào đang mở, mở lúc nào, thấy lần cuối. *Làm:* thu hồi phiên. *Vì sao:* nhãn thẻ hứa có sessions nhưng không có. *Để làm gịch:* khi nghi tài khoản bị dùng trái phép, thu hồi được ngay thay vì đợi hết thời hạn token.
2. **`OPU-IDN-2` Khoá/mở khoá/vô hiệu + đặt lại mật khẩu + xác nhận đổi vai trò** [CFGADM-08] — *Thấy:* trạng thái + hộp xác nhận. *Làm:* khoá tài khoản bị lộ. *Vì sao:* không có hành động khoá, không xác nhận khi đổi vai trò. *Để làm gịch:* cô lập sự cố truy cập trong vài phút.
3. **`OPU-IDN-3` Đăng nhập gần nhất / MFA / IP + nhật ký theo user** [mới] — *Thấy:* hoạt động bất thường. *Làm:* mở nhật ký lọc theo user. *Vì sao:* hiện chỉ có "Updated". *Để làm gịch:* phát hiện đăng nhập lạ trước khi thiệt hại nặng.

### 3.13 Settings `/settings` (`features/settings/settings-screen.tsx`)

**Hiện trạng đã verify:** trang **không gọi mạng lần nào** (grep `fetch(`/`client.` = 0 hit) — hoàn toàn tĩnh, dù BFF đã có `GET /admin/api/settings`. Nút Apply/Replace/Retire vĩnh viễn bị vô hiệu hoá.

1. **`OPU-SET-1` Nối wire đọc đã có: giá trị mong muốn và giá trị đang áp dụng** [CFGADM-01..04/AOPS-M03] — *Thấy:* giá trị thực tế từ service + trạng thái đã áp dụng chưa. *Làm:* mở form sửa. *Vì sao:* BFF đã có đường đọc nhưng phía SPA không có phương thức tương ứng. *Để làm gịch:* trả lời "cấu hình nào đang chạy" mà không phải đọc file cấu hình.
2. **`OPU-SET-2` Chênh lệch mong muốn ↔ quan sát + hướng dẫn áp dụng** [AOPS-M03] — *Thấy:* phần đã khai báo nhưng chưa ăn. *Làm:* gửi thay đổi qua quy trình triển khai. *Vì sao:* hướng dẫn reload không chứng minh cấu hình đã có hiệu lực. *Để làm gịch:* chẩn đoán kiểu cấu hình "đã sửa mà không ăn".
3. **`OPU-SET-3` Trạng thái vận hành: maintenance/feature flag/giữ dữ liệu** [AOPS-07] — *Thấy:* cái gì đang bật/tắt. *Làm:* bật chế độ bảo trì. *Vì sao:* trang không có trạng thái runtime nào. *Để làm gịch:* cô lập sự cố và chặn việc mới trong lúc sửa chữa.
4. **`OPU-SET-4` Xác nhận lại (re-auth) cho thao tác nhạy cảm** [ACUI] — *Thấy:* bước xác nhận danh tính. *Làm:* nhập lại mật khẩu. *Vì sao:* chưa có. *Để làm gịch:* chặn thao tác phá huỷ từ phiên bị chiếm.

### 3.14 Documentation `/docs` (`features/docs/docs-screen.tsx`)

**Hiện trạng:** danh mục 13 endpoint + modal Test Workbench (có chặn quyền trước khi gọi). Nav ghi "Documentation" nhưng **không có tài liệu nào**, và route này cũng không nằm trong `DU_ADMIN_WEB_ROUTES`.

1. **`OPU-DOC-1` Sổ tay xử lý sự cố theo triệu chứng** [AOPS-09] — *Thấy:* "operation FAILED / queue kẹt / connector 403 → làm gì, theo thứ tự". *Làm:* mở đúng quy trình. *Vì sao:* trang không có nội dung. *Để làm gịch:* tuyến 1 tự xử lý được, không leo tầng 2.
2. **`OPU-DOC-2` Từ thông báo lỗi nhảy thẳng tới tài liệu và sự kiện liên quan** [mới] — *Thấy:* link ngay trên tiêu đề lỗi. *Làm:* mở. *Vì sao:* lỗi chỉ có mã + correlationId, người trực phải tự đi tìm. *Để làm gịch:* rút ngắn thời gian khắc phục trung bình.
3. **`OPU-DOC-3` Test Workbench gắn với endpoint đang xem + lưu kết quả đã che** [mới] — *Thấy:* mẫu request/response. *Làm:* chạy thử. *Vì sao:* modal hiện đứng rời, không có mẫu sẵn. *Để làm gịch:* tái lập lỗi khách báo báo bằng vài cú bấm.

### 3.15 API Reference `/api-docs` (`features/api-docs/api-docs-screen.tsx`)

**Hiện trạng:** đọc spec **bundle lúc build** (`?raw` import, không có request nào), có tìm kiếm/lọc theo family/chi tiết operation + hiển thị `x-source` và `x-absent`. Không try-it-out (được ghi rõ trong trang).

1. **`OPU-REF-1` Gắn nhãn spec theo đúng build đang chạy** [mới] — *Thấy:* version spec + nguồn + dấu hiệu lệch. *Làm:* so với spec server trả về. *Vì sao:* spec đóng băng lúc build, backend có thể đã đi trước. *Để làm gịch:* tránh kiểm thử theo một hợp đồng đã cũ.
2. **`OPU-REF-2` Try-it-out có kiểm soát (phiên thật, có ghi audit)** [AOPS-09] — *Thấy:* gửi thật kèm CSRF. *Làm:* thử endpoint ngay tại trang tài liệu. *Vì sao:* trang ghi rõ chưa làm. *Để làm gịch:* kiểm chứng hợp đồng ngay nơi đọc hợp đồng, có dấu vết để đối chiếu.
3. **`OPU-REF-3` `x-source` và `x-absent` thành đường dẫn điều hướng** [mới] — *Thấy:* sự kiện không có, kèm lý do. *Làm:* mở vị trí mã nguồn. *Vì sao:* `x-source` đã hiển thị nhưng không dẫn đi đâu. *Để làm gịch:* đối chiếu mã và hợp đồng trong vài giây khi có tranh chấp.

`routes/not-found.tsx` là trang tĩnh, không mang dữ liệu vận hành — **không** gán 3 tính năng cho nó, vì thêm tính năng vào trang 404 là chi phí không tạo giá trị vận hành.

## 4. Bảng tổng hợp để điều phối

| Page | 3 tính năng đầu tiên nên làm | Lý do ưu tiên |
|---|---|---|
| Cross-cutting | G1 dải sức khoẻ · G2 auto-refresh · G3 deep-link | Nền cho mọi trang; thiếu thì mọi tính năng khác khó dùng khi đang xử lý sự cố |
| Overview | OVR-1 triage · OVR-2 sức khoẻ · OVR-3 audit lọc | Đây là trang vào ca; hiện gần như không có tín hiệu |
| Operations | OPS-1 sống theo thời gian · OPS-2 tải artifact · OPS-3 timeline | Nơi người trực đứng lâu nhất khi có sự cố |
| Usage | USG-1 bảng tổng hợp · USG-2 biểu đồ · USG-3 ngân sách | Hiện là JSON thô — gần như không dùng được |
| API keys | KEY-1 rotate/disable · KEY-2 last-used · KEY-3 phân trang | Dùng khi nghi lộ credential |
| Connectors | CON-1 lịch sử test · CON-2 độ trễ/lỗi/quota · CON-3 lịch sử revision | Dùng khi provider bị lỗi |
| Profiles | PRF-1 danh sách · PRF-2 lịch sử/diff · PRF-3 cấu hình hiệu dụng | Dùng khi cấu hình không chạy như mong đợi |
| Businesses | BIZ-1 xác nhận · BIZ-2 phân trang · BIZ-3 chi tiết version | Rủi ro thao tác nhầm đang ở mức cao nhất |
| Workflows | WFL-1 trạng thái · WFL-2 hàng đợi chờ người · WFL-3 danh mục schema | Tính năng đã chạy nhưng portal không thấy |
| Security | SEC-1 kiểm kê khoá · SEC-2 kiểm thử vòng đi qua · SEC-3 lịch sử | Không có thì không tin được cấu hình mã hoá |
| Secrets | SRT-1 đến hạn xoay · SRT-2 lọc · SRT-3 người dùng | Phòng ngừa sự cố credential hết hạn |
| Identity | IDN-1 danh sách phiên · IDN-2 khoá/reset · IDN-3 đăng nhập gần nhất | Dùng khi nghi truy cập trái phép |
| Settings | SET-1 nối wire đọc · SET-2 chênh lệch · SET-3 maintenance | Trang chết, trong khi wire đọc đã có sẵn |
| Documentation | DOC-1 sổ tay sự cố · DOC-2 nhảy từ lỗi · DOC-3 workbench có mẫu | Giảm thời gian xử lý, giảm tải tuyến 2 |
| API Reference | REF-1 nhãn build · REF-2 try-it-out · REF-3 x-source thành link | Tránh kiểm thử theo hợp đồng cũ |

## 5. Đề xuất chia lô (thứ tự điều phối)

| Lô | Nội dung | Phụ thuộc | Ghi chú |
|---|---|---|---|
| L1 | G1, G2, G3, G4 | không | Nền; làm trước để các lô sau có chỗ bám |
| L2 | OVR-1..4 + SET-1 | L1, AOPS-00 telemetry, BFF health | Cần tín hiệu sức khoẻ thật, không dựng số giả |
| L3 | OPS-1..4, KEY-1..3, CON-1..4 | L1 | Trọng tâm ca trực sự cố |
| L4 | SRT-1..3, IDN-1..3 | L1 | Vệ sinh credential + cô lập truy cập |
| L5 | BIZ-1..3, PRF-1..4, SEC-1..3 | L1, CFGADM | Cần diff/lịch sử revision từ nguồn sự thật |
| L6 | USG-1..4, DOC-1..3, REF-1..3 | L1, COST | Báo cáo + tài liệu + hợp đồng |
| L7 | WFL-1..3 | L1, WFA plan | Phụ thuộc mức độ hoàn tất của WFA |

## 6. Ranh giới và điều kiện bàn giao

- **Không** tạo release gate mới; `G-ADMIN-OPS` và `P8-07` giữ nguyên vai trò. Tài liệu này là sub-packet nghiệm thu, không cộng trùng tiến độ.
- **Không** tự tick gate, không tự kết luận VERIFIED/ACCEPTED; bằng chứng sống do lane khác nộp theo checklist ADM-UX.
- Với mọi hạng mục sức khoẻ: **thiếu dữ liệu phải hiện `unknown`/`unavailable` kèm thời điểm mẫu cuối**, tuyệt đối không thay bằng 0 hay bằng số bịa.
- Với mọi hạng mục có thao tác phá huỷ: blast-radius + xác nhận + CSRF + audit một dòng, đúng như Connectors/Secrets đang làm.
- Với danh sách: tìm kiếm/phân trang/lọc phải là phía server và phải nằm trên URL (không cắt ngữ cảnh khi F5).
- Hai route `workflows` và `docs` hiện **không nằm trong** allow-list `DU_ADMIN_WEB_ROUTES` — trước khi xử lý WFL/DOC phải chốt có mở allow-list hay không, nếu không các trang đó vẫn không bật được.

## 7. Nền tảng quan sát (đã đọc trực tiếp)

- Khung cột sống + nav: `apps/admin-web/src/app-shell/app-shell.tsx:8-13,30,38-57`.
- Bảng định tuyến: `apps/admin-web/src/router.tsx:30-56`.
- Không có lời gọi health ở `apps/admin-web/src/lib/api/client.ts` (grep 0 hit).
- Toàn SPA chỉ có một `setInterval` (đồng hồ) tại `app-shell/app-shell.tsx:30`.
- Hai ô "requires backend" ở `features/overview/overview-screen.tsx:301`.
- `downloadUrl` chỉ được parse tại `features/operations/state.ts:57`, không render link.
- `features/settings/settings-screen.tsx` không có `fetch(`/`client.`/`getSession` nào.
- `features/businesses/businesses-screen.tsx` không có `ConfirmDialog`/`window.confirm`.

**Trạng thái:** đề xuất, chưa dispatch, chưa xác nhận runtime. Claude Code giữ quyền quyết định mức ưu tiên và phân công.