#!/usr/bin/env python3
# Coordinator cycle 09:40 — settle + dispatch wave 4 (Claude session, user-authorized)
import json, subprocess, collections, os
os.chdir(r"D:\Git\dugate\du-rework")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T09:40:00+07:00"

TASKS = [
 ("task_comp05_projection_char",
  "COMP-05 read-only: legacy result/metadata projection semantics vs rework",
  "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
  "Your auth-fence inventory (reports/codex-legacy-auth-fence-inventory-2026-10-01.md) is SETTLED. Hard check PASSED: it classifies caller-supplied x-api-key-id and admin-key fallback as MUST-NOT-REPLICATE and states the constraint that identity must be resolved server-side via resolveApiKey-style hash lookup. One extra item worth recording for the SEC lane (do not fix it yourself): your row 27 shows legacy rate limiting uses the first 16 characters of the caller-supplied key as the Redis bucket and fails open on Redis errors - that must not be presented as an auth fence in any compatibility note. New READ-ONLY task. COMP-05 owns the projection from rework artifacts/checkpoints/usage into the LEGACY result and metadata. Characterize that gap. Sources: lib/pipelines/format.ts (formatOperationResponse - the authoritative legacy wire: name/done/metadata{state,pipeline,current_step,progress_percent,progress_message,create_time,update_time,pipeline_steps} + result{output_format,content,extracted_data,pipeline_steps,usage,download_url} + error{code,message,failed_step}); where progress_percent comes from in the legacy engine (engine.ts / workflow-engine.ts) and whether it is ever stuck at 0; how MIME maps to output_format; how usage input/output tokens and cost are accumulated and when they are final vs pending; and the maxInlineBytes / download_url decision point. Then compare with rework: services/orchestrator/src/modules/operations/facade.ts (note line 45 hard-codes progress.percent = 0), the result/artifact path, and the usage recording. Deliverable: field-by-field projection table (legacy field -> where it must come from in rework -> gap class FULL/MISSING/SYNTHETIC) with file:line. HARD CHECK: a projection that invents a value rather than deriving it is a GAP, not parity - in particular do not accept progress_percent = 0 for an in-flight operation, and do not accept {resultRef} as a substitute for result content. Limits: read-only; write only your own report; no source edits; no gate ticks; no contract freeze."),

 ("task_par03_connector_gap",
  "ORCH-PAR-03 read-only: connector create/activate/retire capability gap",
  "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "Your profile/override characterization (reports/codex-comp03-legacy-profile-override-characterization.md) is SETTLED. The MISMATCH that rework profiles.ts does not model parameters/isLocked/defaultLocked/fileUrlAuthConfig/priority is exactly the kind of finding COMP-03 needs, and the instruction that COMP-03 must not count JSON input validation as profile/locked-field enforcement will be carried into the COMP-00 decision. New READ-ONLY task. ORCH-PAR-00 (receipt qwen-admin.md section 66) classified J04 Connector/ext-connection as cutover-required and states rework currently has NO create/activate/retire proxy for it. Verify that claim precisely and size it. Sources: legacy app/api/internal/ext-connections/** (CRUD, activate, state transitions, test), app/api/internal/ext-connections/[id]/test/**, lib/rbac.ts and lib/auth-guard.ts around them, prisma model ExternalApiConnection (URL, authType, authSecret encrypted how?, prompt, response path, session chaining, state); rework services/orchestrator/src/modules/... connectors/profiles plus any admin-actions surface that already proxies connector operations, and modules/admin-actions/rbac.ts for who may call it. Deliverable: capability matrix (legacy operation -> legacy file:line -> rework counterpart or ABSENT -> owner PAR-xx/SEC/Connector) plus the fixture classes a cutover would need (standalone vs container create/activate/invoke, wrong tenant/account, rotate->revoke). Hard check: do NOT treat an in-process mock as deployment proof, and do NOT treat a binding/proxy as a create/activate/retire capability. Secret encryption must be attributed to the Vault/SEC lane, not to Orchestrator. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_services_billing_shape_char",
  "COMP-08 input: legacy /services and /billing/* RESPONSE SHAPES (not consumers)",
  "term_742c2474-7ff2-427d-8db4-f4bd40d16129",
  "Your ORCH-PAR-00 classification is SETTLED (qwen-admin.md section 66). The narrowing of PAR00-M01 - control plane exists and is HTTP-reachable via POST /api/v1/admin/actions but the browse journey is still broken because the form posts /admin/api-keys/new and every non-admin-login match falls through to handleSectionGet regardless of method (shell-router.ts:1565-1568) - is a precise and useful correction. BOUNDARY so you do not duplicate a live task: term_4568d175 is inventorying CONSUMERS of /services, /billing/balance, /billing/usage (who calls them). YOUR task is the opposite axis: the RESPONSE SHAPES themselves. READ-ONLY. Sources: app/api/v1/services/route.ts, app/api/v1/billing/balance/route.ts, app/api/v1/billing/usage/route.ts. Capture per route: request params accepted, response body field-by-field with types and nullability, what the values actually derive from (in particular whether balance derives from the key's own spending limit/totalUsed or from something else), currency and cost units, start_date/end_date semantics for usage, and every path where the handler reads a caller-supplied identifier instead of resolving one (the auth-fence inventory already recorded that all three read x-api-key-id directly - cite it, do not re-argue it). Then compare with rework server.ts usage/billing surfaces and public-api.ts contracts. Deliverable: shape table + MISMATCH list with file:line, feeding COMP-08. HARD CHECK: if legacy balance is computed rather than stored, say so plainly - COMP-08 forbids fabricating a balance from tenant usage and forbids silently changing a key total into a tenant total. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_par04_schema_gap",
  "ORCH-PAR-04 read-only: workflow schema authoring capability gap (P9-04)",
  "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
  "Your fixture-spec receipt (reports/tester.md:11850) is SETTLED and it is a good result. Doing exactly what was asked: you probed for a live legacy instance, found none (ports 2023/3000 down, docker holds only rework infra), said so plainly, delivered option (2) executable fixture specs instead of inventing observations, and flagged the matrix's own table arithmetic. That discipline is what the review loop needs. New READ-ONLY task. ORCH-PAR-00 (qwen-admin.md section 66) classified J05 Workflow schema authoring as cutover-required and states rework has NO capability for it; COMP-09/P9-04 requires the schema BUSINESS capability to exist without placing the schema interpreter in the Orchestrator. Size and verify that gap precisely. Sources: legacy app/api/internal/workflow-schemas/** and the public POST /api/v1/docs/workflows/schema (app/api/v1/docs/workflows/schema/route.ts) - what a schema author can actually create, store, version, validate (negative graph / XXE), submit, and delete; lib/workflow-builder/{loader,run-schema,interpreter,real-exec}.ts - where the interpreter lives and what depends on it; legacy tests under tests/workflow-builder/**. Then rework: services/orchestrator/src - search for any workflow-schemas route or store (a prior check found 0 matches in rework src), and what workflow runtime exists instead (modules/runtime, business actions). Deliverable: capability matrix (authoring operation -> legacy file:line -> rework counterpart or ABSENT -> owner) plus the fixture classes for a cutover (schema migrated submit->poll/result/HITL, negative graph/XXE, rollback). HARD CHECK: state plainly where the interpreter must live if it must not live in the Orchestrator, and do not report a runtime executor as an authoring capability. Limits: read-only; write only your own report; no source edits; no gate ticks."),
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

# review note to the still-appendying matrix lane
note = ("GHI CHU COORDINATOR (khong doi task cua ban): COMP-01 matrix cua ban da SETTLED, hard check 31/31 DAT. "
        "Mot nhat ky xet duyet dua ra 2 diem can ghi chu, ban tien tinh ghi vao matrix neu ban dong y: "
        "(1) M-06: counts table ghi 22 declared / 15 attached (implies 7 unattached) nhung prose ghi 6. "
        "Nguyen nhan: 'type' bi dem vao bang ma no khong phai param - no la DISCRIMINATOR cua extract (registry.ts:116, doc rieng o runner.ts:106). "
        "Nen 6 param that su bi drop silently: focus_areas, target_language, glossary, redact_patterns, max_words, audience. "
        "Giai ma bang, giu prose 6. "
        "(2) M-16 (initial state is RUNNING, never ACCEPTED) duoc nhan dang cao cho migration, khong phai chi M-06/M-10/M-12. "
        "Bo sung ghi chu. KHONG sua source; chi ghi chu trong report cua ban.")
s = orca(["terminal", "send", "--terminal", "term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc", "--text", note, "--enter", "--json"])
print("note->27eb3380:", s.get("ok"), flush=True)

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
 "ctx_task_par00_classify": "reports/qwen-admin.md:6042 (section 66 / TURN 344; J01..J10 classification; PAR00-M01 narrowed; PAR-00 kept [ ])",
 "ctx_task_legacy_live_fixture_replay": "reports/tester.md:11850 (option 2 - executable fixture specs; live legacy NOT reachable, probes recorded; corrected matrix M-06 6-vs-7)",
 "ctx_task_profile_override_char": "reports/codex-comp03-legacy-profile-override-characterization.md (68 lines; precedence table; rework profiles.ts does NOT model parameters/isLocked/defaultLocked)",
 "ctx_task_legacy_auth_fence_char": "reports/codex-legacy-auth-fence-inventory-2026-10-01.md (42 lines; MUST-NOT-REPLICATE for x-api-key-id selection + admin-key fallback + optional-header fence)",
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
