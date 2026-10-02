import json, os, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T14:15:00+07:00"
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

# ---- C2: settle 3 verified receipts ----
SETTLE = {
    "ctx_task_apikey_user_admin_journeys": (
        "du-rework/coordination/reports/codex-legacy-apikey-user-admin-journeys-2026-10-01.md | "
        "C4 VERIFIED against real code: (1) PUT /api/internal/apikeys note-branch uses UNPROJECTED "
        ".returning() so the response row contains keyHash/status/spendingLimit/totalUsed - confirmed at "
        "app/api/internal/apikeys/route.ts:59-61; GET projects only id/name/status/note (:22-27). "
        "(2) /api/internal/auth-key rate-limit key is derived from the first 16 chars of the caller-supplied "
        "x-api-key header - confirmed auth-key/route.ts:15-17 (MUST-NOT-REPLICATE, correctly labeled). "
        "(3) workflows multipart fallback to earliest ADMIN-key - confirmed docs/workflows/route.ts:74-85 "
        "(MUST-NOT-REPLICATE). (4) POST /api/internal/ext-connections/[id]/test has NO session/role guard in "
        "the handler - confirmed by reading the full file (starts with db.select, no requireAuth/requireAdmin) "
        "+ /api/internal in middleware BYPASS; receipt phrasing accurate. (5) profile-endpoints GET decrypt "
        "failure falls back to parsing stored value as plain JSON - confirmed route.ts:53-57 "
        "(MUST-NOT-REPLICATE plaintext fallback, correctly labeled). (6) runner raw-key lookup has no "
        "status predicate (active-check lives only in /auth-key) - confirmed runner.ts:98-99. "
        "(7) requireProfileAccess: ADMIN full access, non-admin needs assignment, no VIEWER distinction - "
        "confirmed auth-guard.ts:45-70. §5 classify table present with ORCH-PAR plan citations + file:line; "
        "post-cutover assignments explicitly NOT retirement approval - correct framing. "
        "Rework counterparts (tenant-scoped hash resolve ACTIVE-only, Vault write-only secrets, OIDC role map) "
        "consistent with prior receipts."
    ),
    "ctx_task_connector_profile_admin_journeys": (
        "du-rework/coordination/reports/codex-legacy-connector-profile-admin-journeys-2026-10-01.md | "
        "C4 VERIFIED against real code: (1) ExternalApiConnection.authSecret persisted PLAINTEXT - confirmed "
        "ext-connections/route.ts:101 (authSecret: authSecret?.trim() ?? ''), response mask is projection "
        "only (:114-120), schema.ts:72-82 plain text column - MUST-NOT-REPLICATE correctly labeled. "
        "(2) Receipt correctly separates crypto.ts policy from that path: key = ENCRYPTION_KEY ?? "
        "NEXTAUTH_SECRET via SHA-256, throws if neither set, GCM tag validated, helper has NO plaintext "
        "fallback - confirmed crypto.ts:14-20; the legacy plain-JSON branch lives in the CALLER "
        "(profile-endpoints/route.ts:53-57) not inside the helper - precise attribution, verified. "
        "(3) Prompt precedence _prompt > ExternalApiOverride.promptOverride > connection.defaultPrompt - "
        "confirmed prompt-resolver.ts:29-35. (4) parseConnectionSteps: nonempty override replaces registry "
        "connections; legacy string[] and new ConnectionStep[] both handled; invalid JSON -> caller fallback "
        "- confirmed profile-resolver.ts:128-141. (5) ProfileEndpoint columns parameters/connectionsOverride "
        "(plural, no lockedParams column) - consistent with schema.ts:120-137 read earlier. "
        "(6) Caller-selected apiKeyId + admin-key fallback + synthesized x-api-key-id ALL labeled "
        "MUST-NOT-REPLICATE with file:line, and boundary noted that middleware strips x-api-key-id on "
        "ordinary /api/v1 routes - matches the standing security constraint. (7) Pipeline submit/engine "
        "state=ENABLED gate confirmed as runtime enablement, not a lifecycle machine. "
        "§6 classify table present (3 cutover-required, UI post-cutover) with ORCH-PAR citations. "
        "Rework side claims (runtime promptRevisions constructed as {} at runtime.ts:1573-1578; profile "
        "bindings store only slot pins) consistent with prior receipts."
    ),
    "ctx_task_legacy_submit_idempotency_sync_wire": (
        "du-rework/coordination/reports/codex-legacy-submit-idempotency-sync-wire-2026-10-01.md | "
        "C4 VERIFIED against real code: (1) Idempotency lookup is KEY-ONLY with no tenant/apiKey predicate - "
        "confirmed submit.ts:142-145; column is globally unique (schema.ts:13 .unique() single column); "
        "MUST-NOT-REPLICATE labeled correctly, no fix proposed (per constraint). (2) Replay returns the "
        "original row via the same formatOperationResponse, status 200, no replay marker, no sync wait - "
        "confirmed runner.ts:256-257 (isSyncOrIdempotent = result.isIdempotent || executeSync) + "
        "submit.ts:141-147 exits before the sync block. (3) Fresh sync: enqueue + waitUntilFinished("
        "SYNC_TIMEOUT_MS); on timeout/failure catch logs and RETURNS THE RELOADED ROW with status still 200 - "
        "confirmed submit.ts:369-385; default 30s via config. (4) Operation-Location only on 202 branch - "
        "confirmed runner.ts:272-277. (5) Rework public submit: scope (tenant, api_key_id, route_action, key) "
        "+ canonical request hash; different-hash replay -> 409 IDEMPOTENCY_CONFLICT; same-hash -> 200 with "
        "replayed:true; fresh -> 202 - confirmed submission.ts:202-229 + server.ts:1752-1761. "
        "(6) PRECISION FINDING verified: fast lookup filters expires_at > now() (submission.ts:686) but the "
        "transactional recheck does NOT (submission.ts:271-274) - an expired-but-unpurged row can still "
        "replay/conflict; receipt states this accurately as observation, no fix proposed. "
        "(7) Rework has no POST sync-wait; GET ?wait= is a separate long-poll - correctly NOT conflated. "
        "(8) Two idempotency surfaces correctly separated: public submission_keys vs admin modules/idempotency "
        "(8-200 printable ASCII, stored response body). Spec did not propose any new sync/idempotency scheme - "
        "constraint honored."
    ),
}

for key, receipt in SETTLE.items():
    e = disp.get(key)
    if e is None:
        print("MISSING", key)
        continue
    e["status"] = "settled"
    e["receipt"] = receipt
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key)

# ---- C3: dispatch worker-runtime characterization (genuinely uncovered) ----
SPEC_WORKER_RUNTIME = (
    "Your apikey/user-admin journey receipt is SETTLED. I verified its headline claims against real code: the "
    "note-branch .returning() really does leak keyHash (apikeys/route.ts:59-61); the auth-key rate-limit key is "
    "really derived from the first 16 chars of the caller-supplied x-api-key (auth-key/route.ts:15-17); the "
    "workflows ADMIN-key fallback is real (docs/workflows/route.ts:74-85); and ext-connections/[id]/test really "
    "has no guard in the handler. New task, same read-only scope: characterize the LEGACY WORKER RUNTIME - "
    "BullMQ stalled detection, memory monitor, retry/DLQ semantics, and graceful shutdown - against the rework "
    "lease-recovery model. This is the one ops surface no receipt in du-rework/coordination/reports/ has "
    "characterized with file:line (the 13:55 opsadmin receipt covered the recover-stalled HTTP route and queue "
    "defaults, but NOT worker.ts itself). Answer with file:line: (1) WORKER PROCESS WIRING: read worker.ts end "
    "to end. State the pipeline-queue vs workflow-steps-queue construction: env vars WORKER_CONCURRENCY and "
    "SUBSTEP_WORKER_CONCURRENCY and their defaults (worker.ts:32-34), stalledInterval 30_000 and maxStalledCount "
    "2 on BOTH workers (:67-69, :80-82). State exactly what the 'failed' handler does when retries are "
    "exhausted (:93-107): is there any DLQ queue transfer, or only a structured console.error log after the "
    "job already failed? What does the 'stalled' handler do (:110-112) - log only, or any DB write? "
    "(2) RETRY SEMANTICS DISTINCTION: BullMQ maxStalledCount=2 (worker.ts:69) vs queue-level attempts:3 "
    "(lib/queue/pipeline-queue.ts:26-34) vs the recover-stalled route's row-flip "
    "(app/api/internal/recover-stalled/route.ts:48-58) are three DIFFERENT mechanisms. Explain precisely how "
    "they interact: when a stalled job is re-queued by BullMQ, does attempts reset? When BullMQ exhausts "
    "attempts, does anything update the Operation row, or does the row stay RUNNING until recover-stalled "
    "flips it? Cite the code that does (or does not) write operation state on job failure. "
    "(3) CHECKPOINT/RESUME ON RETRY: engine.ts resumes from currentStep when >0 (:227) and stores "
    "pipeline_state_snapshot with step results (:365). State exactly what is re-run vs skipped on a BullMQ "
    "retry, and what happens to progressPercent during a retry (engine.ts:285-297 writes step-start percent; "
    "what does a retry do to the stored percent?). (4) MEMORY MONITOR: read the memoryUsage loop - the "
    "thresholds WORKER_MEMORY_THRESHOLD default 0.90 and the resume threshold (:124-137). What exactly happens "
    "at threshold (pause() what? which queue(s)?) and what happens on resume? What happens to IN-FLIGHT jobs "
    "when the worker pauses? Verify the CLAUDE.md claim 'Memory Monitoring: Worker pauses at 90% heap usage, "
    "resumes at 75%' against the code - if the resume threshold differs, say the code value. "
    "(5) SHUTDOWN: what do SIGTERM/SIGINT handlers do (:153-154) - graceful close of workers/queues, timeout, "
    "drain in-flight jobs or not? Cite the shutdown function. (6) WORKFLOW-ENGINE WAIT STATE: "
    "lib/pipelines/workflow-engine.ts:246-272 marks parent WAITING_USER_INPUT and sends a PAUSED webhook; :302 "
    "sets done: state==SUCCEEDED||FAILED so PAUSED is not done. Confirm whether a PAUSED operation ever "
    "re-enters the queue, or whether resume is only via POST /api/v1/operations/{id}/resume - cite the resume "
    "path if found. (7) REWORK COUNTERPART: with file:line, what rework has today - sweepExpiredLeases "
    "(lease_epoch bump, READY on budget-remaining, LEASE_EXPIRED terminal on exhaustion) in "
    "modules/runtime/runtime.ts, heartbeat epoch-fencing, leaseRecoveryIntervalMs hook in server.ts "
    "(~688-690, 890-903), queue-integrity sweep status. State plainly: rework has a DB lease model + periodic "
    "sweep, legacy has BullMQ stalled-detection + separate recover-stalled route + worker-side memory pause - "
    "which legacy behaviors have NO rework counterpart (e.g. heap-pause backpressure, maxStalledCount semantics) "
    "and which rework behaviors are not in legacy (epoch fencing, queue-integrity states). Do not propose any "
    "fix. HARD CHECKS: (1) characterization only - do NOT propose fixes, config changes, or new recovery "
    "schemes; (2) every claim carries file:line; write 'not found' rather than guessing; (3) anything "
    "MUST-NOT-REPLICATE carries file:line and STOP; (4) the standing security constraints apply to rework "
    "counterparts: operations tenant-fenced via resolveApiKey, encryption fail-closed no bypass, never fake "
    "terminal state CANCELLED while work is processing - if legacy writes a terminal state while the runtime "
    "is still processing, label it MUST-NOT-REPLICATE with file:line; (5) do NOT restate balance, spend or "
    "cost numbers; (6) no gate ticks, no COMP row changes. Path reminder: legacy worker and shared helpers "
    "are at the REPO TOP LEVEL (worker.ts, lib/**), NOT under app/lib/**; rework runtime is "
    "du-rework/services/orchestrator/src/modules/runtime/runtime.ts and server.ts. Limits: READ-ONLY with "
    "source; write only your own new report file "
    "du-rework/coordination/reports/codex-legacy-worker-runtime-lifecycle-2026-10-01.md; no source edits; no "
    "test runs; no commits."
)

s = orca_run(["terminal", "send", "--terminal",
              "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
              "--text", SPEC_WORKER_RUNTIME, "--enter", "--json"])
print("[SEND] ctx_task_legacy_worker_runtime -> ok=%s" % s.get("ok"), flush=True)
t = orca_run(["orchestration", "task-create", "--spec", SPEC_WORKER_RUNTIME,
              "--task-title",
              "COMP/ORCH-PAR read-only: legacy worker.ts runtime lifecycle (stalled, memory pause, retry/DLQ, shutdown) vs rework lease sweep",
              "--display-name",
              "COMP/ORCH-PAR read-only: legacy worker.ts runtime lifecycle vs rework lease sweep",
              "--run", RUN, "--json"])
task = (t.get("result") or {}).get("task") or {}
tid = task.get("id")
print("[TASK-CREATE] ctx_task_legacy_worker_runtime -> ok=%s id=%s" % (t.get("ok"), tid), flush=True)

key = "ctx_task_legacy_worker_runtime"
if key not in disp:
    disp[key] = collections.OrderedDict()
e = disp[key]
e["taskId"] = tid
e["terminalHandle"] = "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe"
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
