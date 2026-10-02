import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T15:50:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
RUN = "run_2e083dbaeaee"

FIX_SPEC = (
"FIX TASK (priority a — red test with evidence, verified live this cycle). "
"Goal: make `businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts` pass WITHOUT weakening "
"production. I re-ran the file: `npx jest tests/r1-e-sdk-metadata-adapter.test.ts --runInBand` = 1/1 FAILED.\n\n"
"EXACT FAILURE (live):\n"
"  tests/r1-e-sdk-metadata-adapter.test.ts:71\n"
"  expect(readWithMetadata).toHaveBeenCalledWith(artifactId)\n"
"  Expected: \"0eaa68d6-8d2c-4655-beab-93d327a0a3af\"\n"
"  Received: \"0eaa68d6-8d2c-4655-beab-93d327a0a3af\", { signal: AbortSignal }\n"
"  Number of calls: 1\n\n"
"ROOT CAUSE: production now forwards a cancellation signal — `src/worker.ts:176-179` calls "
"`artifactFacade.readWithMetadata(id, options)` where options carries `signal` (AbortSignal from the "
"task ctx). The assertion is stale; production behavior is CORRECT and must stay.\n\n"
"WHAT YOU MAY EDIT — ONLY these:\n"
"- `businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts` (the assertion at :71).\n"
"Update the expectation to assert BOTH: (a) first arg is exactly `artifactId`, (b) second arg is an "
"object forwarding an `AbortSignal` (e.g. `expect.objectContaining({ signal: expect.any(AbortSignal) })` "
"or a direct check). Keep every other assertion in the file unchanged.\n\n"
"STRICTLY FORBIDDEN:\n"
"- Do NOT edit `src/worker.ts` or any production file to remove/reorder the signal so the old assertion "
"green. That would delete cancellation propagation — a real regression, not a test artifact.\n"
"- Do NOT relax other assertions, delete the test, or skip it.\n"
"- Do NOT touch any other test file or package.\n\n"
"ACCEPTANCE (must all be true, paste real output in your recap):\n"
"1. `cd du-rework/businesses/document-core && npx jest tests/r1-e-sdk-metadata-adapter.test.ts --runInBand` → all green, exit 0.\n"
"2. `git diff --stat` touches ONLY that one test file.\n"
"3. No production file in the diff.\n"
"4. Recap states the new assertion text verbatim.\n\n"
"DEPENDENCY: none — test-only, independent of COMP-00, does not mount `server.ts`, does not require any gate. "
"Do NOT message nocobase-10. Do NOT tick any gate/COMP/P9 row. Do NOT commit."
)

CHAR_SPEC = (
"READ-ONLY characterization task. Goal: capture the LEGACY demo / non-product surfaces that ORCH-PAR-00 "
"must classify as `cutover-required` / `post-cutover` / `retire`, and which currently have ZERO receipt "
"coverage in this session's reports. This feeds the ORCH-PAR-00 product sign-off, not COMP wire freeze.\n\n"
"SCOPE — read ONLY these, no writes outside your one report file:\n"
"- `app/api/chat/route.ts` (full file) — the public homepage chat/demo endpoint.\n"
"- `app/api/internal/prompt-wizard/route.ts` (full file) — admin prompt wizard.\n"
"- `app/doc-pipeline/**`, `app/lc-checker/**`, `app/doc-compare/**` (route/page entry points — enough to "
"state what each surface does and who can reach it, not every component).\n"
"- `mock-service/` (entry point + what it fakes) and where `MOCK_SERVICE_URL` / mock connections are "
"wired in `lib/` (submit/worker path).\n"
"- Rework counterpart (read-only): does `services/orchestrator/src/app/admin/**` or `server.ts` contain any "
"chat / prompt-wizard / doc-pipeline / mock equivalent? Does `services/connector`? Cite what you find or "
"explicitly state absence.\n\n"
"CAPTURE — every claim file:line:\n"
"1. SURFACE INVENTORY: for each surface — route path, HTTP methods exported, auth gate applied or absent "
"(cite the middleware/NextAuth branch or note it is unauthenticated), what it reads/writes, and whether it "
"is reachable from the public `/api/v1/*` namespace or only the UI/admin namespace.\n"
"2. PROVIDER CALL PATH: which AI provider/model each surface calls, and whether it bypasses ExternalApiConnection "
"and goes straight to Gemini/OpenAI. This is the decisive `retire` vs `post-cutover` signal — a surface that "
"does direct provider calls and has no external consumer should be a retire candidate, not an Orchestrator feature.\n"
"3. MOCK SERVICE: what `mock-service` fakes, how `MOCK_SERVICE_URL` is consumed, whether any non-test path "
"depends on it, and whether rework has a counterpart test double.\n"
"4. CLASSIFICATION (your proposal, clearly labeled as proposal — NOT a decision): per surface, one row of "
"retire / post-cutover / cutover-required, with the one-line reason and the file:line evidence above. Mark "
"any surface you cannot classify as `NEEDS-PRODUCT` with the specific missing fact.\n"
"5. REWORK GAP: for any surface proposed `cutover-required`, state what rework already has and what is "
"missing; for `retire`, state what would be deleted and any data/behavior a client might still depend on.\n\n"
"OUTPUT: du-rework/coordination/reports/codex-legacy-demo-orphan-surfaces-2026-10-01.md "
"(NEW file, your only write). Markdown, file:line on every claim. No fixes proposed, no gate/COMP/PAR row "
"changes, no source edits, no tests run.\n\n"
"ACCEPTANCE: report exists at the path above; sections 1-5 present; section 4 has one row per surface with "
"an explicit classification label; every claim carries file:line.\n\n"
"DEPENDENCY: none — read-only, COMP-00 not required, does not touch `server.ts`, does not dispatch "
"implementation. Do NOT message nocobase-10. Do NOT edit any source file."
)

JOBS = [
    ("ctx_task_rv0108_sdk_metadata_adapter_test",
     "term_949d489b-0ce8-4242-a8c2-988362192922",
     FIX_SPEC,
     "RV01-08 — fix red SDK metadata adapter test assertion (test-only, signal forwarded by worker.ts:176-179).",
     "Legacy parsers / RV01-08 SDK metadata adapter test fix",
     "codex-worker-3",
     "Fix: stale assertion at document-core/tests/r1-e-sdk-metadata-adapter.test.ts:71 expects "
     "readWithMetadata(artifactId) but production forwards AbortSignal via worker.ts:176-179. "
     "Update the assertion only; do NOT weaken production. Test-only, no gate tick, no server.ts.",
     "codex-legacy-parsers-ingest-parse-wire-2026-10-01.md"),
    ("ctx_task_legacy_demo_orphan_surfaces",
     "term_2b05b203-549f-4428-b908-c303a2b187ec",
     CHAR_SPEC,
     "Read-only: legacy chat/prompt-wizard/doc-pipeline/lc-checker/doc-compare + mock-service classification inputs for ORCH-PAR-00 (zero receipt coverage).",
     "Legacy demo / orphan surface characterization (ORCH-PAR-00)",
     "codex-worker-1",
     "Read-only: app/api/chat, prompt-wizard, doc-pipeline/lc-checker/doc-compare, mock-service — "
     "auth gate, provider call path, retire-vs-cutover proposal for ORCH-PAR-00. Report only at "
     "coordination/reports/codex-legacy-demo-orphan-surfaces-2026-10-01.md. No source edits, no gate ticks.",
     None),
]

def dispatch(key, handle, spec, summary, title, display, task_spec, existing_receipt):
    # 1. terminal send
    p = subprocess.run(["orca", "terminal", "send", "--terminal", handle, "--text", spec, "--enter"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"[{key}] SEND_EXIT {p.returncode}")
    out = (p.stdout or "") + (p.stderr or "")
    print(f"[{key}] SEND_OUT {out[:250]}")

    # 2. task-create
    tp = subprocess.run(
        ["orca", "orchestration", "task-create", "--run", RUN,
         "--task-title", title, "--display-name", display, "--spec", task_spec],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"[{key}] TASK_EXIT {tp.returncode}")
    print(f"[{key}] TASK_OUT {((tp.stdout or '') + (tp.stderr or ''))[:250]}")

    return p.returncode == 0 and tp.returncode == 0


def main():
    w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
    disp = w["dispatches"]
    ok = True
    for key, handle, spec, summary, title, display, task_spec, _ in JOBS:
        if key in disp:
            print("ALREADY", key, disp[key].get("status"))
            continue
        good = dispatch(key, handle, spec, summary, title, display, task_spec, None)
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
    c = collections.Counter(x["status"] for x in disp.values())
    print("watch-state total", len(disp), dict(c))
    print("ALL_OK", ok)


main()
