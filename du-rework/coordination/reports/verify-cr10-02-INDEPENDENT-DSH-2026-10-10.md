# Verify độc lập (DSH) — CR10-02 usage dispatcher containment — 2026-10-10

**Vai trò:** Independent Verifier (term_8bfe6adc) cho packet CR10-02 do lane Qwen implement.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test; **KHÔNG** `git add` / commit / push; **KHÔNG** sửa code (kể cả mutation tạm thời — packet cấm); **KHÔNG** tick gate; artifact ghi thêm duy nhất là receipt này + raw log.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · cwd cho mọi lệnh: `du-rework/orchestrator/services/connector`.
**Node:** v22.23.3 (PATH) cho các lượt chính; v24.21.0 (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`) cho lượt khớp runtime của receipt gốc.
**Raw:** `du-rework/coordination/reports/raw/verify-cr10-02-2026-10-10/DSH/` (`focused-run1..3.log`, `focused-node24.log`, `regression-pair.log`, `typecheck.log`, `unit-full.log`, `SHA256SUMS.txt`).

## 0. Đối tượng kiểm (digest tại thời điểm verify)

| File | Dòng | sha256 | Trạng thái git |
|---|---:|---|---|
| `orchestrator/services/connector/src/usage-dispatcher.ts` | 226 | `ac55c95169bf193b400dbd969317bcc3b0154aa230e13bed8319539ad88a60d5` | ` M` (modified) |
| `orchestrator/services/connector/tests/cr10-02-usage-dispatcher-rejection.test.ts` | 194 | `c628d2d76815409e8dd591aef25c22af0ddad214596ca11dd8df3e4e739ae3a9` | `??` (untracked) |
| `coordination/reports/receipt-cr10-02-usage-dispatcher-2026-10-10.md` | 152 | `641df0b5897bff0327d8963a43385f9b790582cd9be154952460231ed3d0f0d7` | `??` |

Phạm vi thay đổi của connector đúng như receipt khai: chỉ 2 file trên (`git status --porcelain` trên `services/connector` = đúng 2 dòng). `git diff --numstat` của source = **22 insertions / 1 deletion** — khớp chính xác con số receipt §2.

## 1. Bằng chứng chạy (mỗi lệnh một tiến trình, REAL_EXIT đo ngay sau lệnh)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts` (lần 1) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 2 | như trên (lần 2, tiến trình riêng) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 3 | như trên (lần 3, tiến trình riêng) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 4 | như trên trên **node v24.21.0** | **0** | `Tests: 5 passed, 5 total` |
| 5 | `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/cr10-02-usage-dispatcher-rejection.test.ts tests/reliability-security.test.ts tests/r1-d-lifecycle-offline.test.ts` | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 30 passed, 30 total` (cả 2 suite dispatcher cũ PASS) |
| 6 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | không output · `error_lines=0` |
| 7 | `node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand --forceExit` (full offline unit của connector) | **0** | `Test Suites: 37 passed, 37 total` · `Tests: 1 skipped, 453 passed, 454 total` · **không có suite FAIL** |

⇒ Toàn bộ số liệu trong receipt gốc (§4.3 `30 passed`, §4.4 `37 suites / 453 passed / 1 skipped`, §4.5 typecheck 0) **được tái lập độc lập, khớp từng con số**. Lượt trên node v24.21.0 cũng xanh ⇒ không phụ thuộc runtime trong 2 bản đã thử.

## 2. Kiểm source — containment (đọc trực tiếp, file:line)

- **Biên độ lớn gốc:** `runBatchCycle()` (`src/usage-dispatcher.ts:163-169`) bọc `await this.processBatch()` trong `try/catch`; nhánh catch chỉ log `logger.error('usage dispatch cycle failed', { error: safeErrorForLog(error) })` ⇒ hàm **luôn resolve**.
- **`dispatchOnce()` (`:143-151`)** gán `this.draining = this.runBatchCycle()` ⇒ promise này không thể reject; nhánh `if (this.draining) return this.draining` trả cùng promise đã contained.
- **Scheduler (`:215-220`)**: `void this.dispatchOnce().finally(() => this.schedule(this.options.pollIntervalMs))` — timer callback fire-and-forget không còn đường reject; `schedule()` giữ nguyên nên **cadence poll tiếp tục** sau lỗi.
- **`drain()` (`:103-141`)**: `await Promise.race([work, timeoutPromise])` với `work = this.draining` (đã contained) ⇒ shutdown không reject khi DB hỏng; `running = false` + `clearTimeout` (`:104-108`) vẫn dừng timer.
- **`deliver()` (`:176-213`)**: `markDelivered` reject → catch → `await this.outbox.defer(...)`; nếu `defer` cũng reject thì rejection nổi lên `Promise.all` → `processBatch()` → **bị chặn tại `runBatchCycle()`** ✓. Ack thất bại không bao giờ đánh dấu DELIVERED (markDelivered chỉ chạy sau khi sink thành công, `:197`).
- Ba đường thoát mà receipt liệt kê (claimBatch reject; markDelivered + defer reject; sink fail + defer reject) **đều nằm dưới cùng một biên**; không còn nhánh nào trả promise trần ra timer.

**Đối chiếu deviation 2 của receipt** (đặt containment ở `runBatchCycle` thay vì thêm `.catch()` trong `schedule()`): tôi xác nhận đây là **tập chứa rộng hơn** — vì `dispatchOnce()` không thể reject, một `.catch()` thứ hai trong `schedule()` sẽ là dead code; cách đặt hiện tại phủ cả `drain()` và caller trực tiếp. Ghi nhận là lựa chọn hợp lý, không phải thiếu sót.

## 3. Kiểm test — bounds, listener unhandledRejection, tính hai kênh

- **Bounds/fault injection:** `FaultInjectingOutbox` (`tests/cr10-02-usage-dispatcher-rejection.test.ts:14-58`) đếm `claimCalls`/`markDeliveredCalls`/`deferCalls` và có **bộ đếm lỗi giảm dần** (`claimFailuresRemaining`, `markDeliveredFailuresRemaining`, `deferFailuresRemaining` — mỗi lần ném thì `-= 1`) ⇒ lỗi có biên, không phải lỗi vô hạn; chỉ test drain cố ý dùng `claimFailuresRemaining = 10000` (`:176`) để mọi poll đều fail.
- **Listener unhandledRejection:** `captureUnhandledRejections()` (`:60-72`) `process.on('unhandledRejection', handler)` gom `reasons`, và `stop()` gỡ handler; **cả 5 test** đều `try { … } finally { await dispatcher.drain(); capture.stop(); }` ⇒ không rò listener giữa các test.
- **Assertion hai kênh:** mọi test đều assert **trạng thái outbox/sink** *và* `expect(capture.reasons).toEqual([])`:
  1. `:83-111` — claimBatch fail 2 lần: `reasons=[]`, `claimCalls >= 3` (cadence tiếp tục), `delivered=[eventId]` (giao đúng 1 lần sau khi DB hồi), `markDeliveredCalls=1`, `size()=0`.
  2. `:113-129` — gọi trực tiếp: `dispatchOnce()` **resolves** (không reject), `size()=1`.
  3. `:131-149` — markDelivered fail + defer fail: resolve, `markDeliveredCalls=1`, `size()=1` (không bị coi là đã giao).
  4. `:151-171` — sink fail + defer fail: resolve, `size()=1` (event vẫn trong outbox).
  5. `:173-194` — drain khi mọi poll fail: `claimCalls` **không tăng** sau drain ⇒ timer dừng thật.
- **Giới hạn kỹ thuật đã biết:** test 1, 5 dùng `settle(120ms)` / `settle(60ms)` với `pollIntervalMs: 5` ⇒ bản chất phụ thuộc thời gian, có thể flake dưới tải nặng; tôi chạy **3 lần liên tiếp + 1 lần trên v24 đều xanh** nên không thấy flake trong điều kiện hiện tại.

## 4. Kiểm chéo các claim khác của receipt

- **Claim message bị redact (deviation 1):** tôi grep độc lập `packages/observability/src/log-events.ts` cho `usage dispatch cycle failed` → **0 hit**; `SAFE_LOG_MESSAGES` có tại `:2` ⇒ message sẽ ra `[REDACTED]` đúng như receipt nói. Nhãn sự cố vẫn phân loại được qua `subsystem=usage-dispatcher`, `level=error`, `service=connector`, `error.kind`. **Kết luận: claim này ĐÚNG**; muốn có message đọc được cần lease trên `log-events.ts` (ngoài lease CR10-02).
- **Claim không đổi semantics giao:** đọc `deliver()` xác nhận `markDelivered` chỉ chạy sau `Promise.race` sink thành công (`:196-197`), nhánh catch chỉ `defer` ⇒ không có đường đánh dấu DELIVERED khi DB chưa nhận.
- **Claim scope:** `git status` trên service connector = đúng 2 file; không đụng CR10-01/03/04.

## 5. Verdict

| Hạng mục | Kết quả |
|---|---|
| Focused suite (5 test) | **PASS** — 3/3 lần exit 0, `5 passed, 5 total`; thêm 1 lần trên node v24.21.0 cũng xanh |
| Regression 2 suite dispatcher cũ | **PASS** — `3 passed, 3 total`, `30 passed, 30 total`, exit 0 |
| Full offline unit connector | **PASS** — `37 passed, 37 total`, `1 skipped, 453 passed, 454 total`, exit 0, không suite FAIL |
| Typecheck | **PASS** — exit 0, 0 lỗi |
| Đọc source (containment + không đổi semantics giao) | **ĐẠT** — ba đường reject đều nằm dưới biên `runBatchCycle()`; `drain()`/scheduler an toàn |
| Bounds + listener của test | **ĐẠT** — fault có bộ đếm giảm dần, listener được gỡ trong `finally`, assert hai kênh |
| Claim phụ (redaction, numstat 22/1, scope 2 file) | **KHỚP** với kiểm chứng độc lập |

⇒ **CR10-02: VERIFY ĐỘC LẬP ĐẠT ở phạm vi offline.** Kết luận này **không** tick gate (VERIFIED/ACCEPTED thuộc coordinator) và **không** thay thế acceptance bullet 4 bên dưới.

## 6. GAP / open items

1. **Acceptance bullet 4 chưa được chứng minh (cả implementer lẫn tôi):** `verifier chạy fault/recovery test + integration với DB disposable` — lượt này **offline hoàn toàn** (không PostgreSQL/Redis/S3, không claim DB window). Cần một packet verifier có DB disposable nếu muốn đóng bullet đó; tôi **không** claim đã làm.
2. **Message log bị `[REDACTED]`** (deviation 1 đã xác nhận): vận hành sẽ không đọc được message `usage dispatch cycle failed` cho tới khi `SAFE_LOG_MESSAGES` được mở rộng — việc này cần lease trên `packages/observability/src/log-events.ts`.
3. **Không có mutation check độc lập từ tôi:** packet cấm sửa code (kể cả tạm thời), nên bằng chứng mutation chỉ đến từ receipt gốc (§4.2). Tôi bù bằng đọc source + 5 test trên cây cuối; nếu coordinator muốn mutation của bên thứ ba, cần cấp lease sửa tạm.
4. **Phụ thuộc thời gian:** 2 test dùng `settle` 60/120 ms; 4/4 lượt xanh nhưng đây là điểm dễ flake trên máy tải nặng.
5. **Chưa commit:** source ` M` + test `??` ⇒ verification gắn với working tree tại digest §0; nếu file đổi tiếp, kết quả hết hiệu lực.

## 7. Xác nhận

- Không `git add`, không commit, không push; không tick gate; không sửa source/test/docs (artifact duy nhất: receipt này + raw log).
- Receipt này tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
