#!/usr/bin/env python3
# Coordinator cycle 10:00 — settle 3 + dispatch wave 5 (Claude session, user-authorized)
import json, subprocess, collections, os
os.chdir(r"D:\Git\dugate\du-rework")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T10:00:00+07:00"

TASKS = [
 ("task_compat_mount_surface",
  "COMP-00/03 read-only: the entire compat layer is UNMOUNTED — map the full surface",
  "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
  "Your consumer inventory (reports/qwen-platform.md:5008, section 53) is SETTLED and it produced the single most important COMP fact of this window: grep 'compat/' in services/orchestrator/src/server.ts returns 0 hits, so the whole compat layer is dead code on the wire. I verified independently: server.ts compat refs = 0, and legacy-action-router is imported only by its own test. Your boundary language on the three GET routes ('khong thay consumer trong repo khong tuong duong khong co consumer') and your refusal to self-decide are exactly right; the four open questions are now inputs to COMP-00 and I am not resolving them. New READ-ONLY task, same axis: enumerate the ENTIRE compat surface and say precisely what mounting it would require. Sources: services/orchestrator/src/compat/ (legacy-wire-decoders.ts, legacy-action-router.ts, legacy-operations.ts, legacy-submit.ts if present, any others), their test files, and every import site across rework src. Deliverable: (1) a table of each compat module - purpose, exports, test coverage, currently-mounted YES/NO, and who calls it; (2) for legacy-action-router specifically, its self-declared host contract at :10-17,183-194,360-367 (host must split the request, form?: unknown) - list every capability it does NOT provide (multipart parsing, artifact creation, upload, SSRF, size limits) so nobody mistakes an existing adapter for a mounted one; (3) what a minimal mount would have to add to server.ts, listed as changes only, NOT implemented. HARD CHECK: an adapter that is written and tested but never mounted is a GAP, not parity - do not report decoder coverage as wire coverage. Limits: read-only; write only your own report; no source edits; no gate ticks; never modify server.ts."),

 ("task_legacy_route_surface_map",
  "COMP-00 substrate: complete legacy-route -> rework-route surface map (parity/defer/absent)",
  "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "Your idempotency characterization (reports/codex-new.md:545) is SETTLED. It passed my hard check on the replay-200 disposition (I verified server.ts:1751 'result.replayed ? 200 : 202'), and it surfaced two mismatches I recorded in the COMP plan: expires_at is checked in only ONE place (submission.ts:687) while the in-transaction lookup at :269-280 does not check it with no expiry-delete path found, and POST ?sync=true is not implemented on the active route. The 'do not weaken the 200-only-when-done semantic to match legacy' instruction will be carried into COMP-00. New READ-ONLY task, complementary axis. COMP-00 cannot be signed while nobody has a complete picture of WHICH legacy routes exist and what each maps to. Task: build the definitive route surface map. Sources: every route file under app/api/v1/** and app/api/internal/** (method + path + auth mechanism + response shape class), middleware.ts (what it actually guards and what it strips), and rework services/orchestrator/src/server.ts route table. Deliverable: one row per legacy route with columns legacy method+path -> legacy file:line -> auth in legacy -> rework counterpart method+path (or ABSENT) -> classification (PARITY-NEEDED / DEFER / RETIRE-OR-KEEP-decision / HARDENING-MUST-NOT-REPLICATE / NEW-BUILD) -> owner COMP-xx or ORCH-PAR-xx. HARD CHECKS: (1) classify by what the handler DOES, not by path similarity - a route that exists but never guards tenant is not parity; (2) every legacy security defect you touch gets MUST-NOT-REPLICATE, specifically client-supplied x-api-key-id/apiKeyId, ADMIN-key fallback, fail-open when the header is absent, the unguarded ext-connections test route, and rate limiting keyed on the first 16 chars of a caller-supplied key; (3) do not tick anything and do not decide defer vs retire - mark those decision-owner Product. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_ssrf_guard_inventory",
  "SEC/COMP-03 read-only: URL-fetch guard inventory in rework + where file_urls must plug in",
  "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "Your input-bridge characterization (reports/codex-comp03-input-bridge-characterization-2026-10-01.md) is SETTLED and it is the most security-relevant receipt of the window. I verified your two central claims myself: upload-encryption-gateway.ts:711-732 validates only mimeType/fileName/sizeBytes syntax (grep assertSafeUrl|adjudicateUrl|ssrf in that file = 0 hits), and legacy-wire-decoders.ts:403-412 only checks 'is a JSON array' with no 20-entry cap and no destination check. Your point that sourceUrl validation does not cover file_urls entries, and that the legacy fileUrlFieldName branch bypasses the local downloader's guard entirely, are both recorded in the COMP plan. New READ-ONLY task that follows directly from your finding. Task: inventory every URL-fetch guard that actually exists in rework TODAY, and specify where a file_urls bridge must plug in so it cannot be bypassed. Sources: packages/egress (DNS-rebinding-safe fetch, PR-Q3-03/09), lib/file-url-downloader.ts assertSafeUrl semantics in legacy, lib/pipelines/processors/http-client.ts legacy scheme/private-IP/dns fail-closed rules, and in rework the egress package entry points, submission.ts adjudicateUrlDestination for sourceUrl, ingress.ts, and any fetch( calls across services/orchestrator/src and services/connector/src. Deliverable: (1) table of each guard - name, file:line, what it blocks, whether it fails closed on DNS error, whether it re-checks on redirect, and which call sites actually use it; (2) a coverage matrix of every rework code path that can cause a server-side HTTP fetch, marked guarded or not; (3) the single recommended choke point for file_urls, with the reasoning. HARD CHECKS: (1) do not assume a helper existing means it is enforced - cite the call site or say 'defined, no caller'; (2) legacy fails-open cases must be marked MUST-NOT-REPLICATE; (3) do not propose plaintext fallback or a trust flag that lets a caller disable the guard. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_openapi_contract_drift",
  "COMP-11 read-only: docs/21-openapi.json vs real server.ts route reality (no serialize-point edit)",
  "term_949d489b-0ce8-4242-a8c2-988362192922",
  "Your workflow runtime characterization (reports/tester.md:11702) remains settled from an earlier cycle, and its two headline findings - legacy routes accept a form apiKeyId then fall back to the earliest ADMIN key, and the schema interpreter lives in the legacy app while P9-04 forbids putting it in the Orchestrator - are still accurate and referenced in later dispatches. New READ-ONLY task. CONTEXT: docs/21-openapi.json is a serialize-point (one owner at a time) so you must NOT edit it, and no lane is editing it right now - this is purely a discrepancy report. COMP-11 will later require syncing docs to code, and the gate opens faster if we know the delta. Task: compare docs/21-openapi.json against services/orchestrator/src/server.ts as it exists now. Capture three lists. (1) PATHS IN DOCUMENTATION BUT NOT IMPLEMENTED: every path whose handler cannot be found in server.ts, with the doc pointer and what it claims. (2) PATHS IMPLEMENTED BUT NOT DOCUMENTED: every route in server.ts absent from the spec - I expect admin audit, admin crypto-config, /api/v1/uploads and its children, /api/v1/usage, and /api/runtime/v1/workspace-reference among them, but find them systematically rather than trusting this list. (3) SHAPE MISMATCH: same path in both, different method/status/field. Also check whether the generator tools/openapi/gen_openapi.py reproduces docs/21 unchanged when run (it is code-derived and has a no-lost-path guard) - report the diff only, do NOT leave the generated file modified. HARD CHECKS: (1) absence from the spec is not a defect if the route is deliberately internal - classify rather than judge; (2) legacy /api/v1/docs/* routes are absent from BOTH rework server.ts and the spec, so they belong to the COMP-00 scope, not to a docs bug - do not conflate them; (3) do not edit docs/21, server.ts, contracts, or any gate. Limits: read-only; write only your own report; revert any accidental generator output before finishing."),
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
 "ctx_task_comp00_consumer_inventory": "reports/qwen-platform.md:5008 (section 53; 3 GET routes NO consumer in workspace -> defer not retire; webhook_url = real parity; COMPAT LAYER UNMOUNTED - server.ts compat refs = 0; 4 questions handed to COMP-00)",
 "ctx_task_legacy_idempotency_char": "reports/codex-new.md:545 (behavior table + 6 MISMATCH; replay always 200 both sides; expires_at checked only at submission.ts:687; POST ?sync=true unimplemented)",
 "ctx_task_input_bridge_char": "reports/codex-comp03-input-bridge-characterization-2026-10-01.md (legacy field precedence; no multipart path in rework; file_urls SSRF gap verified: gateway 0 url-guard, decoder syntax-only, fileUrlFieldName branch bypasses assertSafeUrl)",
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
