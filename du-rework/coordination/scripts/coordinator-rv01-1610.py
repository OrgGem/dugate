import json, sys, subprocess, collections

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOW = "2026-10-01T16:10:00+07:00"
W = r"D:\Git\dugate\du-rework\coordination\agent-watch-state.json"
RUN = "run_2e083dbaeaee"

# ---------- settle RV01-08 (verified green by coordinator) ----------
w = json.load(open(W, encoding="utf-8"), object_pairs_hook=collections.OrderedDict)
disp = w["dispatches"]

k8 = disp.get("ctx_task_rv0108_sdk_metadata_adapter_test")
if k8 and k8["status"] != "settled":
    k8["status"] = "settled"
    k8["receipt"] = "du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts (+4/-1, assertion only)"
    k8["settledAt"] = NOW
    k8["lastObservedAt"] = NOW
    k8["summary"] = (
        "RV01-08 DONE. Coordinator re-ran `npx jest tests/r1-e-sdk-metadata-adapter.test.ts --runInBand` "
        "= 1/1 PASS exit 0 (was 1/1 FAIL before dispatch). Diff confined to the assertion: now "
        "toHaveBeenCalledWith(artifactId, expect.objectContaining({ signal: expect.any(AbortSignal) })). "
        "src/worker.ts:176-179 UNTOUCHED (signal still forwarded) - production not weakened. "
        "git status on worker.ts clean. Terminal 949d489b recap confirms it did not modify production."
    )
    print("SETTLED ctx_task_rv0108_sdk_metadata_adapter_test")

# ---------- RV01-01 : orchestrator boot encryption, lease main.ts + server.ts ----------
RV01_01 = (
"IMPLEMENTATION PACKET RV01-01 (P0) — Bootstrap production encryption and fail-closed.\n"
"Source packet: du-rework/tasks/CODE-REVIEW-FIXES-2026-10-01.md, section 'RV01-01'. Read that section IN FULL first; "
"it is authoritative. Parent packets ENC-02/05/07/08, ENC-INT-01, CR28-01/04.\n\n"
"YOUR FILE LEASE (exclusive while this packet is open):\n"
"- du-rework/services/orchestrator/src/main.ts\n"
"- du-rework/services/orchestrator/src/server.ts\n"
"Nobody else holds these. Do NOT touch packages/contracts, packages/worker-sdk, "
"services/orchestrator/src/modules/artifacts/**, modules/encryption/**, or src/app/admin/** in this packet.\n\n"
"PRE-EXISTING BASELINE YOU MUST PRESERVE (uncommitted, NOT yours):\n"
"`git diff du-rework/services/orchestrator/src/main.ts` currently shows +7/-1 adding "
"adminShellCookieSecret / adminShellPort / adminShellHost and ORCHESTRATOR_PORT. That edit was made by another "
"lane before you got this packet. Read it, keep every line of it, and build on top. "
"server.ts is clean at HEAD (mtime 2026-09-29) — if you see it dirty, STOP and report to coordinator: lease collision.\n\n"
"WHAT TO DO (packet section RV01-01 is the spec; summary only):\n"
"1. Read the ADR-18 / encryption bootstrap decision in du-rework/docs before choosing an approach. If the ADR "
"does not settle it, STOP and report the blocker to coordinator instead of inventing a third design.\n"
"2. Wire the entrypoint so `pnpm start` / real `dist/main.js` supplies metadataEncryption, publicUploadEncryption, "
"deliveryEncryption, recipient registry/policy store and Admin crypto config through a typed config parser, reading "
"from env/secret manager. Allowlist storage-key refs. Master key / raw DEK must never go to env workers, browser, or logs.\n"
"3. For S3 production: missing app-encryption or Vault dependency must FAIL BOOT or FAIL REQUEST before any PUT or DB "
"write. DB-pilot is a distinct mode — no silent fallback to unencrypted.\n"
"4. Keep per-tenant delivery policy (Admin toggle) clearly separate from mandatory storage encryption.\n\n"
"ACCEPTANCE — report honestly, do not fake it:\n"
"- `pnpm --filter @du/orchestrator typecheck` exit 0, `pnpm --filter @du/orchestrator lint` exit 0.\n"
"- Run the orchestrator test suites; record command, cwd, exit code, passed/failed/skipped.\n"
"- Receipt must state WHICH acceptance rows you proved and WHICH are still pending a live S3+Vault instance / DB "
"window. The packet's full acceptance needs a clean image + real S3 + Vault, which requires a coordinator-claimed DB "
"window. Do NOT claim those. Mark them 'BLOCKED: needs DB window claim from coordinator'.\n"
"- The existing `createApp` unit fixture is NOT acceptance for this packet (packet says so explicitly). Say so in your receipt.\n\n"
"HARD CONSTRAINTS:\n"
"- Read-only toward other lanes' files. Never revert or reformat a file you were not given.\n"
"- Do NOT tick any gate (G-ENC/G-SEC/G-DATA/G-COMP/G6 stay NO-GO), do NOT edit tasks/*.md, do NOT commit.\n"
"- No plaintext fallback when encryption is enabled. Fail closed.\n"
"- Do NOT message nocobase-10.\n\n"
"ETA/CHECKPOINT: report back when typecheck+lint+suites are green and your receipt is written, OR when you hit the "
"ADR ambiguity / lease collision. If you need a DB window, stop and ask the coordinator for CLAIM rather than using "
"shared PG/Redis."
)

# ---------- RV01-03 : worker->S3/DB artifact encryption, worker-sdk + artifacts lease ----------
RV01_03 = (
"IMPLEMENTATION PACKET RV01-03 (P0) — Encrypt every Worker -> S3/DB artifact and round-trip the manifest.\n"
"Source packet: du-rework/tasks/CODE-REVIEW-FIXES-2026-10-01.md, section 'RV01-03'. Read it IN FULL first; it is "
"authoritative. Parents ENC-03/04/05, CR28-01, DATA-04, ENC-INT-01.\n\n"
"YOUR FILE LEASE (exclusive while this packet is open):\n"
"- du-rework/packages/worker-sdk/src/** (esp. task-context.ts, worker.ts, types.ts)\n"
"- du-rework/services/orchestrator/src/modules/artifacts/**\n"
"- du-rework/services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts\n"
"NOT yours: services/orchestrator/src/main.ts and src/server.ts are leased by another agent right now — do not edit, "
"do not read-modify. Also NOT yours: du-rework/packages/contracts (shared serialize point).\n\n"
"MANDATORY FIRST STEP — the packet has a BRANCH, not a single answer:\n"
"RV01-03 offers two designs: (A) Orchestrator streaming crypto gateway as the mandatory write boundary, or "
"(B) worker-side crypto IF ADR-18 keeps it, in which case you must wire production config, carry the manifest over an "
"authenticated contract, and prove no helper/grant bypass. READ THE ADR FIRST, then state in your receipt which branch "
"you are taking and the file:line that settles it. If the ADR is ambiguous or absent, STOP and report to coordinator. "
"Do not invent a third architecture, and do not assume (A) merely because it reads cleaner.\n\n"
"KNOWN DEFECTS THE PACKET NAMES (verify each yourself before fixing; do not trust this list blindly):\n"
"- DefaultTaskContext is built without crypto injected, and the plaintext send path fires when the seam is missing, "
"while the multipart branch does not call the seam even when it exists.\n"
"- Single-shot seal path returns/uploads only ciphertext and drops nonce/tag/wrapped DEK/manifest.\n"
"- Read path classifies an object lacking the marker as plaintext.\n"
"- Size limit is enforced only AFTER the whole stream is buffered.\n\n"
"HARD CONSTRAINTS:\n"
"- Encrypt DURING stream read, not after buffering. Chunked for multipart.\n"
"- Fail closed when metadata/marker/manifest is missing or wrong. No plaintext publication.\n"
"- Do NOT give a master key to the worker.\n"
"- If the chosen branch REQUIRES a change to du-rework/packages/contracts, STOP and report that as a blocker for the "
"coordinator to lease — do not edit contracts yourself.\n"
"- Do NOT tick any gate, do NOT edit tasks/*.md, do NOT commit.\n\n"
"ACCEPTANCE — report honestly:\n"
"- `pnpm --filter @du/worker-sdk typecheck` and `pnpm --filter @du/worker-sdk lint` exit 0.\n"
"- `pnpm --filter @du/worker-sdk test` full run: record command, cwd, exit code, passed/failed/skipped.\n"
"- Prove the crypto-seam round-trip for small and >5 MiB buffers with a unit/integration receipt.\n"
"- The packet's full acceptance (real worker + runtime + S3/PG pilot, >64 MiB multipart, RSS/backpressure, Vault outage) "
"needs a live DB window. Mark those 'BLOCKED: needs DB window claim' — do NOT claim them.\n"
"- Do not use the unit crypto-seam test as a substitute for integration evidence; state which rows remain open.\n\n"
"ETA/CHECKPOINT: report back when typecheck+lint+tests are green and the branch decision is written, OR on any blocker "
"(ADR ambiguity, contracts lease need, DB window need)."
)

# ---------- tester offline : independent verification of RV01-08 + suite re-measure ----------
TESTER_OFFLINE = (
"INDEPENDENT VERIFICATION TASK (tester role, not implementation).\n\n"
"GOAL 1 — independently confirm RV01-08 is actually closed, and that it was NOT closed by weakening production.\n"
"  a) cd du-rework/businesses/document-core && npx jest tests/r1-e-sdk-metadata-adapter.test.ts --runInBand — record raw output + exit code.\n"
"  b) cd du-rework && git diff du-rework/businesses/document-core/tests/r1-e-sdk-metadata-adapter.test.ts — the diff must be assertion-only.\n"
"  c) git status --porcelain du-rework/businesses/document-core/src/worker.ts must be EMPTY (production untouched).\n"
"  d) Read src/worker.ts:176-179 and confirm the AbortSignal is still forwarded to artifactFacade.readWithMetadata.\n"
"     Verdict must be explicit: PASS if cancellation propagation is intact, FAIL if it was removed.\n\n"
"GOAL 2 — close out the whole-suite number.\n"
"  The review packet recorded `pnpm --filter @du/document-core test` as 790 pass / 1 fail / 791 total, exit 1.\n"
"  Run it now and record command, cwd, exit code, passed/failed/skipped. Expected: 791/791, exit 0.\n"
"  If ANY other test fails, do NOT fix it — report the failing test names verbatim as a blocker for the coordinator.\n\n"
"CONSTRAINTS:\n"
"- Verification only. Do NOT edit source or tests. Do NOT tick gates. Do NOT commit.\n"
"- Do NOT use the shared PG :5433 / Redis :6380 instances — they may be leased to another agent. If a test needs a DB, "
"  report that and stop.\n"
"- Do NOT message nocobase-10.\n"
"OUTPUT: a receipt at du-rework/coordination/reports/codex-rv0108-independent-verification-2026-10-01.md with raw "
"command output and the four checks above. New file, your only write."
)

# ---------- tester live : offline-verifiable acceptance matrix for RV01-01 + RV01-03 ----------
TESTER_LIVE = (
"PREPARATION TASK FOR THE LIVE TESTER (read-only + one report file; NO live infra runs this turn).\n\n"
"CONTEXT: RV01-01 (orchestrator boot encryption) and RV01-03 (worker->S3/DB artifact encryption) are being "
"implemented in parallel. Their full acceptance needs a clean image + real S3 + Vault + PG/Redis, which requires a "
"coordinator-claimed DB window. You are NOT claiming that window now. Your job is to produce the verification matrix "
"so the live run is mechanical once the window is released.\n\n"
"WHAT TO DO:\n"
"1. Read du-rework/tasks/CODE-REVIEW-FIXES-2026-10-01.md sections 'RV01-01' and 'RV01-03' IN FULL. Extract every "
"acceptance row verbatim into a table.\n"
"2. For each row classify it as:\n"
"   - OFFLINE: provable without DB/S3/Vault (unit tests, config-parser tests, fail-closed tests, typecheck/lint, "
"     a seam round-trip test with an in-memory facade).\n"
"   - LIVE: requires the claimed window (real worker + runtime + S3/PG pilot, >64 MiB multipart, RSS/backpressure, "
"     Vault outage / degraded dependency).\n"
"3. For each OFFLINE row write the EXACT command to run (package, filter, file if known) and the expected result, "
"so a tester can execute it mechanically. Do not run them now unless they are pure jest unit tests with no DB; if "
"you do run any, record raw output + exit code.\n"
"4. For each LIVE row write the setup precondition (image, env vars, Vault path, S3 bucket, PG/Redis) and the "
"one-command reproduction, so it can be run the moment the coordinator releases the window.\n"
"5. State explicitly which rows CANNOT be satisfied by any unit fixture, quoting the packet's own sentence that says "
"so for RV01-01 (the createApp unit fixture is not acceptance).\n\n"
"CONSTRAINTS:\n"
"- Read-only toward du-rework source. Your only write is the report file below.\n"
"- Do NOT tick any gate. Do NOT edit tasks/*.md. Do NOT commit.\n"
"- Do NOT use the shared PG :5433 / Redis :6380 or any live S3/Vault — they may be leased to another agent.\n"
"- Do NOT message nocobase-10.\n"
"OUTPUT: du-rework/coordination/reports/codex-rv01-acceptance-matrix-2026-10-01.md (NEW file, your only write). "
"Markdown table, one row per acceptance item, columns: packet item | verbatim acceptance text | OFFLINE/LIVE | "
"exact command | expected result | precondition.\n\n"
"ETA/CHECKPOINT: report back when the matrix file exists. This is preparation only — no implementation, no gate tick."
)

JOBS = [
    ("ctx_task_rv0101_boot_encryption",
     "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
     RV01_01,
     "RV01-01 (P0) Orchestrator boot encryption + fail-closed. Exclusive lease: main.ts + server.ts. Branch on ADR-18. "
     "Live S3/Vault acceptance rows stay BLOCKED (no DB window). Gates stay NO-GO.",
     "RV01-01 Bootstrap production encryption + fail-closed",
     "qwen_1",
     "P0 RV01-01 (ENC-02/05/07/08, CR28-01/04, ENC-INT-01). Exclusive lease on orchestrator src/main.ts + src/server.ts. "
     "Wire metadataEncryption/publicUploadEncryption/deliveryEncryption/recipient registry into the real entrypoint via "
     "typed config; S3 without app-encryption or Vault must fail boot/request before any PUT or DB write; no silent "
     "fallback. Preserve the pre-existing uncommitted adminShellCookieSecret edit in main.ts. Report ADR branch; mark "
     "live-acceptance rows BLOCKED pending DB window. No gate tick, no commit."),

    ("ctx_task_rv0103_worker_artifact_encryption",
     "term_742c2474-7ff2-427d-8db4-f4bd40d16129",
     RV01_03,
     "RV01-03 (P0) Worker->S3/DB artifact encryption + manifest round-trip. Lease: packages/worker-sdk/src/**, "
     "modules/artifacts/**, modules/encryption/artifact-read-decrypt.ts. Contracts + server.ts/main.ts NOT leased to this lane.",
     "RV01-03 Worker artifact encryption + manifest round-trip",
     "qwen_3",
     "P0 RV01-03 (ENC-03/04/05, CR28-01, DATA-04, ENC-INT-01). Lease: packages/worker-sdk/src/**, orchestrator "
     "modules/artifacts/**, modules/encryption/artifact-read-decrypt.ts. Must first decide ADR branch "
     "(Orchestrator gateway vs worker-side) with file:line, else report blocker. Encrypt during stream read, chunked "
     "multipart, enforce size limit while streaming, fail closed on missing marker/manifest. Do NOT edit packages/contracts "
     "or server.ts/main.ts — other agents hold those leases. Mark live-pilot acceptance BLOCKED pending DB window."),

    ("ctx_task_rv0108_independent_verification",
     "term_b2d08e87-4435-4323-8e14-b58fa1a6729b",
     TESTER_OFFLINE,
     "Independent verification of RV01-08 (assertion-only fix, production signal intact) + re-measure document-core full suite "
     "against the packet's recorded 790/791 exit 1.",
     "Independent verification RV01-08 + document-core suite",
     "codex_tester_offline",
     "Verification only. Confirm r1-e-sdk-metadata-adapter.test.ts green, diff is assertion-only, src/worker.ts:176-179 "
     "still forwards AbortSignal and is unmodified. Re-run pnpm --filter @du/document-core test to close out the recorded "
     "790 pass / 1 fail / 791 total exit 1. Report any remaining failure verbatim as a blocker; do not fix. No source "
     "edits, no gate ticks, no shared PG/Redis usage, no commit."),

    ("ctx_task_rv01_acceptance_matrix",
     "term_c4486089-8f52-4c6f-add2-3d8d9d2e97fe",
     TESTER_LIVE,
     "Acceptance matrix for RV01-01 + RV01-03 (OFFLINE vs LIVE classification, exact commands) so the live run is mechanical "
     "once the DB/S3/Vault window is released. Preparation only — no live infra, no implementation.",
     "RV01-01/03 acceptance matrix (offline vs live)",
     "codex_tester_live",
     "Read-only prep. Extract every RV01-01 + RV01-03 acceptance row verbatim, classify OFFLINE (unit/config/fail-closed/"
     "seam round-trip) vs LIVE (real worker+S3/PG, >64MiB multipart, RSS/backpressure, Vault outage), and write the exact "
     "command + precondition for each. Output coordination/reports/codex-rv01-acceptance-matrix-2026-10-01.md. No live "
     "S3/Vault/PG/Redis usage, no gate ticks, no source edits, no commit."),
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
        print("ALREADY", key, disp[key].get("status"))
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
