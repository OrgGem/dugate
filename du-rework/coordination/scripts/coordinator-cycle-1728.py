import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
NOW = "2026-10-01T17:28:00+07:00"
W = r"D:/Git/dugate/du-rework/coordination/agent-watch-state.json"
RUN = "run_2e083dbaeaee"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

# ---------------- C2: settle 4 receipts ----------------
settles = [
    ("ctx_task_doc_core_variants",
     "du-rework/coordination/reports/codex-document-core-missing-variants-2026-10-01.md",
     "IMPLEMENTED 3 variants (extract:id-card, analyze:fact-check, analyze:summarize-eval) in discriminator + "
     "recipe registry + traceability (31 entries, counts ingest4/extract6/analyze7/transform5/generate6/compare3). "
     "No route mount (COMP-00 respected). Receipt: jest missing-variants 'Tests: 4 passed, 4 total' exit 0; "
     "document-core tsc --noEmit exit 0. HONEST GAP: existing manifest/traceability tests still assert 28 and were "
     "out of lease -> full suite status UNVERIFIED; 31-vs-28 MISMATCH not yet closed. Fix packet dispatched this "
     "cycle (count-only test edits)."),
    ("ctx_task_compat_decoder_serializer",
     "du-rework/coordination/reports/codex-rework-compat-decoders-2026-10-01.md",
     "PURE UNMOUNTED compat modules written: src/compat/legacy-input-decoders.ts (19,048B) + "
     "legacy-operation-serializers.ts (10,775B) + tests/compat-decoders.test.ts (43 tests). HARD CHECKS PASS: "
     "client-supplied x-api-key-id/apiKeyId/api_key_id/xApiKeyId/tenantId/userId/authorization/role REJECTED "
     "(:213-241); unknown fields rejected (:158-163) vs COMP-02 lenient decoder; NEVER emits fabricated CANCELLED "
     "(explicitly refuses COMP-06 toLegacyOperationError synthesis); no route mount, no contract freeze, "
     "packages/contracts + server.ts + main.ts + openapi untouched (byte-verified). 43/43 x3 runs exit 0 + tsc 0 + "
     "mutation-tested (3 mutations -> 3/2/2 failures) + positive control. 3 adjudications left for COMP-00: "
     "next_page_token dialect (op-ID COMP-06 vs 4-slot cursor), envelope shape (response vs result), and whether "
     "the 7 registry-declared-but-unattached params should hard-reject."),
    ("ctx_task_local01_admin_local_users",
     "du-rework/coordination/reports/codex-local01-admin-local-users-2026-10-01.md",
     "LOCAL-01 primitives landed: migration 0023_admin_local_users.sql (tenant-bound, generated immutable UUID, "
     "username unique per tenant, self-describing hash), modules/auth/admin-local/{password.ts (scrypt "
     "N=32768,r=8,p=1, 64MiB cap),repository.ts,index.ts} (tenant fence before DB access, tenant_id+id binding, "
     "password_hash never projected, audit row in same tx, failed audit rolls back), migrations-local-users-cli.ts "
     "(create-admin; password from stdin only, generic failure message, no secret printed). Receipt: 2 suites, "
     "'Tests: 7 passed, 7 total' exit 0, private schema applied 0023 twice + constraint + hash-shape checks, "
     "scoped drop. Receipt reported tsc BLOCKED by TS18047 x4 in local-primitives/authenticate.ts (other lane, "
     "mid-write) -> COORDINATOR RE-RAN npx tsc --noEmit -p services/orchestrator/tsconfig.json = TSC_EXIT=0, so "
     "acceptance now satisfied at workspace level. Follow-up dispatched: CLI disable/reset/rotation + rollback smoke. "
     "LOCAL-00 questions recorded (role matrix, scrypt approval, username/password policy)."),
    ("ctx_task_local02_auth_primitives",
     "du-rework/coordination/reports/codex-local02-auth-primitives-2026-10-01.md",
     "LOCAL-02 primitives landed under modules/auth/local-primitives/: password.ts (fresh 16B salt, scrypt "
     "N=16384,r=8,p=1, 32B key, timingSafeEqual, dummy derivation on malformed verifier), authenticate.ts "
     "(dummy verifier for unknown login, IDENTICAL frozen {authenticated:false,status:401,body:{error:'Invalid "
     "credentials'}} for unknown-user and wrong-password - no enumeration), login-guard.ts (20/60s, lockout 5 -> "
     "15min, 10k cap deny, HMAC subject keys, fail-closed), session.ts (32B base64url opaque token, issuer "
     "'du-local', SHA-256 digest key, expiry enforced). Imports NO LOCAL-01 code (interfaces only). Receipt: "
     "'Tests: 6 passed, 6 total' exit 0 offline + orchestrator tsc exit 0. OPEN for LOCAL-00: attempt/lockout "
     "defaults, 8h TTL/24h cap, process-local guard is NOT cross-replica, scrypt choice."),
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

# ---------------- C3: dispatch ----------------
COMMON = (
    "\n\nSTANDING RULES (unchanged): your lease below is exclusive. Do NOT copy legacy vulns "
    "(client-supplied x-api-key-id/apiKeyId, ADMIN-key fallback, list-no-resolve ops); encryption fail-closed, "
    "NO plaintext fallback; no fake terminal state CANCELLED; no release gate ticks (G-* stays NO-GO); do not "
    "message nocobase-10; do not commit other lanes' changes; do NOT edit du-rework/AGENTS.md, tasks/README.md, "
    "or the execution overlay. DEV TEST ISOLATION: if a test needs DB/Redis/S3 use your own schema/DB + Redis "
    "prefix/DB + S3 prefix/bucket; only serial migration/cleanup destructive on shared resources; do not claim a "
    "shared DB window. Detailed business tests are a separate packet - they do NOT block your code; do not wait "
    "for them. Read your previous receipt first; report honestly with every unrun item marked."
)


def dispatch(key, handle, spec, title, display, task_spec):
    p = subprocess.run(["orca", "terminal", "send", "--terminal", handle, "--text", spec, "--enter"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("[%s] SEND_EXIT %s | %s" % (key, p.returncode, ((p.stdout or "") + (p.stderr or ""))[:160]))
    tp = subprocess.run(["orca", "orchestration", "task-create", "--run", RUN,
                         "--task-title", title, "--display-name", display, "--spec", task_spec],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("[%s] TASK_EXIT %s | %s" % (key, tp.returncode, ((tp.stdout or "") + (tp.stderr or ""))[:160]))
    return p.returncode == 0 and tp.returncode == 0


# E1 -> codex_worker_1 : fix the 28-count assertions (red with evidence)
E1 = (
    "FIX PACKET (evidence-based red, follows your COMP-04b implementation receipt).\n\n"
    "FINDING (coordinator read your receipt): you could only add new test files, so the EXISTING "
    "document-core tests that assert 28 variants were left untouched -> the full document-core Jest suite will "
    "now FAIL on count assertions. That is a real red caused by IMPLEMENTED code, not by your logic.\n\n"
    "GOAL: make the full document-core suite green again.\n\n"
    "EXCLUSIVE LEASE (extended for this packet only):\n"
    "- du-rework/businesses/document-core/tests/** EXISTING test files - COUNT-ONLY edits (28 -> 31, and the "
    "per-action counts ingest:4/extract:6/analyze:7/transform:5/generate:6/compare:3 where a table lists them).\n"
    "- du-rework/businesses/document-core/src/{manifest,recipes,actions,validation}/** if and only if a count "
    "assertion is wrong for a reason you can prove.\n"
    "NOT yours: pipelines/** (qwen_2 P9-01 lane is writing there now), packages/**, services/**, tasks/*.md, "
    "gates/*, server.ts/main.ts.\n\n"
    "RULES FOR THE EDITS: change expected numbers and count literals ONLY. Do NOT weaken or delete any assertion "
    "to make a test pass. If a test fails for a reason other than the count, STOP, leave it red, and report the "
    "failure verbatim - do not patch behaviour you cannot prove from the receipt.\n\n"
    "ACCEPTANCE (honest, every unrun item marked):\n"
    "1. Full document-core suite: `npx jest --runInBand` from du-rework/businesses/document-core -> literal "
    "'Test Suites: N passed, N total' + 'Tests: N passed, N total' + exit 0. If anything still fails, report the "
    "exact failure text and why you did not fix it.\n"
    "2. List every test file you edited with the old->new count.\n"
    "3. npx tsc --noEmit in document-core -> exit 0.\n"
    "4. Report (append, do not delete your existing receipt): "
    "du-rework/coordination/reports/codex-document-core-missing-variants-2026-10-01.md, section 'Follow-up: "
    "count assertions'.\n\n"
    "Do NOT tick COMP-04b or any COMP row. Do not mount routes."
)

# E2 -> codex_worker_2 : finish LOCAL-01 CLI deliverables + rollback smoke
E2 = (
    "FOLLOW-UP PACKET (your LOCAL-01 receipt listed create-admin only; the LOCAL-01 row in "
    "tasks/ADMIN-LOCAL-AUTH-2026-09-30.md line 26 requires disable/reset/rotation too).\n\n"
    "GOAL: finish the LOCAL-01 CLI surface, still PRIMITIVES ONLY.\n"
    "1. Extend src/migrations-local-users-cli.ts with: `disable-admin`, `reset-password`, `rotate-credentials` "
    "(or equivalent) operating through your repository. Password for reset comes from piped stdin, never argv. "
    "Every command prints a generic success/failure message: no username echo where avoidable, no hash, no "
    "password, no secret in any error path.\n"
    "2. Extend tests/admin-local-user-repository.test.ts and/or add NEW test files (yours) covering: disable makes "
    "the account ineligible for login; reset writes a new verifier; rotation bumps version and invalidates prior "
    "material; every command fails closed on unknown tenant or unknown user.\n"
    "3. Migration rollback smoke: apply 0023 to a private schema, then run the project's documented rollback path "
    "for that migration (if none exists, say so explicitly and prove the table drops cleanly when the private "
    "schema is dropped) - all inside your own private schema, then drop only that schema.\n\n"
    "EXCLUSIVE LEASE (unchanged): migrations/0023_admin_local_users.sql, src/modules/auth/admin-local/**, "
    "src/migrations-local-users-cli.ts, your own test files. NOT yours: src/modules/auth/local-primitives/** "
    "(codex_worker_3), main.ts, server.ts (single integrator qwen_1), packages/**, tasks/*.md, gates/*.\n\n"
    "ACCEPTANCE (honest):\n"
    "1. `npx jest --runInBand` on your test files -> literal 'Tests: N passed, N total' + exit 0.\n"
    "2. `npx tsc --noEmit -p services/orchestrator/tsconfig.json` -> exit 0. (Coordinator re-ran this at 17:25: "
    "EXIT 0 - a previous red was a concurrent write in the other lane's file, since fixed. If you see a red, "
    "report the file:line and whether it is inside your lease.)\n"
    "3. Report appended to du-rework/coordination/reports/codex-local01-admin-local-users-2026-10-01.md: commands "
    "added, what each prints, rollback evidence, and the LOCAL-00 questions that remain.\n\n"
    "SECURITY: fail closed, no enumeration, no plaintext path, no secret in logs or output, no rollback of "
    "another lane's schema."
)

# E3 -> codex_worker_3 : P9-03 doc-compare advanced
E3 = (
    "IMPLEMENTATION PACKET - P9-03 doc-compare advanced (tasks/P9-business-backlog.md line 20: BRD khac compare "
    "core, structure/semantic references, large-doc checkpoints).\n\n"
    "GOAL: implement the doc-compare advanced workflow as a bounded multi-step business workflow in rework, "
    "using orchestrator continuation primitives (children/join, wait-input, resume). NO interpreter inside "
    "Orchestrator.\n\n"
    "EXCLUSIVE LEASE (yours alone - disjoint from qwen_2 who holds disbursement):\n"
    "- du-rework/businesses/document-core/src/pipelines/workflows/doc-compare/** (NEW subdir)\n"
    "- du-rework/businesses/document-core/tests/** (your OWN new test files only)\n"
    "NOT yours: src/pipelines/workflows/disbursement/** (qwen_2), manifest/recipes/actions/validation "
    "(codex_worker_1), packages/**, services/**, tasks/*.md, gates/*, server.ts/main.ts. If manifest or recipe "
    "registration is needed, list it as a follow-up in your report - do not edit those files.\n\n"
    "SCOPE (business logic + tests only):\n"
    "1. Structure-level comparison (section/section alignment, headings, ordering) and semantic-reference "
    "comparison, as distinct steps with typed state between them.\n"
    "2. Large-document handling: chunked processing with checkpoint/restore points, bounded per-chunk work, and a "
    "merge step that produces one evidence record. Must be resumable, not re-run from zero.\n"
    "3. Evidence output: every comparison claim carries its source chunk/section reference so a reviewer can trace "
    "it. No fabricated confidence numbers - if a score cannot be derived, omit the field.\n\n"
    "ACCEPTANCE (honest, every unrun item marked):\n"
    "1. Workflow implemented with typed continuation primitives and explicit checkpoint boundaries.\n"
    "2. Own unit tests green: `npx jest --runInBand --runTestsByPath <your new tests>` -> literal "
    "'Tests: N passed, N total' + exit 0. Include at least one resume-from-checkpoint case.\n"
    "3. `npx tsc --noEmit` from du-rework/businesses/document-core -> exit 0.\n"
    "4. Report: du-rework/coordination/reports/codex-p9-03-doc-compare-2026-10-01.md - include a BRD section "
    "stating what doc-compare does differently from the compare CORE action, and your source citations (legacy "
    "lib/pipelines/workflows/doc-compare.ts or lib/endpoints/registry.ts compare rows) for every claim.\n\n"
    "BOUNDARY: P9-05 (legacy workflow FACADE / public wire / billing parity) stays blocked on COMP-00 - do NOT "
    "mount any route, do NOT edit server.ts/main.ts, do NOT freeze any contract. P9-02 lc-checker remains skipped "
    "(domain criteria missing) - do not touch it.\n"
)

# E4 -> qwen_4 : independent verification of the compat modules
E4 = (
    "VERIFICATION PACKET (read + run only, NO source edits). The COMP-03b-adjacent compat modules were written "
    "by another lane (qwen_4) last packet; an INDEPENDENT lane must verify the hard checks. Do NOT edit "
    "src/compat/** or any other source - if you find a defect, REPORT it, do not fix it.\n\n"
    "FILES UNDER REVIEW: services/orchestrator/src/compat/legacy-input-decoders.ts, "
    "legacy-operation-serializers.ts, tests/compat-decoders.test.ts, and your receipt "
    "coordination/reports/codex-rework-compat-decoders-2026-10-01.md.\n\n"
    "HARD CHECKS - each needs file:line evidence from the current source, not from the receipt:\n"
    "1. Client-supplied credential/identity fields are REJECTED, not honored: x-api-key-id, apiKeyId, "
    "api_key_id, xApiKeyId, tenantId, userId, authorization, role. The only credential path may be x-api-key. "
    "Confirm there is no ADMIN-token fallback branch anywhere in the two files.\n"
    "2. No fabricated terminal state: the serializer must never emit CANCELLED (or any terminal state) that was "
    "not supplied by real operation state. Check every branch that can produce a terminal `done`/error value.\n"
    "3. Strictness is real: unknown fields are rejected rather than silently dropped - and confirm which legacy "
    "params this breaks for (the 7 registry-declared-but-unattached ones), listing each by name.\n"
    "4. Purity: the two modules must not import packages/contracts mutation paths, must not import server.ts or "
    "main.ts, must not be mounted by any route. Verify with grep and report the import list.\n"
    "5. Cursor dialect: verify the next_page_token encode/decode round-trip claim and state exactly which dialect "
    "the module uses, vs which one legacy-operations.ts uses. Confirm the two are genuinely different values for "
    "the same operation id (this is a COMP-00 decision input, so state it as a fact, not a recommendation).\n\n"
    "ALSO RUN: `npx jest --runInBand tests/compat-decoders.test.ts` from du-rework/services/orchestrator -> report "
    "the literal 'Tests: N passed, N total' and exit code. Then run ONE adversarial mutation test of your own "
    "design IN A SCRATCH COPY (never edit the real file): e.g. remove the unknown-field rejection, run the suite, "
    "confirm tests fail, restore, and byte-verify the restore with a checksum. If you cannot do this safely "
    "without touching the source, skip it and say so.\n\n"
    "REPORT: du-rework/coordination/reports/codex-verify-compat-decoders-2026-10-01.md - one section per hard "
    "check with PASS/FAIL + file:line, the test literal, and a defect list ordered by severity. No gate ticks. No "
    "commits. Do not message nocobase-10."
)

JOBS = [
    ("ctx_task_fix_doc_core_counts",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     E1 + COMMON,
     "FIX doc-core 28->31 count assertions + full suite green",
     "doc-core count-assertion fix",
     "Count-only edits (28->31, per-action counts) in existing document-core test files, then full document-core "
     "jest + tsc 0. No assertion weakened; non-count failures reported verbatim, not patched. Receipt appended to "
     "codex-document-core-missing-variants-2026-10-01.md. No COMP tick, no route mount."),
    ("ctx_task_local01_cli_lifecycle",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     E2 + COMMON,
     "LOCAL-01 CLI disable/reset/rotation + migration rollback smoke",
     "LOCAL-01 CLI lifecycle commands",
     "Extend migrations-local-users-cli.ts with disable-admin/reset-password/rotate-credentials (password via "
     "stdin only, generic messages, no secret in output), own tests for ineligible-login/new verifier/version "
     "bump, private-schema rollback smoke, tsc 0. Receipt appended to codex-local01-admin-local-users-2026-10-01.md."),
    ("ctx_task_p9_03_doc_compare",
     "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
     E3 + COMMON,
     "P9-03 doc-compare advanced workflow",
     "P9-03 doc-compare workflow",
     "doc-compare advanced workflow under document-core src/pipelines/workflows/doc-compare/** (disjoint from "
     "qwen_2 disbursement): structure + semantic-reference steps, chunked large-doc processing with checkpoint/"
     "resume, evidence with source refs, no fabricated scores. Own tests + tsc 0. No route mount (P9-05 blocked "
     "on COMP-00). Report codex-p9-03-doc-compare-2026-10-01.md with BRD + citations."),
    ("ctx_task_verify_compat_decoders",
     "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
     E4 + COMMON,
     "Independent verification of compat decoder/serializer hard checks",
     "compat decoder verification",
     "Read-only verification of src/compat/legacy-input-decoders.ts + legacy-operation-serializers.ts (written "
     "by qwen_4 last packet; you verify, you do not touch source): reject client-supplied credential/identity "
     "fields, no fabricated CANCELLED, real strictness (list the 7 broken params), no imports/mounts, "
     "next_page_token dialect fact-vs-fact. Rerun tests + one scratch-copy mutation with checksum-verified "
     "restore. Report codex-verify-compat-decoders-2026-10-01.md. No source edits."),
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
        ("lastNudgeAt", None),
        ("consecutiveUnfinishedChecks", 0),
        ("blocker", None),
        ("receipt", None),
        ("summary", task_spec),
    ])
    print("REGISTERED", key)

# RV01-01 note: still at prompt, direction sent 17:15, no receipt -> observation counter
r1 = disp.get("ctx_task_rv0101_boot_encryption")
if r1:
    r1["consecutiveUnfinishedChecks"] = int(r1.get("consecutiveUnfinishedChecks") or 0) + 1
    r1["lastObservedAt"] = NOW
    print("RV01-01 unchanged reads:", r1["consecutiveUnfinishedChecks"])

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")
print("watch-state total", len(disp), dict(collections.Counter(x["status"] for x in disp.values())))
print("ALL_OK", ok)
