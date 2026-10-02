"""Settle F8. Run from du-rework root."""
import io
import json

W = "coordination/agent-watch-state.json"
with io.open(W, encoding="utf-8") as fh:
    state = json.load(fh)

f8 = state["dispatches"]["ctx_task_f8_variant_fixtures"]
f8["status"] = "settled"
f8["receipt"] = "codex-f8-missing-variant-fixtures-2026-10-02.md"
f8["settledAt"] = "2026-10-02T00:10:00+07:00"
f8["summary"] = (
    "F8 done: fixtures for DOC-02-06/DOC-03-06/DOC-03-07 (e2e + corpus + mocks). "
    "Independent re-run 2 suites / 64 tests passed, tsc exit 0. "
    "Matrix 31 unchanged, src untouched by F8. Full-suite F8 reds gone; "
    "only bullmq-smoke (Redis pre-existing) remains."
)
state["updated"] = "2026-10-02T00:10:00+07:00"

with io.open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")

from collections import Counter
print(Counter(v.get("status") for v in state["dispatches"].values()))
print("TOTAL:", len(state["dispatches"]))
