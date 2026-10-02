#!/usr/bin/env python3
# Coordinator cycle 10:33 - settle 3 + dispatch wave 8 (Claude session, user-authorized)
import json, subprocess, collections, os
os.chdir(r"D:\Git\dugate")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T10:33:00+07:00"

TASKS = [
 ("task_workflow_three_process_char",
  "COMP-01b read-only: legacy 3 workflows (disbursement/lc-checker/doc-compare) + schemaSlug wire vs rework",
  "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "Your route surface map (reports/codex-new.md:575) is SETTLED. I verified it covers 45 handlers across 32 legacy route files, maps counterparts by behavior rather than path name, and marks the specified auth defects HARDENING-MUST-NOT-REPLICATE while explicitly leaving keep/retire to Product. That discipline is exactly what COMP-00 needs. New READ-ONLY task, next gap in COMP-01b: nobody has characterized the THREE workflows as wire objects. Sources: legacy app/api/v1/docs/workflows/route.ts (the process discriminator, always-202 path), app/api/v1/docs/workflows/schema/route.ts (schemaSlug path, plus the form.get(apiKeyId) at :59 and oldest-ADMIN fallback at :77 you must flag as MUST-NOT-REPLICATE), lib/pipelines/workflow-engine.ts and lib/pipelines/workflows/ (the three registered workflows), plus rework counterparts. Deliverable: (1) per workflow (disbursement, lc-checker, doc-compare): exact legacy request (method, path, fields incl. the process value, required vs optional), predicted 202 + Operation-Location, then the legacy operation shape as it polls; (2) schema workflow: schemaSlug contract, what a valid slug returns, what an invalid one returns, and the auth defects as MUST-NOT-REPLICATE; (3) for each of the three, the rework mapping attempt: does a business/action exist, or is it ABSENT - do not invent a mapping; (4) poll/checkpoint/HITL semantics a legacy workflow client actually observes (does it ever see done:false mid-run, what step info appears). HARD CHECKS: (1) do not alias a workflow to one of the six core actions - plan line 18 forbids it; (2) do not claim parity where rework has no workflow implementation - say ABSENT and name the owner (COMP-09/P9); (3) never suggest reproducing the ADMIN-key fallback. Limits: read-only; write only your own report; no source edits; no gate ticks; do not tick COMP-01 or COMP-09."),

 ("task_webhook_delivery_wire_char",
  "COMP-01 read-only: webhook_url wire - delivery envelope, plaintext-vs-encryption, retry semantics in legacy vs rework",
  "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "Your egress/URL-guard inventory (reports/codex-egress-url-guard-inventory-2026-10-01.md) is SETTLED and it is the most precise guard map of the window. I verified three anchors myself: (1) adjudicateUrlDestination (packages/contracts/src/ip-policy.ts:244-278) really does return NEEDS_RESOLUTION for public names and does no DNS itself, so citing it alone is NOT an SSRF fence - your wording is exact; (2) createPinnedFetch fails closed on resolver exceptions/empty answers and does not follow redirects, matching your table; (3) createConnectorRevisionHttpAdapter is defined with no caller - I confirmed no instantiation site under services/orchestrator/src, so you correctly did not count it as coverage. Your key conclusion - @du/egress protects only source acquisition, webhook delivery, and connector provider transport, and NO guard covers file_urls entries - is recorded. One refinement I verified that sharpens your report: readJsonBaseUrlFromRequest (shell-router.ts:1008-1016) DOES read request.query jsonBaseUrl, and the shell-server.ts:311-331 wrappers override it with the configured base - so the query override exists at 6 call sites but the standard attachAdminShell wiring replaces it. Your 'no default request-controlled path established' is right; the bound is not enforced by a test. New READ-ONLY task on a different axis. Task: characterize webhook_url as a WIRE contract. Sources: legacy lib/pipelines/submit.ts webhook capture, lib/db/schema.ts operation/webhook columns, lib/pipelines/engine.ts:428,467 + workflow-engine.ts (the if operation.webhookUrl branch), the actual fetch call and what body/status/retries it sends, plus failure handling; rework services/orchestrator/src/modules/webhooks/webhooks.ts, server wiring server.ts:905-923, the webhook_deliveries table, and packages/contracts operation schema webhook field. Deliverable: (1) exact legacy delivery payload - full JSON shape of what a legacy client receives on its webhook URL, with file:line; (2) status codes and retry/backoff semantics on failure, and legacy behavior on timeout; (3) the encryption delta: legacy plaintext delivery vs rework delivery-on-ciphertext - quote the rework path and say plainly whether a legacy receiver can still parse it; (4) where webhook_url is accepted from in the request body and whether it is validated as a URL or as a destination. HARD CHECKS: (1) encryption must fail closed - do not propose plaintext fallback or a header/param bypass; (2) do not treat 'a webhook exists' as parity - payload shape is the acceptance object; (3) do not tick any gate. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_local_admin_auth_gap",
  "ORCH-PAR-00 follow-up: adminToken-to-admin cookie, missing local-user identity (LOCAL-00..06), MUST-NOT-REPLICATE list",
  "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
  "Your J01-J03 characterization (reports/codex-j01-j03-auth-apikey-characterization.md) is SETTLED and it earns its keep by refuting rather than assuming. I verified your three headline claims myself: (1) shell-router.ts:529-531 really does compare the presented value to adminToken and return role admin - a shared static token becomes admin identity, so section 66's fixture 'prove ADMIN_TOKEN does not become local identity' is NOT satisfied, and you were right to retain it as MUST-NOT-REPLICATE rather than close it; (2) dispatcher.ts:546 requires tenantId + apiKey params and :560 calls deps.hashApiKey on the caller value - apikey.issue takes a CALLER-SUPPLIED raw key and only hashes it, while legacy generates the key server-side and returns raw once, and there is no apikey.rotate/activate action (dispatcher.ts:105-106 lists only issue/revoke); (3) your J03 conclusion that bind-profile is not legacy policy/override parity is bounded correctly. New READ-ONLY task, same method, one step deeper into local auth. Sources: tasks/ADMIN-LOCAL-AUTH-2026-09-30.md (the LOCAL-00..06 checklist), services/orchestrator/src/app/admin/shell-router.ts login/logout/session/CSRF handling (:522-710, :1018-1060), shell-server.ts boot guards, standalone src/main.ts:105-129 (adminShellCookieSecret not passed), redis-session-repository.ts, admin-actions/rbac.ts + dispatcher.ts role gates, and legacy app/api/auth/ + lib/auth.ts (Credentials JWT carrying db user id/username/role) for comparison. Deliverable: (1) a LOCAL-00..06 status table - each item PRESENT / ABSENT / PARTIAL with file:line evidence, no self-decided completion; (2) the MUST-NOT-REPLICATE list: every rework path where a static/shared token or unverified header becomes identity, each with file:line; (3) the cutover fixture classes for login (success, wrong password, expired session, CSRF missing, role downgrade, OIDC unavailable fallback) mapped to what rework can currently express; (4) what is missing for 'adminToken does NOT become local identity' to be provable by test. HARD CHECKS: (1) do not tick LOCAL-00..06 or ORCH-PAR-00 - the status table is evidence, not verdict; (2) do not treat 'a cookie exists' as authorization - cite the check; (3) if a LOCAL item is genuinely PARTIAL, say PARTIAL rather than closing it as done. Limits: read-only; write only your own report; no source edits; no gate ticks."),
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

p = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
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
 "ctx_task_ssrf_guard_inventory": "reports/codex-egress-url-guard-inventory-2026-10-01.md (adjudicateUrlDestination NEEDS_RESOLUTION != SSRF fence; pinned fetch fails closed, no redirect follow; @du/egress covers source/webhook/connector transport ONLY; file_urls has NO guard; connector-http-store adapter defined with no caller; facade COMP-03 as single choke point)",
 "ctx_task_par01_admin_session_gap": "reports/codex-j01-j03-auth-apikey-characterization.md (J01 adminToken-to-admin cookie verified shell-router:529-531, ADMIN_TOKEN fixture NOT satisfied -> MUST-NOT-REPLICATE; J02 apikey.issue caller-supplied raw key, no rotate/activate, Admin HTML mutations ABSENT; J03 bind-profile != legacy policy/override parity; no gate ticked)",
 "ctx_task_legacy_route_surface_map": "reports/codex-new.md:575 (45 handlers / 32 legacy route files; behavior-mapped not path-mapped; auth defects HARDENING-MUST-NOT-REPLICATE; keep/retire left to Product)",
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