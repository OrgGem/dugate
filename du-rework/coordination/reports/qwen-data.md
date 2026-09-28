# Lane Qwen-DATA — receipt ledger (du-rework)

## RESUME POINT

- **Packet gần nhất**: W-DATA03-INGESTION-WIRING-1 (Δ17 tầng SDK: `createIngestionTaskHandler` — acquire → `materializeArtifact` port → `artifactId` → receipt gate-ready; 24 pin mới, CF đỏ đúng 4+2 test, packet cmd ×3 84/84 exit 0; lane tự phát hiện + nâng 4 pin SSRF cũ từ scheme-gate lên fence-layer; Δ19 mới: packet-vs-contract terminology) — IMPLEMENTED / VERIFIED-OFFLINE, Mục 9. Trước đó: W-DATA04-STREAM-BOUNDS-1 ở Mục 8 (bounds đọc + `RequestScope.abort()` guard `readableEnded`, 27 test pin), W-DATA01-S3-FACADE-1 ở Mục 7 (đóng Δ14 tầng envelope `IngestionReceipt`), W-DATA03-ACQ-1 vòng 2 ở Mục 6, W-DATA-STATUS-S3-1 ở Mục 5, W-DOC-ISOLATE-1 ở Mục 4, W-DATA04-STREAM-1 ở Mục 3, W-DATA03-ACQ-1 ở Mục 2, W-DATA02-PUB-2 ở Mục 1.
- **Kết luận 4 mức**: (a) **W-DOC-ISOLATE-1 = ACCEPTED** ở phạm vi offline isolation (Reviewer Turn 60 + Tester T-CODEX-TEST-17; ledger đã ghi vào `tasks/README.md`, lane chạy đối chứng lại 42 suite / 506 test / exit 0). (b) **DATA-02 [~]** — public live chưa có receipt; kịch bản 15 bước đã sẵn sàng trong `docs/runbooks/data-02-public-uploads-live.md`, **chưa chạy** (cần cửa sổ Tester). (c) **DATA-03 [~]** — client + server admission offline đã có, live acquisition→S3→READY chưa (Scenario B 7 bước đã chuẩn bị). (d) **DATA-04 [~]** — route public binary 1 MiB-64 MiB chưa có, §6 chưa ký, Δ8/Δ9 mở; bounds đọc + wire-abort read-path đã pin ở Mục 8 (worker-sdk 17 suites/272 tests). (e) `G-DATA`/`G6` NO-GO như audit.
- **Việc còn lại của lane**: PARKED — chờ packet tiếp. Follow-ons đã ghi, không tự mở: (1) Δ11 — facade S3 `catch {}` gom mọi lỗi về 503, mất tên lỗi (owner Orchestrator/DATA); (2) Δ12 — `data-02-04-live-s3.test.ts` không nằm trong `liveSuites` của jest.unit.config, nên thêm file live sẽ làm lệch aggregate 58/15-skipped của các receipt khác; (3) Δ13 — không có MinIO/S3 trong `infra/docker-compose.yml` → môi trường live không tái lập được từ repo; (4) Δ5/Δ6/Δ7/Δ9/Δ10 giữ nguyên.
- **Bài học đo lường của lane (đừng lặp)**: (i) Mục 4.2 — `testPathIgnorePatterns` lọc SAU khi match, và cờ array của yargs nuốt positional đứng ngay sau nó → cờ phải đặt SAU positional. (ii) Mục 5.5 — đã từng kết luận "0 route binary" chỉ vì grep literal `binary: true`; thực tế `server.ts:415-420` truyền biến `isBlobPut`. **Không quy kết hành vi từ một grep literal.** (iii) Mục 3.5 — đừng khẳng định suite của package khác "không đổi" khi chưa chạy.
- **Sửa regression của chính cycle DATA-03** (Mục 3.5): `tests/build-dependency-order.test.ts` đã vá fixture, 8/8 ×3.
- **Trạng thái DATA-03 sau Mục 7**: ba chân đã có — admission + READY gate (orchestrator), **producer leg** (`createSourceAcquisitionIngestor`, worker-sdk), và **envelope hợp đồng** (contracts `IngestionReceiptSchema` + `withIngestionSource`/`resolveIngestionSource`; `markIngestionReady` ghi envelope đồng nhất hai hàng; document-core validate pin, resolve `artifactId` thành `artifactIds`, binding `SOURCE_PIN_MISMATCH`, fail-visible `INGESTION_SOURCE_UNRESOLVED`). **Δ14 ĐÃ ĐÓNG ở tầng envelope.** **Vẫn [~]**: Δ17 đã được xử lý ở **tầng SDK** (Mục 9 — `createIngestionTaskHandler`: acquire→materialize port→`artifactId`→gate-ready, 24 pin offline, adapter shape khuyến nghị tại 9.2); còn mở: (i) caller cho `processIngestionTask` ở composition root orchestrator, (ii) DB adapter materialize, (iii) live acquisition -> S3 -> READY (Scenario B, runbook Mục 5).
- **Δ mới cần adjudicate (cycle 7)**: Δ17 (owner Orchestrator/DATA — ingestion consumer: gọi acquirer + materialize artifacts row READY + set `artifactId` trên receipt trước `markIngestionReady`), Δ18 (envelope READY không mang `sourceUrl` provenance — quyết định contract nếu coordinator thấy cần). Đã đóng: **Δ14** (Mục 7, tầng envelope). Còn mở từ cycle 6: Δ15 (`p8-03` connect PG :5433 thật trái comment dòng 17), Δ16 (aggregate 42-suite có 2 suite chạm live; **đối soát**: từ HEAD này doc-core là 43 suites / 520 tests do packet Mục 7 thêm suite đúng phạm vi — ghi để tránh "regression ảo").
- **Δ mới cần adjudicate (cycle 9)**: Δ19 (packet §1 dùng thuật ngữ plan-cũ `byteLength`/`storageRef`/`mimeType` trong khi canonical `IngestionReceiptSchema` là `sizeBytes`/`storageKey`+`versionId`/không-mimeType, `.strict()`; lane không đụng contract — xem 9.5). Δ17 cập nhật trạng thái: SDK-layer landed (Mục 9), remaining owner Orchestrator (composition + DB adapter) rồi Tester (live). Δ16''' đối soát worker-sdk: 17 suites/**296** = 272 (Mục 8) + 24 test mới; KHÔNG phải regression ảo. Δ6 có bằng chứng mới (D6 Mục 9.4): boundary suite đỏ 3/3 full-run (3 test khác nhau) + 1/3 cô lập, budget 500/400ms, RSS âm trong run F3 — flake máy fleet chung, không thuộc code cycle này chạm.
- **Blocker**: không có với phạm vi offline. Cửa live PG/S3 thuộc Tester theo lịch CLAIM/RELEASE; lane chỉ chuẩn bị kịch bản, không tự mở.

---

## 1 — PACKET W-DATA02-PUB-2: review submit guard + sweeper wiring, verify offline x3

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Phạm vi sửa được phép**: services/orchestrator/src/modules/artifacts/ + src/server.ts. **Thực tế sửa**: không file nào — "git status --porcelain" trên hai scope path chỉ hiện trạng cũ do lane W-DATA02-PUB-1 để lại ("M server.ts", "?? modules/artifacts/"), không đụng tới. Không commit/push/reset. Không mở DB/Redis/S3 live.

### 1.1 Rà soát — hành vi yêu cầu và bằng chứng tĩnh

**(a) Submit guard: chỉ hoàn tất khi READY, từ chối STAGING.** ĐẠT, đã có sẵn:

- Guard: modules/operations/submission.ts "assertReadyTenantArtifacts" (dòng 282–301). Lookup tenant-scoped FOR SHARE (dòng 271–274); unknown/foreign/expired/EXPIRED/DELETED → 404 NOT_FOUND (không lộ sự tồn tại); mọi state khác READY → 409 STATE_CONFLICT "all submitted artifacts must be READY" (dòng 297–299). Gọi 2 lần: preflight (dòng 89) và re-check trong tx (dòng 160), nên artifact không thể expire/chuyển state giữa validate và commit.
- Edge STAGING→READY phía public: modules/artifacts/multipart-service.ts "publicComplete" — UPDATE chỉ commit state='READY' với WHERE ... state='STAGING' AND storage_version_id IS NULL (dòng 1054–1058), sau khi bytes được kiểm chứng ("publishVerifiedBytes": ListParts đối chiếu ledger khai báo + re-hash toàn object). Nhánh replay chạy TRƯỚC gate liveness (dòng 1030–1039): lost response replay được cả sau TTL trên bản đã READY — đúng invariant finalize-replay của plan.
- Route public server.ts dòng 892–924: x-api-key + tenant fence (tenantId lấy từ resolveApiKey, không phải client khai); replay key = body uploadToken hoặc Idempotency-Key header derive per-tenant ("publicUploadToken", multipart-service.ts dòng 82–92); presigned part URL không log.
- Pin offline trực tiếp: tests/artifact-submit-guards.test.ts — "rejects an artifact that has not been finalized from STAGING" (409), foreign → 404, expired-READY → 404, base64 over budget → 413 trước mọi query (5 test).

**(b) Sweeper định kỳ dọn part/staging quá hạn, cả hai nhánh.** ĐẠT, đã có sẵn:

- Quét: "sweepExpiredSessions" (multipart-service.ts dòng 864–905). SELECT không lọc task_id → phủ runtime + public: state='STAGING' AND multipart_expires_at <= now (claim ABORTED, abort_reason='expired' dưới lock riêng) và state='ABORTED' AND multipart_upload_id IS NOT NULL (crash giữa mark-và-purge được dọn nốt). Purge = abortMultipartUpload phía provider + delete version đã pin nếu có; multipart_upload_id chỉ NULL hóa khi purge sạch (dòng 1138–1157). Limit 1..1000/tick, ORDER BY multipart_expires_at.
- Gắn lịch: server.ts "createMultipartSweepHook" (dòng 2167–2183): single-flight (tick chồng bị SKIP, không stack), nuốt lỗi storage (tick sau retry, không poison lease-recovery), enabled=Boolean(s3StorageFacade) — deployment không có backend multipart không bao giờ gọi service; nối vào recovery setInterval production cadence (dòng 558–568) cùng timer với lease-recovery + MM-05. Test seam runMultipartSweep export qua handle (dòng 520–522).
- Row READY không bao giờ bị đụng qua cửa sweep/abort: "publicAbort" từ chối state khác STAGING (dòng 1093–1095); sweep chỉ chọn STAGING/ABORTED.

### 1.2 Bằng chứng chạy (offline)

Lệnh packet (§3), chạy 3 lần liên tiếp tại cwd D:\Git\dugate\du-rework:

    pnpm --filter @du/orchestrator test -- tests/multipart-routes-offline.test.ts tests/multipart-service-offline.test.ts

| Lần | jest output (nguyên văn) | Exit Code: (wrapper) |
|---|---|---|
| 1 | Test Suites: 2 passed, 2 total / Tests: 82 passed, 82 total (service 10.96s; routes 5.21s; total 16.41s) | Exit Code: 0 |
| 2 | Test Suites: 2 passed, 2 total / Tests: 82 passed, 82 total | Exit Code: 0 |
| 3 | Test Suites: 2 passed, 2 total / Tests: 82 passed, 82 total | Exit Code: 0 |

Đếm từng suite (cùng ngày, phục vụ đối chiếu): routes-offline "Tests: 30 passed, 30 total" (Exit Code: 0); service-offline "Tests: 52 passed, 52 total" (Exit Code: 0). Guard-pin artifact-submit-guards.test.ts "Tests: 5 passed, 5 total" (Exit Code: 0). Typecheck "pnpm --filter @du/orchestrator lint" (tsc --noEmit): Exit Code: 0.

**Định nghĩa win/lose của packet**: PASS = 2 suite chỉ định xanh, exit 0 cả 3 lần + lint 0. Đạt. Không chạy full-sweep package: nhiều lane đang đông chai trên cùng checkout (tiền lệ targeted của W-DATA02-PUB-1). data-02-04-live-s3.test.ts KHÔNG chạy (gate live, thuộc Tester window) — chỉ xác nhận tĩnh pin stagingSubmit=409 tại dòng 446–448.

### 1.3 Cấu trúc 2 suite chỉ định (82 test, theo describe)

- routes-offline (30): runtime init; runtime part+complete+abort; public init (x-api-key, tenant fence, Idempotency-Key); public part+complete+abort; createMultipartSweepHook wiring; multipartLimitsFromEnv (§6 env naming đã ký).
- service-offline (52): init; part grant; complete; abort; orphan sweep (runtime); public uploads init (replay, foreign-tenant, cap, no-backend, header-key); public grant+complete+abort (READY edge, replay sau TTL, READY không abort được); public uploads sweep coverage (net chung hai nhánh); complete body vs ingress JSON cap.

## Δ-DEVIATION (chờ coordinator adjudicate — lane KHÔNG tự sửa)

- **Δ5 — ledger artifact_multipart_parts của row terminal không bị sweep xóa.** Sau purge, provider parts (bytes S3) đã được release và multipart_upload_id NULL hóa, nhưng các dòng ledger khai báo vẫn nằm lại PG vô hạn (FK ON DELETE CASCADE chỉ fire khi artifacts row bị xóa, mà row ABORTED được giữ lại có chủ đích — comment migration 0015: part_count định danh nhánh multipart). Hệ quả: metadata-only, bounded theo số session đã abort, không có đường wire nào đọc lại chúng. Nếu câu "dọn dẹp các part" trong packet được hiểu gồm cả xóa ledger, bản sửa nằm trong sweepExpiredSessions (đúng scope artifacts/) nhưng BUỘC cập nhật tests/fixtures/multipart-offline-harness.ts (ngoài scope packet; file test đang có lane khác chạm) → lane không tự làm; ghi để adjudicate.
- Không có lệch nào khác so với packet: mọi mục §2 đều ĐẠT mà không cần sửa code.

## Kết luận cycle

- Trạng thái khai báo: **VERIFIED-OFFLINE (review, 0 diff)** cho §1–§3 packet. **KHÔNG** ACCEPTED — DATA-02 giữ [~]: public live chưa có receipt gọi /api/v1/uploads, Δ1–Δ3 (qwen5r.md) chờ adjudicate, Δ5 mới mở ở trên.
- Khuyến nghị: /compress trước packet kế tiếp.


---

## 2 — PACKET W-DATA03-ACQ-1: bounded URL acquisition client (worker-sdk) — IMPLEMENTED / VERIFIED-OFFLINE

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Phạm vi đã sửa**: packages/worker-sdk/ (src + tests + package.json). **Không sửa**: document-core/, orchestrator/, Admin/OIDC/Vault. Không commit/push. Không DB/Redis/S3 live. Toàn bộ evidence offline (127.0.0.1 port trong quiet band, không system DNS, không globalThis.fetch monkeypatch).

### 2.1 Rà soát — hiện trạng trước khi code

- **@du/egress** (packages/egress/src/pinned-fetch.ts) đã có lớp enforcement: MỘT lần DNS resolve dùng chung cho adjudication + socket (chặn rebinding TOCTOU), deny-before-connect theo ip-policy của @du/contracts (private/loopback/link-local/metadata/CGNAT/multicast), adjudicate từng 3xx hop (CYCLE-103), timeout/abort phá socket. NHƯNG egress KHÔNG bao giờ follow redirect; scheme http vẫn được; không có budget byte/thời gian; không verify hash.
- **worker-sdk artifact-streams.ts**: downloadArtifact/openArtifactStream đã bounded + hash-verified + xóa partial file, nhưng dành cho GRANT URL của storage, redirect mặc định refuse / "follow" không giới hạn, fetcher mặc định globalThis.fetch — không có lớp SSRF nào nếu không inject.
- **document-core**: IngestAction.prepareSources chỉ đọc artifactIds (src/actions/ingest/index.ts dòng 29-47) — KHÔNG có đường URL; đúng thiết kế plan (URL phải thành READY artifact trước khi parse; retry đọc bản đã pin). → KHÔNG sửa pipelines/.
- **orchestrator**: không có URL ingest task/202/READY gate (grep src: 0 hit sourceUrl/acquisition) — phần server của DATA-03 cần packet riêng, ngoài scope packet này.

### 2.2 Đã triển khai (worker-sdk)

- **src/source-acquisition.ts (mới, 391 dòng)**:
  - SourceAcquisitionError + 12 code (dòng 66); defaults maxRedirects=3, timeout=60s, idle=10s (78-82) — SDK-side policy, caller siết được.
  - validateTarget (132): https-only trừ khi allowHttp (seam allowlist scheme của plan); chặn userinfo ở MỌI hop (vector class FIX-CR-01); parse fail-closed.
  - acquireSourceUrl (179): fetcher MẶC ĐỊNH = createPinnedFetch() của @du/egress (SSRF fence không cần opt-in); hop loop bounded (mỗi hop re-validate + fetch lại → egress re-adjudicate + re-resolve, không kế thừa answer của hop trước); Content-Length pre-check; counter transform giữ cap maxBytes trên byte ĐÃ GIẢI NÉN (cả egress và undici đều tự giải nén → cap cũng chặn zip bomb) + SHA-256 luôn stream; idle watchdog (timer rearm mỗi chunk, khi fire destroy source+counter CÙNG một error để pipeline reject tất định); deadline toàn bộ qua createRequestScope (FIX-CR-08: resolve→connect→header→body→verify); MỌI lỗi đều xóa file partial (fail-closed, parse sau không thấy bytes dở).
  - mapFetchError (376): DestinationDeniedError→403 DESTINATION_DENIED; timedOut→408; abort→TRANSPORT; errno letters dạng ETIMEDOUT chỉ để chẩn đoán; message KHÔNG chứa URL (không lộ signed URL/query token).
- **src/index.ts**: export acquireSourceUrl + types qua barrel. **package.json**: + "@du/egress": "workspace:*" (link bằng pnpm install; @du/egress đã đứng TRƯỚC worker-sdk trong build order nên build-dependency-order của document-core không đổi).
- **tests/source-acquisition.test.ts (mới, 516 dòng, 40 test)** — 3 lớp bằng chứng: (1) policy qua fetcher giả, zero socket; (2) **default egress** chặn trước connect: loopback, dạng thập phân 2130706433, metadata 169.254.169.254, RFC1918, ::1, ULA fd00::, CGNAT 100.64/10, và hostname resolve-seam→loopback (vector rebinding); (3) end-to-end qua egress thật + listener loopback: happy path (hash đúng, đúng 1 request), 3xx hop thật, cap mid-stream cắt wire, IDLE stall, TIMEOUT, reset giữa body. 7 test hop-to-metadata: egress deny hop hoặc socket-teardown race → đều fail-closed, không file. Mọi loser xác nhận workspace rỗng (không partial file).

### 2.3 Guard → bằng chứng

| Guard packet yêu cầu | Chỗ hiện thực | Test pin |
|---|---|---|
| SSRF guards / private IP / loopback | fetcher mặc định createPinnedFetch() + @du/contracts ip-policy qua egress; không có fast-path nào khác | fence suite 7 literal + resolver-seam |
| DNS rebinding | egress resolve 1 lần dùng chung socket; mỗi hop re-fetch (re-resolve) | resolver-seam loopback; hop-metadata |
| redirect hops limit | hop loop + maxRedirects, re-validate mỗi hop | REDIRECT_LIMIT ×2 (bound, 0), hop→file:/userinfo bị chặn |
| hash verification | SHA-256 khi stream + expectedSha256/Size (timing-safe) | HASH/SIZE_MISMATCH |
| bounded bytes/time | content-length pre-check, cap mid-stream, deadline, idle watchdog | TOO_LARGE ×3, TIMEOUT, IDLE_TIMEOUT |
| failed acquisition không tạo READY/parse bytes dở | xóa file partial ở MỌI lỗi | expectWorkspaceEmpty trên từng loser |

### 2.4 Bằng chứng chạy (offline)

- **Suite mới, chạy RIÊNG 6 lần**: `pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts` → mỗi lần `Tests: 40 passed, 40 total`, CLEAN 6/6 (sau khi sửa flake xem 2.5).
- **Full package 3 lần**: `pnpm --filter @du/worker-sdk test` → run1 210/213, run2 211/213, run3 213/213 CLEAN. Mọi test đỏ đều thuộc suite pre-existing khác (2.5), suite mới xanh 3/3.
- `pnpm --filter @du/worker-sdk lint` (tsc --noEmit) ×3 → Exit Code: 0 mỗi lần. `build` → Exit Code: 0.
- **Baseline trước thay đổi**: 13 suites / 173 tests, Exit Code: 0 (full package, 17:42).
- **Định nghĩa win/lose**: mỗi tên test = 1 invariant (xem §2.3); PASS của packet = suite mới 6/6 CLEAN + lint 0. Full package xanh 3/3 là CHƯA ĐẠT, không tính — nguyên nhân nằm ngoài diff này (bằng chứng bên dưới).

### 2.5 Flake pre-EXISTING phát hiện khi verify (Δ6, Δ7)

- **Δ6 — suite R1-C `tests/network-boundaries.boundary.test.ts` (lane qwen3) bind port 0 → connect ETIMEDOUT → TRANSPORT_FAILURE.** Chạy RIÊNG 3/3 lần đỏ (2, 1, 3 fail trong 6 test; case thường gặp `[LOCK:ADM-BASE-03 download-error-body-no-raw-echo]` 325ms TRANSPORT_FAILURE) — KHÔNG có suite của lane này trong lần đó, tức không phải do diff. Nguyên nhân: Windows lọc ephemeral port mới (lesson CYCLE-102 trong tests/harness/listen-loopback.ts); convention đã có trong repo: orchestrator webhook boundary dùng QUIET_BOUNDARY_PORT_BASE + pid offset. **Fix 1 dòng cho owner** (không tự sửa vì file thuộc lane khác): `const QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16;` rồi `BoundaryListener.start(QUIET_PORT_BASE + i++)` thay `BoundaryListener.start()`. Suite mới của lane đã áp dụng convention này và giữ 6/6 clean.
- **Δ7 — DATA-03 phần server chưa có gì** (orchestrator: 202 URL submit → ingestion task, READY gate, pin version/hash + retry đọc bản đã pin). Primitive này là phía client của ingestion worker; document-core pipelines cố ý KHÔNG nối URL (parse chỉ READY). Cần packet riêng cho phần orchestrator.
- Ghi chú: `packages/worker-sdk/package.json` đã sửa trên đĩa (đọc lại nội dung xác nhận) nhưng `git status` KHÔNG liệt kê path này (index metadata lỗi thời/skip trong checkout chung) — evidence là nội dung file, không phải git diff. File mới của lane hiện là `??` (chưa track).

### 2.6 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho phần client của DATA-03 (packet W-DATA03-ACQ-1). KHÔNG ACCEPTED: phần server (Δ7) chưa có; §6 chưa ký giá trị budget cho DATA-03 (defaults hiện là SDK-side).

## 3 — PACKET W-DATA04-STREAM-1: streaming bounds + đóng khoảng trống tệp 1 MiB - 64 MiB (T20-D1)

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Không commit/push/reset. Không DB/Redis/S3 live.** Toàn bộ evidence offline (loopback 127.0.0.1 trong quiet band, không system DNS, không monkeypatch globalThis.fetch).

**File đã sửa** (4 file trong danh sách packet + 1 file test ngoài danh sách để vá regression do chính cycle trước):
- `packages/worker-sdk/src/artifact-streams.ts` (policy dải)
- `packages/worker-sdk/src/artifact-multipart.ts` (backstop trần wire)
- `businesses/document-core/src/pipelines/parser-budget.ts` (trần RSS + đọc bounded)
- `packages/worker-sdk/tests/artifact-direct-band.test.ts` (mới, 12 test)
- `businesses/document-core/tests/parser-budget-band.test.ts` (mới, 8 test)
- `businesses/document-core/tests/build-dependency-order.test.ts` (vá regression của W-DATA03-ACQ-1 — xem 3.5)

### 3.1 Rà soát — khoảng trống T20-D1 là gì trên cây hiện tại

- **Sàn/tần trần không gặp nhau**: `packages/contracts/src/runtime.ts:255` đặt `MULTIPART_MIN_TOTAL_BYTES = 64 MiB + 1` (schema init multipart, cùng dòng 274 là `sizeBytes.min`), còn `services/orchestrator/src/http/ingress.ts:28` đặt `DEFAULT_MAX_JSON_BYTES = 1 MiB`. Giữa hai mốc đó không tồn tại hình dạng wire nào: tệp 5 MiB không đi được JSON (413) cũng không đi được multipart (schema từ chối).
- **Không route nào nhận binary**: grep `binary: true` trong `services/orchestrator/src` = **0 hit**. `DEFAULT_MAX_BLOB_BYTES = 64 MiB` (ingress.ts:29) đã có sẵn và chưa được dùng ở đâu — đúng dải cần đóng, nhưng việc bật nó thuộc orchestrator (ngoài phạm vi packet này).
- **Phía worker thì đường single-PUT ĐÃ có sẵn**: `uploadArtifactStream` (artifact-streams.ts) stream với highWaterMark 64 KiB, khai báo `content-length`, `duplex: half`, hash + size verify, không redirect, whole-request timeout. Thiếu không phải cơ chế, mà là **policy**: không ai viết ra dải, và không có gì chặn engine multipart đi xuống dưới sàn contract.
- **Phía business**: `ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES = 10 MiB` (PROPOSED, chờ DATA-00 §6) trong khi `INLINE_READ_BYTES = 1 MiB` là một hằng riêng — tức tầng business không thể đọc tệp 10-64 MiB, dù dải mới sẽ nhận chúng.
- **RSS của đường đọc**: `readArtifactViaStream` stream về đĩa rồi `readFile(target)` — cấp phát theo kích thước file thật trên đĩa và quét hash ở lượt thứ hai. Không vượt budget (budget đã chặn từ `stat` + mid-stream), nhưng tự nó không có trần cứng: đúng thứ packet yêu cầu phải có.

### 3.2 Đã triển khai

**(a) artifact-streams.ts — policy dải, derive từ wire constant**
- `INLINE_ARTIFACT_MAX_BYTES = 1 MiB` (mirror `DEFAULT_MAX_JSON_BYTES` của orchestrator), `DIRECT_ARTIFACT_MAX_BYTES = MULTIPART_MIN_TOTAL_BYTES - 1` (= 64 MiB), `ARTIFACT_UPLOAD_WIRE_MAX_BYTES = MULTIPART_MAX_TOTAL_BYTES` (= 8 GiB), và `resolveArtifactUploadBand(sizeBytes): 'inline' | 'direct' | 'multipart'`.
- Fail-closed: size âm / không phải safe-integer → 422 `SIZE_MISMATCH`; vượt trần wire → 413 `TOO_LARGE`. Không có đường nào để chọn dải cho một size không khai báo.
- Ba giá trị derive từ `@du/contracts` nên **không thể lệch schema server**; hằng 1 MiB được ghi rõ là mirror và cùng thuộc DATA-00 §6 (hợp đồng buộc phải sửa cả hai cùng lúc).

**(b) artifact-multipart.ts — backstop trần, không đụng sàn**
- Trước `init`: `sizeBytes > ARTIFACT_UPLOAD_WIRE_MAX_BYTES` → 413 `TOO_LARGE`, **zero network** (test chứng minh transport không nhận lời gọi nào).
- Cố ý KHÔNG chặn dưới sàn: engine này là geometry engine (suite riêng chạy geometry 2500 byte) và sàn thuộc schema DATA-00-M + routing của facade. Ghi rõ bằng comment tại chỗ để không ai hiểu nhầm là còn sót.

**(c) parser-budget.ts — trần RSS của tầng business + đọc bounded**
- `MAX_BUFFER_SIZE_CEILING_BYTES = MULTIPART_MIN_TOTAL_BYTES - 1` (64 MiB) và `resolveParserBudget` **từ chối** mọi `maxBufferSizeBytes` vượt trần với `INVALID_PARSER_BUDGET`. Đây là lỗ hổng thật trước đó: `safeParseBuffer` nhận `options.maxBufferSizeBytes` từ caller, không có trần nào chặn nó ở 8 GiB — tức tầng business có thể bị yêu cầu materialize trọn vẹn trong heap một artifact của dải multipart.
- `readBounded(target, maxBytes)`: open → stat **trước** → từ chối nếu file trên đĩa vượt budget (fail-closed, zero byte cấp phát) → `Buffer.alloc` đúng kích thước → đọc tuần tự và **hash trong cùng một lượt** với byte mà parser sẽ nhận → trả `{buffer, sha256}`. `Buffer.alloc` (zero-filled) cố ý thay `allocUnsafe` để một lượt đọc thiếu không bao giờ đưa heap chưa khởi tạo cho parser engine. Nhánh đọc thiếu → `ARTIFACT_SIZE_MISMATCH`.

### 3.3 Guard của packet → bằng chứng pin

| Yêu cầu packet | Chỗ hiện thực | Test pin |
|---|---|---|
| Cơ chế binary streaming 1 MiB - 64 MiB ngoài multipart | `uploadArtifactStream` + policy dải; MỘT PUT, `content-length` = size khai báo | `carries a 1 MiB + 1 artifact in a single PUT with an exact content-length` (listener: `requests === 1`, `bodyBytes` = size, header đúng) |
| Đọc/ghi artifact có giới hạn RSS, không buffer trước khi parse | `readArtifactViaStream` (stream về đĩa) + `readBounded` (1 cấp phát ≤ budget, hash 1 lượt) | `PARSER-RSS` 8 MiB artifact: peak marginal external 8.00-8.01 MiB = **một** bản, không phải hai; + 2 test fail-closed (over-budget không chuyển byte nào; digest sai không đưa byte lên parser) |
| Bỏ khoảng trống dải (policy, không lệch contract) | 3 constant derive từ `@du/contracts` + `resolveArtifactUploadBand` | `derives every edge from the DATA-00-M wire constants`, `partitions every size in [0, wire ceiling] into exactly one band` (11 mốc, kín + liền mạch) |
| Fail-closed | dải vượt trần / khai báo hỏng / engine multipart | `fails closed on a size past the wire ceiling`, `fails closed on an unusable declaration`, `multipart engine refuses a size past the wire ceiling before init` (transport 0 lời gọi) |
| Ngăn cấu hình kéo theo | `MAX_BUFFER_SIZE_CEILING_BYTES` chặn budget vô hạn | `refuses a caller budget that would materialize a multipart-band artifact` (3 mức vượt) |

### 3.4 Bằng chứng chạy (offline)

Lệnh, cwd `D:\Git\dugate\du-rework`:

    pnpm --filter @du/worker-sdk test -- tests/artifact-direct-band.test.ts
    pnpm --filter @du/document-core test -- tests/parser-budget-band.test.ts tests/read-stream-acquisition.test.ts tests/parser-budgets.test.ts

| Chạy | Kết quả | Exit Code: |
|---|---|---|
| suite worker-sdk mới x3 | `Tests: 12 passed, 12 total` (12/12, 3/3 sạch) | 0 |
| targeted document-core x3 | `Tests: 64 passed, 64 total` (3 suite: mới + read-stream-acquisition + parser-budgets) | 0 |
| `build-dependency-order.test.ts` x3 | `Tests: 8 passed, 8 total` | 0 |
| **full worker-sdk x6** | run 2, 3, 6: `Test Suites: 15 passed / Tests: 225 passed`; **run 1, 4, 5 đỏ** (xem Δ6) | 0 / 1 |
| **full document-core offline** (`--testPathIgnorePatterns=bullmq-smoke,multi-container-e2e,p8-03`) | `Test Suites: 40 passed, 40 total / Tests: 498 passed, 498 total` | 0 |
| `pnpm --filter @du/worker-sdk lint` x3 | sạch | 0 |
| `pnpm --filter @du/document-core lint` x3 | sạch | 0 |

**Định nghĩa win/lose**: PASS của packet = suite mới 12/12 sạch 3/3 + targeted doc-core 64/64 x3 + lint 0 x3 + full doc-core offline xanh. Full worker-sdk 3/6 xanh **KHÔNG tính là đạt** — nguyên nhân nằm ngoài diff này (Δ6, bằng chứng bên dưới).

**RSS — số đo và cách chọn ngưỡng** (ngưỡng từ số đo, không bịa):
- Đo client-only (fetcher giả hút body, **zero socket**), 64 MiB ở mốc cao nhất của dải, chunk nguồn 64 KiB, lấy mẫu trong data path (đúng convention W-DATA04-RSS-1): các lần đo cho peak marginal external **17.0 / 17.7 / 21.1 / 22.9 / 29.9 / 30.1 / 32.9 / 33.1 MiB** và live external sau lúc truyền **-13.12 … +5.07 MiB**, hình dạng là **sawtooth sạch** (0.5 → 16.4 → 32.4 → 16.7 → 32.7 → 1.2 MiB) tức byte được thu hồi chứ không tích luỹ.
- Ngưỡng chọn: `peak ≤ 48 MiB` (0.75 × kích thước tệp) và `resident ≤ 8 MiB`. Giữ trọn vẹn tệp sẽ pin ≥ 64 MiB ở cả hai mốc → hỏng lần lượt 1.33× và 8×.
- **Đã bỏ một witness sau khi đo**: least-squares slope của nửa sau chuỗi rơi trong khoảng -16k..+24k byte/chunk giữa các lần chạy (sawtooth làm slope vô nghĩa), nên không dùng làm tiêu chí. Ghi lại để không ai thêm lại sau này.
- `PARSER-RSS` (đường đọc, 8 MiB artifact, budget 10 MiB): peak marginal external **8.00 / 8.00 / 8.01 / 8.01 MiB** qua các lần chạy — đúng một bản; một regression pre-buffer (giữ stream cạnh buffer) sẽ nhân đôi lên ~16 MiB và vượt trần 1.75 × budget.

### 3.5 Sửa regression do chính cycle trước (build-dependency-order)

- Full run document-core đỏ `build-dependency-order.test.ts` (1 test). Nguyên nhân **không phải diff của cycle này**: W-DATA03-ACQ-1 (Mục 2) đã thêm `@du/egress` vào `packages/worker-sdk/package.json`; fixture `invertedOrder` trong test là list 4 bước viết tay, thiếu `@du/egress` nên **closure check fire trước** topological check và sai message.
- Vá: thêm `@du/egress` vào fixture trước `worker-sdk` + cập nhật index trong kỳ vọng (1→2, 2→3). Test-only, không đụng product source. 8/8 xanh ×3, full doc-core offline xanh.
- **Khuyến nghị bị thu hồi**: Mục 2.5 ghi build-dependency-order của document-core không đổi — đó là **suy luận, chưa chạy**. Đã chạy và thấy đỏ. Bài học cho cycle sau: khẳng định về suite của package khác phải kèm lệnh chạy, không suy từ lý thuyết build order.

### Δ-DEVIATION (chờ coordinator adjudicate — lane KHÔNG tự sửa)

- **Δ6 (cập nhật, vẫn mở)** — suite R1-C `tests/network-boundaries.boundary.test.ts` (lane qwen3) vẫn đỏ trong full worker-sdk: **3/6 run** (run 1: 1 đỏ `[LOCK] B3-lock-b redirect refused`; run 4, 5: 2 đỏ; vị trí đỏ di chuyển giữa các run), ký hiệu `TRANSPORT_FAILURE` từ ETIMEDOUT. Chạy RIÊNG suite đó **4/4 lần xanh** (3 lần ở cycle trước + 1 lần ở cycle này) → không phải do diff của lane này, là race ephemeral port Windows (lesson CYCLE-102). Fix vẫn là 1 dòng theo convention quiet-band mà suite mới của lane đã dùng: khai báo `QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16` rồi `BoundaryListener.start(QUIET_PORT_BASE + i++)`.
- **Δ8 (mới)** — số đo RSS qua loopback listener trong cùng process bị **phồng bởi chính server**: probe đo được external tăng đều 23 → 75 MiB (slope ~72 KB/chunk ≈ 1.1 byte/byte) khi server là `BoundaryListener` (node:http), trong khi cùng dữ liệu đo qua fetcher giả là sawtooth sạch 1-33 MiB. Chưa phân định được phần tồn dư là undici phía client hay node:http phía server (probe 'server không đọc body' không kịp lấy mẫu vì undici huỷ upload khi response về sớm). Hệ quả thực tế: **mọi phép đo RSS có socket loopback trong cùng process đều bị tính phí của server** — lane khác (Qwen-5, Qwen-3) nếu đo RSS qua listener cần biết điều này. Khuyến nghị: witness bộ nhớ nên zero-socket, listener chỉ dùng làm oracle về wire.
- **Δ9 (mới, chặn phía business)** — sau khi đóng dải phía wire, tầng business **vẫn không đọc nổi tệp 10-64 MiB**: `DEFAULT_MAX_BUFFER_SIZE_BYTES = 10 MiB` là giá trị PROPOSED, `readArtifactViaStream` resolve budget không có override, và `safeParseBuffer` chỉ nâng được tới trần 64 MiB mới (trần vừa đặt). Cần 2 quyết định, **không phải code lane này tự quyết**: (1) DATA-00 §6 ký giá trị budget business; (2) seam `parseFile(path)` của `@du/document-kit` (đã ghi ở qwen4-handoff PARKED #3, vẫn chưa có) để tệp vượt buffer ceiling được parse từ đĩa thay vì nâng buffer. Test `refuses a band artifact above the signed business budget, before any byte moves` **ghim** ranh giới hiện tại (12 MiB → `DOCUMENT_TOO_LARGE`, zero byte chuyển) để khi §6 ký thì đổi test, không sửa lặng lẽ.
- **Ngoài phạm vi packet (để coordinator giao)**: phần server của khoảng trống T20-D1 — một route public nhận `binary: true` (ingress đã có `DEFAULT_MAX_BLOB_BYTES = 64 MiB` sẵn, chưa route nào bật) cộng với việc Reviewer yêu cầu **chấp nhận tường minh** public complete là finalize edge + hai dạng replay-key. Không tự đụng orchestrator trong packet này.

### 3.6 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho phần client của DATA-04 trong packet này: policy dải + cơ chế binary 1 MiB-64 MiB một-request + trần RSS hai tầng + bằng chứng RSS đo được. **KHÔNG ACCEPTED**: DATA-04 giữ [~] vì (a) route public binary phía orchestrator chưa có, (b) §6 chưa ký budget nên tầng business còn chặn ở 10 MiB (Δ9), (c) cửa live §9 của Qwen-4 vẫn mở.

## 4 — PACKET W-DOC-ISOLATE-1: cô lập suite live khỏi runner offline của document-core

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Không commit/push. Không mở DB window.** Căn cứ: Reviewer Turn 50 Finding 4 (yêu cầu do packet trích dẫn; không mở lại `coordination/reports/review.md` vì finding nằm ở turn khác, chỉ làm đúng nội dung packet).

**File đã sửa**: `businesses/document-core/jest.config.cjs` (thêm `testPathIgnorePatterns`) + `businesses/document-core/package.json` (2 script integration — sửa bắt buộc do chính thay đổi này, xem 4.2).

### 4.1 Hiện trạng trước khi sửa

- `jest.config.cjs` **không có** `testPathIgnorePatterns`; `testMatch: ['**/*.test.ts']` + `roots: tests` nên `jest --runInBand` nuốt **mọi** suite trong tests/, kể cả `multi-container-e2e.integration.test.ts`.
- Bằng chứng tái hiện finding: một lần chạy full package vô tình (do tôi truyền sai dạng `--` của pnpm) đã kéo cả suite live vào và nó **đỏ 12 test / 276 s** — đúng triệu chứng mà Reviewer nêu: runner offline mặc định không sạch.
- Tổng số file test trong `tests/`: **43**, trong đó đúng **1** file `.integration.test.ts` → offline lẻ ra 42, khớp con số packet yêu cầu.

### 4.2 Đã sửa + phát hiện bắt buộc (nếu chỉ thêm dòng config thì sẽ hỏng script live)

- `jest.config.cjs`: `testPathIgnorePatterns: ['\\.integration\\.test\\.ts$']` kèm comment nói rõ multi-container là opt-in qua script `test:integration`.
- **Phát hiện**: jest lọc `testPathIgnorePatterns` **sau** khi đã match, nên chạy `jest tests/multi-container-e2e.integration.test.ts` vẫn bị loại → script `test:integration` sẽ thành *No tests found* và exit 1, tức **hỏng đúng thứ packet bảo phải còn lại**. Probe A (dùng `--listTests`, positional không kèm override) → **0 file**: xác nhận bằng đo, không phải suy luận.
- Cách sửa: override bằng CLI trong chính script, giá trị không khớp gì: `--testPathIgnorePatterns=/__offline_default_excludes_integration__/`.
- **Bẫy yargs phải ghi lại**: probe B (cờ ignore **đặt trước** positional) → **42 file**, tức yargs nuốt luôn positional vào mảng của cờ array, script sẽ chạy 42 suite thay vì 1. Probe B2/B3 (cờ **đặt sau** positional) → đúng **1 file**. Vì vậy thứ tự arg trong script là một phần của hợp đồng, không phải chi tiết vô nghĩa.
- Đã áp cho cả `test:integration` và `test:integration:full`.

### 4.3 Bằng chứng chạy

Lệnh, cwd `D:\Git\dugate\du-rework`:

    pnpm --filter @du/document-core test
    pnpm --filter @du/document-core exec jest --listTests
    pnpm --filter @du/document-core exec jest tests/multi-container-e2e.integration.test.ts --runInBand --testPathIgnorePatterns=/__offline_default_excludes_integration__/ --listTests
    pnpm --filter @du/document-core lint

| Chạy | Kết quả | Exit Code: |
|---|---|---|
| `test` (default) run 1 | `Test Suites: 42 passed, 42 total` / `Tests: 506 passed, 506 total` (33.99 s) | 0 |
| `test` (default) run 2 | `Test Suites: 42 passed, 42 total` / `Tests: 506 passed, 506 total` (25.52 s) | 0 |
| `test` (default) run 3 | `Test Suites: 42 passed, 42 total` / `Tests: 506 passed, 506 total` (26.25 s) | 0 |
| `--listTests` (default) | **42 file**, **không** có file `.integration`, vẫn có `bullmq-smoke` + `p8-03` | 0 |
| script integration (đúng thứ tự arg, `--listTests`) | **1 file** = `multi-container-e2e.integration.test.ts` | 0 |
| probe A (positional, không override) | **0 file** — bằng chứng script sẽ hỏng nếu chỉ thêm dòng config | 0 |
| `lint` x3 | sạch | 0 |
| `test:typecheck` | sạch | 0 |

**Định nghĩa win/lose của packet**: PASS = default runner chọn 42 suite offline, 506/506 test, **0 skip**, exit 0 (3/3) + script integration vẫn chọn đúng 1 file. Đạt. Suite live **không** chạy (cần hạ tầng live, không phải gate của lane) — bằng chứng dùng `--listTests` với đúng thứ tự arg của script nên discovery được chứng minh mà không bật dịch vụ live.

### 4.4 Ghi chú trung thực về mức độ offline

- 42 suite xanh **không hoàn toàn thuần offline**: `bullmq-smoke.test.ts` tự probe `127.0.0.1:6380` và trên máy này Redis đó **đang sống**, nên nó **chạy thật và PASS** (không skip — jest báo `506 passed, 506 total`, không có dòng skipped). Đây là Redis local của máy dev, **không** phải DB window của Tester, và packet cấm DB window nên không có vi phạm nào; nhưng ghi rõ để không ai đọc nhầm 42 suite này là offline thuần túi.
- `p8-03-provider-convergence.test.ts` (ghi chú handoff cũ của lane là thuộc DB window Tester-1) chạy và **PASS** trong default runner — không cần PG thật ở đường này.
- Ảnh hưởng tới lane khác: trước đây bất kỳ ai chạy full `pnpm --filter @du/document-core test` đều dính suite live (đỏ 12 test, mất 276 s). Từ giờ lệnh đó là gate offline sạch — **các receipt cũ ghi 'full doc-core' phải đọc lại**: chúng có thể đã loại trừ suite thủ công bằng CLI.

### Δ-DEVIATION (chờ coordinator adjudicate)

- **Δ10 (mới)** — cùng pattern cô lập này chưa được áp cho `services/orchestrator` và `services/connector`; nếu hai package đó có suite `*.integration.test.ts` tương tự thì default runner của chúng vẫn nuốt suite live. Ngoài phạm vi packet (đúng một package), lane **không tự mở**. Kèm theo: script integration nay phụ thuộc **thứ tự arg** (4.2) — ai chèn cờ trước positional sẽ âm thầm chạy 42 suite thay vì 1; nên giữ comment ở chỗ khi sửa `package.json`.

### 4.5 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho W-DOC-ISOLATE-1: Reviewer Turn 50 Finding 4 đã đóng ở phía cấu hình runner, và việc sửa phụ (2 script integration) là bắt buộc để không làm hỏng đường live. **Không** thay đổi trạng thái task DATA-* nào; DATA-02/03/04 giữ nguyên mức đã ghi ở RESUME POINT.
## 5 — PACKET W-DATA-STATUS-S3-1: cập nhật trạng thái DATA sau Turn 60 + rà soát cấu hình S3/MinIO + chuẩn bị kịch bản live

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Không sửa code sản phẩm. Không mở DB window. Không tick umbrella gate. Không commit/push.** Chỉ đụng hồ sơ/markdown: `tasks/README.md`, `docs/runbooks/` (1 file mới + 1 dòng index), receipt này.

### 5.1 Đã đọc — Turn 60 Independent Audit nói gì về lane này

- Vị trí: `coordination/reports/review.md:7-45`.
- Phán quyết cho packet của lane: **W-DOC-ISOLATE-1 → ACCEPT for the isolation packet's offline acceptance scope**. Nguyên văn
  evidence cột: "`@du/document-core` default `test` excludes `*.integration.test.ts`; the separate integration discovery finds
  exactly `multi-container-e2e.integration.test.ts` without executing it. Tester receipt: 42 suites, 506 tests, 0 skips, exit 0."
  Ranh giới Reviewer nêu rõ: KHÔNG gọi aggregate của package là end-to-end green; suite multi-container vẫn là gate live riêng;
  và "Owner may promote W-DOC-ISOLATE-1 after recording the receipt, without closing G6".
- Hai mục Turn 60 giao cho DATA mà lane này **không** tự làm trong packet này (chỉ chuẩn bị): mục 2 — "repair the S3
  credential/configuration that caused the prior 503/`InvalidAccessKeyId`; execute public `/api/v1/uploads` init → binary part →
  complete → submit, replay, abort/sweep and retention checks against real PG/private S3"; mục 3 — DATA-03 live "worker
  acquisition → immutable S3 version/hash → READY/outbox". Mục 6 của audit yêu cầu owner tự ghi dòng task kèm
  command/environment/receipt link — đúng việc 2 của packet.

### 5.2 Item 2 — đã ghi ledger ACCEPTED vào `tasks/README.md`

- Thêm 1 dòng blockquote `> **DATA packet ledger — 2026-09-26:**` ngay dưới dòng SEC-00 ledger cùng mẫu (khuôn do lane SEC đặt).
- Nội dung ghi đủ hồ sơ theo AGENTS mục 5: packet ID + phạm vi tuyên bố, căn cứ Reviewer Turn 60 + Tester T-CODEX-TEST-17, command
  `pnpm --filter @du/document-core test` tại cwd `du-rework`, HEAD `7811298`, **literal ExitCode `0`**, 42 suite passed / 0 failed /
  0 skipped, 506 test passed / 0 failed / 0 skipped, discovery chỉ trả `tests/multi-container-e2e.integration.test.ts` (không chạy
  test), đường raw log `coordination/reports/T-CODEX-TEST-17-document-core-offline-green.log`, link receipt của chủ packet (Mục 4),
  kèm ba điều nó KHÔNG đóng: không tick dòng DATA nào, không đóng `G-DATA`/`G6`, package chưa phải end-to-end green.
- Không sửa dòng task DATA-02/03/04; không sửa `docs/28`/`docs/35` (thuộc lane docs/evidence).
- **Đối chứng độc lập ngay trong cycle này**: lane chạy lại đúng lệnh được ghi ACCEPTED → `Test Suites: 42 passed, 42 total` /
  `Tests: 506 passed, 506 total`, Exit Code 0, 26.76 s (chạy SAU khi đã sửa markdown). Khớp 100% với T-CODEX-TEST-17; tổng cộng
  4 lần xanh của lane cho lệnh này (3 lần ở Mục 4 + 1 lần ở đây).

### 5.3 Item 3 — nguyên nhân lỗi S3 503 / InvalidAccessKeyId, kiểm chứng bằng source (không tin claim)

Bằng chứng lịch sử: `coordination/reports/tester.md:7249-7262` (T-DATA-LIVE-3R: 3 lần multipart-init trả **503** dưới dạng
`AmbiguousReportError`, `afterAll` báo **InvalidAccessKeyId** từ ListObjectVersions, readiness probe trước đó 200, không retry) và
`coordination/reports/tester-antigravity.md:98-130` (T-DATA-LIVE-4: **cùng endpoint :9003, cùng bucket `du-artifacts-live2`, cùng**
**suite** → 5/5 xanh ×2 sau khi lấy đúng root credential từ `docker inspect minio`).

Chuỗi nguyên nhân xác nhận được trực tiếp trên source:

1. **App không tự mang credential**: `services/orchestrator/src/server.ts:261-266` tạo `S3Client` với region/endpoint/forcePathStyle,
   **không** có trường `credentials` → đi theo default provider chain của AWS SDK, thực tế là `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` trong môi trường process. Cặp key *có tồn tại nhưng sai* cho MinIO instance đó vẫn boot bình thường,
   chỉ fail ở call S3 đầu tiên.
2. **Mọi lỗi storage bị gom về một mã**: `modules/artifacts/s3-storage-facade.ts:426-429` bọc `CreateMultipartUpload` bằng `catch`
   **trần** (không giữ cause, không log tên lỗi S3) rồi throw `ArtifactStorageError('STORAGE_UNAVAILABLE')`; `http/errors.ts:61-62`
   map mã đó thành **503 TEMPORARY_UNAVAILABLE**. Đây chính là lý do Tester-1 chỉ thấy 503 và phải suy đoán.
3. **Hệ quả chẩn đoán (giá trị thực tiễn của rà soát này)**: trong stack này **503 lúc multipart-init KHÔNG phải tín hiệu outage**.
   `InvalidAccessKeyId`, `AccessDenied`, `NoSuchBucket`, endpoint chết và lỗi transient thật sự trả về cùng một hình dạng. Thứ tự
   tiết kiệm cửa sổ live nhất là xác minh danh tính credential TRƯỚC khi kết luận về tiến trình MinIO.
4. **Pilot S3 không tái lập được từ repo**: `infra/docker-compose.yml` chỉ khai postgres :5433, redis :6380 và profile connector
   opt-in — **không có service S3/MinIO nào**; `docs/12-operations.md:5` cũng nói thẳng object storage/MinIO chưa được triển khai
   trong infra. Endpoint + root credential + bucket đang được dựng tay theo từng cửa sổ, nên "Tester khác chạy xanh rồi" không phải
   precondition; và việc đọc root credential bằng `docker inspect` là shortcut của harness, không phải đường credential cho deployment.
5. **Đính chính danh tính bucket (packet nêu `du-uploads`)**: `du-uploads` **không phải bucket ở bất kỳ đâu trong `du-rework`**. Bucket
   thật: `du-artifacts-live2` (pilot live) và `du-artifacts-test` (fixture offline,
   `services/orchestrator/tests/s3-multipart-storage-offline.test.ts:23`). Chuỗi `du-uploads` duy nhất là **muối namespace** trong
   hàm dẫn xuất replay-key public: `modules/artifacts/multipart-service.ts:86` = sha256(`'du-uploads|' + tenantId + '|' + idempotencyKey`).
   Nếu Tester tạo bucket `du-uploads` đúng theo chữ trong packet thì sẽ ăn `NoSuchBucket` — và qua lớp mask ở mục 2 lại hiện ra 503.
6. Ma trận env đọc trực tiếp từ `main.ts:74-89` + `server.ts:261-264` + `tests/data-02-04-live-s3.test.ts:239-266` (chi tiết trong
   runbook). Lưu ý `ARTIFACT_STORAGE_BACKEND` chỉ quan trọng với process deploy (suite truyền thẳng `artifactStorage` vào `createApp`),
   nên bỏ quên nó khi chạy *process* cho triệu chứng khác hẵn lỗi credential.

### 5.4 Item 4 — kịch bản live đã chuẩn bị (CHƯA chạy, đúng ràng buộc packet)

- File mới: **`docs/runbooks/data-02-public-uploads-live.md`** (174 dòng) + 1 dòng link trong `docs/runbooks/README.md` (theo đúng
  mục lục của thư mục). Viết bằng tiếng Anh theo style runbook hiện có (`data-05-s3-migration-runbook.md`).
- Nội dung: (i) boundary an toàn (chỉ Tester trong cửa sổ đã claim, không sửa source giữa window, không log secret/signed URL);
  (ii) mục nguyên nhân S3 ở 5.3 kèm file:line; (iii) ma trận env; (iv) **6 bước preflight**, trong đó bước 4 là probe danh tính thẳng
  vào S3 (`aws s3api list-objects-v2 --endpoint-url ...`) để bắt lỗi credential trong vài giây thay vì chờ 503 mơ hồ;
  (v) **Scenario A** — 15 bước public `/api/v1/uploads`: init → part grant → PUT binary → complete → submit, cộng replay cho CẢ HAI
  dạng replay-key, foreign tenant 404, STAGING submit 409, abort, TTL sweep, expired submit 404, mẫu RSS;
  (vi) **Scenario B** — 7 bước DATA-03: submit URL → ingestion task → `acquireSourceUrl` (egress-pinned) → pin S3 version/hash →
  READY gate → kill/retry cùng SHA-256 → outbox đúng một lần; (vii) checklist bằng chứng theo AGENTS mục 5; (viii) mục
  "runbook này không nghiệm thu cái gì".
- **Bước A15 được ghi là 422-expected, không phải pass**: init công khai với size trong dải 1 MiB–64 MiB vẫn bị từ chối vì
  `packages/contracts/src/runtime.ts:255,274` đặt sàn 64 MiB + 1 và **không có route binary công khai nào**. Runbook nói rõ để
  Tester không tính đó là xanh.
- **Không tạo file test mới** trong `services/orchestrator/tests/` — lý do có số liệu ở Δ12, không phải e dè chung chung.

### 5.5 Đính chính một phát biểu của chính lane ở Mục 3

- Mục 3.1 viết: grep `binary: true` trong `services/orchestrator/src` = **0 hit**, rồi suy ra không route nào nhận binary. **Kết luận
  đó sai về bản chất**: giá trị truyền vào không phải literal `true` mà là biến — `server.ts:415-420` tính
  `isBlobPut = method === 'PUT' && /^\/api\/runtime\/v1\/artifacts\/blob\/[^/]+$/` rồi gọi
  `readBoundedBody(req, { binary: isBlobPut, ... })`. Route blob PUT **có** nhận raw binary và dùng trần `maxBlobBytes` (64 MiB).
- Câu đúng phải là: **có đúng một route binary, và nó là route runtime grant-scoped** (`/api/runtime/v1/artifacts/blob/:key`);
  **nhánh public** không có đường binary nào. Kết luận T20-D1 (khoảng trống cho client công khai 1 MiB–64 MiB) vẫn nguyên giá trị,
  nhưng lý lẽ nêu trước đó thiếu chính xác. Đã diễn đạt lại đúng trong runbook (ghi chú bước A15). Đây là lỗi kiểu
  "grep một literal rồi quy kết hành vi" — ghi lại như bài học đo lường.

### Δ-DEVIATION (chờ coordinator adjudicate — lane KHÔNG tự sửa)

- **Δ11 (mới — đề xuất cho owner Orchestrator; lane không sửa vì packet cấm đụng product source)** —
  `s3-storage-facade.ts:426-429` và các chỗ tương tự (dòng 198, 229, 254, 563, 590) bọc thao tác S3 bằng `catch` **không giữ cause**,
  nên mọi fault — kể cả lỗi vĩnh viễn như `InvalidAccessKeyId` — hiện ra thành 503 `TEMPORARY_UNAVAILABLE` và **mất hẳn tên lỗi** ở
  phía caller. Chi phí thực đo được: một cửa sổ live bị đốt để suy luận credential. Sửa tối thiểu mà **không đổi wire shape**: bắt
  `catch (err)`, log đúng một lần qua `lib/logger.ts` với tên/mã lỗi S3 đã sanitize (không query endpoint, không credential), hoặc
  tách lỗi vĩnh viễn (auth/no-bucket) khỏi tín hiệu retry-transient. Thuộc DATA + LOG-01, cần packet riêng.
- **Δ12 (mới)** — `services/orchestrator/jest.unit.config.cjs` đã có danh sách `liveSuites` (15 pattern) để loại suite live khỏi runner
  offline, nhưng **`data-02-04-live-s3.test.ts` không nằm trong danh sách đó**: nó tự `describe.skip` khi `DU_LIVE_INFRA` != 1 nên vẫn
  được *collect*. Đây chính là "1 skipped suite" trong aggregate 58 suite / 1342 passed / 15 skipped của T-CODEX-TEST-2
  (`coordination/reports/tester.md`). Hệ quả: nếu lane thêm file live cho Scenario A/B, mọi aggregate offline của orchestrator nhảy lên
  **2** skipped suite và làm lệch các receipt đang so sánh đúng con số đó. Cần quyết định MỘT lần: hoặc đặt tên file theo pattern đã
  exclude (`*.live.test.ts`, tiền lệ `webhook-reclaim-fence.live.test.ts`) và thêm pattern vào `liveSuites`, hoặc giữ nguyên. Sửa config
  của package khác ngoài phạm vi packet → lane chỉ chuẩn bị kịch bản trong runbook.
- **Δ13 (mới — ops)** — không có S3/MinIO nào trong `infra/docker-compose.yml`: môi trường live cho G-DATA **không tái lập được từ**
  **repo** (endpoint, root credential, bucket đều dựng tay). Owner quyết: thêm service MinIO opt-in (profile riêng, port cố định,
  credential lấy từ env — không hardcode secret vào compose) hay chấp nhận thủ tục dựng tay và ghi nó vào runbook kèm chủ sở hữu.
  Trước khi quyết, mỗi lần chạy live vẫn rủi ro cấu hình như T-DATA-LIVE-3R.
- Nhắc lại các Δ còn mở của lane (cycle này không đổi trạng thái): Δ1–Δ3 (qwen5r), Δ5 (retention ledger), Δ6 (R1-C quiet-band),
  Δ7 (DATA-03 server-side), Δ8 (đo RSS qua loopback bị phồng), Δ9 (business budget 10 MiB, cần §6 + `parseFile`), Δ10 (chưa áp cô lập
  suite live cho orchestrator/connector — trùng góc nhìn với Δ12, coordinator có thể gộp).

### 5.6 Kết luận cycle

- Item 1-4: **HOÀN THÀNH** ở phạm vi hồ sơ/chuẩn bị. Ledger ACCEPTED đã ghi đúng khuôn và có đối chứng độc lập; nguyên nhân S3 đã
  kiểm chứng tới file:line và rút ra được quy trình preflight phòng lặp lại; kịch bản live A/B đã sẵn sàng cho Tester.
- Không có thay đổi hành vi nào và không suite nào bị ảnh hưởng: đã xác nhận không test nào đọc `tasks/README.md` hay
  `docs/runbooks/` (chỉ là markdown tham chiếu), và doc-core vẫn 42/42 + 506/506 exit 0 sau khi sửa.
- Việc của người khác next: Δ11 (owner Orchestrator/DATA), Δ12 + Δ13 (coordinator quyết), cửa sổ live cho Scenario A/B (Tester).

## 6 — PACKET W-DATA03-ACQ-1 (vòng 2): luồng acquisition URL bounded -> pin S3 -> READY (producer leg)

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Offline-only: không mở DB/Redis window, không S3/PG/Redis live nào do lane dựng. Không commit/push.**

**File đã sửa** (đúng phạm vi packet cho phép: `packages/worker-sdk`, `businesses/document-core`):
- `packages/worker-sdk/src/source-ingestion.ts` **(mới, 322 dòng)** — producer leg.
- `packages/worker-sdk/src/index.ts` — thêm export (value + type) cho module mới.
- `packages/worker-sdk/tests/source-ingestion.test.ts` **(mới, 491 dòng, 20 test)**.
- `businesses/document-core/`: **0 thay đổi** — xem 6.1 mục (d) và Δ14 (có lý do cụ thể, không phải bỏ quên).
- Dọn: `packages/worker-sdk/src/source-ingestion.part2.tmp` (file tạm do một lần write nhầm đường dẫn của lane, **đã xóa**; không liên quan build).

### 6.1 Rà soát — Δ7 của Mục 2 giờ đã được đóng MỘT PHẦN bởi lane khác

Trạng thái hiện tại trên cây (không lấy assumption cũ làm hiện tại):

- **(a) 202 URL submission -> ingestion state: ĐÃ CÓ** (không còn là Δ7 nguyên vẹn).
  `modules/operations/submission.ts:99,141,211,238-239` nhận `sourceUrl` (schema `packages/contracts/src/operations.ts:232`),
  validate qua `validateSourceUrl` (dòng 283-295: bắt buộc HTTPS, không userinfo, destination allowed), và khi có `sourceUrl` thì
  operation vào `PENDING_INGESTION` thay vì `ACCEPTED`; `server.ts:1168-1172` **không auto-dispatch** khi state là
  `PENDING_INGESTION`; `markIngestionReady` (dòng 305-336) mới flip operation -> `QUEUED` và **root task -> `READY`** kèm outbox
  `task.dispatch` một lần. Đây đúng là vế 'business task chỉ runnable khi source READY' mà packet yêu cầu — **không cần lane này làm**.
- **(b) Cổng acquirer: ĐÃ CÓ NHƯNG KHÔNG AI IMPLEMENT**.
  `submission.ts:60-69` định nghĩa `IngestionReceipt {storageKey, versionId, sha256, sizeBytes}` +
  `SourceAcquirer { acquire(sourceUrl): Promise<IngestionReceipt> }`; `processIngestionTask` (dòng 340-353) gọi
  `acquirer.acquire()` rồi mở gate. `grep processIngestionTask` toàn repo = **1 hit, chính định nghĩa** → chưa có ai chạy ingestion
  task, và **chưa có implementation nào của `SourceAcquirer`**. Đây chính là khoảng trống packet này giao.
- **(c) Phía tải bytes: đã có từ Mục 2** — `acquireSourceUrl` (bounded timeout/idle/byte cap trên byte đã giải nén, hop-bounded
  redirect, default fetcher là pinned egress nên SSRF fence là mặc định, hash + size verify, xóa file mọi đường lỗi).
- **(d) Vì sao `businesses/document-core` không sửa**: `IngestAction.prepareSources` (src/actions/ingest/index.ts:29-47) chỉ đọc
  `input.artifactIds`, và điều đó **đúng theo plan** (parse chỉ nhận artifact READY). Vấn đề thực nằm ở chỗ receipt không được
  truyền xuống task (Δ14) — sửa doc-core để tự đoán nguồn sẽ là viết code theo assumption chưa duyệt, vi phạm AGENTS mục 2.

**Mapping yêu cầu packet -> trạng thái:**

| # | Yêu cầu | Trạng thái cycle này |
|---|---|---|
| 2a | 202 URL submission tạo ingestion task; business task runnable chỉ khi source READY | **ĐÃ CÓ ở orchestrator** (đã kiểm chứng file:line ở 6.1a) — lane không sửa; phần data-path còn hở = Δ14 |
| 2b | Download HTTPS bounded (timeout/byte) + chặn private IP/link-local/metadata/redirect/rebinding | **CÓ** qua `acquireSourceUrl` (Mục 2) + **test mới chứng minh ingestion không làm yếu đi**: 4 destination literals + oversize + 404, tất cả **0 byte ghi xuống storage** |
| 2c | Tích hợp upload stream vào private S3 (offline: S3 mock fixture), SHA-256 + byte count pin bất biến | **MỚI: `createSourceAcquisitionIngestor`** + port `PinnedSourceStorage`; fixture versioned in-memory offline; chunk witness (>= 32 chunks cho object 2 MiB) |
| 2d | Retry không làm đổi SHA-256 đã pin; failed acquisition không tạo READY hay parse bytes dở | **MỚI**: `resolvePinned` trả bản đã pin **không touch network** (fetcher biết ném nếu bị gọi); mọi đường lỗi không trả receipt; test 4 case idempotence + 6 case fail-closed |

### 6.2 Đã triển khai

- **`SourceIngestionReceipt`** khai báo **shape-compatible** với `IngestionReceipt` của orchestrator (4 field, cùng tên) để host
  adapter nối thẳng mà không cần wire mới; **không** import `@du/orchestrator` (SDK không phụ thuộc service).
- **Port `PinnedSourceStorage` đúng 2 method**: `putVerified({storageKey, contentType, body, maxBytes, signal})` (MUST tạo version
  **mới bất biến** và báo lại digest + số byte nó giữ) và `resolvePinned(storageKey)` (read-only). Không có method nào khác, nên
  không có API thừa chờ người dùng.
- **`createSourceAcquisitionIngestor(options) -> { acquire(sourceUrl) }`** (đúng chữ `SourceAcquirer` của orchestrator):
  1. `reusePinned !== false` -> đọc pin trước; **hit = trả ngay, zero network, zero version mới**.
  2. miss -> `acquireSourceUrl(workspace, fileName, url, transfer)` (chuyển toàn bộ policy xuống lớp đã verify ở Mục 2).
  3. Đọc lại file bằng `createReadStream(highWaterMark 64 KiB)` **stream** sang `putVerified`, vừa đi vừa đo.
  4. **Ba phép đo phải khớp nhau** mới pin: digest của bytes acquired, digest của bytes thực gửi, digest storage báo về;
     cộng `storageKey` storage trả phải đúng key yêu cầu. Lệch bất kỳ -> `PIN_MISMATCH`, không receipt.
  5. `assertIngestionReceipt` chạy ở **producer**: chỉ nhận hex-64, size an toàn, key/version printable non-empty.
  6. `finally` dispose workspace khi ingestor sở hữu nó; lỗi không bao giờ trả receipt.
- **Error taxonomy** `SourceIngestionError`: `RECEIPT_INVALID` | `PIN_MISMATCH` | `STORAGE_FAILURE` | `TOO_LARGE`; message chỉ dùng
  `errorClassName` (ADM-BASE-03), **không** chứa URL/query/secret hay raw upstream string — có test pin điều này.
- **`reusePinned:false`** là đường opt-out có chủ đích cho re-ingest (tạo version mới), không phải tham số trang trí.

### 6.3 Guard -> test pin (suite `tests/source-ingestion.test.ts`, 20 test, 3 lớp)

| Guard packet yêu cầu | Test pin |
|---|---|
| Receipt chỉ có khi đo khớp 3 phía | `refuses to pin when storage reports a digest that disagrees`; `refuses to pin bytes storage committed under a different key` |
| Pin bất biến, không sửa được nữa | fixture versioned giữ **mỗi** version (`v1`, `v2`...) và test assert đúng số version sau từng kịch bản |
| Retry không đổi SHA-256 đã pin | `answers the pinned receipt without any network or storage write` (fetcher ném khi bị gọi); `keeps the pinned SHA-256 even when the URL now serves different bytes`; `reusePinned:false deliberately re-acquires into a NEW version`; `treats a corrupt pin as a fault instead of a licence to re-download` |
| SSRF: private/loopback/link-local/metadata/rebinding | `it.each` 4 destination literals qua **default pinned egress** (không inject fetcher) -> mọi case: 0 `putVerified`, 0 version |
| Bounded byte/time, nguồn từ chối | `produces no receipt and no version for an over-budget source` (TOO_LARGE + workspace sạch); `does not pin when the source answers an error status` (SOURCE_REJECTED) |
| Không buffer cả file trước khi gửi | `hands storage a STREAM, never one whole-object buffer` (đếm chunk phía storage >= 32 cho object 2 MiB) |
| Lỗi storage / pin lookup fail-closed | `maps a storage failure to STORAGE_FAILURE without echoing the URL`; `fails closed when the pinned lookup itself faults` |
| Full chain thật | `carries a 2 MiB document acquire -> stream -> pin over real loopback` (listener quiet band + pinned fetcher local-mesh; lần 2 trả **cùng receipt**, `listener.requests` vẫn 1, `versions` vẫn 1) |
| Receipt hợp lệ mới được tin | 2 test validator: chấp nhận + chuẩn hóa hoa/thường; từ chối 11 dạng hỏng |

### 6.4 Bằng chứng chạy (offline)

| Lệnh (cwd `D:\Git\dugate\du-rework`) | Kết quả | Exit Code: |
|---|---|---|
| `pnpm --filter @du/worker-sdk test -- tests/source-ingestion.test.ts` x3 | `Tests: 20 passed, 20 total` (sạch cả 3 lần) | 0 |
| `pnpm --filter @du/worker-sdk test` x4 | run 1: `Test Suites: 16 passed / Tests: 245 passed`; **run 2, 3, 4 đỏ** chỉ ở `tests/network-boundaries.boundary.test.ts` (Δ6) | 0 / 1 |
| `pnpm --filter @du/worker-sdk test -- tests/network-boundaries.boundary.test.ts` | `Tests: 6 passed, 6 total` (standalone xanh, xác nhận đỏ full-run không thuộc diff này) | 0 |
| `pnpm --filter @du/document-core test` x3 | run 1 và 3: `42 passed / 42 total`, `506 passed / 506 total`; **run 2 đỏ 1 test ở `tests/p8-03-provider-convergence.test.ts`** (Δ15/Δ16) | 0 / 1 |
| `pnpm --filter @du/document-core test -- tests/p8-03-provider-convergence.test.ts` x3 | run 1-2 `7 passed`, run 3 đỏ: `connect EADDRINUSE 127.0.0.1:5433` | 0 / 1 |
| `pnpm --filter @du/worker-sdk lint` (= `tsc --noEmit -p tsconfig.json`; package **không có** script `typecheck`) x3 | sạch | 0 |

**Baseline so sánh**: worker-sdk trước cycle này 15 suites / 225 tests (Mục 3/4); nay **16 suites / 245 tests** (+1 suite, +20 test) —
khớp đúng phần thêm của lane. Doc-core giữ nguyên 42/506 (không đổi gì).
**Định nghĩa win/lose**: PASS = suite mới 20/20 sạch 3/3 + lint 0 3/3 + doc-core không đổi kết quả. Đạt.
Hai lần đỏ full-package (worker-sdk Δ6, doc-core Δ15) là **đỏ của suite khác**, có bằng chứng chạy riêng lẻ ở bảng trên; lane không tự nâng thành xanh.

### 6.5 Hai điểm thành thật cần ghi

1. **Test fail đầu tiên là lỗi của chính lane, ở phía harness** (không phải bug product): fixture `makeStorageFixture` ban đầu chỉ
   ghi `versions` mà **không ghi pin**, nên `resolvePinned` trả null và lần gọi thứ hai tạo `v2` (test đòi `v1`). Sửa: fixture ghi pin
   khi commit, mô đúng bước pin-at-READY của DATA-01 (`artifacts.storage_version_id`). Sau sửa: 20/20 x3. Nếu lane đổ lỗi product
   cho chi tiết này thì sẽ là kết luận sai — nên ghi rõ.
2. `pnpm --filter @du/worker-sdk typecheck` packet nêu **không tồn tại** trong package (chỉ có `lint` = `tsc --noEmit`); lane dùng đúng
   lệnh có thật và ghi lại, không tạo script mới để khớp chữ trong packet.

### Δ-DEVIATION (chờ coordinator adjudicate — lane KHÔNG tự sửa)

- **Δ14 (mới, chặn end-to-end của DATA-03)** — **receipt đã pin không đến được tay business task**.
  `markIngestionReady` ghi `operations.input_ref = {...input, __source: receipt}` (submission.ts:317) nhưng ghi
  `tasks.payload_ref = JSON.stringify(input)` **không kèm receipt** (dòng 322-326). `grep '__source'` toàn repo = **1 hit, chính chỗ ghi**
  → **0 reader**. Hệ quả: task chạy được (`READY`) nhưng `IngestAction.prepareSources` (document-core
  src/actions/ingest/index.ts:29-47) chỉ đọc `input.artifactIds`, không có id nào, nên rơi vào
  `throw new Error('No input document or text provided for parse')` (dòng ~102) thay vì parse bản đã pin.
  **MISMATCH spec->code**: DATA-03 nói 'tải bounded vào S3 trước parse' — state gate đã có, **data path thì không**.
  Owner: Orchestrator/submission + contract owner quyết 1 trong 2: (i) ingestion tạo artifact row thật và put id vào task payload,
  hay (ii) chuyển `__source` vào payload worker nhận. Test cần chạy sau quyết định: cập nhật
  `services/orchestrator/tests/url-ingestion-offline.functional.test.ts` (hiện chỉ assert flip state, không assert payload có nguồn)
  + một ca document-core ingest-từ-URL.
- **Δ15 (mới)** — `businesses/document-core/tests/p8-03-provider-convergence.test.ts` **tự tuyên bố ở dòng 17**
  'Zero connections to shared DB (:5433) or Redis (:6380)' nhưng dòng 329-330 lại
  `new PgSqlClient({ connectionString: DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/...'} )` — tức **connect PG thật**
  (và theo luật fleet, suite này thuộc DB window của Tester-1). Khi cổng/instance :5433 đang bị tiến trình khác giữ, test
  `USE-01 live usage_events projection` đỏ với `connect EADDRINUSE 127.0.0.1:5433`. Bằng chứng: standalone 3 lần → 2 xanh 1 đỏ
  (lỗi port, không phải assertion). Lane không sửa vì file thuộc lane khác và nằm ngoài packet.
- **Δ16 (mới, bổ sung ngay vào phạm vi ACCEPTED của Mục 4)** — vì Δ15, nhãn '42 suite offline' của W-DOC-ISOLATE-1 cần đọc hẹp
  hơn: aggregate 42 suite gồm **41 suite thuần offline + 2 suite chạm hạ tầng live** (`p8-03-provider-convergence` connect PG :5433;
  `bullmq-smoke` đã ghi ở 4.4 là tự probe Redis :6380). Con số 42/506 exit 0 vẫn đúng và đã được Reviewer/Tester đối chứng, nhưng
  **độ tin của nó phụ thuộc trạng thái máy**. Khuyến nghị một gói nhỏ: hoặc nối dài `testPathIgnorePatterns` cho hai suite đó theo
  đúng tiền lệ đặt tên repo (`.db.test.ts`, ví dụ `services/connector/tests/revision-binding.db.test.ts`), hoặc sửa p8-03 dùng fake
  client để header dòng 17 thành đúng. Lane **không tự làm** vì động vào sẽ sửa lại phạm vi vừa được ACCEPTED của Mục 4.
- **Δ7 (Mục 2) cập nhật — không còn nguyên vẹn**: phần orchestrator admission/READY gate **đã có** (6.1a). Phần còn mở:
  (i) wiring acquirer + queue consumer cho ingestion task (`processIngestionTask` chưa có caller), (ii) Δ14 data path,
  (iii) cửa sổ live acquisition -> S3 -> READY cho Scenario B đã soạn ở runbook Mục 5.
- **Δ6 (cập nhật)**: suite R1-C `network-boundaries.boundary.test.ts` đỏ ở **3/4 full run** của cycle này (vị trí đỏ di chuyển:
  B3-lock-a, B3-lock-b, ADM-BASE-03, B-race), standalone **2/2 xanh**. Fix quiet-band 1 dòng vẫn chờ owner (qwen3).

### 6.6 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho producer leg của DATA-03 (packet vòng 2): bounded acquire -> stream -> pin bất biến ->
  receipt hợp lệ, cộng idempotence reuse-pinned và fail-closed ở mọi đường lỗi. Document-core: 0 thay đổi, có lý do.
- **KHÔNG ACCEPTED, DATA-03 vẫn [~]** vì: chưa có ai gọi `processIngestionTask` (không có queue consumer cho ingestion task),
  receipt chưa tới payload của business task (Δ14), và chưa có live acquisition -> S3 -> READY (cửa Tester, Scenario B runbook Mục 5).
- Không đụng DB/Redis/S3 live, không commit/push. Không có sản phẩm phụ nào còn lại trên đĩa (file .tmp đã xóa).

---

## 7 — PACKET W-DATA01-S3-FACADE-1: đóng Δ14 ở tầng envelope — canonical `IngestionReceipt` trong contracts, READY payload đồng nhất, binding pin↔bytes

**Thời điểm**: 2026-09-26. **cwd mọi lệnh**: D:\Git\dugate\du-rework. **Phạm vi packet**: khảo sát contracts + `IngestAction.prepareSources`, làm cho `markIngestionReady` và payload envelope resolve nhất quán, xác minh version-pin + SHA-256 trên đường artifact. **Files lane đã sửa** (không file Admin/OIDC nào, không suite nào của lane khác bị sửa):
- `packages/contracts/src/operations.ts` (thêm khối ingestion-source cuối file) + test mới `packages/contracts/tests/ingestion-receipt.test.ts` (20 test)
- `services/orchestrator/src/modules/operations/submission.ts` (receipt không còn là interface riêng; `markIngestionReady` ghi envelope)
- `packages/worker-sdk/src/source-ingestion.ts` (receipt = type contract; assert delegate schema)
- `businesses/document-core/src/types/actions.ts` + `src/validation/input-normalizer.ts` + `src/actions/ingest/index.ts` + test mới `tests/ingest-source-pin.test.ts` (14 test)

Không commit/push. Không DB/Redis/S3 live.

### 7.1 Hiện trạng khảo sát được (chỗ lệch Δ14, file:line)

- `IngestAction.prepareSources` chỉ đọc nguồn từ `input.artifactIds` (qua `ParserBudgetHelper.readArtifact`) — không có đường nào khác cho tới cycle này.
- Trước packet: `markIngestionReady` ghi `operations.input_ref = {...input, __source: receipt}` (submission.ts:317 cũ) nhưng `tasks.payload_ref = JSON.stringify(input)` **không receipt** (dòng 322-326 cũ). Trong khi đó worker resolve input bằng `input: hasChildPayload ? snapshot.payloadRef : snapshot.resolvedInputRef` (packages/worker-sdk/src/worker.ts:340) — payload rỗng thì đọc `operations.input_ref`, payload có chữ thì **mất pin**. "Source nằm ở đâu" có ba câu trả lời khác nhau tùy branch: đúng là lệch Δ14.
- Vì URL submission không mang `artifactIds`/`text`, business task sau READY rơi vào `throw new Error('No input document or text provided for parse')` — báo lỗi như thể người dùng quên input, trong khi lỗi thật là hạ tầng ingestion chưa resolve nguồn.
- Chiều "artifact row + id": bảng artifacts lưu key theo mẫu `art-<artifactId>` (artifacts.ts:133), finalize pin `storage_version_id` (artifacts.ts:281-292). Khóa `storageKey` do ingestion receipt mang (kiểu `du/tenants/.../source`) **không phải** một hàng artifacts; repo không có con đường INSERT artifacts nào cho ingestion → byte-resolution phía business worker cần artifactId, không tự suy từ storageKey một cách an toàn được.

### 7.2 Phán quyết lane thực thi theo packet (adjudication ghi công khai để Reviewer đối chiếu)

Packet chọn trường "payload envelope schema", nên lane đóng Δ14 theo hướng **(ii) receipt vào payload worker nhận**, kèm một handle vật chất hóa — cụ thể:

1. **contracts** là chủ shape: `IngestionReceiptSchema` (strict; `storageKey`/`versionId` in ấn được và không rỗng; `sha256` lowercase-hex 64; `sizeBytes` non-negative safe integer; **`artifactId?` uuid optional** — handle vật chất hóa để ingestion consumer ghi vào khi pinned version đã thành hàng artifact READY; resolve qua đường artifact-access bình thường, không parse prefix `art-` mong manh). Cùng khối: `assertIngestionReceipt`, `withIngestionSource`, `resolveIngestionSource`, hằng `INGESTION_SOURCE_FIELD = 'source'`, `LEGACY_INGESTION_SOURCE_FIELD = '__source'`, `IngestionReceiptError`.
2. **orchestrator**: `submission.ts` không định nghĩa receipt riêng nữa (`export type { IngestionReceipt } from '@du/contracts'`); `markIngestionReady` build envelope **một lần** bằng `withIngestionSource` (fail-closed TRƯỚC mọi write) và ghi **chuỗi byte-identical** vào cả `operations.input_ref` lẫn `tasks.payload_ref` → branch `payloadRef vs resolvedInputRef` của worker không bao giờ còn thấy hai câu chuyện khác nhau.
3. **worker-sdk**: `SourceIngestionReceipt` giờ LÀ type contract; `assertIngestionReceipt` delegate `IngestionReceiptSchema` (giữ normalization uppercase-hex thành lowercase, giữ nguyên mã lỗi `RECEIPT_INVALID` mà 20 test cycle 6 pin).
4. **document-core**: `IngestInput.source?: IngestionReceipt`. `normalizeIngest`: pin **thiếu = chuyện bình thường** của inline (trả null, không fail); pin **hỏng =** `ValidationError('INVALID_INGESTION_RECEIPT')`, không bao giờ im lặng bỏ qua; pin **có `artifactId`** mà task chưa có `artifactIds` → resolve thành `[artifactId]` (không ghi đè danh sách tường minh). `prepareSources`: khi pin tồn tại và có artifact đọc được, **buộc một artifact phải khớp cả digest lẫn độ dài của pin** (`SOURCE_PIN_MISMATCH`) — đóng khâu cuối "grant honest với chính nó" ↔ "artifact là đúng object gate đã pin". `executeRecipe` mode parse: pin không vật chất hóa → `BusinessExecutionError('INGESTION_SOURCE_UNRESOLVED')` thay vì error "no input document" đánh lạc hướng; đường inline rỗng vẫn giữ error cũ (tương thích history).

Legacy đọc được: hàng `__source` đã admit trước cutover vẫn resolve (`resolveIngestionSource` đọc `source` trước, `__source` sau); envelope mới luôn drop `__source` khi ghi.

### 7.3 Bất biến immutable version pin + SHA-256 — vị trí hiện có trong code (xác minh bằng inspection; không đường nào lane tự khai)

- **Write/finalize**: `verifyAndPin` rồi so 5 điều kiện (objectKey/versionId khong-null/không 'null'/size/digest) TRƯỚC khi ghi `storage_version_id` — artifacts.ts:274-292.
- **Read server-side**: proxy route stream đúng bản đã pin (docstring storage-facade.ts:4-8 "never return objectKey/versionId as a ..."; s3-storage-facade `openPinnedRead`/`verifyPinnedVersion` dòng 186-236, 932-941).
- **Grant descriptor**: `ArtifactAccessGrantSchema` mang `sizeBytes` + `sha256` (runtime.ts:226-237); worker `openGrantedRead` từ chối nếu descriptor tự mâu thuẫn và stream với `expectedSha256` → `HASH_MISMATCH` (task-context.ts:386-410) — test pin: `artifact-read-metadata.test.ts` ca 2.
- **Re-hash phía business**: `readBounded` hash đúng bytes landed và so với grant digest (parser-budget.ts:137-150, 209-238; cycle 5).
- **Mới (packet này)**: binding envelope-pin ↔ bytes đọc được trong `prepareSources` + validation schema ở CẢ producer, gate writer lẫn consumer — một schema, ba chỗ dùng.

### 7.4 Bảng bằng chứng (lệnh literal, exit code literal, ≥3 repeat cho mỗi lệnh targeted)

| # | Lệnh (cwd du-rework) | Kết quả | Exit |
|---|---|---|---|
| C1 | `pnpm --filter @du/contracts test` ×3 | 13 suites / **237 tests** passed, 0 failed, 0 skipped | 0, 0, 0 |
| C2 | `pnpm --filter @du/contracts lint && build` | tsc --noEmit sạch; dist rebuild (các package peer import schema mới) | 0, 0 |
| C3 | `pnpm --filter @du/worker-sdk test -- tests/source-acquisition.test.ts tests/artifact-read-metadata.test.ts` (lệnh literal packet §4) | 2 suites / 42 tests passed | 0 |
| C4 | `pnpm --filter @du/worker-sdk exec jest tests/source-ingestion tests/source-acquisition tests/artifact-read-metadata --runInBand` ×3 | 3 suites / **62 tests** passed ×3 | 0, 0, 0 |
| C5 | `pnpm --filter @du/worker-sdk test` (full) ×2 | run 1: 16/16, 245/245, exit 0 — run 2: 1 FAIL `network-boundaries.boundary.test.ts` B3-lock-a (Δ6; xem 7.5) | 0, 1(Δ6) |
| C6 | `pnpm --filter @du/worker-sdk lint` ×3 | exit 0 | 0, 0, 0 |
| C7 | `pnpm --filter @du/document-core exec jest tests/ingest-source-pin.test.ts` ×3 | 1 suite / **14 tests** passed ×3 | 0, 0, 0 |
| C8 | `pnpm --filter @du/document-core test` (full offline) ×2 | **43 suites / 520 tests** passed, 0 failed, 0 skipped (42→43 suite do suite mới của packet — xem Δ16' ở 7.5) | 0, 0 |
| C9 | `pnpm --filter @du/document-core lint` ×3 | exit 0 | 0, 0, 0 |
| C10 | `pnpm --filter @du/orchestrator exec jest tests/url-ingestion-offline.functional.test.ts` ×3 | 3/3 passed — suite hiện hữu KHÔNG bị sửa vẫn xanh sau đổi gate | 0, 0, 0 |
| C11 | `pnpm --filter @du/orchestrator lint` ×3 | exit 0 | 0, 0, 0 |

Repeat C5-run2 đỏ đúng suite Δ6 đã adjudicate từ cycle 2; standalone sample thêm 4 lần tại cycle này: FAIL(cap-unpaced), FAIL(B-race harness hygiene), PASS, PASS — chi tiết ở 7.5, lane không che.

### 7.5 Δ cập nhật và disclosure

- **Δ14 — ĐÓNG ở tầng envelope** (packet này): một field contract-declared `source`, hai hàng DB nhận cùng chuỗi byte-identical, consumer resolve + binding + fail-closed mọi nhánh lỗi. **Phần còn lại chuyển thành Δ17** (mới):
- **Δ17 (mới, owner Orchestrator/DATA — consumer)**: `processIngestionTask` vẫn **0 caller** (không queue consumer cho ingestion task); khi consumer tồn tại, nó phải (a) gọi `SourceAcquirer.acquire`, (b) vật chất hóa pinned version thành hàng artifacts READY (purpose='input', cùng tenant/operation) và đặt `artifactId` vào receipt TRƯỚC khi gọi `markIngestionReady` — envelope đã chừa đúng handle đó; không có bước (b) thì business task fail visibly bằng `INGESTION_SOURCE_UNRESOLVED` (hành vi test-pin), không im lặng.
- **Δ18 (mới, quyết định của coordinator nếu cần)**: envelope READY không còn mang `sourceUrl` (trước đây cũng không — nó chỉ sống trong wrapper pre-READY `tasks.payload_ref` và hàng outbox gate). Nếu nghiệp vụ cần provenance URL hiển thị ở business task, thêm field vào envelope là quyết định contract, lane không tự mở rộng quá packet yêu cầu.
- **Δ16' (đối soát aggregate W-DOC-ISOLATE-1)**: từ HEAD hiện tại, `pnpm --filter @du/document-core test` = **43 suites / 520 tests** (thêm `tests/ingest-source-pin.test.ts` đúng phạm vi packet này). Con số 42/506 trong receipt Mục 4 + tasks/README là **đúng theo thời điểm**; ai đối chứng lại sẽ thấy 43/520 — ghi ở đây để không thành "regression ảo".
- **Δ6 (cập nhật)**: full worker-sdk cycle này 1 xanh/1 đỏ; boundary standalone 4 mẫu: **2 xanh/2 đỏ, và ba lần đỏ rơi vào BA case khác nhau** (`cap-paced` → `TRANSPORT_FAILURE`, `cap-unpaced` → `TRANSPORT_FAILURE`, `B-race harness hygiene`) — fingerprint flake loopback Windows, không phải diff của lane (lane không sửa một dòng nào trong `artifact-streams.ts`/`source-acquisition.ts`/harness round này). Fix quiet-band 1 dòng vẫn chờ owner (qwen3).
- Instrument note cho packet sau: `pnpm --filter X test -- <file> <file>` **an toàn khi không có cờ nào trước positional** (`--` chỉ bị jest ăn làm regex khi còn cờ mảng xen giữa — bẫy cycle 4 không tái phát ở dạng này).
- Không sửa suite hiện hữu của bất kỳ lane nào; không đụng file Admin/OIDC; không mở cửa DB/Redis/S3; runner orchestrator chỉ chạy đúng suite offline liên quan (`test:unit` default của orchestrator chưa chạy full vì jest.unit.config có liveSuites riêng — ngoài phạm vi packet, giữ nguyên tắc offline-only).

### 7.6 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho W-DATA01-S3-FACADE-1: canonical `IngestionReceipt` + envelope helpers trong @du/contracts; `markIngestionReady` ghi đồng nhất hai hàng từ MỘT envelope đã validate (fail-closed trước write); document-core resolve pin, binding pin↔bytes, và hai đường lỗi mới đều typed (`INVALID_INGESTION_RECEIPT`, `SOURCE_PIN_MISMATCH`, `INGESTION_SOURCE_UNRESOLVED`). Tests: 237/237 contracts, 62/62 targeted worker-sdk, 14/14 pin suite, 43 suites/520 doc-core, url-ingestion-offline 3/3 không đổi; lint 0 trên cả 4 package.
- **KHÔNG ACCEPTED — đó là việc Reviewer**; DATA-03 vẫn `[~]` vì Δ17 (consumer + materialization chưa tồn tại) và chưa có live acquisition → S3 → READY (Scenario B, runbook Mục 5).

## 8 — PACKET W-DATA04-STREAM-BOUNDS-1: bounds đọc của read-path + abort xuống wire (DATA-04)

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **OFFLINE ONLY** — không cửa DB/Redis/S3, không commit/push. Toàn bộ evidence đi qua fetcher mock zero-socket (đúng bài học Δ8: witness bộ nhớ không được nuôi listener cùng process).

**File đã sửa** (2 file — đối chiếu mtime cuối cycle, xem 8.4 D7):
- `packages/worker-sdk/src/artifact-streams.ts` — cộng thêm `RequestScope.abort()` + guard consumer-abandon trong `openArtifactStream` + doc comment. KHÔNG đổi upload/multipart/ingestion path.
- `packages/worker-sdk/tests/artifact-stream-bounds.test.ts` — MỚI, 27 test, suite của lane.
- Hai suite packet chỉ định (`artifact-streams.test.ts`, `artifact-multipart-rss.test.ts`) **giữ nguyên từng byte**, chỉ chạy lại.

### 8.1 Rà soát read-path — cái gì đã có sẵn (file:line sau edit)

Facade `ctx.readStream` (task-context.ts:412) → `openGrantedRead` (task-context.ts:385: pre-check grant.sha256/sizeBytes TRƯỚC khi mở stream) → `openArtifactStream` (artifact-streams.ts:529). Tại seam đó:

- **highWaterMark tường minh**: `assertStreamLimits` (:899) chặn maxBytes ngoài safe-integer ≥ 0 và HWM ngoài [1 byte, 1 MiB]; default 64 KiB ghi tường minh (:569), áp cho CẢ hai phía meter (Transform) lẫn output (PassThrough trả cho consumer). `downloadArtifact` dùng counter Transform HWM mặc định Node 16 KiB — nghiêm ngặt hơn, lane KHÔNG nới (packet chỉ nhắm readStream).
- **Byte-limit watchdog**: pre-check Content-Length trước khi drain body (TOO_LARGE 413 / SIZE_MISMATCH 422, kèm `body.cancel()`); counter mid-stream trip đúng ngưỡng maxBytes; flush verify size + digest trước khi báo thành công.
- **Abort signal**: `createRequestScope` (:874) nối outer→inner NGAY CẢ khi outer đã abort từ trước (FIX-CR-08: phủ resolve→connect→headers→BODY→verify); signal đưa thẳng vào `fetch`; `onAbort` (:606) destroy cả ba stream bằng lỗi typed. Whole-body timeout đã có test pin trong suite hiện hữu (test 'slow', assert `cancelled === true`).
- **Gap còn lại — đúng ý "propagate immediately" của packet §1b**: consumer bỏ stream giữa chừng (`for await` + `break`, hoặc `stream.destroy()`) thì local pipe chết, pull dừng — nhưng **request scope của fetch KHÔNG bị abort**: transaction sống dai tới hạn timeout; với undici thật, việc nhả connection phụ thuộc đường cancel nội bộ của thân thể fromWeb. Chưa có code nào xử, chưa có test nào pin.

### 8.2 Đã triển khai (tối thiểu, additive)

- `RequestScope.abort()` (:891) — method mới trên interface export; hai consumer nội bộ của scope (`source-acquisition.ts`, `artifact-multipart.ts`) không sửa, không đổi hành vi; `streamTransportError(scope,...)` chỉ đọc `timedOut`/`signal` nên trơ với thay đổi này.
- `openArtifactStream`: guard `output.once('close', ...)` abort scope khi `readableEnded === false` (:611-613). Early close = không còn ai muốn byte → hủy trọn request, wire dừng. Drain tự nhiên KHÔNG abort — response đã trọn vẹn, abort muộn chỉ tổ bắn signal vô nghĩa.
- Doc comment của `openArtifactStream` và `RequestScope.abort` cập nhật semantics; không thêm logic nào khác vào file.

### 8.3 Yêu cầu packet → test pin (suite MỚI, 27 test)

| Yêu cầu §1 | Chỗ hiện thực | Test pin |
|---|---|---|
| highWaterMark tường minh | :569 default 64 KiB + :899 cap [1B, 1MiB] | 1 test default (assert `readableHighWaterMark` ngay trên stream trả về) + it.each 5 giá trị hợp lệ tới đúng 1 MiB + it.each 6 vector HWM hỏng + 5 vector maxBytes hỏng — **12 test, fetcher 0 lời gọi ở mọi vector từ chối** |
| byte-limit watchdog | pre-check CL + counter mid-stream + flush verify | 6 test: CL > maxBytes → 413 với `cancelled === true` và `pulled ≤ 1` (không drain); CL ≠ expectedSize → 422 cùng witnesses; nguồn 100 KiB với maxBytes 2500 → TOO_LARGE giữ `pulled < 100` (bounded chứng minh bằng pull-counting, không đo RSS); body thiếu size → SIZE_MISMATCH lúc flush; digest lệch → HASH_MISMATCH; golden path `pulled === 32` đúng một lượt |
| abort xuống fetch/stream | :874 outer→inner + :606 onAbort + guard MỚI :611 | 4 test: caller abort giữa body → TRANSPORT_FAILURE + `captured.signal.aborted === true` TRÊN CHÍNH signal handed to fetch + `cancelled === true` + pull dừng; pre-aborted → 0 byte, fetch nhận signal đã abort; **consumer abandon (break) → request scope bị abort** (pin của product change — counterfactual 8.4 D2); drain trọn → signal KHÔNG abort (guard chống abort muộn giả). Timeout đã pin sẵn ở suite hiện hữu, không duplicate |

### 8.4 Bằng chứng chạy (offline)

| # | Lệnh (cwd du-rework) | Kết quả | Exit |
|---|---|---|---|
| D0 | `pnpm --filter @du/worker-sdk test -- tests/artifact-stream-bounds.test.ts` (lần 1) | **ĐỎ disclosed**: test file dùng `stream.writableHighWaterMark` — TS2551 vì type khai báo là `Readable` (runtime là PassThrough). Vá test-only (bỏ 1 assertion, readable HWM đủ pin), không đụng product | 1 |
| D1 | cùng lệnh ×3 (sau vá) | 27/27 passed | 0, 0, 0 |
| D2 | **counterfactual**: tạm tắt guard bằng điều kiện `false &&`, chạy lại | pin `aborts the underlying request scope when the consumer abandons` **FAIL đúng 1 test** (`Expected: true, Received: false`, artifact-stream-bounds.test.ts:320), 26/27 còn lại xanh → pin phân biệt được product change, không pass-vở | 1 (dự đoán) |
| D3 | bật lại guard; `pnpm --filter @du/worker-sdk test -- tests/artifact-streams.test.ts tests/artifact-multipart-rss.test.ts` (lệnh literal packet §2) ×3 | 2 suites / **47 tests** passed ×3 — RSS suite (2 scenario 1 GiB, ceiling 8 parts) không đổi hành vi sau guard | 0, 0, 0 |
| D4 | `pnpm --filter @du/worker-sdk test` (full, packet §3) ×2 | **17 suites / 272 tests** passed cả 2 run; suite Δ6 (`network-boundaries.boundary.test.ts`) KHÔNG đỏ ở cycle này — ghi nhận quan sát, không tự đóng Δ6 | 0, 0 |
| D5 | `pnpm --filter @du/worker-sdk lint` ×3 | tsc --noEmit sạch | 0, 0, 0 |
| D6 | `pnpm --filter @du/worker-sdk build` | tsc -p exit 0 | 0 |
| D7 | mtime scope check `dir /o-d /t:w src\\*.ts tests\\*.ts` | đúng 2 file mang timestamp cửa sổ packet: `src/artifact-streams.ts` 11:56, `tests/artifact-stream-bounds.test.ts` 11:55; các file khác (kể cả `source-ingestion.ts` 11:08, `index.ts` 09:13) mang timestamp **trước** packet — không phải diff của cycle này | 0 |
| D8 | CJK scan 2 file sửa (`[\\u3400-\\u9fff\\u3040-\\u30ff]`) | `src/artifact-streams.ts` clean; `tests/artifact-stream-bounds.test.ts` clean | 0 |

### 8.5 Δ cập nhật

- **Δ16'' (đối soát aggregate worker-sdk)**: 16 suites/245 tests (receipt Mục 6–7) → **17/272** (Mục 8). Chênh lệch +1 suite/+27 test đúng bằng suite mới của packet này — ghi để đối chứng sau không thành "regression ảo" (tiền lệ Δ16').
- **Δ6**: full worker-sdk 2/2 xanh — mẫu thuận lợi, **không phải bằng chứng đã sửa**; owner quiet-band fix (qwen3) vẫn giữ nguyên.
- Không mở Δ mới. Không sửa suite lane khác, không đụng Admin/OIDC, không commit/push, không cửa DB/Redis/S3.

### 8.6 Kết luận cycle

- **IMPLEMENTED / VERIFIED-OFFLINE** cho W-DATA04-STREAM-BOUNDS-1: hai yêu cầu §1 được xác nhận **đã có** ở tầng code (audit file:line 8.1) và **nay có test pin** (12/6/4); gap thật duy nhất — consumer abandon không hủy wire — đã đóng bằng một method additive + guard 4 dòng, với counterfactual chứng minh pin phân biệt hành vi. Aggregate worker-sdk 17/272 ×2 exit 0; lint/build 0.
- **KHÔNG ACCEPTED — đó là việc Reviewer.** DATA-04 giữ `[~]`: route public binary phía orchestrator chưa có, Δ9 (business budget 10 MiB chờ §6 + seam `parseFile`) mở, cửa live §9 chưa chạy.
## 9 — PACKET W-DATA03-INGESTION-WIRING-1: nối acquisition vào pipeline ingestion (xử lý Δ17 tầng SDK), verify offline 3x

**Thời điểm**: 2026-09-26. **cwd lệnh**: D:\Git\dugate\du-rework. **Phạm vi packet ghi**: `packages/worker-sdk/src/source-ingestion.ts` (và `source-acquisition.ts`) + `tests/source-ingestion.test.ts`. **Thực tế sửa**: `src/source-ingestion.ts` (322→494 dòng), `src/index.ts` (khối exports source-ingestion), `tests/source-ingestion.test.ts` (493→834 dòng). `source-acquisition.ts` KHÔNG sửa — mọi guard §1 đã có sẵn và đã được pin từ Mục 2/6. Không commit/push. Không mở DB/Redis/S3 — chỉ port, adapter DB là việc của composition root.

### 9.1 Audit Δ17 trước khi sửa (bằng chứng grep, không suy đoán)

- `processIngestionTask` (services/orchestrator/src/modules/operations/submission.ts:351): **0 caller** — grep `processIngestionTask` toàn du-rework filter *.ts chỉ trả định nghĩa + 1 comment tham chiếu ở source-ingestion.ts.
- Chính hàm đó cũng KHÔNG set `receipt.artifactId`: nó persist nguyên receipt từ `acquirer.acquire`. Kể cả khi orchestrator nối caller, envelope READY vẫn thiếu handle ⇒ business task fail visible `INGESTION_SOURCE_UNRESOLVED` (businesses/document-core/src/actions/ingest/index.ts:129; pin tại tests/ingest-source-pin.test.ts:159).
- Producer leg (`createSourceAcquisitionIngestor`) đã đủ bốn lớp packet §1: bounded egress (pinned fetcher default), hop limit (`maxRedirects` mặc định 3, re-adjudicate từng hop), byte budget (Content-Length pre-check + mid-stream counter), hash check (`expectedSha256` timing-safe). Receipt đã là contract shape (`IngestionReceiptSchema`, Mục 7).
- ⇒ Gap thật = **act ở giữa**: acquire → materialize READY artifact row → đặt `artifactId` → gate-ready. Phần đó không cần DB để viết đúng — chỉ cần DB để chạy thật — nên SDK nhận DB qua port; toàn bộ flow pin offline được.

### 9.2 Implementation (additive; đường upload/multipart/ingest cũ byte-identical)

`createIngestionTaskHandler(deps)` trong source-ingestion.ts — ports thuần túy:
- `deps.acquirer`: structurally the Orchestrator's `SourceAcquirer` slot (`acquire(sourceUrl)`).
- `deps.materializeArtifact(task, receipt) → artifactId | echoed receipt | null`: cổng đăng ký hàng READY; composition root cài bằng DB adapter.
- Luồng: validate task (trước mọi socket) → acquire → **re-validate receipt qua contract TRƯỚC khi materializer chạm vào** (foreign acquirer không kịp nhét pin hỏng) → pin đã có `artifactId`? replay, không network, không row-write → materialize → merge CHỈ `artifactId` (phần còn lại là pin đã validate) → re-validate → trả receipt hoàn chỉnh cho `markIngestionReady`.
- Fail-closed: lỗi acquisition propagate typed nguyên trạng; materializer KHÔNG bao giờ được gọi (witness `calls==0` ở từng nhánh failure). Materialize trả null/undefined → `MATERIALIZATION_FAILED` (gate shut tại producer — đúng trạng thái Δ17 cấm mở). Echo lệch digest/size/key/version → `PIN_MISMATCH`. Handle không-UUID hoặc echo nửa-shape → contract quyết, `RECEIPT_INVALID`. Adapter throw raw → wrap typed, message không lộ URL/body/raw string (ADM-BASE-03 shape, pin bằng 3 not.toContain).
- Error-code union thêm 2 thành viên (`TASK_INVALID`, `MATERIALIZATION_FAILED`): additive — 17 grep refs của union/ingestor surface đều nằm trong worker-sdk, không consumer ngoài nào switch trên union.
- Hình dạng adapter khuyến nghị cho orchestrator (KHÔNG thuộc packet này, owner bước sau): `const acquirer: SourceAcquirer = { acquire: (url) => handler.run({ operationId, sourceUrl: url, input }) };` — `processIngestionTask` giữ nguyên chữ ký, receipt vào `markIngestionReady` đã mang `artifactId`, envelope `source` hợp lệ cho document-core.

### 9.3 Yêu cầu packet §2 → test pin (24 test mới; suite ingestion 20→44)

| Yêu cầu | Pin (tests/source-ingestion.test.ts, describe ingestion task handler) |
|---|---|
| Lưu lượng thành công: URL hợp lệ → tải về workspace → receipt đúng spec | runs the whole claimed-task flow — receipt = pin + `artifactId`; witness vật chất: `withIngestionSource(input, receipt)` đặt pin vào canonical field `source`, `__source` không tồn tại, `resolveIngestionSource` đọc lại đúng artifactId — chính là phép composition `markIngestionReady` làm, không cần DB |
| DNS loopback/private | never touches the row port for a fenced destination ×2 (`https://127.0.0.1:1/x`, `https://169.254.169.254/...`) → `DESTINATION_DENIED` 403, materialize 0 calls, puts 0 |
| Oversized stream | never materializes an over-budget source → `TOO_LARGE`, 0 versions |
| Redirect quá ngưỡng | never materializes a source that hops past the redirect bound (fetcher 302-chain ×4, maxRedirects mặc định 3) → `REDIRECT_LIMIT` |
| Sai sha256 | never materializes bytes that disagree with the expected digest → `HASH_MISMATCH` 422 + `expectNoWorkspaceLeft` |
| Dọn dẹp temp files | workspace sạch ở happy + hash-mismatch; các fail path của acquireSourceUrl đã xóa file (pin Mục 2/6 giữ nguyên, không sửa) |
| (Thêm, do audit Δ17) retry eventual-consistency | finishes the job on retry — run 1 lỗi materialize, pin + 1 version + 1 fetch; run 2 không network, không version trùng, receipt đủ artifactId. replays a fully materialized pin — pin có artifactId trả lời thẳng, materializer 0 calls |
| (Thêm) guard tầng task | refuses a malformed task before any socket ×5 (thiếu/blank operationId, blank url, URL chứa newline smuggle, input không-object) → `TASK_INVALID` trước fetcher; refuses a foreign acquirer that emits an uncontractual receipt |

### 9.4 Bằng chứng chạy (mỗi lệnh đúng nguyên văn; wrapper in `Exit Code:`)

| ID | Mẫu | Kết quả | Exit Code: |
|---|---|---|---|
| D0 | BASELINE trước sửa: lệnh §3 packet | 2 suites/60 tests (acquisition 40 + ingestion 20) | Exit Code: 0 |
| D1 | Run ĐẦU sau khi thêm 24 test — **ĐỎ, disclose**: 3 fail CẢ PHÍA PIN: (a) `message` không chứa code khi detail được set (constructor chỉ nhúng code khi thiếu detail — assertion của tôi sai kỳ vọng); (b+c) hai fence case dùng `http://` nên **scheme gate** trả lời trước (SCHEME_NOT_ALLOWED 422), egress fence không được chạm. **Phát hiện quan trọng**: describe SSRF fence cũ của CHÍNH suite này (Mục 2/6 để lại) cũng dùng `http://` + `rejects.toThrow()` lỏng — thực chất lâu nay chỉ test scheme gate. Đã nâng 4 case blocked-list sang `https://` và siết assert thành `{name: SourceAcquisitionError, code: DESTINATION_DENIED}`. Bài học cùng họ Mục 5.5: **assert lỏng giết bằng chứng phân tầng.** | Tests: 3 failed, 81 passed, 84 total | Exit Code: 1 |
| D2 | Lệnh §3 sau fix | 2 suites/84 tests (ingestion 44) | Exit Code: 0 |
| D3 | Counterfactual CF1: `describesSameBytes` ép `true || (...)` in-place | đỏ ĐÚNG 4 test drifted-on-the (digest/byte count/version handle/object key); 40 mẫu còn lại trong log đều xanh | Exit Code: 1 |
| D4 | Restore CF1 (xanh lại 4 drift) + counterfactual CF2: null-guard `if (false && ...)` | đỏ ĐÚNG 2 test keeps-the-gate-shut null/undefined (lỗi trôi sang RECEIPT_INVALID — chứng minh guard chịu trách nhiệm PHÂN LOẠI, không chỉ chặn) | Exit Code: 1 |
| D5 | Restore CF2; grep residue `false &&` / `true || (` = 0 matches trong package; **lệnh §3 packet ×3** | 2 suites/84 tests, cả 3 lần toàn xanh, thời gian 3.5-3.6s | Exit Code: 0 (lần 1, 2, 3) |
| D6 | `pnpm --filter @du/worker-sdk test` (full) ×3 | 17 suites/296 tests; **3/3 lần đỏ đúng 1 suite**: network-boundaries.boundary.test.ts, và là test KHÁC nhau mỗi lần (F1: B-race harness hygiene — artifact download failed (Error) tại downloadArtifact; F2: B3-lock-a TOO_LARGE→TRANSPORT_FAILURE race + FIX-CR-08 waitFor 500ms timeout; F3: FIX-CR-08 waitFor 500ms timeout). Cô lập suite boundary: ISO1 đỏ (FIX-CR-08), ISO2 xanh 6/6, mẫu thứ ba xanh 6/6. F3 in kèm `DIRECT-BAND-RSS peakMarginalExternal=-171.54MiB` (số ÂM — RSS baseline bị GC giữa phép đo, hệ thống under áp lực bất thường). Chữ ký flake định thời trên máy fleet chung; red xuất hiện khi boundary chạy ngay sau suite RSS 140s/525MiB trong cùng tiến trình runInBand. **Quy kết Δ6 (owner qwen3)** — KHÔNG file nào trên đường code của suite này bị cycle chạm: artifact-streams.ts mtime 11:56 (Mục 8), mock-listener.ts 09-25 23:06, boundary.test.ts 09-25 04:40. 16 suite còn lại xanh cả 3 full run. | Exit Code: 1 (cả 3 full run; 0 ở 2/3 mẫu cô lập) |
| D7 | `pnpm --filter @du/worker-sdk lint` ×3 (tsc --noEmit) | sạch | Exit Code: 0 ×3 |
| D8 | `pnpm --filter @du/worker-sdk build` ×1 | sạch | Exit Code: 0 |
| D9 | Scope check mtime src+tests: đúng 3 file cycle này chạm (source-ingestion.ts 12:42, source-ingestion.test.ts 12:40, index.ts 12:34); artifact-streams.ts 11:56 và toàn bộ file khác đứng nguyên. CJK scan trên 3 file sửa: clean. | — | — |

Không chạy document-core hay package khác (ngoài scope packet; không claim gì về chúng).

### 9.5 Cập nhật Δ register

- **Δ17 — [SDK-layer LANDED, chờ adjudicate]**: nửa consumer phía worker-sdk đã có hình + 24 pin (acquire → materializeArtifact port → `artifactId` → receipt gate-ready; replay idempotence; fail-visible vật chất tại producer). **Còn mở, owner Orchestrator/DATA**: (i) composition root gọi handler (adapter shape ở 9.2, hoặc thay body `processIngestionTask` bằng acquirer-backed handler), (ii) DB adapter materialize (artifacts row READY + version pin trỏ đúng `storageKey`/`versionId`), (iii) live acquisition→S3→READY (Scenario B, runbook Mục 5) thuộc Tester. Lane không tự mở (offline-only).
- **Δ19 MỚI (chờ coordinator adjudicate)** — thuật ngữ packet §1 (sha256 canonical, byteLength, storageRef, mimeType) lệch canonical `IngestionReceiptSchema`: `byteLength`→`sizeBytes`, `storageRef`→`storageKey`+`versionId`, còn **`mimeType` không tồn tại trong schema** (`.strict()` từ chối field lạ; Content-Type chỉ đi tới storage tại `putVerified.contentType`). Lane KHÔNG sửa contract (envelope đã được document-core pin ở Mục 7 — đụng schema là chiến tranh chéo). Nếu muốn provenance mimeType trên READY envelope, đó là quyết định contract chung với Δ18. Cùng họ Δ4 (lane bạn Qwen-Vault): packet viết theo ngôn ngữ plan cũ, code đã ratified shape mới.
- **Δ6 — bằng chứng mới (D6)**: flake không còn chỉ ở full run; cô lập cũng đỏ 1/3 mẫu khi fleet đông. Hai điểm va chạm: budget thời gian mỏng của FIX-CR-08 (`waitFor 500ms`, race `400ms`) và race cap-vs-teardown của B3-lock-a. One-line quiet-band fix của qwen3 vẫn chưa vào. Không tự sửa — file thuộc grant qwen3.
- **Δ16''' đối soát aggregate**: worker-sdk từ HEAD này = 17 suites/**296** tests = 272 (Mục 8) + đúng 24 test mới; suite ingestion đổi 20→44, acquisition giữ nguyên 40. KHÔNG phải regression ảo.

### 9.6 Kết luận packet

§1 đạt ở tầng SDK (handler hoàn chỉnh; source-acquisition.ts không cần sửa vì guard đã có và đã được pin — 4 lớp packet §1 liệt kê tại 9.1). §2 đạt: 24 test mới phủ đủ 4 luồng lỗi + happy + retry + guard task, và lane tự nâng 4 pin cũ của chính mình từ scheme-gate lên fence-layer. §3 đạt: lệnh packet ×3 exit 0, baseline 60→84; full-suite disclosed-red riêng Δ6 boundary (D6). §4 = mục này. **MỨC: IMPLEMENTED / VERIFIED-OFFLINE — KHÔNG ACCEPTED (phán quyết thuộc Reviewer); DATA-03 giữ `[~]`** vì composition root + live còn mở.
## Ledger

- 1 — W-DATA02-PUB-2 review+verify: submit guard READY-only và sweeper both-branch đã đủ + đúng; x3 exit 0 (82/82), lint 0, 0 diff source; mở Δ5 (ledger retention). — Mục 1.
- 2 — W-DATA03-ACQ-1: triển khai acquireSourceUrl (egress-pinned SSRF fence, hop-bounded redirect, byte/deadline/idle budget, hash verify, fail-closed) + suite 40 test 6/6 clean, lint 0 ×3, build 0; mở Δ6 (R1-C port-0 flake, fix 1 dòng cho owner) + Δ7 (DATA-03 server-side chưa có). — Mục 2.
- 3 — W-DATA04-STREAM-1: đóng khoảng trống 1 MiB-64 MiB phía client của T20-D1 (policy dải derive từ wire constant + một binary request có content-length, không multipart), chặn engine multipart vượt trần trước init, đặt trần RSS 64 MiB cho tầng business + đọc bounded một lần cấp phát; suite mới 12/12 ×3 + targeted doc-core 64/64 ×3 + full doc-core offline 498/498 + lint 0 ×3; vá regression build-dependency-order do chính Mục 2; mở Δ8 (RSS đo qua loopback bị phồng) + Δ9 (business còn chặn 10 MiB, cần §6 + parseFile), Δ6 vẫn đỏ 3/6 full run. — Mục 3.
- 4 — W-DOC-ISOLATE-1: `testPathIgnorePatterns` trong jest.config.cjs tách suite live khỏi runner offline (default `test` = 42 suite / 506 test / 0 skip / exit 0 ×3) + vá 2 script `test:integration` (jest lọc ignore sau khi match, và cờ array phải đặt SAU positional); mở Δ10 (chưa áp cho orchestrator/connector). — Mục 4.
- 6 — W-DATA03-ACQ-1 vòng 2: triển khai producer leg `createSourceAcquisitionIngestor` (bounded acquire -> stream -> pin bất biến -> receipt shape-compatible `IngestionReceipt`, reuse-pinned trả lại bản cũ với zero network, 3 phép đo phải khớp, fail-closed mọi đường lỗi) + 20 test offline, suite mới 20/20 x3, worker-sdk 16 suites/245 tests (đỏ full-run chỉ do Δ6), doc-core 42/506 (1 run đỏ vì Δ15), lint 0 x3; xác nhận Δ7 đã đóng MỘT PHẦN (orchestrator đã có admission + READY gate); mở Δ14 (receipt không tới task payload, 0 reader cho `__source`), Δ15 (p8-03connect PG thật trái comment dòng 17), Δ16 (42-suite aggregate có 2 suite chạm live). — Mục 6.
- 7 — W-DATA01-S3-FACADE-1: đóng Δ14 tầng envelope — canonical `IngestionReceipt`(+`artifactId?`) + `withIngestionSource`/`resolveIngestionSource` vào @du/contracts (test mới 20/20, contracts 13/237 ×3 exit 0); `markIngestionReady` ghi MỘT envelope đã validate (fail-closed trước write) byte-identical vào `operations.input_ref` + `tasks.payload_ref`; worker-sdk receipt = type contract, assert delegate schema (targeted 62 tests ×3 exit 0; full 16/245 xanh 1/2 — run đỏ duy nhất là Δ6 boundary, standalone 2G/2R trên 3 case khác nhau); document-core validate pin thiếu=inline bình thường, hỏng=`INVALID_INGESTION_RECEIPT`, `artifactId` resolve vào `artifactIds`, binding `SOURCE_PIN_MISMATCH`, fail-visible `INGESTION_SOURCE_UNRESOLVED` (suite mới 14/14 ×3; full 43/520 ×2; lint 0 ×3); orchestrator url-ingestion-offline giữ nguyên 3/3 ×3, lint 0 ×3; mở Δ17 (consumer+materialization chưa tồn tại — phần còn lại của DATA-03) và Δ18 (sourceUrl provenance); ghi đối soát 42→43 suites cho aggregate W-DOC-ISOLATE-1. — Mục 7.
- 5 — W-DATA-STATUS-S3-1: ghi ledger ACCEPTED cho W-DOC-ISOLATE-1 vào tasks/README.md (kèm đối chứng chạy lại 42/506 exit 0); kiểm chứng nguyên nhân S3 503/InvalidAccessKeyId tới file:line (S3Client không mang credentials + facade `catch {}` gom mọi lỗi về 503, mất tên lỗi) và đính chính bucket `du-uploads` (không phải bucket, chỉ là muối namespace ở multipart-service.ts:86); soạn docs/runbooks/data-02-public-uploads-live.md (preflight 6 bước + Scenario A 15 bước public uploads + Scenario B 7 bước DATA-03); tự đính chính phát biểu "0 route binary" ở Mục 3; mở Δ11 (mask lỗi S3), Δ12 (data-02-04-live-s3 không nằm trong liveSuites), Δ13 (không có MinIO trong infra). — Mục 5.
- 8 — W-DATA04-STREAM-BOUNDS-1: audit read-path — HWM tường minh (default 64 KiB, cap [1B,1MiB], :569/:899), watchdog byte (CL pre-check + mid-stream + flush verify), abort outer→inner→fetch đã có sẵn: nay 27 test pin mới (suite artifact-stream-bounds); gap thật "consumer abandon không hủy wire" đóng bằng RequestScope.abort() + guard readableEnded, có counterfactual (tắt guard → FAIL đúng 1 test, 26/27 xanh); packet-command 47/47 ×3 exit 0 (2 suite hiện hữu giữ nguyên từng byte), full worker-sdk 17/272 ×2 (Δ6 lặng — mẫu thuận lợi, không tự đóng), lint 0 ×3, build 0; red-run D0 (TS2551 test-only) disclosed; không mở Δ mới; ghi Δ16'' đối soát aggregate 16/245→17/272 đúng bằng suite mới. — Mục 8.
- 9 — W-DATA03-INGESTION-WIRING-1: `createIngestionTaskHandler` (Δ17 tầng SDK: acquire→materializeArtifact port→`artifactId`→gate-ready; 24 pin mới; packet cmd ×3 84/84 exit 0; CF đỏ đúng 4+2 test; full-red riêng Δ6 boundary — D6; Δ19 packet-vs-contract chờ adjudicate)
