import json, os, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T14:20:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"


def orca_run(args, timeout=240):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}


w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

SPEC_PROGRESS = (
    "Your submit/idempotency/sync-wire receipt is SETTLED - I verified the key-only global idempotency lookup "
    "(lib/pipelines/submit.ts:142-145 + schema.ts:13 .unique()), the exact 200/202 ternary at "
    "lib/endpoints/runner.ts:256-257, the sync catch that reloads and still returns 200 (submit.ts:369-385), and "
    "your precision finding that the rework fast lookup filters expires_at (submission.ts:686) while the "
    "transactional recheck does not (submission.ts:271-274). All accurate. New read-only task, same scope: "
    "characterize the LEGACY PROGRESS AND STEP-TIMELINE WIRE - exactly what a client observes about progress "
    "while an operation runs - against the rework progress model. This feeds COMP-00 decision #3 "
    "(materialization bounds + progress), which is the next unblocked decision, and no receipt in "
    "du-rework/coordination/reports/ has done it end to end with file:line (comp05 flagged the rework side as "
    "SYNTHETIC but did not characterize the legacy timeline itself). Answer with file:line: "
    "(1) WRITE CONTRACT: engine.ts computes Math.round((i/pipeline.length)*100) per step and writes both the DB "
    "row and job.updateProgress (:285-297) - confirm the exact formula, the progressMessage text per step, and "
    "whether the write happens at step START or step END. State what is written on the terminal transition "
    "(:401-403 progressPercent: 100, progressMessage: null) and what the failure path writes instead. "
    "(2) SERIALIZATION: format.ts:27-28 passes progressPercent/progressMessage through verbatim - confirm, and "
    "state the FULL set of pipeline_step objects a client sees in metadata.pipeline_steps (names, status/state "
    "per step, any per-step index or duration field, and what an UNREACHED step looks like mid-run). "
    "(3) WAITING/PARALLEL STATES: for a workflow operation, what does progress look like while a step is "
    "WAITING_USER_INPUT (workflow-engine.ts:246-272 marks the parent PAUSED and sends a PAUSED webhook, :302 "
    "sets done = state===SUCCEEDED||FAILED so PAUSED is not done)? Does the Operation row keep RUNNING while "
    "the job is not executing? Is progressPercent frozen, and is there any code that advances it during a "
    "human wait? (4) RETRY VISIBILITY: when a job is retried (BullMQ attempts) or resumed from the recover-"
    "stalled route (app/api/internal/recover-stalled/route.ts:48-58), what does a client see in progress - does "
    "the percent go backwards, restart at 0, or stay? Cite the exact write. "
    "(5) REWORK COUNTERPART: with file:line, the rework side today - progress {percent, message} construction "
    "at modules/operations/facade.ts and modules/operations/submission.ts, the DEFAULT percent 0 that comp05 "
    "flagged (3 hits: submission.ts:715, facade.ts:45, app/admin/operation-section-data.ts:939), the compat "
    "adapter default at compat/legacy-action-router.ts:300-312, and the fact that runtime progress reports are "
    "DISCARDED in modules/runtime/runtime.ts:483-492. State plainly what rework can and cannot currently "
    "project per step, and whether a per-step timeline is derivable from any rework table (tasks, task_steps, "
    "checkpoints, outbox) - answer 'not found' rather than guessing. Do not propose any fix. "
    "HARD CHECKS: (1) characterization only - do NOT propose fixes, config changes, or new progress schemes; "
    "(2) every claim carries file:line; write 'not found' rather than guessing; (3) anything "
    "MUST-NOT-REPLICATE carries file:line and STOP; (4) standing security constraints apply to rework "
    "counterparts: operations tenant-fenced via resolveApiKey, encryption fail-closed no bypass, never fake "
    "terminal state CANCELLED while work is processing - if legacy writes a terminal or done-looking state "
    "while the runtime is still processing, label it MUST-NOT-REPLICATE with file:line; (5) do NOT restate "
    "balance, spend or cost numbers; (6) no gate ticks, no COMP row changes. Path reminder: legacy engine is "
    "lib/pipelines/engine.ts and lib/pipelines/format.ts at the REPO TOP LEVEL; rework is "
    "du-rework/services/orchestrator/src/**. Limits: READ-ONLY with source; write only your own new report "
    "file du-rework/coordination/reports/codex-legacy-progress-step-timeline-wire-2026-10-01.md; no source "
    "edits; no test runs; no commits."
)

s = orca_run(["terminal", "send", "--terminal",
              "term_2b05b203-549f-4428-b908-c303a2b187ec",
              "--text", SPEC_PROGRESS, "--enter", "--json"])
print("[SEND] ctx_task_legacy_progress_step_timeline -> ok=%s" % s.get("ok"), flush=True)
t = orca_run(["orchestration", "task-create", "--spec", SPEC_PROGRESS,
              "--task-title",
              "COMP-00 read-only: legacy progress + step-timeline wire (engine writes, format serialization, retry visibility) vs rework progress projection",
              "--display-name",
              "COMP-00 read-only: legacy progress + step-timeline wire vs rework progress projection",
              "--run", RUN, "--json"])
task = (t.get("result") or {}).get("task") or {}
tid = task.get("id")
print("[TASK-CREATE] -> ok=%s id=%s" % (t.get("ok"), tid), flush=True)

key = "ctx_task_legacy_progress_step_timeline"
if key not in disp:
    disp[key] = collections.OrderedDict()
e = disp[key]
e["taskId"] = tid
e["terminalHandle"] = "term_2b05b203-549f-4428-b908-c303a2b187ec"
e["lastObservedAt"] = NOW
e["lastProgressAt"] = NOW
e["transcriptCursor"] = ""
e["consecutiveUnfinishedChecks"] = 0
e["lastNudgeAt"] = None
e["blocker"] = None
e["status"] = "running"
e["receipt"] = None
e["supervised"] = True

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("watch-state total", len(disp), dict(c))
