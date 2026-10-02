# D5b — doc-compare follow-up: Δ4 alignment fix, P9-01 stale comment, Δ2 disposition

- **Date:** 2026-10-02. **Mode:** implementation. **No gate ticked. No commit.**
- **Lease:** `pipelines/workflows/doc-compare/**`, `manifest/document-core.manifest.ts` (comment only), tests. `disbursement/**`, `actions/compare/**`, `server.ts`, contracts, gates untouched. 31 variants unchanged. No message to `nocobase-10`.
- **Coordinator rulings honoured:** Δ5 barrel export kept as-is; Δ1 connector task names still OPEN, unchanged; Δ3 handled by another lane (see §6); Δ6 offline-only accepted.

## 1. Files touched by D5b (7)

| File | What |
|---|---|
| `src/pipelines/workflows/doc-compare/chunking.ts` | Δ4 — `splitLinesWithOffsets`, `extractSections` emits text-space spans, `planChunks` packs by span |
| `src/pipelines/workflows/doc-compare/types.ts` | Δ4 — `DocumentSection.textStart/textEnd`; `DOC_COMPARE_STATE_VERSION` v1 → **v2** |
| `src/pipelines/workflows/doc-compare/runner.ts` | Δ4 — `sliceChunkText` doc comment now states the invariant it relies on (no code change) |
| `src/pipelines/workflows/doc-compare/doc-compare.ts` | Δ2 — `runChunkChildren` takes the issued `joinToken` and rejects an empty one |
| `src/manifest/document-core.manifest.ts` | Objective 2 — stale comment only, **0 code/behavior change** |
| `tests/p9-03-doc-compare.test.ts` | Δ4 regression test + corrected assertions; Δ2 call sites and 2 new assertions |
| `tests/p9-03-doc-compare-runner.test.ts` | Δ2 call site |

Cumulative `git diff --numstat` against HEAD now also contains D5's uncommitted work, so the aggregate is NOT a D5b number; the per-file table above is the D5b scope.

## 2. Δ4 — chunk offsets are now text-space (decision: option b)

**Chose (b): `planChunks` emits text-space offsets.** Reasons, in order of weight:

1. `types.ts` already specified the contract — `DocumentChunkRef.startOffset/endOffset` are documented as *"Zero-based character offset within that side's normalised text"*. Option (a) would have required rewriting the specification to match the bug; (b) makes the code match the spec that was already written.
2. Option (a) still drops heading text from `chunkText` — the heading lives only in `sectionTitle`. The packet asked for a fix that loses no content; only (b) achieves that.
3. Under (b) the chunk spans **tile** the text, so "concatenating the chunks reproduces the document" becomes an exact, checkable property. That is the regression test below.

**Implementation:** `extractSections` now walks lines through a new `splitLinesWithOffsets` (which tracks each line's absolute span and handles CRLF explicitly rather than assuming a 1-char separator — Windows-authored documents would otherwise drift) and records, per section, `textStart`/`textEnd`: the span the section **occupies** in `side.text`, heading line and trailing separator included. A heading skipped by the "only flush real content" rule deliberately does **not** advance `spanStart`, so its line stays inside the following section's span instead of becoming an unread gap. `planChunks` then packs by span length.

**Before/after on the D5 measured witness** (`'## Clause A\nThe payer shall settle within thirty days.'`, budget 4000): D5 produced `endOffset = 42` and `chunkText = '## Clause A\nThe payer shall settle within '` — a 42-char misaligned slice of a 54-char document that carried the heading and dropped `days.`. Now the single chunk is `[0, 54)` and `chunkText` is the whole document.

**A second, adjacent defect was fixed in the same code.** The oversized-section branch advanced the local `offset` but never `startOffset`, so the next `emit()` began a chunk *before* that section and overlapped it. Both are now advanced. This is the same defect class (chunk coverage) and is inside the requested fix; it is called out here because it was not in the D5 report.

**Honest note on what changed semantically:** `charCount` now includes the heading bytes that a chunk actually carries, so it is a truer "characters sent" measure but no longer equals the summed body length. `runner.ts:sectionsInChunk` caps each section body at `chunk.charCount`; that heuristic is now slightly looser. Alignment, `bodyDigestOf`, `buildStructureClaim` and every claim schema are untouched.

**State version bumped `doc-compare-state-v1` → `-v2`.** `DocumentSection` gained two fields and `DocCompareState` checkpoints the sections, so a state written by a v1 build would reach `planChunks` with no offsets and produce `NaN` lengths. `advanceDocCompare` already rejects a foreign state version, so the bump converts silent corruption into an explicit `STATE_VERSION_MISMATCH`. No wire field changed and no test asserted the v1 literal.

## 3. Objective 2 — stale P9-01 comment

`document-core.manifest.ts` carried: *"The existing root handler kind remains the manifest fallback until host dispatch wiring is added in the separate F4 lane."* That is no longer true — `documentCoreHandlers.disbursement` is registered, `root` routes on `ctx.action`, and fan-out/approval ride the SDK `spawnAndWait`/`waitForInput` facades. Replaced with a comment describing the actual wiring and why `root` is still declared. **Comment only; no code and no behaviour changed.** `manifest.test.ts` green.

## 4. Δ2 — `runChunkChildren` disposition: FIXED, not documented around

Chose the fix. The defect was provable from the callers: all four test call sites did `runChunkChildren(...)` then **discarded** the returned token and substituted `state.joinToken ?? ''` — the signature returned a value that no state could ever accept.

- `joinToken` is now a **required third parameter** and is echoed back; an empty/blank token throws `DocCompareError('JOIN_TOKEN_MISMATCH')` before any child runs. The wrong submission is now unrepresentable, and the compiler forces every caller to supply the token.
- 5 call sites updated, and the `?? ''` workarounds deleted — which is the proof the fix works rather than being re-papered over.
- New test asserts the token round-trips, and a second asserts `''` and `'   '` are both rejected.

**Known gap left open on purpose:** the concurrency ceiling inside the helper is the module constant, not the `SpawnChunkChildren.maxConcurrency` the caller asked for — `const limit = Math.max(1, Math.min(runtime ? MAX_CHUNK_FANOUT_CONCURRENCY : 1, MAX_CHUNK_FANOUT_CONCURRENCY))` simplifies to 8 unconditionally, so that expression is also dead logic. A caller requesting `maxConcurrency: 1` gets 8 concurrent provider calls. Documented in the function's doc comment. **Not fixed:** threading it through changes fan-out concurrency, which is a behaviour decision beyond Δ2, not a consistency fix.

## 5. Verification (literal)

| Check | Result |
|---|---|
| Focused 8 suites (D5 §4 command) | **8 suites / 106 tests, 106 passed, exit 0** (was 104 — +2 new tests) |
| Full document-core | **58 suites / 923 tests: 922 passed + 1 skipped, exit 0** |
| `tsc --noEmit` document-core | **exit 0** |
| `tsc --noEmit` services/orchestrator | **exit 0** |
| 4 doc-compare suites | **70 tests, all green** |

**Negative control for Δ4 (this is the part that makes the regression test worth having):** I temporarily restored the pre-fix body-space coordinate system inside `extractSections` and re-ran the tiling test — **it went red** (1 failed / 34 skipped). Restored text-space — green. So the test genuinely witnesses the defect and is not passing for an unrelated reason. The negative-control patch was reverted and re-verified by `tsc --noEmit` exit 0 before the final runs.

The new regression test drives 9 documents (empty, no-heading, trailing newline, preamble + headings, 3 sections, CRLF, one 5008-char oversized section, an oversized section **followed** by a normal one, and 12 packed sections) and asserts for each: `chunks.map(slice).join('') === text`, `startOffset` of each chunk equals the previous `endOffset`, `charCount === endOffset - startOffset`, and the final cursor equals `text.length`.

Two honest test changes, both stated rather than silently made: `covered` and the last `endOffset` in the oversized-section test moved from `5000` to `huge.length` (5008). `5000` was the body-only length and encoded exactly the coordinate-space defect; asserting it would have pinned the bug back in place. No assertion was weakened — both were strengthened.

## 6. Baseline caveat — the full-suite aggregate is not a stable number

D5 reported 921 tests with 1 red. D5b reports 923 with 1 skipped and **no red**. Both facts are real and neither is a regression:

- **+2 tests** = the two new tests in this packet.
- **The `p8-03` red disappeared because another lane added a live-infra guard**, visible in the shared working tree as an uncommitted `tests/p8-03-provider-convergence.test.ts` **+4/−1** that is **not mine** (`git status` at the end of D5 did not list it): `const LIVE_INFRA = process.env.DU_LIVE_INFRA === '1'; const liveTest = LIVE_INFRA ? test : test.skip;`. I did not touch that file.
- **Measured proof that the guard, not a database, is the switch** (both runs of the same suite, nothing else changed): `DU_LIVE_INFRA=0` → *1 skipped, 6 passed, exit 0*; `DU_LIVE_INFRA=1` → *1 failed (ECONNREFUSED), 6 passed, exit 1*.

So the D5 statement "`p8-03` runs a live DB test with no skip guard" was **accurate when D5 ran** and became stale when the other lane landed the guard mid-D5b. D5's receipt is left unedited; this note supersedes it. **Compare per-suite, not by aggregate count** — concurrent lanes move the aggregate.

## 7. Open / not done

- **Δ1 unchanged and still OPEN:** `doc_compare_structure` / `doc_compare_references` are overridable defaults; nothing in `services/connector` registers them.
- **Δ4 follow-up (new):** the fan-out concurrency gap in §4.
- **Δ6:** no live leg. All evidence offline; the handler has still never run against a real orchestrator/queue/runtime.
- **Not attempted:** `services/orchestrator` dispatch for `doc-compare` submissions; live DB/Redis window.

## RESUME POINT

- Packet **D5b** closed 2026-10-02. Lease on `doc-compare/**` released again.
- Δ4 closed (fixed + negative-controlled), P9-01 comment closed, Δ2 closed (fixed). Remaining from D5: Δ1 (connector lane) and Δ6 (live leg). New: the fan-out concurrency gap.
- **Reproduce:** `cd du-rework/businesses/document-core && npx jest` → expect 58 suites / 923 tests, 922 green + 1 skipped. Set `DU_LIVE_INFRA=1` to see the `p8-03` live test run and fail without Postgres on `:5433`.
