#!/usr/bin/env python3
# Cycle ~12:55. C2 settle 5 receipts (theme, variant matrix, progress wire,
# retention/soft-delete, operation-surface cache). C3 dispatch 3 new read-only
# COMP-01/COMP-09 characterizations on topics verified UNCOVERED in reports/.
import json, subprocess, collections

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T12:55:00+07:00"
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

# ---------------------------------------------------------------- C2 SETTLE
SETTLE = {
    "ctx_codex3_cf_theme": (
        "coordination/reports/tester.md section 'W-ADM-UX-01-CLOUDFLARE-THEME' (recorded 12:37, done 12:38). "
        "CSS-only Cloudflare flat theme in services/orchestrator/src/app/admin/shell-render.ts. Receipt evidence: "
        "pnpm --filter @du/orchestrator test -- tests/admin-shell-render.test.ts -> ExitCode 0, 1 suite, 140 tests passed, 0 failed; "
        "pnpm --filter @du/orchestrator exec tsc --noEmit -> ExitCode 0 no diagnostics. Renderer MARKUP unchanged - existing "
        "class selectors and data-* attributes remain intact; release gates remain NO-GO and were NOT ticked. Hard checks pass: "
        "src/app/admin/** is NOT a serialize-point path (server.ts/contracts/OpenAPI/migrations all clean at HEAD adec19e), so this "
        "lane's edit does not collide with the compat serialize rule."
    ),
    "ctx_task_variant_input_field_matrix": (
        "coordination/reports/qwen-platform.md section '56 - CYCLE 56: COMP-01a INPUT - PER-VARIANT FIELD MATRIX' (12:47, after the "
        "12:30 nudge stopped the broken scripted append). Read-only, zero source edits, zero gate ticks. C4 VERIFIED against real code "
        "this cycle - QUOTED-KEY COUNTING RULE IS CORRECT AND IS THE KEY TO THE 31-vs-28 QUESTION: (1) legacy lib/endpoints/registry.ts "
        "subCases = 31 (4+6+7+5+6+3); (2) services/orchestrator/src/compat/legacy-wire-decoders.ts:32-39 VARIANTS = 31 - I re-read the "
        "file and the sets are literally invoice/contract/id-card/receipt/table/custom (6) and classify/sentiment/compliance/fact-check/"
        "quality/risk/summarize-eval (7); (3) document-core.manifest.ts discriminator enum = 28. THREE DIFFERENT COUNTS AT THREE LAYERS, "
        "all real. (4) NEW SHARPENING this receipt adds and I confirmed: the document-core INPUT NORMALIZER rejects the 3 variants the "
        "decoder accepts - business/document-core/src/validation/input-normalizer.ts extract allow-list is ['invoice','contract','receipt',"
        "'table','custom'] (omits id-card) and analyze allow-list is ['classify','sentiment','compliance','quality','risk'] (omits "
        "fact-check + summarize-eval), each throwing INVALID_DISCRIMINATOR. So even if the manifest were widened, the normalizer would "
        "reject on the wire path. (5) DISCRIMINATOR CORRECTIONS CONFIRMED: generate is 'task' not mode (registry.ts:288), compare is 'mode' "
        "not process (registry.ts:342), workflows uses 'process' at registry.ts:377 OUTSIDE the 31; third alias mismatch confirmed - "
        "manifest document-core.manifest.ts:145 names transform's discriminator 'variant' while registry + decoder both use 'action'. "
        "(6) LEGACY_CORE_ACTIONS (compat/legacy-wire-decoders.ts:12-19) and manifest handlerKinds (:19) both omit 'process' - confirmed. "
        "(7) 7 declared-but-unused params listed with file:line (target_language, glossary, redact_patterns, max_words, audience, "
        "focus_areas, type). HARD CHECKS PASS: no variant added to manifest, input-normalizer not proposed for change, 31-vs-28 NOT "
        "presented as a decision (it feeds COMP-00 decision #2 / COMP-09), no gate tick, no COMP row change. The nudge worked - the "
        "agent stopped fixing the exec script and wrote plain text."
    ),
    "ctx_task_progress_wire_semantics": (
        "coordination/reports/tester.md section 'COMP-00-PROGRESS-WIRE-CHARACTERIZATION' (12:58). Read-only, no source edits, no test "
        "runs, no gate/COMP change. C4 VERIFIED against real code this cycle - ANSWERS COMP-00 DECISION #3: (1) LEGACY REAL PROGRESS: "
        "lib/pipelines/submit.ts:312-313 writes progressPercent=0 + 'Initializing pipeline...' at creation (confirmed); lib/pipelines/engine.ts:285-286 "
        "writes Math.round((i/pipeline.length)*100) + Vietnamese 'Dang xu ly buoc i+1/N: <processor>...' (confirmed) and mirrors it to "
        "BullMQ job.updateProgress at :297; engine.ts:401-402 writes progressPercent=100/progressMessage=null on SUCCEEDED (confirmed); "
        "lib/db/schema.ts:17-18 confirms distinct progressPercent/progressMessage/progressMessage columns exist. (2) REWORK HARD ZERO: "
        "modules/runtime/runtime.ts:483-492 reportProgress validates task existence and lease_epoch then REACHES A NO-OP - the only write "
        "is 'SELECT id FROM tasks WHERE id=$1' whose result is discarded via void opRes; the percent and message are never persisted. "
        "CONFIRMED by direct read. (3) NO PRODUCTION progress.report CALL EXISTS in du-rework/businesses/document-core/src (rg -c = 0 "
        "hits). (4) operations table has NO progress column at all (migrations/0001_platform_v1.sql:36-54 - confirmed: id/tenant_id/"
        "api_key_id/business_id/business_version/action/state/state_version/root_task_id/deadline_at/input_ref/result_ref/error_code/"
        "correlation_id/timestamps only) and step_checkpoints (:102-110) carries step_key/generation/input_hash/output_ref/status, no "
        "progress field. (5) compat/legacy-action-router.ts:307-308 CAN project progressPercent but is UNMOUNTED - rg for "
        "'from ./compat|legacy-action-router|compat/' in server.ts returns 0 hits, so it is not the live poll path. (6) MUST-NOT-REPLICATE "
        "labels attached correctly to facade.ts:45 + submission.ts:715 hardcoded zero AND to the non-persisting endpoint; NO fix or "
        "checkpoint design proposed. HARD CHECKS PASS: no progress formula designed, no balance/spend numbers, no gate tick."
    ),
    "ctx_task_retention_softdelete_visibility": (
        "reports/codex-retention-softdelete-visibility-2026-10-01.md (13660 B, 13:01). Read-only characterization for COMP-00 decision #4 "
        "(retention/soft-delete/post-delete visibility), no policy chosen, no TTL recommended. C4 VERIFIED against real code this cycle - "
        "AND IT CORRECTS MY OWN DISPATCH SPEC: (1) LEGACY FILE RETENTION IS 24 HOURS, NOT 7 DAYS - lib/cleanup.ts:16 is literally "
        "EXPIRY_MS = 24*60*60*1000 with the comment '24 hours' (confirmed by direct read). The 7-day figure in the project CLAUDE.md "
        "('auto-delete uploaded files after 7 days') is actually lib/settings.ts:108 s3_cache_ttl_hours default '168' - the S3 dedup "
        "FileCache TTL, not the operation-file cleanup. Two different clocks; the receipt named them correctly. (2) CLEANUP PREDICATE "
        "CONFIRMED at lib/cleanup.ts:50-54: lt(createdAt, cutoff) AND eq(filesDeleted, false) AND isNull(deletedAt). (3) NEW SECURITY "
        "FINDING: because cleanup REQUIRES deletedAt IS NULL, a soft-deleted row that still holds files is EXCLUDED from the 24h "
        "input/output cleanup, while DELETE only flips deletedAt - so outputContent/extractedData/stepsResultJson/filesJson/outputFilePath "
        "all REMAIN in the row. The 404s on list/detail/download are NOT a DB scrub. This is the correct MUST-NOT-REPLICATE label. "
        "(4) LEGACY has NO admin/internal/script hard-delete of operation rows; the only db.delete(operations) is a submit-path "
        "backpressure rollback at lib/pipelines/submit.ts:357-359. (5) REWORK: no operation-row DELETE route exists, no retention sweep "
        "for operations or READY artifacts; the only real expiry is MULTIPART_SESSION_TTL_MS 24h (contracts runtime.ts:277, "
        "server.ts:4246-4255) which aborts STAGING multipart sessions and does NOT delete the artifacts row (multipart-service.ts:864-900, "
        "1118-1170). artifacts.expires_at column exists (migration :128-142) but NO source sets EXPIRED/DELETED. (6) purgeIdempotencyMarkers "
        "is explicitly not timer-wired (idempotency.ts:155-157) and does not touch operations. HARD CHECKS PASS: no retention policy, no "
        "TTL, no deletion behavior proposed; no balance/spend numbers; no gate tick."
    ),
    "ctx_task_operation_cache_semantics": (
        "reports/codex-operation-surface-cache-semantics-2026-10-01.md (8951 B, 12:56). Read-only characterization closing COMP-00 decision "
        "#1 (Vary/cache policy question) as evidence only - no header policy proposed, no recommendation of which side should change. "
        "C4 VERIFIED against real code this cycle: (1) LEGACY sets NO Cache-Control/Expires/ETag/Last-Modified/Vary/Pragma on any operation "
        "or docs route, and next.config.mjs has no global headers() rule; the download handler sets only Content-Type/Content-Disposition/"
        "Optional-Content-Length. (2) LEGACY middleware.ts does NOT mutate the response - I re-read middleware.ts:28-82: it builds "
        "requestHeaders, deletes x-api-key-id/x-user-id/x-user-role, optionally injects session identity, and returns only "
        "NextResponse.next({request:{headers:...}}). No CORS, no Vary, no cache, no rate-limit response headers. (3) REWORK wrapper "
        "(server.ts:716-720,798-810,821-831) sets x-correlation-id + content-type only; errors.ts contract (packages/contracts/src/errors.ts:82-99) "
        "defines problem-body fields only, no cache headers. (4) NO CONDITIONAL-REQUEST PATH on either side - neither reads If-None-Match/If-Modified-Since, "
        "neither emits ETag/Last-Modified, 304 is not reachable from these handlers; the Next App Router send-response adapter does not "
        "synthesize validators. (5) BOTH sides are labelled MUST-NOT-REPLICATE for cacheable-stale poll responses (legacy "
        "operations/route.ts:101-130 + [id]/route.ts:20-37; rework server.ts:1776-1803,1832-1841 + facade.ts:32-50) - and the receipt is "
        "careful to say a shared cache COULD serve stale state, not that a deployed CDN does. (6) Error responses (409/410/404) likewise "
        "carry no cache restriction, so a proxy could preserve an obsolete error. HARD CHECKS PASS: no Cache-Control/Vary policy "
        "recommended, no side blessed, no balance/spend numbers, no gate tick."
    ),
}

missing = []
for key, receipt in SETTLE.items():
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

# ---------------------------------------------------------------- C3 DISPATCH
# Topics verified UNCOVERED by rg across coordination/reports/ before dispatch:
#   - workflow RUN wire + HITL pause/resume: qwen-platform Muc 55 covered the workflow
#     SCHEMA surface only (loader/override/authz), not the run path; COMP-01c covered
#     operations list/lifecycle, not /api/v1/docs/workflows step execution.
#   - pipeline step-chain + session chaining: registry connectionChain and
#     processors/external-api.ts session state are not characterized anywhere.
#   - rate limiting: cache-semantics report already states middleware adds NO
#     rate-limit headers; the CALLERS of lib/rate-limit.ts were never inventoried.
SPEC_WORKFLOW_HITL = (
    "Your progress-wire characterization (coordination/reports/tester.md section COMP-00-PROGRESS-WIRE-CHARACTERIZATION) is SETTLED and "
    "passed my hard checks. I verified against real code: legacy submit.ts:312-313 really writes 0/'Initializing pipeline...', "
    "engine.ts:285-286 really writes Math.round((i/pipeline.length)*100) with the Vietnamese message and mirrors to job.updateProgress, "
    "engine.ts:401-402 writes 100/null on success; and on the rework side I confirmed reportProgress (modules/runtime/runtime.ts:483-492) "
    "validates task + lease_epoch then discards its own SELECT - a true no-op write - while businesses/document-core/src contains ZERO "
    "production progress.report calls and the operations table (migrations/0001_platform_v1.sql:36-54) has no progress column at all. Your "
    "must-not-replay labels on facade.ts:45 and submission.ts:715 held. Next task, same read-only scope, on the LEGACY WORKFLOW RUN WIRE + "
    "HUMAN-IN-THE-LOOP pause/resume - the one COMP-01 surface still uncharacterized: COMP-00 decision #2 already locked '31 core + 3 "
    "workflows', but no report in reports/ describes what a workflow actually RETURNS while it runs or how a paused workflow resumes. "
    "Answer with file:line on BOTH sides: (1) THE WORKFLOW RUN PATH: what does POST /api/v1/docs/workflows accept - cite the route file "
    "(app/api/v1/docs/workflows/route.ts) and how the 'process' discriminator at lib/endpoints/registry.ts:377 is resolved into a step list; "
    "state the exact request fields for the disbursement example and what 'schema-driven' workflows (lib/workflow-builder/run-schema.ts) "
    "differ on. (2) THE RESPONSE ITSELF: when a workflow submission returns 202/200, what does the operation body contain at that moment - "
    "cite lib/pipelines/format.ts and the workflow-engine writes - and what does a poll return while it is mid-run. (3) THE PAUSE WIRE: "
    "lib/pipelines/workflow-engine.ts:255-268 pauseWorkflow writes state WAITING_USER_INPUT - cite the exact state string, which columns "
    "change (progressPercent is explicitly NOT set to 100), what the client sees on the poll, and what the resume endpoint "
    "(app/api/v1/operations/[id]/resume/route.ts) requires - the exact expectedStateVersion / state-version CAS field if any, and what it "
    "writes on success (the receipt at :83-88 shows a progressMessage update - state what else changes). (4) MULTI-FILE / CHILD OPERATIONS: "
    "how does enqueueSubStep's hidden child operation (lib/pipelines/workflow-engine.ts:128-138) surface to a client - is the parent's "
    "pipeline_steps the only view, or does the client ever see the child rows directly? Cite what the formatter exposes. (5) REWORK "
    "COUNTERPART: state the rework equivalents with file:line - WAITING_INPUT / WAITING_CHILDREN states, POST /api/v1/operations/:id/resume, "
    "the human_waits table (migrations/0005_continuation.sql), and what the rework operation view returns for a waiting operation. State "
    "plainly which legacy workflow behaviours have NO rework counterpart today and which rework behaviours are not in legacy, without "
    "proposing any fix or choosing a side. HARD CHECKS: (1) characterization only - do NOT propose a state machine, a resume payload "
    "schema, a CAS scheme or any fix; (2) any behaviour you label MUST-NOT-REPLICATE must carry file:line and stop there; (3) do NOT fake a "
    "terminal state and do NOT propose cancelling by writing CANCELLED directly - if you observe that, label it and stop; (4) do NOT "
    "restate balance, spend or cost numbers; (5) no gate ticks, no COMP row changes. Path reminder: legacy shared helpers are lib/** at "
    "repo top level, NOT app/lib/**; only route handlers live under app/api/v1/**. Limits: read-only; write only your own new report file "
    "du-rework/coordination/reports/codex-legacy-workflow-hitl-run-wire-2026-10-01.md; no source edits; no test runs."
)

SPEC_SESSION_CHAIN = (
    "Your retention/soft-delete characterization (coordination/reports/codex-retention-softdelete-visibility-2026-10-01.md) is SETTLED. "
    "I verified the headline against real code - and I am correcting MY OWN dispatch spec because of you: lib/cleanup.ts:16 is literally "
    "EXPIRY_MS = 24*60*60*1000 ('24 hours'), NOT the 7 days my spec claimed; the 7-day figure is lib/settings.ts:108 s3_cache_ttl_hours "
    "default '168', the S3 dedup FileCache TTL. You named them separately and correctly. I also confirmed the cleanup predicate at "
    "cleanup.ts:50-54 requires deletedAt IS NULL, which is exactly why your retained-plaintext finding is real: a soft-deleted row is "
    "excluded from the 24h cleanup while DELETE only flips deletedAt. Next task, same read-only scope, on the LEGACY PIPELINE STEP-CHAIN + "
    "SESSION CHAINING - the other COMP-01 surface still uncharacterized: the multi-step execution model is what makes legacy a PIPELINE "
    "rather than a single action, and COMP-09 (ORCH-PAR) cannot be written until this is on the table. Answer with file:line on BOTH sides: "
    "(1) THE CHAIN CONSTRUCTION: how lib/endpoints/registry.ts turns a sub-case into an ordered list of steps, each with its "
    "ExternalApiConnection chain - cite the exact registry fields (connectionChain, processor, prompt) for at least ingest/parse, "
    "extract/invoice and generate/report, and state how many steps each has. (2) THE PERSISTED PIPELINE: what lib/pipelines/submit.ts "
    "writes into operations.pipelineJson - the exact JSON shape of one step - and confirm it is the same object the worker later re-reads. "
    "(3) SESSION CHAINING: how lib/pipelines/processors/external-api.ts carries state BETWEEN steps inside one operation - cite the exact "
    "field (session / sessionId / sessionRef, name it exactly), where it is stored (BullMQ job data? the operation row? the step's "
    "response?), how it is interpolated into the next request (prompt interpolation vs multipart form field), and what happens on the FIRST "
    "step when there is no prior session. (4) CHECKPOINT/RESUME: engine.ts checkpoint semantics - what resumeFromStep means, which of "
    "currentStep/stepsResultJson/state are restored on resume, and what happens to the session object on resume after a crash. (5) PROFILE "
    "OVERRIDES ON THE CHAIN: how ProfileEndpoint and ExternalApiOverride change a step's connection or prompt at resolve time "
    "(lib/endpoints/profile-resolver.ts) and whether an override can change the NUMBER of steps or only a step's content. (6) REWORK "
    "COUNTERPART: state with file:line what rework uses instead - connector slots on the manifest action, step_checkpoints "
    "(migrations/0001_platform_v1.sql:102-110) with generation + input_hash + output_ref, and the checkpoint save path in "
    "modules/runtime/runtime.ts:424-481 - then state plainly (a) whether any rework concept carries per-step session state between two "
    "calls in one operation, (b) whether rework can resume a multi-step operation at a step boundary today, and (c) which legacy behaviours "
    "have NO rework counterpart. HARD CHECKS: (1) characterization only - do NOT propose a session model, a checkpoint design, a pipeline "
    "JSON schema or any fix; (2) any behaviour you label MUST-NOT-REPLICATE must carry file:line and stop there; (3) do NOT restate balance, "
    "spend or cost numbers; (4) no gate ticks, no COMP row changes; (5) do not propose adding variants or editing input-normalizer - that is "
    "COMP-00/COMP-09 territory. Path reminder: legacy shared helpers are lib/** at repo top level, NOT app/lib/**; registry is "
    "lib/endpoints/registry.ts; rework runtime checkpoints are services/orchestrator/src/modules/runtime/runtime.ts, not app/. Limits: "
    "read-only; write only your own new report file du-rework/coordination/reports/codex-legacy-pipeline-session-chain-2026-10-01.md; no "
    "source edits; no test runs."
)

SPEC_RATELIMIT = (
    "Your cloudflare-theme receipt (coordination/reports/tester.md section W-ADM-UX-01-CLOUDFLARE-THEME) is SETTLED: 1 suite / 140 tests "
    "PASS + tsc ExitCode 0, CSS-only, markup and data-* untouched, gates left NO-GO. Next task, different lane of work, same read-only "
    "discipline, on LEGACY RATE LIMITING + the public operations list QUERY SURFACE - two things that are claimed in the project's own "
    "CLAUDE.md but that no report in coordination/reports/ has actually inventoried. Answer with file:line: (1) RATE-LIMIT REALITY: "
    "lib/rate-limit.ts exports checkRateLimit plus RATE_LIMIT_API_KEY (default 100/min) and RATE_LIMIT_IP (default 30/min). Find EVERY "
    "caller of checkRateLimit across the whole legacy repo (app/** and lib/**). State plainly whether ANY caller exists on the /api/v1/** "
    "public surface or in middleware.ts, and if the only caller is under app/api/internal/**, say so explicitly with the file:line. Then "
    "state what checkRateLimit returns and what HTTP status/body a 429 looks like when it does fire, and whether any response header "
    "(Retry-After, X-RateLimit-*) is set. (2) MIDDLEWARE TRUTH: restate what middleware.ts does and does not do for /api/v1/** - I have "
    "already verified it only strips x-api-key-id/x-user-id/x-user-role and returns NextResponse.next({request:{headers}}), so do NOT "
    "re-derive that; instead confirm whether any OTHER middleware or next.config.mjs headers() rule applies rate limiting or CORS to "
    "/api/v1/**, with file:line. (3) THE OPERATIONS LIST QUERY SURFACE: read app/api/v1/operations/route.ts end to end and enumerate EVERY "
    "query parameter it accepts (page, page_size, state, action, date ranges, anything else) with the exact default and the exact maximum "
    "for each. For each parameter state (a) whether an absent value means unbounded, (b) whether an out-of-range or wrong-type value is "
    "rejected with 400 or silently ignored, and (c) whether the LIMIT clause is applied at all - if the query can be made to return an "
    "unbounded number of rows, say so plainly with the line that builds the query. (4) REWORK COUNTERPART: same inventory for "
    "GET /api/v1/operations in services/orchestrator/src/server.ts (:1766-1803) - enumerate its query params, their defaults, whether a "
    "limit is enforced, and what the cursor is. State the parity deltas: which legacy parameters have no rework counterpart, which rework "
    "limits have no legacy counterpart, and whether rework enforces a limit legacy does not. (5) STATE PLAINLY (no fix proposed) whether "
    "the CLAUDE.md claim 'Rate Limiting: Middleware-level per-API-key rate limiting' is accurate for the /api/v1/** surface today. HARD "
    "CHECKS: (1) characterization only - do NOT propose a rate-limit policy, a middleware change, a query-param schema or any fix; (2) any "
    "behaviour you label MUST-NOT-REPLICATE (e.g. an unbounded list query, a spoofable header path) must carry file:line and stop there - "
    "do NOT propose how to fix it and do NOT invent a default limit; (3) do NOT restate balance, spend or cost numbers; (4) no gate ticks, "
    "no COMP row changes; (5) do NOT modify lib/rate-limit.ts or any source. Path reminder: legacy shared helpers are lib/** at repo top "
    "level, NOT app/lib/**; the public routes live under app/api/v1/**; middleware is middleware.ts at repo root. Limits: read-only; write "
    "only your own new report file du-rework/coordination/reports/codex-legacy-ratelimit-list-query-surface-2026-10-01.md; no source edits; "
    "no test runs."
)

DISPATCHES = [
    ("ctx_task_legacy_workflow_hitl_wire",
     "COMP-01 read-only: legacy workflow RUN wire + HITL pause/resume (WAITING_USER_INPUT, resume CAS, child ops; feeds COMP-00 decision #2 + COMP-09)",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     SPEC_WORKFLOW_HITL),
    ("ctx_task_legacy_pipeline_session_chain",
     "COMP-01 read-only: legacy pipeline step-chain + session chaining + checkpoint resume (feeds COMP-09 ORCH-PAR; rework step_checkpoints counterpart)",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     SPEC_SESSION_CHAIN),
    ("ctx_task_legacy_ratelimit_list_query_surface",
     "COMP-01 read-only: legacy rate-limit caller inventory + operations list query-surface/limit bounds vs rework (CLAUDE.md claim check)",
     "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
     SPEC_RATELIMIT),
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
