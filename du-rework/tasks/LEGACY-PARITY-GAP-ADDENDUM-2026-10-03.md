# Legacy parity gap addendum — 2026-10-03

> **Checkpoint 730 / scope mới 2026-10-04:** [review 730](../coordination/reports/plan-review-730-2026-10-04.md) giữ LPG-01 tenant/ENC/ref-lifecycle decision hold và LPG-02 SDK claim-loop collision với W1b. Read-only decision prep có thể làm ngay theo P730-LPG-DECISION; implementation cần coordinator cấp lease sau register/WTV checkpoint, không tự dỡ hold. [CFGADM-03/04](ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md) yêu cầu S3/config/stats/cleanup UI đủ chức năng cũ; artifact ref eligibility thuộc DATA/retention dù chưa chọn content dedup. Không duplicate row hay tick parent.

> **Checkpoint 735 → 736–740:** [refresh receipt](../coordination/reports/plan-refresh-736-740-2026-10-04.md) giữ ORCH-LPG-01 tenant/ENC/ref-lifecycle decisions và ORCH-LPG-02 claim-loop collision với SDK-CONSUME. P730-LPG-DECISION chưa dispatch; prep decision vectors có thể mở theo lease, implementation chờ register/WTV checkpoint và exact release. WTV-07 commit/push vẫn mở, ngoài doc-only scope; producer audit/merge-fix không giải quyết các holds này. Late W2-B P2 ref mismatch và CLOSURE offline evidence ưu tiên trong 736, không tự mở LPG decisions/SDK claim-loop lease.

> **Lịch sử checkpoint 740 / 741–745 (superseded bởi checkpoint 745):** [refresh mới](../coordination/reports/plan-refresh-741-745-2026-10-04.md) fold (b) MET, DD-05/P2-FIX→W1c và SDK-CONSUME disjoint. Các điều kiện đó không mở LPG tenant/ENC/ref lifecycle decisions hoặc claim-loop lease; CONT/user window/WTV-07 còn hold. L2 target refs đã verified FIXED; residual parent-doc sweep ngoài scope không là gate source.

> **Lịch sử checkpoint 745 / 746–750 (superseded bởi checkpoint 750):** [refresh mới](../coordination/reports/plan-refresh-746-750-2026-10-04.md) ghi L2 CLOSED độc lập trên toàn suite, không còn parent sweep backlog. SDK-CONSUME in-flight; prompt producer/session follow-up không mở ORCH-LPG-02 claim-loop writer. P2-FIX còn stream-issue, W3 Δ7(A)/Δ8/Δ10 đã grant nhưng không thay LPG tenant/ENC/ref-lifecycle decisions, register/WTV checkpoint hoặc exact release. Read-only LPG decision prep được đề xuất nếu coordinator cấp packet; content dedup strategy không tự chọn. CONT/live/qwen_4 security/Δ-DEV-03 giữ user gates; WTV-07 commit/push ngoài doc-only scope.

> **Lịch sử checkpoint 750 / 751–755 (superseded bởi update 763):** [receipt 750](../coordination/reports/plan-chkpt-750-2026-10-04.md) fold VFY-REFRESH docs VERIFIED/L2 CLOSED, P2 đã reassign qwen_4 đang chạy, SDK/W3/MEDIUM-1 in-flight. Không mở ORCH-LPG-02 claim-loop trong SDK-CONSUME, không chọn tenant/ENC/ref lifecycle/content dedup strategy; register/WTV + named lease vẫn prerequisite. Sáu P745 carry-forward giữ hold-list; CONT/live/qwen_4 security/Δ-DEV-03 user gates và WTV-07 commit/push ngoài doc-only giữ nguyên.

> **Lịch sử update763 / superseded bởi update770:** [receipt](../coordination/reports/plan-update-763-2026-10-04.md) ghi HARD (1) CLOSED, W3/W1c offline APPROVED/ticked theo coordinator, VERIFY sets CONFIRMED; marker0030 step1 DONE và PC AW-C không mở LPG tenant/ENC/ref-lifecycle/dedup decisions hoặc SDK claim-loop lease. Composition/UI keys dispatched nhưng full runtime/config/live/browser/CONT required còn riêng. Commit plan c1→c6 giữ owner/hunk exclusions, WTV-07 còn hold; không tự commit/push hoặc tick parent LPG.

> **Update 800 (current):** [receipt](../coordination/reports/plan-update-800-2026-10-05.md) giữ L2 CLOSED, LPG tenant/ENC/ref-lifecycle/dedup/claim-loop decisions và WTV-07 holds. COMMIT-PLAN-PREP READY (chờ user go) và RCR fixes (RCR-HTTP/RCR-RUNTIME đang chạy) **không mở LPG lease**; TICK-PROPOSAL-2 chỉ đề xuất P763 offline-leg (chưa tick); RPK-00..21 DEFERRED **không** là prerequisite/giải phóng cho LPG. doc-only không commit/tick.

> **Lịch sử update795 / superseded bởi update800:** [receipt](../coordination/reports/plan-update-795-2026-10-05.md) giữ L2 CLOSED, LPG tenant/ENC/ref-lifecycle/dedup/claim-loop decisions và WTV-07 holds. T-PROM-02 offline CLOSED (carrier B2 AW-C) không mở LPG lease; CW-B UI/backend landed + CREDWORKFLOW writer/compose landed không đổi tenant/ENC/ref-lifecycle decisions; MEDIUM-2 bump defer thuộc commit plan 1→6; commit baseline 1→6 + follow-up atomic vẫn cần owner checks, doc-only không commit/tick.

> **Lịch sử update780 / superseded bởi update795:** [receipt](../coordination/reports/plan-update-780-2026-10-05.md) giữ L2 CLOSED, LPG tenant/ENC/ref-lifecycle/dedup/claim-loop decisions và WTV-07 holds. Carrier AW-C + CAPFIX + VERIFY-CAPFIX PASSED và B2 in-flight không mở LPG lease; CW-A backend + SESSION-LEG (provider-session semantics mở) giữ ngoài LPG scope; commit baseline1→6 + follow-up atomic vẫn cần owner checks, doc-only không commit/tick.

> **Lịch sử update770 / superseded bởi update780:** [receipt](../coordination/reports/plan-update-770-2026-10-04.md) giữ L2 CLOSED, LPG tenant/ENC/ref-lifecycle/dedup/claim-loop decisions và WTV-07 holds. Carrier Form A adjudications SPECIFIED/A running, roster13 đổi owner membership, session/parameters/connector packets chạy không mở broad LPG lease. W3/W1C-PC/COMPOSITION verifies PASSED và UI-KEYS scoped UI_APPROVED không đóng full live/browser/config/CONT; commit baseline1→6 + follow-up atomic A/B cần owner checks, doc-only không commit/tick.

**Trạng thái:** `SPECIFIED`, chưa dispatch, chưa `IMPLEMENTED`/`VERIFIED`/`ACCEPTED`.
Addendum của [ORCH-PAR-00..10](ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md),
[ORCH-PAR-11..17](ORCHESTRATOR-CONFIG-PROFILE-CONNECTOR-DETAIL-2026-10-02.md) và
[PAR-XA-01..05](ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md), sinh từ packet
`legacy-parity-gap-supplement` (dispatch 2026-10-03T23:02+07:00, receipt
`coordination/reports/legacy-parity-gap-supplement-2026-10-03.md`). Không tạo gate mới,
không tick parent, không sửa row hiện có. Các gate `G-SEC`, `G-DATA`, `G-ENC`, `G-COMP`,
`G-ADMIN-OPS`, `G-LOCAL-ADMIN`, `G6` giữ **NO-GO**. Cần coordinator cấp file-lease +
[CC] `APPROVED` trước khi tick `[x]`.

**Dedupe đã thực hiện trước khi ghi row:** đối chiếu
`coordination/reports/plan-open-task-register-2026-10-03.md` (37 file / 237 row mở) và grep
toàn bộ `du-rework/tasks/` + `du-rework/services/orchestrator/src` + `du-rework/packages/worker-sdk/src`.
Mỗi row dưới đây kèm câu chứng minh không trùng. ID prefix `LPG-` không va chạm row nào hiện có
(kiểm chứng grep `LPG-\d` = 0 match; `GAP-11` thuộc architecture doc register, namespace khác).

## ORCH-LPG-01 — Content-hash dedup cho file bytes (FileCache parity) `[ ]`

**Legacy (cũ):** `lib/storage/dedup.ts:21-81` — `dedup(md5, s3Key, ...)`: upsert atomic trên
unique `fileCaches.md5Hash` (`onConflictDoUpdate`: `refCount+1`, `lastAccessedAt=now`) `:31-43`;
nếu canonical `s3Key` khác key vừa upload: `backend.exists(canonical)` → xóa upload trùng, trả
canonical `:46-52`; canonical object mất → adopt upload mới làm canonical `:53-55`; fallback khi
unique-violation race `:59-78`. Callers: `lib/upload-helper.ts:52` (mọi upload) và
`lib/file-url-downloader.ts:256` (file tải từ URL). Model `FileCache` (md5Hash unique, s3Key,
size, refCount, lastAccessedAt) + cleanup tương tác `lib/cleanup.ts` (`cleanupExpiredCache`) với
`s3_cache_ttl_hours=168` (`lib/settings.ts:108`): entry hết TTL chỉ bị xóa khi không còn tham chiếu.
**Gap:** rework không có content dedup nào cho artifact bytes — grep `services/orchestrator/src`
và `packages/worker-sdk/src` chỉ thấy idempotency-key/queue/usage dedup (khác concern); artifact
upload/finalize/multipart đều ghi object mới, không tra content-hash.
**Dedupe:** grep register + `tasks/` cho `filecache|refcount|content-hash|content.address|dedup` →
0 row plan nào phủ capability này (các hit đều là idempotency/queue/webhook dedup).
**Quyết định bắt buộc (không tự quyết ở đây):**
(i) **tenant scope** — legacy dedup là GLOBAL: cùng md5 bất kể tenant ⇒ cross-tenant existence
oracle (biết md5 file của nạn nhân → chứng minh họ từng upload). Rework multi-tenant phải chọn:
dedup per-tenant (an toàn, ít tiết kiệm), shared pool có policy, hoặc no-dedup (retire capability);
(ii) **encryption-at-rest** — ciphertext không dedup được theo key; plaintext md5 lộ content
equality ⇒ cần quyết định keyed/convergent hash gắn với ENC, hoặc chấp nhận dedup chỉ ở chế độ
không mã hóa;
(iii) **lifecycle** — refCount phải tăng/giảm transactional theo artifact lifecycle và khóa với
retention "không xóa artifact còn tham chiếu" (ORCH-PAR-06/17, DATA-02): refCount có thể chính là cơ
chế reference tracking retention cần.
**Acceptance:** hash (md5 hoặc keyed-hash theo quyết định ENC) tính streamed/bounded tại upload
gateway; upsert atomic + adopt canonical đúng race; upload trùng không double-store; refCount
đồng bộ transaction với create/delete artifact; retention không xóa canonical còn ref>0; policy
cross-tenant theo decision (i); hành vi theo encryption mode theo decision (ii) được test cả hai
chiều. Test: upload trùng đồng thởi (race), canonical orphan → adopt, retention với ref sống,
foreign-tenant không đọc được existence khi policy per-tenant.
Parent: `ORCH-PAR-00` register; `DATA-02`/retention; `ENC` (keyed-hash decision); ART upload gateway.

## ORCH-LPG-02 — Worker memory backpressure (pause/resume claim theo heap ratio) `[ ]`

**Legacy (cũ):** `worker.ts:122-141` — monitor định kỳ: `MEMORY_THRESHOLD =
parseFloat(env WORKER_MEMORY_THRESHOLD || '0.90')` `:124`, ratio = `heapUsed/heap_size_limit`;
ratio > threshold → `pause()` cả pipeline và substep worker `:131-135`; ratio ≤ threshold×0.85
(hysteresis chống flap) → `resume()` `:136-140`. Worker pause = ngừng nhận job mới, job đang chạy
vẫn hoàn tất. Bối cảnh: concurrency 5 pipeline / 10 substep (`worker.ts:32,34`,
`WORKER_CONCURRENCY`), stalled 30s/maxStalledCount 2 `:68-69,:81-82`.
**Gap:** rework Worker SDK chỉ có bounded streaming per-artifact (`artifact-streams.ts:31-38`,
`fan-out.ts`, `artifact-multipart.ts:93` part cap) — giới memory theo TỪNG stream, không có cơ chế
nào phanh CLAIM khi tổng heap process vượt ngưỡng. `P8-release-readiness.md:68` là triage
runbook thủ công (OPS-02), RFX-08 là bound RSS đường decrypt, FULL-REWORK:133 là CPU guard
business worker — không cái nào là automated queue-consumption brake.
**Dedupe:** grep register + `tasks/` cho `heap|memory|backpressure|pause.*resume|WORKER_MEMORY` →
chỉ triage thủ công + bounded streaming; không row nào phủ cơ chế tự động.
**Thiết kế gợi ý:** pause = dừng claim mới (tương đương BullMQ `worker.pause()` hoặc cờ local ở
claim loop), task in-flight tiếp tục + heartbeat giữ lease (pause KHÔNG được gây lease loss);
resume có hysteresis (mặc định ×0.85 như legacy); threshold env-tunable, giá trị lạ clamp
fail-closed; quyết định local per-process (claim đã atomic, không cần coordination fleet);
metric + structured log + alert surface cho MON.
**Acceptance:** inject memory pressure (handler cấp phát lớn): worker ngừng claim mới trên
threshold, task in-flight hoàn tất và heartbeat/lease không mất, resume trong band hysteresis,
không flap (đếm số lần chuyển trạng thái có trần), threshold sai cấu hình bị clamp; metric/log
đủ cho MON-01..04. Offline synthetic pressure + soak trong live window P8.
Parent: `P8` (OPS-02), MON-01..04, `P4` worker-sdk.

## Ghi chú detail (fold vào acceptance row hiện có, KHÔNG phải row mới)

1. `.docm` macro rejection với thông báo rõ (`lib/upload.ts:31-36,82-84`, E06) — fold vào
   `ORCH-PAR-12` (`allowedFileExtensions`): acceptance cần nêu macro-enabled formats bị từ chối với
   lý do tường minh, không chỉ "extension không thuộc allowlist".
2. NFD→NFC filename normalization (`lib/upload.ts:112-114`, E07, tên file tiếng Việt) — fold vào
   acceptance multipart của COMP (`API-COMPAT-DUGATE-2026-09-28.md:105` streaming multipart row).
3. `WORKER_CONCURRENCY` + stalled 30s/maxStalledCount 2 (`worker.ts:32,34,68-69,81-82`) — capability
   đã có ở rework runtime (concurrency config + expired-lease sweep P2-09); chỉ ghi nhận mapping,
   không row.
4. CLAUDE.md "First Run /setup" — không có `app/setup` trong legacy tree (doc stale); bootstrap
   admin đầu tiên của rework là CLI one-time (`LOCAL-01`), đây là replacement có chủ ý, không gap.

## Thứ tự + đóng

1. Hai row đều cần `ORCH-PAR-00` ký register trước (cutover-required hay post-cutover) — đặc biệt
   LPG-01 có 3 decision point (tenant scope, ENC interplay, lifecycle) phải chốt bằng ADR/decision
   row trước implementation.
2. LPG-02 không chặn cutover wire nhưng chặn production readiness (fleet OOM dưới tải) — xếp cùng
   cụm P8 acceptance.
3. Mỗi task: test đi cùng implementation (command, cwd, exit code, raw log); LPG-01 chạm
   storage/migration/ENC ⇒ cần live PG/S3 + [CC] review; LPG-02 chạm worker runtime ⇒ cần soak
   evidence. Không tick parent từ focused smoke.
