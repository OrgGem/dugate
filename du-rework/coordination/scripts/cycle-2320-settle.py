"""Settle D4 + register/settle RV01-04. Run from du-rework root."""
import io
import json

W = "coordination/agent-watch-state.json"
with io.open(W, encoding="utf-8") as fh:
    state = json.load(fh)

# 1. D4 -> settled (independent re-run: 53/53 pass, verified this cycle)
d4 = state["dispatches"]["ctx_task_p903_d4_chunk_runner"]
d4["status"] = "settled"
d4["receipt"] = "codex-p9-03-doc-compare-runner-2026-10-01.md"
d4["settledAt"] = "2026-10-01T23:20:00+07:00"
d4["summary"] = (
    "D4 done: createDocCompareRuntime in doc-compare/runner.ts + 20 tests. "
    "Independent re-run 2 suites / 53 tests passed. Full suite 870/4 pre-existing "
    "(bullmq-smoke + F8 fixtures). Hard checks pass: no CANCELLED, "
    "CHUNK_IDENTITY_LEAK guard, manifest/worker untouched."
)

# 2. RV01-04 -> settled (rows 4-6 PROVED live, cleanup done, receipt qwen-platform.md S60)
state["dispatches"]["ctx_task_rv0104_live_infra"] = {
    "status": "settled",
    "terminalHandle": "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
    "taskRef": "spec-only (no orchestration task; dispatched inside RV01-02 lane)",
    "dispatchedAt": "2026-10-01T21:49:00+07:00",
    "lastObservedAt": "2026-10-01T23:10:00+07:00",
    "consecutiveUnfinishedChecks": 0,
    "summary": (
        "RV01-04 done: namespaced MinIO du-rv0104-minio + Vault dev du-rv0104-vault; "
        "rows 4/5/6 PROVED live 3/3 (rv0104-live-encryption.test.ts 3 passed); "
        "M5/M6 bit isolation; full cleanup (containers removed, ports FREE, DB kept "
        "for row 8). Row 8 (real main.ts boot) OPEN."
    ),
    "receipt": "qwen-platform.md#60",
    "settledAt": "2026-10-01T23:20:00+07:00",
}

state["updated"] = "2026-10-01T23:20:00+07:00"

with io.open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

settled = sum(1 for v in state["dispatches"].values() if v.get("status") == "settled")
running = sum(1 for v in state["dispatches"].values() if v.get("status") == "running")
print("dispatches:", len(state["dispatches"]), "settled:", settled, "running:", running)
