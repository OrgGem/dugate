# Qwen-Platform lane — receipts

## RESUME POINT (cuối cycle 22, 2026-09-28)
- Vai trò: Platform Core Coder (orchestrator runtime / queue dispatcher / lease recovery).
- Packet cycle 15: **Δ32 closure** (Mục 15) — test 'invalid credential source at the
  HTTP edge' viết lại với positive control + binding guard isolation + M2 mutation
  proof. 8/8 ×3 Exit 0; typecheck 0. f3 final SHA c2b19d73/18645/398.
  **W-ENC-01-SCHEMA BLOCKED** (task_185188e4ac99): packet không tồn tại trên disk;
  ADR-18 chưa freeze; ENC-00 [~]; 4 nhóm quyết định mở. Không ghi code.
- Δ-trạng thái cuối cycle 15: **Δ32 ĐÓNG** (cycle này), **Δ29 ĐÓNG** (Admin align),
  **Δ31 ĐÓNG** (cycle 14). **Δ30 VẪN MỞ** (docs/06:74, docs/20:39, 0019 header, neo
  server.ts 2556/2594/2629). **Δ35 MỞ** (flake ETIMEDOUT loopback, fleet load).
- Packet đã land offline: cycles 1–14 (xem Ledger).
- File cycle 14 (giữ nguyên): f3 connector-revision-http-offline.functional.test.ts
  c2b19d73/18645/398. server.ts 29c79b1a/3257.
- Cycle tiếp theo: append Mục 16, viết lại RESUME POINT block này.
- Neo server.ts hiện hành (re-grep trước khi tin): sentinel map 2529,
  bindOperationsListSortKey 2556, bindOperationsCursor 2594, listOperationsPage 2629,
  call site 2645, ORDER BY emit 2668.
- Bẫy mới cycle 15: probe console.log residue PHẢI xoá trước khi lấy evidence ×3.
  SHA cuối cùng (post-cleanup) mới là SHA ghi receipt.
- Δ-trạng thái cuối cycle 14: **Δ31 ĐÓNG** (cycle này), **Δ29 ĐÓNG** — lane Admin align
  harness lúc 07:29-07:30Z, verified by content (conformance assert literal; pagination
  :1743 nhận cả literal lẫn legacy $n). **Δ30 VẪN MỞ** (docs/06:74, docs/20:39, 0019
  header, neo server.ts 2556/2594/2629). **Δ32 MỞ + ưu tiên**: test 377-383 'invalid
  credential source at the HTTP edge' là ĐỎ-VÌ-LÝ-DO-SAI — 400 đến từ chặn binding chứ
  chưa từng chạm vaultKv2Refine của path '../etc'; đã đo: thêm binding vẫn 8/8 => bản
  sửa 1 dòng an toàn, chưa áp vì packet chỉ định 341/355. Assertion path-traversal ở
  HTTP edge đang không có coverage thật -> đừng để qua nhiều cycle.
- Bẫy mới cycle 14 (quan trọng hơn cả fix): packet có thể đưa NGUYÊN NHÂN SAI. Đã chạy
  thực nghiệm một biến: A = đúng change packet chỉ định -> vẫn 1 failed (bác bỏ bằng
  lệnh thật, không bằng lý luận); B = hypothesis của lane -> 8/8. Luôn revert byte-exact
  bằng SHA (012183af) giữa hai bước. Đừng nộp fix theo packet mà chưa chứng minh nó là
  nguyên nhân.
- Ciclo 13 giữ nguyên: bindOperationsListSortKey phát Const literal inline khớp 4/4
  index 0019; cursor boundary vẫn $-bound; server.ts 29c79b1a…/3257.
- Packet cycle 13: **W-INGEST-0019-2** (Mục 13) — bindOperationsListSortKey phát
  sentinel deadline_at thành Const literal inline ('0001-01-01T00:00:00.000Z'::
  timestamptz / '9999-12-31T23:59:59.999Z'::timestamptz) theo direction, khớp
  byte-4/4 với expression index 0019; bỏ params.push và bỏ tham số params; cursor
  boundary vẫn $-bound; migration 0019 không đụng (5129B, 8554cbba).
  tsc Exit Code: 0 (hai dạng lệnh). NHƯNG Δ29 mở: 14 test đỏ (deterministic x3)
  ở 3 suite Admin-lane vì harness của chúng GIẢI sentinel qua placeholder — ngoài
  phạm vi ghi của packet, chờ adjudicate. Δ30 (docs + 0019 header + neo dòng
  2547->2556 stale), Δ31 (connector VAULT-06 1 test đỏ pre-existing, untracked).
  CHƯA có bằng chứng offline cho continuity phân trang deadline_at với SQL mới.
  Không commit/push/window.
- Packet đã land offline: cycles 1–12 (xem Ledger) + **W-INGEST-PG-FAILCLOSED-1**
  (Mục 12/Section 12 — T180-D3: submit-time 422 UNSUPPORTED_STORAGE_BACKEND
  khi backend != s3, default fail-closed; server truyền một-nguồn-sự-thật;
  4 test failclosed-offline mới; url-ingestion-offline opt-in s3 tường minh;
  M1/M2 đỏ-đúng-cầu 2-test; Δ26–Δ28). Không commit/push/window.
- File cycle 12 (SHA node-split): submission.ts e100add8…/623; server.ts
  aaea7f44…/3248; tests/url-ingestion-backend-failclosed-offline.test.ts
  bfee81c3…/121; tests/url-ingestion-offline.functional.test.ts d96967a4…/65.
- Cycle-11 files (không đổi cycle 12): ingestion-consumer 4fcac325…/607;
  consumer-test b105d90b…/1213. Cycle-10: workflow 496c08cf…/439;
  conn-http-store 6cd185c4…/181; conn repository 723424c7…/739; conn
  services 7745693e…/408; conn http/server c4873605…/430; transition-test
  43bf569a…/391; bootstrap-test 12b69cc8…/324. Cycle-9: dispatcher
  f7ce4df4…/127; s3-adapter 5b5d04da…/122; package.json 7a5d54a1…/42;
  index.ts 7c04cccd…/187. Tests cũ: f1 85d1a916…/291, f2 1a96181d…/441,
  admin-audit 8cfdcf54…/407, f3 012183af…/398.
- FAILCLOSED TRUTH (cycle 12): submit từ-chối URL khi
  storageBackend !== 's3' (options ?? postgres — fail-closed default,
  Δ27) TRƯỚC mọi DB call (structurally zero-row); message giữ đúng
  packet. server.ts nối storageConfig.backend VÀO submission service —
  cùng điều kiện s3 với ingestionConsumer :395 ⇒ không còn limbo
  PENDING_INGESTION phía postgres (Δ13 cycle 9 đóng ở mức chính sách).
- FENCE TRUTH (cycle 11) giữ nguyên: attempt-token + FOR UPDATE +
  in-tx guard + COMPLETE/RETRY attempts=$2 + preempted-bucket +
  lease>deadline ctor guard + 4-cột artifact-verify (MATERIALIZATION_
  CONFLICT permanent, cast-code Δ24).
- TRANSITION TRUTH (cycle 10) giữ nguyên: initialBindings config (ctor
  fail-fast) + bootstrap ACTIVE-trực-tiếp fresh chain-key + replay
  converges; Δ20 ratify còn treo.
- JOIN TRUTH (cycle 9) + Envelope truths (cycles 4-8) giữ nguyên.
- Gate compile (Δ11): suite cycle 12 cũng không pinpoint; ts-jest gate;
  lint src phủ submission+server: Exit 0.
- LIVE gates mở của lane: (a) f1 re-run 7 tests (window DB, cycle 7);
  (b) Δ16-GOM (Tester window kế): statement cycles 9+10+11 + admitted
  422-path ở server-level (integration thật cần boot s3-vs-postgres ×2).
- Δ chờ coordinator: Δ3–Δ11, Δ13–Δ24 + cycle-12: Δ26 (điểm chặn =
  createSubmissionService vì submitOperation không tồn tại độc lập),
  Δ27 (default fail-closed postgres cho caller manual-create — harness
  URL phải tự truyền s3), Δ28 (message nguyên văn packet; problem+json
  render nhờ khuôn HttpError có sẵn, không đụng http/ingress).
- Trạng thái checkout: sạch mutation — submission.ts SHA khớp baseline
  e100add8, residue PROBE = 0. Không commit, không push, không window.
- Cycle tiếp theo: append Mục 15, viết lại RESUME POINT block này.
- Neo server.ts hiện hành (re-grep trước khi tin): sentinel map 2529,
  bindOperationsListSortKey 2556, bindOperationsCursor 2594, listOperationsPage 2629,
  call site 2645, ORDER BY emit 2668.
- Bẫy công cụ cycle 13 (ghi để đừng lặp): fake-DB của Admin lane ĐỌC hình thái
  SQL chứ không chỉ so chuỗi — đổi shape ORDER BY làm đỏ suite lane khác theo
  kiểu cascade 500, không phải assertion lệch. Trước khi ship packet đổi shape
  SQL, phải đếm harness parse SQL trong toàn suite, không chỉ suite của mình.
## Ledger
- 1 — W-PLAT-MM05-REARM-1: re-arm CAS re-xác minh eligibility tasks/operations lúc WRITE — Mục 1.
- 2 — W-PLAT-MM10-CANCEL-1: heartbeat từ chối gia hạn lease khi operation có cancel signal (read-time refuse + write-time fence + diagnostic ack) — Mục 2.
- 3 — W-PLAT-CLAIM-CANCEL-FLAG-1: claim snapshot phản ánh cancel signal của operation thay vì hard-code false (đóng Δ4) — Mục 3.
- 4 — W-ADMIN-AUDIT-TEST-ALIGN-1: admin-audit.test.ts align với page envelope 5 trường của /api/v1/admin/audit (đóng T130-A1) — Mục 4.
- 5 — W-ADMIN-BASE-AUDIT-ALIGN-1: admin-base-routes.test.ts test 6 align với page envelope của /api/v1/admin/audit (đóng Δ12) — Mục 5.
- 6 — W-ADMIN-APIKEY-ALIGN-1: test 5 admin-base-routes + M4 admin-action-rbac-live align buildApiKeyPage items-envelope (đóng red live T-CODEX-TEST-29 phía tests) — Mục 6.
- 7 — W-ADMIN-APIKEY-TENANT-SCOPE-1: test 5 f1 fetch ?tenantId=${TEST_TENANT} + probe empty-scope (đóng red live duy nhất T-CODEX-TEST-30 phía code; live re-run f1 còn mở) — Mục 7.
- 8 — W-VAULT-FIXTURE-ALIGN-1: seed() f3 mang binding tenant-a + accountId du-conn-openai-main (đóng 4 red BINDING_DENIED — audit Turn 160 HIGH 2); offline 8/8 ×3, không cần live gate — Mục 8.
- 9 — W-DATA03-CONSUMER-JOIN-1: production join gate ingestion — consumer outbox-sweep + S3 pin adapter + dispatcher exclusion + package promotion; offline 24/24 ×3, M1/M2 đỏ-đúng-cầu; Δ13–Δ17 + gate live-PG mới (Δ16) — Mục 9.
- 10 — W-VAULT-LEGACY-TRANSITION-1: transition legacy-unbound -> bound vault = config initialBindings + workflow 2-tầng + bootstrap single-tx fresh-chain-key (sửa trọn 3 khâu K1/K2/K3 của T170-V1); offline 13+11 mới, 80+137 gộp x3, M1/M2 đỏ-đúng-cầu; Δ18–Δ21 + Δ16-gom — Mục 10.
- 11 — W-INGEST-POST-LEASE-FENCE-1: post-lease ownership fence (attempt-token + FOR UPDATE + in-tx commit-guard, COMPLETE/RETRY-guarded, preempted-bucket, lease-bound) + artifact 4-column consistency (find/verify/re-read/multi=CONFLICT, permanent-escalate); 33/33 x3, M1/M2 do-dung-cau; Δ22–Δ25, live-PG gom ca 3 cycle — Muc 11.
- 12 — W-INGEST-PG-FAILCLOSED-1: T180-D3 submit-time fail-closed — 422 UNSUPPORTED_STORAGE_BACKEND khi backend != s3 (default postgres fail-closed), zero-DB-call trước mọi row; server một-nguồn-sự-thật; 7/7 x3 + collateral 60/60, M1/M2 do-dung-cau; Δ13(cu9)-DONG o muc chinh-sach; Δ26–Δ28 — Muc 12.
- 13 — W-INGEST-0019-2: deadline_at sentinel = Const literal inline trong ORDER BY + cursor predicate (khop 4/4 expression index 0019; bo params.push; boundary van param-bound); tsc 0 x2 dang lenh, byte-identity 0, route-SQL bat nguyen van; 14 test Admin do determinstic x3 ngoai pham vi ghi (Δ29), Δ30 docs/neo stale, Δ31 connector VAULT-06 pre-existing — Muc 13.
- 14 — W-VAULT-06-DELTA31: f3 raw POST thieu independent binding (tenantId/accountId) => route 400 truoc parse => stranded.revision undefined; packet typo-gia-thuyet bi bac bang thuc nghiem A (van 1 failed), B = 8/8; 8/8 x3 Exit 0, full offline run 11:12Z 74/74 + 1789 passed 0 failed, typecheck 0; Δ31 DONG (chu: do la f3 cua lane Platform, khong phai Vault lane), Δ29 DONG (lane Admin align 07:29Z), Δ32 MO (test 377-383 vacuous, da do), Δ35 MO (admin-error-boundary ETIMEDOUT = flake ephemeral-port, khong phai regression) — Muc 14.
- 15 — W-VAULT-06-DELTA32: f3 test 377-383 vacuous (400 tu binding guard, chua cham path rule) -> rewrite voi positive control + M2 mutation do dung cau (Expected 400 / Received 201); 8/8 x3 Exit 0; full offline 74/74; f3 SHA 8e7e8aa9/427; W-ENC-01-SCHEMA BLOCKED (ADR-18 chua freeze, packet khong ton tai) — Muc 15.
- 16 — W-ENC-01-SCHEMA: envelope encryption schemas (7 schemas + 2 constants) + 46 tests trong packages/contracts; 20 suites / 412 tests Exit 0; tsc Exit 0; Δ36-Δ39 — Muc 16.
- 17 — ENC-META-01: control-plane metadata crypto (metadata-crypto.ts 324d: AES-256-GCM + Vault Transit DEK + AAD bind tenant/slot/row) wire 9 call site trong runtime.ts; 23/23 x3 Exit 0, tsc 0, collateral 44/44, M1 do dung 4 binding test; Δ36 submit-side input_ref ngoai scope, Δ37 optional-param chua wiring, Δ38 contracts chua can, Δ39 outbox.payload de nguyen co y — Muc 17.
- 18 — W-ENC-04-WORKER-SDK: BLOCKED, KHONG code (operator chon thu hoi). 4 luong do: facade ENC-03 nam o services/orchestrator (ngoai scope); worker-sdk khong phu thuoc orchestrator + tsconfig rootDir=src nen import cheo bat kha thi (3 noi nhan services/orchestrator chi la comment); ClaimResultSchema khong mang field key nao nen worker chua co duong nhan DEK; packages/document-core khong ton tai (that la businesses/document-core). Can (a) chon cho cua facade, (b) chot co che DEK delivery, (c) sua duong dan packet truoc khi dispatch lai — Muc 18.
- 19 — W-ENC-04-SEAM: worker crypto seam — port trung thuc crypto-storage-facade (910d, cc7db569) + crypto-seam.ts (158d) binding tenant cua CLAIM + TaskContextDeps.crypto optional + single-PUT seal truoc khi bytes roi process (finalize nhan size/digest CIPHERTEXT) + 14 test; 14/14 x3 Exit 0, tsc 0, M1 do dung 2 test port-fidelity (12 test hanh vi KHONG bat duoc doi AAD) roi restore byte-exact; full 307/310, 3 do ngoai lai da chung minh doc lap; Δ43 khong lam dep port, Δ44 manifest chua co duong di, Δ45 chua co caller truyen crypto, Δ46 document-core ngoai scope — Muc 19.
- 20 — W-ENC-04-DOC-CORE: document-core ctx.crypto optional + StepCheckpointManager seal/mo trong suot + assertEncryptionAvailable fail-closed truoc step body + 9 test; FULL document-core 44/44 suite 529/529 test Exit 0 (43/520 + 1/9 khop), 9/9 x3, tsc 0; SUA LOI THAT: adapter feature-detect cryptoFor (method ton tai ca khi tat encryption) lam 3 suite do — them cryptoSeam() predicate; M2 base64-leak test van xanh -> them leaksSentinel() decode moi string; D44 D45 D47 van mo — chua deployment nao bat seam — Muc 20.
- 21 — W-INGEST-WIRE-01: ingest/ocr + ingest/digitize truyen TAI LIEU qua artifact reference da freeze (InvocationInput.artifacts) — bo hasBuffer boolean, them guard INGESTION_SOURCE_UNRESOLVED, prepareSources tra artifactIds that; sua 3 test cu chung minh sai (placeholder text) + 1 test moi voi PNG that; FULL document-core 45/45 suite 537/537 test Exit 0, tsc 0, 2 mutation probe dung tung nhanh + restore byte-exact; D48 connector-side fetch chua chung minh, D49 live multi-container con mo, D50 sua 3 test traceability can Reviewer — Muc 21.
- 22 — W-DATA-03-URL-ACQ: URL task chi chay duoc khi source READY — pin check chay BAT KI co pin (tru loi duong vong pin+inline text parse duoc text chua fetch), drop inlineText khi co pin; 1 test moi 5 case + 2 mutation probe dung muc tieu; FULL document-core 46/46 542/542 Exit 0, tsc 0, worker-sdk regression 84/84; D52 tighten co the lam task URL cu fail, D53 live multi-container con mo — Muc 22.
- 23 — W-DATA-03-ORCH-VERIFY: hai file test da ton tai (37/37 xanh san) nen cycle nao phai them THAT MOT LOP HANG: claim-boundary guard PENDING_INGESTION trong runtime.ts (dispatcher chi la routing, khong phai bien); 2 test claim-boundary (refuse + take NO lease / gate mo thi claim CUNG task do) + 5 cot lease + 4 nhanh router; targeted 42/42 x3 + x1 (Exit 0), consumer 35/35, M1 do dung muc tieu, restore byte-exact 902185d2; full suite 5 suite do ngoai lai (admin-shell/crypto-config/admin-error-boundary; oidc test mtime 22:29Z > runtime 22:13Z, grep khong co claimTask, 0 url-ingestion do); tsc 0; D54 write scope vuot 2 file test, D55 live-PG con mo (gop DATA-INT-01), D56 3 do admin-shell — Muc 23.
- 24 — W-ENC-04-DOC-CORE: BLOCKED, KHONG sua code san pham. (a) encrypted input stream KHONG the dat o document-core: worker-sdk write path seal roi upload CHI ciphertext, bo nonce/tag/aad/DEK (0 lan xuat hien), read path khong co decrypt -> bang chung that read() tra CIPHERTEXT (proof 1/1 PASS, silent data-loss); fix can sua worker-sdk + contracts + orchestrator = ngoai scope. (b) checkpoint lease: adapter khong mang leaseEpoch/leaseExpiresAt (0 match), khong co gi de validate. (c) da co tu cycle 20. doc-core 46/46 542/542 Exit 0, worker-sdk 19/19 312/312 Exit 0, tsc 0 ca 2; D57 BLOCKER, D58 khong bat seam, D59 cau hoi thiet ke AAD epoch — Muc 24.
- 25 — W-ENC-04-GRANT-SCHEMA: D57 muc 1 XONG. PACKET SAI TEN FILE: ArtifactAccessGrantSchema o runtime.ts:226, KHONG o operations.ts (grep 0 match) — operations.ts chua recipient-delivery envelope, khac storage envelope. StorageWrappedDekSchema + StorageEnvelopeRefSchema (mirror field-for-field EncryptedStorageObject, KHONG tai dung WrappedDekEnvelopeSchema vi 2 hinh DEK khac ten field: runtime vault-transit-provider.ts:42 = keyRef/keyVersion/ciphertext) + grant.encryption optional; 13 test moi; M1 opt-in 1 do, M2 byte-length 3 do (ca 2 don bien, restore byte-exact 71c0458e/395e0880); FULL contracts 23/23 462/462 Exit 0 (12 TS loi ngoai lai cua lane Cost da tu het), tsc contracts+orchestrator+worker-sdk 0; D60 hai hinh DEK cho quyet, D57 con muc 2-3, D44 chua dung; D59 DONG theo phan coordinator (KHONG rang buoc epoch vao AAD) — Muc 25.

## 1 — CYCLE 1: W-PLAT-MM05-REARM-1 (Queue Integrity re-arm CAS condition)

### Bối cảnh finding
Reviewer: re-arm CAS chỉ fence `dispatched_at` stamp (date_trunc ms) + `attempts < cap`, KHÔNG re-verify
task/operation còn eligible giữa lúc READ candidate (§2 predicate) và UPDATE. Cửa sổ race = BullMQ
`getJob` round-trip nằm giữa hai bước: cancel/terminal landing trong cửa sổ đó mà re-arm vẫn xoá stamp
⇒ dispatcher republish công việc không ai muốn nữa.

### Thay đổi
1. `runtime.ts` — `QUEUE_INTEGRITY_REARM_SQL` thêm guard write-time, MIRROR đúng §2 (không thêm bind param):
   ```sql
   AND EXISTS (
         SELECT 1
           FROM tasks t
           JOIN operations o ON o.id = t.operation_id
          WHERE t.id = outbox.aggregate_id
            AND t.state IN ('READY','QUEUED')
            AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
            AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
       )
   ```
   Guard fail ⇒ rowCount 0 ⇒ đếm vào `casSkipped` (kênh có sẵn, không đổi shape kết quả/health).
2. `tests/mm05-queue-integrity-sweep.test.ts`:
   - FakeRow thêm `task_state` / `lease_expires_at` / `op_state` (seed mặc định READY/null/RUNNING).
   - Fake UPDATE branch: capture SQL vào `rearmSqls` VÀ áp eligibility gate CHỈ KHI SQL thật sự chứa
     guard (detector `hasEligibilityGuard`) — để behavioural test ĐỎ nếu production drop guard.
   - Test mới + định nghĩa win/lose:
     a. `write-time re-check: task cancelled after the candidate read is NEVER re-armed (W-PLAT-MM05-REARM-1)`
        — WIN: casSkipped=1, rearmed=0, dispatched_at còn, attempts=1. LOSE: row bị re-arm (fence không chạy).
     b. `write-time re-check: operation reaching terminal after the candidate read is NEVER re-armed`
        — WIN: op_state='SUCCEEDED' ⇒ casSkipped=1, rearmed=0, stamp còn. LOSE: re-arm resurrection.
     c. `re-arm CAS carries the §2 eligibility re-check at write time (structural pin)`
        — WIN: re-arm SQL chứa đủ 6 clause guard (FROM tasks t / JOIN operations o ON o.id = t.operation_id /
          t.id = outbox.aggregate_id / t.state IN ('READY','QUEUED') / lease clause / o.state NOT IN terminal)
          + còn nguyên fence cũ (date_trunc stamp equality, `attempts < $3`) + KHÔNG có `$4`. LOSE: clause thiếu.
   - 8 test cũ giữ nguyên định nghĩa win/lose (re-arm bình thường, live job, CAS stamp, cap D1,
     Redis-error unconfirmed, fail-closed, candidate structural pin, batch 2-orphan).

### Negative control (mutation probe, chứng minh test bắt regression)
Tạm bẻ dòng `AND EXISTS (` thành biến thể không-detected, chạy sweep suite ⇒ **ĐỎ đúng 2 behavioural test**
(a: `expect casSkipped 1, received 0` — hàng bị re-arm resurrection; 9 test còn lại xanh). Sau đó RESTORE
văn bản gốc; xác minh grep residue = 0 match trong src/, và chain L1/L2 dưới xanh lại trên file đã restore.

### Bằng chứng (mỗi lệnh 3 lần liên tiếp, Exit Code literal từ wrapper)
```text
L1: pnpm --filter @du/orchestrator exec tsc --noEmit
    TSC_RUN_1 -> Exit Code: 0
    TSC_RUN_2 -> Exit Code: 0
    TSC_RUN_3 -> Exit Code: 0
L2: pnpm --filter @du/orchestrator test -- tests/mm05-queue-integrity-sweep.test.ts tests/mm05-queue-integrity-offline.functional.test.ts
    JEST_RUN_1 -> Exit Code: 0 | Test Suites: 2 passed, 2 total | Tests:       15 passed, 15 total
    JEST_RUN_2 -> Exit Code: 0 | Test Suites: 2 passed, 2 total | Tests:       15 passed, 15 total
    JEST_RUN_3 -> Exit Code: 0 | Test Suites: 2 passed, 2 total | Tests:       15 passed, 15 total
  (15 = 11 sweep [8 cũ + 3 mới] + 4 dispatcher-probe; số lấy từ output jest thật)
```

### Δ-DEVIATION (chờ coordinator adjudicate)
- **Δ1 — STEP 4 của packet chỉ 2 file KHÔNG TỒN TẠI** trong `services/orchestrator/tests/`:
  `admin-queue-integrity.test.ts`, `p8-02-runtime-reliability.test.ts` (đã glob xác nhận; `p8-02*`
  chỉ tồn tại ở `du-rework/tests/integration/` — live-gated, ngoài phạm vi OFFLINE ONLY).
  Lane chạy đúng chủ đích packet trên suite offline THẬT của MM-05:
  `mm05-queue-integrity-sweep.test.ts` + `mm05-queue-integrity-offline.functional.test.ts`.
- **Δ2 — docs/38 §3 snippet giờ cách điệu implementation nhiều hơn** (sketch `WHERE id = $1` chưa từng
  có stamp fence; fix này thêm eligibility write-guard). Đề xuất docs-lane sync §3 + bảng §5
  (dòng "Không revive task/op terminal": ghi rõ guard giờ tồn tại CẢ read predicate lẫn write CAS).
  Lane KHÔNG tự sửa docs (ngoài packet).

### Trạng thái (4 mức, tự đánh giá)
- Offline verify: **[PASS]** (điều kiện cert: 3× exit 0 literal, negative control đỏ-đúng-đối-tượng).
- Packet code objective: **[DONE offline]** — finding được đóng ở tầng SQL + pinned bằng test thật.
- Live confirmation: **[OPEN]** — p8-02c rearm-1..4 (đặc biệt rearm-3 terminal fence) cần DB window,
  quyền Tester; lane không claim.
- Docs sync: **[OPEN]** — Δ2, quyền docs-lane/coordinator.
- Không commit, không push, không DB/Redis window trong cycle này.

## 2 — CYCLE 2: W-PLAT-MM10-CANCEL-1 (heartbeat từ chối gia hạn lease khi cancel)

### Bối cảnh finding
Reviewer FR24-06 / MM-10: heartbeat fence epoch/state/lease nhưng khi operation có cancel signal
(`operations.cancel_requested=true` hoặc op state `CANCEL_REQUESTED`), heartbeatTask **vẫn gia hạn
lease_expires_at** và có thể trả `cancelRequested:false` stale.

### Root cause (chính xác hoá phát hiện của Reviewer)
Read `SELECT ... o.cancel_requested ... FOR UPDATE OF t` chỉ khoá ROW TASK; tx cancel update
operations TRƯỚC (không xung đột khoá này) rồi blocked UPDATE tasks phía sau ⇒ cancel commit lọt vào
cửa sổ SELECT→UPDATE: UPDATE lease (join operations) vẫn thấy conditions cũ thoả, lease bị gia hạn,
ack trả false từ bản read stale. Fix 3 tầng trong `heartbeatTask` (KHÔNG thêm bind param — $1..$4 giữ nguyên):
1. SELECT thêm `o.state AS op_state`; **read-time refuse trước khi ghi**: có cancel signal ⇒ return
   200 `{leaseExpiresAt: hiện tại (không gia hạn), cancelRequested: true}`, không phát UPDATE.
2. **write-time fence** trên UPDATE gia hạn: `AND NOT o.cancel_requested AND o.state <> 'CANCEL_REQUESTED'`.
3. rowCount=0 ⇒ **diagnostic SELECT**: cancel ⇒ ack graceful như (1); ngược lại 409 LEASE_LOST như cũ.
Chọn 200+flag thay vì 410: SDK heartbeat path (worker.ts `if (ack.cancelRequested) ctx.abort('cancel')`)
chỉ phản ứng với flag; 410 bị nuốt bởi catch isLeaseLost-only. **Hợp đồng MM-10b giữ y nguyên**: task
state CANCELLED vẫn 410 TASK_TERMINAL (assertActiveLease chạy trước cancel-check — có test chốt).

### Tests
- MỚI `tests/mm10-heartbeat-cancel-offline.test.ts` (9 test, fake conditional-mirror: fake chỉ áp
  cancel fence khi SQL production thực sự chứa guard ⇒ behavioural test ĐỎ nếu drop fence):
  T1 cancel_requested=true → refuse + ack true + zero writes; T2 soft CANCEL_REQUESTED → như T1;
  T3 op CANCELLED + task RUNNING (defensive) → như T1; **T4 race FR24-06** (cancel flip SAU SELECT) →
  UPDATE bị fence chặn, lease nguyên giá trị cũ, ack true; T5 không cancel → gia hạn bình thường, ack
  false; T6 stale epoch + cancel → 409 (không leak cancel cho worker cũ); T7 foreign business + cancel
  → 403; T8 task CANCELLED → 410 TASK_TERMINAL (MM-10b intact); T9 structural pin (SELECT có op_state
  + FOR UPDATE; UPDATE đủ fence mới + mọi fence cũ; `not /\$5/`).
- `tests/runtime-lease-fencing-offline.test.ts`: harness `makeExpiryDuringTransactionDb` capture
  first-read ĐÚNG MỘT LẦN (diagnostic SELECT mới không được ghi đè clockAtSelect/selectedLeaseActive);
  row fake thêm `op_state:'RUNNING'`. Semantics test cũ không đổi.

### Negative control (mutation probe M1)
M1 = xoá dòng write-fence khỏi UPDATE production. Dự đoán: đỏ ĐÚNG 2 test (T4 + T9), còn lại xanh.
Thực tế: `Tests: 2 failed, 7 passed` — T4 fail đúng signature FR24-06 cũ (fake gia hạn lease vì không
thấy guard, ack `cancelRequested:false`). Restore byte-exact, verify read_file + grep `MUTATION_PROBE`
trong src/ = 0 match. Sự cố ghi nhận: restore lần 1 fail vì anchor `($4::text IS NULL...)` trùng 3 nơi
→ file tạm thời thiếu fence vài phút; restore lại bằng anchor đặc thù (`RETURNING t.lease_expires_at`),
TOÀN BỘ evidence chain 3×3 chạy TRÊN FILE ĐÃ RESTORE.

### Evidence (offline, 3 run liên tiếp, literal exit codes từ wrapper)
```text
L1: pnpm --filter @du/orchestrator exec tsc --noEmit
    TSC_RUN_1 -> Exit Code: 0
    TSC_RUN_2 -> Exit Code: 0
    TSC_RUN_3 -> Exit Code: 0
L2: pnpm --filter @du/orchestrator test -- tests/mm10-heartbeat-cancel-offline.test.ts tests/runtime-lease-fencing-offline.test.ts tests/br08-cancel-resume-race-offline.test.ts tests/br12-isolation-offline.test.ts tests/mm05-queue-integrity-sweep.test.ts
    JEST_RUN_1 -> Exit Code: 0 | Test Suites: 5 passed, 5 total | Tests:       76 passed, 76 total
    JEST_RUN_2 -> Exit Code: 0 | Test Suites: 5 passed, 5 total | Tests:       76 passed, 76 total
    JEST_RUN_3 -> Exit Code: 0 | Test Suites: 5 passed, 5 total | Tests:       76 passed, 76 total
  (76 = mm10 9 + mm05-sweep 11 + lease-fencing/br08/br12 56; số thật từ output jest)
```

### Δ-DEVIATION (chờ coordinator adjudicate)
- **Δ3 (tái diễn Δ1)**: STEP 4 packet chỉ `tests/p8-02-runtime-reliability.test.ts` — KHÔNG tồn tại
  (glob xác nhận lần hai). Lane chạy suite offline thật chạm heartbeatTask + regression br08/br12 +
  mm05-sweep. Lưu ý thêm: `tests/runtime.test.ts` (flow heartbeat qua HTTP) là **WINDOW-GATED live**
  (cần DU_LIVE_INFRA=1, PG :5433/Redis :6380) → offline SKIP 97 test, lane KHÔNG tính xanh.
- **Δ4**: `buildClaimResult` hard-code `cancelRequested: false` trong claim snapshot (~runtime.ts:1443)
  — worker nhận flag false lúc claim kể cả op đã cancel_requested. Ngoài phạm vi packet (STEP 2 nêu đích danh heartbeatTask); đề xuất đóng bằng 1 dòng `o.cancel_requested` trong claim SELECT nếu coordinator
  duyệt — chạm snapshot contract nên lane không tự sửa.
- **Δ5**: saveStep không gia hạn lease ⇒ không có defect FR24-06 tại đó; checkpoint write khi cancel
  đang chạy bị fence terminal tự nhiên. Không sửa, đúng scope packet.

### Trạng thái (4 mức, tự đánh giá)
- Offline verify: **[PASS]** (3× exit-0 literal; negative control đỏ-đúng-đối-tượng; residue = 0).
- Packet code objective: **[DONE offline]** — "refuse renewal + cancelRequested:true" ở CẢ read-time
  lẫn write-time; ack không bao giờ là stale-false sau extension thành công (fence write-time là proof).
- Live confirmation: **[OPEN]** — heartbeat-vs-cancel thực trên DB window + `runtime.test.ts` live leg
  (quyền Tester); cộng gate cũ cycle 1 (p8-02c rearm-3).
- Docs sync: **[OPEN]** — lane không đụng docs.
- Không commit, không push, không DB/Redis window trong cycle này.

## 3 — CYCLE 3: W-PLAT-CLAIM-CANCEL-FLAG-1 (đóng Δ4 — claim snapshot phải phản ánh cancel signal)

### Bối cảnh
Δ4 lane báo lên ở Mục 2: `buildClaimResult` hard-code `cancelRequested: false` trong claim snapshot.
Coordinator duyệt bằng packet W-PLAT-CLAIM-CANCEL-FLAG-1 (cycle này).

### Ba phát hiện định hình thiết kế (đo trước, không đoán)
1. **Một điểm dựng snapshot duy nhất**: `ExecutionSnapshot` chỉ được tạo trong `buildClaimResult`
   (grep src/ → runtime.ts:1419 + 1450; không site nào khác) ⇒ sửa 1 chỗ, phủ CẢ HAI exit path của
   claim: replay idempotent (~dòng 269) và claim mới (~dòng 298).
2. **Cờ claim-time có đường tiêu thụ thật**: `packages/worker-sdk/src/worker.ts:323` đưa
   `snapshot.cancelRequested` vào `DefaultTaskContext`; `task-context.ts:157` set `cancelFlag` từ đó
   ⇒ handler đọc `ctx.cancelRequested` thấy true ngay từ t=0 (không phải flag treo không ai đọc).
3. **Không thêm read thứ hai, vì proof lock**: claim đọc dưới `FOR UPDATE OF t`; `cancelOperation`
   (lifecycle.ts:43-50) ghi operations + tasks trong CÙNG một tx và phải chờ chính row lock đó
   ⇒ trong lúc tx claim giữ lock, cancel KHÔNG THỂ commit. Giá trị claim đọc vì vậy không thể mâu thuẫn
   với một cancel đã commit tại thời điểm claim commit; cancel commit SAU đó rơi vào cửa sổ heartbeat —
   đã chặn bằng write-time fence ở cycle 2. Thêm read chỉ trả về cùng giá trị (khác bản chất FR24-06:
   ở đó write-fence làm ack mâu thuẫn với write bị từ chối, nên buộc phải đọc lại).

### Thay đổi (runtime.ts, đúng 2 chỗ; không đổi bind param, không đổi shape wire)
- **claim SELECT** thêm `o.cancel_requested AS op_cancel_requested, o.state AS op_state`
  (runtime.ts:242). `FOR UPDATE OF t` giữ nguyên; không có bind param mới.
- **buildClaimResult** thay hard-code bằng
  `cancelRequested: hasCancelSignal({ cancel_requested: Boolean(t.cancel_requested) || Boolean(t.op_cancel_requested), op_state: t.op_state })`
  ⇒ `hasCancelSignal` giờ là **một định nghĩa cancel duy nhất** cho 3 chỗ dùng (heartbeat read-refuse
   :332, heartbeat diagnostic :364, claim snapshot :1445) — hai kênh không thể bất đồng về "cancel".

### Reachability — nói thẳng, không thổi phồng
Với writer hiện tại, cờ true ở claim path **chưa quan sát được qua cancelOperation**: cancel đặt
`cancel_requested=true` + `op.state='CANCELLED'` + `tasks.state='CANCELLED'` trong một tx ⇒ mọi task của
op đã cancel bị chặn ở `terminalTask`/`terminalOp` → **410 TASK_TERMINAL trước khi tới buildClaimResult**
(T5/T6 chốt hành vi này). Giá trị thật của sửa đổi:
- op state **`CANCEL_REQUESTED`** (soft signal, flag chưa set): `operations.state` là text **không có
  CHECK constraint** (0001_platform_v1.sql) và admin đã model state này
  (`operation-view-models.ts:129,144`; `operation-section-data.ts:382,771`) ⇒ hợp lệ ở DB, chưa có writer.
  Claim giờ trả true thay vì nói dối false.
- Mọi writer tương lai đặt `cancel_requested` mà không cancel task row.
- Không có đường un-cancel: `resumeOperation` chỉ nhận WAITING_INPUT, cancel/resume serialize qua
  `operations FOR UPDATE` (đã verify br08) ⇒ không tồn tại state "cancel_requested=true mà op còn sống".

### Tests
MỚI `tests/mm10-claim-cancel-flag-offline.test.ts` (10 test). Fake dùng **conditional-projection
mirror**: fake CHỈ trao `op_cancel_requested`/`op_state` khi text SQL production thực sự project hai
alias (soi đúng semantics projection của PG) ⇒ xoá alias là behavioural test đỏ, không green-dummy.
Fake cũng **không** trao `cancel_requested` ở cấp task, vì `tasks` không có cột đó.
T1 cancel_requested=true trước claim → vẫn lấy lease (1 write) + snapshot true; T2 soft
CANCEL_REQUESTED → true; T3 không cancel → **false** (chống biến flag thành hằng số); T4 replay path
(cùng deliveryId) → true + zero writes; T5 task CANCELLED → 410 TASK_TERMINAL; T6 op CANCELLED + task
RUNNING → 410 (terminal guard thắng, không suy thoái thành "claim OK + flag"); T7 foreign business →
403 (BR-12 chạy trước); T8 `ClaimResultSchema.parse` giữ nguyên `cancelRequested:true` (zod
`default(false)` không nuốt true — chứng cớ wire không cần đổi); T9 structural pin (claim SELECT đủ 2
alias + `FOR UPDATE OF t` + `not /$12/`; claim UPDATE còn nguyên `lease_epoch=$2`,
`state='RUNNING'`, `attempt = attempt + 1` + `not /$6/`); T10 self-check của chính mirror.
KHÔNG sửa suite nào khác: fake trong `runtime-lease-fencing-offline` không có 2 key mới ⇒ semantics cũ
giữ nguyên (đã xác nhận bằng 3 run, không cần adaptation harness như cycle 2).

### Negative control (2 mutation probe — dự đoán số đỏ TRƯỚC khi chạy)
- **M1** = bỏ 2 alias khỏi claim SELECT. Dự đoán: đỏ ĐÚNG 5 (T1,T2,T4,T8,T9). Thực tế:
  `Tests: 5 failed, 5 passed, 10 total`; T1/T2/T4/T8 fail `Expected: true / Received: false`,
  T9 fail `Expected substring: "o.cancel_requested AS op_cancel_requested"` — đúng signature hành vi cũ.
- **M2** = hard-code `cancelRequested: false` trở lại (giữ projection). Dự đoán: đỏ ĐÚNG 4
  (T1,T2,T4,T8), T9 vẫn xanh vì nó chỉ pin SELECT. Thực tế: `Tests: 4 failed, 6 passed, 10 total`.
⇒ behavioural test bám cả **projection** lẫn **consumer**. Restore byte-exact sau từng probe; verify
read_file (dòng 242 còn nguyên; tổng 1481 dòng như trước probe) + grep
`MUTATION_PROBE|XXX|TODO-REMOVE` trong runtime.ts = **0 match**. Không sự cố anchor nào: cả 2 anchor đều
được grep = 1 match TRƯỚC khi sửa (rút kinh nghiệm cycle 2).

### Evidence (offline, 3 run liên tiếp; literal exit code từ wrapper; chạy TRÊN FILE ĐÃ RESTORE)
```text
L1: pnpm --filter @du/orchestrator exec tsc --noEmit
    TSC_RUN_1 -> Exit Code: 0
    TSC_RUN_2 -> Exit Code: 0
    TSC_RUN_3 -> Exit Code: 0
L2: pnpm --filter @du/orchestrator test -- tests/mm10-heartbeat-cancel-offline.test.ts tests/mm10-claim-cancel-flag-offline.test.ts tests/runtime-lease-fencing-offline.test.ts tests/br08-cancel-resume-race-offline.test.ts tests/br12-isolation-offline.test.ts tests/mm05-queue-integrity-sweep.test.ts
    JEST_RUN_1 -> Exit Code: 0 | Test Suites: 6 passed, 6 total | Tests:       86 passed, 86 total
    JEST_RUN_2 -> Exit Code: 0 | Test Suites: 6 passed, 6 total | Tests:       86 passed, 86 total
    JEST_RUN_3 -> Exit Code: 0 | Test Suites: 6 passed, 6 total | Tests:       86 passed, 86 total
  (86 = mm10-heartbeat 9 + mm10-claim 10 + mm05-sweep 11 + lease-fencing/br08/br12 56 — số thật từ
   output jest; 0 skip trong các suite đã chạy)
```

### Δ-DEVIATION (chờ coordinator adjudicate)
- **Δ6**: STEP 4 packet chỉ `tests/mm10-cancel-heartbeat-offline.test.ts` — **không tồn tại**; tên thật
  là `tests/mm10-heartbeat-cancel-offline.test.ts` (đảo thứ tự từ). Lane chạy file thật (9 test, PASS).
  Đây là lần thứ BA packet chiếu tên file test không có thật (Δ1 cycle 1, Δ3 cycle 2, Δ6 cycle 3) —
  đề xuất coordinator sinh danh sách file bằng glob thay vì gõ tay.
- **Δ7**: STEP 2 cho công thức `Boolean(t.cancel_requested || t.op_cancel_requested)`. `tasks` **không
  có** cột `cancel_requested` (chỉ `operations` — migration 0003_artifacts_grants.sql:37) ⇒ vế đầu luôn
  undefined. Lane giữ nguyên văn vế đó (miễn phí: `SELECT t.*` sẽ tự mang nó nếu sau này thêm cột) và
  ghi rõ ở đây để không ai tưởng claim path đọc cờ cấp task. Lane **mở rộng** so với packet: đưa qua
  `hasCancelSignal` ⇒ nhận thêm `op_state IN ('CANCEL_REQUESTED','CANCELLED')`, đúng ý STEP 3
  ("operation có cancel") và giữ claim/heartbeat cùng một định nghĩa. Nếu coordinator muốn đúng nghĩa
  đen 2-term, lane đổi trong 1 phút.
- **Δ8**: STEP 3 giả định "worker/SDK abort sớm thay vì chạy mù". Đo trong worker-sdk: cờ đi tới
  `ctx.cancelRequested` (worker.ts:323 → task-context.ts:157) nhưng SDK **không** gọi
  `ctx.abort('cancel')` lúc claim ⇒ `ctx.signal` vẫn không aborted; chỉ handler chủ động đọc
  `ctx.cancelRequested` mới bail sớm, handler không đọc vẫn chạy tới heartbeat kế tiếp (đã fence, cycle 2).
  Abort cưỡng bức = 1 dòng trong `packages/worker-sdk/src/worker.ts` (quyền lane Qwen-4, lane không tự sửa).
- **Δ9**: STEP 4 ghi `npx tsc --noEmit` nhưng `du-rework/` root không có tsconfig (tsconfig package ở
  `services/orchestrator/`) ⇒ lane dùng `pnpm --filter @du/orchestrator exec tsc --noEmit` như cycle 1–2
  để chắc chắn check đúng package. STEP 4 cũng chỉ MỘT suite heartbeat; lane thêm 5 suite regression vì
  `buildClaimResult` dùng chung cho mọi claim path.
- **Δ10 (informational, không cần sửa)**: packet không nêu nhưng lane ghi rõ — claim khi op có cancel
  signal **vẫn cho phép claim**, chỉ gắn cờ. Từ chối vẫn là việc của terminal guard (410). Nếu coordinator
  muốn claim fail-fast 410 cho cả soft `CANCEL_REQUESTED`, đó là thay đổi hành vi khác, cần gate riêng.

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — tsc ×3 exit 0; jest 6 suite / 86 test ×3 exit 0; 0 skip trong các suite đã
  chạy; 2 negative control đỏ đúng số dự đoán; grep residue = 0.
- **Packet code objective: [DONE offline]** — STEP 1/2/3 đã land; STEP 4/5/6 đã chạy (Δ6/Δ9 cho lệnh).
- **Live confirmation: [OPEN]** — cần DB window: claim một op đang bay cancel + assert snapshot
  `cancelRequested` (Tester). `runtime.test.ts` vẫn là WINDOW-GATED live (DU_LIVE_INFRA=1) ⇒ offline
  SKIP, không tính xanh. Gate cũ còn mở: live p8-02c rearm-3 + live heartbeat leg.
- **Docs sync: [OPEN]** — nếu docs có section MM-10/Δ4 thì thuộc docs lane.
- Không commit, không push, không mở DB/Redis window trong cycle này.

## 4 — CYCLE 4: W-ADMIN-AUDIT-TEST-ALIGN-1 (admin-audit.test.ts ↔ page envelope, T130-A1)

### Bối cảnh finding
Reviewer Codex Turn 130, finding T130-A1: `GET /api/v1/admin/audit` đã migrate sang page envelope
chuẩn 5 trường `{ items, nextCursor, prevCursor, total, limit }` từ W-ADMUX02-EXT-1 (handler
`server.ts:1950–1976` → `listAuditEventPage` → `listPage` của `@du/contracts`; bình luận
`server.ts:1944–1945` ghi rõ shape `{ tenantId, events }` cũ đã bỏ). `tests/admin-audit.test.ts` vẫn
đọc shape cũ ⇒ trong DB window thật suite sẽ ĐỎ (assert `body.tenantId` trên field không tồn tại).
Packet chỉ sửa TEST; không đụng src.

### Thay đổi (7 hunk trong `tests/admin-audit.test.ts`, 393→407 dòng)
1. **Interface `AuditEnvelope` (:137–143)** — đúng nguyên văn packet: `items`/`nextCursor`/
   `prevCursor`/`total`/`limit`. Đã đối chiếu `ListPageBaseSchema`
   (`packages/contracts/src/public-api.ts:322–328`) và `AdminAuditPageSchema` (.strict, :364) —
   khớp 5 field. `AuditWireEvent` 8 field đã khớp `toAuditWire` của route (`server.ts:2803–2814`),
   giữ nguyên.
2. **Test 1 (:192–201)**: `body.tenantId` + `Array.isArray(body.events)` → `Array.isArray
   (body.items)` + `items.length > 0` + vòng lặp fence `e.tenantId === TENANT_A` cho MỌI item
   (thay echo envelope bằng đúng tính chất fence mà nó đại diện).
3. **Test 2 (:229–237)**: 4 lần đọc cross-tenant `some(...)` + loop → `.items`; ngữ nghĩa
   tenant-fence và comment giữ nguyên.
4. **Test 3 (:240–259)**: `full/capped/one .events` → `.items`; THÊM
   `expect(capped.total).toBeGreaterThanOrEqual(full.items.length)` — `total` đếm toàn bộ
   population đã lọc, không bị limit cắt (`keysetPage` chạy COUNT riêng, `server.ts:2784–2785`).
5. **R3-02 platform bearer (:355–362)**: `a/b.tenantId` → `items.length > 0` cho cả hai tenant +
   fence loop từng tenant.
6. **R3-02 bearer reads A (:368–371)**: `body.tenantId` → `items.length > 0`; `body.events.length`
   → `body.items.length`; THÊM `expect(body.limit).toBeGreaterThanOrEqual(1)`
   (`parseAdminAuditListQuery` clamp limit 1..200, default 50).
7. **R3-02 no-param (:385–390)**: `body.tenantId` → `items.length > 0` + fence loop — chứng minh
   scope bị pin đúng A, không empty-by-accident (tương đương 100% ý nghĩa echo cũ).

Grep residue sau edit: `.events` = 0 match; `.tenantId` chỉ còn ở vị trí hợp lệ (per-item,
interface, URL query, comment).

### Verify offline
- **Gate compile THẬT của file này là ts-jest, không phải tsc của packet** (Δ11): chạy
  `pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts` offline ⇒ file được transform
  (lỗi type = suite FAIL), mọi describe WINDOW-GATED ⇒ SKIP. Exit 0 = compile sạch.
- **Negative control M1** (chứng minh gate không rỗng): đổi lại `body.events` tại :199 → ĐỎ đúng
  dự đoán: `error TS2339: Property 'events' does not exist on type 'AuditEnvelope'` (:199:26),
  `Test Suites: 1 failed`, Exit Code: 1. Restore byte-exact: sha256
  8cfdcf5487722aeefe274a095db50536816248aeb89af03e245c6886be8ec216, 407 dòng (hash trước/sau khớp).

### Evidence (3 lần liên tiếp, literal từ wrapper output)
```text
L1 (packet step 4): pnpm --filter @du/orchestrator exec tsc --noEmit
   TSC_RUN_1 -> Exit Code: 0
   TSC_RUN_2 -> Exit Code: 0
   TSC_RUN_3 -> Exit Code: 0
L2 (gate thật cho file edited): pnpm --filter @du/orchestrator test -- tests/admin-audit.test.ts
   JEST_RUN_1 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 11 skipped, 11 total
   JEST_RUN_2 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 11 skipped, 11 total
   JEST_RUN_3 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 11 skipped, 11 total
```
Ghi chú trung thực: L2 ghi nhận 11 test **COMPILED nhưng SKIPPED** (file là live suite, offline
không chạy) — KHÔNG phải test xanh hành vi. Hành vi thật chờ DB window.

### Collateral run — báo cáo, không absorption
`pnpm --filter @du/orchestrator test:unit` (full offline, jest.unit.config.cjs):
`Test Suites: 3 failed, 2 skipped, 63 passed, 66 of 68 total | Tests: 11 failed, 21 skipped,
1564 passed | Exit Code: 1`. Ba suite đỏ KHÔNG phải file của lane này và không import file lane
đã sửa (`admin-audit.test.ts` nằm trong danh sách liveSuites loại trừ của jest.unit.config.cjs ⇒
không được load trong run đó). Chữ ký lỗi:
- `connector-revision-http-offline.functional.test.ts` (4 test): VAULT-06 —
  `BINDING_DENIED connector ownership binding is unavailable`, source
  `src/modules/connector-credentials/workflow.ts:166`.
- `admin-operations-list-pagination.test.ts` (5 test): W-ADMUX02-SORT-ALLOWLIST-1 —
  `a NULL deadline_at was ordered by a key with no NULL handling`.
- `operations-list-contract-conformance.test.ts` (2 test): route phát
  `ORDER BY deadline_at ...` không có `COALESCE(deadline_at, $1::timestamptz)` trong khi test
  expect chuỗi đó.
Vùng src liên quan (`server.ts`, `connector-credentials/`) đang dirty vì các lane khác trên
checkout chung; diff của lane này = đúng 1 file test untracked. Bằng chứng non-attribution:
file đã sửa không được load trong run đó + stack trace trỏ src không thuộc diff lane. Đề nghị
coordinator chỉ đạo 2 lane liên quan kiểm tra regression src đang bay.

### Δ-DEVIATION
- **Δ11**: Bước 4 của packet (`pnpm --filter @du/orchestrator exec tsc --noEmit` — kiểm tra
  compile) KHÔNG THỂ thấy file đang sửa: `tsconfig.json` có `include: ["src/**/*.ts"]` và
  `"exclude": ["tests"]`. Không tồn tại tsconfig nào phủ `tests/admin-audit.test.ts` (hai tsconfig
  pinpoint hiện có chỉ trỏ từng file KHÁC: `tsconfig.live-tests.json` cho admin-action-rbac-live,
  `tsconfig.pg-tests.json` cho artifacts-fencing-pg). Lane vẫn chạy lệnh packet (exit 0 ×3) và
  thay bằng gate thật ts-jest (L2) + chứng minh không rỗng bằng M1. Nếu fleet muốn gate tsc cho
  live test: pattern tsconfig pinpoint đã có sẵn — nhưng đó là thay đổi config dùng chung, cần
  packet riêng, lane không tự ý mở rộng.
- **Δ12**: Finding T130-A1 còn tồn tại ở file THỨ HAI mà packet không nêu:
  `tests/admin-base-routes.test.ts` test 6 (dòng 249–260) vẫn cast `{ tenantId: string;
  events: unknown[] }` và assert cả hai → cùng class hỏng, sẽ ĐỎ live khi mở window. Ngoài
  scope packet (chỉ định danh admin-audit.test.ts) ⇒ báo cáo, không tự sửa.
- Dòng mô tả trong packet chính xác (137–140, 192–250, 350–376 đều trúng trước edit). Không có
  Δ đặt tên file/lệnh sai như các cycle trước (ngoài gap Δ11 ở trên).

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — 3×2 gate exit 0 literal; M1 đỏ đúng dự đoán + restore byte-exact;
  residue grep = 0.
- **Packet code objective: [DONE]** — step 1/2/3/4/5 đã land (step 4 ghi Δ11, gate thực đã thay).
- **Hành vi suite sau align: [OPEN]** — live suite, 11 test mới chỉ compile + SKIP offline; Tester
  cần chạy 1 lần trong DB window để xác nhận đọc envelope mới khớp hành vi thật.
- **Δ12 fix: [OUT-OF-SCOPE, REPORTED]** — chờ coordinator.
- Không commit, không push, không mở DB/Redis window trong cycle này.

## 5 — CYCLE 5: W-ADMIN-BASE-AUDIT-ALIGN-1 (admin-base-routes.test.ts test 6 ↔ page envelope, đóng Δ12)

### Bối cảnh finding
Δ12 do chính lane này báo ở Mục 4 (cycle 4): lớp hỏng T130-A1 còn sống ở file thứ hai —
`tests/admin-base-routes.test.ts` test 6 (dòng 248–259 trước edit) vẫn cast
`{ tenantId: string; events: unknown[] }` và assert cả hai field không tồn tại trên response hiện
tại `server.ts:1950–1976`. Packet này chỉ định lane sửa đúng test 6, không đụng src.

### Thay đổi (1 hunk, 261→270 dòng)
- Test 6: cast mới đúng nguyên văn packet — 5 field page envelope (`items`, `nextCursor`,
  `prevCursor`, `total`, `limit`). Với cast mới, `items` là `Array<{ tenantId: string }>`:
  `Array.isArray(body.items)` true; tenant fence giữ nguyên bản chất bằng per-item loop
  `for (const e of body.items) expect(e.tenantId).toBe(TEST_TENANT)`; THÊM
  `body.limit >= 1` (clamp 1..200 default 50 của `parseAdminAuditListQuery`) và
  `body.total >= 0` (COUNT riêng của `keysetPage` tại `server.ts:2789` — chạy trên toàn bộ
  population đã lọc predicate, không bị limit cắt nên an toàn với page rỗng lẫn page đầy). KHÔNG assert non-empty: suite này seed tenant/API key/profile nhưng không
  seed audit event và route GET không tự ghi audit ⇒ page rỗng là hợp lệ, ép non-empty sẽ là
  red giả trong live window. Per-item loop trên page rỗng = vacuous pass, trung thực.
- Comment nguồn ghi ngay trong test (W-ADMUX02-EXT-1 / Δ12) để reader sau không revert nhầm.

### Verify offline
- Gate compile THẬT vẫn là ts-jest (Δ11 cycle 4 còn nguyên, packet 5 vẫn nêu cả hai lệnh):
  `pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts` transform file
  (lỗi type = suite FAIL) trong khi 7 test WINDOW-GATED ⇒ SKIP offline. Exit 0 = compile sạch.
- **Negative control M1** (gate không rỗng): đổi `Array.isArray(body.items)` →
  `Array.isArray(body.events)` tại :264 → ĐỎ đúng dự đoán: `error TS2339: Property` events
  `does not exist on type` (264:31), `Test Suites: 1 failed`, Exit Code: 1. Restore byte-exact:
  sha256 331141b0927a4c2c43404c77b2214be1e07933cecf8fad39a253d7efb022a853, 270 dòng.
- Residue grep cả cây `tests/`: `.events` chỉ còn ở view-model (`parsed.events` của
  `normaliseAuditEvents` trong `admin-list-contract-conformance.test.ts:325` — output fetcher,
  KHÔNG phải wire body, để đúng), shell bundle cache (`admin-shell-render.test.ts` — shape riêng
  của fetcher trung gian), audit-recorder fake và harness scripts. Không còn reader nào của
  `{ tenantId, events }` trên route `/api/v1/admin/audit` trong tests ⇒ đóng lớp T130-A1 ở đây.

### Evidence (3 lần liên tiếp, literal từ wrapper output; cwd = `D:/Git/dugate/du-rework`)
```text
L1 (packet step 3a): pnpm --filter @du/orchestrator exec tsc --noEmit
   TSC_RUN_1 -> Exit Code: 0
   TSC_RUN_2 -> Exit Code: 0
   TSC_RUN_3 -> Exit Code: 0
   (vacuous với file này — Δ11: tsconfig exclude tests)
L2 (gate thật, packet step 3b): pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts
   JEST_RUN_1 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total
   JEST_RUN_2 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total
   JEST_RUN_3 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total
M1 (âm tính): -> Exit Code: 1 | tests/admin-base-routes.test.ts:264:31 - error TS2339 | Test Suites: 1 failed
Sau restore: FINAL_TSC -> Exit Code: 0 | FINAL_JEST -> Exit Code: 0 (7 skipped)
git scope sau cycle: ?? admin-base-routes.test.ts, ?? admin-audit.test.ts, ?? reports/qwen-platform.md
```
Ghi chú trung thực: L2 ghi nhận 7 test **COMPILED nhưng SKIPPED** — KHÔNG phải xanh hành vi.

### Δ-DEVIATION
- Packet cycle 5 chính xác tới từng dòng: 248–260 trúng test 6; danh sách thay thế (cast 5 field,
  per-item fence, limit/total) đủ và an toàn. Lệnh tsc vacuous là Δ11 đã báo (cycle 4), không
  phải Δ mới. Không có Δ mới trong cycle này.
- Ghi chú: đóng Δ12 HOÀN TOÀN cần live run 7 test (DB window, Tester) — gate giống
  `admin-audit.test.ts`; hai suite này có thể chạy chung một window, không seed audit nên
  `admin-base-routes` test 6 pass cả khi page rỗng.

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — 3×2 gate exit 0 literal; M1 đỏ đúng dự đoán + restore byte-exact;
  residue grep = 0 reader shape cũ trong tests.
- **Packet code objective: [DONE]** — step 1–5 đã land (step 3 chạy đủ cả tsc lẫn ts-jest gate).
- **Hành vi suite sau align: [OPEN]** — 7 test mới compile + SKIP offline; chờ Tester DB window
  (chạy chung với 11 test của `admin-audit.test.ts` đã align cycle 4).
- **Δ12: ĐÓNG phía code** — phía acceptance đóng khi live pass; coordinator có thể gạch Δ12
  khỏi danh sách chờ và ghi note live.
- Không commit, không push, không mở DB/Redis window trong cycle này.

## 6 — CYCLE 6: W-ADMIN-APIKEY-ALIGN-1 (test 5 f1 + M4 f2 ↔ buildApiKeyPage items-envelope)

### Bối cảnh finding
Tester live T-CODEX-TEST-29 (13:21–13:23, PG :5433 / Redis :6380, HEAD 7811298):
`admin-base-routes.test.ts` ExitCode 1 — 6 pass/1 fail, fail duy nhất là test 5 (API-key list
không có `body.rows`); `admin-action-rbac-live.test.ts` ExitCode 1 — 11 pass/1 fail, fail duy
nhất là M4 (`list.body.rows` undefined). Cùng receipt đó XÁC NHẬN align các cycle trước:
`admin-audit.test.ts` 11/11 PASS live (cycle 4 đóng) và test 6 f1 (cycle 5) nằm trong 6 test
pass. Nguyên nhân đúng như packet: `buildApiKeyPage` (server.ts:2877–2924) trả
`{...listPage({ items, nextCursor, prevCursor, total, limit }), grants, createCopyOnce }` —
wire key là `items`, `rows` không còn trên route GET api-keys (by-id và list đều qua cùng
builder, :1920/:1929/:1935).

### Thay đổi (2 hunk f1 270→277, 1 hunk f2 439→441; fallback `?? rows` CHỦ Ý theo packet —
khác cycle 4/5 vốn bỏ hẳn shape cũ, vì packet 6 yêu cầu dung nạp build cũ mid-rollout)
- **f1 test 5 (E1, :213–228)**: cast thêm `items?` song song `rows?` (optional — server chỉ trả
  `items`); đọc qua `const keyItems = bodyList.items ?? bodyList.rows ?? []`;
  `Array.isArray(keyItems)`; `foundKey` tìm từ `keyItems`. Toàn bộ assertion ngữ nghĩa giữ
  nguyên (prefix du_adm, status ACTIVE, hash KHÔNG bao giờ trên wire, createCopyOnce null,
  grants của key = TEST_BIZ/extract).
- **f1 test 5 (E2, :240–243)**: packet nêu `expect(bodyItem.items ?? bodyItem.rows)
  .toHaveLength(1)` tại :235 — nội dung đúng nhưng vị trí thật là :233–234 và dòng kế
  (`bodyItem.rows[0]!.id`) sẽ KHÔNG compile với cast optional ⇒ lane dùng helper
  `const itemRows = bodyItem.items ?? bodyItem.rows ?? []` rồi `toHaveLength(1)` +
  `itemRows[0]!.id` — tương đương nghĩa, cộng thêm dòng packet thiếu mà compile bắt buộc.
- **f2 M4 (E3, :349)**: đúng nguyên văn packet
  `const rows = (list.body.items ?? list.body.rows) as { tenantId: string }[];` — fence loop
  `r.tenantId === TENANT_A` và assert 403 foreign giữ nguyên.

### Verify offline
- **Gate compile**: f1 không tsconfig nào cover (default exclude tests — Δ11) ⇒ gate thật là
  ts-jest (L2). f2 NGƯỠNG ĐÃ KHÁC: `tsconfig.live-tests.json` include đúng file này ⇒
  `tsc --noEmit -p tsconfig.live-tests.json` (L1b) là gate tsc THẬT cho f2 — lane bổ sung
  vào evidence dù packet không nêu.
- **M1 (f1)**: `bodyList.items` → `bodyList.itemsX` tại :226 → đỏ ĐÚNG dự đoán:
  `error TS2551: Property itemsX does not exist ... Did you mean items?` (:226:31) + dây
  truyền `TS7006 k implicitly any` (:228) — cast strict BẮT ĐƯỢC typo wire-key. Exit 1,
  `Test Suites: 1 failed`. Restore byte-exact (sha 27828a0f… / 277).
- **M2 (f2)**: đổi cast `as { tenantId: string }[]` → `as string` → đỏ đúng dự đoán:
  `error TS2339: Property tenantId does not exist on type string` (:351:36), Exit 1.
  Restore byte-exact (sha 1a96181d… / 441).
- **Giới hạn phương pháp, ghi trung thực (Δ mới của cycle)**: f2 có `body: Record<string,
  unknown>` ⇒ typo TÊN KEY (`list.body.itemsZz`) KHÔNG sinh lỗi compile và suite skip offline
  ⇒ không sinh lỗi runtime. Nửa tiêu cực packet yêu cầu chỉ chứng minh được ở f1; ở f2,
  bảo chứng wire-key là LIVE (red cũ T-CODEX-TEST-29 + green lần chạy lại kế tiếp).
- **Collateral giữa chu kỳ**: lần đầu chạy L1/L1b bị ĐỎ do `src/server.ts` TS2554/TS2345
  (tham số `sort` của `encodeOperationsListCursor` — lane W-ADMUX02-SORT đang edit dở; vị trí
  lỗi trôi 2216→2230→2562→2592 qua các lần đo) rồi TỰ LÀNH trước evidence chính. Hai suite
  jest run trong cửa sổ hỏng đó chỉ báo lỗi server.ts, KHÔNG báo lỗi file của lane ⇒ bằng chứng
  per-file sạch. Không absorption, không đụng src (STRICT của packet).

### Evidence (3 lần liên tiếp, literal từ wrapper output; cwd = `D:/Git/dugate/du-rework`)
```text
L1  pnpm --filter @du/orchestrator exec tsc --noEmit
    TSC_RUN_1/2/3 -> Exit Code: 0   (vacuous với f1 — Δ11; f2 ngoài default tsconfig)
L1b pnpm --filter @du/orchestrator exec tsc --noEmit -p tsconfig.live-tests.json
    PINPOINT_RUN_1/2/3 -> Exit Code: 0   (gate tsc THẬT của f2 — bổ sung bởi lane)
L2  pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts
    JEST_F1_1/2/3 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total
L3  pnpm --filter @du/orchestrator test -- tests/admin-action-rbac-live.test.ts
    JEST_F2_1/2/3 -> Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 12 skipped, 12 total
M1  f1 itemsX -> Exit Code: 1 | admin-base-routes.test.ts:226:31 error TS2551 (Did you mean items?)
M2  f2 as string -> Exit Code: 1 | admin-action-rbac-live.test.ts:351:36 error TS2339
Sau restore: f1 sha 27828a0f44616305c3ae8b263fdd3b1e4bb1f19795907529a0836a40c4ecda04 / 277 dòng
            f2 sha 1a96181dbc86418644289f86111e59accbc7fe21bbbe3240ae91e0ee6ca3601f / 441 dòng
```
Ghi chú trung thực: L2/L3 = 7 + 12 test COMPILED nhưng SKIPPED (WINDOW-GATED) — không phải
xanh hành vi; xanh hành vi của 2 test vừa align cần window live kế tiếp.

### Δ-DEVIATION
- Packet cycle 6 cơ bản chính xác (file/danh sách thay đổi đúng; line 216–225 trúng; :347 trúng
  trước khi sửa). Hai lệch nhỏ, đều đã xử lý công khai ở Thay đổi/Verify: (a) :235 thật là
  :233–234 và một dòng kế bắt buộc phải sửa thêm để compile; (b) negative control kiểu
  wire-key-typo không áp dụng được cho f2 (Record<string, unknown>) — lane chứng minh gate f2
  bằng lỗi kiểu (M2) và ghi rõ giới hạn.
- Δ11 hẹp lại: packet đã kèm sẵn lệnh jest theo file (gate thật). Vẫn còn vacuous: cột tsc
  mặc định. Đề nghị fleet cân nhắc thêm f1 vào một tsconfig pinpoint như pattern f2 — quyết
  định config chung, lane không tự ý.

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — 3×4 gate exit 0 literal (kể cả pinpoint tsc của f2); M1+M2 đỏ
  đúng dự đoán, restore byte-exact cả 2 file.
- **Packet code objective: [DONE]** — step 1–5 land đủ; step 3 chạy thêm gate tsc thật cho f2.
- **Hành vi live sau align: [OPEN]** — test 5 f1 + M4 f2 cần Tester chạy lại trong window kế
  (cùng window đóng luôn gate 7/12 test skip của 2 suite).
- Collateral server.ts transient red: đã lành, ghi nhận để coordinator theo dõi lane
  W-ADMUX02-SORT; không thuộc diff lane này.
- Không commit, không push, không mở DB/Redis window trong cycle này.

## 7 — CYCLE 7: W-ADMIN-APIKEY-TENANT-SCOPE-1 (test 5 f1 ↔ api-keys tenant-scope query)

### Bối cảnh finding
Tester live T-CODEX-TEST-30 (window 13:50:57–13:52:59, PG :5433 / Redis :6380, HEAD 7811298):
`admin-action-rbac-live.test.ts` 12/12 PASS (ĐÓNG gate live cycle 6 phía f2);
`admin-audit.test.ts` 11/11 PASS; `admin-base-routes.test.ts` ExitCode 1 — 6 pass/1 fail, fail
duy nhất test 5: envelope items-rows được chấp nhận nhưng key seed không có trong items ⇒
foundKey undefined. Nguyên nhân đúng như packet: `authorizeAuditTenantRead` (rbac.ts:54) với
platform principal echo nguyên requestedTenantId; không có query tenantId ⇒ scope rỗng ⇒
`server.ts:1927` trả `buildApiKeyPage(ctx, keysPrincipal, [], query)` (:1930) — honest empty
list CÓ CHỦ ĐÍCH theo docstring rbac.ts:45–52, KHÔNG phải bug sản phẩm ⇒ sửa test, không sửa
src (đúng STRICT packet). `parseApiKeyListQuery` (server.ts:2752) đòi tenantId dạng uuid
(non-uuid ⇒ 422 INVALID_SCHEMA). by-id path đi qua `requireResourceTenant`, không cần param.

### Thay đổi (chỉ f1, 277→291; 2 hunk trong test 5; không đụng src)
- **E1 (:214–221)**: fetch của resList đổi thành
  `${baseUrl}/api/v1/admin/api-keys?tenantId=${TEST_TENANT}` + 5 dòng comment ghi rõ scope
  model (W-ADMUX02-EXT-1 SQL predicate; platform echo; thiếu param ⇒ empty page). Packet
  literal viết URL kết thúc bằng `?tenantId=` TRỐNG interpolation — lane suy diễn theo ý
  `?tenantId=${TEST_TENANT}` (key seed thuộc TEST_TENANT), ghi ở Δ-DEVIATION.
- **E2 (:243–247, chân tùy chọn của packet — lane thực hiện)**: probe không-scoped — resNoScope
  fetch bare + `expect(resNoScope.status).toBe(200)` + cast `as typeof bodyList` +
  `expect(emptyBody.items ?? []).toEqual([]);` — pin hành vi fail-closed (thiếu tenant ⇒
  empty, không bao giờ cross-tenant dump). Probe dùng chung cast với list path nên typo
  wire-key trên nó compile-đetectable (chứng minh bằng M2).
- Ngữ nghĩa còn lại giữ nguyên: foundKey từ keyItems (:235) + toBeDefined (:236), prefix
  du_adm, status ACTIVE, hash không trên wire, createCopyOnce null, grants TEST_BIZ/extract,
  by-id + 404; test 6 audit không đụng tới. Số test vẫn 7 (chỉ thêm assertion trong test 5).

### Verify offline
- **Gate compile**: đã kiểm lại — f1 KHÔNG tsconfig pinpoint nào cover ⇒ gate thật = ts-jest
  (L2); default `tsc --noEmit` vacuous với tests (Δ11) nhưng vẫn chạy đủ 3× theo packet.
- **M1 (compile, gán cho hunk mới)**: `TEST_TENANT` → `TEST_TENANZ` trong interpolation tại
  :219 ⇒ đỏ ĐÚNG dự đoán về bản chất, mã chính xác là TS2552 (nâng cấp từ TS2304 khi có
  identifier gần giống): error TS2552: Cannot find name TEST_TENANZ. Did you mean TEST_TENANT?
  tại (:219:78), Exit 1, Test Suites: 1 failed. Restore.
- **M2 (wire-key typo trên probe mới)**: `emptyBody.items` → `emptyBody.itemsQ` tại :247 ⇒ đỏ
  đúng dự đoán: TS2551 Property itemsQ does not exist on type { items?: ...; rows?: ...;
  grants; createCopyOnce } — Did you mean items? tại (:247:22), Exit 1. Restore byte-exact —
  sha 85d1a916898031a73c85a9f5f6330b58099b36060db95675100ab21348c0d843 / 291 dòng; residue
  grep TEST_TENANZ|itemsQ = 0 match.
- **Giới hạn phương pháp (kê thừa cycle 6)**: negative control nghĩa runtime của packet (đổi
  tenantId sang tenant không khớp ⇒ foundKey undefined ⇒ đỏ) KHÔNG chứng minh được offline —
  chuỗi URL không type-checked, suite WINDOW-GATED skip offline. Đó là phát biểu live-only;
  lane chứng minh ở mức compile (M1/M2) và ghi trung thực thay vì silently absorb.
- **Collateral**: poll default tsc attempt 1 exit 0 — `src/server.ts` sạch trong cả cycle 7
  (W-ADMUX02-SORT không can thiệp cửa sổ này).

### Evidence (3 lần liên tiếp, literal từ wrapper output; cwd = D:/Git/dugate/du-rework)
- L1 `pnpm --filter @du/orchestrator exec tsc --noEmit` → TSC_RUN_1/2/3 Exit Code: 0
  (vacuous với f1 — Δ11; f1 chưa có pinpoint tsconfig).
- L2 `pnpm --filter @du/orchestrator test -- tests/admin-base-routes.test.ts` →
  JEST_F1_1/2/3 Exit Code: 0 | Test Suites: 1 skipped, 0 of 1 total | Tests: 7 skipped, 7 total.
- M1 đỏ: Exit Code: 1, TS2552 :219:78. M2 đỏ: Exit Code: 1, TS2551 :247:22.
- Sau restore: f1 sha 85d1a916898031a73c85a9f5f6330b58099b36060db95675100ab21348c0d843 /
  291 dòng (Get-Content).

Ghi chú trung thực: L2 = 7 test COMPILED nhưng SKIPPED (WINDOW-GATED) — không phải xanh hành vi;
xanh hành vi test 5 cần window live kế tiếp (đồng thời là gate live cuối của lane api-keys).

### Δ-DEVIATION
- Packet literal thiếu interpolation ở URL (?tenantId= trống) — xử lý theo ý, không lệch chức
  năng; nếu coordinator muốn đúng nguyên văn thì sản phẩm đã có ${TEST_TENANT} nội suy.
- Packet ghi `server.ts:1926` — TRÚNG tại thời điểm đo cycle 7 (không trôi). Các anchor khác
  đã re-grep: empty branch :1927–1931; buildApiKeyPage def drifted 2877→2979 so với cycle 6;
  parseApiKeyListQuery :2752; authorizeAuditTenantRead def rbac.ts:54.
- Đề nghị cycle 6 (thêm f1 vào một pinpoint tsconfig) chưa được fleet thực hiện ⇒ Δ11 giữ
  nguyên với f1; lane không tự sửa config chung (STRICT packet).
- Cập nhật gate cycle 6: phía f2 (M4) đã LIVE-CONFIRMED 12/12 bởi T-CODEX-TEST-30 ⇒ gate mở
  của lane hẹp lại còn đúng admin-base-routes.test.ts (7 test, gồm test 5 vừa sửa).

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — L1 3× + L2 3× exit 0 literal; M1+M2 đỏ đúng dự đoán; restore
  byte-exact; residue 0; collateral sạch attempt 1.
- **Packet code objective: [DONE]** — step 1 (kể cả chân tùy chọn), 2, 3, 4 land đủ; không sửa
  src, không DB/Redis window, không commit/push.
- **Hành vi live test 5: [OPEN]** — cần Tester chạy admin-base-routes.test.ts trong window kế;
  dự đoán xanh 7/7 nếu scope model không đổi giữa chu kỳ.
- Không commit, không push, không mở DB/Redis window trong cycle này.


## 8 — CYCLE 8: W-VAULT-FIXTURE-ALIGN-1 (f3 seed() binding coordinates)

### Bối cảnh finding
Coordinator dispatch Wave 5 (Turn 163), packet W-VAULT-FIXTURE-ALIGN-1 — sửa HIGH 2 của
Independent Audit Turn 160. Root cause packet nêu (đã verify tại chỗ): `workflow.ts:160–167`
parse `ConnectorRevisionBindingSchema.safeParse({ tenantId: base.tenantId, connectorId,
accountId: base.accountId })` trên chính ROW current; fixture `InMemoryRevisionRepo.seed()`
(:113–126) đặt `tenantId: ''` (= LEGACY_UNBOUND_TENANT_ID, repository.ts:291) và KHÔNG có
`accountId` (field optional, repository.ts:278) ⇒ schema (:strict(), 3 regex — vault.ts:196–200)
fail ⇒ 403 BINDING_DENIED trước mọi vault write — workflow từ chối ĐÚNG thiết kế, fixture sai.
Đo baseline TRƯỚC sửa: **4 failed / 4 passed / 8 total**, cả 4 fail (rotate #1, pin separation,
CAS discipline, emergency revoke) cùng signature `HttpError: connector ownership binding is
unavailable` @ workflow.ts:166:13, Exit Code 1. 4 test còn lại (reconcile, transport,
invalid-source, migration-pin) vốn xanh vì không đi qua binding gate của row seed.

### Thay đổi (chỉ f3, 393→398; 1 hunk trong seed(); không đụng src)
- `seed()` :125–126: `tenantId: 'tenant-a'` + `accountId: 'du-conn-openai-main'` — đúng cặp tọa
  độ mà REASON (:254) và TEST_SCOPES (:255) đã pin (path `du/tenants/tenant-a/connectors/openai-live/accounts/du-conn-openai-main`).
  `tenant-a` pass VAULT_TENANT, `du-conn-openai-main` pass VAULT_ACCOUNT (vault.ts:21–24).
- Kèm 3 dòng comment bất biến (vì sao row phải bound) — chống regressing "dọn về ''" đời sau.
- Số test vẫn 8; không thêm/xóa assertion.

### Verify offline
- Suite f3 chạy offline THUẦN (in-memory repo + loopback HTTP + connector dist), không
  WINDOW-GATED ⇒ exit 0 = xanh hành vi thật, khác các suite live-gated cycle 5–7.
- **M1 (nguyên nhân cột accountId)**: xóa dòng `accountId` ⇒ đỏ ĐÚNG dự đoán: y hệt baseline
  (4 failed, 403 BINDING_DENIED @ workflow.ts:166:13, Exit 1). Restore.
- **M2 (nguyên nhân GIÁ TRỊ tenantId)**: `tenant-a`→`tenant-b` ⇒ đỏ KHÁC signature đúng dự
  đoán: binding gate :166 PASS (shape hợp lệ) nhưng `matchesVaultAccountPath` fail tại
  workflow.ts:178:13 ⇒ 422 INVALID_SCHEMA 'credential ref is outside the connector account
  path' — vẫn 4 failed / 4 passed, Exit 1. Hai probe tách đúng 2 gate (có-binding vs khớp-coordinates).
- Restore byte-exact sau M2 — sha 012183afc6fac30876fb6dd6f2a291941c1d2b2a686c835d6e4908e60cfb1185 /
  398 dòng; residue grep `tenant-b|tenantId: ''` = 0 match.
- **Collateral**: default `tsc --noEmit` attempt 1 exit 0 (vacuous với tests — Δ11; đã kiểm
  pinpoint cycle 8: live-tests chỉ f2, pg-tests chỉ artifacts-fencing-pg ⇒ f3 KHÔNG có pinpoint
  gate, gate thật = ts-jest trong 3× L1).

### Evidence (3 lần liên tiếp, literal từ wrapper output; cwd = D:/Git/dugate/du-rework)
- L1 `pnpm --filter @du/orchestrator test -- tests/connector-revision-http-offline.functional.test.ts`
  → JEST_F3_1/2/3 Exit Code: 0 | Test Suites: 1 passed, 1 total | Tests: 8 passed, 8 total.
- L2 `pnpm --filter @du/orchestrator exec tsc --noEmit` → Exit Code: 0 (collateral).
- Baseline đỏ trước sửa: Exit Code: 1, 4 failed/4 passed. M1 đỏ: Exit Code: 1 @ :166:13.
  M2 đỏ: Exit Code: 1 @ :178:13 (422, không phải 403 — đúng phân loại gate).
- Sau restore: f3 sha 012183afc6fac30876fb6dd6f2a291941c1d2b2a686c835d6e4908e60cfb1185 / 398 dòng.

### Δ-DEVIATION
- Packet ghi lệnh `pnpm -C du-rework --filter ...` — lane tương đương lệnh
  `cd du-rework` + `pnpm --filter ...` (cwd = D:/Git/dugate/du-rework); hành vi pnpm như nhau.
- Packet "around line 113-126" — TRÚNG vị trí seed() đo được (:113–126 pre-edit).
- **Ghi chú ngữ nghĩa (không sửa ngoài packet)**: rev1 vẫn giữ `credentialSource: { kind:
  'legacy-db' }` trong khi binding giờ BOUND — production validator (repository.ts:590) KHÔNG
  cho tổ hợp legacy-db + tenant bound; fixture hợp lệ chỉ vì `seed()` đẩy row thẳng vào mảng,
  bypass validator, và workflow chỉ tin 2 cột binding. Nếu ai đó tái sử dụng repo này qua
  validator sẽ vỡ — flag cho coordinator/audit, lane không tự ý đổi source kind của row.
- Số hiệu "HIGH 2 / Turn 160 / Turn 163" chấp theo dispatch; lane không independent-audit lại.
- Không phát hiện nào của src được sửa: hành vi 403/422 của workflow là ĐÚNG (fail-closed
  trước vault write) — sửa fixture, đúng STRICT packet.

### Trạng thái (4 mức, tự đánh giá)
- **Offline verify: [PASS]** — baseline đỏ 4/8 → fix → 8/8 ×3 literal exit 0; M1+M2 đỏ đúng
  dự đoán với 2 gate phân biệt; restore byte-exact (sha xác nhận 2 lần); residue 0; collateral
  tsc sạch attempt 1.
- **Packet objective: [DONE]** — step 1 (đúng 2 field), 2 (test pass exit 0), 3 (không sửa src),
  4 (offline, zero commit/push/window), 5 (receipt Mục 8 này).
- **Live gate: KHÔNG CÓ cho file này** — suite offline thuần, không phụ thuộc DB/Redis; gate
  live mở duy nhất của lane vẫn là f1 (cycle 7) chờ window Tester.
- Không commit, không push, không mở DB/Redis window trong cycle này.

## 9 — CYCLE 9: W-DATA03-CONSUMER-JOIN-1 (production join cho ingestion gate — audit Turn 160 HIGH 1)
### Bối cảnh (kiểm chứng TRƯỚC khi sửa)
- Packet cite submission.ts:351 (processIngestionTask) và source-ingestion.ts:322
  (createIngestionTaskHandler) — cả hai anchor ĐÚNG tại thời điểm đo (re-grep
  fresh, không drift).
- HIGH 1 xác nhận bằng grep toàn repo: processIngestionTask KHÔNG có caller nào
  ngoài chính file định nghĩa; createIngestionTaskHandler chỉ có trong tests của
  worker-sdk + barrel; KHÔNG file nào ở hai đầu đọc payload.gate. Row
  task.dispatch gate ingestion do submission ghi ra bị dispatcher general
  publish thẳng xuống business queue (resolveQueueForTask theo task) —
  leak-ungated là có thật: claim không chặn PENDING_INGESTION, worker sẽ chạy
  root task khi source chưa pin. Hai khoảng trống một lúc: không ai mở gate,
  VÀ hàng đợi business nhận nhầm việc gated.
- Baseline đo trước khi sửa: url-ingestion-offline 3/3, br12 18/18,
  mm05-queue-integrity-offline 4/4 — mỗi cái Exit Code: 0 (nguyên văn trong
  transcript cycle này).

### Thay đổi (5 file src + 1 test mới; không live window; không commit/push)
1. src/modules/operations/ingestion-consumer.ts (MỚI, 456 dòng node-split):
   durable consumer createIngestionConsumer —
   - claim: SELECT ... FROM outbox WHERE type='task.dispatch' AND dispatched_at
     IS NULL AND (claim_until IS NULL OR claim_until < now()) AND due_at <= now()
     AND payload->>'gate' = 'ingestion' ... FOR UPDATE SKIP LOCKED; stamp
     claim_until/attempts trong CÙNG tx ngắn; xử lý NGOÀI tx (download chậm
     không giữ transaction).
   - payload chỉ là POINTER: coordinates (tenant, root task, envelope input,
     state) đọc lại từ DB; taskId/sourceUrl dispatch phải khớp row — lệch thì
     escalate TASK_INVALID (test 13–14).
   - join thật: createSourceAcquisitionIngestor (budget maxBytes>=1 bắt buộc,
     fetcher seam) → createIngestionTaskHandler (acquirer + materializeArtifact)
     → acquirer-của-processIngestionTask = handler.run → processIngestionTask
     (validateSourceUrl lại; deliveryId MỚI cho dispatch ready vì
     outbox.delivery_id UNIQUE — học từ chính schema: tái dùng delivery id
     ingestion thì INSERT gate-ready sẽ nổ unique).
   - materializeArtifactRow: id deterministic uuidv5 (namespace
     9f14dc40-9e6a-5c1e-a4c9-2f9a1d63b155, name
     du-source|tenant|operation|storageKey|versionId|sha256) — SELECT-first theo
     (tenant, storage_key, storage_version_id, READY); miss thì INSERT purpose
     input, mime application/octet-stream, state READY, token random
     (placeholder — grant route xoay token khi cần, artifacts.ts:410), ON
     CONFLICT (id) DO NOTHING: PK làm trọng tài idempotence — không cần
     unique-index mới, zero schema change.
   - fail-closed: gate CHỈ mở qua markIngestionReady sau receipt hợp lệ có
     artifactId. Permanent (TASK_INVALID, INVALID_URL, SCHEME_NOT_ALLOWED,
     INVALID_SCHEMA) escalate FAILED tức thì; retryable (transport,
     SOURCE_REJECTED, storage, PIN_MISMATCH, MATERIALIZATION_FAILED, TOO_LARGE)
     re-arm due_at backoff tới maxAttempts rồi escalate: UPDATE tasks+operations
     state FAILED với error_code (guard WHERE state=PENDING_INGESTION, code
     sanitize /^[A-Z][A-Z0-9_]{0,39}$/) + maybeScheduleWebhook cùng tx — cùng
     khuôn terminal với sweepExpiredLeases (runtime.ts:1130–1143).
   - storageKey pin: du/tenants/<tenant>/operations/<op>/source — tenant lấy từ
     row đã xác thực; hợp nhất với canonical convention du/tenants/{t}/... của
     docs/15-decisions.md (VAULT path family) — không phải namespace tự chế.
   - single-flight runOnce + start/stop timer (unref) — khuôn webhook sweep.
2. src/modules/queue/dispatcher.ts (+6 dòng): vị từ loại trừ gate ingestion khỏi
   claim SELECT — hàng gated không còn rơi vào business queue; gate ready và
   dispatch không gate vẫn thường lệ.
3. src/modules/operations/ingestion-storage-s3.ts (MỚI, 122 dòng): adapter
   PinnedSourceStorage over S3 — putVerified = PutObjectCommand streaming
   (Readable.from của generator tự đo sha/size, enforce maxBytes giữa dòng,
   abort theo signal) + BẮT BUỘC VersionId bất biến (thiếu hoặc null thì
   STORAGE_FAILURE — cùng tiền lệ bucket-versioning của
   s3-storage-facade:209-211) + ChecksumSHA256 của S3 được đối chiếu (lệch thì
   PIN_MISMATCH); resolvePinned = CHÍNH HÀNG READY trong bảng artifacts
   (storage_key+version+sha+size+artifactId) — pin registry là DB row, không
   có metadata store thứ hai.
4. src/server.ts (+~35 dòng): import mới + config field ingestionConsumer
   (intervalMs, maxBytes, timeoutMs, idleTimeoutMs, maxRedirects, maxAttempts,
   batch) + composition dựng consumer KHI VÀ CHỈ KHI backend s3 (onGateOpened
   kick dispatchOnce) + listen start (tôn trọng autoDispatch; intervalMs 0 =
   handle manual) + close stop + seam ingestionConsumer trên App return.
5. src/index.ts (+18 dòng barrel) và package.json: @du/worker-sdk được thăng
   devDependency → dependency — production src import nó mà package.json còn
   nói dev là nói dối packaging (liên đới Δ14).

### Verify (offline; exit code nguyên văn trong transcript)
- Suite mới tests/url-ingestion-consumer-offline.functional.test.ts (937 dòng
  node-split, 24 test): in-memory SQL router ÉP WHERE-guard + UNIQUE
  delivery_id + PK-conflict (statement lạ thì throw), fetcher thật-Response
  qua seam acquireSourceUrl, storage fixture versioned đếm chunk.
  - happy path: claim→acquire→put→artifact READY→QUEUED/READY; envelope MỘT
    chuỗi JSON duy nhất trên cả hai row; pin.artifactId = đúng id v5 tất
    định; bytes đi thành >1 chunk (doc 82 KiB > HWM 64 KiB) — streaming có
    witness, không phải văn xuôi; fetch=1 put=1; ingestion row có
    dispatched_at; row ready mang delivery id MỚI.
  - replay: chạy lại không claim gì; crash sau-gate-trước-stamp thì replayed
    zero-fetch; crash sau-materialize-trước-gate thì resolvePinned hit,
    artifactId không đổi, không fetch/put thêm, đúng 1 artifact row.
  - negatives: http:// thì FAILED(INVALID_SCHEMA) zero-network; transport fail
    3 lần thì retry, retry, FAILED(TRANSPORT_FAILURE) đúng ngân sách attempts;
    upstream 404 thì FAILED(SOURCE_REJECTED); digest storage lệch thì
    FAILED(PIN_MISMATCH) không artifact không gate; artifact-write fail thì
    FAILED(MATERIALIZATION_FAILED), bytes đã commit vẫn VÔ HÌNH sau gate
    đóng; oversize mid-stream VÀ declared-content-length đều
    FAILED(TOO_LARGE) zero-put; cancel signal thì skipped, delivery tiêu
    visibly; sourceUrl/taskId lệch row thì TASK_INVALID; claim chỉ nhận row
    gate ingestion; v5 tất định + đúng format; budget<=0 thì từ chối khởi tạo.
  - dispatcher routing test: router mô-phỏng đúng vị từ IS DISTINCT FROM — row
    ingestion KHÔNG vào business queue, ready/plain vào.
- Mutation probes, dự đoán chữ ký TRƯỚC khi chạy, khớp nguyên văn:
  M1 = xóa predicate dispatcher ⇒ đỏ ĐÚNG 1 test dispatcher routing
    (expect(dispatched).toBe(2) Nhận 3), 23 còn lại xanh.
  M2 = bypass handler (acquirer chỉ còn ingestor) ⇒ đỏ ĐÚNG 3 test: happy-path
    (toHaveLength(1) Nhận 0 array rỗng), crash-after-materialize (fixtures:
    artifact id missing), MATERIALIZATION fixture (expect(sweep.escalated)
    .toBe(1) Nhận 0). Không đỏ lan tinh.
  Restore byte-exact — SHA 7 file khớp baseline (f7ce4df4 / 25aea094 /
  5b5d04da / a878b63d / 1e913f4d / 7a5d54a1 / 7c04cccd); residue grep
  ingestor.acquire = 0; lint Exit Code: 0 sau restore.
- Evidence ×3 (suite mới, trên bytes cuối): E1 Tests: 24 passed, 24 total
  Exit Code: 0; E2 như hệt Exit Code: 0; E3 như hệt Exit Code: 0.
- Collateral (4 suite cũ import submission/dispatcher, một lệnh gộp):
  Tests: 30 passed, 30 total, Exit Code: 0. Lint src (tsc -p tsconfig — các
  file production mới đều nằm trong gate này): Exit Code: 0.

### Δ-DEVIATION (không ngầm nuốt)
- Δ13: khi backend postgres, ingestionConsumer = undefined và dispatcher thì đã
  chặn leak ⇒ row gate ingestion nằm UNDISPATCHED vĩnh viễn (fail-CLOSED nhưng
  limbo, không health signal). Chọn của lane: đúng chính sách hơn leak; nhưng
  coordinator nên chốt một trong ba: pg-adapter (artifact_blobs + bảng pin
  riêng), 409/422 tại submit khi sourceUrl mà backend khác s3, hoặc
  undispatched-age vào /health. Hiện không có tín hiệu nào trong ba cái đó.
- Δ14 (ĐỘNG VÀO PACKAGE, ngoài các file packet kể): @du/worker-sdk trước đây là
  devDep của orchestrator; production join bắt buộc nó thành dependency (đã
  sửa package.json). Rủi ro liên đới: Dockerfile/compose nếu cài
  production-only (pnpm install --prod) TRƯỚC đó sẽ không có worker-sdk trong
  runtime image — kiểm tra là việc của deploy-owner; lane không đụng Dockerfile.
- Δ15: packet ghi materializes-the-artifact-into-storage/S3 như thể S3 tự
  resolve được pin; port resolvePinned không có metadata store nào khác nên
  lane tự chọn pin-registry = bảng artifacts (hàng READY chính là bằng chứng
  pin). Hàng artifact giờ mang nghĩa mới: input nền-tảng-materialized, purpose
  input, token placeholder. Lane DATA-03 gốc (Qwen-4) + coordinator nên xác
  nhận cơ chế, đặc biệt trước khi DATA-04 read-path chạm các row này. Lưu ý
  số: ký hiệu Δ14 trong comment submission.ts là Δ đánh số TOÀN CỤC của lane
  khác, không liên quan Δ14 cục bộ ở trên (đánh số của lane qwen-platform).
- Δ16: router fake mô-phỏng semantics SQL (guards, UNIQUE, PK conflict,
  interval backoff) nhưng KHÔNG phải PostgreSQL. Toàn bộ statement mới
  (CLAIM/STAMP/COMPLETE/RETRY/LOAD/ARTIFACT/FAIL + 3 statement
  markIngestionReady chạy thật trong tx) cần MỘT lượt live-PG để đóng. Suite
  mới là offline thuần (không DU_LIVE_INFRA gate) ⇒ bằng chứng live là gate
  MỞ mới của lane; đề xuất packet Tester kế tiếp chạy consumer trên PG thật.
- Δ17: main.ts không có env seam cho ingestionConsumer; deployment s3 bật mặc
  định (5s tick, budget = maxBlobBytes 64MiB). Nếu fleet muốn ops-tunable thì
  thêm vài env reads — lane giữ packet-scope, không tự mở mặt trận.
- Packet: chuỗi URL-submission → ingestion-task → private-S3-materialization →
  immutable-artifactId-receipt → READY-business-task đã đi trọn; không lệch
  chính sách. Hai chỗ packet im lặng mà lane phải chọn: (a) trigger =
  outbox-sweep (kiểu webhook scheduler của repo), không phải BullMQ worker
  mới (tránh thêm Redis consumer-plane + lifecycle trong orchestrator);
  (b) escalation terminal FAILED khi exhausted — packet chỉ nói fail-closed,
  không nói hữu cơ-hóa ở đâu; lane chọn FAILED-visible theo tiền lệ
  LEASE_EXPIRED.

### Tự phân loại 4 tầng
- SPECIFIED: rõ, đủ, anchor chính xác 100% (hiếm gặp).
- IMPLEMENTED: join production trọn chuỗi + dispatcher ownership + S3 adapter +
  server wiring + package promotion + barrel.
- VERIFIED (offline): 24/24 ×3 literal exit 0; M1/M2 đỏ-đúng-cầu đối khớp dự
  đoán; collateral 30/30; lint 0. SQL semantics mới mới đạt mức model-router
  (Δ16) — chưa phải PostgreSQL.
- ACCEPTED: không thuộc quyền lane. Gate live Δ16 + pg-policy Δ13 + packaging
  Δ14 chờ coordinator/Tester/deploy-owner.

## 10 — CYCLE 10: W-VAULT-LEGACY-TRANSITION-1 (luồng chuyển đổi legacy -> bound vault — Reviewer T170-V1 HIGH)
### Bối cảnh (kiểm chứng TRƯỚC khi sửa — ba khâu hỏng, không một)
- Reviewer chốt triệu chứng tại workflow.ts:157-167 (unbound legacy base -> 403
  BINDING_DENIED trước rotation). Re-grep fresh xác nhận symptom ĐÚNG, nhưng
  chuỗi gốc có BA khâu hỏng đồng thời, mỗi khâu tự nó đã chặn transition:
  (K1) production HTTP wiring: connector-http-store.get() KHÔNG gửi tenant
      selector -> GET /revisions/current resolve về chain rỗng (unbound), nên
      KỂ CẢ connector đã bound-chain vẫn chỉ thấy row legacy -> vẫn 403. Chu
      cycle 8 xanh chỉ vì in-memory store trả thẳng row mang binding — bằng
      chứng wire-level bị loop-hole chính test-harness che mất.
  (K2) connector createPendingRevision cấu trúc KHÔNG THỂ mở chain bound đầu
      tiên: nó yêu getActiveRevision(bound chain) làm clone-source và route
      activate đòi expectedCurrentRevision >= 1 — rev1 bound không có ACTIVE
      tiền nhiệm để CAS, đường nào cũng INVALID_INPUT.
  (K3) migration 008 chain guard: credential_ref dùng chung KHÔNG BAO GIỜ được
      pha legacy-db với bound (RAISE 23514) — nên mọi transition clone ref
      legacy là phản-schema, đúng như repository.ts:590-591 đã cấm.
- Baseline đo trước khi sửa: orch 4 suite credentials 67/67 Exit Code: 0 + lint
  0; conn 4 suite binding 73/73 Exit Code: 0. Toàn bộ hành vi cũ phải còn y
  nguyên khi KHÔNG khai initialBindings (invariant tương thích).

### Thiết kế chuyển đổi (trusted, không kẻ hở caller-input)
- Nguồn tọa độ ĐẦU TIÊN duy nhất = platform config: deps mới
  createCredentialWorkflow({..., initialBindings?: {connectorId ->
  {tenantId, accountId}}}) — validate toàn bộ tại constructor (fail-fast: typo
  config chết lúc boot chứ không chết giữa rotate). SEC-04 giữ nguyên văn:
  rotate REQUEST không bao giờ mang tenant/account.
- workflow.run() resolve 2 tầng: (1) bound chain hiện diện -> rotate thường;
  binding SƠ ROW phải khớp config — lệch => 403 BINDING_DENIED với message
  riêng 'stored connector binding disagrees with the platform binding', TRƯỚC
  mọi vault write; (2) không có bound chain -> đọc chain unbound: phải là
  legacy-db row thì mới là TRANSITION mode (binding := config; candidate ref
  vẫn bị police lại khớp binding); không legacy-db => 403; không gì hết => 404.
- Transition commit qua port MỚI bootstrap?() (optional): store không có nó =>
  501 BOOTSTRAP_UNSUPPORTED fail-closed — vault version đã write trở thành
  orphan vô tham-chếu (tiền lệ crash-window A, never routable), chain không
  đổi một dòng nào.
- Connector phía nhận: repository.bootstrapVaultRevision — MỘT transaction:
  khóa chain bound (FOR UPDATE) — đã mở cùng pin => replay trả row hiện hữu;
  đã mở khác pin => 403 BINDING_DENIED; chưa mở => ĐỌC-LOCK chain unbound tại
  storage (điều-kiện legacy-db kind ép ở DB-layer, không chỉ echo facade);
  INSERT row bound ACTIVE rev1 với chain-key MỚI 'cred-<connector>-<account>'
  (facade dẫn xuất + collision-guard với ref legacy; hai coordinate tenant/
  account vẫn independent-field như mọi path khác, ref tự-khai không bao giờ
  là thẩm quyền). Không có cửa sổ PENDING-không-CAS: first-bound-chain là
  ngoại lệ CÓ CHỦ ĐÍCH của trật tự VAULT-03 (Δ20 — xin ratify).
- Route mới POST /connectors/:id/revisions/bootstrap {credentialSource,
  tenantId, accountId} -> 201 masked-row + replayed flag; http-store gọi
  đúng route, GET có scope gửi ?tenant= (URL cũ khi absence byte-identical).

### Thay đổi (file + dòng)
1. orchestrator src/modules/connector-credentials/workflow.ts (~+95):
   TrustedInitialBinding + validation ctor; get(scope) port; bootstrap? port;
   run() 2 tầng + mismatch guard; transition commit branch (skip
   createPending/activate); audit detail transition:true; giữ nguyên 100%
   branch không-declared (thông-điệp 403 cũ, thứ tự validate cũ).
2. orchestrator connector-http-store.ts (~+32): scoped GET query;
   bootstrap() implementation cùng khuôn validate — source được parse lại và coordinates tách độc-lập từ path.
3. connector src/db/repository.ts (~+95): LegacyTransitionInput; interface
   +bootstrapVaultRevision; implementation single-tx như trên (SHA baseline
   723424c7…/739 dòng).
4. connector src/services.ts (~+40): DurableConnectorManagement.bootstrapRevision
   — validate source/binding TRƯỚC mọi read, legacy clone + derived-ref
   collision guard, registry check.
5. connector src/http/server.ts (~+27): ConnectorHttpStore.bootstrapRevision
   + route /revisions/bootstrap (đọc body cùng khuôn route /revisions).
6. Tests doubles mở rộng (interface widen): 7 file connector test thêm
   bootstrapRevision throw-unused một dòng (security-lifecycle,
   runtime-foundations x2 chỗ, reliability-security, r1-d-lifecycle-offline,
   r1-d-03, composition) — hành vi không đổi.
7. Suite MỚI orchestrator tests/credential-legacy-transition-offline.test.ts
   (391 dòng, 13 test) + suite MỚI connector
   tests/vault-bootstrap-offline.test.ts (324 dòng, 11 test) — chi tiết Verify.

### Verify (offline; exit code + chữ ký đỏ nguyên văn trong transcript)
- Suite mới orch 13/13: transition happy (vault write THẬT qua VAULT-02
  fixture, chuỗi gọi store đúng thứ tự [get:tenant-a, get:, bootstrap],
  chain legacy không đổi, audit không leak plaintext); không-declared 403
  invariant (zero writes); bound-chain rotate thường (bootstrap=0);
  disagreement-refusal (403 + message riêng + zero writes + chỉ một lần
  get:tenant-a); unbound-không-legacy 403; 404 cả hai mode; store-thiếu-bootstrap
  501 với orphan-vault đúng-một-version; foreign tenant candidate 422
  pre-write; ctor fail-fast. Http adapter: 4 test URL/body (unbound URL
  byte-identical; ?tenant= xuất hiện; bootstrap POST đúng route+coordinates;
  legacy source bị 422 trước mọi call).
- Suite mới conn 11/11: repo (open ACTIVE rev1 fresh-ref + legacy nguyên
  vẹn; replay cùng pin converges (inserts=1); replay khác pin 403; không
  legacy -> INVALID_INPUT zero-insert; foreign-path zero-statement);
  mgmt (derive ref + clone; collision INVALID_INPUT pre-write; corrupt-row
  fail-closed CREDENTIAL_INVALID — phát-hiện-ngoài-lề khi seed sai được ghi
  thành test; validate-before-read zero-statement; vault-kind-unbound
  not-transitionable; second-bootstrap convergence).
- Mutation probes (dự đoán chữ ký TRƯỚC):
  M1 = xóa mismatch guard => đỏ ĐÚNG W4, nhưng phát hiện thứ nhất: fixture
      W4 dùng accountId viết HOA ('du-conn-openai-OTHER') nên rớt regex
      VAULT_ACCOUNT trước cả guard cần đo — red giả định không đạt; lane SỬA
      fixture thành valid-shape ('acct-second') + assert message riêng,
      rồi đo lại: đỏ đúng như dự-đoán-cập-nhật (422 INVALID_SCHEMA thay vì
      403 disagrees) — chứng minh guard là thứ duy nhất đứng giữa request
      lệch và vault write. Ghi lại nguyên văn để KHÔNG nuốt bài học
      vacuous-fixture (xem feedback docs-lane cùng họ).
  M2 = xóa collision guard => đỏ ĐÚNG test collision, nhưng bằng raw
      Error từ chain-guard fake ('guard: chain bound to another tenant') —
      chính-là-luận-điểm: guard service biến một DB-violation thô thành
      INVALID_INPUT có kiểu trước mọi write.
  Restore byte-exact cả hai: 5 file src SHA khớp baseline (496c08cf/6cd185c4/
  723424c7/7745693e/c4873605); residue PROBE-TMP grep = 0.
- Evidence ×3 (gộp regression mỗi service, trên bytes cuối):
  ORCH 5-suite: Tests: 80 passed, 80 total — ba lượt Exit Code: 0 (transcript
  E1..E3 + lượt chốt đếm-số);
  CONN 11-suite: Tests: 137 passed, 137 total — ba lượt Exit Code: 0.
- Lint: connector Exit Code: 0; orchestrator Exit Code: 0 (cả hai sau cùng).

### Δ-DEVIATION (không ngầm nuốt)
- Δ18: nhận định của Reviewer (T170-V1) mô tả đúng TRIỆU CHỨNG nhưng thiếu
  hai khâu gốc khác (K1 unscoped-GET, K2 clone-CAS-structural). Lane sửa trọn
  ba khâu; nếu fleet chỉ nghiệm thu symptom-403 thì K1/K2 vẫn còn đó — đề
  nghị coordinator ghi lại nguyên nhân-ba-tầng vào adjudication.
- Δ19: seam cấu hình = tham số constructor createCredentialWorkflow; lane
  KHÔNG đụng ServerConfig/main.ts/Dockerfile vì credentialWorkflow được inject
  từ composition root phía deploy (kiến trúc VAULT-03 sẵn có). Deploy-owner
  cần wire initialBindings thật (compose env/secret) trước khi transition
  khả-dụng trên cluster; lane không tự mở mặt trận deploy.
- Δ20: bootstrap tạo ACTIVE trực tiếp — NGOẠI LỆ có chủ đích so với trật tự
  write-PENDING-then-CAS-activate của VAULT-03; lý do: rev1-bound không có
  CAS-base, và mọi lựa chọn thay thế (expectedCurrent=0 route hack, pseudo-
  row) đều mở surface lớn hơn. Crash-window trước INSERT = vault orphan
  (vô hại, đã-pinning-SEC-04), sau INSERT = chain hoàn chỉnh. Cần ratify.
- Δ21: quy ước tên chain-key derived (cred-<connector>-<account>) là lane
  tự-chọn vì migration 008 không định nghĩa tên transition-chain; đổi một
  dòng services.ts nếu fleet có quy ước khác. Va-chạm-collision được quản
  bằng guard (test chứng minh).
- Δ16 kéo dài: hai statement SELECT-FOR-UPDATE + INSERT ACTIVE của
  bootstrapVaultRevision chỉ được verify bằng fake router (có replay
  trigger-analog) — lượt live-PG kế tiếp của Tester nên GOM cả cycle 9 lẫn
  cycle 10 (một window đóng hai gate).
- Ghi chú nhỏ: test collision ban đầu seed row VI PHẠM chính invariant
  persisted (legacy source + account column) và storage-layer fail-closed
  trước service guard — lane giữ cả hai kịch-bản thành hai test phân biệt
  (corrupt-row CREDENTIAL_INVALID vs collision INVALID_INPUT), không xóa.

### Tự phân loại 4 tầng
- SPECIFIED: packet đủ hướng nhưng mô-tả nhân quả MỘT tầng; lane xử ba tầng
  và flag Δ18 thay vì âm-thầm hấp-thụ.
- IMPLEMENTED: transition trọn chuỗi config->workflow->http-store->route->
  repository, tương-thích tuyệt đối khi không khai binding.
- VERIFIED (offline): 13+11 test mới; 80+137 gộp regression; M1/M2 đỏ
  đúng-cầu sau khi chính chữ-ký (M1 lần một đỏ SAI do fixture); lint 0 x2.
- live [MỞ]: Δ16-gom (bootstrap statements + ingestion statements, một
  window). ACCEPTED: không thuộc quyền lane.

## 11 — CYCLE 11: W-INGEST-POST-LEASE-FENCE-1 (T180-D1 post-lease ownership fence + T180-D2 artifact consistency)
### Bối cảnh (đo trước khi sửa)
- Nguồn: Reviewer Turn 180 audit (reports/review.md:954,958) + coordinator
  hướng dẫn kỹ thuật (coordinator-antigravity.md:2419-2420): attempt/owner
  token trong stamp/complete/retry; verify operation, task, hash, size khi
  replay/conflict; bound-or-renew lease theo transfer deadline.
- Đúng như Reviewer mô tả: cycle-9 COMPLETE_SQL/RETRY_SQL update theo id
  đơn lẻ; materializeArtifactRow tin (tenant,key,version) rồi trả id KHÔNG
  đọc lại sha/size/operation/task; PK-conflict path trả id tất định mà
  không thấy persisted row. Baseline suite 24/24 Exit Code: 0, lint 0.

### Thiết kế fence (T180-D1)
- TOKEN: claim tx SELECT FOR UPDATE SKIP LOCKED rồi stamp attempts+1 —
  token của người chạy = pre-stamp attempts + 1 (stamp nằm trong tx đang
  giữ row lock nên cộng thức chắc chắn). Mọi reclaim hợp lệ của replica
  khác tất yếu bump attempts ⇒ token cũ chết.
- assertOwnership = hai statement: SELECT id FROM outbox WHERE id=$1 FOR
  UPDATE (KHÓA hàng outbox trong tx đang commit — đóng cửa sổ renew-vs-
  reclaim giữa chứng) + UPDATE renew claim_until với điều kiện
  attempts=token AND dispatched_at IS NULL AND claim_until>now();
  rowCount 0 ⇒ IngestionPreemptedError. Đặt tại: pre-acquire (trước khi
  tốn download), TRONG materialize tx, TRONG gate tx, TRONG escalate tx
  (trước mọi FAIL write). Pre-acquire chỉ hẹp cửa sổ (không giữ lock);
  ba chỗ sau atomic với write của chúng.
- In-tx gate guard cần gate chạy trên client của caller ⇒ refactor
  submission.ts: markIngestionReadyOn(client, ...) xuất statements gốc
  (byte-identical), markIngestionReady giữ nguyên chữ ký + hành vi cũ
  (thêm commitGuard TÙY CHỌN chạy đầu tx); processIngestionTask thêm
  tham số guard forward-through. Consumer gọi markIngestionReadyOn là
  lane-internal; lane khác KHÔNG gọi trực tiếp (guard ngoài thì mất
  atomicity) — pin ở Δ23.
- COMPLETE_SQL/RETRY_SQL thêm AND attempts = $2; rowCount 0 ⇒
  preempted (RETRY: không reset lease chủ mới; ESCALATE: không FAILED
  op mà chủ mới có thể đang mở thành công — test bất tử hoá cả hai).
- Layering còn lại: duy nhất window gate-COMMIT→COMPLETE-stamp không
  fence-in-tx nào phủ ⇒ chính COMPLETE guard nhận (test layering: gate
  vẫn open đúng, row KHÔNG bị A stamp, B lease còn nguyên, B re-claim
  sau expiry → replay-stamp sạch, không ready-row thứ hai).
- Lease BOUND: ctor từ chối claimLeaseSeconds*1000 <= transfer.timeoutMs
  (mặc định 300s vs 60s SDK; cấu hình non-sense chết ngay khi dựng).
- Result thêm bucket preempted (row được giữ nguyên cho chủ mới —
  không stamp, không re-arm, không escalate).

### Thiết kế consistency (T180-D2)
- ARTIFACT_FIND nay SELECT id, operation_id, task_id, sha256, size_bytes
  ... LIMIT 2: 0 hàng ⇒ INSERT như cũ; ≥2 hàng ⇒ MATERIALIZATION_CONFLICT
  (không pick bừa); đúng 1 hàng ⇒ PHẢI khớp cả 4 cột với receipt (sha so
  sau lowercase) rồi mới reuse; INSERT ON CONFLICT rowCount 0 ⇒ RE-READ
  persisted row by id + cùng 4-column check, hàng-không-đọc-được ⇒
  MATERIALIZATION_FAILED retryable (biến mất giữa tx là lạ, cho retry)
  còn mismatch ⇒ conflict.
- Conflict là DETERMINISTIC: re-delivery không sửa được stored row ⇒
  thêm vào PERMANENT_CODES, escalate FAILED(MATERIALIZATION_CONFLICT)
  ngay — không đốt backoff. Mã đi trên SourceIngestionError bằng cast
  (union SourceIngestionErrorCode thuộc worker-sdk, lane không sửa
  package khác) — và PHẢI là SourceIngestionError vì handler worker-sdk
  wrap mọi error khác thành MATERIALIZATION_FAILED retryable (test
  MATERIALIZATION_FAILED cycle 9 vẫn đúng hành vi nhờ cùng cơ chế).

### Files
- src/modules/operations/ingestion-consumer.ts 456→607 dòng (SHA 4fcac325…)
- src/modules/operations/submission.ts 569→600 dòng (SHA 64f050a3…)
- tests/url-ingestion-consumer-offline.functional.test.ts 937→1213 dòng
  (SHA b105d90b…): fake router THÊM nhánh fence/lock + COMPLETE/RETRY
  text-sensitive (SQL mất guard ⇒ fake thôi enforce ⇒ mutation ĐỎ thật,
  cùng bài học dispatcher cycle 9) + option stealAfterGuard.

### Verify (offline; nguyên văn trong transcript)
- 9 test mới: T180-D1 mid-download steal ⇒ preempted:1, artifact 0, gate
  đóng, row/dispatched/lease của B nguyên; stale RETRY không re-arm
  (attempts 2, claim_until B còn hạn, dispatched null); stale escalation
  KHÔNG FAILED op (op PENDING, error_code null, preempted 1); unit
  commit-guard — guard throw ⇒ ZERO gate statement; ctor lease<deadline
  từ chối; layering gate-open-but-unstamped + B replay-stamp; T180-D2
  sha-corrupt reuse ⇒ conflict FAILED, stored row KHÔNG đổi, không row
  thứ hai; hai-row cùng version ⇒ conflict không pick; PK-conflict
  RE-READ hàng khớp ⇒ adopt đúng id, gate mở opened:1.
- Fake cũng phải dạy lại ARTIFACT_FIND (5 cột, LIMIT 2), BY_ID, STAMP
  rowCount; 24 test cũ chỉ đổi các literal sweep sang thêm preempted: 0.
- M1 = xóa AND attempts=$2 khỏi COMPLETE_SQL ⇒ ĐỎ đúng test layering
  tại expect(row.dispatched_at).toBeNull() Nhận timestamp (32 xanh còn
  lại — chứng minh guard thật sự chặn stamp).
- M2 = persistedMatches trả true hằng ⇒ ĐỎ đúng test digest-disagree
  tại expect(sweep.opened).toBe(0) Nhận 1 (32 xanh còn lại). Restore
  byte-exact: SHA 3 file khớp baseline, residue PROBE-TMP src+test = 0.
- Evidence ×3: Tests: 33 passed, 33 total — Exit Code: 0 cả ba lượt.
- Collateral 4 suite submission/dispatcher cũ: 30/30 Exit Code: 0
  (markIngestionReady chữ ký cũ tương thích 100% với caller cũ).
- Lint src: Exit Code: 0 (lint là gate tsc thật của cả submission+consumer).

### Δ-DEVIATION
- Δ22: FOR UPDATE serialize semantics (reclaim không chen được vào giữa
  gate tx) chỉ MODELED — fake router không có lock thật. Đúng như Δ16
  đã ghi: cần lượt live-PG; lần này GOM thêm 3 statement fence/lock +
  guarded COMPLETE/RETRY vào danh sách cần chạy thật.
- Δ23: markIngestionReadyOn + tham số commitGuard mới của
  markIngestionReady/processIngestionTask là API surface mới của
  submission.ts — mọi caller cũ không đổi hành vi; coordinator nên pin
  để lane khác (Qwen-4/Tester) không dùng *On trực tiếp mà bỏ guard.
- Δ24: MATERIALIZATION_CONFLICT là code CAST, nằm ngoài union
  SourceIngestionErrorCode của worker-sdk (lane không sửa package
  không-phải-mình). Muốn chính-thống-hoá: thêm vào union bên worker-sdk — decision
  cross-lane, lane không tự làm. Lưu ý: DB error_code persists string
  này cho operation FAILED (mới, cần biết khi làm ops UI).
- Δ25: pre-acquire ownership check CHỈ hẹp cửa sổ (lock of that tx
  released immediately); nếu fleet muốn zero-waste (không download khi
  chắc mất row) thì cần lease-table riêng — quá packet, ghi nhận.
- Packet ghi đúng symptom cả hai finding; không có mâu thuẫn packet-vs-code
  phát hiện được như vài cycle trước. Phạm vi file khớp: packet nêu
  url-ingestion-consumer-offline.functional.test.ts và suite đó thật sự là
  nơi mở rộng (data suites chỉ là cách gọi chung).

### Tự phân loại 4 tầng
- SPECIFIED: packet rõ, đủ tiêu chí nghiêm thu offline.
- IMPLEMENTED: fence 4 tầng (token, renew+lock in-tx ×3, guarded stamps,
  lease bound) + consistency 4 cột (find/verify/re-read/multi-conflict).
- VERIFIED (offline): 33/33 ×3 literal exit 0; M1/M2 đỏ đúng một-test
  như dự đoán; collateral 30/30; lint 0. FOR UPDATE semantics: modeled,
  chưa PG thật (Δ22).
- ACCEPTED: không thuộc quyền lane. live-PG (Δ16-GOM, giờ ba cycle
  chung một window đề xuất) vẫn chờ Tester.

### 12 — W-INGEST-PG-FAILCLOSED-1 (cycle 12: reject URL ingestion tại submit khi storage backend không phải S3 — T180-D3)
#### Bối cảnh (đo trước khi sửa)
- Reviewer T180-D3 + coordinator decision: chọnFail-Closed Reject tại
  submit-time (phương án 1/3 mà Mục 9 Δ13 để ngỏ). Anchor packet
  server.ts:395-419 (ingestionConsumer = s3-only) ĐÚNG tại thời điểm đo
  (re-grep fresh). Chuỗi limbo cũ: dispatcher loại gate-ingestion (cycle 9),
  consumer chỉ tồn tại khi backend s3 ⇒ trên postgres, row
  PENDING_INGESTION không ai mở, không ai báo.
- Baseline trước sửa: url-ingestion-offline 3, artifact-submit-guards,
  br12 18, mm05-offline 4 — 30/30 Exit Code: 0; lint 0.

#### Thay đổi (chỉ services/orchestrator — đúng phạm vi packet)
1. submission.ts:58-70 SubmissionServiceOptions thêm
   storageBackend?: postgres|s3; ctor :~88 resolve
   storageBackend ?? postgres (FAIL-CLOSED: deployment chưa nối =
   không-phải-s3); submit() chặn ngay sau schema-parse-trước-mọi-DB-call:
   sourceUrl && backend!==s3 ⇒ unprocessable(422,
   UNSUPPORTED_STORAGE_BACKEND, "URL ingestion requires an
   S3-compatible storage backend") — routes tự render problem+json
   (khuôn HttpError hiện hữu). ZERO operation/task/outbox row; schema
   parse phía trên là pure nên lời hứa zero-DB là cấu trúc, không phải
   tình nguyện.
2. server.ts:330-336: createSubmissionService nhận
   storageBackend: storageConfig.backend — MỘT nguồn sự thật với
   ingestionConsumer :395 (cùng điều kiện s3), không tham số rời có thể
   lệch nhau.
3. backend s3: hành vi 202 PENDING_INGESTION + gate-ingestion outbox giữ
   NGUYÊN 100% (test F3 chứng minh bằng captured INSERT params, không
   bằng echo-fake); inline payload postgres giữ ACCEPTED/READY, payload
   outbox không gate key (F4).
4. tests/url-ingestion-offline.functional.test.ts: test 1 truyền
   explicit storageBackend: s3 (suite này mô tả accepted-side; default
   fail-closed mới sẽ 422 nó nếu không opt-in — align test, không nới
   src).
5. NEW tests/url-ingestion-backend-failclosed-offline.test.ts (121 dòng,
   4 test): F1 postgres+URL 422 đúng code+message+calls.length===0;
   F2 absence-of-option cũng 422 (default fail-closed); F3 s3+URL
   PENDING_INGESTION qua cả INSERT operations[6]/tasks[4]/outbox
   payload gate+sourceUrl; F4 postgres+inline ACCEPTED/READY, không
   gate/sourceUrl key trong dispatch payload.

#### Verify
- Baseline→sau sửa: failclosed 4/4 + url-ingestion-offline 3/3 =
  Tests: 7 passed, 7 total — E1 Exit Code: 0; E2 Exit Code: 0;
  E3 Exit Code: 0 (ba lượt liên tiếp, bytes cuối).
- Collateral 4 suite (consumer 33 + guards + br12 + mm05):
  Tests: 60 passed, 60 total, Exit Code: 0 — submission path không
  lane-đọc-được-qua-route nào khác dùng sourceUrl (grep toàn repo
  tests: chỉ suite của chính lane; e2e root: 0 hit).
- Lint: tsc -p tsconfig.json Exit Code: 0.
- Mutation controls (dự đoán chữ ký trước):
  M1 = xóa cả khối check ⇒ đỏ ĐÚNG F1+F2 (promise resolved instead of
       rejected — tái hiện chính xác bug limbo: 202 PENDING_INGESTION
       trên postgres); F3/F4 xanh (hành vi đúng còn nguyên).
  M2 = đổi code+message (INVALID_SCHEMA/bad message) ⇒ đỏ ĐÚNG F1+F2
       qua diff toMatchObject (code/message), status vẫn khớp — chứng
       minh test soi đúng danh tính lỗi, không chỉ 422chung-trung.
  Restore byte-exact: submission.ts SHA e100add8… khớp baseline;
  residue M1-PROBE|M2-PROBE|bad message = 0.

#### Δ-DEVIATION
- Δ26: rejection đặt ở createSubmissionService (packet cho phép or
  submitOperation) — submitOperation không tồn tại như symbol riêng;
  service boundary là chỗ duy nhất có options.backend.
- Δ27: deployment đi qua createApp luôn nhận storageBackend đúng
  (server.ts truyền tường minh); caller THỦ CÔNG createSubmissionService
  (integration tests ngoài orchestrator, harness future) nhận default
  fail-closed postgres — nếu harness muốn URL phải tự giác truyền
  s3. Đây là lựa chọn Có chủ đích (fail-closed default) — ghi để
  coordinator khỏi bất ngờ vì 422 ở nơi không-đặt-tên.
- Δ28: packet demo code UNSUPPORTED_STORAGE_BACKEND + title S3-
  compatible — lane giữ nguyên text message đó; problem+json do
  error-handler hiện hữu render (như INVALID_SCHEMA 422 cũ) — không
  đụng http/ingress.
- Phạm vi: không sửa package ngoài orchestrator; không schema; không
  live window; không commit/push.

#### Tự phân loại 4 tầng
- SPECIFIED: packet rõ, kỹ thuật đầy đủ, quyết định 1/3 đã chốt.
- IMPLEMENTED: admission reject 422 + default fail-closed + wiring
  một-nguồn-sự-thật + 4 test fail-closed/compat.
- VERIFIED (offline): 7/7 ×3 literal Exit Code: 0; collateral 60/60;
  M1/M2 đỏ-đúng-cầu từng test-one như dự đoán; lint 0; restore byte-exact.
- ACCEPTED: không thuộc quyền lane. Δ13-của-cycle-9 ĐÓNG ở mức chính
  sách (coordinator đã chọn reject); live-PG gate Δ16-GOM không đổi
  (submission path mới cũng chỉ model-fake — cùng lượt window Tester).

## 13 — CYCLE 13: W-INGEST-0019-2 (deadline_at sentinel = Const literal inline, khop 0019)

#### Bối cảnh (đo trước khi sửa)
- Packet W-INGEST-0019-2 (task_370713dea9d2, dispatch ctx_f57469bd76f4); F01 HIGH
  từ hourly review Turn 219. 0019 đã ship 4 expression index bake Const literal,
  nhưng query bind sentinel qua Param -> planner không coi Param bằng Const ⇒
  không chọn index ⇒ tái hiện T-35 (Sort -> Seq Scan).
- Neo packet đọc fresh TRƯỚC khi sửa (src trôi dòng liên tục): map sentinel 2526,
  bindOperationsListSortKey 2547, bindOperationsCursor 2585, listOperationsPage
  2620, call site 2636 — tất cả ĐÚNG tại thời điểm đo.
- Baseline cùng lệnh TRƯỚC sửa (4 suite liên quan, cwd services/orchestrator):
  Tests: 144 passed, 13 skipped, 157 total — Exit Code: 0. 13 skip =
  admin-keyset-explain (gate DU_LIVE_INFRA; lane không mở window).

#### Thay đổi (duy nhất services/orchestrator/src/server.ts — đúng phạm vi packet)
1. bindOperationsListSortKey(sort): bỏ tham số params + bỏ params.push. Nhánh
   nullable trả COALESCE(<column>, '<sentinel>'::timestamptz), sentinel lấy từ
   CHÍNH map OPERATIONS_LIST_NULL_SORT_BOUND_SQL theo direction — một map phục vụ
   cả hai nửa hợp đồng (literal trong ORDER BY + value cursor mang cho key NULL),
   nên hai nửa không thể lệch nhau.
2. Call site listOperationsPage:2645 goi bindOperationsListSortKey(sort). pageParams
   vẫn theo thứ tự filter params -> cursor boundary params -> limit. Không còn slot
   sentinel ở giữa ⇒ filter KHÔNG đổi số thứ tự; với cursor + deadline_at, limit tụt
   từ $6 xuống $5 (self-consistent vì LIMIT đọc pageParams.length lúc build).
3. bindOperationsCursor KHÔNG đổi: vẫn push (cursor.createdAt, cursor.id) và
   $<len-1>::timestamptz, $<len>::uuid — boundary vẫn param-bound đúng packet;
   sentinel giờ nằm trong sortKeySql mà nó nội bao.
4. Bốn comment sửa cho khỏi nói dối: NULLABLE_SORT_FIELDS (bound sentinel ->
   sentinel literal), map sentinel (ghi rõ một-map-hai-nửa + phải khớp 0019
   byte-for-byte), doc của bindOperationsListSortKey (Const vs Param + lý do index
   chết), comment call site.

SQL before/after (deadline_at:desc, không filter, có cursor):
BEFORE  WHERE (COALESCE(deadline_at, $1::timestamptz), id) < ($2::timestamptz, $3::uuid)
        ORDER BY COALESCE(deadline_at, $1::timestamptz) DESC, id DESC LIMIT $4
        params = [sentinel, cursorCreatedAt, cursorId, limit+1]
AFTER   WHERE (COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz), id) < ($1::timestamptz, $2::uuid)
        ORDER BY COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC LIMIT $3
        params = [cursorCreatedAt, cursorId, limit+1]
Minh bạch bằng chứng: khối AFTER trên là composed (đọc code + số học placeholder).
Phần in NGUYÊN VĂN từ route là ca không-cursor, ghi ở E3.

#### Verify (offline; exit code nguyên văn từ wrapper)
- E1 Typecheck dạng packet: pnpm --filter @du/orchestrator typecheck
  (tsc --noEmit -p tsconfig.json) — Exit Code: 0.
- E1b Dạng lệnh user giao: npx tsc --noEmit -p tsconfig.json trong
  services/orchestrator — Exit Code: 0. Δ11 vẫn đúng: tsconfig exclude tests ⇒
  gate này không phủ file test.
- E2 Byte-identity với 0019 (scratch check, không phải artifact):
  desc = COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)
  asc  = COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz)
  mỗi expression xuất hiện ĐÚNG 2 lần trong 0019 (tenant-led + key-led) ⇒ khớp 4/4
  index từng ký tự. Thêm: sortFn không còn params.push, không còn dạng
  $<len>::timestamptz; cursorFn chỉ push cặp boundary; cursorFn không tham chiếu
  map sentinel. Kết quả: ALL CHECKS PASS — Exit Code: 0.
- E3 Route-emitted SQL, BẮT NGUYÊN VĂN từ harness conformance (không đoán):
  SELECT * FROM operations ORDER BY COALESCE(deadline_at,
  '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC LIMIT $1
  ⇒ hết-cursor: limit là $1 (không còn slot sentinel), id tiebreak còn nguyên.
- E4 4 suite liên quan, 3 lượt liên tiếp, KẾT QUẢ GIỐNG HỆT:
  run1/run2/run3 — Test Suites: 3 failed, 1 passed, 4 total;
  Tests: 14 failed, 13 skipped, 130 passed, 157 total — Exit Code: 1 cả 3 lượt.
  (Baseline cùng lệnh trước sửa: 144 passed / Exit Code: 0.)
- E5 Collateral full unit offline (pnpm run test:unit): Test Suites: 4 failed,
  1 skipped, 70 passed, 74 of 75; Tests: 15 failed, 28 skipped, 1774 passed,
  1817 total — Exit Code: 1. 15 = 14 của E4 + 1 pre-existing (Δ31).
- E6 Integrity file: server.ts CRLF thuần (3256 CRLF, 0 lone LF, 0 lone CR), 79
  em-dash còn nguyên, không U+FFFD; sha256_8 = 29c79b1a, 3257 dòng (baseline
  cycle 12 ghi aaea7f44…/3248 ⇒ +9 dòng, đúng bằng phần comment thêm vào).
  Migration 0019 KHÔNG đổi: 5129 bytes, sha256_8 = 8554cbba, 4 CREATE INDEX.
- Không mutation probe: packet không yêu cầu, và lane không mở file test của lane
  khác để dựng probe.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ29 — acceptance của packet tự mâu thuẫn với phạm vi ghi của nó. Điều kiện
  'existing suites still pass' KHÔNG đạt được nếu chỉ được sửa server.ts: 14 test
  đỏ nằm ở 3 suite Admin-lane, tất cả parse SQL do route phát ra và GIẢI sentinel
  qua placeholder:
  (a) tests/operations-list-contract-conformance.test.ts:227-228 (bảng
      ORDER_BY_BY_SORT) + test mang tên 'the NULL sentinel for the nullable column
      is bound, not interpolated' :314-330 — test này assert CHÍNH chiều ngược với
      fix (đòi sql không chứa '0001-01-01' và params phải chứa sentinel).
  (b) tests/admin-operations-list-pagination.test.ts:1743 — regex fake-DB chỉ nhận
      dạng COALESCE(<col>, $<n>::timestamptz) ⇒ 5 test throw 'unrecognised ORDER BY
      key expression'.
  (c) tests/admin-operations-sort-http-offline.test.ts:164 BOUNDARY_RE + :189 nhánh
      COALESCE ⇒ fake-DB không diễn giải được ⇒ 7 test nhận 500 thay vì 200.
  Lane KHÔNG sửa (đúng quyền sở hữu; Admin lane đang active, chạm vào là hỏng nhau
  trong checkout dùng chung). Đề xuất: packet W-ADMUX02-SORT-LITERAL-ALIGN-1 cho
  Admin lane, hoặc cấp quyền cho lane này sửa 3 harness.
- Δ30 — hợp đồng tài liệu + chú thích migration thành stale, lane không được sửa:
  docs/06-public-api.md:74 và docs/20-openapi-descriptions.md:39 mô tả sentinel
  dang 'đã bind'/'bound sentinel'; 0019 header (12-24) mô tả query là
  COALESCE(deadline_at, $sentinel::timestamptz); review.md:965, qwen-docs.md:2163
  và qwen-docs.md:2249 cũng vậy. Neo 0019 header server.ts:2547/2593/2659 sau sửa
  là 2556/2594/2668 (+9) — Reviewer/Tester nên định vị theo symbol, không theo số
  dòng. Δ24 cấm sửa migration đã apply nên lane để nguyên và ghi lại đây.
- Δ31 — collateral pre-existing KHÔNG thuộc packet:
  tests/connector-revision-http-offline.functional.test.ts (VAULT-06, file UNTRACKED
  trong git) đỏ 1 test 'restart/reconcile: stranded PENDING...' —
  expect(stranded.revision).toBe(2) nhận undefined. Đỏ y hệt khi chạy riêng lẻ
  (Exit Code: 1) và không chạm đường SQL nào của cycle này. Lane nhận thiếu sót
  protocol ở đây: chỉ baseline 4 suite trước khi sửa, không baseline full suite,
  nên không có bằng chứng tiền kiểm cho tính pre-existing — bằng chứng hiện có là
  cô lập symbol + untracked + đỏ độc lập. Đề xuất Verify xác nhận nguồn gốc (vùng
  Vault lane Δ7/Δ8).
- Rủi ro operational cho gate live (nêu thẳng, không chôn): nếu Tester chạy live
  EXPLAIN bằng SQL viết tay trong admin-keyset-explain.test.ts:448-470 (dạng
  $2::timestamptz), họ đang EXPLAIN lại hình thái CŨ và sẽ tái falsify. Live window
  phải chạy theo hình thái literal mới, cả hai chiều, tenant-scoped + cross-tenant,
  COSTS OFF; chỉ báo Index Scan trên operations_*_deadline_coalesce_*_id_idx khi
  Sort biến mất.
- Phạm vi: chỉ server.ts; không migration; không contracts; không docs; không test
  lane khác; không live window; không commit/push.

#### Tự phân loại 4 tầng
- SPECIFIED: packet rõ; F01 deterministic; literal target lấy từ 0019:66-79.
- IMPLEMENTED: sort-key builder phát Const literal theo direction; bỏ params
  coupling; cursor boundary vẫn param-bound; call site + comment cập nhật.
- VERIFIED (offline, MỘT PHẦN): tsc 0 ở cả hai dạng lệnh; byte-identity 4/4 với
  0019; SQL route-emitted đúng hình thái (bắt nguyên văn); 1774 test còn lại xanh;
  14 đỏ deterministic x3 và nằm toàn bộ ở harness ngoài phạm vi ghi. CHƯA VERIFIED:
  hành vi phân trang deadline_at với SQL mới (fake-DB Admin chưa hiểu hình thái mới
  ⇒ chưa có bằng chứng offline cho continuity/no-loss), và việc planner thật chọn
  index hay không.
- ACCEPTED: không thuộc quyền lane. T180-A1/T190-A1 vẫn chờ Tester live EXPLAIN;
  W-INGEST-0019-2 chỉ hết blocking khi Δ29 được adjudicate (suite xanh) + live
  green.

#### Phụ lục — lệnh tái hiện ( Verify / lane sau chạy lại được )
- cwd du-rework/services/orchestrator.
- Baseline TRƯỚC sửa, 4 suite liên quan: `pnpm run test:unit -- admin-operations-sort-http-offline admin-operations-list-pagination operations-list-contract-conformance admin-keyset-explain` -> Tests: 144 passed, 13 skipped / Exit Code: 0.
- Cùng lệnh SAU sửa (x3): Tests: 14 failed, 130 passed, 13 skipped / Exit Code: 1 (log giu tai .qwen/tmp/targeted-x2.log, targeted-x3.log).
- Typecheck: `pnpm --filter @du/orchestrator typecheck` (tu root du-rework) hoac `npx tsc --noEmit -p tsconfig.json` (tu cwd orchestrator) -> Exit Code: 0 ca hai.
- Byte-identity 0019: `node D:/Git/dugate/.qwen/tmp/w-ingest-0019-2-check.js` -> ALL CHECKS PASS / Exit Code: 0. Logic: lap lai expression COALESCE tu chinh map sentinel trong src, dem so lan xuat hien trong 0019 (ky vong 2 cho moi direction), va kiem bindOperationsListSortKey khong con push param. Scratch co the bi don khi tmp xoa — thu tuc van nguyen o tren.
- Collateral full offline: `pnpm run test:unit` -> Test Suites: 4 failed, 1 skipped, 70 passed, 74 of 75; Tests: 15 failed, 28 skipped, 1774 passed, 1817 total / Exit Code: 1 (log: .qwen/tmp/orch-unit-after.log).

#### Quyết định phạm vi (operator, 2026-09-27)
- CHOT: write scope van la `services/orchestrator/src/server.ts` dung packet. Lane KHONG sua file test cua lane khac trong checkout dung chung.
- Δ29 (14 test Admin) + Δ31 (connector VAULT-06 pre-existing) de coordinator dieu phoi lane Admin/Tester — khong phai bang chung fix sai, la packet thieu pham vi.
- Δ30 (docs/06:74, docs/20:39, 0019 header, neo dong 2547->2556/2594/2668) van mo; lane khong cham docs cung khong cham migration (Δ24).
- Lane khong commit, khong push, khong mo window DB/Redis/S3.

## 14 — CYCLE 14: W-VAULT-06-DELTA31 (fixture f3 sends the binding the route requires)

#### Bối cảnh + kiểm chứng chẩn đoán của packet (TRƯỚC khi sửa)
- Packet W-VAULT-06-DELTA31 (task_52ef79278fe6, dispatch ctx_ae5178a4b764) nói: đỏ
  ở connector-revision-http-offline.functional.test.ts do typo 'vault-kv-v2' ở
  341/355, sửa thành 'vault-kv2' là khớp check dòng 202 và 8/8 xanh.
- READ-ONLY probe bác bỏ ngay tầng hợp đồng: packages/contracts/src/vault.ts:170-191
  định nghĩa 'vault-kv-v2' là READ ALIAS có chủ đích cho snapshot VAULT-05, và
  ConnectorCredentialSourceSchema.transform canonicalize nó về 'vault-kv2'.
  parseCredentialSource (connector/src/vault/resolver.ts:48-49) dùng đúng schema đó.
- Probe trên artifact THẬT mà test require (connector/dist/vault/resolver.js, dist
  mtime 2026-09-26T18:25 fresh hơn src): parseCredentialSource({kind:'vault-kv-v2',
  ...}) -> OK, kind trả về = 'vault-kv2'. Không throw. Nên check dòng 202
  (source.kind !== 'vault-kv2') vốn ĐÃ pass sẵn với alias.
- Nguyên nhân thật đọc từ route: services/connector/src/http/server.ts:195-208 —
  POST /connectors/:id/revisions CHẶN trước mọi parse nếu body thiếu tenantId hoặc
  accountId (typeof !== 'string') => ConnectorError INVALID_INPUT => 400. Test gọi
  raw POST chỉ với { credentialSource } nên nhận 400, .json() không có field
  revision => expect(stranded.revision).toBe(2) nhận undefined. Đây là rot của
  fixture lane mình (f3, cycle 8, SHA pristine 012183af/18537) sau khi route mang
  binding bắt buộc (W-VAULT01-BIND-1R) — không phải lỗi lane khác.

#### Thực nghiệm có kiểm soát (mỗi bước một biến, revert byte-exact giữa bước)
- Baseline pristine: Tests: 1 failed, 7 passed — Exit Code: 1.
- A = đúng thay đổi packet (341/355 'vault-kv-v2' -> 'vault-kv2', không thêm gì):
  1 failed, 7 passed — Exit Code: 1. => CHẨN ĐOÁN CỦA PACKET BÁC BỎ bằng chạy thật,
  không bằng lý luận. Revert: SHA khớp 012183af/18537 byte-exact.
- B = chỉ thêm tenantId:'tenant-a', accountId:'du-conn-openai-main' vào hai body
  (giữ nguyên alias): 8 passed, 8 total — Exit Code: 0. => ĐÓ là root cause.
- A+B = trạng thái chốt (sửa đúng 2 dòng packet chỉ định, theo cả hướng canonical
  write lẫn binding): 8/8 — Exit Code: 0, ba lượt liên tiếp (run1/run2/run3).
- Full unit offline SAU sửa: Test Suites: 1 skipped, 74 passed, 74 of 75 total;
  Tests: 28 skipped, 1789 passed, 1817 total — 0 failed. Typecheck
  (pnpm run typecheck / tsc --noEmit -p tsconfig.json) Exit Code: 0.
- Δ31 trong Mục 13 ĐÓNG. Không sửa source sản phẩm, không sửa contracts, không
  migration, không window DB/Redis/S3, không commit/push.
- File chốt: tests/connector-revision-http-offline.functional.test.ts
  671603bf/18645/398 dòng (từ 012183af/18537; +108 bytes, số dòng không đổi).
- Ghi nhận cross-lane: 3 suite Δ29 (Admin) ĐÃ được lane Admin align lúc
  07:29:49Z / 07:29:21Z / 07:30:23Z — verified by CONTENT, không đoán: conformance
  giờ assert "COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)" và
  params NOT toContain sentinel; pagination parser:1743 nhận cả literal lẫn dạng
  legacy $n; BOUNDARY_RE:168 accepts the inline form. Full 74/74 xanh là vì vậy.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ32 — test 'invalid credential source at the HTTP edge' (dòng 377-383) là test
  ĐỎ VÌ LÝ DO SAI (vacuous): nó POST kind alias + path '../etc' nhưng cũng không gửi
  tenantId/accountId, nên 400 đến từ chặn binding (http/server.ts:195-208) TRƯỚC khi
  parseCredentialSource (:211) kịp chạy — ràng buộc path '../etc' chưa từng được
  thực thi ở route này. Đã ĐO chứ không suy: thêm binding vào đúng body đó => vẫn
  8/8 Exit Code: 0, tức 400 lúc đó mới thật sự đến từ vaultKv2Refine. Lane KHÔNG sửa
  vì packet chỉ định dòng 341/355. Đề xuất: hoặc cho lane này mở 1 dòng, hoặc giao
  Ai-That-Owns-Vault-Edge. Lưu ý đây là覆盖面 assertion an toàn (path traversal) nên
  không nên để trạng thái vacuous thêm nhiều cycle.
- Δ33 — hai chi tiết packet lệch source: (a) 'buildManagement check tại dòng 202'
  là `source.kind !== 'vault-kv2'` chạy SAU normalization, nên nó không phải chỗ
  'khớp' mà alias rớt; (b) packet không nhắc dòng 379 dù cùng dùng 'vault-kv-v2'.
  Lane vẫn đổi 341/355 sang 'vault-kv2' vì contracts ghi rõ new WRITES dùng
  'vault-kv2' (alias chỉ để READ snapshot cũ) — hướng đúng, nhưng không phải
  nguyên nhân; bằng chứng là cột A ở bảng thực nghiệm.
- Δ34 — cập nhật cho Mục 13: Δ29 (14 test Admin) đã được closure bởi lane Admin
  trước cycle này; lane không đụng file Admin nào trong cycle 14.

#### Tự phân loại 4 tầng
- SPECIFIED: packet rõ ràng về file/dòng/acceptance, nhưng nguyên nhân đưa ra sai.
- IMPLEMENTED: fixture 341/355 gửi đủ independent binding + dùng kind canonical.
- VERIFIED (offline): 8/8 x3 literal Exit Code: 0; full 74/74 suites + 1789 test
  xanh, 0 failed; typecheck 0; A/B isolation chứng minh nguyên nhân; revert
  byte-exact đã kiểm bằng SHA; không để lại probe residue (dòng 379 đã restore,
  alias_remaining=1 đúng pristine).
- ACCEPTED: không thuộc quyền lane. Δ31 đóng ở mức bằng chứng; Δ32 (test vacuous)
  cần adjudicate. Gate live của VAULT-06 (nếu có) vẫn thuộc Tester window.
#### Bổ sung Verify (cuối cycle 14 — đo thêm sau khi fix đã chốt)
- Full offline run 11:12Z (sau fix): Test Suites: 1 skipped, 74 passed, 74 of 75;
  Tests: 28 skipped, 1789 passed, 1817 total — 0 failed.
- Full offline run 11:19Z (cùng trạng thái file, không sửa gì thêm): 1 failed =
  admin-error-boundary-offline.test.ts 'IdP callback leg escaping upstream',
  `connect ETIMEDOUT 127.0.0.1:63378`; Tests: 1 failed, 1788 passed, Exit Code: 1.
- Cô lập suite đó: attempt1 ĐỎ (ETIMEDOUT port KHÁC: 63401), attempt2 XANH
  21 passed / Exit Code: 0, attempt3 XANH 21 passed / Exit Code: 0.
- Bằng chứng môi trường: Get-NetTCPConnection đếm 94.336 TimeWait và 87.071 socket
  LocalPort >= 49152 trên máy (toàn bộ fleet đang chạy). ETIMEDOUT (không phải
  ECONNREFUSED) + port thay đổi mỗi lần + mtime file 2026-09-25T18:27 (không ai sửa
  từ 2 ngày, ke ca cac source no do) => KHAO KHAN ephemeral-port, không phải regression.
- Δ35 (mở, đề nghị Verify/Coordinator ghi nhận là hazard môi trường, KHÔNG giao
  cho lane nào sửa code): suite loopback HTTP của Admin dễ đỏ dây chuyền khi máy
  cạn cổng tạm thời. Lần sau ai thấy đỏ ở suite này: kiểm port + chạy lại cô lập
  TRƯỚC khi nghi product; nên chạy trong quiet window (kiểu Δ82 QUIET-PORT của
  Admin lane) hoặc thêm retry/backoff cho connect.
- Chuốt lại Δ31 cho đúng chủ: connector-revision-http-offline.functional.test.ts
  chính là f3 của lane Platform (SHA 012183af/398 khớp record cycle 8), không phải
  file Vault lane. Mục 13 ghi 'pre-existing, untracked' là đúng trạng thái nhưng
  sai tư cách sở hữu; bản sửa nằm ở cycle 8 (seed binding), còn raw POST ở test
  restart/reconcile thì chưa từng được cập nhật sau khi route mang binding bắt buộc.
- Không có mutation probe cho cycle này: đối tượng sửa là fixture gọi HTTP, lưới
  bằng chứng là cặp thực nghiệm A/B + 8/8 x3 + full run.

## 16 — CYCLE 16: W-ENC-01-SCHEMA (encryption contract schemas, ADR-18 baseline)

#### Bối cảnh
- Packet dispatch ctx_5c53254b5b15 ban đầu bị BLOCKED (ADR-18 chua freeze).
  Operator clarifies: freeze restriction áp dụng cho runtime wire ENC-03/04,
  KHÔNG cho packages/contracts schema definitions. Proceed.
- ADR-18 baseline (docs/15-decisions.md:283-326): AES-256-GCM, chunk 4 MiB,
  manifest monotonic, HPKE RFC 9180 + RSA-OAEP-SHA256, Vault Transit DEK wrap.

#### Thay đổi (chỉ packages/contracts — đúng phạm vi packet)
1. NEW src/encryption.ts (196 dòng): 6 schemas + 2 constants.
   - StorageEnvelopeSchema: AES-256-GCM nonce/tag/ciphertext/aad.
   - EncryptedChunkSchema + EncryptedChunkManifestSchema: per-chunk SHA-256,
     monotonic index, totalChunks consistency (2 refine).
   - WrappedDekEnvelopeSchema: Vault Transit key name/version + wrapped DEK.
   - DeliverySuiteSchema: enum hpke-rfc9180 | rsa-oaep-sha256.
   - RecipientDeliveryEnvelopeSchema: suite-disambiguated enc + GCM fields.
   - ArtifactEncryptionRecordSchema: composite (envelope + dek + optional manifest).
   - TenantDeliveryPolicySchema: enabled + preferredSuite + recipientKeyIds,
     refine enabled-requires-keys.
   - Constants: ENCRYPTION_CHUNK_SIZE_BYTES (4 MiB), ENCRYPTION_SINGLE_BLOB_MAX_BYTES (5 MiB).
2. src/index.ts: thêm export * from ./encryption.
3. NEW tests/encryption.test.ts (310 dòng, 24 test): acceptance, rejection,
   monotonicity, suite disambiguation, policy invariant, constants.

#### Verify (offline, 3 lần liên tiếp, literal exit code)
- pnpm run lint (tsc --noEmit): Exit Code: 0.
- pnpm run test ×3:
  R1: Test Suites: 17 passed, 17 total; Tests: 385 passed, 385 total; Exit Code: 0
  R2: Test Suites: 17 passed, 17 total; Tests: 385 passed, 385 total; Exit Code: 0
  R3: Test Suites: 17 passed, 17 total; Tests: 385 passed, 385 total; Exit Code: 0
- encryption.test.ts: PASS (24 test) trong cả 3 run.
- Không đụng src ngoài contracts; không runtime; không live; không commit/push.

#### Δ-DEVIATION
- Δ36: Packet gốc yêu cầu EncryptedChunkManifest và EnvelopeCiphertext như hai
  schema riêng; lane gộp EnvelopeCiphertext thành StorageEnvelopeSchema (cùng
  shape) và thêm ArtifactEncryptionRecordSchema làm composite — tên khác,
  semantics giữ. Coordinator confirm nếu cần rename.
- Δ37: ADR-18 ghi "file > 5 MB chunked" nhưng không nói file = 5 MB xử lý sao.
  Lane chọn threshold là SINGLE_BLOB_MAX = 5 MiB (inclusive), chunk khi > 5 MiB.
  Constant export để runtime tham chiếu, không hardcode.

#### Tự phân loại 4 tầng
- SPECIFIED: ADR-18 baseline rõ; operator xác nhận scope contracts-only.
- IMPLEMENTED: 6 schemas + 2 constants + 24 test.
- VERIFIED (offline): 385/385 ×3 Exit 0; typecheck 0.
- ACCEPTED: không thuộc quyền lane. ENC-00 vẫn [~] cho tới khi 4 nhóm quyết
  định còn mở được ký (wire profile, response mode, key-policy timing, upload
  protocol). Schemas này là baseline shape, không phải contract freeze.


## 15 — CYCLE 15: Δ32 closure + W-ENC-01-SCHEMA BLOCKED

### Δ32 — test 377-383 vacuous → real path-traversal coverage (f3, lane Platform)

#### Bối cảnh
- Cycle 14 phát hiện: test "invalid credential source at the HTTP edge" (f3:377-383)
  đỏ vì lý do sai — 400 đến từ binding guard (thiếu tenantId/accountId) chứ chưa
  từng chạm vaultKv2Refine của path traversal. Đã đo: thêm binding vẫn 8/8.
- Cycle này: viết lại test với positive control + mutation proof.

#### Thay đổi (chỉ f3, test-only)
1. Test cũ 6 dòng → 26 dòng: helper post() + errOf() + BINDING_GUARD const +
   BINDING const. Ba assertion layer:
   (a) noBinding → 400 + message = BINDING_GUARD (chứng minh binding guard bắt
       trước parse — tức 400 này KHÔNG nói gì về path).
   (b) withBinding + traversal path → 400 + code INVALID_INPUT + message !=
       BINDING_GUARD + payload không chứa "../etc" (chứng minh path rule trả lời,
       không leak input).
   (c) Positive control: same request + canonical path → 201 + revision=2.
       Đây là bằng chứng 400 ở (b) là verdict về path, không phải missing field.
2. Xoá probe residue (4 console.log + 3 biến + helper post thừa) từ experiment
   cycle trước trong test restart/reconcile.

#### Mutation proof (M2)
- M2: đổi path traversal thành REASON.path (canonical) → assertion (b) ĐỎ:
  Expected: 400 / Received: 201. Chứng minh test nhạy cảm với đúng biến số.
- Restore M2 → 8/8 xanh.
- M1 (draft đầu thiếu account): test vẫn xanh với path hợp lệ → phát hiện
  vacuous → dựng positive control → M2 pass.

#### Verify
- 8/8 ×3 Exit Code: 0 (post-cleanup, SHA c2b19d73/18645/398 dòng).
- typecheck Exit Code: 0.
- f3: 012183af/18537 (baseline cycle 8) → 671603bf/18645 (cycle 14) →
  8e7e8aa9/19498 (Δ32 + probe) → c2b19d73/18645 (probe cleanup, final).

#### W-ENC-01-SCHEMA — BLOCKED (task_185188e4ac99, dispatch ctx_5c53254b5b15)

Không ghi code. Bốn bằng chứng trên disk:
1. coordination/packets/W-ENC-01-SCHEMA.md KHÔNG tồn tại (glob *ENC* = 0).
2. docs/15-decisions.md:324 (ADR-18 dòng cuối): "Không giao crypto wire
   implementation từ baseline này."
3. tasks/APP-ENCRYPTION-2026-09-27.md:16: "Không dispatch crypto wire
   implementation khi chưa freeze các quyết định này."
4. ENC-00 vẫn [~]; 4 nhóm quyết định mở chưa ký.
packages/contracts/src/encryption.ts chưa tồn tại — không scaffold trước.
Đề nghị coordinator thu hồi dispatch hoặc cung cấp packet + xác nhận freeze.

#### Δ-DEVIATION
- Δ32 ĐÓNG (cycle này). Không có Δ mới.
- Δ30 VẪN MỞ (docs/06:74, docs/20:39, 0019 header, neo server.ts).
- Δ35 MỞ (flake ETIMEDOUT loopback, môi trường fleet load).

#### Tự phân loại 4 tầng
- SPECIFIED: Δ32 phát hiện từ cycle 14, bản sửa rõ ràng.
- IMPLEMENTED: test viết lại với positive control + binding guard isolation.
- VERIFIED: 8/8 ×3 Exit 0; M2 đỏ đúng cầu; typecheck 0.
- ACCEPTED: không thuộc quyền lane.

---

## 17 — CYCLE 17: ENC-META-01 (control-plane metadata crypto — task_9997ff605662, ctx_3bee5d801816)

#### Scope as dispatched
- Owner: Qwen-Platform (Antigravity dispatch ctx_3bee5d801816).
- Allowed write: `src/modules/runtime/**`, `tests/runtime-encryption-metadata.test.ts`,
  `packages/contracts/src/encryption.ts`. NOT written: packages/contracts (no change
  needed — see Δ40), no other service, no migration, no commit/push, no live window.

#### Inventory — which control-plane columns carry tenant data
| slot | written at | read at |
|---|---|---|
| operations.input_ref | (submit, out of this packet) | runtime.ts:1554 buildClaimResult |
| tasks.payload_ref | :802 child insert, :840 parent continuation, :1087 resume input, :1467 join merge | :1569 buildClaimResult |
| human_waits.response_ref | :1060 resumeOperation | (admin resume read, out of scope) |
| step_checkpoints.output_ref | :450 saveStep | :1525 buildClaimResult |
- Idempotency read (not a slot, but must open before hashing): :731 spawnChildren
  existing-children replay. See the bug I introduced and fixed below.

#### Change
- NEW `src/modules/runtime/metadata-crypto.ts` (324 lines, sha aa200211). One
  authenticated envelope per control-plane value: AES-256-GCM over canonical JSON,
  a FRESH DEK per value wrapped through the ENC-02 Vault Transit provider, and an
  AAD that binds (tenantId, slot, refId).
- `runtime.ts`: optional 3rd param `metadataCrypto` on `createRuntimeService`
  (signature stays 1-arg compatible — 20+ existing callers untouched, proven by the
  regression run below), 2 helpers, 9 call sites, and 3 SELECTs that had to project
  `o.tenant_id` (spawnChildren, saveStep, reconcileParentJoin) because the AAD needs
  it and the original projection did not carry it.
- NEW `tests/runtime-encryption-metadata.test.ts` (278 lines, 23 tests, sha 29d3c225).

#### The two semantic breaks I had to fix in my own patch
Both were silent-wrong, not compile-error; both would have shipped as a green suite:
1. `spawnChildren` idempotency hashed the stored `payload_ref`. Once the column is
   sealed that compares a CIPHERTEXT hash to a PLAINTEXT digest, so every legitimate
   retry would have 409 INPUT_HASH_MISMATCH. Fixed by opening the stored value first
   (:731). Pinned by a test that asserts hashing the raw column does NOT match.
2. `buildClaimResult` passed `checkpointRefs[].outputRef` straight through. The
   contract declares a string, and a sealed value is an object — the claim snapshot
   would have failed its own schema. Fixed by opening per checkpoint under
   (tenant, slot, taskId:stepKey) (:1525).

#### Verify (offline, literal exit codes)
- `pnpm --filter @du/orchestrator exec tsc --noEmit` — Exit Code: 0 (log empty),
  re-run after every hunk; 2 intermediate failures fixed (ActiveLeaseRow.tenant_id,
  then the `string | undefined` AAD arg).
- New suite x3 consecutive: Tests: 23 passed, 23 total — Exit Code: 0, 0, 0.
- Regression, 4 existing runtime suites (mm10 claim-cancel, br08 cancel-resume,
  br12 isolation, mm05 queue-integrity): Tests: 44 passed, 44 total — Exit Code: 0.
  This is the evidence that the optional param really is backward compatible.
- M1 mutation (kill the AAD binding, replace deriveAad input with a constant):
  4 failed / 19 passed — exactly the 4 binding negatives (cross-tenant, cross-slot,
  cross-row, readStored-on-sealed) went red and nothing else did. Restored
  byte-identical: sha aa200211, 12142 bytes, MUTATION_LEFT=false, 23/23 green again.
- Full offline unit suite: Test Suites: 1 failed, 1 skipped, 80 passed, 81 of 82
  total; Tests: 1 failed, 28 skipped, 1877 passed, 1906 total — Exit Code: 1.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ36 — PACKET CLAIM BÁC BỎ bằng lệnh thật, lặp lại sau W-ENC-01-SCHEMA:
  `task_9997ff605662` yêu cầu "submit lưu encrypted ref/ciphertext TRƯỚC
  transaction". Không làm được trong write scope: `operations.input_ref` được ghi
  ở `src/modules/operations/submission.ts`, ngoài `src/modules/runtime/**`. Đây là
  điểm đầu tiên của danh sách packet nói "no plaintext trong input_ref" — gap thật.
  Cần packet riêng (hoặc mở rộng scope) cho submission.ts. Gateway upload (ENC-05)
  là packet khác, không gộp.
- Δ37 — `metadataCrypto` là tham số OPTIONAL nên production wiring nằm ngoài scope
  này: chưa có chỗ nào trong repo gọi `createRuntimeService(db, queue, crypto)`.
  Tới khi wiring được, cột control-plane VẪN plaintext trong mọi deployment. Đây là
  khoảng trống thật, không phải chi tiết hình thức — ENC-META-01 chưa đóng.
- Δ38 — chưa đổi `packages/contracts/src/encryption.ts` (nằm trong write scope nhưng
  không cần): envelope control-plane đã có shape riêng, version riêng, và mang
  `WrappedDek` của ENC-02. Thêm nó vào contracts bây giờ sẽ đóng băng một shape mà
  ADR-18 vẫn chưa freeze (open item 2: AAD + manifest + test vector) — hoàn toàn
  trái lý do ENC-01 được phép chạy trước. Đề xuất: đợi ENC-00 sign-off rồi mới
  đưa sang contracts trong một packet riêng.
- Δ39 — COLUMN DUY NHẤT ngoài packet: `outbox.payload`. Task dispatch/continuation
  hiện mang taskId/operationId/businessId/correlationId/kind (định danh kiểm soát,
  không phải nội dung tenant). Packet yêu cầu "outbox/queue không plaintext", tôi
  KHÔNG seal vì (a) dispatcher/SDK đọc trực tiếp, seal sẽ phá wire, (b) không có
  nội dung nhạy cảm để lo. Nếu coordinator muốn seal outbox thì cần một packet
  riêng có dispatcher trong scope.

#### Collateral đỏ KHÔNG thuộc cycle này (không sửa, đúng quy tắc lane)
- `tests/admin-operations-list-pagination.test.ts:406` "list table is wrapped by the
  shell reflow scroller" — đỏ ở cô lập (1 failed / 88 passed), xác định bằng mtime:
  điểm đỏ nằm ở `src/app/admin/shell-render.ts:509` (mtime 14:43Z) và
  `shell-router.ts` (16:00Z), tức Admin lane đang sửa admin shell SONG SONG; file
  của cycle này là `runtime/*` (17:06Z, 17:21Z). Không chạm file lane khác.

#### Tự phân loại 4 tầng
- SPECIFIED: inventory + 4 slot + semantics-preservation rõ ràng; yêu cầu "submit
  lưu ciphertext" vượt write scope (Δ36).
- IMPLEMENTED: 1 module mới + 9 call site + 3 projection + 23 test.
- VERIFIED (offline): tsc 0; 23/23 x3 Exit 0; collateral 44/44 Exit 0; M1 đỏ đúng
  4 binding test rồi restore byte-exact; full 1877/1906 với 1 đỏ ngoại lai.
- ACCEPTED: không thuộc quyền lane. ENC-META-01 [~] — chưa đóng vì Δ36 (submit-side
  input_ref) và Δ37 (production wiring) còn mở. ENC-INT-01 vẫn cần byte scan thật
  trên S3/PG/Redis/log; test offline chỉ chứng minh shape + binding.

#### Bổ sung — ledger tự sửa (self-report)
- Khi verify ledger sau cycle 17, phát hiện **row 16 bị nhân đôi**: một dòng cũ (số liệu
  385/385, do dùng "StorageEnvelope/ArtifactEncryptionRecord" — tên schema đã bị đổi ở
  bản cuối) còn sót từ cycle 16, cạnh dòng mới. Đã xoá dòng cũ, giữ dòng đúng.
  Ledger giờ: 17 dòng, tuần tự 1..17, verify bằng script đếm trong ĐÚNG section
  `## Ledger` (không đếm toàn file — bullet `- 9 test mới:` ở Mục 9 cũng khớp regex
  `- <digit> ` và làm đếm sai).
- Nguyên nhân: script verify của cycle 16 dùng regex `/^- \d+ —/` viết trong exec;
  backslash bị mất nên regex thành ký tự lạ và luôn trả 0 dòng — tôi đã đọc "0" là
  "không có vấn đề" thay vì để ý mâu thuẫn với việc vừa thêm dòng. Cùng họ với
  bẫy `\d` mất backslash đã ghi ở memory; nay có bằng chứng nó làm hỏng CẢ verify.

---

## 18 — CYCLE 18: W-ENC-04-WORKER-SDK BLOCKED (task_fb6bd3a9e44d, ctx_cd237f470150)

#### Quyết định
- Operator chọn: **thu hồi dispatch**. Lane KHÔNG viết dòng code cho ENC-04.
- Mục này ghi lại bằng chứng chặn để packet sau đổi scope có thể đi tiếp ngay, và để
  không ai re-dispatch nguyên xiên khi chưa mở đúng ba dependency đã nêu dưới.
- **Không có file nào bị sửa ở cycle này.**

#### Bằng chứng chặn (4 mục, đều chạy lệnh, không suy luận)
1. **Crypto facade không nằm trong scope.** `CryptoStorageFacade` tồn tại và đã
   VERIFIED-OFFLINE tại `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`
   (ENC-03, task_82858d64c949; board: tasks/APP-ENCRYPTION-2026-09-27.md:25). Worker-SDK
   không có `src/crypto/` (ENOENT). Packet yêu cầu "stream through crypto facade" nhưng
   facade nằm ở orchestrator — dùng nó nghĩa là import chéo package.
2. **Import chéo là bất khả thi, không phải thói quen.** `packages/worker-sdk/package.json`
   chỉ phụ thuộc `@du/contracts`, `@du/egress`, `@du/observability`, `bullmq` — không có
   orchestrator. `tsconfig.json`: `rootDir: src`, `include: ["src/**/*.ts"]`. Ba chỗ trong
   worker-sdk nhắc `services/orchestrator` chỉ là COMMENT trong docblock
   (source-ingestion.ts:16, artifact-streams.ts:301, artifact-multipart.ts:27) — tôi đã
   grep xác minh, không có import thật.
   => Muốn dùng facade: phải PORT (~860 dòng) sang worker-sdk, hoặc tách ra package
   dùng chung. Cả hai đều nằm ngoài `packages/worker-sdk/**` + `packages/document-core/**`.
3. **Worker chưa có đường nhận DEK.** Grep `packages/contracts/src/runtime.ts` với
   `dek` và `KeyRef`: **0 dòng khớp** — `ClaimResultSchema` không mang field khóa nào.
   ADR-18 + ENC-02 quy định Vault Transit giữ khóa và app không bao giờ nhận raw master
   key, nên worker phải nhận DEK qua một đường contract (orchestrator + contracts) —
   ngoài scope. Đây KHÔNG phải chi tiết hình thức: thiếu nó thì worker không thể mã
   hóa bất cứ thứ gì.
4. **Đường dẫn trong packet không tồn tại.** `packages/document-core` = false;
   `businesses/document-core` = true. Nếu lane làm đúng chữ nghĩa sẽ không sửa được file
   nào của document-core. (Đúng như memory lane DATA: doc-core ở `businesses/`.)

#### Cách mở ENC-04 (đề xuất cho coordinator, không tự làm)
Cần MỞ SCOPE trước, theo thứ tự phụ thuộc:
- (a) Chọn chỗ ở của facade: tách `crypto-storage-facade` ra package dùng chung (sạch nhất,
  orchestrator + worker-sdk dùng chung MỘT bản) HOẶC port bản worker-side. Tác động:
  orchestrator phải sửa theo nếu tách. Đây là quyết định kiến trúc, không phải của lane.
- (b) Chốt cơ chế DEK delivery: mở rộng `ClaimResultSchema` (contracts) + claim
  (orchestrator), HOẶC seam tiêm qua `TaskContextDeps` (worker-side, opt-in, không đổi
  contract). Operator đã chọn phương án seam trong câu hỏi này — nhưng nó **vẫn cần**
  một quyết định ở packet kế tiếp vì nó chặn việc chứng minh "worker mã hóa thật"
  (offline chỉ chứng minh được shape + round-trip với DEK giả).
- (c) Sửa đường dẫn packet: `packages/document-core/**` → `businesses/document-core/**`.
- Chỉ khi (a)+(b)+(c) xong, dispatch lại ENC-04 thì mọi dòng "stream through crypto
  facade / không worker path ghi plaintext durable" mới kiểm chứng được.

#### Trạng thái các task liên quan (đọc từ board, không suy luận)
- ENC-01 schema `[~]`, ENC-02 transit `[~]`, ENC-03 facade `[~]`, ENC-06 registry `[~]`,
  ENC-07 delivery — đều VERIFIED-OFFLINE theo board.
- **ENC-04 vẫn `[ ]`** — không code, không test, không receipt nhận việc.
- Ghi chú: `metadata-crypto.ts` của cycle 17 là control-plane (runtime), KHÔNG phải
  artifact-path; nó không thay thế được facade cho worker. Không được tính nhầm 2 tầng này.

#### Tự phân loại 4 tầng
- SPECIFIED: mục tiêu rõ; nhưng 3 dependency nằm ngoài write scope nên packet không
  thi hành được như giao.
- IMPLEMENTED: **không có** (theo quyết định của operator).
- VERIFIED: 4 luận điểm chặn, mỗi cái một lệnh đo; 0 file bị sửa.
- ACCEPTED: không thuộc quyền lane. ENC-04 `[ ]`, chờ packet mở scope.

---

## 19 — CYCLE 19: W-ENC-04-SEAM worker-side crypto seam (task_9dd3248fe32b, ctx_9f1e5d8a98e9)

#### Vì sao cycle 18 BLOCKED và cycle này làm được
- Mục 18 chặn vì facade nằm ở orchestrator + worker chưa có đường nhận DEK + packet
  ghi sai `packages/document-core`. Operator mở scope cho (1) port facade + (2) seam
  tiêm qua deps; (3) đường dẫn document-core vẫn không dùng tới (xem Δ46).

#### Deliverable
1. `src/crypto-storage.ts` NEW, 910 dòng, sha cc7db569 — PORT TRUNG THỰC của
   `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`.
   Port bằng SCRIPT COPY (không gõ tay) + patch import, nên phần thân khớp 100%;
   chỉ khác: bỏ import `vault-transit-provider` và khai báo 3 type cục bộ
   (`WrappedDek`, `WrapDekInput`, `CryptoKeyProvider`) vì worker-sdk không được
   phụ thuộc orchestrator. Alias `CryptoKeyProvider` -> `CryptoStorageKeyProvider`
   để không trùng với interface export (lỗi compile lần 1, đã sửa).
   Không "dọn dẹp" bất kỳ chi tiết wire nào — xem Δ43.
2. `src/crypto-seam.ts` NEW, 158 dòng, sha 54c238aa — seam theo task: bind facade
   vào tenant của CLAIM, trả về handle mà handler chỉ chọn được artifact/version.
3. `src/task-context.ts` (7441eb3c): `TaskContextDeps.crypto?` optional +
   `cryptoFor(binding)` + `sealArtifactBytes()`; single-PUT upload path seal TRƯỚC
   khi bytes rời process, và `finalizeArtifact` nhận size/digest của CIPHERTEXT.
4. `src/index.ts` (b1057462): export facade + seam qua entrypoint.
5. `tests/crypto-seam.test.ts` NEW, 248 dòng, sha d0ea67f0, 14 test.

#### Quyết định thiết kế đáng ghi
- **Không** thêm `cryptoFor` vào interface `TaskContext` công khai: làm vậy sẽ phá
  `MockTaskContext` ở document-core (ngoài scope — Δ42/Δ46). Nên nó là method trên
  `DefaultTaskContext`; handler dùng interface vẫn không ảnh hưởng.
- **Tenant do CLAIM quyết định, không phải handler.** Nếu handler tự truyền tenantId,
  mỗi call site là một chỗ sai sót, và AAD sẽ trung thực gắn SAI tenant — hợp lệ về
  mật mã nhưng chủ thật không đọc được. Bind một lần ở claim để xoá hẳn lớp lỗi đó.
- **Single-PUT > 5 MiB thì TỪ CHỐI**, không ghi plaintext, không "tạm ghi thẳng":
  chunked manifest chưa có chỗ để đi (finalize body chưa có field manifest — Δ44).
  Refuse loudly hơn là âm thầm rò.
- `expectedSha256` của caller vẫn là HỢP ĐỒNG PLAINTEXT: verify trước khi seal,
  không forward xuống upload helper (nơi nó đã là digest của ciphertext).

#### Verify (offline, literal exit code)
- `pnpm --filter @du/worker-sdk exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk; 2
  lỗi compile trung thực được sửa: trùng tên type, AAD -> string | undefined).
- Suite mới x3 liên tiếp: Tests: 14 passed, 14 total — Exit Code: 0 / 0 / 0.
- Full `pnpm --filter @du/worker-sdk test`: 2 failed, 16 passed, 18 suites;
  3 failed, 307 passed, 310 tests — Exit Code: 1. Cả 2 suite đỏ ĐỘC LẬP với
  code của cycle này (xem "Đỏ ngoại lai").
- M1 mutation (đổi chuỗi format AAD): ĐÚNG 2 test port-fidelity đỏ, 12 test hành vi
  vẫn xanh. Restore byte-exact: sha cc7db569, 33614 B, MUTATION_LEFT=false, 14/14
  xanh trở lại.

#### Phát hiện quan trọng từ M1 (nên đọc trước khi "dọn" port)
- 12 test hành vi KHÔNG bắt được đổi format AAD, vì chúng seal và open bằng CÙNG
  một bản port — hai vế lệch nhau vẫn khớp. Chỉ 2 test port-fidelity mới bắt.
  Nghĩa là: nếu ai đó "làm đẹp" port ở worker (đổi AAD, đổi layout nonce, đổi
  chunk size), 12 test vẫn xanh và chỉ hai service fail lúc chạy thật.
  ⇒ Hai test fidelity KHÔNG phải thừa; chúng là hợp đồng liên package duy nhất.

#### Đỏ ngoại lai (không sửa — đúng quy tắc lane)
- `tests/network-boundaries.boundary.test.ts` (2 test: mid-stream cap, sha mismatch)
  và `tests/artifact-direct-band.test.ts` (1 test RSS 64 MiB). Cả hai import
  CHỈ `artifact-streams` / `artifact-multipart` / `fan-out` — KHÔNG nạp
  `task-context.ts`, `crypto-storage.ts`, `crypto-seam.ts`, nên code của cycle này
  không thể chạy trong chúng. Kiểm chứng thêm: `artifact-direct-band` xanh 12/12 ở
  CẢ HAI lần chạy cô lập (Exit Code: 0) và đỏ khi chạy cùng full suite ⇒ nhiễu tải
  máy (RSS + real-listener timing), không phải regression. Cùng họ với Δ35.

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ43 — port KHÔNG được "làm đẹp": mọi chi tiết wire (format AAD, layout nonce 4 byte
  + index big-endian, chunk 4 MiB, khóa MAC HKDF, error taxonomy) phải giống hệt
  orchestrator, nếu không hai service không đọc được ciphertext của nhau. Đã có test
  canh (port-fidelity). Cần một quyết định lâu dài: giữ 2 bản + test canh, hay
  tách facade ra package dùng chung (sẽ bỏ được cả 2 bản và cả test canh).
- Δ44 — chunked manifest CHƯA có đường đi: `finalizeArtifact` không có field
  manifest, nên artifact > 5 MiB chưa mã hóa được. Cần contracts + orchestrator
  (ngoài scope). Hiện tại seam TỪ CHỐI thay vì ghi plaintext.
- Δ45 — CHƯA có caller nào truyền `deps.crypto`: worker nào cũng chưa mã hóa. Seam
  opt-in nên hành vi upload hiện tại KHÔNG đổi (byte-for-byte) — an toàn, nhưng
  ENC-04 chưa đạt "no worker path writes plaintext durable" cho tới khi có wiring
  + DEK delivery (vẫn là Δ41 của Mục 18).
- Δ46 — `businesses/document-core` (6 action, step-checkpoint) CHƯA đụng tới:
  packet ghi `packages/document-core` không tồn tại, và mở scope thì mới mở
  `packages/**`, không tự động mở `businesses/**`. Checkpoint của document-core
  (`pipelines/step-checkpoint.ts`) vẫn ghi output step qua `ctx.step` — đó là
  control-plane, đã đi qua `metadata-crypto` ở Mục 17, KHÔNG phải artifact path.
  Cần packet riêng cho document-core.

#### Tự phân loại 4 tầng
- SPECIFIED: port + seam + tests rõ; phần document-core và DEK delivery vẫn ngoài.
- IMPLEMENTED: 1 port module + 1 seam module + wiring single-PUT + exports + 14 test.
- VERIFIED (offline): tsc 0; 14/14 x3 Exit 0; M1 đúng 2 test fidelity rồi restore
  byte-exact; full 307/310 với 3 đỏ ngoại lai đã chứng minh độc lập.
- ACCEPTED: không thuộc quyền lane. ENC-04 [~]: shape + binding + port fidelity đã
  có bằng chứng, nhưng Δ44 (manifest) + Δ45 (wiring/DEK) + Δ46 (document-core)
  còn mở nên chưa thể nói "không còn worker path ghi plaintext".

---

## 20 — CYCLE 20: W-ENC-04-DOC-CORE (document-core honours the crypto seam) — task_9f1e5d8a98e9 follow-up

#### Phát hiện quyết định khi đọc code (không phải lúc code)
- Cả OUTPUT của action lẫn OUTPUT của checkpoint ĐÃ đi qua encrypted facade từ
  cycle 19, vì `artifacts.write` -> `writeStream` (dòng 667-676 task-context.ts) và
  chính `writeStream` đã seal. Nên nhiệm vụ ở document-core KHÔNG phải "thêm mã hóa"
  mà là: (a) đưa seam tới context nội bộ để business code chạm được, (b) làm checkpoint
  tự seal để không phụ thuộc ai, (c) test chứng minh. Đã kiểm chứng bằng đọc code +
  test, không giả định.

#### Deliverable (chỉ businesses/document-core + 1 method worker-sdk)
1. `src/types/context.ts` (f4f5f2e7): `TaskContext.crypto?: TaskArtifactCrypto` —
   OPTIONAL, nên MockTaskContext và mọi context test cũ không phải sửa.
2. `src/worker.ts` (f60714c3): `taskCrypto()` feature-detect + export
   `toInternalContext` (trước đây private) để test được. Gắn crypto khi worker có seam.
3. `src/pipelines/step-checkpoint.ts` (a7c52ff1): `executeWithCheckpoint` giờ
   persist DẠNG SEALED khi có seam, mở trong suốt khi replay; thêm
   `assertEncryptionAvailable(ctx, required)` fail-closed TRƯỚC khi step body chạy;
   thêm `isSealedRecord()`. Không seam => trả về đúng giá trị cũ, byte-for-byte.
4. `tests/doc-core-crypto-seam.test.ts` (86e5cfc2, 295 dòng, 9 test).
5. worker-sdk `src/task-context.ts` (7ea1dd2a): thêm `cryptoSeam()`. Xem dưới.

#### LỖI THẬT TÔI GÂY RA VÀ ĐÃ SỬA (quan trọng hơn cả phần code)
- Adapter đầu tiên feature-detect `cryptoFor`. SAI: method đó CÓ mặt trên class dù
  `deps.crypto` chưa được cấu hình, nên worker bật/tắt mã hóa đều trông như "đã bật".
  Hậu quả đo được: `internal.crypto` là handle mà mọi lời gọi đều ném, checkpoint seal
  vỡ, và **3 suite tôi làm đỏ**: sdk-consumer (9 test), provider-backed-variant,
  p8-01-traceability-harness — tất cả fail với
  `"artifact encryption is not configured for this worker"`.
- Sửa: worker-sdk thêm `cryptoSeam(): WorkerCryptoSeam | undefined` (predicate nói
  thật sự có cấu hình hay không), adapter dùng predicate, giữ `cryptoFor` cho handler.
  Sau khi sửa: full document-core 44/44 suite, 529/529 test, Exit Code: 0.
- Bài học đã ghi: phân biệt "method tồn tại" với "tính năng được bật". Một API
  optional phải có predicate nếu consumer cần BRANCH theo trạng thái.

#### Test của tôi suýt vacuous — mutation probe bắt được (lần thứ hai trong 2 cycle)
- M2: thêm `leak: base64(plaintext)` vào record lưu. Test **VẪN XANH** — vì
  `JSON.stringify(record).not.toContain(SENTINEL)` không thấy sentinel đã base64-encode.
  Nghĩa là assertion của tôi chỉ chứng minh "plaintext không nằm dạng thô",
  yếu hơn nhiều so với điều cần chứng minh.
- Sửa: thêm `leaksSentinel()` đi base64-decode MỌI string trước khi kết luận.
  M2 chạy lại => **1 failed / 8 passed**, đúng test "persists an envelope...".
  Restore byte-exact (a7c52ff1, 6980 B, `leak_left=false`), 9/9 xanh trở lại.
- Đây là lần thứ hai trong hai cycle liên tiếp một assertion của tôi không cắn;
  không có mutation probe thì cả hai đều đã được nộp như bằng chứng.

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk;
  1 lỗi thật: export chưa có trong worker-sdk dist => phải build lại dist, đã build).
- `pnpm --filter @du/document-core test` FULL: Test Suites: 44 passed, 44 total;
  Tests: 529 passed, 529 total — Exit Code: 0. Số học khớp: 43 suite/520 test
  (baseline ghi nhận trước cycle) + đúng 1 suite/9 test của tôi.
- Suite mới x3 liên tiếp: Tests: 9 passed, 9 total — Exit Code: 0 / 0 / 0.
- Regression worker-sdk: crypto-seam 14/14 Exit 0; `tsc --noEmit` Exit 0.
- Lượt full đầu tiên có 5 suite đỏ: 3 do lỗi adapter ở trên (đã sửa, giờ xanh),
  `p8-03` = `connect ETIMEDOUT 127.0.0.1:5433` (Postgres live, ngoài offline gate),
  `bullmq-smoke` cần Redis. Cả hai XANH ở lượt full sau — nhiễu môi trường, không
  phải code (cùng họ Δ35).

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ44 — checkpoint > 5 MiB vẫn chưa đi được: seam của worker-sdk từ chối single-shot
  quá trần, và chunked manifest chưa có field trong `finalizeArtifact` (cần
  contracts + orchestrator). Tồn tại từ Mục 19, chưa có gì mới.
- Δ45 — CHƯA deployment nào bật seam: `deps.crypto` phải được truyền khi khởi
  động worker (orchestrator/sidecar), và DEK vẫn chưa có đường delivery (Δ41).
  ⇒ "không còn worker path ghi plaintext durable" CHƯA đạt trên bất kỳ môi trường
  thật nào; cycle này chỉ chứng minh hành vi ĐÚNG KHI BẬT, và fallback đúng khi tắt.
- Δ47 — checkpoint seal ở tầng document-core là LỚP THỨ HAI: worker-sdk đã tự seal
  output qua `artifacts.write`, còn `StepCheckpointManager` seal lại giá trị mà
  context nội bộ nhận. Hai lớp không xung đột (nội bộ seal trước, SDK seal sau), nhưng
  nếu sau này ai đó chỉ bỏ lớp trong document-core thì vẫn an toàn — và nếu ai đó
  chỉ bỏ lớp trong worker-sdk thì checkpoint internal vẫn còn được seal. Cần quyết
  định: giữ cả hai (defense in depth, phí mã hóa kép) hay chọn một chỗ duy nhất.
---

## 21 — CYCLE 21: W-INGEST-WIRE-01 (ingest/ocr + ingest/digitize transmit the document) — task_197417c12b31

#### Defect thật trước khi sửa (đọc code, không phải lúc test)
- `ingest/ocr` gửi `{ language, hasBuffer: sources.buffers.length > 0 }` — MỘT BOOLEAN.
  Connector không nhận byte, hash, hay MIME; không có gì để đọc.
- `ingest/digitize` gửi `{ task: "digitize_handwriting" }` — KHÔNG CÓ GÌ ngoài tên task.
- Cả hai test cũ (DOC-01-v2/v3) truyền `text: "image-placeholder"` / `"form-placeholder"`
  và assert provider được gọi. Đó chính là bằng chứng giả mà
  tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:7 cấm ("không dùng hasBuffer hay
  tên task làm bằng chứng đã truyền tài liệu").
- Contract ĐÃ ĐÓNG SẴN: `InvocationInput.artifacts?: readonly { artifactId: string }[]`
  có ở @du/contracts, connector service và worker-sdk. Không cần mở rộng contract —
  chỉ phải DÙNG đúng field đã freeze. Đây là "protocol bounded đã freeze" của spec.

#### Thay đổi (chỉ businesses/document-core)
1. `src/actions/ingest/index.ts` (8b43ce2c, 310 dòng):
   - `prepareSources` trả thêm `artifactIds: string[]` — id của artifact THẬT SỰ đã
     đọc, cùng thứ tự. Không dựng lại bằng index về sau (đó là đoán).
   - OCR: guard `INGESTION_SOURCE_UNRESOLVED` nếu không có artifact + truyền
     `artifacts: [{ artifactId: sourceArtifactId }]`. Xoá hẳn `hasBuffer`.
   - Digitize: cùng contract, giữ `task` làm NHÃN định tuyến nhưng thêm reference.
   - Checkpoint input của cả 2 bước đổi sang `artifactId` (id là identity của
     input, đúng ý nghĩa hơn boolean).
   - native `parse`/`split` KHÔNG đổi: vẫn local, không gọi Connector (docs/10).
2. `tests/ingest-wire.test.ts` (672659ee, 167 dòng, 8 test) — file mới.
3. `tests/ingest.test.ts` (05eb4bc7), `corpus-regression.test.ts` (1687cb7d),
   `all-variants-e2e.test.ts` (59ece128): fixture OCR/digitize nay ghi PNG thật
   (1x1 hợp lệ, base64) + assert payload mang artifactId và KHÔNG còn hasBuffer.
   Đây là các test ĐÃ CHỨNG MINH SAI — sửa chúng là phần việc của task, không phải
   nới lỏng để xanh.

#### Tự sửa lỗi trong lúc làm (báo lại vì suýt nộp hỏng)
- Edit đầu tiên của tôi dán nhầm tên khối (`new_string = "..."` nằm trong
  `old_string`) làm MẤT header `} else if (...)`, guard `sourceArtifact` và wrapper
  `executeWithCheckpoint` của cả hai nhánh ⇒ 26 lỗi compile. Đã vá lại từng nhánh,
  typecheck sạch. Nói thẳng: đây là lỗi thao tác của tôi, không phải tìm lỗi của
  người khác.
- `ArtifactReadResult` không có `artifactId` ⇒ không thể lấy id từ buffer đã đọc;
  đó là lý do `prepareSources` phải trả `artifactIds` thay vì suy ra.

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk; 2 lỗi
  compile thật ở giữa chừng đã sửa).
- Targeted: corpus-regression + all-variants-e2e + ingest + ingest-wire + ingest-source-pin
  = 5 suites, Tests: 88 passed, 88 total — Exit Code: 0.
- **FULL document-core: Test Suites: 45 passed, 45 total; Tests: 537 passed, 537 total
  — Exit Code: 0.** (44/529 ở Mục 20 + 1 suite / 8 test mới = 45/537, khớp).
- Mutation probe, 2 lần, mỗi lần đúng một nhánh:
  M1 đưa OCR về `hasBuffer: true` ⇒ 2 test đỏ (wire OCR + foreign denial).
  M2 bỏ `artifacts` khỏi vision ⇒ đúng 1 test digitize đỏ.
  ⇒ cả hai nhánh đều thật sự được pin, không phải test "cho xanh".
  Restore byte-exact ingest/index.ts: sha 8b43ce2c, 12346 B, byte_identical=true.
  `hasBuffer` còn duy nhất trong COMMENT giải thích, không còn call site thực thi.
#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ48 — chỉ SỬA phía document-core + test. Phía Connector không được sửa (ngoài
  scope của task này): hiện connector nhận `artifacts: [{artifactId}]` nhưng chưa
  được chứng minh là nó FETCH ĐƯỢC artifact đó và truyền bytes thật cho provider.
  Spec yêu cầu "Connector/provider fixture xác nhận đúng bytes/hash/MIME,
  tenant/grant/size/timeout/foreign denial" — phần đó thuộc lane Connector.
  Với phía tôi đã chứng minh: worker gửi đúng reference, và bytes sau reference
  khớp digest/MIME (test ingest-wire).
- Δ49 — chưa có test live multi-container với file scan + handwriting thật (spec yêu
  cầu). Các test ở đây là unit với PNG 1x1 hợp lệ; chứng minh end-to-end qua
  grant thật + provider thật cần DB/Redis/S3/connector thật ⇒ thuộc ENC-INT-01/
  P5-04 window, không phải offline gate.
- Δ50 — `all-variants-e2e`/`corpus-regression`/`ingest.test.ts` vừa được sửa để
  dùng artifact thật. Đây là các test từng "chứng minh" OCR/digitize chạy được mà
  không có tài liệu nào; sửa chúng là điều spec yêu cầu, nhưng cần Reviewer xác
  nhận vì nó thay đổi hành vi của 3 file test thuộc traceability matrix.
- Δ51 — `hasBuffer` vẫn còn trong một COMMENT tại ingest/index.ts:206 (giải thích vì
  sao bỏ nó). Không còn call site thực thi nào dùng `hasBuffer`.

#### Tự phân loại 4 tầng
- SPECIFIED: rõ — truyền nội dung thật qua artifact reference/protocol đã freeze.
- IMPLEMENTED: 1 file src + 1 test mới + 3 test cũ cập nhật (PNG thật thay placeholder).
- VERIFIED (offline): tsc 0; 5 targeted suite 88/88; FULL 45/45 537/537 Exit 0; 2
  mutation probe đúng từng nhánh + restore byte-exact.
- ACCEPTED: không thuộc quyền lane. P5-04/P5-10 "đã truyền tài liệu" chỉ đóng được
  khi Δ48 (connector fetch + verify bytes ở phía provider) và Δ49 (live multi-container
  với scan/handwriting thật) hoàn tất. Offline unit chỉ chứng minh phía worker.

---

## 22 — CYCLE 22: W-DATA-03-URL-ACQ (URL task not runnable before source READY) — task_928ae74339d5

#### Inventory trước khi viết gì (quan trọng: phần lớn DATA-03 ĐÃ có)
- `packages/worker-sdk/src/source-acquisition.ts` + `source-ingestion.ts` đã hiện diện và
  ĐÃ có test: `source-acquisition.test.ts` (SSRF fence qua pinned egress, redirect bound,
  oversized, slow/idle, rebinding) và `source-ingestion.test.ts` (32 case: acquire→
  stream→pin, retry idempotence, no-READY-on-failure, materialization gate).
- Đây là công việc lane DATA + Mục 9 của chính lane này (W-DATA03-CONSUMER-JOIN-1).
  Tôi KHÔNG viết lại những phần đó — task này đòi "viết test xác nhận policy", và phần
  policy đã có test. Nên tôi đi tìm LỖ HỔNG còn lại trong scope mình.

#### Lỗ hổng tìm được (đọc code, không phải đoán)
- `IngestAction.prepareSources` chỉ kiểm tra pin khi `artifactInputs.length > 0`:
  `if (pin && artifactInputs.length > 0) { ...SOURCE_PIN_MISMATCH... }`.
- Hệ quả: một task URL mà acquisition CHƯA materialize (chưa READY) có 0 artifact ⇒
  pin KHÔNG được kiểm. Nếu task đó còn mang `input.text`, parse mode rơi vào nhánh
  `else if (sources.inlineText)` và parse TEXT ĐÓ, báo thành công — dù platform chưa
  tải byte nào. Đúng nghĩa "failed acquisition không tạo READY hay parse bytes dở" bị
  vi phạm bằng một đường vòng: không READY, không bytes, nhưng vẫn có kết quả.
- Đây KHÔNG phải lỗi giả định: tôi đã viết test trước, chạy, và nó ĐỎ trên code cũ.

#### Sửa (1 file, đúng phạm vi)
- `src/actions/ingest/index.ts` (f05634ea, 326 dòng):
  (1) Kiểm pin BẰNG KHI `pin` CÓ, không điều kiện vào số artifact. Không khớp:
      có artifact → SOURCE_PIN_MISMATCH; không artifact nào → INGESTION_SOURCE_UNRESOLVED
      (tức "chưa READY, chưa runnable"), phân biệt rõ hai nguyên nhân.
  (2) `inlineText: pin ? undefined : input.text` — task có pin KHÔNG được thỏa bằng text
      nội tuyến, vì text đó không phải object mà gate đã pin. Không có pin thì đường
      inline thường hoạt động y như cũ (không đổi semantics cho case không pin).

#### Test (1 file mới, 5 test)
- `tests/data-03-url-acq.test.ts` (44b4ecf4, 118 dòng):
  1. pin + KHÔNG artifact + có inline text => INGESTION_SOURCE_UNRESOLVED (lỗ hổng).
  2. pin + artifact không khớp => SOURCE_PIN_MISMATCH (không đổi).
  3. pin + artifact khớp + có inline text => parse bytes ĐÃ PIN, inline bị bỏ.
  4. KHÔNG pin + inline text => đường thường vẫn chạy (fallback nguyên vẹn).
  5. acquisition hỏng => không còn buffer/partial nào để parse.
- Fixture pin theo ĐÚNG `IngestionReceiptSchema` (strict: storageKey, versionId, sha256,
  sizeBytes, artifactId? — KHÔNG có `url`; lần đầu tôi viết pin có `url` nên bị
  contract validator chặn, đã sửa theo schema thật).

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0.
- Targeted mới x3: Tests: 5 passed, 5 total — Exit Code: 0 / 0 / 0.
- **FULL document-core: Test Suites: 46 passed, 46 total; Tests: 542 passed, 542 total
  — Exit Code: 0.** (45/537 ở Mục 21 + 1 suite/5 test mới = 46/542, khớp).
- Regression worker-sdk: source-acquisition + source-ingestion = Tests: 84 passed, 84
  total — Exit Code: 0 (tôi không sửa worker-sdk ở cycle này, nhưng chạy để chắm).
- 2 mutation probe, mỗi cái đúng mục tiêu:
  M1 đưa gate về dạng cũ (`pin && artifactInputs.length > 0`, tắt nhánh unresolved) =>
  2 test đỏ (case 1 và case 5 — đúng hai test bắt lỗ hổng).
  M2 bỏ `inlineText: pin ? undefined` => đúng 1 test đỏ (case 3, inline không bị bỏ).
  ⇒ cả hai nửa của fix đều thật sự được pin.
  Restore byte-exact ingest/index.ts: sha f05634ea, 13203 B, byte_identical=true.
#### Phần spec CHƯA nằm trong write scope của tôi (báo rõ, không ngụy trang xong)
- "202 URL submission tạo ingestion task" + gate "business task chỉ runnable khi source
  READY" ở nửa ORCHESTRATOR (submission.ts / processIngestionTask / markIngestionReady) —
  ngoài `worker-sdk` + `document-core`. Tôi đã SỬA nửa document-core (mệnh đề "chưa
  READY thì task không chạy được" ở đúng chỗ task thực thi). Nửa orchestrator đã có
  từ trước (Mục 9) nhưng tôi KHÔNG verify lại được ở cycle này vì ngoài scope.
- "HTTPS URL fixture bounded vào S3 trước parse" + SSRF/redirect/rebinding/oversized/
  slow + retry-idempotence: đã có test ở worker-sdk (xem Inventory). Tôi chạy lại 84/84
  xanh nhưng không viết lại — tránh nhân bản coverage của lane khác.
- "failed acquisition không tạo READY": nửa storage/gate ở orchestrator, nửa task ở
  document-core (đã sửa + test).

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ52 — sửa là TIGHTENING (fail-closed sớm hơn), có thể làm một số task URL cũ đang
  chạy được bằng inline text bắt đầu fail với INGESTION_SOURCE_UNRESOLVED. Đây là
  hành vi ĐÚNG theo spec nhưng là breaking change cho edge case đó; coordinator nên
  biết trước khi nó lên production.
- Δ53 — chưa có live multi-container evidence cho DATA-03 (fetch thật qua egress thật,
  S3 thật, READY gate thật). Cycle này là offline unit + contract. Live thuộc
  DATA-INT-01.

#### Tự phân loại 4 tầng
- SPECIFIED: rõ — chính sách URL, READY gate, không parse bytes dở.
- IMPLEMENTED: 1 file src (gate pin + drop inline khi có pin) + 1 test file mới (5 test).
- VERIFIED (offline): tsc 0; targeted 5/5 x3; FULL 46/46 542/542 Exit 0; regression
  worker-sdk 84/84; 2 mutation probe đúng mục tiêu + restore byte-exact.
- ACCEPTED: không thuộc quyền lane. Nửa orchestrator (202 + READY gate + no-READY-
  on-failure ở storage) và live multi-container (Δ53) chưa verify trong cycle này.

## 23 — CYCLE 23: W-DATA-03-ORCH-VERIFY (URL task not runnable until source READY — phía Orchestrator) — task_d3329e56f028, ctx_a197b906cb36

#### Inventory trước khi viết gì (đo trước, không đoán)
Packet bảo *verify and wire* trong 2 file test. Tôi đọc cả 2 trước khi chạy gì:

- `tests/url-ingestion-consumer-offline.functional.test.ts` — **đã tồn tại**, 33 test, xanh
  sẵn (viết ở Mục 9 / cycle 9).
- `tests/url-ingestion-backend-failclosed-offline.test.ts` — **đã tồn tại**, 5 test, xanh sẵn
  (viết ở Mục 12 / cycle 12).

⇒ 37 test có sẵn và đang xanh (33 + 4). Nếu cycle này chỉ chạy lại chúng thì **không deliver được gì**.
Vậy "wire" phải chỉ một khoảng trống thật, và tôi phải tìm ra nó bằng đọc code chứ không bằng
chạy test cho xanh.

#### Lỗ hổng tìm được (đọc code, không phải lúc test)
Mệnh đề packet cần giữ: **business task chỉ runnable khi source artifact READY trong S3**.
Tôi lần theo cả ba tầng có thể giữ mệnh đề này:

1. **Tầng submit** — `submission.ts` đã từ chối khi backend ≠ s3 (422
   `UNSUPPORTED_STORAGE_BACKEND`, Mục 12). Đúng, nhưng đây là *điều kiện tiên quyết*, không
   phải *điều kiện READY*.
2. **Tầng dispatch (routing)** — `dispatcher.ts:36-41` có
   `AND (payload->>'gate') IS DISTINCT FROM 'ingestion'`. Đúng là dispatcher **không publish**
   row gate-ingestion lên business queue.
3. **Tầng claim (boundary)** — `claimTask` trong `src/modules/runtime/runtime.ts`:
   **KHÔNG có nhánh nào kiểm tra `PENDING_INGESTION`.** Tôi grep toàn bộ file: chỉ có
   terminal check + ownership fence + artifact consistency.

Đây là hàng rào **1 lớp**, không phải hàng rào. Cụ thể, mọi đường sau vẫn đưa được một task
`PENDING_INGESTION` tới chỗ worker nhận việc, và lúc đó nó **cấp lease thật** cho một task
mà input chưa có byte nào:

- BullMQ redelivery của một job đã publish trước khi gate có (hoặc đã publish vì dispatcher
  chạy trước lúc row được stamp `gate`).
- Row ghi vào DB trước khi `gate` tồn tại (mọi row đã persist từ trước Mục 9).
- Bất kỳ path nào khác re-stamp `dispatched_at` mà không đi qua predicate của dispatcher.

⇒ Đây đúng là loại bug mà tôi đã gặp ở Mục 11 (post-lease ownership fence): **routing không phải
boundary**. Sửa đúng bài toán này bắt buộc phải chạm `src/`, không sửa được bằng test-only.

#### Sửa (1 file src — `src/modules/runtime/runtime.ts`, sha `902185d2`, 77510 B)

Chèn vào `claimTask`, **sau** khối terminal check và **trước** khi lease được cấp:

```typescript
if ((t.op_state as string) === 'PENDING_INGESTION') {
  throw conflict('STATE_CONFLICT', 'task is not runnable until its ingestion source is READY');
}
```

Vị trí này là cố ý:

- **Sau** terminal check — một task đã terminal vẫn trả về lỗi terminal như cũ, không đổi
  semantics của các path khác.
- **Trước** mọi cây lấy lease — nên lần claim bị từ chối **không lấy lease, không tăng
  `attempt`, không ghi `last_delivery_id`**. Đây là điều test mới phải chứng minh, không phải
  điều tôi tự khẳng định.
- Dùng `op_state` (state của **operation**) chứ không phải `state` của task: cổng nằm ở
  operation, và claim query đã project `o.state AS op_state` sẵn — không thêm bind param,
  không thêm round-trip.

Không sửa `dispatcher.ts`, không sửa `ingestion-consumer.ts` (mtime `2026-09-26T10:03`, tôi
không chạm).

#### Test (1 file, +2 test; 33 -> 35)

`tests/url-ingestion-consumer-offline.functional.test.ts`:

- `TaskRow` bổ sung 5 cột lease (`lease_epoch`, `lease_expires_at`, `leased_by`,
  `last_delivery_id`, `attempt`) + `seedGatedSubmission` set giá trị đầu. Trước đó harness
  không có các cột này, nên mệnh đề "refused claim lấy **không** lease" sẽ là assertion vào
  một field không tồn tại — đó là loại test vacuous tôi đã trúng ở cycle 20.
- Router thêm 4 nhánh, tất cả đều là SQL thật mà `claimTask` phát ra:
  1. `SELECT ... FROM tasks t JOIN operations o ... FOR UPDATE OF t` (chỉ project
     `op_state` **khi** SQL có `o.state AS op_state` — router đọc text nên phải ràng điều kiện).
  2. `SELECT state FROM operations WHERE id=$1`.
  3. `UPDATE tasks SET lease_epoch=... leased_by=... last_delivery_id=... state='RUNNING'`
     (chỉ khi `row.lease_epoch + 1 === expectedEpoch`, trả `rowCount 0` nếu không sở hữu —
     mô phỏng đúng CAS, không phải update unconditional).
  4. `UPDATE operations SET state='RUNNING' ... state_version = state_version + 1` (chỉ khi
     op đang `PENDING_INGESTION`).
  Không có 3 và 4 thì test "gate mở rồi claim thành công" sẽ đụng `unrouted sql` và chứng
  minh được **không gì cả**.
- 2 test mới:
  1. `claim boundary: a PENDING_INGESTION task is refused and takes NO lease` — assert
     `STATE_CONFLICT`, `state` vẫn `PENDING_INGESTION`, `lease_epoch` 0, `leased_by` null.
  2. `claim boundary: once the gate opens, the SAME task claims normally` — chạy consumer
     thật (`sweep.opened === 1`, op → `QUEUED`, task → `READY`), rồi claim **chính task đó**
     và assert snapshot mang artifact pin đã materialize (guard bám trạng thái cổng, không bám
     id task).

`tests/url-ingestion-backend-failclosed-offline.test.ts` — **không sửa**. 5 test của nó đã đúng
phạm vi; nói thẳng thay vì sửa cho có.

#### Verify (offline, literal exit code)

- `pnpm --filter @du/orchestrator exec tsc --noEmit` — log **rỗng**, Exit Code: **0**.
- Targeted (3 file `url-ingestion*`) ×3 lần liên tiếp:
  `Test Suites: 3 passed, 3 total` / `Tests: 42 passed, 42 total` — Exit Code: **0 / 0 / 0**
  (lần chạy thứ 4 sau khi restore cũng 0). Thành phần 42 đo từ source, không suy
  đoán: `backend-failclosed` 4 + `consumer` 35 (33 có sẵn + 2 mới) + `offline.functional` 3 —
  file thứ ba **không** nằm trong 2 file packet nêu tên, tôi vẫn chạy vì glob `url-ingestion`
  nuốt nó; failclosed đo trực tiếp = 4, không phải 5 như tôi ghi nhầm ở draft đầu.
- Riêng consumer: **35/35** (33 có sẵn + 2 mới).
- **Mutation probe M1** (tắt guard, chạy consumer suite):
  `Tests: 1 failed, 34 passed` — đúng test `a PENDING_INGESTION task is refused and takes NO
  lease`. ⇒ test cắn đúng. Restore byte-exact: `runtime.ts` sha `902185d2`, 77510 B.

#### Full orchestrator suite — 5 đỏ, phân loại từng cái

`Test Suites: 5 failed, 1 skipped, 86 passed, 91 of 92 total` /
`Tests: 8 failed, 28 skipped, 1992 passed, 2028 total` (run lại 2026-09-28 ~22:35Z).

Lưu ý đọc log: jest liệt kê **mỗi** file FAIL 2 lần (khối đầu + bảng tổng kết), nên
5 dòng FAIL trong log tương ứng **5 suite**, không phải 10. Không url-ingestion nào đỏ.

| Test | Phân loại | Bằng chứng |
|---|---|---|
| `admin-operations-list-pagination` | **ngoại lai, đã biết từ cycle 1** | Admin shell reflow scroller; mtime file 2026-09-24, tồn tại trước mọi thay đổi của tôi |
| `admin-shell-session-lifecycle` | **ngoại lai** | grep `claimTask\|modules/runtime` trong file test → **No matches**. Dấu hiệu đỏ: `console.warn spy received 0 lines` |
| `adm-base-03-safe-error-offline` | **ngoại lai** | log text rỗng, cùng vùng admin-shell, không import `claimTask` |
| `admin-crypto-config-oidc` | **ngoại lai, mới xuất hiện ở run này** | W-ENC-08-CSRF-OIDC, lỗi `CRYPTO_CONFIG_TENANT_REQUIRED`; grep `claimTask\|PENDING_INGESTION` → **No matches** |
| `admin-error-boundary-offline` | **ngoại lai — flake đã biết (Δ35, cycle 14)** | `TypeError: fetch failed` / `connect ETIMEDOUT 127.0.0.1:53006` — ephemeral-port loopback, không phải regression |

Mtime làm tôi tin phần **nguyên nhân** chứ không chỉ phần **phân loại**:

```
src/app/admin/shell-router.ts    mtime=2026-09-27T22:21:23Z   <-- Admin/SEC lane
src/app/admin/shell-server.ts    mtime=2026-09-27T21:15:25Z   <-- Admin/SEC lane
tests/admin-crypto-config-oidc.test.ts mtime=2026-09-27T22:29:19Z  <-- Admin/SEC lane
src/modules/runtime/runtime.ts   mtime=2026-09-27T22:13:48Z   <-- của tôi (cycle này)
src/modules/operations/ingestion-consumer.ts  mtime=2026-09-26T10:03:05Z  (không chạm)
```

Không sửa 3 test này (đúng quy tắc lane: không đụng test file của lane khác trong checkout
dùng chung) và **không** đòi coordinator coi full suite xanh — tôi báo 3 đỏ này mở.

#### Δ-DEVIATION (chờ coordinator adjudicate)

- **Δ54 — write scope vượt packet.** Packet chỉ nêu 2 file test. Nhưng mệnh đề cần giữ
  ("non-runnable until READY") **không thể** được siết bằng test-only: dispatcher đã làm
  đúng phần routing, thiếu duy nhất là guard ở claim boundary trong
  `src/modules/runtime/runtime.ts`. Tôi sửa file src đó. Đây là Δ **cần thiết về mặt kỹ
  thuật**, không phải tự ý mở rộng — nhưng coordinator nên biết vì packet ghi sai phạm vi.
- **Δ55 — chưa có live evidence cho claim guard.** `PENDING_INGESTION` + lease phải chứng
  minh trên Postgres thật qua `FOR UPDATE OF t`. Tất cả bằng chứng ở Mục này là offline với
  fake router. Cùng loại với Δ53 (DATA-03 live multi-container) — gộp vào **DATA-INT-01**.
- **Δ56 — 5 suite đỏ trong full orchestrator, tất cả ngoại lai.** Run đầu tôi thấy 3; run xác
  nhận lại (cùng cây, sau khi lane khác ghi file) thấy **5**: thêm
  `admin-crypto-config-oidc` (mới, W-ENC-08-CSRF-OIDC) và `admin-error-boundary-offline`
  (flake ETIMEDOUT ephemeral-port, đã ghi nhận ở Δ35 cycle 14). Không suite url-ingestion nào
  đỏ. Tôi **không** sửa và **không** hấp thụ; cần lane Admin/SEC dọn. Ghi rõ số 3 ở run đầu là
  quan sát tại thời điểm đó, không phải con số cuối.

Bằng chứng mạnh nhất cho phần **nguyên nhân**: `admin-crypto-config-oidc.test.ts` có mtime
`2026-09-27T22:29:19Z`, **sau** `runtime.ts` của tôi (`22:13:48Z`) — file test bị lane khác ghi vào
gay lúc tôi đang chạy full suite. 5 suite đỏ đều thuộc vùng admin; 0 suite url-ingestion đỏ.

#### Tự phân loại 4 tầng

- **SPECIFIED**: rõ — 2 mệnh đề (202 tạo ingestion task; business task không chạy được trước
  khi source READY), và mệnh đề thứ hai là thuộc tính **claim boundary**.
- **IMPLEMENTED**: 1 file src (`runtime.ts` — 1 guard, 5 dòng) + 1 file test (2 test, 5 cột
  lease, 4 nhánh router).
- **VERIFIED (offline)**: tsc 0; targeted 42/42 ×3 + lần 4 (Exit 0); consumer 35/35; M1 đỏ
  đúng mục tiêu; restore byte-exact `902185d2`/77510 B.
- **ACCEPTED**: không thuộc quyền lane. Chưa có live-PG cho guard (Δ55), chưa có live
  multi-container DATA-03 (Δ53), 3 đỏ admin-shell còn mở (Δ56).
## 24 — CYCLE 24: W-ENC-04-DOC-CORE (task_94c2532781b3) — **BLOCKED, có bằng chứng, KHÔNG sửa code sản phẩm**

#### Quyết định (đọc trước, nói thẳng)
Packet yêu cầu 3 việc trong `businesses/document-core/src/actions/`: (a) actions đọc encrypted
input stream, (b) validate checkpoint lease, (c) ghi checkpoint/result qua `CryptoStorageFacade`
không để lại byte thô. Tôi **không làm (a) và (b)**, vì đo ra chúng là **không khả thi ở tầng
document-core** — không phải vì tôi chọn lười. Chi tiết bằng chứng bên dưới. Tôi giữ lại đúng thứ
tôi chứng minh được và nộp receipt này như một **phát hiện chặn**, không phải như một delivery.

#### Vì sao (a) "actions consume encrypted input streams" là bất khả thi ở đây
Đọc `packages/worker-sdk/src/task-context.ts` trước khi đo:

- **Ghi** (`:601-610`): có seam ⇒ `sealArtifactBytes()` seal trước, upload **chỉ** `sealed.body`
  (= `sealed.encrypted.ciphertext`), `finalizeArtifact` báo **ciphertext** size/sha256.
- **Đọc** (`:637-660`): `read` / `readWithMetadata` / `readStream` gọi thẳng
  `openArtifactStream(grant.downloadUrl, ...)` và trả về byte thô. **Không có `decrypt` ở đâu trên
  read path** — grep `decrypt|crypto|ciphertext` trong `artifact-streams.ts` chỉ trúng
  `createHash` của `node:crypto`.
- Metadata cần để mở (`nonce`, `tag`, `aad`, `wrapped DEK`) **bị vứt**: `sealArtifactBytes` trả về
  `{ body, ciphertextSizeBytes, ciphertextSha256 }` — đếm trong `task-context.ts`: `nonce` 0,
  `tag` 0, `aad` 0, `dek` 0, `EncryptedStorageObject` 0 lần xuất hiện. Không chỗ nào lưu nó.

⇒ **Bằng chứng thực nghiệm** — `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts`
(mới, 1 test) chạy qua facade THẬT (`DefaultTaskContext` + `RuntimeClient` + fetch giả lập
loopback), seam thật, provider là transform đảo ngược thật (XOR+HMAC, không phải echo):

- `stored.equals(bytes)` = **false** ⇒ byte bền vững KHÔNG phải plaintext (đúng ý đồ bảo mật).
- `stored.includes(SENTINEL)` = **false** ⇒ không rò plaintext ở storage.
- `readBack.equals(bytes)` = **false** ⇒ **đọc lại ra CIPHERTEXT, không phải tài liệu**.

Test **PASS** ⇒ đây là hành vi thật, không phải tranh luận. Đây là **data-loss bug**: bật seam lên
là mọi artifact mà worker ghi ra không đọc lại được. Nó **im lặng** — không throw, chỉ trả về
byte sai — nên sẽ chỉ lộ ra ở tầng parse phía trên.

Vì sao chữa ở document-core không được: envelope (`EncryptedStorageObject`) là **contract wire**,
phải đi cùng object qua storage + `ArtifactAccessGrantSchema` (contracts `runtime.ts:226-237` —
chỉ có `fileName/mimeType/sizeBytes/sha256`, **không có** trường envelope). Muốn sửa đúng phải
sửa `packages/worker-sdk` + `packages/contracts` + orchestrator, tức **ngoài write scope**
tôi được giao (`businesses/document-core/src/actions/`). Tôi không tự mở rộng sang 3 package khác.

#### Vì sao (b) "validate checkpoint leases" là bất khả thi ở đây
- `StepCheckpointManager.assertActive` (đã có từ cycle trước) chỉ kiểm `ctx.signal?.aborted`.
- Grep `leaseEpoch|leaseExpiresAt` trong `businesses/document-core/src/worker.ts`: **0 match** —
  lease identity **không đi qua** adapter vào internal context. `TaskContext`
  (`src/types/context.ts`) không có `leaseEpoch`/`leaseExpiresAt`/`attempt`.
- Nên "validate lease" ở tầng này hiện **không có gì để validate**: chỉ có abort signal, mà signal
  là hệ quả của một lần gọi runtime bị 409 (lease đã mất), không phải bằng chứng lease còn hợp lệ.
- Thêm lease field = thêm một predicate **không có nguồn sự thật** để so sánh. Đó là loại "trông
  như đã kiểm" mà tôi đã phê phán ở Mục 20 (Δ45) và ở chính cycle này.

#### Phần (c) — ĐÃ CÓ TỪ TRƯỚC, tôi chỉ xác minh lại (không tự ghi công)
`StepCheckpointManager.toStoredForm` (cycle 20) đã seal **giá trị persist** qua `ctx.crypto.seal`
với binding `checkpoint:<stepKey>`, `fromStoredForm` mở khi replay, `assertEncryptionAvailable`
fail-closed **trước** khi step body chạy. 9 test ở `tests/doc-core-crypto-seam.test.ts` (đọc lại
từ source: 3 adapter + 6 checkpoint) phủ đúng các mệnh đề này. ⇒ (c) không còn việc.

#### Baseline đo được TRƯỚC khi kết luận (không sửa gì)
- `pnpm --filter @du/document-core test`: **46/46 suite, 542/542 test, Exit Code 0**.
- `pnpm --filter @du/worker-sdk test`: **18/18 suite, 311/311 test, Exit Code 0**.
  (18 + 1 suite mới của tôi = 19; xem Verify.)

#### Verify (offline, literal exit code)
- Proof suite mới: `Tests: 1 passed, 1 total` — Exit Code: **0**.
- `pnpm --filter @du/worker-sdk test` (full, **có** suite proof của tôi):
  `Test Suites: 19 passed, 19 total` / `Tests: 312 passed, 312 total` — Exit Code: **0**.
- `pnpm --filter @du/document-core test` (full): **46/46, 542/542** — Exit Code: **0**.
- `pnpm --filter @du/worker-sdk exec tsc --noEmit` — Exit Code **0** (log rỗng).
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code **0** (log rỗng).
  Grep `error TS` trên cả 2 log: **không có** dòng nào.

#### File tôi thêm / file tôi KHÔNG đụng
- THÊM: `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts` (test chứng minh, không sửa logic).
- KHÔNG đụng: `src/actions/**`, `src/worker.ts`, `src/pipelines/step-checkpoint.ts`,
  `src/types/context.ts`, và **không sửa** `task-context.ts` / `crypto-*.ts` của worker-sdk.
  Lý do: sửa read path cần contract thay đổi ở 3 package (Δ57), nằm ngoài scope.

#### Δ-DEVIATION (chờ coordinator adjudicate — đây là phần cần quyết)
- **Δ57 — BLOCKER, cần phạm vi mới.** Round-trip artifact hỏng khi bật seam. Sửa đúng cần:
  (1) `packages/contracts`: thêm trường envelope vào `ArtifactAccessGrantSchema` (+ `EncryptedChunkManifest`
  cho >5 MiB, vẫn là Δ44); (2) `packages/worker-sdk`: `sealArtifactBytes` trả về và **persist**
  `EncryptedStorageObject` (nonce/tag/aad/dek), và read path phải `decrypt` khi grant nói object là
  encrypted; (3) orchestrator: trả envelope trong grant + lưu cạnh object. **Không lane nào tôi
  được giao đang giữ cả 3.** Cho tôi scope này hoặc giao lane khác — hiện tại ENC-04 **không thể
  coi là xong**.
- **Δ58 — cần quyết định, không phải sửa code.** (a) và (c) hiện **mâu thuẫn nhau**: checkpoint đã seal
  (cycle 20) nhưng artifact chưa seal ở tầng đọc ⇒ một hệ thống vừa "bảo mật" vừa "hỏng". Nếu bật
  seam ở production, checkpoint vẫn đọc lại được (nó tự mang envelope) còn artifact thì không.
  ⇒ **không bật seam cho tới khi Δ57 xong** — điều này cũng làm Δ45 (chưa deployment nào bật seam)
  hoá ra là **tình trạng đúng**, không phải sự trễ chưa làm.
- **Δ59 — checkpoint lease.** Muốn validate lease ở document-core thì adapter phải mang
  `leaseEpoch` / `leaseExpiresAt` từ `ClaimedTask` vào `TaskContext`, và checkpoint phải **ràng
  buộc epoch vào binding AAD** để checkpoint của lease cũ không mở được dưới lease mới. Đó là
  thay đổi ở `types/context.ts` + `worker.ts` + `step-checkpoint.ts` **và** phải khớp với policy
  orchestrator (lease fence ở Mục 11). Tôi chưa làm vì cần coordinator chốt: ràng buộc epoch vào AAD
  có làm hỏng replay sau retry không? (Retry = lease epoch mới; nếu AAD gồm epoch thì checkpoint cũ
  không mở được ⇒ mất idempotent replay.) **Đây là câu hỏi thiết kế, tôi không tự quyết.**

#### Tự phân loại 4 tầng
- **SPECIFIED**: rõ về ý, nhưng **2/3 mệnh đề không thể đạt ở write scope đã giao**.
- **IMPLEMENTED**: 0 file sản phẩm. 1 file test chứng minh.
- **VERIFIED (offline)**: doc-core 46/46 542/542 Exit 0; worker-sdk 19/19 312/312 Exit 0;
  proof 1/1 Exit 0; tsc 0.
- **ACCEPTED**: không thuộc quyền lane. Δ57 (round-trip) và Δ59 (lease binding) cần coordinator
  adjudicate trước khi ENC-04 được coi là đóng.
## 25 — CYCLE 25: W-ENC-04-GRANT-SCHEMA (Δ57 mục 1) — task_34d73cbfbe44, ctx_9b165ca0357b

#### SAI LẦM TRONG PACKET — đã sửa bằng đo, không sửa bằng phỏng đoán
Packet nói: *"Cập nhật `packages/contracts/src/operations.ts` để mở rộng `ArtifactAccessGrantSchema`"*.
Đo thật:

- `ArtifactAccessGrantSchema` **KHÔNG nằm trong `operations.ts`**. Nó ở
  `packages/contracts/src/runtime.ts:226`. Grep `operations.ts` cho `ArtifactAccessGrant` = **0 match**.
- `operations.ts` có `EncryptedArtifactDownloadSchema` + `EncryptedResultEnvelopeSchema`, nhưng đó là
  **recipient delivery envelope** (khoá công khai, cho bên nhận NGOÀI) — **khác** storage envelope.
  Dùng nhầm hai loại đó là lẫn lộn giữa ENC-03 (at rest) và ENC-05/ENC-07 (delivery).
⇒ Tôi sửa file **đúng** (`runtime.ts`), và **không** đụng `operations.ts`.

#### Quyết định thiết kế quan trọng: KHÔNG tái dùng `WrappedDekEnvelopeSchema`
Có **hai** hình DEK trong repo và chúng **khác nhau**:

| | field | dùng ở đâu |
|---|---|---|
| `WrappedDekEnvelopeSchema` (contracts `encryption.ts:67`) | `keyId`, `wrappedKey`, `nonce`, `tag` | ADR-18 delivery/wrap, mặt bên nhận |
| **`StorageWrappedDekSchema` (mới)** | `keyRef`, `keyVersion`, `ciphertext` | storage path, `EncryptedStorageObject.dek` |

Nguồn sự thật là runtime, không phải doc: `vault-transit-provider.ts:42-46`
```ts
export interface WrappedDek {
  readonly keyRef: string;
  readonly keyVersion: number;
  readonly ciphertext: string;
}
```
Nếu tôi tái dùng schema ADR-18, hợp đồng sẽ mô tả một thứ mà facade **không bao giờ ghi ra**, và mọi
object thật sẽ fail với lý do sai (thiếu field, chứ không phải hỏng envelope). Tôi tách riêng và có
test chống lại việc hai hình bị gộp nhầm về sau.

Một điểm tôi **đo** thay vì giả định: `aad` là **base64** chứ không phải JSON thô —
`crypto-storage-facade.ts:528` là `aad: aad.toString('base64')` (AAD bên trong mới là JSON). Nên
regex base64 của `EnvelopeCiphertextSchema` là đúng, tôi giữ nguyên cách đó.

#### Thay đổi (2 file src + 1 file test)

1. **`packages/contracts/src/encryption.ts`** — thêm 2 schema, mirror **field-for-field**
   `EncryptedStorageObject` (`crypto-storage-facade.ts:58-68`):
   - `StorageWrappedDekSchema` — `.strict()`, `keyVersion` **bắt buộc** (không đoán "latest":
     đoán sai sẽ unwrap dưới key đã rotate rồi fail auth với lý do hiểu sai).
   - `StorageEnvelopeRefSchema` — `version`, `algorithm`, `nonce`, `tag`, `aad`,
     `plaintextSizeBytes`, `plaintextSha256`, `dek`. `.strict()` + 2 `.refine()` ép **đúng**
     12 byte nonce / 16 byte tag: base64 hợp lệ nhưng sai độ dài sẽ fail sâu trong cipher với lỗi
     gây hiểu nhầm, nên chặn ngay tại contract.
   - **Không có** `ciphertext` trong schema: byte đó đi qua `downloadUrl`. Đây là *reference*
     tới ciphertext, không phải bản sao — và đó là lý do `ciphertext: Buffer` của
     `EncryptedStorageObject` không xuất hiện ở đây.
2. **`packages/contracts/src/runtime.ts`** — `ArtifactAccessGrantSchema` thêm
   `encryption: StorageEnvelopeRefSchema.optional()` (+ import). **Optional** nên grant plaintext
   cũ vẫn hợp lệ byte-for-byte; server hiện dựng grant bằng cách gán field tuỳ chọn
   (`artifacts.ts:415-435`) nên không phá call site nào.
3. **`packages/contracts/tests/grant-encryption-envelope.test.ts`** (mới, 13 test).

#### Một lỗi của chính tôi, đã bắt và sửa
Test đầu tiên **đỏ 1/13**: tôi khẳng định `WrappedDekEnvelopeSchema` parse được shape delivery của nó,
nhưng fixture của tôi thiếu `version: 1` ⇒ schema **đúng**, **test tôi sai**. Đã sửa fixture (thêm
`version: 1 as const`), không sửa schema để chiều theo test. Đây là bài học quen: khi test mới đỏ,
phải hỏi "ai sai" trước khi sửa.

#### Mutation probe (chứng minh test cắn, không chỉ xanh)

Cả hai probe **đơn biến**, chạy trên file đã backup, restore byte-exact sau mỗi cái:

- **M1** — `encryption` thành **bắt buộc** (bỏ `.optional()`):
  `Tests: 1 failed, 12 passed` — đúng test `leaves a plaintext grant unchanged and unencrypted`.
  ⇒ test thật sự bảo vệ tính **opt-in**; nếu không có nó, ai đó siết field này thành bắt buộc sẽ
  làm **mọi grant plaintext vỡ** mà không có test nào kêu.
- **M2** — bỏ 2 `.refine()` byte-length (giữ nguyên `.strict()`):
  `Tests: 3 failed, 10 passed` — đúng 3 test nonce/tag: `rejects a nonce that is valid base64
  but not 12 bytes`, `rejects a tag that is not 16 bytes`, và `surfaces the failure at the GRANT`.

Hai lần tôi **làm hỏng probe trước khi probe chạy** và phải làm lại — cả hai lần đều do **chính tôi**
đo sai, không phải do schema:
1. M2 lần 1 xoá 6 dòng thay vì 8 ⇒ `.refine` tag bị bỏ dở, file **sai cú pháp**, jest báo
   `Tests: 0 total`. Tôi **không** ghi "M2 đỏ" theo kết quả đó — 0 test chạy không phải bằng chứng.
2. M2 lần 2 xoá luôn `.strict()` ⇒ 4 test đỏ thay vì 3, tức **hai biến cùng lúc**, không phải probe
   đơn biến. Đã làm lại cho sạch.
Ghi lại vì đây là lần thứ ba trong các cycle gần đây một "bằng chứng" hoá ra là artifact của lỗi
đo của chính tôi; nếu không kiểm kỹ thì tôi sẽ nộp con số sai.

#### Baseline và Verify (offline, literal exit code)
**Baseline đo TRƯỚC khi sửa** (quan trọng, vì nó không xanh):
`Test Suites: 12 failed, 8 passed, 20 total` / `Tests: 227 passed, 227 total`.
12 suite **không chạy được** do lỗi TS **có sẵn** ở file của lane Cost
(`usage-reconciliation.ts:121` `Cannot find name 'NonNegativeIntSchema'`, mtime `2026-09-28T01:22`,
`usage-budget.ts` 23:02, `pricing.ts` 22:32). Tôi **không** sửa, không hấp thụ — cũng không ghi nó
vào delta của mình.

**Sau khi sửa:**
- Suite mới: `Test Suites: 1 passed` / `Tests: 13 passed, 13 total` — Exit Code: **0**.
- `pnpm --filter @du/contracts test` FULL: **`Test Suites: 23 passed, 23 total` /
  `Tests: 462 passed, 462 total`** — Exit Code: **0**.
  ⇒ **12 lỗi TS ngoại lai đã tự hết** (lane Cost sửa file của họ trong lúc tôi làm). Tôi không
  gán công dọn đó cho mình: 20 suite baseline + 1 của tôi + 2 suite mới của lane khác = 23.
- `pnpm --filter @du/contracts exec tsc --noEmit` — Exit Code: **0**, log rỗng.
- **Typecheck hạ nghiệm (vì contracts là package dùng chung):**
  `@du/orchestrator` tsc Exit Code **0**; `@du/worker-sdk` tsc Exit Code **0**.
  Thêm field optional không phá consumer nào — đã kiểm bằng chạy thật, không suy luận.
- Restore byte-exact: `runtime.ts` sha **`71c0458e`** / 20832 B; `encryption.ts` sha **`395e0880`** /
  13973 B. `runtime.ts` giữ nguyên **CRLF** (467 CRLF / 0 LF) — file này CRLF, file kia LF, tôi đo
  từng file thay vì đoán.

#### Phần coordinator đã phán (Δ59) — GHI NHẬN, không tự mở lại
Coordinator quyết: **KHÔNG ràng buộc lease epoch vào checkpoint AAD**, để giữ idempotent replay khi
retry. Tôi đồng ý và ghi lý do để cycle sau không đề xuất ngược lại: một retry là một **lease epoch
mới**, nên nếu epoch nằm trong AAD thì checkpoint của lần trước **không mở được** ⇒ mất đúng tính
chất idempotent mà checkpoint sinh ra để có. ⇒ Δ59 **ĐÓNG** theo quyết định này. Tôi **không** thêm
gì vào `step-checkpoint.ts`.

#### Δ-DEVIATION (chờ coordinator)
- **Δ60 — hai hình DEK đang cùng tồn tại, chưa ai adjudicate.**
  `WrappedDekEnvelopeSchema` (keyId/wrappedKey/nonce/tag) và `StorageWrappedDekSchema`
  (keyRef/keyVersion/ciphertext) là hai hợp đồng **khác nhau về tên field** cho cùng một khái niệm
  "DEK đã wrap". Tôi tách để khớp runtime, nhưng về lâu dài đây là nợ kỹ thuật: một ai đó đọc
  ADR-18 sẽ hiểu nhầm shape nào áp dụng ở đâu. Cần một lane sở hữu contracts quyết: hợp nhất tên,
  hay ghi rõ bảng mapping trong `docs/15-decisions.md`. **Tôi không tự hợp nhất** vì sẽ phá wire
  với facade đang chạy.
- **Δ57 tiến 1/3.** Mục 1 (contract) **xong**. Còn:
  - (2) `packages/worker-sdk`: `sealArtifactBytes` phải trả + **persist** envelope, và read path
    phải `decrypt` khi grant có `encryption`.
  - (3) orchestrator: trả `encryption` trong grant + lưu envelope cạnh object.
  **Không mục nào trong 2-3 nằm trong write scope tôi được giao ở task này**, nên Δ57 **chưa
  đóng** và ENC-04 vẫn chưa coi là xong. Contract bây giờ đã sẵn sàng cho (2)-(3).
- **Δ44 chưa đụng** (chunked >5 MiB). `StorageEnvelopeRefSchema` cố tình **không** có trường
  manifest: manifest của runtime dùng `manifestMac` mà contract chưa đóng băng field MAC (ghi rõ
  ở `crypto-storage-facade.ts:127-129`). Thêm field manifest bây giờ là hợp đồng cho thứ chưa tồn
  tại — để Δ44.

#### Tự phân loại 4 tầng
- **SPECIFIED**: rõ, **sai 1 chi tiết** (tên file) — đã sửa bằng đo.
- **IMPLEMENTED**: 2 file src (1 file thêm schema, 1 file thêm field optional) + 1 file test mới.
- **VERIFIED (offline)**: 13/13 mới; FULL contracts 23/23 462/462 Exit 0; tsc contracts 0;
  tsc orchestrator 0; tsc worker-sdk 0; M1/M2 đơn biến đúng mục tiêu; restore byte-exact 2 file.
- **ACCEPTED**: không thuộc quyền lane. Δ57 còn mục 2-3; Δ60 cần quyết về hai hình DEK.
