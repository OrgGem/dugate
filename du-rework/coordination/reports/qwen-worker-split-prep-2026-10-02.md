# WORKER-SPLIT-PREP — evidence for the `worker.ts` decision (READ-ONLY)

**Task:** WORKER-SPLIT-PREP · **Date:** 2026-10-02 · **Status:** analysis only. No source, test or guard was modified; no gate ticked; no commit.

## 0. The decision is live, not hypothetical

`node tools/file-size-guard.cjs` prints, **today, on the current tree**:

```
  WARN: ... (>= 1500 lines): 9
  FAIL: new oversize: 2023 lines - businesses/document-core/src/worker.ts
Files over 2000 lines: 4
FAIL: 1 new file(s) exceed 2000 lines.
```

`worker.ts` is **not** in `GRANDFATHERED_DEBT` (`tools/file-size-guard.cjs:37-41`, currently 3 paths) and not in `PLAN_BASELINE_COUNTS` (`:28-34`, 5 paths). `WARN_LINES = 1500`, `FAIL_LINES = 2000` (`:8-9`). So the guard is **red on this file now**, not after some future change.

(Reported from the guard's own printed verdict. My shell invocation masked the process exit code, so I quote the output rather than claim an exit code.)

## 1. Block inventory (measured, `Get-Content .Count` = **2023**)

| # | block | lines | count |
|---|---|---|---|
| 1 | header comment + imports + type re-export (`:74`) | 1-74 | 74 |
| 2 | core shared helpers — `BusinessTaskHandler`, `assertActive`, `StreamingTaskContext`, `writeEnvelopeArtifact`, `taskCrypto` | 75-178 | 104 |
| 3 | `toInternalContext` — SDK ctx to internal `TaskContext` adapter | 179-481 | 303 |
| 4 | `DualTaskHandler` type | 482-486 | 5 |
| 5 | **disbursement engine block** | 487-1266 | **780** |
| 6 | **doc-compare engine block** | 1267-1842 | **576** | |
| 7 | `documentCoreHandlers` map — root dispatcher + 6 simple actions + 2 workflow entries | 1843-2006 | 164 |
| 8 | business definition + `DocumentCoreWorkerConfig` + `startDocumentCoreWorker` | 2007-2023 | 17 |
| | **total** | | **2023** |

**94% of the excess is blocks 5 and 6** (1356 of 2023 lines). Blocks 1-4 and 7-8 together are 667 lines and are cohesive as-is.

## 2. Cross-dependency map (measured from use sites, not guessed)

| symbol | defined | used by | note |
|---|---|---|---|
| `assertActive` | `:85` | blocks 3, 5, 6, 7 | widest fan-out |
| `toInternalContext` | `:179` | blocks 5 (`:1219`), 6 (`:1782`), 7 (`:1863`+) | **exported** |
| `StreamingTaskContext` | `:115` | blocks 2, 5, 6 | type only |
| `taskCrypto` | `:157` | block 3 (`:208`), block 5 (`:892`, `:1130`) | |
| `writeEnvelopeArtifact` | `:133` | block 7 only (`:1873`-`:1983`) | |
| **`isRecord`** | **`:497` — inside block 5** | block 5 *and* block 6 (`:1296`, `:1320`, `:1414`, `:1438`, `:1569`, `:1592`, `:1611`, `:1746`, `:1788`) | **the only genuine cross-edge between the two extractable blocks** |

**The one trap:** `isRecord` is a generic type guard that happens to live inside the disbursement block. Extracting block 5 without moving `isRecord` breaks block 6. It must move to shared, not be duplicated.

## 3. Public surface that must survive

- `src/index.ts:27` — `export * from './worker'`, so **every** `worker.ts` export is the package surface.
- `src/main.ts:2` — `startDocumentCoreWorker`, `WorkerHandle`, `DocumentCoreWorkerConfig`.
- **22 test files** import `../src/worker` directly, using: `documentCoreHandlers` (16), `toInternalContext` (2), `startDocumentCoreWorker` (3), `documentCoreBusinessDefinition`, `TaskDisposition`.
- Named exports to preserve and re-export from `worker.ts`: `BusinessTaskHandler` `:75`, `toInternalContext` `:179`, `DualTaskHandler` `:482`, `documentCoreHandlers` `:1843`, `documentCoreBusinessDefinition` `:2007`, `DocumentCoreWorkerConfig` `:2012`, `startDocumentCoreWorker` `:2019`, plus the type re-export at `:74`.

## 4. Options

### Option A — temporary exemption

Add `businesses/document-core/src/worker.ts` to `GRANDFATHERED_DEBT` (and `PLAN_BASELINE_COUNTS`).

- **File surface:** 0 new, 1 modified (`tools/file-size-guard.cjs`).
- **Risk:** low technical risk, real policy cost. The guard comment (`:23-25`) states the stored count is *not a maximum*, that debt *is reported but does not fail the whole repository before refactoring*, and instructs removal *in the same change that takes it below 2,001 lines*. Option A encodes exactly the debt the tool asks to retire.
- **Compounding:** 20 files in `businesses/document-core` are currently modified (§6). Every in-flight edit is a chance to grow the file, and an exemption freezes a ceiling rather than a direction.

### Option B — extract the two workflow engine blocks (recommended)

Move blocks 5 and 6 out; keep everything else in `worker.ts` as the assembly layer.

- **File surface:** +4 files, 1 modified. Natural home is the directories that **already exist**:
  - `src/pipelines/workflows/disbursement/handler.ts` (~780)
  - `src/pipelines/workflows/doc-compare/handler.ts` (~576)
  - `src/pipelines/workflows/shared.ts` (small: `isRecord` plus the helper/type surface both engines need)
  - one more for `assertActive` / `toInternalContext` / `writeEnvelopeArtifact` / `taskCrypto` / `StreamingTaskContext` — **these must move too**, or the new modules import `worker.ts` while `worker.ts` imports them, which is a cycle. Same constraint that forced `shell-router-shared.ts` in CONV-12.
- `worker.ts` lands at roughly **660-690 lines** — under the 1500 WARN, not merely under the 2000 FAIL.
- **Preserved:** the `documentCoreHandlers` map stays whole in `worker.ts` (object identity, key order, `root` dispatcher semantics untouched); continuation mapping (`mapDisbursementContinuation` `:1098`, `mapDocCompareContinuation` `:1661`) and the durable save/load path (`saveXState`/`loadXState`) move **verbatim**; no export changes for any consumer in §3.
- **Risk:** the `isRecord` edge (§2) is the one thing that must not be handled by duplication. Beyond that it is a relocation with the same A/B discipline used for CONV-12.

### Option C — per-action handler extraction

Split the 8 handler entries into `src/handlers/{action}.ts`, keeping the map as an assembly object.

- **File surface:** +8 to +9 files, 1 modified.
- **Why it is weaker:** the 6 simple action handlers span only `:1863`-`:1985` (~122 lines, ~20 each). Extracting them yields six thin modules that each need `assertActive` + `toInternalContext` + `writeEnvelopeArtifact` — more files and more coupling for less than blocks 5 and 6 remove.
- **It does not clear the breach on its own**; it only works combined with B.
- Viable as a *second* step if finer granularity is wanted later.

## 5. Recommendation

**Option B.** It is the only option that both clears the live red and matches the file's real structure — two cohesive workflow engines sitting under a thin assembly layer. Option A silences a currently-failing guard by adding debt the guard's own comment says to retire; Option C is cosmetic on its own.

## 6. Precondition — the tree is not quiet

`git status` for `businesses/document-core` shows **20 modified files**, including **`src/worker.ts` itself**:

`docs/variant-matrix.md`, `src/index.ts`, `src/manifest/document-core.manifest.ts`, `src/pipelines/workflows/disbursement/fanout.ts`, `src/pipelines/workflows/doc-compare/{chunking,doc-compare,index,runner,types}.ts`, `src/recipes/{recipe-definitions,step-keys}.ts`, **`src/worker.ts`**, and 8 modified test files, plus 2 untracked new test files (`p9-03-doc-compare-handler.test.ts`, `p9-03-doc-compare-registration.test.ts`).

**Option B should not start until the D5 wave is committed or those files are explicitly leased.** A mechanical relocation stacked on uncommitted D5 work makes the diff unreviewable and risks conflicting with the owning lane.

## 7. The two choices for the user

| | choice | what it commits to |
|---|---|---|
| **A** | temporary exemption | guard goes green; `worker.ts` stays 2023 lines; a new `GRANDFATHERED_DEBT` entry to be retired later; growth stays unblocked on a file several lanes are currently editing |
| **B** | split per option B | 4 new files in directories that already exist; `worker.ts` ~660-690 lines; 7 named exports re-exported so all 24 consumers are untouched; requires the D5 wave to land or be leased first |

## 8. Not determined

1. **Whether D5 will add more lines to `worker.ts`.** If it does, option B's budget shifts and the extraction boundaries should be re-measured after D5 lands, not now.
2. **Whether any modified test reaches into `worker.ts` internals** (non-exported symbols). My consumer grep only proves what the 22 files import; a deep-path import would not appear. Option B should start by grepping the 8 modified test files.
3. **Whether `src/pipelines/workflows/{disbursement,doc-compare}/` are the sanctioned future home** for the extracted handlers, or whether the handlers are meant to stay beside the engines they call. The directories exist, which is suggestive but not proof of intent.
4. **The guard process exit code** was masked by my invocation; I report its printed verdict instead (§0).

**No gate is ticked by this receipt.**