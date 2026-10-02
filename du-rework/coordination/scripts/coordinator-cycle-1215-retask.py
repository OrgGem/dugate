#!/usr/bin/env python3
# Correction: ctx_task_legacy_auth_fence_matrix duplicates codex-legacy-auth-fence-inventory-2026-10-01.md (09:34).
# Re-task 2b05b203 to the result-delivery encryption policy wire contract instead.
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
HANDLE = "term_2b05b203-549f-4428-b908-c303a2b187ec"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"


def orca_run(args, timeout=180):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}


SPEC = (
    "STOP the task I just sent you - the auth-fence matrix I assigned 60 seconds ago is a DUPLICATE and you should not spend effort on it. "
    "There is already a complete inventory at du-rework/coordination/reports/codex-legacy-auth-fence-inventory-2026-10-01.md (written "
    "09:34, 12 KB) that already covers every question I asked: it documents the middleware x-api-key-id / x-user-id / x-user-role stripping "
    "(middleware.ts:32-52), the six runEndpoint raw-x-api-key resolutions, the pass-through/missing-key behavior, the workflow caller-selected "
    "apiKeyId plus ADMIN fallback, the optional-header fences on operations list / detail / cancel / resume / download, the services and "
    "billing direct x-api-key-id reads, the /api/internal bypass, and the rework resolveApiKey equivalents - all already labelled "
    "HARDENING-CORRECT-IN-REWORK / MUST-NOT-REPLICATE / NEEDS-COMP-00-DECISION. Do NOT redo it and do NOT merge it into a new file. If you "
    "already started reading files, discard that work. Your settled billing receipt stands and is correct - I verified it against real code.\n\n"
    "NEW task, same read-only COMP-01 scope, genuinely uncovered: the RESULT-DELIVERY ENCRYPTION POLICY wire contract. I have searched the "
    "reports directory and there is a webhook delivery-encryption receipt but NO characterization of the operation result / artifact delivery "
    "encryption policy, and encryption scope is one of the standing COMP plan requirements. Characterize it with file:line on both sides, "
    "answering: (1) What does LEGACY do when delivering an operation result and its output file - the fields, the status codes, and whether "
    "the bytes are ever encrypted at rest or in transit by the application. Cover app/api/v1/operations/[id]/route.ts, "
    "app/api/v1/operations/[id]/download/route.ts and lib/pipelines/format.ts. State plainly whether legacy has ANY result-encryption concept "
    "at all, or whether it is plaintext end to end. (2) What does REWORK do - the tenant delivery policy that your previous receipt already "
    "observed at server.ts:1917-1997 and the plaintext result envelope {schemaVersion, data, artifacts, usage, warnings} at :1983-1987. "
    "Identify the exact configuration or request field that selects encrypted vs plaintext delivery, with file:line, and cite the encryption "
    "implementation module. (3) CRITICAL: for each side, state what happens when encryption is selected but the key material is missing, "
    "unavailable, or wrong. Does it fail closed with an error, or does it silently fall back to delivering plaintext? Cite the line that "
    "decides this. This is the single most important question in the report. (4) Is there ANY param, query flag, or request header that lets a "
    "caller downgrade delivery to plaintext on either side? If yes, label it MUST-NOT-REPLICATE with file:line. (5) Does the encrypted body "
    "change the response content-type or the JSON envelope shape a client must parse, compared to the plaintext path? (6) Does the artifact "
    "download path encrypt bytes independently of the JSON result envelope, or does it inherit the result policy? Cite each separately. "
    "HARD CHECKS: (1) characterization only - do NOT propose an encryption design, do NOT say which side should change, do NOT recommend a key "
    "management approach; (2) if either side has a plaintext fallback on a crypto failure, label it MUST-NOT-REPLICATE with file:line and say "
    "nothing about how to fix it; (3) do NOT restate or re-derive any balance, spend, or cost numbers from your previous report - this task is "
    "about delivery encryption only; (4) no gate ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at repo top level, "
    "NOT app/lib/**; rework crypto helpers are under services/orchestrator/src and packages/contracts/src. Limits: read-only; write only your "
    "own new report file in du-rework/coordination/reports/ named codex-result-delivery-encryption-wire-2026-10-01.md; no source edits; no test "
    "runs."
)

TITLE = ("COMP-01 read-only: result-delivery encryption policy wire contract (legacy plaintext vs rework tenant delivery, "
         "fail-closed check, no plaintext fallback)")

s = orca_run(["terminal", "send", "--terminal", HANDLE, "--text", SPEC, "--enter", "--json"])
print("[SEND-CORRECTION] ok=%s" % s.get("ok"), flush=True)
t = orca_run(["orchestration", "task-create", "--spec", SPEC, "--task-title", TITLE,
              "--display-name", TITLE, "--run", RUN, "--json"])
task = (t.get("result") or {}).get("task") or {}
print("[TASK-CREATE] ok=%s id=%s" % (t.get("ok"), task.get("id")), flush=True)

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]
key = "ctx_task_result_delivery_encryption"
if key not in disp:
    disp[key] = collections.OrderedDict()
e = disp[key]
e["taskId"] = task.get("id")
e["terminalHandle"] = HANDLE
e["lastObservedAt"] = "2026-10-01T12:15:00+07:00"
e["lastProgressAt"] = "2026-10-01T12:15:00+07:00"
e["transcriptCursor"] = ""
e["consecutiveUnfinishedChecks"] = 0
e["lastNudgeAt"] = None
e["blocker"] = None
e["status"] = "running"
e["receipt"] = None
e["supervised"] = True
e["supersedes"] = ("ctx_task_legacy_auth_fence_matrix (task_4b9560ea055a) - withdrawn as a duplicate of "
                   "reports/codex-legacy-auth-fence-inventory-2026-10-01.md, already complete at 09:34")

stale = disp.get("ctx_task_legacy_auth_fence_matrix")
if stale is not None:
    stale["status"] = "settled"
    stale["blocker"] = None
    stale["lastObservedAt"] = "2026-10-01T12:15:00+07:00"
    stale["receipt"] = ("WITHDRAWN 12:15 by coordinator - duplicate scope. Superseded by reports/"
                        "codex-legacy-auth-fence-inventory-2026-10-01.md (09:34), which already covers middleware identity-header "
                        "stripping, all operations/surface optional-header fences, billing/services direct x-api-key-id reads, the "
                        "/api/internal bypass and the rework resolveApiKey equivalents. Lane re-tasked to "
                        "ctx_task_result_delivery_encryption instead. No work product expected from this task id.")

w["lastCheckedAt"] = "2026-10-01T12:15:00+07:00"
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(e["status"] for e in disp.values())
print("watch-state total", len(disp), dict(c))
