"""Check PM-M02 family origins in the regenerated docs21 (read-only audit)."""
import collections
import io
import json
import sys

BEFORE = "C:/Users/Gem/AppData/Local/Temp/opencode/vfy-swagger-origin/21-openapi.before.json"
AFTER = "du-rework/docs/21-openapi.json"

before = json.load(io.open(BEFORE, encoding="utf-8"))
after = json.load(io.open(AFTER, encoding="utf-8"))
fails = []


def check(cond, msg):
    print(("PASS" if cond else "FAIL"), "-", msg)
    if not cond:
        fails.append(msg)


def ops(doc):
    out = {}
    for path, item in doc["paths"].items():
        for method, op in item.items():
            if method.startswith("x-"):
                continue
            out[(path, method)] = op
    return out


EXPECT = {
    "public": "http://localhost:3000",
    "admin": "http://localhost:3002",
    "runtime": "http://localhost:3002",
    "connector": "http://localhost:8080",
}

print("== global ==")
check([s["url"] for s in after["servers"]] == ["http://localhost:3000"],
      "top-level servers = public origin %r" % after["servers"])
check([t["name"] for t in after.get("tags", [])] == ["public", "admin", "runtime", "connector"],
      "top-level tags = four API families: %r" % [t["name"] for t in after.get("tags", [])])
check("localhost:2023" not in json.dumps(after), "no legacy localhost:2023 anywhere in the artifact")
check(after["info"]["version"] == "1.3.0", "info.version is 1.3.0")

print("== per-operation family origins ==")
counts = collections.Counter()
problems = 0
for (path, method), op in sorted(ops(after).items()):
    fam = op.get("x-api-family")
    counts[fam] += 1
    urls = [s.get("url") for s in op.get("servers", [])]
    ok = fam in EXPECT and urls == [EXPECT[fam]] and op.get("tags") == [fam]
    if not ok:
        problems += 1
        print("FAIL - %-6s %-58s family=%r urls=%r tags=%r"
              % (method.upper(), path, fam, urls, op.get("tags")))
check(problems == 0, "every operation carries its family origin, tag and x-api-family")
print("operations by family:", dict(counts))

print("== path method sets and schemas preserved ==")
check(set(before["paths"]) == set(after["paths"]),
      "same 54 path keys (%d -> %d)" % (len(before["paths"]), len(after["paths"])))
b_ops, a_ops = ops(before), ops(after)
check(set(b_ops) == set(a_ops), "same operation set (%d -> %d)" % (len(b_ops), len(a_ops)))
check(before["components"]["schemas"] == after["components"]["schemas"], "components.schemas unchanged")
check(before["x-absent"] == after["x-absent"], "x-absent unchanged")

print("== delta before -> after ==")
changed = collections.Counter()
for key in sorted(set(b_ops) & set(a_ops)):
    path, method = key
    fam = a_ops[key].get("x-api-family")
    old_urls = [s.get("url") for s in b_ops[key].get("servers", [])]
    new_urls = [s.get("url") for s in a_ops[key].get("servers", [])]
    if old_urls != new_urls:
        changed["servers"] += 1
    if a_ops[key].get("tags") != b_ops[key].get("tags"):
        changed["tags"] += 1
    if a_ops[key].get("x-api-family") != b_ops[key].get("x-api-family"):
        changed["x-api-family"] += 1
print("operations with changed servers:", changed["servers"],
      "| tags:", changed["tags"], "| x-api-family:", changed["x-api-family"])
print("before server urls histogram:",
      collections.Counter(tuple(s.get("url") for s in op.get("servers", [])) for op in b_ops.values()))
print("after server urls histogram:",
      collections.Counter(tuple(s.get("url") for s in op.get("servers", [])) for op in a_ops.values()))

print("== families -> operations ==")
for fam in ("public", "admin", "runtime", "connector"):
    rows = ["%s %s" % (m.upper(), p) for (p, m), op in sorted(a_ops.items())
            if op.get("x-api-family") == fam]
    print("[%s] %d operations:" % (fam, len(rows)))
    for r in rows:
        print("   ", r)

print("RESULT:", "PASS" if not fails else "FAIL(%d)" % len(fails))
sys.exit(1 if fails else 0)
