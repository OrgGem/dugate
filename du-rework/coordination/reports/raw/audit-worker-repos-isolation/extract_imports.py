"""Read-only audit of @du/contracts, @du/document-kit, @du/worker-sdk usage
inside the three worker businesses. Produces JSON + text tables for the
AUDIT-WORKER-REPOS-ISOLATION receipt.
"""
import io
import json
import os
import re

BUS = {
    "document-core": "du-rework/businesses/document-core",
    "lc-checker": "du-rework/businesses/lc-checker",
    "example-review": "du-rework/businesses/example-review",
}
PKGS = ["@du/contracts", "@du/document-kit", "@du/worker-sdk"]
SKIP_DIRS = {"node_modules", "dist", ".git", ".cache", "coverage"}
EXTS = {".ts", ".tsx", ".mts", ".cts", ".js", ".cjs", ".mjs"}

FROM_RE = re.compile(
    r"\b(import|export)\s+(type\s+)?((?:(?!\bfrom\b)[^;])*?)\s+from\s+(['\"])(@du/(?:contracts|document-kit|worker-sdk))\4"
)
SIDE_RE = re.compile(r"\bimport\s+(['\"])(@du/(?:contracts|document-kit|worker-sdk))\1")
REQ_RE = re.compile(r"\brequire\s*\(\s*(['\"])(@du/(?:contracts|document-kit|worker-sdk))\1\s*\)")
DYN_RE = re.compile(r"\bimport\s*\(\s*(['\"])(@du/(?:contracts|document-kit|worker-sdk))\1\s*\)")
DYNTYPE_RE = re.compile(
    r"\bimport\s*\(\s*(['\"])(@du/(?:contracts|document-kit|worker-sdk))\1\s*\)\s*\.\s*(\w+)"
)
ALLPKG_RE = re.compile(r"@du/(?:contracts|document-kit|worker-sdk)")


def parse_clause(clause, type_kw):
    syms = []
    clause = clause.strip()
    m = re.match(r"\*\s+as\s+(\w+)$", clause)
    if m:
        return [("*", m.group(1), bool(type_kw))]
    m = re.match(r"(\w+)\s*,\s*(\{[\s\S]*\})$", clause)
    if m:
        syms.append(("default", m.group(1), bool(type_kw)))
        clause = m.group(2)
    m = re.match(r"(\w+)$", clause)
    if m:
        syms.append(("default", m.group(1), bool(type_kw)))
        return syms
    m = re.match(r"\{([\s\S]*)\}$", clause)
    if m:
        for item in m.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            t = bool(type_kw)
            if item.startswith("type "):
                t = True
                item = item[5:].strip()
            parts = re.split(r"\s+as\s+", item)
            if len(parts) == 2:
                orig, local = parts[0].strip(), parts[1].strip()
            else:
                orig = local = item.strip()
            syms.append((orig, local, t))
    return syms


def refs_in(text, symbol):
    if symbol == "*":
        return 0
    return len(re.findall(r"\b" + re.escape(symbol) + r"\b", text))


report = {}
for bus, root in BUS.items():
    entries = []
    nonimport = []
    declared = {}
    pkgjson = os.path.join(root, "package.json")
    if os.path.exists(pkgjson):
        doc = json.load(io.open(pkgjson, encoding="utf-8"))
        for section in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            for name, ver in doc.get(section, {}).items():
                if name in PKGS:
                    declared[name] = {"section": section, "version": ver}
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if os.path.splitext(fn)[1] in EXTS:
                files.append(os.path.join(dirpath, fn))
    for path in sorted(files):
        rel = os.path.relpath(path, "du-rework").replace("\\", "/")
        text = io.open(path, encoding="utf-8", errors="replace").read()
        covered = []
        for m in FROM_RE.finditer(text):
            kind, type_kw, clause, _q, pkg = m.groups()
            syms = parse_clause(clause, type_kw)
            for orig, local, t in syms:
                hits = refs_in(text, local)
                stmt = m.group(0)
                in_stmt = refs_in(stmt, local)
                entries.append({
                    "file": rel, "line": text[:m.start()].count("\n") + 1,
                    "kind": kind + (" type" if type_kw else ""), "pkg": pkg,
                    "symbol": orig, "local": local, "type_only": t,
                    "usage_refs": max(0, hits - in_stmt),
                    "raw": " ".join(stmt.split()),
                })
            covered.append((m.start(), m.end()))
        for rx, kind in ((SIDE_RE, "side-effect import"), (REQ_RE, "require"), (DYN_RE, "dynamic import")):
            for m in rx.finditer(text):
                pkg = m.group(2)
                entries.append({
                    "file": rel, "line": text[:m.start()].count("\n") + 1,
                    "kind": kind, "pkg": pkg, "symbol": "(namespace)",
                    "local": "(module)", "type_only": kind == "dynamic import",
                    "usage_refs": 0, "raw": " ".join(m.group(0).split()),
                })
                covered.append((m.start(), m.end()))
        for m in DYNTYPE_RE.finditer(text):
            entries.append({
                "file": rel, "line": text[:m.start()].count("\n") + 1,
                "kind": "type import()", "pkg": m.group(2), "symbol": m.group(3),
                "local": m.group(3), "type_only": True, "usage_refs": 0,
                "raw": " ".join(m.group(0).split()),
            })
        # non-import textual references (tests that hardcode package names)
        import_spans = set()
        for rx in (FROM_RE, SIDE_RE, REQ_RE, DYN_RE):
            for m in rx.finditer(text):
                for ln in range(text[:m.start()].count("\n") + 1, text[:m.end()].count("\n") + 2):
                    import_spans.add(ln)
        for i, line in enumerate(text.splitlines(), 1):
            if ALLPKG_RE.search(line) and i not in import_spans and not line.strip().startswith("//"):
                nonimport.append({"file": rel, "line": i, "text": line.strip()[:180]})
    report[bus] = {"declared": declared, "imports": entries, "non_import_refs": nonimport}

io.open("C:/Users/Gem/AppData/Local/Temp/opencode/vfy-audit-workers/audit-raw.json", "w", encoding="utf-8").write(
    json.dumps(report, indent=2, ensure_ascii=False))

for bus, data in report.items():
    print("=" * 100)
    print("BUSINESS:", bus)
    print("declared:", json.dumps(data["declared"], ensure_ascii=False))
    print("-- import statements (%d) --" % len(data["imports"]))
    for e in data["imports"]:
        print("%s:%s [%s] %s :: %s%s (refs=%d)"
              % (e["file"], e["line"], e["kind"], e["pkg"], e["symbol"],
                 "" if e["local"] == e["symbol"] else " as " + e["local"], e["usage_refs"]))
    print("-- non-import textual refs (%d) --" % len(data["non_import_refs"]))
    for e in data["non_import_refs"]:
        print("%s:%s %s" % (e["file"], e["line"], e["text"]))
