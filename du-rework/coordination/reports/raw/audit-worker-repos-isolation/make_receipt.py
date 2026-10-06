import io
import json
from collections import OrderedDict

RAW = "C:/Users/Gem/AppData/Local/Temp/opencode/vfy-audit-workers/audit-raw.json"
OUT = "du-rework/coordination/reports/audit-worker-repos-isolation-2026-10-06.md"
PKGS = ["@du/contracts", "@du/document-kit", "@du/worker-sdk"]
NAME = {"@du/contracts": "contracts", "@du/document-kit": "document-kit", "@du/worker-sdk": "worker-sdk"}
raw = json.load(io.open(RAW, encoding="utf-8"))
L = []


def w(s=""):
    L.append(s)


def tier(f):
    if "/tests/" in f or f.endswith(".test.ts"):
        return "tests"
    if "/scripts/" in f or "/template/" in f:
        return "scripts"
    return "src"


def sites_of(entries):
    return "; ".join("%s:%d" % (e["file"].split("businesses/")[-1], e["line"]) for e in entries)


w("# AUDIT-WORKER-REPOS-ISOLATION — worker dependency/import audit")
w("")
w("Task: `task_9dd8faa07a14` (ctx_6ce51451ad04). Date: 2026-10-06. Mode: **read-only** — no source/test edit, no commit.")
w("Scope: every declared and actual reference to `@du/contracts`, `@du/document-kit`, `@du/worker-sdk` inside")
w("`businesses/document-core`, `businesses/lc-checker`, `businesses/example-review`, to prepare worker-repo isolation.")
w("")
w("Method: (1) declared layer = `package.json` dependencies; (2) actual layer = all ESM/CJS statements in")
w("`.ts/.tsx/.mts/.cts/.js/.cjs/.mjs` (multi-line imports, type-only imports, aliases, `require`, dynamic")
w("`import()`, `import()` type positions, `jest.requireActual`); (3) config/build layer = tsconfig paths, jest")
w("`moduleNameMapper`, Dockerfile, build scripts, and textual (non-import) references. Identifier `refs` counts")
w("uses of the local symbol in the same file excluding the import statement itself. Extractor: `extract_imports.py`")
w("(raw evidence `imports-full.txt`, `audit-raw.json`, per-symbol detail `audit-summary.md`).")
w("")
w("## 1. Headline")
w("")
w("| worker | declared deps | actually imported in src | verdict |")
w("|---|---|---|---|")
w("| document-core | contracts, document-kit, worker-sdk | all three | full consumer |")
w("| lc-checker | contracts, document-kit, worker-sdk | contracts + worker-sdk only | **`@du/document-kit` declared but never imported** |")
w("| example-review | contracts, document-kit, worker-sdk | all three | full consumer |")
w("")
w("- Every package specifier is bare `@du/<pkg>`; the only subpath occurrence is a negative test")
w("  (`@du/contracts/private/internal`, package-boundary suites) — no real subpath coupling.")
w("- All three workers import platform services only in **tests/integration**, never in `src`:")
w("  `@du/orchestrator` (example-review ×3 integration tests, document-core multi-container) and")
w("  `@du/connector` (document-core p8-03 + multi-container). They are resolved via jest/tsconfig paths,")
w("  not declared in `package.json`.")
w("- `document-core/template/vendor/` holds an untracked vendored copy of contracts/document-kit/worker-sdk")
w("  sources (13 files) referenced by no code today — candidate isolation seed or cleanup item.")
w("")
w("## 2. Declared vs actual matrix")
w("")
w("| worker | package | package.json | src import sites | test import sites | unique src files | refs (src+test) | status |")
w("|---|---|---|---|---|---|---|---|")
for bus, data in raw.items():
    per = {}
    for e in data["imports"]:
        t = tier(e["file"])
        p = per.setdefault(e["pkg"], {"src": 0, "tests": 0, "scripts": 0, "refs": 0, "srcfiles": set()})
        p[t] += 1
        p["refs"] += e["usage_refs"]
        if t == "src":
            p["srcfiles"].add(e["file"])
    for pkg in PKGS:
        p = per.get(pkg, {"src": 0, "tests": 0, "scripts": 0, "refs": 0, "srcfiles": set()})
        decl = "yes" if pkg in data["declared"] else "no"
        status = "USED" if (p["src"] or p["tests"]) else "**UNUSED**"
        if pkg == "@du/document-kit" and bus == "lc-checker":
            status = "**UNUSED (declared only)**"
        w("| %s | `%s` | %s | %d | %d | %d | %d | %s |" % (bus, pkg, decl, p["src"], p["tests"], len(p["srcfiles"]), p["refs"], status))
w("")
w("> `src import sites` counts individual imported symbols, not statements; one multiline statement can carry many symbols.")
w("")

w("## 3. Caller-symbol detail")
w("")
for bus, data in raw.items():
    w("### 3.%d %s" % (list(raw.keys()).index(bus) + 1, bus))
    w("")
    for pkg in PKGS:
        entries = [e for e in data["imports"] if e["pkg"] == pkg]
        if not entries:
            w("#### `%s` — no imports" % pkg)
            w("")
            continue
        src_entries = [e for e in entries if tier(e["file"]) == "src"]
        test_entries = [e for e in entries if tier(e["file"]) == "tests"]
        script_entries = [e for e in entries if tier(e["file"]) == "scripts"]
        w("#### `%s`" % pkg)
        w("")
        if src_entries:
            agg = OrderedDict()
            for e in src_entries:
                a = agg.setdefault(e["symbol"], {"locals": set(), "lines": [], "refs": 0, "type": 0, "kind": e["kind"]})
                a["locals"].add(e["local"])
                a["lines"].append(e)
                a["refs"] += e["usage_refs"]
                a["type"] += 1 if e["type_only"] else 0
            w("| src symbol | alias | type-only sites | refs | src site(s) |")
            w("|---|---|---|---|---|")
            for sym, a in agg.items():
                alias = ", ".join(sorted(a["locals"] - {sym}))
                flag = " ⚠" if a["refs"] == 0 and sym not in ("(namespace)", "*") else ""
                w("| `%s`%s | %s | %d/%d | %d | %s |" % (sym, flag, alias, a["type"], len(a["lines"]), a["refs"], sites_of(a["lines"])))
            w("")
        else:
            w("(no src imports)")
            w("")
        if test_entries:
            agg = OrderedDict()
            for e in test_entries:
                a = agg.setdefault(e["symbol"], {"locals": set(), "files": set(), "refs": 0, "type": 0, "n": 0})
                a["locals"].add(e["local"])
                a["files"].add(e["file"].split("businesses/")[-1].split("/tests/")[-1])
                a["refs"] += e["usage_refs"]
                a["type"] += 1 if e["type_only"] else 0
                a["n"] += 1
            w("Test-only/extra detail (compact):")
            w("")
            w("| test symbol | type-only | refs | test file(s) |")
            w("|---|---|---|---|")
            for sym, a in agg.items():
                w("| `%s` | %d/%d | %d | %s |" % (sym, a["type"], a["n"], a["refs"], ", ".join(sorted(a["files"]))))
            w("")
        if script_entries:
            w("Script/template sites: " + sites_of(script_entries))
            w("")

w("## 4. Config/build coupling that must change for repo isolation")
w("")
w("| worker | surface | sibling path reference |")
w("|---|---|---|")
w("| document-core | `jest.config.cjs:16-19` | `@du/worker-sdk`, `@du/document-kit` → `../../packages/*/src`; `@du/orchestrator`, `@du/connector` → `../../services/*/dist` |")
w("| document-core | `tsconfig.json:7-8`, `tsconfig.test.json:7-8` | `@du/orchestrator`, `@du/connector` → `../../services/*` (three packages resolve through workspace node_modules) |")
w("| document-core | `scripts/build-dependencies.cjs` | builds 9 workspace packages/services in order (`pnpm --filter @du/...`), incl. `packages/contracts`, `packages/document-kit`, `packages/worker-sdk`, connector, orchestrator |")
w("| document-core | `Dockerfile` (synced) | copies whole workspace (`packages`, `services`, `businesses`, `apps`, `tests`, `scripts/docker`) and builds via `scripts/docker/build-runtime.cjs` |")
w("| document-core | `template/vendor/**` (13 files, untracked) | vendored copies of contracts (7), document-kit (5), worker-sdk (1) sources; no code references them |")
w("| lc-checker | `jest.config.cjs:11-14` | contracts/worker-sdk → `../../packages/*/dist`; document-kit → `../../packages/document-kit/src`; orchestrator → `../../services/orchestrator/dist` |")
w("| lc-checker | `tsconfig.json:10-13`, `tsconfig.test.json:7-10` | all three packages + `@du/orchestrator` → sibling paths |")
w("| lc-checker | `Dockerfile` (synced) | same whole-workspace build as document-core |")
w("| example-review | `jest.config.cjs:11-14` | same mapping shape as lc-checker |")
w("| example-review | `tsconfig.json:10-13`, `tsconfig.test.json:7-10` | all three packages + `@du/orchestrator` → sibling paths |")
w("| example-review | `Dockerfile` (synced) | same whole-workspace build as document-core |")
w("")
w("All three Dockerfiles are generated by `scripts/docker/sync-dockerfiles.cjs` and build every workspace")
w("service from one context; per-worker isolation needs a self-contained context and pinned dependency build.")
w("")

w("## 5. Adjacent couplings found (outside the three packages, isolation-relevant)")
w("")
w("- `@du/orchestrator` imported by tests only: example-review `tests/p7-03-registry-live.integration.test.ts:3`,")
w("  `tests/p7-04-profile-assignment.integration.test.ts:3`, `tests/example-review-continuation.integration.test.ts:3`")
w("  (`createApp`, `createDb`, `App`); document-core `tests/multi-container-e2e.integration.test.ts:13`.")
w("- `@du/connector` imported by tests only: document-core `tests/multi-container-e2e.integration.test.ts:28`,")
w("  `tests/p8-03-provider-convergence.test.ts:9` (`PgSqlClient`).")
w("- None of these are declared in the workers' `package.json`; they resolve via jest/tsconfig sibling paths,")
w("  which the isolated repo will not have. Example-review README already claims a public-package boundary;")
w("  the production `src` tree honours it, integration tests do not (test-scope only).")
w("")

w("## 6. Findings")
w("")
w("| ID | severity | finding | evidence |")
w("|---|---|---|---|")
w("| W-AUD-01 | HIGH (isolation) | `@du/lc-checker` declares `@du/document-kit` (`workspace:*`) but has **zero** imports in src/tests; only jest/tsconfig path entries remain. Either drop the dependency or justify it before freezing the worker manifest. | `lc-checker/package.json:19`; zero import hits in `audit-raw.json`; `jest.config.cjs:12`, `tsconfig.json:11` |")
w("| W-AUD-02 | MEDIUM | Unused import `CONNECTOR_ARTIFACT_MAX_COUNT` in `lc-checker/src/worker.ts:26` (only `CONNECTOR_ARTIFACT_MAX_BYTES` is used, lines 121/129). | grep: single occurrence; `audit-summary.md` ⚠ row |")
w("| W-AUD-03 | MEDIUM | All three workers depend on sibling workspace paths at build/test time (tsconfig paths, jest moduleNameMapper, Dockerfile workspace COPY, `build-dependencies.cjs`). Repo isolation must vendor/pin the three packages and cut these references. | section 4 |")
w("| W-AUD-04 | INFO | `document-core/template/vendor/` contains an untracked vendored copy of the three packages' sources (13 files) referenced by no code; decide seed vs delete. | `git status` reports `?? businesses/document-core/template/` |")
w("| W-AUD-05 | INFO | Integration tests import `@du/orchestrator`/`@du/connector` without declaring them; isolated-repo test policy must use built artifacts or exclude/move these suites. | section 5 |")
w("| W-AUD-06 | LOW | No real subpath or deep-import coupling; the only subpath string is the negative boundary test `@du/contracts/private/internal`. | `document-core/tests/package-boundary.test.ts:195` |")
w("")
w("## 7. Minimum isolation cut (src symbols the worker repo must provide)")
w("")
for bus, data in raw.items():
    w("**%s**" % bus)
    w("")
    for pkg in PKGS:
        syms = OrderedDict()
        for e in data["imports"]:
            if e["pkg"] == pkg and tier(e["file"]) == "src":
                syms.setdefault(e["symbol"], set()).add(e["local"])
        if syms:
            w("- `%s`: " % pkg + ", ".join(("`%s`" % s) for s in syms))
        else:
            w("- `%s`: (none)" % pkg)
    w("")
w("")
w("## 8. Evidence index (under `coordination/reports/raw/audit-worker-repos-isolation/`)")
w("")
w("| file | content |")
w("|---|---|")
w("| `imports-full.txt` | extractor stdout: every statement with symbol, alias, type flag, refs; plus non-import textual refs |")
w("| `audit-raw.json` | machine-readable extraction (all 249 statement-entries) |")
w("| `audit-summary.md` | per-worker/per-package symbol tables including every test import site |")
w("| `extract_imports.py` | read-only extractor (copied from the verification temp dir) |")
w("| `summarize_audit.py` | aggregation script for `audit-summary.md` |")
w("| `summary-build.log` | script run log |")
w("")
w("## 9. Limitations")
w("")
w("- Text/regex extraction, not a TypeScript compiler API run: counts and type-only flags reflect the source text;")
w("  aliased symbols and inline `import()` types are handled, but a `tsc --traceResolution` audit was not run.")
w("- `template/vendor` and `.cjs` scripts were scanned for statements; generated `dist/` and `node_modules/` were excluded.")
w("- This audit changes nothing; the repository was only read. No commit, tick or push.")
w("")

io.open(OUT, "w", encoding="utf-8").write("\n".join(L))
print("wrote", OUT, "lines", len(L))
