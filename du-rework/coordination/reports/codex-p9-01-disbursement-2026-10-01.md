# P9-01 — disbursement business workflow (implementation receipt)

> **Packet** implementation-first directive, 2026-10-01. **Lease** `businesses/document-core/src/pipelines/**` (new `workflows/disbursement/**`) and my own new test file.
> **Status** business logic implemented and green offline. **NOT wired to the platform** — registration belongs to another lane, itemised in §6.

## 1. What was built

A bounded multi-step disbursement workflow expressed as **typed continuation primitives**, with no interpreter anywhere. The business layer decides what happens next and returns a descriptor; the host does three mechanical things with it: run children, persist a wait, write a terminal record.

| File | Lines | sha16 | Role |
|---|---|---|---|
| `src/pipelines/workflows/disbursement/primitives.ts` | 87 | `be3aa11a3ab800e2` | Continuation descriptors + `JoinSubmission` + `isTerminal` |
| `src/pipelines/workflows/disbursement/types.ts` | 140 | `d5467c4f3edfa64c` | Versioned input / state / resume / evidence schemas, business ports |
| `src/pipelines/workflows/disbursement/fanout.ts` | 82 | `28c7825015b3e5c5` | Bounded fan-out executor, order-preserving |
| `src/pipelines/workflows/disbursement/disbursement.ts` | 698 | `03efcd70fb5479ac` | Input guard, state machine, approval gate, crosscheck, report |
| `src/pipelines/workflows/disbursement/index.ts` | 12 | `f23490bdc034ea10` | Barrel |
| `tests/p9-01-disbursement.test.ts` | 660 | `db2f312c3db37962` | 45 offline unit tests |

**Stage flow:** classify (bounded fan-out) → extract (bounded fan-out) → **human approval** → crosscheck (sequential, checkpointed) → report (sequential, checkpointed) → terminate.

The legacy shape is preserved (4 stages, HITL between extract and cross-check) with two structural changes: the fan-out is **bounded**, and the workflow is a **multi-turn state machine** rather than one long `runDisbursement` — which is what makes it resumable at all.

### Continuation set actually emitted

`spawn-children` | `wait-for-input` | `terminate`. That is the complete union. A join is an **input** (`JoinSubmission`), not an outcome: once results are accepted the workflow continues in the same call, so there is nothing to hand back. I removed two kinds I had initially declared (`join-children`, `advance-step`) because the code never emitted them — a declared-but-unemittable kind is a promise the type system does not keep.

## 2. Acceptance — every item, honestly

| # | Item | Result |
|---|---|---|
| 1 | Disbursement workflow with typed continuation primitives | **DONE** — 5 source files, 1019 lines |
| 2 | Own unit tests green + literal `Tests: N passed` | **DONE** — `Test Suites: 1 passed, 1 total` / **`Tests: 45 passed, 45 total`** |
| 3 | `npx tsc --noEmit` in document-core exit 0 | **PARTIAL — see §2.1.** My files produce **0 errors**. The project-wide run now exits **2**, entirely from another lane's `src/pipelines/workflows/doc-compare/**`. I did not touch it. |
| 4 | This report | **DONE** |

Commands run, verbatim results:

```
npx jest --runInBand --runTestsByPath tests/p9-01-disbursement.test.ts
  Test Suites: 1 passed, 1 total
  Tests:       45 passed, 45 total

npx tsc --noEmit -p tsconfig.json        -> exit 0
npx tsc --noEmit -p tsconfig.test.json   -> exit 0
```

## 2.1 `tsc --noEmit` — what is mine and what is not

Measured, not asserted. `npx tsc --noEmit -p tsconfig.json` was **exit 0** when my implementation was complete (17:32:48, my last write). The current project-wide run exits **2** with **11 errors, all in another lane's files**:

| Errors | File | Lane |
|---|---|---|
| 9 | `src/pipelines/workflows/doc-compare/chunking.ts:305,308,310,349,371` | P9-03 doc-compare — not my lease |
| 2 | `src/pipelines/workflows/doc-compare/doc-compare.ts:281,290` | P9-03 doc-compare — not my lease |

**Zero** of the 11 reference `disbursement/`. The mtimes settle it:

```
17:32:48  disbursement/disbursement.ts   <- my last write
17:35:48  doc-compare/primitives.ts     <- another lane, after me
17:36:33  doc-compare/chunking.ts
17:46:00  doc-compare/types.ts
17:47:30  doc-compare/index.ts
17:53:44  doc-compare/doc-compare.ts
```

That lane's code was still in flight while I finished. Their failures are null-dereference and missing-type errors in their own files, and editing them would be a lease violation, so I left them alone. **Acceptance item 3 is therefore honestly PARTIAL: green for my code, red for the project because of a neighbour.** I am not reporting an exit 0 I did not get.

To reproduce the green state for my own code alone, run `tsc` before the doc-compare lane lands, or scope the check to `src/pipelines/workflows/disbursement/**`.

## 3. Regression status of the offline suite

`npx jest --runInBand` (full offline default run): **810 passed, 4 failed, 52 suites**.

I did not take the 4 failures on trust. I moved my directory and my test file aside, re-ran the two fast failing suites, and got **byte-identical failures** — so they are pre-existing and independent of this work. No pre-existing suite imports my module; the only importer is my own test.

| Failing suite | Cause | Mine? |
|---|---|---|
| `bullmq-smoke.test.ts` | needs live Redis on 6380; **not run to completion** (timed out at 600s) | no |
| `corpus-regression.test.ts` | `getCorpusEntry()` returns undefined | no — reproduced with my code removed |
| `all-variants-e2e.test.ts` | `DOC-02-06` / `DOC-03-06` / `DOC-03-07` unhandled | no — reproduced with my code removed |

Worth flagging: those three E2E cases are **exactly the three legacy-only variants** my COMP-04 report recorded as `MISSING-RECIPE` — `extract:id-card`, `analyze:fact-check`, `analyze:summarize-eval`. A suite named "31-Variant" is asserting 31 against a 28-entry registry. That gap predates this packet and is not in my lease.
## 4. Two real defects my own tests caught

Both were found by the tests, not by review, and both were in the product rather than the harness. I am recording them because the second one is the kind of bug that only appears once a workflow is genuinely multi-turn.

**Δ-P9-01-A — a join could be merged into the wrong stage.**
`advanceDisbursement` received one `join` and both fan-out branches read it. On the turn that accepted the classify results, the same `join` was then also offered to the extract branch, where classify-shaped payloads failed the extract guard. I had already designed a `joinToken` and already put `pendingJoinToken` in the state — and never checked it. The token was decoration.

Fix: the workflow records `pendingJoinToken` when it issues a fan-out, and `takeJoin` refuses any submission whose token does not match the stage it is currently waiting on. A stale, duplicated or misrouted join is now a typed error instead of silent cross-contamination. I also removed the two dead continuation kinds while I was in there.

**Δ-P9-01-B — child failures were forgotten between turns.**
`failedChildren` was a local array. A partial failure recorded during the classify merge was lost the moment the workflow returned its next fan-out, so a `continue-on-partial` run could reach `SUCCEEDED` having silently dropped a file. The `continue-on-partial` test caught it with an empty array where one entry was expected.

Fix: failures are persisted into `state.childResults` at merge time and read back when building the terminal result. `state.childResults` was already declared in the state type and unused — the same mistake as the token, in a second place. A multi-turn workflow has to keep its own bookkeeping in the thing it persists, not in the stack frame.

## 5. Deliberate differences from the legacy workflow

| Δ | Legacy | Here | Why |
|---|---|---|---|
| **Δ-P9-01-1** | `Promise.all` over every file — 200 files meant 200 concurrent provider calls | bounded fan-out, ceiling clamped to `MAX_FANOUT_CONCURRENCY = 8` | P9-01 deliverable, named in the backlog |
| **Δ-P9-01-2** | extract had **no** all-children-failed check; it would proceed to approval with zero data | `fail-closed` default for **both** stages; all-fail always throws | **deviation needing domain-owner sign-off.** Legacy silently continued. I chose the safe default and flagged it rather than inheriting it silently |
| **Δ-P9-01-3** | `apiKeyId` read from a **form field**, falling back to the oldest `role = ADMIN` key | identity is not in the input type at all; the guard **rejects** 10 identity field names with `IDENTITY_FIELD_REJECTED` | standing rule: do not copy legacy vulns |
| **Δ-P9-01-4** | cancel wrote `done=true, state=CANCELLED` while the worker kept running | terminal set is `SUCCEEDED` / `FAILED` only; the module never *declares* a cancellation | standing rule: no fake terminal state |
| **Δ-P9-01-5** | child results merged on shape alone | payloads discriminated on `kind`; a mismatched payload is a failure, not a bad merge | a malformed provider reply must not become a classified file |
| **Δ-P9-01-6** | approval state kept in workflow locals | approval is a versioned resume schema; `approved` must be an explicit boolean | waiting on a human outlives the deploy that wrote the state |
| **Δ-P9-01-7** | no encryption concern at the approval gate | `requireEncryptedEvidence` refuses to ask a human to approve unsealed evidence, `retryable: true` | fail-closed, no plaintext fallback |

## 6. Follow-ups — NOT done, not in my lease

~~These are required before P9-01 can execute for real. None is a suggestion; each is a hard blocker, and all of them sit outside the lease I was given.~~ **Partly superseded 2026-10-02 — see §6.1.** I verified F1–F4 are now **done** by another lane, so this list is no longer accurate as written.

| # | Follow-up | Owner / why not mine |
|---|---|---|
| F1 | ~~Register the workflow in `src/manifest/document-core.manifest.ts`~~ **DONE** — `manifest.ts:19` handlerKinds now 8 entries incl. `disbursement`; action at `:244` | was codex_worker_1's lease; landed by lane D3 |
| F2 | ~~Add recipe selectors / stable step ids~~ **DONE** — `recipe-definitions.ts:427` `disbursement:workflow` + `:455 getWorkflowRecipe`; `step-keys.ts:64-69` five stable ids | was codex_worker_1's lease; landed by lane D3 |
| F3 | Add the extract `type` / analyze `task` discriminator entries the workflow expects | `validation/input-normalizer.ts` is codex_worker_1's lease |
| F4 | ~~Wire the host~~ **DONE and it consumes my primitives** — `worker.ts:49` imports `advanceDisbursement` from this module; `:1229` calls it; `:1075 mapDisbursementContinuation` drives the loop | was orchestrator-side; landed by lane D3 |
| F5 | Implement the four business ports against the real connector (`classifyFile`, `extractFile`, `crosscheck`, `report`) | today they are fakes in tests; no provider call has ever run |
| F6 | Export from `src/index.ts` | `src/index.ts` is outside `src/pipelines/**`; I did not touch it |
| F7 | Domain-owner ruling on **Δ-P9-01-2** (fail-closed extract vs legacy silent-continue) | business decision, deliberately not invented |
| F8 | Resolve the 31-vs-28 registry gap so `all-variants-e2e` and `corpus-regression` can pass | pre-existing; already documented in COMP-04 §6.6 |


### 6.1 Follow-up status re-verified 2026-10-02 (supersedes the framing above)

I re-checked the follow-ups before reporting on them, and **F1, F2 and F4 are done** — landed by another lane (its own receipt: `codex-p9-01-disbursement-handler-registration-2026-10-01.md`, 2026-10-01). I verified each in source rather than trusting that receipt:

| Claim | Verified |
|---|---|
| F1 registration | `manifest/document-core.manifest.ts:19` — `handlerKinds` is now **8** entries including `disbursement`; action declared at `:244` |
| F2 recipe + step ids | `recipes/recipe-definitions.ts:427` `disbursement:workflow`, `:455 getWorkflowRecipe`; `recipes/step-keys.ts:64-69` — five stable ids |
| F4 host wiring | `worker.ts:49` imports `advanceDisbursement` **from this module**; `:1229` calls it; `:1075 mapDisbursementContinuation` drives the loop |

**The finding that matters most: the host enforces the exact invariant I fixed.** `worker.ts:1219` reads

```
if (snapshot.state.pendingJoinToken !== reference.joinToken) { /* reject */ }
```

and the token round-trips through persistence — written at `:1102` as `disbursement:v1:<stage>:<joinToken>`, parsed back at `:626-630`. So **Δ-P9-01-A (a join merged into the wrong stage) is now a live, host-enforced invariant rather than a latent hazard**: my earlier fix is load-bearing in the integrated path, not just in my own tests.

**Still open, and genuinely so:** F3 (discriminator entries — `validation/` lease), F5 (the four business ports are still fakes; no provider call has ever run), F6 (`src/index.ts` export, outside my lease), F7 (domain-owner ruling), F8 (31-vs-28). I am **not** marking F1/F2/F4 done on the strength of the other lane's receipt alone — the citations above are mine.

## 7. Not run / not claimed

- **No E2E or integration run.** Impossible until F1–F4 land. Nothing here has been seen working against a queue, a database or a provider.
- **`bullmq-smoke.test.ts` not run to completion** — it needs live Redis on 6380 and timed out at 600s. I did not stand up shared infra for it.
- **No shared DB / Redis / S3 window claimed or used.** Every test is in-process with injected fakes.
- **P9-02 lc-checker: not started, and no criteria or rule versions invented.** The backlog requires domain-owner confirmation for exactly this; guessing would produce a legal-sounding artefact with no authority behind it.
- **P9-03 / P9-04: untouched** (separate packets).
- **No gate ticked.** G-* stays NO-GO. **No contract frozen** — the types here are an implementation surface, not a wire contract.
- **No commit, no push.** The working tree carries other lanes' uncommitted work and I did not touch it.

## 8. Lease compliance

Created, and the only things I changed:

```
du-rework/businesses/document-core/src/pipelines/workflows/disbursement/   (5 files, 1019 lines)
du-rework/businesses/document-core/tests/p9-01-disbursement.test.ts          (1 file,  660 lines)
du-rework/coordination/reports/codex-p9-01-disbursement-2026-10-01.md         (this report)
```

`git status` over `businesses/`, `packages/`, `services/`, `tasks/`, `gates/` shows every other modified and untracked path as another lane's work — `manifest/`, `recipes/`, `actions/`, `validation/`, the orchestrator admin-local set, `p9-03-doc-compare.test.ts`, `missing-variants.test.ts`. I edited none of them, and I did not revert any.
## 9. Follow-up: registration F1/F2/F3/F6 (PACKET D1)

Implemented the in-lease registration work for disbursement:

- **F1:** `src/manifest/document-core.manifest.ts` now includes the `disbursement` action, a closed input schema for the versioned workflow input, the three continuation kinds emitted by the workflow (`spawn-children`, `wait-for-input`, `terminate`), and required `classify`, `extract`, `crosscheck`, and `report` connector slots. The manifest uses the existing `root` handler-kind fallback; it does not add `disbursement` to `runtime.handlerKinds`, because `worker.ts` is outside this packet and its handler map must match the declared handler kinds. Consequently, worker dispatch/host continuation execution remains unimplemented in this packet (F4 boundary).
- **F2:** `src/recipes/recipe-definitions.ts` exposes `getWorkflowRecipe('disbursement')` and the generic selector `getRecipe('disbursement', 'workflow')`. The recipe orders stable stage keys classify -> extract -> approval -> crosscheck -> report and associates connector-backed stages with their matching slots. `src/recipes/step-keys.ts` defines all five stable identifiers. The workflow recipe is separate from `getAllRecipes()`, preserving the 31 document-variant count.
- **F3:** `src/validation/input-normalizer.ts` accepts `extract.type = 'id-card'`, `analyze.task = 'fact-check'`, and `analyze.task = 'summarize-eval'`; fact-check requires non-empty reference data.
- **F6:** `src/index.ts` exports the disbursement workflow barrel, including `advanceDisbursement` and its typed continuation primitives.
- Added the count-neutral `tests/p9-01-disbursement-registration.test.ts` to validate manifest schema/slots/continuations, recipe stage order and step IDs, normalizer discriminators, and the barrel export. The document variant recipe and traceability counts remain 31 with per-action counts 4/6/7/5/6/3.

### Follow-up verification

Commands run from `du-rework/businesses/document-core`:

```
npx jest --runInBand --runTestsByPath tests/p9-01-disbursement-registration.test.ts
  Test Suites: 1 passed, 1 total
  Tests:       4 passed, 4 total

npx tsc --noEmit -p tsconfig.json       -> exit 0
npx tsc --noEmit -p tsconfig.test.json  -> exit 0

npx jest --runInBand
  Test Suites: 4 failed, 50 passed, 54 total
  Tests:       6 failed, 845 passed, 851 total
```

The full Jest baseline supplied for this packet was `Test Suites: 3 failed, 49 passed, 52 total; Tests: 4 failed, 810 passed, 814 total`. The three baseline failures remain: `bullmq-smoke.test.ts:298` (claim was not recorded), `all-variants-e2e.test.ts:377` (fixtures unhandled for DOC-02-06, DOC-03-06, DOC-03-07), and `corpus-regression.test.ts:248` (missing corpus entry). This run adds two failures in the existing `manifest.test.ts`: its action list still expects exactly six names and now receives the registered `disbursement` action; and its `test.failing` case at line 146 unexpectedly passes because the validator now rejects the mutated manifest after `root` is removed while `disbursement` remains undeclared. Both are existing tests outside this packet's test-edit allowance; I did not weaken or alter them. Thus the full-suite no-new-failures condition is **not met**; the requested 31-variant and baseline count assertions were preserved.

**Not done / not claimed:** no `worker.ts`, `main.ts`, or `server.ts` dispatch wiring (F4); no real connector ports (F5); no corpus or all-variants fixture edits (F8); no routes mounted; no gates ticked; no shared DB/Redis/S3 used; no commit made.
