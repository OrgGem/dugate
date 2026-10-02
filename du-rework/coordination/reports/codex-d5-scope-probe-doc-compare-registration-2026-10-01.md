# D5-scope-probe — doc-compare registration mapping (READ-ONLY)

- **Recorded:** 2026-10-01. **Mode:** read-only mapping. **No file was created or modified except this receipt.**
- **Purpose:** scope map for the D5 registration packet. This is NOT an implementation.

## 0. Two corrections to the packet's stated background (measured, not assumed)

**(a) D3 DID touch `recipes/` and `step-keys.ts`.** The packet says "D3 KHÔNG đụng — 31 variants giữ nguyên". Half right: the 31 variants are intact, but D3 added a **workflow recipe and 5 step keys**:
`recipe-definitions.ts:16` (action union gains `'disbursement'`), `:426-440` (`WORKFLOW_RECIPES['disbursement:workflow']`), `:455-457` (`getWorkflowRecipe`); `step-keys.ts:64-70` (`DISBURSEMENT.{CLASSIFY,EXTRACT,APPROVAL,CROSSCHECK,REPORT}`). **So doc-compare DOES need the analogous recipe + step keys** — this changes the D5 scope map.

**(b) My own D4 work left a gap: `createDocCompareRuntime` is not re-exported from the package index.**
`doc-compare/index.ts` re-exports from `./doc-compare`, `./primitives`, `./chunking` — **not** `./runner`. `createDocCompareRuntime` exists only at `runner.ts:345` and is imported only by deep path from `tests/p9-03-doc-compare-runner.test.ts`. Its own header still says "Nothing here is registered anywhere". D5 must add the export or import the deep path.

## 1. Mount-point mapping (file:line, D3 counterpart in the last column)

| # | Mount point needed? | File:line | What | D3 counterpart |
|---|---|---|---|---|
| 1 | **Yes** | `src/worker.ts:1244` `documentCoreHandlers` map | Register a new key `doc-compare` | `disbursement:` at `:1396` |
| 2 | **Yes** | `src/worker.ts:37-49` import block | Import the doc-compare public surface | D3's 11-name import from `./pipelines/workflows/disbursement` |
| 3 | **Yes** | `src/worker.ts:~468-1240` (new block) | Handler functions: input normalization, state checkpoint save/restore, chunk fan-out, join, wait-for-review, terminate, resume | `disbursementFailure()`, `normalizeDisbursementInput` helpers, `handleDisbursement` (D3 block spans ~468-1238) |
| 4 | **Yes** | `src/worker.ts:1242` comment | Update the handlerKinds list comment | comment already lists `'disbursement'` |
| 5 | **Yes** | `src/manifest/document-core.manifest.ts:19` `handlerKinds` | Add `'doc-compare'` to the array | `'disbursement'` is last element |
| 6 | **Yes** | `src/manifest/document-core.manifest.ts` after `:243` | New action object `name:'doc-compare'` with input/output/profile schemas, `connectorSlots`, `artifactPolicy`, `capabilities`, `defaultLimits` | the `disbursement` action at `:243-...` (input schema `:247-268`, output `:269-...`) |
| 7 | **Yes** | `src/manifest/document-core.manifest.ts:324-327` connectorSlots | doc-compare needs slots for structure + references (D3 used 4 named slots for its 4 stages) | `classify/extract/crosscheck/report` |
| 8 | **Yes** | `src/recipes/step-keys.ts:64` | New `DOC_COMPARE` step-key group | `DISBURSEMENT` group (5 keys) |
| 9 | **Yes** | `src/recipes/recipe-definitions.ts:426-440` | New `WORKFLOW_RECIPES['doc-compare:workflow']` + `getWorkflowRecipe` | `disbursement:workflow` recipe |
| 10 | **Yes** | `src/recipes/recipe-definitions.ts:16` | Action union: add `'doc-compare'` | already widened for `'disbursement'` |
| 11 | **Yes** | `src/pipelines/workflows/doc-compare/index.ts` | Add `export { createDocCompareRuntime, ... } from './runner'` | (my D4 gap; no D3 analogue) |
| 12 | **Conditional** | Connector/provider side | Provider task names `doc_compare_structure` / `doc_compare_references` are only **defaults** in `runner.ts` (`DEFAULT_DOC_COMPARE_BINDING`), overridable. They must match whatever the connector actually registers. | D3 hard-codes `task:'disbursement_classify'` etc. inline at `:877, 913, 943, 979` |
| 13 | **No** | `src/actions/compare/*` | doc-compare does not reuse `CompareAction`; it is a separate state machine | — |

**Every mount point D3 touched, doc-compare needs.** The only difference is scale: D3's handler block is ~770 lines because disbursement does its own connector calls inline; doc-compare can be thinner because `createDocCompareRuntime` (D4) already wraps the connector call.

## 2. New handler kind/action, NOT mounted into the existing `compare` handler

**Answer: doc-compare becomes its own handler kind + action. It must NOT be folded into `compare:` (`worker.ts:1372`).**

Evidence from the code read:
1. **Different input contract.** `compare` validates `{mode, source, target}` (`manifest.ts:217-222`; `worker.ts:1376 CompareAction.validateInput`). doc-compare's `normalizeDocCompareInput` requires **two full documents** (`left`/`right` with `artifactId`+`text`), `maxChunkChars`, `maxConcurrency`, `continueOnPartialFailure`, `requireHumanReview`. The shapes are disjoint — there is no `mode` in doc-compare and no two-document pair in `compare`.
2. **Different execution model.** `compare` is single-shot: `validateInput → selectRecipe → prepareSources → executeRecipe → validateResult → formatResult` (`worker.ts:1376-1382`), ending in `kind:'completed'`. doc-compare is a **multi-turn state machine** returning typed continuations (`spawn-chunk-children` / `wait-for-review` / `terminate`) across many calls with resume. `compare` has no notion of a join token or a checkpointed stage.
3. **The manifest separates them by precedent.** `compare` (`:211-240`) and `disbursement` (`:243-...`) are **two distinct action objects**, each with its own `connectorSlots`. `handlerKinds` lists both `'compare'` and `'disbursement'` (`:19`) as independent kinds.
4. **`compare`'s recipe is variant-shaped, not workflow-shaped.** `recipe-definitions.ts:415-422` (`compare:version`) is a 4-step linear recipe with `retryBudget: 2`; doc-compare's chunk fan-out is not expressible as a linear step list. D3 hit the same wall and created a separate `WORKFLOW_RECIPES` namespace (`:425-440`, comment: "selectable by the host but are not document variants").
5. **Semantic consequence if it were folded in:** `compare` emits a single `compare_result.json` artifact and returns `kind:'completed'`. doc-compare must return `WAITING_REVIEW` or a chunk-continuation on the first call, not a completed artifact — putting that in `compare:` would make the shared `compare` mode contract (diff/semantic/version, which COMP-01 pins) depend on whether the caller meant the advanced workflow. That is exactly the wire-parity risk COMP-00 owns.

## 3. Lease / collision risk

| File | Currently | Risk to D5 |
|---|---|---|
| `src/worker.ts` | **D3 holds it this cycle** (modified in git) | **HIGH** — serialize after D3; it is the same mount point |
| `src/manifest/document-core.manifest.ts` | **D3 holds it** | **HIGH** — same file |
| `src/recipes/recipe-definitions.ts`, `step-keys.ts` | **D3 touched them** | MEDIUM-HIGH — D5 edits the same lines' neighbours |
| `src/pipelines/workflows/doc-compare/**` | mine | LOW |
| `src/actions/compare/**` | untouched by D3 | LOW (doc-compare doesn't touch it) |
| `src/pipelines/workflows/disbursement/**` | qwen_2 | must not be touched |

**Mitigation:** D5 needs the same four files D3 just edited. Serialize behind D3 (or have D3 fold doc-compare in while it holds the lease). D5 must NOT start while D3's changes to worker.ts/manifest are uncommitted in the shared tree.

## 4. Not established / out of scope

- The **connector-side** registration of `doc_compare_structure` / `doc_compare_references` is NOT in document-core; those task names must match the connector service's registry. **OPEN** (needs the connector lane).
- Whether doc-compare needs **new connector slots** or can reuse `reasoning`: its runner calls a single slot (default `'reasoning'`), so one slot may suffice — unlike D3's 4. **Coordinator decision**, evidence in mount #7.
- `getAllRecipes()` (`recipe-definitions.ts:451-453`) returns only `Object.values(this.RECIPES)` and **excludes `WORKFLOW_RECIPES`** — a pre-existing asymmetry that D3 already inherits; doc-compare would too. Noted, not changed.

## 5. Verification performed

- **No test or tsc run** — this was a read-only mapping; none was needed to answer the scope question.
- Read-only greps of `worker.ts`, `document-core.manifest.ts`, `recipes/*`, `doc-compare/index.ts`, and a repo-wide grep of `createDocCompareRuntime|advanceDocCompare|runChunkChildren` (48 matches, **all inside `doc-compare/` or the two P9-03 test files** — confirms zero production callers).

## 6. Gates

**No gate ticked.** No commit. No message to nocobase-10. `server.ts`, `contracts`, `tasks/*.md`, `AGENTS.md` untouched.