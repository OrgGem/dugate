#!/usr/bin/env python3
# Cycle ~12:40 - C2 settle encryption receipt + C3 dispatch x3 read-only COMP-00 input characterizations.
# Topics verified NOT covered in reports/ before dispatch (idempotency/sync are covered by codex-new.md:545 - avoided).
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T12:40:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"


def orca_run(args, timeout=180):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}


w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

# ---------------- C2: settle the encryption receipt delivered at 12:34 ----------------
e = disp.get("ctx_task_result_delivery_encryption")
if e is not None:
    e["status"] = "settled"
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    e["receipt"] = (
        "reports/codex-result-delivery-encryption-wire-2026-10-01.md (10228 B, 12:34). Read-only, no source/tests/gates changed, no "
        "encryption design proposed. C4 VERIFIED against real code this cycle - THE CRITICAL QUESTION ANSWERED: (1) FAIL-CLOSED PROVEN: "
        "server.ts:1850-1856 comment literally states 'failure is UNAVAILABLE, never a plaintext downgrade: a tenant whose delivery encryption "
        "is switched on but whose key is missing, revoked, unresolvable or currently erroring gets a 503, because silently downgrading is "
        "exactly the leak this feature exists to prevent'; deliveryEncryptionHttpError maps RECIPIENT_KEY_NOT_FOUND / RECIPIENT_KEY_REVOKED / "
        "any other DeliveryEncryptionError all to 503 TEMPORARY_UNAVAILABLE at :1857-1874; encryptedDeliveryBody's ONLY non-throwing exit is "
        "`if (!policy?.enabled) return null` (:1902-1904) and its catch block rethrows 503 - there is NO path that returns plaintext after a "
        "crypto failure; (2) NO CALLER-CONTROLLED DOWNGRADE: server.ts:370-378 contract comment says 'Platform configuration, never caller "
        "input: a client cannot select plaintext, a key id, or a key version... FAILS CLOSED (503) instead of falling back to plaintext'; "
        "rg -n 'encryption|encrypted|plaintext' over server.ts filtered for query/searchParams/body/header returns only x-content-sha256 "
        "(:1450), an unrelated upload-integrity header; (3) LEGACY HAS NO ENCRYPTION CONCEPT AT ALL: rg -c -i 'encrypt|cipher|decrypt|aes' over "
        "lib/pipelines/format.ts + app/api/v1/operations/[id]/route.ts + [id]/download/route.ts returns 0 hits each - plaintext end to end at "
        "the application layer; (4) envelope/content-type: both plaintext and encrypted variants are application/json, encryption changes the "
        "JSON shape not the content type (receipt cites server.ts:716-720,798-810, operations.ts:171-195); (5) artifact download encrypts "
        "INDEPENDENTLY at download time under the same tenant policy rather than inheriting the result ciphertext (server.ts:2054-2077 + "
        "operations.ts:198-208), while an at-rest-sealed blob is decrypted first (:2041-2053). Hard check 'no plaintext fallback' PASSES; no "
        "balance/spend numbers; no gate tick; no COMP row change. This closes COMP-00 decision #5's encryption evidence."
    )
    print("SETTLED ctx_task_result_delivery_encryption", flush=True)
else:
    print("MISSING ctx_task_result_delivery_encryption", flush=True)

# ---------------- C3: dispatch 3 read-only COMP-00 input characterizations ----------------
SPEC_CACHE = (
    "Your COMP-01c operation list+lifecycle response-shape matrix (coordination/reports/codex-new.md:760) is SETTLED and passed my hard "
    "checks. I verified against real code: toOperationView really does omit tenantId (facade.ts:32-51) while packages/contracts/src/"
    "operations.ts:134 declares tenantId as REQUIRED z.string(); your progress:{percent:0,message:r.state} citation at facade.ts:45 is exact; "
    "you labelled BOTH premature-CANCELLED paths MUST-NOT-REPLICATE (legacy cancel/route.ts:39-45 and rework lifecycle.ts:42-50,64-68) "
    "without blessing either side; and your cursor dialect split (public base64url '<canonical timestamp>|<uuid>|<field:direction>[|p]' vs admin "
    "4-slot base36-microseconds|encoded-id|sort-code|n-or-p) matches server.ts:1771-1803,3382-3414 vs :2719-2743,3511-3523. Next task, same "
    "read-only scope, closing the one input COMP-00 decision #1 explicitly requires and that no report in reports/ currently answers - the "
    "plan says you must pick 'policy Vary/cache' for the shared legacy paths. Characterize HTTP caching and conditional-request semantics on "
    "the operation surface, with file:line on BOTH sides: (1) For each legacy operation route - GET /api/v1/operations, GET "
    "/api/v1/operations/{id}, GET /api/v1/operations/{id}/result-equivalent (the detail response), GET /api/v1/operations/{id}/download, and "
    "the six POST /api/v1/docs/{service} handlers - state whether the response sets Cache-Control, Expires, ETag, Last-Modified, Vary or "
    "Pragma, or whether the framework default applies. Cite the route file and the middleware if it sets any of these. (2) State whether ANY "
    "legacy route honors If-None-Match / If-Modified-Since (i.e. can a poller get 304), and whether a 304 is even reachable. (3) What does "
    "legacy middleware.ts set on responses - does it add CORS headers, Vary, or rate-limit headers to /api/v1/** responses? Cite lines. (4) "
    "Rework side: same inventory for GET /api/v1/operations, /operations/{id}, /operations/{id}/result, /api/v1/artifacts/{id}/download and "
    "the generic submit. Look at the response helper in services/orchestrator/src/server.ts and any middleware, and at "
    "packages/contracts/src/errors.ts for problem+json headers. (5) State plainly whether a legacy client polling with HTTP caching would "
    "ever see a cached STALE operation state from either side - i.e. is a poll response cacheable by a shared cache today, on each side. "
    "(6) Call out any response that a CDN or reverse proxy could cache to the detriment of correctness (e.g. a 409/404 without no-store). "
    "HARD CHECKS: (1) characterization only - do NOT propose a Cache-Control or Vary policy, do NOT recommend headers, do NOT say which side "
    "should change; (2) if a legacy or rework route returns a cacheable response that could serve a stale operation state, label it "
    "MUST-NOT-REPLICATE with file:line and say nothing about how to fix it; (3) do NOT restate balance, spend or cost numbers; (4) no gate "
    "ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at repo top level, NOT app/lib/**; rework response helper is "
    "services/orchestrator/src/server.ts (routes + http/ package), not app/. Limits: read-only; write only your own new report file in "
    "du-rework/coordination/reports/ named codex-operation-surface-cache-semantics-2026-10-01.md; no source edits; no test runs."
)

SPEC_RETENTION = (
    "Your COMP-01c matrix (coordination/reports/codex-new.md:760) is SETTLED - I verified the toOperationView tenantId omission, the "
    "facade.ts:45 progress MISMATCH, both MUST-NOT-REPLICATE premature-CANCELLED labels, and the cursor dialect split against real code. The "
    "CANCEL_REQUESTED probe (reports/codex-cancel-requested-state-characterization-2026-10-01.md) also settled with the same grade: zero "
    "writers of the enum value, lifecycle.ts:40-44 writes CANCELLED + cancel_requested=true directly, and OPERATION_TRANSITIONS "
    "(operations.ts:73-94) has no RUNNING->CANCELLED edge. Next task, same read-only scope, answering the second half of COMP-00 decision #4, "
    "which the plan words as 'Chốt retention/soft delete và quyền xem sau DELETE' and which NO report in reports/ currently characterizes. "
    "Answer with file:line on BOTH sides: (1) LEGACY FILE RETENTION: what does lib/cleanup.ts actually delete, after how long, and on what "
    "schedule? Cite the interval, the age threshold, and exactly which columns/rows cause a file to be eligible. Does it delete operation "
    "rows, only uploaded input files, only output files, or all three? Is there a separate cleanup for output files? Cite "
    "lib/cleanup-scheduler.ts too. (2) LEGACY OPERATION DELETE: app/api/v1/operations/[id]/route.ts:40-64 does a soft delete - cite the exact "
    "column it flips, whether the row survives, and then state what GET /api/v1/operations and GET /api/v1/operations/{id} return for a "
    "deleted operation afterwards (does the list still include it? does detail 404 or return the row with a deleted flag?). Cite the "
    "filter lines. (3) Is there ANY admin/DB path that hard-deletes legacy operations or their artifacts (e.g. prisma scripts in scripts/, "
    "api/internal)? Cite file:line or state plainly that none was found. (4) RETENTION IN REWORK: find every timer/sweep/config that deletes "
    "rework rows or blobs - lease sweep is NOT retention, deadline sweep is NOT retention, so look specifically for operation row deletion, "
    "artifact/row garbage collection, blob TTL, and the at-rest-sealed-blob lifecycle. Cite services/orchestrator/src/modules/** and any "
    "config field. If no retention mechanism exists, say so explicitly with the evidence of what you searched. (5) REWORK DELETE: the "
    "COMP-01c matrix established there is NO rework DELETE route - confirm that and state whether any internal/admin surface can delete an "
    "operation or artifact today. (6) POST-DELETE VISIBILITY: for each side, state what a tenant can still read after a delete, including "
    "whether a download URL or result reference keeps working. HARD CHECKS: (1) characterization only - do NOT propose a retention policy, do "
    "NOT recommend a TTL, do NOT choose a deletion behavior; (2) if a retained plaintext or a post-delete read leaks data that the other side "
    "would prevent, label it MUST-NOT-REPLICATE with file:line and say nothing about how to fix it; (3) do NOT restate balance, spend or cost "
    "numbers; (4) no gate ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at repo top level, NOT app/lib/**; "
    "rework modules are services/orchestrator/src/modules/**, not app/. Limits: read-only; write only your own new report file in "
    "du-rework/coordination/reports/ named codex-retention-softdelete-visibility-2026-10-01.md; no source edits; no test runs."
)

SPEC_PROGRESS = (
    "Your file-admission delta (coordination/reports/tester.md:12286) is SETTLED and passed my hard checks. I verified the headline against "
    "real code: legacy rejects .docm at lib/upload.ts:30-34 (E06) and again at :82-83, while rg -ci docm over "
    "du-rework/services/orchestrator/src + du-rework/packages + du-rework/businesses returns ZERO hits - rework implements no macro rejection "
    "anywhere. Your labelling of rework .docm acceptance and extension/MIME mismatch as MUST-NOT-REPLICATE (rather than a fix proposal) and "
    "your magic-byte finding (admission relies on metadata and hashes, not content sniffing, on either side) both hold. Next task, same "
    "read-only scope, on the PROGRESS WIRE - the plan's COMP-00 decision #3 requires you to fix 'nguồn checkpoint cho pipeline_steps/progress' "
    "and COMP-05 forbids an in-progress operation staying at progress_percent=0 forever, but no report in reports/ characterizes how progress "
    "is actually produced. Answer with file:line on BOTH sides: (1) LEGACY PROGRESS WRITERS, in order of when they fire: the initial write at "
    "job creation (lib/pipelines/submit.ts:312-313), the per-url download message (lib/pipelines/engine.ts:149), the per-step computation "
    "Math.round((i / pipeline.length) * 100) plus its Vietnamese progressMessage (lib/pipelines/engine.ts:285-297), the terminal "
    "progressPercent:100 / progressMessage:null on success (engine.ts:402-403), the failure-path values, and the workflow equivalents "
    "(lib/pipelines/workflow-engine.ts:135-136,209-210,221-222) including the sub-step progress. For each, state the exact percent value or "
    "formula, the exact message text or template, the column written, and the state at which it is written. (2) State how a sync-mode vs "
    "async-mode client observes progress differently if at all (citing the sync wait path), and whether progress is ever written back through "
    "the poll response or only read from the DB. (3) Does the legacy formatter expose progress for a FAILED operation too - cite "
    "lib/pipelines/format.ts:27-28 and what fills progressPercent on the failure path (engine.ts / workflow-engine.ts). (4) REWORK: enumerate "
    "every write to an operation's progress field or a progress-bearing structure - start from the comment at "
    "services/orchestrator/src/modules/runtime/runtime.ts:489 ('Slice: coalesced - update operation progress only. Real impl throttles.') and "
    "find whether any real percent is ever computed anywhere, including document-core producers, task checkpoint writes, and "
    "modules/operations/submission.ts:715. State whether percent is EVER anything other than 0 in production code today. (5) State plainly "
    "whether a client polling rework can distinguish a running operation from a stuck one using progress alone, given what you found in (4), "
    "without proposing a fix. (6) Note any schema/column on either side that stores step-level progress separately from the percent (e.g. a "
    "steps JSON column) and whether it is populated. HARD CHECKS: (1) characterization only - do NOT propose a progress computation, a step "
    "list, a checkpoint design, or a fix; (2) if rework's hardcoded zero is a parity blocker, label it MUST-NOT-REPLICATE with file:line and "
    "stop there - do not design the replacement; (3) do NOT restate balance, spend or cost numbers - the usage/progress line on legacy "
    "responses is out of scope here except where the progress field itself is written; (4) no gate ticks, no COMP row changes. Path reminder: "
    "legacy shared helpers are lib/** at repo top level, NOT app/lib/** (only route handlers live under app/api/v1/**); rework runtime is "
    "services/orchestrator/src/modules/runtime/runtime.ts and submission is modules/operations/submission.ts. Limits: read-only; write only "
    "your own report section in coordination/reports/tester.md as a new numbered section; no source edits; no test runs."
)

DISPATCHES = [
    ("ctx_task_operation_cache_semantics",
     "COMP-01 read-only: operation-surface HTTP cache/conditional-request semantics (Cache-Control/Vary/ETag/304, legacy vs rework, feeds COMP-00 decision #1 Vary/cache)",
     "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
     SPEC_CACHE),
    ("ctx_task_retention_softdelete_visibility",
     "COMP-01 read-only: retention + soft-delete + post-delete visibility (legacy cleanup.ts 7-day + DELETE soft row vs rework, feeds COMP-00 decision #4)",
     "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
     SPEC_RETENTION),
    ("ctx_task_progress_wire_semantics",
     "COMP-01 read-only: progress_percent writer semantics (legacy real per-step percent vs rework hardcoded 0, feeds COMP-00 decision #3 checkpoint source, no fix design)",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     SPEC_PROGRESS),
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
