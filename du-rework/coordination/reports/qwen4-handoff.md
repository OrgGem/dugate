# QWEN-4 HANDOFF — 2026-09-25 ~10:00Z

> [!IMPORTANT]
> **Đây là điểm phục hồi của lane Qwen-4** nếu context orchestrator bị xóa giữa chu kỳ. Qwen-4 là một lane
> trong chương trình điều phối du-rework; user đóng vai coordinator dispatch từng cycle. Ràng buộc thường trực:
> báo cáo vào `du-rework/coordination/reports/qwen4.md` (khối RESUME POINT ở đầu file, thêm block Δ mỗi cycle);
> trả lời bằng tiếng Việt; KHÔNG mở DB/Redis; KHÔNG commit/push; kết thúc mỗi cycle bằng một dòng `> /compress`.

## Trạng thái ngay sau Cycle 141

- **Cycle 141 = ADJUDICATION-ONLY (chỉ văn bản report, 0 sửa source, 0 test-run)** — ghi nhận phán quyết
  Reviewer chu kỳ 156–161 (qwen4.md `## Cycle 141` §16.1-16.3): **Safe offline Document-Core targeted :=
  2 suites / 56 tests PASS** (parser-budgets 48 + read-stream-acquisition 8) — **Zero DB writes, Tester-3
  verified**; `p8-03-provider-convergence.test.ts` (7 tests) có `PgSqlClient` ghi PG thật → **danh riêng cho
  DB Window của Tester-1**. Lane rule từ nay: chọn targeted offline KHÔNG kèm p8-03. Tester-3 cũng nghiệm
  thu độc lập Step C worker-sdk **171/171**.
- **Cycle 140 (Step C — SDK multipart auto-branch) = LANDED + ĐÃ BÁO CÁO + ĐÃ TESTER-3 XÁC NHẬN ĐỘC LẬP
  (qwen4.md `## Cycle 140`, §15.1-15.5). Đang chờ dispatch kế tiếp.**
- Repo `D:\Git\dugate`, workspace pnpm `D:\Git\dugate\du-rework` (packages/contracts, packages/worker-sdk,
  services/orchestrator, businesses/document-core). HEAD `7811298`, branch `codex/fix-workflow-builder`.
  TOÀN BỘ việc của lane nằm ở working-tree, chưa commit — và KHÔNG ĐƯỢC commit/push.
- Chuỗi cycle: W49-Q4-1 review (F1-F5 + 2 mismatch) → W49-Q4-2 soạn contract DATA-00-M (§2 schema, §3 route,
  §6 bảng policy CHƯA KÝ, §7 delta SDK, §12 kế hoạch 4 bước A-D) → **Cycle 138** Step A contracts-only LANDED
  (11 schema + 6 const vào `packages/contracts/src/runtime.ts`; 191/191) → **Cycle 138B** Step A document-core
  LANDED (6 call-site `worker.ts` → `writeEnvelopeArtifact` → facade `writeStream`; 38 suites/484) →
  **Cycle 139** Step B read-streaming LANDED (seam `ArtifactFacade.stat?` +
  `ParserBudgetHelper.readArtifactViaStream` disk-backed; 39/492; lệch §14.3: document-kit chỉ nhận Buffer,
  đã CỜ PR `parseFile(path)` cho coordinator) → **Cycle 140** Step C LANDED (chi tiết dưới).

### Footprint Cycle 140 (chỉ `packages/worker-sdk`)

- **MỚI `src/artifact-multipart.ts` (336 dòng)** — engine `uploadArtifactMultipart`:
  - Transport injection `{init, partGrant(artifactId,body), complete, abort}`; leaseEpoch do facade adapter
    tiêm vào (engine không biết lease); `uploadToken` = randomUUID mới MỖI call (khóa replay server-side).
  - `assertInitGeometry` kiểm geometry server-fix: cap bộ nhớ NỘI BỘ `MULTIPART_SDK_MAX_PART_BYTES = 64MiB`
    từ chối partSizeBytes quá rộng; partCount PHẢI = ceil(size/partSize).
  - Memory = ĐÚNG 1 part (giữ chunk bằng subarray); per-part sha + whole-object sha tính MỘT lượt.
  - Retry PUT: `partPutAttempts` default 3, backoff 50ms·n — retry transport/403/404/408/429/5xx/thiếu etag
    bằng re-grant + re-PUT; 4xx khác fail-fast. Receipts {partNumber, etag, sizeBytes, sha256} ascending.
  - SAU complete KHÔNG bao giờ abort (bytes đã commit server-side; ack disagreement → lỗi typed). TRƯỚC
    complete: abort best-effort — reason `cancelled` nếu signal aborted, else `failed`; lỗi abort swallow
    (TTL sweeper là lưới). ADM-BASE-03: partUrl không vào message; detail qua `readErrorDetail` allowlist.
    SSRF: `assertHttpUrl` chặn mọi PUT không http(s).
- **MỚI `tests/artifact-multipart.test.ts` (667 dòng, 21 test = 14 engine + 7 facade)** — fake transport +
  fake fetch hoàn toàn offline, 0 socket, ~3.5s.
- **SỬA `src/runtime-client.ts`**: +4 method `multipartInit/multipartPartGrant/multipartComplete/multipartAbort`
  (paths `/tasks/:id/artifacts/multipart` + `/artifacts/:id/multipart/{part,complete,abort}`; ack parse bằng
  schema Cycle 138).
- **SỬA `src/task-context.ts`**: `TaskContextDeps.multipartThresholdBytes?` + helper `writeStreamMultipart`
  + luật branch trong `writeStream`: `sizeBytes > threshold (default = maxArtifactBytes)` VÀ
  `>= MULTIPART_MIN_TOTAL_BYTES (64MiB+1)`; vượt `MULTIPART_MAX_TOTAL_BYTES (8GiB)` → Error 'artifact size
  exceeds the multipart wire ceiling'; gray-zone dưới floor → giữ Error legacy 'configured worker byte limit'
  (fail-closed). Finalize tái dùng route duy nhất (cạnh STAGING→READY); gate `committedOutputArtifactIds`
  không đổi.
- **SỬA `types.ts`** (`WorkerConfig.multipartThresholdBytes`), `worker.ts` (thread config→deps), `index.ts`
  (barrel engine + types + helper trước đây private), `artifact-streams.ts` (CHỈ thêm từ khóa `export` vào
  `assertHttpUrl/RequestScope/createRequestScope/streamTransportError/toNodeReadable/readErrorDetail` —
  zero đổi hành vi).
- **Receipt**: worker-sdk lint 0; suite mới 21/21; full jest **12 suites / 171 pass** (150 baseline + 21; run
  đầu 4 đỏ `network-boundaries.boundary` = flake real-listener Windows đã biết, vị trí đỏ DI CHUYỂN giữa
  run, standalone 6/6 — rule rerun §13.4); document-core lint 0 + test:typecheck 0 + 3 suite targeted 63/63
  (phân loại lại theo Cycle 141: safe offline chỉ 2 suites/56 — p8-03 thuộc DB window Tester-1).
  document-core KHÔNG đổi dòng nào = thiết kế §12-C (business không biết multipart tồn tại) được kiểm chứng.
- **Ghi chú adjudicate (§15.3)**: (a) lease-lost giữa upload ghi abort-reason `cancelled` vì
  `wrapLeaseErrors` abort signal TRƯỚC khi engine thấy lỗi — muốn reason riêng `lease-lost` cần thêm giá trị
  enum wire = việc contract lane, đã KHÔNG tự đổi; (b) part-concurrency = 1 (sequential), đề xuất 3 chờ §6;
  (c) cap 64MiB/part là nội bộ SDK PROPOSED, không phải wire; (d) timeout PUT part 60s, lifecycle theo
  RuntimeClient 10s; (e) nhắc lại Qwen-5 Δ7: ingress JSON cap 1MiB vs complete 10k receipts — an toàn ở
  part ≥ 8MiB (≤1000 receipts ≈130KB), PHẢI xét lại ingress nếu §6 ký part nhỏ hơn.

### Bối cảnh lane khác

- Qwen-5 W49-Q5-1: server-side DATA-02 đã ship (`multipart-service.ts` 892 dòng, 4 route tại
  `server.ts` ~:841-:875, migration `0015_artifact_multipart.sql`, 63 test offline, 7 lệch có chủ đích so với
  draft §3 — gồm authorize part/complete/abort theo task của artifact-row thay vì body.taskId; bỏ cột etag
  trong ledger; policy narrow-only, KHÔNG đặt tên env khi chờ §6; finalize 413 cap phân nhánh theo row).
- Tester-2 đã nghiệm thu Step A document-core (39 suites/486). **Tester-3 đã nghiệm thu độc lập Step C:
  worker-sdk 171/171 + doc-core safe-offline 2 suites/56** (Reviewer chu kỳ 156–161). DATA-01/02/04 vẫn
  `[~]` chờ cửa sổ live. Suite p8-03 (ghi PG) thuộc **DB Window của Tester-1**.

### PARKED — chờ coordinator, KHÔNG tự làm

1. Tester live §9.1-9.3: fixture >64MiB qua SDK branch này, response-loss per-step, adversarial part-set,
   đo RSS peak; kèm suite service-window (bullmq-smoke, multi-container e2e) + chốt rule rerun flake ADM-BASE-03.
2. Ký §6: threshold / trần 8GiB / TTL 24h / INLINE_READ_BYTES 1MiB / concurrency.
3. PR document-kit `parseFile(path)` (§14.3) — chìa khóa RSS-chunk-thật khi parse.
4. (tuỳ chọn) option `multipartPartConcurrency` khi cần tốc độ.
5. Step D (async envelope stringify) CHỈ khi có số đo.
6. Nhánh public `/api/v1/uploads` (§8) — KHÔNG thuộc lane này.

## Việc tiếp theo khi coordinator lên tiếng

- MỌI dispatch mới: đọc lại RESUME POINT đầu `qwen4.md` trước (mới nhất = Δ Cycle 141 → §16.3 cuối file;
  trạng thái implementation vẫn nằm ở §15 Cycle 140 — Cycle 141 chỉ là văn bản adjudication).
- §6 được ký → áp giá trị vào default worker-sdk + tham vấn đặt tên env orchestrator (việc lane Qwen-5).
- Được yêu cầu concurrency → mở rộng `MultipartUploadOptions` additive + test engine.
- Được yêu cầu packet `parseFile` → soạn từ §14.3 + §12-B.
- Tester báo đỏ trên đường multipart → soi cây retry/abort của engine trước (§15.3.1 nuance `cancelled`).

## Môi trường / lưu ý công cụ

- Windows cmd.exe. Tool `exec` = runtime JS: gọi `tools.<name>(...)`; KHÔNG viết annotation TS trong exec;
  nội dung lớn dựng bằng mảng line join('\n'), line bọc double-quote để tránh escape trap; một call fail/deny
  sẽ abort cả script — giữ probe mạo hiểm tách riêng.
- Full jest document-core PHẢI loại `bullmq-smoke` (Redis :6380 trên máy này đang sống → suite tự bật live)
  + `multi-container-e2e.integration`.
- `network-boundaries.boundary.test.ts` (worker-sdk) FLAKE on this machine (cold-socket race loopback thật,
  ~2/6 full run, vị trí đỏ di chuyển) — chạy lại riêng lẻ trước khi quy kết đỏ cho code.
- Kỷ luật báo cáo mỗi cycle: block Δ appended vào RESUME POINT đầu file + section `## Cycle NNN` đầy đủ ở
  cuối file; quét CJK-leak sau khi viết báo cáo tiếng Việt dài; kết thúc reply bằng `> /compress`.
