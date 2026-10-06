import io
import json
from collections import OrderedDict

raw = json.load(io.open("C:/Users/Gem/AppData/Local/Temp/opencode/vfy-audit-workers/audit-raw.json", encoding="utf-8"))
OUT = "du-rework/coordination/reports/raw/audit-worker-repos-isolation/audit-summary.md"
PKGS = ["@du/contracts", "@du/document-kit", "@du/worker-sdk"]


def tier(f):
    return "tests" if "/tests/" in f or f.endswith(".test.ts") else ("scripts" if "/scripts/" in f or "/template/" in f else "src")


lines = []
lines.append("# Worker import audit summary (read-only)\n")
lines.append("Generated from `audit-raw.json` (extractor handles multi-line imports, require, dynamic import and `import()` type positions).")
lines.append("`refs` counts identifier references in the file excluding the import statement itself. `tier` = src | tests | scripts.\n")

for bus, data in raw.items():
    lines.append("\n## %s\n" % bus)
    lines.append("Declared: " + ", ".join("%s (%s, %s)" % (k, v["section"], v["version"]) for k, v in data["declared"].items()) if data["declared"] else "Declared: NONE")
    # matrix
    per_pkg = OrderedDict((p, {"src": 0, "tests": 0, "scripts": 0, "refs": 0}) for p in PKGS)
    for e in data["imports"]:
        t = tier(e["file"])
        per_pkg.setdefault(e["pkg"], {"src": 0, "tests": 0, "scripts": 0, "refs": 0})
        per_pkg[e["pkg"]][t] += 1
        per_pkg[e["pkg"]]["refs"] += e["usage_refs"]
    lines.append("\n### Tier matrix (import call sites by file tier)\n")
    lines.append("| package | src sites | test sites | script sites | usage refs |")
    lines.append("|---|---|---|---|---|")
    for p in PKGS:
        v = per_pkg.get(p)
        if v:
            lines.append("| `%s` | %d | %d | %d | %d |" % (p, v["src"], v["tests"], v["scripts"], v["refs"]))
    for p, v in per_pkg.items():
        if p not in PKGS and any(v[k] for k in ("src", "tests", "scripts")):
            lines.append("| `%s` | %d | %d | %d | %d |" % (p, v["src"], v["tests"], v["scripts"], v["refs"]))
    # symbol tables
    for p in PKGS:
        entries = [e for e in data["imports"] if e["pkg"] == p]
        if not entries:
            continue
        agg = OrderedDict()
        for e in entries:
            key = (e["symbol"], e["kind"])
            a = agg.setdefault(key, {"locals": set(), "sites": [], "refs": 0, "type_only": True})
            a["locals"].add(e["local"])
            a["sites"].append((e["file"], e["line"], tier(e["file"])))
            a["refs"] += e["usage_refs"]
            a["type_only"] = a["type_only"] and e["type_only"]
        lines.append("\n### `%s` — caller symbols\n" % p)
        lines.append("| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |")
        lines.append("|---|---|---|---|---|---|---|")
        for (sym, kind), a in sorted(agg.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            src = [f for f, _, t in a["sites"] if t == "src"]
            tst = [f for f, _, t in a["sites"] if t == "tests"]
            scr = [f for f, _, t in a["sites"] if t == "scripts"]
            type_sites = sum(1 for e in entries if e["symbol"] == sym and e["kind"] == kind and e["type_only"])
            total_sites = sum(1 for e in entries if e["symbol"] == sym and e["kind"] == kind)
            sites = "; ".join("%s:%d" % (f.split("businesses/")[-1], ln) for f, ln, _ in a["sites"])
            aliases = ", ".join(sorted(a["locals"])) if a["locals"] != {sym} else ""
            flag = ""
            if a["refs"] == 0 and sym not in ("(namespace)", "*") and (src or scr):
                flag = "⚠ "
            lines.append("| %s`%s` (%s) | %s | %d/%d | %d | %d | %d | %s |" % (
                flag, sym, kind, aliases, type_sites, total_sites,
                len(src) + len(scr), len(tst), a["refs"], sites))
    lines.append("\n### Non-import textual references\n")
    if data["non_import_refs"]:
        lines.append("| file:line | text |")
        lines.append("|---|---|")
        for e in data["non_import_refs"]:
            lines.append("| `%s:%d` | %s |" % (e["file"].split("businesses/")[-1], e["line"], e["text"].replace("|", "\\|")))
    else:
        lines.append("(none)")

io.open(OUT, "w", encoding="utf-8").write("\n".join(lines))
print("wrote", OUT)
print("total entries:", sum(len(d["imports"]) for d in raw.values()))
for bus, d in raw.items():
    print(bus, "imports:", len(d["imports"]), "non-import refs:", len(d["non_import_refs"]))
