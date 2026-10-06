# Receipt P1 — Worker semaphore & fair-share concurrency — 2026-10-06

- **Packet:** P1 (dispatch to OpenCode 1 / `term_cefb27a0`). **Write lease: `worker.ts` only** (repo `D:\Git\dugate`).
- **Constraints honored:** no commit, no push; no file outside the lease edited.
- **Status:** IMPLEMENTED + `npx tsc --noEmit` exit 0. Runtime/Redis behavior not exercised here (no test file in
  lease, no live Redis window) — routed to the independent tester per plan §Verify 3. **Finalized 2026-10-07 — see
  the closure addendum (§6).**

## 1. Dependency state (read-only verification, landed by parallel lanes)

| Dependency | State | Evidence |
|---|---|---|
| `lib/queue/worker-slots.ts` | Present (untracked): `tryAcquireSlot(apiKeyId, endpointSlug, cap, ttlSec)` (Lua INCR+EXPIRE+cap-check, Redis error → returns `true` = fail-open) and `releaseSlot(...)` (guarded DECR) | `lib/queue/worker-slots.ts:35-87` |
| `PipelineJobData` fair-share fields | `apiKeyId?`, `endpointSlug?`, `maxConcurrent?: number \| null` already declared | `lib/queue/pipeline-queue.ts:90-94` |
| Default cap constant | `MAX_CONCURRENT_PER_PROFILE_ENDPOINT` (env override, default 2; invariant comment cap < global concurrency) | `lib/config.ts:33-35` |
| Producer threading | Runner resolves `apiKeyId`/`endpointSlug` and passes `maxConcurrent` from the loaded ProfileEndpoint; submit writes them into `jobData` only when both ids exist; workflow jobs also carry the ids (worker skips them by `type`) | `lib/endpoints/runner.ts:278-293`, `lib/pipelines/submit.ts:351-362` |
| BullMQ API | 5.73.4: `moveToDelayed(timestamp, token?)` and `DelayedError` both available | `node_modules/bullmq/dist/esm/classes/job.d.ts`, `.../errors/delayed-error.d.ts` |

No changes were needed (or made) outside `worker.ts` for the wiring.

## 2. Changes in `worker.ts` (only file touched)

| Dispatch rule | Implementation |
|---|---|
| Import semaphore + default cap | `import { tryAcquireSlot, releaseSlot } from './lib/queue/worker-slots'`, `import { MAX_CONCURRENT_PER_PROFILE_ENDPOINT } from './lib/config'`, `DelayedError` added to the bullmq import (L19-30) |
| Top-level pipeline job with `apiKeyId` + `endpointSlug` acquires before running | `slotKey` computed only when `semaphoreEnabled && !isWorkflow && apiKeyId && endpointSlug` (L68-70); cap = positive-integer `maxConcurrent` else `MAX_CONCURRENT_PER_PROFILE_ENDPOINT` (L73-75); `acquired = await tryAcquireSlot(..., SLOT_TTL_SECONDS)` (L76) |
| Workflow jobs + workflow-steps sub-jobs SKIP the semaphore | Pipeline worker processor → `processJob(job, true)` (L108), steps worker → `processJob(job, false)` (L121); workflow top-level additionally skipped by `isWorkflow = type === 'workflow' \|\| job.name.includes('workflows:')` (L61). Legacy/internal jobs without both ids also run unslotted |
| Contention → re-delay without consuming an attempt | `await job.moveToDelayed(Date.now() + delayMs, job.token)` then `throw new DelayedError()` (L77-86); `delayMs = 4000 + floor(random()*2000)` (L41-42, L80) |
| `releaseSlot` when acquired | `try { runWorkflow/runPipeline } finally { if (acquired && slotKey) await releaseSlot(...) }` (L89-99) — release also runs when the pipeline throws |
| Crash-safe slot reclaim | `SLOT_TTL_SECONDS` (default 900, env `WORKER_SLOT_TTL_SECONDS`) passed to acquire (L43-46) |

Hashes: HEAD `worker.ts` **`EEED21A10FEDF997DE199753C44A39B1D42E7D63A753A8328A82615EF6E63574`** →
working tree **`F09F9AC80AC2626A992BA9897EF4199A277464676C93B7A83B2E979E542391E9`** (`git diff --numstat`: +53/−9).

## 3. Verification evidence

| Check | Command (cwd `D:\Git\dugate`) | Exit | Result | Raw |
|---|---|---|---|---|
| Typecheck | `npx tsc --noEmit` | **0** | zero diagnostics (empty log); `tsconfig.json` includes `**/*.ts` (excludes node_modules, du-rework) so `worker.ts` is covered | `coordination/reports/raw/p1-worker-semaphore/typecheck.log` (empty file, SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` = zero diagnostics) |
| Original file snapshot | `git show HEAD:worker.ts` | 0 | `raw/p1-worker-semaphore/worker.ts.head` (`EEED21A1…`) | as above |

Scope check: `git status --porcelain -- worker.ts` → ` M worker.ts` only; other dirty paths in the tree
(`lib/config.ts`, `lib/db/schema.ts`, `lib/endpoints/runner.ts`, `lib/queue/pipeline-queue.ts`,
`lib/queue/worker-slots.ts` untracked) belong to parallel lanes and were not touched.

## 4. Findings (outside lease — owner actions)

| ID | Severity | Finding |
|---|---|---|
| F-P1-01 | MEDIUM | Fail-open + release drift: on a Redis error `tryAcquireSlot` returns `true` **without** INCR (worker-slots.ts:66-69), but the worker treats it as acquired and its `finally` calls `releaseSlot`, whose guarded DECR (`:76-83`) will decrement an existing key owned by other holders → undercount/over-admission for that (apiKey, endpoint). Fix belongs to `worker-slots.ts` (richer result or per-acquisition-safe release). |
| F-P1-02 | MEDIUM | The semaphore connection uses `createRedisConnection()` (`maxRetriesPerRequest: null`, redis.ts), so during an outage the `eval` may wait in the offline queue instead of failing fast — "fail-open" may not trigger promptly and the job can block. Owner: worker-slots/redis. A bounded timeout in the acquire path would make fail-open real. |
| F-P1-03 | LOW | No per-job timeout is configured for pipeline jobs, so `SLOT_TTL_SECONDS` defaults to 900 s. A legitimate run > TTL can have its slot reclaimed mid-flight (over-admission window); after a crash the slot lingers up to TTL. Env override exists (`WORKER_SLOT_TTL_SECONDS`); a real pipeline timeout would let TTL derive from it. |
| F-P1-04 | INFO | Sync mode + contention: a delayed job may exceed `SYNC_TIMEOUT_MS`; the client then gets the existing reload/warn path (operation not yet finished), not a 500 — matches the plan's documented behavior. |

## 5. Remaining verification (not in this lease)

Plan §Verify 3 (Redis-backed): cap=1 with two same-key jobs → 1 runs + 1 delayed; release lets job 2 run; TTL reclaims
a crashed worker's slot; Redis outage → fail-open; plus plan §Verify 5 e2e fair-share observation. These need a test
file / live Redis window and an independent owner. No commit, no push, no task-row tick performed.

## 6. Closure addendum — 2026-10-07

**6.1 Re-verification of this packet's deliverable (unchanged since §2)**

| Check | Result | Raw |
|---|---|---|
| `worker.ts` SHA-256 | `F09F9AC80AC2626A992BA9897EF4199A277464676C93B7A83B2E979E542391E9` (same as §2; no other lane modified it) | — |
| `git diff --numstat -- worker.ts` | `53 9 worker.ts` (unchanged) | — |
| `npx tsc --noEmit` (fresh, 2026-10-07) | **exit 0**, zero diagnostics | `coordination/reports/raw/p1-worker-semaphore/typecheck-2026-10-07.log` (empty, SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`) |

**6.2 Independent-verification cross-references (later receipts)**

- `coordination/reports/receipt-p3-fair-share-verification-2026-10-06.md` (oc_2): `worker-slots.test.ts` 13 tests +
  `profile-endpoint-limits.test.ts` 13 tests → **26/26 green**; bonus live-Redis probe of the exact Lua scripts
  **8/8** (cap rollback, TTL on first INCR, guarded DECR walking 2→1→0, release after expiry); runnable legacy unit
  regression **177/177 green**. Scope boundary: P3 verifies the semaphore primitive and the producer-side
  normalization — it does **not** run the BullMQ cap=1/two-job wiring of `worker.ts`, so plan §Verify 3/5 (runtime
  fair-share on live Redis) remains open for an independent tester.
- `coordination/reports/receipt-fair-share-worker-packets-2026-10-06.md` (coordinator master, 23:54) lists P1 as
  implemented; it predates the fuller P3 run (00:26), so this receipt + the P3 receipt are the authoritative pair for
  P1 scope.
- `coordination/reports/wt-legacy-fairshare-findings-2026-10-07.md`: **WT-10 (worker-slots dead code) is resolved by
  this packet** — call-sites at `worker.ts:29-30, 75-76, 97` (this receipt's §2). **WT-11 + F-P1-01 remain open** and
  are routed to the legacy-lane owner for `lib/queue/worker-slots.ts` (refresh `EXPIRE` on every successful acquire;
  distinguishable fail-open result so the worker never releases a slot it does not own; `warn` logging via
  `lib/logger.ts`). They are outside the P1 lease (`worker.ts` only) and are not fixed here.

**6.3 Final status of P1:** code-complete and typecheck-verified in the lease; runtime BullMQ wiring test pending the
independent tester. No commit, no push, no task-row tick. If the coordinator closes WT-11/F-P1-01 in
`worker-slots.ts`, no change to `worker.ts` is expected (the worker consumes the existing
`tryAcquireSlot`/`releaseSlot` contract).
