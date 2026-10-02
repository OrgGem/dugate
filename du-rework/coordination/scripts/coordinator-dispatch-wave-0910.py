#!/usr/bin/env python3
# Coordinator dispatch wave 2 — 2026-10-01 09:10 +07 (Claude session, user-authorized)
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T09:10:00+07:00"

TASKS = [
 ("task_keyset_planner_flake_fix",
  "Stabilize admin-keyset-explain created_at planner-sensitive test (test-only)",
  "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "Test-only fix with existing evidence. Suite tests/admin-keyset-explain.test.ts: run1 18/18 PASS, run2 17/18 FAIL only on the created_at backward-hop case because PostgreSQL chose Seq Scan + Sort instead of the expected Index Cond on ROW(created_at,id). Receipt: reports/tester.md:11693; raw: reports/raw/admin-keyset-explain-live-x3.log. The three stale index-name assertions are ALREADY fixed (matcher at :162 is 0019-aware) - do not touch them again. Goal: make the created_at plan assertion planner-tolerant OR pin the planner (e.g. SET enable_seqscan=off for that session/transaction) so the semantic check still binds. Acceptance: live suite green x3 consecutive runs with DU_LIVE_INFRA=1, receipt + raw log appended to tester.md. HARD LIMIT: if the index is genuinely not chosen at realistic scale, STOP and report a product/perf finding instead of weakening the semantic assertion. Do not weaken the deadline assertions. Do not touch src/. Do not tick any gate."),

 ("task_legacy_webhook_char",
  "Legacy webhook wire contract characterization (payload, auth, retry, failure)",
  "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "READ-ONLY. Characterize legacy webhook callback behavior and compare with rework. Legacy: search app/ + lib/ for webhook_url handling on operations (submit.ts, pipelines, engine.ts, workflows routes), the POST payload shape sent to the client, any signature/HMAC header, retry policy, timeout, failure state on the operation, and whether the delivery is fire-and-forget. Rework: du-rework/services/orchestrator/src/modules/... webhooks + the known items DELTA-120 (HMAC computed over ciphertext => receiver contract change) and DELTA-121 (webhook_deliveries.payload still plaintext in DB). Output: table legacy vs rework (payload fields, auth, retry count/backoff, state on failure, encryption) with file:line, plus MISMATCH list feeding COMP-05/COMP-08 encryption rollout. Note explicitly whether a legacy client would break under rework's ciphertext HMAC. Do NOT decide policy. Limits: read-only app/ and rework source; write only your own report; no source/docs/plan edits; no gate ticks."),

 ("task_profile_override_char",
  "Profile / override / locked-field semantics (profile-resolver + overrides)",
  "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "READ-ONLY. Characterize legacy client-profile override machinery feeding COMP-03 validation. Sources: lib/endpoints/profile-resolver.ts, app/api/internal/profile-endpoints/**, app/api/internal/ext-overrides/**, lib/endpoints/registry.ts (ProfileEndpoint fields), lib/pipelines/submit.ts (where overrides are applied). Capture: precedence order (connection default -> profile -> override), locked params (what is forbidden to override and what error is returned), prompt override fields and scope (connection, apiKey, endpointSlug, stepId), fileUrlAuthConfig and allowedFileExtensions, job priority, and whether an override can change tenant/key/encryption. Compare with rework profile/connector modules and record MISMATCHes (COMP-03 needs validate profile/locked fields + prompt-override denial). Output: precedence + field table with file:line into your own report. Limits: read-only; no source/docs/plan edits; no gate ticks."),

 ("task_legacy_auth_fence_char",
  "Legacy vs rework auth/fence characterization (defensive inventory for COMP-00)",
  "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
  "READ-ONLY, DEFENSIVE. Inventory how legacy authenticates /api/v1/* and how rework does, so COMP-00 can make an explicit hardening decision. Legacy: middleware.ts (the x-api-key -> sha256 resolve vs the x-api-key-id / x-user-id / x-user-role strip branch), lib/endpoints/runner.ts:88-110 (the CORRECT resolve pattern), RBAC lib/rbac.ts, rate-limit lib/rate-limit.ts, and any place a client-supplied id selects tenant/key. Rework: services/orchestrator/src/server.ts public-key resolve + admin principal authorization, and the fence on operations list/detail. Deliverable: a table legacy fence vs rework fence per surface (docs submit, operations list/detail/cancel/resume/download, internal admin), classifying each legacy behavior as HARDENING-CORRECT-IN-REWORK / MUST-NOT-REPLICATE / NEEDS-COMP-00-DECISION, with file:line. HARD LIMIT: this is documentation of defects to avoid, not a proposal. Do NOT propose copying any client-supplied x-api-key-id selection, admin-key fallback, or unfenced read; any compat note must require resolveApiKey-style server-side resolution. Read-only; write only your own report; no source edits; no gate ticks."),
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
    out = s.get("ok")
    t = orca(["orchestration", "task-create", "--spec", spec, "--task-title", title,
              "--display-name", title, "--run", RUN, "--json"])
    tid = ((t.get("result") or {}).get("task") or {}).get("id") or t.get("id") if t.get("ok") else None
    print(f"{key} | send={out} | task_create={t.get('ok')} id={tid}", flush=True)

with open('coordination/agent-watch-state.json', encoding='utf-8') as f:
    w = json.load(f, object_pairs_hook=collections.OrderedDict)
for key, title, handle, spec in TASKS:
    w['dispatches'][f"ctx_{key}"] = collections.OrderedDict([
        ("taskId", key), ("terminalHandle", handle),
        ("lastObservedAt", NOW), ("lastProgressAt", NOW),
        ("transcriptCursor", ""), ("consecutiveUnfinishedChecks", 0),
        ("lastNudgeAt", None), ("blocker", None),
        ("status", "running"), ("receipt", None), ("supervised", True),
    ])
# settle three codex lanes that reported done this cycle
settle = {
 "ctx_task_legacy_pagination_char": "reports/qwen-platform.md:4942 (legacy pagination MISMATCH; helper 27/27 but server.ts does not import it)",
 "ctx_task_golden_test_inventory": "reports/tester.md:11741 (golden fixture inventory: 6 routes + lifecycle + 3 workflows; gaps listed)",
 "ctx_task_legacy_error_char": "reports/codex-legacy-error-inventory-2026-10-01.md (3 legacy serializers; lib/errors.ts unused; urn:du:error vs dugate.vn/errors/*)",
}
for k, r in settle.items():
    if k in w['dispatches']:
        w['dispatches'][k]['status'] = 'settled'
        w['dispatches'][k]['receipt'] = r
        w['dispatches'][k]['lastObservedAt'] = NOW
w['lastCheckedAt'] = NOW
with open('coordination/agent-watch-state.json', 'w', encoding='utf-8') as f:
    json.dump(w, f, ensure_ascii=False, indent=2)
    f.write('\n')
print("watch-state updated: total", len(w['dispatches']))
