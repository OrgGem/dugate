import json, sys, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:45:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"

SETTLES = {
    "ctx_task_legacy_external_api_call_wire": (
        "codex-legacy-external-api-call-wire-2026-10-01.md",
        "Legacy external-api call wire: multipart composition (prompt/static/file/input_content/"
        "file_url/session parts), auth matrix API_KEY_HEADER|BEARER + extraHeaders can override the "
        "auth header (external-api.ts:119-134), response parsed ORCHESTRATOR-side (:161-165 "
        "extractContent), engine catch is terminal without rejecting the job. Rework counterpart is "
        "connector-client transport.ts:175 POST /invocations with grant in body (report said 'not "
        "found' — scope artifact, corrected in C4). 3 new MUST-NOT-REPLICATE: raw remoteFileUrls "
        "forward bypassing egress guard (:102-107), redirect/DNS gap http-client.ts:96-130, secret "
        "in endpointUrl query logged verbatim. C4 verified against external-api.ts:68-134 live.",
    ),
    "ctx_task_legacy_parsers_ingest_parse_wire": (
        "codex-legacy-parsers-ingest-parse-wire-2026-10-01.md",
        "Legacy parser registry + ingest/extract routing: Excel+Word only, no PDF parser "
        "(factory.ts:4-7,9-14 pdfjs-dist canvas unavailable), extension-only dispatch with empty "
        "MIME from external-api.ts:37-38, internal parser runs ONLY when filePaths.length===1 and "
        "engine.ts:343 gives files to step 0 only; parser match SHORT-CIRCUITS and skips the "
        "external connector entirely (:50-58 return). 31-row sub-case matrix present. Word: mammoth "
        "raw text duplicated into text+markdown, no HTML/tables/images; corrupt DOCX -> warn + "
        "external fallback. Excel: ALL nonempty sheets -> markdown tables. content_preview 500-char "
        "but full content persisted as outputContent (engine.ts:369,399). Upload allowlist is "
        ".docx/.pdf only (upload.ts:10). Rework document-kit: magic-byte detection, PDF registered, "
        "ParserBudgetHelper bounded reads, still invokes reasoning connector after parse. 4 "
        "MUST-NOT-REPLICATE: unbounded readFile, .docm gap, workflow path read, silent parse-failure "
        "fallback. C4 verified engine.ts:343/369/399 + extract/index.ts:38-42 live.",
    ),
}

w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

for key, (receipt, summary) in SETTLES.items():
    d = disp.get(key)
    if d is None:
        print("MISSING", key)
        continue
    if d["status"] == "settled":
        print("ALREADY_SETTLED", key)
        continue
    d["status"] = "settled"
    d["receipt"] = receipt
    d["summary"] = summary
    d["settledAt"] = NOW
    d["lastObservedAt"] = NOW
    d["blocker"] = None
    print("SETTLED", key, "->", receipt)

w["lastCheckedAt"] = NOW
json.dump(w, open(W, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(W, "a", encoding="utf-8").write("\n")

c = collections.Counter(x["status"] for x in disp.values())
print("total", len(disp), dict(c))
