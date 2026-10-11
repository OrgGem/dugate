# UI business workflow — phân tích yêu cầu và kế hoạch bàn giao

Task: `UBW-00..08`. Trạng thái: **PARTIAL** — AP-01..05 đã `IMPLEMENTED · VERIFIED` (verify static/offline, không phải browser/runtime) và `REVIEWED-WITH-CONDITIONS`; parent `UBW-00..08` **chưa ACCEPTED**. Các hàng còn lại vẫn PROPOSED / SPECIFIED theo yêu cầu người dùng.
Repo scope: `D:/Git/dugate/du-rework` only; legacy root chỉ đọc để đối chiếu. Canonical plan cho yêu cầu này: file này. Claude Code là dispatcher duy nhất theo `COORDINATOR-CONTRACT.md`.
Ưu tiên: làm rõ mô hình và hành trình UI trước; sau đó giao implementation theo lease. Không tự coi yêu cầu lập plan là lệnh triển khai toàn bộ, deploy hoặc bỏ gate đang tồn tại.
Sổ tay mở duy nhất: `PLAN-OPEN-2026-10-09.md` (mục B của file đó là UBW). Header dòng trên **đã cập nhật 2026-10-09** sau khi phân xử mâu thuẫn #7; anchor thật của bảng AP là `:88-92` (sổ tay mở cũ ghi `:87-91`, lệch +1). Nguồn: `reports/contradictions-resolution-2026-10-09.md` §3 #7.

## 1. Yêu cầu và mô hình đề xuất

Người dùng cần worker tự kết nối/đăng ký khi start; orchestrator quản lý worker; business có version và active/deactive; tính năng business tự xuất hiện trên orchestrator; đăng ký process liên kết business; workflow ghép nhiều tính năng; profile gắn workflow.

| Đối tượng | Ý nghĩa và liên kết |
| --- | --- |
| Business | Danh tính nghiệp vụ ổn định, tên và mô tả. |
| Business version | Manifest bất biến, exact version + digest; catalog action, input/output/profile schema, connector slots và capabilities. Một business có nhiều version đồng thời. |
| Worker instance | Một tiến trình thực thi một business/version theo contract hiện có; nhiều instance có thể chạy cùng version. Có identity, image digest, capacity và heartbeat. Không đồng nhất worker với business. |
| Capability/action | Tính năng công khai được khai báo trong manifest. Handler kind nội bộ không mặc nhiên là action cho người vận hành. |
| Process binding | Tên process ổn định cho vận hành/API; trỏ tới business/version/action hoặc workflow revision. Đây là đề xuất cần đối chiếu mapping legacy, tránh tạo registry song song. |
| Workflow revision | Đồ thị nhiều node; mỗi node tham chiếu action và exact business version/digest, cấu hình và mapping input/output. Workflow có draft/publish và revision bất biến. |
| Profile revision | Gắn workflow revision, cấu hình các node/connector/prompt/limit và quyền sử dụng. Operation pin snapshot để các thay đổi sau không đổi lần chạy cũ. |

Chuỗi UI: **Workers → Businesses / Versions / Features → Processes → Workflows → Profiles → Test / Runs**.
Ví dụ minh họa: worker document-core@v1 đăng ký → chọn ingest/parse và extract/invoice → map thành hai node nối tiếp → publish workflow invoice-processing@r1 → tạo profile invoice-default gắn r1 → chạy và xem kết quả từng node. Đây là kịch bản nghiệm thu đề xuất, không phải claim đã chạy.

## 2. Hiện trạng từ source, chưa kiểm chứng browser

| Source | Quan sát | Khoảng trống phải xác minh |
| --- | --- | --- |
| `orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx` | Có list business, mở versions và action enable/activate/deactivate qua API client. | Không kết luận chưa có version/activation; kiểm tra hiệu lực thực, dependencies và catalog feature. |
| `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx` | Màn disabled theo deployment policy Δ-DEV-03; chưa có builder/list/import khả dụng trong component này. | Phải đối chiếu quyền mở gate hiện hành trước khi enable; backend Workflow API không chứng minh UI đã có. |
| `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx` | Profile được tải theo business/version/profile; version nhập mặc định latest. | Chưa thấy hành trình chọn workflow revision trong source đã đọc; phải audit DTO/storage/admission trước khi bổ sung. |
| `orchestrator/packages/worker-sdk/src/worker.ts` | Có worker instance ID, initial heartbeat và heartbeat loop với business/version/image/capacity. | Tự đăng ký worker heartbeat khác với PUT manifest; audit startup của từng business để chứng minh chuỗi manifest → instance → consume. |
| `docs/05-business-registry.md` | Đã quy định immutable version/hash, REGISTERED_DISABLED, enable, heartbeat và exact-version pin. | Đối chiếu state machine thực tế; không đổi spec để hợp thức hóa mismatch. |
| `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` | Scope Workflow API legacy, process/schemaSlug/runtime; UI authoring không thuộc scope đó. | Tích hợp và reuse catalog/runtime, tránh giành lease đang sống hoặc coi WFA là UI hoàn chỉnh. |

Liên kết backlog: ACUI-07, AWEB-06/07, CFGADM workflow mapping, AOPS worker/queue, P9/WFA. Plan này cụ thể hóa hành trình cần có; không tick hoặc thay trạng thái lịch sử của các parent.

## 3. Quy tắc lifecycle cần chốt trước code

1. **Startup:** identity được provision trước → validate manifest → đăng ký manifest idempotent → register instance/heartbeat → nhận queue do platform cấp → consume theo policy. Same version/same hash replay thành công; same version/different hash báo conflict và dừng startup. Retry lỗi tạm có backoff; lỗi auth/contract không được vòng lặp giả healthy.
2. **Auto discovery:** manifest hợp lệ được nạp metadata vào catalog và hiện trên UI qua refresh/poll/invalidation. Không tải/thực thi mã JS/HTML từ business. Business mới mặc định disabled; discovery không tự active, cấp quyền hoặc tạo profile.
3. **Trạng thái riêng:** worker HEALTHY/DEGRADED/OFFLINE; business version REGISTERED_DISABLED/ENABLED/DRAINING/RETIRED theo contract hiện hành. Nhãn Active/Deactivate cần map chính xác với API; không đồng nhất active default version, enabled và worker health.
4. **Deactivate:** preview các process/workflow/profile phụ thuộc; chặn admission mới theo state machine, giữ operation đang chạy theo drain policy hiện hành. Retire chỉ khi không còn backlog/wait/resume phụ thuộc hoặc có quy trình xử lý rõ. Không kill worker/job ngầm.
5. **Version:** thêm version không sửa manifest cũ hoặc tự nâng node/profile đã publish. UI hỗ trợ xem diff, rollout song song và explicit rebind/rollback. Latest chỉ là trợ giúp chọn draft; publication/execution phải resolve và pin exact revision.
6. **Worker management:** xem last heartbeat, instance/version/digest, capacity và số task nếu telemetry thật có. Drain/resume/revoke chỉ mở nếu có control protocol và acknowledgement; UI phân biệt desired/observed. Register trên UI nghĩa là provision identity/hướng dẫn startup hoặc manual manifest registration theo quyền, không tạo một worker giả online.
7. **Process:** tên unique theo scope đã chốt, binding versioned có CAS; giữ process legacy disbursement/lc-checker/doc-compare và schemaSlug tương thích. Chốt process là alias target hay loại node trước khi thiết kế form/API.
8. **Workflow:** nối nhiều action của cùng business là acceptance bắt buộc; đề xuất hỗ trợ khác business qua cùng contract, cần rà runtime trước khi cam kết phạm vi. V1 ưu tiên nối tiếp; branch/parallel/join chỉ mở khi executor có semantics thật. Validate cycle, node count, required inputs, schema/type mapping, unavailable action, connector slot và giới hạn execution. Không bỏ data binding vào business handler ngầm.
9. **Profile:** chọn workflow + revision, cấu hình theo node, connector slots và prompt revision; validate effective config trước publish. Giữ đường profile/action cũ; cần decision về mở rộng model hay adapter vào workflow business hiện có, tránh phá DTO/storage.
10. **Quyền:** registry/worker identity ở scope platform theo quyền hiện hành; workflow/process/profile tenant-scoped nếu contract quy định. BFF principal/tenant, CSRF, audit, idempotency/CAS và secret write-only. Không dùng token platform trong browser.

## 4. Màn hình và hành trình cần thiết kế

| Màn | Hành vi và dữ liệu cần có |
| --- | --- |
| Workers | List/filter instance theo business/version/health; detail heartbeat/digest/capacity; provision registration với lệnh startup không lộ secret lâu dài; trạng thái lỗi registration và acknowledgement thao tác. |
| Businesses | List + version detail; active/deactive/drain/retire đúng quyền; manifest/action catalog và schema; worker tương ứng; dependency impact; diff phiên bản. |
| Processes | Tạo tên process → chọn business/version/action hoặc workflow revision → validate → publish; list/edit revision và dependencies. |
| Workflows | List/draft/detail; palette features từ registry; add/connect node; map output → input; cấu hình per-node; validate; revision/diff/publish/rollback; unavailable feature hiện nguyên nhân. |
| Profiles | Create từ workflow đã publish; chọn exact revision; node settings và connector slots; quyền API key nếu có; effective-config preview; save/reload/publish thật. |
| Test / Runs | Chạy thử có giới hạn bằng profile; theo dõi operation/node và error; kiểm tra worker thực nhận task, output chuyển qua node, kết quả persisted. |

Wireframe và click-through phải mô tả loading/empty/error/403/409/offline/disabled, responsive và keyboard. Không báo Saved/Active chỉ từ state phía client.

## 5. Các packet và thứ tự bàn giao

Tất cả packet repo scope `du-rework`, canonical plan file này. Owner dưới đây là vai trò đề xuất; Claude phải chọn owner bằng live roster, xác định exact file lease và ghi dispatch proof trước giao. Prefix trong bảng là vùng khảo sát, **không tự cấp blanket lease**.

| ID | Deliverable / owner đề xuất | Dependencies | Vùng cần lập exact lease | Receipt / acceptance |
| --- | --- | --- | --- | --- |
| UBW-00 | Inventory + decision matrix / analyst | none | source read-only; report riêng | `coordination/reports/ubw-00-inventory.md`; API/UI/storage/state/consumer mapping có file:line; Δ-DEV-03 và lease WFA được xác minh. |
| UBW-01 | UI information architecture, wireframes, journey / UI designer | UBW-00 | plan/design metadata riêng | `coordination/reports/ubw-01-ui-design.md`; toàn bộ hành trình và lifecycle rõ, đề xuất cần quyết định được đánh dấu. |
| UBW-02 | Startup registration + worker registry/control contracts / SDK + runtime owner | UBW-00/01 contracts | SDK, registry/runtime, business startup, telemetry; chia owner trước | `coordination/reports/ubw-02-registration.md`; manifest/instance/replay/conflict/outage/heartbeat expiry thật. |
| UBW-03 | Workers + Businesses UI/BFF, feature discovery / UI + BFF owner | UBW-01/02 DTO | admin-web worker/business features, API client và BFF phân lease | `coordination/reports/ubw-03-catalog-ui.md`; business mới hiện metadata không rebuild platform; không tự active; reload đọc state thật. |
| UBW-04 | Process binding + workflow contracts/runtime integration / runtime owner | UBW-00/01, reuse WFA | workflow-schemas/compat/contracts/profile liên quan; migrations riêng nếu cần | `coordination/reports/ubw-04-workflow-contract.md`; process versioned và multi-action execution có mapping/pins; không thay fixed alias bằng hành vi khác. |
| UBW-05 | Workflow UI builder/publish / frontend owner | UBW-01/03/04 | workflows feature + route và typed API client theo lease | `coordination/reports/ubw-05-builder-ui.md`; create → connect → validate → publish → reload; deployment gate được xử lý theo authority thật. |
| UBW-06 | Workflow-bound profile UI + admission / profile owner | UBW-04/05 | profiles UI + backend profile/admission/contracts; chia owners | `coordination/reports/ubw-06-profile-binding.md`; exact workflow/node pins, effective config, rollback và action profile compatibility. |
| UBW-07 | Independent functional/browser verification / tester | từng slice sẵn sàng | tests riêng + report; product read-only | `coordination/reports/ubw-07-verification.md`; pass/fail/skip/raw logs, code SHA/build digest; E2E startup→catalog→workflow→profile→run/result. |
| UBW-08 | Independent UI verdict + docs/traceability / reviewer + docs owner | UBW-07 | reviewer read-only; docs lease riêng | `coordination/reports/ubw-08-review.md`; UI_APPROVED đúng build, hướng dẫn vận hành và docs/19/28/35; findings được retest trước ACCEPTED. |

Tiến hành inventory và design trước. Sau khi chốt UX/contracts, Claude lập packet implementation cụ thể; không tự implement code/tests theo coordinator contract. Mọi implementation/test dispatch cần owner, exact lease, dependencies, acceptance, receipt path và runtime receipt.

### Admin-portal UX features (user-approved 2026-10-09)

User đã duyệt thêm 5 tính náng mới vào portal admin. Self-check + analysis tại `coordination/reports/admin-portal-feature-analysis-2026-10-09.md`.

| ID | Feature | Problem | file:line | Size | Risk | Status | Receipt | Verify |
|---|---|---|---|---|---|---|---|---|
| AP-01 | Tenant scoping cho Profiles & Businesses | Profiles/businesses thiếu tenant scope; 6 screens khác đã dùng TenantSelect | `features/profiles/profiles-screen.tsx`, `features/businesses/businesses-screen.tsx` | S–M | Low | IMPLEMENTED · VERIFIED (APPROVED-WITH-CONDITIONS — xem review §4, 3 hunk ngoài scope trong cùng file) | `reports/receipt-ap01-tenant-scoping-2026-10-09.md` | `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (typecheck/build/jest) |
| AP-02 | Connector ID select thay free-text | Input + datalist không chặn giá trị lạ | `features/connectors/connectors-screen.tsx:482-494` | S | Low | IMPLEMENTED · VERIFIED (APPROVED-WITH-CONDITIONS — regression tenant display trong `ManageRevisionFacts`, xem review §4) | `reports/receipt-ap02-connector-select-2026-10-09.md` | `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (typecheck/build/jest) |
| AP-03 | OpenAPI staleness indicator | SpecBuildLabel thiếu last-regenerated date + drift warning | `features/api-docs/api-docs-screen.tsx:59-73` | S | Low | IMPLEMENTED · VERIFIED (age unknown nêu thẳng, không bịa build date; xem review §3) | `reports/receipt-ap03-openapi-staleness-2026-10-09.md` | `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (typecheck/build/jest) |
| AP-04 | Workflows unblock guidance | Banner Δ-DEV-03 không link điều kiện mở gate/owner | `features/workflows/workflows-screen.tsx:8-32` | S | None | IMPLEMENTED · VERIFIED (pure append +27/-0, khớp receipt 100%) | `reports/receipt-ap04-workflows-guidance-2026-10-09.md` | `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (typecheck/build/jest) |
| AP-05 | Legacy-shell link rõ ràng hơn | Link trơn dễ bỏ sót | `app-shell/app-shell.tsx:137` | S | Low | IMPLEMENTED · VERIFIED (badge + icon; cùng file có wrapper/health của lane khác — xem review §4) | `reports/receipt-ap05-legacy-shell-link-2026-10-09.md` | `reports/verify-ap01-to-ap05-INDEPENDENT-DSH-2026-10-09.md` (typecheck/build/jest) |

**Định nghĩa trạng thái dùng ở bảng này (COORDINATOR-CONTRACT, không nới):** `IMPLEMENTED` = implementer có receipt mô tả đúng code trên cây làm việc. `VERIFIED` = tester **độc lập** chạy lệnh và có literal + exit code. Verify của đợt này là **static/offline** (typecheck + production build + regression jest) trên **working tree chưa commit** — không có bằng chứng browser/runtime. Cột Status không mang nghĩa ACCEPTED; ACCEPTED là việc của coordinator/user sau khi review này được xử lý. Review đầy đủ: `reports/review-ap01-to-ap05-CLAUDE-2026-10-09.md`.

## 6. Ma trận nghiệm thu trọng tâm

- Start worker mới bằng identity hợp lệ: manifest/version/action catalog và instance xuất hiện; business disabled đến khi operator có quyền kích hoạt. Restart/replay không tạo business version trùng; instances tách bạch.
- Sai identity/digest/schema hoặc cùng version khác manifest: từ chối rõ; không consume task trái quyền, không hiện healthy giả. Orchestrator gián đoạn rồi hồi phục: retry/reconcile không mất registration hoặc auto-enable.
- Hai version và nhiều worker cùng version: UI health/capacity đúng; workflow pin v1 không bị v2 thay đổi; mất heartbeat không xóa manifest.
- UI tạo process và workflow ít nhất hai action của cùng business; mapping output/input chạy thực qua queue/worker và lưu kết quả; publish schema sai/cycle bị chặn.
- Profile gắn workflow r1; sửa draft/publish r2 không đổi operation cũ; lựa chọn nâng revision và rollback tác động request mới theo policy.
- Deactivate/drain version đang được tham chiếu: dependency preview đúng; submit mới bị chặn đúng trạng thái; operation/wait/resume cũ được xử lý đúng policy và có evidence.
- Save/reload/CAS conflict, permissions và tenant isolation qua HTTP/BFF thật; không tính client stub hoặc element tree là browser/live verification.
- Business/action mới xuất hiện mà không thay platform source hoặc build digest; unsupported schema có validated JSON fallback nếu phù hợp contract, không execute manifest code.
- Legacy process/schemaSlug và action profile vẫn qua contract hiện hành. Paid provider/deployment/cutover cần scope riêng; mock provider chỉ thay external transport.

## 7. Bàn giao

Target: Claude Code đang có tại worktree `7bff06d8-4fd4-4484-b870-7ff1ee8510d2::D:/Git/dugate`, terminal `term_19edcad8-dcd8-4930-a6a2-24f5f8be5bd8`.
Live observation trước gửi: connected, identity claude; terminal vừa điều phối verification khác, không coi là owner rảnh cho product code.
Yêu cầu tiếp theo: tiếp nhận plan; reconcile backlog/lease đang chạy; ưu tiên UBW-00/01 để làm rõ UI; phản hồi các decision/mismatch và kế hoạch packet; giữ Claude là single dispatcher. Không hủy các công việc đang chạy.
Send receipt sẽ được ghi trong artifact riêng sau khi Orca xác nhận, phân biệt input_accepted với turn_started.
