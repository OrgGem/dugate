# 35. Acceptance Baseline (Bảng Chuẩn Nghiệm Thu Duy Nhất Toàn Fleet)

**Document Version:** 1.0.0  
**Date:** 2026-09-23  
**Lane:** Testing Lane (Antigravity-6)  
**Authority:** W42-A66 (Orchestrator)  
**Reference Report:** [`du-rework/coordination/reports/antigravity-6.md`](file:///D:/Git/dugate/du-rework/coordination/reports/antigravity-6.md)  
**Reference Inventory:** [`du-rework/docs/28-test-inventory.md`](file:///D:/Git/dugate/du-rework/docs/28-test-inventory.md)  
**Reference Review:** [`du-rework/coordination/PLAN-REVIEW-2026-09-23.md`](file:///D:/Git/dugate/du-rework/coordination/PLAN-REVIEW-2026-09-23.md)  

---

## 1. Nguyên Tắc Cốt Lõi Về Tiêu Chuẩn Nghiệm Thu

1. **Nguyên tắc Exit Code 0 Tuyệt Đối:** Mọi tác vụ `[x]` chỉ được công nhận khi suite hỗ trợ đạt `Exit Code: 0`.
2. **Quy Chế Cô Lập `[GREEN-EXIT1]` (Ghi nhớ tiền lệ CR-11):**
   - Ba test suite: `blob-wire-binary.test.ts` (5/5), `ingress-bounded.test.ts` (8/8), và `usage-summary.test.ts` (9/9) trước đó bị Exit Code 1 do open handle / afterAll hook timeout.
   - **KẾT QUẢ TÁI THỰC THI (W42-A70):** Cả 3 suite đã được chạy lại độc lập và **đều đạt Exit Code 0 sạch sẽ** (5.09s, 4.09s, 4.07s). Trạng thái `[GREEN-EXIT1]` đã được giải tỏa hoàn toàn; 3 suite chính thức chuyển sang **`[PASS]`**, hợp lệ làm bằng chứng nghiệm thu cho `P2-03`, `P2-04`, `P2-08`.
3. **Phân Định Trách Nhiệm Sửa Lỗi (Zero Source Edits by Testing Lane):** Testing Lane chỉ ghi nhận kết quả thực nghiệm khách quan; không sửa source code của các lane khác.

---

## 2. Tổng Hợp Số Liệu Bảng Chuẩn Toàn Bộ Fleet (104 Suites)

- **Tổng số Suites kiểm kê:** **104 suites**
  - **OFFLINE Suites:** **82 suites** (100% PASS, Exit Code 0, 1,394 passed / 1,394 total)
  - **LIVE_INFRA Suites:** **22 suites** (100% tồn tại trên đĩa, Test-Path = True)
    - **`[PASS]` (Exit 0):** **20 suites** (262 tests passed)
    - **`[GREEN-EXIT1]` (Exit 1 - Open Handle):** **0 suites** (0 tests)
    - **`[FAIL]` (Exit 1 - Functional / Timeout):** **2 suites** (10 tests passed, 4 failed, 14 total)
- **Tổng số Tests Toàn Fleet (104 Suites Thực Tế Trên Đĩa):**
  - **Tests Passed:** $1,394\text{ (Offline)} + 262\text{ (Live Pass)} + 10\text{ (Live Fail Passed)} = \mathbf{1,666\text{ tests passed}}$.
  - **Tests Failed:** $0\text{ (Offline)} + 0\text{ (Live Pass)} + 4\text{ (Live Fail)} = \mathbf{4\text{ tests failed}}$.
  - **Tổng Tests:** $1,666 + 4 = \mathbf{1,670\text{ tests total}}$.

> [!IMPORTANT]
> **Phán Quyết Phân Loại Duy Nhất Toàn Fleet (Reconciliation C1 - Testing Lane Owned):**
> Trước đây tồn tại mâu thuẫn C1 (`docs/28` ghi 81/23 vs `docs/35` ghi 82/22) xoay quanh tệp `tests/isolation/concurrent-interference.test.ts`.
> Sau khi kiểm tra vật lý mã nguồn: tệp này chạy 100% bằng in-memory jail (`IsolatedRedisJail`, `InMemoryRuntimeStub`), không mở bất kỳ kết nối mạng nào tới PostgreSQL :5433 hay Redis :6380, và được phân loại là `Category="Offline"` trong `concurrent-runner.ps1`.
> Do đó, với tư cách là owner của cả `docs/28` và `docs/35`, Testing Lane đã phán quyết phân loại chuẩn xác duy nhất là **`OFFLINE`**. Cả `docs/28` và `docs/35` hiện đã đồng thuận tuyệt đối: **104 suites = 82 OFFLINE + 22 LIVE_INFRA**. Quyết định này là chung cuộc, khép lại mâu thuẫn C1.

> [!IMPORTANT]
> **Addendum W43-Q6 (Qwen-2 lane, owner docs/28 + docs/35):** Browser harness `du-rework/tests/browser/`
> (Playwright chromium-only headless, **BROWSER** class) hoàn tất bởi OpenClaude (W47-O). Vì các suite
> browser **không cần DB/Redis** nên được xếp loại **BROWSER (offline)**. Cập nhật tổng:
> **106 suites = 82 OFFLINE + 22 LIVE_INFRA + 2 BROWSER**.
> Số test BẢNG CHUẨN mới: **passed = 1,680 | failed = 8 | total = 1,688**
> (tăng: +14 sections passed, +4 failed interactions — chi tiết mục 3.4).

> [!IMPORTANT]
> **Addendum W43-Q13 (Qwen-2 lane): 4 suite CR-12/13 = ANSWERED GREEN 10:24 (W42-A90, antigravity-6.md:5419-5494).**
> Re-run 1 cửa sổ DB (10:22:30→10:23:55, 1m25s, window FREE): `blob-wire-binary **8/8** exit 0 · ingress-bounded **8/8** exit 0 ·
> usage-summary **9/9** exit 0 · p4-05-artifact-streams **7/7** exit 0` — **32 passed / 32 total**, 0 failed, 0 GREEN-EXIT1.
> CR-12 regression giải quyết triệt để (A6 verbatim: "thêm token_mode='upload' và rotateGrant cho download đã giải quyết 100% các lỗi 403 trước đó"; root cause fixture-level xác nhận).
> 3 suite GREEN-EXIT1 cũ (blob-wire/ingress/usage) đã chuyển **[PASS]** exit 0 vĩnh viễn; `p4-05` [x]. Không 'GREEN-BUT-EXIT1' nào còn tồn tại trong cụm này.

> [!IMPORTANT]
> **Addendum W43-Q14 (Qwen-2 lane): A91/A92 = QUEUED ADMIN ROUTES (chưa chạy).** A6 (antigravity-6.md:5527-5622):
> `NO DB USED — CHO C (ADM-BASE-01 sẽ có 6 route test)`. 6 route GET pre-staged: `businesses/:id/versions`,
> `profiles/:businessId/:businessVersion/:name`, `connectors/:connectorId/revisions/:rev`, `api-keys`,
> `operations/:id`, `admin/audit` — là 6 PLATFORM REQUEST groups của ADM-BASE-01 (CHỜ build + RUN REQUEST
> của C). Chưa có literal/exit code → KHÔNG thêm hàng bảng chuẩn nào cho 6 route này tới khi có kết quả thật.

> [!IMPORTANT]
> **Addendum W43-Q15 (Qwen-2 lane): A96 (12:43→12:48) xác nhận 2 sự thật + stale-count fix.**
> (1) **ADM-BASE-01 6/6 routes VERIFIED LIVE** — suite MỚI `services/orchestrator/tests/admin-base-routes.test.ts`:
> `Tests: 7 passed, 7 total`, **Exit 0**, 2.36s (A96 §1: auth fence 401; businesses/:id/versions; profiles/:b/:v/:name
> (cả `latest`); connectors/:id/revisions/:rev masked-host zero-secret; api-keys+/:keyId grants; admin/audit;
> dữ liệu THẬT, zero fake not-found pane). OpenClaude UNBLOCKED. → hàng LIVE 23, `P2-02`/ADM-BASE-01 VERIFIED.
> (2) **R24-02 KHÔNG done — 3 fail** (multi-container A96: `3 failed, 10 passed, 13 total (0 skipped)` exit 1,
> 50.24s; 10 xanh gồm toàn bộ artifact/reasoning + PRF-01; 3 fail = version pinning 1.1.0≠1.0.0, crash lease null,
> PRF-02 barrier 15s — khớp baseline docs/35 row 20).
> (3) **Stale-count fix theo W48-O3/O5** (OpenClaude phát hiện): rows 76/77/79 = 14→37 (+23), 59→136 (+77),
> 25→56 (+31) — [PASS] giữ nguyên, chỉ TONG cập nhật; drift +131 đúng bằng gap 1,394→1,525 của offline batch
> (bảng 3.1 nay khớp rerun). **Tổng mới: 112 suites = 87 OFFLINE + 23 LIVE_INFRA + 2 BROWSER; tests 1,829 passed / 4 failed / 1,889 total.**

> [!IMPORTANT]
> **Addendum W43-Q6b (Qwen-2 lane): Offline re-run 07:14–07:19 (runner literal: `82 suites = 81 PASS +
> 1 FAIL thoáng qua`; `Tests Passed Sum: 1469 | Tests Total Sum: 1525`).** FAIL duy nhất
> `admin-shell-server.test.ts` (2 failed, 54 passed, 56 total) **chỉ dưới tải batch**; chạy độc lập 56/56
> exit 0 và cụm 4-suite 254/254 exit 0 — transient flake, suite mới chưa commit của platform
> (xem docs/28 §6.1). Qwen-2 thêm 5 OFFLINE suites (63 tests, xem docs/28 §6.2). **Tổng mới (W43-Q7 final,
> sau W47-O12 browser interactions 4/4 PASS): 111 suites = 87 OFFLINE + 22 LIVE_INFRA + 2 BROWSER;
> tests 1,822 passed / 4 failed / 1,882 total.** Không có regression ổn định mới; [FAIL] 4 = 4 live cũ
> (multi-container 3, p4-08 1). Browser interactions từng [FAIL 0/4 harness-side] → nay **[PASS] 4/4
> exit 0** (fix harness-side, zero sửa src platform) — chi tiết mục 3.4 + docs/28 §4.7. R24-01 đã được
> verify live (operation-tenant-fence 4/4, W42-A78) → blocker an ninh cuối đóng (docs/29 W43-Q7).

---

## 3. Bảng Chuẩn Chi Tiết Toàn Bộ 104 Suites

### 3.1. 82 Suites OFFLINE (Hoàn toàn độc lập hạ tầng, Exit Code 0)

| # | Suite Path | Status | Literal Test Summary | Exit Code | Time | Hàng Đối Chứng | Ghi Chú Phạm Vi |
|:---:|---|:---:|---|:---:|:---:|:---:|---|
| 1 | `businesses/document-core/tests/all-variants-e2e.test.ts` | **[PASS]** | `Tests: 29 passed, 29 total` | 0 | 4.07s | `P5-10` [~] | 28 variants in-memory mock slice |
| 2 | `businesses/document-core/tests/analyze.test.ts` | **[PASS]** | `Tests: 10 passed, 10 total` | 0 | 4.06s | `P5-06` [x] | Sáu action analyze recipes |
| 3 | `businesses/document-core/tests/barrier-cleanup-lifecycle.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 3.04s | `P5-03` [x] | Barrier cleanup & temp sweep |
| 4 | `businesses/document-core/tests/bounded-input.test.ts` | **[PASS]** | `Tests: 32 passed, 32 total` | 0 | 4.05s | `P5-02` [x] | Payload boundaries & limits |
| 5 | `businesses/document-core/tests/build-dependency-order.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | 0 | 3.06s | `P5-01` [x] | Dependency graph DAG order |
| 6 | `businesses/document-core/tests/cancellation-fencing.test.ts` | **[PASS]** | `Tests: 10 passed, 10 total` | 0 | 3.07s | `P5-03` [x] | Heartbeat fencing token |
| 7 | `businesses/document-core/tests/checkpoint-replay.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 3.09s | `P5-03` [x] | Checkpoint replay determinism |
| 8 | `businesses/document-core/tests/checkpoint.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.09s | `P5-03` [x] | Step checkpoint persistence |
| 9 | `businesses/document-core/tests/child-lifecycle.test.ts` | **[PASS]** | `Tests: 13 passed, 13 total` | 0 | 5.08s | `P5-03` [x] | Child tasks spawn/join |
| 10 | `businesses/document-core/tests/compare.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | 0 | 4.08s | `P5-09` [x] | Compare diff & semantic |
| 11 | `businesses/document-core/tests/config.test.ts` | **[PASS]** | `Tests: 15 passed, 15 total` | 0 | 3.07s | `P5-01` [x] | Module config parsing |
| 12 | `businesses/document-core/tests/corpus-regression.test.ts` | **[PASS]** | `Tests: 29 passed, 29 total` | 0 | 4.06s | `P0-05` [x] | Corpus snapshot regression |
| 13 | `businesses/document-core/tests/cross-service-boundary.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 4.06s | `P1-07` [x] | Cross-service boundary schemas |
| 14 | `businesses/document-core/tests/extract.test.ts` | **[PASS]** | `Tests: 12 passed, 12 total` | 0 | 4.05s | `P5-05` [x] | Extract action 5 variants |
| 15 | `businesses/document-core/tests/generate.test.ts` | **[PASS]** | `Tests: 11 passed, 11 total` | 0 | 4.05s | `P5-08` [x] | Generate action 6 variants |
| 16 | `businesses/document-core/tests/helpers/synthetic-fixtures.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 4.07s | `P0-05` [x] | Fixture generator helpers |
| 17 | `businesses/document-core/tests/ingest.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | 0 | 4.10s | `P5-04` [x] | Ingest action native parse |
| 18 | `businesses/document-core/tests/manifest.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 4.08s | `P5-01` [x] | Manifest 28 variants |
| 19 | `businesses/document-core/tests/output-validation.test.ts` | **[PASS]** | `Tests: 23 passed, 23 total` | 0 | 3.06s | `P5-02` [x] | Output validation schemas |
| 20 | `businesses/document-core/tests/package-boundary.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.05s | `P1-01` [x] | Workspace package encapsulation |
| 21 | `businesses/document-core/tests/parser-budgets.test.ts` | **[PASS]** | `Tests: 48 passed, 48 total` | 0 | 3.05s | `P4-06` [x] | CPU & memory budget bounds |
| 22 | `businesses/document-core/tests/profile-binding-fixture.test.ts` | **[PASS]** | `Tests: 12 passed, 12 total` | 0 | 5.10s | `P5-03` [x] | Profile binding fixtures |
| 23 | `businesses/document-core/tests/provider-backed-variant.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 3.06s | `P5-03` [x] | Provider variant with mock |
| 24 | `businesses/document-core/tests/sdk-consumer.test.ts` | **[PASS]** | `Tests: 12 passed, 12 total` | 0 | 3.05s | `P4-01` [x] | SDK consumer local mocks |
| 25 | `businesses/document-core/tests/test-target-guard.test.ts` | **[PASS]** | `Tests: 42 passed, 42 total` | 0 | 3.07s | `P1-05` [x] | DB/Redis safety guards |
| 26 | `businesses/document-core/tests/traceability.test.ts` | **[PASS]** | `Tests: 7 passed, 7 total` | 0 | 3.05s | `P0-04` [x] | Traceability matrix BR-01..12 |
| 27 | `businesses/document-core/tests/transform.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 3.05s | `P5-07` [x] | Transform action 5 variants |
| 28 | `businesses/document-core/tests/worker.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 3.06s | `P4-02` [x] | Worker loop mock queue |
| 29 | `businesses/example-review/tests/approval-wait.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.07s | `P7-05` [x] | Human approval wait states |
| 30 | `businesses/example-review/tests/child-review.test.ts` | **[PASS]** | `Tests: 18 passed, 18 total` | 0 | 3.07s | `P7-05` [x] | Child review aggregation |
| 31 | `businesses/example-review/tests/example-review.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 4.07s | `P7-02` [x] | Example review core business |
| 32 | `businesses/example-review/tests/fanout-and-join.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 3.06s | `P7-05` [x] | Fanout & join continuation |
| 33 | `businesses/example-review/tests/fencing.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.05s | `P7-02` [x] | Lease fencing tokens |
| 34 | `businesses/example-review/tests/input-validation.test.ts` | **[PASS]** | `Tests: 45 passed, 45 total` | 0 | 3.05s | `P7-01` [x] | Input review schemas |
| 35 | `businesses/example-review/tests/manifest.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 3.05s | `P7-01` [x] | Example review manifest |
| 36 | `businesses/example-review/tests/package-boundary.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.07s | `P7-02` [x] | Package boundary isolation |
| 37 | `businesses/example-review/tests/registry-tool.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 3.11s | `P7-03` [~] | CLI registry registration tool |
| 38 | `businesses/example-review/tests/task-context-consumer.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 3.07s | `P7-02` [x] | TaskContext consumer props |
| 39 | `businesses/example-review/tests/version-coexistence.test.ts` | **[PASS]** | `Tests: 3 passed, 3 total` | 0 | 4.07s | `P7-06` [x] | v1/v2 concurrent versions |
| 40 | `packages/connector-client/tests/client.test.ts` | **[PASS]** | `Tests: 2 passed, 2 total` | 0 | 4.07s | `P3-07` [x] | Client retry & transport mock |
| 41 | `packages/connector-client/tests/transport.test.ts` | **[PASS]** | `Tests: 16 passed, 16 total` | 0 | 4.07s | `P3-07` [x] | Wire protocol encoding & HMAC |
| 42 | `packages/contracts/tests/dto.test.ts` | **[PASS]** | `Tests: 20 passed, 20 total` | 0 | 4.09s | `P1-02` [x] | DTO schema validation |
| 43 | `packages/contracts/tests/hashing-errors.test.ts` | **[PASS]** | `Tests: 11 passed, 11 total` | 0 | 3.07s | `P1-04` [x] | Error hashing determinism |
| 44 | `packages/contracts/tests/invocation-hash.test.ts` | **[PASS]** | `Tests: 6 passed, 6 total` | 0 | 4.09s | `P3-03` [x] | Canonical request hash |
| 45 | `packages/contracts/tests/manifest.test.ts` | **[PASS]** | `Tests: 20 passed, 20 total` | 0 | 3.05s | `P1-07` [x] | Manifest schema contracts |
| 46 | `packages/contracts/tests/queue.test.ts` | **[PASS]** | `Tests: 7 passed, 7 total` | 0 | 3.05s | `P1-02` [x] | BullMQ queue job data schemas |
| 47 | `packages/contracts/tests/state-machine.test.ts` | **[PASS]** | `Tests: 12 passed, 12 total` | 0 | 3.06s | `P1-04` [x] | State machine transitions |
| 48 | `packages/document-kit/tests/converters.test.ts` | **[PASS]** | `Tests: 13 passed, 13 total` | 0 | 3.05s | `P4-06` [x] | Pandoc/HTML converters |
| 49 | `packages/document-kit/tests/detector.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 3.06s | `P4-06` [x] | Magic byte MIME detection |
| 50 | `packages/document-kit/tests/limits-boundary.test.ts` | **[PASS]** | `Tests: 31 passed, 31 total` | 0 | 4.05s | `P4-06` [x] | Parser memory & file limits |
| 51 | `packages/document-kit/tests/parsers.test.ts` | **[PASS]** | `Tests: 10 passed, 10 total` | 0 | 4.09s | `P4-06` [x] | DOCX/XLSX/PDF parser kit |
| 52 | `packages/document-kit/tests/pdf-splitter.test.ts` | **[PASS]** | `Tests: 10 passed, 10 total` | 0 | 3.05s | `P4-06` [x] | PDF page chunk splitting |
| 53 | `packages/document-kit/tests/zip-extractor.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | 0 | 3.07s | `P4-06` [x] | Zip bomb protection & extract |
| 54 | `packages/observability/tests/observability.test.ts` | **[PASS]** | `Tests: 16 passed, 16 total` | 0 | 3.05s | `P2-09` [x] | Metrics, logs, traces |
| 55 | `packages/worker-sdk/tests/artifact-streams.test.ts` | **[PASS]** | `Tests: 40 passed, 40 total` | 0 | 3.04s | `P4-05` [ ] | Unit artifact stream & chunks |
| 56 | `packages/worker-sdk/tests/connector-session.test.ts` | **[PASS]** | `Tests: 30 passed, 30 total` | 0 | 3.06s | `P4-07` [x] | Connector session mock |
| 57 | `packages/worker-sdk/tests/fan-out.test.ts` | **[PASS]** | `Tests: 20 passed, 20 total` | 0 | 4.06s | `P4-04` [x] | Fan-out child dispatch unit |
| 58 | `packages/worker-sdk/tests/temp-sweep.test.ts` | **[PASS]** | `Tests: 6 passed, 6 total` | 0 | 4.05s | `P4-05` [ ] | SDK workspace temp sweep |
| 59 | `packages/worker-sdk/tests/worker.test.ts` | **[PASS]** | `Tests: 23 passed, 23 total` | 0 | 4.08s | `P4-01..03` [x] | TaskContext, step checkpoint |
| 60 | `services/connector/tests/canonical-hash-parity.test.ts` | **[PASS]** | `Tests: 2 passed, 2 total` | 0 | 4.07s | `P3-03` [x] | Hash parity across SDK/P3 |
| 61 | `services/connector/tests/composition.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 4.06s | `P3-04` [x] | Middleware & auth composition |
| 62 | `services/connector/tests/connector.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 3.05s | `P3-04` [x] | Generic provider adapter |
| 63 | `services/connector/tests/mock-provider/provider.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 4.07s | `P3-04` [x] | Controllable mock provider |
| 64 | `services/connector/tests/reliability-security.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 4.07s | `P3-03..08` [x] | Token bucket, quota, RBAC |
| 65 | `services/connector/tests/runtime-foundations.test.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | 0 | 4.08s | `P3-01..06` [x] | Ledger outbox, foundations |
| 66 | `services/connector/tests/security-lifecycle.test.ts` | **[PASS]** | `Tests: 6 passed, 6 total` | 0 | 4.09s | `P3-02` [x] | Secret rotation & encryption |
| 67 | `services/connector/tests/webhook.test.ts` | **[PASS]** | `Tests: 6 passed, 6 total` | 0 | 4.06s | `P3-06` [x] | Webhook delivery signatures |
| 68 | `services/orchestrator/tests/admin-api-key-view-model.test.ts` | **[PASS]** | `Tests: 25 passed, 25 total` | 0 | 3.08s | `P6-05` [~] | Admin API key view model |
| 69 | `services/orchestrator/tests/admin-business-view-model.test.ts` | **[PASS]** | `Tests: 54 passed, 54 total` | 0 | 3.06s | `P6-02` [x] | Business registry UI model |
| 70 | `services/orchestrator/tests/admin-connector-view-model.test.ts` | **[PASS]** | `Tests: 33 passed, 33 total` | 0 | 4.06s | `P6-04` [~] | Connector proxy view model |
| 71 | `services/orchestrator/tests/admin-operation-view-model.test.ts` | **[PASS]** | `Tests: 74 passed, 74 total` | 0 | 4.05s | `P6-06` [~] | Operations view model |
| 72 | `services/orchestrator/tests/admin-overview-view-model.test.ts` | **[PASS]** | `Tests: 46 passed, 46 total` | 0 | 4.08s | `P6-01` [x] | Overview metrics view model |
| 73 | `services/orchestrator/tests/admin-p6-01-shell-fixtures.test.ts` | **[PASS]** | `Tests: 38 passed, 38 total` | 0 | 3.06s | `P6-01` [x] | Screen fixtures & layout mock |
| 74 | `services/orchestrator/tests/admin-profile-view-model.test.ts` | **[PASS]** | `Tests: 23 passed, 23 total` | 0 | 4.08s | `P6-03` [x] | Profile editor view model |
| 75 | `services/orchestrator/tests/admin-shell-auth.test.ts` | **[PASS]** | `Tests: 29 passed, 29 total` | 0 | 3.05s | `P6-01` [x] | Admin auth guard cookies |
| 76 | `services/orchestrator/tests/admin-shell-platform-mount.test.ts` | **[PASS]** | `Tests: 37 passed, 37 total` | 0 | 3.05s | `P6-01` [x] | **W48-O3/O5 stale-count fix**: 14→37 (drift +23 sau freeze 09-23) — [PASS] đúng, count cập nhật theo rerun |
| 77 | `services/orchestrator/tests/admin-shell-render.test.ts` | **[PASS]** | `Tests: 136 passed, 136 total` | 0 | 4.06s | `P6-02` [x] | **W48-O3/O5 stale-count fix**: 59→136 (drift +77) — [PASS] đúng, count cập nhật theo rerun |
| 78 | `services/orchestrator/tests/admin-shell-router.test.ts` | **[PASS]** | `Tests: 25 passed, 25 total` | 0 | 4.07s | `P6-01` [x] | Shell HTTP route dispatch |
| 79 | `services/orchestrator/tests/admin-shell-server.test.ts` | **[PASS]** | `Tests: 56 passed, 56 total` | 0 | 4.08s | `P6-01` [x] | **W48-O3/O5 stale-count fix**: 25→56 (drift +31) — [PASS] đúng; batch load flake đã ghi W43-Q6b |
| 80 | `services/orchestrator/tests/admin-view-model.test.ts` | **[PASS]** | `Tests: 105 passed, 105 total` | 0 | 4.06s | `P6-01..06` [~] | Comprehensive view models |
| 81 | `tests/isolation/concurrent-interference.test.ts` | **[PASS]** | `Tests: 12 passed, 12 total` | 0 | 4.08s | `P1-05` [x] | Dual sandbox concurrency |
| 82 | `tests/stubs/provider/mock-provider.test.ts` | **[PASS]** | `Tests: 5 passed, 5 total` | 0 | 4.07s | `P1-05` [x] | Stubs provider contract |

---

### 3.2. 22 Suites LIVE_INFRA (Thực thi trên PostgreSQL :5433 / Redis :6380, 100% Test-Path: True)

| # | Suite Path | Status | Literal Test Summary | Exit Code | Time | Hàng Đối Chứng | Ghi Chú Trạng Thái & Cảnh Báo |
|:---:|---|:---:|---|:---:|:---:|:---:|---|
| 1 | `businesses/document-core/tests/p8-03-provider-convergence.test.ts` | **[PASS]** | `Tests: 7 passed, 7 total` | 0 | 4.07s | `P8-03` [~] | Document core provider convergence |
| 2 | `businesses/example-review/tests/example-review-continuation.integration.test.ts` | **[PASS]** | `Tests: 10 passed, 10 total` | 0 | 50.37s | `P7-05` [x] | Example review continuation integration |
| 3 | `businesses/example-review/tests/p7-03-registry-live.integration.test.ts` | **[PASS]** | `Tests: 15 passed, 15 total` | 0 | 4.08s | `P7-03` [~] | Extension registry live registration |
| 4 | `businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts` | **[PASS]** | `Tests: 19 passed, 19 total` | 0 | 4.07s | `P7-04` [~] | Profile assignment generic live |
| 5 | `packages/connector-client/tests/real-service.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 3.05s | `P3-07` [x] | Real service live harness (Env-gated: 1 test khi CONNECTOR_INTEGRATION=1) |
| 6 | `services/connector/tests/black-box-durable.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 4.08s | `P3-05` [x] | Black-box durable execution |
| 7 | `services/connector/tests/durable-integration.test.ts` | **[PASS]** | `Tests: 2 passed, 2 total` | 0 | 3.05s | `P3-06` [x] | Durable integration outbox |
| 8 | `services/connector/tests/p8-03-convergence.test.ts` | **[PASS]** | `Tests: 22 passed, 22 total` | 0 | 3.06s | `P8-03` [~] | Connector ledger convergence |
| 9 | `services/orchestrator/tests/migrations.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | 0 | 4.06s | `P2-01` [x] | Schema migrations live sandbox |
| 10 | `services/orchestrator/tests/runtime.test.ts` | **[PASS]** | `Tests: 97 passed, 97 total` | 0 | 10.12s | `P2-04..09` [x] | Core orchestrator runtime |
| 11 | `tests/integration/artifacts-grants.integration.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 3.08s | `P2-07` [x] | Rebuild dist raw:bytes passed |
| 12 | `tests/integration/connector-usage.integration.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 3.09s | `P2-07` [x] | Ingestion proxy live |
| 13 | `tests/integration/p8-02-fault-recovery.integration.test.ts` | **[PASS]** | `Tests: 20 passed, 20 total` | 0 | 4.07s | `P8-02` [~] | Crash & lease fault injection |
| 14 | `tests/integration/p8-04-security-isolation.integration.test.ts` | **[PASS]** | `Tests: 26 passed, 26 total` | 0 | 3.06s | `P8-04` [x] | 6 security classes proven |
| 15 | `tests/integration/usage-projection.integration.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | 0 | 3.05s | `P2-07` [x] | Redis outbox to PG projection |
| 16 | `services/orchestrator/tests/blob-wire-binary.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | **0** | 4.08s | `P2-03` [~] | **W42-A90 10:24**: CR-12 regression resolved (8/8, gồm token_mode upload/download separation; count 5→8 sau thêm CR-12 tests). Xem addendum W43-Q13. |
| 17 | `services/orchestrator/tests/ingress-bounded.test.ts` | **[PASS]** | `Tests: 8 passed, 8 total` | **0** | 4.09s | `P2-04` [x] | Exit 0 sạch sẽ (open handle giải phóng, W42-A70) |
| 18 | `services/orchestrator/tests/usage-summary.test.ts` | **[PASS]** | `Tests: 9 passed, 9 total` | **0** | 4.07s | `P2-08` [x] | Exit 0 sạch sẽ (open handle giải phóng, W42-A70) |
| 19 | `businesses/document-core/tests/bullmq-smoke.test.ts` | **[PASS]** | `Tests: 1 passed, 1 total` | **0** | 4.08s | `P4-02` [x] | Exit 0 sạch sẽ, race condition đã giải tỏa (W42-A72) |
| 20 | `businesses/document-core/tests/multi-container-e2e.integration.test.ts` | **[FAIL]** | `Tests: 3 failed, 10 passed, 13 total (0 skipped)` | **1** | 50.24s | `P5-10` [~] | **A96 12:49: R24-02 KHÔNG done — 3 fail thật, 0 skipped** (L1485 version pinning 1.1.0≠1.0.0, L1656 crash lease null, L1821 PRF-02 barrier 15s); 10/13 xanh gồm toàn bộ artifact/reasoning + PRF-01 403 |
| 21 | `tests/integration/p4-05-artifact-streams.integration.test.ts` | **[PASS]** | `Tests: 7 passed, 7 total` | **0** | 5.10s | `P4-05` [x] | Exit 0 sạch sẽ, gỡ bỏ decode shim, raw byte-equal (W42-CX17) |
| 22 | `tests/integration/p4-08-sdk-consumer.integration.test.ts` | **[FAIL]** | `Tests: 1 failed, 1 total` | **1** | 70.51s | `P4-08` [ ] | TS2345 CLEARED; runtime poll timeout 60s -> FAILED — **owner = Codex-2, connector-poll in progress (W43-Q16)**; pending RUN REQUEST 13/13 no-skip qua antigravity |




---

### 3.3. Các đường dẫn MA (ABSENT) Đã Bị Loại Bỏ Khỏi Bằng Chứng (Audit Gating W42-A68)

Tất cả các đường dẫn dưới đây đã được kiểm tra bằng lệnh `Test-Path` và trả về kết quả `False` (tệp không tồn tại trên đĩa). **Mọi nhãn [PASS] trước đây gắn với các tệp này bị hủy bỏ hoàn toàn và chuyển thành `ABSENT - KHÔNG PHẢI BẰNG CHỨNG`**.

| # | Đường Dẫn Suite MA (Phantom Path) | Kết Quả `Test-Path` | Phân Loại | Hàng Task Từng Trích Dẫn Sai | Ghi Chú & Tệp Thay Thế Hợp Lệ Trên Đĩa |
|:---:|---|:---:|:---:|:---:|---|
| 1 | `tests/integration/blob-wire-binary.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | `P2-03` [~] | Tệp thực tế là `services/orchestrator/tests/blob-wire-binary.test.ts` (5 passed, GREEN-EXIT1). |
| 2 | `tests/integration/connector-e2e.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | **`P3-08`** [x] | Tệp không tồn tại. P3-08 có bằng chứng offline hợp lệ: `services/connector/tests/reliability-security.test.ts` (9/9). |
| 3 | `tests/integration/connector-real-service.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | **`P3-07`** [x] | Tệp không tồn tại. Tệp thực tế là `packages/connector-client/tests/real-service.test.ts` (1 test). |
| 4 | `tests/integration/continuation-resume.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | **`P2-06`** [x] | Tệp không tồn tại. Tệp thực tế là `businesses/example-review/tests/example-review-continuation.integration.test.ts` (10/10). |
| 5 | `tests/integration/cross-service-boundary.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | **`P1-07`** [x] | Tệp không tồn tại. Tệp thực tế là offline `businesses/document-core/tests/cross-service-boundary.test.ts` (4/4). |
| 6 | `tests/integration/full-system-e2e.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | `P2-10` [~] | Tệp không tồn tại. |
| 7 | `tests/integration/p7-03-extension-deployment.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | `P7-03` [~] | Tệp không tồn tại. Tệp thực tế là `businesses/example-review/tests/p7-03-registry-live.integration.test.ts` (15/15). |
| 8 | `tests/integration/p7-04-generic-admin-profile.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | `P7-04` [~] | Tệp không tồn tại. Tệp thực tế là `businesses/example-review/tests/p7-04-profile-assignment.integration.test.ts` (19/19). |
| 9 | `tests/integration/bullmq-task-queue.integration.test.ts` | **False** | **`ABSENT - KHÔNG PHẢI BẰNG CHỨNG`** | `P4-02` [x] | Tệp không tồn tại trong tests/integration. Tệp thực tế là `businesses/document-core/tests/bullmq-smoke.test.ts` (1 failed). |

---

### 3.4. 2 Suites BROWSER (Playwright chromium-only, harness offline, zero DB/Redis — W47-O / W43-Q6)

Nguồn: `du-rework/tests/browser/W47-O-REPORT-FRAGMENT.md` (W47-O11 DONE, 2026-09-24 ~05:27 +07),
`artifacts-summary.json` (`{"generatedAt":"2026-09-24T05:26:36+07:00","summary":{"critical":0,"serious":0,"moderate":0,"minor":0}}`),
31 screenshots / 28 axe scans. Ghi nhận bởi Qwen-2 (owner docs/28 + docs/35), **chỉ sau kết quả chạy thật**.

| # | Suite Path | Status | Literal Test Summary | Exit Code | Ghi Chú |
|:---:|---|:---:|---|:---:|---|
| 1 | `tests/browser/tests/sections.spec.ts` | **[PASS]** | `Tests: 14 passed, 14 total` | **0** | 7 sections × desktop/mobile = 14; axe critical/serious/moderate/minor = **0**; 31 screenshots / 28 axe scans; harness offline no DB/Redis. Hàng đối chứng `P6-07` [~]. |
| 2 | `tests/browser/tests/interactions.spec.ts` | **[PASS]** | `Tests: 4 passed, 4 total` | **0** | **W47-O12** (05:45:08, 2.4s): 4/4 interactions PASS sau fix harness-side (`harness-server.ts:35`, `stubs.ts:228`); **zero sửa src platform**, assertions giữ nguyên văn. P6-07 gate **MET — sẵn sàng để coordinator flip [x]**. Harness offline no DB/Redis. |

> **KHÔNG dùng [FAIL] này làm bằng chứng regression platform** — toàn bộ 4 lỗi interaction là harness-side
> (đã phân loại từng cái trong W47-O8). Class BROWSER = offline (không DB/Redis), bổ sung cạnh OFFLINE/LIVE_INFRA.

---

## 4. Chẩn Đoán Dành Riêng Cho Claude Code (DIAGNOSTIC FOR CLAUDE CODE)

**Target:** Module `services/orchestrator`  
**Problem:** Ba suite `blob-wire-binary`, `ingress-bounded`, `usage-summary` đều chạy đúng 32-34 giây (trong đó đúng 30 giây bị kẹt tại `afterAll`) và kết thúc với `Exit Code 1`.

### Lỗi hiển thị:
```text
FAIL tests/blob-wire-binary.test.ts (32.035 s)
  ● Test suite failed to run
    thrown: "Exceeded timeout of 30000 ms for a hook."
    > afterAll(async () => { ... await app?.close(); }, 30_000);
```

### Cơ chế gốc rễ được tìm thấy trong code:
1. `app.close()` tại [`services/orchestrator/src/server.ts:313-317`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/server.ts#L313-L317):
   ```typescript
   const drainTimeout = options?.timeoutMs ?? config.shutdownTimeoutMs ?? 30000;
   await runtime.drain(drainTimeout, pollInterval).catch(() => undefined);
   ```
2. `runtime.drain()` tại [`services/orchestrator/src/modules/runtime/runtime.ts:30-35`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/runtime/runtime.ts#L30-L35):
   ```typescript
   const getActiveLeasesCount = async (): Promise<number> => {
     const res = await db.query<{ count: string | number }>(
       "SELECT count(*)::int as count FROM tasks WHERE state = 'RUNNING'"
     );
     return Number(res.rows[0]?.count ?? 0);
   };
   ```
3. **NGUYÊN NHÂN:** Query trên đếm toàn bộ task có `state = 'RUNNING'` mà **KHÔNG lọc theo `lease_expires_at > NOW()`** và không phân vùng theo tenant/test.
   - Trong database `du_orchestrator_test`, một task crash mồ côi (`2eecd5ba-cdfd-4966-9dab-bec4b853fe36`) còn lưu `state = 'RUNNING'` dù `lease_expires_at` đã hết hạn từ nhiều giờ trước.
   - Do đó, `getActiveLeasesCount()` luôn trả về `1`, khiến `runtime.drain()` bị kẹt trong vòng lặp chờ đúng **30.000 ms**.
4. **HẬU QUẢ:** Jest timeout 30.000 ms của `afterAll` ngắt ngang tiến trình **TRƯỚC KHI** `app.close()` kịp gọi:
   - `server.close()` $\rightarrow$ Rò rỉ `TCPSERVERWRAP`
   - `redis.disconnect()` $\rightarrow$ Rò rỉ client Redis
   - `db.close()` $\rightarrow$ Rò rỉ PostgreSQL pool
5. **HAI PHƯƠNG ÁN KHẮC PHỤC DÀNH CHO CLAUDE CODE (W42-C4 Decision D):**
   - **Phương án 1 (Sửa logic `runtime.ts`):**
     Đổi query thành:
     ```sql
     SELECT count(*)::int as count FROM tasks WHERE state = 'RUNNING' AND lease_expires_at > NOW()
     ```
   - **Phương án 2 (Sửa test shutdown):**
     Cho phép gọi `app.close({ timeoutMs: 0 })` trong test hook để bỏ qua quá trình drain 30 giây khi đóng test.
6. **KẾT QUẢ TÁI KIỂM CHỨNG (W42-A70):** Cả 3 suite `blob-wire-binary`, `ingress-bounded`, `usage-summary` đã chạy độc lập và đạt Exit Code 0 sạch sẽ (5.09s, 4.09s, 4.07s). Toàn bộ 3 suite đã chuyển sang `[PASS]`, không còn open handle hay timeout 30s.

---

## 5. Tổng Hợp Run Request Response Cho Codex-2 (P4-05 & P4-08)

1. **`p4-05-artifact-streams.integration.test.ts`**:
   - **Kết quả tái kiểm chứng (W42-A70):** `Tests: 1 failed, 6 passed, 7 total` (Exit Code 1, 4.07s wall / 2.53s Jest).
   - **Chi tiết:** 6/7 cases pass; fail tại line 280 do lỗi format JSON base64 wrapping trong `blob-store.ts` (`expect(decoded.equals(payloadCopy)).toBe(true)` nhận `false`).
   - **Khuyến nghị cho Codex-2:** **Giữ nguyên `[ ]` / `[~] PARTIAL`**, chưa đủ điều kiện nghiệm thu.
2. **`p4-08-sdk-consumer.integration.test.ts`**:
   - **Kết quả tái kiểm chứng (W42-A70):** `Tests: 1 failed, 1 total` (Exit Code 1, 70.51s wall / 68.32s Jest).
   - **Chi tiết:** 
     - **Compile step:** `TS2345` đã **100% HOÀN TOÀN BIẾN MẤT** (zero TypeScript error).
     - **Runtime step:** Sau khi mock provider trả `PROVIDER_PENDING`, worker ghi nhận `errorCode: PROVIDER_PENDING`, nhưng operation không hoàn tất `SUCCEEDED` mà hết hạn 60s và rơi vào `FAILED`. Vẫn vướng contract HTTP-202 polling replay tại connector.
   - **Khuyến nghị cho Codex-2:** **Giữ nguyên `[ ]` / `[~] PARTIAL`**, KHÔNG tick `[x]`, chờ Platform lane giải quyết contract HTTP 202 polling.

