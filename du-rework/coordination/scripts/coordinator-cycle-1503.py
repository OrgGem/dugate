import json, sys, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:03:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

key = "ctx_task_legacy_progress_step_timeline"
e = disp.get(key)
if e is None:
    print("MISSING", key)
else:
    e["status"] = "settled"
    e["receipt"] = (
        "du-rework/coordination/reports/codex-legacy-progress-step-timeline-wire-2026-10-01.md | "
        "C4 VERIFIED against real code (verified prior cycle, settled when terminal reached prompt): "
        "(1) LEGACY WRITE CONTRACT: per-step START marker Math.round((i/pipeline.length)*100) + message "
        "'Dang xu ly buoc i+1/N: processor...', written to Operation row (currentStep/progressPercent/"
        "progressMessage) BEFORE calling the processor, then job.updateProgress(same number) - confirmed "
        "engine.ts:281-297 (I read :281-297 live). Percent does NOT advance on step completion; only jumps "
        "to 100 on SUCCEEDED (progressPercent:100, progressMessage:null, engine.ts:397-403). Failure path "
        "writes done:FAILED + failedAtStep but does NOT set progressPercent - it retains the last earlier "
        "value (engine.ts:450-465). (2) SERIALIZATION: format.ts:17-32 passes progressPercent/progressMessage "
        "verbatim into metadata.progress_percent/progress_message and parses stepsResultJson into "
        "metadata.pipeline_steps; it does NOT synthesize a placeholder per planned step - so metadata."
        "pipeline_steps contains ONLY steps whose processor returned (engine.ts:358-394,365-373; no status/"
        "duration/start/end fields on step objects). Rework has NO per-step timeline: runtime.reportProgress "
        "checks lease_epoch then does a second SELECT id FROM tasks and VOIDS it, never persisting "
        "body.percent/message (runtime.ts:483-492) - confirmed. (3) HUMAN WAIT: pauseWorkflow writes "
        "WAITING_USER_INPUT done:false and does NOT write progressPercent - the row does NOT stay RUNNING; "
        "percent freezes at the last updateProgress value; PAUSED webhook done=false since done is only "
        "SUCCEEDED||FAILED (workflow-engine.ts:246-272,295-304). Resume route sets RUNNING without touching "
        "percent (resume/route.ts:83-96). (4) RETRY VISIBILITY: engine reads operation.currentStep, skips "
        "completed indices, re-writes the SAME start formula for the resumed index - does NOT reset to 0 "
        "unless index is 0 (engine.ts:226-249,281-297). (5) Rework progress defaults to 0 in THREE places - "
        "facade.ts:45, submission.ts:715, app/admin/operation-section-data.ts:930-939 (confirmed) - plus compat "
        "adapter default legacy-action-router.ts:292-312. Public operation GET is tenant-fenced via "
        "getTenantOperation(id,tenantId) after resolveApiKey (server.ts:1813-1840). Per-step timeline on rework "
        "= NOT FOUND (no task_steps table; step_checkpoints has no step index/start/end/duration, 0001:70-110). "
        "MUST-NOT-REPLICATE x2 verified against real code: recover-stalled terminalizes old RUNNING rows with no "
        "active-job check (recover-stalled/route.ts:33-58) AND public cancel sets done:TRUE/state:CANCELLED "
        "while the BullMQ job keeps running (operations/[id]/cancel/route.ts:37-44 - I read this live; sets "
        "done: true, state: 'CANCELLED', progressMessage: null with no job cancel). All claims file:line, "
        "feeds COMP-05a + COMP-00 decision #3 (materialization bounds/progress). No fixes proposed, no gates."
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
