# ENC-META-SCAN — Inventory writer durable + offline sentinel — cc_2

- **Date:** 2026-10-03 · **Lane:** cc_2 (command-code) · **Spec:** `coordination/reports/recon-old-plans-e-2026-10-03.md` §`ENC-META-01`.
- **Mode:** READ-ONLY source/tests. **Zero file sửa** ngoài receipt này. **Không tick gate. Không commit.** `nocobase-10` không bị nhắc.
- **Scope:** mọi writer durable của orchestrator ghi payload/input/metadata (submission inline, URL ingestion, runtime child/join, HITL/checkpoint, outbox, queue, artifact refs, log/temp) + phần bytes/temp phía worker liên quan.
- **Line-number caveat:** số dòng ghi theo working tree lúc đọc (2026-10-03 ~00:35–01:05). Các lane CRX-01/RFX đang sửa song song `submission.ts`, `ingestion-consumer.ts`, `server.ts`, `multipart-service.ts` và một số test — phát hiện chính (`sourceUrl` trong outbox payload) đã được đọc lại và giữ nguyên dòng `submission.ts:344-356`; khi review nếu dòng dịch chuyển thì neo theo symbol (block `INSERT INTO outbox` trong `submit()`).

**TL;DR (VI):** 4 cột control-plane + 2 nhánh submit/gate **đã seal** qua `metadataCrypto` và có test offline (module + createApp). Các lỗ còn lại của inventory: **(1) `sourceUrl` nằm plaintext trong outbox payload → Redis job data** (submission.ts:355 — ngoài 4 slot, URL có thể chứa query token); **(2) `tasks.result_ref` / `operations.result_ref`** worker-supplied, plaintext (đã có FINDING ở test, chưa có slot); **(3) `human_waits.input_schema/ui_schema/context_ref`** plaintext (runtime.ts:957-970, không có slot); **(4) bytes nguồn URL ingestion ghi thẳng S3** không mã hoá tầng ứng dụng (ingestion-storage-s3.ts:91-100 — thuộc ENC-05); **(5) metadata phụ trợ**: `artifacts.file_name/mime_type`, `usage_events.payload`, `callback_url/connector_bindings/submit_artifacts` chưa có quyết định seal; **(6) `allowPlaintext=true`** ở runtime/consumer là backfill window không deadline (đã pin FINDING). §2 là test plan offline qua `createApp` cho từng chỗ hở — **chưa implement**.

## 1. Inventory writer (file:line → seal → điều kiện còn hở)

### 1.1 Đã seal qua `metadataCrypto` (4 slot + injection điểm)

| # | Writer | file:line | Seal | Ghi chú / test hiện có |
|---|---|---|---|---|
| 1 | Submit inline — `operations.input_ref` | `submission.ts:254` (seal trước tx), INSERT `:285-300` | ✅ `sealSubmitMetadata` → `crypto.seal` | `crx01-creatapp-metadata-seam.test.ts:263-308` (createApp + sentinel + mở lại đúng binding); `submission-metadata-crypto-e2e` |
| 2 | Submit inline — `tasks.payload_ref` (root) | `submission.ts:255`, INSERT `:321-327` | ✅ | như trên |
| 3 | URL ingestion — gate re-seal **cả hai cột** (READY envelope) | `submission.ts:471-477` (`markIngestionReadyOn`), UPDATE `:480-491` | ✅ mỗi cột seal theo row riêng (AAD slot+row) | `url-ingestion-consumer-offline.functional.test.ts:1429-1492` (submit payload mở được, READY envelopes không lộ sentinel) |
| 4 | URL ingestion — mở submit-side payload | `ingestion-consumer.ts:547-553` | ⚠️ đọc qua `readStored(..., true)` (allowPlaintext) | test 1429+; mis-bound → TASK_INVALID (1494+), Vault outage giữ gate đóng (1519+) |
| 5 | Runtime child spawn — payload từng child | `runtime.ts:811-819` seal, INSERT `:820-824` | ✅ | **chưa có test seal** (xem T1) |
| 6 | Runtime parent continuation (`continuationRef`, `joinPolicy`) | `runtime.ts:852-860` | ✅ | chưa có test (T1) |
| 7 | Runtime join — merge `joinSummary` vào parent payload | `runtime.ts:1469-1489` (open `:1474-1478`, seal `:1480-1484`) | ✅ | chưa có test (T2) |
| 8 | HITL — `human_waits.response_ref` (câu trả lời) | `runtime.ts:1073-1081` | ✅ | chưa có test (T3) |
| 9 | HITL — resume payload (`resumeInput`) vào `tasks.payload_ref` | `runtime.ts:1100-1107` | ✅ | chưa có test (T3) |
| 10 | Checkpoint — `step_checkpoints.output_ref` | `runtime.ts:463-477` | ✅ (`input_hash` digest giữ plaintext — rationale trong code `:458-459`) | chưa có test (T4) |
| 11 | Claim — đọc 4 slot để trả snapshot | `runtime.ts:1529-1584` | ✅ (open) | `runtime-encryption-metadata.test.ts:641-773` (4 window qua `claimTask`) |

### 1.2 Outbox / Queue (BullMQ → Redis)

| # | Writer | file:line | Nội dung | Verdict |
|---|---|---|---|---|
| 12 | Submit outbox `task.dispatch` | `submission.ts:338-357` | refs (`taskId/operationId/businessId/version/action/kind/correlationId`) **+ `sourceUrl` + `gate:'ingestion'`** (`:354-355`) | **GAP mới: `sourceUrl` plaintext trong outbox → được dispatcher đẩy nguyên văn vào Redis** (`dispatcher.ts:56`). URL HTTPS không credentials nhưng query string có thể chứa token |
| 13 | Gate 'ready' dispatch | `submission.ts:493-499` | refs + `gate:'ready'` | ✅ không có payload người dùng |
| 14 | Runtime retry re-dispatch | `runtime.ts:631-654` | refs | ✅ |
| 15 | Runtime child spawn dispatch | `runtime.ts:829-849` | refs | ✅ |
| 16 | Runtime recover (lease-expired) | `runtime.ts:1204-1223` | refs | ✅ |
| 17 | Runtime join continuation | `runtime.ts:1490-1504+` | refs (`task.continuation`) | ✅ |
| 18 | HITL resume dispatch | `runtime.ts:1109-1128` | refs | ✅ |
| 19 | Dispatcher → BullMQ | `dispatcher.ts:24-81`, `queue.add(row.type, row.payload, …)` `:56` | payload outbox nguyên văn | ⚠️ phụ thuộc #12; ngoài ra job data = refs (không có input/HITL answer) |
| 20 | Webhook deliveries | `webhooks.ts:76-99` (payload refs: deliveryId/eventType/operationId/state/stateVersion/occurredAt) | refs | ✅ at-rest; wire body plaintext trừ khi per-tenant W-ENC-08 bật (`webhooks.ts:210-223`) — đã thuộc ENC-07 |

### 1.3 Cột/metadata chưa seal (gap hoặc quyết định)

| # | Writer | file:line | Trạng thái | Điều kiện còn hở |
|---|---|---|---|---|
| 21 | `tasks.result_ref` / `operations.result_ref` | `runtime.ts:545`, `:568` | ❌ plaintext | worker-supplied `resultRef` (contracts `z.string()`), **không nằm trong METADATA_SLOTS** — FINDING đã được pin tại `runtime-encryption-metadata.test.ts:603-617`; muốn seal phải thêm slot + migration |
| 22 | `human_waits.input_schema`, `ui_schema`, `context_ref` | `runtime.ts:957-970` | ❌ plaintext | schema/UI có thể chứa nhãn/prompt/giá trị nghiệp vụ; không có slot → chưa seal; cần quyết định contracts |
| 23 | `operations.callback_url`, `connector_bindings`, `submit_artifacts` | `submission.ts:285-318` | ❌ plaintext (refs/config + URL) | callback URL có thể chứa token; snapshot bindings là config platform — quyết định policy (ngoài 4 slot) |
| 24 | `artifacts.file_name` / `mime_type` (+ rows) | `artifacts.ts:159`, `multipart-service.ts:798,1038`, `upload-encryption-gateway.ts:854`, `ingestion-consumer.ts:239-243`, `compat/legacy-public-artifact.ts:52` | ❌ plaintext (tên file có thể nhạy cảm) | content bytes mã hoá chỉ khi `publicUploadEncryption` bật (`server.ts:612-632`); metadata row không seal |
| 25 | `usage_events.payload` | `usage.ts:340-343` (+ `budget-reservations.ts:623`) | ❌ plaintext | event số/đơn giá/ids — business-sensitive, không phải document body; cần quyết định |
| 26 | `admin_audit_events` | `audit.ts:98-112` | ✅ refs (`actor/action/resource`) | không chứa payload; message = `"{action} {resource}"` |

### 1.4 Bytes / temp / log

| # | Chỗ | file:line | Verdict |
|---|---|---|---|
| 27 | URL-ingested source bytes → S3 | `ingestion-storage-s3.ts:64-119` (`PutObject` `:91-100`; không có tầng mã hoá app, không SSE tham số) | ❌ **plaintext at rest trong bucket** khi URL ingestion dùng S3 — gap ENC-05 (recon đã nêu); artifact row chỉ refs |
| 28 | Worker temp workspace | `packages/worker-sdk/src/artifact-streams.ts:121,164-165` (`du-worker-*` trong `os.tmpdir()`), sweep `:208-251` | ⚠️ plaintext workspace theo thiết kế (worker cần plaintext để xử lý); cleanup suite `artifact-streams.test.ts`; chủ sở hữu ENC-04/worker, không thuộc metadataCrypto |
| 29 | Logs (runtime/submission/consumer) | grep `console.` toàn `src/`: chỉ `integrity-scanner.ts:288` (không payload) | ✅ không log payload/input; admin shell log class-only; webhook `last_error` fixed codes (`webhooks.ts:227-243`) |
| 30 | Policy `allowPlaintext` | `runtime.ts:221` (`readStored(..., true)`), `ingestion-consumer.ts:553` | ⚠️ backfill window không deadline — FINDING đã pin `runtime-encryption-metadata.test.ts:1168-1177`; cửa sổ đóng bằng `ENC-09` (chưa xong) |

## 2. Test plan offline (đề xuất — KHÔNG implement)

**Harness chung (đã có tiền lệ):** `jest.mock('pg')` scripted Pool + `createApp` thật + `metadataEncryption` với fake provider reversible + helper `leaksSentinel()` — nguyên mẫu `crx01-creatapp-metadata-seam.test.ts`. Cho queue: `jest.mock('bullmq')` để bắt `Queue.add(name, data, opts)` như mock `pg` (offline, không Redis). App handle đã expose `app.runtime`, `app.dispatcher`, `app.submission` (`runtime.test.ts:340,2478`).

**File đề xuất 1 — `tests/enc-meta-writer-sentinel.functional.test.ts` (mới):** boot createApp + scripted pg, seed sealed rows, drive service thật, quét `state.writes` + captured `Queue.add` + console/stdout.

| Test | Driver (thật) | Steps | Assertion |
|---|---|---|---|
| T1 child spawn | `app.runtime.spawnChildren(...)` | task RUNNING + `c.payloadRef = {doc: SENTINEL}` → gọi spawn | mọi `INSERT INTO tasks` params `payload_ref` + mọi job data đều `leaksSentinel === false`; mở lại parent/child bằng crypto phụ trợ ra đúng giá trị |
| T2 join merge | `app.runtime` join path (child complete → continuation) | 2 child SUCCEEDED, payload parent sealed; chạy join | UPDATE `tasks.payload_ref` mới không chứa sentinel; `open` ra `joinSummary` đúng; outbox chỉ refs |
| T3 HITL | `app.runtime.openWait(...)` + `resumeOperation/answerWait(...)` | wait `uiSchema/contextRef` chứa SENTINEL, answer chứa SENTINEL | (a) FINDING-pin: hiện `ui_schema/context_ref` **có** sentinel trong write (gap #22); (b) `response_ref` + `tasks.payload_ref` resume không có; (c) job data không có |
| T4 checkpoint | `app.runtime.saveCheckpoint(...)` | `outputRef` chứa SENTINEL | `step_checkpoints.output_ref` không sentinel, `open` đúng; `input_hash` giữ nguyên digest |
| T5 outbox/queue tổng | `submit(sourceUrl có ?token=SENTINEL)` + `app.dispatcher.dispatchOnce()` | URL submission | **kỳ vọng RED hôm nay**: `outbox.payload` + `Queue.add` data chứa `sourceUrl` → test này là gap detector cho #12; sau fix phải xanh |
| T6 result_ref | `app.runtime.completeTask(...)` với `resultRef` chứa SENTINEL | complete | FINDING-pin hiện trạng: `result_ref` plaintext (đồng bộ với pin :603-617); đồng thời assert không có sentinel ở các cột khác |
| T7 log scan | submit + resume + complete | capture `console.*` + `process.stdout` (pattern `captureLogs` của `admin-error-boundary-offline.test.ts:131-176`) | không sink nào chứa sentinel; log line chỉ class/correlationId |
| T8 allowPlaintext policy | `claimTask` với row plaintext khi seam ON | như WINDOW 2 | đã phủ ở `runtime-encryption-metadata.test.ts:717-773` — chỉ cần bản createApp nếu muốn khép composition; ghi nhận KHÔNG bắt buộc |

**File đề xuất 2 — `tests/enc-meta-artifact-meta-sentinel.test.ts` (mới):**

| Test | Steps | Assertion |
|---|---|---|
| T9 artifact row metadata | `app.artifacts.create/finalize` với `fileName` chứa SENTINEL (scripted pg bắt `INSERT INTO artifacts`) | FINDING-pin: `file_name` plaintext (gap #24); content-path không bị ảnh hưởng |
| T10 URL-ingest S3 bytes | boot createApp với `artifactStorage: s3` + stub `s3Client.send` (bắt `PutObjectCommand.input.Body`), chạy ingestion consumer `runOnce()` với fetch giả | **kỳ vọng RED hôm nay**: body stream chứa SENTINEL plaintext (gap #27, ENC-05); version/checksum refs đúng; sau khi ENC-05 sửa, test chuyển sang assert ciphertext |
| T11 usage payload | `app.usage.ingest` với event chứa SENTINEL trong field text (nếu schema cho phép) | FINDING-pin: payload plaintext (gap #25) — chỉ để gap hiện diện, không phải khuyến nghị fix trong packet này |

**Nguyên tắc:** T5/T10/T11 là **gap-detector có chủ đích** (viết để đỏ theo hiện trạng, xanh sau khi fix) — nếu reviewer muốn suite xanh tuyệt đối thì tách chúng vào file `enc-meta-gaps-documented.test.ts` gắn nhãn FINDING, theo đúng lối đang dùng ở `runtime-encryption-metadata.test.ts` ("FINDING: …").

**Ước lượng feasibility:** T1–T8 offline 100% (scripted pg + fake provider + mock bullmq); T9 offline (scripted pg); T10 offline với stub S3 (chỉ cần `send` giả — `server.ts:680-684` inject `send`); T11 offline. Không test nào cần PG/Redis/Vault/S3 thật.

## 3. Bảng tổng: writer → seal → gap → test đề xuất

| Writer | file:line | Seal? | Gap | Test đề xuất |
|---|---|---|---|---|
| Submit input_ref/payload_ref | `submission.ts:254-255,285-327` | ✅ | — | đã phủ (crx01-creatapp) |
| Gate READY cả 2 cột | `submission.ts:471-477` | ✅ | allowPlaintext=true khi mở (`ingestion-consumer.ts:553`) | đã phủ (url-ingestion 1429+); policy pin §1.4 #30 |
| Child payload | `runtime.ts:811-824` | ✅ | chưa có test | T1 |
| Parent continuation | `runtime.ts:852-860` | ✅ | chưa có test | T1 |
| Join merge | `runtime.ts:1474-1489` | ✅ | chưa có test | T2 |
| HITL response | `runtime.ts:1073-1081` | ✅ | chưa có test | T3 |
| HITL resume payload | `runtime.ts:1100-1107` | ✅ | chưa có test | T3 |
| HITL schema/ui/context | `runtime.ts:957-970` | ❌ | không có slot | T3(a) gap-pin |
| Checkpoint output | `runtime.ts:463-477` | ✅ | chưa có test | T4 |
| Outbox submit (sourceUrl) | `submission.ts:338-357` | ⚠️ refs + **sourceUrl** | URL plaintext trong outbox/Redis | T5 (RED hôm nay) |
| Outbox khác (retry/child/recover/join/resume/ready) | runtime.ts:635,831,1205,1491,1110; submission.ts:493 | ✅ refs | — | T5 quét tổng |
| Queue BullMQ | `dispatcher.ts:56` | ⚠️ = outbox | job data chứa sourceUrl theo #12 | T5 |
| result_ref | `runtime.ts:545,568` | ❌ | không slot; FINDING đã pin | T6 |
| Artifact refs (fileName/mime) | `artifacts.ts:159` + 4 chỗ khác | ❌ | policy quyết định | T9 |
| URL-ingest S3 bytes | `ingestion-storage-s3.ts:91-100` | ❌ | ENC-05 | T10 (RED hôm nay) |
| usage_events.payload | `usage.ts:340` | ❌ | policy quyết định | T11 |
| webhook_deliveries.payload | `webhooks.ts:87-92` | ✅ refs | wire plaintext tới khi W-ENC-08 bật | đã có suite W-ENC-08 (ENC-07) |
| Audit | `audit.ts:100` | ✅ refs | — | không cần |
| Logs | toàn src | ✅ | — | T7 (regression scan) |
| Worker temp | `worker-sdk/artifact-streams.ts:164` | ⚠️ by design | ENC-04/worker | worker suite hiện có |

## 4. Phần cần live (không chứng minh được offline)

- **S3**: byte-scan object URL-ingested thật (versioning + checksum) và object artifact khi encryption bật; ENC-05 acceptance.
- **Redis**: scan job data thật (BullMQ key space) sau `dispatchOnce` trên Redis thật — offline chỉ chứng minh được data đưa vào `queue.add`, không chứng minh Redis không có bản sao khác.
- **PG**: row-scan `input_ref/payload_ref/human_waits/step_checkpoints/result_ref` trên DB thật sau chuỗi submit→child→join→HITL→checkpoint (byte + `pg_dump` scan).
- **Vault thật**: outage/wrong-key live ở các writer (offline đã giả lập); rotation/rewrap.
- **Worker temp**: scan `os.tmpdir()` trên worker thật trong/sau khi task chạy (cleanup + nội dung).
- **Webhook wire**: W-ENC-08 policy on/off với key registry thật (đã thuộc ENC-07/08).

## 5. Gaps / không làm

- **Không sửa file nào** (source/tests); chỉ ghi receipt. Không tick gate; không commit; không chạy live service; không chạy full suite (chỉ đọc source + test hiện có làm bằng chứng cấu trúc).
- **Hai phát hiện mới cần coordinator xử lý:** (a) `sourceUrl` plaintext trong outbox/queue payload (`submission.ts:355`); (b) `human_waits.ui_schema/context_ref` + `result_ref` không có slot — cần quyết định contracts/migration. (b) phần lớn đã được pin ở FINDING tests, (a) thì chưa thấy test nào.
- Test plan §2 **chưa implement** đúng yêu cầu; file/đường dẫn là đề xuất.
