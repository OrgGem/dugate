# Đánh giá độc lập — CR10-02 unhandled rejection: độ phủ & bounds (2026-10-10)

> **Kết luận: PASS về độ phủ offline, với 4 nhận xét bounds (2 residual phần code, 2 gap test) + 1 phát hiện staleness mới.** Đã đọc 2 receipt (cr10-02 + verify DSH), đọc source, và tự chạy lại test. Chưa phải ACCEPTED — coordinator/Reviewer mới chốt.

- **Đối tượng:** `orchestrator/services/connector/src/usage-dispatcher.ts`; receipt lane fix `receipt-cr10-02-usage-dispatcher-2026-10-10.md` + verifier `verify-cr10-02-INDEPENDENT-DSH-2026-10-10.md`.
- **Role:** đánh giá độc lập (lần 3, sau lane fix Qwen-5R và verifier DSH). Chỉ đọc + chạy test + ghi receipt này. Không sửa source/test, không commit/add/push, không tick gate.
- **Digest ràng buộc (đo được, khớp nguyên receipt DSH §0):**
  - `src/usage-dispatcher.ts` = `ac55c95169bf193b400dbd969317bcc3b0154aa230e13bed8319539ad88a60d5`
  - `tests/cr10-02-usage-dispatcher-rejection.test.ts` = `c628d2d76815409e8dd591aef25c22af0ddad214596ca11dd8df3e4e739ae3a9`
  - `git status` trong `services/connector` = đúng 2 dòng (M source, ?? test) — trùng scope cả 2 receipt trước.

## 1. Tự chạy lại (cwd `services/connector`, Node v24.21.0, mỗi lần 1 tiến trình)

| # | Lệnh | REAL_EXIT | Literal |
|---|---|---:|---|
| 1 | focused `cr10-02-usage-dispatcher-rejection.test.ts` | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 2 | như trên **nhưng output nối pipe vào findstr** | **FAIL** | `Test Suites: 1 failed, 1 total` · `Tests: 0 total` (suite lỗi cấp load, 0 test) |
| 3 | lại, không pipe | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 4 | lại, không pipe | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` |
| 5 | `--config jest.unit.config.cjs --runInBand --forceExit` (full offline unit) | **0** | `Test Suites: 37 passed, 37 total` · `Tests: 1 skipped, 453 passed, 454 total` |

**Ghi nhận lỗi #2 thẳng thắn, không dấu:** lần fail duy nhất là **do pipe `2>&1 | findstr` của chính tôi** (che mất chi tiết + thay đổi hành vi jest), **không** phải flake sản phẩm. Bằng chứng: cùng lệnh không pipe chạy thêm 2 lần đều xanh. Kết luận flake của suite dựa trên **3 lượt sạch liên tiếp** của hình dạng đúng (margins ~128–136 ms cho 2 test time-based, ổn định trong điều kiện máy này).

→ Con số `5/5`, `37 suites / 453 passed / 1 skipped` **được tái lập lần thứ ba**, khớp cả receipt gốc lẫn receipt DSH từng chữ.

## 2. Bounds của fix (đọc source, không tin lời ai)

**Biên duy nhất, là tập chứa rộng hơn yêu cầu:** `runBatchCycle()` (`src/usage-dispatcher.ts:163-171`) bọc `await this.processBatch()` trong try/catch chỉ log → hàm **luôn resolve**. Vì `dispatchOnce()` (`:143-151`) gán `this.draining = this.runBatchCycle()`, ba đường thoát gốc đều rơi xuống cùng biên:

| Đường | Từ | Đi tới biên |
|---|---|---|
| 1 | `claimBatch()` reject (`processBatch:153-156`) | ✓ qua `runBatchCycle` |
| 2 | `markDelivered` reject → `defer` reject (`deliver:176-213`, catch `:198-211`) | ✓ nổi lên `Promise.all` → `processBatch` → bị chặn |
| 3 | sink fail → `defer` reject (cùng catch) | ✓ như trên |

**Bền tại boundary scheduler (đúng trọng tâm packet):**

- Timer callback (`:215-221`) `void this.dispatchOnce().finally(() => this.schedule(...))` — promise mà `.finally` chờ **không thể reject**, nên timer không còn đường `unhandledRejection` (đây chính là chuỗi trước đây nổ ở `Timeout._onTimeout` — receipt gốc bắt được stack này ở RED).
- **Cadence giữ nguyên:** `schedule()` (`:215-221`) không đổi → `.finally` vẫn tải lệnh poll tiếp theo, nên DB hồi là dispatcher tự phục hồi. Test 1 pin đúng điều này: `claimFailuresRemaining = 2` nhưng `claimCalls >= 3` và event giao **đúng 1 lần** (`markDeliveredCalls = 1`). Đây là thuộc tính quan trọng nhất của boundary: containment **không** nuốt retry.
- **Shutdown an toàn:** `drain()` (`:103-141`) `await Promise.race([work, timeout])` với `work` đã contained → tắt máy không reject khi DB hỏng; `running = false` + `clearTimeout` (`:104-108`) vẫn dừng timer thật (test 5: `claimCalls` không tăng sau drain).
- **Không đổi semantics giao:** `markDelivered` chỉ chạy sau khi sink thắng (`:196-197`); ack thất bại → `defer` (`:198-211`) → không bao giờ đánh DELIVERED khi DB chưa nhận. Test 3/4 pin `size() = 1` (event vẫn trong outbox).
- **Đặt tại `runBatchCycle` thay vì `.catch()` trong `schedule()` = đúng lựa chọn:** vì `dispatchOnce()` không thể reject, catch thứ hai trong `schedule()` sẽ là dead code, còn biên hiện tại phủ cả `drain()` và mọi caller trực tiếp (phủ các đường dẫn DI và read). Tôi đồng ý đây là tập chứa rộng hơn, không phải thiếu sót (đúng như DSH nhận định — đây là điểm tôi xác nhận độc lập, không phải chép lại).

## 3. Residual bounds của phần code (2 điểm, tôi tự đọc ra — chưa có test nào phủ)

1. **Throw bên trong callback `.finally` vẫn thoát.** `void X.finally(() => this.schedule(...))` — nếu **chính** `schedule()` throw đồng bộ, promise sinh ra sẽ reject và `void` không có handler → `unhandledRejection` lại quay lại. Containment phủ promise mà `.finally` *chờ*, không phủ phần thân callback. Thực tế khó xảy ra: `schedule()` chỉ 2 dòng (`if (!this.running) return;` + `setTimeout` với `delay` đã qua `clampPositiveInteger` ở `:219-225`, luôn hữu hạn). **Đánh giá: chấp nhận được, nhưng đây là ranh giới thật của thiết kế** — nếu sau này ai thêm logic vào `schedule()` thì lỗ này mở lại. Không test nào mô phỏng được (cần injected clock/timer, ngoài harness hiện tại).
2. **Phần catch tự nó cũng gọi log.** `runBatchCycle` catch chỉ chứa `logger.error(..., { error: safeErrorForLog(error) })` — nếu chính `safeErrorForLog`/logger throw (đường shape lỗi lạ), catch ném lại → reject thoát ra ngoài. Cũng khó xảy ra, cũng không có test. Gợi ý cho owner: bọc khối catch bằng try/catch rỗng hoặc thử `safeErrorForLog` trên 1 vài shape lỗi lạ trong test payload-privacy.

Hai điểm này **không phải lỗi hiện tại** (không reproduced) — chúng là ranh giới của bằng chứng. Ghi rõ để không ai hiểu nhầm coverage là tuyệt đối.

## 4. Coverage của test (đọc toàn bộ 195 dòng)

**Điểm mạnh (đúng chuẩn):**
- Fault injection **biên**: `claimFailuresRemaining/markDeliveredFailuresRemaining/deferFailuresRemaining` giảm dần mỗi lần ném (`:18-20`, `:30-50`) → lỗi có giới hạn, không phải lỗi vô hạn vô hướng (trừ test 5 dùng 10000 có chủ đích để mọi poll đều fail).
- **Listener không rò:** mọi test `try { … } finally { await dispatcher.drain(); capture.stop(); }` → handler `unhandledRejection` luôn gỡ (`:60-72`).
- **Assertion hai kênh** mọi nơi: trạng thái outbox/sink **VÀ** `expect(capture.reasons).toEqual([])` → kiểm được cả hậu quả lẫn sự kiện nền.
- **Semantics được pin:** `markDeliveredCalls = 1` + `size() = 0` sau hồi phục; `size() = 1` khi ack fail → không có đường đánh dấu DELIVERED giả.

**Gap coverage tôi nhận ra (4, chưa test nào phủ):**
1. **Re-entry đồng thời** — nhánh `if (this.draining) return this.draining` (`:144`) không có test nào gọi `dispatchOnce()` lần hai khi chu kỳ đang chạy (không chứng minh không double-claim).
2. **Một-fault duy nhất: `markDelivered` fail mà `defer` THÀNH CÔNG** — test 3 luôn để `defer` fail song song; đường `catch → defer OK → defer trả về` chưa được pin trong suite này (có thể nằm ở 2 suite cũ, không kiểm chứng ở đây).
3. **2 residual §3** (callback `.finally` throw, logger throw trong catch) — không test, và khó test với harness hiện tại.
4. **Không có fault injection với DB thật** — acceptance bullet 4 (fault/recovery + integration DB disposable) vẫn **OPEN**; receipt này chỉ đánh giá offline. Đây là bound quan trọng nhất: **offline pass ≠ DB outage thật**.

## 5. Staleness — phát hiện mới của lượt đánh giá này

Theo đúng kỷ luật: receipt DSH (vừa đọc) đã cũ ở 1 điểm, và cần cảnh báo 1 điểm nữa.

1. **DSH ghi `0 hit` cho nhãn `usage dispatch cycle failed` trong `log-events.ts` → ĐÃ CŨ.** Hiện `packages/observability/src/log-events.ts:59` **đã có** nhãn, kèm 3 test ở `tests/payload-privacy.test.ts:54-75` → CR10-02-D1 đã land ở **src**.
2. **Nhưng `dist` CHƯA rebuild — và điều này quan trọng hơn D1:** `require.resolve('@du/observability')` từ connector = `packages/observability/dist/index.js` (`package.json:6` `main`), và file đó **không chứa cả** `SAFE_LOG_MESSAGES` lẫn nhãn (`findstr` = NO/NO) → dist là bản **cũ hơn cả lần thêm filter privacy**, tức filter chưa có trong bản consumer đang nạp. Hệ quả: `jest.config.cjs:5-7` chỉ map `@du/contracts` → **jest cũng đọc dist đó**.
3. **Cảnh báo dùng bằng chứng (quan trọng):** dòng log đọc được `message: usage dispatch cycle failed` trong các lượt chạy của tôi **KHÔNG chứng minh D1 sửa được đường sink** — nó xuất hiện vì dist cũ chưa có filter. **Không được** trích lượt chạy jest làm bằng chứng đóng D1; bằng chứng đúng là rebuild `packages/observability` rồi kiểm lại `dist`. (Khớp cảnh báo tự ghi của lane D1: dist gitignored, `git status` không hiện.)

## 6. Verdict

| Hạng mục | Kết quả |
|---|---|
| Focused 5 test | **PASS** — 3 lượt sạch liên tiếp (lượt #2 fail do pipe của tôi, đã nêu) |
| Full offline unit connector | **PASS** — `37 passed, 37 total` · `1 skipped, 453 passed, 454 total`, exit 0 |
| Tái lập independent lần 3 | **PASS** — khớp từng con số receipt gốc + DSH |
| Bounds fix (biên runBatchCycle phủ scheduler/drain/direct) | **ĐẠT** — 3 đường thoát đều nằm dưới biên; cadence + shutdown + semantics giao đều được test pin |
| Residual phần code | **2 điểm** (throw trong callback `.finally`; logger throw trong catch) — chưa reproduce, chưa test, ghi nhận là ranh giới |
| Gap coverage | **4 điểm** (re-entry, single-fault defer OK, 2 residual trên) |
| Live DB fault/recovery | **VẪN OPEN** — offline không thay thế được |
| Staleness | **1** (DSH về `0 hit` nhãn đã cũ) + **1 cảnh báo** (dist chưa rebuild ⇒ đừng trích log jest làm bằng chứng D1) |

**Đề xuất cho coordinator:** CR10-02 đủ điều kiện cân nhắc acceptance ở **phạm vi offline** (đã verify 3 lần độc lập, mỗi lần full suite xanh). Hai việc còn lại là việc của lane khác: (i) rebuild `packages/observability` rồi xác nhận D1 ở đúng đường sink; (ii) acceptance bullet 4 (DB thật) mở cửa sổ riêng. Tôi **không** tick gate, **không** viết VERIFIED/ACCEPTED.

## 7. Ranh giới đã giữ

- Không sửa file nào (chỉ đọc + chạy test); file duy nhất ghi là receipt này.
- Không `git add` / `commit` / `push`; không tick gate; không cập nhật task/plan.
- Offline hoàn toàn: không mở DB/Redis/S3, không claim DB window; test không cần hạ tầng.
- Không sửa `SAFE_LOG_MESSAGES` hay `dist` (ngoài phạm vi packet này).