"""Normalize agent-watch-state.json to HEAD's style (indent=2, ensure_ascii=False).

Content unchanged; only serialization matches the committed file so git diff stays small.
"""
import json

W = r"D:/Git/dugate/du-rework/coordination/agent-watch-state.json"

with open(W, encoding="utf-8") as fh:
    state = json.load(fh)
with open(W, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("normalized, dispatches:", len(state["dispatches"]))
