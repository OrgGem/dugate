# Review migration/adapter DB legacy — 2026-10-09

## Phạm vi và kết luận

Đối chiếu schema nguồn `lib/db/schema.ts` (9 bảng PascalCase), canonical plan `coordination/PLAN-LEGACY-DB-ADAPTER-2026-10-09.md`, ADR LDBA-01, backfill runner/production adapter, identity/connector/workflow adapters và receipts LDBA-08/09/09A. Review tĩnh trên working tree; không chạy DB, migration, build/test hoặc đọc secret môi trường. Không thay product source/task status; report này không phải dispatch hay authorization cutover.

**Chưa đủ điều kiện cutover DB legacy.** Có framework backfill và các module chuyển đổi, nhưng chưa có production bridge end-to-end đã được kiểm chứng. Đây là **legacy → rework import**, không phải reverse synchronization và cũng chưa phải runtime chạy trực tiếp trên 9 bảng cũ.

## Luồng hiện tại

1. Nguồn: `Operation`, `ApiKey`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `AppSetting`, `FileCache`, `User`, `UserProfileAssignment` của DUGate root.
2. A1 theo ADR: bridge views riêng trong `ldba_bridge`, read-only, kiểm mapping/count trên snapshot nhất quán. Production adapter hiện scan trực tiếp bảng nguồn trong schema cấu hình; chưa thấy triển khai view bridge/runtime routing tương ứng trong source đã rà.
3. A2: `scripts/ldba-03-backfill.cjs` scan 9 bảng → validate/transform bằng context provider → resolve tenant `legacy-default` → validate target constraints trong transaction rollback → inspect immutable rows → apply một transaction.
4. Target: bảng rework lowercase và Connector tables, được tạo bằng migration sets hiện có. Có thể cùng PostgreSQL database với bảng cũ nếu chuẩn bị role/schema phù hợp; cùng database không đồng nghĩa cùng schema/model hoặc tự đồng bộ.
5. Runtime vẫn query `operations`, `tasks`, `outbox`, `profile_bindings`, `connector_revisions`... Không có cơ chế ghi ngược các thay đổi mới về `Operation`/`ProfileEndpoint` cũ.

Điểm tốt: identifier allowlist, parameterized SQL, fail-closed nhiều lỗi mapping, constraint preflight, insert-only immutable batch, danh sách skipped rows và source→destination accounting. Nên giữ các bảo vệ này khi sửa.

## Findings

### MDB-01 — HIGH: production composition chưa hoàn chỉnh

`scripts/ldba-03-production-adapter.cjs:122` phụ thuộc `LDBA03_CONTEXT_MODULE` để prepareConnector, resolveProfileName, normalizeConnectionsOverride, prepareWorkflowSchema, đọc object và artifact policy. Không tìm thấy production context provider ghép đầy đủ các seam đó trong phạm vi đã rà. LDBA-08 receipt ghi production preflight `BLOCKED_TRANSFORM`; fixture adapter không thay cho production provider.

A1 cũng còn mở theo LDBA-09A. Cần phân biệt module đã code, runner chạy với fixture và import thực dùng các adapter/crypto/storage của deployment. **Chỉ đổi DATABASE_URL về DB cũ không đủ chạy rework.**

Xử lý: chốt topology source/platform/connector và schema ownership; cung cấp composition provider có version; A1 bridge hoặc thay đổi ADR có chủ đích sang read-only extractor; chạy rehearsal qua đúng composition production.

### MDB-02 — HIGH: immutable replay không ổn định qua PostgreSQL types và encryption

`production-adapter.cjs:133–146` normalize Date/Buffer/object nhưng giữ number và string khác nhau. Runner ghi token counts và artifact size bằng số JS (`backfill.cjs:417–419, 730`); target là bigint (`0024_legacy_parity_columns.sql:57–58`, `0001_platform_v1.sql:136`), được pg trả về dạng chuỗi với cấu hình hiện tại. Vì vậy `0` khác `'0'` khi replay, dù giá trị DB không đổi.

Receipt `ldba-09A-fixture-unblock.md` đã ghi first execute APPLIED, replay BLOCKED_TARGET_CONFLICT cho 2 Operation, 2 ProfileEndpoint, 2 FileCache. Bigint mismatch giải thích đường lỗi Operation/FileCache; **chưa xác định đầy đủ nguyên nhân 2 ProfileEndpoint**, không quy tất cả cho bigint.

Còn một rủi ro production: Connector projector mã hóa lại secret mỗi lần (`legacy-connector-adapter.ts:151`), cipher dùng IV ngẫu nhiên (`services.ts:35`). So ciphertext byte-for-byte sẽ conflict dù secret không đổi. Workflow envelope có thể có cùng vấn đề, cần xác minh trong composition mới.

Xử lý: canonical comparison theo column type, giữ chính xác bigint/numeric; không đổi toàn bộ bigint sang Number. Với ciphertext, giữ materialized migration plan hoặc so sánh semantic digest/HMAC trong trust boundary, reuse bản đã nhập khi nguồn không đổi. Không cố định IV để làm ciphertext deterministic. Conflict report chỉ cần tên field/type/reason, không in giá trị nhạy cảm.

Acceptance: first apply → replay unchanged ghi 0 row mới; thay source thật vẫn conflict; cover bigint lớn, numeric, JSON/null/array, timestamps và ciphertext IV mới. Điều tra riêng ProfileEndpoint bằng field-level diagnostics đã redaction.

### MDB-03 — HIGH: import RUNNING tạo operation không thể tiếp tục

`backfill.cjs:351–427` cho phép RUNNING nhưng chỉ tạo row `operations`; không có root task, execution snapshot, lease, checkpoint, human wait hoặc outbox. Schema target để `root_task_id=NULL`, `input_ref={}` mặc định. Runtime recovery quét tasks/outbox nên không tự khôi phục operation này.

Runner chỉ hỗ trợ RUNNING/SUCCEEDED/FAILED trong OPERATION_STATE; chưa có mapping đầy đủ state mở/chờ của hệ cũ. FilesJson có nội dung, webhook hoặc filesDeleted=true bị chặn rõ ràng; đây là fail-closed tốt nhưng cho thấy chưa cover dữ liệu thật phổ biến.

Xử lý v1 đề xuất: drain/freeze app cũ đến không còn operation nonterminal rồi chỉ import lịch sử terminal. Nếu cần tiếp tục công việc đang chạy, phải mở migration execution-state riêng; không tạo task giả hoặc chạy lại provider không kiểm soát. Operation lịch sử cần marker/capabilities để UI không hứa retry/resume khi thiếu input đã pin.

Acceptance: zero orphan RUNNING; inventory từng nonterminal có disposition; result/download/retry của historical operations được kiểm từ API, không chỉ row count.

### MDB-04 — HIGH: backfill bỏ qua đường mã hóa persistence

`backfill.cjs:407–425` ghi pipeline/output/extracted data/error detail trực tiếp; `:687–746` đọc toàn bộ FileCache object vào RAM rồi ghi bytes thô vào artifact_blobs, đặt READY và storage_backend=postgres, không qua crypto/storage facade. Đây là mismatch với policy `docs/41-persistence-encryption-policy.md`: sensitive content phải mã hóa trước persistence; synthetic exemption phải explicit.

Không chỉ là vấn đề production dùng S3: encrypted readers và metadata có thể không hiểu row/bytes imported khi bật strict policy. Cần map artifact ownership/reference; hiện operation_id và task_id đều null, còn filesJson không được nối tới artifact mới.

Xử lý: migrate qua crypto/storage ports chính thức, seal theo tenant/purpose/entity ID mới, giữ manifests/version/hash và nối source reference. Nếu giữ historical plaintext compatibility thì phải là policy/window riêng, có inventory và kế hoạch đóng; không coi là production migration mặc định. Stream/batch file lớn thay vì gom toàn bộ corpus vào một write plan RAM.

Acceptance: dữ liệu nhạy cảm không còn plaintext ở target stores; strict reader đọc được; source/download checksum khớp; foreign tenant bị từ chối; rehearsal dữ liệu lớn có memory bound.

### MDB-05 — HIGH: connector mapping có dữ liệu nhưng chưa giữ hành vi multipart

Legacy root `lib/pipelines/processors/external-api.ts` dùng staticFormFields và các tên field cấu hình. Projector `services/connector/src/db/legacy-connector-adapter.ts:125–188` giữ requestMapping, promptFieldName, fileFieldName, sessionIdFieldName và staticFormFields. Nhưng `src/adapters/http.ts` nhánh multipart hardcode prompt/text/sessionRef/artifacts, không dùng requestMapping/staticFormFields này.

Nguồn mặc định promptFieldName=query, fileFieldName=files (`lib/db/schema.ts`); migrated connector chọn multipart khi fileFieldName khác rỗng nhưng request gửi prompt/artifacts. Provider cũ có thể từ chối hoặc nhận sai input. Đây là vấn đề execution parity, không được chứng minh bằng JSON config được lưu đủ.

Xử lý: adapter honors supported legacy mappings/static fields hoặc chỉ allowlist cấu hình đã chứng minh tương thích. Các auth/method không hỗ trợ phải được thống kê để reconfigure, không biến skip thành parity PASS.

Acceptance: provider capture fixture so sánh request cũ/mới cho prompt, file bytes/filename, session, static fields, headers và response mapping; verify qua invoke thực với revision đã import.

### MDB-06 — HIGH: first-login identity migration chưa nối vào auth; quyền cũ chưa bảo toàn

`modules/identity/legacy-user-adapter.ts:132` có migrateLegacyLocalCredentialOnLogin nhưng tìm callsites ngoài test chỉ thấy định nghĩa. Production context `production-adapter.cjs:511` luôn yêu cầu PASSWORD_RESET_REQUIRED; runner skip users/assignments liên quan. Có helper bcrypt→scrypt không đồng nghĩa user login được qua Portal.

Plan chọn một tenant và bỏ createdByUserId; root `app/api/operations/route.ts:24` có lọc createdByUserId. Mapping USER→operator trong tenant chung có thể mở rộng phạm vi thấy dữ liệu so với cũ. Đây là thay đổi quyền cần migration acceptance, không thể kết luận không cần vì target chưa có consumer. Provider/SSO identity và assignments cần disposition riêng.

Xử lý: ghép first-login fallback an toàn (rate limit, generic errors, target uniqueness, không bypass disabled account), hoặc rollout reset password rõ ràng. Giữ per-user/profile authorization nếu nghiệp vụ yêu cầu; nếu thay đổi, phải có quyết định và negative tests trước cutover.

Acceptance: local user thật login lần đầu → scrypt target → login lại; wrong password/concurrent login/disabled/SSO; user A không thấy yêu cầu của B ngoài policy được duyệt. Không coi users skipped là migrate thành công.

### MDB-07 — HIGH: profile auth chỉ kiểm hình dạng ciphertext, chưa chứng minh giải mã được

`backfill.cjs:241–256, 623` copy fileUrlAuthConfig sau regex iv:tag:ciphertext. Target `modules/profiles/file-url-auth.ts:36` derive key từ ENCRYPTION_KEY/NEXTAUTH_SECRET; khi dùng khóa khác, decrypt trả null. Có thể import thành công nhưng URL ingestion mất authentication. Profile còn tạo connector_bindings={} (`backfill.cjs:617`), nên phải verify effective binding/admission trước coi profile usable.

Xử lý: preflight kiểm decrypt/schema bằng key nguồn trong memory, rồi re-encrypt bằng key target hoặc chứng minh shared-key policy đã chốt. Không log secret. Validate effective connector binding, prompt overrides và URL auth qua runtime consumer.

Acceptance: source/target keys khác nhau vẫn migrate và fetch URL có auth thành công; wrong key chặn migration; không fallback public request khi credential không đọc được.

### MDB-08 — MEDIUM: snapshot/cutover guard và quy mô chưa đủ ở runner

`production-adapter.cjs:280–301` scan từng table qua pool, không có shared REPEATABLE READ snapshot. `:531` và `backfill.cjs:916` kiểm A1 bằng boolean/string từ env; đó là khai báo, không chứng minh nguồn đang freeze hoặc cùng snapshot. Toàn bộ tables/file bytes được gom trong RAM; validatePlan còn thực hiện INSERT rồi ROLLBACK, nên preflight **không phải chỉ SELECT trên target** (có lock/trigger effects trong transaction).

Nếu executor đã freeze source đúng runbook thì race giảm, nhưng tool không tự chứng minh điều đó. Nếu app cũ tiếp tục ghi giữa scan các bảng, có thể mapping nguồn khác thời điểm. Không có reverse sync, nên rollback sau khi rework nhận writes mới không chỉ là đổi connection string.

Xử lý: migration manifest gồm source snapshot/count/digests/timezone, explicit source/target identity, fixed snapshot/read-only source role; staging/materialized plan + checkpoint/bounded batches. Tách validation thuần đọc với rehearsal constraint writes; nêu rõ target quyền/thao tác. Cutover freeze + final delta + single writer, rollback checkpoint và xử lý writes mới.

## Evidence hiện có: không suy rộng

- LDBA-08: production adapter preflight BLOCKED_TRANSFORM, chưa execute.
- LDBA-09A: synthetic fixture preflight và first execute pass; replay fail 6 conflicts; fail-policy và regression rounds chưa chạy. A1 còn mở.
- Đây là receipts đã đọc, không phải test tôi chạy lại. Không dùng offline test pass hay fixture APPLIED để tuyên bố migration production hoàn tất.

## Plan xử lý theo canonical LDBA

| Thứ tự | Deliverable | Acceptance / owner đề xuất |
|---|---|---|
| 0 | Chốt phạm vi: reuse cùng PostgreSQL nhưng dùng rework tables; lịch sử vs active; single tenant vs per-user policy; topology Connector DB | Coordinator + business/security owner ghi decision delta trong canonical LDBA, không đổi spec để hợp thức hóa missing consumer |
| 1 | A1 read-only inventory từ root schema thật và snapshot thật | Migration owner: đủ 9 bảng, enum/UUID/timezone/FK, key/auth/overrides/files/state inventory; mỗi excluded row có disposition, không dùng fixture vi phạm unique constraint để đại diện source |
| 2 | Sửa typed replay, cipher semantic replay, field-level diagnostics | Adapter owner; verifier độc lập chạy first apply/replay/source-change; điều tra riêng profile conflicts |
| 3 | Production context composition + crypto/storage/reference mapping | Migration + storage/connector owners theo exact lease; không còn fixture transforms trong production path; strict readers đọc lại được |
| 4 | Login/authorization, effective profile, multipart parity, operation history policy | Identity/profile/connector owners; verify bằng Portal/API/provider capture thay vì chỉ SQL counts |
| 5 | Rehearsal end-to-end qua production runner | Tester trên DB cô lập: schema root có constraints đúng → A1 → preflight → execute → replay → row/field/hash reconciliation → API/Portal smoke → rollback rehearsal |
| 6 | Controlled cutover packet | Chỉ sau các blocker được đóng; backup/restore evidence, app cũ stop/drain, final snapshot, migration, smoke, open traffic. Single dispatcher cấp lease theo contract hiện hành |

Giữ parent LDBA chưa ACCEPTED đến khi replay, real composition, security/data parity và rehearsal đều có evidence đúng build. Không cần chạy migration lên DB cũ để thực hiện review hoặc sửa các blocker trên.
