# D5 + D5B independent verification — 2026-10-02

## Run context and suite results

- `HEAD` at verification: `f2be0def52368aca0b7cf2d24af406de718154bc`.
- `DU_LIVE_INFRA` was explicitly unset for the test runs. No database, Redis, Docker, or other live infrastructure was used.
- Focused-suite CWD: `D:\Git\dugate\du-rework\businesses\document-core`.
- Full-suite CWD: `D:\Git\dugate\du-rework`.

| Run | Exact command | Result | Exit |
|---|---|---|---:|
| D5 §4 focused command, final stable rerun | `Remove-Item Env:DU_LIVE_INFRA -ErrorAction SilentlyContinue; npx jest manifest sdk-consumer missing-variants p9-03-doc-compare p9-03-doc-compare-runner p9-03-doc-compare-registration p9-03-doc-compare-handler worker` | `Test Suites: 9 passed, 9 total`; `Tests: 120 passed, 120 total`; `Time: 10.591 s` | 0 |
| Full document-core | `Remove-Item Env:DU_LIVE_INFRA -ErrorAction SilentlyContinue; $env:REDIS_SMOKE='0'; $env:DATABASE_URL='postgresql://du:du-test-only@127.0.0.1:1/du_orchestrator_test'; pnpm --filter @du/document-core test` | `Test Suites: 58 passed, 58 total`; `Tests: 1 skipped, 924 passed, 925 total`; `Snapshots: 0 total`; `Time: 35.172 s` | 0 |
| Document-core typecheck | `Remove-Item Env:DU_LIVE_INFRA -ErrorAction SilentlyContinue; npx tsc --noEmit -p tsconfig.json` | No diagnostics | 0 |
| Extra suite selected by focused filter | `npx jest --runTestsByPath tests/r1-e-layer6-archive-worker.test.ts --runInBand` | `Test Suites: 1 passed, 1 total`; `Tests: 12 passed, 12 total` | 0 |

The focused result does **not** equal the expected `8 suites / 106 tests`: the exact §4 pattern `worker` also selects `tests/r1-e-layer6-archive-worker.test.ts` (confirmed by `npx jest --listTests`, 12 passing tests). The current worktree also contains two additional fan-out tests in `tests/p9-03-doc-compare.test.ts:598,615` (`clamps the caller ceiling...` and `runs no more children...`). Thus the literal command selects 9 suites / 120 tests, with no failures. The full-suite total is two tests above the expected 923 for the same two current fan-out tests; all 924 non-skipped tests pass.

## Concurrent mtime changes

I captured `LastWriteTimeUtc` for 99 TypeScript files under `businesses/document-core/src` and `tests` before and after runs. The working tree changed during initial focused attempts:

| File | Observed mtime transition(s), UTC | Resulting action |
|---|---|---|
| `src/pipelines/workflows/doc-compare/doc-compare.ts` | `04:10:16.6243373` → `04:24:38.5443428`; later `04:27:04.5773706` → `04:27:19.1991016` | Reran focused suite after the code update. |
| `src/pipelines/workflows/doc-compare/index.ts` | `03:37:07.9721540` → `04:25:11.7295821` | Included in the focused rerun. |
| `tests/p9-03-doc-compare.test.ts` | `04:11:45.5024162` → `04:25:12.0953390`; later `04:25:54.2105964` → `04:26:23.2733408` | Reran focused suite after the test update. |
| `tests/p9-03-doc-compare-runner.test.ts` | `04:10:48.5784476` → `04:25:12.1817833` | Included in the focused rerun. |

One intermediate focused run overlapped the `doc-compare.ts` update and reported `Expected: 1, Received: 8` in the max-concurrency assertion: `Test Suites: 1 failed, 8 passed, 9 total`; `Tests: 1 failed, 119 passed, 120 total`; exit `1`. After the update, the exact focused command passed `9/9, 120/120`. Mtime snapshots before/after that final focused run and the full suite were unchanged; no further rerun was needed. These changes were already in the shared worktree; this verification edited no source or test files.

## Independent cross-checks

- **Δ4 tiling:** Ran a read-only in-memory probe using `extractSections` + `planChunks` on three distinct documents: Markdown headings + CRLF (754 chars, 2 sections, 4 chunks), plain LF text (1,235 chars, 1 section, 7 chunks), and numbered headings + CRLF (1,070 chars, 3 sections, 6 chunks). For every document, successive offsets were contiguous, each `charCount === endOffset - startOffset`, final cursor equaled `text.length`, and `chunks.map(c => text.slice(c.startOffset, c.endOffset)).join('') === text`; all three passed. The implementation records text spans in `chunking.ts:79-119`, plans from `section.textStart/textEnd` at `:189-208`, sets `charCount` from offset differences at `:177,208`, and slices the same source text in `runner.ts:163-165`. The regression assertions also pin reconstruction and contiguous offsets in `tests/p9-03-doc-compare.test.ts:277-307`.
- **Δ2 join token:** `runChunkChildren` now requires `joinToken: string` and rejects empty/whitespace tokens with `JOIN_TOKEN_MISMATCH` (`src/pipelines/workflows/doc-compare/doc-compare.ts:592-603`); the focused suite's empty-token test passes (`tests/p9-03-doc-compare.test.ts:658-670`). The broader claim “no call site still uses `?? ''`” is not literally true: test helper calls still have fallbacks at `tests/p9-03-doc-compare.test.ts:132,151` and `tests/p9-03-doc-compare-runner.test.ts:318`. The repository search found no production call to this helper; the remaining fallbacks are test-only.
- **P9-01 manifest comment:** No stale “host dispatch wiring pending” text remains in `src/manifest/document-core.manifest.ts`. Its current comment says doc-compare is intentionally separate from compare (`:11-15`), and `handlerKinds` includes `doc-compare` (`:101-110`). `tests/manifest.test.ts` was among the passing focused suites.
- **State version:** `DOC_COMPARE_STATE_VERSION` is `doc-compare-state-v2` (`src/pipelines/workflows/doc-compare/types.ts:21`). `advanceDocCompare` explicitly throws `STATE_VERSION_MISMATCH` when a supplied state version differs (`src/pipelines/workflows/doc-compare/doc-compare.ts:459-463`). Separately, the persisted worker checkpoint loader rejects a mismatched version as `DOC_COMPARE_STATE_INVALID` (`src/worker.ts:1413-1420`).
- **Δ5 barrel export:** `createDocCompareRuntime` is exported from the workflow barrel (`src/pipelines/workflows/doc-compare/index.ts:81`); `npx tsc --noEmit -p tsconfig.json` exits `0`, with no type/export collision.

## P9-03 extra-key finding

**Verdict: the finding remains for the exported normalizer helper, but D5 closes the ordinary handler-input boundary.** A read-only in-memory probe called `normalizeDocCompareInput` with valid left/right objects plus both an unknown top-level key and an unknown nested-side key. It returned successfully and omitted both keys (`accepted: true`, `topLevelExtraRetained: false`, `sideExtraRetained: false`); the helper selects known fields without rejecting arbitrary extras (`doc-compare.ts:119-163`).

The handler's `validateDocCompareInput` and `validateDocCompareSide` apply explicit top-level and side-field allowlists (`src/worker.ts:1276-1285,1295-1303,1319-1340`). A second in-memory probe of that validator rejected both unknown-key cases with `DOC_COMPARE_INPUT_INVALID` (“Doc-compare input contains an unsupported field” / “Doc-compare \"left\" contains an unsupported field”). The handler's unsupported-input test also passes (`tests/p9-03-doc-compare-handler.test.ts:260-273`). Therefore unknown extras are still silently discarded by direct helper callers, but are rejected by the registered handler path.

## Verdict

All final stable suites and the document-core typecheck are green; no live verification is claimed. The exact focused command has 14 more selected tests than the stated expectation, and the full suite has 2 more, explained above rather than hidden. The P9-03 finding is closed at the handler boundary but still reproducible when calling `normalizeDocCompareInput` directly. I did not edit source/test files, gates, or commits; this receipt is the only write.
