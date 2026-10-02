# Follow-up code review — production wiring, encryption và legacy parity

**Trạng thái 2026-10-01:** Đây là inventory lỗi và acceptance, **không phải active dispatch board**. `RV01-01/03` đã có owner implementation; `RV01-08` có focused-test receipt nhưng full regression còn chờ. Xem [execution overlay](IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md) và ledger/terminal hiện tại trước khi giao tiếp; không suy trạng thái từ snapshot này. Review dựa trên working tree quanh HEAD `adec19e`, owner phải đọc lại source trước khi nhận packet. `RV01-01..08` là sub-packet của ENC/CR28/COMP/LOCAL/P9, không tạo release gate mới hoặc tick parent hai lần. Các gate `G-ENC`, `G-DATA`, `G-SEC`, `G-COMP`, `G-LOCAL-ADMIN`, `G-ADMIN-OPS` và `G6` giữ **NO-GO**.

## Bằng chứng review và nguyên tắc đóng

- Offline tại `du-rework`: `pnpm --filter @du/orchestrator typecheck` và `pnpm --filter @du/worker-sdk lint` exit 0; 4 Orchestrator suite legacy/delivery có 121/121 pass; 2 Worker SDK suite crypto/artifact có 71/71 pass. Đây là unit/typecheck, **không** chứng minh wiring của `main.ts`, S3/Vault thật hoặc external wire.
- `pnpm --filter @du/document-core test`: **49 suite pass, 1 fail; 790 test pass, 1 fail / 791 total; exit 1**. Case đỏ tại `businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts:71` kỳ vọng một tham số, trong khi adapter truyền thêm `{ signal }`. Console output của một số negative test không được tính là fail.
- Với mỗi packet, receipt phải ghi command, cwd, build digest, passed/failed/skipped, exit code, raw output và producer/consumer path. Focused smoke đi cùng implementation; live/nghiệp vụ sâu chuyển sang `VFY-*` riêng. Test PG/Redis/S3/Vault chạy đồng thời trên namespace cô lập, chỉ claim/release resource chung hoặc thao tác phá hủy. Claude Code cho verdict `APPROVED` mới xét parent acceptance; không dùng mock xanh thay kết quả live.

## RV01-01 — Bootstrap mã hóa production và fail-closed

**Priority/parent:** P0; `ENC-02/05/07/08`, `ENC-INT-01`, `CR28-01/04`. **Owner gợi ý:** Orchestrator boot + Security/Vault, một owner duy nhất cho `src/main.ts` và `src/server.ts`.

**MISMATCH:** Entrypoint `services/orchestrator/src/main.ts:105-129` chỉ đưa DB/Redis/token/OIDC/storage vào `createApp`, không cung cấp `metadataEncryption`, `publicUploadEncryption`, `deliveryEncryption`, recipient registry hoặc Admin crypto config. Trong `server.ts:556-576`, S3 crypto/public upload gateway đều optional; public upload trả 503 khi gateway vắng (`server.ts:1445-1464`). Unit test inject `createApp` trực tiếp có thể pass trong khi `pnpm start` không có encryption.

**Xử lý:** Chốt cấu hình Vault/key-provider, allowlist storage-key ref, recipient registry/policy store và storage backend từ env/secret manager; nối vào entrypoint production bằng typed config parser. Với S3 production, thiếu app encryption/Vault dependency phải **fail boot hoặc fail request trước mọi PUT/DB write** theo ADR-18; DB pilot là mode riêng, không silent fallback. Không đưa master key/raw DEK vào env worker, browser hay log. Tách rõ delivery policy per-tenant (Admin toggle) khỏi storage encryption bắt buộc.

**Acceptance:** Clean image chạy đúng `dist/main.js` với S3+Vault test instance: PUT input chỉ tạo ciphertext và authenticated manifest; GET/result/download đổi mode theo Admin config, revoked key/Vault outage không trả plaintext. Negative boot matrix thiếu/sai key ref, Vault unavailable và S3 không có gateway không nhận upload/operation mồ côi. Có startup + HTTP + S3 byte-scan + external private-key decrypt receipt; không chỉ `createApp` fixture.

## RV01-02 — Seal metadata trước submit và ingestion READY

**Priority/parent:** P0; `CR28-04`, `ENC-META-01`, `ENC-INT-01`. **Owner gợi ý:** Orchestrator admission/runtime.

**MISMATCH:** `services/orchestrator/src/modules/operations/submission.ts:109-124` có `sealSubmitMetadata` và `:253-254` gọi seam, nhưng `services/orchestrator/src/server.ts:511-517` tạo submission service **không truyền `metadataCrypto`**; seam chỉ được tạo sau đó tại `server.ts:523-532` cho runtime. `services/orchestrator/src/modules/operations/ingestion-consumer.ts:419-431` gọi `processIngestionTask` không truyền seam, dù hàm hỗ trợ tham số này. Vì vậy bật metadata encryption ở `createApp` vẫn có đường ghi `operations.input_ref`/`tasks.payload_ref` plaintext và ingestion READY có thể ghi đè ciphertext bằng plaintext.

**Xử lý:** Khởi tạo một `MetadataCrypto` trước cả submission/runtime/ingestion consumer, truyền cùng key policy/AAD context vào cả ba; không thêm adapter mã hóa thứ hai. Kiểm tra mọi writer của input, child/join/HITL/checkpoint và outbox theo inventory `ENC-META-01`; giữ hash idempotency tính trên canonical plaintext trong memory, không lưu plaintext durable. Rollback transaction nếu seal/unwrap thất bại, không fallback.

**Acceptance:** Test qua **real `createApp` và `dist/main.js`** với hai tenant: submit inline, URL ingestion READY, replay/collision, claim/restart/lease; DB/Redis/outbox/log scan không có sentinel plaintext. Sai tenant/AAD, Vault outage, corrupted envelope và key rotation fail closed; không tạo task READY/queue delivery khi seal thất bại. Unit seam cũ là regression, không phải bằng chứng đóng packet.

## RV01-03 — Mã hóa mọi artifact Worker → S3/DB và round-trip manifest

**Priority/parent:** P0; `ENC-03/04/05`, `CR28-01`, `DATA-04`, `ENC-INT-01`. **Owner gợi ý:** Worker SDK + Orchestrator artifact/storage owner; serialize shared contract và grant code.

**MISMATCH:** `packages/worker-sdk/src/types.ts:256-296` không có production crypto configuration; `packages/worker-sdk/src/worker.ts:319-346` tạo `DefaultTaskContext` không inject `crypto`. `task-context.ts:637-658` gửi plaintext nếu seam vắng, còn nhánh multipart `:553-580` không gọi seam ngay cả khi có. S3 cấp presigned PUT trực tiếp tại `services/orchestrator/src/modules/artifacts/s3-storage-facade.ts:827-850`. Nhánh single-shot seal chỉ trả/upload ciphertext tại `task-context.ts:218-223`, đánh rơi nonce/tag/wrapped DEK/manifest; read path phân loại object thiếu marker là plaintext (`services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts:175-181`). Vì thế output có thể được lưu plaintext, hoặc được lưu ciphertext nhưng GET trả ciphertext không giải mã được. `sealArtifactBytes` chỉ kiểm 5 MiB **sau** khi gom toàn bộ stream (`task-context.ts:198-204`).

**Xử lý đề xuất:** Dùng **Orchestrator streaming crypto gateway** làm write boundary bắt buộc cho worker output, public input và URL ingestion trước S3/DB; không phát plaintext presigned PUT/part grants ở mode production. Worker chỉ giữ short-lived runtime identity và stream bytes qua TLS; Orchestrator seal bằng Vault-backed key, lưu authenticated manifest + version/tenant/artifact AAD atomically với finalize. Nếu ADR giữ worker-side crypto, phải wire config production, truyền manifest theo contract có xác thực và chứng minh không có helper/grant bypass; không đưa master key cho worker. Giới hạn bytes **trong lúc đọc stream**, thực thi chunked encryption cho multipart và fail closed khi metadata/marker/manifest thiếu hoặc sai.

**Acceptance:** Với real worker + runtime + S3/PG pilot: nhỏ, >5 MiB và multipart >64 MiB đều round-trip bytes/hash/MIME; S3/DB chỉ thấy ciphertext, read → worker và public download xác thực/decrypt đúng. Direct PUT/part bypass, marker/manifest strip, swapped object, tamper, restart, lease loss, over-limit và Vault outage đều không công bố READY/plaintext. Đo peak RSS/backpressure; không dùng unit `crypto-seam` làm bằng chứng thay integration.

## RV01-04 — Mount sáu core legacy endpoint và workflow facade

**Priority/parent:** P1; `COMP-00/02/03/09/10`, `P9-01..05`. **Owner gợi ý:** Orchestrator compatibility integrator; shared `server.ts` chỉ một write owner.

**MISMATCH:** Module `services/orchestrator/src/compat/legacy-action-router.ts:363` có router thuần nhưng không được import/mount trong `server.ts`; production chỉ có generic submit tại `server.ts:1730-1764`. `POST /api/v1/docs/{ingest,extract,analyze,transform,generate,compare}` và `/docs/workflows[ /schema ]` do client cũ gọi chưa có HTTP route. Unit router 121/121 pass không chứng minh ingress multipart, auth, upload encryption, admission, dispatch hay response.

**Xử lý:** Sau `COMP-00` freeze URL generic mới và `COMP-02` freeze legacy contract, mount adapter trước canonical routing; parse multipart/headers/query bounded, resolve principal từ `x-api-key`, gọi **cùng** submission/runtime/storage service, không tạo queue/operation thứ hai. Legacy shared paths mặc định trả wire cũ, generic DTO chuyển URL/version/opt-in chỉ cho client mới. Workflow `process`/`schemaSlug` route sang business/P9 đã triển khai; process chưa có thực thi phải fail rõ, không trả 202 giả.

**Acceptance:** HTTP golden fixture cũ, không header mới, chạy cả hai hệ thống: sáu submit, 31 variant sau `RV01-06`, ba workflow + schema, replay/`sync=true`/`Operation-Location`, invalid multipart, tenant/key/locked-field negative. So status/header/body và số operation/task tạo ra; Orchestrator/Connector/worker build digest không thay đổi ngoài packet được cấp.

## RV01-05 — Một serializer legacy operations/result đúng semantics

**Priority/parent:** P1; `COMP-05/06/07/10`, `RESULT-WIRE-01`, `ENC-07`. **Owner gợi ý:** Orchestrator public result/lifecycle; phụ thuộc `COMP-00/02` và output materialization decision.

**MISMATCH:** `services/orchestrator/src/compat/legacy-operations.ts:54-68,175-181` luôn phát `response`/`error` (kể cả null), không phát conditional `result` như hệ cũ `lib/pipelines/format.ts:17-65`; `CANCELLED`/`TIMED_OUT` bị đổi thành `FAILED` tại `legacy-operations.ts:127-145`. Router submit lại có serializer riêng ở `legacy-action-router.ts:292` nên submit và poll có thể khác shape. Production `server.ts:1776-1803` còn trả list canonical, `modules/operations/facade.ts:45` đặt progress luôn 0 và `server.ts:1979-1985` chỉ trả `resultRef`, không materialize nội dung legacy.

**Xử lý:** Một serializer được dùng cho submit/list/detail/poll, dựa golden fixture của DUGate cũ; chỉ xuất `result`/`error` khi đúng trạng thái, giữ trạng thái cancel/timeout đúng decision `COMP-00`, lấy progress/checkpoint/usage thực. Resolve output artifact dưới tenant fence, decrypt bounded rồi inline dưới cap hoặc cấp `download_url` theo `RESULT-WIRE-01`. Legacy `page_token` giữ dialect operation ID và SQL keyset tenant-scoped; không để client cũ phải gửi `Accept` mới. Delivery encryption server-side phải bọc **toàn bộ** legacy result khi Admin đã bật, không bọc riêng `resultRef`.

**Acceptance:** Golden GET list/detail/poll/cancel/resume/DELETE/download cho pending, WAITING_INPUT, success, failure, cancel, timeout, large result và encrypted mode; so key **và giá trị**, status/header/binary, cursor next-page, cross-tenant/missing ID. Test producer→artifact→wire với fixture thật; không đóng từ mapper unit tests.

## RV01-06 — Hoàn thiện domain 31 variants và workflow execution

**Priority/parent:** P1; `COMP-04/09/10`, `P9-01..05`, `INGEST-WIRE-01`. **Owner gợi ý:** document-core + ba workflow business owners; không sửa compatibility router cùng lúc.

**MISMATCH:** `businesses/document-core/src/manifest/document-core.manifest.ts:15` và recipe catalog đang có 28 variants, trong khi DUGate cũ có 31; thiếu `extract:id-card`, `analyze:fact-check`, `analyze:summarize-eval`. Ba workflow `disbursement`, `lc-checker`, `doc-compare` cùng schema workflow chưa có full worker→result/HITL path. Alias tên/fixture đơn thuần không tạo semantic parity.

**Xử lý:** Khóa ma trận 31 dòng ở `COMP-01`, bổ sung manifest/schema/recipe/validation/output cho ba variant, profile/Connector bytes thực theo từng variant; xây workflow business riêng theo P9, không đưa interpreter vào Orchestrator. Gắn process/schemaSlug qua `COMP-09` sau khi business version active.

**Acceptance:** 31/31 variant và 3/3 workflow + schema dùng cùng request fixture cũ chạy submit→worker→result (HITL/resume ở case liên quan), valid/invalid, provider bytes/hash/MIME, profile locked-field, idempotency/retry. Tester độc lập chạy golden `COMP-10`; mock recipe/manifest count chỉ là bước đầu.

## RV01-07 — Admin shell production và local-user mode

**Priority/parent:** P1; `LOCAL-00..06`, `ORCH-PAR-00/05/10`, `G-LOCAL-ADMIN`. **Owner gợi ý:** Auth/Admin boot, độc lập với public compat; serialize `main.ts`/`server.ts`.

**MISMATCH:** `services/orchestrator/src/app/admin/shell-server.ts:499-516` từ chối mount nếu thiếu `adminShellCookieSecret` hoặc `adminToken`; `services/orchestrator/src/main.ts:105-129` không truyền cookie secret. Login hiện dùng token/OIDC redirect (`src/app/admin/shell-router.ts:1607-1615`), không có DB local user/password hay `DU_ADMIN_AUTH_MODE`; static bearer check còn ở `server.ts:2799-2809`.

**Xử lý:** Thực hiện quyết định `LOCAL-00` rồi triển khai DB identity/Argon2id/one-time bootstrap (`LOCAL-01/02`), parser env `local|oidc|both` và shell mount local-only không cần OIDC/static token (`LOCAL-03`), một session/RBAC/CSRF/audit principal cho UI+Admin API (`LOCAL-04`). Mode sai hoặc dependency thiếu fail boot; không cho legacy signed-role cookie/static token mint local session.

**Acceptance:** Từ clean `pnpm start`/image: local-only login, OIDC-only, both, invalid config, logout/reset/disable/revoke, CSRF/tenant/RBAC và two-replica restart bằng HTTP+browser có side effect thật. `LOCAL-05/06` giữ quyền test/docs/review; token-login unit pass không thay local-user acceptance.

## RV01-08 — Sửa regression test SDK metadata adapter

**Priority/parent:** P2 nhưng chặn CI; `P5`/`P8-01` regression harness. **Owner gợi ý:** document-core test owner; không sửa production để chiều assertion cũ.

**MISMATCH:** `businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts:71` kỳ vọng `readWithMetadata(artifactId)`, trong khi implementation tại `businesses/document-core/src/worker.ts:176-179` chuyển tiếp thêm `{ signal }`. Full offline run có 1/791 fail; review chưa chứng minh đây là lỗi hành vi sản phẩm.

**Xử lý:** Xác nhận contract cancellation/AbortSignal của SDK; cập nhật assertion để kiểm `artifactId` và một `AbortSignal` được forward (kèm test abort nếu chưa có), không xóa signal ở production chỉ để xanh test. Nếu API không nên nhận options, cần quyết định contract và sửa producer/consumer cùng packet.

**Acceptance:** Targeted test pass và full `pnpm --filter @du/document-core test` exit 0, 0 skipped ngoài skip đã phê duyệt; báo số suite/test thực tế của lần chạy mới. Chạy thêm Worker SDK metadata read test để bắt regression xuyên package.

## Thứ tự, ownership và gate

1. **Security/data implementation:** `RV01-01` và `RV01-03` chạy song song; `RV01-02` nhận lease `main.ts`/`server.ts` ngay sau `RV01-01` hoặc cùng owner tiếp tục. `VFY-ENC`/`ENC-INT-01` là packet live riêng, không chặn viết code trên namespace cô lập.
2. **Compatibility implementation:** `RV01-06` producer, workflow business và compat decoder/serializer modules làm song song ngoài `server.ts`; `COMP-00/02` chỉ chặn **public wire mount/contract freeze**, không chặn module implementation độc lập. `RV01-04/05` mount sau decision + lease; `VFY-COMP`/`COMP-10` chạy sau từng vertical slice. OpenAPI vẫn single writer `COMP-02/11`.
3. **Admin implementation:** `LOCAL-01/02` primitives có thể làm trong module/migration riêng khi security interface được timebox; `RV01-07/LOCAL-03/04` production wiring cần `LOCAL-00` decision và lease `main.ts`/`server.ts`. `VFY-LOCAL`/`LOCAL-05` là packet chi tiết riêng. `RV01-08` focused fix xong nhưng `VFY-REG` full-suite còn pending.
4. **Gate:** Không lấy một packet `[x]` để tự đóng parent. `G-ENC/G-DATA/G-SEC` cần live crypto/deploy evidence, `G-COMP` cần old/new external fixture + consumer sign-off, `G-LOCAL-ADMIN/G-ADMIN-OPS` cần browser/live Admin journey; `P8-08/G6` vẫn NO-GO cho tới khi các gate áp dụng đều đạt. Coordinator không giao trùng với CR28/COMP/LOCAL packet đang active.
