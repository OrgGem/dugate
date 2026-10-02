# P9-03 independent verification — 2026-10-02

## Execution

Ran the packet's targeted suite from `du-rework/businesses/document-core`, plus both source and test TypeScript checks. The suite uses local fixture documents and `stubRuntime`; no shared DB, Redis, S3, provider, or live Orchestrator was used. No source, test, other-lane file, or gate row was edited.

| Command | Exit | Result |
|---|---:|---|
| `npx jest --runInBand --runTestsByPath tests/p9-03-doc-compare.test.ts` | 0 | 1 suite passed; 33 tests passed, 0 failed; 0 snapshots. |
| `npx tsc --noEmit -p tsconfig.json` | 0 | No diagnostics. |
| `npx tsc --noEmit -p tsconfig.test.json` | 0 | No diagnostics. |

Raw targeted Jest output:

```text
Test Suites: 1 passed, 1 total
Tests:       33 passed, 33 total
Snapshots:   0 total
Time:        2.264 s
Ran all test suites within paths "tests/p9-03-doc-compare.test.ts".
Exit code: 0
```

No tests were red, so there is no failure output to quote.

## Claim comparison

| Claim | Verdict | Evidence |
|---|---|---|
| Bounded chunks; provider payload does not include a whole document | **CONFIRMED in current source; live execution unverified** | Chunk budget is clamped (`businesses/document-core/src/pipelines/workflows/doc-compare/chunking.ts:35-36,121-216`); tests enforce emitted chunk limits and size-split coverage (`tests/p9-03-doc-compare.test.ts:233-265`). The current runner constructs `chunkText` from the selected chunk and invokes the connector with that payload (`src/pipelines/workflows/doc-compare/runner.ts:191-218,349-370`). The targeted suite exercises the state machine with a stub runtime, not a real provider. |
| Four stages with typed state between them | **CONFIRMED** | Stage union/order is `extract-structure`, `compare-structure`, `compare-references`, `merge-evidence` (`src/pipelines/workflows/doc-compare/types.ts:183-225`); continuations and stage payloads are typed (`src/pipelines/workflows/doc-compare/primitives.ts:15-78`). Tests assert distinct structure/reference stages and bounded fan-out (`tests/p9-03-doc-compare.test.ts:270-293`). |
| Claims carry `evidenceChunkIds` | **CONFIRMED** | Both `StructureClaim` and `ReferenceClaim` declare `evidenceChunkIds` (`src/pipelines/workflows/doc-compare/types.ts:107-141`); the structure-claim assertion verifies chunk IDs (`tests/p9-03-doc-compare.test.ts:211-217`). |
| Exactly two sides; a third file is refused (deliberate divergence) | **REFUTED for runtime input validation** | The TS interface declares `left` and `right` (`src/pipelines/workflows/doc-compare/types.ts:65-82`), but `normalizeDocCompareInput` does not reject unknown keys: it reads `left` and `right` and returns a new normalized object without checking for any third-side or extra-file property (`src/pipelines/workflows/doc-compare/doc-compare.ts:141-164`). Consequently an extra side/property accompanying valid `left` and `right` is ignored, not rejected. The targeted tests require both sides/artifact IDs but contain no third-file rejection case (`tests/p9-03-doc-compare.test.ts:322-331`; full suite has 33 tests). This contradicts the receipt's “refuses” claim. |
| No fabricated `confidence` field | **CONFIRMED** | Claim interfaces omit confidence (`src/pipelines/workflows/doc-compare/types.ts:107-141`); tests assert no confidence field in serialized claims/evidence (`tests/p9-03-doc-compare.test.ts:220-228,403-423`). |
| Not mounted or registered (no server/registry wiring) | **CONFIRMED in searched current paths** | Search for `doc-compare`/`DocCompare` in `services/orchestrator/src`, `businesses/document-core/src/manifest`, `src/recipes`, `src/worker.ts`, and package `src/index.ts` returned no wiring matches. The module's own `pipelines/workflows/doc-compare/index.ts` exports do not themselves register it. |
| Receipt §6 says `DocCompareRuntime.runChunk` has no production implementation | **REFUTED in current tree; wiring remains absent** | A connector-backed `createDocCompareRuntime` now exists in `src/pipelines/workflows/doc-compare/runner.ts:339-419`. It is not referenced by the searched worker, manifest, recipe, or Orchestrator paths, so this verifies a runner module exists, not a registered/executable business workflow. The packet-targeted test does not import this runner; no runner-specific suite was run. |

## Verdict

**VERIFIED=No.** The requested suite and both typechecks pass, and the bounded-chunk, typed-stage, evidence, confidence, and non-registration claims are supported. The concrete blocker is the receipt's assertion that a third file is refused: the runtime normalizer silently ignores extra keys when valid `left` and `right` are present. The receipt's separate “no production runner” statement is also stale in the current tree; a runner module exists but remains unwired. No P9-03 gate was ticked.
