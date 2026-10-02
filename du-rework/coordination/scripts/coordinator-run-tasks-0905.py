#!/usr/bin/env python3
# Register coordinator Run + 9 tasks on it, then dispatch each to its terminal (orca CLI only).
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
NOW = "2026-10-01T09:05:00+07:00"

TASKS = [
 ("task_comp01_matrix", "COMP-01a/01b/01c characterization matrix (31 variants + 3 workflows + lifecycle)",
  "term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc",
  "Read-only characterization from legacy app/ + rework: 6 core routes with 31 sub-cases (discriminator mode/type/task/action, required/optional fields per lib/endpoints/registry.ts, file/file_urls policy, output + target business action), 3 workflows + schema + /services + /billing shapes, lifecycle list/cancel/resume/download/DELETE + pagination + state map. Start from existing du-rework/docs/14-reference-compatibility.md section 'Legacy API spec (from code)'. Record legacy spec-vs-code MISMATCHes (catalog 28 vs 31 incl id-card/fact-check/summarize-eval, comment /api/v1/workflows vs real path /api/v1/docs/workflows, integration guide /api/v1/extract wrong path). Deliverable: matrix + source fixtures with file:line + receipt in own report. Limits: read-only, no source edits, no gate ticks, do not freeze contracts (COMP-02 waits COMP-00)."),
 ("task_comp00_consumer_inventory", "COMP-00 input: inventory real consumers of /services, /billing/*, webhook_url",
  "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
  "Read-only: find which legacy consumers actually call /api/v1/services, /api/v1/billing/balance, /api/v1/billing/usage and webhook_url. Scan app/ (UI, ServiceTestClient, chat), tests/, docs/. Output table: route -> consumer file:line -> usage level -> parity/defer/retire recommendation with reason. This is INPUT for COMP-00 (Product/architect decides; do not decide yourself). Limits: read-only, write only to own report, no source/docs/plan edits, no gate ticks."),
 ("task_legacy_lifecycle_char", "Legacy lifecycle fixtures: cancel/resume/download/DELETE + state semantics",
  "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
  "Read-only characterization of legacy app/api/v1/operations/[id]/{cancel,resume,download}/route.ts and operations DELETE: response/status fixtures per endpoint, state semantics (fake CANCELLED? resume without tenant fence?), plus MISMATCH table vs rework. Coordinator adjudication on your earlier question: on legacy-overlapping paths the LEGACY wire wins ({name, done, metadata, result|error}); {operation_id,status} must not appear on old paths; canonical envelope only on new/opt-in surface; server.ts mount stays serialized to the orchestrator owner lane. Limits: read-only, no source edits, no gate ticks, receipt in own report."),
 ("task_par00_classify", "ORCH-PAR-00: classify Admin journeys/legacy routes cutover-required / post-cutover / retire",
  "term_742c2474-7ff2-427d-8db4-f4bd40d16129",
  "Complete ORCH-PAR-00 classification using tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md plus cross-check against legacy app/: API key, profile, connection, workflow schema, settings, analytics, docs portal. Deliverable: classification table with replacement API / owner / fixtures (input for PAR-02..09). Limits: research only; do NOT tick PAR-00 (acceptance is Product/architect); no source edits; receipt in own report."),
 ("task_keyset_explain_fix", "Fix 3 stale index-name assertions in admin-keyset-explain suite (test-only)",
  "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "Test-only fix: suite admin-keyset-explain currently ExitCode 1 because 3 assertions still expect old index names while live plans use new names (receipt coordination/reports/tester.md:7694). Update ONLY the test assertions, do NOT touch src. Run suite green x3, receipt in tester.md. If red for another reason, report blocker instead of forcing pass. Small task (quota <50%)."),
 ("task_legacy_pagination_char", "Legacy operations list pagination semantics (page_size/page_token/filter)",
  "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "Read-only characterization of app/api/v1/operations/route.ts: page_size cap/default, page_token op-id keyset, filter state list + invalid 400, response {operations, next_page_token}; edge cases (invalid token, cross-tenant when apiKeyId null, empty state). Compare against rework 6-value keyset cursor and record MISMATCHes (cursor dialect leak risk). Output in own report; no source edits, no gate ticks."),
 ("task_golden_test_inventory", "Inventory legacy tests that can seed COMP-10-off golden fixtures",
  "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "Read-only: list existing legacy tests in app/ + tests/ (repo root D:/Git/dugate) usable as golden fixture sources for COMP-10-off across 6 routes + lifecycle (list/detail/cancel/resume/download) + 3 workflows. Output table: file:line, case, output shape, fixture source, into tester.md. Limits: no new tests, no source edits, no gate ticks - inventory for a later wave."),
 ("task_legacy_error_char", "Legacy problem+json error taxonomy inventory",
  "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
  "Read-only: inventory legacy problem+json errors - namespace https://dugate.vn/errors/*, status mapping (400/401/403/404/413/422/429/5xx), shape from lib/errors.ts + apiError() helpers + app/api/v1/** routes; compare with rework canonical error contract and record MISMATCHes. Feeds COMP-02 freeze. Output in own report; no source edits, no gate ticks."),
 ("task_workflow_runtime_char", "Legacy runtime semantics for 3 workflows (disbursement/lc-checker/doc-compare)",
  "term_949d489b-0ce8-4242-a8c2-988362192922",
  "Read-only: characterize legacy workflow runtime - flow from app/api/v1/docs/workflows/route.ts through submit to lib/pipelines/workflow-engine.ts (checkpoint/HITL/resume/parallel), plus POST /api/v1/docs/workflows/schema output shape. Output semantics table + MISMATCH vs rework, feeding COMP-09/P9-04. Limits: read-only app/, no rework source edits, no gate ticks, receipt in own report."),
]

def orca(args, timeout=90):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:200]}

obj = ("du-rework API compat coordination: drive COMP legacy-compat wave, ORCH-PAR-00 inventory, "
       "and independent test/characterization lanes for Qwen + Codex agents. Coordinator: Claude session du-rework-api-compat.")

run = orca(["orchestration", "run-create", "--objective", obj, "--json"])
run_id = ((run.get("result") or {}).get("run") or {}).get("id")
print("run_create ok=", run.get("ok"), "run_id=", run_id)

registered = []
for key, title, handle, spec in TASKS:
    t = orca(["orchestration", "task-create", "--spec", spec, "--task-title", title,
              "--display-name", title, "--run", run_id, "--json"])
    ok = t.get("ok")
    task = ((t.get("result") or {}).get("task") or {})
    tid = task.get("id")
    if not tid:
        # fall back: some builds return top-level id
        tid = t.get("id") if ok else None
    d = {"ok": True, "note": "terminal prompt already delivered at 08:55; register only"}
    print(f"{key}: task_create={ok} id={tid} register={d.get('ok')}", flush=True)
    registered.append((key, tid, handle, ok and bool(tid)))

print("\nREGISTERED:")
for k, t, h, ok in registered:
    print(" ", k, "->", t, "OK" if ok else "FAILED")