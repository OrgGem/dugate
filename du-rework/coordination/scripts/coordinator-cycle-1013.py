#!/usr/bin/env python3
# Coordinator cycle 10:13 — settle 4 + dispatch wave 6 (Claude session, user-authorized)
import json, subprocess, collections, os
os.chdir(r"D:\Git\dugate\du-rework")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T10:13:00+07:00"

TASKS = [
 ("task_usage_cost_reconciliation",
  "COMP-05/08 + COST read-only: usage and cost have TWO independent sources - characterize the divergence",
  "term_742c2474-7ff2-427d-8db4-f4bd40d16129",
  "Your services/billing shape characterization (reports/qwen-admin.md section 67, MISMATCH list at 67.5) is SETTLED. I verified your two hard checks myself: balance IS computed at request time, not stored - app/api/v1/billing/balance/route.ts:35-37 gives spendingLimit > 0 ? spendingLimit - totalUsed : null, taken from the SAME key's own columns (apiKeys.spendingLimit, apiKeys.totalUsed), so it is KEY-scoped and NOT tenant-scoped; and end_date really does append 'T23:59:59Z' at usage/route.ts:35 while start_date does not, so a full ISO timestamp 400s on one but not the other. Your M-05 - two independent sources for the same number with no reconciliation - is the thread I want pulled next. Also noted: you selected status (route.ts:28) but never return it, so a revoked key still reports balance normally; and updated_at is new Date() at request time while apiKeys.updatedAt exists and is not selected. READ-ONLY follow-up. Sources: legacy lib/db/schema.ts:54-63 (totalUsed/spendingLimit columns, who updates them - find the write site), legacy operations cost column (SUM(operations.totalCostUsd) you cited), where legacy increments totalUsed (submit? worker on completion? on failure?), and rework du-rework/services/orchestrator/src/modules/usage/usage.ts (project(), events, costMicrousd), packages/contracts/src/runtime.ts usage event schema, plus any rework operation/cost ledger columns. Deliverable: (1) a write-path map for each of the two numbers - exact file:line where it is incremented, under what transaction, and what happens on failure/retry/cancel; (2) enumerate every condition under which the two numbers can disagree (failure after partial usage, retry, cancel, backfill, currency/unit conversion), each with the code path; (3) the unit and losslessness analysis: FLOAT USD vs microusd integer, and whether a round-trip transform can be exact. HARD CHECKS: (1) do not propose computing balance from tenant usage - COMP-08 forbids it; (2) do not recommend silently changing a key total into a tenant total; (3) if the two numbers were never reconciled by design, say that plainly rather than inventing a reconciliation rule. Limits: read-only; write only your own report; no source edits; no gate ticks; no new field/DTO/URL names (COMP-08 owns those)."),

 ("task_par01_admin_session_gap",
  "ORCH-PAR-00 verification pass 2: J01 Admin login/session, J02 API key admin, J03 auth-key admin - confirm or refute section 66",
  "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "Your J04 connector inventory (reports/codex-j04-connector-capability-inventory.md) is SETTLED. Three things in it are worth more than the headline: (1) it confirmed section 66 but bounded it correctly - the Connector service does have revision create/activate/retire/disable/test, so what is absent is specifically the Orchestrator Admin proxy for the legacy ExternalApiConnection config, and 'do not count a health probe or a profile binding as lifecycle parity' is the right standard; (2) the legacy app/api/internal/ext-connections/[id]/test/route.ts has NO requireAuth/requireAdmin call at all while CRUD does - a legacy exposure to characterize, not to reproduce; (3) authSecret is a plain text column inserted raw with the AES helper unused on that path, correctly assigned to SEC/Vault. New READ-ONLY task, same method: verify section 66's claims for J01, J02 and J03 instead of trusting them. Sources - legacy first: app/api/auth/** and lib/auth.ts (credentials + OIDC login, session cookie, what the session actually binds to), app/api/internal/apikeys/** and app/api/internal/auth-key/** (CRUD, rotation, activation, RBAC gate used, masking, hashing), lib/rbac.ts and lib/auth-guard.ts (what requireAuth/requireAdmin really check), any rate-limit or lockout on login. Then rework: services/orchestrator/src/modules/auth/** (local + OIDC, redis session repo), admin-actions/rbac.ts and dispatcher.ts (who may rotate/revoke/activate an API key), and whatever API-key management surface exists in src/app/admin. Deliverable per journey: capability matrix (operation -> legacy file:line -> rework counterpart or ABSENT -> owner ORCH-PAR-xx/SEC) plus the cutover fixture classes (login success/failure/expired, wrong-role, unauthenticated, rotate->revoke, self-service vs admin, CSRF on cookie mutation). HARD CHECKS: (1) confirm or REFUTE - an honest 'this is present and matches' is as valuable as a gap, do not assume a gap exists; (2) any legacy behavior that lets a caller influence its own identity (form/header-provided id, admin fallback, fence skipped when header absent) must be MUST-NOT-REPLICATE; (3) do not treat 'a cookie exists' as an authorization decision - cite what is actually checked. Limits: read-only; write only your own report; no source edits; no gate ticks; do not tick ORCH-PAR-00."),

 ("task_comp05_projection_fixture_spec",
  "COMP-05 executable fixture spec: legacy result/metadata wire, predicted exactly, runnable later (no live legacy available)",
  "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
  "Your COMP-05 projection gap report (reports/codex-comp05-result-projection-gap-2026-10-01.md) is SETTLED and it passed my hard checks. I verified three anchors myself: adapter at compat/legacy-action-router.ts:315-331 does build download_url unconditionally with ?? 0 / ?? null / ?? [] defaults; grep for an operation-level download route in server.ts returns 0 hits so that URL points at nothing; and usage.project() (modules/usage/usage.ts:357-376) really does return measurement pending when count is 0 and never sums pages - so dropping the measurement marker and defaulting to 0 IS a synthetic gap, exactly as you classified it. Your SYNTHETIC vs MISSING vs FULL discipline, and the sentence that { resultRef } cannot stand in for legacy result.content, are what COMP-05 needs. New READ-ONLY task, one step further, and there is a precedent: an earlier lane found no reachable legacy instance (ports 2023/3000 down) and correctly produced an EXECUTABLE FIXTURE SPEC instead of inventing observations (reports/tester.md:11850). Do the same for your projection table. Task: turn each legacy field in your table into an executable assertion spec. For every field: exact legacy request (method, path, multipart/JSON fields, headers), predicted status, predicted response key with type and nullability, and the legacy code line that makes that prediction (formatOperationResponse and its inputs). Then, for each of the 6 + 3 non-FULL rows you classified MISSING or SYNTHETIC, the same rigour applied to rework: what a request would have to be for rework to emit it, and which file:line currently decides it cannot. Group into 4 fixture classes: (A) success full result, (B) in-flight metadata (where progress_percent=0 must be flagged as the synthetic prediction, not as expected parity), (C) failure envelope, (D) large result forcing the download_url/content split. HARD CHECKS: (1) state plainly which of the two you produced - a live-verified observation is not achievable here, so say spec, not observed; (2) never write an assertion that blesses a synthetic value as correct - a prediction of progress 0 is a prediction of a GAP; (3) do not invent a maxInlineBytes threshold if none exists - you already found no such decision point, so record that absence. Limits: read-only; write only your own report; no source edits; no tests executed; no gate ticks; no contract freeze."),
]

def orca(args, timeout=90):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:200]}

for key, title, handle, spec in TASKS:
    s = orca(["terminal", "send", "--terminal", handle, "--text", spec, "--enter", "--json"])
    t = orca(["orchestration", "task-create", "--spec", spec, "--task-title", title,
              "--display-name", title, "--run", RUN, "--json"])
    tid = ((t.get("result") or {}).get("task") or {}).get("id") or t.get("id") if t.get("ok") else None
    print(f"{key} | send={s.get('ok')} | task_create={t.get('ok')} id={tid}", flush=True)

p = 'coordination/agent-watch-state.json'
w = json.load(open(p, encoding='utf-8'), object_pairs_hook=collections.OrderedDict)
for key, title, handle, spec in TASKS:
    w['dispatches'][f"ctx_{key}"] = collections.OrderedDict([
        ("taskId", key), ("terminalHandle", handle),
        ("lastObservedAt", NOW), ("lastProgressAt", NOW),
        ("transcriptCursor", ""), ("consecutiveUnfinishedChecks", 0),
        ("lastNudgeAt", None), ("blocker", None),
        ("status", "running"), ("receipt", None), ("supervised", True),
    ])
SETTLE = {
 "ctx_task_variant_recipe_gap": "reports/comp-01-characterization-matrix.md section 6 (31-row COMP-04 table VERIFIED by reviewer: 31 rows incl. id-card/fact-check/summarize-eval; MISSING-RECIPE 3 / DISCRIMINATOR-ALIAS 5 / OUTPUT-FORMAT-GAP 23 / MISSING-CONNECTOR 0 = 31; chain-complete 28/31)",
 "ctx_task_services_billing_shape_char": "reports/qwen-admin.md section 67 + 67.5 (16 MISMATCH; balance COMPUTED at request from the SAME key columns -> KEY-scoped not tenant; end_date 'T23:59:59Z' asymmetry; status selected but never returned)",
 "ctx_task_par03_connector_gap": "reports/codex-j04-connector-capability-inventory.md (Orchestrator Admin CRUD/lifecycle ABSENT for ExternalApiConnection; legacy [id]/test route has NO requireAuth; authSecret plaintext -> SEC/Vault; 5 cutover fixtures)",
 "ctx_task_comp05_projection_char": "reports/codex-comp05-result-projection-gap-2026-10-01.md (72 lines; field-by-field FULL/MISSING/SYNTHETIC; progress_percent=0 and ??0 adapter defaults = SYNTHETIC; {resultRef} is a reference not content)",
}
for k, r in SETTLE.items():
    if k in w['dispatches']:
        w['dispatches'][k]['status'] = 'settled'
        w['dispatches'][k]['receipt'] = r
        w['dispatches'][k]['lastObservedAt'] = NOW
    else:
        print("MISSING", k)
w['lastCheckedAt'] = NOW
json.dump(w, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(p, 'a', encoding='utf-8').write('\n')
print("watch-state total", len(w['dispatches']))
