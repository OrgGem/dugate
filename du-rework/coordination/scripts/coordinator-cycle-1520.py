import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:20:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
HANDLE = "term_949d489b-0ce8-4242-a8c2-988362192922"
KEY = "ctx_task_legacy_parsers_ingest_parse_wire"

SPEC = (
"READ-ONLY characterization task. Goal: capture the LEGACY local document-parser path used by "
"ingest/extract — which files are parsed in-process, which are deferred to the external-API "
"connector, what each parser returns, and how that maps to rework packages/document-kit. This is "
"an UNCOVERED surface: no 2026-10-01 receipt covers lib/parsers/.\n\n"
"SCOPE — read ONLY these, no writes outside your one report file:\n"
"- lib/parsers/interface.ts, factory.ts, word-parser.ts, excel-parser.ts, index.ts (full files)\n"
"- every consumer of ParserFactory / getParserForFile (grep + read call sites)\n"
"- the ingest:parse and extract:* code paths that decide internal-parser vs external connector "
"(lib/endpoints/runner.ts relevant sections, lib/pipelines/engine.ts relevant sections, "
"lib/pipelines/processors/external-api.ts if it branches on parser presence)\n"
"- lib/upload.ts mime/extension mapping that the factory depends on\n"
"- rework counterpart (read-only): du-rework/packages/document-kit/src/** "
"(formats, parsers, converters, archives), and which rework path invokes it "
"(businesses/document-core or orchestrator action handlers)\n\n"
"CAPTURE — every claim file:line:\n"
"1. PARSER REGISTRY: exact canHandle predicate per parser (mime list + extension list), the "
"PDF exclusion note and what the factory returns when no parser matches (null → external "
"connector), and where that decision is actually made in the pipeline.\n"
"2. WORD PARSER OUTPUT: mammoth usage, what fields the parser emits (text/html? tables? images?), "
"size/error behavior on corrupt DOCX, and whether output feeds content_preview only or the full "
"step result.\n"
"3. EXCEL PARSER OUTPUT: sheet selection (all sheets or first?), cell rendering, empty-workbook "
"behavior, error behavior on corrupt XLSX.\n"
"4. DECISION WIRE: for each of the 31 sub-cases, state whether ingest:parse / extract:* actually "
"routes DOCX/XLSX to the internal parser (cite the call site) or always goes external — and what "
"file_urls / sync / output_format do to that decision.\n"
"5. REWORK COUNTERPART: document-kit capabilities (formats/parsers/converters/archives), which "
"rework code path invokes them, and a plain delta table legacy-in-process-docx-xlsx vs rework-"
"document-kit (coverage, output shape, PDF handling).\n\n"
"OUTPUT: du-rework/coordination/reports/codex-legacy-parsers-ingest-parse-wire-2026-10-01.md "
"(NEW file, your only write). Markdown, file:line on every claim, MUST-NOT-REPLICATE section for "
"anti-patterns (e.g. unbounded file read into memory, macro/docm handling gaps, path traversal "
"via filename, silent fallback that pretends parse succeeded). No fixes proposed, no gate/COMP row "
"changes, no source edits, no tests run.\n\n"
"ACCEPTANCE: report exists at the path above; sections 1-5 all present with file:line; section 4 "
"must be explicit per relevant sub-case (internal vs external), not a vague summary; section 5 "
"delta table present.\n\n"
"DEPENDENCY: none — read-only, COMP-00 not required, does not touch server.ts, does not dispatch "
"implementation. Do NOT message nocobase-10. Do NOT edit any source file."
)

def main():
    p = subprocess.run(["orca","terminal","send","--terminal",HANDLE,"--text",SPEC,"--enter"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("SEND_EXIT", p.returncode)
    print("STDOUT", (p.stdout or "")[:500])
    print("STDERR", (p.stderr or "")[:300])

    tp = subprocess.run([
        "orca","orchestration","task-create","--run","run_2e083dbaeaee",
        "--task-title","Legacy parsers / ingest-parse wire characterization",
        "--display-name","codex-worker-3",
        "--spec","Read-only: legacy lib/parsers (word/excel/factory) + which sub-cases parse in-process vs external connector, vs rework packages/document-kit. Report only at du-rework/coordination/reports/codex-legacy-parsers-ingest-parse-wire-2026-10-01.md. No source edits, no gate ticks. Feeds COMP-01a/02 + COMP-00 decision #2 (parser/connector split).",
    ], capture_output=True, text=True, encoding="utf-8", errors="replace")
    print("TASK_EXIT", tp.returncode)
    print("TASK_OUT", ((tp.stdout or "") + (tp.stderr or ""))[:300])

    w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
    disp = w["dispatches"]
    if KEY in disp:
        print("ALREADY", KEY, disp[KEY].get("status"))
    else:
        disp[KEY] = collections.OrderedDict([
            ("status","running"),("terminalHandle",HANDLE),("dispatchedAt",NOW),
            ("lastObservedAt",NOW),("consecutiveUnfinishedChecks",0),("blocker",None),
            ("receipt",None),
            ("summary","Read-only: legacy lib/parsers word/excel + internal-vs-external parse decision per sub-case vs rework document-kit; feeds COMP-01a/02."),
        ])
        print("REGISTERED", KEY)
    w["lastCheckedAt"] = NOW
    json.dump(w, open(W,"w",encoding="utf-8"), ensure_ascii=False, indent=2)
    open(W,"a",encoding="utf-8").write("\n")
    c = collections.Counter(x["status"] for x in disp.values())
    print("watch-state total", len(disp), dict(c))

main()
