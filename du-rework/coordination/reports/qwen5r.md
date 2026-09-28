# Qwen-5R (Implement) — lane report (kế thừa term_f24ec5cb / Qwen-5)

> [!IMPORTANT]
> **RESUME POINT — 2026-09-25 ~21:5x local (cycle W49-Q5R-1).** Đọc hết khối này là đủ để tiếp tục, khỏi đọc lại transcript.
>
> **Packet**: `W-DATA02-PUB-1` — đường public của **DATA-02** (`tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md` dòng DATA-02): route `POST /api/v1/uploads` + nhánh grant/complete/abort theo draft §8 (qwen4.md), submit guard, wiring `sweepExpiredSessions` vào vòng sweeper, đặt tên env `multipartLimits` theo §6 **đã ký 19:58**. Chỉ code + test offline. **KHÔNG mở DB/Redis/S3. KHÔNG commit/push — HEAD vẫn `7811298`.**
>
> **KẾT LUẬN W49-Q5R-1 = ĐÃ CODE + ĐÃ VERIFY OFFLINE, CHƯA ACCEPTED.**
> 1. **Public branch LANDED**: 4 route `x-api-key` + tenant fence, cùng engine storage-authoritative với nhánh runtime; `complete` public là cạnh STAGING→READY của nhánh này (có Δ-DEVIATION cần adjudicate — xem dưới).
> 2. **Sweeper ĐÃ NỐI** vào `recoveryTimer` qua `createMultipartSweepHook` (single-flight, postgres-only = no-op). **NOTE MISMATCH**: qwen5.md (W49-Q5-1) ghi chu kỳ sweeper nằm ở `integrity-scanner.ts` "thuộc lane khác" — SAI: file đó là trình verify một-shot của DATA-05 (scan `artifact_blobs`), không có vòng timer nào; các loop định kỳ thật nằm trong `server.ts` (recoveryTimer/webhookTimer) và thuộc ranh giới lane này. Không sửa `integrity-scanner.ts`.
> 3. **102/102 offline xanh** (69 cũ + 33 mới); receipt yêu cầu của packet (oidc02 + multipart chạy riêng): **6 suite, 121 pass + 10 skip, 0 fail** — 10 skip là gate live sẵn có của suite oidc02 (Qwen-3), KHÔNG tính là pass.
> 4. **§6 đã ký → env đã đặt tên**: `MULTIPART_PART_SIZE_BYTES` / `MULTIPART_MAX_TOTAL_BYTES` / `MULTIPART_SESSION_TTL_MS` / `MULTIPART_PART_URL_TTL_MS`, narrow-only giữ nguyên (giá trị ký trùng mặc định wire nên default không đổi).
> 5. **DATA-02 vẫn `[~]`**: ACCEPTED cần cửa sổ live S3 (blocker `NO-S3-ENVIRONMENT` của Tester-1 không đổi) + adjudicate các điểm Δ1–Δ4 dưới đây.
>
> **Việc còn của lane (theo ưu tiên)**: (a) chờ adjudicate public-complete=READY + chữ ký Idempotency-Key; (b) khi có S3: áp `0016`, chạy public path live; (c) flag lỗ hổng gray-zone (1 MiB ingress vs floor 64 MiB+1) — việc của coordinator/contract lane, không phải sửa ở đây.

## Packet

- Nguồn vụ: **DATA-02** public path; giao thức §8 draft của Qwen-4 (qwen4.md:389-397); giá trị §6 đã ký (MONITORING-LOG 2026-09-25 19:58, Cycle A1).
- Flow được phục vụ: public client → `POST /api/v1/uploads` (grant) → S3 part PUT (presigned) → `…/complete` → row STAGING→READY (cùng transaction commit đã verify) → submit guard (`submission.ts`, KHÔNG sửa) → operation.
- Consumer bị ảnh hưởng: SDK worker (không đổi wire runtime — 69 test cũ chứng minh); admin/shell (không đổi); client public (mặt mới).
- Ranh giới tuân thủ: chỉ `services/orchestrator` (src + tests + migrations + README/docs của nó) + `docs/07-internal-api.md`. **Không** chạm `packages/contracts` (fixed), `worker-sdk` (Qwen-4R), `services/connector` (Qwen-2). Server.ts: **additive only** — không đổi tên export hiện hữu (cảnh báo conflict Qwen-3/oidc02 trong packet).

## Đã code

| File | Vai trò |
|---|---|
| `src/modules/artifacts/multipart-service.ts` (~+320 dòng) | 4 method public (`publicInit/publicGrantPart/publicComplete/publicAbort`) + schema §8 (`omit(leaseEpoch[,purpose])`), `publicUploadToken()` (uuid dẫn xuất deterministic theo tenant), `Session.taskId` nullable, `lockSessionTenant`/`lockPublicSession`; **refactor bảo toàn hành vi**: `insertPartDeclaration`, `presignPartGrant`, `publishVerifiedBytes` dùng chung cho cả hai nhánh (69 test cũ xanh không đổi một assert nào) |
| `migrations/0016_public_upload_token_index.sql` (MỚI) | UNIQUE `(tenant_id, upload_token) WHERE task_id IS NULL AND upload_token IS NOT NULL` — khóa replay cho row không-task. **Lỗ thật**: index 0015 `(task_id, upload_token)` không ràng buộc được khi `task_id` NULL (PostgreSQL coi NULL là distinct) — replay public sẽ âm thầm tạo upload kép nếu thiếu 0016 |
| `src/server.ts` | Block route `/api/v1/uploads` (init + `:id/part|complete|abort`), `createMultipartSweepHook` (single-flight, disable khi postgres-only), `multipartLimitsFromEnv()` (tên env theo §6 đã ký; sai số → fail boot), seam `runMultipartSweep` trên App + nối vào `recoveryTimer` |
| `src/main.ts` | `multipartLimits: multipartLimitsFromEnv()` |
| `src/index.ts` | Barrel: thêm `publicUploadToken`, `createMultipartSweepHook`, `multipartLimitsFromEnv` (additive, không rename) |
| `tests/fixtures/multipart-offline-harness.ts` | Nhận dạng SQL public (insert `'input'`, select theo tenant+token, lock `id AND tenant`, commit→READY, abort theo tenant) + `publicInitBody`/`uploadEveryPartPublic` |
| `tests/multipart-service-offline.test.ts` | +15 case public (xem ## Test) |
| `tests/multipart-routes-offline.test.ts` | +17 case (wire public, sweep hook, env) |
| `tests/s3-multipart-storage-offline.test.ts` | +1 case (port không có khái niệm task — một facade phục vụ cả hai nhánh) |
| `docs/07-internal-api.md`, `services/orchestrator/README.md` | Mục "Public branch — /api/v1/uploads" + bảng route; README: env đã ký + public branch + sweeper cadence |

### Bất biến mới của nhánh public (mỗi dòng có test tương ứng)

- Auth: `resolveApiKey` (x-api-key ACTIVE, giống mọi route `/api/v1` hiện hành); worker bearer → 403 ngay từ gate đầu `route()`; API-key không có tenant trên row khác tenant → **404** (không lộ existence — cùng khuôn submit guard).
- purpose ép `'input'` phía server; `operation_id`/`task_id` NULL = chữ ký nhánh. Route runtime KHÔNG với được row public (auth JOIN thiếu operation → 404; `ownerTaskOf` → 409) và ngược lại (public gặp row có task → 409) — cả hai chiều đều có test.
- Cổng complete **đúng một engine** với nhánh worker: receipt khít 1..partCount, ledger grant phủ đủ, ListParts authoritative, re-hash toàn bộ pinned version **trước** khi ghi commit; generate chưa publish bị xóa khi fail.
- Replay: body `uploadToken` (uuid) thắng; absent → `Idempotency-Key` header dẫn xuất deterministic theo tenant; cùng key khác params → 409 IDEMPOTENCY_CONFLICT; same-key race → hủy provider upload vừa tạo, trả ack của winner.
- `complete` thành công = row READY (xem Δ1). Abort sau READY → 409, không bao giờ purge byte READY; abort STAGING → mark-then-purge idempotent; TTL sweep covers cả hai nhánh qua cùng một query.

## Δ-DEVIATION — cần coordinator adjudicate

1. **Public `complete` là cạnh STAGING→READY** (draft §8 không ấn định). Lý do: `finalize` runtime là route mang lease (taskId + leaseEpoch + task RUNNING) — client public không có lease nào để chứng minh, còn `complete` đã chạy toàn bộ cổng verify mà finalize sẽ chạy (ListParts + re-hash pinned version). Nới sang một `finalize` public thứ hai = thêm đường ghi READY thứ hai, trái tinh thần "một terminal transition". Submit guard vẫn chỉ nhận READY — không nới.
2. **`Idempotency-Key` VÀ `uploadToken` cùng được chấp nhận** (§8: "hoặc giữ cả hai, coordinator quyết" — lane chọn cả hai, body ưu tiên). Header tự sinh uuid v5-shape từ sha256(tenant|key): không cần đụng contract.
3. **Gray-zone không đóng được ở lane này** (nối dài Δ7 của qwen5.md): ingress JSON cap **1 MiB** (`http/ingress.ts`) nhưng floor multipart wire là **64 MiB+1** (`MULTIPART_MIN_TOTAL_BYTES`) → file công khai trong (1 MiB, 64 MiB] **hiện không có đường upload nào** (base64 chết ở ingress trước khi tới budget 64 MiB của submit guard). Đây là va chạm giữa hai giá trị đã ký/đã freeze: hoặc contract lane hạ floor, hoặc deployment tăng `maxJsonBytes` cho route submit — **quyết định của coordinator**, lane không tự sửa hai bên.
4. **`0016` là migration mới cần Tester apply** trong cùng cửa sổ với `0015` (verify-only boot sẽ fail với ledger thiếu sequence — đúng protocol, không phải bug).

## Trạng thái 4 mức (đếm từ task rows của packet)

| ID | SPECIFIED | IMPLEMENTED | VERIFIED (offline, bản code này) | ACCEPTED |
|---|---|---|---|---|
| DATA-02 · public branch | ✓ (§8 + §6 ký) | ✓ | ✓ 33 case mới | ✗ — cần live S3 (blocker `NO-S3-ENVIRONMENT` không đổi) + adjudicate Δ1–Δ3 |
| DATA-02 · submit guard | ✓ | ✓ (có trước, không sửa) | ✓ 5/5 trong R4 | ✗ (giữ nguyên hold cũ) |
| DATA-02 · sweeper wiring | ✓ (§6: TTL là lưới chính thức) | ✓ | ✓ 4 case hook + seam code; **boot thật chưa đo** (createApp thuộc live suite) | ✗ — cần live |
| DATA-00-M §6 env naming | ✓ (ký 19:58) | ✓ | ✓ 3 case env | ✓ phần lane này (gate live không liên quan tên env) |

Không tick `[x]` task row nào (rule 4).

## Receipt

cwd mọi lệnh: `D:\Git\dugate\du-rework\services\orchestrator`. Windows, **không** `DU_LIVE_INFRA`, HEAD working-tree (chưa commit). Marker `*_EXIT_0` do `&& echo` trong cmd.exe in ra **sau** khi jest kết thúc — exit code literal, không suy từ marker tự đặt.

| # | Lệnh | Kết quả đo được | Exit | Raw output |
|---|---|---|---|---|
| R1 | `npx tsc --noEmit -p tsconfig.json` | 0 lỗi | `TSC_EXIT_0` | `coordination/reports/qwen5r-typecheck.log` (rỗng = 0 lỗi) |
| R2 | `npx jest --runInBand --config jest.unit.config.cjs tests/multipart-service-offline.test.ts tests/multipart-routes-offline.test.ts tests/s3-multipart-storage-offline.test.ts tests/s3-multipart-upload.test.ts` | **4 suites / 102 passed / 0 failed / 0 skipped** = 69 cũ + 33 mới | `MP_EXIT_0` | `coordination/reports/qwen5r-multipart-public.log` |
| R3 | rerun độc lập R2 (lần 2 liên tiếp) | 102/102 | `MP_EXIT_0` | cùng log (ghi đè, kết quả giống hệt) |
| R4 | packet-item-5: `npx jest --runInBand --config jest.unit.config.cjs` trên **oidc02 ×2 + multipart ×4** | **6 suites / 121 passed / 10 skipped / 0 failed** (10 skip = gate live sẵn có của suite oidc02 lane Qwen-3, KHÔNG tính pass) | `OIDC_MP_EXIT_0` | `coordination/reports/qwen5r-oidc02-multipart.log` |
| R5 | regression hàng xóm: artifact-storage-service, artifact-submit-guards, artifact-read-authorization, artifact-integrity-scanner, artifacts-fencing, s3-storage-facade, br12-isolation-offline, runtime-lease-fencing-offline, migrations-ledger-guard | **9 suites / 107 passed / 0 failed** | `REG_EXIT_0` | `coordination/reports/qwen5r-artifacts-regression.log` |
| R6 | `npm run lint` (= `tsc --noEmit` của package) | 0 lỗi | `LINT_EXIT_0` | transcript cycle |

Test mới (33): service +15 — init task-less/replay/tenant-distinct/cap/MULTIPART_NOT_AVAILABLE/invisible-to-runtime/`publicUploadToken` determinism; grant+complete+abort +8 — READY-edge, foreign-tenant 404 ba cửa, untiled receipts giữ STAGING, **replay sau TTL** (khác runtime có chủ đích: commit durable thì còn replay được), abort mark-then-purge + idempotent, READY bất khả purge, từ chối điều khiển row runtime, grant quá hạn 409. Routes +17 — 201/200-replay, forward tenant, ưu tiên token body, 401 key chết, worker-bearer 403, absolutize URL, 404 fallthrough `/finalize` public (không tồn tại), 4 case sweep hook (disabled/enabled/single-flight/re-arm), 3 case env. Storage +1 — port không có khái niệm task, key không chứa tenant.

Không receipt nào là bằng chứng DB/S3/deployment. `migrations/0016_public_upload_token_index.sql` **chưa áp dụng lần nào** (rule 5) — mới đi qua `loadMigrationFiles` offline (guard trùng sequence trong migrations-ledger-guard vẫn xanh).

## Việc tiếp theo (next owner)

1. **Coordinator**: adjudicate Δ1 (public complete = READY edge), Δ2 (chấp thuận Idempotency-Key song song uploadToken), Δ3 (gray-zone 1 MiB ingress vs floor 64 MiB+1 — chọn route: contract lane hạ floor HOẶC deployment nâng `maxJsonBytes` cho submit, không phải im lặng).
2. **Coordinator → Tester-1**: khi S3-compat endpoint sống: cửa sổ live gồm áp `0015` + `0016`, public fixture >64 MiB đi hết grant→parts→complete(→READY)→submit→operation, replay sau mất response, abort/cleanup, và đo RSS server hai nhánh.
3. **Reviewer (tùy coordinator)**: Δ1 thay đổi một bất biến đã ghi trong docs ("terminal transition dùng chung") — nếu muốn giữ nguyên văn bất biến đó thì cần thiết kế finalize-public thứ hai; lane đề xuất adjudicate 1 câu.

> /compress
