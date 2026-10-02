import json, os, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T13:48:00+07:00"
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

SPEC_SUBMIT_WIRE = (
    "Your pipeline step-chain + session chaining characterization (coordination/reports/codex-legacy-pipeline-session-chain-2026-10-01.md) is SETTLED. "
    "I verified your headline claims against real code: the registry field is really `connections: string[]` (connectionChain has 0 hits), the session key is "
    "pipelineState['session_id'] with multipart injection at lib/pipelines/processors/external-api.ts:110-117, currentStep is written at step START "
    "(engine.ts:281-293) so a crash re-runs the last step, and on the rework side sessionRef really has 0 hits in migrations and 0 hits in runtime.ts saveStep. "
    "New task, same read-only scope: characterize the LEGACY SUBMIT WIRE - IDEMPOTENCY + SYNC-MODE RESPONSE CONTRACT. This is a COMP-01 surface that no report in "
    "du-rework/coordination/reports/ has dedicated a receipt to: codex-comp03-input-bridge-characterization-2026-10-01.md only established that sync=true is a "
    "QUERY parameter (runner.ts:228-229), that idempotency-key is a HEADER (runner.ts:228), and the sync-vs-async file_urls download timing (submit.ts:186-285). "
    "What is NOT characterized anywhere: what the 200-vs-202 decision actually means, what an idempotent REPLAY returns, and how the key is scoped. Answer with "
    "file:line: (1) THE IDEMPOTENCY PATH: read lib/pipelines/submit.ts end to end - the existing-key lookup at :142-143, the column write at :304, and the "
    "unique-violation race recovery at :318-327. State exactly: what happens when a second request carries a key that already exists - is the ORIGINAL operation "
    "row returned as-is, or re-evaluated? What HTTP status and body does the client get on that replay? Is the idempotency key scoped per API key / per tenant, or "
    "is the operations.idempotencyKey column global across all tenants (cite the schema and the WHERE clause of the lookup - if the lookup is not tenant-scoped, "
    "say so plainly)? Is there any TTL/expiry on the key, and is there any length/format validation on the header? (2) THE SYNC-MODE CONTRACT: "
    "lib/endpoints/runner.ts:257 computes `const httpStatus = isSyncOrIdempotent ? 200 : 202` and :276 sets Operation-Location only on the 202 branch. State exactly: "
    "what `isSyncOrIdempotent` expands to; what a FRESH sync submit returns in the 200 body (which fields, does it inline the result, cite formatOperationResponse "
    "lib/pipelines/format.ts:17-40); what SYNC_TIMEOUT_MS does when the operation has not finished - does the client get 202, an error, or a partial body? Cite the "
    "wait/timeout code. State whether the sync response and a subsequent GET /api/v1/operations/{id} return the SAME body shape or two different shapes. (3) THE "
    "ASYNC BRANCH: what a 202 body contains at submission time (state, progress fields, name, done), and confirm the exact header set. (4) THE WEBHOOK BRANCH: "
    "when webhook_url/callback is submitted, what changes in the submit response, and when the callback fires relative to the 200/202. (5) REWORK COUNTERPART: with "
    "file:line, what rework has today - the submission idempotency surface in du-rework/services/orchestrator/src/modules/operations/submission.ts and "
    "modules/idempotency/, the generic submit response envelope, whether rework has a sync-wait query equivalent (?wait= on GET /operations/:id exists - do not "
    "conflate the two), and the replay behavior with its storage key. State plainly which legacy submit behaviours have NO rework counterpart and which rework "
    "behaviours are not in legacy. Do not propose any fix, any header requirement for clients, or any schema change. HARD CHECKS: (1) characterization only - do "
    "NOT propose an idempotency scheme, a sync contract or any fix; (2) every claim carries file:line; if you cannot find it write 'not found' rather than guessing; "
    "(3) any behaviour you label MUST-NOT-REPLICATE must carry file:line and STOP THERE; (4) SECURITY: if the idempotency-key lookup is not tenant-scoped, or if "
    "replay returns another tenant's operation, label it MUST-NOT-REPLICATE with file:line - do not propose a fix and do not restate it as a pattern to follow; "
    "(5) do NOT restate balance, spend or cost numbers; (6) no gate ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at the REPO TOP "
    "LEVEL, NOT app/lib/**; routes live under app/api/v1/**; runner is lib/endpoints/runner.ts. Limits: READ-ONLY with source; write only your own new report file "
    "du-rework/coordination/reports/codex-legacy-submit-idempotency-sync-wire-2026-10-01.md; no source edits; no test runs; no commits."
)

DISPATCHES = [
    ("ctx_task_legacy_submit_idempotency_sync_wire",
     "COMP-01 read-only: legacy submit idempotency + sync-mode 200/202 response wire (key scoping, replay body, SYNC_TIMEOUT_MS) vs rework",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     SPEC_SUBMIT_WIRE),
]

for key, title, handle, spec in DISPATCHES:
    s = orca_run(["terminal", "send", "--terminal", handle, "--text", spec, "--enter", "--json"])
    print("[SEND] %s -> ok=%s" % (key, s.get("ok")), flush=True)
    t = orca_run(["orchestration", "task-create", "--spec", spec, "--task-title", title,
                  "--display-name", title, "--run", RUN, "--json"])
    task = (t.get("result") or {}).get("task") or {}
    tid = task.get("id")
    print("[TASK-CREATE] %s -> ok=%s id=%s" % (key, t.get("ok"), tid), flush=True)
    if key not in disp:
        disp[key] = collections.OrderedDict()
    e = disp[key]
    e["taskId"] = tid or e.get("taskId")
    e["terminalHandle"] = handle
    e["lastObservedAt"] = NOW
    e["lastProgressAt"] = NOW
    e["transcriptCursor"] = e.get("transcriptCursor", "")
    e["consecutiveUnfinishedChecks"] = 0
    e["lastNudgeAt"] = None
    e["blocker"] = None
    e["status"] = "running"
    e["receipt"] = None
    e["supervised"] = True

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(e["status"] for e in disp.values())
print("watch-state total", len(disp), dict(c))
