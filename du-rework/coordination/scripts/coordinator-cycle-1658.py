import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
NOW = "2026-10-01T16:58:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
RUN = "run_2e083dbaeaee"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

# ---------- C2a: settle 3 finished dispatches ----------
settles = [
    ("ctx_task_rv01_acceptance_matrix",
     "du-rework/coordination/reports/codex-rv01-acceptance-matrix-2026-10-01.md",
     "RV01-01+RV01-03 acceptance matrix LANDED (codex_tester_live, term_c4486089, done 16:30). All 6 rows "
     "(RV01-01.A/B/C, RV01-03.A/B/C) classified LIVE with offline preflight commands listed; KEY FINDING: "
     "production entrypoint main.ts:74-89,105-132 reads DATABASE_URL/REDIS_URL/ARTIFACT_STORAGE_BACKEND/S3 env "
     "but NOT Vault/key-provider, metadata/publicUpload/deliveryEncryption flags, storage-key allowlist or "
     "recipient registry wiring - RV01-01 criterion explicitly says createApp fixture is not acceptance. "
     "Feeds RV01-01 closeout (boot wiring still incomplete) - not a task tick."),
    ("ctx_task_connector_wire_characterization",
     "du-rework/coordination/reports/codex-rework-legacy-connector-wire-2026-10-01.md",
     "COMP-02 input LANDED (qwen_4, term_63bf0dbc, 16:31). Full behaviour table legacy vs rework connector wire - "
     "ALL 14 rows DIFFERENT (multipart-to-provider+provider-credential vs JSON-to-connector+service-bearer+grant). "
     "3 exposures confirmed on LEGACY only: (a) raw remote file URL forwarded past egress guard; (b) validate-then-fetch "
     "DNS/redirect gap; (c) secret-in-URL logged verbatim in 5 places. Rework: not expressible/guarded on acquisition. "
     "10 questions COMP-02 must answer recorded. Evidence only - COMP-02 stays blocked on COMP-00."),
    ("ctx_task_demo_orphan_reachability",
     "du-rework/coordination/reports/codex-legacy-demo-orphan-reachability-2026-10-01.md",
     "ORCH-PAR-00 input #2 LANDED (codex_worker_3, term_f1ed751c, done 16:47). Reachability/usage evidence for the 6 "
     "legacy demo-orphan surfaces (inbound refs, deploy coupling, doc coupling, test coverage) - closes the repo-side "
     "half of the product decision. Feeds ORCH-PAR-00 product sign-off only - not a COMP task, no gate tick."),
]
for key, receipt, summary in settles:
    s = disp.get(key)
    if s and s.get("status") != "settled":
        s["status"] = "settled"
        s["receipt"] = receipt
        s["settledAt"] = NOW
        s["lastObservedAt"] = NOW
        s["blocker"] = None
        s["summary"] = summary
        print("SETTLED", key)

# ---------- C2b: mark historical running rows (dispatchedAt None) ----------
hist = 0
for k, v in list(disp.items()):
    if v.get("status") == "running" and v.get("dispatchedAt") is None and not k.startswith("ctx_task_"):
        v["status"] = "historical"
        v["lastObservedAt"] = NOW
        v["blocker"] = "historical row from pre-2026-10-01 waves; dispatchedAt never set - not live workload"
        v["summary"] = ((v.get("summary") or "")[:120] + " [marked historical 2026-10-01 16:58 by coordinator]")
        hist += 1
print("HISTORICAL_MARKED", hist)

# ---------- C3: dispatch implementation packets ----------
COMMON = (
"\n\nSTANDING RULES (unchanged): your lease below is exclusive. "
"Do NOT copy legacy vulns (client-supplied x-api-key-id/apiKeyId, ADMIN-key fallback, list-no-resolve ops); "
"encryption fail-closed, NO plaintext fallback; no fake terminal state CANCELLED; no release gate ticks "
"(G-* stays NO-GO); do not message nocobase-10; do not commit other lanes' changes; do NOT edit "
"du-rework/AGENTS.md, tasks/README.md, or the execution overlay. DEV TEST ISOLATION: if a test needs "
"DB/Redis/S3, use your own schema/DB + Redis prefix/DB + S3 prefix/bucket; only serial migration/cleanup "
"destructive on shared resources; do not claim a shared DB window. Detailed business tests are a separate "
"packet - they do NOT block your code; do not wait for them."
)

def dispatch(key, handle, spec, title, display, task_spec):
    p = subprocess.run(["orca", "terminal", "send", "--terminal", handle, "--text", spec, "--enter"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = ((p.stdout or "") + (p.stderr or ""))[:200]
    print("[%s] SEND_EXIT %s | %s" % (key, p.returncode, out))
    tp = subprocess.run(["orca", "orchestration", "task-create", "--run", RUN,
                         "--task-title", title, "--display-name", display, "--spec", task_spec],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    tout = ((tp.stdout or "") + (tp.stderr or ""))[:200]
    print("[%s] TASK_EXIT %s | %s" % (key, tp.returncode, tout))
    return p.returncode == 0 and tp.returncode == 0

D1 = (
"IMPLEMENTATION PACKET (user directive 2026-10-01 16:5x - throughput, implementation first).\n\n"
"GOAL: implement the 3 missing document-core variants so the rework manifest reaches 31 actions: "
"extract:id-card, analyze:fact-check, analyze:summarize-eval (tasks/API-COMPAT-DUGATE-2026-09-28.md line 17; "
"COMP-04b scope). Business logic + manifest entries only.\n\n"
"EXCLUSIVE LEASE (yours alone; do not write outside):\n"
"- du-rework/businesses/document-core/src/manifest/**\n"
"- du-rework/businesses/document-core/src/recipes/**\n"
"- du-rework/businesses/document-core/src/actions/**\n"
"- du-rework/businesses/document-core/src/validation/**\n"
"- du-rework/businesses/document-core/tests/** (your OWN new test files only; do NOT edit other lanes' tests)\n"
"NOT yours: packages/**, services/**, other businesses/**, tasks/*.md, gates/*, server.ts/main.ts (single "
"integrator = qwen_1). Do NOT mount any public route - route mapping stays blocked on COMP-00.\n\n"
"ACCEPTANCE (report honestly, every unrun item marked):\n"
"1. Manifest lists all 31 actions including the 3 new ones; existing 28 unchanged in shape.\n"
"2. Each new variant has a recipe + validation path + its own unit tests.\n"
"3. npx jest --runInBand --runTestsByPath <your new tests> exit 0 with literal 'Tests: N passed, M total'.\n"
"4. npx tsc --noEmit in document-core exit 0.\n"
"5. Report: du-rework/coordination/reports/codex-document-core-missing-variants-2026-10-01.md\n\n"
"DEPENDENCY NOTE: COMP-04b is marked BLOCKED in the COMP plan; today's user directive allocates this for "
"throughput because it does not touch shared server.ts and freezes no public contract. The route/mapping half "
"stays blocked - that is correct, not a gap you should close.\n"
"CONTEXT (read-only): tasks/API-COMPAT-DUGATE-2026-09-28.md; legacy app/ lib/; coordination/reports/codex-*-2026-10-01.md.\n"
"ETA: report when acceptance items run; partial completion with honest gaps is a valid checkpoint."
)

D2 = (
"IMPLEMENTATION PACKET (user directive 2026-10-01 16:5x - throughput, implementation first).\n\n"
"GOAL: implement P9-01 (disbursement business workflow) in rework (tasks/P9-business-backlog.md): bounded "
"multi-step business workflow using orchestrator continuation primitives (children/join, wait-input, resume). "
"NO interpreter inside Orchestrator.\n\n"
"EXCLUSIVE LEASE (yours alone):\n"
"- du-rework/businesses/document-core/src/pipelines/** (new subdirs under workflows/, e.g. workflows/disbursement/**)\n"
"- du-rework/businesses/document-core/tests/** (your OWN new test files only)\n"
"NOT yours: document-core manifest/recipes/actions/validation (lease of codex_worker_1), packages/**, "
"services/**, tasks/*.md, gates/*, server.ts/main.ts. If manifest registration is needed, list it as a "
"follow-up in your report - do not edit those files.\n\n"
"ACCEPTANCE (honest, every unrun item marked):\n"
"1. Disbursement workflow implemented with typed continuation primitives.\n"
"2. Own unit tests green via npx jest --runInBand --runTestsByPath <your new tests> + literal 'Tests: N passed'.\n"
"3. npx tsc --noEmit in document-core exit 0.\n"
"4. Report: du-rework/coordination/reports/codex-p9-01-disbursement-2026-10-01.md\n\n"
"OUT OF SCOPE: P9-02 lc-checker (needs domain-owner criteria/rule versions - DO NOT invent them); P9-03/P9-04 "
"are separate packets.\n"
"DEPENDENCY NOTE: P9 formally depends on P1-P7 contracts and COMP-00/01/02; today's directive allocates the "
"BUSINESS implementation for throughput while the wire side stays blocked. Intentional split.\n"
"CONTEXT (read-only): tasks/P9-business-backlog.md; legacy lib/pipelines/workflow-engine.ts; rework runtime via docs/.\n"
"ETA: report when acceptance items run."
)

D3 = (
"IMPLEMENTATION PACKET (user directive 2026-10-01 16:5x - throughput, implementation first).\n\n"
"GOAL: implement LOCAL-01 auth primitives (tasks/ADMIN-LOCAL-AUTH-2026-09-30.md): (1) new migration "
"admin_local_users; (2) repository with tenant fence + audit hook; (3) admin-creating CLI.\n"
"PRIMITIVES ONLY: no boot wiring, no UI, no server.ts/main.ts, no invented role matrix. LOCAL-00 (product + "
"security + arch ADR) is still open - mode/ADMIN_TOKEN policy stays with that decision. Record policy "
"assumptions as OPEN QUESTIONS in your report, not as code decisions.\n\n"
"EXCLUSIVE LEASE (yours alone):\n"
"- NEW services/orchestrator/src/db/migrations/00XX_admin_local_users.sql (next free number; check 0018-0022)\n"
"- NEW dir services/orchestrator/src/modules/auth/admin-local/**\n"
"- NEW CLI file (e.g. src/migrations-local-users-cli.ts); do NOT edit migrate-cli.ts\n"
"- services/orchestrator/tests/** (your OWN new test files only)\n"
"NOT yours: main.ts, server.ts (single integrator = qwen_1 term_4568d175), existing auth modules "
"(oidc-client/redis-session-repository/session-store), packages/**, tasks/*.md, gates/*.\n\n"
"ACCEPTANCE (honest):\n"
"1. Migration up + idempotent on a test DB you control (own schema per isolation rule).\n"
"2. Repository unit tests: tenant fence enforced, audit row written; literal 'Tests: N passed' + exit 0.\n"
"3. npx tsc --noEmit -p services/orchestrator/tsconfig.json exit 0.\n"
"4. Report: du-rework/coordination/reports/codex-local01-admin-local-users-2026-10-01.md\n\n"
"SECURITY (hard): password material NEVER stored/readable (hashed; record algorithm choice); constant-time "
"compare belongs to LOCAL-02 - no ad-hoc compare; no user enumeration in CLI output; repository fail-closed on "
"missing tenant; no plaintext fallback."
)

D4 = (
"IMPLEMENTATION PACKET (user directive 2026-10-01 16:5x - throughput, implementation first).\n\n"
"GOAL: implement compat DECODER/SERIALIZER modules as PURE, UNMOUNTED code in "
"services/orchestrator/src/compat/ (COMP-03b-adjacent, module level only):\n"
"1. Strict legacy INPUT decoder: legacy request shape -> typed rework submission shape. Fail closed on unknown "
"fields, missing discriminator, malformed fields. MUST reject client-supplied x-api-key-id/apiKeyId (legacy vuln "
"- never honor them; auth resolution stays resolveApiKey of x-api-key).\n"
"2. Legacy operation RESPONSE serializer: typed operation state -> legacy wire shape (name/done/metadata/"
"result|error, next_page_token via the 4-slot cursor dialect). NEVER emit a fabricated CANCELLED state.\n"
"NO ROUTE MOUNT, NO CONTRACT FREEZE: you do NOT edit server.ts/main.ts (single integrator = qwen_1) and do NOT "
"edit packages/contracts (contract freeze is a COMP-00/COMP-02 decision). These are evidence-ready modules, not "
"the frozen contract.\n\n"
"EXCLUSIVE LEASE (yours alone):\n"
"- NEW files under du-rework/services/orchestrator/src/compat/ (e.g. legacy-input-decoders.ts, "
"legacy-operation-serializers.ts); you MAY READ existing compat files; any additive export line in an existing "
"compat file is allowed and must be listed explicitly in the report\n"
"- services/orchestrator/tests/** (your OWN new test files only)\n"
"NOT yours: packages/contracts, server.ts, main.ts, docs/21-openapi.json, tasks/*.md, gates/*.\n\n"
"ACCEPTANCE (honest):\n"
"1. Offline unit tests (no DB): happy decode; missing discriminator fail-closed; unknown-field reject; "
"x-api-key-id reject; serializer happy path; next_page_token cursor round-trip; no-fake-CANCELLED case. "
"Literal 'Tests: N passed, M total' + exit 0.\n"
"2. npx tsc --noEmit -p services/orchestrator/tsconfig.json exit 0.\n"
"3. Report: du-rework/coordination/reports/codex-rework-compat-decoders-2026-10-01.md - include a table "
"legacy field -> rework field -> file:line of the decoder branch.\n\n"
"CONTEXT (read-only): tasks/API-COMPAT-DUGATE-2026-09-28.md COMP-01/03b; "
"coordination/reports/codex-rework-legacy-connector-wire-2026-10-01.md; "
"codex-profileendpoint-lock-override-field-inventory-2026-10-01.md; "
"codex-operation-surface-cache-semantics-2026-10-01.md; legacy app/ lib/ (read-only)."
)

D5 = (
"IMPLEMENTATION PACKET (user directive 2026-10-01 16:5x - throughput, implementation first).\n\n"
"GOAL: implement LOCAL-02 auth PRIMITIVES (tasks/ADMIN-LOCAL-AUTH-2026-09-30.md): (1) constant-time password "
"verify; (2) bounded rate limit + lockout; (3) generic 401 without user enumeration; (4) opaque session mint "
"with issuer=du-local - isolated primitives/seams, no boot wiring, no UI, no server.ts.\n\n"
"EXCLUSIVE LEASE (yours alone):\n"
"- NEW dir services/orchestrator/src/modules/auth/local-primitives/**\n"
"- services/orchestrator/tests/** (your OWN new test files only)\n"
"NOT yours: main.ts, server.ts (single integrator = qwen_1), LOCAL-01's admin-local/** (codex_worker_2), "
"existing auth modules, packages/**, tasks/*.md, gates/*.\n\n"
"ACCEPTANCE (honest):\n"
"1. Offline unit tests: constant-time verify correct/incorrect; lockout after N failures; generic 401 identical "
"for unknown-vs-wrong-password; session token opaque + issuer claim = du-local; expiry enforced. Literal "
"'Tests: N passed, M total' + exit 0.\n"
"2. npx tsc --noEmit -p services/orchestrator/tsconfig.json exit 0.\n"
"3. Report: du-rework/coordination/reports/codex-local02-auth-primitives-2026-10-01.md - document seam "
"interfaces LOCAL-01/LOCAL-03 can plug into; do NOT import LOCAL-01's repo (define interfaces locally).\n\n"
"DEPENDENCY NOTE: LOCAL-02 formally depends on LOCAL-00/01 - you implement PRIMITIVES + interfaces only; "
"lockout thresholds and session TTL are parameterized with safe defaults recorded as OPEN QUESTIONS for "
"LOCAL-00 sign-off.\n"
"SECURITY (hard): fail closed; no enumeration; timing-safe compare; no plaintext password paths; no gate ticks."
)

JOBS = [
    ("ctx_task_doc_core_variants",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     D1 + COMMON,
     "Implement 3 missing document-core variants (COMP-04b)",
     "document-core 3 missing variants",
     "Extract:id-card / analyze:fact-check / analyze:summarize-eval implemented in document-core "
     "manifest+recipes+actions+validation, own unit tests green + tsc 0. Lease: document-core "
     "src/{manifest,recipes,actions,validation} + own tests. No packages/, no services/, no route mount "
     "(COMP-00 still gates mapping). Report codex-document-core-missing-variants-2026-10-01.md."),

    ("ctx_task_p9_01_disbursement",
     "term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc",
     D2 + COMMON,
     "P9-01 disbursement business workflow (rework pipelines)",
     "P9-01 disbursement workflow",
     "Disbursement workflow under document-core src/pipelines/workflows/** using continuation primitives; own "
     "unit tests green + tsc 0. Does NOT touch manifest/recipes (other lease); registration reported as "
     "follow-up. P9-02 skipped (domain-owner criteria missing). Report codex-p9-01-disbursement-2026-10-01.md."),

    ("ctx_task_local01_admin_local_users",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     D3 + COMMON,
     "LOCAL-01 admin_local_users migration + repository + CLI (primitives)",
     "LOCAL-01 admin_local_users primitives",
     "New migration 00XX_admin_local_users + admin-local/** repository (tenant fence + audit) + CLI primitive. "
     "No boot wiring, no UI, no role matrix (LOCAL-00 decision open). Own tests + tsc 0. Report "
     "codex-local01-admin-local-users-2026-10-01.md. Single integrator qwen_1 holds main.ts/server.ts."),

    ("ctx_task_compat_decoder_serializer",
     "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
     D4 + COMMON,
     "Compat decoder/serializer modules (unmounted, no contract freeze)",
     "compat decoder/serializer modules",
     "Pure legacy-input decoder + legacy-operation serializer under services/orchestrator/src/compat/ (new "
     "files), unmounted, no packages/contracts edit, no server.ts. Offline unit tests + tsc 0. Rejects client "
     "x-api-key-id; never fake CANCELLED. Report codex-rework-compat-decoders-2026-10-01.md."),

    ("ctx_task_local02_auth_primitives",
     "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
     D5 + COMMON,
     "LOCAL-02 auth primitives (verify, lockout, generic 401, du-local session seam)",
     "LOCAL-02 auth primitives",
     "Isolated auth primitives under modules/auth/local-primitives/**: constant-time verify, bounded "
     "rate-limit/lockout, generic 401 no-enumeration, opaque session mint issuer=du-local. No boot/UI/server.ts. "
     "Offline unit tests + tsc 0. Report codex-local02-auth-primitives-2026-10-01.md."),
]

ok = True
for key, handle, spec, title, display, task_spec in JOBS:
    if key in disp:
        print("ALREADY", key, disp.get(key, {}).get("status"))
        continue
    good = dispatch(key, handle, spec, title, display, task_spec)
    ok = ok and good
    disp[key] = collections.OrderedDict([
        ("status", "running"),
        ("terminalHandle", handle),
        ("dispatchedAt", NOW),
        ("lastObservedAt", NOW),
        ("consecutiveUnfinishedChecks", 0),
        ("blocker", None),
        ("receipt", None),
        ("summary", task_spec),
    ])
    print("REGISTERED", key)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")
print("watch-state total", len(disp), dict(collections.Counter(x["status"] for x in disp.values())))
print("ALL_OK", ok)
