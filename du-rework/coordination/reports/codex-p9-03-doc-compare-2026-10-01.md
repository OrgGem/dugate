# P9-03 — doc-compare advanced (bounded multi-step comparison workflow)

- **Recorded:** 2026-10-01. **Mode:** implementation, business logic + own tests only.
- **Status:** module implemented and offline-verified. **NOT mounted, NOT registered.** See §6 for follow-ups other lanes own.

## 1. Files written (my entire footprint)

| File | Bytes |
|---|---|
| `businesses/document-core/src/pipelines/workflows/doc-compare/types.ts` | 8,683 |
| `businesses/document-core/src/pipelines/workflows/doc-compare/primitives.ts` | 3,655 |
| `businesses/document-core/src/pipelines/workflows/doc-compare/chunking.ts` | 14,634 |
| `businesses/document-core/src/pipelines/workflows/doc-compare/doc-compare.ts` | 21,343 |
| `businesses/document-core/src/pipelines/workflows/doc-compare/index.ts` | 1,750 |
| `businesses/document-core/tests/p9-03-doc-compare.test.ts` | 33 tests |

**Lease respected.** `src/pipelines/workflows/disbursement/**` untouched (mtime verified unchanged). `manifest/`, `recipes/`, `actions/`, `validation/` are NOT mine and were not written; their modified state in `git status` is codex_worker_1's work. `packages/**`, `services/**`, `tasks/*.md`, `gates/*`, `server.ts`, `main.ts` untouched.

## 2. BRD — what doc-compare does DIFFERENTLY from the `compare` CORE action

Sources: legacy `lib/endpoints/registry.ts` compare rows, and `lib/pipelines/workflows/doc-compare.ts`.

| Dimension | `compare` CORE action | `doc-compare` advanced (this module) |
|---|---|---|
| Registry row | `compare`, discriminator `mode`, variants `diff` / `semantic` / `version`, connections `ext-comparator` | a WORKFLOW (`workflows` table), not a `compare` sub-case |
| Inputs | two texts forwarded to one processor call | two whole documents, split into sections, chunked, compared per chunk |
| Prompt shape | `buildSectionComparePrompt(toc, doc1Text, doc2Text, ...)` — **whole documents in one call** (legacy step 2) | never sends a whole document: bounded chunks only |
| Steps | one pass | 4 distinct stages: extract-structure, compare-structure, compare-references, merge-evidence |
| Structure vs semantics | collapsed into ONE `ext-doc-compare` call, so a reference finding could not be traced back to a structure finding | **separate stages with typed state between them** — `StructurePlan` is produced by the structure stage and consumed by the reference stage |
| Large documents | none. Past the provider context limit the single call fails, so the large-document path did not exist | chunked, per-chunk budget, checkpointed, resumable |
| Evidence | free-text report from `ext-content-gen` | one merged `ComparisonEvidence`; every claim carries `evidenceChunkIds` |
| Human gate | none | optional `wait-for-review` before the merge is written |
| Input count | — | legacy used `filesData[0]`/`[1]` and only errored on `< 2`, so a 3-file submit silently compared the first two; this module requires exactly two sides |

**Deliberate divergence, not parity:** that `>= 2 files` behaviour is a silent-drop defect (a third document is ignored without telling anyone). Refusing it is a COMP-00/P9 decision, not something I claimed as parity.

## 3. Evidence with source references, no fabricated confidence

- Every `StructureClaim` / `ReferenceClaim` carries `evidenceChunkIds` — the chunks actually read. `ReferenceClaim.reference` is the literal reference text, so a reviewer can find it without trusting the verdict.
- **No `confidence` field exists anywhere in the types**, and a test asserts its absence. What IS recorded is the derivable `matchKind` (`exact` / `normalized` / `positional` / `unmatched`), plus body digests and ordinals. A score that cannot be derived is omitted rather than invented.

## 4. Large-document handling

- `planChunks` packs sections up to `maxChunkChars` and never emits a chunk over budget.
- One section larger than the budget is split with `boundaryKind: 'size'` rather than truncated — a truncated clause would be reported as text that was never compared.
- Chunk ids and section ids are **deterministic digests**, so a resumed run plans the same spans (two tests pin byte-identical plans and stable ids).
- `MAX_CHUNK_CHARS` / `MIN_CHUNK_CHARS` clamp a hostile budget instead of trusting it.

## 5. Resume model — and a design problem I hit and fixed

`advanceDocCompare` returns ONE typed continuation per turn: `spawn-chunk-children`, `wait-for-review`, or `terminate`. A turn that **absorbs a join can also return the next fan-out**.

That is a footgun and my own test helper walked into it: it kept only `.state` from the join turn, silently dropping the reference fan-out, after which the workflow merged an evidence record missing its entire reference half — a wrong answer that looks like a correct one.

**I first tried closing this by throwing.** The guard fired and proved the skip was real, but throwing is the wrong answer: a host that crashes after receiving a fan-out IS the resume case, and refusing to re-issue would make resume impossible. **Shipped behaviour: re-issue the same fan-out** when a turn arrives with a pending stage and no join. A chunk is a pure function of its plan, so re-issuing is safe, and it is what makes resume a resume. The `CHUNK_NOT_ISSUED` guard still rejects a join naming a chunk that was never issued.

Resume ledger: `state.chunkEvidence` is keyed `<stage>:<chunkId>`, and a stage re-issues only the chunks missing from it (two tests, including a partial-crash case).

## 6. Follow-ups for OTHER lanes — not done by me

1. **Manifest / recipe / action registration.** `document-core.manifest.ts` and the recipe definitions are NOT my lease. The module is exported from `pipelines/workflows/doc-compare/index.ts` but **nothing references it**. Registration is a follow-up for the manifest/recipe owner.
2. **Handler wiring.** `DocCompareRuntime.runChunk` has no production implementation. A real chunk runner (provider call, structure/reference claim extraction) is a separate packet — detailed business tests were explicitly out of scope here.
3. **`P9-05` legacy facade stays blocked on COMP-00.** No route mounted, no contract frozen, `server.ts`/`main.ts` untouched.
4. **`P9-02` lc-checker untouched**, as instructed.

## 7. Bugs I found in my OWN code, and how

All found by running tests, not by reading. Each is now pinned by a test.

| Bug | How it surfaced | Fix |
|---|---|---|
| A heading on the first line emitted an empty `(preamble)` section that then competed in alignment | probe showed 4 sections where 3 exist | flush only when there is real content |
| NFKD left combining marks, which punctuation collapse turned into SPACES (a Vietnamese word normalized with an inserted space mid-word) | probe printed the normalized string | strip `\p{M}` BEFORE collapsing punctuation |
| After a size-split the trailing emit re-emitted the whole body: a 5000-char section covered 10000 chars | probe summed coverage | emit leftover only when sections are pending |
| Positional pairing reported a deletion + addition as one modified section | alignment paired the removed clause with the added one | pair positionally ONLY when both unmatched sets are the same size |
| An accepted human review re-raised the wait forever | test expected terminate, got wait | wait only while the review is OUTSTANDING |

I also wrote two wrong test expectations (a section count, and a title-normalization equality that the letter `đ` makes undecidable) and corrected the TESTS rather than weakening the module.

## 8. Evidence

- **Tests:** `npx jest --runInBand --runTestsByPath tests/p9-03-doc-compare.test.ts` — **3 consecutive runs**, each `Tests: 33 passed, 33 total`, `Test Suites: 1 passed, 1 total`, ExitCode 0.
- **Typecheck:** `npx tsc --noEmit` from `du-rework/businesses/document-core` — **ExitCode 0**.
- **Resume-from-checkpoint case:** present and passing (two tests, including the partial-crash ledger case).
- **No infra used:** the suite is pure in-memory — no DB, Redis, S3 or provider. The temporary diagnostic probe test was deleted before the verification runs.

## 9. Gates

**No release gate ticked.** `G-ADMIN-OPS`, `G-SEC`, `G-DATA`, `G-ENC`, `G-COMP`, `G-LOCAL-ADMIN`, `G6` all remain **NO-GO** and unchanged. No commit. No other lane's changes touched. No message sent to nocobase-10.
