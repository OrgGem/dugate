#!/usr/bin/env python3
# Cycle ~12:13 - C2 settle x2 (billing wire, ingest multipart wire); C3 dispatch x2 to the freed lanes.
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T12:13:00+07:00"
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

# ---------------- C2: settle the two completed lanes ----------------
RECEIPT_BILLING = (
    "reports/codex-billing-spending-wire-contract-2026-10-01.md (13274 B). Read-only characterization, no source "
    "changed, no tests run. C4 VERIFIED against real code this cycle: (1) legacy 402 gate confirmed at "
    "lib/pipelines/submit.ts:152 (select spendingLimit/totalUsed/name), :159 (spendingLimit>0 && totalUsed>=spendingLimit), "
    ":164 type urn https://dugate.vn/errors/spending-limit-exceeded, :166/:169 status 402 - matches the receipt's :149-159 claim; "
    "(2) rework 0 hits for pattern 402|spending|spendLimit|totalUsed in services/orchestrator/src/server.ts; "
    "(3) 0 hits for budgetReservations|spendingLimit|totalUsed in modules/operations/submission.ts; "
    "(4) modules/usage/budget-reservations.ts throws 503 BUDGET_RESERVATION_UNAVAILABLE at :125,:164,:167,:175 - NOT an over-limit "
    "rejection - while BLOCKED is only an internal admission decision at :375,:473,:501; repo-wide grep for .reserve( returns hits ONLY in "
    "tests/budget-reservations.test.ts, i.e. no production caller. HARD CHECKS PASS: no balance fabricated from tenant usage "
    "(report explicitly refuses to reconcile stored-total vs query-time-sum, :119), no new spending check proposed, and it correctly "
    "separates 'no HTTP balance route' (:7,:117) from 'budget engine exists but is unwired' (:97,:101)."
)

RECEIPT_INGEST = (
    "coordination/reports/tester.md:12206 section COMP-03A-INGEST-UPLOAD-MULTIPART-WIRE-CHARACTERIZATION. Read-only characterization, "
    "no source/contracts/routes/gates changed, no compat design or COMP row decision (tester.md:12284). C4 VERIFIED against real code this "
    "cycle: (1) quoted-key file-field table re-checked at lib/endpoints/runner.ts:36-54 - files[] at :39-42, source_file at :44-45, "
    "target_file at :47-48, file at :50-51, all gated on instanceof File && size>0 - the receipt cites all four keys with correct lines "
    "(tester.md:12221-12222,:12252), i.e. it counted by quoted key not by sub-case; (2) the SSRF direct-forward branch (tester.md:12262) is "
    "labelled an observed input-side boundary with an explicit 'makes no remediation proposal' - boundary not design, no guard or parser "
    "proposed; (3) the guarded branch's assertSafeUrl + manual redirect re-adjudication is recorded as the destination decision point "
    "(:12260) with no fix language; (4) path note is correct - legacy shared helpers are top-level lib/**, only route handlers live under "
    "app/api/v1/** (verified: app/lib does not exist). HARD CHECKS PASS."
)

for key, receipt in (
    ("ctx_task_billing_spend_limit_wire", RECEIPT_BILLING),
    ("ctx_task_ingest_multipart_wire", RECEIPT_INGEST),
):
    if key in disp:
        e = disp[key]
        e["status"] = "settled"
        e["receipt"] = receipt
        e["lastObservedAt"] = NOW
        e["consecutiveUnfinishedChecks"] = 0
        e["blocker"] = None
        print("SETTLED", key, flush=True)
    else:
        print("MISSING", key, flush=True)

# ---------------- C3: dispatch read-only COMP-01 follow-ups to the two freed lanes ----------------
SPEC_949 = (
    "Your ingest/upload wire characterization (coordination/reports/tester.md:12206, section "
    "COMP-03A-INGEST-UPLOAD-MULTIPART-WIRE-CHARACTERIZATION) is SETTLED and passed my hard checks. I verified against real code: "
    "lib/endpoints/runner.ts:36-54 really does collect files[] (:39-42), source_file (:44-45), target_file (:47-48) and file (:50-51) in "
    "that order, each gated on instanceof File && size > 0, and your table cites all four keys with correct lines - you counted by quoted "
    "key, not by sub-case. Your SSRF direct-forward branch is correctly labelled an observed input-side boundary with an explicit 'no "
    "remediation proposal', and your path note (legacy shared helpers are top-level lib/**, only route handlers live under app/api/v1/**) "
    "is right. Next task, same read-only COMP-01 scope, closing the one gap you flagged at tester.md:12280 without resolving it: you wrote "
    "that the rework upload metadata path 'does not implement that legacy extension/MIME mapping or macro-extension rule'. Characterize "
    "the FILE ADMISSION delta end to end, with file:line on both sides, answering: (1) Every admission rule legacy applies to an uploaded or "
    "downloaded file, in the exact order it applies them - extension allow-list and where it can be overridden, extension-to-MIME map, "
    "explicit .docm rejection, non-empty MIME must match the map, per-file size ceiling, aggregate ceiling, filename NFC normalization and "
    "sanitization. Cite lib/upload.ts, lib/upload-helper.ts, lib/pipelines/submit.ts and lib/file-url-downloader.ts precisely. (2) What the "
    "equivalent rules are in rework for BOTH paths - the public upload session (modules/public-api/upload-encryption-gateway.ts, "
    "modules/artifacts/multipart-service.ts, packages/contracts/src/runtime.ts) and the runtime artifact producer grant "
    "(modules/artifacts/artifacts.ts), including what is checked at init versus what is checked during the byte transfer. (3) State per "
    "rule whether it is present, absent, or present-with-different-semantics, with file:line; do NOT reconcile or judge the difference. "
    "(4) Say explicitly whether magic-byte content sniffing happens on either side. HARD CHECKS: (1) characterization only - do NOT propose "
    "a validation rule, an allow-list, a MIME map or a remediation; (2) the macro-rejection rule is a security control - if you find either "
    "side accepts .docm or an extension/MIME mismatch, label it MUST-NOT-REPLICATE with file:line rather than recommending a fix; (3) do not "
    "re-describe the file_urls or SSRF material from your previous section except where it is strictly required to explain a cap; (4) no gate "
    "ticks, no COMP row changes, no balance or spend numbers anywhere in this report. Path reminder: legacy shared helpers are lib/** at "
    "repo top level, NOT app/lib/** (app/lib does not exist); rework lifecycle is modules/lifecycle/lifecycle.ts. Limits: read-only; write "
    "only your own report section in coordination/reports/tester.md as a new numbered section; no source edits; no test runs."
)

SPEC_2B0 = (
    "Your billing/spending wire characterization (coordination/reports/codex-billing-spending-wire-contract-2026-10-01.md) is SETTLED and "
    "passed my hard checks. I verified against real code: the legacy 402 gate is real at lib/pipelines/submit.ts:152,:159,:164,:166,:169; "
    "rework has 0 hits for 402|spending|spendLimit|totalUsed in services/orchestrator/src/server.ts and 0 hits for "
    "budgetReservations|spendingLimit|totalUsed in modules/operations/submission.ts; modules/usage/budget-reservations.ts throws 503 "
    "BUDGET_RESERVATION_UNAVAILABLE at :125,:164,:167,:175 (NOT an over-limit rejection) while BLOCKED is only an internal admission decision "
    "at :375,:473,:501; and a repo-wide grep for .reserve( returns hits only in tests/budget-reservations.test.ts, so there is genuinely no "
    "production caller. You also correctly refused to reconcile stored-total against query-time-sum accounting. Next task, same read-only "
    "COMP-01 scope, on the AUTHENTICATION layer that your report exposed but did not characterize. Your balance and usage handlers read the "
    "x-api-key-id request header directly (app/api/v1/billing/balance/route.ts:18-21,:23-29 and app/api/v1/billing/usage/route.ts:25-39), so "
    "the whole question of whether those reads are fenced depends on what middleware puts on the request. Characterize that precisely: "
    "(1) What middleware.ts actually does for a public /api/v1/** request - which authentication branches exist (x-api-key vs NextAuth session "
    "vs OIDC), and for each branch, exactly which headers it SETS on the downstream request and which it DELETES or refuses to forward. Cite "
    "middleware.ts by line. (2) For each legacy route family that reads an identity header rather than resolving the key itself - billing "
    "balance, billing usage, operations cancel, operations list, operation detail, operation download, operation resume - state whether the "
    "header it reads is one middleware populates, one a client can set directly, or one middleware strips. Give file:line per route. (3) What "
    "the rework equivalent is: where the API key is resolved and hashed, which helper does it, and which rework routes are tenant-fenced by "
    "it versus not. Cite packages/contracts/src (resolveApiKey) and services/orchestrator/src/server.ts. (4) For any legacy read that is "
    "tenant-unfenced when the header is absent or forged, label it MUST-NOT-REPLICATE with file:line. HARD CHECKS: (1) characterization "
    "only - do NOT propose middleware changes, do NOT design a fence, do NOT say which side should change; (2) a missing identity header "
    "producing 401 is NOT the same as a header that can be forged by the client - distinguish these explicitly and state which legacy routes "
    "are in which category; (3) do NOT restate or re-derive any balance, spend, or cost numbers - this task is about identity, not money; (4) "
    "no gate ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at repo top level, NOT app/lib/**; rework auth "
    "helpers are under packages/contracts/src and services/orchestrator/src, not app/. Limits: read-only; write only your own report (a new "
    "codex-*.md file in du-rework/coordination/reports/); no source edits; no test runs."
)

DISPATCHES = [
    ("ctx_task_file_admission_delta",
     "COMP-01 read-only: file admission delta (extension/MIME/.docm/per-file/aggregate/sanitization) legacy upload+download vs rework upload session and artifact grant",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     SPEC_949),
    ("ctx_task_legacy_auth_fence_matrix",
     "COMP-01 read-only: legacy middleware auth matrix - which identity headers are set/stripped, which route families read them, rework resolveApiKey tenant fence (no balance/spend numbers)",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     SPEC_2B0),
]

results = []
for key, title, handle, spec in DISPATCHES:
    s = orca_run(["terminal", "send", "--terminal", handle, "--text", spec, "--enter", "--json"])
    print("[SEND] %s -> ok=%s" % (key, s.get("ok")), flush=True)
    t = orca_run(["orchestration", "task-create", "--spec", spec, "--task-title", title,
                  "--display-name", title, "--run", RUN, "--json"])
    task = (t.get("result") or {}).get("task") or {}
    tid = task.get("id")
    print("[TASK-CREATE] %s -> ok=%s id=%s" % (key, t.get("ok"), tid), flush=True)
    results.append((key, handle, tid))

for key, handle, tid in results:
    if key not in disp:
        disp[key] = collections.OrderedDict()
    e = disp[key]
    e["taskId"] = tid or e.get("taskId")
    e["terminalHandle"] = handle
    e["lastObservedAt"] = NOW
    e["lastProgressAt"] = NOW
    e["transcriptCursor"] = e.get("transcriptCursor", "")
    e["consecutiveUnfinishedChecks"] = 0
    e["lastNudgeAt"] = e.get("lastNudgeAt")
    e["blocker"] = None
    e["status"] = "running"
    e["receipt"] = e.get("receipt")
    e["supervised"] = True

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(e["status"] for e in disp.values())
print("watch-state total", len(disp), dict(c))
