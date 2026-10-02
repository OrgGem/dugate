import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T16:35:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
RUN = "run_2e083dbaeaee"

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

# ---------- C2 settles (2 receipts landed) ----------
s1 = disp.get("ctx_task_rv0108_independent_verification")
if s1 and s1["status"] != "settled":
    s1["status"] = "settled"
    s1["receipt"] = "du-rework/coordination/reports/codex-rv0108-independent-verification-2026-10-01.md"
    s1["settledAt"] = NOW
    s1["lastObservedAt"] = NOW
    s1["blocker"] = ("Goal 2 NOT RUN: `pnpm --filter @du/document-core test` includes "
                     "tests/p8-03-provider-convergence.test.ts (live usage_events projection, DATABASE_URL or "
                     "localhost:5433) - tester correctly refused to touch shared PG. Recorded 790/1/791 stays "
                     "UNVERIFIED. Needs a coordinator CLAIM of the DB window to close.")
    s1["summary"] = (
        "RV01-08 INDEPENDENTLY VERIFIED. Tester role (codex_tester_offline, term_b2d08e87), done 4:23 PM. "
        "Goal 1 ALL PASS: targeted jest 1 suite/1 test, exit 0, raw output pasted; diff assertion-only "
        "(readWithMetadata(artifactId) -> (artifactId, objectContaining({signal: any(AbortSignal)}))); "
        "git status --porcelain src/worker.ts EMPTY; explicit verdict 'PASS - cancellation propagation is intact' "
        "at worker.ts:176-180. Production NOT weakened. Goal 2 BLOCKED by design (shared PG :5433 forbidden) - "
        "full-suite 790/1/791 number remains open pending a claimed DB window. No source/gate/commit."
    )
    print("SETTLED ctx_task_rv0108_independent_verification")

s2 = disp.get("ctx_task_legacy_demo_orphan_surfaces")
if s2 and s2["status"] != "settled":
    s2["status"] = "settled"
    s2["receipt"] = "du-rework/coordination/reports/codex-legacy-demo-orphan-surfaces-2026-10-01.md"
    s2["settledAt"] = NOW
    s2["lastObservedAt"] = NOW
    s2["summary"] = (
        "ORCH-PAR-00 demo/orphan characterization LANDED (codex_worker_1, term_2b05b203). 6 surfaces inventoried "
        "with file:line: /api/chat (unauthenticated, public, outside /api/v1/*), /api/internal/prompt-wizard "
        "(requireAuth, any logged-in role), /doc-pipeline + /lc-checker + /doc-compare (3 browser pages posting "
        "process= to /api/v1/docs/workflows, page GET not auth-gated at page level), mock-service (/health + "
        "/ext/:slug, MOCK_API_KEY, port 3099). KEY NEGATIVE FINDING: no surface makes a DIRECT provider SDK call - "
        "all are connection-row backed; seed wires endpoints to MOCK_SERVICE_URL, so production can depend on the "
        "mock INDIRECTLY via seeded connection rows. Classification section 4 is 5x NEEDS-PRODUCT (product owner / "
        "user dependency not establishable from code) + 1x RETIRE (mock-service, contingent on confirming no env "
        "relies on seed-generated mock URLs). Closes the zero-coverage gap that fed ORCH-PAR-00. Feeds product "
        "sign-off only - NOT a COMP task, no implementation, no gate tick."
    )
    print("SETTLED ctx_task_legacy_demo_orphan_surfaces")

# ---------- C3 dispatch: 2 read-only characterization to idle lanes ----------
CHAR_A = (
"READ-ONLY CHARACTERIZATION (COMP-02 input, no implementation, no COMP-02 task itself).\n\n"
"GOAL: produce the wire facts COMP-02 needs to freeze the invocation request/response contract. You are gathering "
"EVIDENCE for a decision that has not been made yet - do not decide it, do not edit anything outside your one "
"report file.\n\n"
"SCOPE - legacy side (read only, cite file:line on EVERY claim):\n"
"1. Every place legacy code POSTs to a connector / external endpoint. For each: the HTTP method, the path, the "
"   content-type, the exact multipart field names and their order/significance, and which fields carry the prompt, "
"   the file bytes, and the session id.\n"
"2. Every place legacy code READS a connector response. For each: which field it extracts, what it does when that "
"   field is missing, and whether it retries or fails closed.\n"
"3. Whether any legacy connector call carries an HTTP auth header, and whether any caller-supplied header can "
"   override or replace that auth header. Name the exact merge/assign order.\n"
"4. The 3 concrete failure modes the reviewer already flagged - for each, cite the legacy file:line and state "
"   whether rework has the same exposure, has a guard, or has nothing: (a) raw remote file URL forwarding that "
"   bypasses an egress/SSRF guard; (b) validate-then-fetch with a DNS recheck gap across redirects; (c) a secret "
"   placed in a URL query string that is then logged verbatim.\n\n"
"SCOPE - rework side (read only, cite file:line):\n"
"5. The rework connector-client request builder: method, path, headers, how the grant is carried (header vs body), "
"   and how the response body is returned to the worker.\n"
"6. The rework worker-side invoker: which fields it reads off the response, and what it does when a field is absent.\n\n"
"DELIVERABLE: a single table 'legacy behaviour | rework behaviour | same or different | evidence file:line' with one "
"row per behaviour in points 1-6, then a short list of the concrete questions COMP-02 must answer (not answers - "
"questions). Where legacy and rework differ, state the SEMANTIC consequence, not just the diff.\n\n"
"CONSTRAINTS: read-only toward du-rework source. Your only write is the report file. No tests run. No gate or task "
"row changes. No commits. Do NOT message nocobase-10. Do NOT edit packages/contracts, server.ts, main.ts, or "
"docs/21-openapi.json - those are leased or frozen.\n\n"
"OUTPUT: du-rework/coordination/reports/codex-rework-legacy-connector-wire-2026-10-01.md (NEW file, your only write).\n"
"ETA/CHECKPOINT: report back when the file exists. If a claim cannot be sourced, write 'NOT ESTABLISHED' rather "
"than guessing."
)

CHAR_B = (
"READ-ONLY CHARACTERIZATION (ORCH-PAR-00 input #2, no implementation).\n\n"
"GOAL: the previous report classified the legacy demo/orphan surfaces as NEEDS-PRODUCT because product ownership "
"and user dependency cannot be established from code. Your job is to close the SECOND half of that gap from the "
"side that CAN be established: usage and reachability evidence inside this repository. You cannot decide product "
"intent - only report what the repo shows.\n\n"
"SCOPE (read-only, cite file:line or grep hits on every claim):\n"
"1. Which of these surfaces have ANY inbound reference anywhere outside their own directory: homepage chat, "
"   prompt wizard, doc-pipeline, lc-checker, doc-compare, mock-service. Search components/, app/ (other pages), "
"   lib/, docs/, scripts/, tests/, package.json scripts, and any nav/header/menu component. Report each hit as a "
"   real inbound link, a doc mention, or nothing.\n"
"2. Deployment coupling: does any deploy script, compose file, Dockerfile, systemd unit, or package.json script "
"   start the mock service or set MOCK_SERVICE_URL? If the mock is required for a dev or demo environment to boot, "
"   say exactly which file requires it.\n"
"3. Documentation coupling: which of these surfaces are documented as a supported feature (a user-facing doc, a "
"   README, an API doc) versus absent from docs entirely. Quote the doc line.\n"
"4. Test coupling: which of these surfaces have automated coverage, and which have none.\n"
"5. For each surface, one row: inbound references count | deploy coupling Y/N | documented Y/N | test coverage "
"   Y/N | and the single fact that, if known, would decide cutover-required vs retire.\n\n"
"EXPLICITLY OUT OF SCOPE: do not open, read, or comment on du-rework source code. This task is legacy-side only.\n\n"
"CONSTRAINTS: read-only. Your only write is the report file. No tests run. No gate or task row changes. No commits. "
"Do NOT message nocobase-10.\n"
"OUTPUT: du-rework/coordination/reports/codex-legacy-demo-orphan-reachability-2026-10-01.md (NEW file, your only write).\n"
"ETA/CHECKPOINT: report back when the file exists. A row with zero inbound references is a VALID and useful result - "
"do not manufacture references to fill the table."
)

JOBS = [
    ("ctx_task_connector_wire_characterization",
     "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
     CHAR_A,
     "Read-only characterization feeding COMP-02: legacy vs rework connector invocation wire (request/response, auth "
     "header merge order, 3 flagged failure modes) + the questions COMP-02 must answer. No COMP-02 task, no code edit.",
     "Legacy vs rework connector wire characterization (COMP-02 input)",
     "qwen_4",
     "Read-only. Table 'legacy behaviour | rework behaviour | same/different | file:line' for connector invocation "
     "request/response, auth-header merge order, and the 3 flagged exposures (raw remote URL egress bypass, "
     "validate-then-fetch DNS/redirect gap, secret-in-query logged verbatim). End with questions COMP-02 must answer, "
     "not answers. Output coordination/reports/codex-rework-legacy-connector-wire-2026-10-01.md. No source edits, "
     "no contracts/server.ts/main.ts/OpenAPI edits, no gate ticks, no commit."),

    ("ctx_task_demo_orphan_reachability",
     "term_f1ed751c-4c2a-4563-9687-0a5b30c5900a",
     CHAR_B,
     "Read-only reachability/usage evidence for the 6 legacy demo-orphan surfaces (inbound refs, deploy coupling, doc "
     "coupling, test coverage) to close the product-decision half of ORCH-PAR-00 from the repo side.",
     "Legacy demo/orphan reachability + deploy/doc/test coupling",
     "codex_worker_3",
     "Read-only, LEGACY side only (do not open du-rework source). For homepage chat / prompt wizard / doc-pipeline / "
     "lc-checker / doc-compare / mock-service: count real inbound references outside their own dir, check deploy "
     "coupling (does anything require the mock to boot), doc coupling (supported feature vs undocumented), test "
     "coverage. One row per surface + the single deciding fact. Zero references is a valid result. Output "
     "coordination/reports/codex-legacy-demo-orphan-reachability-2026-10-01.md. No source edits, no gate ticks, no commit."),
]


def dispatch(key, handle, spec, title, display, task_spec):
    p = subprocess.run(["orca", "terminal", "send", "--terminal", handle, "--text", spec, "--enter"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = ((p.stdout or "") + (p.stderr or ""))[:200]
    print(f"[{key}] SEND_EXIT {p.returncode} | {out}")
    tp = subprocess.run(["orca", "orchestration", "task-create", "--run", RUN,
                         "--task-title", title, "--display-name", display, "--spec", task_spec],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    tout = ((tp.stdout or "") + (tp.stderr or ""))[:200]
    print(f"[{key}] TASK_EXIT {tp.returncode} | {tout}")
    return p.returncode == 0 and tp.returncode == 0


ok = True
for key, handle, spec, summary, title, display, task_spec in JOBS:
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
        ("summary", summary),
    ])
    print("REGISTERED", key)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")
print("watch-state total", len(disp), dict(collections.Counter(x["status"] for x in disp.values())))
print("ALL_OK", ok)
