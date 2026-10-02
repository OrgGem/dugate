"""Coordinator cycle 2026-10-01 19:35 - step 2: register the three new running rows.

RV01-02 -> term_4568d175 (integrator lease); D3 -> term_2b05b203; D4 -> term_63bf0dbc.
Read-only vs source; only coordination/agent-watch-state.json is written.
"""
import json

W = r"D:/Git/dugate/du-rework/coordination/agent-watch-state.json"
NOW = "2026-10-01T19:38:00+07:00"

ROWS = {
    "ctx_task_rv0102_wiring": {
        "status": "running",
        "terminalHandle": "term_4568d175-fdf8-4ff6-8916-9e787e232a58",
        "taskRef": "task_5ba177982224",
        "dispatchedAt": NOW,
        "lastObservedAt": NOW,
        "consecutiveUnfinishedChecks": 0,
        "summary": "RV01-02 (follows settled RV01-01): #8 main.ts wiring - env->options parser, pass metadataEncryption + publicUploadEncryption into createApp, fail-closed, negative boot matrix row 7 offline. Server.ts 22afb2ff must stay untouched. Spec file: coordination/dispatch-specs/2026-10-01-1935-RV01-02.md",
    },
    "ctx_task_p901_d3_registration": {
        "status": "running",
        "terminalHandle": "term_2b05b203-549f-4428-b908-c303a2b187ec",
        "taskRef": "task_570a460de5d0",
        "dispatchedAt": NOW,
        "lastObservedAt": NOW,
        "consecutiveUnfinishedChecks": 0,
        "summary": "D3 (closes D1's 2 self-caused reds, honest assertion updates no weakening): add 'disbursement' to runtime.handlerKinds + real handler in document-core worker.ts; manifest.test 6->7 actions, sdk-consumer 7->8 kinds; 31 variants unchanged, no F8. Spec file: coordination/dispatch-specs/2026-10-01-1935-D3.md",
    },
    "ctx_task_p903_d4_chunk_runner": {
        "status": "running",
        "terminalHandle": "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
        "taskRef": "task_a9011f965b6f",
        "dispatchedAt": NOW,
        "lastObservedAt": NOW,
        "consecutiveUnfinishedChecks": 0,
        "summary": "D4 (P9-03 module has no production runChunk): production createDocCompareRuntime -> connector per stage, fail-closed CHUNK_FAILED, doc-compare/** only (D3 owns manifest/worker.ts). Spec file: coordination/dispatch-specs/2026-10-01-1935-D4.md",
    },
}


def main() -> None:
    with open(W, encoding="utf-8") as fh:
        state = json.load(fh)
    dispatches = state["dispatches"]
    for key, row in ROWS.items():
        assert key not in dispatches, key
        dispatches[key] = row
    state["summary"] = (
        "19:35 cycle: 5 lanes settled (D1/D2/P9-03/RV01-01/RV01-03, all receipts verified); "
        "3 running (RV01-02 same lane, D3 same lane, D4 P9-03 lane). "
        "D2 lane + RV01-03 lane now free."
    )
    state["updated"] = NOW
    with open(W, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    from collections import Counter
    counts = Counter(row.get("status") for row in dispatches.values())
    print("added rows:", len(ROWS), "->", dict(counts))


if __name__ == "__main__":
    main()