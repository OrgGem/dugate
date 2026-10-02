import json, sys, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T14:52:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

key = "ctx_task_legacy_worker_runtime"
e = disp.get(key)
if e is None:
    print("MISSING", key)
else:
    e["status"] = "settled"
    e["receipt"] = (
        "du-rework/coordination/reports/codex-legacy-worker-runtime-lifecycle-2026-10-01.md | "
        "C4 VERIFIED against real code: (1) Two BullMQ workers, WORKER_CONCURRENCY default 5, "
        "SUBSTEP_WORKER_CONCURRENCY 2x (10 default), stalledInterval 30_000 + maxStalledCount 2 on both - "
        "confirmed worker.ts:32-34,62-84. (2) 'failed' handler when attemptsMade>=opts.attempts(fallback 3) "
        "emits a SECOND console.error tagged DLQ - LOG ONLY, no queue transfer; queue module defines only "
        "pipeline + workflow-steps with removeOnFail:false - confirmed worker.ts:93-107 + "
        "lib/queue/pipeline-queue.ts:15-16,27-35. (3) 'stalled' handler is a warn-only line, NO DB write - "
        "confirmed worker.ts:110-112. (4) THREE mechanisms correctly distinguished: BullMQ maxStalledCount=2 "
        "(per-Worker stalled counter, separate from attemptsMade, does NOT reset attemptsMade on requeue), "
        "queue attempts:3 + 5s base backoff, and the recover-stalled DB row-flip - all cited with file:line "
        "including bullmq node_modules internals. (5) Worker failed-listener does NOT touch Operation row; "
        "engine catch writes FAILED itself so caught errors don't consume retries - confirmed engine.ts:450-486. "
        "(6) MEMORY: threshold default 0.90, RESUME at threshold*0.85 = 0.765 (76.5%) NOT 75% - confirmed "
        "worker.ts:125,136-140; pause()/resume() called on BOTH Worker instances (not Queue objects), in-flight "
        "jobs drain to completion (BullMQ pause does not abort processors). CLAUDE.md's 'resumes at 75%' is "
        "WRONG per code - receipt states code value, correct behavior. (7) SHUTDOWN: SIGTERM/SIGINT -> shutdown "
        "closes pipelineWorker+stepsWorker via Promise.all then process.exit(0), NO timeout/force arg, Queue "
        "singletons not closed - confirmed worker.ts:146-154. (8) HITL: pauseWorkflow writes WAITING_USER_INPUT "
        "done:false + PAUSED webhook, does NOT re-enqueue; resume only via POST /api/v1/operations/{id}/resume "
        "(accepts WAITING_USER_INPUT -> RUNNING -> re-adds pipeline job) - confirmed workflow-engine.ts:246-272,295-304 "
        "+ resume/route.ts:31-33,83-98. (9) Rework counterpart accurate: sweepExpiredLeases lease_epoch bump / "
        "READY / LEASE_EXPIRED-terminal (NOT CANCELLED), epoch fencing LEASE_LOST, 5s recovery timer hooking both "
        "sweep + queue-integrity, queue health states OK/RECONSTRUCTING/SUSPECT - runtime.ts:1140-1243,77-100,60-67 + "
        "server.ts:686-690,890-903. Plainly stated: NO rework counterpart for heap-pause backpressure or "
        "maxStalledCount; NO legacy counterpart for epoch fencing / LEASE_EXPIRED / queue-integrity states. "
        "MUST-NOT-REPLICATE correctly labeled: recover-stalled terminalizes old RUNNING rows by createdAt age "
        "with NO active-job check (recover-stalled/route.ts:33-58) - still-processing op can be marked FAILED. "
        "All claims file:line, no fixes proposed, no gate ticks."
    )
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("watch-state total", len(disp), dict(c))
