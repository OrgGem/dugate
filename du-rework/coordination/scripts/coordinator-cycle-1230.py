#!/usr/bin/env python3
# Cycle ~12:30 — C2 settle x4 (CANCEL_REQUESTED probe, COMP-01c matrix, file admission delta, profile-lock inventory).
# C4 evidence for each is embedded in the receipt literal below.
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
NOW = "2026-10-01T12:30:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

RECEIPTS = {
    "ctx_task_cancel_requested_wire_probe": (
        "reports/codex-cancel-requested-state-characterization-2026-10-01.md (12783 B, 12:11). Read-only characterization, no source/tests/gates "
        "touched, no side chosen. C4 VERIFIED against real code this cycle: (1) THE ANSWER TO THE PROBE - repo-wide scan "
        "rg -n \"state='CANCEL_REQUESTED'|state: 'CANCEL_REQUESTED'\" over du-rework/services/orchestrator/src + packages/contracts/src returns ZERO "
        "hits: no service writer ever persists the enum value; files containing the token are only operations.ts, public-api.ts, "
        "compat/legacy-operations.ts, ingestion-consumer.ts, runtime.ts and the two admin modules; (2) lifecycle.ts cancel writes "
        "state='CANCELLED' + cancel_requested=true (separate boolean) in one UPDATE at :40-44, with terminal list "
        "['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'] at :36 - verified by direct read; (3) lifecycle.ts and facade.ts contain ZERO literal "
        "'CANCEL_REQUESTED' hits - the value is excluded from isTerminal/terminal-lists by omission, exactly as the receipt states; (4) consume "
        "sites verified: runtime.ts:185 hasCancelSignal op_state==='CANCEL_REQUESTED', runtime.ts:399 predicate 'NOT o.cancel_requested AND "
        "o.state <> \\'CANCEL_REQUESTED\\'', contracts operations.ts:19 union member, :74-76/:86-88 transitions INTO it, :89 "
        "CANCEL_REQUESTED: ['CANCELLED','TIMED_OUT'], public-api.ts:94 RUNNING filter group; (5) the CORE COMP-00 EVIDENCE is therefore: "
        "OPERATION_TRANSITIONS (operations.ts:73-94) has NO edge RUNNING->CANCELLED or WAITING_INPUT->CANCELLED, yet lifecycle.ts:42-45 writes "
        "CANCELLED directly and NOTHING ever writes the CANCEL_REQUESTED intermediate, so the transition table's cancel path is dead in practice "
        "- receipt states this as observed behavior, picks no side, proposes no fix. HARD CHECKS PASS: no fabricated write site, no fake "
        "terminal state, no gate tick, no COMP row change."
    ),
    "ctx_task_lifecycle_list_matrix": (
        "reports/codex-new.md:760 section 'COMP-01c — Operation list + lifecycle response-shape matrix (2026-10-01)'. Read-only, no "
        "source/contract/COMP/gate change; legacy resume route explicitly recorded HARDENING-MUST-NOT-REPLICATE. C4 VERIFIED against real code "
        "this cycle: (1) 'toOperationView omits tenantId although OperationViewSchema requires it' - CONFIRMED: facade.ts:32-51 returns no "
        "tenantId field while packages/contracts/src/operations.ts:134 declares tenantId z.string() REQUIRED (not optional); (2) progress "
        "MISMATCH confirmed at facade.ts:45 progress:{percent:0,message:r.state} (matches the standing plan MISMATCH); (3) both premature "
        "CANCELLED paths are labelled MUST-NOT-REPLICATE with file:line - legacy app/api/v1/operations/[id]/cancel/route.ts:39-45 and rework "
        "modules/lifecycle/lifecycle.ts:42-50,64-68 - and the receipt explicitly does NOT bless either side; (4) dialect split is correctly "
        "stated: public operations cursor = base64url '<canonical timestamp>|<uuid>|<field:direction>[|p]' via encodeOperationsListCursor "
        "(server.ts:1771-1803,3382-3414), admin 4-slot codec base36-microseconds|encoded-id|sort-code|n-or-p at :2719-2743,3511-3523,3723-3735 "
        "and the admin codec does NOT serve the public list; (5) legacy download has no rework equivalent and falls to generic 404 "
        "(server.ts:716-720,2746) - verified; (6) rework result envelope costMicrousd + EncryptedResultEnvelope alternative correctly cited at "
        "operations.ts:160-196. HARD CHECKS PASS: no fake CANCELLED, no identity-header fixture technique, no fabricated field or status code, "
        "WAITING_INPUT vs WAITING_USER_INPUT left unmapped as required."
    ),
    "ctx_task_file_admission_delta": (
        "coordination/reports/tester.md:12286 section on file-admission delta (11m32s, done 12:29). Read-only, no source/gates changed, no tests "
        "run. C4 VERIFIED against real code this cycle - THE HEADLINE FINDING HOLDS: legacy rejects .docm at TWO sites "
        "(lib/upload.ts:30-34 'E06: Reject .docm (macro-enabled Word)' and :82-83 second validator), while rg -ci docm over "
        "du-rework/services/orchestrator/src + du-rework/packages + du-rework/businesses returns ZERO hits - rework implements NO macro-rejection "
        "rule anywhere. The receipt labels rework .docm acceptance and extension/MIME mismatch MUST-NOT-REPLICATE (not a fix proposal) and "
        "states admission relies on metadata + hashes rather than magic-byte sniffing on either side. HARD CHECKS PASS: no validation rule, "
        "allow-list, MIME map or remediation proposed; macro rule treated as a security control; no file_urls/SSRF re-description beyond the cap "
        "explanation; no balance/spend numbers; no gate tick."
    ),
    "ctx_task_profile_lock_override_depth": (
        "reports/codex-profileendpoint-lock-override-field-inventory-2026-10-01.md (19417 B, 12:05). Read-only inventory. C4 VERIFIED against "
        "real code this cycle - 5 NEW MUST-NOT-REPLICATE findings, 4 of which are not in any prior receipt: (1) '_workflowPrompts.isLocked "
        "ignored' CONFIRMED at lib/pipelines/workflow-engine.ts:363-368 - the comment at :365 documents the '{value,isLocked}' shape but the code "
        "only reads params._workflowPrompts.value and drops the flag; (2) 'disabled service row can be shadowed' CONFIRMED at "
        "lib/endpoints/profile-resolver.ts:31-42 - the exact (apiKeyId,endpointSlug) query at :30-34 returns the first row WITHOUT an enabled "
        "predicate, and runner.ts:177-185 checks only that returned row, so an enabled exact row defeats a disabled service-level row; (3) "
        "'broad override deletion' CONFIRMED at app/api/internal/ext-overrides/route.ts:147 - DELETE where(eq(connectionId),eq(apiKeyId)) carries "
        "no endpointSlug/stepId, so it wipes every override for that key+connection; (4) 'workflow enabled check absent' and 'client prompt "
        "outranks scoped stored prompt' cited to app/api/v1/workflows/route.ts:15-48,88-95 and :49-95 respectively; (5) locked-field gate is "
        "presence-based (form.has(key) at profile-resolver.ts:74-87 -> forbidden-field 400), matching the receipt's 'presence not equality' "
        "characterization. The URL-policy-bypass finding duplicates the already-settled ingest receipt and is cross-referenced, not re-derived. "
        "HARD CHECKS PASS: inventory only, no remediation proposed, no gate tick."
    ),
}

missing = []
for key, receipt in RECEIPTS.items():
    e = disp.get(key)
    if e is None:
        missing.append(key)
        continue
    e["status"] = "settled"
    e["receipt"] = receipt
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key, flush=True)

if missing:
    print("MISSING KEYS:", missing, flush=True)

# 4568d175 is at 79.6% ctx with a broken scripted append (exec.js:4:1112 expecting ',') and no receipt after repeated reads.
# Single nudge, recorded, no repeat.
h = "term_4568d175-fdf8-4ff6-8916-9e787e232a58"
NUDGE = (
    "Coordinator: your ctx is at 79.6% and your scripted-append tool keeps failing (exec.js:4:1112 expecting ','). "
    "Stop trying to fix the script. Finish the variant input field matrix by writing the final section DIRECTLY with your "
    "normal file-write tool, appending plain text to the report - no JS exec, no orchestration of other files. If it does not "
    "fit, write a concise summary section instead. One section, no further tool repair."
)
r = subprocess.run([ORCA, "terminal", "send", "--terminal", h, "--text", NUDGE, "--enter", "--json"],
                   capture_output=True, text=True, timeout=180, encoding="utf-8", errors="replace")
try:
    ok = json.loads(r.stdout).get("ok")
except Exception:
    ok = False
print("[NUDGE] 4568d175 ok=%s" % ok, flush=True)

k = "ctx_task_variant_input_field_matrix"
if k in disp:
    disp[k]["lastNudgeAt"] = NOW
    disp[k].setdefault("blocker", None)
    if disp[k].get("consecutiveUnfinishedChecks", 0) < 3:
        disp[k]["consecutiveUnfinishedChecks"] = 0

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(e["status"] for e in disp.values())
print("watch-state total", len(disp), dict(c))
