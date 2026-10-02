import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:10:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
HANDLE = "term_2b05b203-549f-4428-b908-c303a2b187ec"
KEY = "ctx_task_legacy_external_api_call_wire"

SPEC = (
"READ-ONLY characterization task. Goal: capture the LEGACY external-API step call wire — "
"what the pipeline actually sends to ExternalApiConnection targets and what it parses back — so "
"COMP-02 wire freeze and COMP-03 have a precise baseline. This complements the already-settled "
"session-chain receipt (which covered prompt precedence + promptFieldName only) and the "
"egress-url-guard inventory (which covered fetch guards, not the processor composition).\n\n"
"SCOPE — read ONLY these, no writes outside your one report file:\n"
"- lib/pipelines/processors/external-api.ts (full file)\n"
"- lib/pipelines/processors/http-client.ts (full file)\n"
"- lib/pipelines/processors/response-parser.ts (full file)\n"
"- lib/pipelines/processors/prompt-resolver.ts (already partially covered — only fill gaps)\n"
"- lib/pipelines/engine.ts sections that call the processor + error catch\n"
"- lib/db/schema.ts ExternalApiConnection columns (authType field list)\n"
"- rework counterpart: du-rework/services/orchestrator/src/modules/connectors/** and "
"packages/contracts action connector-slot types (read-only)\n\n"
"CAPTURE — every claim file:line:\n"
"1. REQUEST COMPOSITION: multipart/form-data field names exactly as sent (file field name, "
"prompt field name from connection.promptFieldName, other appended fields e.g. pages/output_format/"
"language when present), whether file is multipart part vs URL vs inline text, session field handling "
"(sessionId/cookie/etc from response), any extra headers injected (auth header name from authType).\n"
"2. AUTH MATRIX: every authType value in the schema/registry, what header/field each injects, "
"whether the secret is ever put in URL query, and whether the connection prompt/state is sent even "
"when auth fails at the connection layer.\n"
"3. RESPONSE PARSING: response-path extraction (connection.responsePath dotted path semantics, "
"missing path behavior), content_preview 500-char rule, extracted_data presence, pipeline_state "
"capture field, what happens on non-JSON / HTML / empty body / non-2xx status.\n"
"4. ERROR + RETRY WIRE: which HTTP/client errors the processor throws vs swallows, error message "
"shape stored on Operation.error, errorCode values, whether the engine catch is terminal FAILED "
"(no processor-level retry) and how that interacts with queue attempts:3.\n"
"5. SSRF/EGRESS: how http-client enforces URL validation relative to the egress guard inventory "
"(cite both), timeouts, redirect handling, size caps if any.\n"
"6. REWORK COUNTERPART: how rework invokes connector actions — connector slot types in "
"packages/contracts, how orchestrator posts to connector service (endpoint, auth, payload shape), "
"whether response parsing is connector-side or orchestrator-side, and a plain delta table "
"legacy-vs-rework for fields 1-4.\n\n"
"OUTPUT: du-rework/coordination/reports/codex-legacy-external-api-call-wire-2026-10-01.md "
"(NEW file, your only write). Markdown, plain language, file:line on every claim, MUST-NOT-REPLICATE "
"section for anything that is a legacy vulnerability or fake-terminal/security anti-pattern "
"(e.g. secrets in query strings, missing tenant checks, unconditional plaintext). No fixes proposed, "
"no gate/COMP row changes, no source edits, no tests run.\n\n"
"ACCEPTANCE: report exists at the path above; every numbered section has file:line citations; "
"delta table present; hard-check — must state explicitly whether response parsing happens legacy-side "
"(orchestrator) or connector-side, with the exact code location that decides it.\n\n"
"DEPENDENCY: none — read-only, COMP-00 not required, does not touch server.ts, does not dispatch "
"implementation. Do NOT message nocobase-10. Do NOT edit any source file."
)

def main():
    # dispatch via orca
    cmd = ["orca", "terminal", "send", "--terminal", HANDLE, "--text", SPEC, "--enter"]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("SEND_EXIT", p.returncode)
    print("STDOUT", (p.stdout or "")[:400])
    print("STDERR", (p.stderr or "")[:400])

    # register task
    tcmd = [
        "orca", "orchestration", "task-create", "--run", "run_2e083dbaeaee",
        "--title", "Legacy external-api call wire characterization",
        "--assignee", HANDLE,
        "--description", "Read-only: legacy processor multipart/auth/response-path/error wire vs rework connector invocation. Report only.",
    ]
    tp = subprocess.run(tcmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("TASK_EXIT", tp.returncode)
    print("TASK_OUT", ((tp.stdout or "") + (tp.stderr or ""))[:400])

    # watch-state register
    w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
    disp = w["dispatches"]
    if KEY in disp:
        print("ALREADY", KEY, disp[KEY].get("status"))
    else:
        disp[KEY] = collections.OrderedDict([
            ("status", "running"),
            ("terminalHandle", HANDLE),
            ("dispatchedAt", NOW),
            ("lastObservedAt", NOW),
            ("consecutiveUnfinishedChecks", 0),
            ("blocker", None),
            ("receipt", None),
            ("summary", "Read-only: legacy external-api processor call wire (multipart/auth/response-path/error) vs rework connector invocation; feeds COMP-02 freeze + COMP-03."),
        ])
        print("REGISTERED", KEY)

    w["lastCheckedAt"] = NOW
    json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    open(W, "a", encoding="utf-8").write("\n")
    c = collections.Counter(x["status"] for x in disp.values())
    print("watch-state total", len(disp), dict(c))

main()
