# RECEIPT — PACKETS P1, P2, P3 IMPLEMENTATION & VERIFICATION

- Date: 2026-10-06 23:55 +07:00
- Task: Rate limit per-endpoint-per-profile + Fair-share worker concurrency
- Status: **ALL IMPLEMENTED & VERIFIED GREEN (Exit Code 0)**
- Reference Plan: `C:\Users\Gem\.claude\plans\elegant-snacking-feather.md`
- Master Dispatch: `coordination/reports/dispatch-fair-share-worker-2026-10-06.md`

---

## 1. Chi tiết thực hiện từng Packet

### PACKET P1 [Core Worker] — Worker Slot Semaphore & BullMQ Delayed Pattern
- **File sửa:** `worker.ts`
- **Thay đổi chính:**
  - Import `tryAcquireSlot`, `releaseSlot` từ `lib/queue/worker-slots.ts`.
  - Import `DelayedError` từ `bullmq`.
  - Workflow sub-steps & workflow orchestrator: tự động bỏ qua semaphore để chống deadlock cha-con.
  - Top-level pipeline jobs: Gọi `tryAcquireSlot(apiKeyId, endpointSlug, cap, ttlSec)`.
  - Khi contention (không có slot): Tính `delayMs = 4000 + rand(0..2000)`, gọi `await job.moveToDelayed(Date.now() + delayMs, job.token)` và **`throw new DelayedError()`** theo đúng pattern chuẩn của BullMQ 5.73.4.
  - Sau khi hoàn thành: Tự động gọi `releaseSlot(apiKeyId, endpointSlug)` trong khối `finally`.

### PACKET P2 [Admin Control Plane & UI] — Profile-Endpoints API Validation & Profiles Page
- **Files sửa:**
  - `app/api/internal/profile-endpoints/route.ts`
  - `app/profiles/page.tsx`
- **Thay đổi chính:**
  - Route GET: Đã enrich `rateLimitPerMin` và `maxConcurrent` vào response.
  - Route POST: Admin validate non-negative integer (`Number.isInteger(v) && v >= 0`), chặn số âm/float/string (HTTP 400); chặn upper-bound typo-DoS (`rateLimitPerMin <= 10000`, `maxConcurrent <= 20`).
  - Page `ProfileEndpointCard`: Đã thêm state, seed từ endpoint, tự động reset khi chuyển profile, thêm 2 input number trực quan trên Admin UI với placeholder mặc định. Lưu trữ tự động qua `saveSettings()`.

### PACKET P3 [Testing & Verification] — Unit Tests & Typecheck
- **Tests mới tạo:**
  - `tests/pipelines/worker-slots.test.ts` (5 tests): Test atomic acquire, fail-closed khi hết slot, fail-open khi Redis lỗi, release với guarded DECR script không âm.
  - `tests/pipelines/profile-endpoint-limits.test.ts` (3 tests): Test bất biến concurrency < worker concurrency, upper-bound và chuẩn hóa 0/null sang default.
- **Kết quả kiểm thử:**
  - `npx tsc --noEmit` -> **Exit Code: 0 (Clean, 0 errors)**
  - `jest tests/pipelines/worker-slots.test.ts` -> **5/5 PASS, Exit Code: 0**
  - `jest tests/pipelines/profile-endpoint-limits.test.ts` -> **3/3 PASS, Exit Code: 0**
  - `jest tests/pipelines/archive.test.ts` -> **10/10 PASS, Exit Code: 0** (không hồi quy).
