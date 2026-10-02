import json, os, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T13:05:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"


def orca_run(args, timeout=240):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False, "raw": (r.stdout or r.stderr or "")[:300]}


w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

# ------------------------------------------------------------------- C2 SETTLE
SETTLE = {
    "ctx_task_legacy_workflow_hitl_wire": (
        "du-rework/coordination/reports/codex-legacy-workflow-hitl-run-wire-2026-10-01.md | "
        "C4 VERIFIED: 202-only, no 200 sync branch; pauseWorkflow -> WAITING_USER_INPUT without setting percent 100 "
        "(workflow-engine.ts:267-268); legacy resume has ZERO expectedStateVersion / no CAS (resume/route.ts:17-32); "
        "enqueueSubStep inserts child with deletedAt: new Date() (workflow-engine.ts:137) so children are invisible to list "
        "(operations/route.ts:37) and 404 on detail; rework resume DOES CAS (runtime.ts:1007-1031) with waitId+input+"
        "expectedStateVersion. The unlabeled apiKeyId/admin-fallback mention is already covered by "
        "codex-legacy-auth-fence-inventory-2026-10-01.md:18 (MUST-NOT-REPLICATE over workflows/route.ts:49-86, incl. the "
        "admin fallback I confirmed at :85). Not a new coverage hole."
    ),
    "ctx_task_legacy_ratelimit_list_query_surface": (
        "du-rework/coordination/reports/codex-legacy-ratelimit-list-query-surface-2026-10-01.md | "
        "C4 VERIFIED: checkRateLimit(key, limit, windowSec=60) at lib/rate-limit.ts:34-38, defaults 100/30 at :66-67, ONLY caller "
        "app/api/internal/auth-key/route.ts:7,18; middleware imports no rate-limit helper; Redis errors fail open (:59-62); bucket from "
        "raw x-api-key[:16] or x-forwarded-for (MUST-NOT-REPLICATE as auth fence, correctly labeled). Legacy ops list page_size has no "
        "min -> NaN/0 derefs items[-1].id at :96-98, and the conditional x-api-key-id fence at :35-38 is defeated by middleware stripping "
        "the header (list-no-resolve) - both correctly labeled. Rework list: 6-name allow-list, clamp [1,100], resolveApiKey tenant fence "
        "(server.ts:1791-1802), foreign tenant 403, x-api-key-id 0 hits in rework server.ts. CLAUDE.md:173 claim correctly called "
        "inaccurate for /api/v1/**."
    ),
    "ctx_task_legacy_pipeline_session_chain": (
        "du-rework/coordination/reports/codex-legacy-pipeline-session-chain-2026-10-01.md | "
        "C4 VERIFIED: registry field is `connections: string[]`, NOT connectionChain (0 hit in lib/endpoints/registry.ts, as the receipt "
        "states); no prompt field in registry (prompt lives on ExternalApiConnection). Session key IS pipelineState['session_id'], capture "
        "external-api.ts:173-185, injected as a multipart field :110-117. currentStep is written at step START (engine.ts:281-293) so a "
        "crash re-runs the last step; content_preview is only the first 500 chars (:365-373). Rework counterpart: sessionRef exists in "
        "contracts/connector but has 0 hits in du-rework migrations and 0 hits in runtime.ts saveStep, and document-core's adapter omits "
        "res.result.sessionRef (worker.ts:305-350,377-401) - the unpersisted-SessionRef delta is real and correctly stated."
    ),
}

for key, receipt in SETTLE.items():
    e = disp.get(key)
    if e is None:
        print("MISSING KEY", key, flush=True)
        continue
    e["status"] = "settled"
    e["receipt"] = receipt
    e["lastObservedAt"] = NOW
    e["consecutiveUnfinishedChecks"] = 0
    e["blocker"] = None
    print("SETTLED", key, flush=True)

# ------------------------------------------------------------------ C3 DISPATCH
# Coverage probes (rg across du-rework/coordination/reports/*.md) confirmed these are
# still UNCOVERED and they feed ORCH-PAR-00, which the current cycle prompt names as
# priority (b). All three are read-only journey inventories; none touch server.ts, none
# tick a gate, none is COMP-02..09.
#
#   rg 'app/api/internal/(apikeys|profile-endpoints|ext-connections|ext-overrides|workflow-schemas|pipeline-mappings)' codex-*.md -> 0
#   rg 'recover-stalled|analytics|bull-board|api/cleanup|api-docs' codex-*.md -> 0
#
# NOT dispatched: term_f1ed751c stays idle this cycle (its title is implementation-flavored);
# term_2b05b203 was mid-compaction at 13:05; the 4 qwen lanes each already have their own
# queued prompt and must receive nothing (4568d175 @81.3% ctx, 742c2474 @77.9%).
PATH_NOTE = (
    "Path reminder: this is a LEGACY-repo read. Legacy shared helpers live under lib/** at the REPO TOP LEVEL, "
    "NOT app/lib/**. Only route handlers live under app/api/**. Do not read the rework service instead - the point is to "
    "characterize what legacy actually does today, so that ORCH-PAR-00 can classify each journey as cutover-required or "
    "post-cutover."
)
COMMON_TAIL = (
    " HARD CHECKS: (1) characterization only - do NOT propose a redesign, a new route shape, a migration or any fix; "
    "(2) every claim carries file:line; if you cannot find it, write 'not found' rather than guessing; "
    "(3) any behaviour you label MUST-NOT-REPLICATE must carry file:line and STOP THERE - do not propose how to fix it; "
    "(4) SECURITY: legacy has a real client-supplied credential-identifier pattern (a form field or x-api-key-id header naming "
    "WHICH key/profile to act as, plus an implicit admin-key fallback). Wherever you see it, label it MUST-NOT-REPLICATE with "
    "file:line and do not restate it as a pattern to follow - compatibility must always resolve and tenant-fence server-side from "
    "the presented credential. (5) encryption must be described as it is: server-policy-driven, fail-closed, no plaintext "
    "fallback - do not describe or propose a bypass; (6) do NOT restate balance, spend or cost numbers; (7) do NOT fake a terminal "
    "operation state - if you see CANCELLED written directly, label it and stop; (8) no gate ticks, no COMP row changes, no edits to "
    "any COMP or ORCH-PAR row. Limits: READ-ONLY with source; write only your own new report file under "
    "du-rework/coordination/reports/; no source edits; no test runs; no commits."
)

SPEC_A = (
    "ORCH-PAR-00 contribution, read-only. Your last characterization is SETTLED and passed my hard checks (I verified the retention "
    "24h EXPIRY_MS at lib/cleanup.ts:16, the deletedAt IS NULL predicate at :50-54, and the S3 dedup FileCache path). New task, same "
    "read-only discipline: inventory the LEGACY API-KEY + USER MANAGEMENT admin/operator journeys. ORCH-PAR-00 in "
    "du-rework/tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md asks for exactly this - inventory the admin/operator journeys and "
    "the API key / profile / connection / workflow schema they use, and classify each as cutover-required or post-cutover. No report in "
    "du-rework/coordination/reports/ covers these routes today (I checked: app/api/internal/apikeys, profile-endpoints, ext-connections, "
    "ext-overrides all have 0 mentions in any codex-*.md). Answer with file:line: (1) THE JOURNEY, end to end: what an operator does from "
    "the UI to a persisted change. Read app/(pages)/profiles/page.tsx and any client component it drives, then the route handlers it "
    "calls - app/api/internal/apikeys/** (CRUD, plus the create-time reveal of the plaintext key and the spending limit / totalUsed / "
    "status fields), app/api/internal/auth-key/** (the self-service rotate / test path), app/api/users/** and "
    "app/api/internal/user-profiles/**. For each route state: method, exact request fields, exact response shape, and the auth/role "
    "check that guards it (ADMIN vs USER vs VIEWER - lib/rbac.ts). (2) CREDENTIAL LIFECYCLE: where a client API key is generated, how it "
    "is hashed at rest, whether the plaintext is ever recoverable, how it is rotated, and what status/limit fields gate its use. Name "
    "the exact hashing function. (3) THE USER MODEL: how a local user (username + bcrypt) differs from an OIDC user (provider, "
    "providerSub, email, displayName) - lib/auth.ts and app/api/auth/**, and where roles are assigned. (4) REWORK COUNTERPART: state with "
    "file:line what rework has today for each of these - the tenant/api-key model in du-rework/services/orchestrator (server.ts routes, "
    "packages/contracts), how rework authenticates a caller, and whether rework has any user-management or role surface at all. (5) "
    "CLASSIFY: a plain table of each journey -> cutover-required (legacy has it, rework must too) or post-cutover (legacy-only, intentionally "
    "dropped), with the file:line that justifies each row. State plainly which legacy admin surfaces have NO rework counterpart today. "
    "Do not choose which side is right; just lay out the delta." + PATH_NOTE + COMMON_TAIL +
    " Write your report to du-rework/coordination/reports/codex-legacy-apikey-user-admin-journeys-2026-10-01.md"
)

SPEC_B = (
    "ORCH-PAR-00 contribution, read-only. Your pipeline step-chain + session chaining characterization is SETTLED and passed my hard "
    "checks - I confirmed the `connections: string[]` field (no connectionChain, 0 hits), the pipelineState['session_id'] capture at "
    "lib/pipelines/processors/external-api.ts:173-185 with multipart injection at :110-117, currentStep written at step START "
    "(engine.ts:281-293), and that sessionRef really has 0 hits in the rework migrations and in runtime.ts saveStep. New task, same "
    "read-only discipline: inventory the LEGACY CONNECTOR / PROFILE / OVERRIDE / SCHEMA-BUILDER admin journeys. ORCH-PAR-00 asks for "
    "exactly this inventory, and no report in du-rework/coordination/reports/ covers these routes today (checked: "
    "app/api/internal/ext-connections, ext-overrides, profile-endpoints, workflow-schemas, pipeline-mappings all have 0 mentions in any "
    "codex-*.md). Answer with file:line: (1) THE CONNECTOR JOURNEY: app/api/internal/ext-connections/** - what an operator registers, the "
    "exact field set (url, authType, authSecret, prompt, promptFieldName, defaultPrompt, sessionIdResponsePath, sessionIdFieldName, "
    "state), how authSecret is stored (encryption at rest - lib/crypto.ts AES-256-GCM, and the ENCRYPTION_KEY env requirement), how a "
    "connector is tested before it is enabled, and the state machine that gates use. (2) THE PROFILE + OVERRIDE JOURNEY: "
    "app/api/internal/profile-endpoints/** and app/api/internal/ext-overrides/** - what a ProfileEndpoint row holds (enabled, lockedParams, "
    "connectionOverride, jobPriority, fileUrlAuthConfig, allowedFileExtensions), what a per-tenant override is scoped to (connection, "
    "apiKey, endpointSlug, stepId), and the precedence rules a consumer must honour - cite lib/endpoints/profile-resolver.ts. (3) THE "
    "SCHEMA-BUILDER JOURNEY: app/api/internal/workflow-schemas/** and pipeline-mappings/** - what a schema-driven workflow is authored as, "
    "how it is validated, and what a pipeline mapping binds. (4) THE UI PATH: which (pages) screens drive each of the above (app/(pages)/"
    "api-connections/page.tsx, profiles/page.tsx, and any workflow-builder screen) - name the components and the fetches so the journey "
    "is traceable end to end. (5) REWORK COUNTERPART: with file:line, what rework has for each - the connector/slot model "
    "(packages/contracts connector.ts), tenant config, and whether rework has ANY per-tenant prompt or param override surface today. (6) "
    "CLASSIFY: a plain table of each journey -> cutover-required or post-cutover with the justifying file:line, and state plainly which "
    "legacy connector/profile surfaces have NO rework counterpart. Do not choose a side." + PATH_NOTE + COMMON_TAIL +
    " Write your report to du-rework/coordination/reports/codex-legacy-connector-profile-admin-journeys-2026-10-01.md"
)

SPEC_C = (
    "ORCH-PAR-00 contribution, read-only. Your legacy workflow RUN wire + HITL characterization is SETTLED and passed my hard checks - I "
    "confirmed 202-only, the WAITING_USER_INPUT pause with no percent bump (workflow-engine.ts:267-268), the ABSENCE of any CAS in the "
    "legacy resume (expectedStateVersion: 0 hits, resume/route.ts:17-32), the hidden child insert at workflow-engine.ts:137, and the "
    "rework resume CAS at runtime.ts:1007-1031. New task, same read-only discipline: inventory the LEGACY OPS-ADMIN / SETTINGS / "
    "OBSERVABILITY journeys. ORCH-PAR-00 needs these and nothing in du-rework/coordination/reports/ covers them today (checked: "
    "recover-stalled, analytics, bull-board, api/cleanup, api-docs all have 0 mentions in any codex-*.md). Answer with file:line: (1) "
    "STALLED-JOB RECOVERY: app/api/internal/recover-stalled/** - what triggers a scan, the interval, the max-retry count before DLQ, what "
    "state a job is moved to, and what the endpoint returns. (2) RETENTION CLEANUP: app/api/cleanup/** (or wherever the manual cleanup "
    "trigger lives) vs lib/cleanup.ts and lib/cleanup-scheduler.ts - who calls what, on what schedule, and which rows are eligible. (3) "
    "QUEUE DASHBOARD: app/api/bull-board/** - what it exposes, to whom, and how it is mounted. (4) ANALYTICS: app/api/internal/analytics "
    "(and any sibling) - what it aggregates, over what window, and whether it is tenant-scoped. (5) SETTINGS: app/api/settings/** and "
    "lib/settings.ts - the AppSetting key-value surface, which values are ENCRYPTED at rest (never print a decrypted secret; name the key "
    "names only), the AI provider/model selection, and the prompt-template presets. (6) DOCS + HEALTH: what app/api/swagger and the "
    "api-docs screen actually serve (the OpenAPI spec's source of truth - is it generated or hand-written?), and what app/api/health checks. "
    "(7) UI: name the (pages) screens and components behind each of the above so each journey is traceable end to end. (8) REWORK "
    "COUNTERPART: with file:line, what rework has for each - the orchestrator admin surface, the bull-board equivalent, health, and the "
    "OpenAPI surface (docs/21-openapi.json is a serialize point - READ it, do not edit it). (9) CLASSIFY: a plain table of each journey -> "
    "cutover-required or post-cutover with the justifying file:line, and state plainly which legacy ops-admin surfaces have NO rework "
    "counterpart. Do not choose a side." + PATH_NOTE + COMMON_TAIL +
    " Write your report to du-rework/coordination/reports/codex-legacy-opsadmin-settings-journeys-2026-10-01.md"
)

DISPATCHES = [
    ("ctx_task_apikey_user_admin_journeys",
     "ORCH-PAR-00 read-only: legacy API-key + user management admin journeys (apikeys, auth-key, users, user-profiles) vs rework",
     "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
     SPEC_A),
    ("ctx_task_connector_profile_admin_journeys",
     "ORCH-PAR-00 read-only: legacy connector/profile/override/schema-builder admin journeys (ext-connections, ext-overrides, profile-endpoints, workflow-schemas) vs rework",
     "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
     SPEC_B),
    ("ctx_task_opsadmin_settings_journeys",
     "ORCH-PAR-00 read-only: legacy ops-admin + settings + observability journeys (recover-stalled, cleanup, bull-board, analytics, settings, swagger, health) vs rework",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     SPEC_C),
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
