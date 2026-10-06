# LIVE-FAILURES-TRIAGE-819 — 2026-10-05

## Verdict

Không có đủ chứng cứ để xác nhận kết luận “cả 7 failure là pre-existing infra”. Trong checkout chỉ tìm thấy summary trong [agent-watch-state.json:10131](../agent-watch-state.json#L10131), không tìm thấy raw output, command/test manifest, hoặc định danh DB của lần 271/280. Summary cũng không nêu tên 5 suite PASS hay 7 assertion cụ thể; `271 + 7 = 278`, còn **2/280** kết quả chưa được phân loại. Vì vậy không gán bất cứ failure nào trong 7 lỗi là pre-existing.

Tôi chạy độc lập ba suite được nêu trên một PostgreSQL 16 và Redis mới, cô lập, loopback-only. Trên source hiện tại, các suite admin pass và webhook fence pass liên tiếp khi source ổn định. Đây là bằng chứng về source + migration hiện tại trên DB sạch; **không** chứng minh trạng thái của DB mà supervisor đã dùng.

## Triage từng failure được báo cáo

| # | Failure theo summary | Assertion có trong source hiện tại | Kết quả đối chiếu / phân loại |
|---:|---|---|---|
| 1 | `admin-base-routes`: “businesses table schema mismatch” | Suite có test `GET /api/v1/admin/businesses returns real registered businesses array`: status 200, tìm fixture `TEST_BIZ`, rồi assert version/active/status; test versions ở cell #2 cũng đọc cùng fixture. Summary không cho biết cell nào hoặc assertion/error PostgreSQL nào fail. | **Chưa chứng minh, có thể là code/schema-contract mismatch.** Canonical migration không định nghĩa bảng vật lý `businesses`; route hiện tại dùng derived alias `businesses` trên `business_versions`. Không được gọi đây là infra drift nếu chưa có exact DB ledger/raw error. |
| 2 | `admin-base-routes`: connector trả 503 | Cell #4 yêu cầu `GET /api/v1/admin/connectors/test-connector/revisions/1` status 200, endpoint `configured`, `secretSlots=[]`. | **Chưa chứng minh.** Test config trỏ `127.0.0.1:8099`, hiện không có listener. Nhưng source route dùng placeholder khi connector-management store vắng; nếu proxy trả 503, handler bắt lỗi đó và cũng rơi về placeholder. Lượt hiện tại pass 7/7 trong khi 8099 không lắng nghe. Service không chạy tự nó chưa giải thích được 503 được báo cáo. |
| 3–6 | `admin-action-rbac-live`: bốn lỗi “businesses không có trong businesses table” | File có 12 cell D1–D4, M1–M6, X1–X2. Setup tạo hai business trong `business_versions`; summary không chỉ rõ bốn cell, SQLSTATE, statement hoặc assertion. | **Chưa chứng minh; không quy infra hay code khi thiếu raw.** Suite hiện tại chạy 12/12 trên schema sạch sau migrations. Không cần bảng vật lý `businesses` để suite hiện tại chạy. DB supervisor dùng chưa được nhận diện/đọc migration ledger. |
| 7 | `webhook-reclaim-fence.live`: timing race | Có hai ca khả dĩ: stale claimant A sau khi B reclaim/deliver (`DELIVERED`, attempts 1, không bị A ghi đè), hoặc shutdown graceful (`PENDING`, attempts 0, `SHUTDOWN_RELEASED`, rồi claim lại). Summary không chỉ ra ca/assertion nào. | **Failure gốc chưa chứng minh và không tái hiện trên source ổn định.** Ba lượt hiện tại trên PG16/Redis disposable đều 2/2, exit 0, với cùng SHA `runtime.ts` trước/sau mỗi lượt. Điều đó không chứng minh race không tồn tại trong môi trường supervisor. |

Các test/assertion có thể đối chiếu trong [admin-base-routes.test.ts](../../services/orchestrator/tests/admin-base-routes.test.ts#L110), [admin-action-rbac-live.test.ts](../../services/orchestrator/tests/admin-action-rbac-live.test.ts#L18), và [webhook-reclaim-fence.live.test.ts](../../services/orchestrator/tests/webhook-reclaim-fence.live.test.ts#L136). Đây là assertion của **source hiện tại**, không phải xác nhận raw assertion fail của lượt 271/280.

## Migration và “businesses table”

- [0001_platform_v1.sql](../../services/orchestrator/migrations/0001_platform_v1.sql#L24) tạo `business_versions` (business/version/manifest); [0006_active_version.sql](../../services/orchestrator/migrations/0006_active_version.sql#L1) thêm `is_active` và index cho version hoạt động. Rà toàn bộ 33 migration không thấy migration nào tạo bảng vật lý `businesses`.
- [business-list.ts](../../services/orchestrator/src/modules/admin-read/business-list.ts#L23) tạo derived table `(...) businesses` từ `business_versions`; tên `businesses` ở đây là SQL alias, không phải relation vật lý. Admin routes đang dùng reader này.
- Trên DB disposable sau `autoMigrate`, đọc trong `BEGIN READ ONLY` cho kết quả `businesses=false`, `business_versions=true`, ledger có **33 migration**, sequence 1/6/33 khớp `0001`, `0006`, `0033`; admin-base vẫn 7/7 và RBAC 12/12. Raw: [ledger disposable](raw/live-failures-triage-819-2026-10-05/current-disposable-migration-ledger-readonly.log).
- Suite hiện tại gọi `createApp(... autoMigrate: true)`. Do đó DB sạch của lần chạy kiểm chứng nhận đủ migrations trước fixture setup. Tôi không tìm thấy report/dispatch yêu cầu team khác thêm migration tạo bảng vật lý `businesses`; ghi chú lịch sử nói business/version list còn thiếu contract, không phải yêu cầu tạo relation đó.
- **DB của supervisor chưa được kiểm chứng.** `.env` không có trong workspace và các biến DB/live không được inject vào shell hiện tại. Container đang có tên `dgship817-pg` là DB `dugate` ở host port 55432; read-only probe thấy không có `schema_migrations`, `business_versions` hay `businesses`. Nó không khớp test default `localhost:5433/du_orchestrator_test`, nên không được coi là target của lần supervisor. Raw/error có kiểm soát ở [candidate DB probe](raw/live-failures-triage-819-2026-10-05/dgship817-candidate-readonly-schema-check.log). Exact target ledger vẫn cần raw log hoặc target ID của supervisor.

Kết luận schema: việc **không có bảng vật lý `businesses` là đúng với schema hiện tại**, không tự nó chứng minh drift. Nếu raw log thực sự ghi query vào relation vật lý `businesses`, đó sẽ là bằng chứng của code/schema khác revision hoặc query sai; hiện tại chưa có log để quyết định trường hợp nào. Không thể loại trừ migration drift trong DB supervisor khi chưa biết target và ledger của nó.

## Connector 503

Test fixture đặt `connectorBaseUrls['test-connector'] = http://127.0.0.1:8099`; tại lần kiểm tra này port 8099 **không có listener**. Admin route chỉ proxy nếu `ctx.connectorManagement` được compose; proxy 503 được bắt để rơi về configured placeholder, còn không có store thì đi thẳng tới placeholder. Suite hiện tại chạy 7/7 trong **3.549 s**, exit 0 với service đó không chạy. Vì vậy giả thuyết “connector service không bật nên cell hiện tại bắt buộc 503” bị phản chứng cho source/test hiện tại. Nhưng status/body, elapsed time và route của lần supervisor chưa có, nên 503 đó vẫn **chưa phân loại** (config khác, code/build khác, hoặc route khác đều chưa loại trừ).

## Webhook timing và source snapshot trong lúc kiểm tra

Trên snapshot ổn định cuối, `webhook-reclaim-fence.live.test.ts` chạy **3 lần**, mỗi lần 1 suite / 2 test, exit 0; `runtime.ts` SHA trước/sau từng run không đổi. Trước khi source ổn định, tôi đã có 15 lượt: 7 lượt chạy test hoàn chỉnh và pass 2/2; 8 lượt **không chạy test nào** vì Jest/ts-jest gặp `TS2304` trong `runtime.ts` tại các call site `assertReadableWithoutSeam`/`readStoredText`. Không tính 8 lượt compile-blocked là webhook race failure hay pass.

Các compile errors trùng thời gian file `runtime.ts` bị sửa trong working tree chung: SHA ghi nhận `FF09…` → `A3CE…` → `D16E…`; [agent-watch state](../agent-watch-state.json#L10125) cho thấy `CONTROL-PLANE-IMPL-818` đang triển khai song song. Source sau đó chuyển các call sang `MetadataReader`; `tsc --noEmit` exit 0, và lượt focused reader/wrapper/counter đạt **4 suites / 137 tests pass**, source SHA không đổi trong lượt. Tôi không sửa source/test. Lỗi biên dịch ở snapshot trung gian là **một code-state failure quan sát được trong file cùng phạm vi**, có thể do chỉnh sửa đồng thời; không đủ bằng chứng để quy cho task/owner cụ thể hoặc gọi pre-existing.

Receipt cũ ghi một lần webhook fail 0/2 vì fake DNS `fence.live.test` không tới được fixture; source hiện tại đã chuyển sang loopback listener và có các run 2/2 pass sau đó ([tester.md đoạn cũ](tester.md#L3181), [run pass cũ](tester.md#L3990)). Đó là failure fixture lịch sử khác với timing failure được supervisor báo; không dùng nó để phân loại lỗi hiện tại.

## Đối chiếu với metadata wave và các suite PASS

- `admin-base-routes` đi qua admin-read business listing / connector revision route; không gọi `ingestion-consumer` hay auth-counter. RBAC có operation/admin read cells nên không loại trừ hoàn toàn mọi đường runtime; nhưng bốn lỗi gắn với business table chưa chỉ tên cell hoặc SQL.
- Webhook reclaim trực tiếp chạy `deliverWebhooks` và fenced updates trên `webhook_deliveries`. Đường race không dùng metadata crypto/counter. Tuy vậy compile của test import cả app/runtime, nên các chỉnh sửa `runtime.ts` có thể chặn Jest trước khi webhook assertions chạy — đúng điều đã quan sát ở 8 lượt TS2304.
- [FULL-REGRESSION-815](full-regression-815-2026-10-05.md) chạy package suites nhưng ghi **26 suite / 230 test live-gated SKIP**; nó không phải baseline live cho ba suite này. Trong task hiện tại, BA reader/wrapper/counter focused rerun 4/4 suite, 137/137 pass; typecheck orchestrator exit 0.
- Năm suite được báo PASS trong 271/280 **không có tên hoặc per-suite result** trong durable summary. Tôi không gán coverage/pass cho chúng và không thể kiểm tra chúng có chạy đúng tên hay bao phủ code wave không.

## Phân loại cuối

| Nhóm | Kết luận hiện tại |
|---|---|
| Các 7 failure gốc của supervisor | **Chưa chứng minh là pre-existing.** Thiếu raw assertion output và target DB; không thể xác nhận từng nguyên nhân hoặc nhận kết luận hạ tầng. |
| Schema “businesses” | Schema hiện tại cố ý dùng `business_versions` và không có relation vật lý `businesses`; test source hiện tại pass với schema đó. Failure gốc vẫn **unresolved**, có thể là code/schema revision drift nhưng chưa chứng minh. |
| Connector 503 | Service tại 8099 không chạy hiện tại, nhưng route/source hiện tại degrade về placeholder và test pass; 503 gốc **unresolved**, không thể quy infra. |
| Webhook timing | Không tái hiện trong 3 lần stable; failure gốc **unresolved**, không đủ bằng chứng gọi pre-existing hay bug logic. |
| Lượt TS2304 trong verifier | **Code snapshot lỗi được quan sát**, không phải test assertion/infra. Chưa chứng minh ownership; hiện snapshot sau refactor typecheck và focused suites pass. |
| 5 suite PASS | **Không xác minh được** vì thiếu run list và raw outputs. |

Cần có từ supervisor trước khi chốt triage 271/280: raw Jest stdout/stderr và exact invocation/test-file list; target DB identifier (không cần secret) cùng read-only `schema_migrations`/catalog output từ chính target. Chưa thay đổi source/test, không commit và không tick.

## Raw artifacts

[Raw evidence directory](raw/live-failures-triage-819-2026-10-05/) chứa 15 lượt trong lúc source churn, 3 webhook lượt trên snapshot hiện tại, rerun hai suite admin, BA focused/typecheck, read-only DB probes, per-run exit files, fingerprints và SHA list. 54 file đã hash-verify; [SHA256SUMS.txt](raw/live-failures-triage-819-2026-10-05/SHA256SUMS.txt) SHA-256: `D50D0B3C56D9E60F0D4B0A41945684AAFACDD2660C680AC7B43738099F973DA4`.
