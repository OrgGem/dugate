#!/usr/bin/env python3
# Cycle ~12:01 — C2 settle b2d08e87 fixture spec; C3 re-dispatch COMP-01c to c4486089 (restore ownership) + new read-only lifecycle-truth probe to b2d08e87.
import json, subprocess, collections, datetime, os

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T12:01:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

def orca_run(args, timeout=120):
    r = subprocess.run([ORCA]+args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try: return json.loads(r.stdout)
    except Exception: return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}

# ---------- C2: settle the completed fixture-spec task ----------
w = json.load(open(W, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
disp = w['dispatches']

key = "ctx_task_lifecycle_fixture_spec"
if key in disp:
    e = disp[key]
    e['status'] = 'settled'
    e['receipt'] = (
        "reports/codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md "
        "(SPEC not live-verified, states so up front; ports 2023/3000 unreachable, no tests run; "
        "assertion tables starting-state x action, pagination token dialect (legacy next_page_token=last-id "
        "route.ts:31-33,98,129 vs rework nextCursor opaque keyset server.ts:3383-3390), NEGATIVE list; "
        "MUST-NOT-REPLICATE: legacy optional x-api-key-id fence absent w/o middleware header (cancel/download/resume/list/detail), "
        "legacy direct CANCELLED write (cancel/route.ts:39-43) also flagged on rework side (lifecycle.ts:42-45) "
        "vs OPERATION_TRANSITIONS (operations.ts:73-94) which only allows CANCEL_REQUESTED->CANCELLED — "
        "receipt labels it UNRESOLVED, does not bless either side; no synthetic CANCELLED fixture; "
        "resolveApiKey convention honored (server.ts:4182-4194); ticks no gate; no source edit)"
    )
    e['lastObservedAt'] = NOW
    e['consecutiveUnfinishedChecks'] = 0
    e['blocker'] = None
    print("SETTLED", key)
else:
    print("MISSING", key)

# mark the abandoned list-matrix entry so its re-dispatch is visible
key2 = "ctx_task_lifecycle_list_matrix"
if key2 in disp:
    e2 = disp[key2]
    e2['lastObservedAt'] = NOW
    e2['status'] = 'running'   # being re-dispatched this cycle
    e2['blocker'] = None
    e2['receipt'] = None
    print("RE-DISPATCHING", key2, "taskId was", e2.get('taskId'))

# ---------- C3: specs ----------
SPEC_C44 = (
"Ownership restore + COMP-01c redo. Your prior COMP-01c attempt was abandoned because Orca reported "
"the process no longer owned the dispatch - that is fixed: I have issued a fresh orchestration task "
"for this same lane and you own it again. Proceed with the SAME COMP-01c scope as before, unchanged: "
"the lifecycle + list response-shape matrix. Sources: legacy app/api/v1/operations/route.ts (list), "
"app/api/v1/operations/[id]/route.ts (detail), app/api/v1/operations/[id]/cancel/route.ts, "
"app/api/v1/operations/[id]/resume/route.ts, app/api/v1/operations/[id]/download/route.ts, "
"app/lib/pipelines/format.ts (formatOperationResponse serialization), app/lib/db/schema.ts for the "
"operations table columns. Rework: du-rework/services/orchestrator/src/server.ts operations routes "
"(list :1791 area, detail :1832, result :1928, artifacts download :2012, cancel :2091, resume :2101), "
"packages/contracts/src/operations.ts and runtime.ts for canonical shapes, and the admin keyset/cursor "
"module for the 4-slot cursor dialect. A parallel lane has ALREADY written the executable golden-fixture "
"assertion SPEC for this same surface (reports/codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md) "
"- do NOT duplicate its assertion tables. Your deliverable is the RESPONSE-SHAPE matrix: (1) per-operation "
"response matrix for list / detail / result / cancel / resume / download: LEGACY response body shape "
"(exact JSON field names, status codes, headers) vs REWORK response body shape, each cell with file:line; "
"(2) pagination dialect: does legacy list take a page/cursor parameter, what is next_page_token if anything, "
"and what is rework's cursor contract (state whether the admin 4-slot cursor dialect appears on the PUBLIC "
"operations list route or only on admin routes, with file:line); (3) a STATE map: every terminal and "
"non-terminal state name legacy can emit on each of these routes vs every state rework can emit, flagging "
"any state name that exists on one side only (feeds COMP-00 lifecycle-truth - report, do not decide); "
"(4) re-verify the download contract delta with file:line on both sides and state what a legacy download "
"client would actually receive from rework today. HARD CHECKS: (1) characterization only - do NOT propose "
"a response-shape fix, do NOT design an adapter, do NOT change any state name; (2) do not treat 'a 200 "
"exists' as parity - field names, status codes and the pagination token are the acceptance object; "
"(3) do not fake or recommend faking a terminal state CANCELLED when runtime is still processing - if "
"legacy or rework does that, label it MUST-NOT-REPLICATE with file:line instead; (4) no gate ticks, no "
"COMP row changes. Path reminder: legacy helpers are lib/** at repo top level, NOT app/lib/**; rework "
"submission is modules/operations/submission.ts, NOT modules/runtime/submission.ts. Limits: read-only; "
"write only your own report (reports/codex-new.md, new numbered section); no source edits; no test runs."
)

SPEC_B2D = (
"Your golden-fixture assertion spec (reports/codex-operations-lifecycle-golden-fixture-assertions-2026-10-01.md) "
"is SETTLED and passed my hard checks - I verified against real code that cancel/route.ts:24-30 scopes "
"conditionally on x-api-key-id (absent -> no fence), :32-37 returns 409 Already Completed when done:true, "
":39-43 writes done:true state:CANCELLED directly, that lifecycle.ts:37-40 replays on terminal and :42-45 "
"also writes state=CANCELLED directly with cancel_requested=true in the same UPDATE, and that "
"OPERATION_TRANSITIONS at operations.ts:73-94 lists CANCEL_REQUESTED: ['CANCELLED','TIMED_OUT'] with "
"RUNNING/WAITING_INPUT pointing at CANCEL_REQUESTED and never at CANCELLED directly. That last point is "
"the new gap I want you to close next - it feeds COMP-00 lifecycle-truth, the sole blocker for COMP-02..09. "
"New READ-ONLY task: characterize the CANCEL_REQUESTED state in the rework codebase end to end. Questions "
"to answer with file:line, not opinion: (1) Is CANCEL_REQUESTED ever WRITTEN to the operations table or to "
"in-memory state anywhere in services/orchestrator/src/** ? If yes, name every write site; if no, say so "
"plainly. (2) Is CANCEL_REQUESTED ever read, compared, projected, or filtered on anywhere (runtime.ts, "
"facade.ts, lifecycle.ts, server.ts, contracts schemas, webhooks, usage)? List each read site. (3) Does the "
"admin cancel route (server.ts:2087-2094) and lifecycle.cancelOperation (lifecycle.ts:27-68) ever pass "
"through CANCEL_REQUESTED, or is the direct CANCELLED write the only path today? (4) Do the contracts "
"schemas (packages/contracts/src/operations.ts OPERATION_TRANSITIONS and any OperationState enum/union) "
"expose CANCEL_REQUESTED as a value a client can observe on the wire, or only as an internal transition "
"table entry? (5) Does the deadline sweeper (lifecycle.ts:71-103) interact with CANCEL_REQUESTED at all? "
"(6) What does the operations table schema actually store for state - which migration defines the column, "
"and is there a CHECK constraint or is it free text? Sources: du-rework/services/orchestrator/src/modules/"
"lifecycle/lifecycle.ts, modules/runtime/runtime.ts, modules/operations/facade.ts, modules/operations/"
"submission.ts, server.ts operations routes, packages/contracts/src/operations.ts and runtime.ts, and "
"migrations/*.sql for the operations.state column definition. HARD CHECKS: (1) this is characterization - "
"do NOT propose which side is correct, do NOT design a fix, do NOT say the implementation should adopt "
"CANCEL_REQUESTED or that the contract should drop it - that is COMP-00's verdict; (2) if you find that "
"CANCEL_REQUESTED is never written, say exactly that and name the files you searched (grep patterns plus "
"file:line of the closest writes, i.e. lifecycle.ts:42-45); (3) do not fabricate a write site to fill a "
"cell - if a cell is empty it is empty; (4) no gate ticks, no COMP row changes. Path reminder: rework "
"submission is modules/operations/submission.ts, NOT modules/runtime/submission.ts; lifecycle is modules/"
"lifecycle/lifecycle.ts. Limits: read-only; write only your own report (a new codex-*.md file in "
"du-rework/coordination/reports/); no source edits; no test runs."
)

DISPATCHES = [
    ("ctx_task_lifecycle_list_matrix",
     "COMP-01 read-only: lifecycle + list response-shape matrix (redo, ownership restored) - field names, status codes, pagination dialect, state map",
     "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
     SPEC_C44),
    ("ctx_task_cancel_requested_wire_probe",
     "COMP-01 read-only: CANCEL_REQUESTED end-to-end probe in rework - write sites, read sites, wire exposure, schema constraint (feeds COMP-00 lifecycle-truth)",
     "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
     SPEC_B2D),
]

results = []
for key, title, handle, spec in DISPATCHES:
    s = orca_run(["terminal","send","--terminal",handle,"--text",spec,"--enter","--json"])
    print(f"[SEND] {key} -> ok={s.get('ok')}", flush=True)
    t = orca_run(["orchestration","task-create","--spec",spec,"--task-title",title,
                  "--display-name",title,"--run",RUN,"--json"])
    task = (t.get("result") or {}).get("task") or {}
    tid = task.get("id")
    print(f"[TASK-CREATE] {key} -> ok={t.get('ok')} id={tid}", flush=True)
    results.append((key, handle, tid))

# ---------- watch-state update ----------
for key, handle, tid in results:
    if key not in disp:
        disp[key] = collections.OrderedDict()
    e = disp[key]
    e['taskId'] = tid or e.get('taskId')
    e['terminalHandle'] = handle
    e['lastObservedAt'] = NOW
    e['lastProgressAt'] = NOW
    e['transcriptCursor'] = e.get('transcriptCursor', "")
    e['consecutiveUnfinishedChecks'] = 0
    e['lastNudgeAt'] = e.get('lastNudgeAt')
    e['blocker'] = None
    e['status'] = 'running'
    e['receipt'] = e.get('receipt')
    e['supervised'] = True

w['lastCheckedAt'] = NOW
json.dump(w, open(W, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(W, 'a', encoding='utf-8').write('\n')

c = collections.Counter(e['status'] for e in disp.values())
print("watch-state total", len(disp), dict(c))
