"""Register F8 dispatch. Run from du-rework root."""
import io
import json

W = "coordination/agent-watch-state.json"
with io.open(W, encoding="utf-8") as fh:
    state = json.load(fh)

state["dispatches"]["ctx_task_f8_variant_fixtures"] = {
    "status": "running",
    "terminalHandle": "term_2b05b203-549f-4428-b908-c303a2b187ec",
    "taskRef": "task_96c74a1e2c89",
    "dispatchedAt": "2026-10-01T23:55:00+07:00",
    "lastObservedAt": "2026-10-01T23:55:00+07:00",
    "consecutiveUnfinishedChecks": 0,
    "summary": (
        "F8: fixtures for DOC-02-06/DOC-03-06/DOC-03-07 in all-variants-e2e "
        "(getVariantFixture) + expected-result-corpus.ts + corpus mocks if needed. "
        "Fixture-only, no src changes, 31-variant matrix unchanged."
    ),
}
state["updated"] = "2026-10-01T23:55:00+07:00"

with io.open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

from collections import Counter
print(Counter(v.get("status") for v in state["dispatches"].values()))
print("TOTAL:", len(state["dispatches"]))
