# MASTER DISPATCH — IMPLEMENTATION & VERIFICATION OF FAIR-SHARE WORKER & PER-ENDPOINT RATE LIMITING

- Date: 2026-10-06 23:52 +07:00
- Coordinator: Antigravity (`64123580`)
- Architectural Source: `C:\Users\Gem\.claude\plans\elegant-snacking-feather.md` (Approved by User & Architecture Agent)
- Technical Findings: BullMQ 5.73.4 Delayed Pattern (`moveToDelayed` + `throw new DelayedError()`) verified by Claude Code (`84d0106e`).
- CWD: `D:\Git\dugate`
- Constraints: Strict TypeScript, no `any`, test before and after, verify fail-open & graceful degradation.

---

## 1. PHÂN CHIA GÓI CÔNG VIỆC (TASK PACKETS)

### PACKET P1 [Core Worker] — Worker Slot Semaphore & BullMQ Delayed Pattern
- **Assignee:** `oc_1` (Worker & Concurrency Integrator) / `codex_builder`
- **File Lease:** `worker.ts`
- **Reference Files:** `lib/queue/worker-slots.ts`, `lib/queue/pipeline-queue.ts`, `lib/config.ts`
- **Scope & Implementation:**
  1. Import `tryAcquireSlot`, `releaseSlot` từ `lib/queue/worker-slots.ts`.
  2. Import `DelayedError` từ `bullmq`.
  3. Import `MAX_CONCURRENT_PER_PROFILE_ENDPOINT` từ `lib/config.ts`.
  4. Trong `processJob(job: Job<PipelineJobData>)`:
     - Kiểm tra nếu là sub-step queue (`WORKFLOW_STEPS_QUEUE_NAME`) hoặc job type `workflow`: **BỎ QUA semaphore** (tránh deadlock cha-con).
     - Với top-level pipeline job có `apiKeyId` và `endpointSlug`:
       - Resolve `cap = (job.data.maxConcurrent !== null && job.data.maxConcurrent !== undefined && job.data.maxConcurrent > 0) ? job.data.maxConcurrent : MAX_CONCURRENT_PER_PROFILE_ENDPOINT`.
       - `ttlSec = Math.ceil(SYNC_TIMEOUT_MS / 1000) + 60` (hoặc timeout phù hợp, tối thiểu 120s).
       - Gọi `await tryAcquireSlot(apiKeyId, endpointSlug, cap, ttlSec)`.
       - Nếu không acquire được slot (contention):
         - Delay timestamp: `Date.now() + 4000 + Math.floor(Math.random() * 2000)`.
         - Gọi `await job.moveToDelayed(delayTime, job.token)`.
         - **Bắt buộc:** `throw new DelayedError()` để worker delay job an toàn mà không bị coi là completed hoặc tốn retry attempts.
       - Nếu acquire thành công: Thực thi `runPipeline` bên trong khối `try ... finally { await releaseSlot(apiKeyId, endpointSlug); }`.
  5. **Acceptance:** Typecheck clean, không lỗi runtime BullMQ.

---

### PACKET P2 [Admin Control Plane & UI] — Profile-Endpoints API Validation & Profiles Page
- **Assignee:** `oc_4` (Admin Web & API Integrator) / `qwen_5`
- **File Lease:** 
  - `app/api/internal/profile-endpoints/route.ts`
  - `app/profiles/page.tsx`
- **Scope & Implementation:**
  1. **Route `app/api/internal/profile-endpoints/route.ts`:**
     - **GET:** Bổ sung `rateLimitPerMin: dbRecord?.rateLimitPerMin ?? null` và `maxConcurrent: dbRecord?.maxConcurrent ?? null` vào `enrichedEndpoints` (dòng ~95).
     - **POST (Admin Branch):**
       - Lấy `rateLimitPerMin` và `maxConcurrent` từ request body.
       - Validate: `null`/`undefined` = null. Nếu truyền vào, phải là số nguyên ≥ 0 (`Number.isInteger(v) && v >= 0`). Từ chối float/string/số âm với HTTP 400.
       - Upper-bound sanity check: `rateLimitPerMin <= 10000`, `maxConcurrent <= 20` (HTTP 400 nếu vượt).
       - Đưa vào `payload`:
         - `rateLimitPerMin: rateLimitPerMin !== undefined ? (rateLimitPerMin === null || rateLimitPerMin === 0 ? null : rateLimitPerMin) : undefined`
         - `maxConcurrent: maxConcurrent !== undefined ? (maxConcurrent === null || maxConcurrent === 0 ? null : maxConcurrent) : undefined`
  2. **Page `app/profiles/page.tsx`:**
     - Trong `ProfileEndpointCard`: Thêm state `rateLimitPerMin`, `maxConcurrent`.
     - Seed state từ `endpoint.rateLimitPerMin` và `endpoint.maxConcurrent`.
     - Thêm 2 input number trong phần cấu hình Admin của endpoint card:
       - **Rate Limit (req/min):** Placeholder `100 (Default)`. Nhập 0 hoặc để trống = dùng default.
       - **Max Concurrent Slots:** Placeholder `2 (Default)`. Nhập 0 hoặc để trống = dùng default (2 slots).
     - Truyền 2 giá trị này vào payload của `saveSettings()`.
  3. **Acceptance:** `pnpm run lint` hoặc typecheck sạch, UI hiển thị trực quan và lưu trữ chuẩn xác.

---

### PACKET P3 [Testing & Verification Suites] — Unit Tests, Concurrency & E2E Verification
- **Assignee:** `oc_2` & `oc_3` (Verification Specialists) / `qwen_2`
- **File Lease:** 
  - `tests/pipelines/fair-share-worker.test.ts` (mới)
  - `tests/pipelines/endpoint-rate-limit.test.ts` (mới)
- **Scope & Implementation:**
  1. **Unit Test Endpoint Rate Limiting (`tests/pipelines/endpoint-rate-limit.test.ts`):**
     - Test request thứ `limit + 1` trong 60s bị chặn 429 với headers `Retry-After` và `X-RateLimit-Remaining: 0`.
     - Test `rateLimitPerMin = 0` hoặc `null` fallback về default global (100 req/min).
     - Test browser session không có `apiKeyId` fallback sang rate theo IP (30 req/min).
  2. **Unit Test Worker Slot Semaphore (`tests/pipelines/fair-share-worker.test.ts`):**
     - Test atomic Lua `tryAcquireSlot`: cap = 2, acquire 2 lần thành công, lần thứ 3 trả về `false`.
     - Test `releaseSlot`: sau khi release, acquire lại trả về `true`.
     - Test guard chống drift âm: gọi `releaseSlot` nhiều lần không làm giá trị Redis < 0.
     - Test BullMQ job delay: giả lập contention, verify `job.moveToDelayed` và `DelayedError`.
  3. **Regression & Dev Migration Run:**
     - Chạy `npm test` toàn bộ regression của dugate.
  4. **Acceptance:** 100% tests pass exit code 0.

---

## 2. NỘI QUY BÁO CÁO & RECEIPTS

- Mỗi Assignee sau khi hoàn tất packet phải ghi lại receipt chi tiết:
  - Packet P1: `coordination/reports/receipt-p1-worker-semaphore-2026-10-06.md`
  - Packet P2: `coordination/reports/receipt-p2-admin-ui-rate-limit-2026-10-06.md`
  - Packet P3: `coordination/reports/receipt-p3-fair-share-verification-2026-10-06.md`
- Báo cáo gồm: Các file đã sửa, git diff summary, raw test output, exit code literal.
- **Không tự ý commit hoặc push git** nếu chưa có lệnh release từ Coordinator.
