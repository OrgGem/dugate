# Receipt — Legacy semaphore resilience: bounded acquire timeout (F-P1-02) — 2026-10-07

- **Packet:** "Legacy Semaphore Resilience & Redis Outage Hardening (F-P1-02 & F-P1-03)".
- **Owner:** OpenCode (`oc_3` / `term_8a432ae3-63b7-41fd-929e-0797860c7426`). **Mode:** WORKER.
- **Repo scope:** legacy root `D:\Git\dugate` ONLY — no `du-rework/` file touched.
- **Code freeze:** **KHÔNG commit, KHÔNG push**, no task-row tick, no `worker.js` rebuild.
- **Status:** F-P1-02 (MEDIUM) fixed with bounded acquire timeout + resilience tests; focused suite
  **7/7 green**, related legacy semaphore suites **33/33 green**, `npx tsc --noEmit` **exit 0**.
  F-P1-03 (LOW) remains the documented TTL residual (reference only in this dispatch — no behavior change claimed).

## 1. Diff bổ sung

### 1.1 `lib/queue/worker-slots.ts`

Header contract (thêm đoạn F-P1-02):

```diff
 // Failure contract (F-P1-01): a Redis error returns the DISTINGUISHABLE
 // `'fail-open'` outcome. ...
+//
+// Resilience contract (F-P1-02): the dedicated connection uses
+// `maxRetriesPerRequest: null`, so a Redis outage/hang makes the acquire EVAL
+// wait instead of rejecting. Acquire is therefore BOUNDED: after
+// `ACQUIRE_TIMEOUT_MS` (override per call) the attempt fails open and logs a
+// warn, so a worker can never hang forever on a stalled semaphore. Any slot a
+// late EVAL still takes is reclaimed by the TTL, exactly like the F-P1-01
+// error path.
```

Bounded helper + constant (mới):

```ts
export const ACQUIRE_TIMEOUT_MS = 1500;

class SlotAcquireTimeoutError extends Error { ... }

function withAcquireTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SlotAcquireTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
```

`tryAcquireSlot` (bọc EVAL, timeout → warn + fail-open; nhánh Redis error giữ nguyên):

```diff
 export async function tryAcquireSlot(
   apiKeyId: string,
   endpointSlug: string,
   cap: number,
   ttlSec: number,
+  timeoutMs: number = ACQUIRE_TIMEOUT_MS,
 ): Promise<SlotAcquireOutcome> {
   try {
-    const result = await getRedis().eval(
-      ACQUIRE_LUA, 1, `workerslots:${apiKeyId}:${endpointSlug}`, String(cap), String(ttlSec),
-    );
+    const result = await withAcquireTimeout(
+      getRedis().eval(
+        ACQUIRE_LUA, 1, `workerslots:${apiKeyId}:${endpointSlug}`, String(cap), String(ttlSec),
+      ),
+      timeoutMs,
+    );
     ...
   } catch (error) {
+    if (error instanceof SlotAcquireTimeoutError) {
+      logger.warn(
+        'worker-slot acquire timed out (Redis hang) — running without a slot; caller must NOT release',
+        { apiKeyId, endpointSlug, cap, timeoutMs },
+      );
+      return 'fail-open';
+    }
     logger.warn('worker-slot acquire failed open (Redis error) — ...', {...}, error);
     return 'fail-open';
   }
 }
```

Điểm kỹ thuật:
- Timer luôn được `clearTimeout` trong `finally` → không giữ open handle sau lệnh thành công.
- `Promise.race` quan sát cả hai nhánh nên EVAL settle muộn **không** tạo unhandled rejection và không thể đổi kết quả đã settle.
- Timeout có thể override per-call (`timeoutMs`, default 1500 ms) — không đổi call-site hiện tại trong `worker.ts`.
- Timeout trả về cùng outcome `'fail-open'` như lỗi Redis → worker chạy job không slot và **không release** (đúng hợp đồng F-P1-01).

### 1.2 `tests/pipelines/worker-slots-fail-open.test.ts`

Thêm 3 test (giữ nguyên 4 test cũ):

```ts
it('F-P1-02: a hung EVAL is bounded and yields fail-open with a timeout warn', ...);
//  mockEval never answers; tryAcquireSlot(..., timeoutMs=25) → 'fail-open' < 1s, warn chứa 'timed out'

it('F-P1-02: an EVAL answering within the bound is unaffected', ...);
//  EVAL trả sau 10ms với bound 500ms → 'acquired', không warn

it('F-P1-02: a late EVAL answer after the timeout cannot change the fail-open outcome', ...);
//  EVAL trả muộn sau timeout → outcome vẫn 'fail-open', đúng 1 warn, không rò rejection
```

## 2. Commands & evidence (cwd `D:\Git\dugate`)

| # | Command | Exit | Result | Raw log |
|---|---|---|---|---|
| 1 | `npm test -- tests/pipelines/worker-slots-fail-open.test.ts` (đúng lệnh dispatch) | **0** | **1 suite / 7 tests passed** | `coordination/reports/raw/p1-02-semaphore-resilience/focused-fail-open.log` |
| 2 | `npm test -- tests/pipelines/worker-slots.test.ts tests/pipelines/worker-slots-fail-open.test.ts tests/pipelines/profile-endpoint-limits.test.ts` | **0** | **3 suites / 33 tests passed** (trước packet: 30) | — |
| 3 | `npx tsc --noEmit` | **0** | zero diagnostics | `.../typecheck.log` (rỗng) |
| 4 | `git diff --check -- lib/queue/worker-slots.ts tests/pipelines/worker-slots-fail-open.test.ts` | **0** | no whitespace errors | — |

## 3. Files + hashes (before → after)

| File | Change | Before | After |
|---|---|---|---|
| `lib/queue/worker-slots.ts` | bounded acquire timeout + `ACQUIRE_TIMEOUT_MS` + timeout warn (F-P1-02) | `04B1A4FB1BBCFC42B43E68321CA84BECAF5F8D489AD4F0D0B14B1120AC1B223E` (WT-11 packet) | `521D24E33E86B60A913C960AEE56CC3B6416DF29E0F790DEACA52F8A9BAC15D5` |
| `tests/pipelines/worker-slots-fail-open.test.ts` | +3 F-P1-02 resilience tests (7 total) | `202B29F7F66D9CD69B03FFF9FA18FE07CE6FFBB69CB9BDA63644D123C1AC5C4B` (WT-11 packet) | `69775F608C78F41928628B5E3F13CE9EC1B02FC4A6F60CFE610938B8D21C937F` |

Cả hai file là lane file **untracked** trong legacy repo (như WT-11 receipt đã ghi), nên `git diff` không hiển thị; diff ở §1 là before/after theo hash + mô tả hunk.

## 4. Contract behavior sau fix

| Tình huống | Hành vi |
|---|---|
| Redis trả 1 / 0 | `'acquired'` / `'contended'` như cũ (không đổi) |
| Redis lỗi kết nối/từ chối | `'fail-open'` + warn (F-P1-01, không đổi) |
| Redis treo > `timeoutMs` (default 1500 ms) | **`'fail-open'` + warn `'timed out'`** (mới, F-P1-02) — worker không bị treo |
| EVAL trả muộn sau timeout | Outcome đã settle giữ `'fail-open'`; slot EVAL có thể đã chiếm được sẽ được **TTL reclaim**; caller không release |
| Call-site `worker.ts` | Không đổi — vẫn dùng 4 tham số; timeout default áp dụng |

## 5. Residual / findings (không sửa trong packet này)

| ID | Mức | Ghi chú |
|---|---|---|
| F-P1-03 | LOW | TTL residual cho single-holder job > TTL vẫn còn (env `WORKER_SLOT_TTL_SECONDS`); dispatch chỉ tham chiếu, không yêu cầu sửa. Timeout mới cũng dựa vào TTL để reclaim slot mà EVAL muộn có thể đã chiếm. |
| Release path | LOW (noted) | `releaseSlot` vẫn best-effort không bound (chỉ acquire được yêu cầu trong dispatch). Release chạy trong `finally`; nếu Redis treo hẳn có thể trì hoãn kết thúc job — ghi nhận để packet sau nếu cần. |
| F-WT-13 | HIGH (deployment) | `worker.js` bundle tracked vẫn chưa chứa semaphore; **không rebuild** trong packet này (release action + code freeze). |
| Pre-existing | INFO | `tests/pipelines/external-api.test.ts` fail-to-run (mammoth import) vẫn giữ `npm test -- tests/pipelines/` ở exit 1 — không liên quan packet này. |

## 6. Compliance

- Repo scope: legacy root `D:\Git\dugate` ONLY. Files sửa: `lib/queue/worker-slots.ts`,
  `tests/pipelines/worker-slots-fail-open.test.ts`; cộng receipt này + raw logs. Không ghi file `du-rework/` nào.
- **Không commit, không push, không tick, không rebuild bundle.**
