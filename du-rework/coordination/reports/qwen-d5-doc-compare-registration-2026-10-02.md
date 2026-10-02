# D5 — doc-compare registration (handler kind + action)

- **Date:** 2026-10-02. **Mode:** implementation. **No gate ticked. No commit.**
- **Lease used:** `src/worker.ts`, `src/manifest/**`, `src/recipes/**`, `src/pipelines/workflows/doc-compare/**`, `src/index.ts`, `tests/**` — all inside `businesses/document-core`.
- **Not touched:** `pipelines/workflows/disbursement/**`, `actions/compare/**`, `server.ts`, `packages/contracts/**`, gates, `tasks/*.md`, `AGENTS.md`, lockfile. No message to `nocobase-10`.
- **Scope map source:** `coordination/reports/codex-d5-scope-probe-doc-compare-registration-2026-10-01.md` (13 mount points). Probe §0a was right that D3 also touched `recipes/` + `step-keys.ts`, so doc-compare got the analogous recipe and step keys.

## 1. Diff summary

`git diff --numstat -- du-rework/businesses/document-core` → **12 files changed, 804 insertions(+), 12 deletions(-)**; plus 2 new test files (untracked).

| File | +/- | What |
|---|---|---|
| `src/worker.ts` | +605/-1 | import block, doc-compare handler block, `'doc-compare'` registration, handlerKinds comment |
| `src/manifest/document-core.manifest.ts` | +137/-2 | 6 shared schema consts, `handlerKinds` +1, new `doc-compare` action object, business `description` |
| `src/pipelines/workflows/doc-compare/index.ts` | +20/-2 | `export ... from './runner'` (closes probe §0b), header no longer claims "Nothing here is registered anywhere" |
| `src/recipes/recipe-definitions.ts` | +22/-2 | action union +`'doc-compare'`, `WORKFLOW_RECIPES['doc-compare:workflow']`, `getWorkflowRecipe(name: 'disbursement' \| 'doc-compare')` |
| `src/recipes/step-keys.ts` | +8/-1 | `STEP_KEYS.DOC_COMPARE` (4 keys); header no longer says "all 6 actions and 31 variants" |
| `src/pipelines/workflows/doc-compare/chunking.ts` | +1/-1 | **bug fix**, see §3 |
| `src/index.ts` | +1 | barrel re-export of `./pipelines/workflows/doc-compare` — **beyond packet item 4**, see §5-Δ5 |
| `tests/manifest.test.ts` | +2/-1 | 7 → 8 actions |
| `tests/missing-variants.test.ts` | +1/-1 | `actions` length 7 → 8 |
| `tests/sdk-consumer.test.ts` | +2/-1 | 8 → 9 declared handler kinds |
| `tests/worker.test.ts` | +1 | handler key list +`'doc-compare'` |
| `tests/p9-03-doc-compare.test.ts` | +4 | assertion that pins the §3 fix |
| `tests/p9-03-doc-compare-registration.test.ts` | NEW, 6 tests | D3 registration pattern |
| `tests/p9-03-doc-compare-handler.test.ts` | NEW, 9 tests | handler driven end-to-end on a fake SDK context |

## 2. What the handler does

`handleDocCompare` mirrors `handleDisbursement` turn-for-turn, but stays thin because `createDocCompareRuntime` (D4) already wraps the connector call:

1. `assertActive` → `requireDocCompareSdkContext` (spawn/wait/step/connector/artifacts/checkpoints) → `assertRequiredDocCompareSlots` (`reasoning`).
2. Chunk child (`__docCompareChunk` marker, taskKey === chunkId) → `buildDocCompareRuntime` → `runChunk` → writes `doc-compare-chunk-result.json` (`intermediate`).
3. First delivery → `advanceDocCompare` returns `spawn-chunk-children` → checkpoint `doc-compare:workflow-state:<stage>` is saved **before** `spawnAndWait(children, 'all-success', 'doc-compare:v1:<stage>:<joinToken>')`.
4. Join delivery → continuation ref is parsed, checked against `state.pendingStage` + `state.joinToken`, then each issued chunk's artifact is read and validated (`schemaVersion` + `chunkId` + `stage`) into a `ChunkOutcome`.
5. `wait-for-review` → evidence artifact written, then `waitForInput('doc-compare-review-v1', …, { contextRef })`; resume arrives as `resumeInput` and is answered from the `merge-evidence` checkpoint.
6. Terminal: `SUCCEEDED` writes `doc-compare-result.json` (`output`) and returns `completed`; `FAILED` throws the module's own code (`CHUNK_FAILED`, `REVIEW_REJECTED`).

**Fail-closed points that are new code, each with a test that fails without it:**
- unbound `reasoning` slot → `DOC_COMPARE_CONNECTOR_SLOT_MISSING`, before any spawn or connector call.
- unknown input field / wrong `inputVersion` / bad `maxConcurrency` / non-boolean flag / a `sections` key on a side → `DOC_COMPARE_INPUT_INVALID`. `sections` is **rejected, not ignored**: `normalizeDocCompareInput` derives sections from `text`, so accepting then dropping a caller outline would be a silent lie.
- join chunk set ≠ issued chunk set → `DOC_COMPARE_CHUNK_RESULT_MISSING`; join token ≠ saved token → `DOC_COMPARE_CONTINUATION_INVALID`.
- `'succeeded'` outcome without evidence → `DOC_COMPARE_CHUNK_RESULT_INVALID`.
- terminal result with `chunkCount < 1` or **zero claims across both stages** → `DOC_COMPARE_RESULT_INVALID`. This is the anti-fabrication guard: with every chunk failed, the state machine still returns `SUCCEEDED` when `continueOnPartialFailure: true`, and an empty evidence set reads as a clean comparison of two documents that were never opened. Test: `refuses to complete when every chunk failed, even with partial failure allowed`.

**Slot decision (coordinator):** 1 slot `reasoning`, `required: true`, capabilities `['chat-completion','structured-output']`. The runner drives both stages through `DEFAULT_DOC_COMPARE_BINDING.slot` and switches the **provider task** per stage (`doc_compare_structure` / `doc_compare_references`) instead of the slot.

## 3. Defect found in-lease and FIXED

`src/pipelines/workflows/doc-compare/chunking.ts:199` (empty-document branch of `planChunks`):

```ts
chunkId: '`${side.side}-c0`,',   // single-quoted template literal -> literal backticks + comma
```

Every non-empty chunk uses a real template literal; the empty-document chunk did not. Measured consequence: `planChunks(side('left','empty.pdf',''), 4000)` returned `chunkId: "`\`${side.side}-c0\`,"` — and after D5 that literal is what `spawnAndWait` would have used as the **child task key** and as the evidence key. The existing test asserted only `chunks.length === 1`, so nothing caught it.

Fixed to a real template literal and pinned with `expect(chunks[0]!.chunkId).toBe('left-c0')` in `p9-03-doc-compare.test.ts`. **Not requested by the packet** — flagged here so the coordinator can veto; the reason to fix rather than report only is that D5 turns that identifier into a live task key.

## 4. Verification (literal)

| Check | Command | Result |
|---|---|---|
| Focused (8 suites) | `npx jest manifest sdk-consumer missing-variants p9-03-doc-compare p9-03-doc-compare-runner p9-03-doc-compare-registration p9-03-doc-compare-handler worker` | **8 suites / 104 tests, 104 passed, exit 0** |
| Full document-core | `npx jest` | **58 suites / 921 tests: 57 suites / 920 passed, 1 failed — pre-existing, see §6-Δ3** |
| Typecheck | `npx tsc --noEmit` in `businesses/document-core` | **exit 0** |
| Typecheck | `npx tsc --noEmit` in `services/orchestrator` | **exit 0** |
| Manifest contract | `manifest.test.ts` asserts `validateManifest(...).ok === true` and digest == `hashManifest(...)` | pass |

Count changes: manifest actions **7 → 8**; `runtime.handlerKinds` **8 → 9**; `RecipeRegistry.getAllRecipes()` **31 → 31** (unchanged — `WORKFLOW_RECIPES` is still excluded from `getAllRecipes()`, a pre-existing asymmetry D3 already inherited, now asserted explicitly in the registration test); `STEP_KEYS.DOC_COMPARE` **0 → 4 keys**. 31 variants untouched.

**Evidence limit, stated plainly:** every number above is offline. The handler has never run against a real orchestrator/queue/runtime; the 9 handler tests drive it through a hand-written fake `SdkTaskContext` modelled on `disbursement-handler.test.ts`. No live leg was run.

## 5. OPEN / deviations

- **Δ1 — connector task names (coordinator said: record only, do NOT change the connector).** `doc_compare_structure` / `doc_compare_references` remain **defaults** in `DEFAULT_DOC_COMPARE_BINDING`, overridable via `createDocCompareRuntime({ binding })`. They must be matched by whatever the connector service actually registers; nothing in `services/connector` registers them today. Assignment test asserts they are *defaults* and asserts the binding is overridable, so a rename does not need a manifest change.
- **Δ2 — `runChunkChildren` returns `joinToken: ''`.** `doc-compare.ts:advanceDocCompare`'s `takeJoin` requires the submission token to equal `state.joinToken`, so the exported helper's empty token can never satisfy it. The handler does **not** use that helper; it builds `{ joinToken, results }` itself from the parsed continuation ref. The helper is unchanged and still inconsistent for any other caller — flagging, not fixing (D4/P9-03 surface, and no caller).
- **Δ3 — `tests/p8-03-provider-convergence.test.ts` is the one red in the full run, and it is NOT mine.** Failure: `connect ECONNREFUSED 127.0.0.1:5433` from `USE-01 › live usage_events projection query…` at line 328. That test opens a real `PgSqlClient` and INSERTs into `operations`/`tasks`/`usage_events` with **no skip guard**, inside the default offline runner — while the file's own header at line 17 states "Zero connections to shared DB (:5433) or Redis (:6380)". The suite contradicts its own contract and belongs to a Tester DB window. Pre-existing: it touches no doc-compare code path and inserts an `extract` operation. **Baseline for the next lane to compare against: 58 suites / 921 tests, 920 green, that single red.**

> **SUPERSEDED by D5b (2026-10-02).** Another lane added a live-infra guard to that suite mid-D5b — `tests/p8-03-provider-convergence.test.ts` **+4/−1, not mine** (`git status` at the end of D5 did not list it): `const LIVE_INFRA = process.env.DU_LIVE_INFRA === '1'; const liveTest = LIVE_INFRA ? test : test.skip;`. Measured on the same suite: `DU_LIVE_INFRA=0` → 1 skipped / 6 passed / exit 0; `DU_LIVE_INFRA=1` → 1 failed / 6 passed / exit 1. So the claim above was **accurate when D5 ran** and the switch was the env var all along, not a database being up. Do not treat 921/920 as a stable aggregate — compare per-suite. Detail in `qwen-d5b-doc-compare-followup-2026-10-02.md` §6.
- **Δ4 — chunk offsets are computed in a different coordinate space than `sliceChunkText` reads (MEASURED, real code, not arithmetic).** `planChunks` accumulates `section.body.length` — heading lines excluded — into `startOffset`/`endOffset`, but `runner.ts:sliceChunkText` slices `side.text`, which **includes** the heading lines. Probe over `side('left', text = '## Clause A\nThe payer shall settle within thirty days.')`: `textLen = 54`, `sectionBodyLen = 42`, `chunks.length = 1`, `startOffset = 0`, `endOffset = 42`, and `sliceChunkText(...) = '## Clause A\nThe payer shall settle within '` (`chunkTextLen = 42`). So the single chunk sent to the provider is a **misaligned 42-char slice** that carries the heading and silently drops the tail `days.` — and on a multi-section document the drift accumulates, because every heading line shifts the body coordinates. `chunkText` is non-empty, so nothing downstream fails; the comparison just reads the wrong span. Two candidate fixes: (a) slice from `sections.map(s => s.body).join('\n')` in `sliceChunkText`, or (b) make `planChunks` emit text-space offsets — which would break the existing `expect(chunks[chunks.length - 1]!.endOffset).toBe(5000)` assertion at `p9-03-doc-compare.test.ts:248`. **Not fixed here:** outside the packet's five objectives, and it changes what the provider receives, so it is a behaviour decision for the coordinator/connector lane rather than a silent D5 change. The probe file used for the measurement was deleted; the numbers above are its output.
- **Δ5 — `src/index.ts` barrel export is beyond the packet.** Packet item 4 named only `pipelines/workflows/doc-compare/index.ts`. I also added the package barrel re-export so `advanceDocCompare` / `createDocCompareRuntime` are importable from `@du/document-core` the way `advanceDisbursement` is (the registration test relies on it). Measured: `tsc --noEmit` exit 0, i.e. no export-name collision with the disbursement/legacy re-exports. Revert is one line if the coordinator considers this public-surface expansion out of scope.
- **Δ6 — no live leg.** Not run; no DB/Redis window used. See §4 evidence limit.

## 6. Not done / deliberately out

- Did not touch `actions/compare/**`: `compare` keeps its own `{mode, source, target}` contract and its 3 variant recipes. doc-compare is a separate kind + action, per probe §2.
- Did not wire host dispatch: `root` already delegates by `ctx.action`, so `root` → `doc-compare` resolves through `documentCoreHandlers['doc-compare']` without a new branch. Not verified live.
- Did not tick a gate, did not commit, did not push.

## RESUME POINT

- Latest packet: **D5 doc-compare registration**, closed 2026-10-02. `doc-compare` is a registered handler kind + action with a real multi-turn handler; offline-verified only.
- **Before starting D6:** the lease on `worker.ts` / manifest / `recipes/**` / `doc-compare/**` is released. Open items are Δ1–Δ5 above, all needing coordinator or connector-lane input.
- **Reproduce:** `cd du-rework/businesses/document-core && npx jest` → expect 58 suites / 921 tests with exactly one red, `p8-03` USE-01 live-DB (Δ3). Focused 8-suite command and the two `tsc` runs are in §4.
- **Baseline gotcha:** `git diff --numstat` against HEAD includes uncommitted work from other lanes in this shared checkout. `git status --porcelain -- du-rework/businesses/document-core` returns exactly the 12 modified + 2 untracked files listed in §1 and nothing else.
