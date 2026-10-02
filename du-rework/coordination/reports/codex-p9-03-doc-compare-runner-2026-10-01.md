# D4 — doc-compare production chunk runner (`runChunk`)

- **Recorded:** 2026-10-01. **Mode:** implementation, business logic + own tests only.
- **Status:** `runChunk` implemented and offline-verified. **Not mounted, not registered.** See follow-ups.

## 1. Files written (my entire footprint)

| File | Bytes |
|---|---|
| `businesses/document-core/src/pipelines/workflows/doc-compare/runner.ts` | 15,681 |
| `businesses/document-core/tests/p9-03-doc-compare-runner.test.ts` | 20 tests |

**No other file touched.** `document-core.manifest.ts`, `src/worker.ts`, `recipes/*` show as modified in `git status` — that is **D3's** work this cycle (coordinator confirmed D3 holds those files); I did not write them. The other five doc-compare files and `tests/p9-03-doc-compare.test.ts` are unchanged from P9-03.

## 2. What was missing and is now implemented

P9-03 declared `DocCompareRuntime.runChunk: (spec: ChunkTaskSpec) => Promise<ChunkOutcome>` and `advanceDocCompare` throws `INPUT_INVALID` when it is not a function — but **no production implementation existed**; every one of the 33 P9-03 tests ran on a stub runtime, so the module could not actually run. `createDocCompareRuntime` closes that gap.

It follows the same connector pattern document-core already uses (`ctx.connector.invoke(slot, {task, payload, responseFormat}, options)` — the same shape as `src/actions/compare/index.ts`). The connector port is **structurally identical** to `TaskContext['connector']` (`src/types/context.ts`), so a real `ctx.connector` can be passed straight in.

## 3. Two design decisions

**(a) Evidence comes from a validated claim array; `succeeded` requires proof.**
After a `SUCCESS` invocation the runner prefers `invocation.data`, else strips a fenced block off `rawText` (mirroring the compare action), then parses `structureClaims` / `referenceClaims` into the module types with an **allow-list of verdicts** (`unchanged|modified|added|removed|moved` / `resolved|unresolved|contradicted|not-applicable`). `status:'succeeded'` is returned only when the connector said SUCCESS **and** at least one valid claim parsed. An unknown verdict, a missing claim array, an empty array, or unparseable text all fail. This is the deliberate inverse of legacy, which did `parseDeep(content) as TocExtractionResult` / `as DocCompareResult` with **no validation at all** (`lib/pipelines/workflows/doc-compare.ts` steps 1–2).

**(b) Error codes are CHUNK-scoped, never provider-scoped.**
The merge stage records a chunk id + reason and must not have to know which provider failed, so the codes are `CHUNK_FAILED | CHUNK_TIMEOUT | CHUNK_INVALID_INPUT | CHUNK_MALFORMED_RESPONSE | CHUNK_EMPTY_EVIDENCE | CHUNK_IDENTITY_LEAK`. The provider's own code is preserved inside `message` so an operator can still trace it, without this module pretending to classify provider faults. `runChunk` **never throws** for a business reason — every failure becomes a `failed` outcome, because the fan-out treats a throw as an unstructured crash while the merge needs a recordable reason.

Identity guard kept on both sides: a payload **or a reply** carrying an identity field fails (`CHUNK_IDENTITY_LEak`). A provider echoing a tenant/key into the comparison must not reach a reviewer as a claim.

## 4. Bounded work — the runner never sends a whole document

The spec carries both full documents (the state machine needs them for alignment), but `sliceChunkText` extracts only `endOffset - startOffset` characters and offsets are **clamped**, so a corrupt plan degrades to available text instead of throwing mid-fan-out. A test asserts the sent payload is bounded and does not contain the full side text.

## 5. Two bugs I found in my own runner, caught by the new tests

- **Identity guard matched nothing.** I normalized the candidate key (`_`/case) but compared it against a **raw** set of camelCase+snake_case spellings, so `apiKeyId` normalized to `apikeyid` and matched neither raw entry — the guard silently never fired. Fixed by storing the set **already normalized** and normalizing dashes too. (Caught because the payload-identity test ran green with a poisoned key, which should never have passed.)
- **My integration mock, not the runner, was wrong.** It keyed replies on call parity, so a reference chunk received a structure reply and the runner correctly rejected it. Corrected the mock to key on the task the runner actually sent. The runner was right; the test was wrong.

One earlier carry-over from P9-03 bit me again: the driver must carry the pending join across turns (a turn that absorbs a join also returns the next fan-out). I reused the corrected driver this time.

## 6. Acceptance

- **Both doc-compare suites green together, 3 consecutive runs:**
  `npx jest --runInBand --runTestsByPath tests/p9-03-doc-compare.test.ts tests/p9-03-doc-compare-runner.test.ts`
  → each run: **`Test Suites: 2 passed, 2 total`, `Tests: 53 passed, 53 total`**, ExitCode 0. The original **33 P9-03 tests remain green** (regression: none).
- **Typecheck:** `npx tsc --noEmit` from `du-rework/businesses/document-core` — **ExitCode 0**.
- **≥3 new runner tests:** 20 provided (structure success, reference success, connector ERROR → failed, thrown error → failed, timeout → CHUNK_TIMEOUT, malformed/missing/empty/unknown-verdict replies → failed, unparseable rawText → failed, fenced-JSON parse, missing chunk descriptor → failed, reply/payload identity leak → failed, slice clamping, and a real fan-out driven end-to-end to a merged SUCCEEDED result).
- **No infra used:** the runner suite is pure in-memory with a mock connector. No DB, Redis, S3 or provider.

### Full document-core suite (honest)

`npx jest --runInBand` (full): **53 passed / 3 failed suites; 870 passed / 4 failed tests of 874**. All 4 failures are **pre-existing and unrelated to doc-compare** — none is in a doc-compare suite:
- `bullmq-smoke` (1): needs Redis 6380 + worker env (`RUNTIME_URL`/`RUNTIME_TOKEN`/`REDIS_URL` unset in this shell).
- `all-variants-e2e` (2) + `corpus-regression` (3 suite-load): the three legacy variants `extract/id-card`, `analyze/fact-check`, `analyze/summarize-eval` have no corpus fixture (`getCorpusEntry(...)` undefined). These are the COMP-04 missing-variant work, not mine.

I did not touch those files and am not fixing them (not in my lease). Baseline note: the coordinator cited 810/4 before D3's additions; the suite is now 874 with the same 4 failure class. **None of the 4 is new because of D4.**

## 7. Follow-ups (other lanes / not mine)

1. **Manifest / recipe registration** — not done here (coordinator: registration lane). The runner is exported but nothing references it in the manifest.
2. **Provider task names** `doc_compare_structure` / `doc_compare_references` are defaults in `DEFAULT_DOC_COMPARE_BINDING`; they are **config**, overridable per runner, and must match whatever the provider actually registers. Not asserted against a live provider here.
3. **Resume / parallel regression:** the 33 P9-03 tests (resume-from-checkpoint, concurrency) remain green; no new red.

## 8. Gates

**No release gate ticked.** `G-*` all remain **NO-GO**. No commit. No other lane's changes committed. No message to nocobase-10. `AGENTS.md` / `tasks/README.md` / execution overlay untouched.
