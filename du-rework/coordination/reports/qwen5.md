# Qwen-5 (Implement) — lane report

> [!IMPORTANT]
> **RESUME POINT — chu kỳ gần nhất là W49-Q5-2 (~21:10 local); đọc `## W49-Q5-2` cuối file TRƯỚC khối này.** Các mục 2/3/4 và đoạn 'Việc còn lại' bên dưới đã được viết lại cho khớp code hiện tại — bản gốc 15:40 đã bị ba lane song song làm cho lỗi thời trong chính ngày hôm nay.
>
> **Packet**: `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` dòng **DATA-02** — server-side multipart API routes (init / part / complete / abort) trong `services/orchestrator`, theo contract additive đã land ở `packages/contracts/src/runtime.ts:240-355` (lane Qwen-4, Cycle 138). Chỉ code + unit test offline với mock. **KHÔNG mở DB/Redis. KHÔNG commit — HEAD vẫn `7811298`, không stage gì.**
>
> **KẾT LUẬN W49-Q5-1 = ĐÃ CODE + ĐÃ VERIFY OFFLINE, CHƯA ACCEPTED.**
>
> 1. **MISMATCH-1 (F3 của Qwen-4) ĐÃ ĐÓNG.** Engine S3 multipart không còn là helper đứng một mình: có port mới `ArtifactMultipartStorage` (5 method, gồm `ListPartsCommand` và signer cho `UploadPartCommand` — cả hai **chưa từng tồn tại** trong facade cũ) + service lifecycle + 4 route runtime thật.
> 2. **63 test offline của bản 15:40 đã lỗi thời như một mô tả** — ba lane chạy song song nối thêm vào đúng bộ này. Đo lại ở W49-Q5-2: **98/98** (3 suite multipart) và **143/143** (9 suite regression). Test của lane vẫn không chạm DB/Redis/socket.
> 3. **Δ1 (authorize qua artifact row, không cần `taskId` trong body) ĐƯỢC CHẤP THUẬN CHÍNH THỨC** tại user decision gate Cycle A1 — part/complete/abort authorize bằng artifact row, không thêm `taskId` vào request schema. Không còn là lựa chọn của lane nữa.
> 4. **§6 ĐÃ KÝ** (2026-09-25, Cycle A1): total ceiling 8 GiB, part ceiling **64 MiB** (lane này cài ở W49-Q5-2), geometry server-fix, TTL 24 h, part URL 15 phút, **sweeper TTL là lưới cleanup chính thức**. `0015` **đã được Tester apply + verify trên PG thật** (CLAIM 16:57:19 → RELEASE 16:59:12, 9/9).
>
> **Việc còn lại của lane = chỉ còn bằng chứng live.** Ba mục (a)(b)(c) của bản 15:40 **đều đã có lane khác land** trong lúc lane này viết báo cáo: env qua `multipartLimitsFromEnv`, sweeper qua `createMultipartSweepHook` (không đụng file lane khác), public branch §8 qua `/api/v1/uploads`. Chi tiết và hệ quả adjudicate ở `## W49-Q5-2` cuối file.
>
> **CẢNH BÁO MÔI TRƯỜNG cho mọi receipt hôm nay.** Nhiều lane chạy test đồng thời trên cùng máy (`codex6-cycle139-orchestrator-tests.log` ghi 14:29, ~5 phút trước sweep của tôi). Các suite gọi `.listen()` trên loopback thật nên **đỏ không tất định**: `admin-shell-server` (EADDRINUSE), `adm-base-03`, `admin-shell-platform-mount` (1 failed rồi 5 failed trên chính nó, không đổi một dòng code), `webhook-error-boundaries` (1 failed → **32/32 PASS** khi chạy lại). Tổng số test của full sweep cũng dịch **1242 → 1226 → 1246** giữa 3 lần chạy liên tiếp vì lane khác đang thêm file. Không quy kết các đỏ này cho DATA-02; cần một sweep trên máy đứng để adjudicate.

## Packet

- Nguồn vụ: **DATA-02** trong `tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` (+ §3.2 "không đưa public multipart vào production khi vẫn ghi PG blob"), và `du-rework/AGENTS.md` rule 1–5.
- Contract tiêu thụ: `packages/contracts/src/runtime.ts` — các schema `MultipartInit / PartGrant / Complete / Abort` (request + ack) và 6 constant `MULTIPART_*`. Lane này **không sửa** `packages/contracts` (diff `runtime.ts` +178 dòng là của Qwen-4, Cycle 138).
- Consumer bị ảnh hưởng: worker qua SDK (chưa auto-branch — việc kế), public client (chưa làm), `finalize` (vẫn là cạnh STAGING→READY **duy nhất** cho cả hai nhánh upload), sweeper orphan, IaC bucket lifecycle.

## Đã code

| File mới (tương đối `services/orchestrator/`) | Dòng | Vai trò |
|---|---|---|
| `src/modules/artifacts/multipart-storage.ts` | 84 | Port `ArtifactMultipartStorage` (tách khỏi `ArtifactStorageFacade` để PG-only không phải cài) + `multipartUploadHandle` |
| `src/modules/artifacts/multipart-service.ts` | 891 | `createMultipartService`: init / grantPart / complete / abort / sweepExpiredSessions |
| `migrations/0015_artifact_multipart.sql` | 76 | 6 cột `artifacts` + unique replay index + index TTL + bảng ledger `artifact_multipart_parts` |
| `tests/fixtures/multipart-offline-harness.ts` | 470 | `OfflineMultipartDb` (SQL-regex, cùng khuôn với `OfflineArtifactServiceDb`) + `FakeMultipartStorage` |
| `tests/multipart-service-offline.test.ts` | 455 | 35 case: guard / replay / geometry / fence / sweep |
| `tests/multipart-routes-offline.test.ts` | 236 | 13 case wire HTTP qua `route()` thật (service faked) |
| `tests/s3-multipart-storage-offline.test.ts` | 268 | 15 case command-level S3 (fake client + injected signer) |

Sửa: `src/modules/artifacts/s3-storage-facade.ts` (5 method của port + type `PresignPart` + `ListPartsCommand` phân trang + abort idempotent trên `NoSuchUpload`), `src/modules/artifacts/artifacts.ts` (`finalize` phân nhánh cap 413 + đọc `part_count`), `src/server.ts` (4 route, `RouteContext.multipart`, `ServerConfig.multipartLimits`, và **một** instance S3 facade dùng chung cho cả hai nhánh upload), `src/index.ts` (barrel: port + service + `PresignPart`), `docs/07-internal-api` (+9/−1), `services/orchestrator/README.md`.

### Route surface đã bind

    POST /api/runtime/v1/tasks/:id/artifacts/multipart      -> 201 mới / 200 replayed:true
    POST /api/runtime/v1/artifacts/:id/multipart/part       -> 200 presigned PUT 1 part
    POST /api/runtime/v1/artifacts/:id/multipart/complete   -> 200 committed:true
    POST /api/runtime/v1/artifacts/:id/multipart/abort      -> 200 state:"ABORTED"
    POST /api/runtime/v1/artifacts/:id/finalize             -> KHÔNG đổi schema; vẫn là cạnh READY duy nhất

### Bất biến đã cài (mỗi dòng có test tương ứng)

- `uploadToken` (uuid client sinh) unique theo `(task_id, upload_token)` = khóa replay init. Cùng token khác params → **409 IDEMPOTENCY_CONFLICT**. Race insert → hủy provider upload vừa tạo rồi trả ack của winner (`replayed:true`).
- Geometry do **server** chốt; client không tự khai size part. `partCount = ceil(size/partSize)`, part cuối = remainder. `sizeBytes` trong grant là giá trị server tính.
- Provider upload id không rời server; client chỉ nhận `uploadHandle = mh_ + sha256(uploadId)[0..16]`. `partUrl` presigned không vào log.
- `complete` theo đúng thứ tự: (a) receipt lát khít 1..partCount; (b) ledger grant của server phải phủ đủ; (c) sha receipt == sha đã declared lúc grant; (d) **`ListParts` của storage là authoritative** (etag + size + checksum đã decode base64→hex); (e) `CompleteMultipartUpload` bắt buộc `VersionId` ≠ `null`; (f) `verifyAndPin` re-hash **toàn bộ** pinned version **trước** khi ghi commit; (g) fail sau khi publish → **xóa version chưa publish**.
- Lease fence lại ở mọi bước durable, lock order task → artifact (`FOR UPDATE`) giống `finalize` hiện hữu. Epoch đổi giữa chừng → 409 `LEASE_LOST` + version bị xóa (có test chủ động simulate takeover).
- `abort`: mark-then-purge (row terminal TRƯỚC khi byte bị xóa), idempotent, cho phép cleanup khi task đã rời `RUNNING` nhưng vẫn fence epoch; **không** bao giờ purge byte của artifact `READY` (409 `STATE_CONFLICT`).
- `sweepExpiredSessions`: STAGING quá TTL → `ABORTED` (`abort_reason='expired'`), **và** nối dở purge cho row `ABORTED` còn treo `multipart_upload_id`; purge fail thì giữ con trỏ để lần sweep sau làm tiếp.
- Deployment postgres-only → 409 `MULTIPART_NOT_AVAILABLE` (không im lặng rơi về PG — đúng §3.2 plan).
- `artifact_blobs` không có write mới ở mọi path (assert ngay trong INSERT column list của harness).

## Δ-DEVIATION — sai lệch so với draft W49-Q4-2 (cần coordinator adjudicate)

1. **Draft §3 không chạy được như đã viết** (sửa, không phải lựa chọn thẩm mỹ). Draft yêu cầu part/complete/abort dùng `assertArtifactRuntimeAuth` + `assertBodyTaskRuntimeAuth`. Nhưng `MultipartPartGrantRequestSchema` / `MultipartCompleteRequestSchema` / `MultipartAbortRequestSchema` extend `LeaseBoundRequestSchema` = `{ leaseEpoch }` và **không mang `taskId`**, nên `assertBodyTaskRuntimeAuth` (đòi `ctx.body.taskId`) sẽ **403 mọi lời gọi worker đúng spec**. Lane này authorize theo **artifact** (đã business-scope qua `artifacts JOIN operations`) rồi **suy task từ row** và mới fence epoch — không cần đổi contract, chắn bằng hoặc hơn draft. Báo cáo khảo sát của Explore lane (mục 7) độc lập kết luận y hệt: *"you'll need `assertArtifactRuntimeAuth` + a task-ownership check derived from the artifact row's `task_id`"*. Không test nào của draft bắt được điểm này — đó là lý do nó ghi là MISMATCH chứ không phải refactor.
2. **Không đăng ký error code mới vào `RuntimeErrorCodes`.** Các code mới (`MULTIPART_NOT_AVAILABLE`, `MULTIPART_EXPIRED`, `PARTS_EXCEEDED`, `PART_SET_MISMATCH`, `CHECKSUM_MISMATCH`, `SIZE_MISMATCH`, `PART_OUT_OF_RANGE`, `INVALID_STORAGE_GRANT`) đi qua `HttpError(status, code, message)`; `ProblemSchema.code` là `z.string()` và catalog **không** được validate lúc chạy. Tiền lệ ngay trong artifact lane: `PAYLOAD_TOO_LARGE`, `HASH_MISMATCH`, `SIZE_MISMATCH`, `MALFORMED_BODY`, `METHOD_NOT_ALLOWED` đều ngoài catalog. Nếu muốn chúng vào taxonomy: một dòng additive, **thuộc lane contract**, không phải lane này tự làm.
3. **Bỏ cột `etag` trong ledger** (draft §5 có). `ListParts` là nguồn etag authoritative khi complete, nên lưu etag client khai = data chết + mời một đường so sánh sai nguồn. Ledger giữ `(artifact_id, part_number, declared_sha256, size_bytes)`.
4. **§6 policy chưa ký → không đặt tên env var.** Mặc định lấy đúng constant wire của contract; `config.multipartLimits` chỉ được phép **thu hẹp** (helper `narrow()`: floor là wire floor, ceiling là wire ceiling — typo của operator không thể mở rộng wire). Wiring env để trống có chủ đích tới khi Ops/Product ký giá trị.
5. **Thêm `abort_reason`** (draft không có): field `reason` trên wire nếu không persist thì thành data chết. CHECK chấp nhận `cancelled|superseded|failed|expired` (`expired` chỉ sweeper ghi).
6. **Cap 413 của `finalize`** phân nhánh theo row: row có `part_count` dùng size nó khai ở init (đã bị policy cap lúc init), row single-PUT giữ `maxArtifactBytes` như cũ. Hệ quả phụ cần biết: finalize cho artifact **không tồn tại** với body oversize-nhỏ-hơn-trần-wire giờ trả **404** thay vì 413 (trước đây 413 xảy ra trước mọi DB read). Single-PUT 413 path không đổi — case `maxArtifactBytes: 4` trong `artifact-storage-service.test.ts` vẫn xanh.
7. **Không phải việc của lane này, ghi lại để adjudicate cùng §6**: `MULTIPART_MAX_PARTS` của wire là 10 000 nhưng `complete` là JSON body và ingress cap JSON ở **1 MiB** (`http/ingress.ts:27`). 10 000 receipt ≈ 1.3 MB → sẽ 413 ngay ở ingress. Với trần policy 8 GiB / part 8 MiB thì thực tế tối đa **1000 part ≈ 130 KB**, an toàn; nhưng nếu §6 duyệt part nhỏ hơn hoặc total lớn hơn thì **phải** xét cap ingress cùng lúc. Service không có guard cho việc này — cố ý, vì nó là hệ quả của hai giá trị chưa ký.

## _known-EDGE_ (không đóng được bằng code của lane này — cần bằng chứng live)

**Orphan version trong cửa sổ chết.** Nếu process chết **sau** `CompleteMultipartUpload` nhưng **trước** UPDATE commit: provider upload đã đóng → `abortMultipartUpload` hết tác dụng, `ListParts` trả `NoSuchUpload` → complete retry nhận 409 `PART_SET_MISMATCH`; row nằm `STAGING` tới TTL rồi sweep sang `ABORTED`. Trong kịch bản đó `committed_version_id` **chưa được ghi**, nên purge của sweep không biết version nào để xóa → **version cô đơn do bucket lifecycle rule dọn** (`AbortIncompleteMultipartUpload` + noncurrent-version expiration — IaC, `DEP-01`, đã nằm trong draft §3.2). Lane này không tạo đường vòng nào qua rule đó. Không test offline nào chứng minh được điều này và tôi không giả vờ ngược lại.

## Trạng thái 4 mức (đếm từ task rows của packet, không phải tỷ lệ release)

| ID | SPECIFIED | IMPLEMENTED | VERIFIED (offline, bản code này) | ACCEPTED |
|---|---|---|---|---|
| DATA-00-M (contract multipart) | ✓ (Cycle 138) | ✓ | ✓ `191/191` (receipt Qwen-4) | ✗ — §6 policy values chưa ký |
| **DATA-02 (packet của lane này)** | ✓ | ✓ — **F3 đã đóng** | ✓ **63/63** mới + **137/137** regression set | ✗ gate mở: cần PG apply `0015`, signed PUT thật, finalize-replay, RSS bound |
| DATA-02 · submit guard | ✓ (có trước) | ✓ `artifact-submit-guards` | ✓ (nằm trong 137) | ✗ (thuộc lane cũ, không đổi) |
| DATA-02 · public branch `/api/v1/uploads` (§8) | ✓ propose | ✗ chưa làm | — | ✗ |
| DATA-04 · SDK `writeStream` auto-branch (§7) | ✓ propose | ✗ chưa làm | — | ✗ |
| DATA-INT-01 (G-DATA) | ✓ | ✗ (phụ thuộc DATA-02/03 live) | — | ✗ |

Không đánh dấu `[x]` ở `tasks/…`: theo rule 4 chỉ ACCEPTED mới được checked.

## Receipts

cwd mọi lệnh: `D:\\Git\\dugate\\du-rework\\services\\orchestrator`. Thời điểm 2026-09-25 ~15:20–15:40 local, Windows, **không** đặt `DU_LIVE_INFRA`.

| # | Lệnh | Kết quả đo được | Exit | Raw output |
|---|---|---|---|---|
| R1 | `npx tsc --noEmit -p tsconfig.json` | 0 lỗi (gồm barrel `src/index.ts` mới) | 0 | `coordination/reports/qwen5-typecheck.log` (rỗng = 0 lỗi) |
| R2 | `npx jest --runInBand --config jest.unit.config.cjs tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/s3-multipart-storage-offline.test.ts` | **3 suites / 63 passed**, 0 failed, 0 skipped | 0 | `coordination/reports/qwen5-multipart-unit.log` |
| R3 | `npx jest --runInBand --config jest.unit.config.cjs` (toàn bộ unit offline, 55 suite) | 50–53 suite passed; 1216–1233 passed, 7 skipped; suite đỏ **xoay vòng**, không phải của lane này | 0/1 | `coordination/reports/qwen5-orchestrator-unit.log` |
| R4 | `npx jest --runInBand --config jest.unit.config.cjs` trên 13 suite (multipart + artifacts + s3 + fencing + br12); 2 suite bị `jest.unit.config.cjs` loại vì thuộc danh sách live | **11 suites / 137 passed** | 0 | transcript cycle này |
| R5 | rerun `tests/webhook-error-boundaries.boundary.test.ts` hai lần liên tiếp | lần 1: 1 failed / 31 passed; lần 2: **32 passed** — không đổi một dòng code | 0 | `qwen5-probe-webhook.log` |
| R6 | rerun `tests/admin-shell-platform-mount.test.ts` hai lần liên tiếp | 1 failed/36 → **5 failed/32** giữa hai lần chạy giống hệt nhau | 0 | `qwen5-probe-adminmount.log` |
| R7 | rerun riêng `admin-shell-server` / `adm-base-03` / `redis-session-repository` | 55/56 (EADDRINUSE :50660) → **PASS 56/56**; **18/18**; **20/20** | 0 | transcript |

R5/R6/R7 có giá trị adjudicate: `webhook-error-boundaries` là suite offline **duy nhất boot `createApp`** trong 55 suite (14 suite import `createApp`, 13 đã nằm trong `liveSuites` của `jest.unit.config.cjs` — đã đếm lại, không suy luận), và nó pass toàn bộ khi chạy lại → đồng thời chứng minh `createApp` của tôi (đã thêm `createMultipartService` với `storage: undefined` khi deployment không có S3) boot lành.

Không receipt nào ở đây là bằng chứng DB/S3/deployment. `migrations/0015_artifact_multipart.sql` **chưa áp dụng lần nào** (rule 5: test cần DB chỉ do Tester giữ window); nó mới được review bằng mắt và đi qua `loadMigrationFiles` offline (guard trùng sequence trong `migrations-ledger-guard.test.ts` vẫn xanh với file mới).

> **[ĐÓNG VÌ SAI — W49-Q5-2]** Câu trên đúng tại 15:40 và **không còn đúng**: Tester-1 đã apply `0015` trong cửa sổ DB có kiểm soát (CLAIM 16:57:19 → RELEASE 16:59:12, target `127.0.0.1:5433/du_orchestrator_test`, `migrate` + `migrate:verify` exit 0, `migrations.test.ts` 9/9; raw ở `%TEMP%\migration-0015-*.log`, trích trong `coordination/reports/tester.md`). CHECK `part_size_bytes >= 5242880` và unique index replay của tôi vì thế đã đi qua parser PG thật. **Hệ quả ràng buộc**: `0015` giờ là file đã apply — mọi sửa đổi tiếp theo thành checksum drift, phải là `0016` hoặc cửa sổ Tester mới. Lane này **không** đụng `0015` trong W49-Q5-2.

## Việc tiếp theo (next owner)

> **[CẬP NHẬT W49-Q5-2]** Mục 1 đã được xử lý (Δ1 **chấp thuận** tại Cycle A1 — không đổi contract). Mục 2 đã ký **và** đã có lane khác land env wiring. Mục 3 đã có lane khác land (## W49-Q5-2 §1). Mục 5 đã land ở Qwen-4 Cycle 140. **Chỉ còn mục 4 (Tester) là mở**, cộng hai adjudication mới Δ8/Δ9 ở `## W49-Q5-2` §4.

1. **Coordinator**: adjudicate 7 điểm ở ## Δ-DEVIATION. Riêng Δ1: nếu muốn giữ nguyên draft §3 thì phải **thêm `taskId` additive vào 3 request schema** → quay lại lane contract và chạy lại `191` test của `@du/contracts`.
2. **Coordinator / Ops-Product**: ký §6 (threshold / part size / total ceiling / session TTL / part URL TTL / RSS budget). Sau khi ký: một packet nhỏ wiring `multipartLimits` qua env + cập nhật README + xét lại cap JSON ingress (Δ7).
3. **Orchestrator lane (kế)**: nối `sweepExpiredSessions` vào chu kỳ sweeper trong `integrity-scanner.ts` (API đã để sẵn, không đổi hành vi cũ).
4. **Tester**: cửa sổ PG + S3 để mở khóa DATA-02 — apply `0015`, binary fixture > 64 MiB đi hết grant→parts→complete→finalize, finalize-replay sau mất response, và đo RSS thật.
5. **worker-sdk lane**: §7 (SDK `writeStream` tự branch theo ngưỡng) để DATA-04 thực sự dùng được đường này.

---

# W49-Q5-2 — tiếp quản sau adjudication (2026-09-25 ~21:10 local)

> **Không packet mới, không tính năng mới.** Lý do: ba việc lane định làm trong cycle này (wire env
> `multipartLimits`, nối sweeper, và cả §8 public branch) **đã có lane khác land** hồi 20:43–20:58,
> tức trong lúc lane này đang đọc code để bắt đầu. Phần còn lại thật sự mở chỉ là **một giá trị chính
> sách** — và nó là một landmine interop có thật, không phải mỹ thuật.

## 1. Việc đã làm trong chu kỳ

| # | Việc | File | Vì sao thuộc lane này |
|---|---|---|---|
| 1 | Trần part size **5 GiB → 64 MiB** theo §6 đã ký | `src/modules/artifacts/multipart-service.ts:60` | `narrow()` ceiling là của lane DATA-02. **Không** đụng `migrations/0015` (đã apply 16:57 → sửa SQL = checksum drift, phải thành 0016 + cửa sổ Tester) |
| 2 | 2 test mới: clamp trần part + bất biến JSON cap | `tests/multipart-service-offline.test.ts` | cùng bộ test của lane |
| 3 | README ghi trần 64 MiB kèm lý do | `README.md` | cùng surface tài liệu |
| 4 | Sửa 3 claim stale của chính báo cáo này | file này | lane tự chịu trách nhiệm receipt mình đã phát hành |
| 5 | Đối chiếu wire client↔server liên-lane | (inspection, không sửa code) | F3 là của lane này; ai tiêu thụ nó cũng cần lane này xác nhận |

## 2. Vì sao 64 MiB — và vì sao 5 GiB là bug, không phải "hơi rộng"

S3 cho 5 GiB/part, nên 5 GiB từng là ceiling *của storage*. Nhưng SDK `@du/worker-sdk` **từ chối
thẳng** geometry lớn hơn 64 MiB ( `artifact-multipart.ts:54` `MULTIPART_SDK_MAX_PART_BYTES`, fail
413 ở `:132-137`) vì nó buffer đúng một part lúc hash. Wire contract **không chắn được**:
`MultipartInitAckSchema.partSizeBytes` chỉ có `.min(MULTIPART_FIXED_PART_BYTES)`, **không có
max** (`runtime.ts:282`). Cho nên một deployment đặt `MULTIPART_PART_SIZE_BYTES=134217728` từng
hợp lệ với **cả contract lẫn server**, tự verify offline xanh, rồi chết mọi upload thật ở dòng đầu
tiên phía worker. Server giờ clamp xuống 64 MiB → cấu hình đó không còn sinh ra session mà không peer
nào nạp được. Đây là lỗi *chính lane này thiết kế* (trần 5 GiB là của W49-Q5-1), không phải lane SDK.

## 3. Đối chiếu wire liên-lane (chưa ai làm trước đó)

Kết luận: **khớp toàn bộ**, không có 422 ẩn, không có field thừa.

- **Path**: SDK dựng 4 path ở `runtime-client.ts:254/260/266/272`, server bind ở `server.ts:845`
  và `:861`. Alias `part-grant` (lane khác thêm, 19:38) là additive; SDK dùng spell `part`.
- **Body**: cả 4 request SDK gửi **không** mang `taskId` và không mang key nào ngoài schema.
  Cả 4 schema request là `.extend()` trên `z.object` **không** `.strict()`; repo **không** có
  `z.config(`/`createErrorMap` → unknown key bị strip chứ không reject. **Hệ quả cho
  adjudicate**: nếu ai đó muốn "vá" Δ1 theo draft §3 bằng cách cho client gửi `taskId`, server sẽ
  nhận rồi **vứt** — fence không mạnh hơn, chỉ tạo cảm giác mạnh hơn. Muốn thật phải đổi contract
  (đã bị Cycle A1 từ chối).
- **Ack**: SDK parse bằng full schema nên mọi field bắt buộc phải có; server trả đủ
  `uploadHandle`/`replayed`/`committed`, và `partUrl` được `absoluteGrantUrl()`
  absolutize nên `z.string().url()` phía SDK pass.
- **Headers**: SDK gửi nguyên `requiredHeaders` server trả, không tự tính checksum. Chỉ
  `x-amz-checksum-sha256` vào chữ ký (`s3-storage-facade.ts:161-168`); `content-length`
  không sign → size chốt bằng `ListParts`. Khớp đúng thiết kế đã ghi ở W49-Q5-1.
- **Hình học mặc định trùng khít**: server 8 MiB/part ≤ cap SDK 64 MiB; 8 GiB / 8 MiB = 1024 ≤
  10 000 part. Ngưỡng branch SDK (64 MiB) nằm đúng 1 byte dưới floor wire — có chủ đích, có test
  của lane contract.

## 4. Δ-DEVIATION phát sinh thêm (cần coordinator adjudicate)

- **Δ8 — §6 ký "Concurrency part PUT song song 3 (SDK default)" nhưng SDK chạy 1.**
  `artifact-multipart.ts:195` tính `partNumber = receipts.length + 1` rồi `await` ngay trong
  vòng đọc nguồn; không có `Promise.all` part nào trong toàn bộ `packages/worker-sdk/src`. Server
  **chịu được** song song (mỗi grant một tx, lock task→artifact, ledger `ON CONFLICT (artifact_id,
  part_number)`), nhưng **không một test offline nào của cả hai lane** cover path song song. Một giá
  trị đã ký không được implement: hoặc sửa bảng §6, hoặc mở packet cho worker-sdk lane. Không phải
  lane này tự quyết.
- **Δ9 — bất biến "finalize là cạnh STAGING→READY duy nhất" giờ chỉ còn đúng một nửa.** Nhánh public
  (`publicComplete`) commit thẳng `state='READY'` ở `multipart-service.ts:1055`. Nó **vẫn** đi
  qua `publishVerifiedBytes` (ListParts + Complete + `verifyAndPin` re-hash toàn object) tức vẫn
  verified-then-committed; cái thay đổi là có **hai** cạnh. Chéo nhau đã chắn: UPDATE fenced
  `task_id IS NULL AND part_count IS NOT NULL AND storage_version_id IS NULL`, nên route public
  không lật được row của worker và ngược lại. W49-Q5-1 ghi "duy nhất" là đúng lúc viết và **sai** trên
  code hiện tại — sửa ở đây, không viết lại lịch sử.
- **Δ7 ĐÓNG bằng số học, không còn là ghi chú chờ §6.** Part floor 8 MiB là wire (`narrow()` không
  cho thấp hơn) và total ceiling 8 GiB ⇒ `partCount ≤ 1024` **cấu trúc**, kể cả khi operator chỉnh.
  1024 receipt với etag dài tối đa cho phép của schema (256 ký tự) ≈ 410 KB < cap JSON ingress
  1 MiB (`http/ingress.ts:28`). Có test mới khóa lại; §6 tương lai mở total hoặc hạ part floor sẽ
  làm test đỏ **trước** khi route kịp hỏng.

## 5. Trạng thái 4 mức (cập nhật, đếm từ task rows)

| ID | IMPLEMENTED | VERIFIED (offline, code hiện tại) | ACCEPTED |
|---|---|---|---|
| **DATA-02** runtime branch | ✓ (+ trần 64 MiB) | ✓ **98/98** multipart, **143/143** regression; `0015` đã apply + verify trên PG thật | ✗ — còn signed PUT thật, finalize-replay, RSS |
| DATA-02 · env `multipartLimits` | ✓ (lane khác, `multipartLimitsFromEnv`) | ✓ 4 case nằm trong 98 | ✗ — chờ Ops đặt giá trị |
| DATA-02 · sweeper wiring | ✓ (lane khác, `createMultipartSweepHook` — **không** đụng `integrity-scanner.ts`) | ✓ 4 case scheduling trong 98 | ✗ |
| DATA-02 · public branch §8 | ✓ (lane khác) | ✓ ~20 case public trong 98 | ✗ |
| DATA-04 · SDK auto-branch §7 | ✓ (Qwen-4 Cycle 140) | ✓ 171/171 của lane đó + khớp wire đối chiếu ở ## 3 | ✗ — RSS chưa đo |

## 6. Receipts W49-Q5-2

cwd mọi lệnh: `D:\Git\dugate\du-rework\services\orchestrator`, ~21:05–21:15 local,
Windows, **không** `DU_LIVE_INFRA`, **không** DB/Redis, **không commit**.

| # | Lệnh | Kết quả đo được | Raw output |
|---|---|---|---|
| R8 | `npx tsc --noEmit -p tsconfig.json` | 0 lỗi | `coordination/reports/qwen5-cycle2-typecheck.log` (`EXIT0_TSC_CLEAN`) |
| R9 | `npx jest --runInBand --config jest.unit.config.cjs` trên 3 suite multipart | **3 suites / 98 passed**, 0 failed, 0 skipped | `qwen5-cycle2-unit.log` |
| R10 | như R9 + 6 suite artifact/storage/facade regression | **9 suites / 143 passed** | `qwen5-cycle2-regression.log` |
| R11 | đối chiếu client↔server bằng đọc code (## 3) | inspection, không phải lệnh — mỗi kết luận có citation dòng | transcript cycle này |

R10 lưu ý: đường dẫn `tests/ingress-bounded.test.ts` có truyền nhưng bị `jest.unit.config.cjs` loại
(danh sách live) nên chỉ 9 suite chạy — cùng hiện tượng đã ghi ở R4 của W49-Q5-1, không phải đỏ.

**Hai điểm về bản thân cơ chế receipt** (ghi để coordinator xử lý một lần, không phải việc DATA-02):

- `*.log` nằm trong `du-rework/.gitignore:9` → **mọi đường dẫn raw output trong bảng receipt của mọi
  lane chỉ tồn tại trên máy này**, không bao giờ vào repo. Receipt kiểu "path tới log" vì thế không thể
  tái kiểm tra bởi người khác. (Bốn log của W49-Q5-1 cũng cùng số phận.)
- Trong cùng thư mục có `qwen5r-artifacts-regression.log`, `qwen5r-multipart-public.log`,
  `qwen5r-oidc02-multipart.log` — **một lane khác dùng prefix gần giống "qwen5"**. Vì vậy lane này
  **không** quy kết ai đã viết alias `part-grant` / env wiring / sweeper hook / `/api/v1/uploads`;
  chỉ có thể nói các sửa đó tồn tại ở `server.ts`, `main.ts`, `multipart-service` trước 21:00 và
  không phải do lane này. Attribution đúng nên lấy từ Orca ledger của coordinator, không từ suy đoán.

## 7. Việc tiếp theo

1. **Tester**: cửa sổ PG + S3 — binary fixture > 64 MiB đi hết grant→parts→complete→finalize bằng
   signed PUT thật, finalize-replay sau mất response, đo RSS theo ngân sách §6 (2× part + fetch
   overhead). **Đây là gate duy nhất còn lại của DATA-02.**
2. **Coordinator**: adjudicate Δ8 (giá trị concurrency đã ký không có trong code) và xác nhận Δ9 (hai
   cạnh READY, cùng verified-then-committed, fence chéo) là thiết kế chấp nhận được.
3. **Lane sau của DATA-02**: đừng mở packet wiring env / sweeper / §8 — cả ba đã land. Nếu cần đào
   sâu, chỗ chưa có bằng chứng là case orchestrator chết **giữa** `CompleteMultipartUpload` **và**
   commit (`_known-EDGE_` của W49-Q5-1) — chỉ bucket lifecycle rule (DEP-01) đóng được.

