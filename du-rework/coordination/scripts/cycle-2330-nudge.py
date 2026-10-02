"""Record 23:30 guard nudges. Run from du-rework root."""
import io
import json

W = "coordination/agent-watch-state.json"
with io.open(W, encoding="utf-8") as fh:
    state = json.load(fh)

d4 = state["dispatches"]["ctx_task_p903_d4_chunk_runner"]
d4["lastNudgeAt"] = "2026-10-01T23:30:00+07:00"
d4["summary"] = (d4.get("summary", "") + " Guard 23:30: do NOT commit runner/tests.")

rv = state["dispatches"]["ctx_task_rv0103_worker_artifact_encryption"]
rv["lastNudgeAt"] = "2026-10-01T23:30:00+07:00"
rv["summary"] = (rv.get("summary", "") + " Stop-nudge 23:30: ADR-18 user-blocked.")

state["updated"] = "2026-10-01T23:30:00+07:00"

with io.open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("ok, dispatches:", len(state["dispatches"]))
