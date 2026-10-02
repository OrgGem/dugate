"""Register D5 probe dispatch. Run from du-rework root."""
import io
import json

W = "coordination/agent-watch-state.json"
with io.open(W, encoding="utf-8") as fh:
    state = json.load(fh)

state["dispatches"]["ctx_task_d5_scope_probe"] = {
    "status": "running",
    "terminalHandle": "term_63bf0dbc-d90e-406d-8089-37dfc45ed4bb",
    "taskRef": "task_1f1a2f9f88da",
    "dispatchedAt": "2026-10-02T00:25:00+07:00",
    "lastObservedAt": "2026-10-02T00:25:00+07:00",
    "consecutiveUnfinishedChecks": 0,
    "summary": (
        "D5-scope-probe: read-only mapping of doc-compare registration points "
        "(worker handler? manifest? recipes?), mirroring D3 disbursement pattern. "
        "No code changes. Receipt prefix codex-."
    ),
}
state["updated"] = "2026-10-02T00:25:00+07:00"

with io.open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

from collections import Counter
print(Counter(v.get("status") for v in state["dispatches"].values()))
print("TOTAL:", len(state["dispatches"]))
