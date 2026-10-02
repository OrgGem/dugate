#!/usr/bin/env python3
# Coordinator dispatch wave 3 — 2026-10-01 09:25 +07 (Claude session, user-authorized)
import json, subprocess, collections, os
os.chdir(r"D:\Git\dugate\du-rework")

ORCA = r"C:\Users\Gem\AppData\Local\Programs\orca\resources\bin\orca.exe"
RUN = "run_2e083dbaeaee"
NOW = "2026-10-01T09:25:00+07:00"

TASKS = [
 ("task_variant_recipe_gap",
  "COMP-04 read-only gap: 31 variants decoder->business action/recipe in rework",
  "term_27eb3380-f9c3-466a-8b4e-0b7fa0ad23fc",
  "READ-ONLY gap analysis feeding COMP-04 (do NOT tick, do NOT implement). Context: your COMP-01 matrix (reports/comp-01-characterization-matrix.md) confirmed 31 core + 3 workflow sub-cases with registry file:line. I verified separately that services/orchestrator/src/compat/legacy-wire-decoders.ts allow-lists contain all 31 (id-card, fact-check, summarize-eval included). So the DECODER is 31-complete; the open question is whether rework can actually EXECUTE all 31. Task: for each of the 31 core variants, map rework end-to-end coverage: input-normalizer discriminator -> actions.ts action id -> business action / recipe / external connector -> output_format union -> output target (inline vs artifact/download). Deliverable: a 31-row table with the gap class per row: FULL / MISSING-RECIPE / MISSING-CONNECTOR / OUTPUT-FORMAT-GAP / DISCRIMINATOR-ALIAS. Known leads to verify and extend, from your own matrix: M-21 transform legacy 'action' vs rework 'variant' (alias at input-normalizer.ts:184); M-22 rework honours targetLanguage/redactPatterns/maxWords/audience which legacy declares but never attaches; M-23 focus_areas + glossary modelled nowhere in rework; M-24 output_format legacy {md,json,html,csv} vs rework {json,md,text} so html+csv have no counterpart; M-25 legacy takes files/file_urls while rework takes artifactIds. Explicit hard check: do NOT conclude parity from a decoder allow-list alone - a name that decodes but has no business action is a GAP, not parity. Limits: read-only; write only your own report (or append a clearly-headed COMP-04 section to reports/comp-01-characterization-matrix.md); no source edits; no gate ticks; no contract freeze."),

 ("task_legacy_live_fixture_replay",
  "Turn COMP-01 high-risk rows (M-06/M-10/M-12) into live-verified or executable fixtures",
  "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
  "Your COMP-07 lifecycle char (reports/tester.md:11788) is SETTLED - thank you, the resume-without-fence finding is the most important security item of the wave. New task. Your lifecycle char and the COMP-01 matrix (reports/comp-01-characterization-matrix.md section 5) both state that no characterization was EXECUTED: every row is a code-read inference. The matrix names M-06, M-10 and M-12 as the three rows worth replaying first because they break migrations silently. Task, in order of value: (1) IF a live legacy instance can be reached without you starting one (existing DB/Redis already running, a documented test harness you can reuse), replay only those three rows and record the OBSERVED status/body against the predicted one. (2) OTHERWISE, and do not pretend otherwise, produce an EXECUTABLE FIXTURE SPEC for each: exact request (method, path, multipart/form field names and values, headers), expected status, expected response keys, and which line of code makes the prediction - so any later wave with infra can run it in one command. (3) Always state plainly which of the two you did. Do NOT start the legacy app, do NOT install anything, do NOT run migrations. If legacy infra is unreachable, that is a legitimate blocker to report, not a failure to work around by inventing results. Limits: no source edits; no gate ticks; no contract freeze; write only your own report."),

 ("task_legacy_idempotency_char",
  "Legacy idempotency + sync behavior characterization (idempotency-key, ?sync)",
  "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
  "Your keyset planner flake fix is SETTLED - 18/18 x3 with enable_seqscan=off pinned only on that EXPLAIN, semantic assertions unchanged. That was the right shape of fix. New READ-ONLY task. Characterize legacy idempotency and sync behavior, feeding COMP-03 (which requires idempotency-key + x-correlation-id to produce ONE operation, and ?sync=true bounded to return 200 when done vs 202 + Operation-Location otherwise). Sources: lib/endpoints/runner.ts (idempotencyKey from header, sync query param at :70,229,257 per prior reading), lib/pipelines/submit.ts (idempotent lookup, save, enqueue), and any unique constraint or lookup path used for replay. Capture: what exactly is hashed/compared, scope of the key (per apiKey? global?), what the replay response looks like (same ID? same status? different status?), what happens on concurrent double-submit, whether the key is recorded before or after enqueue (crash window), and what sync=true actually blocks on plus its timeout behavior. Then compare with rework: services/orchestrator/src/... submission/idempotency code and the sync handling in server.ts. Deliverable: behavior table + MISMATCH list with file:line. Hard check: a replay that returns 202 when the first submission already returned 200, or a second submission that silently creates a second operation, are both COMP-03 blockers - flag them, do not fix them. Limits: read-only; write only your own report; no source edits; no gate ticks."),

 ("task_input_bridge_char",
  "M-25 input model: legacy files/file_urls vs rework artifactIds (COMP-03 bridge gap)",
  "term_2b05b203-549f-4428-b908-c303a2b187ec",
  "Your webhook char (reports/qwen-platform.md:4976) is SETTLED - the explicit answer that an unmodified legacy receiver breaks under delivery encryption is exactly what COMP-05 needed, and I verified the two anchors myself (webhooks.ts:435-447 builds body then signs, fail-closed; migration 0007 payload jsonb plaintext). New READ-ONLY task. COMP-01 matrix row M-25: legacy submit takes multipart files or a file_urls JSON array (lib/endpoints/runner.ts:36-56), while rework submit takes artifactIds references (actions.ts:12). COMP-03 requires six POST /api/v1/docs/{service} multipart facades accepting files[], file, source_file, target_file, file_urls, webhook_url plus a discriminator and snake_case fields. Task: characterize the input bridge gap. (1) Legacy: enumerate exactly which input field names each of the 6 routes accepts, their precedence when several are supplied together, the file_urls item shape (url, filename, mime_type), per-profile fileUrlAuthConfig and allowedFileExtensions (lib/file-url-downloader.ts, lib/upload.ts, lib/upload-helper.ts), 300MB limit, macro/path-traversal rejection, and the SSRF assertSafeUrl call site. (2) Rework: how a request becomes an artifact today - the upload surface, artifact storage/encryption gateway, and where artifactIds come from; whether any multipart path exists at all. (3) The bridge: what COMP-03 must add so that a legacy multipart request produces the same operation without the client changing, and where the SSRF/size/MIME checks must live so they cannot be bypassed via file_urls. Deliverable: field-name + precedence table, then a gap list with file:line. Hard check: file_urls must not become an SSRF bypass - if rework's current artifact path assumes a trusted uploader and has no URL-fetch guard, say so plainly. Limits: read-only; write only your own report; no source edits; no gate ticks."),
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
 "ctx_task_comp01_matrix": "reports/comp-01-characterization-matrix.md (353 lines; 31 core + 3 workflow with registry file:line; 25 MISMATCH; honest limit: no fixture executed)",
 "ctx_task_keyset_planner_flake_fix": "reports/tester.md:11840 (18/18 x3 with enable_seqscan=off pinned only on the created_at EXPLAIN; semantic assertions unchanged)",
 "ctx_task_legacy_webhook_char": "reports/qwen-platform.md:4976 (LEGACY WEBHOOK CALLBACK CHARACTERIZATION; legacy receiver breaks under delivery encryption; Δ120/Δ121 listed)",
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
