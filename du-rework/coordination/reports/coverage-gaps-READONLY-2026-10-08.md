# Coverage-gap characterization — READ-ONLY — 2026-10-08

**Mode:** read-only characterization. No source/test edit, no commit, no `git add`, no push, no gate tick, no
hand-edit of `docs/21-openapi.json`. Offline only: no PostgreSQL, no Redis, no DB window claimed. Scope
`du-rework` only; nocobase and the legacy root untouched; `.env.live` never read or printed.

**Start cwd for every command:** `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

## 0. Environment snapshot (start and end)

| | Start | End |
|---|---|---|
| HEAD | `72e225ae5465e5a648c34bf31fbabbd182763233` (`72e225a`, 2026-10-08 09:49:15 +0700, *chore(rework): snapshot deployment architecture code and test evidence*) | **identical** |
| node | `v24.21.0` | `v24.21.0` |
| `git status --porcelain` count | **57** | **58** at the end snapshot (13:41); **59** by 13:46 as this deliverable landed and another lane kept writing — see the table below for exact attribution |

**Delta accounting (exact, not by arithmetic):** the count is a point-in-time value and the tree is moving
under other lanes, so the delta is attributed by **path + mtime**, not by subtracting counts. The complete set
of paths with an mtime inside my window (13:20–13:50) is:

| Path | mtime | Whose |
|---|---|---|
| `du-rework/tasks/README.md` (`M`) | 13:31:41 | **another lane** — I never wrote under `tasks/` |
| `du-rework/tasks/DU-PLATFORM-MIGRATION-2026-10-05.md` (`M`) | 13:32:56 | **another lane** |
| `du-rework/.tmp-coverage-gaps/` (`??`) | 13:38:47 | **mine** — the scratch dir PART 1 asked for |
| `du-rework/coordination/reports/coverage-gaps-READONLY-2026-10-08.md` (`??`) | 13:44:36 | **mine** — this deliverable |

Note that a count delta cannot be read as "+1 per event": re-modifying an already-`M` file does not change the
count, which is exactly why the two `tasks/` writes by the other lane are invisible in the 57 → 58 → 59
progression. The defensible statement is the table above: **exactly two paths in my window are mine, and
neither is a source, test, config or docs file.** The two MED-1 files I characterized were both written before
my first command (`src/db/migrations.ts` 12:44:01, the test 11:56:07) and I did not touch either.

**Important pinning caveat:** the two MED-1 files are **uncommitted in-flight lane work, not HEAD content** —
`git diff` shows the whole MED-1 block as added lines, and `git show HEAD:…/migrations.ts` contains **no**
`declaredSchemaObjects` at all (`HEAD_has_declaredSchemaObjects=False`, HEAD file = 231 lines). So this
characterization pins to the **working-tree bytes**, by sha256:

| Artifact | sha256 |
|---|---|
| `orchestrator/services/orchestrator/src/db/migrations.ts` | `519fd20731acac579acde4f5908844ddf98c4948661e408ad64e1c74852d5eed` |
| `orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts` | `0d63375d38822876032d46a45bc9d087168855254ab48f6dc267b6d41c3b5f0c` |
| `du-rework/.tmp-coverage-gaps/probe.cjs` (scratch, not part of any suite) | `e1ff939b35a7c61fdd3c52be82387f8959bde29d89f1e4e35896827933f9a178` |

---

# PART 1 — MED-1 extractor: shared blind spot?

## 1.1 Is the test object list a literal copy of the implementation regex? — **NO (claim refuted)**

**Implementation** — `src/db/migrations.ts:112-120`, a single **line-anchored regex**, one pass per line:
```ts
112: function declaredSchemaObjects(sql: string): string[] {
114:   for (const rawLine of sql.split(/\r?\n/)) {
115:     const line = rawLine.replace(/--.*$/, '');
116:     const match = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/i.exec(line);
117:     if (match) names.push(match[1]!.toLowerCase());
```

**Test side** — a **token scanner**, structurally different, spread over four helpers:
- `sqlWords` (`tests/med1-migration-ledger-object-drift.test.ts:44-51`): strips `--`, splits on
  `[\s(),;]+`, **strips surrounding double quotes** (`.replace(/^"|"$/g, '')`), drops empties.
- `createDeclaration` (`:53-83`): walks tokens — skips `OR REPLACE`, `UNIQUE`, `TEMP|TEMPORARY`,
  `MATERIALIZED VIEW`, `CONCURRENTLY`, `IF NOT EXISTS` — and takes the **next token** as the name.
- `scanMigrationDdl` (`:108-152`) + `declaredObjects` (`:155-159`), the latter filtering to
  `command === 'CREATE TABLE' || 'CREATE INDEX'` only.

They are therefore **two independent grammars**, and they are *observably* different: on sample S4 below the
implementation returns `[]` while the test returns `["idx"]`. A literal copy would not diverge.

**Why the divergence cannot be caught either:** the test never compares its list with the implementation's.
It imports only `loadMigrationFiles, migrate` (`:21`) — `declaredSchemaObjects` is **not exported**, so it is
not callable from the test — and the test's list is used solely to *populate the fake catalog* (`:196`,
`for (const name of declaredObjects(String(sql))) this.present.add(name);`). Direction of detection is
one-way: if the implementation finds a name the test did not materialise, the suite goes red; if the
implementation **misses** a name, nothing is probed and nothing can go red.

## 1.2 How the "actual implementation helper" was run (it is private)

Neither grammar is exported, so neither can be imported. The scratch probe
(`.tmp-coverage-gaps/probe.cjs`, one file, not part of any suite) **reads each file, slices the function
source text verbatim by brace matching, transpiles that slice with the repo's own `typescript`, and evaluates
it**. No module is loaded (so no side effects from `migrations.ts` imports) and **no repo file is written**.
The executed bodies are byte-for-byte the source text pinned by the hashes above.

Command (literal, exit code at the end):
```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node ../../../.tmp-coverage-gaps/probe.cjs
```

## 1.3 Literal extractor output, per sample

| # | Sample (verbatim SQL) | `declaredSchemaObjects` (impl) | `declaredObjects` (test) | agree | Gap? |
|---|---|---|---|---|---|
| S1 | `CREATE UNIQUE INDEX CONCURRENTLY idx_c1 ON t (a);` | `["idx_c1"]` | `["idx_c1"]` | true | **no** |
| S2 | `CREATE INDEX IF NOT EXISTS idx_c2 ON t (a);` | `["idx_c2"]` | `["idx_c2"]` | true | **no** |
| S3a | `CREATE INDEX idx_expr ON t ((a + b));` | `["idx_expr"]` | `["idx_expr"]` | true | **no** |
| S3b | `CREATE INDEX ON t ((a + b));` | `["on"]` | `["on"]` | true | **YES — shared wrong name** |
| S4 | `CREATE INDEX "Idx Quoted" ON t (a);` | `[]` | `["idx"]` | false | **YES — impl misses; test invents a different wrong name** |
| S5 | `CREATE TABLE t_trailing (\n  a int,\n);` | `["t_trailing"]` | `["t_trailing"]` | true | **no** |
| S6 | `CREATE UNIQUE INDEX\n  idx_multiline\n  ON t (a);` | `[]` | `[]` | true | **YES — shared miss** |
| S7 | `CREATE TABLE\n  t_multiline (\n  a int\n);` | `[]` | `[]` | true | **YES — shared miss** |
| S8 | `-- CREATE TABLE ghost (a int);` | `[]` | `[]` | true | no (correct: comment) |
| S9 | `  CREATE TABLE indented_tbl (a int);` | `["indented_tbl"]` | `["indented_tbl"]` | true | **no** |
| S10 | `CREATE TABLE a1 (x int); CREATE TABLE a2 (y int);` | `["a1"]` | `["a1"]` | true | **YES — shared miss of `a2`** |

## 1.4 Verdict per sample, and which of the task's predictions held

- **The five samples the task predicted would be missed are NOT gaps:** `CREATE UNIQUE INDEX CONCURRENTLY`
  (S1), `CREATE INDEX IF NOT EXISTS` (S2), a **named** expression index (S3a) and the trailing comma before
  `)` (S5) are all handled correctly by **both** grammars — the implementation's optional groups
  `(?:CONCURRENTLY\s+)?` / `(?:IF\s+NOT\s+EXISTS\s+)?` cover S1/S2, the name is captured before the `(` in
  S3a/S5, and the trailing comma is irrelevant because both sides only read the declaration's first line.
- **Real shared gaps found (4, all unexercised by either side):**
  1. **S6/S7 — a declaration whose object name is not on the same line** (legal SQL, ordinary formatting):
     both return `[]`. The implementation's `^\s*CREATE\s+…\s+([name])` needs the name on that line; the
     test's token walk finds no token after the kind and stores `objectName: null`, which `declaredObjects`
     (`:158`) then drops.
  2. **S10 — two `CREATE` statements on one line:** both return only `["a1"]`; `a2` is invisible to both.
  3. **S3b — an unnamed index (`CREATE INDEX ON t (…)`, legal PostgreSQL):** both return the keyword
     **`"on"` as an object name**. This is a *false object*, not a miss: the drift guard would probe for a
     table/index literally named `on`, not find it, and **refuse to boot** (`migrations.ts:182-201`,
     `:303-317`) — a false-positive fail-closed, which is the opposite failure direction from a blind spot.
  4. **S4 — a quoted object name:** the implementation misses it entirely (`[]`), and the test's
     quote-stripping token walk yields `"idx"` (the first word of `"Idx Quoted"`), i.e. a *different* wrong
     name. The divergence is masked because the test's list only feeds the fake catalog; the runtime side
     still probes nothing for that index.

## 1.5 Is the gap material today? — **latent, not live**

The shipped corpus is `orchestrator/services/orchestrator/migrations/*.sql`, **37 files**. Greps over all 37:

| Gap class | Hits in corpus |
|---|---|
| unnamed index (`CREATE [UNIQUE] INDEX ON …`) | **0** |
| quoted object name after `CREATE [UNIQUE] [TABLE\|INDEX] [CONCURRENTLY] [IF NOT EXISTS]` | **0** |
| declaration whose name is on a following line | **0** |
| two `CREATE` statements on one line | **0** |

So the shared blind spot **does not affect any currently shipped migration**; it bites only when such DDL is
introduced. This is a latent robustness gap, not a live defect.

**PART 1 CLAIM VERDICT: PARTIALLY CONFIRMED.** The *mechanism* asserted (test list is a hand-copied replica
of the implementation regex) is **refuted** — they are independent grammars and observably diverge. The
*consequence* asserted (a gap both share is never exercised) is **confirmed in kind** — four such gaps exist,
including three genuine shared misses — but **none of the five samples the task predicted** is one of them,
and none of the four is reachable from the current 37-file corpus.

---

# PART 2 — SPA offline harnesses in no automated suite

## 2.1 Why the `.cjs` files are not matched, with file:line

- `orchestrator/services/orchestrator/jest.config.cjs:5` — `roots: ['<rootDir>/tests']`: the harnesses **do**
  live under `tests/`, so location is *not* the reason.
- `orchestrator/services/orchestrator/jest.config.cjs:6` — **`testMatch: ['**/*.test.ts']`**: the reason. A
  file named `*.cjs` can never match a pattern whose extension is `.ts`, so jest never collects it.
- `orchestrator/services/orchestrator/jest.unit.config.cjs:26-29` — `module.exports = { ...base,
  testPathIgnorePatterns: liveSuites }`: the offline config **inherits** `testMatch` from the base and only
  adds ignore patterns, so it does not change this.
- `orchestrator/services/orchestrator/package.json:11` — `"test": "jest --runInBand"`;
  `:12` — `"test:unit": "jest --runInBand --config jest.unit.config.cjs"`. Both entry points are jest, so both
  inherit `testMatch`.
- `du-rework/package.json` — `"test": "pnpm -r run test"` fans out to each package's `test` script, i.e. to
  jest again. Nothing in the fan-out reaches a `.cjs` harness.
- **There is no CI to catch it either:** no `.github/workflows` directory exists anywhere under `du-rework`.

## 2.2 Every hit for an invocation of either file — **zero**

Grep over the whole `du-rework` tree for `usage-screen-offline|f7-overview-usage-tile-offline` returns 54
lines. Excluding `coordination/reports/**` (receipts and raw logs that *document manual runs*) and the
harness files themselves, the complete list of hits in any script/config/package file is:

| file:line | content | kind |
|---|---|---|
| `tests/f7-overview-usage-tile-offline.cjs:4` | `// services/orchestrator/tests/usage-screen-offline.cjs — the TSX is transpiled with` | comment |
| `tests/tenant-select-offline.cjs:3` | `// Convention: services/orchestrator/tests/usage-screen-offline.cjs — the TSX is` | comment |
| `tests/tenant-select-offline.cjs:7` | `// (usage-screen-offline.cjs:10); this harness loads the REAL component module,` | comment |
| `tests/f4-component-tenant-select.test.ts:6` | `* \`tests/tenant-select-offline.cjs\` (element tree) and \`tests/usage-screen-offline.cjs\`, which` | comment |

A dedicated grep restricted to script-ish files (`*.json,*.yml,*.yaml,*.cjs,*.mjs,*.js,*.ps1,*.sh`, excluding
`node_modules` and `coordination/reports`) returned **only those three comment lines** — no script, no config,
no workflow, no `package.json` invokes either harness. **Zero invocations.**

Corroboration from another lane's receipt: `coordination/reports/verify-tenant-usage-INDEPENDENT-dsh-a-2026-10-08.md:33,47`
records passing both `.cjs` paths to jest and getting `Pattern: tests/usage-screen-offline.cjs|tests/f7-overview-usage-tile-offline.cjs - 0 matches`.

## 2.3 One manual run each (literal + exit code)

```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node tests/usage-screen-offline.cjs
```
```
PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock
```
`EXIT=0`

```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node tests/f7-overview-usage-tile-offline.cjs
```
```
  ok  1: tenant session renders real usage totals and drops the stale copy
  ok  2: platform session without a tenant does not call usage and asks for a tenant
  ok  3: a denied usage read renders a denied pane and never fabricates counts
  ok  4: an unreadable usage payload fails closed without fabricated numbers
  ok  5: an empty window renders the empty state
  ok  6: the Operations tile keeps its own unavailable copy
  ok  7: a failed session fails the usage tile closed without a stale claim
  ok  8: a session without an admin principal renders an honest pane
PASS: real OverviewScreen usage tile — 8 scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, unreadable payload, empty window, Operations tile intact)
```
`EXIT=0`

## 2.4 Smallest options for closing the gap (not implemented — reported only)

| Option | Change | Risk |
|---|---|---|
| **A. Widen `testMatch`** to also collect `**/*.test.cjs` and rename the two files `*.test.cjs` | 1 line in `jest.config.cjs` + 2 renames | The harnesses are **not jest tests** — they are top-level scripts that call `process.exitCode` and `console.log`, with no `describe`/`it`. Jest would report "Your test suite must contain at least one test" → red. Would need a jest wrapper per file, i.e. more than a rename. |
| **B. Add npm scripts** (`"test:spa": "node tests/usage-screen-offline.cjs && node tests/f7-overview-usage-tile-offline.cjs"`) and call it from the package `test` script | ~2 lines | Cheapest honest fix; makes the assurance run with `pnpm test`. Risk: the package `test` script currently means "jest", so mixing a non-jest runner changes the meaning of an existing gate; and the two harnesses must stay green or they block the jest suite. |
| **C. Port the harnesses into jest** (`*.test.ts` with the same in-memory React shim) | rewrite 2 files (~550 lines total) | Largest effort; removes the "not collected" property permanently. Risk: the shim is hand-rolled and deliberately avoids a DOM — a port must preserve that, or the repo needs the render infrastructure it does not have. |
| **D. Leave as-is, but record in the inventory docs** that the SPA assurance is manual-only | docs only | Zero code risk, but the assurance still never runs automatically — it only stops being invisible. |

Whichever option is chosen, the underlying constraint does not change: **the repo has no DOM and no component
renderer**, so these harnesses assert on an **element tree**, and no option above turns them into a browser
test.

**PART 2 CLAIM VERDICT: CONFIRMED.** Both files are standalone node harnesses; `testMatch` (not location)
excludes them from jest; no script, config, package.json or CI invokes them; their assurance therefore never
runs automatically. Both pass when run by hand (exit 0, literals above).

---

## FAIL section

**No FAIL. There is no red result anywhere in this characterization.**
- `probe.cjs` → exit **0**; its output includes non-empty and empty object lists, but those are *findings*,
  not test failures.
- `node tests/usage-screen-offline.cjs` → **PASS**, exit **0**.
- `node tests/f7-overview-usage-tile-offline.cjs` → **8/8 ok**, exit **0**.
- No jest suite was run in this task (none was requested), so no suite-level red is reported.

## Limits — what this did NOT prove

1. **No real database.** The MED-1 drift guard's runtime half (`schemaObjectExists`, `migrations.ts:127-139`)
   was **never executed** against PostgreSQL. Everything about "what the guard would do with a missed or
   invented object name" is inference from the SQL text and the call sites, not an observed probe result. A
   real-DB check would need a DB window, which this task forbids.
2. **No browser.** Both SPA harnesses assert on a returned **element tree**, not painted DOM. The claim "SPA
   assurance never runs automatically" is about *execution*, and is proven; but what that assurance *covers*
   (base-ui trigger labels, portals, a11y attributes, real interactions) remains outside it.
3. **The two MED-1 files are uncommitted in-flight work**, so this characterization pins to working-tree
   hashes (listed in §0), **not** to HEAD `72e225a` — HEAD contains neither the extractor nor the test. If
   that lane edits either file, every conclusion here must be re-run.
4. **The probe evaluates sliced source text, not an imported module.** The executed function bodies are
   byte-for-byte from disk, but this is not the same as calling the shipped module: any behaviour that depends
   on module-level state would not appear. Neither function has module-level dependencies (both are pure
   string processing), so the risk is judged nil — but it is not *proven* nil by construction.
5. **The corpus check in §1.5 is grep-based** over `migrations/*.sql` with the four patterns shown; it proves
   absence for those patterns, not that the corpus is exhaustively free of every formatting that could defeat
   both grammars.
6. **I did not run the jest suite** (`med1-migration-ledger-object-drift.test.ts` was not executed), so I did
   not verify that the suite is currently green, nor whether it would catch any of the four gaps.
7. **The scratch probe remains on disk** at `du-rework/.tmp-coverage-gaps/probe.cjs` (untracked, the only
   working-tree delta I introduced, `git status` 57 → 58). It is not referenced by any suite, config or script.
   Removing it is a one-line action for whoever owns the tree.

## Command log (literal)

| # | Command (cwd `…\orchestrator\services\orchestrator` unless noted) | Exit | Literal |
|---|---|---|---|
| 1 | `node ../../../.tmp-coverage-gaps/probe.cjs` | **0** | 11 sample blocks; per-sample `impl`/`test`/`agree` lines quoted verbatim in §1.3 |
| 2 | `node tests/usage-screen-offline.cjs` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |
| 3 | `node tests/f7-overview-usage-tile-offline.cjs` | **0** | 8 × `ok`, then `PASS: real OverviewScreen usage tile — 8 scenarios (…)` |
| 4 | `git rev-parse HEAD` (cwd `D:\Git\dugate`) | 0 | `72e225ae5465e5a648c34bf31fbabbd182763233` |
| 5 | `git status --porcelain \| Measure-Object` (start / end) | 0 | `57` / `58` |
| 6 | `node --version` | 0 | `v24.21.0` |
